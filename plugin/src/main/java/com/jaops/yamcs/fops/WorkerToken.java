package com.jaops.yamcs.fops;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.GeneralSecurityException;
import java.util.ArrayDeque;
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

/**
 * The access token of a worker, for the user who started the execution: minted as Yamcs's {@code /auth/token} does
 * (an HS256 JWT with the server's secret, registered in the {@code TokenStore}), given to the worker (a {@link Sink}:
 * a file only the Yamcs user can read, or a message to its runner), and replaced at half its lifespan. The previous token stays valid until the next replacement, so a
 * worker reading the file just before is not refused; all are revoked when the execution ends.
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

    /** Where the tokens go. */
    interface Sink {
        void write(String token) throws IOException;

        /** The worker no longer needs tokens. */
        default void close() {
        }
    }

    /** A file only the Yamcs user can read, replaced atomically; deleted at the end. */
    static Sink file(Path file) {
        return new Sink() {
            @Override
            public void write(String jwt) throws IOException {
                var tmp = file.resolveSibling(file.getFileName() + ".tmp");
                Files.deleteIfExists(tmp);
                Files.createFile(tmp,
                        PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
                Files.writeString(tmp, jwt, StandardCharsets.US_ASCII);
                Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            }

            @Override
            public void close() {
                try {
                    Files.deleteIfExists(file);
                } catch (IOException e) {
                    log.warn("Could not delete {}: {}", file, e.getMessage());
                }
            }
        };
    }

    private final String username;
    private final Sink sink;
    private final ArrayDeque<String> tokens = new ArrayDeque<>();
    private ScheduledFuture<?> refresh;

    public WorkerToken(String username, Sink sink) {
        this.username = username;
        this.sink = sink;
    }

    public synchronized void start(ScheduledExecutorService timer) throws IOException {
        var yamcs = YamcsServer.getServer();
        long ttl = Math.max(10, yamcs.getSecurityStore().getAccessTokenLifespan() / 1000);
        write(ttl);
        long period = Math.max(5, ttl / 2);
        refresh = timer.scheduleAtFixedRate(() -> {
            try {
                write(ttl);
            } catch (IOException | RuntimeException e) {
                log.error("Could not renew the worker token of {}", username, e);
            }
        }, period, period, TimeUnit.SECONDS);
    }

    private synchronized void write(long ttl) throws IOException {
        var yamcs = YamcsServer.getServer();
        String jwt;
        try {
            jwt = JwtHelper.generateHS256Token("Yamcs", username, yamcs.getSecretKey(), (int) ttl);
        } catch (GeneralSecurityException e) {
            throw new IOException(e);
        }
        var tokenStore = yamcs.getGlobalService(HttpServer.class).getTokenStore();
        tokenStore.registerAccessToken(jwt, new AuthenticationInfo(WORKER_AUTH, username));
        sink.write(jwt);
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
        sink.close();
    }
}
