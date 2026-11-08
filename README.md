# Bines OS

Bines OS is an open-source, self-hosted work-management platform: boards with typed columns, views (table, kanban,
calendar, Gantt and more), automations, dashboards, docs, forms, a client portal, AI agents and an MCP server. It runs
many isolated accounts in one installation. The UI is Hebrew-first (RTL) with English; the defaults are Israeli
(ILS, 18% VAT, the Hebrew calendar) and every one of them is a setting.

## Install in one command

```sh
docker run -d --name bines-os -p 3000:3000 -v bines_data:/data --restart unless-stopped ghcr.io/binesamit/open-crm:latest
```

Open <http://localhost:3000> and create the owner account in the browser. Nothing to configure: the embedded
database, file storage and generated keys live in the `bines_data` volume. For a server with HTTPS, PostgreSQL or
Docker Compose, see [`docs/SELF-HOSTING.md`](docs/SELF-HOSTING.md).

## Documentation

- [User guide](docs/user/README.md): boards, views, automations, sharing and everything else in the app.
- [Built-in help center](seed/help/README.md): the in-app help articles and guided tours every new installation
  loads on first boot.
- [Install and licensing guide](docs/GUIDE.md) ([Hebrew](docs/GUIDE.he.md)): what the license allows, installing,
  registration and FAQ.
- [Self-hosting](docs/SELF-HOSTING.md): the technical install, configuration, backups and upgrades.
- [REST API](docs/06-API.md): conventions and resources. Every installation also serves the live reference at
  `/api/docs` and the OpenAPI document at `/api/v1/openapi.json`.
- [MCP server](docs/06-API.md#5-mcp-server): connect Claude, ChatGPT or any MCP client at `/mcp`.
- [Extensions](docs/EXTENSIONS-GUIDE.md): build your own; the full developer guide is in
  [`docs/extensions/`](docs/extensions/README.md).
- [`llms.txt`](llms.txt): what an AI assistant should read first. Coding agents start at [`AGENTS.md`](AGENTS.md).
- Architecture and specs: [`docs/DECISIONS.md`](docs/DECISIONS.md), then [`docs/00-PRD.md`](docs/00-PRD.md) onwards;
  [roadmap](docs/12-ROADMAP.md).

## Develop

```sh
pnpm i
cp .env.example .env          # values match docker-compose.yml
docker compose up -d          # postgres, mailpit, minio
pnpm db:migrate && pnpm db:seed
pnpm dev                      # api :3000, web :5173
```

A pnpm monorepo: `apps/api` (Hono, TypeScript), `apps/web` (React, Vite), `apps/worker` (graphile-worker) and
`packages/*`, on PostgreSQL with Drizzle. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request.

## License

Open source under the [GNU AGPL-3.0](LICENSE.md), with the additional permissions in
[`LICENSE-EXCEPTIONS.md`](LICENSE-EXCEPTIONS.md). You may use, change, share and host it for any purpose, including
commercially; if you run a changed version as a service for others, offer them its source. Extensions and
integrations that use the public API may use any license, and the SDK packages are MIT. The name and logo are
trademarks ([`TRADEMARKS.md`](TRADEMARKS.md)). Contributions are accepted under the [CLA](CLA.md). Plain-language FAQ:
[`docs/GUIDE.md`](docs/GUIDE.md#1-what-the-license-allows).

**No warranty, no liability.** The software is provided "as is", without warranty of any kind, and the authors are
not liable for any damage or loss arising from its use (sections 15–16 of the AGPL; the same in the MIT license of the
SDK packages). You run it, host it and keep your data and backups at your own risk. The legal document drafts the
software ships with are templates, not legal advice.

Google, Microsoft and other product names mentioned in this repository are trademarks of their owners, used only to
describe compatibility; this project is not affiliated with or endorsed by them.
