#!/usr/bin/env node
// Thin source-checkout wrapper. Package installation builds dist during prepare; the repository gate builds once
// before tests, so installer invocations never race by rebuilding dist underneath concurrent consumers.
process.argv.splice(2, 0, "install-skill");
await import("../bin/pi-bio-agent.mjs");
