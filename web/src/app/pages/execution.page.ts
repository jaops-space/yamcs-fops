import { ChangeDetectionStrategy, Component, computed, effect, inject, input, OnDestroy, signal, untracked } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { WebappSdkModule } from '@yamcs/webapp-sdk';
import { UtcPipe } from '../time.pipe';
import { firstValueFrom } from 'rxjs';
import { CodeView } from '../code-view';
import { FopsContext } from '../context';
import { confirm, GotoDialog, ItemInfoDialog, SettingsDialog } from '../dialogs';
import { ExecutionStore } from '../execution';
import { declaredItems } from '../items';
import { LiveParameters } from '../live';
import { Control, Ev, Inspect, ParamRef } from '../model';
import { PrefsService } from '../prefs';
import { available, ControlName, label, statusClass, stepClass } from '../status';
import { PromptPanel } from './prompt.panel';
import { ShellPanel, VariablesPanel } from './variables.panel';

type Tab = 'code' | 'steps' | 'text' | 'commands' | 'variables' | 'shell';

const MSG_KIND: Record<string, string> = {
  log: 'PROC',
  step: 'STEP',
  prompt: 'PROMPT',
  prompt_answered: 'PROMPT',
  prompt_cancelled: 'PROMPT',
  telemetry: 'TM',
  verify: 'VERIFY',
  check: 'CHECK',
  precondition: 'REQUIRES',
  waiting: 'WAIT',
  wait: 'WAIT',
  watch: 'WATCH',
  jump: 'JUMP',
  sample: 'SAMPLE',
  cleanup: 'CLEANUP',
  outcome: 'PROC',
  controller_lost: 'SYS',
  eval_result: 'SHELL',
  call: 'CALL',
};

/** SPELL's procedure view: header, control panel, prompt area and presentations. */
@Component({
  selector: 'fops-execution-page',
  imports: [WebappSdkModule, UtcPipe, CodeView, PromptPanel, VariablesPanel, ShellPanel],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ya-instance-page noscroll>
      <ya-instance-toolbar>
        <ng-template ya-instance-toolbar-label>
          <a class="fops-crumb" [href]="ctx.url('')" (click)="$event.preventDefault(); ctx.go('')">Procedures</a>
          <span class="material-symbols">chevron_right</span>
          @if (store?.st?.parentId; as parentId) {
            <a class="fops-crumb" [href]="ctx.url('executions/' + parentId)" (click)="$event.preventDefault(); ctx.go('executions/' + parentId)" title="The procedure that started this one">caller ({{ parentId }})</a>
            <span class="material-symbols">chevron_right</span>
          }
          {{ title() }} ({{ id() }})
          @if (store?.st?.procedure; as file) {
            @if (file !== title()) {
              <a class="fops-crumb fops-file" [href]="ctx.url('procedures/' + file)" (click)="$event.preventDefault(); ctx.go('procedures/' + file)" title="The procedure file; opens its details">{{ file }}</a>
            }
          }
        </ng-template>
        <ya-page-button icon="open_in_new" matTooltip="Open this execution in a window of its own" (clicked)="detach()">New window</ya-page-button>
        <ya-page-button icon="receipt_long" matTooltip="The as-run log: everything this execution did, in order" (clicked)="ctx.go('executions/' + id() + '/asrun')">As-run</ya-page-button>
        @if (store?.st?.activityId; as activityId) {
          <ya-page-button icon="playlist_play" matTooltip="The Yamcs activity that started this execution" (clicked)="ctx.goYamcs('activities/' + activityId)">Activity</ya-page-button>
        }
        <ya-page-button icon="settings" [disabled]="!store?.controlling" [matTooltip]="store?.controlling ? 'The trace limit of this execution' : 'Take control to change the settings'" (clicked)="settings()">Settings</ya-page-button>
        <ya-page-button icon="print" matTooltip="Print this page" (clicked)="print()">Print</ya-page-button>
      </ya-instance-toolbar>

      @if (store; as s) {
        @let st = s.tick() >= 0 ? s.st : null;
        <div class="fops fops-exec" [class]="statusClass(st?.activity || st?.status)">
          @if (!s.connected()) {
            <div class="fops-banner bad">Connection to the server lost: {{ s.error() }}. Retrying… A controlled procedure pauses after {{ ctx.info()?.controllerGracePeriod ?? 10 }} s without its controller.</div>
          }
          @if (st) {
            <!-- presentations control area -->
            <div class="fops-head">
              <div class="fops-stepinfo">
                <div class="fops-mute">{{ st.step ? 'Step ' + (st.step.index + 1) + ': ' + st.step.name : 'Step (none)' }}</div>
                @if (st.evaluating; as e) {
                  <div class="fops-lastmsg fops-evaluating" [title]="evaluatingText(e)">
                    <span class="material-symbols">hourglass_top</span>
                    @if (e['wait'] !== undefined) {
                      <span>wait {{ e['wait'] }} s</span>
                    }
                    @for (r of e['results']; track $index) {
                      <span [class.ok]="r.ok">{{ r.condition }}</span>
                    }
                    @if (e['left'] !== undefined) {
                      <span class="fops-countdown" [title]="'until ' + deadline(e)">{{ countdown(e) }}</span>
                    }
                  </div>
                } @else {
                  <div class="fops-lastmsg" [title]="s.lastMessage">{{ s.lastMessage }}</div>
                }
                @if (!s.ended && checkErrors().length) {
                  @let c = checkErrors()[0];
                  <div class="fops-lastmsg fops-checkmsg warn" [title]="checkText()" (click)="outline(c.line)">
                    <span class="material-symbols">warning</span>
                    line {{ c.line }}: {{ c.message }}
                    @if (checkErrors().length > 1) {
                      <span class="fops-mute">(+{{ checkErrors().length - 1 }} more)</span>
                    }
                  </div>
                }
              </div>
              <span class="fops-status big" [class]="statusClass(st.activity || st.status)">{{ label(st) }}</span>
            </div>
            @for (c of runningCalls(st); track c['call_seq']) {
              <div class="fops-banner">
                Sub-procedure {{ c['procedure'] }}
                @if (c['id']) {
                  <a [href]="ctx.url('executions/' + c['id'])" (click)="$event.preventDefault(); ctx.go('executions/' + c['id'])">execution {{ c['id'] }}</a>
                }
                <span class="fops-mute">&nbsp;{{ c['stage'] }}</span>
              </div>
            }

            <!-- control panel -->
            <div class="fops-controls">
              <ya-button icon="play_arrow" [disabled]="!may('resume')" (click)="send({ cmd: 'resume' })" title="Run until the end, a breakpoint or a prompt (F5)">Run</ya-button>
              <ya-button icon="pause" [disabled]="!may('pause')" (click)="send({ cmd: 'pause' })" title="Pause at the next line (F6)">Pause</ya-button>
              <ya-button icon="step_into" [disabled]="!may('step')" (click)="send({ cmd: 'step' })" title="Run the next line; if it calls a function of the procedure, pause on that function's first line (F7)">Step into</ya-button>
              <ya-button icon="step_over" [disabled]="!may('step_over')" (click)="send({ cmd: 'step_over' })" title="Run the next line, including the functions it calls, and pause on the line after it (F8)">Step over</ya-button>
              <ya-button icon="skip_next" [disabled]="!may('skip')" (click)="send({ cmd: 'skip' })" title="Skip the current line without running it, and pause at the next">Skip</ya-button>
              <ya-button icon="move_down" [disabled]="!may('goto')" (click)="gotoDialog()" title="Jump to a step or a line, without running what is in between">Goto…</ya-button>
              <ya-button icon="stop" [disabled]="!may('abort')" (click)="abort()" title="Stop the procedure; its cleanup steps still run">Abort</ya-button>
              <ya-button icon="replay" [disabled]="!available(st, 'restart') || !ctx.privileges.start" title="Start the procedure again from the top, in a new execution: its current version, the same arguments, breakpoints and options" (click)="restart()">Restart</ya-button>
              <ya-button icon="dangerous" [disabled]="!available(st, 'kill') || !ctx.privileges.kill" (click)="kill()" title="Kill the worker process at once: no cleanup steps run">Kill</ya-button>
              <span class="fops-sep"></span>
              <label class="fops-check" title="Keep the current line in view"><input type="checkbox" [checked]="prefs.prefs().autoScroll" (change)="prefs.set('autoScroll', !prefs.prefs().autoScroll)" /> Auto-scroll</label>
              <label class="fops-check" title="Pause before the body of each step"><input type="checkbox" [checked]="!!st.options?.byStep" (change)="setOption('by_step', !st.options?.byStep)" [disabled]="mode() !== 'ctrl'" /> By step</label>
              <label class="fops-check" title="Ask before sending each command; SEVERE and CRITICAL commands always ask"><input type="checkbox" [checked]="!!st.options?.confirmCommands" (change)="setOption('confirm_commands', !st.options?.confirmCommands)" [disabled]="mode() !== 'ctrl'" /> TC confirm</label>
              <span class="fops-grow"></span>
              <span class="fops-mute">
                @if (s.ended) {
                  ended
                } @else if (st.controller) {
                  controlled by {{ st.controller.user }}{{ s.controlling ? ' (this tab)' : '' }}
                } @else {
                  no controller{{ st.background ? ', in background' : '' }}
                }
                @if (st.monitors.length) {
                  · monitored by {{ st.monitors.join(', ') }}
                }
              </span>
              @if (!s.controlling && !s.ended && ctx.privileges.control) {
                <ya-button icon="sports_esports" [disabled]="!!st.controller" (click)="action('takeControl')" [title]="st.controller ? 'Controlled by ' + st.controller.user + '; they must release it first' : 'Control this execution from this tab'">Take control</ya-button>
              }
              @if (s.controlling && !s.ended) {
                <ya-button icon="logout" (click)="action('releaseControl')" title="Give up control: the procedure goes on in the background, and another operator can take it">Release</ya-button>
              }
            </div>

            <!-- prompts -->
            @for (p of openPrompts(); track p['id']) {
              <fops-prompt [prompt]="p" [enabled]="mode() === 'ctrl'" [warnAfter]="promptDelay()" (answer)="answer(p['id'], $event)" />
            }

            @if (st.finished) {
              <div class="fops-banner" [class]="st.status === 'finished' ? 'ok' : 'bad'">
                @if (st.finished['line']; as line) {
                  {{ st.status | uppercase }}: <a class="fops-goto" (click)="outline(line)" title="Show the line">line {{ line }}</a>:
                  {{ st.finished['message'].replace('line ' + line + ': ', '') }}
                } @else {
                  {{ st.status | uppercase }}: {{ st.finished['message'] }}
                }
                @if (st.finished['elapsed_ms']) {
                  <span class="fops-mute">({{ (st.finished['elapsed_ms'] / 1000).toFixed(1) }} s)</span>
                }
              </div>
            }

            <div class="fops-body">
              <div class="fops-main">
                <div class="fops-tabs">
                  @for (t of tabs; track t.id) {
                    <button [class.active]="tab() === t.id" (click)="tab.set(t.id)">{{ t.label }}</button>
                  }
                </div>
                <div class="fops-pane">
                  @switch (tab()) {
                    @case ('code') {
                      @if (source() !== null) {
                        <fops-code
                          [source]="source()!"
                          [store]="s"
                          [tick]="s.tick()"
                          [breakpoints]="st.breakpoints"
                          [tempBreakpoints]="runTo() ? [runTo()!] : []"
                          [controlling]="mode() === 'ctrl'"
                          [autoScroll]="prefs.prefs().autoScroll"
                          [reveal]="reveal()"
                          [check]="inspect()?.check ?? []"
                          [params]="params()"
                          [live]="live"
                          (toggleBreakpoint)="toggleBreakpoint($event)"
                          (clearBreakpoints)="clearBreakpoints()"
                          (runTo)="runToLine($event)"
                          (gotoLine)="send({ cmd: 'goto_line', line: $event })"
                          (itemInfo)="itemInfo($event)" />
                      } @else {
                        <ya-dots />
                      }
                    }
                    @case ('steps') {
                      <table class="fops-table">
                        <thead><tr><th>#</th><th>Step</th><th>Execution</th><th>Confirmation</th><th>Detail</th><th></th></tr></thead>
                        <tbody>
                          @for (s of stepRows(); track s.index) {
                            <tr [class.active]="st.step?.index === s.index && !st.finished">
                              <td class="mono">{{ s.index + 1 }}</td>
                              <td>{{ s.name }} @if (s.cleanup) {<span class="fops-tag">cleanup</span>}</td>
                              <td [class]="stepClass(s.ev?.['execution'])">{{ s.ev?.['execution'] || '' }}</td>
                              <td [class]="stepClass(s.ev?.['confirmation'])">{{ s.ev?.['confirmation'] || '' }}</td>
                              <td class="fops-msg" [title]="st.step?.index === s.index && st.evaluating ? evaluatingText(st.evaluating) : ''">
                                @if (st.step?.index === s.index && st.evaluating; as e) {
                                  {{ evaluatingText(e) }}
                                } @else {
                                  {{ s.ev?.['note'] || s.ev?.['error'] || '' }}
                                }
                              </td>
                              <td><ya-text-action icon="move_down" [disabled]="mode() !== 'ctrl' || !!st.finished" (click)="send({ cmd: 'goto_step', index: s.index })">Go to</ya-text-action></td>
                            </tr>
                          } @empty {
                            <tr><td colspan="6" class="fops-mute">This procedure has no steps.</td></tr>
                          }
                        </tbody>
                      </table>
                    }
                    @case ('text') {
                      <div class="fops-row fops-pad">
                        <label class="fops-check"><input type="checkbox" [checked]="prefs.prefs().textTimestamps" (change)="prefs.set('textTimestamps', !prefs.prefs().textTimestamps)" /> Timestamps</label>
                        @for (k of kinds; track k) {
                          <label class="fops-check"><input type="checkbox" [checked]="!hidden().has(k)" (change)="toggleKind(k)" /> {{ k }}</label>
                        }
                      </div>
                      <div class="fops-text">
                        @for (m of textRows(); track $index) {
                          <div class="fops-msgline" [class]="m.cls">
                            @if (prefs.prefs().textTimestamps) {
                              <span class="ts">{{ m.time }}</span>
                            }
                            <span class="kind">{{ m.kind }}</span>
                            <span class="txt">{{ m.text }}</span>
                          </div>
                        }
                      </div>
                    }
                    @case ('commands') {
                      <table class="fops-table">
                        <thead><tr><th>#</th><th>Command</th><th>Arguments</th><th>Stage</th><th>Line</th><th>Time</th><th>Yamcs id</th></tr></thead>
                        <tbody>
                          @for (c of commandRows(); track c.seq) {
                            <tr (click)="reveal.set({ line: c.line }); tab.set('code')" [title]="c.stages">
                              <td class="mono">{{ c.seq }}</td>
                              <td class="mono">{{ c.name }}</td>
                              <td class="mono fops-msg">{{ c.args }}</td>
                              <td [class]="c.cls">{{ c.stage }}{{ c.detail ? ': ' + c.detail : '' }}</td>
                              <td class="mono">{{ c.line }}</td>
                              <td class="mono">{{ c.time | utc }}</td>
                              <td class="mono">{{ c.yamcsId || '' }}</td>
                            </tr>
                          } @empty {
                            <tr><td colspan="7" class="fops-mute">No commands.</td></tr>
                          }
                        </tbody>
                      </table>
                    }
                    @case ('variables') {
                      <fops-variables [store]="s" [tick]="s.tick()" [editable]="s.controlling && ctx.privileges.shell" />
                    }
                    @case ('shell') {
                      <fops-shell [store]="s" [tick]="s.tick()" [enabled]="s.controlling && ctx.privileges.shell" />
                    }
                  }
                </div>
              </div>

              <!-- outline -->
              <aside class="fops-outline">
                <div class="fops-h">Outline</div>
                @if (inspect(); as i) {
                  @for (s of i.steps; track s.index) {
                    <div class="fops-ol" (click)="outline(s.line)" [title]="'line ' + s.line">
                      <span class="material-symbols">flag</span>{{ s.index + 1 }}. {{ s.name }}
                      <span class="fops-dot" [class]="stepClass(st.steps[s.index]?.['confirmation'] || st.steps[s.index]?.['execution'])"></span>
                    </div>
                  }
                  @for (w of i.watches; track w.line) {
                    <div class="fops-ol" (click)="outline(w.line)"><span class="material-symbols">visibility</span>{{ w.condition }}</div>
                  }
                  @for (f of i.functions; track f.line) {
                    <div class="fops-ol" (click)="outline(f.line)"><span class="material-symbols">function</span>{{ f.name }}</div>
                  }
                } @else {
                  <div class="fops-mute">-</div>
                }
              </aside>
            </div>
          } @else {
            <ya-dots />
          }
        </div>
      }
    </ya-instance-page>
  `,
})
export class ExecutionPage implements OnDestroy {
  readonly ctx = inject(FopsContext);
  readonly prefs = inject(PrefsService);
  private readonly docTitle = inject(Title);
  readonly id = input.required<number>();
  readonly statusClass = statusClass;
  readonly stepClass = stepClass;
  readonly label = label;
  readonly available = available;
  readonly runningCalls = runningCalls;

  readonly tabs: { id: Tab; label: string }[] = [
    { id: 'code', label: 'Code' },
    { id: 'steps', label: 'Steps' },
    { id: 'text', label: 'Text' },
    { id: 'commands', label: 'Commands' },
    { id: 'variables', label: 'Variables' },
    { id: 'shell', label: 'Shell' },
  ];
  readonly kinds = ['PROC', 'STEP', 'PROMPT', 'TM', 'VERIFY', 'WAIT', 'WATCH', 'SYS', 'SHELL', 'OTHER'];

  private readonly _store = signal<ExecutionStore | null>(null);
  /** Read through a signal so computeds follow the store when the id changes. */
  get store(): ExecutionStore | null {
    return this._store();
  }
  readonly tab = signal<Tab>('code');
  readonly source = signal<string | null>(null);
  readonly inspect = signal<Inspect | null>(null);
  readonly runTo = signal<number | null>(null);
  readonly reveal = signal<{ line: number } | null>(null);
  readonly hidden = signal(new Set<string>());
  private loadedFor = '';

  /** Live values of the procedure's parameters: shown on hover in the code. */
  readonly live = new LiveParameters(this.ctx.yamcs.yamcsClient, this.ctx.instance, this.ctx.info()?.processor ?? 'realtime');
  /** The names of the procedure that are MDB parameters (from its `procedure` event). */
  readonly params = computed(() => {
    this.store?.tick();
    return (this.store?.st?.procedureInfo?.['parameters'] as Record<string, ParamRef> | undefined) ?? null;
  });

  constructor() {
    effect(() => this.docTitle.setTitle(this.title() + ' (' + this.id() + ')'));
    effect(() => {
      const params = this.params();
      untracked(() => this.live.follow(Object.values(params ?? {}).map((p) => p.name)));
    });
    effect((onCleanup) => {
      const id = this.id();
      untracked(() => {
        this.store?.stop();
        const store = new ExecutionStore(this.ctx.api, id);
        this.source.set(null);
        this.inspect.set(null);
        this.loadedFor = '';
        this._store.set(store);
        store.start();
      });
      onCleanup(() => this.store?.stop());
    });
    // load the source once the procedure path is known
    effect(() => {
      this.store?.tick();
      const st = this.store?.st;
      if (st && st.procedure && this.loadedFor !== st.procedure) {
        this.loadedFor = st.procedure;
        untracked(() => this.loadSource(this.id(), st.procedure));
      }
    });
    // the temporary breakpoint goes when the procedure pauses
    effect(() => {
      this.store?.tick();
      if (this.runTo() !== null && this.store?.st?.status !== 'running') {
        const cur = this.store?.st?.current;
        if (cur?.type === 'paused' || this.store?.ended) untracked(() => this.runTo.set(null));
      }
    });
    window.addEventListener('keydown', this.keys);
    this.clock = window.setInterval(() => {
      if (this.store?.st?.evaluating) this.now.set(Date.now());
    }, 250);
  }

  ngOnDestroy() {
    clearInterval(this.clock);
    this.live.cancel();
    this.store?.stop();
    window.removeEventListener('keydown', this.keys);
  }

  /** The code the execution ran; the procedure as it is now for one started before that was kept. */
  private async loadSource(id: number, path: string) {
    try {
      const d = await this.ctx.api.executionProcedure(id).catch(() => this.ctx.api.procedure(path));
      if (id !== this.id()) return;
      this.source.set(d.source);
      this.inspect.set(d.inspect ?? null);
    } catch {
      this.source.set('# source not available');
    }
  }

  /** What `fops check` finds in the procedure (its warnings left out): errors at run time. */
  readonly checkErrors = computed(() => (this.inspect()?.check ?? []).filter((c) => !c.message.startsWith('warning:')));
  readonly checkText = computed(() => this.checkErrors().map((c) => 'line ' + c.line + ': ' + c.message).join('\n'));

  readonly title = computed(() => {
    this.store?.tick();
    return this.store?.st?.name || this.store?.st?.procedure || 'Execution';
  });

  /** ctrl (this tab controls), bg (nobody does) or mon. */
  readonly mode = computed(() => {
    this.store?.tick();
    const s = this.store;
    if (!s?.st) return 'mon';
    if (s.controlling && !s.ended) return 'ctrl';
    if (!s.st.controller && s.st.background) return 'bg';
    return 'mon';
  });

  readonly openPrompts = computed(() => {
    this.store?.tick();
    return Object.values(this.store?.st?.prompts ?? {});
  });

  readonly promptDelay = computed(() => this.prefs.prefs().promptWarningDelay || this.ctx.info()?.promptWarningDelay || 0);

  /** A goal, wait_until or wait in progress: its conditions (the invariants of a wait), with their current values. */
  evaluatingText(e: Ev): string {
    const conds = (e['results'] ?? []).map((r: any) => (r.ok ? '✓ ' : '') + r.condition);
    return [...(e['wait'] !== undefined ? [`wait ${e['wait']} s`] : []), ...conds].join(' · ');
  }

  /** When a goal, wait_until or wait gives up. */
  deadline(e: Ev): string {
    return new Date(Date.parse(e.time ?? '') + (e['left'] ?? 0) * 1000).toISOString();
  }

  /** Ticks every second while something is evaluated, for the countdown. */
  private readonly now = signal(Date.now());
  private clock?: number;

  /** Time left, from the latest evaluating event and this browser's clock (no skew with the server's). */
  countdown(e: Ev): string {
    const left = Math.max(0, Math.ceil(e['left'] - (this.now() - e['received']) / 1000));
    return left < 60 ? `${left} s` : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }

  readonly stepRows = computed(() => {
    this.store?.tick();
    const st = this.store?.st;
    const known = this.inspect()?.steps ?? (st?.procedureInfo?.['steps'] as any[]) ?? [];
    const rows = known.map((s: any, i: number) => ({ index: s.index ?? i, name: s.name, cleanup: !!s.cleanup, ev: st?.steps[s.index ?? i] as Ev | undefined }));
    for (const [k, ev] of Object.entries(st?.steps ?? {})) {
      if (!rows.some((r) => r.index === +k)) rows.push({ index: +k, name: ev['name'], cleanup: false, ev });
    }
    return rows.sort((a, b) => a.index - b.index);
  });

  readonly textRows = computed(() => {
    this.store?.tick();
    const hidden = this.hidden();
    return (this.store?.messages ?? [])
      .map((m) => ({ ev: m, kind: MSG_KIND[m.type] ?? 'OTHER' }))
      .filter((m) => !hidden.has(m.kind) && !(hidden.has('OTHER') && !MSG_KIND[m.ev.type]))
      .map(({ ev, kind }) => ({ kind, time: ev.time ? ev.time.slice(11, 23) : '', text: describe(ev), cls: msgClass(ev) }));
  });

  readonly commandRows = computed(() => {
    this.store?.tick();
    const by = new Map<number, Ev[]>();
    for (const c of this.store?.st?.commands ?? []) {
      const list = by.get(c['seq']) ?? [];
      list.push(c);
      by.set(c['seq'], list);
    }
    return [...by.entries()].map(([seq, evs]) => {
      const last = evs[evs.length - 1];
      const args = evs.find((e) => e['args'])?.['args'];
      const options = evs.find((e) => e['options'])?.['options'];
      return {
        seq,
        name: last['name'],
        args: (args ? JSON.stringify(args) : '') + (options ? ' options ' + JSON.stringify(options) : ''),
        stage: last['stage'],
        detail: last['detail'],
        line: last.line ?? 0,
        time: last.time ?? last['time'],
        yamcsId: evs.find((e) => e['yamcs_id'])?.['yamcs_id'],
        stages: evs.map((e) => `${e['time'] ?? ''} ${e['stage']}${e['detail'] ? ': ' + e['detail'] : ''}`).join('\n'),
        cls: last['stage'] === 'completed' ? 'ok' : ['failed', 'timeout', 'rejected'].includes(last['stage']) ? 'bad' : last['stage'] === 'abandoned' ? 'warn' : 'prog',
      };
    });
  });

  may(c: ControlName): boolean {
    return this.mode() === 'ctrl' && available(this.store?.st ?? null, c);
  }

  async send(c: Control) {
    try {
      await this.store?.control(c);
    } catch (e) {
      this.ctx.error(e);
    }
  }

  setOption(k: 'by_step' | 'confirm_commands', v: boolean) {
    this.send({ cmd: 'set_options', [k]: v } as Control);
  }

  async abort() {
    if (this.prefs.prefs().confirmAbort && !(await confirm(this.ctx.dialog, 'Abort', 'Abort this procedure? Cleanup steps will run.'))) return;
    this.send({ cmd: 'abort' });
  }

  async kill() {
    const ok = await confirm(
      this.ctx.dialog,
      'Kill',
      'Kill the worker process? This is not a graceful stop: no cleanup steps run, and the spacecraft may be left in an inconsistent state.',
    );
    if (!ok) return;
    try {
      await this.ctx.api.action(this.id(), 'kill');
    } catch (e) {
      this.ctx.error(e);
    }
  }

  async restart() {
    try {
      const { id } = await this.ctx.api.restart(this.id());
      this.ctx.go('executions/' + id);
    } catch (e) {
      this.ctx.error(e);
    }
  }

  async action(a: 'takeControl' | 'releaseControl') {
    try {
      await this.ctx.api.action(this.id(), a);
    } catch (e) {
      this.ctx.error(e);
    }
  }

  answer(id: number, value: string) {
    this.send({ cmd: 'answer', id, value });
  }

  toggleBreakpoint(line: number) {
    const st = this.store?.st;
    if (!st || this.mode() !== 'ctrl') return;
    const enabled = !st.breakpoints.includes(line);
    st.breakpoints = enabled ? [...st.breakpoints, line] : st.breakpoints.filter((l) => l !== line);
    this.store!.tick.update((t) => t + 1);
    this.send({ cmd: 'breakpoint', line, enabled });
  }

  clearBreakpoints() {
    for (const l of [...(this.store?.st?.breakpoints ?? [])]) this.toggleBreakpoint(l);
  }

  runToLine(line: number) {
    this.runTo.set(line);
    this.send({ cmd: 'run_to', line });
  }

  async gotoDialog() {
    const steps = this.stepRows().map((s) => ({ index: s.index, name: s.name }));
    const ref = this.ctx.dialog.open(GotoDialog, { width: '420px', data: { steps, current: this.store?.st?.current?.line } });
    const r = await firstValueFrom(ref.afterClosed());
    if (!r) return;
    if (r.step !== undefined) this.send({ cmd: 'goto_step', index: r.step });
    else this.send({ cmd: 'goto_line', line: r.line });
  }

  itemInfo(line: number) {
    const s = this.store!;
    const items = [...(s.items.get(line) ?? [])];
    const step = (s.st?.procedureInfo?.steps ?? []).find((st: any) => st.line === line);
    if (step) items.push(...declaredItems(step, items, s.hitsOf(line)));
    this.ctx.dialog.open(ItemInfoDialog, {
      width: '900px',
      data: { line, source: (this.source() ?? '').split('\n')[line - 1] ?? '', hits: s.hitsOf(line), items },
    });
  }

  outline(line: number) {
    this.tab.set('code');
    this.reveal.set({ line });
  }

  toggleKind(k: string) {
    const h = new Set(this.hidden());
    h.has(k) ? h.delete(k) : h.add(k);
    this.hidden.set(h);
  }

  async settings() {
    const st = this.store?.st;
    const ref = this.ctx.dialog.open(SettingsDialog, {
      width: '460px',
      data: { traceLimit: st?.traceLimit ?? null },
    });
    const r = await firstValueFrom(ref.afterClosed());
    if (!r) return;
    if (r.traceLimit !== (st?.traceLimit ?? null)) {
      await this.send({ cmd: 'set_trace_limit', limit: r.traceLimit });
      if (st) st.traceLimit = r.traceLimit;
    }
  }

  detach() {
    window.open(this.ctx.absolute('executions/' + this.id()), `fops-${this.id()}`);
  }

  print() {
    window.print();
  }

  private keys = (e: KeyboardEvent) => {
    if (this.mode() !== 'ctrl' || (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
    const map: Record<string, () => void> = {
      F5: () => this.may('resume') && this.send({ cmd: 'resume' }),
      F6: () => this.may('pause') && this.send({ cmd: 'pause' }),
      F7: () => this.may('step') && this.send({ cmd: 'step' }),
      F8: () => this.may('step_over') && this.send({ cmd: 'step_over' }),
    };
    if (map[e.key]) {
      e.preventDefault();
      map[e.key]();
    }
  };
}

/** The sub-procedures not ended, of a running execution. */
function runningCalls(st: { calls?: Record<string, Ev>; finished: Ev | null }): Ev[] {
  if (st.finished) return [];
  return Object.values(st.calls ?? {}).filter((c) => !['ended', 'rejected'].includes(c['stage']));
}

function conds(results: any[] | undefined) {
  return (results ?? []).map((r) => `${r.ok ? '✓' : '✗'} ${r.condition}`).join('; ');
}

/** One line of the Text presentation. */
export function describe(e: Ev): string {
  switch (e.type) {
    case 'step':
      return `step ${e['index'] + 1} "${e['name']}": ${e['execution']}${e['confirmation'] ? ', ' + e['confirmation'] : ''}${e['note'] ? ' (' + e['note'] + ')' : ''}${e['error'] ? ': ' + e['error'] : ''}`;
    case 'outcome':
      return `procedure ${e['execution']}${e['confirmation'] ? ', ' + e['confirmation'] : ''}${e['message'] ? ': ' + e['message'] : ''}`;
    case 'cleanup':
      return `running cleanup steps ${(e['steps'] ?? []).map((i: number) => i + 1).join(', ')} (${e['reason']})`;
    case 'check':
    case 'precondition':
      return (e['goal'] ? 'goal not reached: ' : '') + conds(e['results']);
    case 'verify':
      return (e['invariant'] ? 'invariant ' : '') + conds(e['results']);
    case 'sample':
      return Object.entries(e['values'] ?? {}).map(([n, v]: [string, any]) => `${n} = ${JSON.stringify(Array.isArray(v) ? v[0] : v)}`).join(', ');
    case 'log':
      return e['message'];
    case 'output':
      return e['text'];
    case 'telemetry':
      return `${e['name']} = ${JSON.stringify(e['value'])}${e['valid'] ? '' : ' (invalid)'}`;
    case 'set':
      return `set ${e['name']} := ${JSON.stringify(e['value'])}${e['units'] ? ' ' + e['units'] : ''}${e['ok'] ? '' : ' FAILED: ' + e['detail']}`;
    case 'waiting':
      return `waiting until ${e['condition']} (max ${e['within']} s)`;
    case 'wait':
      return e['until'] ? `waiting until ${e['until']}` : `waiting ${e['seconds']} s`;
    case 'watch':
      return `${e['message'] ?? ''} → ${e['action']}`;
    case 'jump':
      return `jump: step ${e['source'] + 1} → step ${e['target'] + 1}`;
    case 'procedure': {
      const args = Object.entries(e['arg_values'] ?? {}).map(([n, v]) => `${n}=${JSON.stringify(v)}`).join(', ');
      return `procedure "${e['name'] ?? ''}"${e['version'] ? ' ' + e['version'] : ''}: ${(e['steps'] ?? []).length} steps${args ? '; ' + args : ''}`;
    }
    case 'finished':
      return `${String(e['status']).toUpperCase()}${e['message'] ? ': ' + e['message'] : ''}${e['elapsed_ms'] ? ` (${(e['elapsed_ms'] / 1000).toFixed(1)} s)` : ''}`;
    case 'prompt':
      return `? ${e['message']}${e['options']?.length ? ' [' + e['options'].join(', ') + ']' : ''}`;
    case 'prompt_answered':
      return `answer: ${e['answer']}`;
    case 'prompt_cancelled':
      return `prompt withdrawn: ${e['reason']}`;
    case 'controller_lost':
      return `controller ${e['user']} lost: ${e['action']}`;
    case 'eval_result':
      return `>>> ${e['expr']}\n${e['ok'] ? e['output'] : e['error']}`;
    case 'call': {
      const exec = e['id'] ? ` (execution ${e['id']})` : '';
      const args = Object.entries(e['args'] ?? {}).map(([n, v]) => `${n}=${JSON.stringify(v)}`).join(', ');
      const end = e['stage'] === 'ended' ? `: ${e['status']}${e['confirmation'] ? ', ' + e['confirmation'] : ''}` : '';
      return `${e['procedure']}${args ? '(' + args + ')' : ''}${exec} ${e['stage']}${end}${e['detail'] ? ' — ' + e['detail'] : ''}`;
    }
    default:
      return JSON.stringify(e);
  }
}

function msgClass(e: Ev): string {
  if (e.type === 'prompt') return 'm-prompt';
  if (e.type === 'output') return e['stream'] === 'stderr' ? 'm-warning' : '';
  if (e.type === 'log') return e['level'] === 'error' ? 'm-error' : e['level'] === 'warning' ? 'm-warning' : '';
  if (e.type === 'verify' || e.type === 'precondition') return e['ok'] ? '' : 'm-error';
  if (e.type === 'step') return e['confirmation'] === 'not confirmed' || e['execution'] === 'aborted' ? 'm-error' : 'm-step';
  if (e.type === 'watch' || e.type === 'controller_lost') return 'm-warning';
  if (e.type === 'call') return e['stage'] === 'rejected' || (e['stage'] === 'ended' && e['confirmation'] !== 'confirmed') ? 'm-error' : e['stage'] === 'aborting' ? 'm-warning' : '';
  return '';
}
