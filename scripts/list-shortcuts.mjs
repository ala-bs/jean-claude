#!/usr/bin/env node
/**
 * Extract every keyboard shortcut registered in the renderer.
 *
 * Shortcuts live in three shapes:
 *   - `useCommands(scope, [...])` entries with `shortcut:` + `label:`
 *   - `<Kbd shortcut="..." />` display-only hints
 *   - raw `shortcut: 'x'` in ad-hoc binding registrations
 *
 * Usage:
 *   node scripts/list-shortcuts.mjs            # print the markdown table
 *   node scripts/list-shortcuts.mjs --write    # splice it into docs/keyboard-shortcuts.md
 *   node scripts/list-shortcuts.mjs --check    # exit 1 if a key is bound twice
 *
 * `--check` reports *candidate* collisions only: two bindings for the same key
 * are legitimate when they live in scopes that are never mounted together
 * (e.g. per-modal `escape`). Treat its output as a prompt to think, not a fail.
 */
/* eslint-disable sort-imports */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');

/** Keys bound so widely that listing every site is noise, not signal. */
const UBIQUITOUS = new Set(['escape', 'enter', 'shift+enter']);

/**
 * Components whose `shortcut` prop only renders a hint. Anything not listed
 * here is assumed to register a real binding (e.g. `ModeSelector`), which is
 * the safe default: over-reporting a key as taken is cheap, missing one is not.
 */
const DISPLAY_ONLY_JSX = new Set(['Kbd', 'DropdownItem']);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const findings = [];

for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const rel = relative(ROOT, file);

  // Nearest enclosing useCommands('<scope>', ...) above the match.
  const scopeAt = (index) => {
    for (let i = index; i >= 0; i--) {
      const m = lines[i].match(/useCommands\(\s*['"]([^'"]+)['"]/);
      if (m) return m[1];
    }
    return '—';
  };
  // Name of the JSX element whose attribute list contains this line. Skips
  // self-closing elements (`icon={<GitPullRequest />}` sits between the
  // `<DropdownItem` tag and its `shortcut` prop and would otherwise win).
  const openTagFor = (index) => {
    for (let i = index; i >= Math.max(0, index - 30); i--) {
      const m = lines[i].match(/<([A-Z][A-Za-z0-9]*)\b/);
      if (!m) continue;
      if (/\/>/.test(lines[i])) continue;
      return m[1];
    }
    return '';
  };
  // Nearest `label:` within a few lines above/below the shortcut.
  const labelNear = (index) => {
    for (let i = Math.max(0, index - 4); i <= Math.min(lines.length - 1, index + 4); i++) {
      const m = lines[i].match(/label:\s*['"]([^'"]+)['"]/);
      if (m) return m[1];
      const t = lines[i].match(/title:\s*[`'"]([^`'"]+)/);
      if (t) return t[1];
    }
    return '';
  };

  lines.forEach((line, i) => {
    const decl = line.match(/shortcut:\s*(\[[^\]]*\]|['"][^'"]+['"])/);
    if (decl) {
      const keys = decl[1].startsWith('[')
        ? [...decl[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1])
        : [decl[1].replace(/['"]/g, '')];
      for (const key of keys) {
        findings.push({ key, kind: 'binding', scope: scopeAt(i), label: labelNear(i), file: rel, line: i + 1 });
      }
    }
    // JSX `shortcut="..."`. Two cases, both of which reserve the key:
    //   <Kbd shortcut="cmd+enter" />       -> display hint for a binding elsewhere
    //   <ModeSelector shortcut="cmd+i" />  -> the child registers the binding
    // Treating only `shortcut:` object literals as real is how `cmd+i`/`cmd+t`
    // were once mistaken for free keys.
    const jsx = line.match(/\bshortcut="([^"]+)"/);
    if (jsx) {
      // `<Kbd>` and `<DropdownItem>` only *render* the hint (DropdownItem
      // forwards to Kbd, see src/common/ui/dropdown/index.tsx:438); the real
      // binding lives elsewhere. Counting them would double-report every menu
      // entry as colliding with its own command.
      const isKbd = /<Kbd\b/.test(line) || DISPLAY_ONLY_JSX.has(openTagFor(i));
      findings.push({
        key: jsx[1],
        kind: isKbd ? 'display' : 'prop',
        scope: scopeAt(i),
        label: labelNear(i),
        file: rel,
        line: i + 1,
      });
    }
  });
}

// `display` entries mirror a binding declared elsewhere, so counting them would
// report every <Kbd> as a collision. `prop` entries are real registrations.
const bindings = findings.filter(
  (f) => f.kind === 'binding' || f.kind === 'prop',
);
const byKey = new Map();
for (const f of bindings) {
  if (!byKey.has(f.key)) byKey.set(f.key, []);
  byKey.get(f.key).push(f);
}

const collisions = [...byKey.entries()]
  .filter(([key, list]) => list.length > 1 && !UBIQUITOUS.has(key))
  .sort((a, b) => a[0].localeCompare(b[0]));

if (process.argv.includes('--check')) {
  if (collisions.length === 0) {
    console.log('No candidate shortcut collisions.');
    process.exit(0);
  }
  console.log('Candidate shortcut collisions (verify the scopes cannot co-mount):\n');
  for (const [key, list] of collisions) {
    console.log(`  ${key}`);
    for (const f of list) {
      console.log(`      ${f.scope.padEnd(22)} ${f.label || '(unlabelled)'}  — ${f.file}:${f.line}`);
    }
  }
  process.exit(1);
}

const sortKey = (k) => {
  const mods = (k.match(/\+/g) || []).length;
  return `${mods}${k}`;
};
const rows = ['| Shortcut | Scope | Action | Source |', '| --- | --- | --- | --- |'];
for (const key of [...byKey.keys()].sort((a, b) => sortKey(a).localeCompare(sortKey(b)))) {
  for (const f of byKey.get(key)) {
    rows.push(`| \`${key}\` | ${f.scope} | ${f.label || '—'} | \`${f.file}:${f.line}\` |`);
  }
}
const table = rows.join('\n');

if (process.argv.includes('--write')) {
  const DOC = join(ROOT, 'docs/keyboard-shortcuts.md');
  const START = '<!-- BEGIN GENERATED SHORTCUTS -->';
  const END = '<!-- END GENERATED SHORTCUTS -->';
  const doc = readFileSync(DOC, 'utf8');
  if (!doc.includes(START) || !doc.includes(END)) {
    console.error(`Missing ${START} / ${END} markers in docs/keyboard-shortcuts.md`);
    process.exit(1);
  }
  const next =
    doc.slice(0, doc.indexOf(START) + START.length) +
    '\n' +
    table +
    '\n' +
    doc.slice(doc.indexOf(END));
  writeFileSync(DOC, next);
  console.log(`Wrote ${byKey.size} distinct keys to docs/keyboard-shortcuts.md`);
  process.exit(0);
}

console.log(table);
