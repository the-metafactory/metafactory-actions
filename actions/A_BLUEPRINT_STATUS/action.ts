import type { ActionContext } from "../../types";
import { homedir } from "os";
import { join } from "path";
import YAML from "yaml";

interface Input {
  [key: string]: unknown;
}

interface RepoBlueprintHealth {
  repo: string;
  total: number;
  done: number;
  inProgress: number;
  ready: number;
  blocked: number;
}

interface BlueprintHealth {
  repos: RepoBlueprintHealth[];
  summary: {
    total: number;
    done: number;
    inProgress: number;
    ready: number;
    blocked: number;
  };
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { ...upstream } = input;
    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("Shell capability required");

    const devRoot = process.env.PULSE_DEV_ROOT || join(homedir(), "Developer");
    const compassPath = process.env.COMPASS_PATH || join(devRoot, "compass");
    const blueprintCli = join(devRoot, "blueprint", "src", "cli.ts");

    // 1. Read active repos from compass
    const activeRepos = await readActiveRepos(compassPath);

    // 2. Git pull each repo to ensure blueprint.yaml is current
    const pullResults: string[] = [];
    for (const repo of activeRepos) {
      const repoPath = join(devRoot, repo);
      const result = await shell(`git -C "${repoPath}" pull --ff-only --quiet 2>&1 || true`);
      if (result.code === 0) {
        const output = result.stdout.trim();
        if (output && !output.includes("Already up to date")) {
          pullResults.push(`${repo}: updated`);
        }
      }
    }
    if (pullResults.length > 0) {
      process.stderr.write(`Blueprint sync: pulled ${pullResults.length} repo(s): ${pullResults.join(", ")}\n`);
    }

    // 3. Run blueprint status
    let blueprintHealth: BlueprintHealth | null = null;
    try {
      const result = await shell(`bun "${blueprintCli}" status --json 2>/dev/null`);
      if (result.code === 0 && result.stdout.trim()) {
        blueprintHealth = JSON.parse(result.stdout.trim());
      }
    } catch (_err) {
      // Blueprint CLI not available or failed — non-fatal, continue without it
    }

    return {
      ...upstream,
      blueprintHealth,
      reposPulled: pullResults.length,
      blueprintStatusAt: blueprintHealth ? new Date().toISOString() : null,
    };
  },
};

/** Read active repo names from compass/ecosystem/repos.yaml */
async function readActiveRepos(compassPath: string): Promise<string[]> {
  const reposPath = join(compassPath, "ecosystem", "repos.yaml");
  try {
    const file = Bun.file(reposPath);
    if (!(await file.exists())) return [];
    const parsed = YAML.parse(await file.text()) as { repos?: Record<string, { status?: string }> };
    if (!parsed?.repos) return [];
    return Object.entries(parsed.repos)
      .filter(([_, entry]) => entry.status === "active")
      .map(([name]) => name);
  } catch (_err) {
    return [];
  }
}
