// Tests of the parts that do not need VS Code: `npm test`.
import * as assert from 'assert';
import * as path from 'path';
import { importEdit, parseImports, resolve } from '../imports';
import { asString, findMdbPackages, loadMdb, parseArgs } from '../mdb';

const repo = path.resolve(__dirname, '..', '..', '..');
const tests: [string, () => void][] = [];
const test = (name: string, fn: () => void) => tests.push([name, fn]);

test('literals and arguments', () => {
    assert.strictEqual(asString("'it\\'s'"), "it's");
    assert.strictEqual(asString('"a \'b\'"'), "a 'b'");
    const { pos, kw } = parseArgs("'/A/b', 'enumeration', labels=('X', 'Y, Z'), units='%'");
    assert.deepStrictEqual(pos, ["'/A/b'", "'enumeration'"]);
    assert.strictEqual(kw.labels, "('X', 'Y, Z')");
});

test('the generated package of procedures/', () => {
    const [root] = findMdbPackages(repo);
    assert.strictEqual(root, path.join(repo, 'procedures', 'mdb'));
    const mdb = loadMdb(root)!;
    assert.strictEqual(mdb.instance, 'simulator');
    const code = mdb.item('mdb.PUS.tm', 'tc_ack_start_failure_code');
    assert.ok(code?.kind === 'param');
    assert.deepStrictEqual(code.labels, ['INVALID_PUS_SUBTYPE', 'NOT_IMPLEMENTED', 'INVALID_EVENT_ID', 'INVALID_VOLTAGE_NUM']);
    assert.strictEqual(code.qualifiedName, '/PUS/tc-ack-start-failure-code');
    const capacity = mdb.item('mdb.SIMULATOR.tm', 'BatteryCapacity1');
    assert.ok(capacity?.kind === 'param' && capacity.units === '%');
    const on = mdb.item('mdb.SIMULATOR.tc', 'SWITCH_VOLTAGE_ON');
    assert.ok(on?.kind === 'command');
    assert.deepStrictEqual(on.args.map(a => [a.name, a.default]),
        [['voltage_num', undefined], ['ackflags', '7'], ['source', '0']]);
    const onEnum = mdb.item('mdb.SIMULATOR.tc', 'SWITCH_VOLTAGE_ON_ENUM');
    assert.ok(onEnum?.kind === 'command');
    assert.deepStrictEqual(onEnum.args[0].labels, ['PRIMARY', 'SECONDARY', 'BACKUP']);
    assert.deepStrictEqual(on.verifiers, ['Accepted', 'Started', 'Complete']);
    const alive = mdb.item('mdb.PUS17.tc', 'ARE_YOU_ALIVE');
    assert.ok(alive?.kind === 'command');
    assert.deepStrictEqual(alive.verifiers, ['Accepted', 'Started', 'Complete', 'PUS17_Report']);
    const n = [...mdb.items()].length;
    assert.ok(n > 100, `${n} items`);
});

test('imports, aliases and resolution', () => {
    const mdb = loadMdb(path.join(repo, 'procedures', 'mdb'))!;
    const src = [
        '"""Doc', 'string."""',
        'from fops import procedure, send',
        'from mdb import SIMULATOR',
        'from mdb.PUS.tm import seqcount as count',
        'from mdb.SIMULATOR.tm import (BatteryVoltage1, BusVoltage,',
        '                              OrbitNumber)',
        'import mdb.SIMULATOR.tc as stc',
        '',
        'X = 1',
    ].join('\n');
    const imp = parseImports(src);
    assert.strictEqual(imp.bodyStart, 2);
    assert.strictEqual(imp.lastImportLine, 7);
    assert.strictEqual(resolve(mdb, imp, ['OrbitNumber'])?.qualifiedName, '/SIMULATOR/OrbitNumber');
    assert.strictEqual(resolve(mdb, imp, ['count'])?.qualifiedName, '/PUS/seqcount');
    assert.strictEqual(resolve(mdb, imp, ['SIMULATOR', 'tm', 'BusCurrent'])?.qualifiedName, '/SIMULATOR/BusCurrent');
    assert.strictEqual(resolve(mdb, imp, ['stc', 'SWITCH_VOLTAGE_OFF'])?.qualifiedName, '/SIMULATOR/SWITCH_VOLTAGE_OFF');
    assert.strictEqual(resolve(mdb, imp, ['send']), undefined);

    const lines = src.split('\n');
    // into the existing one-line import, sorted
    assert.deepStrictEqual(importEdit(imp, 'mdb.PUS.tm', 'apid', lines),
        { line: 4, endLine: 4, text: 'from mdb.PUS.tm import apid, seqcount as count' });
    // the parenthesized one is left alone: a new line, after the last module sorting before
    assert.deepStrictEqual(importEdit(imp, 'mdb.SIMULATOR.tm', 'BusCurrent', lines),
        { line: 7, endLine: 6, text: 'from mdb.SIMULATOR.tm import BusCurrent' });
    assert.deepStrictEqual(importEdit(imp, 'mdb.PUS17.tc', 'ARE_YOU_ALIVE', lines),
        { line: 5, endLine: 4, text: 'from mdb.PUS17.tc import ARE_YOU_ALIVE' });
    assert.strictEqual(importEdit(imp, 'mdb.SIMULATOR.tm', 'BusVoltage', lines), undefined);
    // no imports: after the docstring
    assert.deepStrictEqual(importEdit(parseImports('"""x"""\nprint(1)\n'), 'mdb.SIMULATOR.tm', 'BusVoltage', ['"""x"""', 'print(1)']),
        { line: 1, endLine: 0, text: 'from mdb.SIMULATOR.tm import BusVoltage' });
});

let failed = 0;
for (const [name, fn] of tests) {
    try {
        fn();
        console.log('ok   ' + name);
    } catch (e) {
        failed++;
        console.log('FAIL ' + name + '\n' + (e as Error).stack);
    }
}
process.exit(failed ? 1 : 0);
