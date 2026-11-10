package com.jaops.yamcs.fops;

import java.util.ArrayList;
import java.util.List;

import org.yamcs.utils.parser.ParseException;
import org.yamcs.yarch.DataType;
import org.yamcs.yarch.Stream;
import org.yamcs.yarch.Tuple;
import org.yamcs.yarch.TupleDefinition;
import org.yamcs.yarch.YarchDatabase;
import org.yamcs.yarch.YarchDatabaseInstance;
import org.yamcs.yarch.query.Query;
import org.yamcs.yarch.streamsql.StreamSqlException;

/**
 * The executions of an instance in its Yamcs database: the table {@code fops_executions}, one row per execution
 * (upserted through the stream {@code fops_executions_in}).
 * <p>
 * The JSON columns: {@code request} (the StartRequest, for restart), {@code summary} (the Summary, kept up to date
 * while it runs) and {@code state} (the State, once ended). The other columns repeat summary fields for queries.
 */
class ExecutionDb {
    static final String TABLE = "fops_executions";
    static final String STREAM = "fops_executions_in";
    static final TupleDefinition TDEF = new TupleDefinition();
    static {
        TDEF.addColumn("id", DataType.LONG);
        for (var c : new String[] { "procedure", "status", "started", "ended", "startedBy", "origin", "asrun",
                "request", "summary", "state" }) {
            TDEF.addColumn(c, DataType.STRING);
        }
    }

    /** One row; {@code ended} and {@code state} may be null. */
    record Row(long id, String procedure, String status, String started, String ended, String startedBy,
            String origin, String asrun, String request, String summary, String state) {
    }

    private final YarchDatabaseInstance ydb;
    private final Stream stream;

    ExecutionDb(String instance) throws StreamSqlException, ParseException {
        ydb = YarchDatabase.getInstance(instance);
        if (ydb.getTable(TABLE) == null) {
            ydb.execute(Query.createTable(TABLE, TDEF).primaryKey("id").toStatement());
        }
        if (ydb.getStream(STREAM) == null) {
            ydb.execute(Query.createStream(STREAM, TDEF).toStatement());
            ydb.execute(Query.upsertIntoTable(TABLE).query(Query.selectStream(STREAM).toSQL()).toStatement());
        }
        stream = ydb.getStream(STREAM);
    }

    void save(Row r) {
        stream.emitTuple(new Tuple(TDEF, new Object[] { r.id, r.procedure, r.status, r.started, r.ended,
                r.startedBy, r.origin, r.asrun, r.request, r.summary, r.state }));
    }

    List<Row> load() {
        var rows = new ArrayList<Row>();
        var result = ydb.executeUnchecked(Query.selectTable(TABLE).toStatement());
        try {
            while (result.hasNext()) {
                var t = result.next();
                rows.add(new Row(t.getLongColumn("id"), str(t, "procedure"), str(t, "status"), str(t, "started"),
                        str(t, "ended"), str(t, "startedBy"), str(t, "origin"), str(t, "asrun"), str(t, "request"),
                        str(t, "summary"), str(t, "state")));
            }
        } finally {
            result.close();
        }
        return rows;
    }

    /** A null column is not stored: absent from the tuple read back. */
    private static String str(Tuple t, String column) {
        return t.hasColumn(column) ? t.getColumn(column) : null;
    }
}
