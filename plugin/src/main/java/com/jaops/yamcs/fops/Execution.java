package com.jaops.yamcs.fops;

import java.io.IOException;
import java.nio.file.Path;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;

import org.yamcs.logging.Log;
import org.yamcs.security.User;

import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonSyntaxException;

/**
 * One execution: its {@code fops run} worker, its state and events, and who controls and monitors it.
 * <p>
 * Control model (SPELL's): one controller (user and client session), which alone sends controls; monitors (the
 * sessions seen polling the events in the last {@link #MONITOR_WINDOW_MS}); or none of them (background). A controller
 * that stops polling for the grace period loses control: the worker is paused and a {@code controller_lost} event
 * emitted.
 * <p>
 * Sub-procedures: a {@code call} event of stage {@code starting} starts another execution (its child), answered with
 * {@code call_started}; its end is reported with {@code call_ended}. A child starts with its parent's controller, and
 * the two share their sessions: polling either counts as presence on both. It is aborted when its parent asks
 * ({@code aborting}) or ends.
 */
public class Execution {
    private static final Log log = new Log(Execution.class);
    static final long MONITOR_WINDOW_MS = 30_000;
    static final long ABORT_KILL_DELAY_MS = 5_000;
    /** How long a finished worker still answers get_variables, set_variable and eval. */
    static final long LINGER_MS = 10 * 60_000;
    static final Set<String> AFTER_END = Set.of("get_variables", "set_variable", "eval");
    static final int EVENT_BUFFER = 20_000;
    static final long LINE_DELAY_MS = 50;
    private static final DateTimeFormatter ISO = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'");
    private static final String STOP = "\u0000stop";

    /** Raised when an execution without controller asks the operator (a Yamcs event). */
    public interface PromptAlert {
        void alert(Execution e, JsonObject prompt);
    }

    /** Starts the sub-procedure a worker asks for; throws why it cannot. */
    public interface CallStarter {
        Execution start(Execution parent, StartRequest req) throws Exception;
    }

    public final long id;
    public final String instance;
    public final Path file;
    public final StartRequest request;
    /** The name of its journal and log, without extension: local files while it runs, then bucket objects. */
    final String base;
    final Path asrun;
    final Path logFile;
    /** {path, source, inspect?} as it started, until stored in the as-run bucket. */
    volatile JsonObject procedure;
    /** The Summary last written to the database. */
    volatile String saved;
    /** Whether the State of the ended execution is in the database. */
    volatile boolean stateSaved;
    final ExecState st;
    final EventLog events;
    private final ScheduledExecutorService timer;
    private final PromptAlert promptAlert;

    // under the events lock
    private JsonObject controller; // {user, session}
    private boolean background;
    /** Shared with the parent, if any; locked inside the events lock. */
    private final Map<String, Presence> sessions;
    private final Set<Long> alerted = new TreeSet<>();
    private boolean controlChanged;

    private Worker worker;
    /** The user the worker acts as in Yamcs: who started it, then whoever takes control. */
    private volatile User runsAs;
    /** Its token, with security on. */
    private WorkerToken token;
    private final BlockingQueue<String> controls = new LinkedBlockingQueue<>();
    private volatile String killedBy;
    private volatile boolean abortEscalated;
    private Runnable onEnd = () -> {
    };
    /** The calling execution and its call number, for a sub-procedure. */
    final Execution parent;
    final long parentCall;
    /** Sub-procedures by call number. */
    private final Map<Long, Execution> children = new java.util.concurrent.ConcurrentHashMap<>();
    volatile CallStarter calls;

    private static class Presence {
        String user;
        long lastSeen;
        int active;
    }

    Execution(long id, String instance, Path file, StartRequest request, String user, String base, Path asrun,
            Path logFile, ScheduledExecutorService timer, PromptAlert promptAlert) {
        this.id = id;
        this.instance = instance;
        this.file = file;
        this.request = request;
        this.base = base;
        this.asrun = asrun;
        this.logFile = logFile;
        this.timer = timer;
        this.promptAlert = promptAlert;
        var origin = request.session == null ? "api" : "user";
        st = new ExecState(id, instance, request.procedure, now(), origin, user);
        st.traceLimit = request.traceLimit;
        st.args = request.args;
        st.byStep = request.byStep;
        st.confirmCommands = request.confirmCommands;
        st.breakpoints.addAll(request.breakpoints);
        events = new EventLog(EVENT_BUFFER, LINE_DELAY_MS, timer);
        parent = request.parent;
        parentCall = request.parentCall;
        if (parent != null) {
            st.parentId = parent.id;
            st.parentCall = parentCall;
            sessions = parent.sessions;
            controller = parent.controller();
            background = controller == null;
        } else {
            sessions = new HashMap<>();
            background = request.background || request.session == null;
            if (!background) {
                controller = person(user, request.session);
                touch(request.session, user, 0);
            }
        }
        st.controller = controller;
        st.background = background;
    }

    /** An ended execution of an earlier server life, without worker. */
    Execution(ExecState st, StartRequest request, String base, Path asrun, Path logFile,
            ScheduledExecutorService timer, PromptAlert promptAlert) {
        this.id = st.id;
        this.instance = st.instance;
        this.file = null;
        this.request = request;
        this.base = base;
        this.asrun = asrun;
        this.logFile = logFile;
        this.timer = timer;
        this.promptAlert = promptAlert;
        this.st = st;
        this.sessions = new HashMap<>();
        this.parent = null;
        this.parentCall = 0;
        events = new EventLog(EVENT_BUFFER, LINE_DELAY_MS, timer);
        events.startAfter(st.seq);
        stateSaved = true;
    }

    static String now() {
        return ZonedDateTime.now(ZoneOffset.UTC).format(ISO);
    }

    private static JsonObject person(String user, String session) {
        var o = new JsonObject();
        o.addProperty("user", user);
        o.addProperty("session", session);
        return o;
    }

    /** Before {@link #start}. */
    void runAs(User user, WorkerToken token) {
        this.runsAs = user;
        this.token = token;
    }

    /** The user the worker acts as in Yamcs, and starts sub-procedures as. */
    User runsAs() {
        return runsAs;
    }

    /** Starts the worker. Called once. */
    void start(Worker worker, Runnable onEnd) throws IOException {
        this.onEnd = onEnd;
        this.worker = worker;
        worker.start(new Worker.Listener() {
            @Override
            public void event(String line) {
                workerLine(line);
            }

            @Override
            public void exited(int code, String reason) {
                ended(code, reason);
            }
        });
        var writer = new Thread(this::writeControls, "fops-" + id + "-stdin");
        writer.setDaemon(true);
        writer.start();
    }

    private void send(JsonObject control) {
        controls.add(control.toString());
    }

    private void writeControls() {
        try {
            while (true) {
                var c = controls.take();
                if (c == STOP) {
                    worker.closeInput(); // a lingering worker exits
                    break;
                }
                worker.send(c);
                if (c.contains("\"abort\"") && JsonParser.parseString(c).getAsJsonObject().get("cmd").getAsString()
                        .equals("abort")) {
                    // Escalate if the procedure does not reach a line boundary in time
                    // (e.g. stuck inside a long native call).
                    timer.schedule(() -> {
                        if (worker.isAlive()) {
                            log.warn("Execution {}: killing the worker, unresponsive to abort", id);
                            abortEscalated = true;
                            worker.kill();
                        }
                    }, ABORT_KILL_DELAY_MS, TimeUnit.MILLISECONDS);
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (IOException e) {
            log.debug("Execution {}: stdin closed: {}", id, e.getMessage());
        }
    }

    private void workerLine(String line) {
        JsonObject ev;
        try {
            ev = JsonParser.parseString(line).getAsJsonObject();
        } catch (JsonSyntaxException | IllegalStateException e) {
            log.warn("Execution {}: bad event {}", id, line);
            return;
        }
        workerEvent(ev);
    }

    /** A worker event: numbered, timed and applied. */
    void workerEvent(JsonObject ev) {
        // the command and call records have their own sequence number
        var type = ExecState.str(ev, "type", "");
        if ("token_applied".equals(type)) {
            if (token != null) {
                token.applied(ExecState.str(ev, "user", ""));
            }
            return; // in the as-run journal, not in the stream
        }
        if ("command".equals(type) && ev.has("seq")) {
            ev.add("command_seq", ev.remove("seq"));
        }
        if ("call".equals(type) && ev.has("seq")) {
            ev.add("call_seq", ev.remove("seq"));
        }
        emit(ev);
        if ("call".equals(type)) {
            call(ev);
        }
        if ("finished".equals(type)) {
            worker.finished();
            // the worker lingers (--linger) for get_variables/eval on the ended execution
            timer.schedule(() -> controls.add(STOP), LINGER_MS, TimeUnit.MILLISECONDS);
        }
    }

    void emit(JsonObject ev) {
        if (!ev.has("time")) {
            ev.addProperty("time", now());
        }
        events.append(ev, st::apply);
        checkPrompts();
        if ("finished".equals(ExecState.str(ev, "type", ""))) {
            if (parent != null) {
                parent.childEnded(parentCall, ev, st.confirmation);
            }
            children.values().forEach(c -> c.abort("the calling procedure (execution " + id + ") ended"));
        }
    }

    /** The worker's sub-procedure requests. */
    private void call(JsonObject ev) {
        var seq = ExecState.num(ev, "call_seq", 0);
        switch (ExecState.str(ev, "stage", "")) {
        case "starting": {
            var reply = new JsonObject();
            reply.addProperty("cmd", "call_started");
            reply.addProperty("seq", seq);
            try {
                var req = new StartRequest();
                req.procedure = ExecState.str(ev, "procedure", "");
                if (ev.has("args") && ev.get("args").isJsonObject()) {
                    req.args = ev.getAsJsonObject("args");
                }
                if (ev.has("options") && ev.get("options").isJsonObject()) {
                    var o = ev.getAsJsonObject("options");
                    req.byStep = o.has("by_step") && o.get("by_step").getAsBoolean();
                    req.confirmCommands = o.has("confirm_commands") && o.get("confirm_commands").getAsBoolean();
                }
                req.parent = this;
                req.parentCall = seq;
                if (calls == null || st.isEnded()) {
                    throw new IllegalStateException("execution " + id + " cannot start procedures");
                }
                var child = calls.start(this, req);
                children.put(seq, child);
                reply.addProperty("id", child.id);
            } catch (Exception e) {
                log.warn("Execution {}: sub-procedure {} not started: {}", id, ExecState.str(ev, "procedure", ""),
                        e.toString());
                reply.addProperty("error", e.getMessage() == null ? e.toString() : e.getMessage());
            }
            send(reply);
            break;
        }
        case "aborting": {
            var child = children.get(seq);
            if (child != null) {
                log.info("Execution {}: aborting its sub-procedure {}", id, child.id);
                child.abort("aborted by the calling procedure (execution " + id + "): "
                        + ExecState.str(ev, "detail", ""));
            }
            break;
        }
        default:
        }
    }

    /** A sub-procedure has ended: the worker is told. Not under any lock of this execution. */
    private void childEnded(long call, JsonObject finished, String confirmation) {
        var c = new JsonObject();
        c.addProperty("cmd", "call_ended");
        c.addProperty("seq", call);
        c.addProperty("status", ExecState.str(finished, "status", "crashed"));
        if (confirmation != null) {
            c.addProperty("confirmation", confirmation);
        }
        c.addProperty("message", ExecState.str(finished, "message", ""));
        send(c);
    }

    /** The controller, or null. */
    private JsonObject controller() {
        synchronized (events) {
            return controller == null ? null : controller.deepCopy();
        }
    }

    private void ended(int code, String reason) {
        synchronized (events) {
            if (st.finished == null) {
                var ev = new JsonObject();
                ev.addProperty("type", "finished");
                if (killedBy != null) {
                    var k = new JsonObject();
                    k.addProperty("type", "killed");
                    k.addProperty("user", killedBy);
                    emit(k);
                    ev.addProperty("status", "killed");
                    ev.addProperty("message", "killed by " + killedBy);
                } else {
                    ev.addProperty("status", "crashed");
                    ev.addProperty("message", abortEscalated ? "worker killed: unresponsive to abort"
                            : reason != null ? reason : "worker exited with code " + code);
                }
                ev.addProperty("elapsed_ms", 0);
                ev.add("stats", new JsonObject());
                emit(ev);
            }
        }
        controls.add(STOP);
        log.info("Execution {} ended: {}", id, st.status);
        onEnd.run();
    }

    public boolean isAlive() {
        return worker != null && worker.isAlive();
    }

    public boolean isEnded() {
        synchronized (events) {
            return st.isEnded();
        }
    }

    // --- views ---------------------------------------------------------------

    public String summaryJson() {
        synchronized (events) {
            return st.summary().toString();
        }
    }

    public JsonObject summary() {
        synchronized (events) {
            return st.summary().deepCopy();
        }
    }

    public JsonObject state() {
        synchronized (events) {
            return st.state().deepCopy();
        }
    }

    public List<Long> breakpoints() {
        synchronized (events) {
            return new ArrayList<>(st.breakpoints);
        }
    }

    /** An open prompt, or null. */
    public JsonObject prompt(long promptId) {
        synchronized (events) {
            var p = st.prompts.get(promptId);
            return p == null ? null : p.deepCopy();
        }
    }

    public String startedBy() {
        return st.startedBy;
    }

    void setActivityId(String activityId) {
        synchronized (events) {
            st.activityId = activityId;
        }
    }

    // --- events (long poll) --------------------------------------------------

    /**
     * Long poll of the events after {@code after}; a poll with a session is that session's presence while it waits
     * and when it ends.
     */
    public Runnable poll(long after, long timeoutMs, String session, String user, Consumer<JsonObject> respond) {
        if (session != null) {
            synchronized (events) {
                touch(session, user, 1);
            }
        }
        var open = new java.util.concurrent.atomic.AtomicBoolean(true);
        Runnable left = () -> {
            if (session != null && open.compareAndSet(true, false)) {
                synchronized (events) {
                    touch(session, user, -1);
                }
            }
        };
        var cancel = events.poll(after, timeoutMs, () -> st.state().deepCopy(), out -> {
            left.run();
            respond.accept(out);
        });
        return () -> {
            cancel.run();
            left.run();
        };
    }

    // --- control model -------------------------------------------------------

    /** Under the events lock. */
    private void touch(String session, String user, int delta) {
        synchronized (sessions) {
            var p = sessions.computeIfAbsent(session, s -> new Presence());
            p.user = user;
            p.lastSeen = System.currentTimeMillis();
            p.active = Math.max(0, p.active + delta);
        }
    }

    private boolean isController(String session, String user) {
        return controller != null && session != null && session.equals(controller.get("session").getAsString())
                && user.equals(controller.get("user").getAsString());
    }

    /** Sends a control of the controller to the worker. */
    public void control(String session, String user, JsonObject c) {
        synchronized (events) {
            if (!isController(session, user)) {
                throw FopsException.forbidden("not the controller of execution " + id);
            }
            touch(session, user, 0);
            var cmd = ExecState.str(c, "cmd", "");
            if (!isAlive() || (st.isEnded() && !AFTER_END.contains(cmd))) {
                throw FopsException.conflict("execution " + id + " has ended");
            }
            if (cmd.equals("breakpoint")) {
                var line = ExecState.num(c, "line", -1);
                if (c.has("enabled") && c.get("enabled").getAsBoolean()) {
                    st.breakpoints.add(line);
                } else {
                    st.breakpoints.remove(line);
                }
            } else if (cmd.equals("set_trace_limit")) {
                st.traceLimit = c.has("limit") && !c.get("limit").isJsonNull() ? c.get("limit").getAsLong() : null;
            }
            send(c);
        }
    }

    /**
     * The worker then acts as {@code u} in Yamcs: what the controller does (the shell included) is done with the
     * controller's privileges, never with those of an earlier user.
     */
    public void takeControl(String session, User u) {
        requireSession(session);
        var user = u.getName();
        synchronized (events) {
            if (controller != null && !isController(session, user)) {
                throw FopsException.forbidden("execution " + id + " is controlled by "
                        + controller.get("user").getAsString());
            }
            if (isController(session, user)) {
                return;
            }
            controller = person(user, session);
            background = false;
            touch(session, user, 0);
            if (runsAs != null && !user.equals(runsAs.getName())) {
                log.info("Execution {}: now runs as {} (was {})", id, user, runsAs.getName());
                runsAs = u;
                if (token != null) {
                    try {
                        token.setUser(user);
                    } catch (IOException e) {
                        log.error("Execution {}: no token for {}: {}", id, user, e.toString());
                    }
                }
            }
            emitControl();
        }
    }

    public void releaseControl(String session, String user) {
        requireSession(session);
        synchronized (events) {
            if (!isController(session, user)) {
                throw FopsException.forbidden("not the controller of execution " + id);
            }
            controller = null;
            background = true;
            emitControl();
        }
        checkPrompts();
    }

    public void monitor(String session, String user) {
        requireSession(session);
        synchronized (events) {
            touch(session, user, 0);
            if (!st.isEnded() && !monitorUsers().equals(st.monitors)) {
                emitControl();
            }
        }
    }

    /** Lets a lingering worker of an ended execution exit (it is restarted). */
    void closeWorker() {
        controls.add(STOP);
    }

    /** Aborts the procedure, whoever controls it (its activity was cancelled). */
    void abort() {
        abort(null);
    }

    /** With the reason the procedure ends with, instead of "Aborted by operator". */
    void abort(String reason) {
        synchronized (events) {
            if (isAlive() && !st.isEnded()) {
                var c = new JsonObject();
                c.addProperty("cmd", "abort");
                if (reason != null) {
                    c.addProperty("reason", reason);
                }
                send(c);
            }
        }
    }

    public void kill(String user) {
        if (!isAlive() || isEnded()) {
            throw FopsException.conflict("execution " + id + " has no running worker");
        }
        killedBy = user;
        log.info("Execution {}: killed by {}", id, user);
        worker.kill();
    }

    private static void requireSession(String session) {
        if (session == null || session.isEmpty()) {
            throw FopsException.badRequest("session is required");
        }
    }

    /** Under the events lock. */
    private void emitControl() {
        var ev = new JsonObject();
        ev.addProperty("type", "control");
        ev.add("controller", controller == null ? JsonNull.INSTANCE : controller.deepCopy());
        var m = new com.google.gson.JsonArray();
        monitorUsers().forEach(m::add);
        ev.add("monitors", m);
        ev.addProperty("background", background);
        if (runsAs != null) {
            ev.addProperty("runs_as", runsAs.getName());
        }
        emit(ev);
    }

    /** Under the events lock: the users of the sessions present, but the controller's. */
    private List<String> monitorUsers() {
        var users = new TreeSet<String>();
        var now = System.currentTimeMillis();
        synchronized (sessions) {
            sessions.forEach((s, p) -> {
                if ((p.active > 0 || now - p.lastSeen < MONITOR_WINDOW_MS)
                        && !(controller != null && s.equals(controller.get("session").getAsString()))) {
                    users.add(p.user);
                }
            });
        }
        return new ArrayList<>(users);
    }

    /**
     * Once a second: forgets the sessions gone, updates the monitors and checks the controller's presence.
     *
     * @param graceMs
     *            how long the controller may be absent
     */
    public void tick(long now, long graceMs) {
        synchronized (events) {
            if (st.isEnded()) {
                return;
            }
            boolean present = true;
            synchronized (sessions) {
                sessions.values()
                        .removeIf(p -> p.active == 0 && now - p.lastSeen > Math.max(MONITOR_WINDOW_MS, graceMs));
                if (controller != null) {
                    var p = sessions.get(controller.get("session").getAsString());
                    present = p != null && (p.active > 0 || now - p.lastSeen < graceMs);
                }
            }
            if (controller != null && graceMs > 0) {
                if (!present) {
                    var user = controller.get("user").getAsString();
                    log.warn("Execution {}: controller {} lost, pausing", id, user);
                    if (isAlive() && !"paused".equals(st.status)) {
                        var c = new JsonObject();
                        c.addProperty("cmd", "pause");
                        send(c);
                    }
                    var ev = new JsonObject();
                    ev.addProperty("type", "controller_lost");
                    ev.addProperty("user", user);
                    ev.addProperty("action", "paused");
                    emit(ev);
                    controller = null;
                    controlChanged = true;
                }
            }
            if (controlChanged || !monitorUsers().equals(st.monitors)) {
                controlChanged = false;
                emitControl();
            }
        }
        checkPrompts();
    }

    /** A Yamcs event, once per prompt, for the prompts nobody controls. */
    private void checkPrompts() {
        List<JsonObject> raise = new ArrayList<>();
        synchronized (events) {
            alerted.retainAll(st.prompts.keySet());
            if (controller == null && !st.isEnded()) {
                st.prompts.forEach((pid, p) -> {
                    if (alerted.add(pid)) {
                        raise.add(p.deepCopy());
                    }
                });
            }
        }
        for (var p : raise) {
            try {
                promptAlert.alert(this, p);
            } catch (RuntimeException e) {
                log.warn("Execution {}: prompt alert failed: {}", id, e.toString());
            }
        }
    }

    @Override
    public String toString() {
        return "execution " + id + " (" + Objects.toString(st.procedure) + ")";
    }
}
