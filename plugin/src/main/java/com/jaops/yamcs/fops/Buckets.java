package com.jaops.yamcs.fops;

import java.io.IOException;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import org.yamcs.YamcsServer;
import org.yamcs.buckets.Bucket;
import org.yamcs.buckets.ObjectProperties;

/** Blocking access to the Yamcs buckets of fops, created when missing. */
final class Buckets {
    static final long TIMEOUT_S = 60;

    private Buckets() {
    }

    static Bucket get(String name) throws IOException {
        var bm = YamcsServer.getServer().getBucketManager();
        synchronized (Buckets.class) {
            var b = bm.getBucket(name);
            return b != null ? b : bm.createBucket(name);
        }
    }

    static List<ObjectProperties> list(Bucket b) throws IOException {
        return await(b.listObjectsAsync());
    }

    /** The object, or null if there is none. */
    static byte[] read(Bucket b, String name) throws IOException {
        return await(b.findObjectAsync(name)) == null ? null : await(b.getObjectAsync(name));
    }

    static void write(Bucket b, String name, String contentType, byte[] data) throws IOException {
        await(b.putObjectAsync(name, contentType, Map.of(), data));
    }

    static void delete(Bucket b, String name) throws IOException {
        await(b.deleteObjectAsync(name));
    }

    private static <T> T await(CompletableFuture<T> f) throws IOException {
        try {
            return f.get(TIMEOUT_S, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("interrupted", e);
        } catch (ExecutionException e) {
            throw e.getCause() instanceof IOException io ? io : new IOException(e.getCause());
        } catch (TimeoutException e) {
            throw new IOException("bucket timed out", e);
        }
    }
}
