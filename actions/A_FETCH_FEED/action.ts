import type { ActionContext } from "../../types";

interface Input {
  feedUrl: string;
  limit?: number;
  [key: string]: unknown;
}

interface FeedItem {
  title: string;
  link: string;
  description: string;
  pubDate?: string;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { feedUrl, limit = 5, ...upstream } = input;

    const fetchFn = ctx.capabilities.fetch!;
    const response = await fetchFn(feedUrl, {
      headers: { "User-Agent": "pulse/0.1.0" },
    });

    if (!response.ok) {
      throw new Error(`Feed fetch failed: ${response.status} ${response.statusText}`);
    }

    const xml = await response.text();

    // Simple XML parsing — extract <item> or <entry> elements
    const items: FeedItem[] = [];
    const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>|<entry[^>]*>([\s\S]*?)<\/entry>/gi;
    let match;

    while ((match = itemRegex.exec(xml)) !== null && items.length < limit) {
      const block = match[1] || match[2];
      const title = block.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1]?.trim() || "";
      const link = block.match(/<link[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/)?.[1]?.trim()
        || block.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/)?.[1]?.trim() || "";
      const desc = block.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1]?.trim()
        || block.match(/<summary[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/summary>/)?.[1]?.trim() || "";
      const pubDate = block.match(/<pubDate[^>]*>(.*?)<\/pubDate>/)?.[1]?.trim()
        || block.match(/<published[^>]*>(.*?)<\/published>/)?.[1]?.trim();

      if (title) {
        items.push({
          title: title.replace(/<[^>]*>/g, ""),
          link,
          description: desc.replace(/<[^>]*>/g, "").slice(0, 500),
          pubDate,
        });
      }
    }

    // Extract feed title
    const feedTitle = xml.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1]?.trim()?.replace(/<[^>]*>/g, "") || feedUrl;

    return {
      ...upstream,
      feedUrl,
      feedTitle,
      items,
      fetchedAt: new Date().toISOString(),
    };
  },
};
