import { Ev } from './model';

/**
 * SPELL's item columns: what a source line did (telemetry read, command
 * stage, verification, prompt...), with a status. One line can have many
 * items; `ex` is the line's execution count when the item was produced, so
 * items of the latest execution can be told from history.
 */
export interface Item {
  key: string;
  ex: number;
  name: string;
  value: string;
  status: ItemStatus;
  time?: string;
  comment?: string;
  /** Describes the situation, not an outcome: left out of the line's status. */
  context?: boolean;
  ev: Ev;
}

export type ItemStatus =
  | 'SUCCESS'
  | 'FAILED'
  | 'IN PROGRESS'
  | 'WAITING'
  | 'TIMEOUT'
  | 'SKIPPED'
  | 'CANCELLED'
  | 'WARNING'
  | 'UNKNOWN'
  /** no outcome to show: a context item */
  | '';

export const STATUS_CLASS: Record<ItemStatus, string> = {
  SUCCESS: 'ok',
  FAILED: 'bad',
  'IN PROGRESS': 'prog',
  WAITING: 'warn',
  TIMEOUT: 'warn',
  SKIPPED: 'warn',
  CANCELLED: 'warn',
  WARNING: 'warn',
  UNKNOWN: '',
  '': '',
};

const CMD_STATUS: Record<string, ItemStatus> = {
  completed: 'SUCCESS',
  failed: 'FAILED',
  timeout: 'TIMEOUT',
  abandoned: 'CANCELLED',
  rejected: 'FAILED',
  error: 'FAILED',
};

const CALL_STATUS: Record<string, ItemStatus> = {
  rejected: 'FAILED',
  aborting: 'CANCELLED',
  waiting: 'WAITING',
};

function short(v: any, n = 80): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s === undefined ? '' : s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** Items produced by one event, or [] if it describes no line activity. */
export function itemsOf(ev: Ev, ex: number): Item[] {
  const base = { ex, time: ev.time, ev };
  const seq = ev.eseq ?? Math.random();
  switch (ev.type) {
    case 'command': {
      const status = CMD_STATUS[ev.stage] ?? (ev.stage?.startsWith('ack') && /NOK|fail/i.test(ev.detail ?? '') ? 'FAILED' : 'IN PROGRESS');
      return [{ ...base, key: `cmd:${ev.seq}`, name: ev.name, value: ev.stage, status, comment: ev.detail ?? undefined }];
    }
    case 'telemetry':
      return [{ ...base, key: `tm:${seq}`, name: ev.name, value: short(ev.value), status: ev.valid ? 'SUCCESS' : 'WARNING', comment: ev.valid ? undefined : 'invalid' }];
    case 'verify':
    case 'check':
    case 'precondition': {
      // a check of the goal before the body: not met is why the step runs
      const start = ev.type === 'check' && !!ev.goal;
      const what = ev.type === 'precondition' ? 'requires' : ev.invariant ? 'invariant' : start ? 'goal (start)' : ev.type === 'check' ? 'holds' : 'verify';
      return (ev.results ?? []).map((r: any, i: number) => ({
        ...base,
        key: `${ev.type}:${seq}:${i}`,
        name: what,
        value: r.condition,
        status: r.ok ? 'SUCCESS' : start ? '' : ev.type === 'check' ? 'WARNING' : 'FAILED',
        comment: start && !r.ok ? 'not met yet: the step runs' : undefined,
        context: start || undefined,
      }));
    }
    case 'sample':
      return Object.entries(ev.values ?? {}).map(([n, v]: [string, any], i) => ({
        ...base,
        key: `sample:${seq}:${i}`,
        name: n,
        value: short(Array.isArray(v) ? v[0] : v),
        status: 'SUCCESS',
      }));
    case 'set':
      return [{ ...base, key: `set:${seq}`, name: ev.name, value: `:= ${short(ev.value)}${ev.units ? ' ' + ev.units : ''}`, status: ev.ok ? 'SUCCESS' : 'FAILED', comment: ev.detail ?? undefined }];
    case 'waiting':
      return [{ ...base, key: `wait:${seq}`, name: 'wait until', value: ev.condition, status: 'WAITING', comment: `max ${ev.within}s` }];
    case 'wait':
      return [{ ...base, key: `wait:${seq}`, name: 'wait', value: ev.until ?? `${ev.seconds}s`, status: 'WAITING' }];
    case 'prompt':
      return [{ ...base, key: `prompt:${ev.id}`, name: 'prompt', value: ev.message, status: 'WAITING' }];
    case 'output':
      return [{ ...base, key: `output:${seq}`, name: ev.stream, value: ev.text, status: ev.stream === 'stderr' ? 'WARNING' : 'SUCCESS' }];
    case 'log':
      return [{ ...base, key: `log:${seq}`, name: ev.level ?? 'log', value: ev.message, status: ev.level === 'error' ? 'FAILED' : ev.level === 'warning' ? 'WARNING' : 'SUCCESS' }];
    case 'call': {
      const status = CALL_STATUS[ev.stage] ?? (ev.stage === 'ended' ? (ev.status === 'finished' && ev.confirmation === 'confirmed' ? 'SUCCESS' : 'FAILED') : 'IN PROGRESS');
      const comment = ev.stage === 'ended' ? `${ev.status}${ev.confirmation ? ', ' + ev.confirmation : ''}: ${ev.detail ?? ''}` : ev.detail;
      return [{ ...base, key: `call:${ev.call_seq}`, name: ev.procedure, value: ev.id ? `${ev.stage} (execution ${ev.id})` : ev.stage, status, comment }];
    }
    case 'watch':
      return [{ ...base, key: `watch:${seq}`, name: 'watch', value: ev.message ?? '', status: 'WARNING', comment: ev.action }];
    default:
      return [];
  }
}

const STEP_CONDITIONS = ['goal', 'requires', 'ensures', 'invariant'] as const;

/**
 * The conditions a step declares that its line has no result for in execution
 * `ex` (ensures, say, while the body runs): not evaluated yet. `step` is the
 * procedure description's step.
 */
export function declaredItems(step: any, items: Item[], ex: number): Item[] {
  const evaluated = items.filter((i) => i.ex === ex).map((i) => i.value);
  return STEP_CONDITIONS.flatMap((what) =>
    ((step[what] ?? []) as string[])
      .filter((c) => !evaluated.some((v) => v === c || v.startsWith(c + ' (')))
      .map((c, i) => ({
        key: `declared:${what}:${i}`,
        ex,
        name: what,
        value: c,
        status: 'UNKNOWN' as ItemStatus,
        comment: 'not evaluated yet',
        ev: { type: 'declared', [what]: c } as Ev,
      })),
  );
}

/** Updates the item list of a line with an event, merging command stages and prompt answers. */
export function mergeItems(items: Item[], ev: Ev, ex: number): void {
  if (ev.type === 'prompt_answered' || ev.type === 'prompt_cancelled') {
    const it = items.find((i) => i.key === `prompt:${ev.id}`);
    if (it) {
      it.status = ev.type === 'prompt_answered' ? 'SUCCESS' : 'CANCELLED';
      it.comment = ev.type === 'prompt_answered' ? `answer: ${ev.answer}` : ev.reason;
      it.time = ev.time;
    }
    return;
  }
  for (const n of itemsOf(ev, ex)) {
    if (ev.type === 'command' || ev.type === 'call') {
      // one item per command or sub-procedure (its number in the procedure), latest stage wins
      const old = items.find((i) => i.key === n.key);
      if (old) {
        old.value = n.value;
        old.status = n.status;
        old.time = n.time;
        old.comment = n.comment ?? old.comment;
        old.ev = ev;
        continue;
      }
    }
    items.push(n);
  }
}

/** SPELL's compound status: one status, or "IN PROGRESS (5/7)". */
export function summarize(items: Item[]): { status: ItemStatus; text: string } | null {
  items = items.filter((i) => !i.context);
  if (!items.length) return null;
  if (items.length === 1) return { status: items[0].status, text: items[0].status };
  const done = items.filter((i) => i.status !== 'IN PROGRESS' && i.status !== 'WAITING').length;
  const failed = items.some((i) => i.status === 'FAILED');
  const status: ItemStatus = failed ? 'FAILED' : done < items.length ? 'IN PROGRESS' : items.some((i) => i.status !== 'SUCCESS') ? 'WARNING' : 'SUCCESS';
  return { status, text: `${status} (${done}/${items.length})` };
}
