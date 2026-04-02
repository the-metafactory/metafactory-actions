import type { ActionContext } from "../../types";

interface Input {
  org: string;
  repos: string[];
  [key: string]: unknown;
}

interface WorkItem {
  type: "issue" | "pr" | "handover" | "blueprint-feature";
  repo: string;
  id: string;
  title: string;
  labels: string[];
  url?: string;
  author?: string;
  /** For blueprint features */
  status?: string;
  depends?: string[];
  iteration?: number;
  description?: string;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { org, repos, ...upstream } = input;
    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("Shell capability required");

    const workItems: WorkItem[] = [];

    for (const repo of repos) {
      const fullRepo = `${org}/${repo}`;

      // 1. Open issues
      const issuesResult = await shell(
        `gh issue list --repo ${fullRepo} --state open --json number,title,labels,author,url --limit 50 2>/dev/null || echo '[]'`
      );
      try {
        const issues = JSON.parse(issuesResult.stdout) as Array<{
          number: number; title: string; labels: Array<{ name: string }>; author: { login: string }; url: string;
        }>;
        for (const issue of issues) {
          workItems.push({
            type: "issue",
            repo,
            id: `${repo}#${issue.number}`,
            title: issue.title,
            labels: issue.labels.map((l) => l.name),
            url: issue.url,
            author: issue.author?.login,
          });
        }
      } catch { /* skip parse errors */ }

      // 2. Open PRs
      const prsResult = await shell(
        `gh pr list --repo ${fullRepo} --state open --json number,title,labels,author,url --limit 20 2>/dev/null || echo '[]'`
      );
      try {
        const prs = JSON.parse(prsResult.stdout) as Array<{
          number: number; title: string; labels: Array<{ name: string }>; author: { login: string }; url: string;
        }>;
        for (const pr of prs) {
          workItems.push({
            type: "pr",
            repo,
            id: `${repo}#${pr.number}`,
            title: pr.title,
            labels: pr.labels.map((l) => l.name),
            url: pr.url,
            author: pr.author?.login,
          });
        }
      } catch { /* skip parse errors */ }

      // 3. Blueprint features (planned or in-progress)
      const repoPath = `${process.env.HOME}/work/mf/${repo}`;
      const bpResult = await shell(`cat "${repoPath}/blueprint.yaml" 2>/dev/null || echo ""`);

      if (bpResult.stdout.trim()) {
        const features = parseBlueprintFeatures(bpResult.stdout, repo);
        workItems.push(...features);
      }
    }

    // 4. Open handover issues (label: handover, state: open) across entire org
    // Handovers could be on any repo, but typically meta-factory
    const handoverResult = await shell(
      `gh search issues --owner ${org} --state open --label handover --json repository,number,title,url --limit 20 2>/dev/null || echo '[]'`
    );
    try {
      const handovers = JSON.parse(handoverResult.stdout) as Array<{
        repository: { name: string }; number: number; title: string; url: string;
      }>;
      for (const h of handovers) {
        workItems.push({
          type: "handover",
          repo: h.repository?.name || "unknown",
          id: `${h.repository?.name || "unknown"}#${h.number}`,
          title: h.title,
          labels: ["handover"],
          url: h.url,
        });
      }
    } catch { /* skip parse errors */ }

    console.log(`  Gathered ${workItems.length} work items across ${repos.length} repos`);
    console.log(`    Issues: ${workItems.filter((w) => w.type === "issue").length}`);
    console.log(`    PRs: ${workItems.filter((w) => w.type === "pr").length}`);
    console.log(`    Blueprint: ${workItems.filter((w) => w.type === "blueprint-feature").length}`);
    console.log(`    Handovers: ${workItems.filter((w) => w.type === "handover").length}`);

    return {
      ...upstream,
      org,
      repos,
      workItems,
      gatheredAt: new Date().toISOString(),
    };
  },
};

function parseBlueprintFeatures(yaml: string, repo: string): WorkItem[] {
  const features: WorkItem[] = [];
  const lines = yaml.split("\n");
  let currentId = "";
  let currentName = "";
  let currentStatus = "";
  let currentIteration: number | undefined;
  let currentDepends: string[] = [];
  let currentDescription = "";

  for (const line of lines) {
    const idMatch = line.match(/^\s+- id:\s*(.+)/);
    const nameMatch = line.match(/^\s+name:\s*(.+)/);
    const statusMatch = line.match(/^\s+status:\s*(.+)/);
    const iterMatch = line.match(/^\s+iteration:\s*(\d+)/);
    const dependsMatch = line.match(/^\s+depends:\s*\[([^\]]*)\]/);
    const descMatch = line.match(/^\s+description:\s*"?(.+?)"?\s*$/);

    if (idMatch) currentId = idMatch[1].trim();
    if (nameMatch) currentName = nameMatch[1].trim();
    if (iterMatch) currentIteration = parseInt(iterMatch[1]);
    if (dependsMatch) {
      currentDepends = dependsMatch[1]
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean);
    }
    if (descMatch) currentDescription = descMatch[1].trim();

    if (statusMatch && currentId) {
      currentStatus = statusMatch[1].trim();

      // Only include planned and in-progress features
      if (currentStatus === "planned" || currentStatus === "in-progress") {
        features.push({
          type: "blueprint-feature",
          repo,
          id: `${repo}/${currentId}`,
          title: `${currentId}: ${currentName}`,
          labels: currentStatus === "in-progress" ? ["now"] : ["future"],
          status: currentStatus,
          depends: currentDepends,
          iteration: currentIteration,
          description: currentDescription,
        });
      }

      // Reset
      currentId = "";
      currentName = "";
      currentStatus = "";
      currentIteration = undefined;
      currentDepends = [];
      currentDescription = "";
    }
  }

  return features;
}
