import type { ActionContext } from "../../types";

interface Input {
  org: string;
  repos: string[];
  author: string;
  [key: string]: unknown;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { org, repos, author, ...upstream } = input;
    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("Shell capability required");

    const prsNeedingReview: Array<{ repo: string; number: number; title: string; author: string }> = [];
    const prsOpen: Array<{ repo: string; number: number; title: string }> = [];
    const issuesInProgress: Array<{ repo: string; number: number; title: string; labels: string[] }> = [];
    const issuesBlocked: Array<{ repo: string; number: number; title: string }> = [];

    for (const repo of repos) {
      const fullRepo = `${org}/${repo}`;

      // PRs requesting review from the handover recipient
      const reviewResult = await shell(
        `gh pr list --repo ${fullRepo} --state open --json number,title,author,reviewRequests --jq '[.[] | {number, title, author: .author.login, reviewers: [.reviewRequests[].login]}]' 2>/dev/null || echo '[]'`
      );

      // Open PRs by the handing-off author
      const myPrsResult = await shell(
        `gh pr list --repo ${fullRepo} --state open --author ${author} --json number,title --jq '[.[] | {number, title}]' 2>/dev/null || echo '[]'`
      );

      // Issues with "handover" or "blocked" labels, or assigned to author
      const issuesResult = await shell(
        `gh issue list --repo ${fullRepo} --state open --assignee ${author} --json number,title,labels --jq '[.[] | {number, title, labels: [.labels[].name]}]' 2>/dev/null || echo '[]'`
      );

      try {
        const reviews = JSON.parse(reviewResult.stdout);
        for (const pr of reviews) {
          if (pr.author !== author) {
            prsNeedingReview.push({ repo, number: pr.number, title: pr.title, author: pr.author });
          }
        }
      } catch {}

      try {
        const myPrs = JSON.parse(myPrsResult.stdout);
        for (const pr of myPrs) {
          prsOpen.push({ repo, number: pr.number, title: pr.title });
        }
      } catch {}

      try {
        const issues = JSON.parse(issuesResult.stdout);
        for (const issue of issues) {
          const labels = issue.labels || [];
          if (labels.includes("blocked") || labels.includes("needs-decision")) {
            issuesBlocked.push({ repo, number: issue.number, title: issue.title });
          } else {
            issuesInProgress.push({ repo, number: issue.number, title: issue.title, labels });
          }
        }
      } catch {}
    }

    return {
      ...upstream,
      org,
      repos,
      author,
      openThreads: {
        prsNeedingReview,
        prsOpen,
        issuesInProgress,
        issuesBlocked,
      },
      gatheredAt: new Date().toISOString(),
    };
  },
};
