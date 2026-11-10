package com.jaops.yamcs.fops;

import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import org.yamcs.InitException;
import org.yamcs.Spec;
import org.yamcs.YConfiguration;
import org.yamcs.YamcsServer;
import org.yamcs.security.AuthModule;
import org.yamcs.security.AuthenticationInfo;
import org.yamcs.security.AuthenticationToken;
import org.yamcs.security.AuthorizationInfo;
import org.yamcs.security.User;

/**
 * The service user of an instance ({@code serviceUser}): the Yamcs user that the procedures started by the timeline
 * run as, instead of the System user the timeline starts its activities as.
 * <p>
 * The service user never logs in, while Yamcs resolves an access token to a user of its user cache, which only a
 * login fills. So each such start logs the service user in, without a password, through {@link #AUTH}, an
 * authenticator added to the security store's modules: the security store then reads the user from its directory
 * (creating it if unknown), refuses it if it is not active, and gives it the roles and privileges of the other
 * modules (users.yaml, LDAP groups) and of the directory, as for an interactive login.
 */
final class ServiceUser {
    private static final long LOGIN_TIMEOUT_S = 30;

    /** The login of a service user, which only this plugin makes. */
    private record Token(String username) implements AuthenticationToken {
    }

    static final AuthModule AUTH = new AuthModule() {
        @Override
        public Spec getSpec() {
            return new Spec();
        }

        @Override
        public void init(YConfiguration args) throws InitException {
        }

        @Override
        public AuthenticationInfo getAuthenticationInfo(AuthenticationToken token) {
            return token instanceof Token t ? new AuthenticationInfo(this, t.username()) : null;
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

    private ServiceUser() {
    }

    /** Adds {@link #AUTH} to the security store's modules, last, so it sees no token of another module. */
    static void register() {
        var modules = YamcsServer.getServer().getSecurityStore().getAuthModules();
        if (!modules.contains(AUTH)) {
            modules.add(AUTH);
        }
    }

    static boolean isSystem(User user) {
        return user == YamcsServer.getServer().getSecurityStore().getSystemUser();
    }

    /** Logs the service user in: the user, with its current privileges. */
    static User login(String username) {
        var store = YamcsServer.getServer().getSecurityStore();
        try {
            store.login(new Token(username)).get(LOGIN_TIMEOUT_S, TimeUnit.SECONDS);
        } catch (ExecutionException e) {
            throw new IllegalArgumentException("service user " + username + " cannot log in: "
                    + e.getCause().getMessage());
        } catch (TimeoutException e) {
            throw new IllegalArgumentException("service user " + username + ": no login after "
                    + LOGIN_TIMEOUT_S + " s");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalArgumentException("service user " + username + ": login interrupted");
        }
        var user = store.getUserFromCache(username);
        if (user == null) {
            throw new IllegalArgumentException("service user " + username + " is not known after its login");
        }
        return user;
    }
}
