import type { ActionContext } from "../../types";

interface Input {
  org: string;
  repos: string[];
  sinceDays?: number;
  [key: string]: unknown;
}

interface RepoActivity {
  repo: string;
  commits: Array<{ sha: string; message: string; author: string; date: string }>;
  prsOpen: Array<{ number: number; title: string; author: string }>;
  prsMerged: Array<{ number: number; title: string; author: string }>;
  issuesOpened: Array<{ number: number; title: string; labels: string[] }>;
  issuesClosed: Array<{ number: number; title: string }>;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { org, repos, sinceDays = 1, ...upstream } = input;
    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("Shell capability required");

    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const repoActivity: RepoActivity[] = [];

    for (const repo of repos) {
      const fullRepo = `${org}/${repo}`;

      // Recent commits
      const commitsResult = await shell(
        `gh api repos/${fullRepo}/commits --jq '[.[:10] | .[] | {sha: .sha[:7], message: (.commit.message | split("\\n")[0]), author: .commit.author.name, date: .commit.author.date}]' 2>/dev/null || echo '[]'`
      );

      // Open PRs
      const prsResult = await shell(
        `gh pr list --repo ${fullRepo} --state open --json number,title,author --jq '[.[] | {number, title, author: .author.login}]' 2>/dev/null || echo '[]'`
      );

      // Recently merged PRs
      const mergedResult = await shell(
        `gh pr list --repo ${fullRepo} --state merged --json number,title,author,mergedAt --jq '[.[:5] | .[] | {number, title, author: .author.login}]' 2>/dev/null || echo '[]'`
      );

      // Issues opened since date
      const issuesOpenedResult = await shell(
        `gh issue list --repo ${fullRepo} --state open --json number,title,labels --jq '[.[:10] | .[] | {number, title, labels: [.labels[].name]}]' 2>/dev/null || echo '[]'`
      );

      // Recently closed issues
      const issuesClosedResult = await shell(
        `gh issue list --repo ${fullRepo} --state closed --json number,title,closedAt --jq '[.[:5] | .[] | {number, title}]' 2>/dev/null || echo '[]'`
      );

      let commits = [], prsOpen = [], prsMerged = [], issuesOpened = [], issuesClosed = [];
      try { commits = JSON.parse(commitsResult.stdout); } catch {}
      try { prsOpen = JSON.parse(prsResult.stdout); } catch {}
      try { prsMerged = JSON.parse(mergedResult.stdout); } catch {}
      try { issuesOpened = JSON.parse(issuesOpenedResult.stdout); } catch {}
      try { issuesClosed = JSON.parse(issuesClosedResult.stdout); } catch {}

      repoActivity.push({
        repo,
        commits,
        prsOpen,
        prsMerged,
        issuesOpened,
        issuesClosed,
      });
    }

    return {
      ...upstream,
      org,
      repos,
      since,
      repoActivity,
      fetchedAt: new Date().toISOString(),
    };
  },
};
