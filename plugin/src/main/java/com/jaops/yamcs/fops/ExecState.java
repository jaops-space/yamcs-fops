package com.jaops.yamcs.fops;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

/**
 * What an execution is doing, built from its events: the Summary and
 * the State of docs/plugin-api.md. Not thread safe: {@link Execution} applies events and reads it under one lock.
 */
public class ExecState {
    static final int LOG_CAP = 2000;

    /** Statuses after which the worker is gone. */
    static final Set<String> FINAL = Set.of("finished", "aborted", "error", "crashed", "killed");

    final long id;
    final String instance;
    final String procedure;
    final String started;
    final String origin;
    final String startedBy;

    String ended;
    String status = "starting";
    /** Inside wait/wait_until, until the next line. */
    boolean waiting;
    String message;
    Long traceLimit;
    JsonObject args = new JsonObject();
    boolean byStep;
    boolean confirmCommands;

    // The control model, from the plugin's "control" events.
    JsonObject controller;
    List<String> monitors = new ArrayList<>();
    boolean background;
    /** The Yamcs activity of the execution, once there is one. */
    String activityId;
    /** A sub-procedure: the calling execution and its call number. */
    Long parentId;
    long parentCall;
    /** The procedure's confirmation, from its last "outcome" event. */
    String confirmation;

    long seq;
    final JsonArray codes = new JsonArray();
    JsonObject procedureInfo;
    final TreeMap<Long, JsonObject> steps = new TreeMap<>();
    JsonObject current;
    /** The events after which no evaluation is in progress. */
    static final Set<String> ENDS_EVALUATING = Set.of("line", "verify", "precondition", "step", "jump", "finished",
            "killed", "crashed");
    /** The latest values of a goal or wait_until in progress (an "evaluating" event), or null. */
    JsonObject evaluating;
    final TreeMap<String, Long> hits = new TreeMap<>();
    final TreeSet<String> suppressed = new TreeSet<>();
    final TreeSet<Long> breakpoints = new TreeSet<>();
    final ArrayDeque<JsonObject> log = new ArrayDeque<>();
    final List<JsonObject> commands = new ArrayList<>();
    final TreeMap<Long, JsonObject> prompts = new TreeMap<>();
    /** The latest record of each sub-procedure, by call number. */
    final TreeMap<Long, JsonObject> calls = new TreeMap<>();
    JsonObject finished;
    JsonObject variables;
    /** Restored from the database: the Summary and State as saved; nothing is applied any more. */
    private JsonObject savedSummary;
    private JsonObject savedState;

    public ExecState(long id, String instance, String procedure, String started, String origin, String startedBy) {
        this.id = id;
        this.instance = instance;
        this.procedure = procedure;
        this.started = started;
        this.origin = origin;
        this.startedBy = startedBy;
    }

    /**
     * An ended execution of an earlier server life, from its saved Summary and State (the Summary alone if it did not
     * end: it is then crashed, with {@code message}).
     */
    static ExecState restore(JsonObject summary, JsonObject state, String message) {
        var s = state != null ? state : summary;
        var st = new ExecState(num(s, "id", 0), str(s, "instance", ""), str(s, "procedure", ""),
                str(s, "started", ""), str(s, "origin", "user"), str(s, "startedBy", null));
        summary = summary.deepCopy();
        state = (state != null ? state : summary).deepCopy();
        // from the Summary, commands is a count
        if (!state.has("commands") || !state.get("commands").isJsonArray()) {
            state.add("commands", new JsonArray());
        }
        // a poll after 0 always gets a snapshot
        if (num(state, "seq", 0) < 1) {
            state.addProperty("seq", 1);
        }
        if (message != null || !state.has("finished") || !state.get("finished").isJsonObject()) {
            var status = message != null ? "crashed" : str(summary, "status", "crashed");
            var msg = message != null ? message : str(summary, "message", null);
            var f = new JsonObject();
            f.addProperty("type", "finished");
            f.addProperty("status", status);
            f.addProperty("message", msg);
            for (var o : new JsonObject[] { summary, state }) {
                o.addProperty("status", status);
                o.addProperty("activity", status);
                o.addProperty("message", msg);
            }
            state.add("finished", f);
        }
        for (var o : new JsonObject[] { summary, state }) {
            o.add("controller", JsonNull.INSTANCE);
            o.add("monitors", new JsonArray());
        }
        st.status = str(summary, "status", "crashed");
        st.ended = str(summary, "ended", null);
        st.message = str(summary, "message", null);
        st.seq = num(state, "seq", 0);
        st.finished = state.getAsJsonObject("finished");
        if (state.has("breakpoints") && state.get("breakpoints").isJsonArray()) {
            state.getAsJsonArray("breakpoints").forEach(b -> st.breakpoints.add(b.getAsLong()));
        }
        st.savedSummary = summary;
        st.savedState = state;
        return st;
    }

    public boolean isEnded() {
        return FINAL.contains(status) && finished != null;
    }

    /** Applies one event, which already carries its seq and time. */
    public void apply(JsonObject ev) {
        if (ev.has("seq")) {
            seq = ev.get("seq").getAsLong();
        }
        var type = str(ev, "type", "");
        if (ENDS_EVALUATING.contains(type)) {
            evaluating = null;
        }
        switch (type) {
        case "started":
            status = "running";
            break;
        case "code":
            codes.add(ev);
            break;
        case "line":
            hits.put(key(ev), num(ev, "n", 0));
            current = ev;
            waiting = false;
            break;
        case "suppressed":
            suppressed.add(key(ev));
            break;
        case "evaluating":
            evaluating = ev;
            break;
        case "paused":
            status = "paused";
            current = ev;
            waiting = false;
            break;
        case "resumed":
            status = "running";
            break;
        case "procedure":
            procedureInfo = ev;
            break;
        case "step":
            steps.put(num(ev, "index", 0), ev);
            pushLog(ev);
            break;
        case "wait":
        case "waiting":
            waiting = true;
            pushLog(ev);
            break;
        case "verify":
            waiting = false;
            pushLog(ev);
            break;
        case "log":
            message = str(ev, "message", null);
            pushLog(ev);
            break;
        case "output":
        case "telemetry":
        case "precondition":
        case "watch":
        case "jump":
        case "sample":
        case "check":
        case "set":
        case "cleanup":
        case "eval_result":
        case "controller_lost":
        case "killed":
            pushLog(ev);
            break;
        case "outcome":
            if ("completed".equals(str(ev, "execution", ""))) {
                confirmation = str(ev, "confirmation", null);
            }
            pushLog(ev);
            break;
        case "call": {
            var seq = num(ev, "call_seq", 0);
            var c = ev.deepCopy();
            // "waiting" has no execution id: keep the one known
            var prev = calls.get(seq);
            if (!c.has("id") && prev != null && prev.has("id")) {
                c.add("id", prev.get("id"));
            }
            calls.put(seq, c);
            waiting = "waiting".equals(str(ev, "stage", ""));
            pushLog(ev);
            break;
        }
        case "options":
            if (ev.has("by_step") && !ev.get("by_step").isJsonNull()) {
                byStep = ev.get("by_step").getAsBoolean();
            }
            if (ev.has("confirm_commands") && !ev.get("confirm_commands").isJsonNull()) {
                confirmCommands = ev.get("confirm_commands").getAsBoolean();
            }
            break;
        case "variables":
            variables = ev;
            break;
        case "command":
            commands.add(withEx(ev));
            break;
        case "prompt":
            prompts.put(num(ev, "id", 0), ev);
            pushLog(ev);
            break;
        case "prompt_answered":
        case "prompt_cancelled":
            prompts.remove(num(ev, "id", 0));
            pushLog(ev);
            break;
        case "finished":
            status = str(ev, "status", "finished");
            finished = ev;
            ended = str(ev, "time", null);
            prompts.clear();
            waiting = false;
            break;
        case "control":
            controller = ev.has("controller") && ev.get("controller").isJsonObject()
                    ? ev.getAsJsonObject("controller")
                    : null;
            monitors = new ArrayList<>();
            if (ev.has("monitors") && ev.get("monitors").isJsonArray()) {
                ev.getAsJsonArray("monitors").forEach(m -> monitors.add(m.getAsString()));
            }
            background = ev.has("background") && ev.get("background").getAsBoolean();
            break;
        default:
            break;
        }
    }

    void pushLog(JsonObject ev) {
        if (log.size() == LOG_CAP) {
            log.removeFirst();
        }
        log.addLast(withEx(ev));
    }

    /**
     * The event with "ex", the execution of its line (of the main file) it belongs
     * to: the snapshot keeps the hit counts only as they are now.
     */
    JsonObject withEx(JsonObject ev) {
        var line = num(ev, "line", 0);
        if (line <= 0) {
            return ev;
        }
        long ex = 0;
        for (var c : codes) {
            var o = c.getAsJsonObject();
            if (o.has("main") && o.get("main").getAsBoolean()) {
                ex = Math.max(ex, hits.getOrDefault(raw(o, "code_id") + ":" + line, 0L));
            }
        }
        if (ex == 0) {
            return ev;
        }
        var copy = ev.deepCopy();
        copy.addProperty("ex", ex);
        return copy;
    }

    /** SPELL-style: prompt, waiting, paused, running, or the final status. */
    public String activity() {
        if (FINAL.contains(status)) {
            return status;
        }
        if (!prompts.isEmpty()) {
            return "prompt";
        }
        if (waiting) {
            return "waiting";
        }
        if (status.equals("paused")) {
            // held before anything ran (--paused): SPELL's LOADED
            return current != null && "start".equals(str(current, "reason", null)) ? "loaded" : "paused";
        }
        return "running";
    }

    /** The step in progress (the latest not completed), else the last one. */
    JsonElement currentStep() {
        JsonObject s = null;
        for (var step : steps.descendingMap().values()) {
            if (!"completed".equals(str(step, "execution", null))) {
                s = step;
                break;
            }
        }
        if (s == null && !steps.isEmpty()) {
            s = steps.lastEntry().getValue();
        }
        if (s == null) {
            return JsonNull.INSTANCE;
        }
        var out = new JsonObject();
        for (var k : new String[] { "index", "name", "execution", "confirmation" }) {
            out.add(k, s.has(k) ? s.get(k) : JsonNull.INSTANCE);
        }
        return out;
    }

    public JsonObject summary() {
        if (savedSummary != null) {
            return savedSummary;
        }
        var o = new JsonObject();
        o.addProperty("id", id);
        o.addProperty("instance", instance);
        o.addProperty("procedure", procedure);
        o.add("name", info("name"));
        o.add("version", info("version"));
        o.addProperty("started", started);
        if (ended != null) {
            o.addProperty("ended", ended);
        }
        o.addProperty("status", status);
        o.addProperty("activity", activity());
        o.add("step", currentStep());
        o.add("message", message == null ? JsonNull.INSTANCE : new JsonPrimitive(message));
        o.addProperty("commands", commands.size());
        o.add("controller", controller == null ? JsonNull.INSTANCE : controller);
        var m = new JsonArray();
        monitors.forEach(m::add);
        o.add("monitors", m);
        o.addProperty("background", background);
        o.addProperty("origin", origin);
        o.addProperty("startedBy", startedBy);
        if (activityId != null) {
            o.addProperty("activityId", activityId);
        }
        if (parentId != null) {
            o.addProperty("parentId", parentId);
            o.addProperty("parentCall", parentCall);
        }
        return o;
    }

    public JsonObject state() {
        if (savedState != null) {
            return savedState;
        }
        var o = summary();
        o.addProperty("seq", seq);
        o.add("traceLimit", traceLimit == null ? JsonNull.INSTANCE : new JsonPrimitive(traceLimit));
        o.add("args", args);
        var opts = new JsonObject();
        opts.addProperty("byStep", byStep);
        opts.addProperty("confirmCommands", confirmCommands);
        o.add("options", opts);
        o.add("codes", codes);
        o.add("procedureInfo", orNull(procedureInfo));
        o.add("steps", toObject(steps));
        o.add("current", orNull(current));
        o.add("evaluating", orNull(evaluating));
        var h = new JsonObject();
        hits.forEach(h::addProperty);
        o.add("hits", h);
        var s = new JsonArray();
        suppressed.forEach(s::add);
        o.add("suppressed", s);
        var b = new JsonArray();
        breakpoints.forEach(b::add);
        o.add("breakpoints", b);
        var l = new JsonArray();
        log.forEach(l::add);
        o.add("log", l);
        var c = new JsonArray();
        commands.forEach(c::add);
        o.add("commands", c);
        o.add("prompts", toObject(prompts));
        o.add("calls", toObject(calls));
        o.add("finished", orNull(finished));
        o.add("variables", orNull(variables));
        return o;
    }

    private JsonElement info(String field) {
        if (procedureInfo != null && procedureInfo.has(field)) {
            return procedureInfo.get(field);
        }
        return JsonNull.INSTANCE;
    }

    private static JsonObject toObject(Map<Long, JsonObject> map) {
        var o = new JsonObject();
        map.forEach((k, v) -> o.add(Long.toString(k), v));
        return o;
    }

    private static JsonElement orNull(JsonObject o) {
        return o == null ? JsonNull.INSTANCE : o;
    }

    /** "code_id:line", as the worker's suppressed locations and the UI's hit counts. */
    static String key(JsonObject ev) {
        return raw(ev, "code_id") + ":" + raw(ev, "line");
    }

    private static String raw(JsonObject ev, String field) {
        var e = ev.get(field);
        if (e == null || e.isJsonNull()) {
            return "null";
        }
        return e.getAsString();
    }

    static String str(JsonObject ev, String field, String dflt) {
        var e = ev.get(field);
        return e == null || e.isJsonNull() ? dflt : e.getAsString();
    }

    static long num(JsonObject ev, String field, long dflt) {
        var e = ev.get(field);
        if (e == null || e.isJsonNull()) {
            return dflt;
        }
        try {
            return e.getAsLong();
        } catch (NumberFormatException | UnsupportedOperationException ex) {
            return dflt;
        }
    }
}
