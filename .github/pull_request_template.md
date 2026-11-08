## What and why

<!-- What does this change, and why? Link the issue it closes: "Closes #123". -->

## How it was tested

<!-- Commands you ran, and for UI changes a screenshot — in Hebrew (RTL) and English. -->

## Checklist

- [ ] Tests added or updated (API endpoint → `apps/api/test/<module>.test.ts`; shared logic → unit test; UI flow → `e2e/`), and `pnpm test` passes
- [ ] `pnpm format:check && pnpm lint && pnpm typecheck` pass
- [ ] i18n: every user-facing string is a key in **both** `packages/shared/src/i18n/he.json` and `en.json`; logical CSS (RTL) only
- [ ] No hard-coded client data or per-customer behaviour — names, ids, URLs, emails or business rules of one organisation; behaviour is a setting in the UI
- [ ] No secrets, tokens or real personal data in code, tests, fixtures or screenshots
- [ ] New dependencies (if any) pass `pnpm check:licenses`
- [ ] I have signed the CLA (`CLA.md`) (the CLA bot asks on your first pull request)
