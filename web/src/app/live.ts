import { signal } from '@angular/core';
import { ParameterSubscription, ParameterValue, YamcsClient } from '@yamcs/webapp-sdk';

/**
 * Live values of the procedure's parameters, from a subscription on the
 * WebSocket Yamcs-web already has open: nothing is fetched on hover. Values
 * come from the processor's cache first, then on each update.
 */
export class LiveParameters {
  /** By qualified name. */
  readonly values = new Map<string, ParameterValue>();
  /** Bumped on each update, for the views to read. */
  readonly tick = signal(0);
  private sub?: ParameterSubscription;
  private ids = new Map<number, string>();
  private key = '';

  constructor(
    private client: YamcsClient,
    private instance: string,
    private processor: string,
  ) {}

  /** Follows these parameters (qualified names), instead of the previous ones. */
  follow(names: string[]) {
    const key = [...new Set(names)].sort().join('\n');
    if (key === this.key) return;
    this.cancel();
    this.key = key;
    if (!key) return;
    this.sub = this.client.createParameterSubscription(
      {
        instance: this.instance,
        processor: this.processor,
        id: key.split('\n').map((name) => ({ name })),
        abortOnInvalid: false,
        updateOnExpiration: true,
        sendFromCache: true,
        action: 'REPLACE',
      },
      (data) => {
        for (const [n, id] of Object.entries(data.mapping ?? {})) this.ids.set(+n, id.name);
        for (const pv of data.values ?? []) {
          const name = this.ids.get(pv.numericId);
          if (name) this.values.set(name, pv);
        }
        this.tick.update((t) => t + 1);
      },
    );
  }

  cancel() {
    this.sub?.cancel();
    this.sub = undefined;
    this.ids.clear();
    this.values.clear();
    this.key = '';
  }
}
