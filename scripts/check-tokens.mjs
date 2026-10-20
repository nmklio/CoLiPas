#!/usr/bin/env node
/**
 * Design-token guard.
 *
 * Enforces the two-layer token contract that makes theming cheap and keeps the
 * light theme frozen while the dark theme is added:
 *
 *   1. tokens.css is the only place colour/spacing/type variables are declared.
 *   2. Every historical semantic variable resolves to its original light value,
 *      so introducing the indirection cannot move a single pixel in light mode.
 *   3. The dark block must cover the full semantic surface.
 *   4. Text pairs used by components must meet WCAG AA.
 *   5. Hard-coded colour literals in global.css may only decrease (ratchet).
 *
 * Run standalone (`node scripts/check-tokens.mjs`) or as part of
 * `node scripts/verify-production.mjs`.
 */

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const failures = [];
const notes = [];

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function check(condition, message) {
  if (!condition) {
    failures.push(message);
  }
  return Boolean(condition);
}

function normalize(value) {
  return String(value)
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .trim();
}

/** Extract the declaration body of the first `selector {` block. */
function extractBlock(source, selector) {
  const start = source.indexOf(selector);
  if (start < 0) {
    return '';
  }
  const open = source.indexOf('{', start);
  if (open < 0) {
    return '';
  }
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open + 1, index);
      }
    }
  }
  return '';
}

function parseDeclarations(body) {
  const declarations = new Map();
  const pattern = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
  let match;
  while ((match = pattern.exec(body))) {
    declarations.set(match[1].toLowerCase(), match[2].trim());
  }
  return declarations;
}

/** Resolve `var(--x)` chains against a declaration map. */
function resolve(declarations, name, depth = 0) {
  const raw = declarations.get(name);
  if (!raw || depth > 8) {
    return null;
  }
  const reference = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(raw.trim());
  if (!reference) {
    return raw;
  }
  return resolve(declarations, reference[1].toLowerCase(), depth + 1);
}

// ---------------------------------------------------------------------------
// 1. Single source of truth
// ---------------------------------------------------------------------------

const tokensCss = read('src/styles/tokens.css');
const globalCss = read('src/styles/global.css');
const themeDarkCss = read('src/styles/theme-dark.css');
const mainTsx = read('src/main.tsx');

const lightBody = extractBlock(tokensCss, ':root');
const darkBody = extractBlock(tokensCss, '[data-theme="dark"]');
const light = parseDeclarations(lightBody);
const dark = parseDeclarations(darkBody);

check(light.size >= 80, `tokens.css must declare at least 80 variables in :root (found ${light.size})`);
check(dark.size >= 18, `tokens.css must override at least 18 variables for dark (found ${dark.size})`);

const legacyNames = [
  '--bg',
  '--panel',
  '--panel-strong',
  '--surface',
  '--surface-strong',
  '--text',
  '--muted',
  '--line',
  '--line-strong',
  '--brand',
  '--brand-strong',
  '--brand-soft',
  '--brand-line',
  '--sidebar',
  '--sidebar-strong',
  '--blue',
  '--orange',
  '--red',
  '--green',
  '--shadow',
  '--shadow-soft',
  '--focus-ring',
];

/** Frozen light-mode values. Light mode is the contract: moving one of these is a reviewed redesign decision. */
const frozenLightValues = {
  '--bg': '#f4f7f8',
  '--panel': '#ffffff',
  '--panel-strong': '#eef5f6',
  '--surface': '#fbfdfd',
  '--surface-strong': '#f7fbfb',
  '--text': '#122329',
  '--muted': '#64747b',
  '--line': '#e8e8e8',
  '--line-strong': '#dcdcdc',
  '--brand': '#0052d9',
  '--brand-strong': '#003cab',
  '--brand-soft': '#f2f3ff',
  '--brand-line': '#b5c7ff',
  '--sidebar': '#10262b',
  '--sidebar-strong': '#18343a',
  '--blue': '#246b86',
  '--orange': '#b86a17',
  '--red': '#b43737',
  '--green': '#16774e',
  '--shadow': '0 16px 38px rgba(18,35,41,0.08)',
  '--shadow-soft': '0 8px 20px rgba(18,35,41,0.055)',
  '--focus-ring': '0 0 0 3px rgba(0,82,217,0.16)',
};

const resolvedLight = new Map();
for (const name of legacyNames) {
  const value = resolve(light, name);
  if (!check(value !== null, `tokens.css must define ${name} in :root`)) {
    continue;
  }
  resolvedLight.set(name, value);
  const expected = frozenLightValues[name];
  if (check(expected !== undefined, `no frozen baseline recorded for ${name}`)) {
    check(
      normalize(value) === normalize(expected),
      `light-mode contract broken: ${name} resolves to "${value}" but must stay "${expected}"`,
    );
  }
}

/** global.css must not re-declare the semantic layer (that would silently win on cascade order). */
for (const name of legacyNames) {
  const redeclared = new RegExp(`${name}\\s*:`, 'i').test(globalCss);
  check(!redeclared, `global.css re-declares ${name}; declare it only in tokens.css`);
}
check(!/color-scheme\s*:/i.test(globalCss), 'global.css must not set color-scheme; tokens.css owns it');

// ---------------------------------------------------------------------------
// 2. Dark coverage
// ---------------------------------------------------------------------------

const requiredDarkKeys = [
  '--bg',
  '--panel',
  '--panel-strong',
  '--surface',
  '--surface-strong',
  '--text',
  '--muted',
  '--line',
  '--line-strong',
  '--brand',
  '--brand-strong',
  '--brand-soft',
  '--brand-line',
  '--sidebar',
  '--sidebar-strong',
  '--blue',
  '--orange',
  '--red',
  '--green',
  '--shadow',
  '--shadow-soft',
  '--focus-ring',
];
for (const key of requiredDarkKeys) {
  check(dark.has(key), `dark theme must override ${key}`);
}
check(/color-scheme\s*:\s*dark/i.test(darkBody), 'dark theme must set color-scheme: dark');

// ---------------------------------------------------------------------------
// 3. Stylesheet wiring
// ---------------------------------------------------------------------------

const tokensIndex = mainTsx.indexOf('./styles/tokens.css');
const globalIndex = mainTsx.indexOf('./styles/global.css');
const darkIndex = mainTsx.indexOf('./styles/theme-dark.css');
check(tokensIndex >= 0, 'src/main.tsx must import ./styles/tokens.css');
check(globalIndex >= 0, 'src/main.tsx must import ./styles/global.css');
check(darkIndex >= 0, 'src/main.tsx must import ./styles/theme-dark.css');
if (tokensIndex >= 0 && globalIndex >= 0) {
  check(tokensIndex < globalIndex, 'tokens.css must be imported before global.css');
}
if (globalIndex >= 0 && darkIndex >= 0) {
  check(globalIndex < darkIndex, 'theme-dark.css must be imported after global.css (it is an override layer)');
}
check(
  /data-theme/.test(themeDarkCss),
  'theme-dark.css rules must be scoped under [data-theme="dark"]',
);
const unscopedRule = [...themeDarkCss.matchAll(/^([^@/\s[][^{]*)\{/gm)]
  .map((match) => match[1].trim())
  .filter((selector) => selector && !selector.includes('[data-theme="dark"]'));
check(unscopedRule.length === 0, `theme-dark.css has unscoped selectors: ${unscopedRule.join(', ')}`);

// ---------------------------------------------------------------------------
// 3b. Light workspace island
//
// global.css still hard-codes light literals inside the modules, so theme-dark.css
// keeps <main> on the light palette until each module is migrated. The island must
// mirror light mode exactly — otherwise it silently becomes a third theme.
// ---------------------------------------------------------------------------

const islandMarker = '/* __LIGHT_ISLAND__ */';
if (
  check(
    themeDarkCss.includes(islandMarker),
    'theme-dark.css must keep the light workspace island marker (modules are not token-migrated yet)',
  )
) {
  const islandBody = extractBlock(themeDarkCss, '\n  main {');
  const island = parseDeclarations(islandBody);
  check(islandBody.includes(islandMarker), 'the light workspace island marker must live inside the main { } block');
  check(
    /color-scheme\s*:\s*light/i.test(islandBody),
    'the light workspace island must set color-scheme: light so native controls stay light',
  );
  for (const key of dark.keys()) {
    if (!check(island.has(key), `the light workspace island must re-declare ${key} so it matches light mode`)) {
      continue;
    }
    const islandResolved = resolve(new Map([...light, ...island]), key);
    const lightResolved = resolve(light, key);
    if (islandResolved === null || lightResolved === null) {
      failures.push(`cannot resolve the island/light value for ${key}`);
      continue;
    }
    check(
      normalize(islandResolved) === normalize(lightResolved),
      `island ${key} resolves to "${islandResolved}" but light mode uses "${lightResolved}"`,
    );
  }
  // Custom properties are substituted where they are declared, so an alias such
  // as --border: var(--line) keeps the chrome's dark --line forever unless the
  // island re-declares it. Require every alias that depends on a flipped key.
  const flipDependentAliases = [...light.keys()].filter((key) => {
    if (dark.has(key)) {
      return false;
    }
    const raw = light.get(key)?.trim() ?? '';
    const reference = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(raw);
    if (!reference) {
      return false;
    }
    let cursor = reference[1].toLowerCase();
    for (let depth = 0; depth < 8 && cursor; depth += 1) {
      if (dark.has(cursor)) {
        return true;
      }
      const next = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec((light.get(cursor) ?? '').trim());
      cursor = next ? next[1].toLowerCase() : null;
    }
    return false;
  });
  for (const key of flipDependentAliases) {
    if (!check(island.has(key), `the light workspace island must re-declare alias ${key} or it keeps the dark value`)) {
      continue;
    }
    const islandResolved = resolve(new Map([...light, ...island]), key);
    const lightResolved = resolve(light, key);
    check(
      islandResolved !== null && lightResolved !== null && normalize(islandResolved) === normalize(lightResolved),
      `island alias ${key} resolves to "${islandResolved}" but light mode uses "${lightResolved}"`,
    );
  }
  const allowedIslandKeys = new Set([...dark.keys(), ...flipDependentAliases]);
  const extraIslandKeys = [...island.keys()].filter((key) => !allowedIslandKeys.has(key));
  check(
    extraIslandKeys.length === 0,
    `the light workspace island declares variables the dark theme never flips: ${extraIslandKeys.join(', ')}`,
  );
}

// ---------------------------------------------------------------------------
// 4. Contrast (WCAG AA)
// ---------------------------------------------------------------------------

function relativeLuminance(hex) {
  const value = hex.replace('#', '');
  const expanded =
    value.length === 3
      ? value
          .split('')
          .map((char) => char + char)
          .join('')
      : value;
  const channels = [0, 2, 4]
    .map((offset) => parseInt(expanded.slice(offset, offset + 2), 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground, background) {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

function resolveSolid(declarations, name) {
  const value = resolve(declarations, name);
  return value && /^#[0-9a-f]{3,8}$/i.test(value.trim()) ? value.trim() : null;
}

const contrastPairs = [
  // [label, foreground token, background token, minimum ratio]
  ['light body text', '--text', '--bg', 4.5],
  ['light text on panel', '--text', '--panel', 4.5],
  ['light muted text', '--muted', '--bg', 4.5],
  ['light muted on panel', '--muted', '--panel', 4.5],
  ['light brand on panel', '--brand', '--panel', 4.5],
  ['light danger on panel', '--red', '--panel', 4.5],
  ['light success on panel', '--green', '--panel', 4.5],
  // Status tones double as icon/large-text colours, so 3:1 (WCAG AA graphics).
  ['light warning on panel', '--orange', '--panel', 3.0],
  ['dark body text', '--text', '--bg', 4.5],
  ['dark text on panel', '--text', '--panel', 4.5],
  ['dark muted text', '--muted', '--bg', 4.5],
  ['dark muted on panel', '--muted', '--panel', 4.5],
  ['dark brand on panel', '--brand', '--panel', 4.5],
  ['dark danger on panel', '--red', '--panel', 4.5],
  ['dark success on panel', '--green', '--panel', 4.5],
  ['dark warning on panel', '--orange', '--panel', 3.0],
];

const contrastReport = [];
for (const [label, foregroundToken, backgroundToken, minimum] of contrastPairs) {
  const isDark = label.startsWith('dark');
  const declarations = isDark ? new Map([...light, ...dark]) : light;
  const foreground = resolveSolid(declarations, foregroundToken);
  const background = resolveSolid(declarations, backgroundToken);
  if (!foreground || !background) {
    failures.push(`cannot resolve colours for contrast pair "${label}"`);
    continue;
  }
  const ratio = contrastRatio(foreground, background);
  contrastReport.push(`${label}: ${ratio.toFixed(2)}:1`);
  check(
    ratio >= minimum,
    `contrast ${label} is ${ratio.toFixed(2)}:1, below the ${minimum}:1 requirement (${foreground} on ${background})`,
  );
}

// ---------------------------------------------------------------------------
// 5. Literal-colour ratchet
// ---------------------------------------------------------------------------

const literalBudget = 1896;
const literalCount = (globalCss.match(/#[0-9a-f]{3,8}\b/gi) ?? []).length;
check(
  literalCount <= literalBudget,
  `global.css gained hard-coded colour literals: ${literalCount} > budget ${literalBudget}. Use a token instead.`,
);
if (literalCount < literalBudget) {
  notes.push(
    `hard-coded colours in global.css: ${literalCount} (budget ${literalBudget}) — lower the budget in scripts/check-tokens.mjs to ${literalCount} to lock the gain in.`,
  );
}

/** theme-dark.css is an override layer, not a second palette: keep it literal-free. */
const darkLiteralBudget = 3;
const darkLiteralCount = (themeDarkCss.match(/#[0-9a-f]{3,8}\b/gi) ?? []).length;
check(
  darkLiteralCount <= darkLiteralBudget,
  `theme-dark.css gained hard-coded colour literals: ${darkLiteralCount} > budget ${darkLiteralBudget}. Reuse the island or a token instead.`,
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error('Design token check failed:');
  for (const failure of failures) {
    console.error(`  - ${failure}`);
  }
  process.exit(1);
}

console.log(
  `Design tokens OK: ${light.size} light variables, ${dark.size} dark overrides, ${contrastReport.length} contrast pairs, ${literalCount}/${literalBudget} literal colours.`,
);
for (const note of notes) {
  console.log(`  note: ${note}`);
}
console.log(`  contrast: ${contrastReport.join(' · ')}`);
