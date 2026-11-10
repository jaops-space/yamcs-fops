import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { WebappSdkModule } from '@yamcs/webapp-sdk';
import { UtcPipe } from '../time.pipe';
import { CodeView } from '../code-view';
import { FopsContext } from '../context';
import { startWithDialog } from '../dialogs';
import { Inspect, ProcedureDetail } from '../model';

/** SPELL's procedure properties, plus starting with arguments or later on the Yamcs timeline. */
@Component({
  selector: 'fops-procedure-page',
  imports: [WebappSdkModule, UtcPipe, CodeView],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ya-instance-page>
      <ya-instance-toolbar>
        <ng-template ya-instance-toolbar-label>
          <a class="fops-crumb" [href]="ctx.url('')" (click)="$event.preventDefault(); ctx.go('')">Procedures</a>
          <span class="material-symbols">chevron_right</span>
          {{ path() }}
        </ng-template>
        <ya-page-button icon="play_arrow" primary [disabled]="!ctx.privileges.start || !d() || !!d()?.inspect?.error" (clicked)="startNow()">Open</ya-page-button>
        <ya-page-button icon="tune" [disabled]="!ctx.privileges.start || !!d()?.inspect?.error" (clicked)="start('args')">Open with arguments…</ya-page-button>
        <ya-page-button icon="schedule" [disabled]="!ctx.privileges.start || !ctx.timelineAllowed || !!d()?.inspect?.error" [matTooltip]="ctx.timelineAllowed ? 'Put it on the Yamcs timeline' : 'Needs the Yamcs timeline and the ControlTimeline privilege'" (clicked)="start('schedule')">Schedule…</ya-page-button>
        <ya-page-button icon="refresh" (clicked)="load()">Refresh</ya-page-button>
      </ya-instance-toolbar>
      <div class="fops fops-proc-page">
        @if (d(); as d) {
          <section class="fops-props">
            @if (d.inspect; as i) {
              @if (i.error) {
                <div class="fops-warn-box bad"><b>Cannot load this procedure</b><pre>{{ i.error }}</pre></div>
              }
              <ya-attr-list>
                <ya-attr label="Name">{{ i.name || '-' }}</ya-attr>
                <ya-attr label="Version">{{ i.version || '-' }}</ya-attr>
                <ya-attr label="Author">{{ i.author || '-' }}</ya-attr>
                <ya-attr label="Duration">{{ durationText(i) }}</ya-attr>
                <ya-attr label="File">{{ d.path }}{{ d.modified ? ' · modified ' : '' }}{{ d.modified ? (d.modified | utc) : '' }}</ya-attr>
                <ya-attr label="Description"><span style="white-space: pre-wrap">{{ i.description || '-' }}</span></ya-attr>
                @if (!i.declaresProcedure) {
                  <ya-attr label="Kind">Plain script: one step, no conditions</ya-attr>
                }
                <ya-attr label="Requires">{{ i.requires || '-' }}</ya-attr>
                <ya-attr label="Invariant">{{ i.invariant || '-' }}</ya-attr>
              </ya-attr-list>
              @if (i.args.length) {
                <div class="fops-h">Arguments</div>
                <table class="fops-table">
                  <thead><tr><th>Name</th><th>Type</th><th>Default</th><th>Constraints</th><th>Description</th></tr></thead>
                  <tbody>
                    @for (a of i.args; track a.name) {
                      <tr>
                        <td class="mono">{{ a.name }}{{ a.required ? ' *' : '' }}</td>
                        <td>{{ a.type }}{{ a.unit ? ' (' + a.unit + ')' : '' }}</td>
                        <td class="mono">{{ a.default ?? '-' }}</td>
                        <td>{{ a.choices?.length ? a.choices!.join(', ') : '' }}{{ a.min !== undefined && a.min !== null ? ' ≥ ' + a.min : '' }}{{ a.max !== undefined && a.max !== null ? ' ≤ ' + a.max : '' }}</td>
                        <td>{{ a.description || '' }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              }
              <div class="fops-h">Steps</div>
              <table class="fops-table">
                <thead><tr><th>#</th><th>Step</th><th>Conditions</th></tr></thead>
                <tbody>
                  @for (s of i.steps; track s.index) {
                    <tr (click)="reveal.set({ line: s.line })">
                      <td class="mono">{{ s.index + 1 }}</td>
                      <td>{{ s.name }} @if (s.cleanup) {<span class="fops-tag">cleanup</span>}</td>
                      <td class="fops-conds">
                        @if (s.requires) {<div><b>requires</b> {{ s.requires }}</div>}
                        @if (s.goal) {<div><b>goal</b> {{ s.goal }}</div>}
                        @if (s.invariant) {<div><b>invariant</b> {{ s.invariant }}</div>}
                        @if (s.ensures) {<div><b>ensures</b> {{ s.ensures }}</div>}
                      </td>
                    </tr>
                  } @empty {
                    <tr><td colspan="3" class="fops-mute">No steps.</td></tr>
                  }
                </tbody>
              </table>
              @if (i.watches.length) {
                <div class="fops-h">Watchdogs</div>
                <table class="fops-table">
                  <tbody>
                    @for (w of i.watches; track w.line) {
                      <tr (click)="reveal.set({ line: w.line })"><td class="mono">{{ w.condition }}</td><td>then {{ w.then }}</td><td>{{ w.handler || '' }}</td></tr>
                    }
                  </tbody>
                </table>
              }
              @if (i.check.length) {
                <div class="fops-h">Check</div>
                @for (c of i.check; track $index) {
                  <div class="fops-check-line warn" (click)="reveal.set({ line: c.line })">line {{ c.line }}: {{ c.message }}</div>
                }
              }
            } @else {
              <div class="fops-mute fops-pad">No properties available.</div>
            }
          </section>
          <section class="fops-src">
            <fops-code [source]="d.source" [reveal]="reveal()" [check]="d.inspect?.check ?? []" />
          </section>
        } @else if (err()) {
          <ya-empty-message headerTitle="Procedure">{{ err() }}</ya-empty-message>
        } @else {
          <ya-dots />
        }
      </div>
    </ya-instance-page>
  `,
})
export class ProcedurePage {
  readonly ctx = inject(FopsContext);
  readonly path = input.required<string>();
  private readonly docTitle = inject(Title);
  readonly d = signal<ProcedureDetail | null>(null);
  readonly err = signal<string | null>(null);
  readonly reveal = signal<{ line: number } | null>(null);

  constructor() {
    effect(() => {
      this.path();
      this.load();
    });
    effect(() => this.docTitle.setTitle(this.path()));
  }

  async load() {
    try {
      this.d.set(await this.ctx.api.procedure(this.path()));
      this.err.set(null);
    } catch (e: any) {
      this.err.set(e?.statusCode === 404 ? 'No such procedure.' : String(e?.message ?? e));
    }
  }

  /** Loads with the defaults (held until Run or Step); required arguments go through the dialog. */
  async startNow() {
    if (this.d()?.inspect?.args?.some((a) => a.required)) return this.start('args');
    try {
      const { id } = await this.ctx.api.start({ procedure: this.path() });
      this.ctx.go('executions/' + id);
    } catch (e) {
      this.ctx.error(e);
    }
  }

  /** Declared, or estimated from the source (with the default arguments). */
  durationText(i: Inspect): string {
    const fmt = (s: number) => (s < 60 ? `${Math.round(s)} s` : `${Math.floor(s / 60)} min${s % 60 ? ' ' + Math.round(s % 60) + ' s' : ''}`);
    if (i.duration) return fmt(i.duration);
    if (!i.estimate) return '-';
    const e = i.estimate;
    const parts = [e.waits ? `${e.waits} s of waits` : '', e.commands ? `${e.commands} command(s)` : '', e.procedures ? `${e.procedures} s of sub-procedures` : '']
      .filter(Boolean)
      .join(', ');
    return `about ${fmt(e.seconds)}, estimated from the source${parts ? ' (' + parts + ')' : ''}`;
  }

  start(mode: 'args' | 'schedule') {
    return startWithDialog(this.ctx, this.path(), this.d()?.inspect, mode);
  }
}
