// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { t } from '@bines/shared';
import { Button, Dialog, Field, Input, Switch } from '@bines/ui';
import { showToast } from '../../lib/toast';
import { useItemTemplateMutations } from './item-templates-api';
import { openItemTemplates } from './store';

const Toggle = ({
  label,
  hint,
  checked,
  onChange,
  testId,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  testId: string;
}) => (
  <label className="flex items-start gap-3 py-1">
    <span className="min-w-0 flex-1">
      <span className="block text-sm text-fg">{label}</span>
      {hint ? <span className="block text-xs text-muted">{hint}</span> : null}
    </span>
    <Switch checked={checked} onChange={onChange} testId={testId} />
  </label>
);

/**
 * "Save as template": the item and its subitems at every depth, with their values, updates and files.
 * The suggested variables turn the item's dates into working days after a start date, its owner and name into
 * questions asked when the template is applied; each can be turned off. The editor fine-tunes the rest.
 */
export const SaveTemplateDialog = ({
  accountId,
  boardId,
  itemId,
  itemName,
  onClose,
}: {
  accountId: string;
  boardId: string;
  itemId: string;
  itemName: string;
  onClose: () => void;
}) => {
  const m = useItemTemplateMutations(accountId, boardId);
  const [name, setName] = useState(itemName);
  const [category, setCategory] = useState('');
  const [withSubitems, setWithSubitems] = useState(true);
  const [withUpdates, setWithUpdates] = useState(true);
  const [withFiles, setWithFiles] = useState(true);
  const [start, setStart] = useState(true);
  const [owner, setOwner] = useState(true);
  const [askName, setAskName] = useState(true);
  const save = () =>
    m.saveAs.mutate(
      {
        itemId,
        name: name.trim() || itemName,
        category: category.trim(),
        description: '',
        with_subitems: withSubitems,
        with_updates: withUpdates,
        with_files: withFiles,
        variables: { start, owner, name: askName },
      },
      {
        onSuccess: (dto) => {
          onClose();
          showToast({
            message: t('itemTemplates.saved', { name: dto.name }),
            action: {
              label: t('itemTemplates.openEditor'),
              run: () => openItemTemplates({ kind: 'edit', boardId, templateId: dto.id }),
            },
          });
        },
      },
    );
  return (
    <Dialog
      open
      onClose={onClose}
      title={t('itemTemplates.saveTitle')}
      subtitle={itemName}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button busy={m.saveAs.isPending} onClick={save} data-testid="item-template-save">
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3" data-testid="item-template-save-dialog">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('itemTemplates.name')}>
            <Input
              value={name}
              maxLength={120}
              onChange={(e) => setName(e.target.value)}
              data-testid="item-template-name"
            />
          </Field>
          <Field label={t('itemTemplates.category')} hint={t('itemTemplates.categoryHint')}>
            <Input value={category} maxLength={60} onChange={(e) => setCategory(e.target.value)} />
          </Field>
        </div>
        <div className="rounded-[12px] border border-line px-3 py-2">
          <p className="text-xs font-semibold text-fg-2">{t('itemTemplates.keep')}</p>
          <Toggle
            label={t('itemTemplates.withSubitems')}
            checked={withSubitems}
            onChange={setWithSubitems}
            testId="item-template-with-subitems"
          />
          <Toggle
            label={t('itemTemplates.withUpdates')}
            checked={withUpdates}
            onChange={setWithUpdates}
            testId="item-template-with-updates"
          />
          <Toggle
            label={t('itemTemplates.withFiles')}
            checked={withFiles}
            onChange={setWithFiles}
            testId="item-template-with-files"
          />
        </div>
        <div className="rounded-[12px] border border-line px-3 py-2">
          <p className="text-xs font-semibold text-fg-2">{t('itemTemplates.ask')}</p>
          <Toggle
            label={t('itemTemplates.askStart')}
            hint={t('itemTemplates.askStartHint')}
            checked={start}
            onChange={setStart}
            testId="item-template-ask-start"
          />
          <Toggle
            label={t('itemTemplates.askOwner')}
            hint={t('itemTemplates.askOwnerHint')}
            checked={owner}
            onChange={setOwner}
            testId="item-template-ask-owner"
          />
          <Toggle
            label={t('itemTemplates.askName')}
            hint={t('itemTemplates.askNameHint')}
            checked={askName}
            onChange={setAskName}
            testId="item-template-ask-name"
          />
        </div>
      </div>
    </Dialog>
  );
};
