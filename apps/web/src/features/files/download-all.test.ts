// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** "Download all": the server's checks first, then the browser downloads the streamed ZIP itself. */
const gets: string[] = [];
let answer: () => Promise<unknown> = async () => ({ files: 2, skipped: 0 });
const toasts: { message: string; tone?: string }[] = [];

vi.mock('../../lib/api', () => ({
  api: () => ({
    get: (path: string) => {
      gets.push(path);
      return answer();
    },
  }),
}));
vi.mock('../../lib/toast', () => ({ showToast: (t: { message: string; tone?: string }) => toasts.push(t) }));
vi.mock('../account/CopyLink', () => ({ reasonMessage: (e: Error) => `reason:${e.message}` }));
vi.mock('../admin/account-settings', () => ({ useAccountDetail: () => ({ data: undefined }) }));

const { cellZipPath, downloadAll, updateZipPath } = await import('./download-all');

let clicked: string[] = [];
beforeEach(() => {
  gets.length = 0;
  toasts.length = 0;
  clicked = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this.getAttribute('href') ?? '');
  });
});

describe('downloadAll', () => {
  it('asks the server first, then lets the browser download the ZIP (the account in the query)', async () => {
    await downloadAll('A1', cellZipPath('I1', 'files'));
    expect(gets).toEqual(['/items/I1/cells/files/files.zip?check=1']);
    expect(clicked).toEqual(['/api/v1/items/I1/cells/files/files.zip?account_id=A1']);
    expect(toasts).toHaveLength(1);
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
  });

  it('says how many files were left out', async () => {
    answer = async () => ({ files: 2, skipped: 3 });
    await downloadAll('A1', updateZipPath('U1'));
    expect(clicked).toEqual(['/api/v1/updates/U1/files.zip?account_id=A1']);
    expect(toasts[0]!.message).toContain('3');
  });

  it('a refusal is a message, and nothing downloads', async () => {
    answer = async () => {
      throw new Error('zip_too_many_files');
    };
    await downloadAll('A1', updateZipPath('U1'));
    expect(clicked).toEqual([]);
    expect(toasts).toEqual([{ message: 'reason:zip_too_many_files', tone: 'error' }]);
  });
});
