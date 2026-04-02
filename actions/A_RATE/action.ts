import type { ActionContext } from "../../types";

interface Article {
  title: string;
  link: string;
  description: string;
  content: string;
  wordCount: number;
  pubDate?: string;
}

interface RatedArticle extends Article {
  relevance: number;
  quality: number;
  reasoning: string;
}

interface Input {
  articles: Article[];
  [key: string]: unknown;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { articles, ...upstream } = input;
    const llm = ctx.capabilities.llm;
    if (!llm) throw new Error("LLM capability required");

    const rated: RatedArticle[] = [];

    for (const article of articles) {
      const prompt = `Rate this article on two dimensions (1-10 each):

**Relevance**: How interesting/useful is this for a technical audience?
**Quality**: How well-written, substantive, and insightful is the content?

Article title: ${article.title}
Content (first 1000 chars): ${article.content.slice(0, 1000)}

Respond in JSON format only:
{"relevance": <1-10>, "quality": <1-10>, "reasoning": "<one sentence>"}`;

      try {
        const result = await llm(prompt, {
          tier: "fast",
          system: "You are a content evaluator. Rate articles objectively. Return ONLY valid JSON.",
          json: true,
        });

        const scores = result.json as { relevance: number; quality: number; reasoning: string } | undefined;
        rated.push({
          ...article,
          relevance: scores?.relevance ?? 5,
          quality: scores?.quality ?? 5,
          reasoning: scores?.reasoning ?? "Unable to rate",
        });
      } catch {
        rated.push({
          ...article,
          relevance: 5,
          quality: 5,
          reasoning: "Rating failed — default scores applied",
        });
      }
    }

    return {
      ...upstream,
      rated,
      ratedAt: new Date().toISOString(),
    };
  },
};
