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
const REPO_LINE = /^repo:\s+([A-Za-z0-9_-]+)/;

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

function prefixesFromIds(ids: string[]): string[] {
  const set = new Set<string>();
  for (const id of ids) {
    // Capture prefix up to last dash before final numeric run, e.g. "F3-309" → "F3-", "S1-01" → "S1-", "DD-90" → "DD-"
    const m = id.match(/^([A-Za-z]+\d?)-/);
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
    const regPath = registryPath || `${root}/compass/ecosystem/repos.yaml`;
    const allowlist = new Set<string>();
    const reg = await shell(`test -f ${regPath} && cat ${regPath} || true`);
    if (reg.stdout) {
      // Match top-level repo keys: 2-space indent followed by name and colon
      const repoKey = /^  ([A-Za-z0-9][A-Za-z0-9_-]*):\s*$/gm;
      let m: RegExpExecArray | null;
      while ((m = repoKey.exec(reg.stdout)) !== null) allowlist.add(m[1]);
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

      // If a canonical allowlist was loaded, restrict to it (filters alternate clones / forks)
      if (allowlist.size > 0 && !allowlist.has(repoName)) continue;

      // Filter out worktree pointers — only include canonical repos where
      // the directory itself is the git top-level (not a linked worktree)
      const top = await shell(`git -C ${dir} rev-parse --show-toplevel 2>/dev/null`);
      const topPath = top.stdout.trim();
      if (!topPath || topPath !== dir) continue;

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
