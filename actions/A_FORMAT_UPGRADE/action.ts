import type { ActionContext } from "../../types";

interface UpgradeResult {
  repo: string;
  packageName: string;
  action: "upgraded" | "skipped";
  detail: string;
  success: boolean;
}

interface Input {
  org: string;
  repos: string[];
  upgradeResults: UpgradeResult[];
  [key: string]: unknown;
}

export default {
  async execute(input: Input, _ctx: ActionContext) {
    const { upgradeResults, repos, ...upstream } = input;

    const lines: string[] = [];
    lines.push("╔═══════════════════════════════════════════════════════════╗");
    lines.push("║  metafactory — Arc Upgrade                               ║");
    lines.push("╚═══════════════════════════════════════════════════════════╝");
    lines.push("");

    const upgraded = upgradeResults.filter((r) => r.action === "upgraded" && r.success);
    const skipped = upgradeResults.filter((r) => r.action === "skipped");
    const failed = upgradeResults.filter((r) => !r.success);

    lines.push(`  ${repos.length} repos | ${upgraded.length} upgraded | ${skipped.length} skipped | ${failed.length} failed`);
    lines.push("");

    if (failed.length > 0) {
      lines.push("  ─── FAILED ─────────────────────────────────────────────");
      lines.push("");
      for (const r of failed) {
        lines.push(`  ! ${r.repo} (${r.packageName}) — ${r.detail}`);
      }
      lines.push("");
    }

    lines.push("  ─── DETAILS ────────────────────────────────────────────");
    lines.push("");
    for (const r of upgradeResults) {
      const icon = r.action === "skipped" ? "-" : (r.success ? "~" : "!");
      const name = r.packageName !== r.repo ? `${r.repo} (${r.packageName})` : r.repo;
      lines.push(`  ${icon} ${name.padEnd(30)} ${r.action.padEnd(10)} ${r.detail}`);
    }
    lines.push("");

    const digest = lines.join("\n");
    return { ...upstream, repos, upgradeResults, digest };
  },
};
