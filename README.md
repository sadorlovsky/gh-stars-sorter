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

```sh
# dry run: build report.md without writing anything
bun run src/main.ts

# on a subset
bun run src/main.ts --limit 20

# write the assignments to your account
bun run src/main.ts --apply

# re-evaluate already-sorted repos under the current abandonment rules
bun run src/main.ts --resort            # dry
bun run src/main.ts --resort --apply    # write
```

Flags: `--apply` (write; dry run by default), `--limit N`, `--resort`.

## Configuring categories

The lists and their AI-facing descriptions live in [`src/config.ts`](src/config.ts); the classification rules are in [`src/classify.ts`](src/classify.ts). After editing them, delete `cache.json` to force reclassification.

## Notes

- AI decisions are cached in `cache.json`, so re-runs don't re-ask the model and an interrupted run resumes where it left off.
- Writes are throttled (~250 ms between mutations) with backoff on GitHub's secondary rate limits.
- `updateUserListsForItem` has set semantics (it sets the full list membership of a repo) — safe only for "naked" stars.

## License

[MIT](LICENSE)
