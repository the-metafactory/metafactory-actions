import type { ActionContext } from "../../types";

interface Input {
  devRoot?: string;
  registryPath?: string;
  [key: string]: unknown;
}

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
  reposByPath: Record<string, string>;
}

const FEATURE_BLOCK = /^\s*-\s+id:\s+([A-Za-z0-9_-]+)\s*$/;
const STATUS_LINE = /^\s+status:\s+(\w+)/;
const NAME_LINE = /^\s+name:\s*(?:"([^"]*)"|(.+))$/;
const ISSUE_LINE = /^\s+issue:\s+(\d+)/;
const ITERATION_LINE = /^\s+iteration:\s+(\d+)/;
// Multi-line flag is required: `repo:` is on line 2 of every blueprint
// (line 1 is `schema: blueprint/v1`). Without `m` the `^` anchor only
// matches start-of-string and the regex never fires — falling back
// silently to the directory name. (Holly review #5)
const REPO_LINE = /^repo:\s+([A-Za-z0-9_-]+)/m;

function parseBlueprint(yamlText: string, fallbackRepo: string): { repo: string; features: Feature[] } {
  const lines = yamlText.split("\n");
  let repo = fallbackRepo;
  const repoMatch = yamlText.match(REPO_LINE);
  if (repoMatch) repo = repoMatch[1];

  const features: Feature[] = [];
  let current: Partial<Feature> | null = null;
  let currentIndent = -1;

  for (const line of lines) {
    const idMatch = line.match(FEATURE_BLOCK);
    if (idMatch) {
      if (current && current.id) features.push(finalize(current, repo));
      current = { id: idMatch[1] };
      currentIndent = line.indexOf("- id:");
      continue;
    }
    if (!current) continue;

    // End of current feature: line indented less than the field-line indent
    const fieldIndent = currentIndent + 2;
    if (line.trim() === "" || (line.length > 0 && !line.startsWith(" ".repeat(fieldIndent)))) {
      // Could still be a comment line or another sibling — only break on dedented non-empty content
      if (line.trim() !== "" && !line.startsWith(" ".repeat(fieldIndent))) {
        // Probably a comment at lower indent or new section
        if (!line.trimStart().startsWith("#")) {
          features.push(finalize(current, repo));
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

  if (current && current.id) features.push(finalize(current, repo));
  return { repo, features };
}

function finalize(p: Partial<Feature>, repo: string): Feature {
  return {
    repo,
    id: p.id!,
    status: p.status || "unknown",
    name: p.name || "",
    issue: p.issue,
    iteration: p.iteration,
  };
}

/**
 * Extract canonical repo names from compass/ecosystem/repos.yaml. Anchored
 * to the top-level `repos:` mapping — sibling top-level sections (metadata,
 * defaults, roles, etc.) are ignored. Empty input or absent `repos:` → [].
 * (Holly cycle-2 #4)
 *
 * Implementation: section-aware single-pass scan. Find the line matching
 * `^repos:$`; from there, capture top-level mapping keys at indent === 2;
 * stop on the next line whose indent is 0 (next top-level section) OR
 * any line that re-enters indent === 0 (siblings of `repos:`).
 *
 * We use a hand-rolled scan rather than a full YAML parser because (a) the
 * registry is shape-stable (repos: → 2-space-indented name keys), (b) Bun's
 * built-in `bun:yaml` doesn't resolve under `bun test` in this repo (no
 * package.json), and (c) installing a yaml dep just for this one shape
 * isn't worth it.
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
    // We're inside repos: — exit on the next top-level (indent 0) section
    if (indent === 0) break;
    // Top-level mapping keys under repos: live at indent === 2
    if (indent !== 2) continue;
    const keyMatch = line.match(/^  ([A-Za-z0-9][A-Za-z0-9_-]*):\s*$/);
    if (keyMatch) result.push(keyMatch[1]);
  }
  return result;
}

export function prefixesFromIds(ids: string[]): string[] {
  const set = new Set<string>();
  for (const id of ids) {
    // Capture prefix up to last dash before final numeric run, e.g.
    // "F3-309" → "F3-", "S1-01" → "S1-", "DD-90" → "DD-", "F12-309" → "F12-".
    // `\d*` (not `\d?`) — single-char digit count would collapse double-digit
    // iteration prefixes (F12-... → F1-) and miscategorize. (Holly review #5)
    const m = id.match(/^([A-Za-z]+\d*)-/);
    if (m) set.add(m[1] + "-");
  }
  return [...set].sort((a, b) => b.length - a.length);
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { devRoot, registryPath, ...upstream } = input;
    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("Shell capability required");

    // Resolve devRoot: explicit input, or walk up from PWD to find .ecosystem.yaml
    let root = devRoot;
    if (!root) {
      const pwd = (await shell("pwd")).stdout.trim();
      const find = await shell(
        `cd ${pwd} && current="$PWD"; while [ "$current" != "/" ]; do if [ -f "$current/.ecosystem.yaml" ]; then echo "$current"; break; fi; current=$(dirname "$current"); done`
      );
      root = find.stdout.trim();
      if (!root) throw new Error("Could not locate .ecosystem.yaml — pass devRoot explicitly");
    }

    // Load canonical repo allowlist from compass/ecosystem/repos.yaml.
    // Filters out alternate clones / worktrees / experimental forks at devRoot.
    // Use a real YAML parser anchored to the `repos:` key — a regex would
    // pollute the allowlist with siblings of repos: (metadata, defaults,
    // roles, etc.) since they share the same indent level. (Holly cycle-2 #4)
    // Fail-closed: if the registry can't be read or yields no entries we
    // throw rather than silently treating every blueprint as canonical.
    const regPath = registryPath || `${root}/compass/ecosystem/repos.yaml`;
    const reg = await shell(`cat ${regPath} 2>/dev/null`);
    const allowlist = new Set<string>(extractRepoNames(reg.stdout));
    if (allowlist.size === 0) {
      throw new Error(
        `A_FETCH_BLUEPRINTS: failed to load canonical repo allowlist from ${regPath}. ` +
          `Expected a top-level \`repos:\` mapping with one entry per ecosystem repo. ` +
          `Pass an explicit registryPath if the registry lives elsewhere.`
      );
    }

    // Find blueprint.yaml files at depth 2 (devRoot/<repo>/blueprint.yaml)
    const findResult = await shell(
      `find ${root} -mindepth 2 -maxdepth 2 -name blueprint.yaml -type f 2>/dev/null | sort`
    );
    const paths = findResult.stdout.split("\n").filter(Boolean);

    const features: Feature[] = [];
    const prefixesByRepo: Record<string, string[]> = {};
    const reposByPath: Record<string, string> = {};
    const seenRepoNames = new Set<string>();

    for (const path of paths) {
      const dir = path.replace("/blueprint.yaml", "");
      const repoName = dir.replace(`${root}/`, "");

      // Restrict to canonical allowlist (filters alternate clones / forks /
      // experimental dirs at devRoot). Allowlist guaranteed non-empty above.
      if (!allowlist.has(repoName)) continue;

      // Defense-in-depth: skip linked worktrees. A linked worktree has a
      // `.git` *file* (containing `gitdir: ...`), whereas a canonical
      // checkout has a `.git` *directory*. `rev-parse --show-toplevel`
      // can't distinguish the two — inside a linked worktree it returns
      // the linked dir itself. (Holly review #5)
      const gitTest = await shell(
        `if [ -d "${dir}/.git" ]; then echo dir; elif [ -f "${dir}/.git" ]; then echo file; else echo none; fi`
      );
      if (gitTest.stdout.trim() !== "dir") continue;

      const cat = await shell(`cat ${path}`);
      const { repo, features: feats } = parseBlueprint(cat.stdout, repoName);
      // Skip duplicate repo names (defensive — schema's `repo:` field is canonical)
      if (seenRepoNames.has(repo)) continue;
      seenRepoNames.add(repo);

      reposByPath[repo] = path;
      features.push(...feats);
      prefixesByRepo[repo] = prefixesFromIds(feats.map((f) => f.id));
    }

    const blueprints: BlueprintIndex = { features, prefixesByRepo, reposByPath };
    return { ...upstream, blueprints };
  },
};
