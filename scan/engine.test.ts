import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHashedDenylist,
  canon,
  checkNewBinary,
  dedupe,
  globToRegExp,
  hashToken,
  parsePatternsYaml,
  parseUnifiedDiff,
  pathMatchesAny,
  redactPath,
  renderFinding,
  scanContentForDenylist,
  scanContentForShapes,
  scanLineForShapes,
  type Finding,
  type HashedDenylist,
  type ShapePattern,
} from "./engine.ts";
import {
  decideExit,
  expandMasks,
  loadDenylist,
  loadPatterns,
  parseArgs,
  renderReport,
  runScan,
  type Options,
} from "./confidentiality-scan.ts";
import { findShadowingRepos, localHooksPathOverride, run as runInstaller } from "./install-hooks.ts";

// ---------------------------------------------------------------------------
// Test helpers — synthetic fixtures only, built at runtime so no client-shaped
// literal is ever committed to this PUBLIC repo (design doc L2 pattern).
// ---------------------------------------------------------------------------

const PATTERNS_PATH = join(import.meta.dir, "public-patterns.yaml");
let PATTERNS: ShapePattern[];

beforeAll(async () => {
  PATTERNS = await loadPatterns(PATTERNS_PATH);
});

function findPattern(id: string): ShapePattern {
  const p = PATTERNS.find((x) => x.id === id);
  if (!p) throw new Error(`pattern ${id} not found`);
  return p;
}

/** Build an 18-digit non-placeholder platform-ID shape (synthetic, not a real snowflake). */
const SNOWFLAKE_18 = ["100", "200", "300", "400", "500", "607"].join(""); // 18 digits, not all-same
/** A synthetic internal-domain address at the metafactory PUBLIC brand domain. */
const INTERNAL_EMAIL = ["dev", "placeholder"].join(".") + "@meta-factory.ai";
/**
 * A synthetic compliance-code (org token "XY" is not a real client). Built at
 * runtime by concatenation so no literal shape match sits in this file — the
 * gate must be green over its own tree (design doc L2 "construct forbidden
 * strings at runtime").
 */
const COMPLIANCE = ["STD", "XY", "AI", "042"].join("-");

function opts(overrides: Partial<Options> = {}): Options {
  return {
    mode: "diff",
    staged: false,
    range: null,
    denylistPath: null,
    patternsPath: PATTERNS_PATH,
    extraText: [],
    useGitleaks: false,
    failOnWarn: false,
    json: false,
    cwd: process.cwd(),
    pepper: "",
    requireDenylist: false,
    ...overrides,
  };
}

function git(args: string[], cwd: string) {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode ?? 1, out: p.stdout ? new TextDecoder().decode(p.stdout) : "" };
}

// ===========================================================================
// public-patterns.yaml loader
// ===========================================================================

describe("parsePatternsYaml — hand-rolled loader (no YAML dep, repo convention)", () => {
  test("loads every expected pattern id from the shipped file", () => {
    const ids = PATTERNS.map((p) => p.id).sort();
    expect(ids).toEqual(["compliance-code", "internal-email", "platform-snowflake", "seed-identity"]);
  });

  test("regexes compile with the global flag and allow-lists are compiled", () => {
    for (const p of PATTERNS) {
      expect(p.regex.flags).toContain("g");
      expect(Array.isArray(p.allow)).toBe(true);
    }
    expect(findPattern("seed-identity").paths.length).toBeGreaterThan(0);
  });

  test("throws (fail-closed) on a pattern with no regex", () => {
    expect(() => parsePatternsYaml("patterns:\n  - id: broken\n    class: x\n")).toThrow();
  });

  test("single-quoted scalars keep backslashes literal", () => {
    const [p] = parsePatternsYaml(["patterns:", "  - id: t", "    regex: '\\d{3}'", "    description: three digits"].join("\n"));
    expect("abc 123 xyz".match(p.regex)?.[0]).toBe("123");
  });
});

// ===========================================================================
// glob matching
// ===========================================================================

describe("globToRegExp / pathMatchesAny", () => {
  test("** crosses path separators, * does not", () => {
    expect(globToRegExp("**/*.sql").test("a/b/c/x.sql")).toBe(true);
    expect(globToRegExp("agents.d/**").test("agents.d/x/y.yaml")).toBe(true);
    expect(globToRegExp("*.sql").test("a/x.sql")).toBe(false);
  });
  test("empty glob list applies everywhere", () => {
    expect(pathMatchesAny("any/where.ts", [])).toBe(true);
  });
});

// ===========================================================================
// Tier 2 — shape detection: internal-email (class 6)
// ===========================================================================

describe("internal-email (class 6)", () => {
  test("POSITIVE: address at a metafactory brand domain is flagged", () => {
    const { findings } = scanContentForShapes(`contact = "${INTERNAL_EMAIL}"`, "src/app.ts", [findPattern("internal-email")]);
    expect(findings.map((f) => f.ruleId)).toContain("internal-email");
  });
  test("NEGATIVE: sanctioned system addresses + github noreply are carved out", () => {
    for (const addr of ["noreply@meta-factory.ai", "security@meta-factory.ai", "u@users.noreply.github.com"]) {
      const { findings } = scanContentForShapes(`x="${addr}"`, "src/app.ts", [findPattern("internal-email")]);
      expect(findings).toHaveLength(0);
    }
  });
  test("NEGATIVE: external / placeholder domains do not match this rule", () => {
    const { findings } = scanContentForShapes(`x="person@example.com"`, "src/app.ts", [findPattern("internal-email")]);
    expect(findings).toHaveLength(0);
  });
});

// ===========================================================================
// Tier 2 — compliance-code (class 5) + the carve-out self-test
// ===========================================================================

describe("compliance-code (class 5)", () => {
  test("POSITIVE: STD-<ORG>-AI-### is flagged", () => {
    const { findings } = scanLineForShapes(`code: ${COMPLIANCE}`, 1, "docs/x.md", [findPattern("compliance-code")]);
    expect(findings).toHaveLength(1);
    expect(findings[0].class).toBe("compliance-code-shape");
  });

  // The red-team resolution (design doc §4 L1): a carve-out is only meaningful
  // if the carve-out FORM actually matches the DETECTION shape — otherwise it is
  // false comfort. Prove both sanctioned forms are live carve-outs.
  test("carve-out self-test: STD-EX-AI-001 matches the shape but is allowed", () => {
    const cp = findPattern("compliance-code");
    const cpNoAllow: ShapePattern = { ...cp, allow: [], regex: new RegExp(cp.regex.source, cp.regex.flags) };
    // Shape matches (detector WOULD fire without the carve-out):
    expect(scanLineForShapes("STD-EX-AI-001", 1, "f", [cpNoAllow]).findings).toHaveLength(1);
    // Carve-out excludes it (detector does NOT fire with the carve-out):
    expect(scanLineForShapes("STD-EX-AI-001", 1, "f", [cp]).findings).toHaveLength(0);
  });

  test("carve-out self-test: STD-EXAMPLE-AI-001 also matches the shape but is allowed", () => {
    const cp = findPattern("compliance-code");
    const cpNoAllow: ShapePattern = { ...cp, allow: [], regex: new RegExp(cp.regex.source, cp.regex.flags) };
    expect(scanLineForShapes("STD-EXAMPLE-AI-001", 1, "f", [cpNoAllow]).findings).toHaveLength(1);
    expect(scanLineForShapes("STD-EXAMPLE-AI-001", 1, "f", [cp]).findings).toHaveLength(0);
  });
});

// ===========================================================================
// Tier 2 — platform-snowflake (class 8)
// ===========================================================================

describe("platform-snowflake (class 8)", () => {
  test("POSITIVE: 17-20 digit non-placeholder ID is flagged", () => {
    const { findings } = scanLineForShapes(`id=${SNOWFLAKE_18}`, 1, "src/config.ts", [findPattern("platform-snowflake")]);
    expect(findings).toHaveLength(1);
  });
  test("POSITIVE: test files ARE in scope (design doc L1)", () => {
    const { findings } = scanLineForShapes(`const id = "${SNOWFLAKE_18}";`, 1, "src/__tests__/x.test.ts", [findPattern("platform-snowflake")]);
    expect(findings).toHaveLength(1);
  });
  test("NEGATIVE: all-zero and all-same-digit placeholders are allowed", () => {
    for (const id of ["0".repeat(18), "1".repeat(19)]) {
      const { findings } = scanLineForShapes(`id=${id}`, 1, "f.ts", [findPattern("platform-snowflake")]);
      expect(findings).toHaveLength(0);
    }
  });
  test("NEGATIVE: 16-digit (too short) and 21-digit (too long) do not match", () => {
    expect(scanLineForShapes("id=1234567890123456", 1, "f.ts", [findPattern("platform-snowflake")]).findings).toHaveLength(0); // 16
    expect(scanLineForShapes("id=123456789012345678901", 1, "f.ts", [findPattern("platform-snowflake")]).findings).toHaveLength(0); // 21
  });
});

// ===========================================================================
// Tier 2 — seed-identity (class 7)
// ===========================================================================

describe("seed-identity (class 7)", () => {
  test("POSITIVE: internal-domain email in a .sql seed is flagged (the incident class)", () => {
    const line = `INSERT INTO principals(email) VALUES ('${["placeholder", "identity"].join(".")}@meta-factory.ai');`;
    const { findings } = scanContentForShapes(line, "migrations/0002_seed.sql", [findPattern("seed-identity")]);
    expect(findings.map((f) => f.ruleId)).toContain("seed-identity");
  });
  test("POSITIVE: non-reserved external email in migrations/ is flagged", () => {
    const email = "seed.user@" + ["acme", "widgets"].join("") + ".io"; // synthetic, non-reserved
    const { findings } = scanContentForShapes(`('${email}')`, "migrations/x.sql", [findPattern("seed-identity")]);
    expect(findings).toHaveLength(1);
  });
  test("NEGATIVE: reserved placeholder domains are allowed in seeds", () => {
    const { findings } = scanContentForShapes(`('user@example.com'),('a@b.test')`, "seeds/dev.sql", [findPattern("seed-identity")]);
    expect(findings).toHaveLength(0);
  });
  test("NEGATIVE: path scoping — a non-seed file does NOT trigger seed-identity", () => {
    const email = "seed.user@" + ["acme", "widgets"].join("") + ".io";
    const { findings } = scanContentForShapes(`('${email}')`, "src/app.ts", [findPattern("seed-identity")]);
    expect(findings).toHaveLength(0);
  });
});

// ===========================================================================
// Masking — findings NEVER echo the matched literal (design doc: no digests)
// ===========================================================================

describe("masking — no matched plaintext, no hash, no digest in rendered output", () => {
  test("rendered shape findings contain the descriptor but not the literal", () => {
    const content = [`code=${COMPLIANCE}`, `id=${SNOWFLAKE_18}`, `mail=${INTERNAL_EMAIL}`].join("\n");
    const { findings } = scanContentForShapes(content, "src/config.ts", PATTERNS);
    expect(findings.length).toBeGreaterThanOrEqual(3);
    const rendered = findings.map((f) => renderFinding(f)).join("\n");
    // No literal appears anywhere in the masked output:
    expect(rendered).not.toContain(COMPLIANCE);
    expect(rendered).not.toContain(SNOWFLAKE_18);
    expect(rendered).not.toContain(INTERNAL_EMAIL);
    // But the shape descriptors DO:
    expect(rendered).toContain("compliance-code shape");
    expect(rendered).toContain("platform ID");
  });
});

// ===========================================================================
// Tier 3 — hashed denylist (salted; engine holds only hashes)
// ===========================================================================

describe("hashed denylist (tier 3) — canonicalized windowed matching", () => {
  const SALT = "unit-test-salt-not-a-secret";
  // Synthetic single-word + two-word terms (never real).
  const dl: HashedDenylist = buildHashedDenylist(SALT, [
    { id: "client-0007", term: "zzsyntheticorg", class: "client-name" },
    { id: "eng-0003", term: "quuxwidget", class: "engagement-name", action: "warn" },
  ]);
  // The multi-word case the adversarial review flagged: "Zeta Nimbus" written
  // as "ZetaNimbus" in a diff must still match. Term built at runtime.
  const TWO_WORD = ["Zeta", "Nimbus"].join(" ");
  const dlTwo: HashedDenylist = buildHashedDenylist(SALT, [{ id: "client-0099", term: TWO_WORD, class: "client-name" }]);

  test("flags a denylisted term and reports entry-id + class ONLY (never the term/hash)", () => {
    const { findings } = scanContentForDenylist("deploy for zzsyntheticorg tonight", "notes.md", dl);
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleId).toBe("client-0007");
    expect(findings[0].class).toBe("client-name");
    const rendered = renderFinding(findings[0], dl);
    expect(rendered).not.toContain("zzsyntheticorg");
    expect(rendered).not.toContain(dl.entries[0].hash);
    expect(rendered).toContain("client-0007");
  });

  test("REGRESSION (review): multi-word term matches every spelling in a diff", () => {
    // "Zeta Nimbus" / "ZetaNimbus" / "zeta-nimbus" / "zeta_nimbus" all canon to "zetanimbus".
    for (const form of [TWO_WORD, "ZetaNimbus", "zeta-nimbus", "zeta_nimbus", "const zetaNimbus = 1;"]) {
      const { findings } = scanContentForDenylist(form, "f.ts", dlTwo);
      expect(findings.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("windowed: matches a denylisted term as a SUBSTRING of a longer identifier", () => {
    // "quuxwidget" embedded in "myQuuxwidgetFactory" is caught (windowing, not tokenizing).
    const { findings } = scanContentForDenylist("class myQuuxwidgetFactory {}", "f.ts", dl);
    expect(findings.map((f) => f.ruleId)).toContain("eng-0003");
  });

  test("identifier-aware: camelCase / snake_case / SHOUT all match the single-word entry", () => {
    for (const form of ["zzSyntheticOrg", "zz_synthetic_org", "ZZSYNTHETICORG"]) {
      const { findings } = scanContentForDenylist(`const ${form} = 1;`, "f.ts", dl);
      expect(findings.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("pepper: a peppered denylist only matches when the same pepper is supplied", () => {
    const peppered = buildHashedDenylist(SALT, [{ id: "c-1", term: "zzsyntheticorg", class: "client-name" }], "PEP");
    expect(scanContentForDenylist("zzsyntheticorg", "f", peppered, "PEP").findings).toHaveLength(1);
    expect(scanContentForDenylist("zzsyntheticorg", "f", peppered, "").findings).toHaveLength(0); // wrong/missing pepper → miss
  });

  test("empty-salt placeholder is INERT (tier 3 disabled)", () => {
    const { findings } = scanContentForDenylist("zzsyntheticorg everywhere", "f", { salt: "", entries: [] });
    expect(findings).toHaveLength(0);
  });

  test("buildHashedDenylist emits only hashes + lengths — never plaintext", () => {
    const serialized = JSON.stringify(dl);
    expect(serialized).not.toContain("zzsyntheticorg");
    expect(serialized).not.toContain("quuxwidget");
    expect(dl.entries[0].len).toBe("zzsyntheticorg".length);
    expect(JSON.stringify(dlTwo)).not.toContain("zeta");
  });
});

describe("canon + hashToken (shared contract with compass tooling)", () => {
  test("canon collapses whitespace/case/camelCase/punctuation to one alnum string", () => {
    expect(canon("Zeta Nimbus")).toBe("zetanimbus");
    expect(canon("ZetaNimbus")).toBe("zetanimbus");
    expect(canon("zeta-nimbus")).toBe("zetanimbus");
    expect(canon("  zeta_nimbus  ")).toBe("zetanimbus");
  });
  test("canon keeps unicode letters/digits (accented), strips symbols", () => {
    expect(canon("Nödл-42!")).toBe(canon("Nödл42")); // symbols stripped, letters/digits kept
    expect(canon("café")).toBe("café".normalize("NFC").toLowerCase());
  });
  test("hashToken: salt:canon, deterministic + salt/pepper-sensitive, no key-stretch", () => {
    expect(hashToken("s", "x")).toBe(hashToken("s", "x"));
    expect(hashToken("s1", "x")).not.toBe(hashToken("s2", "x"));
    expect(hashToken("s", "x")).not.toBe(hashToken("s", "x", "pep"));
  });
});

// ===========================================================================
// Unified-diff parsing (diff mode line accuracy)
// ===========================================================================

describe("parseUnifiedDiff", () => {
  test("extracts added lines with correct destination line numbers", () => {
    const patch = [
      "diff --git a/src/x.ts b/src/x.ts",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -10,0 +11,2 @@",
      "+const a = 1;",
      "+const b = 2;",
      "@@ -20,1 +22,1 @@",
      "-old",
      "+new line",
    ].join("\n");
    const { added } = parseUnifiedDiff(patch);
    expect(added).toEqual([
      { file: "src/x.ts", line: 11, text: "const a = 1;" },
      { file: "src/x.ts", line: 12, text: "const b = 2;" },
      { file: "src/x.ts", line: 22, text: "new line" },
    ]);
  });
  test("captures binary files and ignores +++/--- headers as content", () => {
    const patch = [
      "diff --git a/agents.d/x.png b/agents.d/x.png",
      "Binary files a/agents.d/x.png and b/agents.d/x.png differ",
    ].join("\n");
    const { binaryFiles, added } = parseUnifiedDiff(patch);
    expect(binaryFiles).toContain("agents.d/x.png");
    expect(added).toHaveLength(0);
  });
});

// ===========================================================================
// new-binary rule, dedupe, redactPath
// ===========================================================================

describe("checkNewBinary / dedupe / redactPath", () => {
  test("binary under a sensitive path is flagged; elsewhere is not", () => {
    expect(checkNewBinary("agents.d/x.png", "block")?.ruleId).toBe("new-binary-sensitive-path");
    expect(checkNewBinary("docs/logo.png", "block")).toBeNull(); // docs not in the default sensitive set
    expect(checkNewBinary("agents.d/x.yaml", "block")).toBeNull(); // not a binary
  });
  test("dedupe collapses identical (file,line,ruleId,class) findings; keeps distinct lines", () => {
    const a = { tier: 2, ruleId: "x", class: "c", action: "block", file: "f", line: 1, descriptor: "d" } as const;
    const b = { ...a, line: 2 } as const;
    const d = dedupe({ findings: [{ ...a }, { ...a }, { ...b }], masks: [] });
    expect(d.findings.length).toBe(2); // two line-1 dups collapse; line-2 kept
  });
  test("redactPath whole-segment redacts a path segment that hashes into the denylist", () => {
    const dl = buildHashedDenylist("s", [{ id: "c-1", term: "codename", class: "client-name" }]);
    // Whole segment is redacted (safest — no partial reveal of the leaking filename).
    expect(redactPath("agents.d/codename.yaml", dl)).toBe("agents.d/‹redacted›");
    expect(redactPath("agents.d/codename.yaml")).toBe("agents.d/codename.yaml"); // inert without denylist
  });
});

// ===========================================================================
// CLI arg parsing + exit codes
// ===========================================================================

describe("parseArgs / decideExit", () => {
  test("parses mode + flags", () => {
    const o = parseArgs(["tree", "--no-gitleaks", "--range", "a..b", "--fail-on-warn"]);
    expect(o.mode).toBe("tree");
    expect(o.useGitleaks).toBe(false);
    expect(o.range).toBe("a..b");
    expect(o.failOnWarn).toBe(true);
  });
  test("block → exit 1, warn → exit 0 unless --fail-on-warn", () => {
    const block = [{ tier: 2, ruleId: "x", class: "c", action: "block", file: "f", line: 1, descriptor: "d" }] as const;
    const warn = [{ tier: 2, ruleId: "x", class: "c", action: "warn", file: "f", line: 1, descriptor: "d" }] as const;
    expect(decideExit([...block], opts())).toBe(1);
    expect(decideExit([...warn], opts())).toBe(0);
    expect(decideExit([...warn], opts({ failOnWarn: true }))).toBe(1);
    expect(decideExit([], opts())).toBe(0);
  });
});

// ===========================================================================
// loadDenylist — precedence + fail-closed
// ===========================================================================

describe("loadDenylist", () => {
  test("bundled placeholder is inert (empty salt)", async () => {
    const { denylist, source } = await loadDenylist(opts());
    expect(source).toBe("bundled-placeholder");
    expect(denylist.salt).toBe("");
    expect(denylist.entries).toHaveLength(0);
  });
  test("env override is parsed", async () => {
    const dl = buildHashedDenylist("s", [{ id: "c-1", term: "x", class: "client-name" }]);
    process.env.MF_CONFIDENTIALITY_DENYLIST = JSON.stringify(dl);
    try {
      const { denylist, source } = await loadDenylist(opts());
      expect(source).toContain("env:");
      expect(denylist.entries).toHaveLength(1);
    } finally {
      delete process.env.MF_CONFIDENTIALITY_DENYLIST;
    }
  });
  test("malformed denylist JSON fails closed (throws)", async () => {
    process.env.MF_CONFIDENTIALITY_DENYLIST = "{not json";
    let threw = false;
    try {
      await loadDenylist(opts());
    } catch {
      threw = true;
    } finally {
      delete process.env.MF_CONFIDENTIALITY_DENYLIST;
    }
    expect(threw).toBe(true);
  });
});

// ===========================================================================
// Integration — diff mode on a real temp git repo (acceptance: correct file:line)
// ===========================================================================

describe("integration: diff --staged on a temp repo", () => {
  let repo: string;
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "mfa-scan-"));
    git(["init", "-q"], repo);
    git(["config", "user.email", "t@example.com"], repo);
    git(["config", "user.name", "t"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("BLOCKs staged content at correct file:line, masked, exit 1", async () => {
    const file = join(repo, "src", "config.ts");
    mkdirSync(join(repo, "src"), { recursive: true });
    // line 1 blank, line 2 compliance, line 3 snowflake, line 4 internal email
    writeFileSync(file, ["", `const code = "${COMPLIANCE}";`, `const id = "${SNOWFLAKE_18}";`, `const mail = "${INTERNAL_EMAIL}";`].join("\n"));
    git(["add", "-A"], repo);

    const o = opts({ mode: "diff", staged: true, useGitleaks: false, cwd: repo });
    const report = await runScan(o);
    const blocks = report.findings.filter((f) => f.action === "block");
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    // Correct line numbers:
    const byLine = new Map(blocks.map((f) => [f.ruleId, f.line]));
    expect(byLine.get("compliance-code")).toBe(2);
    expect(byLine.get("platform-snowflake")).toBe(3);
    expect(byLine.get("internal-email")).toBe(4);
    // Correct file:
    expect(blocks.every((f) => f.file === "src/config.ts")).toBe(true);
    // Exit code + masked output:
    expect(decideExit(report.findings, o)).toBe(1);
    const rendered = renderReport(report, undefined, o);
    expect(rendered).not.toContain(COMPLIANCE);
    expect(rendered).not.toContain(SNOWFLAKE_18);
    expect(rendered).toContain("BLOCK");
    // Degraded (tier3 inert) notice present:
    expect(report.notices.join("\n")).toContain("tier3");
  });

  test("clean staged content → no findings, exit 0", async () => {
    const clean = mkdtempSync(join(tmpdir(), "mfa-scan-clean-"));
    try {
      git(["init", "-q"], clean);
      git(["config", "user.email", "t@example.com"], clean);
      git(["config", "user.name", "t"], clean);
      writeFileSync(join(clean, "ok.ts"), ["const id = \"" + "0".repeat(18) + "\";", "const mail = \"noreply@meta-factory.ai\";"].join("\n"));
      git(["add", "-A"], clean);
      const o = opts({ mode: "diff", staged: true, useGitleaks: false, cwd: clean });
      const report = await runScan(o);
      expect(report.findings).toHaveLength(0);
      expect(decideExit(report.findings, o)).toBe(0);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });

  test("the scan engine's OWN source tree is clean (gate-on-self)", async () => {
    // tree scan of scan/ must not self-flag on its own patterns/fixtures.
    const o = opts({ mode: "tree", useGitleaks: false, cwd: join(import.meta.dir, "..") });
    const report = await runScan(o);
    const selfBlocks = report.findings.filter((f) => f.action === "block" && f.file.startsWith("scan/"));
    // engine.ts / patterns / json placeholder / this test file must not BLOCK.
    if (selfBlocks.length) {
      // Surface which for debugging without leaking (descriptors only).
      throw new Error("self-scan BLOCKs: " + selfBlocks.map((f) => `${f.file}:${f.line}[${f.ruleId}]`).join(", "));
    }
    expect(selfBlocks).toHaveLength(0);
  });
});

// ===========================================================================
// install-hooks helpers (G17 shadowing detection) + doctor fail path
// ===========================================================================

describe("install-hooks: hooksPath shadowing detection (G17)", () => {
  let devRoot: string;
  let shadowed: string;
  let plain: string;
  beforeAll(() => {
    devRoot = mkdtempSync(join(tmpdir(), "mfa-devroot-"));
    shadowed = join(devRoot, "shadowed");
    plain = join(devRoot, "plain");
    mkdirSync(shadowed);
    mkdirSync(plain);
    git(["init", "-q"], shadowed);
    git(["init", "-q"], plain);
    git(["config", "--local", "core.hooksPath", ".husky"], shadowed);
  });
  afterAll(() => rmSync(devRoot, { recursive: true, force: true }));

  test("localHooksPathOverride reads the local override", () => {
    expect(localHooksPathOverride(shadowed)).toBe(".husky");
    expect(localHooksPathOverride(plain)).toBeNull();
  });
  test("findShadowingRepos enumerates only repos with an override", () => {
    const found = findShadowingRepos(devRoot).map((s) => s.repo);
    expect(found).toContain(shadowed);
    expect(found).not.toContain(plain);
  });
  test("doctor FAILS (non-zero) when a --repo has a shadowing local hooksPath", () => {
    const code = runInstaller(["doctor", "--repo", shadowed]);
    expect(code).not.toBe(0);
  });
});

// ===========================================================================
// Adversarial review #9 — regression fixes (1..8) + golden-vector parity lock.
// All forbidden-shaped strings are BUILT AT RUNTIME so this file stays scan-clean.
// ===========================================================================

/** Make a throwaway git repo with commit signing off. */
function tmpRepo(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  git(["init", "-q"], d);
  git(["config", "user.email", "t@example.com"], d);
  git(["config", "user.name", "t"], d);
  git(["config", "commit.gpgsign", "false"], d);
  return d;
}

/** True iff `fn` rejects (optionally with a message matching `re`). */
async function rejects(fn: () => Promise<unknown>, re?: RegExp): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return re ? re.test((e as Error).message) : true;
  }
}

describe("fix1: git-plumbing failure fails CLOSED (exit 3), never a silent green", () => {
  let repo: string;
  beforeAll(() => {
    repo = tmpRepo("mfa-fix1-");
    mkdirSync(join(repo, "src"), { recursive: true });
    // A real leak sits in the committed tree — a broken scan must NOT report clean.
    writeFileSync(join(repo, "src", "a.ts"), `const mail = "${INTERNAL_EMAIL}";\n`);
    git(["add", "-A"], repo);
    git(["commit", "-qm", "seed"], repo);
  });
  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  test("bogus --range throws → exit 3 (leak in tree, yet git diff errors)", async () => {
    const o = opts({ mode: "diff", range: "no-such-ref-aaa...no-such-ref-bbb", cwd: repo });
    expect(await rejects(() => runScan(o), /git diff failed/i)).toBe(true);
  });
  test("shallow-checkout simulation: origin/main absent → throws (not clean exit 0)", async () => {
    const o = opts({ mode: "diff", range: "origin/main...HEAD", cwd: repo });
    expect(await rejects(() => runScan(o))).toBe(true);
  });
  test("tree mode in a non-git directory throws (ls-files fails closed)", async () => {
    const nonGit = mkdtempSync(join(tmpdir(), "mfa-fix1-nogit-"));
    try {
      writeFileSync(join(nonGit, "leak.ts"), `const mail = "${INTERNAL_EMAIL}";\n`);
      expect(await rejects(() => runScan(opts({ mode: "tree", cwd: nonGit })), /ls-files/i)).toBe(true);
    } finally {
      rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

describe("fix2: expandMasks splits multi-line secrets so no line leaks raw", () => {
  test("every line of a multi-line secret becomes its own mask; blanks dropped; deduped", () => {
    const secret = ["-----BEGIN KEY-----", "LINE2SECRET", "LINE3SECRET", "-----END KEY-----"].join("\n");
    const out = expandMasks([secret, "singleLineToken", "", "  "]);
    expect(out).toContain("LINE2SECRET");
    expect(out).toContain("LINE3SECRET");
    expect(out).toContain("-----END KEY-----");
    expect(out).toContain("singleLineToken");
    expect(out).not.toContain(""); // blank / whitespace-only lines never masked
    // CRLF handled + dedup across lines:
    expect(expandMasks(["dup\r\ndup"]).filter((x) => x === "dup")).toHaveLength(1);
  });
});

describe("fix3: internal-email catches subdomains (still rejects lookalikes)", () => {
  const P3 = () => [findPattern("internal-email")];
  const BRAND = ["meta", "factory"].join("-"); // "meta-factory" assembled at runtime
  test("subdomain addresses at a brand domain are flagged", () => {
    for (const host of [`ci.${BRAND}.dev`, `mail.${BRAND}.ai`, `sub.dept.${BRAND}.io`]) {
      const addr = "u" + "@" + host; // never a full literal in source
      expect(scanContentForShapes(`x="${addr}"`, "src/app.ts", P3()).findings.length).toBeGreaterThanOrEqual(1);
    }
  });
  test("apex still flagged; a lookalike domain is NOT (no over-broadening)", () => {
    expect(scanContentForShapes(`x="u${"@"}${BRAND}.ai"`, "src/app.ts", P3()).findings).toHaveLength(1);
    expect(scanContentForShapes(`x="u${"@"}evil-${BRAND}.ai"`, "src/app.ts", P3()).findings).toHaveLength(0);
  });
});

describe("fix4: platform-ID catches word-glued forms; 21+ digits still match nothing", () => {
  const P4 = () => [findPattern("platform-snowflake")];
  test("underscore/letter-glued 18-digit IDs are flagged", () => {
    for (const s of [`webhook_${SNOWFLAKE_18}`, `guildId${SNOWFLAKE_18}`, `id:${SNOWFLAKE_18}`, `${SNOWFLAKE_18}`]) {
      expect(scanLineForShapes(s, 1, "f.ts", P4()).findings.length).toBeGreaterThanOrEqual(1);
    }
  });
  test("21+ digit runs match nothing (not a snowflake; no sub-slice flagged)", () => {
    const long = Array.from({ length: 24 }, (_, i) => String((i % 9) + 1)).join(""); // 24 digits
    expect(scanLineForShapes(`x=${long}`, 1, "f.ts", P4()).findings).toHaveLength(0);
  });
  test("all-same-digit placeholder stays allowed even when word-glued", () => {
    expect(scanLineForShapes(`id_${"7".repeat(18)}`, 1, "f.ts", P4()).findings).toHaveLength(0);
  });
});

describe("fix7: compliance-code is case-insensitive; carve-outs inherit the case-fold", () => {
  const cp = () => findPattern("compliance-code");
  const mk = (org: string, n: string) => ["STD", org, "AI", n].join("-"); // runtime-built
  test("lowercase / mixed-case codes are flagged", () => {
    for (const code of [mk("XY", "001").toLowerCase(), mk("Np", "014"), mk("ABCD", "999")]) {
      expect(scanLineForShapes(`c: ${code}`, 1, "docs/x.md", [cp()]).findings.length).toBeGreaterThanOrEqual(1);
    }
  });
  test("a lowercase sanctioned placeholder is STILL carved out (allow inherits `i`)", () => {
    const exLower = mk("EX", "001").toLowerCase();
    expect(scanLineForShapes(exLower, 1, "f", [cp()]).findings).toHaveLength(0);
  });
});

describe("fix5: oversized files are surfaced as findings, never silently skipped", () => {
  test("tree mode: a >1MB file yields a visible non-clean 'oversize-unscanned' finding + notice", async () => {
    const dir = tmpRepo("mfa-fix5-");
    try {
      writeFileSync(join(dir, "big.ts"), "x".repeat(1_000_001)); // >1MB, no shape inside
      git(["add", "-A"], dir);
      const r = await runScan(opts({ mode: "tree", cwd: dir }));
      const f = r.findings.find((x) => x.ruleId === "oversize-unscanned");
      expect(f).toBeTruthy();
      expect(r.notices.join("\n")).toContain("exceeded the");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("oversize under a sensitive path BLOCKs", async () => {
    const dir = tmpRepo("mfa-fix5b-");
    try {
      mkdirSync(join(dir, "seeds"), { recursive: true });
      writeFileSync(join(dir, "seeds", "big.sql"), "x".repeat(1_000_001));
      git(["add", "-A"], dir);
      const r = await runScan(opts({ mode: "tree", cwd: dir }));
      const f = r.findings.find((x) => x.ruleId === "oversize-unscanned");
      expect(f?.action).toBe("block");
      expect(decideExit(r.findings, opts({ mode: "tree", cwd: dir }))).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("fix6: dedupe preserves EVERY mask (gitleaks emits 2 masks / 1 finding)", () => {
  const f = (file: string): Finding => ({ tier: 1, ruleId: "r", class: "c", action: "block", file, line: 1, descriptor: "d" });
  test("a tail mask is never dropped because masks outnumber findings", () => {
    const findings = [f("a"), f("b"), f("c")];
    const masks = ["SECRET", "MATCH", "SHAPE_A_LITERAL", "SHAPE_B_LITERAL"]; // 4 masks, 3 findings
    const d = dedupe({ findings, masks });
    expect(d.masks).toContain("SHAPE_B_LITERAL"); // previously silently dropped
    expect(d.masks).toHaveLength(4);
  });
  test("duplicate findings still collapse; their masks are still preserved for masking", () => {
    const d = dedupe({ findings: [f("a"), f("a")], masks: ["M1", "M2"] });
    expect(d.findings).toHaveLength(1);
    expect(d.masks).toHaveLength(2);
  });
});

describe("fix8: --require-denylist enforces tier 3 on the trusted path", () => {
  test("inert denylist + requireDenylist → runScan throws (=> exit 3)", async () => {
    // The enforce check runs before any mode scan, so no git repo is needed.
    expect(await rejects(() => runScan(opts({ mode: "diff", requireDenylist: true })), /require-denylist/i)).toBe(true);
  });
  test("populated denylist + requireDenylist → runs, tier 3 active", async () => {
    const dl = buildHashedDenylist("s", [{ id: "c-1", term: "zzsyntheticorg", class: "client-name" }]);
    process.env.MF_CONFIDENTIALITY_DENYLIST = JSON.stringify(dl);
    const dir = tmpRepo("mfa-fix8-");
    try {
      const r = await runScan(opts({ mode: "tree", requireDenylist: true, cwd: dir }));
      expect(r.tiersRun).toContain(3);
    } finally {
      delete process.env.MF_CONFIDENTIALITY_DENYLIST;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// GOLDEN VECTORS — the canon+hash contract, pinned. Any change to canon() or
// hashToken() (or a reordering that changes output) FAILS here, catching silent
// divergence from the compass #101 denylist tooling. Salt/pepper are fixed,
// public test constants (NOT secrets). Digests computed from THIS engine and
// frozen; #101 must produce byte-identical values for the same {salt,term}.
// ---------------------------------------------------------------------------
describe("GOLDEN VECTORS — canon + sha256(salt:canon) parity lock (#101 contract)", () => {
  const SALT = "golden-salt-v1";
  const PEP = "golden-pepper";
  const V: Array<{ label: string; in: string; canon: string; len: number; hash: string }> = [
    { label: "multi-word", in: ["Zeta", "Nimbus"].join(" "), canon: "zetanimbus", len: 10, hash: "f0196e3a7ae2c4ce00a58d15070e3e6c5f4054da0b995c3b855f1a0012954979" },
    { label: "hyphenated", in: "zeta-nimbus", canon: "zetanimbus", len: 10, hash: "f0196e3a7ae2c4ce00a58d15070e3e6c5f4054da0b995c3b855f1a0012954979" },
    { label: "camelCase", in: "ZetaNimbus", canon: "zetanimbus", len: 10, hash: "f0196e3a7ae2c4ce00a58d15070e3e6c5f4054da0b995c3b855f1a0012954979" },
    { label: "snake_case", in: "acme_corp", canon: "acmecorp", len: 8, hash: "6c29a44ab609753f0c0f3df064b426eedefd3592a0377d8868f95165ee017710" },
    { label: "three-word", in: ["Foo", "Bar", "Baz"].join(" "), canon: "foobarbaz", len: 9, hash: "196443fa77ba17ae32a49e68751a4845fb24ac3c37f243b32c82e7e628221366" },
    { label: "digit-boundary", in: "Zeta2Nimbus", canon: "zeta2nimbus", len: 11, hash: "c083597db4275b52c287ec165cdbc7a2381223dbabcbea5a0bd89efabfb7961a" },
    // NFD input (e + U+0301 combining acute) MUST NFC-compose before hashing:
    { label: "NFD-accented", in: "café", canon: "café", len: 4, hash: "f1100e4b38eadc0b7eee839a6e3c83499e53e36f0c1c39ca6fb544f7779ee30d" },
    { label: "precomposed+digits+symbol", in: "Nödl-42", canon: "nödl42", len: 6, hash: "04dad61b5f51d17a4d7769669b3e82d5693788b39c68a56b2cb4db402358c27e" },
  ];
  test("canon() produces exactly the pinned form + length for every vector", () => {
    for (const v of V) {
      expect(canon(v.in)).toBe(v.canon);
      expect(canon(v.in).length).toBe(v.len); // UTF-16 code-unit length (parity note)
    }
  });
  test("hashToken(SALT, canon) matches the pinned digest for every vector", () => {
    for (const v of V) expect(hashToken(SALT, canon(v.in))).toBe(v.hash);
  });
  test("peppered digest (salt:pepper:canon) is pinned", () => {
    expect(hashToken(SALT, canon(["Zeta", "Nimbus"].join(" ")), PEP)).toBe(
      "339fd35e0d36e7eb14038695752098880200646ca24763d9b9b15cbd7a227fe6"
    );
  });
  test("buildHashedDenylist reproduces the pinned hash+len end-to-end", () => {
    const dl = buildHashedDenylist(SALT, [{ id: "g-1", term: ["Zeta", "Nimbus"].join(" "), class: "client-name" }]);
    expect(dl.entries[0].hash).toBe("f0196e3a7ae2c4ce00a58d15070e3e6c5f4054da0b995c3b855f1a0012954979");
    expect(dl.entries[0].len).toBe(10);
  });
  test("NFC composition is locked: NFD and NFC spellings hash identically (from escapes)", () => {
    // Built from code points so this assertion carries no accented literal and is
    // encoding-robust. If canon() ever drops NFC normalization, these diverge.
    const nfd = "cafe" + String.fromCodePoint(0x0301); // e + combining acute (5 code units)
    const nfc = "caf" + String.fromCodePoint(0x00e9); // é precomposed (4 code units)
    expect(canon(nfd)).toBe(canon(nfc));
    expect(canon(nfd)).toBe(nfc);
    expect(canon(nfd).length).toBe(4);
    expect(hashToken(SALT, canon(nfd))).toBe("f1100e4b38eadc0b7eee839a6e3c83499e53e36f0c1c39ca6fb544f7779ee30d");
    expect(hashToken(SALT, canon(nfd))).toBe(hashToken(SALT, canon(nfc)));
  });
});
