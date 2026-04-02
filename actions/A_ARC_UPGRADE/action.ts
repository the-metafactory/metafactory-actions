import type { ActionContext } from "../../types";

interface Input {
  org: string;
  repos: string[];
  workDir?: string;
  [key: string]: unknown;
}

interface UpgradeResult {
  repo: string;
  packageName: string;
  action: "upgraded" | "skipped";
  detail: string;
  success: boolean;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { org, repos, workDir = `${process.env.HOME}/work/mf`, ...upstream } = input;
    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("Shell capability required");

    const upgradeResults: UpgradeResult[] = [];

    for (const repo of repos) {
      const repoPath = `${workDir}/${repo}`;

      // Check if repo has an arc-manifest.yaml
      const manifestResult = await shell(
        `cat "${repoPath}/arc-manifest.yaml" 2>/dev/null || echo ""`
      );

      if (!manifestResult.stdout.trim()) {
        upgradeResults.push({
          repo,
          packageName: repo,
          action: "skipped",
          detail: "no arc-manifest.yaml",
          success: true,
        });
        continue;
      }

      // Extract package name from manifest
      const nameMatch = manifestResult.stdout.match(/^name:\s*(.+)/m);
      const packageName = nameMatch ? nameMatch[1].trim() : repo;

      // Run arc upgrade
      const result = await shell(
        `arc upgrade ${packageName} 2>&1 || echo "UPGRADE_FAILED"`
      );
      const output = result.stdout.trim();
      const failed = output.includes("UPGRADE_FAILED");

      upgradeResults.push({
        repo,
        packageName,
        action: "upgraded",
        detail: failed ? output.slice(-200) : (output.includes("already") ? "already latest" : output.split("\n").pop() || "upgraded"),
        success: !failed,
      });
    }

    const upgraded = upgradeResults.filter((r) => r.action === "upgraded" && r.success).length;
    const skipped = upgradeResults.filter((r) => r.action === "skipped").length;
    const failed = upgradeResults.filter((r) => !r.success).length;
    console.log(`  Upgrade: ${upgraded} upgraded, ${skipped} skipped (no manifest), ${failed} failed`);

    return {
      ...upstream,
      org,
      repos,
      upgradeResults,
      upgradedAt: new Date().toISOString(),
    };
  },
};
