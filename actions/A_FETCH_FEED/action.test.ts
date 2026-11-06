import { describe, expect, test } from "bun:test";
import type { ActionContext } from "../../types";
import action from "./action";

const entry = (title: string, published?: string) =>
  `<entry><title>${title}</title><link href="https://example.test/${encodeURIComponent(title)}"/>${published ? `<published>${published}</published>` : ""}</entry>`;
const feedOf = (...entries: string[]) => `<feed><title>Example</title>${entries.join("")}</feed>`;

function contextFor(xml: string, startedAt: string, timeZone = "Europe/Zurich"): ActionContext {
  return {
    capabilities: { fetch: (async () => new Response(xml)) as unknown as typeof fetch },
    env: { mode: "local" },
    run: { startedAt: new Date(startedAt), timeZone },
  };
}

async function fetchWindow(xml: string, startedAt: string, extra: Record<string, unknown> = {}, timeZone?: string) {
  return action.execute({ feedUrl: "https://example.test/feed", limit: 150, window: "yesterday", ...extra }, contextFor(xml, startedAt, timeZone)) as Promise<Record<string, any>>;
}
const titles = (out: Record<string, any>): string[] => out.items.map((item: { title: string }) => item.title);

describe("A_FETCH_FEED window: yesterday", () => {
  test("keeps only yesterday's items from a feed holding other days", async () => {
    const out = await fetchWindow(
      feedOf(
        entry("today", "2026-11-06T09:00:00+01:00"),
        entry("yesterday-late", "2026-11-05T23:30:00+01:00"),
        entry("yesterday-early", "2026-11-05T00:10:00+01:00"),
        entry("day-before", "2026-11-04T18:00:00+01:00"),
      ),
      "2026-11-06T08:00:00+01:00",
    );
    expect(titles(out)).toEqual(["yesterday-late", "yesterday-early"]);
    expect(out).toMatchObject({ windowDay: "2026-11-05", windowZone: "Europe/Zurich", windowPartial: false, windowNote: "" });
  });

  test("a day boundary is local midnight, whatever offset the item carries", async () => {
    const out = await fetchWindow(
      feedOf(
        entry("first-of-today-utc", "2026-11-05T23:00:00Z"),
        entry("last-of-yesterday-utc", "2026-11-05T22:59:59Z"),
        entry("first-of-yesterday-tokyo", "2026-11-05T08:00:00+09:00"),
        entry("last-of-day-before-tokyo", "2026-11-05T07:59:59+09:00"),
      ),
      "2026-11-06T08:00:00+01:00",
    );
    expect(titles(out)).toEqual(["last-of-yesterday-utc", "first-of-yesterday-tokyo"]);
  });

  test("reads the RFC 822 dates an RSS feed carries", async () => {
    const rss = `<rss><channel><title>Example</title><item><title>in</title><pubDate>Thu, 05 Nov 2026 12:00:00 +0100</pubDate></item><item><title>out</title><pubDate>Wed, 04 Nov 2026 12:00:00 GMT</pubDate></item></channel></rss>`;
    expect(titles(await fetchWindow(rss, "2026-11-06T08:00:00+01:00"))).toEqual(["in"]);
  });

  test("a short day and a long day each hold all of their hours", async () => {
    const spring = await fetchWindow(
      feedOf(
        entry("after-spring-day", "2026-03-29T22:00:00Z"),
        entry("spring-last", "2026-03-29T21:59:59Z"),
        entry("spring-first", "2026-03-28T23:00:00Z"),
        entry("before-spring-day", "2026-03-28T22:59:59Z"),
      ),
      "2026-03-30T08:00:00+02:00",
    );
    expect(titles(spring)).toEqual(["spring-last", "spring-first"]);

    const autumn = await fetchWindow(
      feedOf(
        entry("after-autumn-day", "2026-10-25T23:00:00Z"),
        entry("autumn-last", "2026-10-25T22:59:59Z"),
        entry("autumn-first", "2026-10-24T22:00:00Z"),
        entry("before-autumn-day", "2026-10-24T21:59:59Z"),
      ),
      "2026-10-26T08:00:00+01:00",
    );
    expect(titles(autumn)).toEqual(["autumn-last", "autumn-first"]);
  });

  test("a run on the first of a month reads the last day of the month before", async () => {
    const out = await fetchWindow(
      feedOf(entry("march", "2026-03-31T12:00:00+02:00"), entry("older", "2026-03-30T12:00:00+02:00")),
      "2026-04-01T08:00:00+02:00",
    );
    expect(out.windowDay).toBe("2026-03-31");
    expect(titles(out)).toEqual(["march"]);
  });

  test("the day comes from the run's zone, so one instant can be two different yesterdays", async () => {
    const xml = feedOf(entry("nov-5-utc-noon", "2026-11-05T12:00:00Z"), entry("nov-4-utc-noon", "2026-11-04T12:00:00Z"));
    const instant = "2026-11-06T02:00:00Z";
    expect(titles(await fetchWindow(xml, instant, {}, "Europe/Zurich"))).toEqual(["nov-5-utc-noon"]);
    expect(titles(await fetchWindow(xml, instant, {}, "America/Los_Angeles"))).toEqual(["nov-4-utc-noon"]);
  });

  test("an item with no readable date is left out and counted, never guessed into the day", async () => {
    const out = await fetchWindow(
      feedOf(entry("dated", "2026-11-05T12:00:00+01:00"), entry("no-date"), entry("bad-date", "soon"), entry("older", "2026-11-04T12:00:00+01:00")),
      "2026-11-06T08:00:00+01:00",
    );
    expect(titles(out)).toEqual(["dated"]);
    expect(out.windowPartial).toBe(true);
    expect(out.windowNote).toContain("2 articles without a readable date");
  });

  test("a feed that does not reach back past the day says the day may be partial", async () => {
    const out = await fetchWindow(
      feedOf(entry("today", "2026-11-06T07:00:00+01:00"), entry("yesterday-evening", "2026-11-05T20:00:00+01:00")),
      "2026-11-06T08:00:00+01:00",
    );
    expect(titles(out)).toEqual(["yesterday-evening"]);
    expect(out.windowPartial).toBe(true);
    expect(out.windowNote).toContain("2026-11-05 20:00");
  });

  test("limit never hides a day further down the feed, and cutting the day itself is reported", async () => {
    const today = Array.from({ length: 5 }, (_, i) => entry(`today-${i}`, `2026-11-06T0${i}:00:00+01:00`));
    const yesterday = Array.from({ length: 4 }, (_, i) => entry(`yesterday-${i}`, `2026-11-05T1${i}:00:00+01:00`));
    const older = entry("older", "2026-11-04T12:00:00+01:00");

    const whole = await fetchWindow(feedOf(...today, ...yesterday, older), "2026-11-06T08:00:00+01:00", { limit: 4 });
    expect(titles(whole)).toHaveLength(4);
    expect(whole.windowPartial).toBe(false);

    const cut = await fetchWindow(feedOf(...today, ...yesterday, older), "2026-11-06T08:00:00+01:00", { limit: 3 });
    expect(titles(cut)).toEqual(["yesterday-0", "yesterday-1", "yesterday-2"]);
    expect(cut.windowPartial).toBe(true);
    expect(cut.windowNote).toContain("first 3 of 4");
  });

  test("a day with no items gives an empty list and a complete window", async () => {
    const out = await fetchWindow(
      feedOf(entry("today", "2026-11-06T07:00:00+01:00"), entry("older", "2026-11-04T12:00:00+01:00")),
      "2026-11-06T08:00:00+01:00",
    );
    expect(out.items).toEqual([]);
    expect(out.windowPartial).toBe(false);
  });

  test("an empty feed says it cannot speak for the day", async () => {
    const out = await fetchWindow(feedOf(), "2026-11-06T08:00:00+01:00");
    expect(out.items).toEqual([]);
    expect(out.windowPartial).toBe(true);
    expect(out.windowNote).toContain("no article with a readable date");
  });

  test("an Atom entry with only the required updated date is dated by it", async () => {
    const xml = feedOf(
      `<entry><title>only-updated</title><updated>2026-11-05T12:00:00+01:00</updated></entry>`,
      entry("older", "2026-11-04T12:00:00+01:00"),
    );
    expect(titles(await fetchWindow(xml, "2026-11-06T08:00:00+01:00"))).toEqual(["only-updated"]);
  });

  test("without a clock from the run it reads the host's clock and zone", async () => {
    const xml = feedOf(entry("ancient", "2001-01-01T12:00:00Z"));
    const context = contextFor(xml, "2026-11-06T08:00:00+01:00");
    delete context.run;
    const out = (await action.execute({ feedUrl: "https://example.test/feed", limit: 150, window: "yesterday" }, context)) as Record<string, any>;
    expect(out.windowZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(out.items).toEqual([]);
  });

  test("an unknown window is refused rather than ignored", async () => {
    await expect(fetchWindow(feedOf(), "2026-11-06T08:00:00+01:00", { window: "last-week" })).rejects.toThrow("window");
  });
});

describe("A_FETCH_FEED without a window", () => {
  test("still returns the first limit items, whatever their date", async () => {
    const out = (await action.execute(
      { feedUrl: "https://example.test/feed", limit: 2 },
      contextFor(feedOf(entry("a", "2001-01-01T00:00:00Z"), entry("b"), entry("c")), "2026-11-06T08:00:00+01:00"),
    )) as Record<string, any>;
    expect(titles(out)).toEqual(["a", "b"]);
    expect(out.windowDay).toBeUndefined();
  });
});
