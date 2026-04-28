import type { ActionContext } from "../../types";

interface BlueprintIndex {
  features: Array<{ repo: string; id: string; status: string; name: string }>;
  prefixesByRepo: Record<string, string[]>;
}

interface Input {
  blueprints: BlueprintIndex;
  org?: string;
  limit?: number;
  sinceDate?: string;
  [key: string]: unknown;
}

interface PRRef {
  repo: string;
  prNumber: number;
  title: string;
  mergedAt: string;
  ids: string[];
}

interface RepoScanFailure {
  repo: string;
  reason: string;
}

interface RepoScanTruncation {
  repo: string;
  limit: number;
}

export function extractIds(title: string, prefixes: string[]): string[] {
  // Match by LETTER-FAMILY (not exact prefix). For each registered
  // prefix `X<digits>-`, derive the letters `X`; accept any digit-count
  // variant `X\d*-\d+`. This addresses Holly review #5 fix #4: PR title
  // `F5-501` is extracted even when the registered set is `["F-"]`,
  // so A_DETECT_DRIFT gets a chance to fuzzy-normalize and match against
  // F5-501 in blueprint. Stays repo-scoped (no generic catch-all
  // false-positive flood from SHA-256, SOP-*, INC-*, T-*, FR-*, HL-*,
  // CP-*, etc. that aren't blueprint feature IDs).
  if (!prefixes.length) return [];
  const families = new Set<string>();
  for (const p of prefixes) {
    const m = p.match(/^([A-Za-z]+)\d*-/);
    if (m) families.add(m[1]);
  }
  if (!families.size) return [];
  // Longest-first prevents partial collisions (e.g. `DD` over `D` if both existed).
  const famAlt = [...families].sort((a, b) => b.length - a.length).join("|");
  // Case-insensitive: PR titles often use lowercase variants
  // (e.g. `feat(c-016): ...` vs blueprint `C-016`).
  const re = new RegExp(`\\b(?:${famAlt})\\d*-\\d+\\b`, "gi");
  const hits = new Set<string>();
  for (const m of title.match(re) || []) hits.add(m.toUpperCase());
  return [...hits];
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const {
      blueprints,
      org = "the-metafactory",
      limit = 200,
      sinceDate,
      ...upstream
    } = input;

    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("Shell capability required");
    if (!blueprints) throw new Error("blueprints input required (run A_FETCH_BLUEPRINTS first)");

    const repos = Object.keys(blueprints.prefixesByRepo);
    const prRefs: PRRef[] = [];
    const failedRepos: RepoScanFailure[] = [];
    const truncatedRepos: RepoScanTruncation[] = [];

    for (const repo of repos) {
      const prefixes = blueprints.prefixesByRepo[repo] || [];

      const result = await shell(
        `gh pr list --repo ${org}/${repo} --state merged --limit ${limit} --json number,title,mergedAt`
      );

      // Surface per-repo scan failures rather than swallowing them. (Holly
      // cycle-2 #1 [major]) `gh pr list` reports errors via stderr+exit;
      // empty stdout from a failure used to JSON.parse-throw + silently
      // `continue`, making MISSING/STALE counts a lower bound the operator
      // couldn't distinguish from "0 drift in this repo".
      if (result.code !== 0) {
        const reason = (result.stderr || "").trim().slice(0, 200) || `exit ${result.code}`;
        failedRepos.push({ repo, reason });
        continue;
      }

      let prs: Array<{ number: number; title: string; mergedAt: string }>;
      try {
        prs = JSON.parse(result.stdout);
      } catch (err) {
        failedRepos.push({
          repo,
          reason: `JSON parse failed: ${(err as Error).message.slice(0, 100)}`,
        });
        continue;
      }

      // Surface limit-truncation as well (Holly cycle-2 #2 [warning]).
      // `gh pr list` returns up to `limit` rows; if a repo's merged-PR
      // history exceeds `limit` since `sinceDate`, the tail is silently
      // dropped — operator needs to see that.
      if (prs.length === limit) {
        truncatedRepos.push({ repo, limit });
      }

      for (const pr of prs) {
        if (sinceDate && pr.mergedAt < sinceDate) continue;
        const ids = extractIds(pr.title || "", prefixes);
        if (!ids.length) continue;
        prRefs.push({
          repo,
          prNumber: pr.number,
          title: pr.title,
          mergedAt: pr.mergedAt,
          ids,
        });
      }
    }

    return { ...upstream, blueprints, prRefs, failedRepos, truncatedRepos };
  },
};
