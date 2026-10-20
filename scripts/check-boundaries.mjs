#!/usr/bin/env node
/**
 * Architecture boundary guard.
 *
 * The codebase is layered: the browser bundle (app/ modules/ services/ shared/)
 * must never reach into server code, the server must never import UI, modules
 * must not import each other sideways, and the known oversized files may only
 * shrink. Everything here is a static check on import specifiers and line
 * counts — no bundler, no execution — so it stays fast enough for every commit.
 */

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];
const notes = [];

function walk(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(absolute));
    } else if (/\.(?:ts|tsx|css|mjs)$/.test(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

function relative(absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join('/');
}

function countLines(absolutePath) {
  const content = fs.readFileSync(absolutePath, 'utf8');
  return content.split('\n').length;
}

/** Collect static import/export-from specifiers with their clause text. */
function readImports(absolutePath) {
  const source = fs.readFileSync(absolutePath, 'utf8');
  const imports = [];
  const pattern = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^;]*?)\s*from\s*['"]([^'"]+)['"]/g;
  let match;
  while ((match = pattern.exec(source))) {
    imports.push({ typeOnly: Boolean(match[1]), specifier: match[3] });
  }
  const sideEffectPattern = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g;
  while ((match = sideEffectPattern.exec(source))) {
    imports.push({ typeOnly: false, specifier: match[1] });
  }
  return imports;
}

function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) {
    return null;
  }
  const base = path.resolve(path.dirname(fromFile), specifier);
  return relative(base);
}

const serverFiles = walk(path.join(root, 'src/server'));
const clientRoots = ['src/app', 'src/modules', 'src/services', 'src/shared'].map((entry) =>
  path.join(root, entry),
);
const clientFiles = clientRoots.flatMap((directory) =>
  fs.existsSync(directory) ? walk(directory) : [],
);

// ---------------------------------------------------------------------------
// 1. The server must not import the browser bundle.
//
// src/shared is deliberately isomorphic (pure helpers used by both sides), so it
// is the one directory the server may reach into.
// ---------------------------------------------------------------------------
const forbiddenServerPrefixes = ['src/app/', 'src/modules/', 'src/services/', 'src/i18n'];
for (const file of serverFiles) {
  for (const { specifier } of readImports(file)) {
    const target = resolveSpecifier(file, specifier);
    if (!target) {
      continue;
    }
    if (forbiddenServerPrefixes.some((prefix) => target.startsWith(prefix)) || target === 'src/i18n.tsx') {
      failures.push(
        `${relative(file)} imports browser-bundle code "${specifier}" (${target}); the server layer must stay UI-free`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 2. The browser bundle must not import server code.
// ---------------------------------------------------------------------------
for (const file of clientFiles) {
  for (const { specifier } of readImports(file)) {
    const target = resolveSpecifier(file, specifier);
    if (target && (target === 'src/server' || target.startsWith('src/server/'))) {
      failures.push(
        `${relative(file)} imports server code "${specifier}"; call the HTTP API instead of bundling the server`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Modules must not import each other sideways (type-only crossings allowed).
// ---------------------------------------------------------------------------
let typeOnlyCrossings = 0;
for (const file of clientFiles) {
  const fromMatch = /^src\/modules\/([^/]+)\//.exec(relative(file));
  if (!fromMatch) {
    continue;
  }
  const fromModule = fromMatch[1];
  for (const { specifier, typeOnly } of readImports(file)) {
    const target = resolveSpecifier(file, specifier);
    const toMatch = target && /^src\/modules\/([^/]+)\//.exec(target);
    if (!toMatch || toMatch[1] === fromModule) {
      continue;
    }
    if (typeOnly) {
      typeOnlyCrossings += 1;
      continue;
    }
    failures.push(
      `${relative(file)} imports "${specifier}" across modules (${fromModule} -> ${toMatch[1]}); move the shared piece into src/shared`,
    );
  }
}

// ---------------------------------------------------------------------------
// 4. Size ratchet for the files this roadmap is shrinking.
//
// Budgets equal today's size on purpose: growth must be a deliberate edit here,
// which makes "just append to the monolith" a reviewed decision instead of a
// silent habit.
// ---------------------------------------------------------------------------
const lineBudgets = new Map([
  ['src/styles/global.css', 25061],
  ['src/styles/tokens.css', 219],
  // The dark layer holds three things: chrome overrides, the light workspace
  // island (28 variables, mirrored from tokens.css and asserted by
  // check-tokens.mjs), and the command palette. It does not grow per module —
  // module surfaces are migrated to tokens instead.
  ['src/styles/console.css', 701],
  ['src/styles/theme-dark.css', 234],
  ['src/app/App.tsx', 3024],
  ['src/services/apiClient.ts', 1874],
  ['src/server/app.ts', 1233],
  ['src/server/config.ts', 169],
  ['src/server/http/requestContext.ts', 189],
  ['src/modules/security/SecurityPanel.tsx', 9745],
  ['src/modules/servers/ServerInventory.tsx', 8030],
]);

const sizeReport = [];
for (const [file, budget] of lineBudgets) {
  const absolute = path.join(root, file);
  if (!fs.existsSync(absolute)) {
    failures.push(`budgeted file ${file} is missing`);
    continue;
  }
  const lines = countLines(absolute);
  sizeReport.push(`${file} ${lines}/${budget}`);
  if (lines > budget) {
    failures.push(`${file} grew to ${lines} lines (budget ${budget}); split it instead of extending it`);
  } else if (lines < budget) {
    notes.push(`${file} is ${budget - lines} lines under budget; lower the ratchet to ${lines} when convenient`);
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (failures.length > 0) {
  console.error('Architecture boundary check failed:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Architecture boundaries OK: ${serverFiles.length} server files, ${clientFiles.length} bundle files, ${typeOnlyCrossings} type-only module crossings.`,
);
console.log(`  size ratchet: ${sizeReport.join(' · ')}`);
for (const note of notes) {
  console.log(`  note: ${note}`);
}
