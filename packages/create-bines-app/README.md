# create-bines-app

Start a new Bines OS extension in a minute: a Vite page with `@bines/ext-sdk`, a manifest (development and
production), and — when asked — an extension server that verifies signed calls from Bines. MIT, no dependencies.

```sh
npx create-bines-app my-board-view
cd my-board-view
npm install
npm run dev
```

Then, in a **development** Bines (a production server refuses `localhost`): Administration → Extensions → For
developers → add by URL → `http://localhost:5180/manifest.json`.

## Options

| Option            | What it does                                                                        |
| ----------------- | ----------------------------------------------------------------------------------- |
| `--id my-ext`     | The extension id (default: the folder name). Lowercase letters, digits and dashes.   |
| `--name "Name"`   | The display name.                                                                   |
| `--port 5180`     | The dev server port (the extension server, with `--server`, uses the next one).      |
| `--server`        | Also an extension server: signed lifecycle calls and OAuth client credentials.       |
| `--sdk <spec>`    | The `@bines/ext-sdk` dependency (default: the published version on npm).            |

## Documentation

Every Bines deployment has the full developer guide and a one-hour tutorial — inside the app (Administration →
Extensions → For developers) and as public pages at `/api/docs/extensions` and `/api/docs/extensions/quickstart`.
