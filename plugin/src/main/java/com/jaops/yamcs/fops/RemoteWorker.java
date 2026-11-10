package com.jaops.yamcs.fops;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import org.yamcs.logging.Log;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * A worker run by a runner (docs/remote-workers.md). Its events come numbered, and its as-run journal and log as
 * byte ranges, which this writes to the execution's local files: after a reconnection the runner resends from where
 * this left off. Controls sent while the runner is away wait for it. A runner away for longer than the grace period
 * has lost its workers.
 */
class RemoteWorker implements Worker {
    private static final Log log = new Log(RemoteWorker.class);
    final String key;
    final long id;
    private final Runners runners;
    private final JsonObject start;
    private final Path asrun;
    private final Path logFile;

    // under this
    private RunnerConnection conn;
    private Listener listener;
    private CompletableFuture<Void> started;
    private boolean exited;
    private String token;
    private long events;
    private long asrunEnd;
    private long logEnd;
    private final List<JsonObject> pending = new ArrayList<>();
    private ScheduledFuture<?> grace;
    private volatile boolean finished;

    /**
     * @param start
     *            the start message: instance, procedure, manifest, flags
     */
    RemoteWorker(Runners runners, String key, long id, JsonObject start, Path asrun, Path logFile) {
        this.runners = runners;
        this.key = key;
        this.id = id;
        this.start = start;
        this.asrun = asrun;
        this.logFile = logFile;
    }

    @Override
    public void start(Listener listener) throws IOException {
        // as a local worker has them from its start
        for (var p : List.of(asrun, logFile)) {
            if (!Files.exists(p)) {
                Files.createFile(p);
            }
        }
        CompletableFuture<Void> f;
        synchronized (this) {
            this.listener = listener;
            conn = runners.choose();
            started = f = new CompletableFuture<>();
            var m = start.deepCopy();
            m.addProperty("type", "start");
            m.addProperty("x", key);
            if (token != null) {
                m.addProperty("token", token);
            }
            runners.register(this);
            conn.send(m);
        }
        try {
            f.get(runners.config.runnerStartTimeout, TimeUnit.SECONDS);
            log.info("Execution {}: started by runner {}", id, describe());
        } catch (ExecutionException | TimeoutException | InterruptedException e) {
            if (e instanceof InterruptedException) {
                Thread.currentThread().interrupt();
            }
            synchronized (this) {
                exited = true;
                if (conn != null) {
                    conn.send(msg("kill"));
                    conn.send(msg("forget"));
                }
            }
            runners.unregister(this);
            var why = e instanceof ExecutionException ? e.getCause().getMessage()
                    : e instanceof TimeoutException ? "no answer from runner " + describe() : "interrupted";
            throw new IOException("worker not started: " + why);
        }
    }

    private JsonObject msg(String type) {
        var m = new JsonObject();
        m.addProperty("type", type);
        m.addProperty("x", key);
        return m;
    }

    /** Sends now, or once the runner is back. */
    private synchronized void deliver(JsonObject m) {
        if (exited) {
            return;
        }
        if (conn != null) {
            conn.send(m);
        } else {
            pending.add(m);
        }
    }

    @Override
    public void send(String line) {
        var m = msg("control");
        m.addProperty("line", line);
        deliver(m);
    }

    @Override
    public void closeInput() {
        deliver(msg("close"));
    }

    @Override
    public void kill() {
        deliver(msg("kill"));
    }

    @Override
    public synchronized boolean isAlive() {
        return started != null && !exited;
    }

    @Override
    public synchronized String describe() {
        return conn == null ? "(away)" : conn.name;
    }

    synchronized RunnerConnection connection() {
        return conn;
    }

    synchronized boolean isExited() {
        return exited;
    }

    @Override
    public void finished() {
        finished = true;
    }

    /** Whether it takes a place on its runner: its procedure still runs. */
    synchronized boolean running() {
        return !exited && !finished;
    }

    /** A renewed access token (the token's sink). */
    void token(String jwt) {
        synchronized (this) {
            token = jwt;
            if (started == null) {
                return; // goes with the start
            }
        }
        var m = msg("token");
        m.addProperty("token", jwt);
        deliver(m);
    }

    // --- from the runner, on its connection's thread ----------------------------------------------------------------

    void started() {
        CompletableFuture<Void> f;
        synchronized (this) {
            f = started;
        }
        f.complete(null);
    }

    void failed(String error) {
        CompletableFuture<Void> f;
        synchronized (this) {
            f = started;
        }
        f.completeExceptionally(new IOException(error));
    }

    void event(long n, String line) {
        Listener l;
        synchronized (this) {
            if (n <= events || exited) {
                return; // resent
            }
            if (n > events + 1) {
                log.warn("Execution {}: events {} to {} lost by runner {}", id, events + 1, n - 1, describe());
            }
            events = n;
            l = listener;
        }
        l.event(line);
    }

    synchronized void file(String name, long offset, long end, String data) {
        var isAsrun = "asrun".equals(name);
        var have = isAsrun ? asrunEnd : logEnd;
        if (end <= have || exited) {
            return;
        }
        if (offset != have) {
            log.warn("Execution {}: {} bytes {} to {} lost by runner {}", id, name, have, offset, describe());
        }
        try {
            Files.write(isAsrun ? asrun : logFile, data.getBytes(StandardCharsets.UTF_8), StandardOpenOption.CREATE,
                    StandardOpenOption.APPEND);
        } catch (IOException e) {
            log.error("Execution {}: cannot write {}: {}", id, isAsrun ? asrun : logFile, e.toString());
        }
        if (isAsrun) {
            asrunEnd = end;
        } else {
            logEnd = end;
        }
    }

    void exited(int code, String reason) {
        Listener l;
        synchronized (this) {
            if (exited) {
                return;
            }
            exited = true;
            if (grace != null) {
                grace.cancel(false);
            }
            if (conn != null) {
                conn.send(msg("forget"));
            }
            l = listener;
        }
        runners.unregister(this);
        log.info("Execution {}: worker exited on runner {} ({}{})", id, describe(), code,
                reason == null ? "" : ", " + reason);
        l.exited(code, reason);
    }

    /** Its runner is gone; it has the grace period to come back. */
    synchronized void detach() {
        if (exited) {
            return;
        }
        var name = conn == null ? "?" : conn.name;
        conn = null;
        log.warn("Execution {}: runner {} disconnected", id, name);
        grace = runners.timer.schedule(() -> {
            synchronized (this) {
                if (conn != null) {
                    return;
                }
            }
            exited(-1, "runner " + name + " lost");
        }, runners.config.runnerGrace, TimeUnit.SECONDS);
    }

    /** Its runner is back: it resends what this has not got, then gets what waited. */
    synchronized void attach(RunnerConnection c) {
        if (exited) {
            return;
        }
        if (grace != null) {
            grace.cancel(false);
            grace = null;
        }
        conn = c;
        log.info("Execution {}: runner {} back", id, c.name);
        var m = msg("resume");
        m.addProperty("n", events);
        var files = new JsonObject();
        files.addProperty("asrun", asrunEnd);
        files.addProperty("log", logEnd);
        m.add("files", files);
        c.send(m);
        if (token != null) {
            var t = msg("token");
            t.addProperty("token", token);
            c.send(t);
        }
        pending.forEach(c::send);
        pending.clear();
    }

    static JsonArray strings(List<String> l) {
        var a = new JsonArray();
        l.forEach(a::add);
        return a;
    }
}
