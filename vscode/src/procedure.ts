// The active procedure as `fops inspect` sees it: a tree view, and code lenses
// above its steps and watches.
import * as vscode from 'vscode';
import { Inspection } from './cli';
import { Checker } from './diagnostics';
import { Workspace } from './workspace';

type Node = { label: string; description?: string; tooltip?: string | vscode.MarkdownString; line?: number;
    icon?: string; children?: Node[]; expanded?: boolean };

export class ProcedureView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;
    private doc: vscode.TextDocument | undefined;
    private disposables: vscode.Disposable[] = [this.changed];

    constructor(private ws: Workspace, private checker: Checker) {
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor(() => this.follow()),
            checker.onDidInspect(d => {
                if (d === this.doc) {
                    this.changed.fire();
                }
            }),
        );
        this.follow();
    }

    private follow(): void {
        const doc = vscode.window.activeTextEditor?.document;
        if (doc && doc.languageId === 'python') {
            const proc = this.ws.isProcedure(doc);
            vscode.commands.executeCommand('setContext', 'fops.isProcedure', proc);
            if (proc && doc !== this.doc) {
                this.doc = doc;
                this.changed.fire();
                if (!this.checker.inspections.has(doc.uri.toString())) {
                    this.checker.schedule(doc, 0);
                }
            }
        } else if (doc) {
            vscode.commands.executeCommand('setContext', 'fops.isProcedure', false);
        }
    }

    getTreeItem(n: Node): vscode.TreeItem {
        const item = new vscode.TreeItem(n.label, n.children?.length
            ? (n.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed)
            : vscode.TreeItemCollapsibleState.None);
        item.description = n.description;
        item.tooltip = n.tooltip ?? (n.description ? `${n.label}: ${n.description}` : undefined);
        if (n.icon) {
            item.iconPath = new vscode.ThemeIcon(n.icon);
        }
        if (n.line !== undefined && this.doc) {
            const pos = new vscode.Position(Math.max(n.line - 1, 0), 0);
            item.command = { command: 'vscode.open', title: 'Go to', arguments: [this.doc.uri, { selection: new vscode.Range(pos, pos) }] };
        }
        return item;
    }

    getChildren(n?: Node): Node[] {
        if (n) {
            return n.children ?? [];
        }
        const i = this.doc && this.checker.inspections.get(this.doc.uri.toString())?.inspection;
        return i ? tree(i) : [];
    }

    refresh(): void {
        if (this.doc) {
            this.checker.schedule(this.doc, 0);
        }
    }

    dispose(): void {
        vscode.Disposable.from(...this.disposables).dispose();
    }
}

function cond(label: string, c: string | null, icon: string): Node[] {
    return c ? [{ label, description: c, icon }] : [];
}

function tree(i: Inspection): Node[] {
    const out: Node[] = [];
    const head: Node = {
        label: i.name, description: i.version ? 'v' + i.version : '',
        tooltip: i.description ?? undefined, icon: i.declaresProcedure ? 'checklist' : 'file-code', line: 1,
    };
    out.push(head);
    if (i.error) {
        out.push({ label: 'Does not load', description: i.error, icon: 'error' });
    }
    if (!i.declaresProcedure && !i.error) {
        out.push({ label: 'Plain script', description: 'no procedure(): one step, no conditions', icon: 'warning' });
    }
    out.push(...cond('Requires', i.requires, 'pass'), ...cond('Invariant', i.invariant, 'shield'));
    if (i.args.length) {
        out.push({
            label: 'Arguments', icon: 'symbol-parameter', expanded: true,
            children: i.args.map(a => ({
                label: a.name,
                description: [a.type, a.required ? 'required' : `= ${JSON.stringify(a.default)}`,
                    a.unit as string | undefined, a.description].filter(Boolean).join(' · '),
                icon: 'symbol-variable',
            })),
        });
    }
    if (i.declaresProcedure) {
        out.push({
            label: 'Steps', description: String(i.steps.length), icon: 'list-ordered', expanded: true,
            children: i.steps.map(s => ({
                label: `${s.index + 1}. ${s.name}`, description: s.cleanup ? 'cleanup' : undefined, line: s.line,
                icon: s.cleanup ? 'debug-restart' : 'debug-stackframe-dot',
                children: [...cond('requires', s.requires, 'pass'), ...cond('goal', s.goal, 'target'),
                    ...cond('invariant', s.invariant, 'shield'), ...cond('ensures', s.ensures, 'check')]
                    .map(c => ({ ...c, line: s.line })),
            })),
        });
    }
    if (i.watches.length) {
        out.push({
            label: 'Watches', icon: 'eye', expanded: true,
            children: i.watches.map(w => ({
                label: w.condition, description: w.then + (w.handler ? ` · ${w.handler}()` : ''), line: w.line, icon: 'bell',
            })),
        });
    }
    return out;
}

export class StepLenses implements vscode.CodeLensProvider {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeCodeLenses = this.changed.event;

    constructor(private checker: Checker) {
        checker.onDidInspect(() => this.changed.fire());
        vscode.workspace.onDidChangeConfiguration(e => e.affectsConfiguration('fops.codeLens') && this.changed.fire());
    }

    provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
        if (!vscode.workspace.getConfiguration('fops').get('codeLens')) {
            return [];
        }
        // Only an inspection of this very text: lines move while typing.
        const i = this.checker.current(doc);
        if (!i) {
            return [];
        }
        const lens = (line: number, title: string, tooltip?: string) => {
            const l = Math.min(Math.max(line - 1, 0), doc.lineCount - 1);
            return new vscode.CodeLens(doc.lineAt(l).range, { title, tooltip, command: '' });
        };
        const out: vscode.CodeLens[] = [];
        for (const s of i.declaresProcedure ? i.steps : []) {
            const conds = [s.requires && `requires ${s.requires}`, s.goal && `goal ${s.goal}`,
                s.invariant && `invariant ${s.invariant}`, s.ensures && `ensures ${s.ensures}`].filter(Boolean) as string[];
            const title = `${s.cleanup ? 'cleanup ' : ''}step ${s.index + 1}/${i.steps.length}`;
            out.push(lens(s.line, conds.length ? `${title} · ${conds.length} condition${conds.length > 1 ? 's' : ''}` : title,
                conds.join('\n')));
        }
        for (const w of i.watches) {
            out.push(lens(w.line, `watch: when ${w.condition}, ${w.then}`));
        }
        return out;
    }
}
