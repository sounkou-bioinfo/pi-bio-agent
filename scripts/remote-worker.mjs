import http from "node:http";
import { spawn } from "node:child_process";

// A WORKER NODE: an HTTP service that runs an agent on demand. One of these runs per machine. The coordinator
// POSTs {step, notes} (the subtask + its access-list artifacts); the worker runs a real `pi` agent and returns
// the produced note. Only the host:port changes to make this a different physical machine. (mirai.plumber2 is
// the same shape in R.) Run: node scripts/remote-worker.mjs <port> <label>

const [port, label] = process.argv.slice(2);

function piAgent(prompt) {
  return new Promise((resolve, reject) => {
    const model = process.env.PI_BIO_AGENT_MODEL ?? "openai-codex/gpt-5.3-codex";
    const timeout = Number(process.env.PI_BIO_AGENT_TIMEOUT_MS ?? 120_000);
    const c = spawn("pi", ["--model", model, "--thinking", "medium", "--no-extensions", "--no-skills",
      "--no-context-files", "--no-session", "--no-tools", "-p", prompt], { cwd: process.cwd(), timeout });
    let o = "", e = "";
    c.stdout.on("data", (d) => (o += d));
    c.stderr.on("data", (d) => (e += d));
    c.on("close", (code, signal) => (code === 0
      ? resolve(o.trim())
      : reject(new Error(`pi ${code ?? signal}: ${e.slice(0, 200)}`))));
  });
}

http.createServer((req, res) => {
  if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
  let b = "";
  req.on("data", (d) => (b += d));
  req.on("end", async () => {
    const { step, notes } = JSON.parse(b);
    const ctx = notes.length ? `\n\nUpstream context (your access list):\n${notes.map((n) => `--- ${n.slug} ---\n${n.body}`).join("\n\n")}` : "";
    const prompt = `You are an agent worker on machine '${label}'. Task: ${step.subtask}${ctx}\n\nReply with ONLY the resulting note content, concise (no preamble).`;
    console.error(`[worker ${label}:${port}] received step '${step.id}', spawning pi agent (pid of this worker process = ${process.pid})`);
    try {
      const body = await piAgent(prompt);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ body, hook: `produced on ${label}`, machine: `${label}:${port}` }));
    } catch (err) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(err.message) }));
    }
  });
}).listen(Number(port), () => console.error(`[worker ${label}] listening on :${port} (pid ${process.pid})`));
