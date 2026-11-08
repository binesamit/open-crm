// SPDX-License-Identifier: AGPL-3.0-only
import { useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { phoneColumnConfig, t, type PhoneAction } from '@bines/shared';
import { Button, cn, Dialog, Menu, useActionMenu, type MenuEntry } from '@bines/ui';
import { Icon, type IconName } from '../../lib/icons';
import { copyText } from '../../lib/entity-menu';
import { usePhonePrefs, useSmsStatus } from './phone-api';
import { cellPhone, clickTarget, currentDevice, planPhoneAction, type PhoneStep } from './phone-logic';
import { SmsDialog } from './SmsDialog';

const LONG_PRESS_MS = 550;

const ICON: Record<PhoneAction, IconName> = {
  whatsapp: 'chat',
  telegram: 'send',
  call: 'mobile',
  sms: 'mail',
  copy: 'copy',
};

/**
 * The number of a phone cell with its click actions. A click runs what the user chose in the
 * profile (default: the menu of the column's actions — WhatsApp, Telegram, call, SMS, copy, then "edit");
 * Ctrl/⌘+click or a long press runs the column's default action at once. A number that is not valid offers only
 * call and copy. With the column's switch off it is the plain tel: link it always was. Clicking the cell around the
 * number (or Enter / F2) still edits it.
 */
export const PhoneNumber = ({
  accountId,
  itemId,
  columnId,
  settings,
  value,
  text,
  editable,
  telegramRaw,
  onEdit,
}: {
  accountId: string;
  itemId: string;
  columnId: string;
  settings: Record<string, unknown>;
  value: unknown;
  text: string | null;
  editable: boolean;
  telegramRaw: string | null;
  onEdit: () => void;
}) => {
  const enabled = phoneColumnConfig(settings).enabled;
  const status = useSmsStatus(accountId, enabled);
  const prefs = usePhonePrefs(enabled);
  const device = useMemo(() => currentDevice(), []);
  const menu = useActionMenu();
  const [sms, setSms] = useState<string | null | false>(false);
  const [callPanel, setCallPanel] = useState<{ href: string | null; text: string } | null>(null);
  const press = useRef<{ timer: number | null; fired: boolean }>({ timer: null, fired: false });

  const cell = cellPhone({ settings, value, sms: status.data ?? null, device, telegramRaw });
  const shown = text ?? cell.phone;
  // a number not recognised is kept as written — a soft mark and a tip, never an error.
  const unknown = !!cell.phone && !cell.info.valid;
  const unknownTip = unknown ? t('phone.unrecognized') : undefined;

  if (!enabled || !cell.actions.length) {
    // The feature is off (or nothing applies): the plain link of before.
    const href = cell.phone ? `tel:${cell.phone.replace(/[^\d+*#]/g, '')}` : undefined;
    return href ? (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        dir="ltr"
        data-testid="phone-link"
        data-phone-menu="off"
        data-valid={!unknown || undefined}
        title={unknownTip}
        className={cn('truncate text-primary underline', unknown && 'phone-unrecognized')}
        onClick={(e) => e.stopPropagation()}
      >
        {shown}
      </a>
    ) : (
      <span className="truncate" dir="ltr">
        {shown}
      </span>
    );
  }

  const run = (step: PhoneStep) => {
    switch (step.kind) {
      case 'open':
        if (step.newTab) window.open(step.href, '_blank', 'noopener,noreferrer');
        else window.location.assign(step.href);
        return;
      case 'copy':
        copyText(step.text);
        return;
      case 'call-panel':
        setCallPanel({ href: step.href, text: step.text });
        return;
      case 'sms-dialog':
        setSms(step.device);
        return;
      case 'none':
        return;
    }
  };
  const runAction = (action: PhoneAction) =>
    run(
      planPhoneAction(action, cell, {
        device,
        prefs: prefs.data,
        smsFromSystem: !!status.data?.can_send,
        telegramRaw,
      }),
    );
  const gesture = (kind: 'click' | 'default', e: MouseEvent<HTMLElement>) => {
    const target = clickTarget(kind, prefs.data, settings, cell.actions);
    if (target === 'menu') menu.fromTrigger(e);
    else if (target !== 'none') runAction(target);
  };

  const entries: MenuEntry[] = [
    ...cell.actions.map((a): MenuEntry => ({
      label: t(`phone.action.${a}`),
      icon: <Icon name={ICON[a]} size={16} />,
      testId: `phone-action-${a}`,
      onSelect: () => runAction(a),
    })),
    ...(editable
      ? ([
          { kind: 'separator' },
          {
            label: t('menu.cell.edit'),
            icon: <Icon name="edit" size={16} />,
            shortcut: 'F2',
            testId: 'phone-action-edit',
            onSelect: onEdit,
          },
        ] as MenuEntry[])
      : []),
  ];

  const clearPress = () => {
    if (press.current.timer != null) window.clearTimeout(press.current.timer);
    press.current.timer = null;
  };
  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    press.current.fired = false;
    clearPress();
    // Long press is a touch gesture; a mouse has Ctrl/⌘+click.
    if (e.button !== 0 || e.pointerType === 'mouse') return;
    press.current.timer = window.setTimeout(() => {
      press.current.fired = true;
      press.current.timer = null;
      const action = clickTarget('default', prefs.data, settings, cell.actions);
      if (action !== 'menu' && action !== 'none') runAction(action);
    }, LONG_PRESS_MS);
  };

  return (
    <>
      <button
        type="button"
        dir="ltr"
        data-testid="phone-link"
        data-phone-menu="on"
        data-valid={cell.info.valid || undefined}
        aria-haspopup="menu"
        title={unknown ? `${t('phone.unrecognized')} · ${t('phone.hint')}` : t('phone.hint')}
        className={cn(
          'max-w-full truncate text-primary underline select-none [-webkit-touch-callout:none]',
          unknown && 'phone-unrecognized',
        )}
        onPointerDown={onPointerDown}
        onPointerUp={clearPress}
        onPointerLeave={clearPress}
        onPointerCancel={clearPress}
        onContextMenu={(e) => {
          // A long press on a phone also fires contextmenu: the default action ran, the cell menu must not open.
          if (press.current.fired) {
            e.preventDefault();
            e.stopPropagation();
          }
        }}
        onClick={(e) => {
          e.stopPropagation();
          if (press.current.fired) {
            press.current.fired = false;
            e.preventDefault();
            return;
          }
          gesture(e.ctrlKey || e.metaKey ? 'default' : 'click', e);
        }}
      >
        {shown}
      </button>
      <Menu at={menu.at} onClose={menu.close} items={entries} label={t('phone.menu')} testId="phone-menu" />
      {/* The dialogs sit in portals, but React events still bubble to the table cell: a click in the SMS dialog
          reached the cell (already selected) and opened its editor, unmounting the dialog. */}
      <div
        className="contents"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {sms !== false ? (
          <SmsDialog
            accountId={accountId}
            itemId={itemId}
            columnId={columnId}
            phone={cell.phone}
            e164={cell.info.e164}
            platform={device.platform}
            device={sms}
            onClose={() => setSms(false)}
          />
        ) : null}
        {callPanel ? (
          <Dialog
            open
            onClose={() => setCallPanel(null)}
            title={t('phone.call.title')}
            footer={
              <>
                <Button variant="ghost" onClick={() => setCallPanel(null)}>
                  {t('common.close')}
                </Button>
                {callPanel.href ? (
                  <a
                    href={callPanel.href}
                    data-testid="phone-call-app"
                    className="inline-flex h-9 items-center rounded-[10px] border border-line-strong px-3 text-[0.8125rem] text-fg hover:border-primary"
                  >
                    {t('phone.call.withApp')}
                  </a>
                ) : null}
                <Button data-testid="phone-call-copy" onClick={() => copyText(callPanel.text)}>
                  <Icon name="copy" size={14} />
                  {t('phone.action.copy')}
                </Button>
              </>
            }
          >
            <div className="space-y-2" data-testid="phone-call-panel">
              <p
                dir="ltr"
                className="text-center font-display text-2xl font-extrabold tracking-wide text-heading select-all"
                data-testid="phone-call-number"
              >
                {cell.info.e164 ?? callPanel.text}
              </p>
              <p className="text-center text-xs text-muted">{t('phone.call.hint')}</p>
            </div>
          </Dialog>
        ) : null}
      </div>
    </>
  );
};
