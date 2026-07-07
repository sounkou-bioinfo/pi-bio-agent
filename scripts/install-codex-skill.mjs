#!/usr/bin/env node
// Compatibility wrapper. The generic installer is the real entry point.
process.argv.splice(2, 0, "--host", "codex");
await import("./install-skill.mjs");
