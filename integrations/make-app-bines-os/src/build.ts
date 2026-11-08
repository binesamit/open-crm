// SPDX-License-Identifier: MIT
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { format } from 'prettier';
import {
  app,
  base,
  connection,
  CONNECTION,
  groups,
  MODULE_TYPE,
  modules,
  PRODUCT_NAME,
  rpcs,
  webhooks,
} from './spec.ts';
import { ICON_FILE, renderIcon } from './icon.ts';

/**
 * Writes the app to `app/` — one JSON file per Make section, the layout `scripts/push.ts` uploads:
 *
 *   app/app.json                         name, label, theme + the index of every component (types, labels, links)
 *   app/base.json, app/groups.json, app/readme.md
 *   app/connections/<name>/{api,parameters}.json
 *   app/webhooks/<name>/{api,parameters,attach,detach}.json
 *   app/rpcs/<name>/{api,parameters}.json
 *   app/modules/<name>/{api,parameters,expect,interface,samples}.json
 *
 * …and the app's icon, `assets/icon.png` (`src/icon.ts`; pushed with `PUT /sdk/apps/{name}/{version}/icon`).
 *
 * No `functions/`: the app uses Make's built-in IML only (custom IML functions need Make support to enable them).
 *
 * `pnpm --filter make-app-bines-os build` after changing `spec.ts`; the tests fail while `app/` is out of date.
 */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const APP_DIR = join(ROOT, 'app');

const prettierConfig = JSON.parse(readFileSync(join(ROOT, '..', '..', '.prettierrc.json'), 'utf8')) as object;
const json = (v: unknown) => format(JSON.stringify(v), { ...prettierConfig, parser: 'json' });

const readme = () => {
  const kinds = { instant: 'Instant triggers', action: 'Actions', search: 'Searches', universal: 'Universal' } as const;
  const lines = [
    `# ${PRODUCT_NAME}`,
    '',
    app.description,
    '',
    `Connect with your ${PRODUCT_NAME} address and a personal API token (profile menu → API tokens). The token acts as you, limited to its scopes and boards.`,
    '',
  ];
  for (const [kind, title] of Object.entries(kinds)) {
    lines.push(`## ${title}`, '');
    for (const m of Object.values(modules).filter((x) => x.kind === kind))
      lines.push(`- **${m.label}** — ${m.description}`);
    lines.push('');
  }
  return lines.join('\n');
};

/** Every generated file: path relative to `app/` → content. */
export const buildFiles = async (): Promise<Map<string, string>> => {
  const files = new Map<string, string>();
  const put = async (path: string, value: unknown) => files.set(path, await json(value));

  await put('app.json', {
    ...app,
    connections: { [CONNECTION]: { label: connection.label, type: connection.type } },
    webhooks: Object.fromEntries(
      Object.entries(webhooks).map(([k, w]) => [k, { label: w.label, type: 'web', connection: CONNECTION }]),
    ),
    rpcs: Object.fromEntries(Object.entries(rpcs).map(([k, r]) => [k, { label: r.label, connection: CONNECTION }])),
    modules: Object.fromEntries(
      Object.entries(modules).map(([k, m]) => [
        k,
        {
          typeId: MODULE_TYPE[m.kind],
          label: m.label,
          description: m.description,
          connection: m.webhook ? null : CONNECTION,
          webhook: m.webhook ?? null,
        },
      ]),
    ),
  });
  await put('base.json', base);
  await put('groups.json', groups);
  files.set('readme.md', readme());
  await put(`connections/${CONNECTION}/api.json`, connection.api);
  await put(`connections/${CONNECTION}/parameters.json`, connection.parameters);
  for (const [k, w] of Object.entries(webhooks)) {
    for (const section of ['api', 'parameters', 'attach', 'detach'] as const)
      await put(`webhooks/${k}/${section}.json`, w[section]);
  }
  for (const [k, r] of Object.entries(rpcs)) {
    await put(`rpcs/${k}/api.json`, r.api);
    await put(`rpcs/${k}/parameters.json`, r.parameters);
  }
  for (const [k, m] of Object.entries(modules)) {
    if (m.api !== undefined) await put(`modules/${k}/api.json`, m.api);
    await put(`modules/${k}/parameters.json`, m.parameters ?? []);
    await put(`modules/${k}/expect.json`, m.expect ?? []);
    await put(`modules/${k}/interface.json`, m.interface);
    await put(`modules/${k}/samples.json`, m.samples ?? {});
  }
  return files;
};

const main = async () => {
  for (const dir of ['connections', 'webhooks', 'rpcs', 'modules', 'functions'])
    rmSync(join(APP_DIR, dir), { recursive: true, force: true });
  const files = await buildFiles();
  for (const [path, content] of files) {
    const full = join(APP_DIR, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  console.warn(`wrote ${files.size} files to app/`);
  mkdirSync(join(ROOT, 'assets'), { recursive: true });
  writeFileSync(join(ROOT, ICON_FILE), renderIcon());
  console.warn(`wrote ${ICON_FILE}`);
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
