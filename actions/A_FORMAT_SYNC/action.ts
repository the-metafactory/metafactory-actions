import type { ActionContext } from "../../types";

interface SyncResult {
  repo: string;
  action: "pulled" | "cloned" | "skipped";
  detail: string;
  success: boolean;
}

interface Input {
  org: string;
  repos: string[];
  syncResults: SyncResult[];
  [key: string]: unknown;
}

export default {
  async execute(input: Input, _ctx: ActionContext) {
    const { syncResults, repos, ...upstream } = input;

    const lines: string[] = [];
    lines.push("╔═══════════════════════════════════════════════════════════╗");
    lines.push("║  metafactory — Repo Sync                                 ║");
    lines.push("╚═══════════════════════════════════════════════════════════╝");
    lines.push("");

    const pulled = syncResults.filter((r) => r.action === "pulled");
    const cloned = syncResults.filter((r) => r.action === "cloned");
    const failed = syncResults.filter((r) => !r.success);

    lines.push(`  ${repos.length} repos | ${pulled.length} pulled | ${cloned.length} new | ${failed.length} failed`);
    lines.push("");

    if (cloned.length > 0) {
      lines.push("  ─── NEW REPOS ──────────────────────────────────────────");
      lines.push("");
      for (const r of cloned) {
        lines.push(`  ${r.success ? "+" : "!"} ${r.repo} — ${r.detail}`);
      }
      lines.push("");
    }

    if (failed.length > 0) {
      lines.push("  ─── FAILED ─────────────────────────────────────────────");
      lines.push("");
      for (const r of failed) {
        lines.push(`  ! ${r.repo} (${r.action}) — ${r.detail}`);
      }
      lines.push("");
    }

    lines.push("  ─── DETAILS ────────────────────────────────────────────");
    lines.push("");
    for (const r of syncResults) {
      const icon = r.success ? (r.action === "cloned" ? "+" : "~") : "!";
      lines.push(`  ${icon} ${r.repo.padEnd(24)} ${r.action.padEnd(8)} ${r.detail}`);
    }
    lines.push("");

    const digest = lines.join("\n");
    return { ...upstream, repos, syncResults, digest };
  },
};
