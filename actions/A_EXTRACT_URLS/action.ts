import type { ActionContext } from "../../types";
import { baseDomain } from "../../utils";

interface Input {
  emailBody: string;
  [key: string]: unknown;
}

const SKIP_DOMAINS = new Set([
  "media.beehiiv.com",
  "t.co",
  "twitter.com",
  "x.com",
  "linkedin.com",
  "facebook.com",
  "youtube.com",
  "youtu.be",
  "reddit.com",
  "news.ycombinator.com",
  "ul.live",
  "beehiiv.com",
  "unsupervised-learning.com",
]);

function unwrapUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "wise.readwise.io" && parsed.searchParams.has("url")) {
      return parsed.searchParams.get("url")!;
    }
  } catch {
    // not a valid URL, return as-is
  }
  return url;
}

export default {
  async execute(input: Input, _ctx: ActionContext) {
    const { emailBody, ...upstream } = input;

    const urlRegex = /https?:\/\/[^\s)<>\]"]+/gi;
    const rawUrls = emailBody.match(urlRegex) || [];

    const cleaned = rawUrls.map((u: string) =>
      u.replace(/[.,;:!?)]+$/, "").replace(/\)$/, "")
    );

    const unwrapped = cleaned.map(unwrapUrl);

    const seen = new Set<string>();
    const urls: Array<{ url: string; domain: string }> = [];

    for (const url of unwrapped) {
      const domain = baseDomain(url);
      if (SKIP_DOMAINS.has(domain)) continue;
      if (/\.(png|jpg|jpeg|gif|svg|webp|ico|mp3|mp4|pdf)(\?|$)/i.test(url)) continue;

      const normalized = url.replace(/\/+$/, "").toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);

      urls.push({ url, domain });
    }

    return {
      ...upstream,
      urls,
      urlCount: urls.length,
      extractedAt: new Date().toISOString(),
    };
  },
};
