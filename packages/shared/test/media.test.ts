// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { mediaKindOf, mediaServeType } from '../src/media';

/** audio / video play inside the app — also when uploaded without a type. */
describe('mediaKindOf', () => {
  it('by the stored type first', () => {
    expect(mediaKindOf({ name: 'a.bin', mime: 'video/mp4' })).toBe('video');
    expect(mediaKindOf({ name: 'a', mime: 'audio/mpeg' })).toBe('audio');
    expect(mediaKindOf({ name: 'clip.mp4', mime: 'application/pdf' })).toBeNull();
  });
  it('no useful type: by the extension', () => {
    expect(mediaKindOf({ name: 'voice.M4A', mime: 'application/octet-stream' })).toBe('audio');
    expect(mediaKindOf({ name: 'call.opus', mime: '' })).toBe('audio');
    expect(mediaKindOf({ name: 'film.mkv', mime: '' })).toBe('video');
    expect(mediaKindOf({ name: 'song.ogg', mime: 'application/ogg' })).toBe('audio');
    expect(mediaKindOf({ name: 'notes.txt', mime: '' })).toBeNull();
  });
});

describe('mediaServeType', () => {
  it('only for a vague stored type, and only media types', () => {
    expect(mediaServeType({ name: 'voice.m4a', mime: 'application/octet-stream' })).toBe('audio/mp4');
    expect(mediaServeType({ name: 'v.webm', mime: '' })).toBe('video/webm');
    expect(mediaServeType({ name: 'v.webm', mime: 'video/webm' })).toBeNull();
    expect(mediaServeType({ name: 'page.html', mime: 'application/octet-stream' })).toBeNull();
  });
  it('never a page, SVG, XML or script type — an allowlist of audio / video only, whatever the name', () => {
    for (const name of ['a.html', 'a.htm', 'a.svg', 'a.xml', 'a.js', 'a.xhtml', 'a', 'a.mp4.html'])
      expect(mediaServeType({ name, mime: '' })).toBeNull();
    // A page renamed to .mp4 keeps its stored type (not vague): no override, and the stored type is not inline-safe.
    expect(mediaServeType({ name: 'page.mp4', mime: 'text/html' })).toBeNull();
    expect(mediaServeType({ name: 'img.mp4', mime: 'image/svg+xml' })).toBeNull();
    for (const ext of [
      'mp4',
      'm4v',
      'webm',
      'ogv',
      'mov',
      'mkv',
      '3gp',
      'mp3',
      'm4a',
      'aac',
      'wav',
      'ogg',
      'oga',
      'opus',
      'weba',
      'flac',
      'amr',
    ])
      expect(mediaServeType({ name: `x.${ext}`, mime: '' })).toMatch(/^(audio|video)\/[\w.+-]+$/);
  });
});
