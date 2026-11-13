package com.jaops.yamcs.fops;

import static io.netty.handler.codec.http.HttpHeaderNames.CACHE_CONTROL;
import static io.netty.handler.codec.http.HttpHeaderNames.CONTENT_LENGTH;
import static io.netty.handler.codec.http.HttpHeaderNames.CONTENT_TYPE;
import static io.netty.handler.codec.http.HttpVersion.HTTP_1_1;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;

import org.yamcs.http.HandlerContext;
import org.yamcs.http.BodyHandler;
import org.yamcs.http.HttpException;
import org.yamcs.logging.Log;
import org.yamcs.security.ObjectPrivilegeType;
import org.yamcs.security.SystemPrivilege;
import org.yamcs.security.User;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import io.netty.handler.codec.http.DefaultFullHttpResponse;
import io.netty.handler.codec.http.HttpMethod;
import io.netty.handler.codec.http.HttpResponseStatus;
import io.netty.handler.codec.http.QueryStringDecoder;

/**
 * The fops HTTP API, {@code /fops/api/{instance}/...} (docs/plugin-api.md). Yamcs authenticates the user; the request
 * is then handled off the Netty event loop, on the plugin's pool, and a long poll of the events waits on no thread
 * at all.
 */
public class FopsHandler extends BodyHandler {
    private static final Log log = new Log(FopsHandler.class);
    static final int DEFAULT_POLL_TIMEOUT_S = 25;
    static final int MAX_POLL_TIMEOUT_S = 60;

    private final Executions executions;
    private final ExecutorService pool;
    private final String version;

    public FopsHandler(Executions executions, ExecutorService pool, String version) {
        this.executions = executions;
        this.pool = pool;
        this.version = version;
    }

    @Override
    public boolean requireAuth() {
        return true;
    }

    @Override
    public void handle(HandlerContext ctx) {
        // the body must be read now: Netty releases the request when this returns
        String body = null;
        if (ctx.isPOST()) {
            body = ctx.getNettyFullHttpRequest().content().toString(StandardCharsets.UTF_8);
        }
        var b = body;
        try {
            pool.execute(() -> {
                try {
                    route(ctx, b);
                } catch (Throwable t) {
                    sendError(ctx, t);
                }
            });
        } catch (RejectedExecutionException e) {
            sendError(ctx, new FopsException(HttpResponseStatus.SERVICE_UNAVAILABLE, "ServiceUnavailableException",
                    "fops is shutting down"));
        }
    }

    private void route(HandlerContext ctx, String body) throws IOException {
        // "", "fops", "api", instance, resource, ...
        var path = Arrays.stream(ctx.getPathWithoutContext().split("/", -1))
                .map(QueryStringDecoder::decodeComponent).toArray(String[]::new);
        if (path.length < 5 || !path[2].equals("api") || path[4].isEmpty()) {
            throw FopsException.notFound("no such fops resource");
        }
        var instance = path[3];
        var user = ctx.getUser();
        executions.instance(instance);
        requireMonitor(user);
        var resource = path[4];
        switch (resource) {
        case "info":
            requireMethod(ctx, HttpMethod.GET, path.length == 5);
            sendJson(ctx, HttpResponseStatus.OK, info(user, instance));
            return;
        case "procedures":
            requireMethod(ctx, HttpMethod.GET, true);
            var procedures = executions.procedures.get(instance);
            if (path.length == 5) {
                sendJson(ctx, HttpResponseStatus.OK, procedures.list());
            } else {
                var name = String.join("/", Arrays.copyOfRange(path, 5, path.length));
                sendJson(ctx, HttpResponseStatus.OK, procedures.get(name));
            }
            return;
        case "executions":
            executions(ctx, user, instance, path, body);
            return;
        default:
            throw FopsException.notFound("no such fops resource: " + resource);
        }
    }

    private void executions(HandlerContext ctx, User user, String instance, String[] path, String body)
            throws IOException {
        if (path.length == 5) {
            if (ctx.isGET()) {
                sendJson(ctx, HttpResponseStatus.OK, executions.list(instance));
                return;
            }
            requireMethod(ctx, HttpMethod.POST, true);
            require(user, FopsPlugin.START);
            var req = StartRequest.parse(json(body));
            var e = executions.start(instance, req, user);
            var out = new JsonObject();
            out.addProperty("id", e.id);
            sendJson(ctx, HttpResponseStatus.OK, out);
            return;
        }
        var idAction = path[5].split(":", 2);
        long id;
        try {
            id = Long.parseLong(idAction[0]);
        } catch (NumberFormatException ex) {
            throw FopsException.notFound("no such execution: " + idAction[0]);
        }
        var e = executions.get(instance, id);
        if (idAction.length == 2) {
            requireMethod(ctx, HttpMethod.POST, path.length == 6);
            action(ctx, user, e, idAction[1], json(body));
            return;
        }
        if (path.length == 6) {
            requireMethod(ctx, HttpMethod.GET, true);
            sendJson(ctx, HttpResponseStatus.OK, e.state());
            return;
        }
        if (path.length != 7) {
            throw FopsException.notFound("no such fops resource");
        }
        switch (path[6]) {
        case "events":
            requireMethod(ctx, HttpMethod.GET, true);
            events(ctx, user, e);
            return;
        case "control":
            requireMethod(ctx, HttpMethod.POST, true);
            control(ctx, user, e, json(body));
            return;
        case "asrun":
            requireMethod(ctx, HttpMethod.GET, true);
            send(ctx, HttpResponseStatus.OK, Executions.ASRUN_TYPE, executions.journal(e));
            return;
        case "procedure":
            requireMethod(ctx, HttpMethod.GET, true);
            sendJson(ctx, HttpResponseStatus.OK, executions.procedure(e));
            return;
        default:
            throw FopsException.notFound("no such fops resource: " + path[6]);
        }
    }

    private void action(HandlerContext ctx, User user, Execution e, String action, JsonObject body)
            throws IOException {
        var session = session(body);
        switch (action) {
        case "takeControl":
            require(user, FopsPlugin.CONTROL);
            e.takeControl(session, user);
            break;
        case "releaseControl":
            require(user, FopsPlugin.CONTROL);
            e.releaseControl(session, user.getName());
            break;
        case "monitor":
            e.monitor(session, user.getName());
            break;
        case "kill":
            require(user, FopsPlugin.KILL);
            e.kill(user.getName());
            break;
        case "restart": {
            require(user, FopsPlugin.START);
            if (!e.isEnded()) {
                throw FopsException.conflict("execution " + e.id + " has not ended");
            }
            var req = e.request.restart(e.breakpoints(), session);
            // the options as last set; an execution restored from its Summary alone has the request's
            var opts = e.state().get("options");
            if (opts != null && opts.isJsonObject()) {
                var o = opts.getAsJsonObject();
                req.byStep = o.has("byStep") ? o.get("byStep").getAsBoolean() : req.byStep;
                req.confirmCommands = o.has("confirmCommands") ? o.get("confirmCommands").getAsBoolean()
                        : req.confirmCommands;
            }
            var n = executions.start(e.instance, req, user);
            e.closeWorker();
            var out = new JsonObject();
            out.addProperty("id", n.id);
            sendJson(ctx, HttpResponseStatus.OK, out);
            return;
        }
        default:
            throw FopsException.notFound("no such action: " + action);
        }
        sendNoContent(ctx);
    }

    private void control(HandlerContext ctx, User user, Execution e, JsonObject body) {
        var session = session(body);
        var c = body.deepCopy();
        c.remove("session");
        var cmd = ExecState.str(c, "cmd", null);
        if (cmd == null) {
            throw FopsException.badRequest("cmd is required");
        }
        if (cmd.equals("eval") || cmd.equals("set_variable")) {
            require(user, FopsPlugin.SHELL);
        } else {
            require(user, FopsPlugin.CONTROL);
        }
        if (cmd.equals("answer")) {
            var prompt = e.prompt(ExecState.num(c, "id", -1));
            if (prompt != null && "command".equals(ExecState.str(prompt, "kind", null))) {
                var command = prompt.has("command") && prompt.get("command").isJsonObject()
                        ? ExecState.str(prompt.getAsJsonObject("command"), "name", null)
                        : null;
                if (command == null || !user.hasObjectPrivilege(ObjectPrivilegeType.Command, command)) {
                    throw FopsException.forbidden("no privilege to send " + command);
                }
            }
        }
        e.control(session, user.getName(), c);
        sendNoContent(ctx);
    }

    private void events(HandlerContext ctx, User user, Execution e) {
        long after = parseLong(ctx.getQueryParameter("after"), 0);
        long timeout = Math.min(MAX_POLL_TIMEOUT_S,
                Math.max(0, parseLong(ctx.getQueryParameter("timeout"), DEFAULT_POLL_TIMEOUT_S)));
        var session = ctx.getQueryParameter("session");
        if (session != null && session.isEmpty()) {
            session = null;
        }
        var channel = ctx.getNettyChannelHandlerContext().channel();
        var cancel = e.poll(after, timeout * 1000, session, user.getName(), out -> {
            if (channel.isActive()) {
                sendJson(ctx, HttpResponseStatus.OK, out);
            }
        });
        channel.closeFuture().addListener(f -> cancel.run());
    }

    private JsonObject info(User user, String instance) {
        var o = new JsonObject();
        o.addProperty("fopsVersion", version);
        var p = new JsonObject();
        p.addProperty("monitor", true);
        p.addProperty("start", has(user, FopsPlugin.START));
        p.addProperty("control", has(user, FopsPlugin.CONTROL));
        p.addProperty("shell", has(user, FopsPlugin.SHELL));
        p.addProperty("kill", has(user, FopsPlugin.KILL));
        o.add("privileges", p);
        o.addProperty("promptWarningDelay", executions.config.promptWarningDelay);
        o.addProperty("controllerGracePeriod", executions.config.controllerGracePeriod);
        o.addProperty("processor", executions.instance(instance).processor);
        var limit = executions.instance(instance).traceLimit;
        if (limit == null) {
            o.add("traceLimit", com.google.gson.JsonNull.INSTANCE);
        } else {
            o.addProperty("traceLimit", limit);
        }
        return o;
    }

    // --- privileges ----------------------------------------------------------

    static boolean has(User user, SystemPrivilege p) {
        return user.isSuperuser() || user.hasSystemPrivilege(p);
    }

    static void require(User user, SystemPrivilege p) {
        if (!has(user, p)) {
            throw FopsException.forbidden("insufficient privileges: " + p.getName() + " is needed");
        }
    }

    /** Monitor is implied by any other fops privilege. */
    static void requireMonitor(User user) {
        for (var p : FopsPlugin.PRIVILEGES) {
            if (has(user, p)) {
                return;
            }
        }
        throw FopsException.forbidden("insufficient privileges: " + FopsPlugin.MONITOR.getName() + " is needed");
    }

    // --- requests and responses ----------------------------------------------

    private static void requireMethod(HandlerContext ctx, HttpMethod method, boolean pathOk) {
        if (!pathOk) {
            throw FopsException.notFound("no such fops resource");
        }
        if (!ctx.getNettyHttpRequest().method().equals(method)) {
            throw new FopsException(HttpResponseStatus.METHOD_NOT_ALLOWED, "MethodNotAllowedException",
                    "only " + method + " here");
        }
    }

    private static JsonObject json(String body) {
        if (body == null || body.isBlank()) {
            return new JsonObject();
        }
        try {
            var e = JsonParser.parseString(body);
            if (!e.isJsonObject()) {
                throw FopsException.badRequest("the body must be a JSON object");
            }
            return e.getAsJsonObject();
        } catch (com.google.gson.JsonParseException e) {
            throw FopsException.badRequest("bad JSON: " + e.getMessage());
        }
    }

    private static String session(JsonObject body) {
        return ExecState.str(body, "session", null);
    }

    private static long parseLong(String s, long dflt) {
        if (s == null || s.isEmpty()) {
            return dflt;
        }
        try {
            return Long.parseLong(s);
        } catch (NumberFormatException e) {
            throw FopsException.badRequest("not a number: " + s);
        }
    }

    static void sendJson(HandlerContext ctx, HttpResponseStatus status, JsonElement json) {
        send(ctx, status, "application/json", json.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static void send(HandlerContext ctx, HttpResponseStatus status, String contentType, byte[] bytes) {
        var body = ctx.createByteBuf();
        body.writeBytes(bytes);
        var response = new DefaultFullHttpResponse(HTTP_1_1, status, body);
        response.headers().set(CONTENT_TYPE, contentType);
        response.headers().set(CONTENT_LENGTH, body.readableBytes());
        response.headers().set(CACHE_CONTROL, "no-store");
        ctx.sendResponse(response);
    }

    private static void sendNoContent(HandlerContext ctx) {
        var response = new DefaultFullHttpResponse(HTTP_1_1, HttpResponseStatus.NO_CONTENT);
        response.headers().set(CONTENT_LENGTH, 0);
        ctx.sendResponse(response);
    }

    /** As the Yamcs API: {code, type, msg}. */
    private void sendError(HandlerContext ctx, Throwable t) {
        HttpResponseStatus status;
        String type;
        if (t instanceof FopsException) {
            status = ((FopsException) t).getStatus();
            type = ((FopsException) t).getType();
        } else if (t instanceof HttpException) {
            status = ((HttpException) t).getStatus();
            type = t.getClass().getSimpleName();
        } else {
            log.error("Error handling {}", ctx.getNettyHttpRequest().uri(), t);
            status = HttpResponseStatus.INTERNAL_SERVER_ERROR;
            type = "InternalServerError";
        }
        var o = new JsonObject();
        o.addProperty("code", status.code());
        o.addProperty("type", type);
        o.addProperty("msg", t.getMessage() == null ? t.toString() : t.getMessage());
        sendJson(ctx, status, o);
    }
}
