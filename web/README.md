# fops web UI (Yamcs-web extension)

Angular 22 custom elements built on `@yamcs/webapp-sdk` 1.6.7, the versions of
Yamcs 5.14.0. Only the latest Yamcs release is supported: when Yamcs moves to a
new SDK or Angular version, bump them here to match
(`yamcs-web/src/main/webapp/package.json` of the release tag) and rebuild.

```bash
npm install
npm run build        # dist/yamcs-fops.js, dist/yamcs-fops.css
```

The plugin build (`../plugin`) copies `dist/` into the jar; the plugin
registers it with `WebPlugin.addExtension`. Yamcs-web then loads
`yamcs-fops.js` on every page. Keep it one bundle: `scripts/postbuild.mjs`
fails on lazy chunks, because Yamcs-web serves the extension's files from its
own root.

## Elements

- `<yamcs-fops>`, named after the plugin, created by Yamcs-web at startup:
  adds **Procedures** to the Automation group of the sidebar
  (`src/app/init.element.ts`).
- `<fops-procedures>`, routed at `/ext/fops-procedures/<subroute>?c=<instance>`
  (`src/app/pages.element.ts`):

| subroute | page |
|---|---|
| `` | procedure tree and the executions of the instance (SPELL navigation + master view); Open (also double-click, Enter) loads a procedure held before anything runs (LOADED), as SPELL does; Schedule… puts it on the Yamcs timeline; Details… opens its properties |
| `procedures/<path>` | properties, arguments, steps, watchdogs, check results, source; Open (defaults) / Open with arguments… / Schedule… |
| `executions/<id>` | the execution console (SPELL procedure view) |
| `executions/<id>/asrun` | live as-run journal |

## Where things are

| file | what |
|---|---|
| `api.ts` | client of the plugin API (`docs/plugin-api.md`), through `yamcsClient.doFetch` so Yamcs authentication applies; the tab's session id |
| `execution.ts` | one execution: snapshot + long poll, events applied like the plugin's state machine |
| `items.ts` | SPELL's item columns: what each line did, compound status `IN PROGRESS (5/7)` |
| `status.ts` | status colours and SPELL's control availability table |
| `code-view.ts` | the Code presentation: coverage, current line, hit counts, breakpoints, item columns, context menu, search, live value of a parameter on hover |
| `live.ts` | live values of the procedure's parameters: a subscription on Yamcs-web's WebSocket |
| `pages/execution.page.ts` | header, control panel, Steps/Text/Commands presentations, outline |
| `pages/prompt.panel.ts` | prompt area, delay warning (blink, sound, notification) |
| `pages/variables.panel.ts` | Variables and Shell presentations |
| `dialogs.ts` | start (arguments, options; now, or later as a `PROCEDURE` activity on the Yamcs timeline, with Yamcs-web's date-time input and a duration guessed from `procedure(duration=)`, else the median of the last 10 finished runs, else the source estimate of `fops inspect`, when the instance has one and the user has `ControlTimeline`), goto, item information, settings, preferences |
| `prefs.ts` | per-user preferences in browser storage |

Syntax highlighting uses the Lezer Python grammar directly (no editor): the
code view is a table, so the item columns, coverage and context menu stay simple.

## Keyboard

F5 run, F6 pause, F7 step into, F8 step over (when controlling).
