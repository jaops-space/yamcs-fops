import { ChangeDetectionStrategy, Component, inject, signal, ViewEncapsulation } from '@angular/core';
import { Title } from '@angular/platform-browser';
import { WebappSdkModule, YamcsWebExtension } from '@yamcs/webapp-sdk';
import { FopsContext } from './context';
import { AsRunPage } from './pages/asrun.page';
import { ExecutionPage } from './pages/execution.page';
import { HomePage } from './pages/home.page';
import { ProcedurePage } from './pages/procedure.page';

type Route =
  | { page: 'home' }
  | { page: 'procedure'; path: string }
  | { page: 'execution'; id: number }
  | { page: 'asrun'; id: number }
  | { page: 'unknown'; sub: string };

function parse(sub: string): Route {
  const s = (sub ?? '').replace(/^\/+|\/+$/g, '');
  if (!s) return { page: 'home' };
  let m = /^executions\/(\d+)(\/asrun)?$/.exec(s);
  if (m) return m[2] ? { page: 'asrun', id: +m[1] } : { page: 'execution', id: +m[1] };
  m = /^procedures\/(.+)$/.exec(s);
  if (m) return { page: 'procedure', path: decodeURIComponent(m[1]) };
  return { page: 'unknown', sub: s };
}

/** The routed element: /ext/fops-procedures/<subroute>. */
@Component({
  selector: 'fops-pages',
  imports: [WebappSdkModule, HomePage, ProcedurePage, ExecutionPage, AsRunPage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  template: `
    @if (ready()) {
      @if (ctx.unavailable(); as msg) {
        <ya-instance-page>
          <ya-instance-toolbar label="Procedures" />
          <ya-empty-message headerTitle="Procedures">{{ msg }}</ya-empty-message>
        </ya-instance-page>
      } @else {
        @switch (page().page) {
          @case ('home') {
            <fops-home />
          }
          @case ('procedure') {
            <fops-procedure-page [path]="$any(page()).path" />
          }
          @case ('execution') {
            <fops-execution-page [id]="$any(page()).id" />
          }
          @case ('asrun') {
            <fops-asrun-page [id]="$any(page()).id" />
          }
          @default {
            <ya-instance-page>
              <ya-instance-toolbar label="Procedures" />
              <ya-empty-message headerTitle="Not found">No page {{ $any(page()).sub }}</ya-empty-message>
            </ya-instance-page>
          }
        }
      }
    }
  `,
})
export class PagesElement extends YamcsWebExtension {
  readonly ctx = inject(FopsContext);
  private readonly title = inject(Title);
  readonly ready = signal(false);
  readonly page = signal<Route>({ page: 'home' });

  override onExtensionInit(): void {
    this.title.setTitle('Procedures');
    this.page.set(parse(this.subroute));
    this.ctx.api; // binds the API to the current instance, loads /info
    this.ready.set(true);
  }

  override onExtensionChanges(subroute: string): void {
    this.title.setTitle('Procedures');
    this.page.set(parse(subroute));
    this.ctx.api;
  }
}
