import type { ActionContext } from "../../types";

interface Input {
  org: string;
  repos: string[];
  sinceDate: string;
  excludeRepos?: string[];
  [key: string]: unknown;
}

interface MergedPR {
  number: number;
  title: string;
  author: string;
  mergedAt: string;
  date: string; // YYYY-MM-DD
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { org, repos, sinceDate, excludeRepos = [], ...upstream } = input;
    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("Shell capability required");

    const filtered = repos.filter((r) => !excludeRepos.includes(r));
    const prsByRepo: Record<string, MergedPR[]> = {};

    for (const repo of filtered) {
      const fullRepo = `${org}/${repo}`;
      const result = await shell(
        `gh pr list --repo ${fullRepo} --state merged --search "merged:>=${sinceDate}" --json number,title,author,mergedAt --jq '[.[] | {number, title, author: .author.login, mergedAt}]' 2>/dev/null || echo '[]'`
      );

      let prs: MergedPR[] = [];
      try {
        const raw = JSON.parse(result.stdout);
        prs = raw
          .filter((pr: { mergedAt: string }) => pr.mergedAt >= sinceDate)
          .map((pr: { number: number; title: string; author: string; mergedAt: string }) => ({
            ...pr,
            date: pr.mergedAt.split("T")[0],
          }));
      } catch (_err) {
        // gh command failed or returned non-JSON — skip this repo
      }

      if (prs.length > 0) {
        prsByRepo[repo] = prs;
      }
    }

    return {
      ...upstream,
      org,
      repos: filtered,
      sinceDate,
      prsByRepo,
      gatheredAt: new Date().toISOString(),
    };
  },
};
