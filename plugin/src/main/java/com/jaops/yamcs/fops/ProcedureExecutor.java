package com.jaops.yamcs.fops;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

import org.yamcs.Spec;
import org.yamcs.Spec.NamedSpec;
import org.yamcs.Spec.OptionType;
import org.yamcs.ValidationException;
import org.yamcs.YConfiguration;
import org.yamcs.YamcsServer;
import org.yamcs.activities.Activity;
import org.yamcs.activities.ActivityExecution;
import org.yamcs.activities.ActivityExecutor;
import org.yamcs.activities.ActivityService;
import org.yamcs.security.User;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;

/**
 * The Yamcs activity type {@value #TYPE}: every execution is an activity of its instance.
 * <p>
 * An activity started by Yamcs (the activities API, a timeline item) starts an execution in the background, with the
 * activity's arguments {@code {procedure, args?, options?: {byStep, confirmCommands}}} and its user; the timeline
 * starts its activities as the System user, whose executions run as the instance's service user ({@link ServiceUser})
 * when security is on. An execution started by fops (its UI or API, a restart) is attached to a new activity once its
 * worker runs ({@link #attach}).
 * Either way the activity follows the execution and ends with it; cancelling the activity aborts the execution.
 * <p>
 * Yamcs makes one executor per instance (ServiceLoader), before or after the plugin is loaded.
 */
public class ProcedureExecutor implements ActivityExecutor {
    public static final String TYPE = "PROCEDURE";
    private static final Gson GSON = new Gson();

    /** The executions started by fops, from {@link #attach} to {@link #createExecution}. */
    private static final Map<UUID, Execution> attaching = new ConcurrentHashMap<>();

    private ActivityService activityService;

    @Override
    public String getActivityType() {
        return TYPE;
    }

    @Override
    public String getDisplayName() {
        return "Procedure";
    }

    @Override
    public String getDescription() {
        return "Run a fops procedure.";
    }

    @Override
    public String getIcon() {
        return "playlist_play";
    }

    @Override
    public NamedSpec getSpec() {
        return null;
    }

    @Override
    public void init(ActivityService activityService, YConfiguration options) {
        this.activityService = activityService;
    }

    @Override
    public Spec getActivitySpec() {
        var options = new Spec();
        options.addOption("byStep", OptionType.BOOLEAN);
        options.addOption("confirmCommands", OptionType.BOOLEAN);
        var spec = new Spec();
        spec.addOption("procedure", OptionType.STRING).withRequired(true);
        spec.addOption("args", OptionType.MAP).withSpec(Spec.ANY);
        spec.addOption("options", OptionType.MAP).withSpec(options);
        return spec;
    }

    @Override
    public String describeActivity(Map<String, Object> args) {
        return YConfiguration.getString(args, "procedure");
    }

    /** A refusal (an IllegalArgumentException or a FopsException) makes the activity fail at once. */
    @Override
    public ActivityExecution createExecution(Activity activity, User user) throws ValidationException {
        var e = attaching.remove(activity.getId());
        if (e != null) {
            return new ProcedureActivity(activityService, this, activity, e, null, user);
        }
        var args = getActivitySpec().validate(activity.getArgs());
        var executions = executions();
        var instance = activityService.getYamcsInstance();
        if (executions == null || !executions.config.instances.containsKey(instance)) {
            throw new IllegalArgumentException("no fops for instance " + instance);
        }
        if (ServiceUser.isSystem(user) && YamcsServer.getServer().getSecurityStore().isEnabled()) {
            var serviceUser = executions.config.instances.get(instance).serviceUser;
            if (serviceUser == null) {
                throw new IllegalArgumentException("no fops serviceUser for instance " + instance
                        + ": the timeline cannot start procedures");
            }
            user = ServiceUser.login(serviceUser);
        }
        if (!user.hasSystemPrivilege(FopsPlugin.START)) {
            throw new IllegalArgumentException("user " + user.getName() + " lacks privilege " + FopsPlugin.START);
        }
        var body = integral(GSON.toJsonTree(args)).getAsJsonObject();
        var req = StartRequest.parse(body);
        return new ProcedureActivity(activityService, this, activity, null, req, user);
    }

    /**
     * Makes a started execution an activity of its instance, started by its user; nothing if Yamcs has no
     * activities for the instance or there is no such executor.
     */
    static void attach(Execution e, User user) {
        var instance = YamcsServer.getServer().getInstance(e.instance);
        var service = instance == null ? null : instance.getActivityService();
        if (service == null || service.getExecutor(TYPE) == null) {
            return;
        }
        var args = new JsonObject();
        args.addProperty("procedure", e.request.procedure);
        if (e.request.args.size() > 0) {
            args.add("args", e.request.args);
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> map = GSON.fromJson(args, Map.class);
        var activity = service.prepareActivity(TYPE, map, user, null);
        activity.setDetail(detail(e));
        e.setActivityId(activity.getId().toString());
        attaching.put(activity.getId(), e);
        try {
            service.startActivity(activity, user);
        } finally {
            attaching.remove(activity.getId());
        }
    }

    static String detail(Execution e) {
        return e.request.procedure + " (execution " + e.id + ")";
    }

    private static Executions executions() {
        var plugin = YamcsServer.getServer().getPluginManager().getPlugin(FopsPlugin.class);
        return plugin == null ? null : plugin.executions();
    }

    /** Started by Yamcs, an execution in the background of the activity's instance. */
    static Execution launch(String instance, StartRequest req, User user) throws Exception {
        var executions = executions();
        if (executions == null) {
            throw new IllegalStateException("the fops plugin is not loaded");
        }
        return executions.launch(instance, req, user);
    }

    /**
     * Protobuf Structs carry numbers as doubles: 3.0 becomes 3, so that it is a valid int argument of the procedure.
     */
    private static JsonElement integral(JsonElement el) {
        if (el.isJsonObject()) {
            var o = new JsonObject();
            el.getAsJsonObject().entrySet().forEach(en -> o.add(en.getKey(), integral(en.getValue())));
            return o;
        }
        if (el.isJsonArray()) {
            var a = new com.google.gson.JsonArray();
            el.getAsJsonArray().forEach(x -> a.add(integral(x)));
            return a;
        }
        if (el.isJsonPrimitive() && el.getAsJsonPrimitive().isNumber()) {
            var d = el.getAsDouble();
            if (d == Math.rint(d) && !Double.isInfinite(d) && Math.abs(d) < 1L << 53) {
                return new JsonPrimitive((long) d);
            }
        }
        return el;
    }
}
