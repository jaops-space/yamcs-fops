// Browsing the MDB package: space systems, their telemetry and commands.
import * as vscode from 'vscode';
import { markdown } from './language';
import { Item, SpaceSystem } from './mdb';
import { Workspace } from './workspace';

export type MdbNode =
    | { type: 'system'; system: SpaceSystem }
    | { type: 'group'; system: SpaceSystem; kind: 'param' | 'command' }
    | { type: 'item'; item: Item };

export class MdbView implements vscode.TreeDataProvider<MdbNode> {
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this.changed.event;

    constructor(private ws: Workspace) {
        ws.onDidChangeMdb(() => this.changed.fire());
    }

    getTreeItem(n: MdbNode): vscode.TreeItem {
        const Collapsed = vscode.TreeItemCollapsibleState.Collapsed;
        if (n.type === 'system') {
            const t = new vscode.TreeItem(n.system.path, Collapsed);
            t.description = n.system.module;
            t.iconPath = new vscode.ThemeIcon('symbol-namespace');
            return t;
        }
        if (n.type === 'group') {
            const items = n.kind === 'param' ? n.system.params : n.system.commands;
            const t = new vscode.TreeItem(n.kind === 'param' ? 'tm' : 'tc', Collapsed);
            t.description = `${items.length} ${n.kind === 'param' ? 'parameters' : 'commands'}`;
            t.iconPath = new vscode.ThemeIcon(n.kind === 'param' ? 'pulse' : 'send');
            return t;
        }
        const i = n.item;
        const t = new vscode.TreeItem(i.name, vscode.TreeItemCollapsibleState.None);
        t.contextValue = i.kind;
        if (i.kind === 'param') {
            t.description = [i.type, i.units, i.labels.length ? i.labels.join('|') : undefined].filter(Boolean).join(' ');
            t.iconPath = new vscode.ThemeIcon(i.labels.length ? 'symbol-enum' : 'symbol-variable');
        } else {
            t.description = [i.significance, i.description].filter(Boolean).join(' · ');
            t.iconPath = new vscode.ThemeIcon('symbol-method', i.significance ? new vscode.ThemeColor('list.warningForeground') : undefined);
        }
        t.tooltip = this.ws.mdb ? markdown(i, this.ws.mdb) : undefined;
        const pos = new vscode.Position(i.line, 0);
        t.command = { command: 'vscode.open', title: 'Show definition',
            arguments: [vscode.Uri.file(i.file), { selection: new vscode.Range(pos, pos), preview: true, preserveFocus: true }] };
        return t;
    }

    getChildren(n?: MdbNode): MdbNode[] {
        const mdb = this.ws.mdb;
        if (!mdb) {
            return [];
        }
        if (!n) {
            return mdb.systems.filter(s => s.params.length || s.commands.length).map(system => ({ type: 'system', system }));
        }
        if (n.type === 'system') {
            const out: MdbNode[] = [];
            if (n.system.params.length) {
                out.push({ type: 'group', system: n.system, kind: 'param' });
            }
            if (n.system.commands.length) {
                out.push({ type: 'group', system: n.system, kind: 'command' });
            }
            return out;
        }
        if (n.type === 'group') {
            return (n.kind === 'param' ? n.system.params : n.system.commands).map(item => ({ type: 'item', item }));
        }
        return [];
    }

    refresh(): void {
        this.ws.reload();
    }
}
