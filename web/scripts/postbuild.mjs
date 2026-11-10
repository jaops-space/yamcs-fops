// Yamcs-web serves the extension's files from the same root as its own and,
// without an index.html, includes every .js and .css found there. Give ours
// names that cannot collide with the webapp's (main.*.js, styles.*.css).
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';

const dist = new URL('../dist/', import.meta.url);
const moves = { 'main.js': 'yamcs-fops.js', 'styles.css': 'yamcs-fops.css' };
for (const [from, to] of Object.entries(moves)) {
  if (existsSync(new URL(from, dist))) renameSync(new URL(from, dist), new URL(to, dist));
}
for (const f of readdirSync(dist)) {
  if (f.endsWith('.js') && !Object.values(moves).includes(f)) {
    console.error(`unexpected chunk ${f}: the extension must be a single bundle (no lazy imports)`);
    process.exit(1);
  }
  if (f === 'index.html') rmSync(new URL(f, dist));
}
console.log('dist:', readdirSync(dist).join(', '));
