import { extractFeatureIdsFromTitle } from "../../utils";
import type { ActionContext } from "../../types";

interface BlueprintIndex {
  features: Array<{ repo: string; id: string; status: string; name: string }>;
  prefixesByRepo: Record<string, string[]>;
}

interface Input {
  blueprints: BlueprintIndex;
  org?: string;
  limit?: number;
  sinceDate?: string;
  [key: string]: unknown;
}

interface PRRef {
  repo: string;
  prNumber: number;
  title: string;
  mergedAt: string;
  ids: string[];
}

interface RepoScanFailure {
  repo: string;
  reason: string;
}

interface RepoScanTruncation {
  repo: string;
  limit: number;
}

// Re-export so the test file can pull from one location rather than reach
// across action boundaries. (Holly cycle-3 W2)
export { extractFeatureIdsFromTitle as extractIds };

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { blueprints, org = "the-metafactory", limit = 200, sinceDate, ...upstream } = input;

    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("Shell capability required");
    if (!blueprints) throw new Error("blueprints input required (run A_FETCH_BLUEPRINTS first)");

    const repos = Object.keys(blueprints.prefixesByRepo);
    const prRefs: PRRef[] = [];
    const failedRepos: RepoScanFailure[] = [];
    const truncatedRepos: RepoScanTruncation[] = [];

    for (const repo of repos) {
      const prefixes = blueprints.prefixesByRepo[repo] || [];

      const result = await shell(
        `gh pr list --repo ${org}/${repo} --state merged --limit ${limit} --json number,title,mergedAt`
      );

      // Surface per-repo scan failures rather than swallowing them. (Holly
      // cycle-2 #1) `gh pr list` reports errors via stderr+exit; empty stdout
      // from a failure used to JSON.parse-throw + silently `continue`,
      // making MISSING/STALE counts a lower bound the operator couldn't
      // distinguish from "0 drift in this repo".
      if (result.code !== 0) {
        const reason = (result.stderr || "").trim().slice(0, 200) || `exit ${result.code}`;
        failedRepos.push({ repo, reason });
        continue;
      }

      let prs: Array<{ number: number; title: string; mergedAt: string }>;
      try {
        prs = JSON.parse(result.stdout);
      } catch (err) {
        failedRepos.push({
          repo,
          reason: `JSON parse failed: ${(err as Error).message.slice(0, 100)}`,
        });
        continue;
      }

      // Surface limit-truncation as well (Holly cycle-2 #2).
      if (prs.length === limit) {
        truncatedRepos.push({ repo, limit });
      }

      for (const pr of prs) {
        if (sinceDate && pr.mergedAt < sinceDate) continue;
        const ids = extractFeatureIdsFromTitle(pr.title || "", prefixes);
        if (!ids.length) continue;
        prRefs.push({
          repo,
          prNumber: pr.number,
          title: pr.title,
          mergedAt: pr.mergedAt,
          ids,
        });
      }
    }

    return { ...upstream, blueprints, prRefs, failedRepos, truncatedRepos };
  },
};
