package com.jaops.yamcs.fops;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

import org.yamcs.logging.Log;

import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * The runners connected to this server (docs/remote-workers.md), the workers they run and the inspections asked of
 * them. A worker starts on the runner with the most free capacity.
 */
public class Runners {
    private static final Log log = new Log(Runners.class);
    final FopsConfig config;
    final ScheduledExecutorService timer;
    private final List<RunnerConnection> connections = new CopyOnWriteArrayList<>();
    /** By key "instance/id". */
    private final Map<String, RemoteWorker> workers = new ConcurrentHashMap<>();
    private final Map<Long, CompletableFuture<JsonElement>> inspections = new ConcurrentHashMap<>();
    private final AtomicLong requests = new AtomicLong();

    Runners(FopsConfig config, ScheduledExecutorService timer) {
        this.config = config;
        this.timer = timer;
    }

    RemoteWorker worker(String instance, long id, String procedure, JsonObject manifest, List<String> flags,
            Path asrun, Path logFile) {
        var m = new JsonObject();
        m.addProperty("instance", instance);
        m.addProperty("procedure", procedure);
        m.add("manifest", manifest);
        m.add("flags", RemoteWorker.strings(flags));
        return new RemoteWorker(this, instance + "/" + id, id, m, asrun, logFile);
    }

    void register(RemoteWorker w) {
        workers.put(w.key, w);
    }

    void unregister(RemoteWorker w) {
        workers.remove(w.key, w);
    }

    /** The runner with the most free capacity. */
    RunnerConnection choose() {
        RunnerConnection best = null;
        int bestFree = 0;
        for (var c : connections) {
            var free = c.capacity - running(c);
            if (free > bestFree) {
                best = c;
                bestFree = free;
            }
        }
        if (best == null) {
            throw FopsException.unavailable(connections.isEmpty() ? "no runner connected"
                    : "no worker capacity: all " + connections.size() + " runners are full");
        }
        return best;
    }

    private int running(RunnerConnection c) {
        return (int) workers.values().stream().filter(w -> w.connection() == c && w.running()).count();
    }

    /** The inspection of a procedure by a runner; JsonNull if no runner could. */
    JsonElement inspect(String instance, JsonObject manifest, String path, long timeoutMs) {
        if (connections.isEmpty()) {
            return JsonNull.INSTANCE;
        }
        RunnerConnection c;
        try {
            c = choose();
        } catch (FopsException e) {
            c = connections.get(0); // inspections do not count against capacity
        }
        var req = requests.incrementAndGet();
        var f = new CompletableFuture<JsonElement>();
        inspections.put(req, f);
        var m = new JsonObject();
        m.addProperty("type", "inspect");
        m.addProperty("req", req);
        m.addProperty("instance", instance);
        m.addProperty("path", path);
        m.add("manifest", manifest);
        c.send(m);
        try {
            return f.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (Exception e) {
            log.warn("fops inspect {} on runner {}: {}", path, c.name, e.toString());
            return JsonNull.INSTANCE;
        } finally {
            inspections.remove(req);
        }
    }

    // --- from the connections, each on its own thread -----------------------------------------------------------------

    void connected(RunnerConnection c) {
        connections.add(c);
        log.info("fops: runner {} connected (user {}, capacity {})", c.name, c.user, c.capacity);
    }

    /** The executions the runner still has: theirs again if this still waits for them, else killed. */
    void hello(RunnerConnection c, JsonObject hello) {
        if (!hello.has("executions")) {
            return;
        }
        for (var e : hello.getAsJsonArray("executions")) {
            var x = e.getAsString();
            var w = workers.get(x);
            if (w != null && w.connection() == null && !w.isExited()) {
                w.attach(c);
            } else {
                log.info("fops: runner {} has execution {}, unknown here: killed", c.name, x);
                for (var type : List.of("kill", "forget")) {
                    var m = new JsonObject();
                    m.addProperty("type", type);
                    m.addProperty("x", x);
                    c.send(m);
                }
            }
        }
    }

    void message(RunnerConnection c, JsonObject m) {
        var type = ExecState.str(m, "type", "");
        if (type.equals("inspected")) {
            var f = inspections.get(ExecState.num(m, "req", 0));
            if (f != null) {
                var r = ExecState.str(m, "result", null);
                if (r == null) {
                    log.debug("fops inspect on runner {}: {}", c.name, ExecState.str(m, "error", "?"));
                }
                f.complete(r == null ? JsonNull.INSTANCE : parse(r));
            }
            return;
        }
        if (type.equals("load")) {
            c.capacity = (int) ExecState.num(m, "capacity", c.capacity);
            return;
        }
        var w = workers.get(ExecState.str(m, "x", ""));
        if (w == null || w.connection() != c) {
            return;
        }
        switch (type) {
        case "started":
            w.started();
            break;
        case "failed":
            w.failed(ExecState.str(m, "error", "?"));
            break;
        case "event":
            w.event(ExecState.num(m, "n", 0), ExecState.str(m, "line", ""));
            break;
        case "file":
            w.file(ExecState.str(m, "name", ""), ExecState.num(m, "offset", 0), ExecState.num(m, "end", 0),
                    ExecState.str(m, "data", ""));
            break;
        case "exited":
            w.exited((int) ExecState.num(m, "code", -1), ExecState.str(m, "reason", null));
            break;
        default:
            log.debug("fops: runner {}: unknown message {}", c.name, type);
        }
    }

    private static JsonElement parse(String s) {
        try {
            return JsonParser.parseString(s.trim());
        } catch (RuntimeException e) {
            return JsonNull.INSTANCE;
        }
    }

    void disconnected(RunnerConnection c) {
        if (!connections.remove(c)) {
            return;
        }
        log.warn("fops: runner {} disconnected", c.name);
        workers.values().stream().filter(w -> w.connection() == c).forEach(RemoteWorker::detach);
    }
}
