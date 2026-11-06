import type { ActionContext } from "../../types";

interface Input {
  feedUrl: string;
  limit?: number;
  window?: string;
  [key: string]: unknown;
}

interface FeedItem {
  title: string;
  link: string;
  description: string;
  pubDate?: string;
}

const WINDOW_YESTERDAY = "yesterday";

function localParts(at: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(at);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function localDay(at: Date, timeZone: string): string {
  const { year, month, day } = localParts(at, timeZone);
  return `${year}-${month}-${day}`;
}

function localMinute(at: Date, timeZone: string): string {
  const { hour, minute } = localParts(at, timeZone);
  return `${localDay(at, timeZone)} ${hour}:${minute}`;
}

function dayBefore(day: string): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
}

function readInstant(pubDate: string | undefined): Date | null {
  if (!pubDate) return null;
  const at = new Date(pubDate);
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Selects by each item's own local day, so a short or long day needs no boundary arithmetic.
 * An item with no readable date is left out and counted: the list must hold only what is known to be from that day, and the note says what is missing.
 */
function selectYesterday(all: FeedItem[], limit: number, ctx: ActionContext) {
  const startedAt = ctx.run?.startedAt ?? new Date();
  const windowZone = ctx.run?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const windowDay = dayBefore(localDay(startedAt, windowZone));

  const dated = all.flatMap((item) => {
    const at = readInstant(item.pubDate);
    return at ? [{ item, at, day: localDay(at, windowZone) }] : [];
  });
  const inDay = dated.filter((entry) => entry.day === windowDay).map((entry) => entry.item);
  const undated = all.length - dated.length;
  const oldest = dated.reduce<Date | null>((soFar, entry) => (soFar && soFar <= entry.at ? soFar : entry.at), null);

  const notes: string[] = [];
  if (!oldest) notes.push(`The feed holds no article with a readable date, so it cannot show what was published on ${windowDay}.`);
  else if (!dated.some((entry) => entry.day < windowDay)) notes.push(`The feed reaches back only to ${localMinute(oldest, windowZone)}, so ${windowDay} may be incomplete.`);
  if (inDay.length > limit) notes.push(`Only the first ${limit} of ${inDay.length} articles from ${windowDay} are included.`);
  if (undated > 0 && oldest) notes.push(`${undated} articles without a readable date were left out.`);

  return {
    items: inDay.slice(0, limit),
    windowDay,
    windowZone,
    windowPartial: notes.length > 0,
    windowNote: notes.join(" "),
  };
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { feedUrl, limit = 5, ...upstream } = input;
    if (input.window !== undefined && input.window !== WINDOW_YESTERDAY) {
      throw new Error(`A_FETCH_FEED: window must be "${WINDOW_YESTERDAY}", got "${input.window}"`);
    }

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

    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1] || match[2];
      const title = block.match(/<title[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1]?.trim() || "";
      const link = block.match(/<link[^>]*>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/)?.[1]?.trim()
        || block.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/)?.[1]?.trim() || "";
      const desc = block.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1]?.trim()
        || block.match(/<summary[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/summary>/)?.[1]?.trim() || "";
      const pubDate = block.match(/<pubDate[^>]*>(.*?)<\/pubDate>/)?.[1]?.trim()
        || block.match(/<published[^>]*>(.*?)<\/published>/)?.[1]?.trim()
        || block.match(/<dc:date[^>]*>(.*?)<\/dc:date>/)?.[1]?.trim()
        || block.match(/<updated[^>]*>(.*?)<\/updated>/)?.[1]?.trim();

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
      ...(input.window ? selectYesterday(items, limit, ctx) : { items: items.slice(0, limit) }),
      fetchedAt: new Date().toISOString(),
    };
  },
};
