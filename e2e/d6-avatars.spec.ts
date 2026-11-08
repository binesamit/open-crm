// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, newTeammate, ownerContext, signIn } from './helpers';

/**
 * Built-in avatars (the product owner picked the animals): the profile photo menu offers "בחירת אווטר" — one of our eight animals
 * on a background from our palette; saving stores it as the profile photo, which shows like an uploaded one.
 */
const uid = () => Math.random().toString(36).slice(2, 7);

test('profile: choose an animal avatar and a background; it becomes the profile photo', async ({ page, browser }) => {
  await signIn(page);
  const mate = await newTeammate(page, browser, `אווטר ${uid()}`);
  forbidNativeDialogs(mate);
  await mate.goto('/a/demo/profile');
  await expect(mate.getByTestId('profile-page')).toBeVisible();
  // No photo yet: initials.
  await expect(mate.getByTestId('profile-avatar').locator('img')).toHaveCount(0);

  await mate.getByTestId('profile-avatar').click();
  await mate.getByTestId('profile-photo-avatar').click();
  const picker = mate.getByTestId('avatar-picker');
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('radio', { name: /^(שועל|חתול|דוב|ינשוף|ארנב|פנדה|צפרדע|פינגווין)$/ })).toHaveCount(8);

  // Cancel changes nothing.
  await mate.getByTestId('avatar-picker-cancel').click();
  await expect(picker).toHaveCount(0);
  await expect(mate.getByTestId('profile-avatar').locator('img')).toHaveCount(0);

  // Pick the owl and the fourth background; the preview follows.
  await mate.getByTestId('profile-avatar').click();
  await mate.getByTestId('profile-photo-avatar').click();
  await mate.getByTestId('avatar-option-owl').click();
  await expect(mate.getByTestId('avatar-option-owl')).toHaveAttribute('aria-checked', 'true');
  await mate.getByTestId('avatar-bg-3').click();
  await expect(mate.getByTestId('avatar-bg-3')).toHaveAttribute('aria-checked', 'true');
  const preview = mate.getByTestId('avatar-picker-preview');
  await expect(preview).toHaveAttribute('data-avatar', 'owl');
  await expect(preview).toHaveAttribute('data-bg', '#dcc5fe');

  await mate.getByTestId('avatar-picker-save').click();
  await expect(picker).toHaveCount(0);
  // Saved as the profile photo: a square image, served like an uploaded one (it stays after a reload).
  const img = mate.getByTestId('profile-avatar').locator('img');
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth >= 256 && el.naturalWidth === el.naturalHeight))
    .toBe(true);
  await mate.reload();
  await expect(mate.getByTestId('profile-avatar').locator('img')).toBeVisible();
  await mate.close();
});

/**
 * Product decision: an agent gets an animal too — a new agent starts on a random one; "בחירה" opens the
 * same picker; "אקראי"; "הסוכן יבחר" lets its model pick on save. The list shows it.
 */
test('agents: a new agent starts on a random animal; pick one in the picker; the list shows it', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const api = (path: string) => `/api/v1${path}`;
  const original = (await (await page.request.get(api('/ai/settings'), { headers })).json()) as { enabled: boolean };
  await page.request.patch(api('/ai/settings'), { headers, data: { enabled: true } });
  const connection = (await (
    await page.request.post(api('/ai/connections'), {
      headers,
      data: { name: `E2E avatars ${tag}`, provider: 'anthropic', api_key: 'sk-ant-e2e-scripted-0000' },
    })
  ).json()) as { id: string };
  let agentId: string | null = null;
  try {
    await page.goto('/a/demo/agents');
    await page.getByTestId('agent-new').click();
    const choice = page.getByTestId('agent-avatar-choice');
    await expect(choice).toHaveAttribute('data-value', /^animal:[a-z]+:[0-7]$/);
    await page.getByTestId('agent-avatar-random').click();
    await expect(choice).toHaveAttribute('data-value', /^animal:[a-z]+:[0-7]$/);
    await page.getByTestId('agent-avatar-auto').click();
    await expect(choice).toHaveAttribute('data-value', 'animal:auto');
    await expect(page.getByTestId('agent-avatar-auto')).toHaveAttribute('aria-pressed', 'true');

    // The same picker as the profile, returning the agent's code.
    await page.getByTestId('agent-avatar-pick').click();
    await page.getByTestId('avatar-option-penguin').click();
    await page.getByTestId('avatar-bg-2').click();
    await page.getByTestId('avatar-picker-save').click();
    await expect(page.getByTestId('avatar-picker')).toHaveCount(0);
    await expect(choice).toHaveAttribute('data-value', 'animal:penguin:2');

    await page.getByTestId('agent-name').fill(`פינגווין ${tag}`);
    await page.getByTestId('agent-tab-model').click();
    await page.getByTestId('agent-connection').click();
    await page.getByRole('menu').getByText(`E2E avatars ${tag}`).click();
    await page.getByTestId('agent-save').click();
    await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}$/);
    agentId = page.url().split('/').at(-1)!;

    await page.goto('/a/demo/agents');
    await expect(page.locator('img[data-avatar="animal:penguin:2"]').first()).toBeVisible();
  } finally {
    if (agentId) await page.request.delete(api(`/agents/${agentId}`), { headers });
    await page.request.delete(api(`/ai/connections/${connection.id}`), { headers });
    await page.request.patch(api('/ai/settings'), { headers, data: { enabled: original.enabled } });
  }
});
