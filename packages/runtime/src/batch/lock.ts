import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";

interface LockInfo {
  host: string;
  pid: number;
  startedAt: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Takes `<dbPath>.lock` so only one batch writes a database at a time. Returns the release function. */
export function acquireLock(dbPath: string): () => void {
  const file = `${dbPath}.lock`;
  const mine: LockInfo = { host: hostname(), pid: process.pid, startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify(mine), { flag: "wx" });
      return () => {
        try {
          unlinkSync(file);
        } catch {
          // already gone
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    let other: LockInfo;
    try {
      other = JSON.parse(readFileSync(file, "utf8")) as LockInfo;
    } catch {
      throw new Error(`Lock file ${file} exists but cannot be read. If no batch is running, delete it.`);
    }
    if (other.host !== mine.host) {
      throw new Error(`Another batch on host ${other.host} (pid ${other.pid}, started ${other.startedAt}) holds ${file}. Stop it, or delete the lock file if it is gone.`);
    }
    if (alive(other.pid)) throw new Error(`Another batch (pid ${other.pid}, started ${other.startedAt}) is using ${dbPath}. Stop it first.`);
    if (existsSync(file)) unlinkSync(file); // owner died: replace its lock
  }
  throw new Error(`Could not take the lock ${file}.`);
}
