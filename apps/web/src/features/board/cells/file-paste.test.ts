// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { dragHasFiles, namePastedFiles, pastedFileName, transferFiles } from './file-paste';

/** r19small: files pasted / dropped into a files cell. */
const at = new Date(2026, 9, 7, 14, 32, 5);

describe('pastedFileName', () => {
  it('names a screenshot (a generic or empty image name) by the date and minute', () => {
    expect(pastedFileName({ name: 'image.png', type: 'image/png' }, at, 'צילום מסך')).toBe(
      'צילום מסך 2026-10-07 14-32.png',
    );
    expect(pastedFileName({ name: '', type: 'image/jpeg' }, at, 'Screenshot')).toBe('Screenshot 2026-10-07 14-32.jpg');
    expect(pastedFileName({ name: 'Image.PNG', type: 'image/png' }, at, 'S', 2)).toBe('S 2026-10-07 14-32 (2).png');
  });
  it('keeps a real name (a file copied in the file manager)', () => {
    expect(pastedFileName({ name: 'logo-final.png', type: 'image/png' }, at, 'S')).toBe('logo-final.png');
    expect(pastedFileName({ name: 'contract.pdf', type: 'application/pdf' }, at, 'S')).toBe('contract.pdf');
  });
});

describe('transferFiles', () => {
  const file = new File(['x'], 'image.png', { type: 'image/png' });
  const dt = (o: unknown) => o as DataTransfer;
  it('reads the file items (a screenshot is there only), never the text ones', () => {
    const items = [
      { kind: 'string', getAsFile: () => null },
      { kind: 'file', getAsFile: () => file },
    ];
    expect(transferFiles(dt({ items, files: [] }))).toEqual([file]);
  });
  it('falls back to `files`, and is empty for text or nothing', () => {
    expect(transferFiles(dt({ items: [], files: [file] }))).toEqual([file]);
    expect(transferFiles(dt({ items: [{ kind: 'string', getAsFile: () => null }], files: [] }))).toEqual([]);
    expect(transferFiles(null)).toEqual([]);
  });
  it('tells a drag of files from other drags', () => {
    expect(dragHasFiles(dt({ types: ['Files'] }))).toBe(true);
    expect(dragHasFiles(dt({ types: ['text/plain'] }))).toBe(false);
  });
});

describe('namePastedFiles', () => {
  it('renames screenshots (numbered within one paste) and leaves named files as they are', () => {
    const a = new File(['a'], 'image.png', { type: 'image/png' });
    const b = new File(['b'], 'image.png', { type: 'image/png' });
    const c = new File(['c'], 'notes.txt', { type: 'text/plain' });
    const out = namePastedFiles([a, b, c], 'צילום מסך', at);
    expect(out.map((f) => f.name)).toEqual([
      'צילום מסך 2026-10-07 14-32.png',
      'צילום מסך 2026-10-07 14-32 (2).png',
      'notes.txt',
    ]);
    expect(out[2]).toBe(c);
    expect(out[0]!.type).toBe('image/png');
  });
});
