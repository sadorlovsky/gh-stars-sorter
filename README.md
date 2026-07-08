# gh-stars-sorter

Auto-sort your starred GitHub repositories into [Stars Lists](https://docs.github.com/en/get-started/exploring-projects-on-github/saving-repositories-with-stars#organizing-starred-repositories-with-lists) using AI.

It fetches all your stars, figures out what each repo is (Claude Haiku), files it into one of your existing lists, and routes abandoned / archived / deprecated repos into a dedicated list.

## How it works

- **Read/write** goes through `gh api graphql` — Stars Lists are only exposed in GraphQL, and the mutations require the `user` OAuth scope.
- **Abandonment** is decided by the last commit date on the default branch (`committedDate`), not `pushedAt` (which gets bumped by tags/branches without any commits), plus deprecation keywords in the description (`deprecated`, `unmaintained`, …).
- **Classification** runs in batches through the Anthropic SDK with a strict JSON schema.
- **Only "naked" stars** are touched — repos you've already filed into a list by hand are left alone.

## Requirements

- [Bun](https://bun.sh)
- [`gh`](https://cli.github.com), authenticated and with the `user` scope:
  ```sh
  gh auth refresh -h github.com -s user
  ```
- `ANTHROPIC_API_KEY` (in the environment or in `.env` — Bun loads it automatically)

## Install

```sh
bun install
```

## Usage

The tool never writes to your account unless you pass `--apply` — every command is a dry run by default and just (re)builds `report.md` for you to review first.

### First run

```sh
# 1. dry run — classify everything and write report.md, but touch nothing
bun run src/main.ts

# (optional) try it on a handful of repos first
bun run src/main.ts --limit 20

# 2. read report.md to see what would go where, then commit for real
bun run src/main.ts --apply
```

That first `--apply` creates the category lists on your account and files every **naked** star (one not already in a list you made by hand) into them. AI decisions are cached in `cache.json`, so this is the only time the model classifies everything from scratch.

### Later runs

Re-run whenever your stars or the tool's rules change — it's incremental and cheap (the cache means already-classified repos aren't re-sent to the model):

```sh
# You starred new repos → sort just the new naked stars (dry, then apply)
bun run src/main.ts
bun run src/main.ts --apply

# Re-check already-sorted repos against the abandonment rules and move the
# newly-dead ones into "Abandoned"
bun run src/main.ts --resort
bun run src/main.ts --resort --apply

# You edited the categories in src/config.ts → re-classify everything the tool
# previously sorted under the new taxonomy (see "Configuring categories" below)
bun run src/main.ts --recategorize
bun run src/main.ts --recategorize --apply
```

Flags: `--apply` (write; dry run by default), `--limit N`, `--resort`, `--recategorize`.

## Configuring categories

The lists and their AI-facing descriptions live in [`src/config.ts`](src/config.ts); the classification rules are in [`src/classify.ts`](src/classify.ts). After editing them, run `--recategorize` (preferred — it re-sorts everything the tool previously filed and updates the cache). Deleting `cache.json` also forces reclassification, but it wipes the tool's record of which repos it owns, so `--resort`/`--recategorize` can no longer operate on already-sorted repos — prefer `--recategorize` over deleting the cache.

Don't rename a list's `listName` in the config without also renaming (or deleting) the corresponding list on GitHub — otherwise you get a duplicate list and the old one lingers.

## Notes

- AI decisions are cached in `cache.json`, so re-runs don't re-ask the model and an interrupted run resumes where it left off.
- `cache.json` also tracks the ids of the lists the tool manages (`managed`), so a managed list you rename in the UI is still recognized as the tool's (by id) and not mistaken for a manual list. This kicks in once the tool has written to that list at least since this behavior was added — a list renamed before its id was ever recorded isn't recognized.
- **`--recategorize` replaces a repo's tool-managed list membership with the fresh AI decision.** Only your *manual* (non-managed) lists are preserved. So if you manually move a tool-sorted repo from one managed list to another in the UI, `--recategorize` will overwrite that move; put the repo in a manual list instead if you want the placement to stick.
- Entries for repos you've unstarred are pruned from `cache.json` on the next run.
- Writes are throttled (~250 ms between mutations) with backoff on GitHub's secondary rate limits.
- `updateUserListsForItem` has set semantics (it sets the full list membership of a repo) — safe only for "naked" stars.

## License

[MIT](LICENSE)
