// SPDX-License-Identifier: AGPL-3.0-only
import type { EventEmitter as NodeEventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertPublicUrl, isPrivateIp, outboundDownload } from '../src/lib/outbound';

/**
 * Red team, outbound calls (docs/AI-SECURITY-REVIEW.md): `attach_file_from_url` takes a URL from a model, so the
 * SSRF guard is attacked directly — internal and metadata addresses in every spelling, redirects into the network,
 * and DNS rebinding (a name that is public when checked and private when dialled). DNS and the socket are faked:
 * no test leaves the machine.
 */
const net = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as { EventEmitter: typeof NodeEventEmitter };
  const state = {
    /** What the check-time resolver answers (dns/promises). */
    checked: {} as Record<string, string[]>,
    /** What the dial-time resolver answers (dns.lookup inside the socket) — defaults to `checked`. */
    dialled: {} as Record<string, string[]>,
    responses: {} as Record<string, { status: number; headers?: Record<string, string>; body?: string }>,
    connects: [] as string[],
  };
  type Cb = (res: unknown) => void;
  type Lookup = (h: string, o: object, cb: (err: Error | null, address?: string) => void) => void;
  const request = (url: URL, opts: { lookup?: Lookup }, cb: Cb) => {
    const req = new EventEmitter() as InstanceType<typeof EventEmitter> & Record<string, unknown>;
    req.write = () => true;
    req.destroy = (e?: Error) => {
      if (e) req.emit('error', e);
      req.emit('close');
    };
    req.end = () => {
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const dial = (address: string) => {
        state.connects.push(`${host}@${address}`);
        const r = state.responses[url.href] ?? { status: 404 };
        const res = new EventEmitter() as InstanceType<typeof EventEmitter> & Record<string, unknown>;
        res.statusCode = r.status;
        res.headers = r.headers ?? {};
        res.destroy = () => res.emit('close');
        cb(res);
        queueMicrotask(() => {
          if (r.body) res.emit('data', Buffer.from(r.body));
          res.emit('end');
        });
      };
      if (opts.lookup) opts.lookup(host, {}, (err, address) => (err ? req.emit('error', err) : dial(address!)));
      else dial(host);
    };
    return req;
  };
  const family = (a: string) => (a.includes(':') ? 6 : 4);
  return { state, request, family };
});

vi.mock('node:http', () => ({ request: net.request }));
vi.mock('node:https', () => ({ request: net.request }));
vi.mock('node:dns/promises', () => ({
  lookup: async (host: string) => {
    const list = net.state.checked[host];
    if (!list) throw Object.assign(new Error(`ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return list.map((address) => ({ address, family: net.family(address) }));
  },
}));
vi.mock('node:dns', () => ({
  lookup: (host: string, _o: object, cb: (e: Error | null, a: { address: string; family: number }[]) => void) => {
    const list = net.state.dialled[host] ?? net.state.checked[host] ?? [];
    cb(
      null,
      list.map((address) => ({ address, family: net.family(address) })),
    );
  },
}));

const PUBLIC = '93.184.216.34';
const opts = { maxBytes: 1024, timeoutMs: 5000 };

beforeEach(() => {
  net.state.checked = {};
  net.state.dialled = {};
  net.state.responses = {};
  net.state.connects = [];
});

describe('SSRF guard — addresses', () => {
  it('blocks internal and metadata addresses in every spelling', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '169.254.169.254', // AWS / GCP / Azure metadata
      '100.100.100.200', // Alibaba metadata (CGNAT range)
      '0.0.0.0',
      '::1',
      '::',
      'fe80::1',
      'fd00:ec2::254', // AWS metadata over IPv6
      'fd12:3456::1', // Railway private network
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '64:ff9b::a9fe:a9fe', // NAT64
      '2002:a9fe:a9fe::1', // 6to4 of 169.254.169.254 (AI-RT13)
      '2002:7f00:1::', // 6to4 of 127.0.0.1 (AI-RT13)
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo (AI-RT13)
      'not-an-ip',
    ])
      expect(isPrivateIp(ip), ip).toBe(true);
    for (const ip of [PUBLIC, '8.8.8.8', '2606:4700:4700::1111', '2002:5db8:d822::1', '2001:4860:4860::8888'])
      expect(isPrivateIp(ip), ip).toBe(false);
  });

  it('refuses private hosts however the URL writes them, and anything that is not http(s)', async () => {
    for (const url of [
      'http://2130706433/', // 127.0.0.1 as a number
      'http://0x7f.1/',
      'http://017700000001/',
      'http://127.1/',
      'http://[::ffff:7f00:1]/',
      'http://[2002:a9fe:a9fe::]/latest/meta-data/',
      'http://localhost./',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://printer.local/',
      'http://metadata.google.internal./',
    ])
      await expect(assertPublicUrl(url), url).rejects.toThrow(/webhook_url_private/);
    for (const url of ['file:///etc/passwd', 'gopher://x.test/', 'ftp://x.test/a', 'https://user:pass@x.test/', 'nope'])
      await expect(assertPublicUrl(url), url).rejects.toThrow(/webhook_url_invalid/);
    // A name that resolves to any private address (one of several is enough) is refused.
    net.state.checked['mixed.test'] = [PUBLIC, '10.0.0.7'];
    await expect(assertPublicUrl('https://mixed.test/a')).rejects.toThrow(/webhook_url_private/);
  });
});

describe('SSRF guard — downloads (attach_file_from_url)', () => {
  it('downloads from a public host', async () => {
    net.state.checked['files.test'] = [PUBLIC];
    net.state.responses['https://files.test/a.pdf'] = {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      body: '%PDF',
    };
    const f = await outboundDownload('https://files.test/a.pdf', opts);
    expect(f).toMatchObject({ mime: 'application/pdf', fileName: 'a.pdf' });
    expect(net.state.connects).toEqual([`files.test@${PUBLIC}`]);
  });

  it('a redirect into the network is refused before it is followed', async () => {
    net.state.checked['redirector.test'] = [PUBLIC];
    net.state.checked['internal.test'] = ['10.0.0.5'];
    for (const location of [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://[::1]:5432/',
      'https://internal.test/x',
      'file:///etc/passwd',
    ]) {
      net.state.connects = [];
      net.state.responses['https://redirector.test/a.pdf'] = { status: 302, headers: { location } };
      await expect(outboundDownload('https://redirector.test/a.pdf', opts), location).rejects.toThrow(
        /webhook_url_private|webhook_url_invalid/,
      );
      expect(net.state.connects, location).toEqual([`redirector.test@${PUBLIC}`]);
    }
  });

  it('a redirect loop stops', async () => {
    net.state.checked['loop.test'] = [PUBLIC];
    net.state.responses['https://loop.test/a'] = { status: 302, headers: { location: '/a' } };
    await expect(outboundDownload('https://loop.test/a', opts)).rejects.toThrow(/too_many_redirects/);
    expect(net.state.connects.length).toBe(4);
  });

  it('DNS rebinding: public when checked, private when dialled — the socket refuses it', async () => {
    net.state.checked['rebind.test'] = [PUBLIC];
    net.state.dialled['rebind.test'] = ['169.254.169.254'];
    net.state.responses['https://rebind.test/a.pdf'] = { status: 200, body: 'secret' };
    await expect(outboundDownload('https://rebind.test/a.pdf', opts)).rejects.toThrow(/webhook_url_private/);
    expect(net.state.connects).toEqual([]);
  });

  it('an answer larger than the cap is refused, not cut', async () => {
    net.state.checked['big.test'] = [PUBLIC];
    net.state.responses['https://big.test/a.pdf'] = { status: 200, body: 'x'.repeat(5000) };
    await expect(outboundDownload('https://big.test/a.pdf', opts)).rejects.toThrow(/file_too_large/);
  });
});
