package com.jaops.yamcs.fops;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.ArrayDeque;
import java.util.UUID;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;

import org.yamcs.InitException;
import org.yamcs.Spec;
import org.yamcs.YConfiguration;
import org.yamcs.YamcsServer;
import org.yamcs.http.HttpServer;
import org.yamcs.http.auth.JwtHelper;
import org.yamcs.logging.Log;
import org.yamcs.security.AuthModule;
import org.yamcs.security.AuthenticationException;
import org.yamcs.security.AuthenticationInfo;
import org.yamcs.security.AuthenticationToken;
import org.yamcs.security.AuthorizationInfo;

import com.google.gson.JsonObject;

/**
 * The access token of a worker, for the user it runs as: who started the execution, then whoever takes control of it.
 * Minted as Yamcs's {@code /auth/token} does (an HS256 JWT with the server's secret, registered in the
 * {@code TokenStore}), given to the worker through its control channel (a {@link Sink}), never written to a file, and
 * replaced at half its lifespan. The previous token stays valid until the next replacement, so a request sent just
 * before is not refused. When the user changes, the earlier user's tokens are revoked once the worker says it uses the
 * new one ({@code token_applied}), or after {@link #APPLY_TIMEOUT_S} if it does not; all are revoked when the worker
 * exits.
 */
public class WorkerToken {
    private static final Log log = new Log(WorkerToken.class);

    /**
     * The authenticator of the workers' tokens. It is not one of the security store's modules, so the store does not
     * re-verify the tokens against a directory (the user logged in when starting the execution).
     */
    static final AuthModule WORKER_AUTH = new AuthModule() {
        @Override
        public Spec getSpec() {
            return new Spec();
        }

        @Override
        public void init(YConfiguration args) throws InitException {
        }

        @Override
        public AuthenticationInfo getAuthenticationInfo(AuthenticationToken token) throws AuthenticationException {
            return null;
        }

        @Override
        public AuthorizationInfo getAuthorizationInfo(AuthenticationInfo authenticationInfo) {
            return new AuthorizationInfo();
        }

        @Override
        public boolean verifyValidity(AuthenticationInfo authenticationInfo) {
            return true;
        }
    };

    /** Where the tokens go: the worker. */
    interface Sink {
        void write(String token, String user) throws IOException;
    }

    /** How long the earlier user's tokens stay valid at most, waiting for {@code token_applied}. */
    static final long APPLY_TIMEOUT_S = 10;

    private String username;
    private final Sink sink;
    private long ttl;
    private ScheduledExecutorService timer;
    /** The earlier users' tokens, until the worker uses the current user's. */
    private final ArrayDeque<String> retiring = new ArrayDeque<>();
    private final ArrayDeque<String> tokens = new ArrayDeque<>();
    private ScheduledFuture<?> refresh;

    public WorkerToken(String username, Sink sink) {
        this.username = username;
        this.sink = sink;
    }

    public synchronized void start(ScheduledExecutorService timer) throws IOException {
        this.timer = timer;
        var yamcs = YamcsServer.getServer();
        ttl = Math.max(10, yamcs.getSecurityStore().getAccessTokenLifespan() / 1000);
        write();
        long period = Math.max(5, ttl / 2);
        refresh = timer.scheduleAtFixedRate(() -> {
            try {
                write();
            } catch (IOException | RuntimeException e) {
                log.error("Could not renew the worker token of {}", username, e);
            }
        }, period, period, TimeUnit.SECONDS);
    }

    public synchronized String user() {
        return username;
    }

    /**
     * Gives the worker a token for {@code user} from now on. The earlier user's tokens are revoked when the worker
     * says it uses the new one ({@link #applied}), so its requests are not refused meanwhile, or after
     * {@link #APPLY_TIMEOUT_S} (at once if the new one could not be sent): it must not keep acting as the earlier user.
     */
    public synchronized void setUser(String user) throws IOException {
        if (user.equals(username) || refresh == null || refresh.isCancelled()) {
            return;
        }
        username = user;
        retiring.addAll(tokens);
        tokens.clear();
        try {
            write();
        } catch (IOException | RuntimeException e) {
            revokeRetiring();
            throw e;
        }
        timer.schedule(this::revokeRetiring, APPLY_TIMEOUT_S, TimeUnit.SECONDS);
    }

    /** The worker's {@code token_applied}: it uses {@code user}'s token. */
    public synchronized void applied(String user) {
        if (user.equals(username)) {
            revokeRetiring();
        }
    }

    private synchronized void revokeRetiring() {
        if (retiring.isEmpty()) {
            return;
        }
        var httpServer = YamcsServer.getServer().getGlobalService(HttpServer.class);
        if (httpServer != null) {
            retiring.forEach(httpServer.getTokenStore()::revokeAccessToken);
        }
        retiring.clear();
    }

    private synchronized void write() throws IOException {
        var yamcs = YamcsServer.getServer();
        String jwt;
        try {
            // Yamcs's claims, plus a unique jti: without it, a token minted in the same second as the user's own
            // login token is the same string, and revoking ours would log the user out.
            var claims = new JsonObject();
            long now = System.currentTimeMillis() / 1000;
            claims.addProperty("iss", "Yamcs");
            claims.addProperty("sub", username);
            claims.addProperty("iat", now);
            claims.addProperty("exp", now + ttl);
            claims.addProperty("jti", UUID.randomUUID().toString());
            jwt = JwtHelper.generateHS256Token(claims, yamcs.getSecretKey());
        } catch (GeneralSecurityException e) {
            throw new IOException(e);
        }
        var tokenStore = yamcs.getGlobalService(HttpServer.class).getTokenStore();
        tokenStore.registerAccessToken(jwt, new AuthenticationInfo(WORKER_AUTH, username));
        sink.write(jwt, username);
        tokens.addLast(jwt);
        while (tokens.size() > 2) {
            tokenStore.revokeAccessToken(tokens.removeFirst());
        }
    }

    public synchronized void close() {
        if (refresh != null) {
            refresh.cancel(false);
        }
        var httpServer = YamcsServer.getServer().getGlobalService(HttpServer.class);
        if (httpServer != null) {
            tokens.forEach(httpServer.getTokenStore()::revokeAccessToken);
        }
        tokens.clear();
        revokeRetiring();
    }
}
