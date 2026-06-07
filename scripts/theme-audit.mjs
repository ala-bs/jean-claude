#!/usr/bin/env node
/**
 * Finds hardcoded colors / palette classes outside theme token files.
 *
 * Usage:
 *   node scripts/theme-audit.mjs              # full scan
 *   node scripts/theme-audit.mjs --base main  # only files changed vs ref
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

const EXCLUDE_DIRS = [
  'src/styles/themes/',
  'node_modules/',
  'out/',
  'dist/',
];

const PATTERNS = [
  { name: 'oklch()', re: /oklch\s*\(/ },
  { name: 'hex color', re: /#[0-9a-fA-F]{3,8}\b/ },
  { name: 'arbitrary bg hex', re: /bg-\[#/ },
  { name: 'text-white', re: /\btext-white\b/ },
  { name: 'amber/orange palette', re: /\b(?:bg|text|border)-(?:amber|orange)-/ },
  {
    name: 'semantic tailwind palette',
    re: /\b(?:bg|text|border)-(?:green|red|blue|yellow|emerald|rose|sky)-(?:\d{2,3}|\[)/,
  },
];

function parseArgs(argv) {
  const baseIdx = argv.indexOf('--base');
  return {
    base: baseIdx === -1 ? null : argv[baseIdx + 1],
  };
}

function loadAllowlist() {
  const file = path.join(ROOT, 'scripts/theme-audit-allowlist.txt');
  if (!fs.existsSync(file)) return new Set();
  return new Set(
    fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#')),
  );
}

function isExcluded(filePath, allowlist) {
  if (allowlist.has(filePath)) return true;
  return EXCLUDE_DIRS.some((dir) => filePath.startsWith(dir));
}

function listSourceFiles() {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(ROOT, full).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'dist')
          continue;
        walk(full);
        continue;
      }
      if (entry.isFile() && /\.(tsx|css)$/.test(entry.name)) files.push(rel);
    }
  }
  walk(path.join(ROOT, 'src'));
  return files;
}

function changedFiles(base) {
  try {
    const out = execSync(`git diff --name-only ${base}...HEAD`, {
      cwd: ROOT,
      encoding: 'utf8',
    });
    return out
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f && /\.(tsx|css)$/.test(f) && f.startsWith('src/'));
  } catch {
    console.error(`theme-audit: could not diff against "${base}"`);
    process.exit(2);
  }
}

function scanFile(filePath) {
  const content = fs.readFileSync(path.join(ROOT, filePath), 'utf8');
  const lines = content.split('\n');
  const hits = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('// theme-audit:ignore')) continue;
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) {
        hits.push({ line: i + 1, rule: name, text: line.trim() });
        break;
      }
    }
  }
  return hits;
}

const { base } = parseArgs(process.argv.slice(2));
const allowlist = loadAllowlist();
const candidates = base ? changedFiles(base) : listSourceFiles();
const files = candidates.filter((f) => !isExcluded(f, allowlist));

const report = [];
for (const file of files) {
  const hits = scanFile(file);
  if (hits.length > 0) report.push({ file, hits });
}

if (report.length === 0) {
  const scope = base ? `changed files vs ${base}` : 'src';
  console.log(`theme-audit: no hardcoded theme issues in ${scope}.`);
  process.exit(0);
}

console.error('theme-audit: hardcoded colors / palette classes found:\n');
for (const { file, hits } of report) {
  console.error(file);
  for (const h of hits) {
    console.error(`  L${h.line} [${h.rule}] ${h.text}`);
  }
  console.error('');
}

const total = report.reduce((n, r) => n + r.hits.length, 0);
console.error(
  `${total} issue(s) in ${report.length} file(s). Map to theme tokens or add path to scripts/theme-audit-allowlist.txt`,
);
console.error('Suppress one line with: // theme-audit:ignore');
process.exit(1);
