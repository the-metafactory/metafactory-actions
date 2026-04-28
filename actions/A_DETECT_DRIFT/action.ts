import type { ActionContext } from "../../types";

interface Feature {
  repo: string;
  id: string;
  status: string;
  name: string;
  issue?: number;
  iteration?: number;
}

interface BlueprintIndex {
  features: Feature[];
  prefixesByRepo: Record<string, string[]>;
}

interface PRRef {
  repo: string;
  prNumber: number;
  title: string;
  mergedAt: string;
  ids: string[];
}

interface MissingEntry {
  repo: string;
  id: string;
  prs: Array<{ number: number; title: string; mergedAt: string }>;
}

interface StaleEntry {
  repo: string;
  id: string;
  currentStatus: string;
  name: string;
  prs: Array<{ number: number; title: string; mergedAt: string }>;
}

interface Drift {
  missing: MissingEntry[];
  staleStatus: StaleEntry[];
  failedRepos: Array<{ repo: string; reason: string }>;
  truncatedRepos: Array<{ repo: string; limit: number }>;
  stats: {
    repos: number;
    blueprintFeatures: number;
    prsScanned: number;
    missingCount: number;
    staleCount: number;
    failedRepoCount: number;
    truncatedRepoCount: number;
  };
}

interface Input {
  blueprints: BlueprintIndex;
  prRefs: PRRef[];
  failedRepos?: Array<{ repo: string; reason: string }>;
  truncatedRepos?: Array<{ repo: string; limit: number }>;
  outputPath?: string;
  /** Prefixes to exclude from MISSING/STALE classification — useful for design-decision IDs (e.g. "DD-") that are tracked outside blueprint.yaml */
  excludePrefixes?: string[];
  [key: string]: unknown;
}

/** Build fuzzy-equivalence keys: "F-501" ↔ "F5-501" both reduce to "F-501" */
function normalizeId(id: string): string {
  // Strip the optional digit between the letter prefix and the first dash
  return id.replace(/^([A-Za-z]+)\d-/, "$1-");
}

function fmtMarkdown(drift: Drift): string {
  const out: string[] = [];
  out.push(`# Blueprint Drift Report`);
  out.push("");
  out.push(`Generated: ${new Date().toISOString()}`);
  out.push("");

  // Scan-incomplete header BEFORE the stats — operator must see immediately
  // that the report is a lower bound when any repo failed or was truncated.
  // (Holly cycle-2 #1+#2)
  if (drift.failedRepos.length || drift.truncatedRepos.length) {
    out.push(`> ⚠️ **Scan incomplete — drift counts below are a lower bound.**`);
    if (drift.failedRepos.length) {
      const list = drift.failedRepos
        .map((f) => `${f.repo} (${f.reason})`)
        .join("; ");
      out.push(`>`);
      out.push(`> Scan failed for: ${list}`);
    }
    if (drift.truncatedRepos.length) {
      const list = drift.truncatedRepos
        .map((t) => `${t.repo} (hit limit=${t.limit})`)
        .join("; ");
      out.push(`>`);
      out.push(`> PR list truncated for: ${list} — raise \`limit\` input to capture older PRs.`);
    }
    out.push("");
  }

  out.push(`## Stats`);
  out.push("");
  out.push(`- Repos scanned: ${drift.stats.repos}`);
  out.push(`- Blueprint features: ${drift.stats.blueprintFeatures}`);
  out.push(`- Merged PRs scanned: ${drift.stats.prsScanned}`);
  out.push(`- **MISSING entries: ${drift.stats.missingCount}**`);
  out.push(`- **STALE_STATUS entries: ${drift.stats.staleCount}**`);
  if (drift.stats.failedRepoCount > 0) {
    out.push(`- **Failed scans: ${drift.stats.failedRepoCount}**`);
  }
  if (drift.stats.truncatedRepoCount > 0) {
    out.push(`- **Truncated scans: ${drift.stats.truncatedRepoCount}**`);
  }
  out.push("");

  if (drift.missing.length) {
    out.push(`## MISSING — feature ID found in merged PR titles but not in blueprint.yaml`);
    out.push("");
    const byRepo: Record<string, MissingEntry[]> = {};
    for (const m of drift.missing) (byRepo[m.repo] ||= []).push(m);
    for (const repo of Object.keys(byRepo).sort()) {
      out.push(`### ${repo}`);
      out.push("");
      for (const m of byRepo[repo].sort((a, b) => a.id.localeCompare(b.id))) {
        const prList = m.prs.map((p) => `#${p.number}`).join(", ");
        const firstPR = m.prs[0];
        out.push(`- **${m.id}** — ${prList} — _${firstPR.title.slice(0, 90)}_`);
      }
      out.push("");
    }
  }

  if (drift.staleStatus.length) {
    out.push(`## STALE_STATUS — blueprint says non-done but a merged PR mentions the ID`);
    out.push("");
    const byRepo: Record<string, StaleEntry[]> = {};
    for (const s of drift.staleStatus) (byRepo[s.repo] ||= []).push(s);
    for (const repo of Object.keys(byRepo).sort()) {
      out.push(`### ${repo}`);
      out.push("");
      for (const s of byRepo[repo].sort((a, b) => a.id.localeCompare(b.id))) {
        const prList = s.prs.map((p) => `#${p.number}`).join(", ");
        out.push(`- **${s.id}** _(${s.currentStatus})_ — ${prList} — ${s.name.slice(0, 80)}`);
      }
      out.push("");
    }
  }

  if (!drift.missing.length && !drift.staleStatus.length) {
    out.push(`## ✓ No drift detected`);
    out.push("");
    out.push(`All blueprint feature IDs referenced in merged PRs match their tracked status.`);
  }

  return out.join("\n");
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const {
      blueprints,
      prRefs,
      failedRepos = [],
      truncatedRepos = [],
      outputPath,
      excludePrefixes = ["DD-"],
      ...upstream
    } = input;

    if (!blueprints) throw new Error("blueprints input required");
    if (!prRefs) throw new Error("prRefs input required");

    // Build feature index keyed by repo + id (exact AND normalized for fuzzy match)
    const featureIndex = new Map<string, Feature>();
    const featureIndexFuzzy = new Map<string, Feature>();
    for (const f of blueprints.features) {
      featureIndex.set(`${f.repo}/${f.id}`, f);
      featureIndexFuzzy.set(`${f.repo}/${normalizeId(f.id)}`, f);
    }

    // For each (repo, id) mentioned in PRs, classify
    const missingMap = new Map<string, MissingEntry>();
    const staleMap = new Map<string, StaleEntry>();

    for (const pr of prRefs) {
      for (const id of pr.ids) {
        // Skip excluded prefixes (e.g. DD-* design decisions tracked elsewhere)
        if (excludePrefixes.some((p) => id.startsWith(p))) continue;

        const key = `${pr.repo}/${id}`;
        // Try exact match first; fall back to fuzzy (digit-suffix variant)
        const feature =
          featureIndex.get(key) || featureIndexFuzzy.get(`${pr.repo}/${normalizeId(id)}`);
        const prInfo = { number: pr.prNumber, title: pr.title, mergedAt: pr.mergedAt };

        if (!feature) {
          if (!missingMap.has(key)) {
            missingMap.set(key, { repo: pr.repo, id, prs: [] });
          }
          missingMap.get(key)!.prs.push(prInfo);
        } else if (feature.status !== "done") {
          // Use the canonical id from the matched feature for the report
          const canonKey = `${pr.repo}/${feature.id}`;
          if (!staleMap.has(canonKey)) {
            staleMap.set(canonKey, {
              repo: pr.repo,
              id: feature.id,
              currentStatus: feature.status,
              name: feature.name,
              prs: [],
            });
          }
          staleMap.get(canonKey)!.prs.push(prInfo);
        }
      }
    }

    const drift: Drift = {
      missing: [...missingMap.values()],
      staleStatus: [...staleMap.values()],
      failedRepos,
      truncatedRepos,
      stats: {
        repos: Object.keys(blueprints.prefixesByRepo).length,
        blueprintFeatures: blueprints.features.length,
        prsScanned: prRefs.length,
        missingCount: missingMap.size,
        staleCount: staleMap.size,
        failedRepoCount: failedRepos.length,
        truncatedRepoCount: truncatedRepos.length,
      },
    };

    const report = fmtMarkdown(drift);

    if (outputPath) {
      const writeFile = ctx.capabilities.writeFile;
      const shell = ctx.capabilities.shell;
      if (writeFile) {
        await writeFile(outputPath, report);
      } else if (shell) {
        // Shell-only fallback: a single-quoted heredoc (<<'EOF') has a
        // literal body — no shell expansion, no escape rules. Just write
        // the report as-is. The cycle-1 attempt to apply single-quote
        // shell-string escaping (`'\\''`) was wrong: that's the syntax
        // for escaping inside single-quoted strings, NOT inside a
        // single-quoted heredoc body where it would corrupt apostrophes
        // in PR titles into `'\''`. (Holly cycle-3 #2)
        await shell(
          `cat > ${outputPath} << 'BLUEPRINT_DRIFT_EOF'\n${report}\nBLUEPRINT_DRIFT_EOF`
        );
      }
    }

    return { ...upstream, drift, report };
  },
};
