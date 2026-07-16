# metafactory-actions

Shared actions and flows for the metafactory ecosystem. An [arc](https://github.com/the-metafactory/arc) library containing 28 independent actions and 8 orchestration flows, all runnable via [pulse](https://github.com/the-metafactory/pulse).

## Install

Requires [arc](https://github.com/the-metafactory/arc) v0.9.1+.

```bash
arc install metafactory-actions                    # all 36 artifacts
arc install metafactory-actions:A_DISCOVER_REPOS   # single action
arc install metafactory-actions:F_NEXT_PICK        # single flow
```

## Actions

Actions are independent, composable units. Each has an `action.json` manifest and `action.ts` implementation. They connect via pulse's passthrough pattern -- data accumulates through the pipeline, each action takes what it needs and passes the rest through.

| Action | Description | Requires |
|--------|-------------|----------|
| **A_DISCOVER_REPOS** | Discover all repos in the-metafactory GitHub org | shell |
| **A_FETCH_REPOS** | Fetch recent GitHub activity across repos | shell |
| **A_GATHER_WORK** | Gather open work items from issues, PRs, blueprints | shell |
| **A_RANK_WORK** | Score and rank work items, LLM selects best next task | llm |
| **A_FORMAT_PICK** | Format top pick with reasoning for display | -- |
| **A_CHECK_BLUEPRINT** | Check blueprint feature status across ecosystem | shell |
| **A_BLUEPRINT_STATUS** | Run blueprint CLI to get feature health | shell |
| **A_EXTRACT_ACTIONS** | Extract operator action items from repo activity | -- |
| **A_SUMMARIZE_DIGEST** | LLM-summarize ecosystem activity into daily digest | llm |
| **A_FORMAT_DISCORD** | Format digest as Discord message and post | fetch |
| **A_ARC_UPGRADE** | Run arc upgrade for repos with arc-manifest.yaml | shell |
| **A_FORMAT_UPGRADE** | Format arc upgrade results as readable digest | -- |
| **A_SYNC_REPOS** | Pull latest changes for all metafactory repos | shell |
| **A_FORMAT_SYNC** | Format sync results as readable digest | -- |
| **A_FETCH_FEED** | Fetch and parse an RSS feed into items | fetch |
| **A_EXTRACT_ARTICLE** | Extract article content from feed item URLs | fetch |
| **A_RATE** | Rate articles for relevance using LLM | llm |
| **A_RECOMMEND** | Rank rated articles into recommendation digest | llm |
| **A_COLLECT_WORK** | Collect work items for timezone handover | shell |
| **A_GATHER_THREADS** | Gather active discussion threads for handover | shell, fetch |
| **A_WRITE_HANDOVER** | Write handover digest using LLM | llm |
| **A_DELIVER** | Deliver handover to Discord/Slack | fetch |
| **A_GATHER_PR_STATS** | Gather merged PR data per repo for time-series charting | shell |
| **A_RENDER_PR_CHART** | Render dual Chart.js visualization of PR activity | writeFile |
| **A_FETCH_BLUEPRINTS** | Walk dev_root, parse every blueprint.yaml, emit per-repo feature index | shell |
| **A_SCAN_PR_FEATURE_IDS** | Per repo, list merged PRs and extract feature IDs from titles | shell |
| **A_DETECT_DRIFT** | Cross-reference blueprint features vs merged PRs; surface drift | shell |
| **A_COUNT_DOWNLOADS** | Count package downloads per package from the production or dev audit log (D1) | shell |

## Flows

Flows orchestrate actions into pipelines. Each flow has a `flow.yaml` (source/destination) and `pipeline.yaml` (action sequence).

Once installed (`arc install metafactory-actions`), run flows directly by name — no need to point pulse at a pipeline.yaml path:

```bash
pulse flow list          # discover installed flows
pulse flow run F_PR_STATS
```

### F_NEXT_PICK

Scan all metafactory repos and blueprints for open work, rank by importance, select the single best thing to work on next.

```
A_DISCOVER_REPOS → A_GATHER_WORK → A_RANK_WORK → A_FORMAT_PICK
```

### F_ECOSYSTEM_DIGEST

Daily ecosystem digest: fetch GitHub activity, check blueprint status, summarize via LLM, post to Discord.

```
A_FETCH_REPOS → A_CHECK_BLUEPRINT → A_SUMMARIZE_DIGEST → A_FORMAT_DISCORD
```

### F_HANDOVER_DIGEST

Timezone handover: collect recent work, gather discussion threads, write a handover digest, deliver to Discord.

```
A_COLLECT_WORK → A_GATHER_THREADS → A_WRITE_HANDOVER → A_DELIVER
```

### F_ARC_UPGRADE

Run `arc upgrade` for all metafactory repos that have an arc-manifest.yaml.

```
A_DISCOVER_REPOS → A_ARC_UPGRADE → A_FORMAT_UPGRADE
```

### F_SYNC_REPOS

Pull latest changes for all metafactory repos, clone any new ones.

```
A_SYNC_REPOS → A_FORMAT_SYNC
```

### F_RSS_PIPELINE

Fetch an RSS feed, extract article content, rate for relevance, generate recommendation digest.

```
A_FETCH_FEED → A_EXTRACT_ARTICLE → A_RATE → A_RECOMMEND
```

### F_PR_STATS

Merged PR stats across the metafactory ecosystem — dual Chart.js visualization (cumulative line + daily stacked bar + combined total).

```
A_DISCOVER_REPOS → A_GATHER_PR_STATS → A_RENDER_PR_CHART
```

```bash
pulse flow run F_PR_STATS
open /tmp/mf-pr-stats.html
```

Defaults (override via flow input): `org: the-metafactory`, `sinceDate: 2026-03-26`, `excludeRepos: ["content-filter"]`, `outputPath: /tmp/mf-pr-stats.html`.

### F_BLUEPRINT_DRIFT

Walk every `blueprint.yaml` in the ecosystem, scan merged PRs for feature IDs, surface `MISSING` and `STALE_STATUS` drift between blueprint state and what actually shipped.

```
A_FETCH_BLUEPRINTS → A_SCAN_PR_FEATURE_IDS → A_DETECT_DRIFT
```

```bash
pulse flow run F_BLUEPRINT_DRIFT
```

## Structure

```
metafactory-actions/
├── arc-manifest.yaml          # Library root (type: library)
├── types.ts                   # Shared ActionContext type
├── actions/
│   ├── A_DISCOVER_REPOS/      # Each action: action.json + action.ts + arc-manifest.yaml
│   ├── A_FETCH_REPOS/
│   └── ...
└── flows/
    ├── F_NEXT_PICK/           # Each flow: flow.yaml + pipeline.yaml + arc-manifest.yaml
    ├── F_ECOSYSTEM_DIGEST/
    └── ...
```

## Design Principles

- **Actions are independent.** No action imports or references another action. Dependencies emerge from pipeline sequencing alone.
- **Passthrough data model.** Each action spreads upstream data through: `return { ...upstream, myNewField }`. Data accumulates as it flows through the pipeline.
- **Capability injection.** Actions declare what they need (shell, llm, fetch) in `action.json`. The runtime provides implementations -- same code runs locally or in the cloud.
- **Flat action directory.** All actions live in `actions/` regardless of which flow uses them. An action can appear in multiple flows.

## Consolidated from

This repo replaces actions previously scattered across:
- `pulse/examples/` (next-pick, ecosystem-digest, arc-upgrade, sync-repos, rss-pipeline)
- `ecosystem-digest` (standalone repo)
- `handover-digest` (standalone repo)

## Confidentiality gate — caller usage

Two **reusable workflows** (design doc §4 L1/L5, umbrella compass#81) that every
public repo calls to keep client-confidential content out of the tree, the
history, and the merge-bypass path. They drive the shared scan engine in
[`scan/`](scan/README.md).

- `.github/workflows/confidentiality-gate.yml` — required status check. Runs the
  engine in `diff` mode on PRs, `tree` on push, `history` on schedule.
- `.github/workflows/confidentiality-push-alert.yml` — detects merge-bypass on the
  default branch (forced push, direct push, **zero-approval merge = `--admin`**),
  alerts the private ops channel (with SHA) + opens a **SHA-free** public issue.

Drop this into each public repo. **Pin both by 40-hex commit SHA** — a branch/tag
ref is movable (check-name-spoof + it would select the engine too), and the gate
now **fails closed** if it cannot resolve an immutable engine SHA. **Pass that same
SHA as the gate's `engine_sha` input** — it is REQUIRED and is what pins the scan
engine (`github.job_workflow_sha` is empty on cross-repo caller runs, so the gate
cannot derive the SHA itself). **Pass only the named secrets** — never
`secrets: inherit` (that hands every caller secret to the reusable workflow; scope
the blast radius to just what the gate needs):

```yaml
# .github/workflows/confidentiality.yml
name: confidentiality
on:
  pull_request:            # NOT pull_request_target — the gate refuses it (fail-open/secret-exposure footgun)
  push:
    branches: [main]
  schedule:
    - cron: "17 4 * * 1"   # weekly history scan
jobs:
  gate:
    uses: the-metafactory/metafactory-actions/.github/workflows/confidentiality-gate.yml@<PIN-40-HEX-SHA>
    with:
      # REQUIRED. Set to the SAME 40-hex SHA you pin `uses:@` at above. This is the
      # engine's immutability anchor — github.job_workflow_sha is empty on caller
      # runs, so the gate cannot derive it and needs this explicit pin.
      engine_sha: <PIN-40-HEX-SHA>
    secrets:
      MF_CONFIDENTIALITY_DENYLIST: ${{ secrets.MF_CONFIDENTIALITY_DENYLIST }}
      CONF_DENYLIST_PEPPER: ${{ secrets.CONF_DENYLIST_PEPPER }}   # optional; omit if unused
  alert:
    if: ${{ github.event_name == 'push' }}
    uses: the-metafactory/metafactory-actions/.github/workflows/confidentiality-push-alert.yml@<PIN-40-HEX-SHA>
    secrets:
      MF_OPS_DISCORD_WEBHOOK: ${{ secrets.MF_OPS_DISCORD_WEBHOOK }}
```

Then add the observed `confidentiality-gate` check to the repo's **required
status checks** (the exact context name is read from the first run — see the
compass rollout tooling).

### Burn-in vs. enforce (`require_denylist` input)

A repo adopting the gate enters **burn-in**: the workflow is present but warn-only
and the org denylist secret is not yet populated. Fail-closed-on-absent is correct
when **enforcing**, but it would fail closed on *every* same-repo PR during burn-in —
so burn-in would validate nothing. The `require_denylist` input picks the posture:

| `require_denylist` | Same-repo + denylist absent/empty | Purpose |
|---|---|---|
| `true` **(default)** | **FAIL CLOSED** (`::error::`, exit 1) | **Enforce.** A mis-wired secret can't ship green with tier 3 off (fix-8). |
| `false` | **DEGRADE** to tiers 1+2 + `::warning::` (never fails closed) | **Burn-in only.** Same degraded path fork PRs use — validate tiers 1+2 while the denylist is populated. |

The default is `true` — a caller that forgets the flag fails closed (secure default).
A same-repo run **with a valid denylist** always runs the full tiers 1+2+3 scan
regardless of this input; the flag only governs the absent/empty case. Set
`require_denylist: false` on the `with:` of the reusable-workflow call **only** while
a repo is in burn-in, and remove it (revert to enforce) before the gate becomes a
required check:

```yaml
  gate:
    uses: the-metafactory/metafactory-actions/.github/workflows/confidentiality-gate.yml@<PIN-40-HEX-SHA>
    with:
      engine_sha: <PIN-40-HEX-SHA>   # REQUIRED — same 40-hex SHA you pin uses:@ at (see caller usage above)
      require_denylist: false        # BURN-IN ONLY — degrade same-repo to tiers 1+2 + warn; remove to enforce
    secrets:
      MF_CONFIDENTIALITY_DENYLIST: ${{ secrets.MF_CONFIDENTIALITY_DENYLIST }}
      CONF_DENYLIST_PEPPER: ${{ secrets.CONF_DENYLIST_PEPPER }}   # optional; omit if unused
```

### Degraded-fork contract (never fails open silently)

- **Same-repo run without the denylist secret → HARD FAIL** (when enforcing —
  `require_denylist: true`, the default) naming the org-secret visibility list. The
  denylist tier is never silently skipped on a trusted run. During **burn-in**
  (`require_denylist: false`) the same-repo path degrades to **tiers 1+2 + a
  `::warning::`** instead — see "Burn-in vs. enforce" above.
- **Fork PR → DEGRADED mode**: the org secret is unavailable to forks by design,
  so the gate runs **tiers 1+2 only** and emits a visible `::notice::`. A maintainer
  **must** run the full-denylist local gate before merging a fork PR (SOP OD-2).
  `require_denylist` never affects forks — they are always degraded.
- **gitleaks (tier 1)** is pinned by version **and sha256-verified on every run,
  including cache restores** — the tarball is re-verified before use and the binary
  re-extracted from it, so a poisoned cache cannot slip an unverified binary past the
  pin. A download flake or sha256 **mismatch** skips tier 1 (tiers 2+3 still gate)
  rather than running an unverified/tampered binary. gitleaks runs against a
  **pinned trusted config** (`--gitleaks-config`), so an in-tree `.gitleaks.toml`
  in the caller repo cannot disable tier 1.
- The scan runs `bun` from a **trusted working directory** (`runner.temp`), never
  the caller checkout, and scans the tree via `--target` — so a `bunfig.toml`
  (`preload`) planted in a PR cannot execute code in the secret-bearing gate job.
- Findings are **masked** by the engine (no matched literal, no digest);
  `::add-mask::` registers raw matches with the runner before any finding line.
- **Diff mode is fail-closed**: the gate fetches and verifies the PR base ref and
  asserts the scan range covers the PR's changed files — a git/fetch error or an
  empty range never reads as "clean."
- The engine is checked out at the **immutable commit SHA** the caller passes as the
  required `engine_sha` input (set to the same SHA the reusable is pinned at in
  `uses:@`), so the engine is byte-matched to the gate. `github.job_workflow_sha` is
  empty on cross-repo caller runs and is kept only as a non-empty fallback. The engine
  **repository is hardcoded** (`the-metafactory/metafactory-actions`) — never a caller
  input — so a caller can only pin a metafactory-actions SHA, not redirect the checkout.
  A movable tag or floating `main` can no longer select the engine; the gate fails
  closed if `engine_sha` is not a 40-hex commit and no valid fallback exists.

## validate-manifest — caller usage

The **reusable workflow** [`validate-manifest.yml`](.github/workflows/validate-manifest.yml)
(skill-estate migration WS2, [arc#316](https://github.com/the-metafactory/arc/issues/316))
is the shared CI floor for skill repos: it installs a pinned
[arc](https://github.com/the-metafactory/arc) and runs `arc validate` over the
repo's `arc-manifest.yaml`. A clean manifest passes; any strict `arc/v1`
contract violation fails the check, one line per violation.

Drop this into each skill repo. It validates the repo's own manifest at the
pushed commit — no inputs required. **Pin by 40-hex commit SHA** (a branch/tag ref
is movable):

```yaml
# .github/workflows/validate-manifest.yml
name: validate-manifest
on:
  pull_request:
  push:
    branches: [main]
jobs:
  validate:
    uses: the-metafactory/metafactory-actions/.github/workflows/validate-manifest.yml@<PIN-40-HEX-SHA>
```

Then add the observed `validate-manifest` check to the repo's **required status
checks**.

Notes:

- **arc is pinned inside the reusable** to the commit that introduced `arc
  validate` (not yet in an arc release tag). Re-pin the `arc_ref` default to the
  first arc release tag that carries `arc validate` when one ships.
- The manifest is read from the repo root by default; set `manifest_path` on the
  `with:` if the manifest lives in a subdirectory.
- To validate a **different** repo (e.g. a driver/proof run), pass `target_repo`
  and `target_ref`; for a **private** target, also pass a `target_token` secret
  with read access to it. Self-validation and public targets need neither — the
  job's `GITHUB_TOKEN` covers them.

