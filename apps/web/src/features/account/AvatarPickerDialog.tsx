// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { animalAvatarCode, parseAnimalAvatar, t, type MessageKey } from '@bines/shared';
import { Button, cn, Dialog } from '@bines/ui';
import { AVATAR_ANIMALS, AVATAR_BACKGROUNDS, avatarDataUrl, avatarFile } from './avatars';

/**
 * "בחירת אווטר": pick one of our animals and a background from our palette. The profile: "שמירה"
 * draws it to a PNG and hands it to `onSave` — the same path as an uploaded photo. An agent: `onPick` gets its code
 * (`animal:<id>:<background>`), and `initial` opens on the agent's current one.
 */
export const AvatarPickerDialog = ({
  busy,
  initial,
  onCancel,
  onSave,
  onPick,
}: {
  busy?: boolean;
  initial?: string | null;
  onCancel: () => void;
  onSave?: (file: File) => void | Promise<void>;
  onPick?: (code: string) => void;
}) => {
  const start = parseAnimalAvatar(initial);
  const [picked, setPicked] = useState(start?.art ?? AVATAR_ANIMALS[0]!);
  /** null = the animal's own background. */
  const [bg, setBg] = useState<string | null>(start?.bg ?? null);
  const [saving, setSaving] = useState(false);
  const background = bg ?? picked.bg;
  const name = (id: string) => t(`avatar.animal.${id}` as MessageKey);
  const save = async () => {
    if (onPick) return onPick(animalAvatarCode(picked.id, AVATAR_BACKGROUNDS.indexOf(background as never)));
    setSaving(true);
    try {
      await onSave?.(await avatarFile(picked, background));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onCancel}
      title={t('avatar.picker.title')}
      className="md:max-w-[520px]"
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} data-testid="avatar-picker-cancel">
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void save()} busy={saving || busy} data-testid="avatar-picker-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="avatar-picker">
        <div role="radiogroup" aria-label={t('avatar.picker.title')} className="grid grid-cols-4 gap-2 sm:gap-3">
          {AVATAR_ANIMALS.map((a) => {
            const on = a.id === picked.id;
            return (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={name(a.id)}
                title={name(a.id)}
                data-testid={`avatar-option-${a.id}`}
                onClick={() => setPicked(a)}
                className={cn(
                  'grid place-items-center rounded-full p-1 transition-shadow hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]',
                  on && 'shadow-[0_0_0_3px_var(--heading)]',
                )}
              >
                <img src={avatarDataUrl(a, on ? background : undefined)} alt="" className="aspect-square w-full" />
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="w-12 text-xs text-muted">{t('avatar.picker.background')}</span>
          <div role="radiogroup" aria-label={t('avatar.picker.background')} className="flex flex-wrap gap-2">
            {AVATAR_BACKGROUNDS.map((c, i) => {
              const on = c === background;
              return (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={t('avatar.picker.backgroundN', { n: i + 1 })}
                  data-testid={`avatar-bg-${i}`}
                  onClick={() => setBg(c)}
                  style={{ backgroundColor: c }}
                  className={cn(
                    'size-7 rounded-full border border-line focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]',
                    on && 'shadow-[0_0_0_2px_var(--surface),0_0_0_4px_var(--heading)]',
                  )}
                />
              );
            })}
          </div>
        </div>
        <div className="flex items-center gap-3 border-t border-line pt-3">
          <img
            src={avatarDataUrl(picked, background)}
            alt={name(picked.id)}
            data-testid="avatar-picker-preview"
            data-avatar={picked.id}
            data-bg={background}
            className="size-11 shrink-0"
          />
          <span className="text-sm text-muted">{t('avatar.picker.preview')}</span>
        </div>
      </div>
    </Dialog>
  );
};
