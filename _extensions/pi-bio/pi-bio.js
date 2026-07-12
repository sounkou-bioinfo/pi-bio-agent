// packages/quarto-engine/src/pi-bio.ts
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
var ENGINE_NAME = "pi-bio";
var CELL_LANGUAGE = "pi-bio";
var PROCESS_TIMEOUT_MS = 12e4;
var PROCESS_MAX_BUFFER = 8 * 1024 * 1024;
var quarto;
var escapeHtml = (value) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
var renderValue = (value) => {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value, null, 2);
    return json === void 0 ? String(value) : json;
  } catch {
    return String(value);
  }
};
var markdownLabel = (value) => String(value ?? "figure").replaceAll("[", "\\[").replaceAll("]", "\\]");
var renderEvent = (event, context) => {
  const value = renderValue(event.value);
  if (event.kind === "markdown") return value;
  if (event.kind === "json") {
    return `

\`\`\` json
${value}
\`\`\`
`;
  }
  if (event.kind === "figure") {
    if (!event.value || typeof event.value !== "object" || Array.isArray(event.value)) {
      throw new Error("pi-bio figure output must be an object");
    }
    const figure = event.value;
    if (typeof figure.path !== "string" || figure.path.length === 0) {
      throw new Error("pi-bio figure output requires a non-empty path");
    }
    const absolutePath = isAbsolute(figure.path) ? resolve(figure.path) : resolve(context.projectDir, figure.path);
    const projectRelative = relative(context.projectDir, absolutePath);
    if (projectRelative.startsWith(".." + sep) || isAbsolute(projectRelative)) {
      throw new Error(`pi-bio figure path escapes the project: ${figure.path}`);
    }
    if (!Deno.statSync(absolutePath).isFile) throw new Error(`pi-bio figure path is not a file: ${figure.path}`);
    context.supporting.add(absolutePath);
    const documentRelative = relative(context.sourceDir, absolutePath).split(sep).join("/") || absolutePath.split(sep).pop();
    const image = `![${markdownLabel(figure.alt)}](${encodeURI(documentRelative)})`;
    const caption = typeof figure.caption === "string" && figure.caption.length > 0 ? `

${figure.caption}` : "";
    return `

${image}${caption}
`;
  }
  return `<pre><code>${escapeHtml(value)}</code></pre>`;
};
var renderCellOutput = (cell, events, context) => {
  if (!cell.output) return "";
  const cellEvents = events.filter((event) => event.cell === cell.id);
  if (cellEvents.length === 0) return "";
  return cellEvents.map((event) => {
    const body = renderEvent(event, context);
    if (event.kind === "markdown" || event.kind === "figure") return body;
    const label = event.kind === "json" ? "JSON output" : "Output";
    return [
      `<details class="pi-bio-output">`,
      `<summary>${label}: ${escapeHtml(cell.id)}</summary>`,
      "",
      body,
      "",
      "</details>"
    ].join("\n");
  }).join("\n");
};
var sourceForOutput = (cell) => {
  if (!cell.echo) return "";
  const source = cell.sourceVerbatim;
  for (const language of [
    "ts",
    "typescript",
    "js",
    "javascript"
  ]) {
    const quartoFence = `\`\`\`{${language} .${CELL_LANGUAGE}}`;
    if (source.startsWith(quartoFence)) {
      return `\`\`\`{.${language} .${CELL_LANGUAGE}}${source.slice(quartoFence.length)}`;
    }
  }
  return source;
};
var optionIsFalse = (value) => value === false || value === "false";
var cellVisibility = (options) => {
  if (optionIsFalse(options?.include)) return {
    echo: false,
    output: false
  };
  return {
    echo: !optionIsFalse(options?.echo),
    output: !optionIsFalse(options?.output)
  };
};
var workerSource = (cells) => {
  const cellBlocks = cells.map((cell) => [
    `__piBioCell = ${JSON.stringify(cell.id)};`,
    `__piBioContext.enterWith(${JSON.stringify(cell.id)});`,
    [
      "r",
      "python",
      "py",
      "bash",
      "sh"
    ].includes(cell.language) ? `__piBioRunProcess(${JSON.stringify(cell.language)}, ${JSON.stringify(cell.source)});` : cell.source,
    "await new Promise((resolve) => setImmediate(resolve));"
  ].join("\n")).join("\n\n");
  return `
import { AsyncLocalStorage as __PiBioAsyncLocalStorage } from "node:async_hooks";
import { spawnSync as __piBioSpawnSync } from "node:child_process";
import { writeFileSync as __piBioWriteFileSync } from "node:fs";
const __piBioEvents = [];
let __piBioCell = "process";
let __piBioError;
const __piBioResultFile = process.argv[2];
const __piBioContext = new __PiBioAsyncLocalStorage();
const __piBioEncode = (value) => {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
};
const __piBioJson = (value) => {
  try {
    const json = JSON.stringify(value, (_key, candidate) =>
      typeof candidate === "bigint" ? String(candidate) + "n" : candidate
    );
    return json === undefined ? String(value) : JSON.parse(json);
  } catch {
    return __piBioEncode(value);
  }
};
const __piBioEmit = (kind, level, value) => {
  const encoded = kind === "json" || kind === "figure" ? __piBioJson(value) : __piBioEncode(value);
  __piBioEvents.push({ cell: __piBioContext.getStore() ?? __piBioCell, kind, level, value: encoded });
};
const __piBioRunProcess = (language, source) => {
  const command = language === "r"
    ? ["Rscript", ["--vanilla", "-e", source], undefined]
    : language === "python" || language === "py"
      ? ["python3", ["-"], source]
      : ["bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", source], undefined];
  const [program, args, input] = command;
  const result = __piBioSpawnSync(program, args, {
    encoding: "utf8",
    input,
    maxBuffer: ${PROCESS_MAX_BUFFER},
    timeout: ${PROCESS_TIMEOUT_MS},
  });
  if (result.stdout) __piBioEmit("text", "stdout", result.stdout.trimEnd());
  if (result.stderr) __piBioEmit("text", "stderr", result.stderr.trimEnd());
  if (result.error || result.status !== 0) {
    const message = result.error?.message ?? String(program) + " exited with status " + String(result.status ?? "unknown");
    throw new Error(String(language) + " cell failed: " + message);
  }
};
const __piBioConsole = globalThis.console;
globalThis.console = new Proxy(__piBioConsole, {
  get(target, property, receiver) {
    if (["log", "info", "debug", "warn", "error", "dir"].includes(String(property))) {
      return (...values) => __piBioEmit("text", String(property), values.map(__piBioEncode).join(" "));
    }
    return Reflect.get(target, property, receiver);
  },
});
globalThis.piBio = Object.freeze({
  display: (value) => __piBioEmit("text", "display", value),
  json: (value) => __piBioEmit("json", "display", value),
  markdown: (value) => __piBioEmit("markdown", "display", String(value)),
  figure: (path, options = {}) => __piBioEmit("figure", "display", {
    ...(options && typeof options === "object" ? options : {}),
    path: String(path),
  }),
});
const __piBioFail = (error) => {
  __piBioError = {
    cell: __piBioContext.getStore() ?? __piBioCell,
    message: String(error?.message ?? error),
    stack: error?.stack,
  };
  process.exitCode = 1;
  process.exit(1);
};
process.on("uncaughtException", __piBioFail);
process.on("unhandledRejection", __piBioFail);
process.on("exit", () => {
  try {
    __piBioWriteFileSync(__piBioResultFile, JSON.stringify({ events: __piBioEvents, error: __piBioError }), "utf8");
  } catch {
    // The parent reports a missing result file with the captured process output.
  }
});

${cellBlocks}
`;
};
var runNodeCells = async (options, cells) => {
  const projectDir = options.projectDir ?? Deno.cwd();
  const sourceDir = options.target.source ? dirname(quarto.path.absolute(options.target.source)) : projectDir;
  const tempFile = await Deno.makeTempFile({
    dir: sourceDir,
    suffix: ".ts"
  });
  const resultFile = await Deno.makeTempFile({
    dir: sourceDir,
    suffix: ".json"
  });
  try {
    await Deno.writeTextFile(tempFile, workerSource(cells));
    const command = new Deno.Command("node", {
      args: [
        "--experimental-strip-types",
        tempFile,
        resultFile
      ],
      cwd: projectDir,
      stdout: "piped",
      stderr: "piped"
    });
    const result = await command.output();
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr).trim();
    const resultText = await Deno.readTextFile(resultFile).catch(() => "");
    if (!resultText) {
      throw new Error([
        "pi-bio Quarto engine: Node did not return a result file.",
        stderr,
        stdout.slice(-2e3)
      ].filter(Boolean).join("\n"));
    }
    let parsed;
    try {
      parsed = JSON.parse(resultText);
    } catch (error) {
      throw new Error([
        "pi-bio Quarto engine: Node returned an invalid result file.",
        String(error),
        stderr
      ].filter(Boolean).join("\n"));
    }
    if (stdout.trim()) parsed.events.push({
      cell: "process",
      kind: "text",
      level: "stdout",
      value: stdout.trimEnd()
    });
    if (stderr) parsed.events.push({
      cell: "process",
      kind: "text",
      level: "stderr",
      value: stderr
    });
    if (!result.success && !parsed.error) {
      throw new Error(`pi-bio Quarto engine: Node exited with status ${result.code ?? "unknown"}.`);
    }
    return parsed;
  } finally {
    await Deno.remove(tempFile).catch(() => void 0);
    await Deno.remove(resultFile).catch(() => void 0);
  }
};
var RUNTIME_LANGUAGES = [
  "ts",
  "typescript",
  "js",
  "javascript",
  "r",
  "python",
  "py",
  "bash",
  "sh"
];
var cellLanguage = (cell) => {
  if (typeof cell.cell_type !== "object" || cell.cell_type === null || !("language" in cell.cell_type)) return "";
  return String(cell.cell_type.language).toLowerCase();
};
var isPiBioCell = (cell) => {
  if (!cell.sourceVerbatim.value.includes(".pi-bio")) return false;
  return RUNTIME_LANGUAGES.includes(cellLanguage(cell));
};
var engine = {
  init: (api) => {
    quarto = api;
  },
  name: ENGINE_NAME,
  defaultExt: ".qmd",
  defaultYaml: () => [
    "engine: pi-bio"
  ],
  defaultContent: () => [
    "```{ts .pi-bio}",
    'console.log("Hello from pi-bio");',
    "```"
  ],
  validExtensions: () => [],
  claimsFile: () => false,
  claimsLanguage: (language, firstClass) => {
    const normalized = language.toLowerCase();
    if (firstClass === CELL_LANGUAGE && RUNTIME_LANGUAGES.includes(normalized)) return 2;
    return normalized === CELL_LANGUAGE;
  },
  canFreeze: false,
  generatesFigures: true,
  launch: (context) => ({
    name: ENGINE_NAME,
    canFreeze: false,
    markdownForFile: (file) => Promise.resolve(quarto.mappedString.fromFile(file)),
    target: (file, _quiet, markdown) => {
      const resolved = markdown ?? quarto.mappedString.fromFile(file);
      return Promise.resolve({
        source: file,
        input: file,
        markdown: resolved,
        metadata: quarto.markdownRegex.extractYaml(resolved.value)
      });
    },
    partitionedMarkdown: (file) => Promise.resolve(quarto.markdownRegex.partition(Deno.readTextFileSync(file))),
    execute: async (options) => {
      const chunks = await quarto.markdownRegex.breakQuartoMd(options.target.markdown);
      const cells = [];
      for (const cell of chunks.cells) {
        if (isPiBioCell(cell)) {
          cells.push({
            id: `cell-${cells.length + 1}`,
            language: cellLanguage(cell),
            source: cell.source.value,
            sourceVerbatim: cell.sourceVerbatim.value,
            ...cellVisibility(cell.options)
          });
        }
      }
      if (cells.length === 0) {
        return {
          engine: ENGINE_NAME,
          markdown: options.target.markdown.value,
          supporting: [],
          filters: []
        };
      }
      const runtime = await runNodeCells(options, cells);
      if (runtime.error) {
        throw new Error([
          `pi-bio Quarto engine: ${runtime.error.cell} failed: ${runtime.error.message}`,
          runtime.error.stack
        ].filter(Boolean).join("\n"));
      }
      const projectDir = resolve(options.projectDir ?? Deno.cwd());
      const sourceDir = dirname(quarto.path.absolute(options.target.source));
      const renderContext = {
        projectDir,
        sourceDir,
        supporting: /* @__PURE__ */ new Set()
      };
      const processed = [];
      let cellIndex = 0;
      for (const cell of chunks.cells) {
        if (isPiBioCell(cell)) {
          const sourceCell = cells[cellIndex++];
          processed.push(sourceForOutput(sourceCell));
          const output = renderCellOutput(sourceCell, runtime.events, renderContext);
          if (output) processed.push(`

${output}
`);
        } else {
          processed.push(cell.sourceVerbatim.value);
        }
      }
      return {
        engine: ENGINE_NAME,
        markdown: processed.join(""),
        supporting: [
          ...renderContext.supporting
        ],
        filters: []
      };
    },
    dependencies: (_options) => Promise.resolve({
      includes: {}
    }),
    postprocess: (_options) => Promise.resolve()
  })
};
var pi_bio_default = engine;
export {
  pi_bio_default as default
};
