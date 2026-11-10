package com.jaops.yamcs.fops;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.yamcs.logging.Log;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import io.netty.channel.Channel;
import io.netty.channel.ChannelHandlerContext;
import io.netty.channel.SimpleChannelInboundHandler;
import io.netty.handler.codec.http.websocketx.CloseWebSocketFrame;
import io.netty.handler.codec.http.websocketx.PingWebSocketFrame;
import io.netty.handler.codec.http.websocketx.PongWebSocketFrame;
import io.netty.handler.codec.http.websocketx.TextWebSocketFrame;
import io.netty.handler.codec.http.websocketx.WebSocketFrame;
import io.netty.handler.timeout.IdleStateEvent;

/**
 * The WebSocket of one runner: JSON text frames, the first a {@code hello}. Its messages are handled in order, off the
 * event loop, on a thread of its own.
 */
class RunnerConnection extends SimpleChannelInboundHandler<WebSocketFrame> {
    private static final Log log = new Log(RunnerConnection.class);
    private final Runners runners;
    final String user;
    private final Channel channel;
    private final ExecutorService serial;
    volatile String name;
    volatile int capacity;
    private boolean hello;

    RunnerConnection(Runners runners, String user, Channel channel) {
        this.runners = runners;
        this.user = user;
        this.channel = channel;
        this.name = channel.remoteAddress().toString();
        serial = Executors.newSingleThreadExecutor(r -> {
            var t = new Thread(r, "fops-runner-" + channel.remoteAddress());
            t.setDaemon(true);
            return t;
        });
    }

    void send(JsonObject m) {
        channel.writeAndFlush(new TextWebSocketFrame(m.toString()));
    }

    @Override
    protected void channelRead0(ChannelHandlerContext ctx, WebSocketFrame frame) {
        if (frame instanceof PingWebSocketFrame) {
            ctx.writeAndFlush(new PongWebSocketFrame(frame.content().retain()));
            return;
        }
        if (frame instanceof CloseWebSocketFrame) {
            ctx.close();
            return;
        }
        if (!(frame instanceof TextWebSocketFrame)) {
            return;
        }
        var text = ((TextWebSocketFrame) frame).text();
        serial.execute(() -> handle(text));
    }

    private void handle(String text) {
        JsonObject m;
        try {
            m = JsonParser.parseString(text).getAsJsonObject();
        } catch (RuntimeException e) {
            log.warn("fops: runner {}: bad message {}", name, text.length() > 200 ? text.substring(0, 200) : text);
            return;
        }
        try {
            if (!hello) {
                if (!"hello".equals(ExecState.str(m, "type", ""))) {
                    log.warn("fops: runner {}: no hello, closing", name);
                    channel.close();
                    return;
                }
                hello = true;
                name = ExecState.str(m, "runner", name);
                capacity = (int) ExecState.num(m, "capacity", 1);
                log.info("fops: runner {} is fops {}", name, ExecState.str(m, "version", "?"));
                runners.connected(this);
                runners.hello(this, m);
                return;
            }
            runners.message(this, m);
        } catch (RuntimeException e) {
            log.error("fops: runner {}: handling {}", name, ExecState.str(m, "type", "?"), e);
        }
    }

    @Override
    public void userEventTriggered(ChannelHandlerContext ctx, Object evt) throws Exception {
        if (evt instanceof IdleStateEvent) {
            log.warn("fops: runner {} silent, closing", name);
            ctx.close();
            return;
        }
        super.userEventTriggered(ctx, evt);
    }

    @Override
    public void channelInactive(ChannelHandlerContext ctx) throws Exception {
        serial.execute(() -> {
            if (hello) {
                runners.disconnected(this);
            }
        });
        serial.shutdown();
        super.channelInactive(ctx);
    }

    @Override
    public void exceptionCaught(ChannelHandlerContext ctx, Throwable cause) {
        log.warn("fops: runner {}: {}", name, cause.toString());
        ctx.close();
    }
}
