import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { executable } from './cli';
import { Checker, QuickFixes } from './diagnostics';
import { addImportEdit, Completion, Hover } from './language';
import { Item } from './mdb';
import { MdbNode, MdbView } from './mdbView';
import { ProcedureView, StepLenses } from './procedure';
import { Workspace } from './workspace';

export function activate(ctx: vscode.ExtensionContext): { procedureView: ProcedureView; mdbView: MdbView } {
    const ws = new Workspace();
    const checker = new Checker(ws);
    const procedureView = new ProcedureView(ws, checker);
    const mdbView = new MdbView(ws);
    const python: vscode.DocumentSelector = { language: 'python', scheme: 'file' };

    ctx.subscriptions.push(
        ws, checker, procedureView,
        vscode.languages.registerCompletionItemProvider(python, new Completion(ws), '"', "'"),
        vscode.languages.registerHoverProvider(python, new Hover(ws)),
        vscode.languages.registerCodeActionsProvider(python, new QuickFixes(), { providedCodeActionKinds: QuickFixes.kinds }),
        vscode.languages.registerCodeLensProvider(python, new StepLenses(checker)),
        vscode.window.registerTreeDataProvider('fops.procedure', procedureView),
        vscode.window.registerTreeDataProvider('fops.mdb', mdbView),
        ws.onDidChangeMdb(() => vscode.workspace.textDocuments.forEach(d => checker.schedule(d, 0))),

        vscode.commands.registerCommand('fops.checkFile', async () => {
            const doc = vscode.window.activeTextEditor?.document;
            if (!doc || !ws.isProcedure(doc)) {
                vscode.window.showInformationMessage('The active file is not a procedure (it imports neither fops nor the MDB).');
                return;
            }
            const i = await checker.run(doc);
            if (i) {
                const n = i.check.filter(f => !f.message.startsWith('warning:')).length;
                vscode.window.setStatusBarMessage(n ? `fops check: ${n} problem${n > 1 ? 's' : ''}` : 'fops check: ok', 4000);
            }
        }),
        vscode.commands.registerCommand('fops.checkAll', () => vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'fops check', cancellable: true },
            async (_, token) => {
                const { files, errors } = await checker.checkAll(token);
                vscode.window.showInformationMessage(`fops check: ${files} procedures, ${errors ? errors + ' problems' : 'ok'}`);
                if (errors) {
                    vscode.commands.executeCommand('workbench.actions.view.problems');
                }
            })),
        vscode.commands.registerCommand('fops.refresh', () => {
            mdbView.refresh();
            procedureView.refresh();
        }),
        vscode.commands.registerCommand('fops.insertItem', () => insertItem(ws)),
        vscode.commands.registerCommand('fops.mdbView.insert', (n: MdbNode) => n.type === 'item' && insert(ws, n.item)),
        vscode.commands.registerCommand('fops.mdbView.copyName', (n: MdbNode) =>
            n.type === 'item' && vscode.env.clipboard.writeText(n.item.qualifiedName)),
        vscode.commands.registerCommand('fops.runProcedure', () => runProcedure(ws, checker)),
        vscode.commands.registerCommand('fops.mdbGen', () => mdbGen(ws)),
        vscode.commands.registerCommand('fops.configurePython', () => configurePython(ws)),
    );
    return { procedureView, mdbView };  // for the tests
}

export function deactivate(): void {}

async function insertItem(ws: Workspace): Promise<void> {
    const mdb = ws.mdb;
    if (!mdb) {
        vscode.window.showWarningMessage('No MDB package in the workspace: run "fops: Regenerate MDB Package from Yamcs".');
        return;
    }
    type Pick = vscode.QuickPickItem & { item: Item };
    const picks: Pick[] = [...mdb.items()].map(item => ({
        label: `$(${item.kind === 'param' ? 'symbol-variable' : 'symbol-method'}) ${item.name}`,
        description: item.qualifiedName,
        detail: item.kind === 'param'
            ? [item.type, item.units, item.labels.join(' | '), item.description].filter(Boolean).join(' · ')
            : [item.significance, item.description, item.args.filter(a => a.default === undefined).map(a => a.name).join(', ')]
                .filter(Boolean).join(' · '),
        item,
    }));
    const pick = await vscode.window.showQuickPick(picks, {
        title: `MDB of ${mdb.instance ?? mdb.packageName}`, placeHolder: 'Parameter or command (name, qualified name or description)',
        matchOnDescription: true, matchOnDetail: true,
    });
    if (pick) {
        await insert(ws, pick.item);
    }
}

/** Inserts the item at the cursor, importing it. */
async function insert(ws: Workspace, item: Item): Promise<void> {
    const editor = vscode.window.activeTextEditor ?? vscode.window.visibleTextEditors.find(e => e.document.languageId === 'python');
    if (!editor || !ws.mdb) {
        return;
    }
    const { local, edit } = addImportEdit(editor.document, ws.mdb, item);
    const snippet = item.kind === 'command'
        ? new vscode.SnippetString(local + '(' + item.args.filter(a => a.default === undefined)
            .map((a, i) => `${a.name}=\${${i + 1}}`).join(', ') + ')$0')
        : new vscode.SnippetString(local);
    await editor.insertSnippet(snippet);
    if (edit) {
        const we = new vscode.WorkspaceEdit();
        we.set(editor.document.uri, [edit]);
        await vscode.workspace.applyEdit(we);
    }
}

function config() {
    return vscode.workspace.getConfiguration('fops');
}

function instance(ws: Workspace): string | undefined {
    return config().get<string>('yamcs.instance') || ws.mdb?.instance;
}

function terminal(name: string, cwd: string, env: Record<string, string>): vscode.Terminal {
    vscode.window.terminals.find(t => t.name === name)?.dispose();
    return vscode.window.createTerminal({ name, cwd, env });
}

function shellQuote(s: string): string {
    return /^[\w./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

async function runProcedure(ws: Workspace, checker: Checker): Promise<void> {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || !ws.isProcedure(doc)) {
        vscode.window.showInformationMessage('Open a procedure to run it.');
        return;
    }
    if (doc.isDirty) {
        await doc.save();
    }
    const i = await checker.run(doc);
    if (i?.error) {
        vscode.window.showErrorMessage(`${path.basename(doc.uri.fsPath)} does not load: ${i.error}`);
        return;
    }
    const url = config().get<string>('yamcs.url') || 'http://localhost:8090';
    const inst = instance(ws);
    const args = ['run', doc.uri.fsPath, '--control', '--yamcs', url];
    if (inst) {
        args.push('--instance', inst);
    }
    if (i?.args.length) {
        const defaults = Object.fromEntries(i.args.map(a => [a.name, a.required ? null : a.default]));
        const json = await vscode.window.showInputBox({
            title: `Arguments of ${i.name}`, value: JSON.stringify(defaults),
            prompt: i.args.map(a => `${a.name}: ${a.type}${a.required ? ' (required)' : ''}`).join(', '),
            validateInput: v => {
                try {
                    return typeof JSON.parse(v) === 'object' ? undefined : 'a JSON object';
                } catch (e) {
                    return String(e);
                }
            },
        });
        if (json === undefined) {
            return;
        }
        args.push('--args', json);
    }
    const ok = await vscode.window.showWarningMessage(
        `Run "${i?.name ?? path.basename(doc.uri.fsPath)}" against ${url}${inst ? ' (' + inst + ')' : ''}?`,
        { modal: true, detail: 'Its commands are sent to Yamcs. Events are printed as JSON lines; control messages (answers, pause, abort) are read from the terminal as JSON lines.' },
        'Run');
    if (ok !== 'Run') {
        return;
    }
    const t = terminal('fops run', path.dirname(doc.uri.fsPath), pythonEnv(doc.uri.fsPath, ws));
    t.show();
    t.sendText([executable(), ...args].map(shellQuote).join(' '));
}

function pythonEnv(file: string, ws: Workspace): Record<string, string> {
    const dirs = [path.dirname(file), ws.mdb?.sourceRoot, process.env.PYTHONPATH].filter((d): d is string => !!d);
    return { PYTHONPATH: [...new Set(dirs)].join(path.delimiter) };
}

async function mdbGen(ws: Workspace): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
        return;
    }
    const url = await vscode.window.showInputBox({ title: 'Yamcs URL', value: config().get<string>('yamcs.url') || 'http://localhost:8090' });
    if (!url) {
        return;
    }
    const inst = await vscode.window.showInputBox({ title: 'Yamcs instance', value: instance(ws) ?? '' });
    if (!inst) {
        return;
    }
    const out = ws.mdb?.sourceRoot ?? path.join(folder.uri.fsPath, 'procedures');
    const pkg = ws.mdb?.packageName ?? 'mdb';
    const t = terminal('fops mdb-gen', folder.uri.fsPath, {});
    t.show();
    t.sendText([executable(), 'mdb-gen', '--yamcs', url, '--instance', inst, '--out', out, '--package', pkg].map(shellQuote).join(' '));
    // The file watcher reloads the package once it is written.
}

/** The `python/` directory holding the fops library. */
function fopsPython(): string | undefined {
    const candidates = [process.env.FOPS_PYTHON];
    for (const f of vscode.workspace.workspaceFolders ?? []) {
        candidates.push(path.join(f.uri.fsPath, 'python'));
    }
    const exe = executable();
    if (path.isAbsolute(exe)) {
        candidates.push(path.resolve(path.dirname(exe), '..', '..', 'python'));
    }
    return candidates.find(c => c && fs.existsSync(path.join(c, 'fops', '_runtime.py')));
}

/** Points the Python language server at the fops library and the MDB package. */
async function configurePython(ws: Workspace): Promise<void> {
    const dirs = [fopsPython(), ws.mdb?.sourceRoot].filter((d): d is string => !!d);
    if (!dirs.length) {
        vscode.window.showWarningMessage('Found neither the fops library (python/fops) nor an MDB package.');
        return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    const rel = (d: string) => (folder && d.startsWith(folder.uri.fsPath + path.sep) ? path.relative(folder.uri.fsPath, d) : d);
    const py = vscode.workspace.getConfiguration('python.analysis');
    const current = py.get<string[]>('extraPaths') ?? [];
    const merged = [...new Set([...current, ...dirs.map(rel)])];
    await py.update('extraPaths', merged, vscode.ConfigurationTarget.Workspace);
    vscode.window.showInformationMessage(`python.analysis.extraPaths: ${merged.join(', ')}`);
}
