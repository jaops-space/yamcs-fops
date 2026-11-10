// Shapes of the plugin's HTTP API (docs/plugin-api.md). Worker events pass
// through unchanged (snake_case); the plugin adds `seq` and `time`.

export interface Privileges {
  monitor: boolean;
  start: boolean;
  control: boolean;
  shell: boolean;
  kill: boolean;
}

export interface Info {
  fopsVersion: string;
  privileges: Privileges;
  promptWarningDelay: number;
  controllerGracePeriod: number;
  traceLimit: number | null;
  /** The Yamcs processor the procedures use. */
  processor?: string;
}

/** A name of the procedure that is an MDB parameter (the worker's `procedure` event). */
export interface ParamRef {
  name: string;
  units?: string | null;
  description?: string | null;
}

export interface ProcedureEntry {
  path: string;
  name?: string;
  version?: string;
}

export interface ArgSpec {
  name: string;
  type: 'int' | 'float' | 'str' | 'bool';
  default?: any;
  required: boolean;
  description?: string;
  choices?: any[];
  min?: number;
  max?: number;
  unit?: string;
}

export interface Inspect {
  path: string;
  declaresProcedure: boolean;
  name?: string;
  version?: string;
  description?: string;
  author?: string;
  args: ArgSpec[];
  requires: string | null;
  invariant: string | null;
  steps: {
    index: number;
    name: string;
    line: number;
    cleanup: boolean;
    goal?: string | null;
    requires?: string | null;
    invariant?: string | null;
    ensures?: string | null;
  }[];
  watches: { line: number; condition: string; then: string; handler?: string | null }[];
  /** procedure(duration=), seconds. */
  duration?: number | null;
  /** How long a run takes from the source (fops inspect): waits, commands, steps, sub-procedures. */
  estimate?: { seconds: number; waits: number; commands: number; steps: number; procedures: number } | null;
  functions: { name: string; line: number; endLine: number }[];
  check: { line: number; message: string }[];
  error: string | null;
}

export interface ProcedureDetail {
  path: string;
  source: string;
  modified?: string;
  inspect?: Inspect;
}

export interface StartRequest {
  procedure: string;
  args?: Record<string, any>;
  traceLimit?: number | null;
  background?: boolean;
  breakpoints?: number[];
  options?: { byStep?: boolean; confirmCommands?: boolean };
  session: string;
}

export interface Controller {
  user: string;
  session: string;
}

export interface StepSummary {
  index: number;
  name: string;
  execution: string;
  confirmation?: string | null;
}

export interface Summary {
  id: number;
  instance: string;
  procedure: string;
  name?: string | null;
  version?: string | null;
  started: string;
  ended?: string | null;
  status: string;
  activity: string;
  step: StepSummary | null;
  message?: string | null;
  commands: number;
  controller: Controller | null;
  monitors: string[];
  background: boolean;
  origin: string;
  startedBy?: string;
  /** Its Yamcs activity (type PROCEDURE), once there is one. */
  activityId?: string;
  /** A sub-procedure: the execution that started it, and its call number there. */
  parentId?: number;
  parentCall?: number;
}

/** A worker or plugin event. */
export interface Ev {
  type: string;
  /** Event sequence number, added by the plugin. */
  eseq?: number;
  time?: string;
  line?: number;
  [k: string]: any;
}

/** In the state, `commands` is the list of command records, not their count. */
export interface State extends Omit<Summary, 'commands'> {
  seq: number;
  commands: Ev[];
  traceLimit: number | null;
  args?: Record<string, any> | null;
  options?: { byStep?: boolean; confirmCommands?: boolean };
  codes: Ev[];
  procedureInfo: Ev | null;
  steps: Record<string, Ev>;
  current: Ev | null;
  /** The values of a goal or wait_until in progress: {results: [{condition, ok}], left}. */
  evaluating?: Ev | null;
  hits: Record<string, number>;
  suppressed: string[];
  breakpoints: number[];
  log: Ev[];
  prompts: Record<string, Ev>;
  /** The latest `call` record of each sub-procedure, by call number. */
  calls?: Record<string, Ev>;
  finished: Ev | null;
  variables: Ev | null;
}

export interface EventsResponse {
  seq: number;
  events?: Ev[];
  snapshot?: any;
}

/** Statuses after which an execution cannot change any more. */
export const ENDED = new Set(['finished', 'aborted', 'error', 'crashed', 'killed']);

export type Control =
  | { cmd: 'pause' | 'resume' | 'step' | 'step_over' | 'abort' | 'skip' }
  | { cmd: 'breakpoint'; line: number; enabled: boolean }
  | { cmd: 'set_trace_limit'; limit: number | null }
  | { cmd: 'answer'; id: number; value: string }
  | { cmd: 'goto_step'; index: number }
  | { cmd: 'goto_line'; line: number }
  | { cmd: 'run_to'; line: number }
  | { cmd: 'set_options'; by_step?: boolean; confirm_commands?: boolean }
  | { cmd: 'get_variables'; request_id: number }
  | { cmd: 'set_variable'; request_id: number; name: string; expr: string }
  | { cmd: 'eval'; request_id: number; expr: string };
