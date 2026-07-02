import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Directly exercise the confidentiality-gate classification (scan/gate-policy.sh),
// the single source of truth the reusable workflow's "Gate policy" step calls. The
// branch logic is security-critical, so we run the REAL script (no re-implemented
// copy that could drift from the YAML) across every fork/same-repo × denylist-state
// × require_denylist combination.
const SCRIPT = join(import.meta.dir, "gate-policy.sh");

// Structurally valid: non-empty salt AND ≥1 entry. Synthetic — no real denylist.
const VALID_DENYLIST = JSON.stringify({ salt: "s1", entries: ["abc123"] });
// Present-but-empty placeholder — must NOT count as "have denylist" (re-review F2).
const EMPTY_DENYLIST = JSON.stringify({ salt: "", entries: [] });

interface PolicyResult {
  code: number;
  stdout: string;
  decision: string | null; // GATE_DECISION appended to $GITHUB_ENV, or null if none
}

function runPolicy(overrides: Record<string, string | undefined>): PolicyResult {
  const dir = mkdtempSync(join(tmpdir(), "mf-gate-policy-"));
  const githubEnv = join(dir, "github_env");
  try {
    // Bun.spawnSync REPLACES the environment — carry PATH/HOME (jq + bash), then
    // clear the three classification inputs so an omitted override means "absent".
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
    delete env.IS_FORK;
    delete env.DENYLIST;
    delete env.REQUIRE_DENYLIST;
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
    env.GITHUB_ENV = githubEnv;

    const proc = Bun.spawnSync(["bash", SCRIPT], { env, stdout: "pipe", stderr: "pipe" });
    const stdout = proc.stdout ? new TextDecoder().decode(proc.stdout) : "";
    let decision: string | null = null;
    if (existsSync(githubEnv)) {
      const m = readFileSync(githubEnv, "utf8").match(/GATE_DECISION=(\w+)/);
      if (m) decision = m[1];
    }
    return { code: proc.exitCode ?? 1, stdout, decision };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// `gate-policy.sh assert-decision` — the scan-step guard. Validates the
// GATE_DECISION the classifier already emitted (read from env), independent of the
// classify-mode inputs. `undefined` ⇒ the variable is unset.
function runAssert(gateDecision: string | undefined): { code: number; stdout: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") env[k] = v;
  delete env.GATE_DECISION;
  if (gateDecision !== undefined) env.GATE_DECISION = gateDecision;
  const proc = Bun.spawnSync(["bash", SCRIPT, "assert-decision"], { env, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode ?? 1, stdout: proc.stdout ? new TextDecoder().decode(proc.stdout) : "" };
}

describe("gate-policy.sh — confidentiality-gate classification", () => {
  // ── UNCHANGED: fork PR (untrusted, secret unavailable) → degraded tiers 1+2 ──
  test("fork PR + denylist absent → degraded, exit 0, fork notice", () => {
    const r = runPolicy({ IS_FORK: "true" });
    expect(r.code).toBe(0);
    expect(r.decision).toBe("degraded");
    expect(r.stdout).toMatch(/DEGRADED — fork PR/);
  });

  test("fork PR is degraded even when require_denylist=true (flag never affects forks)", () => {
    const r = runPolicy({ IS_FORK: "true", REQUIRE_DENYLIST: "true" });
    expect(r.code).toBe(0);
    expect(r.decision).toBe("degraded");
    expect(r.stdout).not.toMatch(/::error::/);
  });

  // ── UNCHANGED: same-repo + valid denylist → full scan tiers 1+2+3 ──
  test("same-repo + valid denylist → full, exit 0", () => {
    const r = runPolicy({ IS_FORK: "false", DENYLIST: VALID_DENYLIST });
    expect(r.code).toBe(0);
    expect(r.decision).toBe("full");
  });

  test("same-repo + valid denylist + require_denylist=false → still full (flag only gates ABSENT)", () => {
    const r = runPolicy({ IS_FORK: "false", DENYLIST: VALID_DENYLIST, REQUIRE_DENYLIST: "false" });
    expect(r.code).toBe(0);
    expect(r.decision).toBe("full");
  });

  // ── UNCHANGED (fix-8): same-repo + absent/empty + require_denylist=true → FAIL CLOSED ──
  test("same-repo + denylist absent + require_denylist=true → fail closed (exit 1, ::error::, no decision)", () => {
    const r = runPolicy({ IS_FORK: "false", REQUIRE_DENYLIST: "true" });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/::error::/);
    expect(r.decision).toBeNull();
  });

  test("SECURE DEFAULT: same-repo + absent + require_denylist UNSET → fail closed", () => {
    const r = runPolicy({ IS_FORK: "false" });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/::error::/);
  });

  test("same-repo + empty-placeholder denylist + require_denylist=true → fail closed", () => {
    const r = runPolicy({ IS_FORK: "false", DENYLIST: EMPTY_DENYLIST, REQUIRE_DENYLIST: "true" });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/::error::/);
  });

  test("unparseable denylist JSON is treated as empty (not valid) → fail closed under enforce", () => {
    const r = runPolicy({ IS_FORK: "false", DENYLIST: "not json at all", REQUIRE_DENYLIST: "true" });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/::error::/);
  });

  // ── NEW: same-repo + absent/empty + require_denylist=false → degrade tiers 1+2 + WARN ──
  test("BURN-IN: same-repo + denylist absent + require_denylist=false → degrade, exit 0, ::warning:: (no ::error::)", () => {
    const r = runPolicy({ IS_FORK: "false", REQUIRE_DENYLIST: "false" });
    expect(r.code).toBe(0);
    expect(r.decision).toBe("degraded");
    expect(r.stdout).toMatch(/::warning::.*[Bb]urn-?in/);
    expect(r.stdout).not.toMatch(/::error::/);
  });

  test("BURN-IN: same-repo + empty-placeholder denylist + require_denylist=false → degrade + warn", () => {
    const r = runPolicy({ IS_FORK: "false", DENYLIST: EMPTY_DENYLIST, REQUIRE_DENYLIST: "false" });
    expect(r.code).toBe(0);
    expect(r.decision).toBe("degraded");
    expect(r.stdout).toMatch(/::warning::/);
    expect(r.stdout).not.toMatch(/::error::/);
  });
});

describe("gate-policy.sh assert-decision — scan-step guard (refactor-proof, fail-closed)", () => {
  // Known decisions the classifier emits → proceed.
  test("GATE_DECISION=full → exit 0", () => {
    expect(runAssert("full").code).toBe(0);
  });

  test("GATE_DECISION=degraded → exit 0", () => {
    expect(runAssert("degraded").code).toBe(0);
  });

  // The fail-open we're closing: an undetermined decision must NOT reach the scan.
  test("GATE_DECISION unset → FAIL CLOSED (exit 1, ::error::)", () => {
    const r = runAssert(undefined);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/::error::/);
  });

  test("GATE_DECISION empty → FAIL CLOSED", () => {
    const r = runAssert("");
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/::error::/);
  });

  test("GATE_DECISION unknown value → FAIL CLOSED (never falls through to a scan)", () => {
    const r = runAssert("bogus");
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/::error::/);
  });
});
