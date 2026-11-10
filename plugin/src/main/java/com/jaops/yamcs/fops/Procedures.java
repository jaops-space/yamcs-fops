package com.jaops.yamcs.fops;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import org.yamcs.logging.Log;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

/**
 * The procedures of an instance, from its Yamcs bucket, and their {@code fops inspect} output (cached by modification
 * time).
 * <p>
 * The workers run from a copy of the bucket on disk (they import the bucket's packages, like the generated MDB), which
 * is brought up to date at most every {@link #SYNC_INTERVAL_MS} when procedures are listed, read or started. A file's
 * modification time is its object's creation time.
 */
public class Procedures {
    private static final Log log = new Log(Procedures.class);
    static final long INSPECT_TIMEOUT_S = 20;
    /** How long a listing waits for the inspections it needs. */
    static final long LIST_WAIT_MS = 5000;
    static final long SYNC_INTERVAL_MS = 2000;

    private final String instance;
    private final String bucket;
    private final Path root;
    private final FopsConfig config;
    private final ExecutorService pool;
    private final Map<Path, Inspected> cache = new ConcurrentHashMap<>();
    /** Workers and inspections on runners; null: local. */
    private final Runners runners;
    /** Under this: the SHA-256 of the files, by path, tagged "modified:size". */
    private final Map<String, String[]> hashes = new HashMap<>();
    /** Under this: the files of the last manifest, by SHA-256. */
    private final Map<String, String> bySha = new HashMap<>();
    /** Under this: the objects copied, as "created:size". */
    private final Map<String, String> copied = new HashMap<>();
    private long lastSync;

    private static class Inspected {
        final long modified;
        final Future<JsonElement> result;

        Inspected(long modified, Future<JsonElement> result) {
            this.modified = modified;
            this.result = result;
        }
    }

    /**
     * @param root
     *            the directory of the copy
     */
    public Procedures(String instance, String bucket, Path root, FopsConfig config, ExecutorService pool,
            Runners runners) {
        this.instance = instance;
        this.bucket = bucket;
        this.root = root;
        this.config = config;
        this.pool = pool;
        this.runners = runners;
    }

    /**
     * The tree the workers run in, up to date with the bucket, as {path: sha256}: what a runner needs to run a procedure
     * of this instance (it gets the files with {@link #blob}).
     */
    public synchronized JsonObject manifest() throws IOException {
        sync();
        var files = new java.util.TreeMap<String, String>();
        Files.createDirectories(root);
        try (var walk = Files.walk(root)) {
            for (var p : (Iterable<Path>) walk::iterator) {
                var name = name(p);
                if (!Files.isRegularFile(p) || name.contains("__pycache__/") || p.getFileName().toString()
                        .startsWith(".sync")) {
                    continue;
                }
                var tag = Files.getLastModifiedTime(p).toMillis() + ":" + Files.size(p);
                var h = hashes.get(name);
                if (h == null || !h[0].equals(tag)) {
                    h = new String[] { tag, sha256(Files.readAllBytes(p)) };
                    hashes.put(name, h);
                }
                files.put(name, h[1]);
            }
        }
        hashes.keySet().retainAll(files.keySet());
        bySha.clear();
        var o = new JsonObject();
        files.forEach((name, sha) -> {
            o.addProperty(name, sha);
            bySha.put(sha, name);
        });
        return o;
    }

    /** The content of a file of the last manifest, if it still has that hash; else null. */
    public byte[] blob(String sha) {
        String name;
        synchronized (this) {
            name = bySha.get(sha);
        }
        if (name == null) {
            return null;
        }
        try {
            var data = Files.readAllBytes(root.resolve(name));
            return sha256(data).equals(sha) ? data : null;
        } catch (IOException e) {
            return null;
        }
    }

    static String sha256(byte[] data) {
        try {
            return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(data));
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** The directory the workers run in. */
    public Path root() {
        return root;
    }

    /** Brings the copy up to date with the bucket, unless done in the last {@link #SYNC_INTERVAL_MS}. */
    public synchronized void sync() {
        var now = System.currentTimeMillis();
        if (now - lastSync < SYNC_INTERVAL_MS) {
            return;
        }
        lastSync = now;
        try {
            Files.createDirectories(root);
            var b = Buckets.get(bucket);
            var seen = new HashSet<String>();
            for (var o : Buckets.list(b)) {
                var name = o.name();
                if (name.endsWith("/") || !valid(name)) {
                    continue;
                }
                seen.add(name);
                var tag = o.created() + ":" + o.size();
                var file = root.resolve(name);
                if (tag.equals(copied.get(name)) && Files.isRegularFile(file)) {
                    continue;
                }
                var data = Buckets.read(b, name);
                if (data == null) {
                    continue; // deleted meanwhile
                }
                Files.createDirectories(file.getParent());
                var tmp = Files.createTempFile(file.getParent(), ".sync", ".tmp");
                Files.write(tmp, data);
                Files.setLastModifiedTime(tmp, FileTime.fromMillis(o.created()));
                Files.move(tmp, file, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
                copied.put(name, tag);
            }
            copied.keySet().retainAll(seen);
            try (var walk = Files.walk(root)) {
                for (var p : (Iterable<Path>) walk::iterator) {
                    if (Files.isRegularFile(p) && !seen.contains(name(p))) {
                        Files.delete(p);
                    }
                }
            }
        } catch (IOException | RuntimeException e) {
            log.warn("Cannot copy the procedures of bucket {}: {}", bucket, e.toString());
        }
    }

    /** After a change the inspections depend on, like the generated MDB: all are done again, on a fresh copy. */
    public synchronized void invalidate() {
        lastSync = 0;
        cache.clear();
    }

    private String name(Path p) {
        return root.relativize(p).toString().replace(java.io.File.separatorChar, '/');
    }

    private static boolean valid(String name) {
        if (name == null || name.isEmpty() || name.startsWith("/") || name.contains("\\")) {
            return false;
        }
        for (var part : name.split("/")) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) {
                return false;
            }
        }
        return true;
    }

    /** The file of a procedure path ("folder/x.py"), or null if there is none. */
    public Path resolve(String name) {
        if (!valid(name)) {
            return null;
        }
        sync();
        var p = root.resolve(name).normalize();
        return p.startsWith(root) && Files.isRegularFile(p) ? p : null;
    }

    /** [{path, name?, version?}], sorted by path. */
    public JsonArray list() {
        sync();
        var files = new ArrayList<String>();
        walk(root, files);
        files.sort(null);
        var deadline = System.currentTimeMillis() + LIST_WAIT_MS;
        var out = new JsonArray();
        for (var f : files) {
            var o = new JsonObject();
            o.addProperty("path", f);
            var info = inspect(root.resolve(f), Math.max(0, deadline - System.currentTimeMillis()));
            if (info != null && info.isJsonObject()) {
                var i = info.getAsJsonObject();
                copy(i, "name", o);
                copy(i, "version", o);
            }
            out.add(o);
        }
        return out;
    }

    private static void copy(JsonObject from, String field, JsonObject to) {
        if (from.has(field) && !from.get(field).isJsonNull()) {
            to.add(field, from.get(field));
        }
    }

    private void walk(Path dir, List<String> out) {
        try (var entries = Files.list(dir)) {
            for (var p : (Iterable<Path>) entries::iterator) {
                var n = p.getFileName().toString();
                if (n.startsWith("_") || n.startsWith(".")) {
                    continue;
                }
                if (Files.isDirectory(p)) {
                    // packages (like the generated MDB) hold no procedures
                    if (!Files.exists(p.resolve("__init__.py"))) {
                        walk(p, out);
                    }
                } else if (n.endsWith(".py")) {
                    out.add(name(p));
                }
            }
        } catch (IOException e) {
            log.warn("Cannot list {}: {}", dir, e.getMessage());
        }
    }

    /** {path, source, modified, inspect}. */
    public JsonObject get(String name) throws IOException {
        var file = resolve(name);
        if (file == null) {
            throw FopsException.notFound("no such procedure: " + name);
        }
        var o = new JsonObject();
        o.addProperty("path", name);
        o.addProperty("source", Files.readString(file, StandardCharsets.UTF_8));
        o.addProperty("modified", Files.getLastModifiedTime(file).toInstant().toString());
        var info = inspect(file, INSPECT_TIMEOUT_S * 1000);
        o.add("inspect", info == null ? JsonNull.INSTANCE : info);
        return o;
    }

    /** The inspection of a file, waiting at most waitMs for it; null if not (yet) available. */
    JsonElement inspect(Path file, long waitMs) {
        long modified;
        try {
            modified = Files.getLastModifiedTime(file).toMillis();
        } catch (IOException e) {
            return null;
        }
        var i = cache.compute(file, (k, old) -> old != null && old.modified == modified && !failed(old) ? old
                : new Inspected(modified, pool.submit(() -> runInspect(file))));
        try {
            return i.result.get(waitMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            return null;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    /** A finished inspection without result (e.g. a worker without inspect, since rebuilt) is retried. */
    private static boolean failed(Inspected i) {
        if (!i.result.isDone()) {
            return false;
        }
        try {
            var r = i.result.get();
            return r == null || r.isJsonNull();
        } catch (Exception e) {
            return true;
        }
    }

    private JsonElement runInspect(Path file) throws IOException, InterruptedException {
        if (runners != null) {
            // user code (the procedure's top level) runs on a runner too
            return runners.inspect(instance, manifest(), name(file), (INSPECT_TIMEOUT_S + 5) * 1000);
        }
        var tmp = Files.createTempFile("fops-inspect", ".json");
        String out;
        Process p;
        try {
            var pb = new ProcessBuilder(config.executable, "inspect", file.toString()).directory(root.toFile())
                    .redirectError(ProcessBuilder.Redirect.DISCARD)
                    .redirectInput(ProcessBuilder.Redirect.from(new java.io.File("/dev/null")))
                    .redirectOutput(tmp.toFile());
            if (config.python != null) {
                pb.environment().put("FOPS_PYTHON", config.python);
            }
            p = pb.start();
            if (!p.waitFor(INSPECT_TIMEOUT_S, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                log.warn("fops inspect {}: timed out", file);
                return JsonNull.INSTANCE;
            }
            out = Files.readString(tmp, StandardCharsets.UTF_8);
        } finally {
            Files.deleteIfExists(tmp);
        }
        try {
            return JsonParser.parseString(out.trim());
        } catch (RuntimeException e) {
            // an older worker without "fops inspect"
            log.debug("fops inspect {}: no JSON (exit {})", file, p.exitValue());
            return JsonNull.INSTANCE;
        }
    }
}
