#!/usr/bin/env bash
# Confidentiality-gate policy classifier (design doc §4 L1).
#
# SINGLE SOURCE OF TRUTH for the gate's fork/same-repo × denylist-state ×
# require_denylist decision. The reusable workflow's "Gate policy" step calls this;
# scan/gate-policy.test.ts exercises it directly. Keeping the security-critical
# branch logic in ONE executed file means it cannot drift between the YAML and its
# test. It ships in the engine bundle, so the gate checks it out at the same
# immutable SHA it resolves for the engine — the classifier is byte-pinned to the
# gate.
#
# Inputs (env — secrets/attacker-controlled values are NEVER interpolated, only read):
#   IS_FORK           "true" ⇒ fork PR (untrusted, org secret unavailable); else same-repo (trusted)
#   DENYLIST          MF_CONFIDENTIALITY_DENYLIST payload (may be absent / empty / valid)
#   REQUIRE_DENYLIST  "false" ⇒ degrade to tiers 1+2 + warn on an absent denylist (BURN-IN only);
#                     anything else (incl. unset) ⇒ "true" — the SECURE DEFAULT: fail closed.
#
# Modes:
#   (default)          classify this run and emit GATE_DECISION (uses IS_FORK / DENYLIST /
#                      REQUIRE_DENYLIST above). Called by the workflow's "Gate policy" step.
#   assert-decision    validate the GATE_DECISION the classifier already emitted (from env)
#                      and FAIL CLOSED on anything not in {full,degraded}. Called by the
#                      scan step BEFORE it scans, so a step-order regression that skipped
#                      the classifier can't let the scan proceed tier-3-off (fail-open).
#
# Output:
#   Appends GATE_DECISION=<full|degraded> to $GITHUB_ENV (when set) for the scan step,
#   and echoes the same line to stdout (test capture + non-Actions runs).
#   Emits ::error:: / ::warning:: / ::notice:: annotations.
#   Exit 0 ⇒ proceed (full or degraded).
#   Exit 1 ⇒ FAIL CLOSED (same-repo, denylist absent/empty, require_denylist enforced;
#            or assert-decision saw an unset/empty/unknown GATE_DECISION).
set -euo pipefail

# The decision vocabulary — defined ONCE here and shared by the classifier (which
# EMITS it) and the scan step's `assert-decision` guard (which DEFENDS it), so the
# two can never drift. Add a new decision value in this one place.
is_known_decision() { case "${1:-}" in full|degraded) return 0 ;; *) return 1 ;; esac; }

emit_decision() {
  # $1 = full | degraded. Defensive: the classifier must never emit a value the
  # scan-step guard would later reject — fail closed if it somehow tries.
  if ! is_known_decision "$1"; then
    echo "::error::confidentiality-gate: internal — refusing to emit unknown GATE_DECISION '$1'. Failing closed."
    exit 1
  fi
  if [ -n "${GITHUB_ENV:-}" ]; then echo "GATE_DECISION=$1" >> "$GITHUB_ENV"; fi
  echo "GATE_DECISION=$1"
}

# ── assert-decision mode ── the scan step calls `gate-policy.sh assert-decision`
# BEFORE it scans. An unset/empty/unknown GATE_DECISION means the classifier did not
# run before the scan (e.g. a future step-order regression) — FAIL CLOSED rather than
# let the scan proceed with an undetermined tier-3 posture. Strictly additive: this
# only ADDS a fail-closed path, it never changes a reachable classify-mode outcome.
if [ "${1:-}" = "assert-decision" ]; then
  if is_known_decision "${GATE_DECISION:-}"; then exit 0; fi
  echo "::error::confidentiality-gate: GATE_DECISION='${GATE_DECISION:-}' is not one of full|degraded — the Gate policy classifier did not run before the scan (step-order regression?). Refusing to scan with an undetermined tier-3 posture. Failing closed."
  exit 1
fi

# ── classify mode (default): emit GATE_DECISION for this run. ──
IS_FORK="${IS_FORK:-}"
# Secure default: only an EXPLICIT "false" opts out of fail-closed. Unset / empty /
# any other value enforces — a caller that forgets the flag fails closed.
REQUIRE_DENYLIST="${REQUIRE_DENYLIST:-true}"

# Classify the denylist payload: absent | empty | valid. A PRESENT-BUT-EMPTY secret
# (the committed placeholder {"salt":"","entries":[]}, a salt-less doc, or
# unparseable JSON) must NOT count as "have denylist" — that would let tier 3 run
# silently INERT and ship green (re-review F2). Validate the STRUCTURE (non-empty
# salt AND ≥1 entry), not mere presence.
DL_STATE="valid"
if [ -z "${DENYLIST:-}" ]; then
  DL_STATE="absent"
elif ! printf '%s' "${DENYLIST}" | jq -e '(.salt // "") != "" and ((.entries // []) | length) > 0' >/dev/null 2>&1; then
  DL_STATE="empty"
fi

# ── Fork PR (untrusted) — ALWAYS degraded tiers 1+2; the org secret is unavailable
#    to forks, so tier 3 is legitimately off and require_denylist never applies here.
#    UNCHANGED.
if [ "$IS_FORK" = "true" ]; then
  if [ "$DL_STATE" != "valid" ]; then
    echo "::notice::confidentiality-gate DEGRADED — fork PR (denylist ${DL_STATE}): the denylist secret is unavailable to forks. Running tiers 1+2 only. A maintainer MUST run the full-denylist local gate before merging this fork PR (SOP OD-2)."
  fi
  emit_decision degraded
  exit 0
fi

# ── Same-repo (trusted) from here. ──

# Valid denylist → FULL scan tiers 1+2+3 (the scan step adds --require-denylist).
# UNCHANGED.
if [ "$DL_STATE" = "valid" ]; then
  emit_decision full
  exit 0
fi

# Same-repo + denylist absent/empty. The require_denylist input decides.
if [ "$REQUIRE_DENYLIST" = "false" ]; then
  # BURN-IN degrade (NEW): route down the SAME degraded path forks use — tiers 1+2,
  # tier 3 off — and WARN. Do NOT fail closed. The scan step omits --require-denylist,
  # so the engine degrades cleanly; findings from tiers 1+2 still fail the scan step.
  echo "::warning::confidentiality-gate BURN-IN — MF_CONFIDENTIALITY_DENYLIST is ${DL_STATE} on a same-repo run and require_denylist=false. Tier 3 is OFF: running tiers 1+2 only and WARNING (not failing closed). Populate the denylist and set require_denylist=true (the default) to ENFORCE before this repo leaves burn-in (SOP: gate rollout)."
  emit_decision degraded
  exit 0
fi

# Same-repo + denylist absent/empty + require_denylist enforced (secure default):
# FAIL CLOSED. UNCHANGED (preserves fix-8) — a mis-wired secret must not ship green
# with tier 3 silently off.
echo "::error::confidentiality-gate: MF_CONFIDENTIALITY_DENYLIST is ${DL_STATE} on a same-repo run (a placeholder like {\"salt\":\"\",\"entries\":[]} counts as empty) and require_denylist=true. Tier 3 would be silently OFF. Add/repair the org secret (Settings ▸ Secrets ▸ Actions ▸ MF_CONFIDENTIALITY_DENYLIST ▸ selected public repos), or set require_denylist=false ONLY for burn-in. Failing closed."
exit 1
