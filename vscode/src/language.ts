// Completion and hovers from the MDB: enumeration labels, MDB and fops names
// with their import, and what a parameter or command is.
import * as vscode from 'vscode';
import { FOPS_API, importEdit, Imports, localName, parseImports, resolve } from './imports';
import { Command, Item, matching, Mdb, Parameter } from './mdb';
import { Workspace } from './workspace';

const CHAIN = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)\s*$/;

function chainOf(expr: string): string[] {
    return expr.split('.').map(s => s.trim());
}

/** The imports of `doc`, cached per version. */
const cache = new WeakMap<vscode.TextDocument, { version: number; imports: Imports }>();
export function importsOf(doc: vscode.TextDocument): Imports {
    const c = cache.get(doc);
    if (c && c.version === doc.version) {
        return c.imports;
    }
    const imports = parseImports(doc.getText());
    cache.set(doc, { version: doc.version, imports });
    return imports;
}

export class Completion implements vscode.CompletionItemProvider {
    constructor(private ws: Workspace) {}

    provideCompletionItems(doc: vscode.TextDocument, pos: vscode.Position): vscode.CompletionItem[] | vscode.CompletionList | undefined {
        const mdb = this.ws.mdb;
        if (!this.ws.isProcedure(doc)) {
            return undefined;
        }
        const prefix = doc.lineAt(pos.line).text.slice(0, pos.character);
        const labels = mdb && this.labels(doc, pos, prefix, mdb);
        if (labels) {
            return labels;
        }
        if (inStringOrComment(prefix) || /\.\s*\w*$/.test(prefix) || /^\s*(from|import)\s/.test(prefix)
            || !/(^|[^\w.])[A-Za-z_]\w*$/.test(prefix)) {
            return undefined;
        }
        if (!vscode.workspace.getConfiguration('fops').get('completion.autoImport')) {
            return undefined;
        }
        return this.names(doc, mdb, /[A-Za-z_]\w*$/.exec(prefix)![0]);
    }

    resolveCompletionItem(ci: vscode.CompletionItem): vscode.CompletionItem {
        if (ci instanceof MdbCompletion && this.ws.mdb) {
            ci.documentation = markdown(ci.item, this.ws.mdb);
        }
        return ci;
    }

    /** Enumeration labels in a string compared with a parameter, or given to a command argument. */
    private labels(doc: vscode.TextDocument, pos: vscode.Position, prefix: string, mdb: Mdb): vscode.CompletionItem[] | undefined {
        const str = /(['"])([^'"\\]*)$/.exec(prefix);
        if (!str || !inStringOrComment(prefix)) {
            return undefined;
        }
        const before = prefix.slice(0, str.index);
        const imports = importsOf(doc);
        let values: string[] | undefined;
        let detail = '';
        let m: RegExpExecArray | null;
        if ((m = /(?:==|!=)\s*$/.exec(before))) {
            const chain = CHAIN.exec(before.slice(0, m.index));
            const p = chain && resolve(mdb, imports, chainOf(chain[1]));
            if (p?.kind === 'param') {
                values = p.labels;
                detail = p.qualifiedName;
            }
        } else if ((m = /\.\s*is_in\s*\(([^()]*,)?\s*$/.exec(before))) {
            const chain = CHAIN.exec(before.slice(0, m.index));
            const p = chain && resolve(mdb, imports, chainOf(chain[1]));
            if (p?.kind === 'param') {
                values = p.labels;
                detail = p.qualifiedName;
            }
        } else if ((m = /(\w+)\s*=\s*$/.exec(before))) {
            const text = doc.getText(new vscode.Range(new vscode.Position(Math.max(0, pos.line - 20), 0), pos));
            const head = text.slice(0, text.length - prefix.length + m.index);
            const call = enclosingCall(head);
            if (m[1] === 'until' && call && /^(\w+\.)?send$/.test(call.name)) {
                // send(CMD(...), until="..."): the stages it can wait for
                const first = /^\s*([A-Za-z_][\w.]*)\s*\(/.exec(head.slice(call.open + 1))?.[1];
                const c = first ? resolve(mdb, imports, chainOf(first)) : undefined;
                values = ['complete', 'issued', 'queued', 'released', 'sent', ...(c?.kind === 'command' ? c.verifiers ?? [] : [])];
                detail = c?.kind === 'command' ? `${c.qualifiedName}: send() waits for` : 'send() waits for';
            } else {
                const c = call ? resolve(mdb, imports, chainOf(call.name)) : undefined;
                const arg = c?.kind === 'command' ? c.args.find(a => a.name === m![1]) : undefined;
                if (arg) {
                    values = arg.labels;
                    detail = `${c!.qualifiedName} ${arg.name}`;
                }
            }
        }
        if (!values?.length) {
            return undefined;
        }
        const range = new vscode.Range(pos.line, pos.character - str[2].length, pos.line, pos.character);
        return values.map((v, i) => {
            const item = new vscode.CompletionItem(v, vscode.CompletionItemKind.EnumMember);
            item.detail = detail;
            item.range = range;
            item.sortText = String(i).padStart(4, '0');
            return item;
        });
    }

    /**
     * The fops API names and the MDB parameters and commands matching the
     * word being typed, not imported yet; picking one adds its import. An MDB has tens of thousands
     * of names: at least MIN_TYPED characters are needed, at most MAX_ITEMS
     * are returned, the list is incomplete (asked again as typing goes on),
     * and documentation is built for the highlighted item only.
     */
    private names(doc: vscode.TextDocument, mdb: Mdb | undefined, typed: string): vscode.CompletionList | undefined {
        if (typed.length < MIN_TYPED) {
            return new vscode.CompletionList([], true);
        }
        const imports = importsOf(doc);
        const lines = doc.getText().split('\n');
        const items: vscode.CompletionItem[] = [];
        for (const name of FOPS_API) {
            const edit = imports.bindings.has(name) ? undefined : importEdit(imports, 'fops', name, lines);
            if (!edit) {
                continue;  // imported, or the name is taken
            }
            const fn = /^[a-z]/.test(name);
            const ci = new vscode.CompletionItem({ label: name, description: 'fops' },
                fn ? vscode.CompletionItemKind.Function : vscode.CompletionItemKind.Class);
            ci.detail = `from fops import ${name}`;
            ci.sortText = '~' + String(items.length).padStart(4, '0');
            ci.additionalTextEdits = [toTextEdit(doc, edit)];
            if (fn) {
                ci.insertText = new vscode.SnippetString(`${name}($0)`);
                ci.command = { command: 'editor.action.triggerParameterHints', title: '' };
            }
            items.push(ci);
        }
        for (const item of mdb ? matching(mdb, typed) : []) {
            if (localName(imports, item)) {
                continue;  // already imported: the Python language server completes it
            }
            const bound = imports.bindings.get(item.name);
            const alias = bound && bound !== `${item.module}.${item.name}` ? aliasFor(item, imports) : undefined;
            const local = alias ?? item.name;
            const ci = new MdbCompletion(item,
                { label: local, description: item.qualifiedName, detail: item.kind === 'param' ? paramDetail(item) : '()' },
                item.kind === 'param' ? vscode.CompletionItemKind.Variable : vscode.CompletionItemKind.Function);
            ci.filterText = local;
            ci.sortText = '~' + String(items.length).padStart(4, '0');  // after the names in scope, best match first
            const edit = importEdit(imports, item.module, alias ? `${item.name} as ${alias}` : item.name, lines);
            if (edit) {
                ci.additionalTextEdits = [toTextEdit(doc, edit)];
                ci.detail = `from ${item.module} import ${item.name}${alias ? ' as ' + alias : ''}`;
            }
            if (item.kind === 'command') {
                ci.insertText = new vscode.SnippetString(`${local}(${commandSnippetArgs(item)})`);
                ci.command = { command: 'editor.action.triggerParameterHints', title: '' };
            }
            items.push(ci);
            if (items.length >= MAX_ITEMS) {
                break;
            }
        }
        return new vscode.CompletionList(items, true);
    }
}

const MIN_TYPED = 2;
const MAX_ITEMS = 100;

class MdbCompletion extends vscode.CompletionItem {
    constructor(readonly item: Item, label: vscode.CompletionItemLabel, kind: vscode.CompletionItemKind) {
        super(label, kind);
    }
}

/** `status_report` from /PUS22 when another `status_report` is imported: `pus22_status_report`. */
function aliasFor(item: Item, imports: Imports): string {
    const system = item.qualifiedName.split('/').slice(-2, -1)[0] ?? 'mdb';
    let alias = `${system.toLowerCase()}_${item.name}`.replace(/\W/g, '_');
    for (let n = 2; imports.bindings.has(alias); n++) {
        alias = `${system.toLowerCase()}_${item.name}${n}`;
    }
    return item.kind === 'command' ? alias.toUpperCase() : alias;
}

function commandSnippetArgs(c: Command): string {
    return c.args.filter(a => a.default === undefined).map((a, i) => `${a.name}=\${${i + 1}}`).join(', ');
}

function toTextEdit(doc: vscode.TextDocument, e: { line: number; endLine: number; text: string }): vscode.TextEdit {
    if (e.endLine < e.line) {
        return vscode.TextEdit.insert(new vscode.Position(e.line, 0), e.text + '\n');
    }
    return vscode.TextEdit.replace(new vscode.Range(e.line, 0, e.endLine, doc.lineAt(e.endLine).text.length), e.text);
}

export function addImportEdit(doc: vscode.TextDocument, mdb: Mdb, item: Item): { local: string; edit?: vscode.TextEdit } {
    const imports = importsOf(doc);
    const existing = localName(imports, item);
    if (existing) {
        return { local: existing };
    }
    const bound = imports.bindings.get(item.name);
    const alias = bound && bound !== `${item.module}.${item.name}` ? aliasFor(item, imports) : undefined;
    const e = importEdit(imports, item.module, alias ? `${item.name} as ${alias}` : item.name, doc.getText().split('\n'));
    return { local: alias ?? item.name, edit: e && toTextEdit(doc, e) };
}

/** The callee of the innermost call still open at the end of `text`. */
/** The call whose arguments end `text`: its name and the index of its "(". */
function enclosingCall(text: string): { name: string; open: number } | undefined {
    let depth = 0;
    for (let i = text.length - 1; i >= 0; i--) {
        const c = text[i];
        if (c === ')' || c === ']' || c === '}') {
            depth++;
        } else if (c === '(' || c === '[' || c === '{') {
            if (depth === 0) {
                if (c !== '(') {
                    return undefined;
                }
                const name = CHAIN.exec(text.slice(0, i))?.[1];
                return name === undefined ? undefined : { name, open: i };
            }
            depth--;
        }
    }
    return undefined;
}

/** Whether the end of a line prefix is inside a string literal or a comment. */
function inStringOrComment(prefix: string): boolean {
    let quote: string | null = null;
    for (let i = 0; i < prefix.length; i++) {
        const c = prefix[i];
        if (quote) {
            if (c === '\\') {
                i++;
            } else if (c === quote) {
                quote = null;
            }
        } else if (c === '#') {
            return true;
        } else if (c === '"' || c === "'") {
            quote = c;
        }
    }
    return quote !== null;
}

function paramDetail(p: Parameter): string {
    return ' ' + [p.type, p.units].filter(Boolean).join(' ');
}

export function markdown(item: Item, mdb: Mdb): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    const source = vscode.Uri.file(item.file).with({ fragment: `L${item.line + 1}` });
    if (item.kind === 'param') {
        md.appendMarkdown(`**${item.name}** \`${item.qualifiedName}\` — telemetry, ${item.type}`);
        if (item.units) {
            md.appendMarkdown(` in ${item.units}`);
        }
        md.appendMarkdown('\n\n');
        if (item.description && item.description !== item.units) {
            md.appendText(item.description + '\n\n');
        }
        if (item.labels.length) {
            md.appendMarkdown('Labels: ' + item.labels.map(l => '`' + l + '`').join(' · ') + '\n\n');
        }
    } else {
        md.appendMarkdown(`**${item.name}** \`${item.qualifiedName}\` — command`);
        if (item.significance) {
            md.appendMarkdown(`, **${item.significance}**`);
        }
        md.appendMarkdown('\n\n');
        if (item.reason) {
            md.appendText('⚠ ' + item.reason + '\n\n');
        }
        if (item.description) {
            md.appendText(item.description + '\n\n');
        }
        if (item.args.length) {
            md.appendMarkdown('| argument | type | default | |\n|---|---|---|---|\n');
            for (const a of item.args) {
                const extra = [
                    a.units,
                    a.min !== undefined || a.max !== undefined ? `${a.min ?? ''}..${a.max ?? ''}` : undefined,
                    a.labels.length ? a.labels.join(', ') : undefined,
                ].filter(Boolean).join(' · ');
                md.appendMarkdown(`| \`${a.name}\` | ${a.type} | ${a.default === undefined ? '*required*' : '`' + a.default + '`'} | ${extra} |\n`);
            }
            md.appendMarkdown('\n');
        }
        if (item.verifiers?.length) {
            md.appendMarkdown('Verifiers: ' + item.verifiers.map(v => '`' + v + '`').join(' · ') + '\n\n');
        }
    }
    md.appendMarkdown(`[${item.module}](${source.toString()})`);
    if (mdb.instance) {
        md.appendMarkdown(` · Yamcs instance ${mdb.instance}`);
    }
    return md;
}

export class Hover implements vscode.HoverProvider {
    constructor(private ws: Workspace) {}

    provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
        const mdb = this.ws.mdb;
        const range = doc.getWordRangeAtPosition(pos, /[A-Za-z_]\w*/);
        if (!mdb || !range || !this.ws.isProcedure(doc)) {
            return undefined;
        }
        const line = doc.lineAt(pos.line).text;
        const imports = importsOf(doc);
        // In `from mdb.X.tm import a as b`, the imported name itself.
        const from = /^from\s+([\w.]+)\s+import\b/.exec(line);
        const word = doc.getText(range);
        let item: Item | undefined;
        if (from && range.start.character > from[0].length) {
            item = mdb.item(from[1], word) ?? resolve(mdb, imports, [word]);
        } else {
            const chain = CHAIN.exec(line.slice(0, range.end.character));
            item = chain ? resolve(mdb, imports, chainOf(chain[1])) : undefined;
        }
        return item ? new vscode.Hover(markdown(item, mdb), range) : undefined;
    }
}
