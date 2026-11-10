import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  HostListener,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ParameterValue, utils, WebappSdkModule } from '@yamcs/webapp-sdk';
import { ExecutionStore } from './execution';
import { highlightLines, nameAtEnd } from './highlight';
import { Item, STATUS_CLASS, summarize } from './items';
import { LiveParameters } from './live';
import { ParamRef } from './model';
import { PrefsService } from './prefs';
import { UtcPipe } from './time.pipe';

/** A value as shown to the operator, with its units. */
function shown(v: ParameterValue['engValue'] | undefined, units?: string | null): string {
  if (!v) return '';
  const x = utils.convertValue(v);
  const s =
    typeof x === 'number' && !Number.isInteger(x) ? String(+x.toPrecision(6))
    : x instanceof Date ? x.toISOString()
    : x !== null && typeof x === 'object' ? JSON.stringify(x instanceof Map ? Object.fromEntries(x) : x)
    : String(x);
  return units ? `${s} ${units}` : s;
}

interface Row {
  n: number;
  html: string;
  text: string;
  hits: number;
  sup: boolean;
  bp: boolean;
  tmp: boolean;
  cur: boolean;
  items: Item[];
  data: string;
  status: string;
  statusCls: string;
  /** `fops check` findings of the line: 'bad' (errors), 'warn' (warnings only) or ''. */
  check: string;
  checkText: string;
}

/**
 * SPELL's Tabular presentation: the source with execution coverage, the
 * current line, hit counts (fops: trace limits), breakpoints, and the item
 * columns (Data, Status) for what each line did.
 */
@Component({
  selector: 'fops-code',
  imports: [WebappSdkModule, UtcPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fops-code-bar">
      <input #search class="fops-filter" placeholder="Search code" [value]="query()" (input)="query.set($any($event.target).value); hit.set(0)" (keydown.enter)="next($any($event).shiftKey ? -1 : 1)" (keydown.escape)="query.set('')" />
      @if (query()) {
        <span class="fops-mute">{{ matches().length ? hit() + 1 + '/' + matches().length : 'no match' }}</span>
        <ya-icon-action icon="keyboard_arrow_up" (click)="next(-1)" />
        <ya-icon-action icon="keyboard_arrow_down" (click)="next(1)" />
        <ya-icon-action icon="close" (click)="query.set('')" />
      }
      <span class="fops-grow"></span>
    </div>
    <div class="fops-code" #scroller [style.font-size.px]="prefs.prefs().codeFontSize" (contextmenu)="$event.preventDefault()"
      (mouseover)="hoverParam($event)" (mouseleave)="hover.set(null)" (scroll)="hover.set(null)">
      <table>
        <colgroup>
          <col class="c-g" /><col class="c-n" /><col class="c-h" /><col />
          @if (store()) {
            <col class="c-d" /><col class="c-s" />
          }
        </colgroup>
        <tbody>
          @for (r of rows(); track r.n) {
            <tr
              [attr.data-line]="r.n"
              [class.cur]="r.cur"
              [class.done]="r.hits > 0"
              [class.match]="matchSet().has(r.n)"
              [class.hit]="matches()[hit()] === r.n"
              (dblclick)="itemInfo.emit(r.n)"
              (contextmenu)="openMenu($event, r.n)">
              <td class="g" [class.bp]="r.bp" [class.tmp]="r.tmp" (click)="toggleBreakpoint.emit(r.n)" title="Breakpoint">{{ r.bp ? '●' : r.tmp ? '○' : '' }}</td>
              <td class="n" [class]="r.check" [title]="r.checkText">{{ r.n }}</td>
              <td class="h" [class.sup]="r.sup" [title]="r.sup ? 'trace limit reached: no longer reported' : ''">{{ r.hits || '' }}{{ r.sup ? '+' : '' }}</td>
              <td class="t" [class]="r.check" [title]="r.checkText" [innerHTML]="r.html"></td>
              @if (store()) {
                <td class="d" [title]="r.data">{{ r.data }}</td>
                <td class="s" [class]="r.statusCls">{{ r.status }}</td>
              }
            </tr>
          }
        </tbody>
      </table>
    </div>
    @if (paramTip(); as p) {
      <div class="fops-ptip" [style.left.px]="p.x" [style.top.px]="p.y">
        <div><b>{{ p.key }}</b> <span class="fops-mute">{{ p.ref.name }}</span></div>
        @if (p.pv; as v) {
          <div class="fops-ptip-v" [class]="'mon-' + (v.monitoringResult || 'none')">
            {{ p.value }}
            @if (p.raw) {
              <span class="fops-mute">raw {{ p.raw }}</span>
            }
          </div>
          <div class="fops-mute">{{ v.generationTime | utc }}{{ v.acquisitionStatus !== 'ACQUIRED' ? ' · ' + v.acquisitionStatus : '' }}{{ v.monitoringResult ? ' · ' + v.monitoringResult : '' }}</div>
        } @else {
          <div class="fops-mute">{{ live() ? 'no value yet' : 'no live values here' }}</div>
        }
        @if (p.ref.description) {
          <div class="fops-mute">{{ p.ref.description }}</div>
        }
      </div>
    }
    @if (menu(); as m) {
      <div class="fops-menu" [style.left.px]="m.x" [style.top.px]="m.y" (click)="$event.stopPropagation()">
        @if (store()) {
          <button (click)="act('bp', m.line)" [disabled]="!controlling()">{{ rowsByLine().get(m.line)?.bp ? 'Remove breakpoint' : 'Add breakpoint at this line' }}</button>
          <button (click)="act('clear', m.line)" [disabled]="!controlling()">Remove all breakpoints</button>
          <button (click)="act('runTo', m.line)" [disabled]="!controlling()">Run until this line</button>
          <button (click)="act('goto', m.line)" [disabled]="!controlling()">Go to this line</button>
          <button (click)="act('info', m.line)">Item information…</button>
          <hr />
        }
        <button (click)="act('copy', m.line)">Copy line</button>
        <button (click)="act('search', m.line)">Search…</button>
      </div>
    }
  `,
})
export class CodeView {
  readonly prefs = inject(PrefsService);
  private host = inject(ElementRef<HTMLElement>);

  readonly source = input.required<string>();
  /** Absent for a procedure that is not running (procedure properties). */
  readonly store = input<ExecutionStore | null>(null);
  readonly tick = input(0);
  readonly breakpoints = input<number[]>([]);
  readonly tempBreakpoints = input<number[]>([]);
  readonly controlling = input(false);
  readonly autoScroll = input(true);
  /** Line to scroll to (outline). */
  readonly reveal = input<{ line: number } | null>(null);
  /** Names of the source that are MDB parameters: marked, with a tooltip. */
  readonly params = input<Record<string, ParamRef> | null>(null);
  /** Their live values, for the tooltip. */
  readonly live = input<LiveParameters | null>(null);
  /** `fops check` findings: their lines are underlined, with the message as tooltip. */
  readonly check = input<{ line: number; message: string }[]>([]);

  readonly toggleBreakpoint = output<number>();
  readonly clearBreakpoints = output<void>();
  readonly runTo = output<number>();
  readonly gotoLine = output<number>();
  readonly itemInfo = output<number>();

  readonly query = signal('');
  readonly hit = signal(0);
  readonly menu = signal<{ x: number; y: number; line: number } | null>(null);
  readonly hover = signal<{ key: string; el: Element; x: number; y: number } | null>(null);

  readonly paramTip = computed(() => {
    const h = this.hover();
    const ref = h && this.params()?.[h.key];
    if (!h || !ref) return null;
    this.live()?.tick();
    const pv = this.live()?.values.get(ref.name);
    const value = shown(pv?.engValue, ref.units);
    const raw = pv?.rawValue ? shown(pv.rawValue) : '';
    return { ...h, ref, pv, value, raw: raw && raw !== shown(pv?.engValue) ? raw : '' };
  });

  private scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private searchBox = viewChild<ElementRef<HTMLInputElement>>('search');

  private readonly lines = computed(() => {
    const src = this.source();
    return { html: highlightLines(src, new Set(Object.keys(this.params() ?? {}))), text: src.split('\n') };
  });

  readonly rows = computed<Row[]>(() => {
    this.tick();
    const { html, text } = this.lines();
    const store = this.store();
    const bps = new Set(this.breakpoints());
    const tmp = new Set(this.tempBreakpoints());
    const cur = store?.st?.current;
    const curLine = cur && store!.mainCodes.has(cur['code_id']) ? cur.line : -1;
    const p = this.prefs.prefs();
    const check = new Map<number, string[]>();
    for (const c of this.check()) check.set(c.line, [...(check.get(c.line) ?? []), c.message]);
    return text.map((t, i) => {
      const n = i + 1;
      const all = store?.items.get(n) ?? [];
      const ex = all.length ? Math.max(...all.map((x) => x.ex)) : 0;
      const latest = all.filter((x) => x.ex === ex);
      const sum = summarize(latest);
      let data = '';
      if (latest.length === 1) {
        const it = latest[0];
        data = p.dataColumn === 'name' ? it.name : p.dataColumn === 'value' ? it.value : `${it.name} = ${it.value}`;
      }
      let status = sum?.text ?? '';
      if (sum && p.showItemTime) {
        const t = latest[latest.length - 1].time;
        status = `${sum.status[0]} ${t ? t.slice(11, 19) : ''}`;
      }
      // the underline of a line with findings starts after its indentation
      const h = html[i] ?? '';
      const indent = check.has(n) ? /^\s*/.exec(h)![0] : '';
      return {
        n,
        html: check.has(n) ? `${indent}<span class="chk">${h.slice(indent.length)}</span>` : h,
        text: t,
        hits: store ? store.hitsOf(n) : 0,
        sup: store ? store.suppressedAt(n) : false,
        bp: bps.has(n),
        tmp: tmp.has(n),
        cur: n === curLine,
        items: all,
        data,
        status,
        statusCls: sum ? STATUS_CLASS[sum.status] : '',
        check: !check.has(n) ? '' : check.get(n)!.every((m) => m.startsWith('warning:')) ? 'warn' : 'bad',
        checkText: (check.get(n) ?? []).join('\n'),
      };
    });
  });

  readonly rowsByLine = computed(() => new Map(this.rows().map((r) => [r.n, r])));

  readonly matches = computed(() => {
    const q = this.query().toLowerCase();
    if (!q) return [] as number[];
    return this.lines()
      .text.map((t, i) => (t.toLowerCase().includes(q) ? i + 1 : 0))
      .filter((n) => n);
  });
  readonly matchSet = computed(() => new Set(this.matches()));

  private lastCur = -1;

  constructor() {
    // auto-scroll: keep the current line in the middle
    effect(() => {
      const r = this.rows().find((x) => x.cur);
      if (!r || r.n === this.lastCur || !this.autoScroll()) return;
      this.lastCur = r.n;
      queueMicrotask(() => this.scrollTo(r.n));
    });
    effect(() => {
      const m = this.matches()[this.hit()];
      if (m) queueMicrotask(() => this.scrollTo(m));
    });
    effect(() => {
      const r = this.reveal();
      if (r) queueMicrotask(() => this.scrollTo(r.line));
    });
  }

  scrollTo(line: number) {
    const el = this.scroller()?.nativeElement.querySelector(`tr[data-line="${line}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'auto' });
  }

  next(d: number) {
    const n = this.matches().length;
    if (n) this.hit.set((this.hit() + d + n) % n);
  }

  hoverParam(ev: MouseEvent) {
    const el = (ev.target as Element).closest?.('.fops-param');
    if (!el) {
      if (this.hover()) this.hover.set(null);
      return;
    }
    if (this.hover()?.el === el) return;
    // the name is the text of the line up to the end of this token (the sanitizer drops data-* attributes)
    const cell = el.closest('td');
    if (!cell) return;
    const upTo = document.createRange();
    upTo.setStart(cell, 0);
    upTo.setEndAfter(el);
    const key = nameAtEnd(upTo.toString());
    if (!key) return;
    const box = this.host.nativeElement.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    this.hover.set({ key, el, x: r.left - box.left, y: r.bottom - box.top + 2 });
  }

  openMenu(ev: MouseEvent, line: number) {
    ev.preventDefault();
    const box = this.host.nativeElement.getBoundingClientRect();
    this.menu.set({ x: ev.clientX - box.left, y: ev.clientY - box.top, line });
  }

  @HostListener('document:click')
  closeMenu() {
    this.menu.set(null);
  }

  act(what: string, line: number) {
    this.menu.set(null);
    switch (what) {
      case 'bp':
        this.toggleBreakpoint.emit(line);
        break;
      case 'clear':
        this.clearBreakpoints.emit();
        break;
      case 'runTo':
        this.runTo.emit(line);
        break;
      case 'goto':
        this.gotoLine.emit(line);
        break;
      case 'info':
        this.itemInfo.emit(line);
        break;
      case 'copy':
        navigator.clipboard?.writeText(this.lines().text[line - 1] ?? '');
        break;
      case 'search':
        this.searchBox()?.nativeElement.focus();
        break;
    }
  }

  lineText(n: number) {
    return this.lines().text[n - 1] ?? '';
  }
}
