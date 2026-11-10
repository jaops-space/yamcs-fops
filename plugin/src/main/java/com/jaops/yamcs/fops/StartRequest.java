package com.jaops.yamcs.fops;

import java.util.ArrayList;
import java.util.List;

import com.google.gson.JsonObject;

/** The body of {@code POST /executions}, kept by the execution for restart. */
public class StartRequest {
    String procedure;
    JsonObject args = new JsonObject();
    /** null: unlimited (only meaningful with {@link #traceLimitSet}). */
    Long traceLimit;
    boolean traceLimitSet;
    boolean background;
    List<Long> breakpoints = new ArrayList<>();
    boolean byStep;
    boolean confirmCommands;
    String session;
    /** A sub-procedure: the calling execution and its call number (not kept for restart). */
    Execution parent;
    long parentCall;

    static StartRequest parse(JsonObject body) {
        var r = new StartRequest();
        if (!body.has("procedure") || !body.get("procedure").isJsonPrimitive()) {
            throw FopsException.badRequest("procedure is required");
        }
        r.procedure = body.get("procedure").getAsString();
        try {
            if (body.has("args") && body.get("args").isJsonObject()) {
                r.args = body.getAsJsonObject("args");
            }
            if (body.has("traceLimit")) {
                r.traceLimitSet = true;
                var t = body.get("traceLimit");
                r.traceLimit = t.isJsonNull() ? null : t.getAsLong();
                if (r.traceLimit != null && r.traceLimit <= 0) {
                    r.traceLimit = null;
                }
            }
            r.background = body.has("background") && body.get("background").getAsBoolean();
            if (body.has("breakpoints") && body.get("breakpoints").isJsonArray()) {
                body.getAsJsonArray("breakpoints").forEach(b -> r.breakpoints.add(b.getAsLong()));
            }
            if (body.has("options") && body.get("options").isJsonObject()) {
                var o = body.getAsJsonObject("options");
                r.byStep = o.has("byStep") && o.get("byStep").getAsBoolean();
                r.confirmCommands = o.has("confirmCommands") && o.get("confirmCommands").getAsBoolean();
            }
            if (body.has("schedule")) {
                throw FopsException.badRequest(
                        "schedule: fops starts executions now; schedule a PROCEDURE activity on the Yamcs timeline");
            }
            if (body.has("session") && !body.get("session").isJsonNull()) {
                r.session = body.get("session").getAsString();
            }
        } catch (IllegalStateException | UnsupportedOperationException | NumberFormatException e) {
            throw FopsException.badRequest("bad request body: " + e.getMessage());
        }
        return r;
    }

    /**
     * Held before anything runs until the controller runs or steps, as SPELL loads a procedure: a start with a
     * controller. Background starts (the timeline's among them) run on their own, sub-procedures as their caller.
     */
    boolean startsPaused() {
        return !background && session != null && parent == null;
    }

    /** As parse() reads it back, without the session. */
    JsonObject toJson() {
        var o = new JsonObject();
        o.addProperty("procedure", procedure);
        o.add("args", args);
        o.addProperty("traceLimit", traceLimit);
        o.addProperty("background", background);
        var b = new com.google.gson.JsonArray();
        breakpoints.forEach(b::add);
        o.add("breakpoints", b);
        var opts = new JsonObject();
        opts.addProperty("byStep", byStep);
        opts.addProperty("confirmCommands", confirmCommands);
        o.add("options", opts);
        return o;
    }

    /** The same procedure, args, breakpoints and options, for {@code :restart}. */
    StartRequest restart(List<Long> currentBreakpoints, String session) {
        var r = new StartRequest();
        r.procedure = procedure;
        r.args = args.deepCopy();
        r.traceLimit = traceLimit;
        r.traceLimitSet = true;
        r.breakpoints = new ArrayList<>(currentBreakpoints);
        r.byStep = byStep;
        r.confirmCommands = confirmCommands;
        r.session = session;
        return r;
    }
}
