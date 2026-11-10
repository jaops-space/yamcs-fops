import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { User, YamcsWebExtension } from '@yamcs/webapp-sdk';
import { ELEMENT, FopsContext } from './context';

const MAY_SEE = (user: User) =>
  ['fops.Monitor', 'fops.Start', 'fops.Control'].some((p) => user.hasSystemPrivilege(p)) || user.isSuperuser();

/** Startup hook: adds the sidebar entries. Renders nothing. */
@Component({
  selector: 'fops-init',
  template: '',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InitElement extends YamcsWebExtension {
  private ctx = inject(FopsContext);

  override onExtensionInit(): void {
    const svc = this.extensionService;
    this.ctx.svc = svc;
    svc.disableReloadOnNavigation(ELEMENT);
    svc.addNavItem('automation', {
      path: `ext/${ELEMENT}`,
      activeWhen: `ext/${ELEMENT}`,
      label: 'Procedures',
      icon: 'fact_check',
      order: 10,
      condition: MAY_SEE,
    });
  }
}
