import type { ActionContext } from "../../types";

interface Input {
  org: string;
  repos: string[];
  author: string;
  hoursBack?: number;
  [key: string]: unknown;
}

interface RepoWork {
  repo: string;
  commits: Array<{ sha: string; message: string; date: string }>;
  prsMerged: Array<{ number: number; title: string }>;
  issuesClosed: Array<{ number: number; title: string }>;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { org, repos, author, hoursBack = 10, ...upstream } = input;
    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("Shell capability required");

    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
    const workDone: RepoWork[] = [];

    for (const repo of repos) {
      const fullRepo = `${org}/${repo}`;

      // Commits by author in the time window
      const commitsResult = await shell(
        `gh api "repos/${fullRepo}/commits?author=${author}&since=${since}" --jq '[.[:20] | .[] | {sha: .sha[:7], message: (.commit.message | split("\\n")[0]), date: .commit.author.date}]' 2>/dev/null || echo '[]'`
      );

      // PRs merged by author recently
      const mergedResult = await shell(
        `gh pr list --repo ${fullRepo} --state merged --author ${author} --json number,title,mergedAt --jq '[.[:10] | .[] | select(.mergedAt > "${since}") | {number, title}]' 2>/dev/null || echo '[]'`
      );

      // Issues closed recently (assigned to author)
      const closedResult = await shell(
        `gh issue list --repo ${fullRepo} --state closed --assignee ${author} --json number,title,closedAt --jq '[.[:10] | .[] | select(.closedAt > "${since}") | {number, title}]' 2>/dev/null || echo '[]'`
      );

      let commits: any[] = [], prsMerged: any[] = [], issuesClosed: any[] = [];
      try { commits = JSON.parse(commitsResult.stdout); } catch {}
      try { prsMerged = JSON.parse(mergedResult.stdout); } catch {}
      try { issuesClosed = JSON.parse(closedResult.stdout); } catch {}

      // Only include repos with activity
      if (commits.length || prsMerged.length || issuesClosed.length) {
        workDone.push({ repo, commits, prsMerged, issuesClosed });
      }
    }

    return {
      ...upstream,
      org,
      repos,
      author,
      since,
      hoursBack,
      workDone,
      collectedAt: new Date().toISOString(),
    };
  },
};
