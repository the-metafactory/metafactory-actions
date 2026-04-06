import type { ActionContext } from "../../types";
import { baseDomain } from "../../utils";

interface UrlEntry {
  url: string;
  domain: string;
}

interface Input {
  urls: UrlEntry[];
  [key: string]: unknown;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { urls, ...upstream } = input;
    const shell = ctx.capabilities.shell!;

    const result = await shell("sift sources --json -n 500");
    if (result.code !== 0) {
      throw new Error(`sift sources failed: ${result.stderr}`);
    }

    let existingSources: Array<{ url: string }>;
    try {
      existingSources = JSON.parse(result.stdout);
    } catch {
      throw new Error(`sift sources returned invalid JSON: ${result.stdout.slice(0, 200)}`);
    }

    const knownDomains = new Set(
      existingSources.map((s) => baseDomain(s.url))
    );

    const newCandidates: UrlEntry[] = [];
    let alreadyKnown = 0;

    for (const entry of urls) {
      if (knownDomains.has(entry.domain)) {
        alreadyKnown++;
      } else {
        newCandidates.push(entry);
      }
    }

    return {
      ...upstream,
      newCandidates,
      alreadyKnown,
      totalExtracted: urls.length,
      crossrefAt: new Date().toISOString(),
    };
  },
};
