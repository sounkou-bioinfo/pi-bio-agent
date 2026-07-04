import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { ComputeRunner, ComputeTaskHandle, ComputeTaskResult, ComputeTaskSpec, ComputeTaskStatus } from "../core/ports.js";
import { ENV_DESCRIPTOR_SCHEMA, unknownEnvDescriptor, type EnvDescriptor } from "../core/reproducibility.js";

// A minimal base environment for a spawned child: just enough to resolve binaries and locale, never the host's
// arbitrary vars (that's where ENV-VAR secrets — *_API_KEY, *_TOKEN, AWS_*, … — live). An allowlist, not a
// denylist, so a newly-invented secret var name can't slip through. The host adds anything else via spec.env.
//
// SCOPE — this allowlists ENV VARS; it is NOT a filesystem/secret SANDBOX. `HOME`/`USER` are passed so real tools
// work (R user libraries, git, conda), but that means a child can still do file-based credential discovery
// (`~/.aws/credentials`, `.netrc`, cloud-CLI caches) and copy those bytes into an output artifact. Env hygiene is
// the library's job; FILESYSTEM/network isolation is the HOST's — a secret-bearing host must run a jailed/container
// ComputeRunner (or an empty HOME), exactly like the DuckDB egress residue. nodeComputeRunner is the trusting default.
const SAFE_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP", "SHELL", "USER", "LOGNAME", "SystemRoot", "PATHEXT", "COMSPEC", "WINDIR"];
function safeBaseEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of SAFE_ENV_KEYS) { const v = process.env[k]; if (typeof v === "string") out[k] = v; }
  return out;
}

// The host adapter for the ComputeRunner port — spawn an out-of-process child via node:child_process, capture
// stdout/stderr (capped), honor a timeout and an AbortSignal. It is a THIN exec boundary: it never inspects or
// transforms the data (the Arrow-IPC files are the data contract, owned by the resolver). `spawn` with an argv
// array — never a shell string — so there is no shell to inject into. This is the seam the host injects to GRANT
// the agent out-of-process compute; without it bound, a compute.run resource fails closed.
//
// The lifecycle is future-shaped: submit returns a handle immediately, status is non-blocking, collect waits for
// the value, and cancel is best-effort. Local spawn is just one backend for that lifecycle.

// Cap RETAINED stdout/stderr so a chatty/runaway child can't blow up memory. Peak transient is bounded too:
// the kept string is hard-sliced to OUTPUT_CAP and a stream `data` chunk is <= the stream highWaterMark (~64KB),
// so the worst-case live allocation is OUTPUT_CAP + one chunk — intentionally not micro-optimized further.
const OUTPUT_CAP = 1_000_000;

export function nodeComputeRunner(): ComputeRunner {
  type Entry = {
    status: ComputeTaskStatus;
    done: Promise<ComputeTaskResult>;
    killTree: () => void;
    cancelled: boolean;
  };
  const entries = new Map<string, Entry>();
  const now = (): string => new Date().toISOString();

  return {
    // A MINIMAL observed environment (C1): the platform + the executable name. Deliberately NO version shell-out
    // (`Rscript --version`, `pip freeze`): a probe must not spawn, hang, hit network, or mutate — so this is only
    // what we know without running anything. A richer host provider (micromamba/renv/container) can return more.
    describeEnvironment(spec: ComputeTaskSpec): Promise<EnvDescriptor> {
      const exe = spec.command[0];
      if (!exe) return Promise.resolve(unknownEnvDescriptor(["no command to describe"]));
      return Promise.resolve({
        schema: ENV_DESCRIPTOR_SCHEMA,
        kind: "composite",
        layers: [{ kind: "platform", os: process.platform, arch: process.arch }, { kind: "executable", name: exe }],
      });
    },
    async submit(spec: ComputeTaskSpec): Promise<ComputeTaskHandle> {
      const [exe, ...args] = spec.command;
      if (typeof exe !== "string" || !exe) throw new Error("nodeComputeRunner: command[0] (the executable) is required");
      // FAIL CLOSED: an ALREADY-aborted signal must prevent the SPAWN entirely. Killing after spawn races the
      // child's immediate side effects — `sh -c 'touch /tmp/x; sleep 10'` can touch before SIGKILL lands — so an
      // aborted compute.run would still run effects. Never start it.
      if (spec.signal?.aborted) throw new Error("nodeComputeRunner: signal already aborted — not spawning");

      const runId = randomUUID();
      const submittedAt = now();
      let entry!: Entry;
      let resolveDone!: (result: ComputeTaskResult) => void;
      let rejectDone!: (err: Error) => void;
      const done = new Promise<ComputeTaskResult>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });

      // detached (POSIX) puts the child in its OWN process group so a kill can take down the WHOLE tree, not
      // just the direct child — a forking command (a shell wrapper, mclapply, an R worker pool) would otherwise
      // orphan its grandchildren past a timeout/abort, defeating "contained in the child". Windows has no
      // process groups via spawn; there child.kill signals only the direct process.
      const posix = process.platform !== "win32";
      const child = spawn(exe, args, {
        cwd: spec.cwd,
        // SECURITY: do NOT inherit the full host `process.env` — it carries secrets (API keys, tokens, cloud
        // creds), and an agent-declared command would otherwise read/exfiltrate them, breaking the injected-
        // effect boundary (secrets are host-owned, never agent-reachable). Pass only a minimal, non-secret base
        // so binaries resolve, plus the explicit `spec.env` the host/manifest declared. A host that needs a
        // richer env passes it via spec.env — deliberately, not by ambient inheritance.
        env: { ...safeBaseEnv(), ...spec.env },
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
      entry = {
        status: { runId, phase: "running", at: submittedAt },
        done,
        killTree,
        cancelled: false,
      };
      entries.set(runId, entry);

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

      const timer = spec.timeoutMs ? setTimeout(() => {
        timedOut = true;
        entry.status = { runId, phase: "failed", at: now(), message: `timed out after ${spec.timeoutMs}ms` };
        killTree();
      }, spec.timeoutMs) : undefined;
      const onAbort = (): void => {
        entry.cancelled = true;
        entry.status = { runId, phase: "cancelled", at: now(), message: "aborted" };
        killTree();
      };
      spec.signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = (): void => { if (timer) clearTimeout(timer); spec.signal?.removeEventListener("abort", onAbort); };

      child.on("error", (err) => {
        cleanup();
        entry.status = { runId, phase: "failed", at: now(), message: err.message };
        rejectDone(err instanceof Error ? err : new Error(String(err)));
      }); // exec failure (e.g. ENOENT: no such executable)
      child.on("close", (code, signal) => {
        cleanup();
        const result = { exitCode: code, signal, stdout, stderr, timedOut };
        if (entry.cancelled) entry.status = { runId, phase: "cancelled", at: now(), message: signal ? `killed by ${signal}` : "cancelled" };
        else if (code === 0 && !timedOut) entry.status = { runId, phase: "succeeded", at: now() };
        else entry.status = { runId, phase: "failed", at: now(), message: timedOut ? `timed out after ${spec.timeoutMs}ms` : signal ? `killed by ${signal}` : `exited ${code}` };
        resolveDone(result);
      });

      return { runId, submittedAt, backend: "node-process" };
    },
    async status(handle: ComputeTaskHandle): Promise<ComputeTaskStatus | null> {
      return entries.get(handle.runId)?.status ?? null;
    },
    async collect(handle: ComputeTaskHandle): Promise<ComputeTaskResult> {
      const entry = entries.get(handle.runId);
      if (!entry) throw new Error(`nodeComputeRunner: unknown process run '${handle.runId}'`);
      try {
        return await entry.done;
      } finally {
        entries.delete(handle.runId);
      }
    },
    async cancel(handle: ComputeTaskHandle): Promise<void> {
      const entry = entries.get(handle.runId);
      if (!entry) throw new Error(`nodeComputeRunner: unknown process run '${handle.runId}'`);
      if (entry.status.phase === "succeeded" || entry.status.phase === "failed" || entry.status.phase === "cancelled") return;
      entry.cancelled = true;
      entry.status = { runId: handle.runId, phase: "cancelled", at: now(), message: "cancel requested" };
      entry.killTree();
    },
  };
}
