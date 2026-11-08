// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { ipBucket, normalizeIp, parseTrustProxy, resolveClientIp, type ClientIpConfig } from '../src/lib/client-ip';
import { RateLimiter } from '../src/lib/rate-limit';

/** S-10: one helper decides the client address, from configuration only. */
const h = (headers: Record<string, string>) => new Headers(headers);
const edge: ClientIpConfig = { trust: 'edge', header: 'x-forwarded-for' };
const hops = (n: number): ClientIpConfig => ({ trust: n, header: 'x-forwarded-for' });

describe('resolveClientIp', () => {
  it('edge (Railway): the first X-Forwarded-For entry — the edge replaced whatever the client sent', () => {
    expect(resolveClientIp(edge, h({ 'x-forwarded-for': '203.0.113.5' }))).toBe('203.0.113.5');
    // Railway may add hops inside its network after the client
    expect(resolveClientIp(edge, h({ 'x-forwarded-for': '203.0.113.5, 100.64.0.2' }))).toBe('203.0.113.5');
    expect(resolveClientIp(edge, h({ 'x-forwarded-for': ' 2001:DB8::1 , 100.64.0.2' }))).toBe('2001:db8::1');
  });

  it('hop count: the client is n from the right; entries a client prepends are ignored (spoofing)', () => {
    // attacker sends "X-Forwarded-For: 1.1.1.1"; one proxy of ours appends the real address
    expect(resolveClientIp(hops(1), h({ 'x-forwarded-for': '1.1.1.1, 198.51.100.4' }))).toBe('198.51.100.4');
    // a long forged chain changes nothing
    expect(resolveClientIp(hops(1), h({ 'x-forwarded-for': '9.9.9.9, 8.8.8.8, 1.1.1.1, 198.51.100.4' }))).toBe(
      '198.51.100.4',
    );
    // two proxies: CDN appended the client, the load balancer appended the CDN
    expect(resolveClientIp(hops(2), h({ 'x-forwarded-for': '1.1.1.1, 198.51.100.4, 10.0.0.3' }))).toBe('198.51.100.4');
    // fewer entries than trusted hops: the chain did not come through our proxies — unknown
    expect(resolveClientIp(hops(2), h({ 'x-forwarded-for': '198.51.100.4' }))).toBeNull();
  });

  it('a single-value header set by the edge (x-real-ip / cf-connecting-ip)', () => {
    const cfg: ClientIpConfig = { trust: 'edge', header: 'x-real-ip' };
    expect(resolveClientIp(cfg, h({ 'x-real-ip': '203.0.113.8', 'x-forwarded-for': '1.1.1.1' }))).toBe('203.0.113.8');
  });

  it('none: forwarded headers are ignored, the TCP peer is the client', () => {
    const cfg: ClientIpConfig = { trust: 'none', header: 'x-forwarded-for' };
    expect(resolveClientIp(cfg, h({ 'x-forwarded-for': '1.1.1.1' }), '::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(resolveClientIp(cfg, h({ 'x-forwarded-for': '1.1.1.1' }))).toBeNull();
  });

  it('garbage is unknown, never a bucket of its own', () => {
    expect(resolveClientIp(edge, h({ 'x-forwarded-for': 'not-an-ip' }))).toBeNull();
    expect(resolveClientIp(edge, h({ 'x-forwarded-for': '<script>, 1.2.3.4' }))).toBeNull();
    expect(resolveClientIp(edge, h({ 'x-forwarded-for': ',,,' }))).toBeNull();
    expect(resolveClientIp(hops(1), h({ 'x-forwarded-for': '1.2.3.4, 999.1.1.1' }))).toBeNull();
    // no header at all: the peer (direct request)
    expect(resolveClientIp(edge, h({}), '10.1.2.3')).toBe('10.1.2.3');
  });
});

describe('helpers', () => {
  it('normalizeIp strips ports and unwraps IPv4-mapped IPv6', () => {
    expect(normalizeIp('203.0.113.5:4431')).toBe('203.0.113.5');
    expect(normalizeIp('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(normalizeIp('::FFFF:198.51.100.1')).toBe('198.51.100.1');
    expect(normalizeIp('')).toBeNull();
  });

  it('parseTrustProxy accepts edge / none / a hop count and refuses the rest', () => {
    expect(parseTrustProxy(undefined)).toBe('edge');
    expect(parseTrustProxy('EDGE')).toBe('edge');
    expect(parseTrustProxy('none')).toBe('none');
    expect(parseTrustProxy('2')).toBe(2);
    expect(() => parseTrustProxy('lots')).toThrow();
  });

  it('ipBucket: IPv4 per address, IPv6 per /64 (one client usually owns a whole /64)', () => {
    expect(ipBucket('203.0.113.5')).toBe('ip:203.0.113.5');
    expect(ipBucket('2001:db8:1:2:aaaa::1')).toBe(ipBucket('2001:db8:1:2:bbbb::9'));
    expect(ipBucket('2001:db8:1:2::1')).not.toBe(ipBucket('2001:db8:1:3::1'));
    expect(ipBucket(null)).toBe('ip:unknown');
  });

  it('RateLimiter.peek reports a full window without counting', () => {
    const l = new RateLimiter(2, 1000);
    expect(l.peek('a', 0)).toBe(0);
    l.hit('a', 0);
    l.hit('a', 0);
    expect(l.peek('a', 100)).toBe(900);
    expect(l.peek('a', 1000)).toBe(0);
  });
});
