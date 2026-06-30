import { spawn } from "node:child_process";
import type { ProcessRunner, ProcessRunResult, ProcessRunSpec } from "../core/ports.js";

// The host adapter for the ProcessRunner port — spawn an out-of-process child via node:child_process, capture
// stdout/stderr (capped), honor a timeout and an AbortSignal. It is a THIN exec boundary: it never inspects or
// transforms the data (the Arrow-IPC files are the data contract, owned by the resolver). `spawn` with an argv
// array — never a shell string — so there is no shell to inject into. This is the seam the host injects to GRANT
// the agent out-of-process compute; without it bound, a process.compute resource fails closed.

const OUTPUT_CAP = 1_000_000; // cap captured stdout/stderr so a chatty/runaway child can't blow up memory

export function nodeProcessRunner(): ProcessRunner {
  return {
    run(spec: ProcessRunSpec): Promise<ProcessRunResult> {
      const [exe, ...args] = spec.command;
      if (typeof exe !== "string" || !exe) throw new Error("nodeProcessRunner: command[0] (the executable) is required");
      return new Promise<ProcessRunResult>((resolve, reject) => {
        const child = spawn(exe, args, {
          cwd: spec.cwd,
          env: spec.env ? { ...process.env, ...spec.env } : process.env,
          stdio: ["ignore", "pipe", "pipe"], // no stdin; the data contract is the Arrow files, not the pipe
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        child.stdout.on("data", (d: Buffer) => { if (stdout.length < OUTPUT_CAP) stdout += d.toString(); });
        child.stderr.on("data", (d: Buffer) => { if (stderr.length < OUTPUT_CAP) stderr += d.toString(); });

        const timer = spec.timeoutMs ? setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, spec.timeoutMs) : undefined;
        const onAbort = (): void => { child.kill("SIGKILL"); };
        spec.signal?.addEventListener("abort", onAbort, { once: true });
        const cleanup = (): void => { if (timer) clearTimeout(timer); spec.signal?.removeEventListener("abort", onAbort); };

        child.on("error", (err) => { cleanup(); reject(err); }); // exec failure (e.g. ENOENT: no such executable)
        child.on("close", (code) => { cleanup(); resolve({ exitCode: code, stdout, stderr, timedOut }); });
      });
    },
  };
}
