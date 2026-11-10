package com.jaops.yamcs.fops;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

import org.yamcs.YamcsServer;
import org.yamcs.http.HttpServer;
import org.yamcs.http.api.XtceToGpbAssembler;
import org.yamcs.http.api.XtceToGpbAssembler.DetailLevel;
import org.yamcs.logging.Log;
import org.yamcs.mdb.MdbFactory;

import com.google.protobuf.InvalidProtocolBufferException;
import com.google.protobuf.MessageOrBuilder;

/**
 * The package generated from the MDB of an instance ({@code mdbPackage}, {@code fops mdb-gen}) in its procedure
 * bucket, regenerated when its instance starts if the MDB changed: the MDB's parameters and commands, as the
 * {@code /api/mdb} listings give them to a user who may see all, go to {@code fops mdb-gen --mdb}, which writes the
 * package in a temporary directory, and the package replaces the bucket's if their fingerprints differ.
 */
final class MdbPackage {
    private static final Log log = new Log(MdbPackage.class);
    static final long TIMEOUT_S = 120;
    static final String CONTENT_TYPE = "text/x-python";
    private static final Pattern FINGERPRINT = Pattern.compile("(?m)^FINGERPRINT = '([^']*)'");

    private final Executions executions;

    MdbPackage(Executions executions) {
        this.executions = executions;
    }

    /** Brings the package of an instance up to date; problems are logged. */
    synchronized void update(String instance) {
        var config = executions.config;
        var ic = config.instances.get(instance);
        if (ic == null || ic.mdbPackage == null) {
            return;
        }
        if (executions.runners != null) {
            // fops is not on this host
            log.info("fops: the {} package of {} is not regenerated with remote workers", ic.mdbPackage, instance);
            return;
        }
        Path tmp = null;
        try {
            tmp = Files.createTempDirectory(config.dataDir, "mdb-gen");
            var mdbFile = tmp.resolve("mdb.json");
            Files.writeString(mdbFile, listings(instance), StandardCharsets.UTF_8);
            var out = tmp.resolve("out");
            var output = tmp.resolve("output.txt");
            var pb = new ProcessBuilder(config.executable, "mdb-gen", "--mdb", mdbFile.toString(), "--instance",
                    instance, "--out", out.toString(), "--package", ic.mdbPackage).directory(tmp.toFile())
                    .redirectErrorStream(true).redirectOutput(output.toFile())
                    .redirectInput(ProcessBuilder.Redirect.from(new java.io.File("/dev/null")));
            if (config.python != null) {
                pb.environment().put("FOPS_PYTHON", config.python);
            }
            var p = pb.start();
            if (!p.waitFor(TIMEOUT_S, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                log.warn("fops mdb-gen {}: timed out", instance);
                return;
            }
            if (p.exitValue() != 0) {
                log.warn("fops mdb-gen {} failed (exit {}): {}", instance, p.exitValue(),
                        Files.readString(output, StandardCharsets.UTF_8).strip());
                return;
            }
            replace(instance, ic.procedureBucket, ic.mdbPackage, out.resolve(ic.mdbPackage));
        } catch (IOException | RuntimeException e) {
            log.warn("fops: cannot regenerate the {} package of {}: {}", ic.mdbPackage, instance, e.toString());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            if (tmp != null) {
                delete(tmp);
            }
        }
    }

    /** {"parameters": [...], "commands": [...]}: what the detailed /api/mdb listings give, unfiltered. */
    static String listings(String instance) throws InvalidProtocolBufferException {
        var mdb = MdbFactory.getInstance(instance);
        var printer = YamcsServer.getServer().getGlobalService(HttpServer.class).getJsonPrinter();
        var params = mdb.getParameters().stream().map(p -> XtceToGpbAssembler.toParameterInfo(p, DetailLevel.FULL))
                .toList();
        var commands = mdb.getMetaCommands().stream()
                .map(c -> XtceToGpbAssembler.toCommandInfo(c, DetailLevel.FULL)).toList();
        return "{\"parameters\": " + array(printer, params) + ", \"commands\": " + array(printer, commands) + "}";
    }

    private static String array(com.google.protobuf.util.JsonFormat.Printer printer,
            List<? extends MessageOrBuilder> messages) throws InvalidProtocolBufferException {
        var sb = new StringBuilder("[");
        for (var m : messages) {
            if (sb.length() > 1) {
                sb.append(", ");
            }
            sb.append(printer.print(m));
        }
        return sb.append("]").toString();
    }

    /** Puts the generated package in the bucket unless the bucket has it with the same fingerprint. */
    private void replace(String instance, String bucket, String pkg, Path generated) throws IOException {
        var init = pkg + "/__init__.py";
        var fingerprint = fingerprint(Files.readAllBytes(generated.resolve("__init__.py")));
        var b = Buckets.get(bucket);
        var old = Buckets.read(b, init);
        var oldFingerprint = old == null ? null : fingerprint(old);
        if (fingerprint != null && fingerprint.equals(oldFingerprint)) {
            log.info("fops: the {} package of {} is up to date (MDB fingerprint {})", pkg, instance, fingerprint);
            return;
        }
        var files = new HashMap<String, byte[]>();
        try (var walk = Files.walk(generated)) {
            for (var f : (Iterable<Path>) walk::iterator) {
                if (Files.isRegularFile(f)) {
                    files.put(pkg + "/" + generated.relativize(f).toString().replace(java.io.File.separatorChar, '/'),
                            Files.readAllBytes(f));
                }
            }
        }
        // the root __init__.py, with the fingerprint, last: a package left incomplete is regenerated next time
        for (var e : files.entrySet()) {
            if (!e.getKey().equals(init)) {
                Buckets.write(b, e.getKey(), CONTENT_TYPE, e.getValue());
            }
        }
        for (var o : Buckets.list(b)) {
            var name = o.name();
            if (name.startsWith(pkg + "/") && !files.containsKey(name) && !name.contains("__pycache__/")
                    && !name.endsWith("/")) {
                Buckets.delete(b, name);
            }
        }
        Buckets.write(b, init, CONTENT_TYPE, files.get(init));
        executions.procedures.get(instance).invalidate();
        log.info("fops: the {} package of {} regenerated from its MDB ({} files, fingerprint {} -> {})", pkg,
                instance, files.size(), oldFingerprint == null ? "none" : oldFingerprint, fingerprint);
    }

    static String fingerprint(byte[] init) {
        var m = FINGERPRINT.matcher(new String(init, StandardCharsets.UTF_8));
        return m.find() ? m.group(1) : null;
    }

    private static void delete(Path dir) {
        try (var walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        } catch (IOException e) {
            log.warn("Could not delete {}: {}", dir, e.getMessage());
        }
    }
}
