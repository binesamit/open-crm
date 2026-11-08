// SPDX-License-Identifier: AGPL-3.0-only
import { BlockList, isIP } from 'node:net';
import { normalizeIp } from './client-ip';

/**
 * IP allowlist matching (M8 ד12): one address or a CIDR range per entry, IPv4 and IPv6 (node's BlockList). The
 * address is the real client address (lib/client-ip.ts, S-10); an unknown address (null) is never inside.
 */
export const toBlockList = (ranges: string[]) => {
  const list = new BlockList();
  for (const raw of ranges) {
    const [addr = '', prefix] = raw.trim().split('/');
    const ip = normalizeIp(addr);
    if (!ip) continue;
    const family = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
    if (prefix === undefined) list.addAddress(ip, family);
    else list.addSubnet(ip, Number(prefix), family);
  }
  return list;
};

export const ipInRanges = (ip: string | null, ranges: string[]): boolean => {
  const v = normalizeIp(ip);
  if (!v || !ranges.length) return false;
  return toBlockList(ranges).check(v, isIP(v) === 6 ? 'ipv6' : 'ipv4');
};
