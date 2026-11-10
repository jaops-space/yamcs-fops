import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialog, MatDialogRef } from '@angular/material/dialog';
import { SaveTimelineItemRequest, WebappSdkModule } from '@yamcs/webapp-sdk';
import { UtcPipe } from './time.pipe';
import { firstValueFrom } from 'rxjs';
import { FopsContext } from './context';
import { Item, STATUS_CLASS } from './items';
import { ArgSpec, Inspect, StartRequest } from './model';
import { Prefs, PrefsService } from './prefs';

// ---------------------------------------------------------------- confirm

@Component({
  selector: 'fops-confirm',
  imports: [WebappSdkModule, UtcPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content><p style="white-space: pre-wrap">{{ data.message }}</p></mat-dialog-content>
    <mat-dialog-actions align="end">
      <ya-button mat-dialog-close>Cancel</ya-button>
      <ya-button appearance="primary" [mat-dialog-close]="true">{{ data.ok || data.title }}</ya-button>
    </mat-dialog-actions>
  `,
})
export class ConfirmDialog {
  readonly data = inject<{ title: string; message: string; ok?: string }>(MAT_DIALOG_DATA);
}

export async function confirm(dialog: MatDialog, title: string, message: string, ok?: string): Promise<boolean> {
  const ref = dialog.open(ConfirmDialog, { width: '480px', data: { title, message, ok } });
  return !!(await firstValueFrom(ref.afterClosed()));
}

// ---------------------------------------------------------------- start (arguments, options, timeline)

export interface StartDialogData {
  path: string;
  inspect?: Inspect;
  /** Start now with arguments, or schedule on the Yamcs timeline. */
  mode: 'args' | 'schedule';
  /** Schedule: the proposed duration (see guessDuration). */
  duration?: DurationGuess;
}

export interface DurationGuess {
  seconds: number;
  source: string;
}

/**
 * How long a run of the procedure takes: its declared duration, else the median of its last 10 finished runs (held or
 * paused time included, which the median mostly leaves out), else the estimate from its source, else a minute.
 */
export async function guessDuration(ctx: FopsContext, path: string, inspect?: Inspect): Promise<DurationGuess> {
  if (inspect?.duration) return { seconds: inspect.duration, source: 'declared by the procedure' };
  try {
    const runs = (await ctx.api.executions())
      .filter((e) => e.procedure === path && e.status === 'finished' && e.ended)
      .sort((a, b) => b.id - a.id)
      .slice(0, 10)
      .map((e) => (Date.parse(e.ended!) - Date.parse(e.started)) / 1000)
      .sort((a, b) => a - b);
    if (runs.length) {
      const m = runs.length / 2;
      const median = runs.length % 2 ? runs[Math.floor(m)] : (runs[m - 1] + runs[m]) / 2;
      return { seconds: median, source: `median of ${runs.length} run${runs.length > 1 ? 's' : ''}` };
    }
  } catch {
    // no history: the estimate
  }
  if (inspect?.estimate) return { seconds: inspect.estimate.seconds, source: 'estimated from the source' };
  return { seconds: 60, source: 'default' };
}

/** What the start dialog gives: a start request, or a Yamcs timeline item that starts it later. */
export type StartDialogResult = Omit<StartRequest, 'session'> | { timeline: SaveTimelineItemRequest };

/**
 * Start now with arguments (SPELL 3.1), or schedule: a PROCEDURE activity on the Yamcs timeline, where it can be
 * moved or cancelled until it starts.
 */
@Component({
  selector: 'fops-start-dialog',
  imports: [WebappSdkModule, ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ timeline ? 'Schedule' : 'Open' }} {{ data.inspect?.name || data.path }}</h2>
    <mat-dialog-content class="fops fops-form">
      @if (args.length) {
        <div class="fops-h">Arguments</div>
        @for (a of args; track a.name) {
          <label class="fops-field">
            <span>{{ a.name }}{{ a.required ? ' *' : '' }} <span class="fops-mute">{{ a.type }}{{ a.unit ? ', ' + a.unit : '' }}</span></span>
            @if (a.choices?.length) {
              <select [value]="values()[a.name] ?? ''" (change)="setArg(a, $any($event.target).value)">
                @if (!a.required) {
                  <option value="">(default{{ a.default !== undefined ? ': ' + a.default : '' }})</option>
                }
                @for (c of a.choices; track c) {
                  <option [value]="c">{{ c }}</option>
                }
              </select>
            } @else if (a.type === 'bool') {
              <select [value]="values()[a.name] ?? ''" (change)="setArg(a, $any($event.target).value)">
                <option value="">(default{{ a.default !== undefined ? ': ' + a.default : '' }})</option>
                <option value="true">true</option>
                <option value="false">false</option>
              </select>
            } @else {
              <input
                [type]="a.type === 'str' ? 'text' : 'number'"
                [attr.min]="a.min"
                [attr.max]="a.max"
                [attr.step]="a.type === 'int' ? 1 : 'any'"
                [placeholder]="a.default !== undefined && a.default !== null ? 'default: ' + a.default : ''"
                [value]="values()[a.name] ?? ''"
                (input)="setArg(a, $any($event.target).value)" />
            }
            @if (a.description) {
              <small class="fops-mute">{{ a.description }}</small>
            }
            @if (argError(a); as err) {
              <small class="bad">{{ err }}</small>
            }
          </label>
        }
      }

      <div class="fops-h">Options</div>
      @if (!timeline) {
        <label class="fops-check"><input type="checkbox" [checked]="background()" (change)="background.set(!background())" /> Run in background (no controlling client)</label>
      }
      <label class="fops-check"><input type="checkbox" [checked]="byStep()" (change)="byStep.set(!byStep())" /> By step: pause at each step</label>
      <label class="fops-check"><input type="checkbox" [checked]="confirmCommands()" (change)="confirmCommands.set(!confirmCommands())" /> TC confirm: confirm every command</label>
      @if (!timeline) {
        <label class="fops-field">
          <span>Trace limit <span class="fops-mute">(per source location; empty = server default, 0 = none)</span></span>
          <input type="number" min="0" [value]="traceLimit()" (input)="traceLimit.set($any($event.target).value)" />
        </label>
      }

      @if (timeline) {
        <div class="fops-h">Timeline</div>
        <label class="fops-field"><span>Activity label</span><input type="text" [formControl]="label" /></label>
        <div class="fops-field"><span>Execution time</span><ya-date-time-input [formControl]="at" [showNow]="true" /></div>
        <div class="fops-field">
          <span>Duration @if (durationSource()) {<span class="fops-mute">({{ durationSource() }})</span>}</span>
          <ya-duration-input [formControl]="duration" />
        </div>
        <label class="fops-check"><input type="checkbox" [formControl]="autoStart" /> Start automatically</label>
        <div class="fops-field"><span>Timeline tags</span><ya-tag-select [formControl]="tags" /></div>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <ya-button mat-dialog-close>Cancel</ya-button>
      <ya-button appearance="primary" [disabled]="!valid()" (click)="ok()">{{ timeline ? 'Schedule' : background() ? 'Start' : 'Open' }}</ya-button>
    </mat-dialog-actions>
  `,
})
export class StartDialog {
  readonly data = inject<StartDialogData>(MAT_DIALOG_DATA);
  readonly ref = inject(MatDialogRef<StartDialog>);
  readonly ctx = inject(FopsContext);
  readonly args: ArgSpec[] = this.data.inspect?.args ?? [];

  readonly values = signal<Record<string, string>>({});
  readonly background = signal(false);
  readonly byStep = signal(false);
  readonly confirmCommands = signal(false);
  readonly traceLimit = signal<string>('');
  /** Schedule: a PROCEDURE activity on the Yamcs timeline (in the background); otherwise started now. */
  readonly timeline = this.data.mode === 'schedule';
  /** An ISO string, entered in the user's Yamcs time zone (as elsewhere in Yamcs-web). */
  readonly at = new FormControl<string | null>(new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 600_000).toISOString());
  private readonly atValue = toSignal(this.at.valueChanges, { initialValue: this.at.value });
  readonly label = new FormControl('Run ' + (this.data.inspect?.name || this.data.path), { nonNullable: true });
  private readonly labelValue = toSignal(this.label.valueChanges, { initialValue: this.label.value });
  readonly autoStart = new FormControl(true, { nonNullable: true });
  /** "Ns", as the timeline takes it: the guess (data.duration) until edited. ya-duration-input shows only a value set
   * before it renders (it does not ask for change detection), hence a guess made before the dialog opens. */
  readonly duration = new FormControl<string | null>(this.data.duration ? `${Math.max(1, Math.round(this.data.duration.seconds))}s` : null);
  readonly durationSource = signal(this.data.duration?.source ?? '');
  readonly tags = new FormControl<string[]>([], { nonNullable: true });

  constructor() {
    this.duration.valueChanges.subscribe(() => this.durationSource.set(''));
  }

  readonly valid = computed(() => {
    if (this.args.some((a) => this.argError(a))) return false;
    if (this.timeline) {
      return !!this.labelValue().trim() && !!this.atValue() && !isNaN(Date.parse(this.atValue()!));
    }
    return true;
  });

  argError(a: ArgSpec): string | null {
    const v = this.values()[a.name];
    if (v === undefined || v === '') return a.required && a.default === undefined ? 'required' : null;
    if (a.type === 'int' && !/^-?\d+$/.test(v)) return 'an integer';
    if (a.type === 'float' && isNaN(+v)) return 'a number';
    if ((a.type === 'int' || a.type === 'float') && a.min !== undefined && a.min !== null && +v < a.min) return `at least ${a.min}`;
    if ((a.type === 'int' || a.type === 'float') && a.max !== undefined && a.max !== null && +v > a.max) return `at most ${a.max}`;
    return null;
  }

  setArg(a: ArgSpec, v: string) {
    this.values.update((x) => ({ ...x, [a.name]: v }));
  }

  ok() {
    const args: Record<string, any> = {};
    for (const a of this.args) {
      const v = this.values()[a.name];
      if (v === undefined || v === '') continue;
      args[a.name] = a.type === 'int' ? parseInt(v, 10) : a.type === 'float' ? +v : a.type === 'bool' ? v === 'true' : v;
    }
    if (this.timeline) {
      // the activity's arguments: ProcedureExecutor's spec
      const timeline: SaveTimelineItemRequest = {
        type: 'ACTIVITY',
        name: this.label.value.trim(),
        start: this.atValue()!,
        duration: this.duration.value || '0s',
        autoStart: this.autoStart.value,
        tags: this.tags.value,
        activityDefinition: {
          type: 'PROCEDURE',
          args: {
            procedure: this.data.path,
            ...(Object.keys(args).length ? { args } : {}),
            options: { byStep: this.byStep(), confirmCommands: this.confirmCommands() },
          },
        },
      };
      this.ref.close({ timeline });
      return;
    }
    const tl = this.traceLimit();
    const req: Omit<StartRequest, 'session'> = {
      procedure: this.data.path,
      args: Object.keys(args).length ? args : undefined,
      background: this.background() || undefined,
      options: { byStep: this.byStep(), confirmCommands: this.confirmCommands() },
      ...(tl !== '' ? { traceLimit: +tl === 0 ? 0 : +tl } : {}),
    };
    this.ref.close(req);
  }
}

/** Opens the start dialog, then starts the procedure (and opens it) or puts it on the timeline. */
export async function startWithDialog(ctx: FopsContext, path: string, inspect: Inspect | undefined, mode: 'args' | 'schedule') {
  const duration = mode === 'schedule' ? await guessDuration(ctx, path, inspect) : undefined;
  const ref = ctx.dialog.open(StartDialog, { width: '600px', data: { path, inspect, mode, duration } });
  const res = (await firstValueFrom(ref.afterClosed())) as StartDialogResult | undefined;
  if (!res) return;
  try {
    if ('timeline' in res) {
      await ctx.yamcs.yamcsClient.createTimelineItem(ctx.instance, res.timeline);
      ctx.info$('Procedure scheduled on the timeline');
      return;
    }
    const { id } = await ctx.api.start(res);
    if (res.background) {
      ctx.info$(`Execution ${id} started in background`);
      ctx.go('');
    } else ctx.go('executions/' + id);
  } catch (e) {
    ctx.error(e);
  }
}

// ---------------------------------------------------------------- goto

export interface GotoData {
  steps: { index: number; name: string; line?: number }[];
  current?: number;
}

/** SPELL 5.5: go to a step (label) or a line. Returns {step} or {line}. */
@Component({
  selector: 'fops-goto-dialog',
  imports: [WebappSdkModule, UtcPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>Go to</h2>
    <mat-dialog-content class="fops fops-goto">
      <label class="fops-check"><input type="radio" name="t" [checked]="kind() === 'step'" (change)="kind.set('step')" [disabled]="!data.steps.length" /> Step</label>
      <select [disabled]="kind() !== 'step'" [value]="step()" (change)="step.set(+$any($event.target).value)">
        @for (s of data.steps; track s.index) {
          <option [value]="s.index">{{ s.index + 1 }}. {{ s.name }}</option>
        }
      </select>
      <label class="fops-check"><input type="radio" name="t" [checked]="kind() === 'line'" (change)="kind.set('line')" /> Line</label>
      <input type="number" min="1" [disabled]="kind() !== 'line'" [value]="line()" (input)="line.set(+$any($event.target).value)" />
      <small class="fops-mute">A line jump stays inside the current function (Python scope rules). A step jump interrupts the current step.</small>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <ya-button mat-dialog-close>Cancel</ya-button>
      <ya-button appearance="primary" (click)="ok()">Go</ya-button>
    </mat-dialog-actions>
  `,
})
export class GotoDialog {
  readonly data = inject<GotoData>(MAT_DIALOG_DATA);
  readonly ref = inject(MatDialogRef<GotoDialog>);
  readonly kind = signal<'step' | 'line'>(this.data.steps.length ? 'step' : 'line');
  readonly step = signal(this.data.steps[0]?.index ?? 0);
  readonly line = signal(this.data.current ?? 1);

  ok() {
    this.ref.close(this.kind() === 'step' ? { step: this.step() } : { line: this.line() });
  }
}

// ---------------------------------------------------------------- item information

export interface ItemInfoData {
  line: number;
  source: string;
  hits: number;
  items: Item[];
}

/** SPELL 3.2.1: the items of a line, latest execution / history / raw. */
@Component({
  selector: 'fops-item-info',
  imports: [WebappSdkModule, UtcPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>Line {{ data.line }}</h2>
    <mat-dialog-content class="fops">
      <pre class="fops-src-line">{{ data.source }}</pre>
      <div class="fops-row">
        <span class="fops-mute">Executed {{ data.hits }} time(s)</span>
        <span class="fops-grow"></span>
        <label><input type="radio" name="m" [checked]="mode() === 'latest'" (change)="mode.set('latest')" /> Latest</label>
        <label><input type="radio" name="m" [checked]="mode() === 'history'" (change)="mode.set('history')" /> History</label>
        <label><input type="radio" name="m" [checked]="mode() === 'raw'" (change)="mode.set('raw')" /> Raw</label>
      </div>
      @if (mode() === 'raw') {
        <pre class="fops-raw">{{ raw() }}</pre>
      } @else {
        <table class="fops-table">
          <thead><tr><th>EX</th><th>Item</th><th>Value</th><th>Status</th><th>Time</th><th>Comment</th></tr></thead>
          <tbody>
            @for (i of shown(); track i.key) {
              <tr>
                <td class="mono">{{ i.ex }}</td>
                <td>{{ i.name }}</td>
                <td class="mono">{{ i.value }}</td>
                <td [class]="cls[i.status]">{{ i.status }}</td>
                <td class="mono">{{ i.time ? (i.time | utc) : '' }}</td>
                <td>{{ i.comment || '' }}</td>
              </tr>
            } @empty {
              <tr><td colspan="6" class="fops-mute">No items.</td></tr>
            }
          </tbody>
        </table>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end"><ya-button mat-dialog-close>Close</ya-button></mat-dialog-actions>
  `,
})
export class ItemInfoDialog {
  readonly data = inject<ItemInfoData>(MAT_DIALOG_DATA);
  readonly cls = STATUS_CLASS;
  readonly mode = signal<'latest' | 'history' | 'raw'>('latest');
  readonly shown = computed(() => {
    if (this.mode() === 'history') return this.data.items;
    const ex = Math.max(...this.data.items.map((i) => i.ex));
    return this.data.items.filter((i) => i.ex === ex);
  });
  readonly raw = computed(() => this.data.items.map((i) => JSON.stringify(i.ev)).join('\n'));
}

// ---------------------------------------------------------------- value detail

@Component({
  selector: 'fops-value-dialog',
  imports: [WebappSdkModule, UtcPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content><pre class="fops-raw">{{ data.text }}</pre></mat-dialog-content>
    <mat-dialog-actions align="end"><ya-button mat-dialog-close>Close</ya-button></mat-dialog-actions>
  `,
})
export class ValueDialog {
  readonly data = inject<{ title: string; text: string }>(MAT_DIALOG_DATA);
}

// ---------------------------------------------------------------- execution settings

export interface SettingsData {
  traceLimit: number | null;
}

/** The trace limit of an execution. */
@Component({
  selector: 'fops-settings-dialog',
  imports: [WebappSdkModule, UtcPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>Execution settings</h2>
    <mat-dialog-content class="fops fops-form">
      <label class="fops-field">
        <span>Trace limit <span class="fops-mute">(hits reported per source location; empty = unlimited)</span></span>
        <input type="number" min="0" [value]="limit()" (input)="limit.set($any($event.target).value)" />
      </label>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <ya-button mat-dialog-close>Cancel</ya-button>
      <ya-button appearance="primary" (click)="ok()">Apply</ya-button>
    </mat-dialog-actions>
  `,
})
export class SettingsDialog {
  readonly data = inject<SettingsData>(MAT_DIALOG_DATA);
  readonly ref = inject(MatDialogRef<SettingsDialog>);
  readonly limit = signal<string>(this.data.traceLimit === null ? '' : String(this.data.traceLimit));

  ok() {
    const l = this.limit();
    this.ref.close({ traceLimit: l === '' ? null : +l });
  }
}

// ---------------------------------------------------------------- preferences

@Component({
  selector: 'fops-prefs-dialog',
  imports: [WebappSdkModule, UtcPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>Preferences</h2>
    <mat-dialog-content class="fops fops-form">
      <div class="fops-h">Code view</div>
      <label class="fops-check"><input type="checkbox" [checked]="p().showItemTime" (change)="set('showItemTime', !p().showItemTime)" /> Show item time (short status + time of the latest notification)</label>
      <label class="fops-field">
        <span>Data column</span>
        <select [value]="p().dataColumn" (change)="set('dataColumn', $any($event.target).value)">
          <option value="name">item names</option>
          <option value="value">item values</option>
          <option value="both">both</option>
        </select>
      </label>
      <label class="fops-field"><span>Code font size, px</span><input type="number" min="9" max="24" [value]="p().codeFontSize" (input)="set('codeFontSize', +$any($event.target).value || 12)" /></label>
      <div class="fops-h">Execution</div>
      <label class="fops-check"><input type="checkbox" [checked]="p().autoScroll" (change)="set('autoScroll', !p().autoScroll)" /> Auto-scroll</label>
      <label class="fops-check"><input type="checkbox" [checked]="p().confirmAbort" (change)="set('confirmAbort', !p().confirmAbort)" /> Confirm before aborting</label>
      <label class="fops-check"><input type="checkbox" [checked]="p().textTimestamps" (change)="set('textTimestamps', !p().textTimestamps)" /> Timestamps in the Text view</label>
      <div class="fops-h">Prompts</div>
      <label class="fops-check"><input type="checkbox" [checked]="p().promptSound" (change)="set('promptSound', !p().promptSound)" /> Sound when a prompt waits too long</label>
      <label class="fops-field">
        <span>Prompt warning delay, s <span class="fops-mute">(0 = server default)</span></span>
        <input type="number" min="0" [value]="p().promptWarningDelay" (input)="set('promptWarningDelay', +$any($event.target).value || 0)" />
      </label>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <ya-button (click)="prefs.reset()">Defaults</ya-button>
      <ya-button appearance="primary" mat-dialog-close>Close</ya-button>
    </mat-dialog-actions>
  `,
})
export class PreferencesDialog {
  readonly prefs = inject(PrefsService);
  readonly p = this.prefs.prefs;

  set<K extends keyof Prefs>(k: K, v: Prefs[K]) {
    this.prefs.set(k, v);
  }
}
