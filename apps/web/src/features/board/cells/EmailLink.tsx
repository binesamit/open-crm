// SPDX-License-Identifier: AGPL-3.0-only
import { emailComposeUrl, t, type EmailOpen } from '@bines/shared';
import { Menu, useActionMenu, type MenuEntry } from '@bines/ui';
import { useAppearance } from '../../../lib/appearance';
import { copyText } from '../../../lib/entity-menu';

/**
 * an address in an email column. A click asks where to write from — Gmail, Outlook on the web, the
 * device's mail app — or copies it (our menu, never the browser's); with a choice set in Profile → Appearance (or
 * the account's default) the click goes straight there and the menu stays on right-click / Shift+F10.
 */
const go = (app: Exclude<EmailOpen, 'ask'>, address: string) => {
  const url = emailComposeUrl(app, address);
  if (app === 'mailto') window.location.href = url;
  else window.open(url, '_blank', 'noopener,noreferrer');
};

export const EmailLink = ({ address, text }: { address: string; text: string }) => {
  const choice = useAppearance().value.email_open;
  const menu = useActionMenu();
  const items: MenuEntry[] = [
    { label: t('emailOpen.menu.gmail'), onSelect: () => go('gmail', address), testId: 'email-menu-gmail' },
    { label: t('emailOpen.menu.outlook'), onSelect: () => go('outlook', address), testId: 'email-menu-outlook' },
    { label: t('emailOpen.menu.mailto'), onSelect: () => go('mailto', address), testId: 'email-menu-mailto' },
    { kind: 'separator' },
    { label: t('emailOpen.menu.copy'), onSelect: () => copyText(address), testId: 'email-menu-copy' },
  ];
  return (
    <>
      <a
        href={emailComposeUrl('mailto', address)}
        dir="auto"
        className="truncate text-primary underline"
        data-testid="email-link"
        aria-haspopup={choice === 'ask' ? 'menu' : undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (choice === 'ask') menu.fromTrigger(e);
          else {
            e.preventDefault();
            go(choice, address);
          }
        }}
        onContextMenu={menu.onContextMenu}
        onKeyDown={menu.onKeyDown}
      >
        {text}
      </a>
      <Menu
        at={menu.at}
        onClose={menu.close}
        items={items}
        label={t('emailOpen.menuLabel', { address })}
        testId="email-menu"
      />
    </>
  );
};
