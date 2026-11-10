import { YamcsService } from '@yamcs/webapp-sdk';
import {
  Control,
  EventsResponse,
  Info,
  ProcedureDetail,
  ProcedureEntry,
  StartRequest,
  State,
  Summary,
} from './model';

/**
 * Identifies this browser tab to the plugin: the controller of an execution
 * is a user and a session. Kept in sessionStorage so that a reload keeps
 * control (SPELL: regain control after a communication failure).
 */
export const SESSION: string = (() => {
  const key = 'fops.session';
  try {
    let s = sessionStorage.getItem(key);
    if (!s) {
      s = crypto.randomUUID();
      sessionStorage.setItem(key, s);
    }
    return s;
  } catch {
    return crypto.randomUUID();
  }
})();

/** Client of the plugin's API for one instance, authenticated like the Yamcs API. */
export class FopsApi {
  readonly base: string;

  constructor(
    private yamcs: YamcsService,
    readonly instance: string,
  ) {
    this.base = new URL(`fops/api/${encodeURIComponent(instance)}`, document.baseURI).toString();
  }

  private async fetch(path: string, init?: RequestInit): Promise<Response> {
    const client = this.yamcs.yamcsClient;
    if (!init?.signal) return client.doFetch(this.base + path, init);
    // Yamcs-web's HTTP interceptor logs out on any fetch error other than a
    // TypeError, so an aborted request would land on the login page. Let the
    // abort resolve below the interceptor, then report it here.
    const quiet = Object.create(client, {
      handle: {
        value: (url: string, i?: RequestInit) =>
          fetch(url, i).catch((e) => (e?.name === 'AbortError' ? new Response('{"msg":"aborted"}', { status: 499 }) : Promise.reject(e))),
      },
    });
    try {
      return await client.doFetch.call(quiet, this.base + path, init);
    } catch (e) {
      if (init.signal.aborted) throw new DOMException('aborted', 'AbortError');
      throw e;
    }
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const r = await this.fetch(path, init);
    if (r.status === 204) return undefined as T;
    return (await r.json()) as T;
  }

  private post<T>(path: string, body: any, signal?: AbortSignal): Promise<T> {
    return this.json<T>(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
      signal,
    });
  }

  info() {
    return this.json<Info>('/info');
  }

  procedures() {
    return this.json<ProcedureEntry[]>('/procedures');
  }

  procedure(path: string) {
    return this.json<ProcedureDetail>('/procedures/' + encodePath(path));
  }

  start(req: Omit<StartRequest, 'session'>) {
    return this.post<{ id: number }>('/executions', { ...req, session: SESSION });
  }

  executions() {
    return this.json<Summary[]>('/executions');
  }

  execution(id: number) {
    return this.json<State>(`/executions/${id}`);
  }

  /** The procedure as the execution started it. */
  executionProcedure(id: number) {
    return this.json<ProcedureDetail>(`/executions/${id}/procedure`);
  }

  events(id: number, after: number, signal: AbortSignal, timeout = 25) {
    const q = `after=${after}&session=${encodeURIComponent(SESSION)}&timeout=${timeout}`;
    return this.json<EventsResponse>(`/executions/${id}/events?${q}`, { signal });
  }

  control(id: number, c: Control) {
    return this.post<void>(`/executions/${id}/control`, { ...c, session: SESSION });
  }

  action(id: number, action: 'takeControl' | 'releaseControl' | 'monitor' | 'kill') {
    return this.post<void>(`/executions/${id}:${action}`, { session: SESSION });
  }

  restart(id: number) {
    return this.post<{ id: number }>(`/executions/${id}:restart`, { session: SESSION });
  }

  async asrun(id: number): Promise<any[]> {
    const text = await (await this.fetch(`/executions/${id}/asrun`)).text();
    return text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return { type: 'raw', text: l };
        }
      });
  }
}

function encodePath(p: string) {
  return p.split('/').map(encodeURIComponent).join('/');
}

export function errorText(e: any): string {
  if (!e) return 'error';
  if (e.statusText || e.message) {
    return [e.statusCode ?? e.response?.status, e.message || e.statusText].filter(Boolean).join(' ');
  }
  return String(e);
}
