// `fops inspect` of each open procedure (unsaved changes included): its
// check findings as diagnostics, with quick fixes for the ones that say how.
import * as vscode from 'vscode';
import { check, Finding, inspect, Inspection } from './cli';
import { Workspace } from './workspace';

const SOURCE = 'fops check';

export class Checker implements vscode.Disposable {
    readonly collection = vscode.languages.createDiagnosticCollection('fops');
    /** The latest inspection of each document, and the version it is of. */
    readonly inspections = new Map<string, { version: number; inspection: Inspection }>();
    private readonly inspected = new vscode.EventEmitter<vscode.TextDocument>();
    readonly onDidInspect = this.inspected.event;
    private timers = new Map<string, NodeJS.Timeout>();
    private generation = new Map<string, number>();
    private disposables: vscode.Disposable[] = [];
    private warnedMissing = false;

    constructor(private ws: Workspace) {
        this.disposables.push(
            this.collection, this.inspected,
            vscode.workspace.onDidOpenTextDocument(d => this.schedule(d, 0)),
            vscode.workspace.onDidSaveTextDocument(d => this.schedule(d, 0)),
            vscode.workspace.onDidChangeTextDocument(e => {
                if (e.contentChanges.length && vscode.workspace.getConfiguration('fops').get('check.onType')) {
                    this.schedule(e.document, vscode.workspace.getConfiguration('fops').get('check.delay', 500));
                }
            }),
            vscode.workspace.onDidCloseTextDocument(d => this.inspections.delete(d.uri.toString())),
        );
        for (const d of vscode.workspace.textDocuments) {
            this.schedule(d, 0);
        }
    }

    schedule(doc: vscode.TextDocument, delay: number): void {
        if (!this.ws.isProcedure(doc)) {
            return;
        }
        const key = doc.uri.toString();
        clearTimeout(this.timers.get(key));
        this.timers.set(key, setTimeout(() => this.run(doc), delay));
    }

    async run(doc: vscode.TextDocument): Promise<Inspection | undefined> {
        const key = doc.uri.toString();
        const gen = (this.generation.get(key) ?? 0) + 1;
        this.generation.set(key, gen);
        const version = doc.version;
        let inspection: Inspection;
        try {
            inspection = await inspect(doc.uri.fsPath, doc.isDirty ? doc.getText() : undefined, this.ws.mdb?.sourceRoot);
        } catch (e) {
            if (this.generation.get(key) === gen && /not found/.test(String(e)) && !this.warnedMissing) {
                this.warnedMissing = true;
                vscode.window.showWarningMessage(String((e as Error).message ?? e));
            } else if (this.generation.get(key) === gen) {
                this.collection.set(doc.uri, [toDiagnostic(doc, { line: 0, message: String((e as Error).message ?? e) })]);
            }
            return undefined;
        }
        if (this.generation.get(key) !== gen || doc.isClosed) {
            return undefined;  // a newer check started
        }
        this.collection.set(doc.uri, inspection.check.map(f => toDiagnostic(doc, f)));
        this.inspections.set(key, { version, inspection });
        this.inspected.fire(doc);
        return inspection;
    }

    /** The latest inspection of `doc`, if it is of its current text. */
    current(doc: vscode.TextDocument): Inspection | undefined {
        const i = this.inspections.get(doc.uri.toString());
        return i && i.version === doc.version ? i.inspection : undefined;
    }

    /** Checks every procedure file under the workspace folders (open or not). */
    async checkAll(token?: vscode.CancellationToken): Promise<{ files: number; errors: number }> {
        const exclude = this.ws.mdb ? new vscode.RelativePattern(this.ws.mdb.root, '**') : undefined;
        const uris = await vscode.workspace.findFiles('**/*.py', '{**/node_modules/**,**/target/**,**/.*/**,**/__pycache__/**}');
        let files = 0;
        let errors = 0;
        for (const uri of uris) {
            if (token?.isCancellationRequested) {
                break;
            }
            if (exclude && uri.fsPath.startsWith(exclude.baseUri.fsPath)) {
                continue;
            }
            const doc = await vscode.workspace.openTextDocument(uri);
            if (!this.ws.isProcedure(doc)) {
                continue;
            }
            files++;
            const findings: Finding[] = await check(uri.fsPath, doc.isDirty ? doc.getText() : undefined, this.ws.mdb?.sourceRoot);
            const diags = findings.map(f => toDiagnostic(doc, f));
            errors += diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error).length;
            this.collection.set(uri, diags);
        }
        return { files, errors };
    }

    dispose(): void {
        for (const t of this.timers.values()) {
            clearTimeout(t);
        }
        vscode.Disposable.from(...this.disposables).dispose();
    }
}

function toDiagnostic(doc: vscode.TextDocument, f: Finding): vscode.Diagnostic {
    let message = f.message;
    let severity = vscode.DiagnosticSeverity.Error;
    if (message.startsWith('warning: ')) {
        message = message.slice('warning: '.length);
        severity = vscode.DiagnosticSeverity.Warning;
    }
    const line = Math.min(Math.max(f.line - 1, 0), doc.lineCount - 1);
    const d = new vscode.Diagnostic(rangeFor(doc, line, f.message), message, severity);
    d.source = SOURCE;
    return d;
}

/** The token a message is about, on `line`; else the line without indentation. */
function rangeFor(doc: vscode.TextDocument, line: number, message: string): vscode.Range {
    const text = doc.lineAt(line).text;
    for (const pattern of tokenPatterns(message)) {
        const m = pattern.exec(text);
        if (m) {
            const start = m.index + (m[0].length - m[0].trimStart().length);
            return new vscode.Range(line, start, line, m.index + m[0].length);
        }
    }
    const first = doc.lineAt(line).firstNonWhitespaceCharacterIndex;
    return new vscode.Range(line, first, line, Math.max(first, text.trimEnd().length));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function tokenPatterns(message: string): RegExp[] {
    const out: RegExp[] = [];
    let m: RegExpExecArray | null;
    if ((m = /cannot import name '(\w+)'/.exec(message))) {
        out.push(new RegExp(`\\b${esc(m[1])}\\b(?!\\s*\\.)`));
    }
    if ((m = /No module named '([\w.]+)'/.exec(message))) {
        out.push(new RegExp(`\\b${esc(m[1])}\\b`));
    }
    if ((m = /'((?:[^'\\]|\\.)*)' is not one of/.exec(message)) || (m = /^\S+: (\S+?) is not one of/.exec(message))) {
        out.push(new RegExp(`(['"])${esc(m[1])}\\1`), new RegExp(`\\b${esc(m[1])}\\b`));
    }
    if ((m = /has no argument '(\w+)'/.exec(message))) {
        out.push(new RegExp(`\\b${esc(m[1])}(?=\\s*=)`));
    }
    if ((m = /^\/(?:[\w/]*\/)?(\w+)\b/.exec(message))) {
        out.push(new RegExp(`\\b${esc(m[1])}\\b`));
    }
    return out;
}

interface Fix { title: string; edit: (doc: vscode.TextDocument, d: vscode.Diagnostic) => vscode.TextEdit[] | undefined }

export class QuickFixes implements vscode.CodeActionProvider {
    static readonly kinds = [vscode.CodeActionKind.QuickFix];

    provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
        const out: vscode.CodeAction[] = [];
        for (const d of ctx.diagnostics) {
            if (d.source !== SOURCE) {
                continue;
            }
            for (const fix of fixesFor(d.message)) {
                const edits = fix.edit(doc, d);
                if (!edits?.length) {
                    continue;
                }
                const a = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);
                a.diagnostics = [d];
                a.isPreferred = true;
                a.edit = new vscode.WorkspaceEdit();
                a.edit.set(doc.uri, edits);
                out.push(a);
            }
        }
        return out;
    }
}

function fixesFor(message: string): Fix[] {
    const fixes: Fix[] = [];
    const mean = /\(did you mean ([^?]+)\?\)/.exec(message)?.[1];
    if (mean) {
        const replacement = mean.replace(/^'(.*)'$/, '$1');
        fixes.push({
            title: `Change to ${mean}`,
            edit: (doc, d) => {
                const text = doc.getText(d.range);
                const quoted = /^(['"])(.*)\1$/.exec(text);
                if (quoted) {
                    return [vscode.TextEdit.replace(d.range, quoted[1] + replacement + quoted[1])];
                }
                // A misspelled module: the full dotted path is suggested.
                const missing = /No module named '([\w.]+)'/.exec(message)?.[1];
                if (missing) {
                    return replaceOnLine(doc, d.range.start.line, missing, replacement);
                }
                return d.range.isSingleLine && /^\w+$/.test(text) ? [vscode.TextEdit.replace(d.range, replacement)] : undefined;
            },
        });
    }
    const where = /\(it is in ([\w.]+):/.exec(message)?.[1];
    if (where) {
        const pkg = where.replace(/\.(tm|tc)$/, '');
        fixes.push({
            title: `Import from ${where}`,
            edit: (doc, d) => replaceOnLine(doc, d.range.start.line, `from ${pkg} import`, `from ${where} import`),
        });
    }
    if (/is telemetry, not a value/.test(message)) {
        fixes.push({ title: 'Test it now with holds(...)', edit: wrapInHolds });
    }
    return fixes;
}

function replaceOnLine(doc: vscode.TextDocument, line: number, from: string, to: string): vscode.TextEdit[] | undefined {
    const text = doc.lineAt(line).text;
    const i = text.indexOf(from);
    return i < 0 ? undefined : [vscode.TextEdit.replace(new vscode.Range(line, i, line, i + from.length), to)];
}

/** `if event_id == "EVENT_1":` → `if holds(event_id == "EVENT_1"):`, adding the import. */
function wrapInHolds(doc: vscode.TextDocument, d: vscode.Diagnostic): vscode.TextEdit[] | undefined {
    const line = d.range.start.line;
    const text = doc.lineAt(line).text;
    const m = /^(\s*(?:if|elif|while|assert)\s+)(not\s+)?(.+?)(\s*:\s*(?:#.*)?|\s*,.*|\s*#.*)?$/.exec(text);
    if (!m || /\b(and|or)\b/.test(m[3])) {  // holds(a and b) would test only one of them
        return undefined;
    }
    const start = m[1].length + (m[2]?.length ?? 0);
    const edits = [vscode.TextEdit.replace(new vscode.Range(line, start, line, start + m[3].length), `holds(${m[3]})`)];
    const imp = ensureFopsImport(doc, 'holds');
    if (imp) {
        edits.push(imp);
    }
    return edits;
}

/** Adds `name` to `from fops import ...`, or a new import line. */
export function ensureFopsImport(doc: vscode.TextDocument, name: string): vscode.TextEdit | undefined {
    for (let i = 0; i < Math.min(doc.lineCount, 200); i++) {
        const text = doc.lineAt(i).text;
        const m = /^from fops import (?!\()(.*?)\s*$/.exec(text);
        if (m && !text.includes('#')) {
            const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
            if (names.includes(name) || names.includes('*')) {
                return undefined;
            }
            names.push(name);
            names.sort((a, b) => a.localeCompare(b, 'en', { caseFirst: 'upper' }));
            return vscode.TextEdit.replace(doc.lineAt(i).range, `from fops import ${names.join(', ')}`);
        }
        if (/^from fops import \(/.test(text) && new RegExp(`\\b${name}\\b`).test(doc.getText())) {
            return undefined;
        }
    }
    return vscode.TextEdit.insert(new vscode.Position(firstImportLine(doc), 0), `from fops import ${name}\n`);
}

function firstImportLine(doc: vscode.TextDocument): number {
    for (let i = 0; i < doc.lineCount; i++) {
        if (/^(from|import)\s/.test(doc.lineAt(i).text)) {
            return i;
        }
    }
    return 0;
}
