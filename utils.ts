/** Extract base domain from URL (e.g. "sub.example.com" → "example.com") */
export function baseDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    const parts = hostname.split(".");
    return parts.length > 2 ? parts.slice(-2).join(".") : hostname;
  } catch {
    return url;
  }
}

/** Escape a string for safe use as a shell argument (single-quote wrapping) */
export function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// blueprint.yaml parsing — shared between A_FETCH_BLUEPRINTS,
// A_SCAN_PR_FEATURE_IDS (which builds prefix sets from blueprint IDs) and
// future audit actions. Single source of truth for the schema lives here so
// no future action grows a 4th hand-rolled parser. (Holly cycle-2 M6, cycle-3)
// ---------------------------------------------------------------------------

export interface BlueprintFeature {
  repo: string;
  id: string;
  status: string;
  name: string;
  issue?: number;
  iteration?: number;
}

const FEATURE_BLOCK = /^\s*-\s+id:\s+([A-Za-z0-9_-]+)\s*$/;
// `[\w-]+` — captures hyphenated values like `in-progress`, `not-started`,
// `in-review`. `\w+` would truncate to "in" / "not". (Holly cycle-3 M1)
const STATUS_LINE = /^\s+status:\s+([\w-]+)/;
const NAME_LINE = /^\s+name:\s*(?:"([^"]*)"|(.+))$/;
const ISSUE_LINE = /^\s+issue:\s+(\d+)/;
const ITERATION_LINE = /^\s+iteration:\s+(\d+)/;
// `/m` flag mandatory: `repo:` is on line 2 (after `schema:`). Without `/m`
// the `^` anchor matches start-of-string only and the regex never fires —
// silent fallback to caller-provided fallbackRepo. (Holly cycle-1 M1)
const REPO_LINE = /^repo:\s+([A-Za-z0-9_-]+)/m;

/**
 * Parse a blueprint.yaml into {repo, features[]}. Schema-tolerant single-pass
 * scan — does not depend on a YAML parser (no package.json in this repo).
 *
 * The `repo:` field on line 2 is canonical; `fallbackRepo` is only used when
 * a malformed file lacks the field.
 */
export function parseBlueprint(
  yamlText: string,
  fallbackRepo: string
): { repo: string; features: BlueprintFeature[] } {
  const lines = yamlText.split("\n");
  let repo = fallbackRepo;
  const repoMatch = yamlText.match(REPO_LINE);
  if (repoMatch) repo = repoMatch[1];

  const features: BlueprintFeature[] = [];
  let current: Partial<BlueprintFeature> | null = null;
  let currentIndent = -1;

  const finalize = (p: Partial<BlueprintFeature>): BlueprintFeature => ({
    repo,
    id: p.id!,
    status: p.status || "unknown",
    name: p.name || "",
    issue: p.issue,
    iteration: p.iteration,
  });

  for (const line of lines) {
    const idMatch = line.match(FEATURE_BLOCK);
    if (idMatch) {
      if (current && current.id) features.push(finalize(current));
      current = { id: idMatch[1] };
      currentIndent = line.indexOf("- id:");
      continue;
    }
    if (!current) continue;
    const fieldIndent = currentIndent + 2;
    if (line.trim() === "" || (line.length > 0 && !line.startsWith(" ".repeat(fieldIndent)))) {
      if (line.trim() !== "" && !line.startsWith(" ".repeat(fieldIndent))) {
        if (!line.trimStart().startsWith("#")) {
          features.push(finalize(current));
          current = null;
          continue;
        }
      }
      continue;
    }

    const s = line.match(STATUS_LINE);
    if (s) current.status = s[1];
    const n = line.match(NAME_LINE);
    if (n) current.name = (n[1] || n[2] || "").trim().replace(/^"|"$/g, "");
    const i = line.match(ISSUE_LINE);
    if (i) current.issue = Number(i[1]);
    const it = line.match(ITERATION_LINE);
    if (it) current.iteration = Number(it[1]);
  }

  if (current && current.id) features.push(finalize(current));
  return { repo, features };
}

/**
 * Build the set of letter-prefix families used by features in `ids`. Used
 * by A_SCAN_PR_FEATURE_IDS to decide which IDs in a PR title belong to the
 * repo being scanned.
 *
 * `\d*` (not `\d?`) so double-digit iteration prefixes like `F12-309`
 * collapse to `F12-`, not `F1-`. (Holly cycle-1 M2)
 */
export function prefixesFromIds(ids: string[]): string[] {
  const set = new Set<string>();
  for (const id of ids) {
    const m = id.match(/^([A-Za-z]+\d*)-/);
    if (m) set.add(m[1] + "-");
  }
  return [...set].sort((a, b) => b.length - a.length);
}

/**
 * Extract canonical repo names from compass/ecosystem/repos.yaml. Anchored
 * to the top-level `repos:` mapping — sibling top-level sections (metadata,
 * defaults, roles, etc.) are ignored. Empty input or absent `repos:` → [].
 * (Holly cycle-2 W3)
 */
export function extractRepoNames(yamlText: string): string[] {
  if (!yamlText.trim()) return [];
  const lines = yamlText.split("\n");
  const result: string[] = [];
  let inReposSection = false;
  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (!inReposSection) {
      if (/^repos:\s*$/.test(line)) inReposSection = true;
      continue;
    }
    if (indent === 0) break;
    if (indent !== 2) continue;
    const keyMatch = line.match(/^  ([A-Za-z0-9][A-Za-z0-9_-]*):\s*$/);
    if (keyMatch) result.push(keyMatch[1]);
  }
  return result;
}

/**
 * Extract feature IDs from a PR title. Matches by LETTER-FAMILY of registered
 * prefixes (so PR `F5-501` is extracted even when registered set is `["F-"]`,
 * letting A_DETECT_DRIFT fuzzy-normalize against blueprint). Stays repo-scoped
 * — no global catch-all that would flood with SHA-256 / SOP-* / INC-* /
 * FR-* / HL-* / CP-* / T-* false positives. (Holly cycle-1 M4)
 *
 * Case-insensitive; output normalized to uppercase to match canonical IDs.
 */
export function extractFeatureIdsFromTitle(title: string, prefixes: string[]): string[] {
  if (!prefixes.length) return [];
  const families = new Set<string>();
  for (const p of prefixes) {
    const m = p.match(/^([A-Za-z]+)\d*-/);
    if (m) families.add(m[1]);
  }
  if (!families.size) return [];
  const famAlt = [...families].sort((a, b) => b.length - a.length).join("|");
  const re = new RegExp(`\\b(?:${famAlt})\\d*-\\d+\\b`, "gi");
  const hits = new Set<string>();
  for (const m of title.match(re) || []) hits.add(m.toUpperCase());
  return [...hits];
}
