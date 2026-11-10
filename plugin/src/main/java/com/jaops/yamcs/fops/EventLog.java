package com.jaops.yamcs.fops;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.Supplier;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

/**
 * The events of one execution, numbered from 1, the latest {@code capacity} of them kept, and the long polls waiting
 * for them ({@code GET .../events?after=SEQ}).
 * <p>
 * A poll is answered at once if there are events after SEQ, else at the first new event or at its timeout (then with
 * no events). Line events are coalesced: an answer holds only the latest line event (all others are kept), and a poll
 * that would be answered with line events only waits {@code lineDelayMs} more for others, so a tight loop answers
 * about 20 polls a second, not one per line. A poll after 0, or after a SEQ older than the buffer (or newer than the
 * latest, from another server's life), is answered with a snapshot.
 * <p>
 * The lock of this object is the execution's lock: {@link #append} applies the event to the state under it, and the
 * snapshot is taken under it, so a snapshot and its seq agree.
 */
public class EventLog {
    private final int capacity;
    private final long lineDelayMs;
    private final ScheduledExecutorService timer;
    private final ArrayDeque<JsonObject> buffer = new ArrayDeque<>();
    private final List<Poll> polls = new ArrayList<>();
    private long seq;

    public EventLog(int capacity, long lineDelayMs, ScheduledExecutorService timer) {
        this.capacity = capacity;
        this.lineDelayMs = lineDelayMs;
        this.timer = timer;
    }

    /** Continues the numbering after {@code seq} (an execution restored with no events). */
    public synchronized void startAfter(long seq) {
        if (buffer.isEmpty()) {
            this.seq = seq;
        }
    }

    public synchronized long seq() {
        return seq;
    }

    /**
     * Numbers the event (its {@code seq}), passes it to {@code apply} and keeps it, all under the lock; then answers
     * the polls it completes.
     */
    public void append(JsonObject ev, Consumer<JsonObject> apply) {
        List<Poll> ready = new ArrayList<>();
        synchronized (this) {
            seq++;
            ev.addProperty("seq", seq);
            apply.accept(ev);
            if (buffer.size() == capacity) {
                buffer.removeFirst();
            }
            buffer.addLast(ev);
            var isLine = isLine(ev);
            for (var it = polls.iterator(); it.hasNext();) {
                var p = it.next();
                if (!isLine) {
                    it.remove();
                    ready.add(p);
                } else if (p.lineTimer == null) {
                    p.lineTimer = timer.schedule(() -> complete(p), lineDelayMs, TimeUnit.MILLISECONDS);
                }
            }
        }
        ready.forEach(this::complete);
    }

    /**
     * Polls for the events after {@code after}: {@code respond} gets {@code {seq, events}} or {@code {seq, snapshot}}
     * exactly once (unless cancelled), now or later, from this thread or the timer's.
     *
     * @param snapshot
     *            the execution's State, called under the lock
     * @return cancels the poll (the client went away); it is not answered
     */
    public Runnable poll(long after, long timeoutMs, Supplier<JsonObject> snapshot, Consumer<JsonObject> respond) {
        var p = new Poll(after, snapshot, respond);
        synchronized (this) {
            var first = buffer.isEmpty() ? seq + 1 : buffer.getFirst().get("seq").getAsLong();
            if (after <= 0 || after < first - 1 || after > seq) {
                p.done.set(true);
                var out = new JsonObject();
                out.addProperty("seq", seq);
                out.add("snapshot", snapshot.get());
                // outside the lock would be nicer, but the snapshot must be serialised under it anyway
                respondNow(respond, out);
                return () -> {
                };
            }
            if (after < seq) {
                if (hasNonLineAfter(after)) {
                    p.done.set(true);
                    respondNow(respond, eventsAfter(after));
                    return () -> {
                    };
                }
                p.lineTimer = timer.schedule(() -> complete(p), lineDelayMs, TimeUnit.MILLISECONDS);
            }
            polls.add(p);
            p.timeout = timer.schedule(() -> complete(p), timeoutMs, TimeUnit.MILLISECONDS);
        }
        return () -> {
            if (p.done.compareAndSet(false, true)) {
                cancelTimers(p);
                synchronized (this) {
                    polls.remove(p);
                }
            }
        };
    }

    private void respondNow(Consumer<JsonObject> respond, JsonObject out) {
        respond.accept(out);
    }

    private void complete(Poll p) {
        if (!p.done.compareAndSet(false, true)) {
            return;
        }
        cancelTimers(p);
        JsonObject out;
        synchronized (this) {
            polls.remove(p);
            var first = buffer.isEmpty() ? seq + 1 : buffer.getFirst().get("seq").getAsLong();
            if (p.after < first - 1) { // overrun while waiting
                out = new JsonObject();
                out.addProperty("seq", seq);
                out.add("snapshot", p.snapshot.get());
            } else {
                out = eventsAfter(p.after);
            }
        }
        p.respond.accept(out);
    }

    private static void cancelTimers(Poll p) {
        if (p.timeout != null) {
            p.timeout.cancel(false);
        }
        if (p.lineTimer != null) {
            p.lineTimer.cancel(false);
        }
    }

    private boolean hasNonLineAfter(long after) {
        for (var it = buffer.descendingIterator(); it.hasNext();) {
            var ev = it.next();
            if (ev.get("seq").getAsLong() <= after) {
                break;
            }
            if (!isLine(ev)) {
                return true;
            }
        }
        return false;
    }

    /** {@code {seq, events}}: the events after {@code after}, with only the latest line event. */
    private JsonObject eventsAfter(long after) {
        JsonObject lastLine = null;
        for (var it = buffer.descendingIterator(); it.hasNext();) {
            var ev = it.next();
            if (ev.get("seq").getAsLong() <= after) {
                break;
            }
            if (isLine(ev)) {
                lastLine = ev;
                break;
            }
        }
        var events = new JsonArray();
        for (var ev : buffer) {
            if (ev.get("seq").getAsLong() > after && (!isLine(ev) || ev == lastLine)) {
                events.add(ev);
            }
        }
        var out = new JsonObject();
        out.addProperty("seq", seq);
        out.add("events", events);
        return out;
    }

    private static boolean isLine(JsonObject ev) {
        var t = ev.get("type");
        return t != null && "line".equals(t.getAsString());
    }

    /** Number of polls waiting (for tests). */
    synchronized int waiting() {
        return polls.size();
    }

    private static class Poll {
        final long after;
        final Supplier<JsonObject> snapshot;
        final Consumer<JsonObject> respond;
        final AtomicBoolean done = new AtomicBoolean();
        ScheduledFuture<?> timeout;
        ScheduledFuture<?> lineTimer;

        Poll(long after, Supplier<JsonObject> snapshot, Consumer<JsonObject> respond) {
            this.after = after;
            this.snapshot = snapshot;
            this.respond = respond;
        }
    }
}
