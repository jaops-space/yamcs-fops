package com.jaops.yamcs.fops;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

import org.yamcs.Spec;
import org.yamcs.Spec.OptionType;
import org.yamcs.YConfiguration;

/** The {@code fops:} section of yamcs.yaml (docs/plugin-api.md). */
public class FopsConfig {
    public final String executable;
    public final String python;
    /** Absolute: the Yamcs dataDir resolved. */
    public final Path dataDir;
    public final int promptWarningDelay;
    public final int controllerGracePeriod;
    public final Map<String, InstanceConfig> instances;
    /** Workers run by runners (docs/remote-workers.md), not as child processes. */
    public final boolean remoteWorkers;
    /** --memory-limit of the local workers, e.g. "512M"; null: none. */
    public final String workerMemory;
    /** Seconds a runner may be disconnected before its executions crash. */
    public final int runnerGrace;
    /** Seconds for a runner to start a worker. */
    public final int runnerStartTimeout;

    public static class InstanceConfig {
        public final String name;
        /** The Yamcs bucket of the procedures. */
        public final String procedureBucket;
        /** The Yamcs bucket of the as-run journals and worker logs of the ended executions. */
        public final String asrunBucket;
        public final String processor;
        public final Long traceLimit;
        /** The Yamcs user the procedures started by the timeline run as; null: none, they are refused. */
        public final String serviceUser;
        /** The package of the bucket generated from the MDB (fops mdb-gen), kept up to date; null: not kept. */
        public final String mdbPackage;

        public InstanceConfig(String name, String procedureBucket, String asrunBucket, String processor,
                Long traceLimit, String serviceUser, String mdbPackage) {
            this.name = name;
            this.procedureBucket = procedureBucket;
            this.asrunBucket = asrunBucket;
            this.processor = processor;
            this.traceLimit = traceLimit;
            this.serviceUser = serviceUser;
            this.mdbPackage = mdbPackage;
        }
    }

    public FopsConfig(String executable, String python, Path dataDir, int promptWarningDelay,
            int controllerGracePeriod, Map<String, InstanceConfig> instances, boolean remoteWorkers,
            String workerMemory, int runnerGrace, int runnerStartTimeout) {
        this.executable = executable;
        this.python = python;
        this.dataDir = dataDir;
        this.promptWarningDelay = promptWarningDelay;
        this.controllerGracePeriod = controllerGracePeriod;
        this.instances = instances;
        this.remoteWorkers = remoteWorkers;
        this.workerMemory = workerMemory;
        this.runnerGrace = runnerGrace;
        this.runnerStartTimeout = runnerStartTimeout;
    }

    static Spec spec() {
        var instanceSpec = new Spec();
        // default: fops-procedures-<instance> and fops-asrun-<instance>
        instanceSpec.addOption("procedureBucket", OptionType.STRING);
        instanceSpec.addOption("asrunBucket", OptionType.STRING);
        instanceSpec.addOption("processor", OptionType.STRING).withDefault("realtime");
        // 0 or less: unlimited
        instanceSpec.addOption("traceLimit", OptionType.INTEGER).withDefault(100);
        // default: the top-level serviceUser
        instanceSpec.addOption("serviceUser", OptionType.STRING);
        // empty: the generated MDB package is not kept up to date
        instanceSpec.addOption("mdbPackage", OptionType.STRING).withDefault("mdb");

        var spec = new Spec();
        spec.addOption("executable", OptionType.STRING).withDefault("fops");
        spec.addOption("python", OptionType.STRING);
        spec.addOption("dataDir", OptionType.STRING).withDefault("fops");
        spec.addOption("promptWarningDelay", OptionType.INTEGER).withDefault(60);
        spec.addOption("controllerGracePeriod", OptionType.INTEGER).withDefault(10);
        spec.addOption("serviceUser", OptionType.STRING);
        spec.addOption("instances", OptionType.MAP).withSpec(Spec.ANY);
        spec.addOption("workers", OptionType.STRING).withChoices("local", "remote").withDefault("local");
        spec.addOption("workerMemory", OptionType.STRING);
        spec.addOption("runnerGrace", OptionType.INTEGER).withDefault(30);
        spec.addOption("runnerStartTimeout", OptionType.INTEGER).withDefault(20);
        return spec;
    }

    static FopsConfig from(YConfiguration c, Path yamcsDataDir) {
        var instances = new LinkedHashMap<String, InstanceConfig>();
        var serviceUser = c.containsKey("serviceUser") ? c.getString("serviceUser") : null;
        if (c.containsKey("instances")) {
            var ic = c.getConfig("instances");
            for (var name : ic.getKeys()) {
                var i = ic.getConfig(name);
                var limit = i.getLong("traceLimit", 100);
                instances.put(name, new InstanceConfig(name,
                        i.getString("procedureBucket", "fops-procedures-" + name),
                        i.getString("asrunBucket", "fops-asrun-" + name),
                        i.getString("processor", "realtime"),
                        limit > 0 ? limit : null,
                        i.containsKey("serviceUser") ? i.getString("serviceUser") : serviceUser,
                        i.getString("mdbPackage", "mdb").isEmpty() ? null : i.getString("mdbPackage", "mdb")));
            }
        }
        return new FopsConfig(executable(c.getString("executable", "fops")),
                c.containsKey("python") ? c.getString("python") : null,
                yamcsDataDir.resolve(c.getString("dataDir", "fops")).toAbsolutePath().normalize(),
                c.getInt("promptWarningDelay", 60),
                c.getInt("controllerGracePeriod", 10),
                instances,
                "remote".equals(c.getString("workers", "local")),
                c.containsKey("workerMemory") ? c.getString("workerMemory") : null,
                c.getInt("runnerGrace", 30),
                c.getInt("runnerStartTimeout", 20));
    }

    /**
     * A relative path is resolved against the Yamcs working directory, since the workers run in their
     * procedure directory; a bare name is left to the PATH lookup.
     */
    static String executable(String e) {
        var p = Path.of(e);
        if (p.isAbsolute() || p.getNameCount() == 1) {
            return e;
        }
        return p.toAbsolutePath().normalize().toString();
    }
}
