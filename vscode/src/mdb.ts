// The MDB package written by `fops mdb-gen`, read from its source: one
// package per space system, parameters in tm.py, commands in tc.py.
import * as fs from 'fs';
import * as path from 'path';

export interface Parameter {
    kind: 'param';
    name: string;           // Python name
    module: string;         // e.g. mdb.SIMULATOR.tm
    qualifiedName: string;  // e.g. /SIMULATOR/BusVoltage
    type: string;           // integer, float, enumeration, ...
    labels: string[];
    units?: string;
    description?: string;
    line: number;           // 0-based, in file
    file: string;
}

export interface CommandArg {
    name: string;
    type: string;
    labels: string[];
    default?: string;  // Python literal
    units?: string;
    min?: string;
    max?: string;
}

export interface Command {
    kind: 'command';
    name: string;
    module: string;
    qualifiedName: string;
    args: CommandArg[];
    significance?: string;
    reason?: string;
    description?: string;
    /** Stages of its MDB verifiers; undefined in an MDB generated before they were. */
    verifiers?: string[];
    line: number;
    file: string;
}

export type Item = Parameter | Command;

export interface SpaceSystem {
    path: string;    // /SIMULATOR
    module: string;  // mdb.SIMULATOR
    params: Parameter[];
    commands: Command[];
}

export class Mdb {
    /** By module (mdb.SIMULATOR.tm), then Python name. */
    readonly byModule = new Map<string, Map<string, Item>>();
    readonly systems: SpaceSystem[] = [];

    constructor(
        readonly root: string,       // the package directory
        readonly packageName: string,
        readonly instance?: string,
        readonly fingerprint?: string,
        readonly generated?: string,
    ) {}

    /** The directory to put on the Python path (the package's parent). */
    get sourceRoot(): string {
        return path.dirname(this.root);
    }

    item(module: string, name: string): Item | undefined {
        return this.byModule.get(module)?.get(name);
    }

    *items(): Iterable<Item> {
        for (const s of this.systems) {
            yield* s.params;
            yield* s.commands;
        }
    }
}

/** The MDB's names in lower case, per MDB. */
const lowered = new WeakMap<Mdb, { item: Item; lower: string }[]>();

/**
 * The items whose name matches `typed` (case-insensitive): those starting
 * with it, then those containing it, then those containing its letters in
 * order from the same first letter, as the editor's own filter does.
 */
export function* matching(mdb: Mdb, typed: string): Iterable<Item> {
    let names = lowered.get(mdb);
    if (!names) {
        names = [...mdb.items()].map(item => ({ item, lower: item.name.toLowerCase() }));
        lowered.set(mdb, names);
    }
    const t = typed.toLowerCase();
    const contains: Item[] = [];
    const fuzzy: Item[] = [];
    for (const { item, lower } of names) {
        if (lower.startsWith(t)) {
            yield item;
        } else if (lower.includes(t)) {
            contains.push(item);
        } else if (lower[0] === t[0] && subsequence(t, lower)) {
            fuzzy.push(item);
        }
    }
    yield* contains;
    yield* fuzzy;
}

function subsequence(t: string, s: string): boolean {
    let i = 0;
    for (let j = 0; j < s.length && i < t.length; j++) {
        if (s[j] === t[i]) {
            i++;
        }
    }
    return i === t.length;
}

/** Reads the package at `root` (the directory holding __init__.py). */
export function loadMdb(root: string): Mdb | undefined {
    const init = path.join(root, '__init__.py');
    let text: string;
    try {
        text = fs.readFileSync(init, 'utf8');
    } catch {
        return undefined;
    }
    if (!/^FINGERPRINT\s*=/m.test(text)) {
        return undefined;
    }
    const constant = (n: string) => text.match(new RegExp(`^${n}\\s*=\\s*(.+)$`, 'm'))?.[1];
    const str = (v?: string) => (v === undefined ? undefined : asString(v));
    const mdb = new Mdb(root, path.basename(root), str(constant('INSTANCE')), str(constant('FINGERPRINT')),
        str(constant('GENERATED')));
    walk(mdb, root, mdb.packageName, '');
    mdb.systems.sort((a, b) => a.path.localeCompare(b.path));
    return mdb;
}

function walk(mdb: Mdb, dir: string, module: string, ssPath: string): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return;
    }
    const tm = path.join(dir, 'tm.py');
    const tc = path.join(dir, 'tc.py');
    if (fs.existsSync(tm) || fs.existsSync(tc)) {
        const ss: SpaceSystem = { path: ssPath || '/', module, params: [], commands: [] };
        if (fs.existsSync(tm)) {
            ss.params = parseTm(tm, module + '.tm');
        }
        if (fs.existsSync(tc)) {
            ss.commands = parseTc(tc, module + '.tc');
        }
        mdb.systems.push(ss);
        for (const [m, items] of [[module + '.tm', ss.params], [module + '.tc', ss.commands]] as const) {
            const byName = new Map<string, Item>();
            for (const i of items) {
                byName.set(i.name, i);
            }
            mdb.byModule.set(m, byName);
        }
    }
    for (const e of entries) {
        if (e.isDirectory() && fs.existsSync(path.join(dir, e.name, '__init__.py'))) {
            // tm_ / tc_: a space system named tm or tc
            walk(mdb, path.join(dir, e.name), module + '.' + e.name, ssPath + '/' + e.name.replace(/^(tm|tc)_$/, '$1'));
        }
    }
}

const PARAM = /^(\w+): _Parameter\[.*?\] = _Parameter\((.*)\)\s*$/;

export function parseTm(file: string, module: string): Parameter[] {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const out: Parameter[] = [];
    lines.forEach((line, i) => {
        const m = PARAM.exec(line);
        if (!m) {
            return;
        }
        const { pos, kw } = parseArgs(m[2]);
        out.push({
            kind: 'param', name: m[1], module, qualifiedName: asString(pos[0]) ?? m[1],
            type: asString(pos[1]) ?? '', labels: asStrings(kw.labels), units: asString(kw.units),
            description: asString(kw.description), line: i, file,
        });
    });
    return out;
}

export function parseTc(file: string, module: string): Command[] {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const out: Command[] = [];
    for (let i = 0; i < lines.length; i++) {
        const deco = /^@_command\((.*)\)\s*$/.exec(lines[i]);
        const def = /^def (\w+)\(/.exec(lines[i + 1] ?? '');
        if (!deco || !def) {
            continue;
        }
        const { pos, kw } = parseArgs(deco[1]);
        const args: CommandArg[] = [];
        for (const spec of splitTop(stripParens(kw.args ?? ''))) {
            const a = /^_Arg\((.*)\)$/.exec(spec.trim());
            if (!a) {
                continue;
            }
            const p = parseArgs(a[1]);
            args.push({
                name: asString(p.pos[0]) ?? '?', type: asString(p.pos[1]) ?? '', labels: asStrings(p.kw.labels),
                default: p.kw.default, units: asString(p.kw.units), min: p.kw.min, max: p.kw.max,
            });
        }
        const doc = /^\s*"""(.*)"""\s*$/.exec(lines[i + 2] ?? '')?.[1];
        const qn = asString(pos[0]) ?? def[1];
        out.push({
            kind: 'command', name: def[1], module, qualifiedName: qn, args,
            significance: asString(kw.significance), reason: asString(kw.reason),
            verifiers: kw.verifiers === undefined ? undefined : asStrings(kw.verifiers),
            description: doc && doc !== qn ? doc : undefined, line: i + 1, file,
        });
    }
    return out;
}

/** Positional and keyword arguments of a call, as Python source. */
export function parseArgs(src: string): { pos: string[]; kw: Record<string, string> } {
    const pos: string[] = [];
    const kw: Record<string, string> = {};
    for (const part of splitTop(src)) {
        const m = /^\s*(\w+)\s*=(?!=)\s*([\s\S]*)$/.exec(part);
        if (m) {
            kw[m[1]] = m[2].trim();
        } else if (part.trim()) {
            pos.push(part.trim());
        }
    }
    return { pos, kw };
}

/** Splits on commas outside brackets and string literals. */
export function splitTop(src: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let quote: string | null = null;
    let start = 0;
    for (let i = 0; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === '\\') {
                i++;
            } else if (c === quote) {
                quote = null;
            }
        } else if (c === '"' || c === "'") {
            quote = c;
        } else if ('([{'.includes(c)) {
            depth++;
        } else if (')]}'.includes(c)) {
            depth--;
        } else if (c === ',' && depth === 0) {
            out.push(src.slice(start, i));
            start = i + 1;
        }
    }
    if (src.slice(start).trim()) {
        out.push(src.slice(start));
    }
    return out;
}

function stripParens(src: string): string {
    const s = src.trim();
    return s.startsWith('(') && s.endsWith(')') ? s.slice(1, -1) : s;
}

/** The value of a Python string literal (as written by repr). */
export function asString(src?: string): string | undefined {
    if (src === undefined) {
        return undefined;
    }
    const m = /^(['"])([\s\S]*)\1$/.exec(src.trim());
    if (!m) {
        return undefined;
    }
    return m[2].replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|.)/g, (_, e: string) => {
        if (e[0] === 'x' || e[0] === 'u') {
            return String.fromCharCode(parseInt(e.slice(1), 16));
        }
        return ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[e] ?? e;
    });
}

function asStrings(src?: string): string[] {
    if (!src) {
        return [];
    }
    return splitTop(stripParens(src)).map(s => asString(s)).filter((s): s is string => s !== undefined);
}

/** The package directories under `dir` (skipping the usual heavy directories). */
export function findMdbPackages(dir: string, depth = 4): string[] {
    const out: string[] = [];
    const skip = new Set(['node_modules', '.git', 'target', 'out', 'dist', '.venv', 'venv', '__pycache__']);
    const visit = (d: string, n: number) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (!e.isDirectory() || skip.has(e.name) || e.name.startsWith('.')) {
                continue;
            }
            const p = path.join(d, e.name);
            const init = path.join(p, '__init__.py');
            if (fs.existsSync(init) && /^FINGERPRINT\s*=/m.test(safeRead(init))) {
                out.push(p);
            } else if (n > 0) {
                visit(p, n - 1);
            }
        }
    };
    visit(dir, depth);
    return out;
}

function safeRead(f: string): string {
    try {
        return fs.readFileSync(f, 'utf8');
    } catch {
        return '';
    }
}
