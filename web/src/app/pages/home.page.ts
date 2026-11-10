import { ChangeDetectionStrategy, Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { WebappSdkModule } from '@yamcs/webapp-sdk';
import { UtcPipe } from '../time.pipe';
import { SESSION } from '../api';
import { FopsContext } from '../context';
import { confirm, PreferencesDialog, startWithDialog } from '../dialogs';
import { ENDED, ProcedureEntry, Summary } from '../model';
import { label, statusClass } from '../status';

interface Folder {
  name: string;
  path: string;
  folders: Folder[];
  files: ProcedureEntry[];
}

function tree(entries: ProcedureEntry[]): Folder {
  const root: Folder = { name: '', path: '', folders: [], files: [] };
  for (const e of entries) {
    const parts = e.path.split('/');
    let f = root;
    for (const p of parts.slice(0, -1)) {
      let sub = f.folders.find((x) => x.name === p);
      if (!sub) f.folders.push((sub = { name: p, path: f.path ? `${f.path}/${p}` : p, folders: [], files: [] }));
      f = sub;
    }
    f.files.push(e);
  }
  return root;
}

/** SPELL's navigation view and master view. */
@Component({
  selector: 'fops-home',
  imports: [WebappSdkModule, UtcPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ya-instance-page>
      <ya-instance-toolbar label="Procedures">
        <ya-page-button icon="refresh" (clicked)="refresh()">Refresh</ya-page-button>
        <ya-page-button icon="tune" (clicked)="preferences()">Preferences</ya-page-button>
      </ya-instance-toolbar>
      <div class="fops fops-home">
        <section class="fops-nav">
          <div class="fops-h">Procedures</div>
          <input class="fops-filter" placeholder="Filter" [value]="filter()" (input)="filter.set($any($event.target).value)" />
          <ng-template #folderTpl let-f>
            @for (sub of f.folders; track sub.path) {
              <div class="fops-folder" (click)="toggle(sub.path)">
                <span class="material-symbols">{{ closed().has(sub.path) ? 'folder' : 'folder_open' }}</span>
                {{ sub.name }}
              </div>
              @if (!closed().has(sub.path)) {
                <div class="fops-indent">
                  <ng-container *ngTemplateOutlet="folderTpl; context: { $implicit: sub }" />
                </div>
              }
            }
            @for (p of f.files; track p.path) {
              <a
                class="fops-proc"
                [class.sel]="selected() === p.path"
                [href]="ctx.url('procedures/' + p.path)"
                (click)="$event.preventDefault(); selected.set(p.path)"
                (dblclick)="quickStart(p.path)"
                (keydown.enter)="quickStart(p.path)"
                [title]="p.path">
                <span class="material-symbols">description</span>
                <span class="fops-grow">{{ p.path.split('/').pop() }}</span>
                @if (p.name) {
                  <span class="fops-mute">{{ p.name }}</span>
                }
              </a>
            }
          </ng-template>
          <ng-container *ngTemplateOutlet="folderTpl; context: { $implicit: procTree() }" />
          @if (!procs().length) {
            <div class="fops-mute fops-pad">No procedures.</div>
          }
          <div class="fops-actions">
            <ya-button [disabled]="!selected() || !ctx.privileges.start" icon="play_arrow" appearance="primary" title="Load it with the default arguments, held before anything runs until you press Run or Step (also double-click or Enter). A procedure with required arguments opens its details instead." (click)="quickStart(selected()!)">Open</ya-button>
            <ya-button
              [disabled]="!selected() || !ctx.privileges.start || !ctx.timelineAllowed"
              icon="schedule"
              [title]="ctx.timelineAllowed ? 'Put it on the Yamcs timeline, with arguments and options' : 'Needs the Yamcs timeline and the ControlTimeline privilege'"
              (click)="schedule(selected()!)">Schedule…</ya-button>
            <ya-button [disabled]="!selected()" icon="description" (click)="ctx.go('procedures/' + selected())">Details…</ya-button>
          </div>
        </section>

        <section class="fops-master">
          <div class="fops-h">
            Executions
            <span class="fops-grow"></span>
            <label class="fops-check"><input type="checkbox" [checked]="showEnded()" (change)="showEnded.set(!showEnded())" /> ended</label>
          </div>
          <div class="fops-toolbar">
            <ya-button icon="sports_esports" [disabled]="!can('take')" (click)="each('takeControl')">Take control</ya-button>
            <ya-button icon="logout" [disabled]="!can('release')" (click)="each('releaseControl')" title="Give up control: the executions go on in the background">Release</ya-button>
            <ya-button icon="visibility" [disabled]="!sel().length" (click)="openSelected()">Open</ya-button>
            <ya-button icon="stop" [disabled]="!can('abort')" (click)="abortSelected()">Abort</ya-button>
            <ya-button icon="dangerous" [disabled]="!can('kill')" (click)="killSelected()">Kill</ya-button>
          </div>
          <table class="fops-table">
            <thead>
              <tr>
                <th class="cb"><input type="checkbox" [checked]="allSelected()" (change)="selectAll($any($event.target).checked)" /></th>
                <th>#</th>
                <th>Procedure</th>
                <th>Status</th>
                <th>Controller</th>
                <th>Origin</th>
                <th>Step</th>
                <th>Started</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              @for (e of visible(); track e.id) {
                <tr [class.sel]="selection().has(e.id)" (click)="toggleSel(e.id)" (dblclick)="ctx.go('executions/' + e.id)">
                  <td class="cb"><input type="checkbox" [checked]="selection().has(e.id)" (click)="$event.stopPropagation(); toggleSel(e.id)" /></td>
                  <td class="mono">{{ e.id }}</td>
                  <td>
                    <a [href]="ctx.url('executions/' + e.id)" (click)="$event.preventDefault(); $event.stopPropagation(); ctx.go('executions/' + e.id)">{{ e.name || e.procedure }}</a>
                    <div class="fops-mute">{{ e.procedure }}</div>
                  </td>
                  <td><span class="fops-status" [class]="statusClass(e.activity || e.status)">{{ label(e) }}</span></td>
                  <td>
                    @if (ended(e)) {
                      -
                    } @else {
                      {{ e.controller?.user ?? (e.background ? 'background' : 'none') }}
                      @if (e.controller?.session === session) {
                        <span class="fops-mute">(this tab)</span>
                      }
                      @if (e.monitors?.length) {
                        <div class="fops-mute">monitored by {{ e.monitors!.join(', ') }}</div>
                      }
                    }
                  </td>
                  <td>{{ e.origin }}{{ e.startedBy ? ' · ' + e.startedBy : '' }}</td>
                  <td>
                    @if (e.step) {
                      {{ e.step.index + 1 }}. {{ e.step.name }} <span class="fops-mute">{{ e.step.confirmation || e.step.execution }}</span>
                    } @else {
                      -
                    }
                  </td>
                  <td>{{ e.started | utc }}</td>
                  <td class="fops-msg">{{ e.message || '' }}</td>
                </tr>
              } @empty {
                <tr><td colspan="9" class="fops-mute">No executions.</td></tr>
              }
            </tbody>
          </table>
        </section>
      </div>
    </ya-instance-page>
  `,
})
export class HomePage implements OnInit, OnDestroy {
  readonly ctx = inject(FopsContext);
  readonly session = SESSION;
  readonly statusClass = statusClass;
  readonly label = label;

  readonly procs = signal<ProcedureEntry[]>([]);
  readonly execs = signal<Summary[]>([]);
  readonly filter = signal('');
  readonly selected = signal<string | null>(null);
  readonly closed = signal(new Set<string>());
  readonly selection = signal(new Set<number>());
  readonly showEnded = signal(true);

  readonly procTree = computed(() => {
    const f = this.filter().toLowerCase();
    return tree(this.procs().filter((p) => !f || p.path.toLowerCase().includes(f) || (p.name ?? '').toLowerCase().includes(f)));
  });
  readonly visible = computed(() => this.execs().filter((e) => this.showEnded() || !ENDED.has(e.status)));
  readonly sel = computed(() => this.execs().filter((e) => this.selection().has(e.id)));
  readonly allSelected = computed(() => this.visible().length > 0 && this.visible().every((e) => this.selection().has(e.id)));

  private timer?: number;

  ngOnInit() {
    this.refresh();
    this.timer = window.setInterval(() => this.loadExecs(), 2000);
  }

  ngOnDestroy() {
    clearInterval(this.timer);
  }

  async refresh() {
    try {
      this.procs.set(await this.ctx.api.procedures());
    } catch (e) {
      this.ctx.error(e);
    }
    this.loadExecs();
  }

  async loadExecs() {
    try {
      this.execs.set(await this.ctx.api.executions());
    } catch {
      // shown by the next refresh; keep the last list
    }
  }

  toggle(path: string) {
    const s = new Set(this.closed());
    s.has(path) ? s.delete(path) : s.add(path);
    this.closed.set(s);
  }

  toggleSel(id: number) {
    const s = new Set(this.selection());
    s.has(id) ? s.delete(id) : s.add(id);
    this.selection.set(s);
  }

  selectAll(on: boolean) {
    this.selection.set(on ? new Set(this.visible().map((e) => e.id)) : new Set());
  }

  ended(e: Summary) {
    return ENDED.has(e.status);
  }

  /** Multi-selection rules (SPELL 3.3.1): enabled only if it applies to all selected. */
  can(what: 'take' | 'release' | 'abort' | 'kill'): boolean {
    const sel = this.sel();
    if (!sel.length) return false;
    const p = this.ctx.privileges;
    return sel.every((e) => {
      const ended = ENDED.has(e.status);
      switch (what) {
        case 'take':
          return p.control && !ended && !e.controller;
        case 'release':
          return !ended && e.controller?.session === SESSION;
        case 'abort':
          return !ended && e.controller?.session === SESSION;
        case 'kill':
          return p.kill && !ended;
      }
    });
  }

  async each(action: 'takeControl' | 'releaseControl') {
    for (const e of this.sel()) {
      try {
        await this.ctx.api.action(e.id, action);
      } catch (err) {
        this.ctx.error(err);
      }
    }
    this.loadExecs();
  }

  openSelected() {
    const sel = this.sel();
    if (sel.length === 1) this.ctx.go('executions/' + sel[0].id);
    else for (const e of sel) window.open(this.ctx.absolute('executions/' + e.id), `fops-${e.id}`);
  }

  async abortSelected() {
    if (!(await confirm(this.ctx.dialog, 'Abort', `Abort ${this.sel().length} execution(s)? Cleanup steps will run.`))) return;
    for (const e of this.sel()) await this.ctx.api.control(e.id, { cmd: 'abort' }).catch((err) => this.ctx.error(err));
  }

  async killSelected() {
    const ok = await confirm(
      this.ctx.dialog,
      'Kill',
      `Kill ${this.sel().length} execution(s)? This is not a graceful stop: no cleanup steps run, and commands in progress are left as they are.`,
    );
    if (!ok) return;
    for (const e of this.sel()) await this.ctx.api.action(e.id, 'kill').catch((err) => this.ctx.error(err));
    this.loadExecs();
  }

  async quickStart(path: string) {
    if (!this.ctx.privileges.start) return;
    try {
      const d = await this.ctx.api.procedure(path);
      if (d.inspect?.args?.some((a) => a.required)) {
        // needs arguments: start from the properties page
        this.ctx.go('procedures/' + path);
        return;
      }
      const { id } = await this.ctx.api.start({ procedure: path });
      this.ctx.go('executions/' + id);
    } catch (e) {
      this.ctx.error(e);
    }
  }

  /** The start dialog on its timeline part; a procedure that does not load cannot be scheduled. */
  async schedule(path: string) {
    try {
      const d = await this.ctx.api.procedure(path);
      if (d.inspect?.error) {
        this.ctx.go('procedures/' + path);
        return;
      }
      await startWithDialog(this.ctx, path, d.inspect, 'schedule');
    } catch (e) {
      this.ctx.error(e);
    }
  }

  preferences() {
    this.ctx.dialog.open(PreferencesDialog, { width: '520px' });
  }
}
