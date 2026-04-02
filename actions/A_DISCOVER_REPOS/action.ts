import type { ActionContext } from "../../types";

interface Input {
  org?: string;
  [key: string]: unknown;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { org = "the-metafactory", ...upstream } = input;
    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("Shell capability required");

    const result = await shell(
      `gh repo list ${org} --json name,updatedAt --limit 50 --no-archived`
    );

    let repos: string[] = [];
    try {
      const parsed = JSON.parse(result.stdout) as Array<{ name: string; updatedAt: string }>;
      // Sort by most recently updated
      repos = parsed
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .map((r) => r.name);
    } catch {
      throw new Error(`Failed to parse repo list: ${result.stderr || result.stdout}`);
    }

    console.log(`  Discovered ${repos.length} repos: ${repos.join(", ")}`);

    return {
      ...upstream,
      org,
      repos,
      discoveredAt: new Date().toISOString(),
    };
  },
};
