import { createApplication } from '@angular/platform-browser';
import { createCustomElement } from '@angular/elements';
import { MAT_DATE_FORMATS, MAT_NATIVE_DATE_FORMATS } from '@angular/material/core';
import { provideRouter } from '@angular/router';
import { provideYamcsWebExtension } from '@yamcs/webapp-sdk';
import { InitElement } from './app/init.element';
import { PagesElement } from './app/pages.element';

// Yamcs-web creates <yamcs-fops> (named after the plugin) at startup, and
// <fops-procedures> for the routes /ext/fops-procedures/...
(async () => {
  const app = await createApplication({
    providers: [
      provideRouter([]),
      provideYamcsWebExtension(),
      // the date picker's popup (ya-date-time-input) needs them at the root: provideYamcsWebExtension() gives only
      // the date adapter, Yamcs-web's own MatNativeDateModule is not visible from the extension
      { provide: MAT_DATE_FORMATS, useValue: MAT_NATIVE_DATE_FORMATS },
    ],
  });
  const define = (name: string, c: any) => {
    if (!customElements.get(name)) customElements.define(name, createCustomElement(c, { injector: app.injector }));
  };
  define('yamcs-fops', InitElement);
  define('fops-procedures', PagesElement);
})();
