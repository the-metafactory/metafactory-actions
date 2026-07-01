# metafactory-actions

Shared actions and flows for the metafactory ecosystem. An [arc](https://github.com/the-metafactory/arc) library containing 22 independent actions and 6 orchestration flows, all runnable via [pulse](https://github.com/the-metafactory/pulse).

## Install

Requires [arc](https://github.com/the-metafactory/arc) v0.9.1+.

```bash
arc install metafactory-actions                    # all 28 artifacts
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

## Flows

Flows orchestrate actions into pipelines. Each flow has a `flow.yaml` (source/destination) and `pipeline.yaml` (action sequence).

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

Drop this into each public repo (**pin both by commit SHA** — a floating ref is a
check-name-spoof vector; the gate self-checks and warns if you don't):

```yaml
# .github/workflows/confidentiality.yml
name: confidentiality
on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: "17 4 * * 1"   # weekly history scan
jobs:
  gate:
    uses: the-metafactory/metafactory-actions/.github/workflows/confidentiality-gate.yml@<PIN-40-HEX-SHA>
    secrets: inherit        # passes MF_CONFIDENTIALITY_DENYLIST (+ optional CONF_DENYLIST_PEPPER)
  alert:
    if: ${{ github.event_name == 'push' }}
    uses: the-metafactory/metafactory-actions/.github/workflows/confidentiality-push-alert.yml@<PIN-40-HEX-SHA>
    secrets: inherit        # passes MF_OPS_DISCORD_WEBHOOK
```

Then add the observed `confidentiality-gate` check to the repo's **required
status checks** (the exact context name is read from the first run — see the
compass rollout tooling).

### Degraded-fork contract (never fails open silently)

- **Same-repo run without the denylist secret → HARD FAIL** naming the org-secret
  visibility list. The denylist tier is never silently skipped on a trusted run.
- **Fork PR → DEGRADED mode**: the org secret is unavailable to forks by design,
  so the gate runs **tiers 1+2 only** and emits a visible `::notice::`. A maintainer
  **must** run the full-denylist local gate before merging a fork PR (SOP OD-2).
- **gitleaks (tier 1)** is pinned by version **and sha256-verified**, then cached —
  a release-download flake can't fail checks org-wide (the tier is skipped, tiers
  2+3 still gate). A sha256 **mismatch** skips tier 1 rather than running an
  unverified binary.
- Findings are **masked** by the engine (no matched literal, no digest);
  `::add-mask::` registers raw matches with the runner before any finding line.
- The engine is checked out at the **same ref the gate was pinned to**
  (`job_workflow_ref`), so a SHA-pinned caller gets a SHA-matched engine.
