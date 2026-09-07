---
title: Pi Bio
---

# Pi Bio

Pi Bio is a Pi-native scientific agent application built on AgentHarness v2. One backend serves the browser and Electron apps; a supervised worker owns persistent DuckDB and session-isolated R over nanonext/NNG.

It is not a general agent SDK. There is no compatibility host, workbench layer, Jupyter control plane, or second agent lifecycle.

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
export OPENAI_API_KEY=...
```

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

Open <http://127.0.0.1:4317>. Sessions and `science.duckdb` live under `~/.pi/bio` by default.

### Desktop application

```sh
npm run desktop
```

To assemble a platform-native directory:

```sh
npm run package:desktop
```

Outputs are under `apps/desktop/dist/`; on Linux, run `apps/desktop/dist/linux-unpacked/pi-bio`.

Set `PI_BIO_MODEL=provider/model-id` to override `openai/gpt-5.4`. Set `PI_BIO_DATA_DIR`, `PI_BIO_HOST`, `PI_BIO_PORT`, or `PI_BIO_API_TOKEN` as needed. A non-loopback API refuses to start without a token.

R execution additionally requires R packages `jsonlite`, `mirai`, `nanoarrow`, and `nanonext`. The pinned `pi-ducknng` source provisions the matching DuckDB extension. `npm run test:integration` exercises that path.

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

See [docs/design.md](docs/design.md) for durability and security boundaries. The worker isolates failures; untrusted or multi-user execution still requires a container or VM.
