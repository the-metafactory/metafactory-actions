import type { ActionContext } from "../../types";

interface Input {
  repoActivity: any[];
  blueprintStatus: Record<string, { done: string[]; inProgress: string[]; planned: string[] }>;
  since?: string;
  [key: string]: unknown;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { repoActivity, blueprintStatus, since, ...upstream } = input;
    const llm = ctx.capabilities.llm;
    if (!llm) throw new Error("LLM capability required");

    // Build context for the LLM
    const activitySummary = repoActivity.map((r) => {
      const parts = [`## ${r.repo}`];
      if (r.commits?.length) parts.push(`Commits: ${r.commits.length} (latest: ${r.commits.slice(0, 3).map((c: any) => c.message).join("; ")})`);
      if (r.prsMerged?.length) parts.push(`PRs merged: ${r.prsMerged.map((p: any) => `#${p.number} ${p.title}`).join(", ")}`);
      if (r.prsOpen?.length) parts.push(`PRs open: ${r.prsOpen.map((p: any) => `#${p.number} ${p.title}`).join(", ")}`);
      if (r.issuesOpened?.length) parts.push(`Open issues: ${r.issuesOpened.map((i: any) => `#${i.number} ${i.title}`).join(", ")}`);
      if (r.issuesClosed?.length) parts.push(`Closed issues: ${r.issuesClosed.map((i: any) => `#${i.number}`).join(", ")}`);
      return parts.join("\n");
    }).join("\n\n");

    const blueprintSummary = Object.entries(blueprintStatus).map(([repo, status]) => {
      const parts = [`## ${repo}`];
      if (status.inProgress.length) parts.push(`In progress: ${status.inProgress.join(", ")}`);
      if (status.planned.length) parts.push(`Planned (${status.planned.length} features)`);
      parts.push(`Done: ${status.done.length} features`);
      return parts.join("\n");
    }).join("\n\n");

    const prompt = `You are a development team assistant for the metafactory ecosystem — a marketplace for agentic components.

Analyze this ecosystem activity and produce a concise daily digest.

## Recent Activity
${activitySummary}

## Blueprint Status (feature roadmap)
${blueprintSummary}

Produce a JSON response with:
- "summary": A 2-3 sentence overview of what happened and what's moving
- "highlights": Array of 3-5 notable items (merged PRs, completed features, new issues) as short strings
- "blockers": Array of items that might need attention (stale PRs, blocked features, failing patterns) as short strings. Empty array if none.
- "nextUp": Array of 2-3 things the team should focus on next based on the blueprint

Return ONLY valid JSON.`;

    const result = await llm(prompt, {
      tier: "fast",
      system: "You are a concise, actionable development digest generator. Focus on what matters. No fluff.",
      json: true,
    });

    const parsed = result.json as {
      summary?: string;
      highlights?: string[];
      blockers?: string[];
      nextUp?: string[];
    } | undefined;

    return {
      ...upstream,
      repoActivity,
      blueprintStatus,
      since,
      summary: parsed?.summary || "Unable to generate summary",
      highlights: parsed?.highlights || [],
      blockers: parsed?.blockers || [],
      nextUp: parsed?.nextUp || [],
      summarizedAt: new Date().toISOString(),
    };
  },
};
