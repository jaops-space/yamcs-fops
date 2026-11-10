import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, input, signal, viewChild } from '@angular/core';
import { WebappSdkModule } from '@yamcs/webapp-sdk';
import { FopsContext } from '../context';
import { ValueDialog } from '../dialogs';
import { ExecutionStore } from '../execution';

const INSPECTABLE = new Set(['paused', 'finished', 'aborted', 'error']);

function inspectable(s: ExecutionStore) {
  const st = s.st;
  return !!st && (INSPECTABLE.has(st.status) || st.activity === 'prompt');
}

/** SPELL's watch of variables (GUI manual 3.5): on demand, globals in bold, editable when paused. */
@Component({
  selector: 'fops-variables',
  imports: [WebappSdkModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fops-row fops-pad">
      <ya-button icon="refresh" [disabled]="!can()" (click)="refresh()">Refresh</ya-button>
      <label class="fops-check"><input type="checkbox" [checked]="showLocals()" (change)="showLocals.set(!showLocals())" /> Locals</label>
      <label class="fops-check"><input type="checkbox" [checked]="showGlobals()" (change)="showGlobals.set(!showGlobals())" /> Globals</label>
      <span class="fops-grow"></span>
      @if (frame(); as f) {
        <span class="fops-mute">in {{ f.function }}, line {{ f.line }}</span>
      }
      @if (!can()) {
        <span class="fops-mute">Available when paused, at a prompt, or ended.</span>
      }
    </div>
    <table class="fops-table">
      <thead><tr><th>Name</th><th>Type</th><th>Value</th></tr></thead>
      <tbody>
        @for (v of rows(); track v.scope + v.name) {
          <tr>
            <td class="mono" [class.global]="v.scope === 'global'">{{ v.name }}</td>
            <td class="mono fops-mute">{{ v.type }}</td>
            <td class="mono fops-val">
              @if (editing() === v.scope + v.name) {
                <input #edit class="fops-edit" [value]="v.repr" (keydown.enter)="commit(v.name, $any($event.target).value)" (keydown.escape)="editing.set(null)" (blur)="editing.set(null)" />
              } @else {
                <span (click)="startEdit(v.scope + v.name)" [class.editable]="editable() && can()">{{ v.repr.length > 200 ? v.repr.slice(0, 200) + ' […]' : v.repr }}</span>
                @if (v.repr.length > 200) {
                  <ya-icon-action icon="open_in_full" (click)="detail(v.name, v.repr)" />
                }
              }
            </td>
          </tr>
        } @empty {
          <tr><td colspan="3" class="fops-mute">{{ store().st?.variables ? 'No variables.' : 'Press Refresh.' }}</td></tr>
        }
      </tbody>
    </table>
    @if (error()) {
      <div class="bad fops-pad">{{ error() }}</div>
    }
  `,
})
export class VariablesPanel {
  readonly ctx = inject(FopsContext);
  readonly store = input.required<ExecutionStore>();
  readonly tick = input(0);
  readonly editable = input(false);
  readonly showLocals = signal(true);
  readonly showGlobals = signal(true);
  readonly editing = signal<string | null>(null);
  readonly error = signal<string | null>(null);
  private edit = viewChild<ElementRef<HTMLInputElement>>('edit');

  readonly can = computed(() => {
    this.tick();
    return inspectable(this.store());
  });
  readonly frame = computed(() => {
    this.tick();
    return this.store().st?.variables?.['frame'] as { function: string; line: number } | undefined;
  });
  readonly rows = computed(() => {
    this.tick();
    const v = this.store().st?.variables;
    if (!v) return [];
    const out: { scope: string; name: string; type: string; repr: string }[] = [];
    if (this.showLocals()) for (const [n, x] of Object.entries<any>(v['locals'] ?? {})) out.push({ scope: 'local', name: n, type: x.type, repr: x.repr });
    if (this.showGlobals()) for (const [n, x] of Object.entries<any>(v['globals'] ?? {})) out.push({ scope: 'global', name: n, type: x.type, repr: x.repr });
    return out;
  });

  refresh() {
    const s = this.store();
    this.error.set(null);
    s.control({ cmd: 'get_variables', request_id: s.nextRequestId() }).catch((e) => this.error.set(String(e?.message ?? e)));
  }

  startEdit(key: string) {
    if (!this.editable() || !this.can()) return;
    this.editing.set(key);
    queueMicrotask(() => this.edit()?.nativeElement.focus());
  }

  async commit(name: string, expr: string) {
    this.editing.set(null);
    const s = this.store();
    try {
      await s.control({ cmd: 'set_variable', request_id: s.nextRequestId(), name, expr });
      this.refresh();
    } catch (e: any) {
      this.error.set(String(e?.message ?? e));
    }
  }

  detail(name: string, text: string) {
    this.ctx.dialog.open(ValueDialog, { width: '800px', data: { title: name, text } });
  }
}

/** SPELL's Shell presentation: Python in the paused frame, with history (Ctrl+Up/Down). */
@Component({
  selector: 'fops-shell',
  imports: [WebappSdkModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fops-shell" (dblclick)="cleared.set(store().messages.length)">
      @for (r of results(); track $index) {
        <div class="in">&gt;&gt;&gt; {{ r['expr'] }}</div>
        <div [class]="r['ok'] ? 'out' : 'out bad'">{{ r['ok'] ? r['output'] : r['error'] }}</div>
      }
      @if (!enabled()) {
        <div class="fops-mute">The shell needs control of the procedure and the fops.Shell privilege.</div>
      } @else if (!can()) {
        <div class="fops-mute">The shell runs in the paused frame: pause the procedure first.</div>
      }
    </div>
    <div class="fops-shell-in">
      <span class="mono">{{ multiline() ? '...' : '>>>' }}</span>
      <textarea
        rows="1"
        [disabled]="!enabled() || !can()"
        [value]="text()"
        (input)="onInput($any($event.target).value)"
        (keydown)="key($event)"
        placeholder="Python statement (Enter runs; a block ends with an empty line)"></textarea>
    </div>
    <div class="fops-mute fops-pad">Statements run inside the procedure: what they change is journaled, but their notifications do not appear in the other views. Double-click to clear.</div>
  `,
})
export class ShellPanel {
  readonly store = input.required<ExecutionStore>();
  readonly tick = input(0);
  readonly enabled = input(false);
  readonly text = signal('');
  readonly cleared = signal(0);
  private history: string[] = [];
  private hpos = 0;

  readonly can = computed(() => {
    this.tick();
    return inspectable(this.store());
  });
  readonly results = computed(() => {
    this.tick();
    return this.store()
      .messages.slice(this.cleared())
      .filter((m) => m.type === 'eval_result');
  });
  readonly multiline = computed(() => this.text().includes('\n'));

  onInput(v: string) {
    this.text.set(v);
  }

  key(e: KeyboardEvent) {
    const ta = e.target as HTMLTextAreaElement;
    if (e.key === 'ArrowUp' && e.ctrlKey) {
      e.preventDefault();
      if (this.hpos > 0) this.text.set(this.history[--this.hpos]);
    } else if (e.key === 'ArrowDown' && e.ctrlKey) {
      e.preventDefault();
      this.hpos = Math.min(this.hpos + 1, this.history.length);
      this.text.set(this.history[this.hpos] ?? '');
    } else if (e.key === 'Enter' && !e.shiftKey) {
      const v = ta.value;
      // a block (ends with ':' or already multi-line) continues until an empty line
      const block = v.trimEnd().endsWith(':') || (v.includes('\n') && !v.endsWith('\n'));
      if (block) {
        e.preventDefault();
        const indent = /:\s*$/.test(v) ? '    ' : (/\n?([ \t]*)[^\n]*$/.exec(v)?.[1] ?? '');
        this.text.set(v + '\n' + indent);
        return;
      }
      e.preventDefault();
      this.run(v.trimEnd());
    }
  }

  private async run(expr: string) {
    if (!expr.trim()) return;
    this.history.push(expr);
    this.hpos = this.history.length;
    this.text.set('');
    const s = this.store();
    await s.control({ cmd: 'eval', request_id: s.nextRequestId(), expr }).catch(() => {});
  }
}
