import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type http from "node:http";
import { createServer } from "./server.ts";
import { EventLog } from "../log/event-log.ts";

let server: http.Server | undefined;
afterEach(() => {
  server?.closeAllConnections();
  server?.close();
  server = undefined;
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "polylogue-srv-"));
  const db = join(dir, "runs.sqlite");
  const log = new EventLog(db);
  log.createRun({ id: "r1", condition: "single", n: 1, taskId: "toy-vault", seed: 1, model: "m", revision: "r", sampling: {}, configHash: "h", gitSha: null, startedAt: "2026-10-11T00:00:00Z" });
  log.append("r1", { kind: "idle", t: 1, agent: "a1" });
  const viewer = join(dir, "viewer");
  mkdirSync(viewer);
  writeFileSync(join(viewer, "index.html"), "<!doctype html><title>viewer</title>");
  writeFileSync(join(dir, "secret.txt"), "nope");
  return { db, log, viewer };
}

async function listen(s: http.Server): Promise<string> {
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

describe("server", () => {
  it("serves runs, a run, and its events", async () => {
    const { db } = fixture();
    server = createServer(db);
    const base = await listen(server);
    expect((await (await fetch(`${base}/runs`)).json()).map((r: { id: string }) => r.id)).toEqual(["r1"]);
    expect((await (await fetch(`${base}/runs/r1`)).json()).status).toBe("running");
    expect((await (await fetch(`${base}/runs/r1/events`)).json())[0]).toMatchObject({ seq: 0, event: { kind: "idle" } });
    expect((await (await fetch(`${base}/runs/r1/events?from=1`)).json())).toEqual([]);
    const missing = await fetch(`${base}/runs/nope`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Run not found" });
    expect((await fetch(`${base}/runs`, { method: "POST" })).status).toBe(405);
  });

  it("streams existing and new events, then ends after run_finished", async () => {
    const { db, log } = fixture();
    server = createServer(db, { pollMs: 20 });
    const base = await listen(server);
    const res = await fetch(`${base}/runs/r1/stream`);
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    setTimeout(() => {
      log.append("r1", { kind: "wake", t: 2, agent: "a1", reason: "message" });
      log.append("r1", { kind: "run_finished", t: 3, reason: "all_idle", solved: false, wallMs: 3, totalTokens: 0 });
    }, 50);
    const body = await res.text();
    const seqs = [...body.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(seqs).toEqual([0, 1, 2]);
    expect(body).toContain("event: end");
  });

  it("serves the viewer with an index fallback and refuses paths outside it", async () => {
    const { db, viewer } = fixture();
    server = createServer(db, { viewerDir: viewer });
    const base = await listen(server);
    expect(await (await fetch(`${base}/`)).text()).toContain("<title>viewer</title>");
    expect(await (await fetch(`${base}/replay/r1`)).text()).toContain("<title>viewer</title>");
    expect((await fetch(`${base}/..%2fsecret.txt`)).status).toBe(404);
  });

  it("answers 400 for a malformed percent-escape and keeps serving", async () => {
    const { db } = fixture();
    server = createServer(db);
    const base = await listen(server);
    const bad = await fetch(`${base}/runs/%`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Bad request" });
    expect((await (await fetch(`${base}/runs`)).json()).map((r: { id: string }) => r.id)).toEqual(["r1"]);
  });

  it("answers 400 for a malformed viewer path and keeps serving", async () => {
    const { db, viewer } = fixture();
    server = createServer(db, { viewerDir: viewer });
    const base = await listen(server);
    expect((await fetch(`${base}/%`)).status).toBe(400);
    expect(await (await fetch(`${base}/`)).text()).toContain("<title>viewer</title>");
  });
});
