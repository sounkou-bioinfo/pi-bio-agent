import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ProcessRunner, ProcessRunResult, ProcessRunSpec } from "../core/ports.js";

// The host adapter for the ProcessRunner port — spawn an out-of-process child via node:child_process, capture
// stdout/stderr (capped), honor a timeout and an AbortSignal. It is a THIN exec boundary: it never inspects or
// transforms the data (the Arrow-IPC files are the data contract, owned by the resolver). `spawn` with an argv
// array — never a shell string — so there is no shell to inject into. This is the seam the host injects to GRANT
// the agent out-of-process compute; without it bound, a process.compute resource fails closed.

// Cap RETAINED stdout/stderr so a chatty/runaway child can't blow up memory. Peak transient is bounded too:
// the kept string is hard-sliced to OUTPUT_CAP and a stream `data` chunk is <= the stream highWaterMark (~64KB),
// so the worst-case live allocation is OUTPUT_CAP + one chunk — intentionally not micro-optimized further.
const OUTPUT_CAP = 1_000_000;

export function nodeProcessRunner(): ProcessRunner {
  return {
    run(spec: ProcessRunSpec): Promise<ProcessRunResult> {
      const [exe, ...args] = spec.command;
      if (typeof exe !== "string" || !exe) throw new Error("nodeProcessRunner: command[0] (the executable) is required");
      return new Promise<ProcessRunResult>((resolve, reject) => {
        // detached (POSIX) puts the child in its OWN process group so a kill can take down the WHOLE tree, not
        // just the direct child — a forking command (a shell wrapper, mclapply, an R worker pool) would otherwise
        // orphan its grandchildren past a timeout/abort, defeating "contained in the child". Windows has no
        // process groups via spawn; there child.kill signals only the direct process.
        const posix = process.platform !== "win32";
        const child = spawn(exe, args, {
          cwd: spec.cwd,
          env: spec.env ? { ...process.env, ...spec.env } : process.env,
          stdio: ["ignore", "pipe", "pipe"], // no stdin; the data contract is the Arrow files, not the pipe
          detached: posix,
        });
        // Kill the child AND its descendants. On POSIX, signalling -pid hits the process group; ESRCH (already
        // gone) is benign. Fall back to the direct child if the group signal can't be sent.
        const killTree = (): void => {
          try {
            if (posix && child.pid != null) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
        };
        // Capture stdout/stderr capped at OUTPUT_CAP, decoded multibyte-safe (a UTF-8 char can straddle two
        // chunks; the stderr tail surfaces in error messages, so a naive per-chunk toString() would mojibake it).
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const sink = (get: () => string, set: (s: string) => void) => {
          const decoder = new StringDecoder("utf8");
          return (d: Buffer): void => {
            const cur = get();
            if (cur.length >= OUTPUT_CAP) return; // already at the cap; drop further output
            set((cur + decoder.write(d)).slice(0, OUTPUT_CAP)); // hard-cap even a single oversized chunk
          };
        };
        child.stdout.on("data", sink(() => stdout, (s) => { stdout = s; }));
        child.stderr.on("data", sink(() => stderr, (s) => { stderr = s; }));

        const timer = spec.timeoutMs ? setTimeout(() => { timedOut = true; killTree(); }, spec.timeoutMs) : undefined;
        const onAbort = (): void => { killTree(); };
        spec.signal?.addEventListener("abort", onAbort, { once: true });
        const cleanup = (): void => { if (timer) clearTimeout(timer); spec.signal?.removeEventListener("abort", onAbort); };
        // A signal that ALREADY fired before we attached the listener never invokes it — honor a pre-aborted
        // signal explicitly, or the child would run to completion despite the cancellation.
        if (spec.signal?.aborted) killTree();

        child.on("error", (err) => { cleanup(); reject(err); }); // exec failure (e.g. ENOENT: no such executable)
        child.on("close", (code, signal) => { cleanup(); resolve({ exitCode: code, signal, stdout, stderr, timedOut }); });
      });
    },
  };
}
