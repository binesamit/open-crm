#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Dependency license check (open-source preparation, stage ק4).
 *
 * Reads `pnpm licenses list --prod --json` (the production dependency tree of every workspace package) and checks each
 * package's license against scripts/license-policy.json:
 *   - allowed  — passes (checked first, so BSL-1.0 = Boost passes while BSL/BUSL = Business Source fails);
 *   - denied   — GPL/AGPL/LGPL/SSPL/BSL/BUSL/FSL/... — fails;
 *   - anything else (no license, "SEE LICENSE IN", a custom string) is "unknown" — fails.
 * SPDX expressions are evaluated: `A OR B` passes if either side passes, `A AND B` only if both do; `WITH <exception>`
 * is judged by its license. A package listed under "exceptions" (name + exact license string + reason) passes.
 *
 * Usage:
 *   node scripts/check-licenses.mjs                    check; exit 1 on a violation (`pnpm check:licenses`, CI)
 *   node scripts/check-licenses.mjs --write-notices    also (re)write THIRD-PARTY-NOTICES.md (`pnpm licenses:notices`)
 *   node scripts/check-licenses.mjs --check-notices    also warn (never fail) when THIRD-PARTY-NOTICES.md is stale
 *   --input <file>                                     read a saved `pnpm licenses list --prod --json` instead
 * Before checking it runs a small self-test of the expression rules, so a broken rule fails loudly.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POLICY_FILE = path.join(ROOT, 'scripts', 'license-policy.json');
const NOTICES_FILE = path.join(ROOT, 'THIRD-PARTY-NOTICES.md');

// ---------- SPDX expression evaluation ----------

const tokenize = (expr) => expr.replace(/\(/g, ' ( ').replace(/\)/g, ' ) ').trim().split(/\s+/).filter(Boolean);

/** Parse an SPDX expression into a tree: { op: 'OR'|'AND', args } or { id }. Throws on malformed input. */
export const parseExpression = (expr) => {
  const tokens = tokenize(expr);
  let i = 0;
  const atom = () => {
    const tok = tokens[i++];
    if (tok === undefined) throw new Error(`unexpected end of "${expr}"`);
    if (tok === '(') {
      const inner = orExpr();
      if (tokens[i++] !== ')') throw new Error(`missing ) in "${expr}"`);
      return inner;
    }
    if (tok === ')' || /^(AND|OR|WITH)$/i.test(tok)) throw new Error(`unexpected "${tok}" in "${expr}"`);
    // `X WITH Y`: judged by X (the exception only adds permissions).
    if (/^WITH$/i.test(tokens[i] ?? '')) i += 2;
    return { id: tok.replace(/\+$/, '') };
  };
  const andExpr = () => {
    const args = [atom()];
    while (/^AND$/i.test(tokens[i] ?? '')) (i++, args.push(atom()));
    return args.length === 1 ? args[0] : { op: 'AND', args };
  };
  const orExpr = () => {
    const args = [andExpr()];
    while (/^OR$/i.test(tokens[i] ?? '')) (i++, args.push(andExpr()));
    return args.length === 1 ? args[0] : { op: 'OR', args };
  };
  const tree = orExpr();
  if (i !== tokens.length) throw new Error(`trailing "${tokens.slice(i).join(' ')}" in "${expr}"`);
  return tree;
};

/** 'allowed' | 'denied' | 'unknown' for one license id. */
export const classifyId = (id, policy) => {
  if (policy.allowed.includes(id)) return 'allowed';
  const upper = id.toUpperCase();
  if (policy.denied.some((p) => upper === p.toUpperCase() || upper.startsWith(p.toUpperCase()))) return 'denied';
  return 'unknown';
};

const RANK = { allowed: 0, unknown: 1, denied: 2 };
const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);
const best = (a, b) => (RANK[a] <= RANK[b] ? a : b);

/** Verdict for a whole license string (an SPDX expression, or anything a package.json may hold). */
export const classifyLicense = (license, policy) => {
  if (typeof license !== 'string' || !license.trim()) return 'unknown';
  let tree;
  try {
    tree = parseExpression(license);
  } catch {
    return 'unknown';
  }
  const evaluate = (node) => {
    if (node.id) return classifyId(node.id, policy);
    const verdicts = node.args.map(evaluate);
    return verdicts.reduce(node.op === 'OR' ? best : worst);
  };
  return evaluate(tree);
};

const selfTest = () => {
  const policy = { allowed: ['MIT', 'Apache-2.0', 'BSL-1.0', 'CC0-1.0'], denied: ['GPL', 'AGPL', 'BSL', 'FSL'] };
  const cases = [
    ['MIT', 'allowed'],
    ['(MIT OR Apache-2.0)', 'allowed'],
    ['(MIT OR GPL-3.0-only)', 'allowed'],
    ['MIT AND GPL-2.0', 'denied'],
    ['GPL-2.0-or-later', 'denied'],
    ['GPL-2.0+', 'denied'],
    ['GPL-2.0 WITH Classpath-exception-2.0', 'denied'],
    ['AGPL-3.0', 'denied'],
    ['BSL-1.0', 'allowed'],
    ['BSL-1.1', 'denied'],
    ['FSL-1.1-Apache-2.0', 'denied'],
    ['(MIT OR CC0-1.0) AND Apache-2.0', 'allowed'],
    ['SEE LICENSE IN LICENSE.md', 'unknown'],
    ['Unknown', 'unknown'],
    ['', 'unknown'],
    ['(MIT', 'unknown'],
  ];
  for (const [license, expected] of cases) {
    const got = classifyLicense(license, policy);
    if (got !== expected) throw new Error(`license self-test: "${license}" -> ${got}, expected ${expected}`);
  }
};

// ---------- input ----------

const argValue = (flag) => {
  const at = process.argv.indexOf(flag);
  return at === -1 ? undefined : process.argv[at + 1];
};

/** Flatten pnpm's `{ [license]: [{ name, versions, paths, license, author, homepage }] }` into one row per version. */
const loadPackages = () => {
  const input = argValue('--input');
  const raw = input
    ? readFileSync(input, 'utf8')
    : execSync('pnpm licenses list --prod --json', { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const byLicense = JSON.parse(raw);
  const rows = [];
  for (const [groupLicense, pkgs] of Object.entries(byLicense)) {
    for (const pkg of pkgs) {
      pkg.versions.forEach((version, n) => {
        rows.push({
          name: pkg.name,
          version,
          license: pkg.license ?? groupLicense,
          author: pkg.author,
          homepage: pkg.homepage,
          dir: pkg.paths?.[n] ?? pkg.paths?.[0],
        });
      });
    }
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
};

// ---------- THIRD-PARTY-NOTICES.md ----------

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

/** Platform-specific binaries (`os`/`cpu` in package.json) differ per machine; leave them out so the file is stable. */
const isPlatformBinary = (row) => {
  const manifest = row.dir ? readJson(path.join(row.dir, 'package.json')) : undefined;
  return Boolean(manifest && (manifest.os || manifest.cpu));
};

const licenseTexts = (dir) => {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying|notice)([.-].*)?$/i.test(f))
    .sort()
    .map((f) => ({ file: f, text: readFileSync(path.join(dir, f), 'utf8').replace(/\r\n/g, '\n').trim() }));
};

/** Third-party files shipped in the repository itself (fonts…), listed in the policy's "bundled". */
const bundledOf = (policy) =>
  (policy.bundled ?? []).map((b) => ({
    ...b,
    texts: b.files.map((f) => ({
      file: f,
      text: readFileSync(path.join(ROOT, b.path, f), 'utf8')
        .replace(/\r\n/g, '\n')
        .trim(),
    })),
  }));

const renderNotices = (rows, bundled = []) => {
  const listed = rows.filter((r) => !isPlatformBinary(r));
  const out = [
    '# Third-party notices',
    '',
    'This project depends on the open-source packages below (production dependencies of every workspace package, as',
    'reported by `pnpm licenses list --prod`; platform-specific binary builds are omitted). Each is used under its own',
    'license, reproduced here. Generated by `pnpm licenses:notices` (`scripts/check-licenses.mjs`) — do not edit by hand.',
    '',
    '**Trademarks.** The Google and Microsoft logos on the "Sign in with…" buttons, and the names Google and',
    'Microsoft, are trademarks of their owners. They are not covered by the AGPL or by any license in this',
    "file, and are used only as each owner's branding guidelines allow. This project is not affiliated with any of them.",
    '',
    '| Package | Version | License |',
    '| --- | --- | --- |',
    ...listed.map((r) => `| ${r.name} | ${r.version} | ${r.license} |`),
    '',
  ];
  for (const r of listed) {
    out.push(`## ${r.name}@${r.version}`, '', `License: ${r.license}`);
    if (r.homepage) out.push(`Homepage: ${r.homepage}`);
    out.push('');
    const texts = licenseTexts(r.dir);
    if (!texts.length) out.push('_No license file is shipped in the package; see its license field above._', '');
    for (const t of texts) out.push(`${t.file}:`, '', '~~~~text', t.text, '~~~~', '');
  }
  if (bundled.length) {
    out.push('# Bundled files', '', 'Shipped in this repository itself (not npm packages):', '');
    for (const b of bundled) {
      out.push(
        `## ${b.name} ${b.version}`,
        '',
        `License: ${b.license}`,
        `Homepage: ${b.homepage}`,
        `Location: ${b.path}`,
      );
      if (b.use) out.push(`Use: ${b.use}`);
      out.push('');
      for (const t of b.texts) out.push(`${t.file}:`, '', '~~~~text', t.text, '~~~~', '');
    }
  }
  return out.join('\n');
};

// ---------- main ----------

const main = () => {
  selfTest();
  const policy = JSON.parse(readFileSync(POLICY_FILE, 'utf8'));
  const rows = loadPackages();
  const bundled = bundledOf(policy);

  const problems = [];
  const excepted = [];
  for (const r of rows) {
    const verdict = classifyLicense(r.license, policy);
    if (verdict === 'allowed') continue;
    const exception = policy.exceptions.find((e) => e.package === r.name && e.license === r.license);
    if (exception) excepted.push(`${r.name}@${r.version} (${r.license}) — ${exception.reason}`);
    else problems.push(`${r.name}@${r.version}: ${r.license || '(none)'} — ${verdict}`);
  }
  // Bundled files: the same policy, and their license text must be there.
  for (const b of bundled) {
    const verdict = classifyLicense(b.license, policy);
    if (verdict !== 'allowed') problems.push(`${b.name} (bundled, ${b.path}): ${b.license} — ${verdict}`);
    if (!b.texts.every((t) => t.text)) problems.push(`${b.name} (bundled): empty license file`);
  }
  // Exceptions that no longer match anything should be removed, so the allowlist never grows stale.
  const unused = policy.exceptions.filter((e) => !rows.some((r) => r.name === e.package && r.license === e.license));

  const counts = {};
  for (const r of rows) counts[r.license] = (counts[r.license] ?? 0) + 1;
  console.log(`Checked ${rows.length} production packages:`);
  for (const [lic, n] of Object.entries(counts).sort((a, b) => b[1] - a[1])) console.log(`  ${lic}: ${n}`);
  for (const e of excepted) console.log(`allowed by exception: ${e}`);
  for (const e of unused)
    console.log(`::warning::license exception for "${e.package}" (${e.license}) matches nothing — remove it`);

  if (process.argv.includes('--write-notices')) {
    writeFileSync(NOTICES_FILE, renderNotices(rows, bundled));
    console.log(`wrote ${path.relative(ROOT, NOTICES_FILE)}`);
  } else if (process.argv.includes('--check-notices')) {
    const current = existsSync(NOTICES_FILE) ? readFileSync(NOTICES_FILE, 'utf8').replace(/\r\n/g, '\n') : '';
    if (current !== renderNotices(rows, bundled))
      console.log('::warning::THIRD-PARTY-NOTICES.md is out of date — run `pnpm licenses:notices` and commit it');
  }

  if (problems.length) {
    console.error(`\n${problems.length} dependency license problem(s):`);
    for (const p of problems) console.error(`  ${p}`);
    console.error(
      '\nReplace the package, or (if it is acceptable) add it to scripts/license-policy.json "exceptions" with a reason.',
    );
    process.exit(1);
  }
  console.log('License check passed.');
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
