import {
  extractRepoNames,
  parseBlueprint,
  prefixesFromIds,
  type BlueprintFeature,
} from "../../utils";
import type { ActionContext } from "../../types";

interface Input {
  devRoot?: string;
  registryPath?: string;
  [key: string]: unknown;
}

interface BlueprintIndex {
  features: BlueprintFeature[];
  prefixesByRepo: Record<string, string[]>;
  reposByPath: Record<string, string>;
}

// Re-export shared utilities so the test file can pull them from one place
// rather than reaching across action boundaries. (Holly cycle-3 W2)
export { extractRepoNames, parseBlueprint, prefixesFromIds };

async function resolveDevRoot(
  shell: (cmd: string) => Promise<{ stdout: string; stderr: string; code: number }>,
  explicit: string | undefined
): Promise<string> {
  if (explicit) return explicit;
  const pwd = (await shell("pwd")).stdout.trim();
  const find = await shell(
    `cd ${pwd} && current="$PWD"; while [ "$current" != "/" ]; do if [ -f "$current/.ecosystem.yaml" ]; then echo "$current"; break; fi; current=$(dirname "$current"); done`
  );
  const root = find.stdout.trim();
  if (!root) {
    throw new Error("A_FETCH_BLUEPRINTS: could not locate .ecosystem.yaml — pass devRoot explicitly");
  }
  return root;
}

async function loadAllowlist(
  shell: (cmd: string) => Promise<{ stdout: string; stderr: string; code: number }>,
  registryPath: string
): Promise<Set<string>> {
  const reg = await shell(`cat ${registryPath} 2>/dev/null`);
  const set = new Set<string>(extractRepoNames(reg.stdout));
  if (set.size === 0) {
    throw new Error(
      `A_FETCH_BLUEPRINTS: failed to load canonical repo allowlist from ${registryPath}. ` +
        `Expected a top-level \`repos:\` mapping with one entry per ecosystem repo. ` +
        `Pass an explicit registryPath if the registry lives elsewhere.`
    );
  }
  return set;
}

export default {
  async execute(input: Input, ctx: ActionContext) {
    const { devRoot, registryPath, ...upstream } = input;
    const shell = ctx.capabilities.shell;
    if (!shell) throw new Error("Shell capability required");

    const root = await resolveDevRoot(shell, devRoot);
    const regPath = registryPath || `${root}/compass/ecosystem/repos.yaml`;
    const allowlist = await loadAllowlist(shell, regPath);

    // Find blueprint.yaml files at depth 2 (devRoot/<repo>/blueprint.yaml)
    const findResult = await shell(
      `find ${root} -mindepth 2 -maxdepth 2 -name blueprint.yaml -type f 2>/dev/null | sort`
    );
    const paths = findResult.stdout.split("\n").filter(Boolean);

    const features: BlueprintFeature[] = [];
    const prefixesByRepo: Record<string, string[]> = {};
    const reposByPath: Record<string, string> = {};
    const seenRepoNames = new Set<string>();

    for (const path of paths) {
      const dir = path.replace("/blueprint.yaml", "");
      const repoName = dir.replace(`${root}/`, "");

      // Restrict to canonical allowlist (filters alternate clones / forks /
      // experimental dirs at devRoot).
      if (!allowlist.has(repoName)) continue;

      // Defense-in-depth: skip linked worktrees. A linked worktree has a
      // `.git` *file* (containing `gitdir: ...`), whereas a canonical
      // checkout has a `.git` *directory*. (Holly cycle-1 M3)
      const gitTest = await shell(
        `if [ -d "${dir}/.git" ]; then echo dir; elif [ -f "${dir}/.git" ]; then echo file; else echo none; fi`
      );
      if (gitTest.stdout.trim() !== "dir") continue;

      const cat = await shell(`cat ${path}`);
      const { repo, features: feats } = parseBlueprint(cat.stdout, repoName);
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
