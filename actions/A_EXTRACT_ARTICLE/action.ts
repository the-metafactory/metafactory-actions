import type { ActionContext } from "../../types";

interface FeedItem {
  title: string;
  link: string;
  description: string;
  pubDate?: string;
}

interface Article extends FeedItem {
  content: string;
  wordCount: number;
}

interface Input {
  items: FeedItem[];
  [key: string]: unknown;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { items, ...upstream } = input;
    const fetchFn = ctx.capabilities.fetch!;

    const articles: Article[] = [];

    for (const item of items.slice(0, 3)) {
      // Skip items without links
      if (!item.link) {
        articles.push({ ...item, content: item.description, wordCount: item.description.split(/\s+/).length });
        continue;
      }

      try {
        const response = await fetchFn(item.link, {
          headers: { "User-Agent": "pulse/0.1.0" },
          redirect: "follow",
        });

        if (!response.ok) {
          articles.push({ ...item, content: item.description, wordCount: item.description.split(/\s+/).length });
          continue;
        }

        const html = await response.text();

        // Simple content extraction: find <article>, <main>, or largest <p> block
        let content = "";
        const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
        const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
        const block = articleMatch?.[1] || mainMatch?.[1] || html;

        // Strip HTML tags, collapse whitespace
        content = block
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 2000);

        const wordCount = content.split(/\s+/).length;
        articles.push({ ...item, content, wordCount });
      } catch {
        // On fetch error, use description as content
        articles.push({ ...item, content: item.description, wordCount: item.description.split(/\s+/).length });
      }
    }

    return {
      ...upstream,
      articles,
      extractedAt: new Date().toISOString(),
    };
  },
};
