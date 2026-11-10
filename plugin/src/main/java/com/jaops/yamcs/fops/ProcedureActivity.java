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
 * The activity log gets the procedure's log messages, the steps' outcomes, the prompts, the watchdogs and the loss of
 * the controller. The activity succeeds if the procedure finishes confirmed (a plain script: if it finishes), and fails
 * otherwise, with the execution's final message.
 */
class ProcedureActivity extends ActivityExecution {
    private static final long POLL_MS = 30_000;

    private final StartRequest request;
    private final User user;
    private volatile Execution execution;
    /** The procedure's confirmation, from its last "outcome" event; null for a plain script. */
    private String confirmation;
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

        var summary = e.summary();
        var status = ExecState.str(summary, "status", "crashed");
        var message = ExecState.str(summary, "message", status);
        if (!"finished".equals(status)) {
            throw new ManualFailureException(status + ": " + message);
        }
        if (confirmation != null && !"confirmed".equals(confirmation)) {
            throw new ManualFailureException(confirmation + ": " + message);
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
            var msg = "Step " + ExecState.str(ev, "name", "?") + ": " + c;
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
            }
            break;
        case "prompt":
            logActivityWarning("Asks: " + ExecState.str(ev, "message", ""));
            break;
        case "watch":
            logActivityWarning("Watchdog: " + ExecState.str(ev, "message", ""));
            break;
        case "controller_lost":
            logActivityWarning("Controller " + ExecState.str(ev, "user", "?") + " lost: paused");
            break;
        default:
        }
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
