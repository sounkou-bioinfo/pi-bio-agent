---
title: Pi Bio
---

# Pi Bio

Pi Bio is a scientific research workspace with a Svelte interface shared by the browser and Electron desktop. Conversations, drafts, and scientific tables persist between visits; a supervised worker runs DuckDB and session-isolated R.

```text
web / Electron
      |
   HTTP + SSE
      |
AgentHarness v2 API ---- Harness session log
      |
science worker -------- DuckDB
      |
   DuckNNG -- NNG ----- R
```

Harness owns conversations, tools, cancellation, recovery, and child lanes. DuckDB owns durable scientific tables. R is persistent scratch state. `delegate` runs a child Harness lane directly.

## Try the GUI

Install with Node.js 24 or later:

```sh
npm install
```

Pi Bio uses Pi’s provider catalog and credential API, reusing `~/.pi/agent/auth.json`. Choose a model and connect its provider in the sidebar. The default is an OpenAI Codex subscription model, but authentication and model controls are provider-neutral. No API-key environment setup is required.

### Browser development

```sh
npm run dev
```

Open <http://127.0.0.1:5173>. Vite proxies the API at `127.0.0.1:4317`.

### Built web application

```sh
npm run build
npm start
```

Open <http://127.0.0.1:4317>. By default, `~/.pi/bio` holds Pi session logs, `workspace.sqlite` for drafts/archival, and `science.duckdb` for scientific tables.

### Desktop application

```sh
npm run desktop
```

To assemble a platform-native directory:

```sh
npm run package:desktop
```

Outputs are under `apps/desktop/dist/`; on Linux, run `apps/desktop/dist/linux-unpacked/pi-bio`.

New sessions default to `openai-codex/gpt-5.6-sol`; model changes are persisted by Pi per session. `PI_BIO_DATA_DIR`, `PI_BIO_HOST`, `PI_BIO_PORT`, and `PI_BIO_API_TOKEN` control application deployment; they are not model credentials. A non-loopback API refuses to start without a token.

R execution additionally requires R packages `jsonlite`, `mirai`, `nanoarrow`, and `nanonext`. The pinned `pi-ducknng` source provisions the matching DuckDB extension. `npm run test:integration` exercises that path.

The Windows CI job runs workspace checks, desktop directory packaging, and the desktop smoke test. R/NNG provisioning is skipped on Windows unless `DUCKNNG_EXTENSION_PATH` is supplied. Windows R/NNG execution remains unverified.

## Working with sessions

The chat renders model-provided reasoning, Markdown, highlighted code and patches, and copyable code blocks. **Session** opens recorded token/cost estimates, rename, clone, fork-from-message, tree, archive, and restore controls. Archiving is reversible and never deletes scientific data. Forks copy conversation history, not shared DuckDB tables or R memory.

Type `/` for supported commands: `/new`, `/name`, `/session`, `/model`, `/thinking`, `/tree`, `/fork`, and `/clone`. Arrow keys select, Tab completes, Enter accepts, and Escape dismisses. Shift+Tab cycles the selected model’s supported thinking levels. Resource/extension reload and full Pi extension loading are not implemented; **Reload view** only reloads saved application state. Cost estimates are not subscription bills or remaining account quotas.

## Tools

- `duckdb_sql`: bounded SQL results over the durable workspace.
- `r_eval`: session-isolated persistent R over NNG.
- `r_reset`: discard one session's R scratch environment.
- `delegate`: one isolated Harness child lane without recursive delegation.

## Verify

```sh
npm run check
npm run test:integration
npm audit
```

`npm run test:desktop` checks the desktop API connection, preload bridge, and clipboard permissions. On headless Linux, run `xvfb-run -a npm run test:desktop` after building.

See [docs/design.md](docs/design.md) for durability and security boundaries. The worker isolates failures; untrusted or multi-user execution still requires a container or VM.
