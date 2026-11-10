# Development environment: Yamcs with the fops plugin and the simulator

`dev/yamcs/` is a `yamcs:run` project: Yamcs 5.14.0 on port **8090**, instance
`simulator`, the fops plugin with the worker `../target/release/fops`, its
procedures in the bucket `fops-procedures-simulator` and its as-run journals
in `fops-asrun-simulator`. The instance runs the PUS simulator of the Yamcs
repository inside Yamcs (the `SimulatorCommander` service, from the
`org.yamcs:simulator` artifact): no other process is needed. Its
configuration and MDB come from the `examples/pus` of the Yamcs repository,
without CFDP. The links are `tm_realtime` (TCP 10015) and `tc_realtime` (TCP
10025). Security is off (user `guest`, a superuser).

```bash
cargo build --release
```

```bash
(cd plugin && mvn install)
```

Then Yamcs:

```bash
cd dev/yamcs && mvn yamcs:run
```

The procedure bucket is the `procedures/` folder: edits on disk show in
Yamcs-web at once, and edits made there land in the folder.

Yamcs-web: <http://localhost:8090/>. The API:

```bash
curl -s localhost:8090/fops/api/simulator/procedures
```

```bash
curl -s -XPOST localhost:8090/fops/api/simulator/executions -d '{"procedure": "battery_off.py", "session": "cli"}'
```

```bash
curl -s 'localhost:8090/fops/api/simulator/executions/1/events?after=0'
```

```bash
curl -s localhost:8090/fops/api/simulator/executions/1/asrun
```

The starting session becomes the controller: if it does not poll the
events (as with curl), the plugin pauses the execution after 10 s
(`controllerGracePeriod`). Add `"background": true` to start without one.

After changing the plugin or rebuilding the UI (`npm run build` in `web/`),
run `mvn install` in `plugin/` and restart Yamcs. Never change
`target/yamcs/yamcs-data/fops/web/` while Yamcs runs: Yamcs-web 5.14 then
fails to redeploy and answers 404 for every page until restarted. `mvn clean` in `dev/yamcs`
wipes the archive, the as-run journals and the worker logs
(`target/yamcs/yamcs-data/fops/`).
