package com.jaops.yamcs.fops;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import org.yamcs.activities.Activity;
import org.yamcs.activities.ActivityExecution;
import org.yamcs.activities.ActivityService;
import org.yamcs.activities.ManualFailureException;
import org.yamcs.security.User;

import com.google.gson.JsonObject;

/**
 * An execution as a Yamcs activity: started here if Yamcs started the activity, followed until it ends.
 * <p>
 * The activity log gets the procedure's log messages, the steps' outcomes with their errors, the cleanups, the jumps,
 * the prompts and their answers, the watchdogs, the sub-procedures' ends and the loss of the controller. The activity
 * succeeds if the procedure finishes confirmed (a plain script: if it finishes), and fails otherwise, with the
 * execution's final message.
 */
class ProcedureActivity extends ActivityExecution {
    private static final long POLL_MS = 30_000;

    private final StartRequest request;
    private final User user;
    private volatile Execution execution;
    /** The procedure's confirmation, from its last "outcome" event; null for a plain script. */
    private String confirmation;
    /** The message of that "outcome" event: why it was aborted or finished early. */
    private String outcomeMessage;
    private final AtomicBoolean aborted = new AtomicBoolean();

    ProcedureActivity(ActivityService service, ProcedureExecutor executor, Activity activity, Execution execution,
            StartRequest request, User user) {
        super(service, executor, activity);
        this.execution = execution;
        this.request = request;
        this.user = user;
    }

    @Override
    public Void run() throws Exception {
        var e = execution;
        if (e == null) {
            e = ProcedureExecutor.launch(yamcsInstance, request, user);
            e.setActivityId(activity.getId().toString());
            activity.setDetail(ProcedureExecutor.detail(e));
            // stored at the start already: the activity list would show the detail without the execution id
            activityService.getActivityDb().update(activity);
            execution = e;
        }
        logServiceInfo("Execution " + e.id + " of " + e.request.procedure + ", as " + user.getName());
        follow(e);

        var state = e.state();
        var status = ExecState.str(state, "status", "crashed");
        var f = state.get("finished");
        var message = f != null && f.isJsonObject() ? ExecState.str(f.getAsJsonObject(), "message", "") : "";
        if (!"finished".equals(status)) {
            throw new ManualFailureException(message.isEmpty() ? status : status + ": " + message);
        }
        if (confirmation != null && !"confirmed".equals(confirmation)) {
            throw new ManualFailureException(outcomeMessage == null ? confirmation : confirmation + ": " + outcomeMessage);
        }
        return null;
    }

    /** Copies the execution's events to the activity log until it ends. */
    private void follow(Execution e) throws InterruptedException {
        long after = 0;
        while (true) {
            var answer = new CompletableFuture<JsonObject>();
            var cancel = e.events.poll(after, POLL_MS, () -> e.state(), answer::complete);
            JsonObject out;
            try {
                out = answer.get(POLL_MS + 5_000, TimeUnit.MILLISECONDS);
            } catch (InterruptedException ex) {
                cancel.run();
                throw ex;
            } catch (Exception ex) {
                cancel.run();
                out = null;
            }
            if (out != null) {
                if (out.has("snapshot")) {
                    // the first poll, or overrun: the outcome may be among the events not seen
                    after = out.get("seq").getAsLong();
                    var entries = out.getAsJsonObject("snapshot").get("log");
                    if (entries != null && entries.isJsonArray()) {
                        for (var el : entries.getAsJsonArray()) {
                            var ev = el.getAsJsonObject();
                            if ("outcome".equals(ExecState.str(ev, "type", ""))) {
                                log(ev);
                            }
                        }
                    }
                } else if (out.has("events")) {
                    for (var el : out.getAsJsonArray("events")) {
                        var ev = el.getAsJsonObject();
                        after = Math.max(after, ExecState.num(ev, "seq", after));
                        log(ev);
                    }
                }
            }
            if (e.isEnded()) {
                return;
            }
        }
    }

    private void log(JsonObject ev) {
        switch (ExecState.str(ev, "type", "")) {
        case "log": {
            var msg = ExecState.str(ev, "message", "");
            switch (ExecState.str(ev, "level", "info")) {
            case "error":
                logActivityError(msg);
                break;
            case "warning":
            case "warn":
                logActivityWarning(msg);
                break;
            default:
                logActivityInfo(msg);
            }
            break;
        }
        case "step": {
            if (!"completed".equals(ExecState.str(ev, "execution", ""))) {
                break;
            }
            var c = ExecState.str(ev, "confirmation", "");
            var msg = "Step " + (ExecState.num(ev, "index", -1) + 1) + " '" + ExecState.str(ev, "name", "?") + "': " + c;
            var note = ExecState.str(ev, "note", null);
            if (note != null) {
                msg += " (" + note + ")";
            }
            var error = ExecState.str(ev, "error", null);
            if (error != null) {
                msg += ": " + error;
            } else if (!"confirmed".equals(c)) {
                var failed = failed(ev);
                if (!failed.isEmpty()) {
                    msg += ": " + failed;
                }
            }
            if ("confirmed".equals(c)) {
                logActivityInfo(msg);
            } else if ("aborted".equals(c)) {
                logActivityError(msg);
            } else {
                logActivityWarning(msg);
            }
            break;
        }
        case "outcome":
            if ("completed".equals(ExecState.str(ev, "execution", ""))) {
                confirmation = ExecState.str(ev, "confirmation", null);
                outcomeMessage = ExecState.str(ev, "message", null);
            }
            break;
        case "verify":
            // a step's failed checks are in its outcome; the procedure's ensures are not
            if (ExecState.bool(ev, "procedure", false) && !ExecState.bool(ev, "ok", true)) {
                logActivityWarning("Procedure not confirmed: " + failed(ev));
            }
            break;
        case "cleanup": {
            var steps = new StringBuilder();
            var a = ev.get("steps");
            if (a != null && a.isJsonArray()) {
                for (var i : a.getAsJsonArray()) {
                    steps.append(steps.length() == 0 ? "" : ", ").append(i.getAsInt() + 1);
                }
            }
            logActivityWarning("Cleanup steps " + steps + ": " + ExecState.str(ev, "reason", ""));
            break;
        }
        case "jump": {
            var source = ev.get("source");
            logActivityWarning("Jump from " + (source == null || source.isJsonNull() ? "the start"
                    : "step " + (source.getAsInt() + 1)) + " to step " + (ExecState.num(ev, "target", -1) + 1));
            break;
        }
        case "prompt":
            logActivityWarning("Asks: " + ExecState.str(ev, "message", ""));
            break;
        case "prompt_answered":
            logActivityInfo("Answer: " + ExecState.str(ev, "answer", ""));
            break;
        case "prompt_cancelled":
            logActivityInfo("Question withdrawn: " + ExecState.str(ev, "reason", ""));
            break;
        case "watch": {
            var action = ExecState.str(ev, "action", "");
            var error = ExecState.str(ev, "error", null);
            var msg = "Watchdog '" + ExecState.str(ev, "message", "") + "': " + action;
            if (error != null) {
                logActivityError(msg + ": " + error);
            } else {
                logActivityWarning(msg);
            }
            break;
        }
        case "call":
            if ("ended".equals(ExecState.str(ev, "stage", ""))) {
                var st = ExecState.str(ev, "status", "?");
                var c = ExecState.str(ev, "confirmation", null);
                var msg = "Sub-procedure " + ExecState.str(ev, "procedure", "?") + " (execution "
                        + ExecState.str(ev, "id", "?") + "): " + st + (c == null ? "" : ", " + c);
                if ("finished".equals(st) && (c == null || "confirmed".equals(c))) {
                    logActivityInfo(msg);
                } else {
                    logActivityWarning(msg);
                }
            }
            break;
        case "controller_lost":
            logActivityWarning("Controller " + ExecState.str(ev, "user", "?") + " lost: paused");
            break;
        default:
        }
    }

    /** The conditions not met, of an event with "results". */
    private static String failed(JsonObject ev) {
        var out = new StringBuilder();
        var a = ev.get("results");
        if (a != null && a.isJsonArray()) {
            for (var el : a.getAsJsonArray()) {
                var r = el.getAsJsonObject();
                if (!ExecState.bool(r, "ok", true)) {
                    out.append(out.length() == 0 ? "" : "; ").append(ExecState.str(r, "condition", "?"));
                }
            }
        }
        return out.toString();
    }

    /** Aborts the execution when the activity is cancelled; Yamcs calls it twice then, and once at any end. */
    @Override
    public void stop() {
        var e = execution;
        if (e != null && !e.isEnded() && activityService.isStopRequested(activity) && aborted.compareAndSet(false, true)) {
            logServiceInfo("Aborting execution " + e.id);
            e.abort();
        }
    }
}
