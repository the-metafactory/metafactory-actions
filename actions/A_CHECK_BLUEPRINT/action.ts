import type { ActionContext } from "../../types";

interface Input {
  repos: string[];
  [key: string]: unknown;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { repos, ...upstream } = input;
    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("Shell capability required");

    const blueprintStatus: Record<string, {
      done: string[];
      inProgress: string[];
      planned: string[];
    }> = {};

    for (const repo of repos) {
      const repoPath = `${process.env.HOME}/work/mf/${repo}`;
      const yamlPath = `${repoPath}/blueprint.yaml`;

      // Read blueprint.yaml and extract feature statuses
      const result = await shell(
        `cat "${yamlPath}" 2>/dev/null || echo ""`
      );

      if (!result.stdout.trim()) {
        blueprintStatus[repo] = { done: [], inProgress: [], planned: [] };
        continue;
      }

      const done: string[] = [];
      const inProgress: string[] = [];
      const planned: string[] = [];

      // Parse features from YAML
      const lines = result.stdout.split("\n");
      let currentId = "";
      let currentName = "";

      for (const line of lines) {
        const idMatch = line.match(/^\s+- id:\s*(.+)/);
        const nameMatch = line.match(/^\s+name:\s*(.+)/);
        const statusMatch = line.match(/^\s+status:\s*(.+)/);

        if (idMatch) currentId = idMatch[1].trim();
        if (nameMatch) currentName = nameMatch[1].trim();
        if (statusMatch && currentId) {
          const status = statusMatch[1].trim();
          const label = `${currentId}: ${currentName}`;
          if (status === "done") done.push(label);
          else if (status === "in-progress") inProgress.push(label);
          else if (status === "planned") planned.push(label);
          currentId = "";
          currentName = "";
        }
      }

      blueprintStatus[repo] = { done, inProgress, planned };
    }

    return {
      ...upstream,
      repos,
      blueprintStatus,
      blueprintCheckedAt: new Date().toISOString(),
    };
  },
};
