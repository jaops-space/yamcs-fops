package com.jaops.yamcs.fops;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentSkipListMap;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import org.yamcs.YamcsServer;
import org.yamcs.events.EventProducer;
import org.yamcs.events.EventProducerFactory;
import org.yamcs.http.HttpServer;
import org.yamcs.logging.Log;
import org.yamcs.security.User;
import org.yamcs.protobuf.Event.EventSeverity;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * The executions of all instances and the starting of their workers.
 * <p>
 * Each instance has its executions in a table of its Yamcs database ({@link ExecutionDb}; ids are per instance),
 * opened once the instance exists. An execution's row is written when it starts, when its Summary changes (at most
 * once a second) and when it ends; executions of an earlier server life are read back as ended ones (those that had
 * not ended are crashed). A worker writes its as-run journal and log to local files, which go to the instance's
 * as-run bucket when the worker exits.
 */
public class Executions {
    private static final Log log = new Log(Executions.class);
    static final String ASRUN_TYPE = "application/x-ndjson";
    static final String LOG_TYPE = "text/plain; charset=utf-8";
    static final String JSON_TYPE = "application/json";
    /** The procedure as the execution started it: {path, source, inspect?}. */
    static final String PROCEDURE_SUFFIX = ".procedure.json";

    final FopsConfig config;
    final Map<String, Procedures> procedures = new HashMap<>();
    private final Map<String, Instance> instances = new ConcurrentHashMap<>();
    private final ScheduledExecutorService timer;
    /** Uploads and database writes off the worker and timer threads. */
    private final Executor io;
    private final Map<String, EventProducer> eventProducers = new ConcurrentHashMap<>();
    private volatile String yamcsUrl;
    /** The runners of the workers; null: they are local. */
    final Runners runners;

    /** The executions of one instance. */
    private static class Instance {
        final ExecutionDb db;
        final ConcurrentSkipListMap<Long, Execution> all = new ConcurrentSkipListMap<>();
        final AtomicLong nextId = new AtomicLong(1);

        Instance(ExecutionDb db) {
            this.db = db;
        }
    }

    public Executions(FopsConfig config, ScheduledExecutorService timer, ExecutorService pool) {
        this.config = config;
        this.timer = timer;
        this.io = pool;
        runners = config.remoteWorkers ? new Runners(config, timer) : null;
        config.instances.forEach((name, ic) -> procedures.put(name, new Procedures(name, ic.procedureBucket,
                config.dataDir.resolve("procedures").resolve(name), config, pool, runners)));
        timer.scheduleAtFixedRate(this::tick, 1, 1, TimeUnit.SECONDS);
    }

    private void tick() {
        var now = System.currentTimeMillis();
        var grace = config.controllerGracePeriod * 1000L;
        for (var name : config.instances.keySet()) {
            var inst = instances.get(name);
            if (inst == null) {
                if (YamcsServer.getServer().getInstance(name) == null) {
                    continue;
                }
                try {
                    inst = open(name);
                } catch (RuntimeException ex) {
                    continue; // logged; tried again next tick
                }
            }
            for (var e : inst.all.values()) {
                try {
                    e.tick(now, grace);
                    var justEnded = e.isEnded() && !e.stateSaved;
                    save(inst, e, false);
                    if (justEnded) {
                        // a copy now; the lingering worker may still journal (eval, set_variable)
                        io.execute(() -> upload(e, false));
                    }
                } catch (RuntimeException ex) {
                    log.error("Execution {}: tick failed", e.id, ex);
                }
            }
        }
    }

    /** The executions of an instance, read from its database on first use. */
    private Instance open(String instance) {
        instance(instance);
        return instances.computeIfAbsent(instance, name -> {
            if (YamcsServer.getServer().getInstance(name) == null) {
                throw FopsException.unavailable("instance " + name + " is not running");
            }
            try {
                var inst = new Instance(new ExecutionDb(name));
                restore(name, inst);
                return inst;
            } catch (Exception ex) {
                log.error("fops: cannot open the executions of {}", name, ex);
                throw FopsException.unavailable("cannot open the executions of " + name + ": " + ex);
            }
        });
    }

    private void restore(String instance, Instance inst) {
        int n = 0;
        for (var r : inst.db.load()) {
            try {
                var summary = JsonParser.parseString(r.summary()).getAsJsonObject();
                var state = r.state() == null ? null : JsonParser.parseString(r.state()).getAsJsonObject();
                var interrupted = !ExecState.FINAL.contains(r.status());
                var st = ExecState.restore(summary, state, interrupted ? "Yamcs stopped while it ran" : null);
                var body = JsonParser.parseString(r.request()).getAsJsonObject();
                // stored before fops left scheduling to the Yamcs timeline
                body.remove("schedule");
                var req = StartRequest.parse(body);
                var e = new Execution(st, req, r.asrun(), asrunFile(instance, r.asrun()), logFile(instance, r.asrun()),
                        timer, this::promptAlert);
                inst.all.put(e.id, e);
                inst.nextId.accumulateAndGet(e.id + 1, Math::max);
                if (interrupted || state == null || Files.exists(e.asrun) || Files.exists(e.logFile)) {
                    // the journal of a worker that did not exit with this server
                    io.execute(() -> {
                        upload(e, true);
                        save(inst, e, true);
                    });
                }
                n++;
            } catch (RuntimeException ex) {
                log.warn("fops: cannot restore execution {} of {}: {}", r.id(), instance, ex.toString());
            }
        }
        log.info("fops: {} executions of {} restored", n, instance);
    }

    /** Writes the execution's row if its Summary changed (with its State, once ended). */
    private void save(Instance inst, Execution e, boolean force) {
        synchronized (e) {
            saveLocked(inst, e, force);
        }
    }

    private void saveLocked(Instance inst, Execution e, boolean force) {
        if (e.stateSaved && !force) {
            return;
        }
        var summary = e.summary();
        var json = summary.toString();
        var ended = e.isEnded();
        if (!force && json.equals(e.saved) && !ended) {
            return;
        }
        inst.db.save(new ExecutionDb.Row(e.id, e.request.procedure, ExecState.str(summary, "status", null),
                ExecState.str(summary, "started", null), ExecState.str(summary, "ended", null), e.startedBy(),
                ExecState.str(summary, "origin", null), e.base, e.request.toJson().toString(), json,
                ended ? e.state().toString() : null));
        e.saved = json;
        e.stateSaved = ended;
    }

    /** Copies (move false) or moves the local journal and log of an execution to the as-run bucket. */
    private void upload(Execution e, boolean move) {
        var bucket = config.instances.get(e.instance).asrunBucket;
        for (var f : List.of(e.asrun, e.logFile)) {
            if (!Files.exists(f)) {
                continue;
            }
            var object = f == e.asrun ? e.base + ".jsonl" : e.base + ".log";
            try {
                Buckets.write(Buckets.get(bucket), object, f == e.asrun ? ASRUN_TYPE : LOG_TYPE, Files.readAllBytes(f));
                if (move) {
                    Files.delete(f);
                }
            } catch (IOException ex) {
                log.warn("Execution {}: cannot store {} in bucket {} (kept in {}): {}", e.id, object, bucket, f,
                        ex.toString());
            }
        }
    }

    /** The as-run journal of an execution: the local file, else the bucket object. */
    public byte[] journal(Execution e) throws IOException {
        try {
            return Files.readAllBytes(e.asrun);
        } catch (java.nio.file.NoSuchFileException ex) {
            // moved to the bucket
        }
        var data = Buckets.read(Buckets.get(config.instances.get(e.instance).asrunBucket), e.base + ".jsonl");
        if (data == null) {
            throw FopsException.notFound("no as-run journal");
        }
        return data;
    }

    private Path asrunFile(String instance, String base) {
        return config.dataDir.resolve("asrun").resolve(instance).resolve(base + ".jsonl");
    }

    private Path logFile(String instance, String base) {
        return config.dataDir.resolve("logs").resolve(instance).resolve(base + ".log");
    }

    public FopsConfig.InstanceConfig instance(String name) {
        var ic = config.instances.get(name);
        if (ic == null) {
            throw FopsException.notFound("no fops for instance " + name);
        }
        return ic;
    }

    public Execution get(String instance, long id) {
        var e = open(instance).all.get(id);
        if (e == null) {
            throw FopsException.notFound("no such execution: " + id);
        }
        return e;
    }

    /** The Summaries of an instance, newest first. */
    public JsonArray list(String instance) {
        var out = new JsonArray();
        for (var e : open(instance).all.descendingMap().values()) {
            out.add(e.summary());
        }
        return out;
    }

    /** Starts an execution, which is also a Yamcs activity. */
    public Execution start(String instance, StartRequest req, User user) throws IOException {
        var e = launch(instance, req, user);
        try {
            ProcedureExecutor.attach(e, user);
        } catch (RuntimeException ex) {
            log.warn("Execution {}: not an activity: {}", e.id, ex.toString());
        }
        return e;
    }

    /** Starts an execution, without activity (that of {@link ProcedureActivity}). */
    Execution launch(String instance, StartRequest req, User user) throws IOException {
        var ic = instance(instance);
        var inst = open(instance);
        var file = procedures.get(instance).resolve(req.procedure);
        if (file == null) {
            throw FopsException.notFound("no such procedure: " + req.procedure);
        }
        // the code it runs, kept: the procedure may change before its run is looked at
        var source = Files.readString(file, StandardCharsets.UTF_8);
        if (!req.traceLimitSet) {
            req.traceLimit = ic.traceLimit;
            req.traceLimitSet = true;
        }
        var id = inst.nextId.getAndIncrement();
        var started = Execution.now();
        // by day: 2026-11-06/2026-11-06T192819.159Z-battery_off-1
        var base = started.substring(0, 10) + "/" + started.replace(":", "") + "-"
                + req.procedure.replace('/', '_').replaceAll("\\.py$", "") + "-" + id;
        var asrun = asrunFile(instance, base);
        var logFile = logFile(instance, base);
        Files.createDirectories(asrun.getParent());
        Files.createDirectories(logFile.getParent());

        var e = new Execution(id, instance, file, req, user.getName(), base, asrun, logFile, timer,
                this::promptAlert);
        e.calls = (parent, r) -> startCall(parent, r, parent.runsAs());

        var cmd = new ArrayList<String>(List.of("--control", "--linger", "--sub-procedures", "--events", "-"));
        for (var line : req.breakpoints) {
            cmd.addAll(List.of("--breakpoint", line.toString()));
        }
        if (req.startsPaused()) {
            cmd.add("--paused");
        }
        if (req.byStep) {
            cmd.add("--by-step");
        }
        if (req.confirmCommands) {
            cmd.add("--confirm-commands");
        }
        if (req.traceLimit == null) {
            cmd.add("--unlimited");
        } else {
            cmd.addAll(List.of("--trace-limit", req.traceLimit.toString()));
        }
        cmd.addAll(List.of("--instance", instance, "--processor", ic.processor));
        if (req.args.size() > 0) {
            cmd.addAll(List.of("--args", req.args.toString()));
        }
        var secure = YamcsServer.getServer().getSecurityStore().isEnabled();
        Worker worker;
        if (runners != null) {
            // the runner adds the procedure file, --asrun, --yamcs and --yamcs-token-stdin
            worker = runners.worker(instance, id, req.procedure, procedures.get(instance).manifest(), cmd, asrun,
                    logFile);
        } else {
            cmd.addAll(0, List.of(config.executable, "run", file.toString()));
            cmd.addAll(List.of("--asrun", asrun.toString(), "--yamcs", yamcsUrl()));
            if (config.workerMemory != null) {
                cmd.addAll(List.of("--memory-limit", config.workerMemory));
            }
            if (secure) {
                cmd.add("--yamcs-token-stdin");
            }
            var env = new HashMap<String, String>();
            if (config.python != null) {
                env.put("FOPS_PYTHON", config.python);
            }
            worker = new LocalWorker(id, cmd, env, procedures.get(instance).root(), logFile);
        }
        WorkerToken token = null;
        if (secure) {
            token = new WorkerToken(user.getName(), worker::token);
            token.start(timer);
        }
        e.runAs(user, token);
        inst.all.put(id, e);
        var t = token;
        try {
            e.start(worker, () -> {
                if (t != null) {
                    t.close();
                }
                io.execute(() -> {
                    upload(e, true);
                    save(inst, e, true);
                });
            });
        } catch (IOException | RuntimeException ex) {
            inst.all.remove(id);
            log.warn("Execution {}: worker not started: {}", id, ex.toString());
            if (t != null) {
                t.close();
            }
            throw ex;
        }
        save(inst, e, true);
        keepProcedure(e, source);
        return e;
    }

    /**
     * Stores the procedure as the execution started it next to its journal, with its inspection if the file has not
     * changed meanwhile. Until stored, it is held by the execution.
     */
    private void keepProcedure(Execution e, String source) {
        var o = new JsonObject();
        o.addProperty("path", e.request.procedure);
        o.addProperty("source", source);
        e.procedure = o;
        io.execute(() -> {
            var info = procedures.get(e.instance).inspect(e.file, Procedures.INSPECT_TIMEOUT_S * 1000);
            try {
                if (info != null && !info.isJsonNull()
                        && source.equals(Files.readString(e.file, StandardCharsets.UTF_8))) {
                    var withInspect = o.deepCopy();
                    withInspect.add("inspect", info);
                    e.procedure = withInspect;
                }
            } catch (IOException ex) {
                // removed meanwhile: without inspection
            }
            var bucket = config.instances.get(e.instance).asrunBucket;
            try {
                Buckets.write(Buckets.get(bucket), e.base + PROCEDURE_SUFFIX, JSON_TYPE,
                        e.procedure.toString().getBytes(StandardCharsets.UTF_8));
                e.procedure = null;
            } catch (IOException ex) {
                log.warn("Execution {}: cannot store its procedure in bucket {} (kept in memory): {}", e.id, bucket,
                        ex.toString());
            }
        });
    }

    /** {path, source, inspect?}: the procedure as the execution started it. */
    public JsonObject procedure(Execution e) throws IOException {
        var p = e.procedure;
        if (p != null) {
            return p;
        }
        var data = Buckets.read(Buckets.get(config.instances.get(e.instance).asrunBucket), e.base + PROCEDURE_SUFFIX);
        if (data == null) {
            // started before procedures were kept
            throw FopsException.notFound("the procedure of execution " + e.id + " was not kept");
        }
        return JsonParser.parseString(new String(data, StandardCharsets.UTF_8)).getAsJsonObject();
    }

    /** A sub-procedure of {@code parent}: an execution of the same instance, as the user the parent runs as. */
    private Execution startCall(Execution parent, StartRequest req, User user) throws IOException {
        if (!user.hasSystemPrivilege(FopsPlugin.START)) {
            throw FopsException.forbidden("user " + user.getName() + " lacks privilege " + FopsPlugin.START);
        }
        log.info("Execution {}: starts {} (call {})", parent.id, req.procedure, req.parentCall);
        return start(parent.instance, req, user);
    }

    /** The Yamcs URL for the workers: this server, on loopback if it listens on all addresses. */
    String yamcsUrl() {
        if (yamcsUrl == null) {
            var http = YamcsServer.getServer().getGlobalService(HttpServer.class);
            var b = http.getBindings().get(0);
            var addr = b.getAddress();
            String host;
            if (addr == null || addr.isAnyLocalAddress()) {
                host = "127.0.0.1";
            } else {
                host = addr.getHostAddress();
                if (host.contains(":")) {
                    host = "[" + host + "]";
                }
            }
            yamcsUrl = (b.isTLS() ? "https" : "http") + "://" + host + ":" + b.getPort() + http.getContextPath();
        }
        return yamcsUrl;
    }

    private void promptAlert(Execution e, JsonObject prompt) {
        var ep = eventProducers.computeIfAbsent(e.instance, i -> {
            var p = EventProducerFactory.getEventProducer(i);
            p.setSource("fops");
            return p;
        });
        var msg = String.format("%s (execution %d, started by %s) asks: %s", e.request.procedure, e.id,
                e.startedBy(), ExecState.str(prompt, "message", ""));
        ep.sendEvent(EventSeverity.WARNING, "PROMPT", msg);
    }
}
