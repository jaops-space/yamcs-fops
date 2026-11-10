// The workspace's MDB package, kept up to date, and which documents are procedures.
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { findMdbPackages, loadMdb, Mdb } from './mdb';

export class Workspace implements vscode.Disposable {
    mdb: Mdb | undefined;
    private readonly changed = new vscode.EventEmitter<void>();
    readonly onDidChangeMdb = this.changed.event;
    private disposables: vscode.Disposable[] = [this.changed];
    private reloadTimer: NodeJS.Timeout | undefined;

    constructor() {
        const watcher = vscode.workspace.createFileSystemWatcher('**/{tm,tc,__init__}.py');
        const later = (uri: vscode.Uri) => {
            if (!this.mdb || uri.fsPath.startsWith(this.mdb.root + path.sep)) {
                clearTimeout(this.reloadTimer);
                this.reloadTimer = setTimeout(() => this.reload(), 500);  // mdb-gen writes many files
            }
        };
        this.disposables.push(
            watcher, watcher.onDidChange(later), watcher.onDidCreate(later), watcher.onDidDelete(later),
            vscode.workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration('fops.mdbPackage')) {
                    this.reload();
                }
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => this.reload()),
        );
        this.reload();
    }

    reload(): void {
        this.mdb = undefined;
        const configured = vscode.workspace.getConfiguration('fops').get<string>('mdbPackage');
        const candidates: string[] = [];
        for (const f of vscode.workspace.workspaceFolders ?? []) {
            if (configured) {
                candidates.push(path.isAbsolute(configured) ? configured : path.join(f.uri.fsPath, configured));
            } else {
                candidates.push(...findMdbPackages(f.uri.fsPath));
            }
        }
        for (const c of candidates) {
            this.mdb = loadMdb(c);
            if (this.mdb) {
                break;
            }
        }
        vscode.commands.executeCommand('setContext', 'fops.active', this.mdb !== undefined);
        this.changed.fire();
    }

    /** A Python file that imports fops or the MDB package (and is not part of it). */
    isProcedure(doc: vscode.TextDocument): boolean {
        if (doc.languageId !== 'python' || doc.uri.scheme !== 'file') {
            return false;
        }
        if (this.mdb && doc.uri.fsPath.startsWith(this.mdb.root + path.sep)) {
            return false;
        }
        const dir = path.dirname(doc.uri.fsPath);
        if (path.basename(dir) === 'fops' && fs.existsSync(path.join(dir, '_runtime.py'))) {
            return false;  // the fops library itself
        }
        const pkg = this.mdb?.packageName ?? 'mdb';
        return new RegExp(`^\\s*(from|import)\\s+(fops|${pkg})\\b`, 'm').test(doc.getText());
    }

    dispose(): void {
        clearTimeout(this.reloadTimer);
        vscode.Disposable.from(...this.disposables).dispose();
    }
}
