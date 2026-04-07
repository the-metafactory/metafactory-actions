import type { ActionContext } from "../../types";

interface Input {
  org: string;
  repos: string[];
  workDir?: string;
  [key: string]: unknown;
}

interface SyncResult {
  repo: string;
  action: "pulled" | "cloned" | "skipped";
  detail: string;
  success: boolean;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { org, repos, workDir = `${process.env.HOME}/work/mf`, ...upstream } = input;
    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("Shell capability required");

    const syncResults: SyncResult[] = [];

    for (const repo of repos) {
      const repoPath = `${workDir}/${repo}`;

      // Check if repo exists locally
      const exists = await shell(`test -d "${repoPath}/.git" && echo "yes" || echo "no"`);

      if (exists.stdout.trim() === "yes") {
        // Pull latest
        const result = await shell(
          `cd "${repoPath}" && git fetch --prune 2>&1 && git pull --rebase --autostash 2>&1 || echo "PULL_FAILED"`
        );
        const output = result.stdout.trim();
        const failed = output.includes("PULL_FAILED") || output.includes("CONFLICT");

        syncResults.push({
          repo,
          action: "pulled",
          detail: failed ? output.slice(-200) : (output.includes("Already up to date") ? "up to date" : "updated"),
          success: !failed,
        });
      } else {
        // Clone new repo
        const result = await shell(
          `cd "${workDir}" && gh repo clone ${org}/${repo} 2>&1 || echo "CLONE_FAILED"`
        );
        const output = result.stdout.trim();
        const failed = output.includes("CLONE_FAILED");

        syncResults.push({
          repo,
          action: "cloned",
          detail: failed ? output.slice(-200) : "cloned",
          success: !failed,
        });
      }
    }

    const pulled = syncResults.filter((r) => r.action === "pulled" && r.success).length;
    const cloned = syncResults.filter((r) => r.action === "cloned" && r.success).length;
    const failed = syncResults.filter((r) => !r.success).length;
    console.log(`  Synced: ${pulled} pulled, ${cloned} cloned, ${failed} failed`);

    return {
      ...upstream,
      org,
      repos,
      syncResults,
      syncedAt: new Date().toISOString(),
    };
  },
};
