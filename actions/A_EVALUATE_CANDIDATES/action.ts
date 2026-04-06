import type { ActionContext } from "../../types";

interface UrlEntry {
  url: string;
  domain: string;
}

interface EvaluatedCandidate {
  url: string;
  domain: string;
  feedUrl: string;
  title: string;
  type: "rss" | "newsletter" | "webpage" | "video" | "academic" | "social";
  topicId: number;
  topicName: string;
  reasoning: string;
}

interface RejectedCandidate {
  url: string;
  domain: string;
  reason: string;
}

interface Input {
  newCandidates: UrlEntry[];
  [key: string]: unknown;
}

const TOPIC_MAP = `Available topics:
196 = AI & Machine Learning
197 = Technology
198 = Security
199 = Science
200 = Business
202 = Programming
203 = DevOps
204 = Data & Analytics
235 = DevTools & Productivity
237 = Process Analysis
238 = Psychology & Social Science
239 = Music & Entertainment
251 = Robotics & Hardware
253 = Space & Aerospace
254 = Economics & Fintech
255 = Geopolitics & International Affairs
292 = Biology
306 = Ecology & Environment
336 = Ideas & Culture
337 = General News & Current Affairs
338 = Swiss Tech & Policy`;

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { newCandidates, ...upstream } = input;
    const llm = ctx.capabilities.llm!;

    if (!newCandidates.length) {
      return {
        ...upstream,
        approved: [],
        rejected: [],
        evaluatedAt: new Date().toISOString(),
      };
    }

    const urlList = newCandidates
      .map((c, i) => `${i + 1}. ${c.url} (domain: ${c.domain})`)
      .join("\n");

    const prompt = `You are evaluating URLs from the Unsupervised Learning newsletter for potential RSS feed sources.

For each URL, determine:
1. Is this a BLOG or NEWS SITE that publishes regular content? (worth following as an RSS feed)
2. Or is this a ONE-OFF article, podcast episode, social media post, PDF, tool/product page, or sponsor link? (skip)

For approved sites:
- Suggest the RSS feed URL (usually /feed, /rss, /atom.xml, or /feed.xml appended to the base domain)
- Suggest a human-readable title
- Suggest the source type (rss, newsletter, webpage, video, academic, social)
- Assign the best matching topic ID from the list below

${TOPIC_MAP}

URLs to evaluate:
${urlList}

Respond in JSON format:
{
  "approved": [
    { "index": 1, "feedUrl": "https://example.com/feed", "title": "Example Blog", "type": "rss", "topicId": 196, "topicName": "AI & Machine Learning", "reasoning": "Active tech blog with regular posts" }
  ],
  "rejected": [
    { "index": 2, "reason": "One-off news article, not a blog" }
  ]
}

Be selective — only approve sites that clearly publish regular content (blogs, news outlets, research groups). Reject individual articles, product pages, event pages, PDFs, podcasts, social posts, and sponsor links.`;

    const result = await llm(prompt, {
      tier: "standard",
      system: "You are a feed curation assistant. Return ONLY valid JSON. Be selective — quality over quantity.",
      json: true,
      maxTokens: 4096,
    });

    const evaluation = result.json as {
      approved?: Array<{ index: number; feedUrl: string; title: string; type: string; topicId: number; topicName: string; reasoning: string }>;
      rejected?: Array<{ index: number; reason: string }>;
    } | null;

    const rawApproved = Array.isArray(evaluation?.approved) ? evaluation.approved : [];
    const rawRejected = Array.isArray(evaluation?.rejected) ? evaluation.rejected : [];

    const approved: EvaluatedCandidate[] = rawApproved
      .filter((a) => a.index >= 1 && a.index <= newCandidates.length)
      .map((a) => {
        const candidate = newCandidates[a.index - 1];
        return {
          url: candidate.url,
          domain: candidate.domain,
          feedUrl: a.feedUrl,
          title: a.title,
          type: a.type as EvaluatedCandidate["type"],
          topicId: a.topicId,
          topicName: a.topicName,
          reasoning: a.reasoning,
        };
      });

    const rejected: RejectedCandidate[] = rawRejected
      .filter((r) => r.index >= 1 && r.index <= newCandidates.length)
      .map((r) => {
        const candidate = newCandidates[r.index - 1];
        return {
          url: candidate.url,
          domain: candidate.domain,
          reason: r.reason,
        };
      });

    return {
      ...upstream,
      approved,
      rejected,
      evaluatedAt: new Date().toISOString(),
    };
  },
};
