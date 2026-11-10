package com.jaops.yamcs.fops;

import java.io.IOException;
import java.io.InputStream;
import java.net.URISyntaxException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.zip.ZipInputStream;

import org.yamcs.Plugin;
import org.yamcs.PluginException;
import org.yamcs.Spec;
import org.yamcs.YConfiguration;
import org.yamcs.YamcsServer;
import org.yamcs.YamcsServerInstance;
import org.yamcs.http.HttpServer;
import org.yamcs.logging.Log;
import org.yamcs.management.ManagementListener;
import org.yamcs.management.ManagementService;
import org.yamcs.protobuf.YamcsInstance.InstanceState;
import org.yamcs.security.SystemPrivilege;

/**
 * The fops plugin ({@code yamcs-fops}): the HTTP API under {@code /fops/api/{instance}/}, the executions of the
 * {@code fops run} workers, and the Yamcs-web extension.
 * <p>
 * Its configuration is the {@code fops:} section of yamcs.yaml (docs/plugin-api.md). Yamcs names a plugin's section
 * after the plugin, {@code yamcs-fops:}, which must stay the plugin's name for Yamcs-web to create the
 * {@code <yamcs-fops>} element; so the plugin registers the {@code fops} section itself and reads that.
 */
public class FopsPlugin implements Plugin {
    private static final Log log = new Log(FopsPlugin.class);
    public static final String CONFIG_SECTION = "fops";
    public static final String NAME = "yamcs-fops";

    public static final SystemPrivilege MONITOR = new SystemPrivilege("fops.Monitor");
    public static final SystemPrivilege START = new SystemPrivilege("fops.Start");
    public static final SystemPrivilege CONTROL = new SystemPrivilege("fops.Control");
    public static final SystemPrivilege SHELL = new SystemPrivilege("fops.Shell");
    public static final SystemPrivilege KILL = new SystemPrivilege("fops.Kill");
    /** Of the runners' accounts (docs/remote-workers.md). */
    public static final SystemPrivilege RUNNER = new SystemPrivilege("fops.Runner");
    static final List<SystemPrivilege> PRIVILEGES = List.of(MONITOR, START, CONTROL, SHELL, KILL, RUNNER);

    private volatile Executions executions;

    @Override
    public Spec getSpec() {
        YamcsServer.getServer().addConfigurationSection(CONFIG_SECTION, FopsConfig.spec());
        return new Spec();
    }

    @Override
    public void onLoad(YConfiguration pluginConfig) throws PluginException {
        var yamcs = YamcsServer.getServer();
        var httpServer = yamcs.getGlobalService(HttpServer.class);
        if (httpServer == null) {
            throw new PluginException("the fops plugin needs the HttpServer service");
        }
        PRIVILEGES.forEach(yamcs.getSecurityStore()::addSystemPrivilege);
        if (yamcs.getSecurityStore().isEnabled()) {
            ServiceUser.register();
        }

        var config = FopsConfig.from(yamcs.getConfig().getConfigOrEmpty(CONFIG_SECTION),
                yamcs.getDataDirectory());
        try {
            Files.createDirectories(config.dataDir);
        } catch (IOException e) {
            throw new PluginException("cannot create " + config.dataDir, e);
        }

        var timer = Executors.newScheduledThreadPool(2, threads("fops-timer"));
        var pool = Executors.newCachedThreadPool(threads("fops-http"));
        executions = new Executions(config, timer, pool);
        var meta = yamcs.getPluginManager().getMetadata(getClass());
        var version = meta == null ? "unknown" : meta.getVersion();
        var handler = new FopsHandler(executions, pool, version);
        httpServer.addRoute("fops", () -> handler);
        if (executions.runners != null) {
            var runnerHandler = new RunnerHandler(executions.runners, executions, pool);
            httpServer.addRoute("fops-runner", () -> runnerHandler);
            log.info("fops {}: instances {}, workers on runners (at {}/fops-runner/connect)", version,
                    config.instances.keySet(), httpServer.getContextPath());
        } else {
            log.info("fops {}: instances {}, worker {}", version, config.instances.keySet(), config.executable);
        }
        config.instances.values().stream().filter(ic -> ic.serviceUser != null).forEach(ic -> log.info(
                "fops: the timeline's procedures of {} run as {}", ic.name, ic.serviceUser));
        keepMdbPackages(new MdbPackage(executions), pool);

        deployWebExtension(config.dataDir.resolve("web"));
    }

    /**
     * Regenerates the MDB packages once Yamcs is ready (its HTTP server answers), and that of an instance restarted
     * afterwards, which reloads its MDB.
     */
    private static void keepMdbPackages(MdbPackage mdb, java.util.concurrent.ExecutorService pool) {
        var ready = new java.util.concurrent.atomic.AtomicBoolean();
        YamcsServer.getServer().addReadyListener(() -> pool.execute(() -> {
            ready.set(true);
            YamcsServer.getInstances().forEach(i -> mdb.update(i.getName()));
        }));
        ManagementService.getInstance().addManagementListener(new ManagementListener() {
            @Override
            public void instanceStateChanged(YamcsServerInstance i) {
                if (ready.get() && i.state() == InstanceState.RUNNING) {
                    pool.execute(() -> mdb.update(i.getName()));
                }
            }
        });
    }

    /** The executions of all instances; null until the plugin is loaded. */
    Executions executions() {
        return executions;
    }

    private static ThreadFactory threads(String name) {
        var n = new AtomicInteger();
        return r -> {
            var t = new Thread(r, name + "-" + n.incrementAndGet());
            t.setDaemon(true);
            return t;
        };
    }

    /**
     * Extracts the UI (fops-web/ in the jar) and adds it to Yamcs-web; nothing if the jar has none. The directory must
     * not change afterwards: in Yamcs 5.14, Yamcs-web's redeployer then fails (it copies from a null source when
     * Yamcs-web comes from the classpath) and every web page answers 404.
     */
    private void deployWebExtension(Path dir) throws PluginException {
        try {
            if (Files.exists(dir)) {
                try (var walk = Files.walk(dir)) {
                    walk.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
                }
            }
            Files.createDirectories(dir);
            var n = extract(dir);
            if (n == 0) {
                log.info("fops: no web UI in the plugin (built without ../web/dist)");
                return;
            }
            if (addWebExtension(dir)) {
                log.info("fops: web UI ({} files) deployed from {}", n, dir);
            }
        } catch (IOException | URISyntaxException e) {
            throw new PluginException("cannot deploy the fops web UI", e);
        }
    }

    /** Adds the UI in dir to Yamcs-web; false without Yamcs-web. */
    private static boolean addWebExtension(Path dir) {
        Class<?> webPluginClass;
        try {
            webPluginClass = Class.forName("org.yamcs.web.WebPlugin");
        } catch (ClassNotFoundException e) {
            log.info("fops: no Yamcs-web, the web UI is not deployed");
            return false;
        }
        return addExtension(webPluginClass, dir);
    }

    @SuppressWarnings("unchecked")
    private static boolean addExtension(Class<?> webPluginClass, Path dir) {
        var plugin = YamcsServer.getServer().getPluginManager()
                .getPlugin((Class<? extends Plugin>) webPluginClass);
        if (plugin == null) {
            log.info("fops: Yamcs-web is disabled, the web UI is not deployed");
            return false;
        }
        ((org.yamcs.web.WebPlugin) plugin).addExtension(NAME, Map.of(), dir);
        log.info("fops: web UI from {}", dir);
        return true;
    }

    /** Copies fops-web/ of the plugin's jar (or classes directory) to dir; the number of files. */
    private int extract(Path dir) throws IOException, URISyntaxException {
        var location = getClass().getProtectionDomain().getCodeSource().getLocation().toURI();
        var source = Path.of(location);
        int n = 0;
        if (Files.isDirectory(source)) {
            var web = source.resolve("fops-web");
            if (!Files.isDirectory(web)) {
                return 0;
            }
            try (var walk = Files.walk(web)) {
                for (var p : (Iterable<Path>) walk::iterator) {
                    var target = dir.resolve(web.relativize(p).toString());
                    if (Files.isDirectory(p)) {
                        Files.createDirectories(target);
                    } else {
                        Files.copy(p, target, StandardCopyOption.REPLACE_EXISTING);
                        n++;
                    }
                }
            }
            return n;
        }
        try (InputStream in = Files.newInputStream(source); var zip = new ZipInputStream(in)) {
            for (var entry = zip.getNextEntry(); entry != null; entry = zip.getNextEntry()) {
                var name = entry.getName();
                if (!name.startsWith("fops-web/") || name.equals("fops-web/")) {
                    continue;
                }
                var target = dir.resolve(name.substring("fops-web/".length())).normalize();
                if (!target.startsWith(dir)) {
                    continue;
                }
                if (entry.isDirectory()) {
                    Files.createDirectories(target);
                } else {
                    Files.createDirectories(target.getParent());
                    Files.copy(zip, target, StandardCopyOption.REPLACE_EXISTING);
                    n++;
                }
            }
        }
        return n;
    }
}
