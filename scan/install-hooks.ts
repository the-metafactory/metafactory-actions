#!/usr/bin/env bun
/**
 * install-hooks — install/verify the metafactory confidentiality git hooks
 * (design doc §4 L5).
 *
 * The metafactory pattern is a GLOBAL `core.hooksPath` shim that chains to any
 * repo-local hook. The killer problem it must handle (G17): ~20 local repos set
 * a repo-local `core.hooksPath`, which SILENTLY SHADOWS a global hook exactly
 * where it matters. So:
 *   - `install` sets the global hooksPath + bakes the engine path into the hooks.
 *   - `install` DETECTS repo-local core.hooksPath overrides across dev-root
 *     repos and, with --unset, removes them.
 *   - `doctor` FAILS LOUDLY (non-zero exit) on a broken chain: unset/missing
 *     global hooksPath, non-executable hooks, unreachable engine, or ANY
 *     repo-local core.hooksPath override that would shadow the global hook.
 *
 * Subcommands:
 *   install   [--global | --repo <path>] [--engine <path>] [--hooks-dir <path>]
 *             [--dev-root <path>] [--unset]
 *   doctor    [--repo <path>] [--dev-root <path>]
 *   uninstall [--global | --repo <path>]
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const HERE = import.meta.dir;
const HOOK_NAMES = ["pre-commit", "pre-push"] as const;
const DEFAULT_HOOKS_DIR = join(homedir(), ".config", "metafactory", "git-hooks");
const DEFAULT_DEV_ROOT = process.env.PULSE_DEV_ROOT || join(homedir(), "Developer");

interface Args {
  cmd: string;
  global: boolean;
  repo: string | null;
  engine: string | null;
  hooksDir: string;
  devRoot: string;
  unset: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    cmd: argv.find((x) => !x.startsWith("-")) || "help",
    global: !argv.includes("--repo"),
    repo: null,
    engine: null,
    hooksDir: DEFAULT_HOOKS_DIR,
    devRoot: DEFAULT_DEV_ROOT,
    unset: argv.includes("--unset"),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--repo") a.repo = argv[++i] ?? null;
    else if (argv[i] === "--engine") a.engine = argv[++i] ?? null;
    else if (argv[i] === "--hooks-dir") a.hooksDir = argv[++i] ?? a.hooksDir;
    else if (argv[i] === "--dev-root") a.devRoot = argv[++i] ?? a.devRoot;
    else if (argv[i] === "--global") a.global = true;
  }
  if (a.repo) a.global = false;
  return a;
}

function sh(cmd: string[], cwd?: string): { stdout: string; code: number } {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { stdout: p.stdout ? new TextDecoder().decode(p.stdout).trim() : "", code: p.exitCode ?? 1 };
}

function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/** Read a repo's LOCAL core.hooksPath override (the G17 shadowing vector), or null. */
export function localHooksPathOverride(repo: string): string | null {
  const r = sh(["git", "config", "--local", "--get", "core.hooksPath"], repo);
  return r.code === 0 && r.stdout ? r.stdout : null;
}

/** Enumerate immediate git repos under dev-root that set a local core.hooksPath. */
export function findShadowingRepos(devRoot: string): Array<{ repo: string; hooksPath: string }> {
  const out: Array<{ repo: string; hooksPath: string }> = [];
  if (!existsSync(devRoot)) return out;
  for (const name of readdirSync(devRoot)) {
    const dir = join(devRoot, name);
    try {
      if (!statSync(dir).isDirectory() || !isGitRepo(dir)) continue;
    } catch {
      continue; // unreadable entry — skip (enumeration must not throw)
    }
    const override = localHooksPathOverride(dir);
    if (override) out.push({ repo: dir, hooksPath: override });
  }
  return out;
}

function resolveEngine(explicit: string | null): string {
  if (explicit) return resolve(explicit);
  // Default: the engine sibling to this installer.
  return resolve(join(HERE, "confidentiality-scan.ts"));
}

function writeHook(destDir: string, name: string, enginePath: string): void {
  const src = readFileSync(join(HERE, "hooks", name), "utf8");
  const baked = src.replace("__ENGINE_PATH__", enginePath);
  const dest = join(destDir, name);
  writeFileSync(dest, baked, { mode: 0o755 });
  chmodSync(dest, 0o755);
}

function installGlobal(args: Args): number {
  const engine = resolveEngine(args.engine);
  if (!existsSync(engine)) {
    process.stderr.write(`install: engine not found at ${engine} (pass --engine)\n`);
    return 3;
  }
  mkdirSync(args.hooksDir, { recursive: true });
  for (const h of HOOK_NAMES) writeHook(args.hooksDir, h, engine);
  const set = sh(["git", "config", "--global", "core.hooksPath", args.hooksDir]);
  if (set.code !== 0) {
    process.stderr.write("install: failed to set global core.hooksPath\n");
    return 3;
  }
  process.stdout.write(`✓ installed global hooks → ${args.hooksDir}\n`);
  process.stdout.write(`  engine: ${engine}\n`);

  // Detect + optionally unset repo-local shadowing overrides (G17).
  const shadowing = findShadowingRepos(args.devRoot);
  const foreign = shadowing.filter((s) => resolve(s.hooksPath) !== resolve(args.hooksDir));
  if (foreign.length) {
    process.stdout.write(`\n⚠ ${foreign.length} repo(s) set a LOCAL core.hooksPath that shadows the global hook (G17):\n`);
    for (const s of foreign) process.stdout.write(`  · ${s.repo} → ${s.hooksPath}\n`);
    if (args.unset) {
      for (const s of foreign) {
        const r = sh(["git", "config", "--local", "--unset", "core.hooksPath"], s.repo);
        process.stdout.write(`  ${r.code === 0 ? "✓ unset" : "✗ failed to unset"}: ${s.repo}\n`);
      }
    } else {
      process.stdout.write("  Re-run with --unset to remove these overrides (or unset manually).\n");
    }
  }
  return 0;
}

function installRepo(args: Args): number {
  const repo = resolve(args.repo!);
  if (!isGitRepo(repo)) {
    process.stderr.write(`install --repo: ${repo} is not a git repo\n`);
    return 3;
  }
  const engine = resolveEngine(args.engine);
  const destDir = join(repo, ".git", "hooks");
  mkdirSync(destDir, { recursive: true });
  for (const h of HOOK_NAMES) writeHook(destDir, h, engine);
  process.stdout.write(`✓ installed repo hooks → ${destDir}\n  engine: ${engine}\n`);
  const override = localHooksPathOverride(repo);
  if (override) {
    process.stdout.write(`⚠ this repo has local core.hooksPath=${override}; .git/hooks may be shadowed. Re-run with --unset.\n`);
    if (args.unset) sh(["git", "config", "--local", "--unset", "core.hooksPath"], repo);
  }
  return 0;
}

/** doctor: verify the hook chain; return non-zero on ANY breakage (fail loud). */
function doctor(args: Args): number {
  const problems: string[] = [];
  const notes: string[] = [];

  const globalHooksPath = sh(["git", "config", "--global", "--get", "core.hooksPath"]).stdout || null;
  if (!globalHooksPath) {
    problems.push("global core.hooksPath is NOT set (run `install`)");
  } else {
    notes.push(`global core.hooksPath = ${globalHooksPath}`);
    for (const h of HOOK_NAMES) {
      const hp = join(globalHooksPath, h);
      if (!existsSync(hp)) problems.push(`missing hook: ${hp}`);
      else {
        try {
          const mode = statSync(hp).mode & 0o111;
          if (!mode) problems.push(`hook not executable: ${hp}`);
        } catch {
          problems.push(`cannot stat hook: ${hp}`);
        }
        // Engine reachability: the baked path must exist (or a fallback).
        const baked = readFileSync(hp, "utf8").match(/MF_SCAN_ENGINE_DEFAULT="([^"]*)"/);
        const engine = baked?.[1] || "";
        if (engine && engine !== "__ENGINE_PATH__" && !existsSync(engine)) {
          problems.push(`hook ${h} points at a missing engine: ${engine}`);
        } else if (engine) {
          notes.push(`hook ${h} engine = ${engine}`);
        }
      }
    }
  }

  // Shadowing repos anywhere under dev-root (or the specific --repo) FAIL doctor.
  const repos = args.repo ? [resolve(args.repo)] : undefined;
  const shadowing = repos
    ? repos.map((r) => ({ repo: r, hooksPath: localHooksPathOverride(r) })).filter((s): s is { repo: string; hooksPath: string } => !!s.hooksPath)
    : findShadowingRepos(args.devRoot);
  const foreign = shadowing.filter((s) => !globalHooksPath || resolve(s.hooksPath) !== resolve(globalHooksPath));
  for (const s of foreign) problems.push(`repo-local core.hooksPath shadows the global hook: ${s.repo} → ${s.hooksPath}`);

  for (const n of notes) process.stdout.write(`  · ${n}\n`);
  if (problems.length) {
    process.stderr.write(`\n✗ doctor: ${problems.length} problem(s):\n`);
    for (const p of problems) process.stderr.write(`  ✗ ${p}\n`);
    return 1;
  }
  process.stdout.write("\n✓ doctor: hook chain is healthy\n");
  return 0;
}

function uninstall(args: Args): number {
  if (args.global) {
    const gp = sh(["git", "config", "--global", "--get", "core.hooksPath"]).stdout;
    if (gp) {
      for (const h of HOOK_NAMES) {
        const hp = join(gp, h);
        if (existsSync(hp)) rmSync(hp);
      }
    }
    sh(["git", "config", "--global", "--unset", "core.hooksPath"]);
    process.stdout.write("✓ uninstalled global hooks + unset global core.hooksPath\n");
    return 0;
  }
  const repo = resolve(args.repo!);
  for (const h of HOOK_NAMES) {
    const hp = join(repo, ".git", "hooks", h);
    if (existsSync(hp)) rmSync(hp);
  }
  process.stdout.write(`✓ removed repo hooks from ${join(repo, ".git", "hooks")}\n`);
  return 0;
}

function help(): number {
  process.stdout.write(
    [
      "install-hooks — metafactory confidentiality git hooks",
      "",
      "  bun scan/install-hooks.ts install [--global|--repo <path>] [--engine <path>] [--hooks-dir <path>] [--dev-root <path>] [--unset]",
      "  bun scan/install-hooks.ts doctor  [--repo <path>] [--dev-root <path>]",
      "  bun scan/install-hooks.ts uninstall [--global|--repo <path>]",
      "",
      "install  sets a GLOBAL core.hooksPath, bakes the engine path into the hooks,",
      "         and reports (—unset removes) repo-local core.hooksPath overrides (G17).",
      "doctor   FAILS (non-zero) on a broken chain: unset/missing hooksPath, non-exec",
      "         hooks, missing engine, or any shadowing repo-local core.hooksPath.",
      "",
    ].join("\n")
  );
  return 0;
}

export function run(argv: string[]): number {
  const args = parseArgs(argv);
  switch (args.cmd) {
    case "install":
      return args.global ? installGlobal(args) : installRepo(args);
    case "doctor":
      return doctor(args);
    case "uninstall":
      return uninstall(args);
    default:
      return help();
  }
}

if (import.meta.main) {
  process.exit(run(process.argv.slice(2)));
}
