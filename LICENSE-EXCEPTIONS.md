# Additional permissions under GNU AGPL version 3, section 7

Copyright (c) 2026 Amit Bines (the "**copyright holder**").

This software is licensed under the GNU Affero General Public License, version 3 only (see `LICENSE.md`). As permitted
by section 7 of that license, the copyright holder grants the following additional permissions. They apply to the
version of the software distributed by the copyright holder and to every copy or modified version of it, unless the
distributor of a modified version removes them (section 7 allows removing additional permissions from a copy).

## 1. Extension exception

An "**extension**" is a program that interacts with the software only through its documented interfaces — the HTTP
API, the webhooks, the MCP server, the extension protocol and SDKs (`@bines/sdk`, `@bines/ext-sdk`,
`create-bines-app`), the Make and n8n integrations, or any other interface the documentation describes as public.

As an additional permission, the copyright holder permits you to develop, run, distribute and sell an extension under
any license of your choice, including a proprietary license, **even if the extension would otherwise be considered a
work based on the software** or a modified version of it. Running an extension together with the software does not
place any AGPL obligation on the extension. The software itself, including any copy that runs alongside an extension,
stays under the AGPL.

This exception does not cover:

- copying code from the software into the extension beyond what the public SDKs ship for that purpose;
- modifying the software itself (its server, worker, web app or packages); such modifications stay under the AGPL,
  including section 13 (network use) when you run them as a service.

## 2. SDKs and integrations

The following directories are published under the MIT license, stated in their own `LICENSE` files, and may be used
without any AGPL obligation: `packages/sdk`, `packages/ext-sdk`, `packages/create-bines-app`,
`integrations/n8n-nodes-bines-os`, `integrations/make-app-bines-os`.

## 3. Attribution (section 7(b))

A copy or modified version must keep the "About" screen's reference to the original project and its license, and the
source-code link the software shows under section 13. The link may point to the modified source (it must, if you changed
the software and run it as a service). You may not present the software, modified or not, as endorsed by the original
authors.

## 4. Trademarks (section 7(e))

No trademark license is granted. The name and logo of the product are governed by `TRADEMARKS.md`; the product name
shown to users is a setting so that a modified version can carry its own name.

---

Sections 1 and 2 are additional permissions; sections 3 and 4 are additional terms of the kinds section 7(b) and 7(e)
of the AGPL allow, and add nothing beyond them. If any part of this document is held unenforceable, the AGPL alone
applies to that part.
