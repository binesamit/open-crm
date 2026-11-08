#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
/**
 * License keys — an offline tool for a provider (docs/LICENSING.md). Never shipped, never run by the server; the owner
 * console does the same with forms (Licensing → License server → "Create a signing key", and the Licenses screen).
 * The format is described in packages/shared/src/api/license.ts.
 *
 *   node scripts/license-tool.mjs keygen [--out .license-keys]
 *       Makes an Ed25519 key pair: <out>/license-private.pem (KEEP SECRET, never commit — `.license-keys/` is
 *       git-ignored) and <out>/license-public.pem. Set the private key as LICENSE_SIGNING_KEY on the server that
 *       issues keys; installations it serves store the public key beside the server's address (fetched on save).
 *
 *   node scripts/license-tool.mjs sign --key <private.pem> --licensee "Acme Ltd" --features saml,oidc
 *       [--expires 2027-12-31T23:59:59Z] [--id ACME-001] [--plan business] [--seats 50] [--instance <instance id>]
 *       [--grace-days 14] [--support standard]
 *       (The license server's owner console → Licensing → Licenses does the same with a form.)
 *   node scripts/license-tool.mjs sign --key <private.pem> --payload license.json
 *       Prints the license key (`lic1.<payload>.<signature>`) to stdout.
 *
 *   node scripts/license-tool.mjs verify --pub <public.pem> <key>
 *       Prints the payload if the signature holds (expiry is the server's job, but is reported here too).
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const PREFIX = 'lic1';
const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i > 0 ? args[i + 1] : undefined;
};
const fail = (msg) => {
  console.error(`license-tool: ${msg}`);
  process.exit(1);
};
const b64url = (buf) => Buffer.from(buf).toString('base64url');

if (cmd === 'keygen') {
  const out = path.resolve(opt('out') ?? '.license-keys');
  const priv = path.join(out, 'license-private.pem');
  if (existsSync(priv)) fail(`${priv} exists — refusing to overwrite a private key`);
  mkdirSync(out, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  writeFileSync(priv, privPem, { mode: 0o600 });
  // The same private key as one base64 line — the value of LICENSE_SIGNING_KEY in a hosting panel (Railway).
  const envFile = path.join(out, 'license-private.env-value.txt');
  writeFileSync(envFile, Buffer.from(privPem).toString('base64'), { mode: 0o600 });
  const pub = publicKey.export({ type: 'spki', format: 'pem' });
  writeFileSync(path.join(out, 'license-public.pem'), pub);
  console.log(
    `Private key: ${priv}  (keep it secret; never commit)\n` +
      `LICENSE_SIGNING_KEY value (one line, same secret): ${envFile}\nPublic key:\n${pub}`,
  );
} else if (cmd === 'sign') {
  const keyFile = opt('key') ?? fail('--key <private.pem> is required');
  let payload;
  const file = opt('payload');
  if (file) payload = JSON.parse(readFileSync(file, 'utf8'));
  else {
    const licensee = opt('licensee') ?? fail('--licensee is required (or --payload <file.json>)');
    const features = (opt('features') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    payload = { licensee, features, expires: opt('expires') ?? null, issued_at: new Date().toISOString() };
    if (opt('id')) payload.id = opt('id');
    // Editions (docs/LICENSING.md): all optional — keys without them stay valid (any installation, 14 days' grace).
    if (opt('plan')) payload.plan = opt('plan');
    if (opt('seats')) payload.seats = Number(opt('seats'));
    if (opt('instance')) payload.instance_id = opt('instance');
    if (opt('grace-days')) payload.grace_days = Number(opt('grace-days'));
    if (opt('support')) payload.support = opt('support');
  }
  if (payload.plan !== undefined && !['registered', 'business', 'enterprise'].includes(payload.plan))
    fail('--plan is registered | business | enterprise');
  if (payload.seats !== undefined && payload.seats !== null && !(Number.isInteger(payload.seats) && payload.seats > 0))
    fail('--seats is a positive whole number');
  if (payload.support !== undefined && !['community', 'standard', 'sla'].includes(payload.support))
    fail('--support is community | standard | sla');
  if (typeof payload.licensee !== 'string' || !Array.isArray(payload.features) || !('expires' in payload))
    fail('the payload needs { licensee, features[], expires (ISO date-time or null) }');
  if (payload.expires !== null && Number.isNaN(Date.parse(payload.expires))) fail('expires is not a date');
  const signed = `${PREFIX}.${b64url(JSON.stringify(payload))}`;
  const sig = sign(null, Buffer.from(signed), createPrivateKey(readFileSync(keyFile)));
  console.log(`${signed}.${b64url(sig)}`);
} else if (cmd === 'verify') {
  const pubFile = opt('pub') ?? fail('--pub <public.pem> is required');
  const key = args[args.length - 1];
  const [prefix, body, sig] = key.split('.');
  if (prefix !== PREFIX || !body || !sig) fail('not a license key');
  const ok = verify(
    null,
    Buffer.from(`${prefix}.${body}`),
    createPublicKey(readFileSync(pubFile)),
    Buffer.from(sig, 'base64url'),
  );
  if (!ok) fail('bad signature');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  const expired = payload.expires !== null && Date.parse(payload.expires) <= Date.now();
  console.log(JSON.stringify({ ...payload, expired }, null, 2));
} else {
  console.log(
    'usage: license-tool.mjs keygen [--out dir] | sign --key <pem> (--payload <json> | --licensee X --features a,b [--expires ISO] [--id ID] [--plan P] [--seats N] [--instance ID] [--grace-days N] [--support S]) | verify --pub <pem> <key>',
  );
  process.exit(cmd ? 1 : 0);
}
