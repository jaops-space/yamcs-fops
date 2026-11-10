import { signal } from '@angular/core';
import { FopsApi, SESSION, errorText } from './api';
import { Item, ItemStatus, mergeItems } from './items';
import { Control, ENDED, Ev, State } from './model';

/** The events after which no goal, wait_until or wait is in progress (as the plugin). */
const ENDS_EVALUATING = new Set(['line', 'verify', 'precondition', 'step', 'jump', 'finished', 'killed', 'crashed']);

const LOG_CAP = 2000;

/**
 * Live state of one execution: a snapshot, then events from the plugin's
 * long poll, applied here as the plugin applies them (ExecState.java).
 * The state is mutated in place; `tick` changes after each
 * batch so views recompute.
 */
export class ExecutionStore {
  st: State | null = null;
  readonly tick = signal(0);
  /** false while the plugin cannot be reached (SPELL: communication failure). */
  readonly connected = signal(true);
  readonly error = signal<string | null>(null);

  /** Items per source line of the main file. */
  readonly items = new Map<number, Item[]>();
  /** Messages for the Text presentation (bounded). */
  readonly messages: Ev[] = [];
  /** eval results and variable dumps, by request id. */
  readonly results = new Map<number, Ev>();
  /** Latest message shown in the header. */
  lastMessage = '';

  private readonly promptLines = new Map<number, number>();
  /** The item of the wait in progress: no event ends a wait, the procedure moving on does. */
  private openWait: Item | null = null;
  private abort = new AbortController();
  private stopped = false;
  private requestId = 1;

  constructor(
    readonly api: FopsApi,
    readonly id: number,
  ) {}

  start() {
    this.loop();
  }

  stop() {
    this.stopped = true;
    this.abort.abort();
  }

  get mainCodes(): Set<number> {
    return new Set((this.st?.codes ?? []).filter((c) => c.main).map((c) => c.code_id));
  }

  get ended() {
    return !!this.st && ENDED.has(this.st.status);
  }

  /** Controlled by this tab. */
  get controlling() {
    return this.st?.controller?.session === SESSION;
  }

  /** Line hit count of the main file. */
  hitsOf(line: number): number {
    if (!this.st) return 0;
    let n = 0;
    for (const c of this.mainCodes) n = Math.max(n, this.st.hits[`${c}:${line}`] ?? 0);
    return n;
  }

  suppressedAt(line: number): boolean {
    if (!this.st) return false;
    for (const c of this.mainCodes) if (this.st.suppressed.includes(`${c}:${line}`)) return true;
    return false;
  }

  nextRequestId() {
    return this.requestId++;
  }

  async control(c: Control) {
    try {
      await this.api.control(this.id, c);
    } catch (e) {
      this.error.set(errorText(e));
      throw e;
    }
  }

  private async loop() {
    let after = 0;
    let failures = 0;
    while (!this.stopped) {
      try {
        const r = await this.api.events(this.id, after, this.abort.signal);
        failures = 0;
        this.connected.set(true);
        if (r.snapshot) this.load(r.snapshot);
        for (const ev of r.events ?? []) this.apply(ev);
        after = r.seq;
        this.tick.update((t) => t + 1);
        // after the end, one more poll collects stragglers; then stop
        if (this.ended && !(r.events ?? []).length && !r.snapshot) break;
      } catch (e: any) {
        if (this.stopped) return;
        failures++;
        if (e?.statusCode === 404) {
          this.error.set('no such execution');
          return;
        }
        this.connected.set(false);
        this.error.set(errorText(e));
        await new Promise((r) => setTimeout(r, Math.min(1000 * failures, 5000)));
      }
    }
  }

  private load(s: any) {
    const st = s as State;
    st.codes ??= [];
    st.steps ??= {};
    st.hits ??= {};
    st.suppressed ??= [];
    st.breakpoints ??= [];
    st.log ??= [];
    st.commands ??= [];
    st.prompts ??= {};
    if (st.evaluating) st.evaluating['received'] = Date.now();
    this.st = st;
    this.items.clear();
    this.promptLines.clear();
    this.openWait = null;
    this.messages.length = 0;
    // Rebuild items and messages from what the snapshot retains (bounded log + all commands).
    for (const ev of [...st.log, ...st.commands]) ExecutionStore.normalize(ev);
    const evs = [...st.log, ...st.commands].sort((a, b) => (a.eseq ?? 0) - (b.eseq ?? 0));
    for (const ev of evs) this.index(ev);
    // the log is bounded and may have lost the end
    if (st.finished?.['message']) this.lastMessage = st.finished['message'];
  }

  /**
   * Event sequence number in `eseq` and a command record's own number in `seq`
   * (the contract), also from the variant `seq` + `command_seq`.
   */
  static normalize(ev: Ev): Ev {
    if (ev.eseq === undefined && ev['command_seq'] !== undefined) {
      ev.eseq = ev['seq'];
      ev['seq'] = ev['command_seq'];
    } else if (ev.eseq === undefined && ev.type !== 'command' && typeof ev['seq'] === 'number') {
      ev.eseq = ev['seq'];
    }
    return ev;
  }

  /** Port of ExecState.apply, plus the plugin's own events. */
  private apply(ev: Ev) {
    ExecutionStore.normalize(ev);
    const st = this.st;
    if (!st) return;
    st.seq = ev.eseq ?? st.seq;
    const key = () => `${ev['code_id']}:${ev.line}`;
    if (ENDS_EVALUATING.has(ev.type)) st.evaluating = null;
    switch (ev.type) {
      case 'evaluating':
        // shown live, not an item or a message; `left` counts from its arrival
        ev['received'] = Date.now();
        st.evaluating = ev;
        return;
      case 'started':
        st.status = 'running';
        st.activity = 'running';
        break;
      case 'code':
        st.codes.push(ev);
        break;
      case 'line':
        this.endWait(ev);
        st.hits[key()] = ev['n'];
        st.current = ev;
        if (st.activity === 'waiting' || st.activity === 'paused' || st.activity === 'loaded') st.activity = 'running';
        if (st.status === 'paused') st.status = 'running';
        break;
      case 'suppressed':
        if (!st.suppressed.includes(key())) st.suppressed.push(key());
        break;
      case 'paused':
        st.status = 'paused';
        st.activity = Object.keys(st.prompts).length ? 'prompt' : ev['reason'] === 'start' ? 'loaded' : 'paused';
        st.current = ev;
        break;
      case 'resumed':
        st.status = 'running';
        st.activity = Object.keys(st.prompts).length ? 'prompt' : 'running';
        break;
      case 'procedure':
        st.procedureInfo = ev;
        st.name = ev['name'];
        st.version = ev['version'];
        break;
      case 'step':
        st.steps[ev['index']] = ev;
        st.step = { index: ev['index'], name: ev['name'], execution: ev['execution'], confirmation: ev['confirmation'] };
        this.pushLog(ev);
        break;
      case 'command':
        st.commands.push(ev);
        break;
      case 'call': {
        const calls = (st.calls ??= {});
        const prev = calls[ev['call_seq']];
        calls[ev['call_seq']] = { ...ev, id: ev['id'] ?? prev?.['id'] };
        if (ev['stage'] === 'waiting') st.activity = 'waiting';
        this.pushLog(ev);
        break;
      }
      case 'prompt':
        st.prompts[ev['id']] = ev;
        st.activity = 'prompt';
        this.pushLog(ev);
        break;
      case 'prompt_answered':
      case 'prompt_cancelled':
        delete st.prompts[ev['id']];
        if (!Object.keys(st.prompts).length && st.activity === 'prompt') st.activity = st.status === 'paused' ? 'paused' : 'running';
        this.pushLog(ev);
        break;
      case 'waiting':
      case 'wait':
        st.activity = 'waiting';
        this.pushLog(ev);
        break;
      case 'finished':
        st.status = ev['status'] ?? 'finished';
        st.activity = st.status;
        st.finished = ev;
        st.prompts = {};
        st.ended = ev.time;
        break;
      case 'killed':
        st.status = 'killed';
        st.activity = 'killed';
        st.prompts = {};
        break;
      case 'options':
        st.options = { byStep: ev['by_step'], confirmCommands: ev['confirm_commands'] };
        break;
      case 'variables':
        st.variables = ev;
        this.results.set(ev['request_id'], ev);
        break;
      case 'eval_result':
        this.results.set(ev['request_id'], ev);
        this.pushLog(ev);
        break;
      case 'control':
        st.controller = ev['controller'] ?? null;
        st.monitors = ev['monitors'] ?? [];
        st.background = !!ev['background'];
        break;
      case 'controller_lost':
        this.pushLog(ev);
        break;
      case 'breakpoint':
        // echoed by the plugin when a breakpoint changes
        if (ev['enabled']) {
          if (!st.breakpoints.includes(ev.line!)) st.breakpoints.push(ev.line!);
        } else st.breakpoints = st.breakpoints.filter((l) => l !== ev.line);
        break;
      default:
        if (['log', 'output', 'telemetry', 'verify', 'precondition', 'watch', 'jump', 'sample', 'check', 'set', 'cleanup', 'outcome'].includes(ev.type)) {
          this.pushLog(ev);
        }
    }
    if (ev.type !== 'line' && ev.type !== 'suppressed') this.index(ev);
  }

  private pushLog(ev: Ev) {
    const st = this.st!;
    if (st.log.length >= LOG_CAP) st.log.shift();
    st.log.push(ev);
  }

  /** Closes the item of the wait in progress once the procedure goes on. */
  private endWait(ev: Ev) {
    const w = this.openWait;
    if (!w) return;
    let status: ItemStatus;
    switch (ev.type) {
      case 'verify':
        // the result of a wait until
        if (ev['waited'] === undefined) return;
        status = ev['ok'] ? 'SUCCESS' : 'TIMEOUT';
        break;
      case 'line':
      case 'command':
      case 'call':
        status = 'SUCCESS';
        break;
      case 'step':
        status = ev['confirmation'] === 'aborted' ? 'CANCELLED' : 'SUCCESS';
        break;
      case 'finished':
      case 'killed':
      case 'crashed':
        status = 'CANCELLED';
        break;
      default:
        return;
    }
    w.status = status;
    this.openWait = null;
  }

  /** Items and messages for an event. */
  private index(ev: Ev) {
    this.endWait(ev);
    if (ev.type === 'prompt' && ev.line) this.promptLines.set(ev['id'], ev.line);
    // answers carry no line: they go to the line of their prompt
    const line = ev.line ?? (ev.type === 'prompt_answered' || ev.type === 'prompt_cancelled' ? this.promptLines.get(ev['id']) : undefined);
    if (line) {
      let list = this.items.get(line);
      if (!list) this.items.set(line, (list = []));
      // snapshot events carry their execution; live ones are at the current one
      mergeItems(list, ev, ev['ex'] ?? this.hitsOf(line));
      if (ev.type === 'wait' || ev.type === 'waiting') this.openWait = list[list.length - 1];
    }
    if (ev.type !== 'command' && ev.type !== 'code') {
      if (this.messages.length >= LOG_CAP) this.messages.shift();
      this.messages.push(ev);
    }
    if (ev.type === 'log') this.lastMessage = ev['message'];
    else if (ev.type === 'prompt') this.lastMessage = ev['message'];
    else if (ev.type === 'finished') this.lastMessage = ev['message'];
  }
}
