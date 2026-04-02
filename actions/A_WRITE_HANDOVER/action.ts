import type { ActionContext } from "../../types";

interface Input {
  workDone: any[];
  openThreads: {
    prsNeedingReview: any[];
    prsOpen: any[];
    issuesInProgress: any[];
    issuesBlocked: any[];
  };
  author: string;
  recipient?: string;
  org?: string;
  hoursBack?: number;
  [key: string]: unknown;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { workDone, openThreads, author, recipient, org, hoursBack, ...upstream } = input;
    const llm = ctx.capabilities.llm;
    if (!llm) throw new Error("LLM capability required");

    const workSummary = workDone.map((r) => {
      const parts = [`**${r.repo}**`];
      if (r.commits?.length) parts.push(`  Commits: ${r.commits.map((c: any) => `${c.sha} ${c.message}`).join("; ")}`);
      if (r.prsMerged?.length) parts.push(`  Merged: ${r.prsMerged.map((p: any) => `#${p.number} ${p.title}`).join(", ")}`);
      if (r.issuesClosed?.length) parts.push(`  Closed: ${r.issuesClosed.map((i: any) => `#${i.number} ${i.title}`).join(", ")}`);
      return parts.join("\n");
    }).join("\n\n");

    const threadsSummary = [
      openThreads.prsNeedingReview.length ? `PRs needing review: ${openThreads.prsNeedingReview.map((p) => `${p.repo}#${p.number} "${p.title}" by ${p.author}`).join("; ")}` : "",
      openThreads.prsOpen.length ? `My open PRs: ${openThreads.prsOpen.map((p) => `${p.repo}#${p.number} "${p.title}"`).join("; ")}` : "",
      openThreads.issuesInProgress.length ? `In progress: ${openThreads.issuesInProgress.map((i) => `${i.repo}#${i.number} "${i.title}"`).join("; ")}` : "",
      openThreads.issuesBlocked.length ? `Blocked/needs decision: ${openThreads.issuesBlocked.map((i) => `${i.repo}#${i.number} "${i.title}"`).join("; ")}` : "",
    ].filter(Boolean).join("\n");

    const recipientName = recipient || "the team";
    const today = new Date().toISOString().split("T")[0];

    const prompt = `You are writing a timezone handover document for the metafactory project.

${author} is ending their work day and handing over to ${recipientName}.

## Work completed (last ${hoursBack || 10} hours)
${workSummary || "No commits, PRs, or issues recorded in this period."}

## Open threads
${threadsSummary || "No open threads."}

Write a concise, actionable handover in markdown. Structure:

1. **Summary** (2-3 sentences: what was the focus, what moved forward)
2. **Completed** (bullet list of concrete things done — PRs merged, issues closed, features shipped)
3. **Needs your attention** (things the recipient should look at — PRs to review, decisions needed, blockers)
4. **In progress** (work started but not finished — provide enough context to continue)
5. **Notes** (anything else — gotchas, things to watch out for, context that isn't in the code)

Be direct and specific. Reference PR/issue numbers. Don't pad with pleasantries.
Return the handover as markdown text (not JSON).`;

    const result = await llm(prompt, {
      tier: "standard",
      system: "You write clear, concise development handover documents. Every line should be actionable or provide context the recipient needs.",
      maxTokens: 2048,
    });

    const handover = `# Handover: ${author} → ${recipientName}\n**Date:** ${today}\n\n${result.text.trim()}`;

    return {
      ...upstream,
      workDone,
      openThreads,
      author,
      recipient,
      handover,
      handoverDate: today,
      writtenAt: new Date().toISOString(),
    };
  },
};
