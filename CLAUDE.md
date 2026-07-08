# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Bun/TypeScript CLI that auto-sorts your starred GitHub repositories into GitHub Stars Lists using Claude. It fetches every star, classifies each repo (multi-label) with `claude-haiku-4-5`, routes abandoned/archived/deprecated repos into a dedicated list, and writes the assignments back via GraphQL mutations.

## Commands

```sh
bun install                              # install deps
bun test                                 # run all tests (only src/rules.test.ts exists)
bun test src/rules.test.ts               # run a single test file
bun test -t "isAbandoned"                # run tests matching a name

bun run src/main.ts                      # dry run: build report.md, write nothing (default)
bun run src/main.ts --apply              # write assignments to your account
bun run src/main.ts --limit 20           # operate on a subset
bun run src/main.ts --resort [--apply]   # re-check already-sorted repos against abandonment rules
bun run src/main.ts --recategorize [--apply]  # re-run AI over previously-sorted repos under the current taxonomy
```

There is no build/lint step; Bun runs the TypeScript directly. Requires `gh` authenticated with the `user` scope (`gh auth refresh -h github.com -s user`) and `ANTHROPIC_API_KEY` (env or `.env`, which Bun loads automatically).

## Architecture

Data flows: `github.ts` (fetch) → `rules.ts` (decide) → `classify.ts` (AI) → `main.ts` (orchestrate report/write).

- **`config.ts`** — the single source of truth for the taxonomy. `CATEGORIES` maps a stable `slug` (the enum key the model returns) → `listName` (must match a real GitHub list name exactly) → `description` (fed to the prompt). Also defines the special `Abandoned`/`Uncategorized` lists and the `Repo` type. **Edit categories here.**
- **`rules.ts`** — pure, side-effect-free decision logic (no IO/network/SDK), which is why it is the only tested module. Abandonment (`isAbandoned`/`abandonReason`), slug↔list-name mapping, cache normalization/pruning, drift detection, and `desiredListNames` (the manual-vs-managed merge for `--recategorize`).
- **`classify.ts`** — Anthropic call in batches of 40 with a strict JSON-schema (`output_config.format`) enum over `ALL_SLUGS`, plus retry/backoff. Returns `nameWithOwner → slug[]`.
- **`github.ts`** — all GitHub access shells out to `gh api graphql` (Stars Lists are GraphQL-only; mutations need the `user` scope). Handles pagination, secondary-rate-limit/transient backoff, and `repairMissingCommits` (re-fetches `committedDate` when a paginated query flakily returns `defaultBranchRef=null`).
- **`main.ts`** — three modes (default sort / `--resort` / `--recategorize`), report generation, and throttled writing (~250 ms/mutation).

## Invariants that matter

- **Only "naked" stars are touched in the default mode** — repos already filed into any list by hand are left alone. `--resort`/`--recategorize` operate only on repos the tool itself previously filed (tracked in `cache.json`).
- **Abandonment is decided by `lastCommit` (default-branch `committedDate`), not `pushedAt`** — `pushedAt` is bumped by tags/branches without commits. Plus archived flag and deprecation keywords (`DEAD_RE`) in the description. Threshold: 2 years.
- **`setRepoLists` (`updateUserListsForItem`) has SET semantics** — it replaces a repo's *entire* list membership with the ids you pass. Callers must include manual lists to preserve them (see `desiredListNames`). This is why it's safe on naked stars but dangerous otherwise.
- **`cache.json`** persists AI decisions (`decisions`: repoId → slug[]) so re-runs don't re-ask the model and interrupted runs resume, and tool-managed list ids (`managed`) so a list renamed in the GitHub UI is still recognized by id (not mistaken for a manual list). A list renamed *before* its id was ever recorded won't be recognized. Prefer `--recategorize` over deleting the cache — deleting it wipes the tool's ownership record.
- After editing the taxonomy in `config.ts`, run `--recategorize` (not cache deletion) to re-sort. Renaming a `listName` without also renaming/deleting the list on GitHub spawns a duplicate list.
