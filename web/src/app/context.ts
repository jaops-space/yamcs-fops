import { Injectable, inject, signal } from '@angular/core';
import { MatDialog } from '@angular/material/dialog';
import { ExtensionService, User } from '@yamcs/webapp-sdk';
import { FopsApi, errorText } from './api';
import { Info } from './model';

export const ELEMENT = 'fops-procedures';

/** Services shared by the pages: the host's Yamcs services, the API of the current instance, navigation. */
@Injectable({ providedIn: 'root' })
export class FopsContext {
  /** The host's services, set by the elements when Yamcs-web initializes them. */
  svc!: ExtensionService;
  readonly dialog = inject(MatDialog);
  readonly info = signal<Info | null>(null);
  /** Set when the instance has no fops (404 on /info) or the plugin is unreachable. */
  readonly unavailable = signal<string | null>(null);
  private _api: FopsApi | null = null;

  get yamcs() {
    return this.svc.yamcs;
  }

  get instance(): string {
    return this.yamcs.instance!;
  }

  get api(): FopsApi {
    if (!this._api || this._api.instance !== this.instance) {
      this._api = new FopsApi(this.yamcs, this.instance);
      this.loadInfo();
    }
    return this._api;
  }

  get user(): User | null {
    return this.svc.authService.getUser();
  }

  /** Scheduling is a PROCEDURE activity on the Yamcs timeline, as Yamcs-web's "Run later" for stacks and scripts. */
  get timelineAllowed(): boolean {
    const caps = this.yamcs.connectionInfo$.value?.instance?.capabilities ?? [];
    return caps.includes('timeline') && caps.includes('activities') && !!this.user?.hasSystemPrivilege('ControlTimeline');
  }

  get privileges() {
    return this.info()?.privileges ?? { monitor: false, start: false, control: false, shell: false, kill: false };
  }

  async loadInfo() {
    const api = this._api!;
    try {
      this.info.set(await api.info());
      this.unavailable.set(null);
    } catch (e: any) {
      this.info.set(null);
      this.unavailable.set(
        e?.statusCode === 404 ? `fops is not configured for instance ${api.instance}.` : `fops is unavailable: ${errorText(e)}`,
      );
    }
  }

  /** URL (for href) and navigation inside the extension. */
  url(sub: string): string {
    return `/ext/${ELEMENT}/${sub}?c=${encodeURIComponent(this.yamcs.context ?? this.instance)}`;
  }

  go(sub: string) {
    this.svc.router.navigateByUrl(this.url(sub));
  }

  /** Navigation to a page of Yamcs-web for the same instance (path without leading slash). */
  goYamcs(path: string) {
    this.svc.router.navigateByUrl(`/${path}?c=${encodeURIComponent(this.yamcs.context ?? this.instance)}`);
  }

  /** Absolute URL, for opening a view in another window (SPELL: detached views). */
  absolute(sub: string): string {
    return new URL(this.url(sub).replace(/^\//, ''), document.baseURI).toString();
  }

  info$(msg: string) {
    this.svc.messageService.showInfo(msg);
  }

  error(e: any) {
    this.svc.messageService.showError(typeof e === 'string' ? e : errorText(e));
  }
}
