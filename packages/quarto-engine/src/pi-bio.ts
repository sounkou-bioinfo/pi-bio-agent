import type {
  DependenciesOptions,
  EngineProjectContext,
  ExecuteOptions,
  ExecuteResult,
  ExecutionEngineDiscovery,
  ExecutionEngineInstance,
  ExecutionTarget,
  MappedString,
  PostProcessOptions,
  QuartoAPI,
} from "@quarto/types";
import { dirname } from "node:path";

const ENGINE_NAME = "pi-bio";
const CELL_LANGUAGE = "pi-bio";
const PROCESS_TIMEOUT_MS = 120_000;
const PROCESS_MAX_BUFFER = 8 * 1024 * 1024;

type Cell = {
  id: string;
  language: string;
  source: string;
};

type OutputEvent = {
  cell: string;
  kind: "text" | "json" | "markdown";
  level: string;
  value: unknown;
};

type RuntimeResult = {
  events: OutputEvent[];
  error?: { cell: string; message: string; stack?: string };
};

let quarto: QuartoAPI;

const escapeHtml = (value: string): string => value
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const renderValue = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    const json = JSON.stringify(value, null, 2);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
};

const renderEvent = (event: OutputEvent): string => {
  const value = renderValue(event.value);
  if (event.kind === "markdown") return value;
  if (event.kind === "json") {
    return `\n\n\`\`\` json\n${value}\n\`\`\`\n`;
  }
  return `<pre><code>${escapeHtml(value)}</code></pre>`;
};

const renderCellOutput = (cell: Cell, events: OutputEvent[]): string => {
  const cellEvents = events.filter((event) => event.cell === cell.id);
  if (cellEvents.length === 0) return "";
  const body = cellEvents.map(renderEvent).join("\n");
  return [
    `<details class="pi-bio-output">`,
    `<summary>Output: ${escapeHtml(cell.id)}</summary>`,
    "",
    body,
    "",
    "</details>",
  ].join("\n");
};

const sourceForOutput = (source: string): string => {
  for (const language of ["ts", "typescript", "js", "javascript"]) {
    const quartoFence = `\`\`\`{${language} .${CELL_LANGUAGE}}`;
    if (source.startsWith(quartoFence)) {
      return `\`\`\`{.${language} .${CELL_LANGUAGE}}${source.slice(quartoFence.length)}`;
    }
  }
  return source;
};

const workerSource = (cells: Cell[]): string => {
  const cellBlocks = cells.map((cell) => [
    `__piBioCell = ${JSON.stringify(cell.id)};`,
    `__piBioContext.enterWith(${JSON.stringify(cell.id)});`,
    ["r", "python", "py", "bash", "sh"].includes(cell.language)
      ? `__piBioRunProcess(${JSON.stringify(cell.language)}, ${JSON.stringify(cell.source)});`
      : cell.source,
    "await new Promise((resolve) => setImmediate(resolve));",
  ].join("\n")).join("\n\n");

  return `
import { AsyncLocalStorage } from "node:async_hooks";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
const __piBioEvents = [];
let __piBioCell = "process";
let __piBioError;
const __piBioResultFile = process.argv[2];
const __piBioContext = new AsyncLocalStorage();
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
  const encoded = kind === "json" ? __piBioJson(value) : __piBioEncode(value);
  __piBioEvents.push({ cell: __piBioContext.getStore() ?? __piBioCell, kind, level, value: encoded });
};
const __piBioRunProcess = (language, source) => {
  const command = language === "r"
    ? ["Rscript", ["--vanilla", "-e", source], undefined]
    : language === "python" || language === "py"
      ? ["python3", ["-"], source]
      : ["bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", source], undefined];
  const [program, args, input] = command;
  const result = spawnSync(program, args, {
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
    writeFileSync(__piBioResultFile, JSON.stringify({ events: __piBioEvents, error: __piBioError }), "utf8");
  } catch {
    // The parent reports a missing result file with the captured process output.
  }
});

${cellBlocks}
`;
};

const runNodeCells = async (options: ExecuteOptions, cells: Cell[]): Promise<RuntimeResult> => {
  // Put the transient module beside the document: relative imports then use the document's normal ESM base,
  // while bare imports still walk up to the document project's node_modules directory.
  const projectDir = options.projectDir ?? Deno.cwd();
  const sourceDir = options.target.source ? dirname(quarto.path.absolute(options.target.source)) : projectDir;
  const tempFile = await Deno.makeTempFile({ dir: sourceDir, suffix: ".ts" });
  const resultFile = await Deno.makeTempFile({ dir: sourceDir, suffix: ".json" });
  try {
    await Deno.writeTextFile(tempFile, workerSource(cells));
    const command = new Deno.Command("node", {
      args: ["--experimental-strip-types", tempFile, resultFile],
      cwd: projectDir,
      stdout: "piped",
      stderr: "piped",
    });
    const result = await command.output();
    const stdout = new TextDecoder().decode(result.stdout);
    const stderr = new TextDecoder().decode(result.stderr).trim();
    const resultText = await Deno.readTextFile(resultFile).catch(() => "");
    if (!resultText) {
      throw new Error([
        "pi-bio Quarto engine: Node did not return a result file.",
        stderr,
        stdout.slice(-2000),
      ].filter(Boolean).join("\n"));
    }
    let parsed: RuntimeResult;
    try {
      parsed = JSON.parse(resultText) as RuntimeResult;
    } catch (error) {
      throw new Error([
        "pi-bio Quarto engine: Node returned an invalid result file.",
        String(error),
        stderr,
      ].filter(Boolean).join("\n"));
    }
    if (stdout.trim()) parsed.events.push({ cell: "process", kind: "text", level: "stdout", value: stdout.trimEnd() });
    if (stderr) parsed.events.push({ cell: "process", kind: "text", level: "stderr", value: stderr });
    if (!result.success && !parsed.error) {
      throw new Error(`pi-bio Quarto engine: Node exited with status ${result.code ?? "unknown"}.`);
    }
    return parsed;
  } finally {
    await Deno.remove(tempFile).catch(() => undefined);
    await Deno.remove(resultFile).catch(() => undefined);
  }
};

const RUNTIME_LANGUAGES = ["ts", "typescript", "js", "javascript", "r", "python", "py", "bash", "sh"];

const cellLanguage = (cell: { cell_type: unknown }): string => {
  if (typeof cell.cell_type !== "object" || cell.cell_type === null || !("language" in cell.cell_type)) return "";
  return String(cell.cell_type.language).toLowerCase();
};

const isPiBioCell = (cell: { cell_type: unknown; sourceVerbatim: { value: string } }): boolean => {
  if (!cell.sourceVerbatim.value.includes(".pi-bio")) return false;
  return RUNTIME_LANGUAGES.includes(cellLanguage(cell));
};

const engine: ExecutionEngineDiscovery = {
  init: (api: QuartoAPI) => {
    quarto = api;
  },
  name: ENGINE_NAME,
  defaultExt: ".qmd",
  defaultYaml: () => ["engine: pi-bio"],
  defaultContent: () => [
    "```{ts .pi-bio}",
    "console.log(\"Hello from pi-bio\");",
    "```",
  ],
  validExtensions: () => [],
  claimsFile: () => false,
  claimsLanguage: (language: string, firstClass?: string): boolean | number => {
    const normalized = language.toLowerCase();
    if (firstClass === CELL_LANGUAGE && RUNTIME_LANGUAGES.includes(normalized)) return 2;
    return normalized === CELL_LANGUAGE;
  },
  canFreeze: false,
  generatesFigures: false,
  launch: (context: EngineProjectContext): ExecutionEngineInstance => ({
    name: ENGINE_NAME,
    canFreeze: false,
    markdownForFile: (file: string): Promise<MappedString> => Promise.resolve(quarto.mappedString.fromFile(file)),
    target: (file: string, _quiet?: boolean, markdown?: MappedString): Promise<ExecutionTarget> => {
      const resolved = markdown ?? quarto.mappedString.fromFile(file);
      return Promise.resolve({
        source: file,
        input: file,
        markdown: resolved,
        metadata: quarto.markdownRegex.extractYaml(resolved.value),
      });
    },
    partitionedMarkdown: (file: string) => Promise.resolve(quarto.markdownRegex.partition(Deno.readTextFileSync(file))),
    execute: async (options: ExecuteOptions): Promise<ExecuteResult> => {
      const chunks = await quarto.markdownRegex.breakQuartoMd(options.target.markdown);
      const cells: Cell[] = [];
      for (const cell of chunks.cells) {
        if (isPiBioCell(cell)) cells.push({ id: `cell-${cells.length + 1}`, language: cellLanguage(cell), source: cell.source.value });
      }
      if (cells.length === 0) {
        return { engine: ENGINE_NAME, markdown: options.target.markdown.value, supporting: [], filters: [] };
      }
      const runtime = await runNodeCells(options, cells);
      if (runtime.error) {
        throw new Error([
          `pi-bio Quarto engine: ${runtime.error.cell} failed: ${runtime.error.message}`,
          runtime.error.stack,
        ].filter(Boolean).join("\n"));
      }
      const processed: string[] = [];
      let cellIndex = 0;
      for (const cell of chunks.cells) {
        processed.push(sourceForOutput(cell.sourceVerbatim.value));
        if (isPiBioCell(cell)) {
          const sourceCell = cells[cellIndex++];
          const output = renderCellOutput(sourceCell, runtime.events);
          if (output) processed.push(`\n\n${output}\n`);
        }
      }
      return { engine: ENGINE_NAME, markdown: processed.join(""), supporting: [], filters: [] };
    },
    dependencies: (_options: DependenciesOptions) => Promise.resolve({ includes: {} }),
    postprocess: (_options: PostProcessOptions) => Promise.resolve(),
  }),
};

export default engine;
