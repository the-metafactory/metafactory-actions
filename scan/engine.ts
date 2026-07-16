/**
 * Confidentiality scan engine — pure detection core.
 *
 * PUBLIC-REPO DISCIPLINE (absolute): this file, its sibling data files, and its
 * tests contain ONLY generic shapes. No client names, real emails, or live
 * platform IDs. Findings are MASKED — the engine never emits a matched literal,
 * a hash of a matched literal, or any reversible digest of one. (Design doc
 * §4 L1: "no token digests of any kind in public output" — closes the
 * reversible-hash self-leak.)
 *
 * Three detection tiers (design doc §3 "one engine, one denylist, many
 * consumers"):
 *   1. gitleaks   — pinned binary, shelled out by the CLI when present.
 *   2. public shapes — regex shapes from `public-patterns.yaml` (this module
 *      loads + applies them). Public-safe: shapes, never values.
 *   3. hashed denylist — salted-SHA-256 hashed denylist supplied at RUNTIME
 *      (org secret / private installed path), NEVER committed populated. The
 *      engine holds only hashes; it never sees or stores plaintext terms.
 *
 * The module is I/O-free so it is unit-testable with synthetic fixtures; git
 * plumbing + gitleaks + output live in `confidentiality-scan.ts`.
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Tier = 1 | 2 | 3;
export type FindingAction = "block" | "warn";

/** A compiled public-shape pattern (tier 2). */
export interface ShapePattern {
  /** Stable rule identifier, e.g. "compliance-code". */
  id: string;
  /** Datum class the shape belongs to, e.g. "compliance-code-shape". */
  class: string;
  tier: Tier;
  action: FindingAction;
  /** Masked shape descriptor — printed verbatim, so it MUST be static (no captured content). */
  description: string;
  /** Detection regex (global). */
  regex: RegExp;
  /** Optional path globs — when non-empty the rule only applies to matching files. */
  paths: string[];
  /** Carve-out regexes — a match satisfying any of these is NOT flagged. */
  allow: RegExp[];
  /**
   * metafactory-actions#20 — when true, a match is suppressed if it is
   * EMBEDDED in a longer hex token (see {@link isHexEmbedded}): extending the
   * match through flanking `[0-9a-fA-F]` chars yields a token ≥32 chars that
   * contains at least one hex letter. Commit SHAs (40 hex) and sha256 digests
   * (64 hex) contain a 17–20-digit decimal run by chance often enough to
   * false-BLOCK innocent PRs; a REAL pasted platform id is delimited, never
   * hex-flanked into a digest-length token. Opt-in per rule so the carve-out
   * can't silently weaken unrelated shapes.
   */
  suppressInHex: boolean;
}

/**
 * One hashed denylist entry (tier 3). Plaintext lives only in PRIVATE compass.
 * Canonical contract (design doc §4 L1 / compass denylist tooling): the hash is
 * of `salt:[pepper:]canon(term)` and `len` is `canon(term).length` — `len` is
 * what lets the engine window-match (an exact hash can't substring-search).
 */
export interface DenylistEntry {
  /** Optional triage handle printed in findings (e.g. "client-0007"). Never the term. */
  id?: string;
  /** sha256 hex of `salt:[pepper:]canon(term)`. */
  hash: string;
  /** Datum class, e.g. "client-name". */
  class: string;
  action: FindingAction;
  /** canon(term).length — required for windowed matching. */
  len: number;
}

/** The hashed denylist document (org secret / private-path payload). */
export interface HashedDenylist {
  version?: number;
  generated?: string;
  /** Per-denylist random salt. Empty salt ⇒ tier 3 inert (placeholder). */
  salt: string;
  entries: DenylistEntry[];
}

/**
 * A masked finding. Carries NOTHING reversible: no raw match, no hash, no
 * digest. `descriptor` is a static shape label; for tier 3 the denylist entry
 * id + class are the only handles (triage via the private denylist tool).
 */
export interface Finding {
  tier: Tier;
  ruleId: string;
  class: string;
  action: FindingAction;
  file: string;
  /** 1-indexed line; 0 for file-level findings (e.g. new-binary). */
  line: number;
  descriptor: string;
}

/**
 * Result of scanning a unit of content. `masks` holds the raw matched literals
 * used ONLY for GitHub Actions `::add-mask::` emission by the CLI; it is never
 * rendered, serialized, or returned to a caller that renders output. Keeping it
 * separate from `findings` is what guarantees findings stay leak-free.
 */
export interface ScanChunkResult {
  findings: Finding[];
  masks: string[];
}

// ---------------------------------------------------------------------------
// Glob matching (minimal — supports **, *, and literal segments)
// ---------------------------------------------------------------------------

/** Convert a minimal glob to an anchored RegExp. Supports `**`, `*`, `?`. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` — match across path separators (and an optional trailing slash).
        re += ".*";
        i++;
        if (glob[i + 1] === "/") i++;
      } else {
        // `*` — match within a path segment.
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/** True when `path` matches any glob in `globs`. Empty `globs` ⇒ applies everywhere. */
export function pathMatchesAny(path: string, globs: string[]): boolean {
  if (!globs.length) return true;
  const norm = path.replace(/^\.\//, "");
  return globs.some((g) => globToRegExp(g).test(norm));
}

// ---------------------------------------------------------------------------
// public-patterns.yaml loader (hand-rolled, dependency-free)
//
// Matches the repo convention (utils.ts parseBlueprint/extractRepoNames): no
// YAML dependency, single-pass, tolerant. Scalars may be single-quoted (literal,
// `''`→`'`), double-quoted (JSON-unescaped), or bare. Regexes MUST be
// single-quoted so backslashes stay literal.
// ---------------------------------------------------------------------------

function unquoteScalar(raw: string): string {
  const v = raw.trim();
  if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) {
    return v.slice(1, -1).replace(/''/g, "'");
  }
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  return v;
}

interface RawPattern {
  id?: string;
  class?: string;
  tier?: string;
  action?: string;
  description?: string;
  regex?: string;
  flags?: string;
  paths: string[];
  allow: string[];
  suppress_in_hex?: string;
}

/**
 * Parse public-patterns.yaml into compiled ShapePatterns. Throws on a pattern
 * with no id/regex (fail-closed: a malformed pattern file must not silently
 * disable a tier).
 */
export function parsePatternsYaml(text: string): ShapePattern[] {
  const lines = text.split("\n");
  const raws: RawPattern[] = [];
  let cur: RawPattern | null = null;
  let listKey: "paths" | "allow" | null = null;

  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;

    // New pattern: `- id: <value>`
    const dashId = line.match(/^\s*-\s+id:\s*(.+?)\s*$/);
    if (dashId) {
      if (cur) raws.push(cur);
      cur = { id: unquoteScalar(dashId[1]), paths: [], allow: [] };
      listKey = null;
      continue;
    }
    if (!cur) continue;

    // List item under `allow:` / `paths:`
    const dashItem = line.match(/^\s*-\s+(.+?)\s*$/);
    if (dashItem && listKey) {
      cur[listKey].push(unquoteScalar(dashItem[1]));
      continue;
    }

    // `key:` (list opener) or `key: value` (scalar)
    const kv = line.match(/^\s+([A-Za-z_]+):\s*(.*)$/);
    if (kv) {
      const key = kv[1];
      const val = kv[2];
      if (key === "allow" || key === "paths") {
        listKey = key;
        if (val.trim()) cur[key].push(unquoteScalar(val)); // inline single value
        continue;
      }
      listKey = null;
      if (key === "class") cur.class = unquoteScalar(val);
      else if (key === "tier") cur.tier = unquoteScalar(val);
      else if (key === "action") cur.action = unquoteScalar(val);
      else if (key === "description") cur.description = unquoteScalar(val);
      else if (key === "regex") cur.regex = unquoteScalar(val);
      else if (key === "flags") cur.flags = unquoteScalar(val);
      else if (key === "suppress_in_hex") cur.suppress_in_hex = unquoteScalar(val);
      else if (key === "id") cur.id = unquoteScalar(val);
    }
  }
  if (cur) raws.push(cur);

  return raws.map((r) => {
    if (!r.id || !r.regex) {
      throw new Error(`public-patterns.yaml: pattern missing id or regex (id=${r.id ?? "?"})`);
    }
    let flags = r.flags || "g";
    if (!flags.includes("g")) flags += "g"; // scanning needs matchAll
    const action: FindingAction = r.action === "warn" ? "warn" : "block";
    const tier = (Number(r.tier) as Tier) || 2;
    // Carve-outs INHERIT the rule's case-sensitivity: a case-insensitive
    // detection rule (flags: gi) must have case-insensitive allow-list anchors
    // too, else a lowercase sanctioned placeholder (std-ex-ai-001) matches the
    // shape but slips past its carve-out and BLOCKs (adversarial review #9 fix 7).
    const allowFlags = flags.includes("i") ? "i" : "";
    return {
      id: r.id,
      class: r.class || r.id,
      tier,
      action,
      description: r.description || r.id,
      regex: new RegExp(r.regex, flags),
      paths: r.paths,
      allow: r.allow.map((a) => new RegExp(a, allowFlags)),
      suppressInHex: r.suppress_in_hex === "true",
    } satisfies ShapePattern;
  });
}

// ---------------------------------------------------------------------------
// Tier 2 — public shape detection
// ---------------------------------------------------------------------------

function isAllowed(match: string, allow: RegExp[]): boolean {
  return allow.some((re) => re.test(match));
}

/**
 * metafactory-actions#20 — is the match at [start, start+len) embedded in a
 * longer hex token? Extends the match left/right through `[0-9a-fA-F]` and
 * suppresses only when the maximal token is ≥{@link HEX_EMBED_MIN_LEN} chars
 * AND contains a hex letter — i.e. it reads as a digest (git SHA-1 = 40,
 * sha256 = 64, md5 = 32), not as an id glued to a word (`guildId1234…`
 * extends to a ~20-char token → NOT suppressed, preserving the
 * letter-adjacent catches of adversarial review #9 finding 4). A pure-digit
 * long run never qualifies (no hex letter) — not that one can reach here:
 * the snowflake rule's own digit lookarounds already refuse runs inside
 * longer digit runs.
 */
export const HEX_EMBED_MIN_LEN = 32;

const HEX_CHAR = /[0-9a-fA-F]/;

export function isHexEmbedded(line: string, start: number, len: number): boolean {
  let l = start;
  while (l > 0 && HEX_CHAR.test(line[l - 1])) l--;
  let r = start + len;
  while (r < line.length && HEX_CHAR.test(line[r])) r++;
  const token = line.slice(l, r);
  return token.length >= HEX_EMBED_MIN_LEN && /[a-fA-F]/.test(token);
}

/**
 * Scan a file's content against compiled shape patterns. Returns masked
 * findings + the raw matches (for CI masking only). Line numbers are 1-indexed.
 */
export function scanContentForShapes(
  content: string,
  file: string,
  patterns: ShapePattern[]
): ScanChunkResult {
  const findings: Finding[] = [];
  const masks: string[] = [];
  const applicable = patterns.filter((p) => pathMatchesAny(file, p.paths));
  if (!applicable.length) return { findings, masks };

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const chunk = scanLineForShapes(lines[i], i + 1, file, applicable);
    findings.push(...chunk.findings);
    masks.push(...chunk.masks);
  }
  return { findings, masks };
}

/** Scan a single already-located line (used by diff mode, which knows line nums). */
export function scanLineForShapes(
  line: string,
  lineNo: number,
  file: string,
  patterns: ShapePattern[]
): ScanChunkResult {
  const findings: Finding[] = [];
  const masks: string[] = [];
  for (const p of patterns) {
    if (!pathMatchesAny(file, p.paths)) continue;
    p.regex.lastIndex = 0;
    for (const m of line.matchAll(p.regex)) {
      const match = m[0];
      if (isAllowed(match, p.allow)) continue;
      // #20 — hex-digest embedding carve-out (opt-in per rule).
      if (p.suppressInHex && isHexEmbedded(line, m.index ?? 0, match.length)) {
        continue;
      }
      findings.push({
        tier: p.tier,
        ruleId: p.id,
        class: p.class,
        action: p.action,
        file,
        line: lineNo,
        descriptor: p.description,
      });
      masks.push(match);
    }
  }
  return { findings, masks };
}

// ---------------------------------------------------------------------------
// Tier 3 — hashed denylist detection
// ---------------------------------------------------------------------------

/**
 * Canonicalize a string to the shared match form. This MUST be byte-identical to
 * the compass denylist tooling (design doc §4 L1 contract) or the two sides
 * disagree and terms silently pass. Steps, in order:
 *   1. NFC normalize
 *   2. lowercase
 *   3. split camelCase (`([a-z0-9])([A-Z])` → `$1 $2`)
 *   4. strip ALL non-alphanumerics, unicode-aware (accented letters/digits kept)
 * "Acme Corp" / "AcmeCorp" / "acme-corp" all canonicalize to "acmecorp".
 *
 * PARITY NOTE (adversarial review #9): step 3 runs AFTER step 2, so its `[A-Z]`
 * never matches — the camelCase split is effectively a no-op. The result is still
 * correct because step 4 strips the space the split would have inserted, so
 * `AcmeCorp`→`acmecorp` either way (verified against a split-first reference over
 * camel/digit/Pascal/NFD probes: no divergence). It is intentionally left as-is to
 * keep the written steps aligned with the contract's wording — but the invariant
 * that holds parity is "step 4 removes separators", NOT the split. If compass #101
 * ever tokenizes on those boundaries instead of windowing, revisit both sides.
 * The `scan/engine.test.ts` GOLDEN-VECTORS test pins canon+hash so any drift here
 * (or a reordering that changes output) fails a test.
 *
 * `len`/window use UTF-16 code units (String.length / slice) on BOTH the build
 * (`buildHashedDenylist`) and match sides — internally consistent. If #101 ever
 * computes `len` as codepoints, astral-plane terms would mis-window; the golden
 * vectors don't include astral chars, so keep #101 on code-unit lengths.
 */
export function canon(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * Denylist entry hash: sha256 hex of `salt:canon` (or `salt:pepper:canon` when a
 * pepper secret is present). Input is expected ALREADY canonicalized. Deliberately
 * NOT key-stretched: windowed matching hashes O(|line|·distinctLens) times per
 * line, so stretching would make scans minutes-slow (design doc L1 contract).
 */
export function hashToken(salt: string, canonStr: string, pepper = ""): string {
  const input = pepper ? `${salt}:${pepper}:${canonStr}` : `${salt}:${canonStr}`;
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Scan content against a hashed denylist by WINDOWED matching (design doc §4 L1
 * contract): an exact hash can't substring-search, so for each line we compute
 * `sq = canon(line)` and, for every DISTINCT entry length L, slide an L-char
 * window across `sq` and test each window's hash for membership. This catches a
 * denylisted "Acme Corp" however it is written in a diff ("AcmeCorp",
 * "acme-corp", "acme corp") — all canonicalize to the same substring of `sq`.
 *
 * Findings reference the entry id (if present) + class only — never the term,
 * never the hash. Empty salt / no entries ⇒ tier inert. `pepper` (optional 2nd
 * secret) must match whatever built the denylist.
 */
export function scanContentForDenylist(
  content: string,
  file: string,
  denylist: HashedDenylist,
  pepper = ""
): ScanChunkResult {
  const findings: Finding[] = [];
  const masks: string[] = [];
  if (!denylist.salt || !denylist.entries.length) return { findings, masks };

  // Group entry hashes by length so a length-L window only tests length-L entries.
  const byLen = new Map<number, Map<string, DenylistEntry>>();
  for (const e of denylist.entries) {
    if (!e.len || e.len < 1) continue; // unusable entry (malformed) — skip
    let m = byLen.get(e.len);
    if (!m) byLen.set(e.len, (m = new Map()));
    m.set(e.hash, e);
  }
  if (!byLen.size) return { findings, masks };

  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const sq = canon(lines[i]);
    if (!sq) continue;
    const seenOnLine = new Set<string>(); // one finding per (line, entry.hash)
    for (const [L, m] of byLen) {
      if (L > sq.length) continue;
      for (let j = 0; j + L <= sq.length; j++) {
        const win = sq.slice(j, j + L);
        const hit = m.get(hashToken(denylist.salt, win, pepper));
        if (!hit || seenOnLine.has(hit.hash)) continue;
        seenOnLine.add(hit.hash);
        findings.push({
          tier: 3,
          ruleId: hit.id ?? `deny-${hit.class}`,
          class: hit.class,
          action: hit.action,
          file,
          line: i + 1,
          descriptor: `denylist:${hit.class}`,
        });
        masks.push(win); // canon form only; the original term is never reconstructable from output
      }
    }
  }
  return dedupe({ findings, masks });
}

/**
 * Build a hashed denylist from plaintext terms — used by tests and by the
 * PRIVATE compass sync tool. Public-safe: it only emits salted hashes + lengths,
 * never the plaintext. The engine + tests share ONE canon + hash definition (the
 * "one engine, one denylist" principle) so the build and match sides agree.
 */
export function buildHashedDenylist(
  salt: string,
  terms: Array<{ id?: string; term: string; class: string; action?: FindingAction }>,
  pepper = ""
): HashedDenylist {
  return {
    version: 1,
    salt,
    entries: terms.map((t) => {
      const c = canon(t.term);
      return {
        ...(t.id ? { id: t.id } : {}),
        hash: hashToken(salt, c, pepper),
        class: t.class,
        action: t.action ?? "block",
        len: c.length,
      } satisfies DenylistEntry;
    }),
  };
}

// ---------------------------------------------------------------------------
// Unified-diff parsing (diff mode)
// ---------------------------------------------------------------------------

export interface DiffAddedLine {
  file: string;
  line: number;
  text: string;
}

export interface ParsedDiff {
  added: DiffAddedLine[];
  /** Files git reported as binary (for the new-binary rule). */
  binaryFiles: string[];
  /** Files with any added/changed content (for changed-sensitive-file full scan). */
  changedFiles: string[];
}

/**
 * Parse a `git diff --unified=0` (or larger context) patch. Extracts ADDED
 * lines with accurate 1-indexed new-file line numbers from `@@ ... +c,d @@`
 * hunk headers. Ignores the `+++ b/...` file header line.
 */
export function parseUnifiedDiff(patch: string): ParsedDiff {
  const added: DiffAddedLine[] = [];
  const binaryFiles: string[] = [];
  const changed = new Set<string>();
  let file = "";
  let newLine = 0;

  for (const raw of patch.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      file = "";
      newLine = 0;
      continue;
    }
    // Prefer the `+++ b/path` header for the destination path.
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      file = p === "/dev/null" ? "" : p.replace(/^b\//, "");
      continue;
    }
    if (raw.startsWith("--- ")) continue;
    if (raw.startsWith("Binary files ") || raw.includes("GIT binary patch")) {
      // "Binary files a/x and b/y differ" — capture destination path.
      const m = raw.match(/ and (?:b\/)?(.+?) differ/);
      const bf = m ? m[1] : file;
      if (bf) {
        binaryFiles.push(bf);
        changed.add(bf);
      }
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("+")) {
      added.push({ file, line: newLine, text: raw.slice(1) });
      changed.add(file);
      newLine++;
    } else if (raw.startsWith("-")) {
      // deleted line — new-file counter does not advance
    } else if (raw.startsWith(" ")) {
      newLine++;
    }
  }
  return { added, binaryFiles, changedFiles: [...changed] };
}

// ---------------------------------------------------------------------------
// New-binary-under-sensitive-path rule (file-level, tier 2)
// ---------------------------------------------------------------------------

/** Sensitive path globs — a new binary here BLOCKs pending allowlist (design doc §4 L1). */
export const SENSITIVE_BINARY_PATHS = [
  "**/agents.d/**",
  "agents.d/**",
  "**/personas/**",
  "personas/**",
  "**/migrations/**",
  "**/seeds/**",
];

const BINARY_EXT = new RegExp(
  "\\.(png|jpe?g|gif|bmp|webp|ico|pdf|sqlite3?|db|dat|bin|zip|tar|gz|tgz|7z|rar|" +
    "key|keystore|p12|pfx|jks|xlsx?|docx?|pptx?|mp4|mov|woff2?|ttf|otf)$",
  "i"
);

/**
 * True when `file` has a recognized BINARY extension. This is the ONLY signal used
 * to treat a file as binary — a NUL/control byte in the content is NOT (re-review
 * F3: source files carry sentinel bytes and must still be text-scanned). Callers
 * use this to route real binaries (images/archives/db) to the new-binary rule and
 * everything else — including NUL-bearing source — to the text scanners.
 */
export function hasBinaryExtension(file: string): boolean {
  return BINARY_EXT.test(file);
}

/** A file-level finding for a binary/db file added under a sensitive path. */
export function checkNewBinary(
  file: string,
  action: FindingAction,
  sensitivePaths: string[] = SENSITIVE_BINARY_PATHS
): Finding | null {
  if (!BINARY_EXT.test(file)) return null;
  if (!pathMatchesAny(file, sensitivePaths)) return null;
  return {
    tier: 2,
    ruleId: "new-binary-sensitive-path",
    class: "binary-under-sensitive-path",
    action,
    file,
    line: 0,
    descriptor: "binary/db file under sensitive path (allowlist required)",
  };
}

// ---------------------------------------------------------------------------
// Dedupe + rendering
// ---------------------------------------------------------------------------

/**
 * Dedupe FINDINGS by (file,line,ruleId,class), preserving order. Masks are NOT
 * index-aligned with findings — `runGitleaks` emits up to TWO masks (Secret +
 * Match) per ONE finding, so an index-keyed "drop mask[i] when finding[i] is a
 * dup" (the old behavior) silently dropped the TAIL masks and left real matched
 * literals unregistered with `::add-mask::` (adversarial review #9 fix 6). Masks
 * are consumed ONLY by the CI masker, which dedupes them itself, so we preserve
 * EVERY mask here — a mask must never be dropped because some *finding* at a
 * shared index was a duplicate.
 */
export function dedupe(chunk: ScanChunkResult): ScanChunkResult {
  const seen = new Set<string>();
  const findings: Finding[] = [];
  for (const f of chunk.findings) {
    const k = `${f.file}:${f.line}:${f.ruleId}:${f.class}`;
    if (seen.has(k)) continue;
    seen.add(k);
    findings.push(f);
  }
  return { findings, masks: chunk.masks.filter(Boolean) };
}

/**
 * Redact any path segment that CONTAINS a denylisted term (windowed canon match)
 * — an `agents.d/<codename>.yaml` path is itself a leak (design doc §4 L6 finding
 * hygiene). Whole-segment redaction (no partial reveal). No-op when inert.
 */
export function redactPath(path: string, denylist?: HashedDenylist, pepper = ""): string {
  if (!denylist || !denylist.salt || !denylist.entries.length) return path;
  return path
    .split("/")
    .map((seg) => (scanContentForDenylist(seg, seg, denylist, pepper).findings.length ? "‹redacted›" : seg))
    .join("/");
}

/**
 * Render a finding as a single masked line. Contains NO matched literal, NO
 * hash, NO reversible digest — only file:line, tier/rule-id, class/descriptor.
 */
export function renderFinding(f: Finding, denylist?: HashedDenylist, pepper = ""): string {
  const loc = f.line > 0 ? `${redactPath(f.file, denylist, pepper)}:${f.line}` : redactPath(f.file, denylist, pepper);
  const flag = f.action === "block" ? "BLOCK" : "warn ";
  return `  ${flag}  ${loc}  [tier${f.tier}:${f.ruleId}]  ${f.descriptor}`;
}
