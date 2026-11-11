// What a procedure imports from the MDB package, and adding imports to it.
import { Item, Mdb } from './mdb';

/** The fops API: `fops.__all__` (the tests keep the two the same). */
export const FOPS_API = [
    'Arg', 'ArgumentError', 'CommandFailed', 'CommandResult', 'Condition', 'InvariantViolated', 'MdbError',
    'OperationFailed', 'Parameter', 'ProcedureAborted', 'ProcedureFailed', 'ProcedureResult', 'Running', 'Sent',
    'SetFailed', 'Snapshot', 'VerificationFailed', 'abort', 'ask', 'finish', 'holds', 'log', 'param', 'procedure',
    'run', 'send', 'snapshot', 'verify', 'wait', 'wait_until', 'yamcs_client',
];

export interface ImportStmt {
    module: string;                                // from <module> import ...
    names: { name: string; alias?: string }[];
    startLine: number;                             // 0-based
    endLine: number;
    parenthesized: boolean;
}

export interface Imports {
    statements: ImportStmt[];       // `from X import ...` at the top level
    /** Local name → dotted target: a module (mdb.SIMULATOR) or an item (mdb.SIMULATOR.tm.BusVoltage). */
    bindings: Map<string, string>;
    lastImportLine: number;         // -1 when none
    bodyStart: number;              // first line after the module docstring
}

export function parseImports(text: string): Imports {
    const lines = text.split('\n');
    const statements: ImportStmt[] = [];
    const bindings = new Map<string, string>();
    let lastImportLine = -1;
    const bodyStart = docstringEnd(lines);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!/^(from|import)\s/.test(line)) {
            continue;
        }
        let stmt = stripComment(line);
        const start = i;
        const parenthesized = /\(\s*$|\(/.test(stmt) && stmt.startsWith('from');
        while ((parenthesized && !stmt.includes(')')) || /\\\s*$/.test(stmt)) {
            if (++i >= lines.length) {
                break;
            }
            stmt = stmt.replace(/\\\s*$/, ' ') + ' ' + stripComment(lines[i]);
        }
        lastImportLine = i;
        const from = /^from\s+([\w.]+)\s+import\s+\(?([^)]*)\)?/.exec(stmt);
        if (from) {
            const names = from[2].split(',').map(s => s.trim()).filter(Boolean).map(s => {
                const m = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(s);
                return m ? { name: m[1], alias: m[2] } : { name: s };
            });
            statements.push({ module: from[1], names, startLine: start, endLine: i, parenthesized });
            for (const n of names) {
                bindings.set(n.alias ?? n.name, from[1] + '.' + n.name);
            }
            continue;
        }
        const imp = /^import\s+(.+)$/.exec(stmt);
        if (imp) {
            for (const part of imp[1].split(',')) {
                const m = /^\s*([\w.]+)(?:\s+as\s+(\w+))?\s*$/.exec(part);
                if (m) {
                    if (m[2]) {
                        bindings.set(m[2], m[1]);
                    } else {
                        const top = m[1].split('.')[0];
                        bindings.set(top, top);
                    }
                }
            }
        }
    }
    return { statements, bindings, lastImportLine, bodyStart };
}

function stripComment(s: string): string {
    return s.replace(/#.*$/, '').trimEnd();
}

function docstringEnd(lines: string[]): number {
    let i = 0;
    while (i < lines.length && (/^\s*$/.test(lines[i]) || /^#/.test(lines[i]))) {
        i++;
    }
    const m = /^[rRuU]?("""|''')/.exec(lines[i] ?? '');
    if (!m) {
        return i;
    }
    const q = m[1];
    if (lines[i].indexOf(q, m[0].length) >= 0) {
        return i + 1;
    }
    for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].includes(q)) {
            return j + 1;
        }
    }
    return i;
}

/** The MDB item a dotted expression (BusVoltage, SIMULATOR.tm.BusVoltage, tm.BusVoltage) names, if any. */
export function resolve(mdb: Mdb, imports: Imports, chain: string[]): Item | undefined {
    if (chain.length === 0) {
        return undefined;
    }
    const head = imports.bindings.get(chain[0]);
    if (!head) {
        return undefined;
    }
    const full = [...head.split('.'), ...chain.slice(1)];
    const name = full.pop()!;
    return mdb.item(full.join('.'), name);
}

/** The local name an item is imported under, if it is imported by name. */
export function localName(imports: Imports, item: Item): string | undefined {
    for (const s of imports.statements) {
        if (s.module === item.module) {
            const n = s.names.find(n => n.name === item.name);
            if (n) {
                return n.alias ?? n.name;
            }
        }
    }
    return undefined;
}

export interface LineEdit {
    line: number;        // replace lines [line, endLine] (inclusive); endLine < line: insert before `line`
    endLine: number;
    text: string;        // without the trailing newline
}

/** The edit importing `name` from `module`, or undefined when already imported. */
export function importEdit(imports: Imports, module: string, name: string, lines: string[]): LineEdit | undefined {
    const existing = imports.statements.filter(s => s.module === module);
    if (existing.some(s => s.names.some(n => n.name === name && !n.alias))) {
        return undefined;
    }
    const target = existing.find(s => !s.parenthesized && s.startLine === s.endLine && !lines[s.startLine].includes('#'));
    if (target) {
        const names = [...target.names.map(n => (n.alias ? `${n.name} as ${n.alias}` : n.name)), name];
        const sorted = [...names].sort((a, b) => a.localeCompare(b, 'en', { caseFirst: 'upper' }));
        const text = `from ${module} import ${sorted.join(', ')}`;
        if (text.length <= 110) {
            return { line: target.startLine, endLine: target.endLine, text };
        }
    }
    const text = `from ${module} import ${name}`;
    // Among the imports of the same package, sorted by module.
    const same = imports.statements.filter(s => s.module.split('.')[0] === module.split('.')[0]);
    const before = same.filter(s => s.module.localeCompare(module) <= 0);
    let at: number;
    if (before.length) {
        at = Math.max(...before.map(s => s.endLine)) + 1;
    } else if (same.length) {
        at = same[0].startLine;
    } else {
        at = imports.lastImportLine >= 0 ? imports.lastImportLine + 1 : imports.bodyStart;
    }
    return { line: at, endLine: at - 1, text };
}
