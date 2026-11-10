import { Injectable, signal } from '@angular/core';

/** Per-user display preferences (SPELL GUI 3.2.1, 4.2.2), in browser storage. */
export interface Prefs {
  /** Item status column: short status and time of the latest notification. */
  showItemTime: boolean;
  /** What the Data column shows. */
  dataColumn: 'name' | 'value' | 'both';
  /** Timestamps in the Text presentation. */
  textTimestamps: boolean;
  autoScroll: boolean;
  promptSound: boolean;
  confirmAbort: boolean;
  codeFontSize: number;
  /** Seconds before an unanswered prompt starts blinking; 0 = server default. */
  promptWarningDelay: number;
}

const DEFAULTS: Prefs = {
  showItemTime: false,
  dataColumn: 'both',
  textTimestamps: true,
  autoScroll: true,
  promptSound: true,
  confirmAbort: true,
  codeFontSize: 12,
  promptWarningDelay: 0,
};

const KEY = 'fops.prefs';

@Injectable({ providedIn: 'root' })
export class PrefsService {
  readonly prefs = signal<Prefs>(load());

  set<K extends keyof Prefs>(k: K, v: Prefs[K]) {
    this.prefs.update((p) => ({ ...p, [k]: v }));
    try {
      localStorage.setItem(KEY, JSON.stringify(this.prefs()));
    } catch {
      // storage unavailable: preferences last for this page only
    }
  }

  reset() {
    this.prefs.set({ ...DEFAULTS });
    try {
      localStorage.removeItem(KEY);
    } catch {}
  }
}

function load(): Prefs {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
