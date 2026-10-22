import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { parseConfig, type SuiteId } from "./config.ts";
import { gitSha } from "./git.ts";
import { EventLog } from "./log/event-log.ts";
import type { BatchResult } from "./batch/runner.ts";
import { runOnce } from "./run/run.ts";

const USAGE = "usage:\n  polylogue run <config.json> [--db runs.sqlite]\n  polylogue batch <matrix.json> [--db runs.sqlite]\n  polylogue pilot-report --db runs.sqlite --matrix <matrix.json> [--out data/reports/<name>.md]\n  polylogue serve <runs.sqlite> [--port 4317] [--host 127.0.0.1] [--viewer packages/viewer/dist]";

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "run") {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { db: { type: "string", default: "runs.sqlite" } } });
    if (positionals.length !== 1) throw new Error(USAGE);
    const cfg = parseConfig(JSON.parse(readFileSync(positionals[0]!, "utf8")));
    const log = new EventLog(values.db!);
    try {
      const summary = await runOnce(cfg, { log, gitSha: gitSha() });
      console.log(JSON.stringify(summary, null, 2));
      if (summary.reason === "infra_error") process.exitCode = 2;
    } finally {
      log.close();
    }
    return;
  }
  if (command === "batch") {
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { db: { type: "string", default: "runs.sqlite" } } });
    if (positionals.length !== 1) throw new Error(USAGE);
    const { Matrix } = await import("./batch/matrix.ts");
    const { BatchError, runBatch } = await import("./batch/runner.ts");
    const { acquireLock } = await import("./batch/lock.ts");
    const m = Matrix.parse(JSON.parse(readFileSync(positionals[0]!, "utf8")));
    const release = acquireLock(values.db!);
    const log = new EventLog(values.db!);
    let stopping = false;
    const onSignal = () => {
      if (stopping) {
        release();
        process.exit(130);
      }
      stopping = true;
      console.log("stopping after the runs in progress (press Ctrl-C again to exit now)");
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    const summary = (r: BatchResult) =>
      JSON.stringify({ ran: r.ran.length, skipped: r.skipped.length, closed: r.closed, failedTwice: r.failedTwice, notStarted: r.notStarted.length, deadServers: r.deadServers }, null, 2);
    try {
      const result = await runBatch(m, { log, gitSha: gitSha(), onRun: (line) => console.log(line), shouldStop: () => stopping });
      console.log(summary(result));
      if (result.deadServers.length > 0) process.exitCode = 3;
    } catch (err) {
      if (err instanceof BatchError) console.log(summary(err.result));
      throw err;
    } finally {
      log.close();
      release();
    }
    return;
  }
  if (command === "pilot-report") {
    const { values } = parseArgs({ args: rest, options: { db: { type: "string", default: "runs.sqlite" }, matrix: { type: "string" }, out: { type: "string" } } });
    if (!values.matrix) throw new Error(USAGE);
    const { Matrix, expandMatrix } = await import("./batch/matrix.ts");
    const { collectOutcomes, renderReport } = await import("./batch/report.ts");
    const { listTasks } = await import("./suites/registry.ts");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const m = Matrix.parse(JSON.parse(readFileSync(values.matrix, "utf8")));
    const log = new EventLog(values.db!, { readonly: true });
    try {
      const out = values.out ?? `${m.dataDir}/reports/${m.name}.md`;
      mkdirSync(dirname(out), { recursive: true });
      const list = (s: SuiteId, split: "pilot" | "scored") => listTasks(s, split, m.dataDir);
      writeFileSync(out, renderReport(m, collectOutcomes(m, log, list), expandMatrix(m, list)));
      console.log(`wrote ${out}`);
    } finally {
      log.close();
    }
    return;
  }
  if (command === "serve") {
    const { serve } = await import("./server/server.ts");
    await serve(rest);
    return;
  }
  throw new Error(USAGE);
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
