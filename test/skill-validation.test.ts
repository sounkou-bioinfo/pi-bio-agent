import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const script = resolve("scripts", "validate-skills.mjs");

test("packaged substrate skill passes the procedural-skill validation gate", async () => {
  const out = await execFileAsync(process.execPath, [script], { cwd: process.cwd() });
  assert.match(out.stdout, /validate-skills: ok \(1 skill\)/);
  assert.equal(out.stderr, "");
});

test("skill validation rejects executable clients, secrets, patient identifiers, and weak metadata", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-bio-bad-skill-root-"));
  const skillDir = join(root, "bad-skill");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(join(skillDir, "SKILL.md"), [
    "---",
    "name: bad-skill",
    "description: too short",
    "---",
    "",
    "# Bad Skill",
    "",
    "MRN: 123456",
    "api_key = sk-12345678901234567890",
    "",
    "```python",
    "import requests",
    "requests.get('https://example.test')",
    "```",
    "",
  ].join("\n"), "utf8");

  await assert.rejects(
    execFileAsync(process.execPath, [script, "--root", root], { cwd: process.cwd() }),
    (error) => {
      const err = error as { stderr?: string };
      assert.match(err.stderr ?? "", /description must be clear/);
      assert.match(err.stderr ?? "", /patient identifiers must not be in skills/);
      assert.match(err.stderr ?? "", /looks like an API key or model provider secret/);
      assert.match(err.stderr ?? "", /executable python code block belongs in repo code\/tests/);
      assert.match(err.stderr ?? "", /API client implementation belongs in code\/tests/);
      return true;
    },
  );
});

test("skill validation rejects escaping and missing local reference links", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-bio-link-skill-root-"));
  const skillDir = join(root, "link-skill");
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(join(skillDir, "SKILL.md"), [
    "---",
    "name: link-skill",
    "description: A procedural host-neutral skill used only to test local reference link validation in the package gate.",
    "---",
    "",
    "# Link Skill",
    "",
    "[escape](references/../../outside.md)",
    "[missing](references/missing.md)",
    "",
  ].join("\n"), "utf8");

  await assert.rejects(
    execFileAsync(process.execPath, [script, "--root", root], { cwd: process.cwd() }),
    (error) => {
      const err = error as { stderr?: string };
      assert.match(err.stderr ?? "", /local link escapes skill directory/);
      assert.match(err.stderr ?? "", /missing referenced file references\/missing\.md/);
      return true;
    },
  );
});
