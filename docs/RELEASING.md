# Releasing

How a version of the platform reaches people: a tag, an image, a GitHub release. This page is for maintainers who cut
releases. Nothing here needs a person's account or a server of the project's own — GitHub builds and hosts everything.

## Every release

1. Make sure `main` is green: `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm docs:check`,
   and the E2E suite (`node e2e/run-stacks.mjs`) on the commit you release.
2. Bump the version in `package.json` and `apps/api/package.json` (the same number; it is what the app shows under
   ? → About and on the sign-in screen), commit, and tag: `git tag v1.2.3 && git push origin v1.2.3`.
3. `.github/workflows/release.yml` builds `docker/Dockerfile` and publishes `ghcr.io/binesamit/open-crm` with the tags
   `1.2.3`, `1.2` and `latest`, then opens a GitHub release whose notes carry the one-line install.
4. Installations that run `:latest` update with `docker pull` + a restart; the migrations run on start
   (`docs/SELF-HOSTING.md` → Upgrades).

The image is public once the package's visibility is set to public in the repository's Packages settings (once).

## The first public release (once)

The public repository starts from one commit of a cleaned tree, without the development history:

```sh
# from the cleaned, green branch
git archive --format=tar HEAD | (mkdir ../public && cd ../public && tar xf -)
cd ../public && git init -b main && git add -A && git commit -m "Bines OS 1.0.0"
git remote add origin git@github.com:binesamit/open-crm.git && git push -u origin main
git tag v1.0.0 && git push origin v1.0.0
```

Before that push, in the tree you archive:

- If the repository moves, change `binesamit/open-crm` everywhere (`git grep -n binesamit/open-crm`) and regenerate the
  embedded guide (`pnpm --filter @bines/api docs:guide`).
- `pnpm licenses:notices` so `THIRD-PARTY-NOTICES.md` matches the lockfile.
- Run a secrets scan on the tree (for example gitleaks) and grep for production identifiers and private paths; only
  the fake fixture ids in the tests may remain.
- Repository settings: Discussions on, Issues on with the templates in `.github/`, the CLA workflow's token
  (`.github/workflows/cla.yml`), private vulnerability reporting on (`SECURITY.md` points there), branch protection
  on `main` requiring the CI checks.

## What a release never contains

Customer data, production identifiers, people's names, keys or tokens. The seed templates are generic sample boards;
the E2E suite runs against its own fresh databases.
