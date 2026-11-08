# @bines/ext-sdk

The SDK for Bines OS extensions (MIT, no dependencies, ESM, TypeScript types included).

- `@bines/ext-sdk` — for an extension **page** shown inside Bines in a sandboxed iframe: context, REST calls with a
  short-lived extension token, per-extension storage, file upload, toasts, modals, opening item cards, auto-resize.
- `@bines/ext-sdk/server` — for an extension's **server**: verify signed calls from Bines (automation actions,
  lifecycle events), fire automation triggers, and call the API as the extension's service user (OAuth
  `client_credentials`). Uses Web Crypto only (Node 18+, Deno, Bun, Workers).

## Install

```sh
npm install @bines/ext-sdk
# or start a whole project (a page, a manifest and an optional server):
npx create-bines-app my-extension
```

## Use

```ts
import { createBinesSdk } from '@bines/ext-sdk';

const bines = createBinesSdk({ hostOrigin: 'https://your-bines.example.com' });
const ctx = await bines.ready();
const { data } = await bines.items<{ data: { id: string; name: string }[] }>();
```

```ts
import { verifyBinesSignature } from '@bines/ext-sdk/server';
```

## Documentation

Every Bines deployment serves the full developer guide and a one-hour tutorial:

- Inside the app: **Administration → Extensions → For developers → Read the developer guide**
- Public pages (no sign-in): `https://<your Bines>/api/docs/extensions` and `https://<your Bines>/api/docs/extensions/quickstart`

In the source repository: `docs/extensions/README.md` (§7 page SDK, §11 server SDK) and `docs/extensions/QUICKSTART.md`.

## Development (in the Bines repository)

```sh
pnpm --filter @bines/ext-sdk test       # tests
pnpm --filter @bines/ext-sdk build:npm  # dist/ (what npm gets)
```

Publishing: `scripts/publish-sdk.ps1` (dry run by default).
