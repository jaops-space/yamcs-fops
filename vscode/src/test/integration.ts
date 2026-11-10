// Run inside VS Code (see README): the extension on an unsaved edit of
// procedures/verification_test.py, which is reverted at the end.
import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const repo = path.resolve(__dirname, '..', '..', '..');

async function until<T>(what: string, fn: () => T | undefined | Promise<T | undefined>, ms = 15000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await fn();
        if (v) {
            return v;
        }
        if (Date.now() > end) {
            throw new Error('timed out waiting for ' + what);
        }
        await new Promise(r => setTimeout(r, 100));
    }
}

function labels(list: vscode.CompletionList): string[] {
    return list.items.map(i => (typeof i.label === 'string' ? i.label : i.label.label));
}

export async function run(): Promise<void> {
    const uri = vscode.Uri.file(path.join(repo, 'procedures', 'verification_test.py'));
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    const log: string[] = [];
    try {
        await until('the extension', () => vscode.extensions.getExtension('jaops.fops-vscode')?.isActive);
        const text = doc.getText();
        const find = (s: string) => {
            const i = text.indexOf(s);
            assert.ok(i >= 0, s);
            return doc.positionAt(i);
        };

        // 1. a misspelled enumeration label, unsaved: diagnostic and quick fix
        const label = find('"INVALID_VOLTAGE_NUM"');
        await editor.edit(e => e.replace(new vscode.Range(label, label.translate(0, 21)), '"INVALID_VOLTAG_NUM"'));
        const diag = await until('the INVALID_VOLTAG_NUM diagnostic', () =>
            vscode.languages.getDiagnostics(uri).find(d => d.message.includes("'INVALID_VOLTAG_NUM' is not one of")));
        assert.strictEqual(doc.getText(diag.range), '"INVALID_VOLTAG_NUM"');
        log.push('diagnostic: ' + diag.message);
        const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>('vscode.executeCodeActionProvider', uri, diag.range);
        const fix = actions.find(a => a.title === "Change to 'INVALID_VOLTAGE_NUM'");
        assert.ok(fix?.edit, actions.map(a => a.title).join(', '));
        await vscode.workspace.applyEdit(fix.edit);
        assert.ok(doc.lineAt(diag.range.start.line).text.includes('tc_ack_start_failure_code == "INVALID_VOLTAGE_NUM"'));
        await until('the diagnostic to go', () => !vscode.languages.getDiagnostics(uri).some(d => d.source === 'fops check' && d.severity === vscode.DiagnosticSeverity.Error));
        log.push('quick fix: ' + fix.title);

        // 2. completion of labels after == "
        const at = find('proc = procedure(');
        await editor.edit(e => e.insert(at, 'X = tc_ack_completion_failure_code == "\n'));
        let list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri,
            at.translate(0, 'X = tc_ack_completion_failure_code == "'.length));
        assert.ok(['COMPLETION_ERROR_0', 'COMPLETION_ERROR_1', 'INVALID_EVENT_ID'].every(l => labels(list).includes(l)), labels(list).slice(0, 20).join());
        log.push('labels: ' + labels(list).filter(l => /^[A-Z_0-9]+$/.test(l)).join(' '));
        // command argument labels
        await editor.edit(e => e.replace(new vscode.Range(at, at.translate(1, 0)),
            'from mdb.SIMULATOR.tc import SWITCH_VOLTAGE_ON_ENUM\nX = SWITCH_VOLTAGE_ON_ENUM(voltage_num="\n'));
        list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri,
            at.translate(1, 'X = SWITCH_VOLTAGE_ON_ENUM(voltage_num="'.length));
        assert.deepStrictEqual(labels(list).slice(0, 3), ['PRIMARY', 'SECONDARY', 'BACKUP']);
        log.push('argument labels: ' + labels(list).slice(0, 3).join(' '));
        await editor.edit(e => e.delete(new vscode.Range(at, at.translate(2, 0))));
        assert.strictEqual(doc.getText(), text.replace('"INVALID_VOLTAG_NUM"', '"INVALID_VOLTAGE_NUM"'));

        // 3. completion of a name not imported yet, with its import
        await editor.edit(e => e.insert(at, 'X = BatteryCapa\n'));
        list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri,
            at.translate(0, 'X = BatteryCapa'.length));
        const bc = list.items.find(i => typeof i.label !== 'string' && i.label.label === 'BatteryCapacity1');
        assert.ok(bc?.additionalTextEdits?.length, 'BatteryCapacity1 with an import');
        assert.strictEqual(bc.additionalTextEdits[0].newText,
            'from mdb.SIMULATOR.tm import BatteryCapacity1, BatteryVoltage1, BatteryVoltage2, BatteryVoltage3');
        log.push('auto-import: ' + bc.additionalTextEdits[0].newText);
        // documentation is built when an item is resolved (the first 10 here)
        list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri,
            at.translate(0, 'X = BatteryCapa'.length), undefined, 10);
        const resolved = list.items.find(i => typeof i.label !== 'string' && i.label.label === 'BatteryCapacity1');
        assert.match((resolved?.documentation as vscode.MarkdownString | undefined)?.value ?? '', /\/SIMULATOR\/BatteryCapacity1/);
        // one letter typed: no MDB names; at most 100 otherwise
        await editor.edit(e => e.replace(new vscode.Range(at, at.translate(1, 0)), 'X = B\n'));
        list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri, at.translate(0, 5));
        assert.ok(!list.items.some(i => typeof i.label !== 'string' && i.label.description?.startsWith('/')), 'MDB names after one letter');
        await editor.edit(e => e.replace(new vscode.Range(at, at.translate(1, 0)), 'X = Ba\n'));
        list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri, at.translate(0, 6));
        const mdbNames = list.items.filter(i => typeof i.label !== 'string' && i.label.description?.startsWith('/'));
        assert.ok(mdbNames.length > 0 && mdbNames.length <= 100, String(mdbNames.length));
        log.push(`completion: none after 1 letter, ${mdbNames.length} after "Ba", documentation on resolve`);
        await editor.edit(e => e.delete(new vscode.Range(at, at.translate(1, 0))));
        // a name clash gets an alias: status_report is imported from /PUS19, /PUS22 has one too
        await editor.edit(e => e.insert(at, 'from mdb.PUS19.tm import status_report\nX = status_rep\n'));
        list = await vscode.commands.executeCommand<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri,
            at.translate(1, 'X = status_rep'.length));
        const other = list.items.find(i => typeof i.label !== 'string' && i.label.description === '/PUS22/status_report');
        assert.ok(other, labels(list).slice(0, 20).join());
        assert.match(other.detail ?? '', / as pus22_status_report$/);
        log.push('name clash: ' + other.detail);
        await editor.edit(e => e.delete(new vscode.Range(at, at.translate(2, 0))));

        // 4. hover
        const bv3 = find('BatteryVoltage3 > 20').translate(0, 1);
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', uri, bv3);
        const md = hovers.flatMap(h => h.contents).map(c => (typeof c === 'string' ? c : (c as vscode.MarkdownString).value)).join('\n');
        assert.ok(md.includes('/SIMULATOR/BatteryVoltage3'), md);
        log.push('hover: ' + md.split('\n')[0]);

        // 5. code lenses, from the inspection of the current text
        const lenses = await until('code lenses', async () => {
            const l = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri);
            return l.length ? l : undefined;
        });
        log.push('code lenses: ' + lenses.map(l => `${l.range.start.line + 1}: ${l.command?.title}`).join(' | '));

        // 5b. the tree views
        const api = vscode.extensions.getExtension('jaops.fops-vscode')!.exports as
            { procedureView: vscode.TreeDataProvider<any>; mdbView: vscode.TreeDataProvider<any> };
        const top = (await api.procedureView.getChildren())!;
        const names = await Promise.all(top.map(async n => (await api.procedureView.getTreeItem(n)).label));
        assert.ok(names.includes('Requires') && names.includes('Steps'), names.join());
        const steps = top.find(n => n.label === 'Steps');
        log.push('procedure view: ' + names.join(', ') + ' | ' + (await api.procedureView.getChildren(steps))!.map(n => n.label).join(', '));
        const systems = (await api.mdbView.getChildren())!;
        const simulator = systems.find(n => n.system.path === '/SIMULATOR');
        const [tm] = (await api.mdbView.getChildren(simulator))!;
        const params = (await api.mdbView.getChildren(tm))!;
        log.push(`mdb view: ${systems.length} space systems, /SIMULATOR tm: ` +
            (await Promise.all(params.map(async n => (await api.mdbView.getTreeItem(n)).label))).join(' '));

        // 6. a bad import: diagnostic on the name, fix to the suggestion
        const alive = find('import ARE_YOU_ALIVE').translate(0, 'import '.length);
        await editor.edit(e => e.replace(new vscode.Range(alive, alive.translate(0, 13)), 'ARE_YOU_ALIV'));
        const imp = await until('the import diagnostic', () =>
            vscode.languages.getDiagnostics(uri).find(d => d.message.includes("cannot import name 'ARE_YOU_ALIV'")));
        assert.strictEqual(doc.getText(imp.range), 'ARE_YOU_ALIV');
        assert.ok(!imp.message.includes('fops-check-'), imp.message);
        log.push('import diagnostic: ' + imp.message);
    } catch (e) {
        log.push('FAIL ' + ((e as Error).stack ?? e));
        throw e;
    } finally {
        console.log(log.map(l => '  ' + l).join('\n'));
        if (process.env.FOPS_TEST_LOG) {
            fs.writeFileSync(process.env.FOPS_TEST_LOG, log.join('\n') + '\n');
        }
        await vscode.commands.executeCommand('workbench.action.files.revert');
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
}
