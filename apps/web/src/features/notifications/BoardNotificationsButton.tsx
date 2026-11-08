// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type BoardNotifications, type MessageKey, t } from '@bines/shared';
import { Button, Dialog, type MenuEntry } from '@bines/ui';
import { api } from '../../lib/api';
import { Icon } from '../../lib/icons';

type Category = BoardNotifications['categories'][number];
type SetBody = {
  mode?: 'all' | 'muted';
  muted?: boolean;
  categories?: Category[];
  muted_for_everyone?: boolean;
};

/**
 * The board's notification settings (08 §12.2), as entries of the board header's ⋯ menu (N20): everything,
 * custom (the categories I take from this board — they only narrow my personal settings) or muted for me;
 * owners and admins can also mute it for everyone. `dialog` is the "custom" dialog, rendered by the caller.
 */
export const useBoardNotifications = (accountId: string, boardId: string) => {
  const qc = useQueryClient();
  const [customizing, setCustomizing] = useState(false);
  const key = ['account', accountId, 'board', boardId, 'notifications'];
  const state = useQuery({
    queryKey: key,
    queryFn: () => api(accountId).get<BoardNotifications>(`/boards/${boardId}/notifications`),
  });
  const set = useMutation({
    mutationFn: (body: SetBody) => api(accountId).put<BoardNotifications>(`/boards/${boardId}/notifications`, body),
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      // My notification settings list the boards I muted (and the app badge keeps that query for minutes).
      void qc.invalidateQueries({ queryKey: ['account', accountId, 'notification-settings'] });
    },
  });
  const s = state.data;
  const silent = !!s && (s.muted || s.muted_for_everyone);

  const items: MenuEntry[] = s
    ? [
        { label: t('boardNotif.all'), checked: s.mode === 'all', onSelect: () => set.mutate({ mode: 'all' }) },
        { label: t('boardNotif.custom'), checked: s.mode === 'custom', onSelect: () => setCustomizing(true) },
        { label: t('boardNotif.mute'), checked: s.mode === 'muted', onSelect: () => set.mutate({ mode: 'muted' }) },
        ...(s.can_mute_for_everyone
          ? ([
              { kind: 'separator' },
              {
                label: t('boardNotif.everyone'),
                checked: s.muted_for_everyone,
                onSelect: () => set.mutate({ muted_for_everyone: !s.muted_for_everyone }),
              },
            ] satisfies MenuEntry[])
          : []),
      ]
    : [{ label: t('app.loading'), disabled: true, onSelect: () => undefined }];

  /** "התראות · מושתק" / "התראות · מותאם": the state shows on the menu row itself. */
  const label = `${t('boardNotif.button')}${
    silent ? ` · ${t('boardNotif.muted')}` : s?.mode === 'custom' ? ` · ${t('boardNotif.customShort')}` : ''
  }`;

  const dialog =
    s && customizing ? (
      <CustomDialog
        initial={s.categories}
        busy={set.isPending}
        onClose={() => setCustomizing(false)}
        onSave={(categories) => set.mutate({ categories }, { onSuccess: () => setCustomizing(false) })}
      />
    ) : null;

  return {
    /**
     * The ⋯ menu's submenu — there from the first render (its rows say "loading" until the settings arrive): a row
     * that appeared later would push the rows below it while the menu is open, under the pointer.
     */
    entry: { kind: 'submenu', label, items, icon: <Icon name="bell" size={16} /> } satisfies MenuEntry,
    silent,
    mode: s?.mode,
    mutedForEveryone: !!s?.muted_for_everyone,
    dialog,
  };
};

const CustomDialog = ({
  initial,
  busy,
  onClose,
  onSave,
}: {
  initial: Category[];
  busy: boolean;
  onClose: () => void;
  onSave: (categories: Category[]) => void;
}) => {
  const [categories, setCategories] = useState(initial);
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('boardNotif.custom')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={busy} data-testid="board-notif-save" onClick={() => onSave(categories)}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">{t('boardNotif.customHint')}</p>
      <table className="w-full text-sm" data-testid="board-notif-custom">
        <thead className="text-xs text-muted">
          <tr>
            <th className="py-1 text-start font-medium">{t('notifSettings.kind')}</th>
            <th className="w-20 py-1 font-medium">{t('notifSettings.bell')}</th>
            <th className="w-20 py-1 font-medium">{t('notifSettings.email')}</th>
          </tr>
        </thead>
        <tbody>
          {categories.map((c) => (
            <tr key={c.key} className="border-t border-line" data-key={c.key}>
              <td className="py-2">{t(`notifSettings.category.${c.key}` as MessageKey)}</td>
              {(['bell', 'email'] as const).map((channel) => (
                <td key={channel} className="py-2 text-center">
                  <input
                    type="checkbox"
                    aria-label={`${t(`notifSettings.category.${c.key}` as MessageKey)} — ${t(`notifSettings.${channel}`)}`}
                    checked={c[channel]}
                    onChange={(e) =>
                      setCategories((list) =>
                        list.map((x) => (x.key === c.key ? { ...x, [channel]: e.target.checked } : x)),
                      )
                    }
                    className="h-4 w-4 accent-[var(--check)]"
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
};
