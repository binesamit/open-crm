// SPDX-License-Identifier: MIT
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extensionManifestSchema, isLocalOrigin } from '@bines/shared';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error — a plain .mjs module (the CLI is dependency-free JavaScript).
import { repoSdkDir, scaffold, SDK_VERSION, sdkSpec, validId } from '../scaffold.mjs';

/** create-bines-app (D27 ת8): the template becomes a working extension whose manifest the platform accepts. */
const dirs: string[] = [];
const fresh = () => {
  const d = mkdtempSync(join(tmpdir(), 'bines-app-'));
  dirs.push(d);
  return join(d, 'app');
};
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

const manifestOf = async (dir: string, origin: string, serverOrigin?: string) => {
  const mod = (await import(pathToFileURL(join(dir, 'manifest.config.mjs')).href)) as {
    manifest: (o: string, s?: string) => unknown;
  };
  return mod.manifest(origin, serverOrigin);
};

describe('create-bines-app', () => {
  it('a board view: files filled in, no server part, a manifest the platform validates', async () => {
    const dir = fresh();
    const files: string[] = scaffold({ dir, id: 'my-view', name: 'My view', port: 5190 });
    expect(files).toEqual(
      expect.arrayContaining([
        '.gitignore',
        'README.md',
        'index.html',
        'manifest.config.mjs',
        'package.json',
        'src/main.ts',
      ]),
    );
    expect(files.some((f) => f.startsWith('server/'))).toBe(false);
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(pkg.name).toBe('my-view');
    expect(pkg.dependencies['@bines/ext-sdk']).toMatch(/^file:.*ext-sdk$/);
    expect(readFileSync(join(dir, 'vite.config.ts'), 'utf8')).toContain("Number('5190')");
    for (const f of files) expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/__[A-Z_]+__/);
    const local = extensionManifestSchema.parse(await manifestOf(dir, 'http://localhost:5190'));
    expect(local).toMatchObject({ id: 'my-view', name: 'My view', permissions: ['boards:read'] });
    expect(local.origins.every(isLocalOrigin)).toBe(true);
    expect(local.server).toBeUndefined();
    // The production manifest: https, the same features.
    const prod = extensionManifestSchema.parse(await manifestOf(dir, 'https://ext.example.com'));
    expect(prod.features[0]!.url).toBe('https://ext.example.com/index.html');
  });

  it('--server adds the lifecycle server and its origin', async () => {
    const dir = fresh();
    const files: string[] = scaffold({ dir, id: 'crm-sync', server: true, sdk: '^1.0.0' });
    expect(files).toContain('server/lifecycle.mjs');
    const m = extensionManifestSchema.parse(await manifestOf(dir, 'http://localhost:5180', 'http://localhost:5181'));
    expect(m.server).toEqual({ lifecycle_url: 'http://localhost:5181/lifecycle' });
    expect(m.origins).toEqual(['http://localhost:5180', 'http://localhost:5181']);
    expect(readFileSync(join(dir, 'server/lifecycle.mjs'), 'utf8')).toContain("Number('5181')");
  });

  it('s37market: from npm the project depends on the published SDK; from the repository on its copy', () => {
    const sdkPkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../ext-sdk/package.json'), 'utf8'),
    ) as { version: string };
    // The CLI's own idea of the SDK version is the SDK's real version (they are published together).
    expect(SDK_VERSION).toBe(sdkPkg.version);
    expect(repoSdkDir()).toMatch(/ext-sdk$/);
    expect(sdkSpec(undefined)).toMatch(/^file:.*ext-sdk$/);
    // Installed from npm (node_modules / the npx cache): the npm version.
    const fromNpm = join(tmpdir(), 'npx', 'node_modules', 'create-bines-app');
    expect(repoSdkDir(fromNpm)).toBeNull();
    expect(sdkSpec(undefined, fromNpm)).toBe(`^${SDK_VERSION}`);
    // Somewhere without an ext-sdk next to it: the npm version too; --sdk always wins.
    expect(sdkSpec(undefined, join(tmpdir(), 'nowhere', 'create-bines-app'))).toBe(`^${SDK_VERSION}`);
    expect(sdkSpec('^2.0.0', fromNpm)).toBe('^2.0.0');
  });

  it('refuses a bad id or a folder that is not empty', () => {
    expect(validId('My App')).toBe(false);
    expect(validId('default')).toBe(false);
    expect(() => scaffold({ dir: fresh(), id: '1x' })).toThrow(/not a valid extension id/);
    const dir = fresh();
    scaffold({ dir, id: 'once' });
    expect(() => scaffold({ dir, id: 'once' })).toThrow(/not empty/);
  });
});
