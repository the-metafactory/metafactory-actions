import type { ActionContext } from "../../types";

interface RatedArticle {
  title: string;
  link: string;
  relevance: number;
  quality: number;
  reasoning: string;
  wordCount: number;
}

interface Input {
  rated: RatedArticle[];
  feedTitle?: string;
  [key: string]: unknown;
}

export default {
  async execute(input: Input, _ctx: ActionContext) {
    const { rated, feedTitle, ...upstream } = input;

    // Rank by combined score (relevance 60% + quality 40%)
    const ranked = [...rated]
      .map((a) => ({
        ...a,
        score: a.relevance * 0.6 + a.quality * 0.4,
      }))
      .sort((a, b) => b.score - a.score);

    const topPicks = ranked.filter((a) => a.score >= 6);

    // Build digest
    const lines: string[] = [];
    lines.push(`# Feed Digest: ${feedTitle || "RSS Feed"}`);
    lines.push(`*${ranked.length} articles evaluated*\n`);

    if (topPicks.length === 0) {
      lines.push("No standout articles this round.\n");
    } else {
      lines.push(`## Top Picks (${topPicks.length})\n`);
      for (const pick of topPicks) {
        const stars = "★".repeat(Math.round(pick.score / 2)) + "☆".repeat(5 - Math.round(pick.score / 2));
        lines.push(`### ${pick.title}`);
        lines.push(`${stars} (${pick.score.toFixed(1)}/10) — ${pick.wordCount} words`);
        lines.push(`${pick.reasoning}`);
        lines.push(`[Read →](${pick.link})\n`);
      }
    }

    if (ranked.length > topPicks.length) {
      lines.push("## Also Reviewed\n");
      for (const article of ranked.slice(topPicks.length)) {
        lines.push(`- **${article.title}** (${article.score.toFixed(1)}/10)`);
      }
    }

    return {
      ...upstream,
      feedTitle,
      topPicks,
      ranked,
      digest: lines.join("\n"),
      recommendedAt: new Date().toISOString(),
    };
  },
};
