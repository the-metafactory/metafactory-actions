# Confidentiality scan engine

The shared, public-safe scan engine for the metafactory confidentiality program
(design doc §3/§4 L1, umbrella compass#81). **One engine, one denylist, many
consumers**: this engine is authored once here and driven by git hooks (L5), the
reusable CI gate (L1, PR 2), and future surface gates (L6).

> **Public-repo discipline is absolute.** This directory contains only generic
> shapes and the metafactory org's own PUBLIC brand domains. No client names, no
> real emails, no live platform IDs — in code, patterns, tests, or fixtures. A
> populated denylist is **never** committed here.

## What it detects

| Tier | Source | Catches |
|---|---|---|
| 1 | `gitleaks` (pinned binary, shelled out when present) | credential/secret shapes |
| 2 | `public-patterns.yaml` (this repo) | internal-domain emails, `STD-<ORG>-AI-###` compliance-code shape, 17–20-digit platform IDs, seed identities |
| 3 | salted-SHA-256 **hashed denylist** supplied at runtime | client/engagement terms (identifier-aware) |

Tier 2 shapes (public-safe by construction):

- **internal-domain email** — an address at a metafactory brand domain (`@meta-factory.{ai,dev,io}`). Sanctioned system addresses (`noreply@…`, `support@…`, GitHub noreply) are carved out.
- **compliance-code shape** — `STD-<ORG>-AI-###`. Sanctioned placeholders `STD-EX-AI-001` and `STD-EXAMPLE-AI-001` are carved out (and the carve-out is self-tested to actually match the detection shape).
- **platform ID** — a standalone 17–20-digit number. Test files **are** in scope. All-zero (`000000000000000000`) and all-same-digit placeholders are allowed.
- **seed identity** — a real-looking email in a seed/migration file (`**/migrations/**`, `**/seeds/**`, `*.sql`, `*seed*`). Only RFC-reserved placeholder domains (`example.com`, `.test`, …) pass.

## Output discipline — masked, no digests

Findings are **masked**: `file:line`, tier/rule-id, and a static shape descriptor
only. The engine **never** emits the matched literal, a hash of it, or any
reversible digest (design doc §4 L1: "no token digests of any kind in public
output" — closes the reversible-hash self-leak). Tier-3 findings print the
denylist **entry id + class** (e.g. `[tier3:client-0007] denylist:client-name`);
triage the id via the private compass denylist tool. Under GitHub Actions the
engine emits `::add-mask::` for every raw match **before** any finding line, so
even accidental downstream echoes are redacted by the runner.

## Usage

```bash
# changed lines of a PR / staged commit
bun scan/confidentiality-scan.ts diff --staged
bun scan/confidentiality-scan.ts diff --range origin/main...HEAD

# whole working tree (tracked + untracked, .gitignore honored)
bun scan/confidentiality-scan.ts tree

# every reachable blob (weekly history scan)
bun scan/confidentiality-scan.ts history

# JSON output (masked findings only)
bun scan/confidentiality-scan.ts diff --staged --json
```

Flags: `--staged`, `--range <A..B>`, `--denylist <path>`, `--patterns <path>`,
`--extra-text <str>` (repeatable — PR title/body/branch), `--no-gitleaks`,
`--fail-on-warn`, `--json`, `--cwd <path>`.

**Exit codes:** `0` clean · `1` one-or-more BLOCK findings (or a warn with
`--fail-on-warn`) · `3` engine/config error (fail-closed).

## The denylist is supplied at runtime — never committed

`denylist.hashed.json` in this repo is an **empty placeholder**; tier 3 is inert
while its salt is empty. A populated, salted-SHA-256 hashed denylist is delivered
at runtime and is never committed to this public repo:

- **CI:** the `MF_CONFIDENTIALITY_DENYLIST` org secret (visibility: selected
  public repos). Fork PRs run tiers 1+2 only (degraded, with a visible notice).
- **Hooks:** the private installed path
  `~/.config/metafactory/pkg/repos/compass/confidentiality/…`.

Precedence: `--denylist <path>` > `MF_CONFIDENTIALITY_DENYLIST` env > bundled
placeholder. Malformed denylist JSON **fails closed** (the engine refuses to run
tier 3 rather than silently skipping it).

The canonical **plaintext** denylist lives only in PRIVATE compass. Its salted
hashes are produced by the shared `buildHashedDenylist()` helper (same hashing
definition on the build side and the match side).

## Git hooks (L5)

```bash
# global install: sets core.hooksPath, bakes the engine path, chains to repo-local hooks,
# and detects/(with --unset)removes repo-local core.hooksPath overrides that would shadow it (G17)
bun scan/install-hooks.ts install --global --engine "$PWD/scan/confidentiality-scan.ts" --unset

# per-repo install (into .git/hooks)
bun scan/install-hooks.ts install --repo /path/to/repo --engine "$PWD/scan/confidentiality-scan.ts"

# verify the chain — FAILS LOUDLY (non-zero) on a broken/shadowed chain
bun scan/install-hooks.ts doctor

# remove
bun scan/install-hooks.ts uninstall --global
```

- **pre-commit** scans staged changes (`diff --staged`).
- **pre-push** scans the outgoing range per ref, gating on the actual push-remote
  URL (`$2`) with a per-range perf cap; it is the stale-clone re-leak control.
- Both **chain to any repo-local hook first** so existing hooks are not shadowed.
- **Bypass** (velocity by design — CI + push-alert are the backstops):
  `CONFIDENTIALITY_SKIP=1` or `git commit/push --no-verify`. Skip usage is tracked in retro.

## Tests

```bash
bun test scan/
```

Covers every pattern class (positive + negative) with **synthetic fixtures built
at runtime** (so the engine's own tree stays scan-clean), the compliance-code
carve-out self-test, masking (output never contains a matched literal), the
hashed-denylist tier + identifier-aware matching, unified-diff line accuracy, a
temp-git-repo integration test asserting correct `file:line`, and the installer's
`core.hooksPath`-shadowing detection.
