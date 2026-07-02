import { parseArgs } from "node:util";
import { openBioStore } from "../hosts/bio-store.js";
import { listMemory, memoryHistory, recall, MEMORY_NOW } from "../hosts/memory-store.js";

// The `memory` CLI: read the ONE temporal store (memory is append-only observations under agent:memory:<slug>).
// list/show/history are all AS-OF (time-travel); history shows supersession + authorship. Provider-agnostic — no Pi needed.

// Strict ISO-8601 / RFC3339: a date, optionally with time (T or space) + up to MILLISECOND fraction, and a REQUIRED
// timezone (Z or ±hh:mm) WHEN a time is present. Rejects lenient forms (e.g. "March 1 2026") AND a timezone-less
// datetime — a tz-less time is interpreted as LOCAL by JS Date.parse but by the SESSION zone by DuckDB TIMESTAMPTZ,
// so time-travel would silently differ. ms cap: the history filter is JS ms while list/show are DuckDB micro — cap
// input to ms (our recorded_at precision) so they agree. A date-only value is treated as UTC midnight (below).
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:[Zz]|[+-]\d{2}:?\d{2}))?$/;
export interface MemoryCliDeps {
  cwd: string;
  out: (line: string) => void;
  err: (line: string) => void;
}

export const MEMORY_USAGE = `pi-bio-agent memory <command>

Commands:
  list    [--as-of <iso>]         list current memory notes (as of a time; default now)
  show    <slug> [--as-of <iso>]  a note's full content (as of a time)
  history <slug> [--as-of <iso>]  the revision trail — what changed, when, by whom (supersession + tombstones); --as-of shows the trail up to that time

Reads .pi/bio-agent/store.duckdb (the ONE temporal store). Memory is append-only, as-of, and attributed;
a forgotten note is a retraction — history and an earlier as-of still see it.`;

export async function mainMemory(argv: string[], deps: MemoryCliDeps): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || !["list", "show", "history"].includes(command)) {
    deps.err(MEMORY_USAGE);
    return 2;
  }
  let values: ReturnType<typeof parseArgs>["values"], positionals: string[];
  try {
    ({ values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { "as-of": { type: "string" } } }));
  } catch {
    // an unknown flag / malformed arg is a USAGE error (exit 2), not a crash (generic exit 1) — match mainRun()
    deps.err(MEMORY_USAGE);
    return 2;
  }
  const asOf = (values["as-of"] as string | undefined) ?? MEMORY_NOW;
  const asOfLabel = asOf === MEMORY_NOW ? "now" : asOf;

  // reject SURPLUS positionals (list takes none; show/history take exactly one slug) — a stray arg is a mistake that
  // must not silently succeed against the WRONG input (e.g. `memory show good typo` acting on 'good').
  const maxPositionals = command === "list" ? 0 : 1;
  if (positionals.length > maxPositionals) {
    deps.err(`memory ${command}: unexpected extra argument(s) '${positionals.slice(maxPositionals).join(" ")}'\n\n${MEMORY_USAGE}`);
    return 2;
  }
  // Validate USAGE (required slug for show/history; a parseable --as-of) BEFORE opening the store — a usage error must
  // not create/lock the store file as a side effect.
  if (command !== "list" && !positionals[0]) {
    deps.err(`memory ${command} <slug> — a slug is required.\n\n${MEMORY_USAGE}`);
    return 2;
  }
  // Validate --as-of as a STRICT ISO-8601/RFC3339 instant (NOT lenient Date.parse, which accepts "March 1 2026" and
  // other forms DuckDB's TIMESTAMPTZ cast may parse differently — that mismatch could defer failure to the DB or give
  // implementation-dependent time-travel). A strict form is parsed identically by both Date.parse and DuckDB.
  if (asOf !== MEMORY_NOW && (!ISO_INSTANT_RE.test(asOf) || Number.isNaN(Date.parse(asOf)))) {
    deps.err(`memory ${command}: --as-of '${asOf}' is not a valid ISO-8601 timestamp with a timezone when a time is given (e.g. 2026-01-01 or 2026-01-01T12:00:00Z)\n\n${MEMORY_USAGE}`);
    return 2;
  }
  // Normalize to a canonical UTC instant used EVERYWHERE (the DuckDB TIMESTAMPTZ reads AND the JS history filter), so
  // there is exactly one interpretation of the time. A date-only value becomes UTC midnight; a tz-bearing time is
  // converted to UTC. (Validated above, so new Date() is unambiguous here.)
  const asOfInstant = asOf === MEMORY_NOW ? MEMORY_NOW : new Date(asOf).toISOString();

  const store = await openBioStore(deps.cwd);
  try {
    if (command === "list") {
      const mems = await listMemory(store.conn, asOfInstant);
      deps.out(JSON.stringify({ asOf: asOfLabel, count: mems.length, notes: mems.map((m) => ({ slug: m.slug, kind: m.kind, title: m.title, hook: m.hook, author: m.author })) }, null, 2));
      return 0;
    }
    const slug = positionals[0];
    if (!slug) {
      deps.err(`memory ${command} <slug> — a slug is required.\n\n${MEMORY_USAGE}`);
      return 2;
    }
    if (command === "show") {
      const note = await recall(store.conn, slug, asOfInstant);
      if (!note) {
        deps.err(`no memory for '${slug}'${asOf === MEMORY_NOW ? "" : ` as of ${asOf}`}`);
        return 1;
      }
      deps.out(JSON.stringify({ asOf: asOfLabel, ...note }, null, 2));
      return 0;
    }
    // history — HONOR --as-of: show only revisions recorded AT OR BEFORE that time (a time-travelled trail), not
    // future ones. Default (MEMORY_NOW) shows the whole trail. A provided-but-unparseable time is a usage error
    // (exit 2), matching how list/show fail on a bad TIMESTAMPTZ rather than silently returning nothing.
    const revisions = await memoryHistory(store.conn, slug);
    // asOf is already validated as parseable (or MEMORY_NOW) above, so filter directly.
    const visible = asOfInstant === MEMORY_NOW ? revisions : revisions.filter((r) => Date.parse(r.recordedAt) <= Date.parse(asOfInstant));
    // Emit the FULL content per revision (not just title) so "what changed" is actually visible — a title-only trail
    // hides body/hook/tags/kind edits. A tombstone (forgotten) carries null content.
    deps.out(JSON.stringify({ slug, asOf: asOfLabel, revisions: visible.map((r) => ({
      recordedAt: r.recordedAt, author: r.author, forgotten: r.content === null,
      content: r.content === null ? null : { kind: r.content.kind, title: r.content.title, hook: r.content.hook, body: r.content.body, tags: r.content.tags, ...(r.content.sources ? { sources: r.content.sources } : {}) },
    })) }, null, 2));
    return 0;
  } finally {
    store.close();
  }
}
