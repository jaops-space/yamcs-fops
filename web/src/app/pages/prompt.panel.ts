import { ChangeDetectionStrategy, Component, computed, effect, inject, input, OnDestroy, output, signal } from '@angular/core';
import { WebappSdkModule } from '@yamcs/webapp-sdk';
import { Ev } from '../model';
import { PrefsService } from '../prefs';

/**
 * SPELL's prompt area (GUI manual 3.2.6, 5.4): options as buttons or a list,
 * text and number input with a hint, and a warning
 * (blink, sound, desktop notification) when a prompt waits too long.
 */
@Component({
  selector: 'fops-prompt',
  imports: [WebappSdkModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="fops-prompt" [class.late]="late()" [class.command]="kind() === 'command'">
      <div class="fops-prompt-q">
        <span class="material-symbols">{{ kind() === 'command' ? 'warning' : 'help' }}</span>
        <span>{{ prompt()['message'] }}</span>
        <span class="fops-grow"></span>
        <span class="fops-mute">line {{ prompt().line }} · waiting {{ age() }} s</span>
      </div>
      @if (kind() === 'command' && prompt()['command']; as c) {
        <table class="fops-table fops-cmdconfirm">
          <tr><th>Command</th><td class="mono">{{ c.name }}</td></tr>
          <tr><th>Significance</th><td [class.bad]="c.significance === 'CRITICAL'" [class.warn]="c.significance !== 'CRITICAL'">{{ c.significance || '-' }}</td></tr>
          <tr><th>Arguments</th><td class="mono">{{ c.args ? json(c.args) : '-' }}</td></tr>
          @if (c.options) {
            <tr><th>Options</th><td class="mono">{{ json(c.options) }}</td></tr>
          }
        </table>
      }
      @if (options().length && options().length <= 6) {
        <div class="fops-row">
          @for (o of options(); track o) {
            <ya-button [appearance]="choice() === o ? 'primary' : 'basic'" [disabled]="!enabled()" (click)="pick(o)">{{ o }}</ya-button>
          }
        </div>
      } @else if (options().length) {
        <div class="fops-radios">
          @for (o of options(); track o) {
            <label><input type="radio" [name]="'p' + prompt()['id']" [checked]="choice() === o" [disabled]="!enabled()" (change)="choice.set(o)" /> {{ o }}</label>
          }
        </div>
      }
      @if (!options().length) {
        <input
          class="fops-prompt-in"
          [type]="kind() === 'number' ? 'number' : 'text'"
          [placeholder]="prompt()['hint'] || (kind() === 'number' ? 'a number' : 'your answer')"
          [value]="text()"
          [disabled]="!enabled()"
          (input)="text.set($any($event.target).value)"
          (keydown.enter)="commit()" />
      }
      <div class="fops-row">
        @if (!options().length || options().length > 6) {
          <ya-button appearance="primary" [disabled]="!enabled() || !value()" (click)="commit()">Answer</ya-button>
        }
        @if (!enabled()) {
          <span class="fops-mute">Monitoring: only the controlling client can answer.</span>
        }
      </div>
    </div>
  `,
})
export class PromptPanel implements OnDestroy {
  readonly prefs = inject(PrefsService);
  readonly prompt = input.required<Ev>();
  readonly enabled = input(true);
  /** Seconds before warning; 0 = never. */
  readonly warnAfter = input(0);
  readonly answer = output<string>();

  readonly choice = signal<string | null>(null);
  readonly text = signal('');
  readonly now = signal(Date.now());
  private readonly since = Date.now();
  private warned = false;
  private timer = window.setInterval(() => this.now.set(Date.now()), 1000);

  readonly kind = computed(() => this.prompt()['kind'] ?? (this.options().length ? 'options' : 'text'));
  readonly options = computed<string[]>(() => this.prompt()['options'] ?? []);
  readonly value = computed(() => (this.options().length ? this.choice() : this.text().trim()));
  readonly age = computed(() => {
    const t = this.prompt().time ? Date.parse(this.prompt().time!) : this.since;
    return Math.max(0, Math.round((this.now() - (isNaN(t) ? this.since : t)) / 1000));
  });
  readonly late = computed(() => this.warnAfter() > 0 && this.age() >= this.warnAfter());

  constructor() {
    effect(() => {
      if (this.prompt()['default'] !== undefined && this.prompt()['default'] !== null && !this.text()) this.text.set(String(this.prompt()['default']));
    });
    effect(() => {
      if (this.late() && !this.warned && this.enabled()) {
        this.warned = true;
        if (this.prefs.prefs().promptSound) beep();
        notify(this.prompt()['message']);
      }
    });
  }

  ngOnDestroy() {
    clearInterval(this.timer);
  }

  json(v: any) {
    return JSON.stringify(v);
  }

  pick(o: string) {
    this.choice.set(o);
    this.commit();
  }

  commit() {
    const v = this.value();
    if (this.enabled() && v) this.answer.emit(v);
  }
}

function beep() {
  try {
    const ctx = new AudioContext();
    for (let i = 0; i < 3; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      o.connect(g).connect(ctx.destination);
      g.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.3);
      g.gain.setValueAtTime(0, ctx.currentTime + i * 0.3 + 0.15);
      o.start(ctx.currentTime + i * 0.3);
      o.stop(ctx.currentTime + i * 0.3 + 0.16);
    }
  } catch {
    // no audio
  }
}

function notify(message: string) {
  try {
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('Procedure waiting for an answer', { body: message });
    }
  } catch {
    // no notifications
  }
}
