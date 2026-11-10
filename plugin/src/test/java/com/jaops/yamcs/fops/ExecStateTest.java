package com.jaops.yamcs.fops;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

class ExecStateTest {
    long seq;

    ExecState state() {
        return new ExecState(7, "simulator", "battery_off.py", "2026-11-06T10:00:00.000Z", "user", "operator");
    }

    void apply(ExecState s, String json) {
        var ev = JsonParser.parseString(json).getAsJsonObject();
        ev.addProperty("seq", ++seq);
        s.apply(ev);
    }

    @Test
    void eventsKeepTheExecutionOfTheirLine() {
        var s = state();
        apply(s, "{\"type\":\"code\",\"code_id\":1,\"file\":\"x.py\",\"name\":\"<module>\",\"main\":true}");
        apply(s, "{\"type\":\"line\",\"code_id\":1,\"line\":2,\"n\":1}");
        apply(s, "{\"type\":\"verify\",\"ok\":false,\"line\":2}");
        apply(s, "{\"type\":\"line\",\"code_id\":1,\"line\":2,\"n\":2}");
        apply(s, "{\"type\":\"verify\",\"ok\":true,\"line\":2}");
        apply(s, "{\"type\":\"command\",\"seq\":1,\"stage\":\"sent\",\"name\":\"/X\",\"line\":2}");
        apply(s, "{\"type\":\"log\",\"message\":\"no line\"}");
        var log = s.log.toArray(new JsonObject[0]);
        assertEquals(1, log[0].get("ex").getAsInt());
        assertEquals(2, log[1].get("ex").getAsInt());
        assertFalse(log[2].has("ex"));
        assertEquals(2, s.commands.get(0).get("ex").getAsInt());
    }

    @Test
    void lifecycle() {
        var s = state();
        assertEquals("starting", s.status);
        apply(s, "{\"type\":\"started\",\"procedure\":\"battery_off.py\",\"trace_mode\":\"monitor\"}");
        assertEquals("running", s.status);
        assertEquals("running", s.activity());
        apply(s, "{\"type\":\"procedure\",\"name\":\"Battery off\",\"version\":\"1.0\"}");
        apply(s, "{\"type\":\"code\",\"code_id\":1,\"file\":\"x.py\",\"name\":\"<module>\",\"main\":true}");
        apply(s, "{\"type\":\"line\",\"code_id\":1,\"line\":3,\"n\":1}");
        apply(s, "{\"type\":\"line\",\"code_id\":1,\"line\":3,\"n\":2}");
        assertEquals(2L, s.hits.get("1:3"));
        apply(s, "{\"type\":\"suppressed\",\"code_id\":1,\"line\":3,\"n\":100}");
        assertTrue(s.suppressed.contains("1:3"));
        apply(s, "{\"type\":\"step\",\"index\":0,\"name\":\"Switch off\",\"execution\":\"executing\"}");
        apply(s, "{\"type\":\"log\",\"message\":\"switching off\",\"level\":\"info\"}");
        apply(s, "{\"type\":\"command\",\"seq\":1,\"stage\":\"sent\",\"name\":\"/X\",\"line\":4,\"time\":\"t\"}");

        var sum = s.summary();
        assertEquals("Battery off", sum.get("name").getAsString());
        assertEquals("1.0", sum.get("version").getAsString());
        assertEquals("switching off", sum.get("message").getAsString());
        assertEquals(1, sum.get("commands").getAsInt());
        assertEquals("Switch off", sum.getAsJsonObject("step").get("name").getAsString());
        assertEquals("user", sum.get("origin").getAsString());
        assertEquals("operator", sum.get("startedBy").getAsString());
        assertFalse(sum.has("ended"));

        apply(s, "{\"type\":\"step\",\"index\":0,\"name\":\"Switch off\",\"execution\":\"completed\"}");
        apply(s, "{\"type\":\"finished\",\"status\":\"finished\",\"message\":\"\",\"elapsed_ms\":5,"
                + "\"stats\":{},\"time\":\"2026-11-06T10:00:05.000Z\"}");
        assertEquals("finished", s.status);
        assertEquals("finished", s.activity());
        assertTrue(s.isEnded());
        var st = s.state();
        assertEquals("2026-11-06T10:00:05.000Z", st.get("ended").getAsString());
        assertEquals(seq, st.get("seq").getAsLong());
        assertEquals("completed", st.getAsJsonObject("steps").getAsJsonObject("0").get("execution").getAsString());
        assertEquals(1, st.getAsJsonArray("codes").size());
        assertEquals(3, st.getAsJsonArray("log").size()); // the two step events and the log
    }

    @Test
    void pausePromptAndWaiting() {
        var s = state();
        apply(s, "{\"type\":\"started\"}");
        apply(s, "{\"type\":\"wait\",\"seconds\":5}");
        assertEquals("waiting", s.activity());
        apply(s, "{\"type\":\"line\",\"code_id\":1,\"line\":9,\"n\":1}");
        assertEquals("running", s.activity());
        apply(s, "{\"type\":\"prompt\",\"id\":3,\"message\":\"Go?\",\"options\":[\"YES\",\"NO\"],\"line\":10}");
        assertEquals("prompt", s.activity());
        assertTrue(s.state().getAsJsonObject("prompts").has("3"));
        apply(s, "{\"type\":\"prompt_answered\",\"id\":3,\"answer\":\"YES\"}");
        assertEquals("running", s.activity());
        apply(s, "{\"type\":\"paused\",\"code_id\":1,\"line\":11,\"reason\":\"breakpoint\"}");
        assertEquals("paused", s.status);
        assertEquals("paused", s.activity());
        assertEquals(11, s.state().getAsJsonObject("current").get("line").getAsInt());
        apply(s, "{\"type\":\"resumed\",\"how\":\"resume\"}");
        assertEquals("running", s.status);
        apply(s, "{\"type\":\"prompt\",\"id\":4,\"message\":\"Again?\",\"options\":[],\"line\":12}");
        apply(s, "{\"type\":\"finished\",\"status\":\"aborted\",\"message\":\"by operator\"}");
        assertTrue(s.prompts.isEmpty());
        assertEquals("aborted", s.activity());
    }

    @Test
    void optionsVariablesAndControl() {
        var s = state();
        apply(s, "{\"type\":\"started\"}");
        assertEquals("running", s.activity());

        apply(s, "{\"type\":\"options\",\"by_step\":true,\"confirm_commands\":false}");
        var opts = s.state().getAsJsonObject("options");
        assertTrue(opts.get("byStep").getAsBoolean());
        assertFalse(opts.get("confirmCommands").getAsBoolean());

        apply(s, "{\"type\":\"variables\",\"request_id\":1,\"frame\":{\"function\":\"f\",\"line\":3},"
                + "\"locals\":{},\"globals\":{}}");
        assertEquals(1, s.state().getAsJsonObject("variables").get("request_id").getAsInt());

        apply(s, "{\"type\":\"control\",\"controller\":{\"user\":\"bob\",\"session\":\"s1\"},"
                + "\"monitors\":[\"alice\"],\"background\":false}");
        var sum = s.summary();
        assertEquals("bob", sum.getAsJsonObject("controller").get("user").getAsString());
        assertEquals("alice", sum.getAsJsonArray("monitors").get(0).getAsString());
        assertFalse(sum.get("background").getAsBoolean());
        apply(s, "{\"type\":\"control\",\"controller\":null,\"monitors\":[],\"background\":true}");
        sum = s.summary();
        assertTrue(sum.get("controller").isJsonNull());
        assertTrue(sum.get("background").getAsBoolean());
    }

    @Test
    void killed() {
        var s = state();
        apply(s, "{\"type\":\"started\"}");
        apply(s, "{\"type\":\"killed\",\"user\":\"bob\"}");
        apply(s, "{\"type\":\"finished\",\"status\":\"killed\",\"message\":\"killed by bob\"}");
        assertEquals("killed", s.status);
        assertEquals("killed", s.activity());
        assertTrue(s.isEnded());
    }

    @Test
    void logIsBounded() {
        var s = state();
        for (int i = 0; i < ExecState.LOG_CAP + 10; i++) {
            apply(s, "{\"type\":\"log\",\"message\":\"m" + i + "\"}");
        }
        assertEquals(ExecState.LOG_CAP, s.log.size());
        assertEquals("m10", s.log.getFirst().get("message").getAsString());
    }

    @Test
    void stepSummaryIsTheOneInProgress() {
        var s = state();
        apply(s, "{\"type\":\"step\",\"index\":0,\"name\":\"a\",\"execution\":\"executing\"}");
        apply(s, "{\"type\":\"step\",\"index\":1,\"name\":\"b\",\"execution\":\"completed\"}");
        JsonObject step = s.summary().getAsJsonObject("step");
        assertEquals("a", step.get("name").getAsString());
        assertTrue(step.has("confirmation"));
    }

    @Test
    void restoreEnded() {
        var s = state();
        apply(s, "{\"type\":\"started\"}");
        s.breakpoints.add(5L);
        apply(s, "{\"type\":\"finished\",\"status\":\"finished\",\"message\":\"Completed\"}");
        var r = ExecState.restore(s.summary(), s.state(), null);
        assertTrue(r.isEnded());
        assertEquals("finished", r.summary().get("status").getAsString());
        assertEquals(s.seq, r.seq);
        assertEquals(s.state().get("seq"), r.state().get("seq"));
        assertTrue(r.breakpoints.contains(5L));
        assertTrue(r.summary().get("controller").isJsonNull());
    }

    @Test
    void restoreInterrupted() {
        var s = state();
        apply(s, "{\"type\":\"started\"}");
        var r = ExecState.restore(s.summary(), null, "Yamcs stopped while it ran");
        assertTrue(r.isEnded());
        assertEquals("crashed", r.summary().get("status").getAsString());
        assertEquals("Yamcs stopped while it ran", r.state().getAsJsonObject("finished").get("message").getAsString());
        assertTrue(r.state().get("commands").isJsonArray());
        assertEquals(1, r.seq);
    }

    @Test
    void startRequestRoundTrip() {
        var body = JsonParser.parseString("{\"procedure\":\"a/b.py\",\"args\":{\"n\":3},\"traceLimit\":null,"
                + "\"breakpoints\":[4],\"options\":{\"byStep\":true},\"session\":\"s\"}")
                .getAsJsonObject();
        var r = StartRequest.parse(StartRequest.parse(body).toJson());
        assertEquals("a/b.py", r.procedure);
        assertEquals(3, r.args.get("n").getAsInt());
        assertTrue(r.traceLimitSet);
        assertEquals(null, r.traceLimit);
        assertEquals(java.util.List.of(4L), r.breakpoints);
        assertTrue(r.byStep);
        assertFalse(r.confirmCommands);
        assertEquals(null, r.session);
    }

    @Test
    void startRequestRefusesSchedule() {
        var body = JsonParser.parseString("{\"procedure\":\"a.py\",\"schedule\":{\"after\":20}}").getAsJsonObject();
        var e = assertThrows(FopsException.class, () -> StartRequest.parse(body));
        assertTrue(e.getMessage().contains("timeline"));
    }
}
