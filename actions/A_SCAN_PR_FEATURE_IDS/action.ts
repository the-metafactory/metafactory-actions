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

function extractIds(title: string, prefixes: string[]): string[] {
  if (!prefixes.length) return [];
  // Build alternation; longest first to avoid partial matches
  const alt = prefixes.map((p) => p.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")).join("|");
  const re = new RegExp(`\\b(?:${alt})\\d+\\b`, "g");
  return [...new Set(title.match(re) || [])];
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const {
      blueprints,
      org = "the-metafactory",
      limit = 200,
      sinceDate,
      ...upstream
    } = input;

    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("Shell capability required");
    if (!blueprints) throw new Error("blueprints input required (run A_FETCH_BLUEPRINTS first)");

    const repos = Object.keys(blueprints.prefixesByRepo);
    const prRefs: PRRef[] = [];

    for (const repo of repos) {
      const prefixes = blueprints.prefixesByRepo[repo] || [];
      if (!prefixes.length) continue;

      const result = await shell(
        `gh pr list --repo ${org}/${repo} --state merged --limit ${limit} --json number,title,mergedAt`
      );
      let prs: Array<{ number: number; title: string; mergedAt: string }>;
      try {
        prs = JSON.parse(result.stdout);
      } catch {
        // skip repos with no access / no PRs
        continue;
      }

      for (const pr of prs) {
        if (sinceDate && pr.mergedAt < sinceDate) continue;
        const ids = extractIds(pr.title || "", prefixes);
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

    return { ...upstream, blueprints, prRefs };
  },
};
