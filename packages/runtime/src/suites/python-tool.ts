import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";
import type { WorkTool } from "../tools/work-tool.ts";

export const SANDBOX_IMAGE = "polylogue-python:1";

export interface PythonToolOptions {
  image: string;
  timeoutMs: number;
  memoryMb: number;
  maxChars: number;
  /** The host timer fires at timeoutMs + hostGraceMs and kills the container (a backstop; the in-container limit normally fires first). */
  hostGraceMs: number;
}
/** The in-container `timeout` is the binding limit; the host timer waits this much longer, for container start-up, before it kills the container. */
export const HOST_GRACE_MS = 8000;
export const PYTHON_DEFAULTS: PythonToolOptions = { image: SANDBOX_IMAGE, timeoutMs: 10_000, memoryMb: 512, maxChars: 4000, hostGraceMs: HOST_GRACE_MS };
/** Docker runs in its own process group, so a Ctrl-C in the batch's terminal (sent to the foreground group) never reaches it or the container. */
export const DOCKER_SPAWN = { detached: true } as const;
/** Past the output cap a stream is read one chunk per this many ms: the writer is held back, yet a finished program's output still drains. */
const TRICKLE_MS = 10;

const seconds = (ms: number) => Math.ceil(ms / 1000);

function run(cmd: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...DOCKER_SPAWN, stdio: "ignore" });
    p.on("error", () => resolve(-1));
    p.on("close", (code) => resolve(code ?? -1));
  });
}

function capture(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { ...DOCKER_SPAWN, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.setEncoding("utf8");
    p.stdout.on("data", (c: string) => (out += c));
    p.on("error", () => resolve(""));
    p.on("close", () => resolve(out));
  });
}

export async function pythonSandboxReady(image = SANDBOX_IMAGE): Promise<boolean> {
  return (await run("docker", ["image", "inspect", image])) === 0;
}

/** Removes every container named `polylogue-py-*` (leftovers of a crashed run) and returns how many. */
export async function sweepSandboxContainers(): Promise<number> {
  const ids = (await capture("docker", ["ps", "-aq", "--filter", "name=polylogue-py-"])).split("\n").filter(Boolean);
  if (ids.length > 0) await run("docker", ["rm", "-f", ...ids]);
  return ids.length;
}

function cut(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n[… cut at ${max} characters]`;
}

/**
 * The `docker run` argv. No container logs (a flood must not fill the disk); no signal proxy (a signal to the docker CLI is not passed on);
 * `timeout -k 2 <s>` inside the container is the binding time limit (exit 124) and stops the code even if this process dies.
 */
export function sandboxArgs(name: string, o: PythonToolOptions): string[] {
  const mem = `${o.memoryMb}m`;
  return [
    "run", "--rm", "-i", "--init", "--sig-proxy=false", "--name", name, "--network", "none", "--log-driver", "none", "--memory", mem, "--memory-swap", mem,
    "--cpus", "1", "--pids-limit", "64", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--read-only", "--tmpfs", "/tmp:rw,size=64m",
    "--user", "65534:65534", o.image, "timeout", "-k", "2", String(seconds(o.timeoutMs)), "python", "-",
  ];
}

const DOCKER_ERROR = /^docker: |Unable to find image|Error response from daemon/m;

export function pythonTool(over: Partial<PythonToolOptions> = {}): WorkTool {
  const o = { ...PYTHON_DEFAULTS, ...over };
  return {
    name: "run_python",
    description: `Run Python 3.12 code (sympy and numpy installed; no network; ${seconds(o.timeoutMs)} s and ${o.memoryMb} MB per call). Returns the exit code, stdout and stderr.`,
    parameters: Type.Object({ code: Type.String() }),
    run: (a: { code: string }, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error("aborted"));
        const name = `polylogue-py-${randomUUID()}`;
        const t0 = Date.now();
        const p = spawn("docker", sandboxArgs(name, o), DOCKER_SPAWN);
        let out = "";
        let err = "";
        let timedOut = false;
        let aborted = false;
        // Once enough is kept the stream is paused and then read one chunk every TRICKLE_MS: backpressure holds a flooding writer back
        // (until the in-container limit) instead of this process draining gigabytes, while a program that printed a lot and finished still exits.
        // After the container is stopped the streams are drained and discarded, because the docker CLI only exits once its output has been read.
        let stopped = false;
        const streams = [p.stdout, p.stderr];
        const trickles = new Set<NodeJS.Timeout>();
        const collect = (stream: NodeJS.ReadableStream, get: () => string, set: (s: string) => void) => {
          let waiting = false;
          stream.on("data", (c: string) => {
            if (get().length <= o.maxChars) set(get() + c);
            if (get().length > o.maxChars && !stopped && !waiting) {
              stream.pause();
              waiting = true;
              const t = setTimeout(() => {
                trickles.delete(t);
                waiting = false;
                stream.resume();
              }, TRICKLE_MS);
              trickles.add(t);
            }
          });
        };
        p.stdout.setEncoding("utf8");
        p.stderr.setEncoding("utf8");
        collect(p.stdout, () => out, (v) => (out = v));
        collect(p.stderr, () => err, (v) => (err = v));
        const stop = () => {
          stopped = true;
          for (const st of streams) st.resume();
          void run("docker", ["kill", name]);
        };
        const onAbort = () => {
          aborted = true;
          stop();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, Math.max(0, o.timeoutMs + o.hostGraceMs));
        signal?.addEventListener("abort", onAbort, { once: true });
        const done = () => {
          clearTimeout(timer);
          for (const t of trickles) clearTimeout(t);
          signal?.removeEventListener("abort", onAbort);
        };
        p.on("error", (e) => {
          done();
          reject(new Error(`The Python sandbox is unavailable: ${e.message}`));
        });
        p.on("close", (code) => {
          done();
          if (aborted) return reject(new Error("aborted"));
          if (code === 125 && DOCKER_ERROR.test(err)) return reject(new Error(`The Python sandbox is unavailable: ${err.trim().split("\n").at(-1) ?? "docker run failed"}`));
          // 124 is timeout(1)'s code, 137 its code when the program ignored SIGTERM and `-k` killed it; either code before the limit is the program's own
          // (124) or a memory kill (137)
          const pastLimit = Date.now() - t0 >= o.timeoutMs;
          const head = timedOut || ((code === 124 || code === 137) && pastLimit)
            ? `Timed out after ${seconds(o.timeoutMs)} s; the process was stopped.`
            : code === null
              ? "Stopped by a signal."
              : code === 137
                ? `Killed (memory limit ${o.memoryMb} MB).`
                : `exit code: ${code}`;
          resolve(`${head}\n--- stdout ---\n${cut(out, o.maxChars)}\n--- stderr ---\n${cut(err, o.maxChars)}`);
        });
        p.stdin.on("error", () => {}); // docker may exit before reading stdin (e.g. missing image)
        p.stdin.end(a.code);
      }),
  };
}
