import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// DOCS-CONFORMANCE GATE. The README claims "each row maps to shipped code with tests, and a docs-conformance
// check keeps these docs matching the code." This IS that check: a mechanical guard that removed/renamed symbols
// and known overclaims never creep back into the PUBLIC docs. Library correctness — a doc must not name a facility
// the code no longer has. It complements the generated tool-list / example-readme gates already in `npm run check`.
// (It formalizes the one-off doc/code audit into an always-on regression gate.)

const ROOT = process.cwd(); // `node --test` runs from the repo root
const docFiles = [
  "README.qmd", // the SOURCE (README.md is rendered from it) — forbid tokens here so a re-render can't reintroduce them
  "README.md",
  ...readdirSync(join(ROOT, "docs")).filter((f) => f.endsWith(".md")).map((f) => join("docs", f)),
  ...readdirSync(join(ROOT, "scripts")).filter((f) => f.endsWith(".md")).map((f) => join("scripts", f)), // shipped example/evidence docs
  ...readdirSync(join(ROOT, "examples"), { recursive: true }).filter((f) => typeof f === "string" && f.endsWith(".md")).map((f) => join("examples", f as string)), // shipped example READMEs
];

// each entry: a token that must NOT appear in the public docs + the current truth that makes it forbidden.
const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /\breproduce\(\)/, why: "the export is reproduceRun(), not reproduce()" },
  { re: /registry\.listToolSpecs/, why: "the tool-spec registry was removed from core" },
  { re: /spec\.validateToolSpec/, why: "validateToolSpec was removed; use validateBioManifest / validateBioOperationSpec" },
  { re: /\bBioToolSpec\b/, why: "BioToolSpec was removed from core" },
  { re: /\bsyncStudyNoteGraph\b|\bsyncProjectStudyNotes\b|\breportStudyNoteGraph\b/, why: "the file-notes→graph sync was removed" },
  { re: /\bcreateBioGraphSchema\b/, why: "removed; the graph is bio_observations → bio_edges_as_of" },
  { re: /\bkg-sync\b|\bstudy-sync\b/, why: "the kg-sync / study-sync modules were removed" },
  { re: /\bbio_nodes\b/, why: "there is no bio_nodes table; a node is an id referenced by observations" },
  { re: /every NNG topology/, why: "overclaim: the tested topology primitives are push/pull, pub/sub, survey/debate; the rest are ducknng transport" },
  { re: /\bdomain_pack\b|\bdomainPack\b/, why: "the domain-pack concept was removed; a manifest is the program" },
  { re: /\bsha512\b|\bblake3\b/, why: "CAS is sha256-only; ContentAddressAlgorithm no longer names sha512/blake3" },
  { re: /\bhostfs\b|community_extensions\/extensions\/hostfs/i, why: "DuckDB HostFS was removed from the public positioning; ducknng-fs is research only" },
  { re: /ClinVar From A Raw URL|More, live/, why: "stale README headline/prose from the pre-action ClinVar section" },
];

describe("docs-conformance: the public docs name only facilities the code actually has", () => {
  for (const rel of docFiles) {
    test(`no removed/renamed symbols or overclaims in ${rel}`, () => {
      const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
      for (const { re, why } of FORBIDDEN) {
        lines.forEach((line, i) => {
          assert.ok(!re.test(line), `${rel}:${i + 1} has a forbidden token (${why}) → ${line.trim().slice(0, 100)}`);
        });
      }
    });
  }
});

describe("README hygiene: action-first generated README, no fake illustration blocks", () => {
  test("README.md is still marked as generated from README.qmd", () => {
    const text = readFileSync(join(ROOT, "README.md"), "utf8");
    assert.ok(
      text.trimStart().startsWith("<!-- README.md is generated from README.qmd"),
      "README.md must stay a rendered artifact; edit README.qmd and render instead",
    );
  });

  test("README sources avoid text-only architecture fences", () => {
    for (const rel of ["README.qmd", "README.md"]) {
      const lines = readFileSync(join(ROOT, rel), "utf8").split("\n");
      lines.forEach((line, i) => {
        assert.ok(!/^```\s*\{?text\b/i.test(line), `${rel}:${i + 1} uses a text-only fence; use a runnable chunk or prose`);
      });
    }
  });

  test("README.qmd examples are runnable chunks or typed code fences", () => {
    const allowed = new Set(["r", "pi", "biocli", "pattern", "sh", "ts", "json"]);
    const lines = readFileSync(join(ROOT, "README.qmd"), "utf8").split("\n");
    lines.forEach((line, i) => {
      const match = line.match(/^```\s*(?:\{?([A-Za-z0-9_-]+))?/);
      if (!match) return;
      const lang = match[1];
      if (!lang) return;
      assert.ok(allowed.has(lang), `README.qmd:${i + 1} uses unsupported fence '${lang}'`);
    });
  });
});
