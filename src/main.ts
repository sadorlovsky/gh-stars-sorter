// Orchestration: load → diff "naked" stars → abandonment → AI → report/write.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ABANDONED_LIST,
  ABANDONED_MAX_AGE_MS,
  CATEGORIES,
  UNCATEGORIZED_LIST,
  UNCATEGORIZED_SLUG,
  type Repo,
} from "./config";
import { classifyAll } from "./classify";
import {
  createList,
  fetchLists,
  fetchStarred,
  setRepoList,
  type ListMeta,
} from "./github";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_PATH = join(ROOT, "cache.json");
const REPORT_PATH = join(ROOT, "report.md");

const ABANDONED_KEY = "__abandoned__"; // internal decision key

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Args {
  apply: boolean;
  limit: number | null;
  resort: boolean;
}

function parseArgs(argv: string[]): Args {
  const apply = argv.includes("--apply");
  const resort = argv.includes("--resort");
  const li = argv.indexOf("--limit");
  const limit = li >= 0 && argv[li + 1] ? parseInt(argv[li + 1]!, 10) : null;
  return { apply, limit, resort };
}

// Date of last real activity: last commit on the default branch (pushedAt is
// bumped by tags/branches without commits, so it's only a fallback).
function lastActivity(r: Repo): string | null {
  return r.lastCommit ?? r.pushedAt;
}

// Explicit "dead" markers in a repository's description.
const DEAD_RE =
  /\b(deprecated|unmaintained|no longer (actively )?maintained|not (actively )?maintained|no longer (actively )?developed|abandoned|discontinued|obsolete|archived|end[- ]of[- ]life|superseded by|use .* instead)\b/i;

function abandonReason(r: Repo): string | null {
  if (r.isArchived) return "archived";
  if (r.description && DEAD_RE.test(r.description)) return "marked deprecated";
  const d = lastActivity(r);
  if (!d) return "no activity data";
  if (Date.parse(d) < Date.now() - ABANDONED_MAX_AGE_MS) return "no commits in >2y";
  return null;
}

function isAbandoned(r: Repo): boolean {
  return abandonReason(r) !== null;
}

// decision slug → target list name
function slugToListName(slug: string): string {
  if (slug === ABANDONED_KEY) return ABANDONED_LIST;
  if (slug === UNCATEGORIZED_SLUG) return UNCATEGORIZED_LIST;
  const cat = CATEGORIES.find((c) => c.slug === slug);
  return cat ? cat.listName : UNCATEGORIZED_LIST;
}

type Cache = { decisions: Record<string, string> }; // repoId → slug (AI only)

async function loadCache(): Promise<Cache> {
  if (!existsSync(CACHE_PATH)) return { decisions: {} };
  try {
    return JSON.parse(await readFile(CACHE_PATH, "utf8"));
  } catch {
    return { decisions: {} };
  }
}

async function saveCache(cache: Cache): Promise<void> {
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
}

async function writeReport(
  decisions: { repo: Repo; slug: string; reason: string }[],
): Promise<void> {
  const byList = new Map<string, typeof decisions>();
  for (const d of decisions) {
    const name = slugToListName(d.slug);
    (byList.get(name) ?? byList.set(name, []).get(name)!).push(d);
  }

  const lines: string[] = [];
  lines.push(`# Stars sorting report\n`);
  lines.push(`Total to sort: **${decisions.length}**\n`);
  lines.push(`## Summary by list\n`);
  const sorted = [...byList.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [name, items] of sorted) {
    lines.push(`- **${name}** — ${items.length}`);
  }
  lines.push(`\n## Details\n`);
  for (const [name, items] of sorted) {
    lines.push(`\n### ${name} (${items.length})\n`);
    for (const d of items.sort((a, b) =>
      a.repo.nameWithOwner.localeCompare(b.repo.nameWithOwner),
    )) {
      const desc = d.repo.description ? ` — ${d.repo.description}` : "";
      lines.push(`- [${d.repo.nameWithOwner}](${d.repo.url}) *(${d.reason})*${desc}`);
    }
  }
  await writeFile(REPORT_PATH, lines.join("\n") + "\n");
}

// Re-evaluate repos WE previously sorted under the current abandonment rules.
// Only touches "our" repos (those present in cache.decisions — the script filed
// them); the user's manual lists are left untouched. Moves into Abandoned the
// ones that look alive by pushedAt but are dead by commits / marked deprecated.
async function resort(apply: boolean) {
  const cache = await loadCache();
  const owned = new Set(Object.keys(cache.decisions));
  console.log(`Our sorted repos (in cache): ${owned.size}`);

  const { byName } = await fetchLists();
  const starred = await fetchStarred();

  const flips = starred.filter(
    (r) =>
      owned.has(r.id) &&
      cache.decisions[r.id] !== ABANDONED_KEY &&
      isAbandoned(r),
  );

  console.log(`Moving to Abandoned: ${flips.length}`);
  for (const r of flips) {
    console.log(
      `  ${r.nameWithOwner}  (${abandonReason(r)}; was: ${slugToListName(
        cache.decisions[r.id]!,
      )})`,
    );
  }

  if (!flips.length) {
    console.log("Nothing to move.");
    return;
  }
  if (!apply) {
    console.log("Dry run — nothing written. Run with --resort --apply.");
    return;
  }

  const abandonedList = byName.get(ABANDONED_LIST);
  if (!abandonedList) throw new Error(`List "${ABANDONED_LIST}" not found.`);

  console.log(`Moving ${flips.length}…`);
  let done = 0;
  for (const r of flips) {
    await setRepoList(r.id, abandonedList.id);
    cache.decisions[r.id] = ABANDONED_KEY;
    done++;
    process.stdout.write(`\r  ${done}/${flips.length}`);
    await sleep(250);
  }
  process.stdout.write("\n");
  await saveCache(cache);
  console.log("Done.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `Mode: ${args.resort ? "RESORT " : ""}${
      args.apply ? "APPLY (writing!)" : "dry-run"
    }${args.limit ? `, limit ${args.limit}` : ""}`,
  );

  if (args.resort) return resort(args.apply);

  console.log("Loading lists and starred repositories…");
  const { byName, assigned } = await fetchLists();
  const starred = await fetchStarred();
  console.log(
    `  lists: ${byName.size}, stars: ${starred.length}, already sorted: ${assigned.size}`,
  );

  // Invariant: only process "naked" stars.
  let naked = starred.filter((r) => !assigned.has(r.id));
  console.log(`  naked (not in any list): ${naked.length}`);
  if (args.limit != null) naked = naked.slice(0, args.limit);

  // Abandoned ones are decided deterministically, without AI.
  const abandoned = naked.filter(isAbandoned);
  const forAI = naked.filter((r) => !isAbandoned(r));
  console.log(`  abandoned: ${abandoned.length}, to AI: ${forAI.length}`);

  // Cache of AI decisions.
  const cache = await loadCache();
  const uncached = forAI.filter((r) => !(r.id in cache.decisions));
  console.log(`  cached: ${forAI.length - uncached.length}, new: ${uncached.length}`);

  if (uncached.length) {
    console.log("Classifying with AI…");
    const labels = await classifyAll(uncached, (done, total) =>
      process.stdout.write(`\r  AI: ${done}/${total}`),
    );
    process.stdout.write("\n");
    for (const r of uncached) {
      cache.decisions[r.id] = labels.get(r.nameWithOwner) ?? UNCATEGORIZED_SLUG;
    }
    await saveCache(cache);
  }

  // Assemble final decisions.
  const decisions: { repo: Repo; slug: string; reason: string }[] = [];
  for (const r of abandoned) {
    decisions.push({
      repo: r,
      slug: ABANDONED_KEY,
      reason: abandonReason(r) ?? "abandoned",
    });
  }
  for (const r of forAI) {
    decisions.push({ repo: r, slug: cache.decisions[r.id]!, reason: "ai" });
  }

  await writeReport(decisions);
  console.log(`Report: ${REPORT_PATH}`);

  if (!args.apply) {
    console.log("Dry run — nothing written. Review report.md, then run with --apply.");
    return;
  }

  // ---- Writing ----
  // Make sure the required lists exist.
  const ensure = async (name: string): Promise<ListMeta> => {
    const found = byName.get(name);
    if (found) return found;
    console.log(`  creating list "${name}"…`);
    const created = await createList(name);
    byName.set(name, created);
    return created;
  };

  // Category lists must already exist.
  for (const c of CATEGORIES) {
    if (!byName.has(c.listName)) {
      throw new Error(
        `List "${c.listName}" not found on GitHub. Renamed? Check config.ts.`,
      );
    }
  }
  await ensure(ABANDONED_LIST);
  await ensure(UNCATEGORIZED_LIST);

  console.log(`Writing ${decisions.length} repositories…`);
  let done = 0;
  for (const d of decisions) {
    const listName = slugToListName(d.slug);
    const list = byName.get(listName)!;
    await setRepoList(d.repo.id, list.id);
    done++;
    process.stdout.write(`\r  ${done}/${decisions.length}`);
    await sleep(250); // throttle against secondary rate limits
  }
  process.stdout.write("\n");
  console.log("Done.");
}

main().catch((e) => {
  console.error("\nError:", e.message);
  process.exit(1);
});
