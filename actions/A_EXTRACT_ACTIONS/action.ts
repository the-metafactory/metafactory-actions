import type { ActionContext } from "../../types";

interface RepoActivity {
  repo: string;
  commits: Array<{ sha: string; message: string; author: string; date: string }>;
  prsOpen: Array<{ number: number; title: string; author: string }>;
  prsMerged: Array<{ number: number; title: string; author: string }>;
  issuesOpened: Array<{ number: number; title: string; labels: string[] }>;
  issuesClosed: Array<{ number: number; title: string }>;
}

interface Input {
  repoActivity: RepoActivity[];
  [key: string]: unknown;
}

interface OperatorAction {
  command: string;
  reason: string;
  priority: "high" | "normal" | "low";
  repo: string;
}

/** Repos that are arc-installable packages */
const ARC_PACKAGES = new Set(["grove", "pulse", "miner", "miner-server", "compass"]);

/** Pattern rules: commit message regex → action generator */
const COMMIT_PATTERNS: Array<{
  test: RegExp;
  action: (repo: string, match: RegExpMatchArray) => OperatorAction | null;
}> = [
  {
    // Version bumps in arc-managed packages
    test: /^chore:.*bump.*v?(\d+\.\d+\.\d+)/i,
    action: (repo) =>
      ARC_PACKAGES.has(repo)
        ? { command: `arc upgrade ${repo}`, reason: "new version released", priority: "normal", repo }
        : null,
  },
  {
    // Registry changes
    test: /registry/i,
    action: (repo) =>
      repo === "meta-factory"
        ? { command: "arc catalog", reason: "registry updated — check for new packages", priority: "normal", repo }
        : null,
  },
  {
    // SOP changes
    test: /\bsop\b/i,
    action: (repo) =>
      repo === "compass"
        ? { command: "arc upgrade compass", reason: "SOPs updated", priority: "high", repo }
        : null,
  },
  {
    // CLAUDE.md or template changes
    test: /claude\.md|template/i,
    action: (repo) =>
      repo === "compass"
        ? { command: "arc upgrade compass", reason: "CLAUDE.md templates updated — regenerate repo CLAUDE.md files", priority: "high", repo }
        : null,
  },
  {
    // New skill added
    test: /\b(add|new).*skill\b/i,
    action: (_repo, match) => ({
      command: "arc catalog --type skills",
      reason: `new skill available: ${match[0]}`,
      priority: "normal",
      repo: _repo,
    }),
  },
  {
    // Agent rules / agents-md.yaml changes
    test: /agents-md|agent.?rules|claude-md\.yaml/i,
    action: (repo) => ({
      command: `arc upgrade compass`,
      reason: `agent rules updated in ${repo} — regenerate CLAUDE.md with arc`,
      priority: "normal",
      repo,
    }),
  },
  {
    // Ecosystem repos.yaml changes (compass governs which repos are in the network)
    test: /ecosystem.*repos|repos\.yaml/i,
    action: (repo) =>
      repo === "compass"
        ? { command: "arc upgrade compass", reason: "ecosystem repo registry updated — blueprint and pulse will pick up changes", priority: "high", repo }
        : null,
  },
  {
    // Breaking changes
    test: /\bBREAKING\b|breaking change/i,
    action: (repo) => ({
      command: `Review breaking changes in ${repo}`,
      reason: "breaking change detected — check compatibility",
      priority: "high",
      repo,
    }),
  },
];

export default {
  async execute(input: Input, _ctx: ActionContext) {
    const { repoActivity, ...upstream } = input;
    const actions: OperatorAction[] = [];
    const seen = new Set<string>(); // dedupe by command

    for (const activity of repoActivity) {
      const { repo, commits, prsMerged, prsOpen } = activity;

      // Arc self-update if arc itself has changes
      if (repo === "arc" && commits.length > 0) {
        addAction(actions, seen, {
          command: "arc self-update",
          reason: `${commits.length} new commit${commits.length === 1 ? "" : "s"} in arc`,
          priority: "high",
          repo: "arc",
        });
      }

      // Scan commit messages for patterns
      for (const commit of commits) {
        for (const pattern of COMMIT_PATTERNS) {
          const match = commit.message.match(pattern.test);
          if (match) {
            const action = pattern.action(repo, match);
            if (action) addAction(actions, seen, action);
          }
        }
      }

      // Scan merged PR titles for patterns
      for (const pr of prsMerged) {
        for (const pattern of COMMIT_PATTERNS) {
          const match = pr.title.match(pattern.test);
          if (match) {
            const action = pattern.action(repo, match);
            if (action) addAction(actions, seen, action);
          }
        }
      }

      // Open PRs in key repos — flag for review
      if (prsOpen.length > 0 && ARC_PACKAGES.has(repo)) {
        for (const pr of prsOpen) {
          addAction(actions, seen, {
            command: `gh pr view ${pr.number} --repo the-metafactory/${repo}`,
            reason: `open PR: ${pr.title}`,
            priority: "low",
            repo,
          });
        }
      }
    }

    // Sort: high → normal → low
    const priorityOrder = { high: 0, normal: 1, low: 2 };
    actions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    return {
      ...upstream,
      repoActivity,
      operatorActions: actions,
      actionsExtractedAt: new Date().toISOString(),
    };
  },
};

function addAction(
  actions: OperatorAction[],
  seen: Set<string>,
  action: OperatorAction,
): void {
  if (seen.has(action.command)) return;
  seen.add(action.command);
  actions.push(action);
}
