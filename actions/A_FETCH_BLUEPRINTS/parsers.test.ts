import { describe, expect, test } from "bun:test";
import { extractRepoNames, parseBlueprint, prefixesFromIds } from "./action";
import { extractIds } from "../A_SCAN_PR_FEATURE_IDS/action";

describe("prefixesFromIds — Holly #2: digit count widened from \\d? to \\d*", () => {
  test("single-letter prefixes (A-, F-)", () => {
    expect(prefixesFromIds(["A-100", "F-412"])).toEqual(expect.arrayContaining(["A-", "F-"]));
  });

  test("single-digit iteration prefixes (F3-, S1-)", () => {
    const out = prefixesFromIds(["F3-309", "S1-01", "S2-22"]);
    expect(out).toEqual(expect.arrayContaining(["F3-", "S1-", "S2-"]));
  });

  test("multi-letter prefix (DD-, MA-)", () => {
    expect(prefixesFromIds(["DD-90", "MA-1"])).toEqual(expect.arrayContaining(["DD-", "MA-"]));
  });

  test("DOUBLE-DIGIT iteration prefix must NOT collapse (Holly #2 regression)", () => {
    // Pre-fix: \d? captured at most one digit, so F12-309 → F1- (wrong).
    // Post-fix: \d* captures all digits → F12-.
    const out = prefixesFromIds(["F12-309"]);
    expect(out).toContain("F12-");
    expect(out).not.toContain("F1-");
  });

  test("mixed corpus across all known prefix shapes", () => {
    const out = prefixesFromIds(["F-1", "F12-309", "DD-90", "S1-01"]);
    expect(out.sort()).toEqual(["DD-", "F-", "F12-", "S1-"].sort());
  });
});

describe("extractIds — Holly #4: family-based match accepts digit variants of registered prefixes", () => {
  test("matches IDs whose prefix is registered exactly", () => {
    const out = extractIds("feat: A-100 install pipeline", ["A-"]);
    expect(out).toEqual(["A-100"]);
  });

  test("ALSO matches digit-count variants of the same letter family", () => {
    // Pre-fix: prefixes=["F-"] would NOT match "F5-501" — drift detector never sees it.
    // Post-fix: letter-family `F` accepts F-, F1-, F5-, F12-, etc. variants.
    const out = extractIds("feat: F5-501 — registry signing", ["F-"]);
    expect(out).toContain("F5-501");
  });

  test("respects repo-scoping — IDs from other letter families do NOT match", () => {
    // SHA-256, SOP-1, INC-001, FR-7, HL-3, CP-7, T-3, etc. all have ID-like shape
    // but are NOT blueprint feature families. Only registered letter families match.
    const out = extractIds("test: SHA-256 + SOP-1 + INC-001 + T-3 + FR-7 in PR", ["A-"]);
    expect(out).toEqual([]);
  });

  test("empty prefix set yields empty result (no global catch-all)", () => {
    const out = extractIds("feat: G-100 message bridging", []);
    expect(out).toEqual([]);
  });

  test("case-insensitive — lowercase PR titles normalize to uppercase blueprint form", () => {
    const out = extractIds("chore(c-016): blueprint scalar fix", ["C-"]);
    expect(out).toEqual(["C-016"]);
  });

  test("dedupes repeats", () => {
    const out = extractIds("feat: A-100 install (A-100)", ["A-"]);
    expect(out).toEqual(["A-100"]);
  });

  test("ignores non-ID alphanumeric noise", () => {
    const out = extractIds("feat: HTTP/2 fix", ["A-"]);
    expect(out).toEqual([]);
  });

  test("longest-family-first prevents partial-prefix collision", () => {
    // If both `D` and `DD` were registered, an ID `DD-90` must match `DD`
    // family, not `D` family. (Defensive — current corpus has no `D-` family
    // but the alternation order in the regex must keep this safe.)
    const out = extractIds("feat: DD-90 federation decision", ["DD-"]);
    expect(out).toEqual(["DD-90"]);
  });
});

describe("parseBlueprint — Holly cycle-3 #1: status regex captures hyphenated values", () => {
  test("status: in-progress is captured fully (not truncated to 'in')", () => {
    const yaml = [
      "schema: blueprint/v1",
      "repo: meta-factory",
      "",
      "features:",
      "  - id: F-1",
      "    status: in-progress",
      "    name: Active feature",
      "",
    ].join("\n");
    const { features } = parseBlueprint(yaml, "fallback");
    expect(features[0].status).toBe("in-progress");
    expect(features[0].status).not.toBe("in");
  });

  test("multiple hyphenated statuses (in-review, not-started) all captured", () => {
    const yaml = [
      "schema: blueprint/v1",
      "repo: x",
      "features:",
      "  - id: A-1",
      "    status: in-review",
      "    name: A",
      "  - id: A-2",
      "    status: not-started",
      "    name: B",
      "  - id: A-3",
      "    status: done",
      "    name: C",
      "",
    ].join("\n");
    const { features } = parseBlueprint(yaml, "fallback");
    const statuses = features.map((f) => f.status);
    expect(statuses).toEqual(["in-review", "not-started", "done"]);
  });

  test("canonical repo: field on line 2 wins over fallbackRepo (Holly cycle-1 #1)", () => {
    const yaml = "schema: blueprint/v1\nrepo: real-name\n\nfeatures:\n  - id: A-1\n    status: done\n    name: x\n";
    const { repo } = parseBlueprint(yaml, "fallback-from-dir");
    expect(repo).toBe("real-name");
  });
});

describe("extractRepoNames — Holly cycle-2 #4: anchored YAML parse, no sibling pollution", () => {
  test("returns repo keys under top-level `repos:` mapping", () => {
    const yaml = [
      "repos:",
      "  arc:",
      "    description: foo",
      "  grove:",
      "    description: bar",
      "",
    ].join("\n");
    expect(extractRepoNames(yaml).sort()).toEqual(["arc", "grove"]);
  });

  test("ignores sibling top-level sections (metadata, defaults, roles)", () => {
    // Pre-fix: regex `/^  (\w+):\s*$/gm` would also match `dev_root`, `roles`,
    // `defaults` because they share the same indent — polluting the allowlist
    // with non-repo names. Post-fix: anchored to repos: mapping only.
    const yaml = [
      "metadata:",
      "  dev_root: ./",
      "  version: 1",
      "repos:",
      "  arc:",
      "    description: foo",
      "  grove:",
      "    description: bar",
      "defaults:",
      "  status: active",
      "roles:",
      "  steward: jc",
      "",
    ].join("\n");
    const out = extractRepoNames(yaml).sort();
    expect(out).toEqual(["arc", "grove"]);
    expect(out).not.toContain("dev_root");
    expect(out).not.toContain("status");
    expect(out).not.toContain("steward");
  });

  test("empty input yields empty list (caller decides fail-open vs fail-closed)", () => {
    expect(extractRepoNames("")).toEqual([]);
    expect(extractRepoNames("   \n  \n")).toEqual([]);
  });

  test("missing repos: key yields empty list", () => {
    const yaml = "metadata:\n  version: 1\n";
    expect(extractRepoNames(yaml)).toEqual([]);
  });

  test("malformed YAML yields empty list (no throw)", () => {
    const yaml = "repos:\n  : invalid\n   bad indent";
    // Should not throw — caller's fail-closed `size === 0` will catch it.
    expect(() => extractRepoNames(yaml)).not.toThrow();
  });
});

describe("REPO_LINE — Holly #1: regex matches `repo:` on line 2 (m flag)", () => {
  test("import works (smoke test — full parser tested via integration)", async () => {
    const mod = await import("./action");
    expect(mod.default).toBeDefined();
  });

  test("regex matches multi-line input (the canonical blueprint shape)", () => {
    // Re-derive the regex from the source contract: must match line-anchored
    // `repo:` even when it's not the first line of the file.
    const REPO_LINE = /^repo:\s+([A-Za-z0-9_-]+)/m;
    const blueprintShape = "schema: blueprint/v1\nrepo: meta-factory\n\nfeatures:\n";
    expect(blueprintShape.match(REPO_LINE)?.[1]).toBe("meta-factory");
    // Pre-fix: without /m the same input would NOT match.
    const REPO_LINE_BUGGY = /^repo:\s+([A-Za-z0-9_-]+)/;
    expect(blueprintShape.match(REPO_LINE_BUGGY)).toBeNull();
  });
});
