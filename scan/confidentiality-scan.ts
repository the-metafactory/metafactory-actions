#!/usr/bin/env bun
/**
 * confidentiality-scan — the shared scan engine CLI (design doc §3/§4 L1).
 *
 * Modes:
 *   diff     changed lines of a PR / staged commit (default consumer: git hooks + CI PRs)
 *   tree     the whole working tree (default consumer: push events, ad-hoc audits)
 *   history  every reachable blob (default consumer: scheduled weekly history scan)
 *
 * Tiers (each mode runs all available tiers):
 *   1  gitleaks  — pinned binary shelled out when present; best-effort, masked
 *   2  shapes    — public-patterns.yaml (this repo, public-safe)
 *   3  denylist  — salted-SHA-256 hashed denylist supplied at RUNTIME (never committed)
 *
 * Output discipline: findings are MASKED (no matched literal, no hash, no digest).
 * Under GitHub Actions the raw matches are registered with `::add-mask::` BEFORE
 * any finding line is printed, so even accidental echoes downstream are redacted.
 *
 * Exit codes: 0 clean · 1 one-or-more BLOCK findings (or a warn with --fail-on-warn)
 * · 3 engine/config error (fail-closed).
 */

import { join } from "node:path";
import { readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  checkNewBinary,
  dedupe,
  parsePatternsYaml,
  parseUnifiedDiff,
  redactPath,
  renderFinding,
  scanContentForDenylist,
  scanContentForShapes,
  scanLineForShapes,
  pathMatchesAny,
  type Finding,
  type FindingAction,
  type HashedDenylist,
  type ScanChunkResult,
  type ShapePattern,
} from "./engine.ts";

const HERE = import.meta.dir;
const MAX_FILE_BYTES = 1_000_000; // 1MB — skip larger blobs (perf cap; noted in output)
const MAX_HISTORY_BLOBS = 20_000; // hard cap so a 91-tag history can't hang the scan

/** Sensitive paths whose FULL changed content is scanned in diff mode (design doc §4 L1). */
const SENSITIVE_CONTENT_PATHS = [
  "**/agents.d/**",
  "agents.d/**",
  "**/personas/**",
  "personas/**",
  "**/arc-manifest*.yaml",
  "arc-manifest*.yaml",
  "**/migrations/**",
  "**/seeds/**",
];

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export type Mode = "diff" | "tree" | "history";

export interface Options {
  mode: Mode;
  staged: boolean;
  range: string | null;
  denylistPath: string | null;
  patternsPath: string;
  extraText: string[];
  useGitleaks: boolean;
  /**
   * Pinned gitleaks config passed as `--config`. Defaults to the bundled
   * scan/gitleaks.toml, which makes gitleaks IGNORE any `.gitleaks.toml`
   * committed in the scanned target — so an attacker can't disable tier-1 by
   * committing a catch-all `[allowlist]` (review #9 CONFIRMED-2). Override with
   * --gitleaks-config.
   */
  gitleaksConfig: string;
  failOnWarn: boolean;
  json: boolean;
  cwd: string;
  /** Optional 2nd denylist secret; must match whatever built the denylist. From env CONF_DENYLIST_PEPPER. */
  pepper: string;
  /**
   * Enforce tier 3: when set, an absent/empty denylist FAILS CLOSED (exit 3)
   * instead of degrading silently. Set on the TRUSTED (non-fork) CI path so a
   * mis-wired org secret can't ship green with tier 3 off (review #9 fix 8).
   * Also settable via env MF_REQUIRE_DENYLIST=1 for hook/CI wiring.
   */
  requireDenylist: boolean;
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = {
    mode: "diff",
    staged: false,
    range: null,
    denylistPath: null,
    patternsPath: join(HERE, "public-patterns.yaml"),
    extraText: [],
    useGitleaks: true,
    gitleaksConfig: join(HERE, "gitleaks.toml"),
    failOnWarn: false,
    json: false,
    cwd: process.cwd(),
    pepper: process.env.CONF_DENYLIST_PEPPER || "",
    requireDenylist: process.env.MF_REQUIRE_DENYLIST === "1",
  };
  const positional = argv.filter((a) => !a.startsWith("-"));
  if (positional[0] && ["diff", "tree", "history"].includes(positional[0])) {
    opts.mode = positional[0] as Mode;
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--staged") opts.staged = true;
    else if (a === "--range") opts.range = argv[++i] ?? null;
    else if (a === "--denylist") opts.denylistPath = argv[++i] ?? null;
    else if (a === "--patterns") opts.patternsPath = argv[++i] ?? opts.patternsPath;
    else if (a === "--extra-text") opts.extraText.push(argv[++i] ?? "");
    else if (a === "--no-gitleaks") opts.useGitleaks = false;
    else if (a === "--fail-on-warn") opts.failOnWarn = true;
    else if (a === "--require-denylist") opts.requireDenylist = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--cwd" || a === "--target") opts.cwd = argv[++i] ?? opts.cwd;
    else if (a === "--gitleaks-config") opts.gitleaksConfig = argv[++i] ?? opts.gitleaksConfig;
  }
  return opts;
}

// ---------------------------------------------------------------------------
// Shell helper (git + gitleaks)
// ---------------------------------------------------------------------------

interface Sh {
  stdout: string;
  stderr: string;
  code: number;
}

function sh(cmd: string[], cwd: string, stdin?: string): Sh {
  const proc = Bun.spawnSync(cmd, {
    cwd,
    stdin: stdin ? new TextEncoder().encode(stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: proc.stdout ? new TextDecoder().decode(proc.stdout) : "",
    stderr: proc.stderr ? new TextDecoder().decode(proc.stderr) : "",
    code: proc.exitCode ?? 1,
  };
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

export async function loadPatterns(path: string): Promise<ShapePattern[]> {
  const f = Bun.file(path);
  if (!(await f.exists())) throw new Error(`patterns file not found: ${path}`);
  return parsePatternsYaml(await f.text());
}

/**
 * Load the hashed denylist. Precedence: --denylist path > MF_CONFIDENTIALITY_DENYLIST
 * env (org secret payload) > bundled placeholder (empty ⇒ tier 3 inert). Returns
 * null only when nothing is available. Fail-closed on malformed JSON.
 */
export async function loadDenylist(opts: Options): Promise<{ denylist: HashedDenylist; source: string }> {
  const parse = (raw: string, source: string): { denylist: HashedDenylist; source: string } => {
    let obj: unknown;
    try {
      obj = JSON.parse(raw);
    } catch {
      throw new Error(`denylist (${source}) is not valid JSON — refusing to run tier 3 (fail-closed)`);
    }
    const d = obj as Partial<HashedDenylist>;
    return {
      denylist: { version: d.version, salt: typeof d.salt === "string" ? d.salt : "", entries: Array.isArray(d.entries) ? d.entries : [] },
      source,
    };
  };
  if (opts.denylistPath) {
    const f = Bun.file(opts.denylistPath);
    if (!(await f.exists())) throw new Error(`--denylist path not found: ${opts.denylistPath}`);
    return parse(await f.text(), `file:${opts.denylistPath}`);
  }
  const env = process.env.MF_CONFIDENTIALITY_DENYLIST;
  if (env && env.trim()) return parse(env, "env:MF_CONFIDENTIALITY_DENYLIST");
  const bundled = Bun.file(join(HERE, "denylist.hashed.json"));
  if (await bundled.exists()) return parse(await bundled.text(), "bundled-placeholder");
  return { denylist: { salt: "", entries: [] }, source: "none" };
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

/** Read a file as text; returns null when absent, oversized, or binary (null-byte sniff). */
async function readTextFile(path: string): Promise<string | null> {
  const f = Bun.file(path);
  if (!(await f.exists())) return null;
  if (f.size > MAX_FILE_BYTES) return null;
  const buf = new Uint8Array(await f.arrayBuffer());
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return null; // binary
  return new TextDecoder().decode(buf);
}

/** True when the on-disk file exceeds the content-scan size cap. */
async function isOversizeText(path: string): Promise<boolean> {
  const f = Bun.file(path);
  return (await f.exists()) && f.size > MAX_FILE_BYTES;
}

/**
 * A file too large to content-scan must NOT be skipped silently (review #9 fix
 * 5): emit a VISIBLE, non-clean finding. `block` under a sensitive path (an
 * unscanned large seed/persona/agents.d file is a real leak vector), else `warn`.
 * The path is rendered redacted downstream; no notice carries the raw path.
 */
function oversizeFinding(file: string, sensitivePaths: string[]): Finding {
  const action: FindingAction = pathMatchesAny(file, sensitivePaths) ? "block" : "warn";
  return {
    tier: 2,
    ruleId: "oversize-unscanned",
    class: "oversize-unscanned-file",
    action,
    file,
    line: 0,
    descriptor: `file exceeds the ${MAX_FILE_BYTES}-byte scan cap — NOT content-scanned (review manually)`,
  };
}

function scanText(content: string, file: string, patterns: ShapePattern[], denylist: HashedDenylist, pepper: string): ScanChunkResult {
  const shapes = scanContentForShapes(content, file, patterns);
  const deny = scanContentForDenylist(content, file, denylist, pepper);
  return dedupe({ findings: [...shapes.findings, ...deny.findings], masks: [...shapes.masks, ...deny.masks] });
}

// ---------------------------------------------------------------------------
// Tier 1 — gitleaks (best-effort, masked)
// ---------------------------------------------------------------------------

interface GitleaksResult {
  ran: boolean;
  findings: Finding[];
  masks: string[];
  note: string;
}

/** Monotonic suffix so concurrent/repeat gitleaks report temp files never collide. */
let gitleaksReportSeq = 0;

/**
 * Build the gitleaks argv for a mode. ALWAYS injects `--config opts.gitleaksConfig`
 * (the bundled scan/gitleaks.toml by default) so the scanned target repo's own
 * `.gitleaks.toml` — e.g. a catch-all `[allowlist]` — cannot disable tier-1
 * (review #9 CONFIRMED-2). The config path is absolute; gitleaks runs with
 * cwd=opts.cwd (the target), so a relative config would wrongly resolve there.
 * Exported for deterministic testing (no gitleaks binary needed).
 *
 * DIFF MODE (re-review F1): `gitleaks protect` scans only UNCOMMITTED changes. On
 * the two primary diff paths — CI `pull_request` and the pre-push hook — the
 * content is already COMMITTED, so `protect` would scan nothing and tier-1 would
 * be silently inert (a committed secret passes the PR gate, caught only after
 * merge). So when a committed range is given (`opts.range` set, not `--staged`)
 * scan those commits with `gitleaks git --log-opts=<range>`. `--staged`
 * (pre-commit, genuinely uncommitted) keeps `protect --staged`; a bare working-
 * tree diff (no range, no staged) keeps `protect`. tree/history are unchanged.
 */
export function buildGitleaksArgs(opts: Options, bin: string, reportPath = "/dev/stdout"): string[] {
  const cfg = ["--config", opts.gitleaksConfig];
  const tail = ["--report-format", "json", "--report-path", reportPath, "--no-banner"];
  if (opts.mode === "history") return [bin, "git", ...cfg, ...tail];
  if (opts.mode === "tree") return [bin, "dir", ".", ...cfg, ...tail];
  // diff mode:
  if (opts.range && !opts.staged) {
    // Committed range (CI PR / pre-push): scan the commits in the range so a
    // committed secret is actually detected. `--log-opts` is passed verbatim to
    // `git log`; the range has no spaces so it is a single git rev-range arg.
    return [bin, "git", `--log-opts=${opts.range}`, ...cfg, ...tail];
  }
  // Staged (pre-commit) or bare working-tree diff: protect scans uncommitted content.
  return [bin, "protect", opts.staged ? "--staged" : "--no-banner", ...cfg, ...tail];
}

function runGitleaks(opts: Options): GitleaksResult {
  const bin = process.env.MF_GITLEAKS_BIN || "gitleaks";
  const which = sh([process.platform === "win32" ? "where" : "which", bin], opts.cwd);
  if (which.code !== 0) {
    return { ran: false, findings: [], masks: [], note: `tier1 gitleaks: SKIPPED (binary '${bin}' not found on PATH)` };
  }
  // Capture gitleaks' JSON report from a temp FILE, then read it back — NOT
  // `/dev/stdout`. gitleaks opens --report-path for write with O_CREATE|O_TRUNC;
  // on macOS that FTLs ("Report path is not writable: /dev/stdout — permission
  // denied") and the scan yields an empty report, so tier-1 would silently run
  // BLIND on every local hook invocation. A private temp file is portable across
  // macOS + Linux. Non-zero gitleaks exit = leaks found (expected), not an error.
  const reportPath = join(tmpdir(), `mf-gitleaks-${process.pid}-${gitleaksReportSeq++}.json`);
  const res = sh(buildGitleaksArgs(opts, bin, reportPath), opts.cwd);
  const findings: Finding[] = [];
  const masks: string[] = [];
  let raw = "";
  try {
    raw = readFileSync(reportPath, "utf8");
  } catch {
    // No report file — gitleaks errored before writing one (e.g. a bad range, or a
    // config error). Best-effort tier-1: report it ran-without-output and let the
    // fail-closed tiers 2/3 (which parse git themselves) gate the run.
    return { ran: true, findings, masks, note: `tier1 gitleaks: ran but produced no report (exit ${res.code}) — see stderr` };
  } finally {
    try { unlinkSync(reportPath); } catch { /* temp report may be absent; nothing to clean up */ }
  }
  const jsonStart = raw.indexOf("[");
  if (jsonStart >= 0) {
    try {
      const arr = JSON.parse(raw.slice(jsonStart)) as Array<Record<string, unknown>>;
      for (const g of arr) {
        findings.push({
          tier: 1,
          ruleId: `gitleaks:${String(g.RuleID ?? "rule")}`,
          class: "secret",
          action: "block",
          file: String(g.File ?? ""),
          line: Number(g.StartLine ?? 0) || 0,
          descriptor: "secret detected by gitleaks",
        });
        if (typeof g.Secret === "string") masks.push(g.Secret);
        if (typeof g.Match === "string") masks.push(g.Match);
      }
    } catch {
      return { ran: true, findings, masks, note: "tier1 gitleaks: ran but report was unparseable" };
    }
  }
  return { ran: true, findings, masks, note: `tier1 gitleaks: ran (${findings.length} finding(s))` };
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

export interface ScanReport {
  findings: Finding[];
  masks: string[];
  notices: string[];
  denylistSource: string;
  tiersRun: number[];
}

async function scanDiff(opts: Options, patterns: ShapePattern[], denylist: HashedDenylist): Promise<{ findings: Finding[]; masks: string[]; notices: string[] }> {
  const notices: string[] = [];
  const diffArgs = ["git", "diff", "--unified=0", "-M"];
  if (opts.staged) diffArgs.splice(2, 0, "--cached");
  if (opts.range) diffArgs.push(opts.range);
  const diff = sh(diffArgs, opts.cwd);
  // FAIL CLOSED (review #9 fix 1): `git diff` (no --exit-code) returns non-zero
  // ONLY on error — never merely "there were changes". A non-zero here means the
  // range/repo is unusable (the common one: a shallow CI checkout where the base
  // ref `origin/main` was never fetched, so `origin/main...HEAD` errors). Treating
  // that as "empty diff ⇒ no findings" is a silent green gate that scanned NOTHING.
  // Throw so main() exits 3 instead of reporting clean.
  if (diff.code !== 0) {
    throw new Error(`git diff failed (${diffArgs.join(" ")}): ${diff.stderr.trim().split("\n")[0] || `exit ${diff.code}`} — failing closed`);
  }
  const parsed = parseUnifiedDiff(diff.stdout);

  const findings: Finding[] = [];
  const masks: string[] = [];
  let oversize = 0;

  // (a) added lines
  for (const add of parsed.added) {
    const chunk = scanLineForShapes(add.text, add.line, add.file, patterns);
    findings.push(...chunk.findings);
    masks.push(...chunk.masks);
    const deny = scanContentForDenylist(add.text, add.file, denylist, opts.pepper);
    for (let i = 0; i < deny.findings.length; i++) {
      findings.push({ ...deny.findings[i], line: add.line });
      masks.push(deny.masks[i]);
    }
  }

  // (b) full content of changed sensitive-path files
  for (const file of parsed.changedFiles) {
    if (!pathMatchesAny(file, SENSITIVE_CONTENT_PATHS)) continue;
    // The staged read uses `git show` (no size cap — always fully scanned). The
    // working-tree read is size-capped: never skip a too-large sensitive file
    // silently (review #9 fix 5) — surface it as a BLOCK finding.
    if (!opts.staged && (await isOversizeText(join(opts.cwd, file)))) {
      findings.push(oversizeFinding(file, SENSITIVE_CONTENT_PATHS));
      oversize++;
      continue;
    }
    const content = opts.staged ? sh(["git", "show", `:${file}`], opts.cwd).stdout : await readTextFile(join(opts.cwd, file));
    if (!content) continue;
    const chunk = scanText(content, file, patterns, denylist, opts.pepper);
    findings.push(...chunk.findings);
    masks.push(...chunk.masks);
  }

  // (c) new binaries under sensitive paths
  for (const bf of parsed.binaryFiles) {
    const f = checkNewBinary(bf, "block");
    if (f) findings.push(f);
  }

  // (d) extra text: PR title/body/branch + PR-range commit messages
  const extra = [...opts.extraText];
  if (opts.range) {
    const log = sh(["git", "log", `${opts.range}`, "--format=%B"], opts.cwd);
    if (log.code === 0 && log.stdout.trim()) extra.push(log.stdout);
  }
  for (const text of extra) {
    if (!text) continue;
    const chunk = scanText(text, "<pr-metadata>", patterns, denylist, opts.pepper);
    findings.push(...chunk.findings);
    masks.push(...chunk.masks);
  }

  if (oversize) notices.push(`${oversize} changed file(s) exceeded the ${MAX_FILE_BYTES}-byte scan cap — reported as findings, NOT content-scanned`);
  return { findings, masks, notices };
}

async function scanTree(opts: Options, patterns: ShapePattern[], denylist: HashedDenylist): Promise<{ findings: Finding[]; masks: string[]; notices: string[] }> {
  const notices: string[] = [];
  // Tracked + untracked-not-ignored (so a working tree with staged-but-uncommitted
  // or newly-added files is scanned; .gitignore'd paths like node_modules excluded).
  const ls = sh(["git", "ls-files", "--cached", "--others", "--exclude-standard"], opts.cwd);
  // FAIL CLOSED (review #9 fix 1): a failed enumeration must not read as "empty
  // tree ⇒ clean". Throw so main() exits 3.
  if (ls.code !== 0) {
    throw new Error(`git ls-files failed (not a git repo or git error): ${ls.stderr.trim().split("\n")[0] || `exit ${ls.code}`} — failing closed`);
  }
  const findings: Finding[] = [];
  const masks: string[] = [];
  let oversize = 0;
  const files = ls.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  for (const file of files) {
    if (await isOversizeText(join(opts.cwd, file))) {
      // Too large to content-scan — never skip silently (review #9 fix 5).
      findings.push(oversizeFinding(file, SENSITIVE_CONTENT_PATHS));
      oversize++;
      continue;
    }
    const content = await readTextFile(join(opts.cwd, file));
    if (content === null) {
      // Unreadable/binary — flag binaries under sensitive paths (can't tell "new" in tree mode ⇒ warn).
      const f = checkNewBinary(file, "warn");
      if (f) findings.push(f);
      continue;
    }
    const chunk = scanText(content, file, patterns, denylist, opts.pepper);
    findings.push(...chunk.findings);
    masks.push(...chunk.masks);
  }
  if (oversize) notices.push(`${oversize} file(s) exceeded the ${MAX_FILE_BYTES}-byte scan cap — reported as findings, NOT content-scanned`);
  return { findings, masks, notices };
}

async function scanHistory(opts: Options, patterns: ShapePattern[], denylist: HashedDenylist): Promise<{ findings: Finding[]; masks: string[]; notices: string[] }> {
  const notices: string[] = [];
  const rev = sh(["git", "rev-list", "--objects", "--all"], opts.cwd);
  // FAIL CLOSED (review #9 fix 1): don't treat a rev-list error as "no history".
  if (rev.code !== 0) {
    throw new Error(`git rev-list failed (not a git repo or git error): ${rev.stderr.trim().split("\n")[0] || `exit ${rev.code}`} — failing closed`);
  }
  const findings: Finding[] = [];
  const masks: string[] = [];
  let oversize = 0;
  const seen = new Set<string>();
  let count = 0;
  let capped = false;
  for (const line of rev.stdout.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp < 0) continue; // commit/tree entries with no path
    const sha = line.slice(0, sp);
    const path = line.slice(sp + 1).trim();
    if (!path || seen.has(sha)) continue;
    seen.add(sha);
    if (count >= MAX_HISTORY_BLOBS) {
      capped = true;
      break;
    }
    const type = sh(["git", "cat-file", "-t", sha], opts.cwd).stdout.trim();
    if (type !== "blob") continue;
    count++;
    const cat = sh(["git", "cat-file", "-p", sha], opts.cwd);
    if (cat.code !== 0) continue;
    if (cat.stdout.includes("\0")) continue; // binary blob
    if (cat.stdout.length > MAX_FILE_BYTES) {
      // Too large to content-scan — surface, don't skip silently (review #9 fix 5).
      findings.push(oversizeFinding(path, SENSITIVE_CONTENT_PATHS));
      oversize++;
      continue;
    }
    const chunk = scanText(cat.stdout, path, patterns, denylist, opts.pepper);
    findings.push(...chunk.findings);
    masks.push(...chunk.masks);
  }
  if (capped) notices.push(`history scan capped at ${MAX_HISTORY_BLOBS} blobs (perf cap) — some history not scanned`);
  if (oversize) notices.push(`${oversize} blob(s) exceeded the ${MAX_FILE_BYTES}-byte scan cap — reported as findings, NOT content-scanned`);
  return { findings, masks, notices };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runScan(opts: Options): Promise<ScanReport> {
  const patterns = await loadPatterns(opts.patternsPath);
  // FAIL CLOSED: an empty patterns set means tier 2 would silently do nothing
  // (e.g. a gutted/empty public-patterns.yaml). Never run with a tier disabled.
  if (!patterns.length) {
    throw new Error(`no tier-2 patterns loaded from ${opts.patternsPath} — refusing to run with tier 2 disabled (fail-closed)`);
  }
  const { denylist, source } = await loadDenylist(opts);

  const notices: string[] = [];
  const tiersRun: number[] = [2];
  if (!denylist.salt || !denylist.entries.length) {
    // Enforce mode (review #9 fix 8): on the trusted path a required-but-absent
    // denylist must FAIL CLOSED, not degrade to a silent green with tier 3 off.
    if (opts.requireDenylist) {
      throw new Error(`--require-denylist set but tier 3 denylist is absent/empty (source=${source}) — failing closed`);
    }
    notices.push(`tier3 denylist: INERT (source=${source}, no entries) — degraded mode, shape + gitleaks tiers only`);
  } else {
    tiersRun.push(3);
  }

  const allFindings: Finding[] = [];
  const allMasks: string[] = [];

  // Tier 1
  if (opts.useGitleaks) {
    const gl = runGitleaks(opts);
    notices.push(gl.note);
    if (gl.ran) tiersRun.unshift(1);
    allFindings.push(...gl.findings);
    allMasks.push(...gl.masks);
  } else {
    notices.push("tier1 gitleaks: disabled (--no-gitleaks)");
  }

  // Tiers 2 + 3
  const modeResult =
    opts.mode === "tree"
      ? await scanTree(opts, patterns, denylist)
      : opts.mode === "history"
        ? await scanHistory(opts, patterns, denylist)
        : await scanDiff(opts, patterns, denylist);
  allFindings.push(...modeResult.findings);
  allMasks.push(...modeResult.masks);
  notices.push(...modeResult.notices);

  const deduped = dedupe({ findings: allFindings, masks: allMasks });
  return {
    findings: deduped.findings,
    masks: deduped.masks,
    notices,
    denylistSource: source,
    tiersRun: [...new Set(tiersRun)].sort(),
  };
}

// ---------------------------------------------------------------------------
// Output + exit code
// ---------------------------------------------------------------------------

export function decideExit(findings: Finding[], opts: Options): number {
  const hasBlock = findings.some((f) => f.action === "block");
  if (hasBlock) return 1;
  const hasWarn = findings.some((f) => f.action === "warn");
  if (hasWarn && opts.failOnWarn) return 1;
  return 0;
}

/**
 * Expand raw matches into the exact set of lines to register with `::add-mask::`.
 * GitHub Actions' `::add-mask::` command consumes ONLY up to the first newline,
 * so a multi-line secret (a PEM private key, a cert block — routine gitleaks
 * `Secret`/`Match` values) would leave lines 2..n printed RAW in the log
 * (adversarial review #9 fix 2). Split every mask on newlines and register each
 * non-blank line separately; dedupe across all lines. Exported for testing.
 */
export function expandMasks(masks: string[]): string[] {
  const out = new Set<string>();
  for (const m of masks) {
    if (!m) continue;
    for (const part of m.split(/\r?\n/)) {
      if (part.trim()) out.add(part);
    }
  }
  return [...out];
}

/** Emit `::add-mask::` for each raw match line — GitHub Actions redacts these values in the log. */
function emitCiMasks(masks: string[]): void {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  for (const line of expandMasks(masks)) process.stdout.write(`::add-mask::${line}\n`);
}

export function renderReport(report: ScanReport, denylist: HashedDenylist | undefined, opts: Options): string {
  const lines: string[] = [];
  const blocks = report.findings.filter((f) => f.action === "block");
  const warns = report.findings.filter((f) => f.action === "warn");
  lines.push("confidentiality-scan · mode=" + opts.mode + " · tiers=" + report.tiersRun.join("+") + " · denylist=" + report.denylistSource);
  for (const n of report.notices) lines.push("  · " + n);
  if (report.findings.length === 0) {
    lines.push("  ✓ no confidentiality findings");
  } else {
    if (blocks.length) {
      lines.push(`  ✗ ${blocks.length} BLOCK finding(s):`);
      for (const f of blocks) lines.push(renderFinding(f, denylist, opts.pepper));
    }
    if (warns.length) {
      lines.push(`  ⚠ ${warns.length} warn finding(s):`);
      for (const f of warns) lines.push(renderFinding(f, denylist, opts.pepper));
    }
  }
  return lines.join("\n");
}

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  let report: ScanReport;
  let denylist: HashedDenylist;
  try {
    denylist = (await loadDenylist(opts)).denylist;
    report = await runScan(opts);
  } catch (err) {
    process.stderr.write(`confidentiality-scan: ${(err as Error).message}\n`);
    return 3; // fail-closed on engine/config error
  }
  // Register raw matches with the Actions log masker BEFORE printing anything.
  emitCiMasks(report.masks);
  if (opts.json) {
    // JSON output is masked-only: findings carry no raw match/hash by construction.
    process.stdout.write(JSON.stringify({ findings: report.findings.map((f) => ({ ...f, file: redactPath(f.file, denylist, opts.pepper) })), notices: report.notices, tiersRun: report.tiersRun }, null, 2) + "\n");
  } else {
    process.stdout.write(renderReport(report, denylist, opts) + "\n");
  }
  return decideExit(report.findings, opts);
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
