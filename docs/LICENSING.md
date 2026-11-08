# Licensing: keys, registration and the license server

The platform is open source under the GNU AGPL-3.0 (`LICENSE.md`, `LICENSE-EXCEPTIONS.md`, `TRADEMARKS.md`; the SDK
packages and integrations are MIT). **Nothing in the software is locked**: every installation holds every capability,
for any number of users and items, with no key. This document describes the optional machinery that remains — license
keys as a record of a provider's activation and support, and the license server any installation can run for the
installations it serves. It is for self-hosters and for operators who sell hosting or support; a plain-language FAQ
is in [`GUIDE.md`](GUIDE.md#1-what-the-license-allows).

## Which license covers what

| What | License | File |
|---|---|---|
| The platform (everything not listed below) | AGPL-3.0-only, with the section 7 additional permissions | `LICENSE.md`, `LICENSE-EXCEPTIONS.md` |
| `packages/sdk`, `packages/ext-sdk`, `packages/create-bines-app`, `integrations/*` | MIT | `LICENSE` in each package |
| Third-party dependencies | their own (`scripts/check-licenses.mjs`, `THIRD-PARTY-NOTICES.md`) | — |

`package.json`: `"license": "AGPL-3.0-only"` (MIT in the MIT packages); every source file carries an SPDX header.
Contributors sign the CLA (`CLA.md`, bot: `.github/workflows/cla.yml`).

## What a license key is — and is not

A key is **a record, not a lock**. It names a plan (`registered` / `business` / `enterprise`), a number of seats, a
support level and an expiry, and it binds to one installation. The owner console shows what it says; above `seats`
active users it shows a warning; past its grace period it shows "expired". It never turns a capability off and never
makes anything read-only: `LICENSED_FEATURES_BUILT` is empty and the AGPL lets anyone remove a check anyway.

Who uses keys: an operator that sells hosting, installation or support to the people who run their own copies — the
key tells both sides which installation is covered and until when. An installation that never registers and never
installs a key is a complete installation.

Data, in one place: `packages/shared/src/api/editions.ts` (plans, support levels, the feature keys that plans of a
hosting operator may list — see `docs/08-ACCOUNT-ADMIN.md` and the plans in the owner console for how an operator
gates *its hosted accounts* by plan; that is the operator's business with its customers, not a lock on the software).

## Hosting others ("platform mode")

Any installation may host accounts for other people and charge for it. Nothing needs a key: the owner console's
**Plans** (limits per plan, prices, Stripe), **Self sign-up** (off by default — the one switch that opens the public
sign-up screens), **Legal documents**, trial emails and support are the same code on every installation (decision D32).
The "first steps" card lists what open sign-up still needs (email, a published legal document, a public plan, the
switch).

## License keys

- **Format**: `lic1.<payload>.<signature>` — payload = base64url JSON, signature = Ed25519 over `lic1.<payload>`
  (`packages/shared/src/api/license.ts`). Payload: `licensee`, `features[]`, `expires` (ISO | null), `id?`,
  `issued_at?`, `plan?`, `seats?` (number | null), `instance_id?`, `grace_days?` (default 14), `support?`.
- **Verification**: offline, on the server (`apps/api/src/modules/license/license-key.ts`) against the trusted public
  keys: the one embedded in `public-key.ts`, this installation's own signing key (when it is a license server), and
  the **provider's key** stored with the license server address (below). A key that names an `instance_id` works only
  on that installation.
- **States** (the owner console's license card): `valid`; `expiring` (≤ 30 days left); `grace` (past `expires`,
  within `grace_days`); `expired`; `revoked` (only after an online check learned it); `invalid` (unreadable, not
  signed by a trusted key, or another installation's). None of them changes what the software does.
- **Storage**: `platform_settings` row `license`. Owner console → Licensing → License: paste / upload, remove,
  "Check online". API: `GET / PUT / DELETE /platform/license`, `POST /platform/license/check`.

## Instance id

A random UUID made on first boot (`platform_settings` row `instance`; `apps/api/src/modules/license/instance.ts`). It
identifies nothing else — no host name, no address.

## The provider (the installation's side)

- **Address**: owner console → Licensing → settings → "License server address", else env `LICENSE_SERVER_URL`. **No
  address is built into the code**: with neither, registration and online checks are simply unavailable; keys can
  still be pasted.
- **The provider's public key** is fetched when the address is saved (`GET <server>/api/v1/public/licenses/key`) and
  stored beside it (`platform_settings` row `licensing`, `server_public_key`); the card shows its fingerprint. If the
  server cannot be reached, the owner pastes the PEM by hand (`PATCH /platform/licensing {server_public_key}`). Keys the
  provider issues are trusted only once its key is stored.
- **Registration** is optional: the License card's "Register" opens a short form (company, size, role, use case,
  email, an unticked "you may email me updates"). Submit → the provider emails a verification link → this installation
  picks up its key (`POST /platform/registration/poll`) and installs it by itself. Offline installs: a link to
  `<server>/register?instance=<id>` — register from any browser and paste the key.

## The license server (the provider's side)

Any installation becomes a license server in the owner console: Licensing → **License server** → **Create a signing
key** (`POST /platform/license-server/key`). The Ed25519 private key is sealed with `SECRET_MASTER_KEY` in the
`platform_settings` row `license_server`; the public key and its fingerprint are shown for the installations it will
serve, and published at `GET /api/v1/public/licenses/key`. Removing the key (`DELETE …/key`) means every key it signed
stops verifying on installations that trusted it — the console says so first. An operator that prefers the environment
sets `LICENSE_SIGNING_KEY` (PEM, PEM with `\n`, or base64); the console's key wins when both exist. The server trusts
its own key, so keys it issues verify on it too.

- Public: `GET /api/v1/public/licenses/key`, `GET …/installations/config`, `POST …/installations/register` (rate
  limit: 10 an hour per address, 5 per installation, 5 per email; Turnstile when the owner turned on the platform
  place "Installation registration"; a verification email — **no key before the email is verified**),
  `POST …/installations/verify`, `POST …/installations/status` (the installation's poll, with a secret only it holds),
  `POST …/installations/heartbeat`, `POST /api/v1/public/licenses/check`. A registered installation proves itself with
  that same `poll_secret` on the heartbeat, the online check and a re-registration; an installation that lost its secret
  is released by the owner (Installations → "Release registration", audited as `installation.released`).
  Pages: `/register`, `/register/verify`.
- Tables (migration 0075): `license_installations` and `issued_licenses`.
- Owner console → Licensing: **Installations** (filters, CSV export) and **Licenses** (issue, renew +1 year, change
  plan, revoke, copy key, email key). `pnpm license:sign` still signs offline with a PEM from `pnpm license:keygen`.

### Expiry reminders

On a license server only. An hourly job (`license.expiry_reminders`) looks at the licenses that are not revoked and
expire within the largest reminder setting, and sends the reminder of the nearest threshold reached — by default **30
days, then 7 days** before the expiry — to the customer and to every platform owner. Each `(license, expiry, days)` is
claimed once in `license_reminders`, so nothing is sent twice. Settings: owner console → Licensing → **Expiry
reminders** (`platform_settings` row `license_ops`).

### Online purchase — optional

OFF by default. A generic provider interface (`license-payments.ts`) with **Stripe** implemented first (plain HTTPS
calls). With the provider not set up, every purchase endpoint answers 404 and no purchase UI shows anywhere.

Setting it up (owner console → Licensing → **Payments**): a Stripe Product and **Price** per plan; the webhook endpoint
shown on the card (`<api address>/api/v1/public/licenses/webhook/stripe`) with `checkout.session.completed` and
`invoice.paid`; the secret key and the webhook signing secret (sealed, write-only); then **Sell licenses online** on.

The flow: `/buy?plan=&instance=` → `POST /api/v1/public/licenses/checkout` → Stripe's hosted page → the webhook issues
(or renews) the license and emails the key. Each event id is recorded in `license_payment_events` (replays change
nothing). Migration 0085.

## Privacy and telemetry

- Registration sends, **only on "Submit"**: the form's answers + the random `instance_id` + the version.
- **Never sent**: board content, item names, files, the user list, internal addresses.
- **Telemetry is off by default.** If the owner turns it on (owner console → Licensing → settings, which shows the
  exact payload), a daily heartbeat sends `{ instance_id, version, active_users, boards }` to the configured provider —
  nothing else. With no provider configured nothing is sent at all.
- `BINES_TELEMETRY=false` forces it off whatever the console says; `BINES_UPDATE_CHECK=false` turns off the online key
  check (and any update check).
- Better Auth's own telemetry is disabled explicitly (`telemetry: { enabled: false }`).

