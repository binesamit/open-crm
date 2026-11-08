// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type FormEvent } from 'react';
import {
  type CellLink,
  FILE_LINK_NAME_MAX,
  FILE_LINK_URL_MAX,
  fileLinkLabel,
  normalizeFileLink,
  t,
} from '@bines/shared';
import { Button, Input } from '@bines/ui';
import { Icon } from '../../../lib/icons';

export type { CellLink };

/** A link's site icon is not fetched (no third-party requests from the board): the link glyph stands for all. */
export const LinkGlyph = ({ size = 14 }: { size?: number }) => (
  <Icon name="link" size={size} className="shrink-0 text-info-fg" />
);

/**
 * Add / edit a link in a files cell: an address and an optional name. `example.com` is fine (it
 * gains https://); anything but http(s) is refused here and again by the server.
 */
export const LinkForm = ({
  initial,
  onSave,
  onCancel,
}: {
  initial?: Pick<CellLink, 'url' | 'name'>;
  onSave: (v: { url: string; name: string }) => Promise<void>;
  onCancel: () => void;
}) => {
  const [url, setUrl] = useState(initial?.url ?? '');
  const [name, setName] = useState(initial?.name ?? '');
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const clean = normalizeFileLink(url);
    if (!clean) {
      setInvalid(true);
      return;
    }
    setBusy(true);
    try {
      await onSave({ url: clean, name: name.trim() });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="space-y-1.5 rounded-[var(--radius-sm)] border border-line p-2"
      data-testid="file-cell-link-form"
      onSubmit={(e) => void submit(e)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Esc closes the form, not the whole popover.
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <label className="block text-xs text-muted">
        {t('files.cell.linkUrl')}
        <Input
          autoFocus
          value={url}
          dir="ltr"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          maxLength={FILE_LINK_URL_MAX}
          placeholder="https://"
          aria-invalid={invalid || undefined}
          data-testid="file-cell-link-url"
          className="mt-0.5"
          onChange={(e) => {
            setUrl(e.target.value);
            setInvalid(false);
          }}
        />
      </label>
      <label className="block text-xs text-muted">
        {t('files.cell.linkName')}
        <Input
          value={name}
          maxLength={FILE_LINK_NAME_MAX}
          autoComplete="off"
          data-testid="file-cell-link-name"
          className="mt-0.5"
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      {invalid ? (
        <p role="alert" className="text-xs text-danger-fg" data-testid="file-cell-link-invalid">
          {t('files.cell.linkInvalid')}
        </p>
      ) : null}
      <div className="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('files.cell.linkCancel')}
        </Button>
        <Button type="submit" size="sm" busy={busy} disabled={!url.trim()} data-testid="file-cell-link-save">
          {t('files.cell.linkSave')}
        </Button>
      </div>
    </form>
  );
};

/** One link in the cell's popover: opens in a new tab; edit and remove for whoever may edit the cell. */
export const LinkRow = ({
  link,
  editable,
  onEdit,
  onRemove,
}: {
  link: CellLink;
  editable: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) => {
  const label = fileLinkLabel(link);
  return (
    <div className="flex items-center justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-surface-2">
      <a
        href={link.url}
        target="_blank"
        rel="noopener noreferrer"
        title={link.url}
        aria-label={t('files.cell.openLink', { name: label })}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-start text-primary underline"
        data-testid="file-cell-link-open"
        onClick={(e) => e.stopPropagation()}
      >
        <LinkGlyph />
        <span className="truncate" dir="auto">
          {label}
        </span>
      </a>
      {editable ? (
        <>
          <button
            type="button"
            aria-label={t('files.cell.editLink', { name: label })}
            title={t('files.cell.editLink', { name: label })}
            data-testid="file-cell-link-edit"
            className="text-muted hover:text-fg"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            <Icon name="edit" size={13} />
          </button>
          <button
            type="button"
            aria-label={t('files.cell.removeLink', { name: label })}
            title={t('files.cell.removeLink', { name: label })}
            data-testid="file-cell-link-remove"
            className="text-muted hover:text-danger-fg"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
          >
            ✕
          </button>
        </>
      ) : null}
    </div>
  );
};
