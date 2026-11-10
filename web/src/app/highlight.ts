import { classHighlighter, highlightTree } from '@lezer/highlight';
import { parser } from '@lezer/python';

/** A name, or dotted names, ending where a token ends. */
const CHAIN = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*)*)$/;

/** The name, or dotted names (`tm.BusVoltage`), that ends `text`, without spaces. */
export function nameAtEnd(text: string): string | undefined {
  return CHAIN.exec(text)?.[1].replace(/\s+/g, '');
}

/**
 * One source line as highlighted HTML (classes `tok-*` of classHighlighter).
 * Names in `params` (`BusVoltage`, `tm.BusVoltage`) get the class
 * `fops-param`, on their last part.
 */
export function highlightLines(source: string, params?: ReadonlySet<string>): string[] {
  const tree = parser.parse(source);
  const out: string[] = [];
  let line = '';
  let pos = 0;
  const emit = (text: string, cls: string) => {
    const parts = text.split('\n');
    parts.forEach((p, i) => {
      if (i > 0) {
        out.push(line);
        line = '';
      }
      if (p) line += cls ? `<span class="${cls}">${esc(p)}</span>` : esc(p);
    });
  };
  highlightTree(tree, classHighlighter, (from, to, cls) => {
    if (from > pos) emit(source.slice(pos, from), '');
    if (params?.size && /tok-(variableName|propertyName)/.test(cls)) {
      const name = nameAtEnd(source.slice(source.lastIndexOf('\n', from - 1) + 1, to));
      if (name && params.has(name)) cls += ' fops-param';
    }
    emit(source.slice(from, to), cls);
    pos = to;
  });
  if (pos < source.length) emit(source.slice(pos), '');
  out.push(line);
  if (source.endsWith('\n')) out.pop();
  return out;
}

export function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
