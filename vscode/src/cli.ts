// Running the fops binary: check, inspect, and finding it.
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface Finding {
    line: number;      // 1-based; 0 is the whole file
    message: string;
}

export interface Inspection {
    path: string;
    declaresProcedure: boolean;
    name: string;
    version: string | null;
    description: string | null;
    author: string | null;
    args: { name: string; type: string; default?: unknown; description?: string; [k: string]: unknown }[];
    requires: string | null;
    invariant: string | null;
    steps: {
        index: number; name: string; line: number; cleanup: boolean;
        goal: string | null; requires: string | null; invariant: string | null; ensures: string | null;
    }[];
    watches: { line: number; condition: string; then: string; handler: string | null }[];
    functions: { name: string; line: number; endLine: number }[];
    check: Finding[];
    error: string | null;
}

export function executable(): string {
    const configured = vscode.workspace.getConfiguration('fops').get<string>('executable');
    if (configured) {
        return configured.replace(/^~(?=\/)/, os.homedir());
    }
    for (const f of vscode.workspace.workspaceFolders ?? []) {
        for (const p of ['target/release/fops', 'target/debug/fops']) {
            const candidate = path.join(f.uri.fsPath, p);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }
    return 'fops';
}

function run(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        execFile(executable(), args, { env: { ...process.env, ...env }, cwd, timeout: 30000, maxBuffer: 16 << 20 },
            (err, stdout, stderr) => {
                if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
                    reject(new Error(`fops not found (${executable()}): build it with cargo build --release, or set fops.executable`));
                } else if (err && typeof err.code !== 'number') {
                    reject(new Error(stderr || err.message));
                } else {
                    resolve({ code: typeof err?.code === 'number' ? err.code : 0, stdout, stderr });
                }
            });
    });
}

/** Python path entries: the procedure's own directory and the MDB package's parent. */
function pythonPath(file: string, mdbRoot?: string): string {
    const dirs = [path.dirname(file)];
    if (mdbRoot && !dirs.includes(mdbRoot)) {
        dirs.push(mdbRoot);
    }
    if (process.env.PYTHONPATH) {
        dirs.push(process.env.PYTHONPATH);
    }
    return dirs.join(path.delimiter);
}

/**
 * Runs `fn` on a file holding `text` as if it were `file`: a temporary copy
 * with the same name (so messages read the same), never `file` itself. Without
 * `text`, on `file`. Imports are resolved from `file`'s directory either way.
 */
async function withCopy<T>(file: string, text: string | undefined, fn: (target: string, unmap: (s: string) => string) => Promise<T>): Promise<T> {
    if (text === undefined) {
        return fn(file, s => s);
    }
    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fops-check-'));
    const target = path.join(tmp, path.basename(file));
    await fs.promises.writeFile(target, text);
    try {
        return await fn(target, s => s.split(target).join(file).split(tmp + path.sep).join(path.dirname(file) + path.sep));
    } finally {
        fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
}

export function check(file: string, text: string | undefined, mdbRoot?: string): Promise<Finding[]> {
    return withCopy(file, text, async (target, unmap) => {
        const { stdout, stderr } = await run(['check', target], { PYTHONPATH: pythonPath(file, mdbRoot) },
            path.dirname(file));
        const findings = parseCheck(stdout, target);
        if (!findings.length && !/: ok\s*$/m.test(stdout) && stderr.trim()) {
            findings.push({ line: 0, message: 'fops check failed: ' + stderr.trim().split('\n').pop() });
        }
        return findings.map(f => ({ ...f, message: unmap(f.message) }));
    });
}

export function parseCheck(stdout: string, file: string): Finding[] {
    const out: Finding[] = [];
    for (const line of stdout.split('\n')) {
        if (!line.startsWith(file + ':')) {
            continue;
        }
        const m = /^(\d+): ?(.*)$/.exec(line.slice(file.length + 1));
        if (m) {
            out.push({ line: Number(m[1]), message: m[2] });
        }
    }
    return out;
}

/** What the procedure declares, and its `fops check` findings; `text` as in `check`. */
export function inspect(file: string, text: string | undefined, mdbRoot?: string): Promise<Inspection> {
    return withCopy(file, text, async (target, unmap) => {
        const { stdout, stderr } = await run(['inspect', target], { PYTHONPATH: pythonPath(file, mdbRoot) },
            path.dirname(file));
        const line = stdout.split('\n').find(l => l.startsWith('{'));
        if (!line) {
            throw new Error('fops inspect: ' + (stderr.trim().split('\n').pop() || 'no output'));
        }
        const i = JSON.parse(line) as Inspection;
        i.path = file;
        i.check = i.check.map(f => ({ ...f, message: unmap(f.message) }));
        i.error = i.error && unmap(i.error);
        return i;
    });
}
