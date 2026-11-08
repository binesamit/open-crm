# Security Policy

## Reporting a vulnerability

**Please do not open a public issue, discussion or pull request for a security problem.**

Report it privately: open the repository's **Security** tab → **Report a vulnerability** (GitHub Security
Advisories — `https://github.com/binesamit/open-crm/security/advisories/new`). Only the maintainers can see the report,
and we can work on the fix and the advisory together with you there.

Please include:

- what is affected (component — API, web app, worker, MCP server, an SDK package — and version or commit);
- how to reproduce it, step by step (a proof of concept is welcome), and what an attacker could achieve;
- any logs, requests or screenshots that help — **with real data, tokens and passwords removed**.

## What to expect

This project is maintained part-time, so we handle reports on a **best-effort basis, with no guaranteed response
times**. In practice:

- we acknowledge your report as soon as we can;
- we then assess it (confirmed or not, and how severe) and tell you what we found;
- critical and high-severity issues are fixed first; medium and low ones may wait for a regular release;
- a public advisory (GitHub Security Advisory, CVE when relevant) is published after a fixed release is available.

If you have not heard back after a reasonable time, a short follow-up on the same report is welcome.

We keep you updated while we work on it, and we credit you in the advisory unless you prefer otherwise. We ask that
you do not disclose the issue publicly until a fix is released or 90 days have passed since your report, whichever
comes first.

## Supported versions

Security fixes are made for:

| Version                                                        | Supported |
| -------------------------------------------------------------- | --------- |
| The latest release (the latest minor version only)             | ✅        |
| `main` (unreleased)                                            | ✅        |
| Older releases                                                 | ❌ — please upgrade |

This is self-hosted software: you run your own installation, so you are responsible for upgrading it. Watch the
repository's releases (Watch → Custom → Releases and Security alerts) to hear about fixes.

## Scope

In scope: the code in this repository — `apps/api`, `apps/web`, `apps/worker`, the MCP server, the `packages/*`
packages (including the SDKs) and the `integrations/*` code — and its default configuration (`docker-compose.yml`,
`.env.example`).

Out of scope:

- installations you do not own or have no permission to test — **test only on your own local installation**;
- vulnerabilities in third-party dependencies that are not exploitable through this project (please report those
  upstream; if they are exploitable here, report them to us too);
- issues that need a compromised server, a malicious administrator of the same installation, or physical access;
- volumetric denial of service, spam, social engineering, and missing hardening headers without a demonstrated impact;
- the hosted service of any company that runs this software — report to that company.

## Safe harbor

We will not take legal action against you for research that follows this policy: done in good faith, on your own
installation, without accessing, changing or destroying data that is not yours, and reported to us privately first.
