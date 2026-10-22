import { execSync } from "node:child_process";

/** The HEAD commit of the repository at cwd, with "-dirty" when the tree has uncommitted changes; null outside a repository. */
export function gitSha(cwd?: string): string | null {
  const git = (cmd: string) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  try {
    const sha = git("git rev-parse HEAD");
    return git("git status --porcelain") ? `${sha}-dirty` : sha;
  } catch {
    return null;
  }
}
