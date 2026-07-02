import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { deleteStudyNote, listStudyNotes, makeStudyNote, readStudyNotes, runtimeSkillRoot, runtimeStudyRoot, scoreStudyNote, validateSkillInput, writeProjectSkill, writeStudyNote } from "../src/hosts/pi-project.js";

async function tempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-bio-agent-"));
}

describe("Pi project host helpers", () => {
  test("computes project-local roots", async () => {
    const cwd = await tempProject();
    assert.equal(runtimeSkillRoot(cwd), join(cwd, ".pi", "bio-agent", "skills"));
    assert.equal(runtimeStudyRoot(cwd), join(cwd, ".pi", "bio-agent", "study-notes"));
  });

  test("writes valid project-local skills and rejects invalid names", async () => {
    const cwd = await tempProject();
    assert.throws(() => validateSkillInput("Bad Skill", "desc", "body"), /skill name/);
    const path = await writeProjectSkill(cwd, "rare-disease-review", "Reusable rare disease review workflow.", "# Steps\n\nUse structured evidence.");
    const body = await readFile(path, "utf8");
    assert.match(body, /name: rare-disease-review/);
    assert.match(body, /description: "Reusable rare disease review workflow\."/);
  });

  test("quotes a description containing a colon so the YAML frontmatter stays valid", async () => {
    const cwd = await tempProject();
    // Unquoted, this 'X: Y' would be read as a nested mapping and fail to load (the SKILL.md bug).
    const path = await writeProjectSkill(cwd, "hpo-grounding", "Ground phenotypes to HPO: terms first.", "body");
    const body = await readFile(path, "utf8");
    assert.match(body, /description: "Ground phenotypes to HPO: terms first\."/);
    // the colon is inside the quoted scalar, not a bare mapping value
    assert.doesNotMatch(body, /description: Ground phenotypes to HPO: terms/);
  });

  test("writes, reads, searches, and ignores corrupt study notes", async () => {
    const cwd = await tempProject();
    const first = makeStudyNote({
      kind: "cheatsheet",
      title: "OpenTargets GraphQL",
      hook: "Use before public gene-disease evidence queries.",
      body: "Resolve identifiers before querying.",
      tags: ["opentargets", "graphql"],
    }, "2026-06-27T00:00:00Z");
    const second = makeStudyNote({
      kind: "failure_case",
      title: "VEP cache miss",
      hook: "Use when local annotation cache lacks a transcript.",
      body: "Fall back only through explicit policy.",
      tags: ["vep"],
    }, "2026-06-28T00:00:00Z");
    await writeStudyNote(cwd, first, "2026-06-27T00:00:00Z");
    await writeStudyNote(cwd, second, "2026-06-28T00:00:00Z");
    await writeFile(join(runtimeStudyRoot(cwd), "broken.json"), "{not json", "utf8");

    const all = await readStudyNotes(cwd);
    assert.deepEqual(all.map((note) => note.id), [second.id, first.id]);
    assert.ok(scoreStudyNote(first, "gene disease") > 0);
    assert.equal(scoreStudyNote(first, "unrelated"), 0);
    const hits = await listStudyNotes(cwd, { query: "graphql evidence", limit: 10 });
    assert.deepEqual(hits.map((note) => note.id), [first.id]);
  });

  test("derives slugs, validates the hook, and rejects a hook that only restates the title", () => {
    const note = makeStudyNote({ kind: "cheatsheet", title: "OpenTargets GraphQL", hook: "Read before evidence queries.", body: "x" });
    assert.equal(note.slug, "opentargets-graphql");
    assert.throws(() => makeStudyNote({ kind: "cheatsheet", title: "Same", hook: "  same  ", body: "x" }), /hook must say when to read/);
    assert.throws(() => makeStudyNote({ kind: "cheatsheet", title: "T", hook: "", body: "x" }), /hook is required/);
  });

  test("upserts by slug, preserves createdAt, and regenerates INDEX.md", async () => {
    const cwd = await tempProject();
    const v1 = makeStudyNote({ slug: "opentargets-ids", kind: "cheatsheet", title: "OpenTargets IDs", hook: "Read before queries.", body: "v1" }, "2026-06-27T00:00:00Z");
    const r1 = await writeStudyNote(cwd, v1, "2026-06-27T00:00:00Z");
    const v2 = makeStudyNote({ slug: "opentargets-ids", kind: "cheatsheet", title: "OpenTargets IDs", hook: "Read before queries.", body: "v2 updated", tags: ["x"] }, "2026-06-28T00:00:00Z");
    const r2 = await writeStudyNote(cwd, v2, "2026-06-28T00:00:00Z");
    assert.equal(r1.path, r2.path); // same slug -> same file (upsert, not duplicate)
    assert.equal(r1.created, true);
    assert.equal(r2.created, false);
    // The returned note is the persisted truth, not the caller's input: id preserved, updatedAt owned by the write layer.
    assert.equal(r2.note.id, v1.id);
    assert.equal(r2.note.updatedAt, "2026-06-28T00:00:00Z");

    const all = await readStudyNotes(cwd);
    assert.equal(all.length, 1);
    assert.equal(all[0].body, "v2 updated");
    assert.equal(all[0].id, v1.id); // id preserved across the edit, so old id references still resolve
    assert.equal(all[0].createdAt, "2026-06-27T00:00:00Z"); // preserved across the edit
    assert.equal(all[0].updatedAt, "2026-06-28T00:00:00Z"); // write layer owns updatedAt

    const index = await readFile(join(runtimeStudyRoot(cwd), "INDEX.md"), "utf8");
    assert.match(index, /generated cache/);
    assert.match(index, /\[OpenTargets IDs\]\(opentargets-ids\.json\)/);
  });

  test("deletes a note by slug and reports a miss", async () => {
    const cwd = await tempProject();
    await writeStudyNote(cwd, makeStudyNote({ slug: "vep-cache", kind: "failure_case", title: "VEP cache", hook: "Read on cache miss.", body: "b" }));
    assert.equal(await deleteStudyNote(cwd, "vep-cache"), true);
    assert.equal((await readStudyNotes(cwd)).length, 0);
    assert.equal(await deleteStudyNote(cwd, "vep-cache"), false);
  });

  test("deleteStudyNote SURFACES a non-ENOENT failure (not swallowed as a benign miss)", async () => {
    const cwd = await tempProject();
    // put a DIRECTORY where the note file would be — unlink() then fails with EISDIR/EPERM (NOT ENOENT), which must
    // propagate rather than be swallowed as `false` (a swallowed error would let bio_forget report a clean delete).
    await mkdir(join(runtimeStudyRoot(cwd), "blocked.json"), { recursive: true });
    await assert.rejects(() => deleteStudyNote(cwd, "blocked"), /EISDIR|EPERM|EEXIST|directory|not permitted/i);
  });
});
