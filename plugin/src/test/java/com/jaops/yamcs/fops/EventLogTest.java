package com.jaops.yamcs.fops;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import com.google.gson.JsonObject;

class EventLogTest {
    ScheduledExecutorService timer;
    EventLog log;
    List<Long> applied = new ArrayList<>();
    ArrayBlockingQueue<JsonObject> answers = new ArrayBlockingQueue<>(10);

    @BeforeEach
    void setUp() {
        timer = Executors.newSingleThreadScheduledExecutor();
        log = new EventLog(5, 50, timer);
    }

    @AfterEach
    void tearDown() {
        timer.shutdownNow();
    }

    JsonObject snapshot() {
        var o = new JsonObject();
        o.addProperty("seq", log.seq());
        return o;
    }

    void add(String type) {
        var ev = new JsonObject();
        ev.addProperty("type", type);
        log.append(ev, e -> applied.add(e.get("seq").getAsLong()));
    }

    Runnable poll(long after, long timeoutMs) {
        return log.poll(after, timeoutMs, this::snapshot, answers::add);
    }

    JsonObject answer(long ms) throws InterruptedException {
        return answers.poll(ms, TimeUnit.MILLISECONDS);
    }

    static List<String> types(JsonObject answer) {
        var out = new ArrayList<String>();
        answer.getAsJsonArray("events").forEach(e -> out.add(e.getAsJsonObject().get("type").getAsString()));
        return out;
    }

    @Test
    void numbersAndAppliesEvents() {
        add("log");
        add("log");
        assertEquals(List.of(1L, 2L), applied);
        assertEquals(2, log.seq());
    }

    @Test
    void afterZeroIsASnapshot() throws InterruptedException {
        add("log");
        poll(0, 1000);
        var a = answer(100);
        assertEquals(1, a.get("seq").getAsLong());
        assertTrue(a.has("snapshot"));
    }

    @Test
    void eventsAfterAreReturnedAtOnce() throws InterruptedException {
        add("log");
        add("step");
        add("log");
        poll(1, 1000);
        var a = answer(100);
        assertNotNull(a);
        assertEquals(3, a.get("seq").getAsLong());
        assertEquals(List.of("step", "log"), types(a));
    }

    @Test
    void lineEventsAreCoalesced() throws InterruptedException {
        add("log");
        add("line");
        add("line");
        add("suppressed");
        add("line");
        poll(1, 1000);
        var a = answer(100);
        assertEquals(List.of("suppressed", "line"), types(a));
        assertEquals(5, a.getAsJsonArray("events").get(1).getAsJsonObject().get("seq").getAsLong());
    }

    @Test
    void longPollWaitsForTheNextEvent() throws InterruptedException {
        add("log");
        poll(1, 5000);
        assertNull(answer(100));
        assertEquals(1, log.waiting());
        add("prompt");
        var a = answer(100);
        assertEquals(List.of("prompt"), types(a));
        assertEquals(0, log.waiting());
    }

    @Test
    void lineOnlyAnswersAreDelayed() throws InterruptedException {
        add("log");
        poll(1, 5000);
        add("line");
        add("line");
        var a = answer(1000);
        assertEquals(List.of("line"), types(a));
        assertEquals(3, a.get("seq").getAsLong());
    }

    @Test
    void timeoutAnswersWithNoEvents() throws InterruptedException {
        add("log");
        poll(1, 100);
        var a = answer(1000);
        assertEquals(0, a.getAsJsonArray("events").size());
        assertEquals(1, a.get("seq").getAsLong());
    }

    @Test
    void tooOldIsASnapshot() throws InterruptedException {
        for (int i = 0; i < 10; i++) {
            add("log");
        }
        poll(2, 1000); // the buffer holds 6..10
        assertTrue(answer(100).has("snapshot"));
        poll(5, 1000); // just in time: 6..10 follow
        var a = answer(100);
        assertFalse(a.has("snapshot"));
        assertEquals(5, a.getAsJsonArray("events").size());
    }

    @Test
    void newerThanLatestIsASnapshot() throws InterruptedException {
        add("log");
        poll(42, 1000);
        assertTrue(answer(100).has("snapshot"));
    }

    @Test
    void cancelledPollsAreNotAnswered() throws InterruptedException {
        add("log");
        var cancel = poll(1, 5000);
        cancel.run();
        add("log");
        assertNull(answer(200));
        assertEquals(0, log.waiting());
    }

    @Test
    void severalPollsAreAnswered() throws InterruptedException {
        add("log");
        poll(1, 5000);
        poll(1, 5000);
        add("log");
        assertNotNull(answer(100));
        assertNotNull(answer(100));
    }
}
