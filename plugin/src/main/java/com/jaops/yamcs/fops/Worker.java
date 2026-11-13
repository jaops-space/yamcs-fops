package com.jaops.yamcs.fops;

import java.io.IOException;

/**
 * The {@code fops run} process of an execution: a child process of Yamcs ({@link LocalWorker}) or one started by a
 * runner ({@link RemoteWorker}). Its stdin takes control lines, its stdout gives event lines.
 */
interface Worker {
    /** Where a worker's output goes, from the worker's own threads, in order. */
    interface Listener {
        /** A line of its stdout. */
        void event(String line);

        /** It exited; then nothing more comes. A reason replaces "worker exited with code ...". */
        void exited(int code, String reason);
    }

    /** Starts it; throws if it could not be started (then the listener is never called). */
    void start(Listener listener) throws IOException;

    /** A control line to its stdin; may block (the execution sends from its own thread). */
    void send(String line) throws IOException;

    /**
     * Its Yamcs access token, for {@code user}: a {@code token} control, sent ahead of the others when it starts
     * ({@code --yamcs-token-stdin}).
     */
    void token(String jwt, String user);

    /** Closes its stdin: a lingering worker exits, a running one aborts. */
    void closeInput();

    /** SIGKILL. */
    void kill();

    boolean isAlive();

    /** Its procedure has ended (it lingers for get_variables and eval until its input closes). */
    default void finished() {
    }

    /** For the log. */
    String describe();
}
