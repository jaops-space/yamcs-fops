import { State } from './model';

/** CSS class for an execution status or activity (SPELL's status colours). */
export function statusClass(s: string | undefined | null): string {
  switch (s) {
    case 'running':
      return 'st-running';
    case 'paused':
      return 'st-paused';
    case 'loaded':
      return 'st-loaded';
    case 'prompt':
      return 'st-prompt';
    case 'waiting':
      return 'st-waiting';
    case 'finished':
      return 'st-finished';
    case 'aborted':
    case 'error':
    case 'crashed':
    case 'killed':
      return 'st-failed';
    default:
      return 'st-other';
  }
}

export function stepClass(s: string | undefined | null): string {
  switch (s) {
    case 'confirmed':
    case 'completed':
      return 'ok';
    case 'not confirmed':
    case 'aborted':
      return 'bad';
    case 'not available':
      return 'warn';
    case 'executing':
    case 'preconditions':
    case 'confirmation':
      return 'prog';
    default:
      return '';
  }
}

export type ControlName =
  | 'resume'
  | 'pause'
  | 'step'
  | 'step_over'
  | 'skip'
  | 'goto'
  | 'abort'
  | 'restart'
  | 'kill';

/**
 * SPELL's command availability table (GUI manual 5.3), on fops statuses.
 * Pause also applies while waiting; WAITING and PROMPT are activities here.
 */
export function available(st: State | null, c: ControlName): boolean {
  if (!st) return false;
  const status = st.status;
  const act = st.activity;
  const ended = ['finished', 'aborted', 'error', 'crashed', 'killed'].includes(status);
  switch (c) {
    case 'resume':
    case 'step':
    case 'step_over':
    case 'skip':
    case 'goto':
      return status === 'paused';
    case 'pause':
      return status === 'running' || act === 'waiting';
    case 'abort':
      return !ended && status !== 'starting';
    case 'restart':
      return ended;
    case 'kill':
      return !ended;
  }
}

export const STATUS_LABEL: Record<string, string> = {
  starting: 'STARTING',
  loaded: 'LOADED',
  running: 'RUNNING',
  paused: 'PAUSED',
  prompt: 'PROMPT',
  waiting: 'WAITING',
  finished: 'FINISHED',
  aborted: 'ABORTED',
  error: 'ERROR',
  crashed: 'ERROR',
  killed: 'KILLED',
};

/** The label of the activity, falling back to the status. */
export function label(st: { status: string; activity?: string } | null): string {
  if (!st) return '';
  const a = st.activity && st.activity !== st.status && !['finished', 'aborted', 'error', 'crashed', 'killed'].includes(st.status) ? st.activity : st.status;
  return STATUS_LABEL[a] ?? a.toUpperCase();
}
