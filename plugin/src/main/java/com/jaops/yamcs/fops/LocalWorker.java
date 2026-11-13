package com.jaops.yamcs.fops;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import org.yamcs.logging.Log;

import com.google.gson.JsonObject;

/** A worker run as a child process of Yamcs; its stderr goes to the execution's log file. */
class LocalWorker implements Worker {
    private static final Log log = new Log(LocalWorker.class);
    private final long id;
    private final List<String> command;
    private final Map<String, String> env;
    private final Path cwd;
    private final Path logFile;
    private Process process;
    private OutputStream stdin;
    /** The token control, until it is started. */
    private String token;

    LocalWorker(long id, List<String> command, Map<String, String> env, Path cwd, Path logFile) {
        this.id = id;
        this.command = command;
        this.env = env;
        this.cwd = cwd;
        this.logFile = logFile;
    }

    @Override
    public synchronized void start(Listener listener) throws IOException {
        var pb = new ProcessBuilder(command).directory(cwd.toFile())
                .redirectError(ProcessBuilder.Redirect.appendTo(logFile.toFile()));
        pb.environment().putAll(env);
        process = pb.start();
        stdin = process.getOutputStream();
        if (token != null) {
            send(token);
            token = null;
        }
        log.info("Execution {}: {} (pid {})", id, String.join(" ", command), process.pid());
        var reader = new Thread(() -> read(listener), "fops-" + id + "-stdout");
        reader.setDaemon(true);
        reader.start();
    }

    private void read(Listener listener) {
        try (var in = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = in.readLine()) != null) {
                listener.event(line);
            }
        } catch (IOException e) {
            log.warn("Execution {}: reading events: {}", id, e.getMessage());
        }
        int code;
        try {
            code = process.waitFor();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            code = -1;
        }
        listener.exited(code, null);
    }

    @Override
    public synchronized void send(String line) throws IOException {
        stdin.write((line + "\n").getBytes(StandardCharsets.UTF_8));
        stdin.flush();
    }

    @Override
    public synchronized void token(String jwt, String user) {
        var c = new JsonObject();
        c.addProperty("cmd", "token");
        c.addProperty("token", jwt);
        c.addProperty("user", user);
        if (stdin == null) {
            token = c.toString(); // goes first when it starts
            return;
        }
        try {
            send(c.toString());
        } catch (IOException e) {
            log.debug("Execution {}: token not sent: {}", id, e.getMessage());
        }
    }

    @Override
    public synchronized void closeInput() {
        try {
            stdin.close();
        } catch (IOException e) {
            log.debug("Execution {}: closing stdin: {}", id, e.getMessage());
        }
    }

    @Override
    public void kill() {
        process.destroyForcibly();
    }

    @Override
    public boolean isAlive() {
        return process != null && process.isAlive();
    }

    @Override
    public String describe() {
        return "pid " + (process == null ? "?" : process.pid());
    }
}
