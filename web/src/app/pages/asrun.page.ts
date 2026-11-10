import { ChangeDetectionStrategy, Component, computed, effect, inject, input, OnDestroy, signal } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { WebappSdkModule } from '@yamcs/webapp-sdk';
import { FopsContext } from '../context';
import { describe } from './execution.page';

/** SPELL's As-Run view (GUI manual 5.7.1), live: refreshed while the procedure runs. */
@Component({
  selector: 'fops-asrun-page',
  imports: [WebappSdkModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ya-instance-page>
      <ya-instance-toolbar>
        <ng-template ya-instance-toolbar-label>
          <a class="fops-crumb" [href]="ctx.url('')" (click)="$event.preventDefault(); ctx.go('')">Procedures</a>
          <span class="material-symbols">chevron_right</span>
          <a class="fops-crumb" [href]="ctx.url('executions/' + id())" (click)="$event.preventDefault(); ctx.go('executions/' + id())">Execution {{ id() }}</a>
          <span class="material-symbols">chevron_right</span>
          As-run
        </ng-template>
        <ya-page-button icon="refresh" (clicked)="load()">Refresh</ya-page-button>
        <ya-page-button icon="print" (clicked)="print()">Print</ya-page-button>
        <ya-page-button icon="download" (clicked)="download()">Download</ya-page-button>
      </ya-instance-toolbar>
      <div class="fops fops-pad">
        <div class="fops-row">
          <input class="fops-filter" placeholder="Filter" [value]="filter()" (input)="filter.set($any($event.target).value)" />
          <label class="fops-check" title="Show the procedure's stdout and stderr and the worker's messages"><input type="checkbox" [checked]="output()" (change)="output.set(!output())" /> Output</label>
          <label class="fops-check" title="Refresh every 3 seconds while the procedure runs"><input type="checkbox" [checked]="live()" (change)="live.set(!live())" /> Live</label>
          <span class="fops-mute">{{ rows().length }} / {{ entries().length }} entries</span>
        </div>
        <table class="fops-table fops-asrun">
          <thead><tr><th>Time</th><th>Type</th><th>Line</th><th>Entry</th></tr></thead>
          <tbody>
            @for (r of rows(); track $index) {
              <tr [class]="r.cls">
                <td class="mono">{{ r.time }}</td>
                <td>{{ r.type }}</td>
                <td class="mono">{{ r.line }}</td>
                <td class="fops-msg">{{ r.text }}</td>
              </tr>
            } @empty {
              <tr><td colspan="4" class="fops-mute">No entries.</td></tr>
            }
          </tbody>
        </table>
      </div>
    </ya-instance-page>
  `,
})
export class AsRunPage implements OnDestroy {
  readonly ctx = inject(FopsContext);
  readonly id = input.required<number>();
  private readonly docTitle = inject(Title);
  readonly entries = signal<any[]>([]);
  readonly filter = signal('');
  /** Shows the procedure's stdout and stderr and the worker's messages. */
  readonly output = signal(true);
  readonly live = signal(true);
  private timer = window.setInterval(() => this.live() && this.load(), 3000);

  readonly rows = computed(() => {
    const f = this.filter().toLowerCase();
    return this.entries()
      .filter((e) => this.output() || e.type !== 'output')
      .map((e) => {
        const text = e.type === 'command' ? `${e.name} ${e.stage}${e.detail ? ': ' + e.detail : ''}${e.args ? ' ' + JSON.stringify(e.args) : ''}${e.options ? ' options ' + JSON.stringify(e.options) : ''}` : describe(e);
        return {
          time: (e.time ?? e.journal_time ?? '').replace('T', ' ').replace('Z', ''),
          type: e.type === 'output' ? e.stream : e.type === 'command' && e.stage === 'ack' ? 'cmd_ack' : e.type,
          line: e.line ?? '',
          text,
          cls: e.type === 'command' && ['failed', 'timeout'].includes(e.stage) ? 'bad' : e.type === 'verify' && !e.ok ? 'bad' : e.type === 'output' && e.stream === 'stderr' ? 'warn' : '',
        };
      })
      .filter((r) => !f || r.text.toLowerCase().includes(f) || r.type.includes(f));
  });

  constructor() {
    effect(() => {
      this.id();
      this.load();
    });
    effect(() => this.docTitle.setTitle('As-run ' + this.id()));
  }

  ngOnDestroy() {
    clearInterval(this.timer);
  }

  async load() {
    try {
      this.entries.set(await this.ctx.api.asrun(this.id()));
    } catch (e) {
      this.live.set(false);
      this.ctx.error(e);
    }
  }

  print() {
    window.print();
  }

  download() {
    const blob = new Blob([this.entries().map((e) => JSON.stringify(e)).join('\n') + '\n'], { type: 'application/x-ndjson' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `asrun-${this.ctx.instance}-${this.id()}.jsonl`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}
