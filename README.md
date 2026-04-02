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
