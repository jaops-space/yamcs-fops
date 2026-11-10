package com.jaops.yamcs.fops;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;

import org.yamcs.http.HandlerContext;
import org.yamcs.http.HttpHandler;
import org.yamcs.http.HttpRequestHandler;
import org.yamcs.security.User;

import io.netty.buffer.Unpooled;
import io.netty.channel.ChannelHandlerContext;
import io.netty.handler.codec.http.DefaultFullHttpRequest;
import io.netty.handler.codec.http.DefaultFullHttpResponse;
import io.netty.handler.codec.http.EmptyHttpHeaders;
import io.netty.handler.codec.http.HttpHeaderNames;
import io.netty.handler.codec.http.HttpHeaderValues;
import io.netty.handler.codec.http.HttpRequest;
import io.netty.handler.codec.http.HttpResponseStatus;
import io.netty.handler.codec.http.HttpUtil;
import io.netty.handler.codec.http.cors.CorsHandler;
import io.netty.handler.codec.http.websocketx.WebSocketFrameAggregator;
import io.netty.handler.codec.http.websocketx.WebSocketServerHandshakerFactory;
import io.netty.handler.timeout.IdleStateHandler;

/**
 * The runners' side of the plugin, at {@code <contextPath>/fops-runner/}: {@code connect}, the WebSocket of a runner;
 * {@code blobs/{instance}/{sha256}}, a file of an instance's procedures by content. Both need the privilege
 * {@code fops.Runner}.
 */
public class RunnerHandler extends HttpHandler {
    static final int MAX_FRAME = 16 << 20;
    /** Runners ping every 10 s. */
    static final int SILENCE_S = 30;
    private final Runners runners;
    private final Executions executions;
    private final ExecutorService pool;

    RunnerHandler(Runners runners, Executions executions, ExecutorService pool) {
        this.runners = runners;
        this.executions = executions;
        this.pool = pool;
    }

    @Override
    public boolean requireAuth() {
        return true;
    }

    @Override
    protected void doHandle(ChannelHandlerContext ctx, HttpRequest req, User user) {
        var path = new io.netty.handler.codec.http.QueryStringDecoder(req.uri()).path();
        if (path.endsWith("/fops-runner/connect") && req.headers().containsValue(HttpHeaderNames.UPGRADE,
                HttpHeaderValues.WEBSOCKET, true)) {
            if (!user.hasSystemPrivilege(FopsPlugin.RUNNER)) {
                respond(ctx, req, HttpResponseStatus.FORBIDDEN, "lacks privilege fops.Runner");
                return;
            }
            upgrade(ctx, req, user);
            return;
        }
        super.doHandle(ctx, req, user);
    }

    private void upgrade(ChannelHandlerContext ctx, HttpRequest req, User user) {
        var full = new DefaultFullHttpRequest(req.protocolVersion(), req.method(), req.uri(), Unpooled.EMPTY_BUFFER,
                req.headers(), EmptyHttpHeaders.INSTANCE);
        var location = "ws://" + req.headers().get(HttpHeaderNames.HOST) + req.uri();
        var handshaker = new WebSocketServerHandshakerFactory(location, null, true, MAX_FRAME).newHandshaker(full);
        if (handshaker == null) {
            WebSocketServerHandshakerFactory.sendUnsupportedVersionResponse(ctx.channel());
            return;
        }
        var channel = ctx.channel();
        var pipeline = ctx.pipeline();
        handshaker.handshake(channel, full);
        // Yamcs's HTTP handlers (this one's included) give way to the runner's frames
        if (pipeline.get(CorsHandler.class) != null) {
            pipeline.remove(CorsHandler.class);
        }
        pipeline.remove(HttpRequestHandler.class);
        pipeline.addLast(new IdleStateHandler(SILENCE_S, 0, 0, TimeUnit.SECONDS));
        pipeline.addLast(new WebSocketFrameAggregator(MAX_FRAME));
        pipeline.addLast(new RunnerConnection(runners, user.getName(), channel));
    }

    @Override
    public void handle(HandlerContext ctx) {
        // "", "fops-runner", "blobs", instance, sha
        var path = ctx.getPathWithoutContext().split("/", -1);
        if (path.length != 5 || !path[2].equals("blobs")) {
            throw FopsException.notFound("no such fops-runner resource");
        }
        if (!ctx.getUser().hasSystemPrivilege(FopsPlugin.RUNNER)) {
            throw FopsException.forbidden("lacks privilege fops.Runner");
        }
        ctx.requireGET();
        var procedures = executions.procedures.get(path[3]);
        if (procedures == null) {
            throw FopsException.notFound("no fops for instance " + path[3]);
        }
        var sha = path[4];
        pool.execute(() -> {
            byte[] data;
            try {
                data = procedures.blob(sha);
            } catch (RuntimeException e) {
                data = null;
            }
            var netty = ctx.getNettyChannelHandlerContext();
            var req = ctx.getNettyHttpRequest();
            if (data == null) {
                respond(netty, req, HttpResponseStatus.NOT_FOUND, "no such blob (changed meanwhile?)");
                return;
            }
            var resp = new DefaultFullHttpResponse(req.protocolVersion(), HttpResponseStatus.OK,
                    Unpooled.wrappedBuffer(data));
            resp.headers().set(HttpHeaderNames.CONTENT_TYPE, "application/octet-stream");
            HttpUtil.setContentLength(resp, data.length);
            ctx.sendResponse(resp);
        });
    }

    private static void respond(ChannelHandlerContext ctx, HttpRequest req, HttpResponseStatus status, String text) {
        var resp = new DefaultFullHttpResponse(req.protocolVersion(), status,
                Unpooled.copiedBuffer(text + "\n", java.nio.charset.StandardCharsets.UTF_8));
        resp.headers().set(HttpHeaderNames.CONTENT_TYPE, "text/plain; charset=utf-8");
        HttpUtil.setContentLength(resp, resp.content().readableBytes());
        ctx.writeAndFlush(resp);
    }
}
