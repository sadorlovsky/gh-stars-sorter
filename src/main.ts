// Orchestration: load → diff "naked" stars → abandonment → AI → report/write.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  ABANDONED_LIST,
  CATEGORIES,
  UNCATEGORIZED_LIST,
  UNCATEGORIZED_SLUG,
  type Repo,
} from "./config";
import {
  ABANDONED_KEY,
  abandonReason,
  desiredListNames,
  driftSlugs,
  isAbandoned,
  MANAGED_LIST_NAMES,
  normalizeDecisions,
  pruneCache,
  slugsToListNames,
} from "./rules";
import { classifyAll } from "./classify";
import {
  createList,
  fetchLists,
  fetchStarred,
  setRepoLists,
  type ListMeta,
} from "./github";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_PATH = join(ROOT, "cache.json");
const REPORT_PATH = join(ROOT, "report.md");

const CACHE_CHECKPOINT_EVERY = 25; // flush cache to disk this often during --apply

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Args {
  apply: boolean;
  limit: number | null;
  resort: boolean;
  recategorize: boolean;
}

function parseArgs(argv: string[]): Args {
  const apply = argv.includes("--apply");
  const resort = argv.includes("--resort");
  const recategorize = argv.includes("--recategorize");
  const li = argv.indexOf("--limit");
  const limit = li >= 0 && argv[li + 1] ? parseInt(argv[li + 1]!, 10) : null;
  return { apply, limit, resort, recategorize };
}

// decisions: repoId → slug[] (AI only). managed: GitHub list ids the tool
// considers its own — persisted so a managed list renamed in the UI is still
// recognized as managed (by id) instead of being mistaken for a manual list.
type Cache = { decisions: Record<string, string[]>; managed: string[] };

async function loadCache(): Promise<Cache> {
  if (!existsSync(CACHE_PATH)) return { decisions: {}, managed: [] };
  try {
    const parsed = JSON.parse(await readFile(CACHE_PATH, "utf8"));
    return {
      decisions: normalizeDecisions(parsed?.decisions),
      managed: Array.isArray(parsed?.managed)
        ? parsed.managed.filter((x: unknown): x is string => typeof x === "string")
        : [],
    };
  } catch {
    return { decisions: {}, managed: [] };
  }
}

async function saveCache(cache: Cache): Promise<void> {
  await writeFile(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// Record a list id as tool-managed (idempotent).
function markManaged(cache: Cache, meta: ListMeta): void {
  if (!cache.managed.includes(meta.id)) cache.managed.push(meta.id);
}

// Record the ids of all currently-config-named managed lists, so future renames
// are recognized by id. Only marks lists whose NAME is a managed name (never a
// user's manual list). Returns the effective set of managed ids.
function bootstrapManaged(cache: Cache, byName: Map<string, ListMeta>): Set<string> {
  for (const [name, meta] of byName) {
    if (MANAGED_LIST_NAMES.has(name)) markManaged(cache, meta);
  }
  return new Set(cache.managed);
}

// Warn (at startup) when the cache references category slugs that no longer
// exist in the config — a rename/removal that would otherwise map silently to
// Uncategorized.
function warnDrift(cache: Cache): void {
  const drift = driftSlugs(cache.decisions);
  if (drift.length) {
    console.warn(
      `⚠️  cache references unknown category slug(s) [${drift.join(", ")}] — ` +
        `they fall back to "${UNCATEGORIZED_LIST}". Run --recategorize to re-sort.`,
    );
  }
}

// Drop cache entries for repos that are no longer starred; persist if anything
// changed. Safe with --limit (the starred list is always complete).
async function pruneCacheToStarred(cache: Cache, starred: Repo[]): Promise<void> {
  const removed = pruneCache(cache.decisions, new Set(starred.map((r) => r.id)));
  if (removed) {
    console.log(`  pruned ${removed} unstarred repo(s) from cache`);
    await saveCache(cache);
  }
}

// Warn before creating a list whose name collides case-insensitively with an
// existing one — the usual signature of a rename that will spawn a duplicate.
function warnListClash(name: string, byName: Map<string, ListMeta>): void {
  const clash = [...byName.keys()].find(
    (n) => n !== name && n.toLowerCase() === name.toLowerCase(),
  );
  if (clash) {
    console.warn(
      `⚠️  creating "${name}" but a similarly-named list "${clash}" already exists — ` +
        `possible duplicate from a rename.`,
    );
  }
}

type Decision = { repo: Repo; slugs: string[]; reason: string };

async function writeReport(decisions: Decision[]): Promise<void> {
  // A repo appears under each of its lists, so per-list counts sum to more than
  // the number of repos when multi-label is in play — that's expected.
  const byList = new Map<string, Decision[]>();
  for (const d of decisions) {
    for (const name of slugsToListNames(d.slugs)) {
      (byList.get(name) ?? byList.set(name, []).get(name)!).push(d);
    }
  }

  const multi = decisions.filter((d) => slugsToListNames(d.slugs).length > 1);

  const lines: string[] = [];
  lines.push(`# Stars sorting report\n`);
  lines.push(`Total repos to sort: **${decisions.length}**`);
  lines.push(`In more than one list: **${multi.length}**\n`);
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
      const others = slugsToListNames(d.slugs).filter((n) => n !== name);
      const also = others.length ? ` _(also: ${others.join(", ")})_` : "";
      const desc = d.repo.description ? ` — ${d.repo.description}` : "";
      lines.push(
        `- [${d.repo.nameWithOwner}](${d.repo.url}) *(${d.reason})*${also}${desc}`,
      );
    }
  }
  await writeFile(REPORT_PATH, lines.join("\n") + "\n");
}

// Re-evaluate every repo the tool previously AI-sorted (all of cache.decisions
// except the deterministic Abandoned ones) against the CURRENT taxonomy, with
// multi-label output, and move them. A repo's manual (non-managed) lists are
// preserved; its managed-list membership is replaced with the new decision.
async function recategorize(apply: boolean, limit: number | null) {
  const cache = await loadCache();
  warnDrift(cache);
  const owned = new Set(
    Object.keys(cache.decisions).filter(
      (id) => !cache.decisions[id]!.includes(ABANDONED_KEY),
    ),
  );
  console.log(`AI-sorted repos in cache (excl. Abandoned): ${owned.size}`);

  const { byName, membership } = await fetchLists();
  const starred = await fetchStarred();
  await pruneCacheToStarred(cache, starred);
  const managedIds = bootstrapManaged(cache, byName);

  let targets = starred.filter((r) => owned.has(r.id) && !isAbandoned(r));
  console.log(`  re-evaluating: ${targets.length}`);
  if (limit != null) targets = targets.slice(0, limit);

  // Re-classify from scratch — ignore cached decisions.
  console.log("Classifying with AI…");
  const labels = await classifyAll(targets, (done, total) =>
    process.stdout.write(`\r  AI: ${done}/${total}`),
  );
  process.stdout.write("\n");

  const slugsFor = (r: Repo) => labels.get(r.nameWithOwner) ?? [UNCATEGORIZED_SLUG];
  const sortedEq = (a: string[], b: string[]) =>
    a.length === b.length && a.every((x, i) => x === b[i]);

  const decisions: Decision[] = [];
  const moves: { repo: Repo; before: string[]; desired: string[] }[] = [];

  for (const r of targets) {
    const slugs = slugsFor(r);
    decisions.push({ repo: r, slugs, reason: "ai" });

    const mem = membership.get(r.id) ?? [];
    const before = mem.map((m) => m.name).sort();
    const desired = desiredListNames(mem, managedIds, slugsToListNames(slugs));
    if (!sortedEq(before, desired)) moves.push({ repo: r, before, desired });
  }

  await writeReport(decisions);
  console.log(`Report: ${REPORT_PATH}`);
  console.log(`Planned moves: ${moves.length} / ${targets.length}`);
  for (const m of moves.slice(0, 40)) {
    console.log(
      `  ${m.repo.nameWithOwner}: [${m.before.join(", ")}] → [${m.desired.join(", ")}]`,
    );
  }
  if (moves.length > 40) {
    console.log(`  … and ${moves.length - 40} more (see report.md)`);
  }

  if (!apply) {
    console.log(
      "Dry run — nothing written. Review report.md, then run with --recategorize --apply.",
    );
    return;
  }

  // Ensure every needed list exists (creates the new category lists on demand).
  // `desired` mixes managed and preserved manual names, so only mark the
  // managed ones as tool-owned.
  const ensure = async (name: string): Promise<ListMeta> => {
    const found = byName.get(name);
    if (found) return found;
    warnListClash(name, byName);
    console.log(`  creating list "${name}"…`);
    const created = await createList(name);
    byName.set(name, created);
    if (MANAGED_LIST_NAMES.has(name)) markManaged(cache, created);
    return created;
  };
  for (const name of new Set(moves.flatMap((m) => m.desired))) await ensure(name);

  console.log(`Applying ${moves.length} moves…`);
  let done = 0;
  for (const m of moves) {
    const ids = m.desired.map((n) => byName.get(n)!.id);
    await setRepoLists(m.repo.id, ids);
    cache.decisions[m.repo.id] = slugsFor(m.repo); // checkpoint as we go
    done++;
    process.stdout.write(`\r  ${done}/${moves.length}`);
    if (done % CACHE_CHECKPOINT_EVERY === 0) await saveCache(cache);
    await sleep(250);
  }
  process.stdout.write("\n");
  // Refresh cache decisions for ALL targets (even unmoved ones may have new slugs).
  for (const r of targets) cache.decisions[r.id] = slugsFor(r);
  await saveCache(cache);
  console.log("Done.");
}

// Re-evaluate repos WE previously sorted under the current abandonment rules.
// Only touches "our" repos (those present in cache.decisions — the script filed
// them); the user's manual lists are left untouched. Moves into Abandoned the
// ones that look alive by pushedAt but are dead by commits / marked deprecated.
async function resort(apply: boolean) {
  const cache = await loadCache();
  warnDrift(cache);
  const owned = new Set(Object.keys(cache.decisions));
  console.log(`Our sorted repos (in cache): ${owned.size}`);

  const { byName } = await fetchLists();
  const starred = await fetchStarred();
  await pruneCacheToStarred(cache, starred);
  bootstrapManaged(cache, byName);

  const flips = starred.filter(
    (r) =>
      owned.has(r.id) &&
      !cache.decisions[r.id]?.includes(ABANDONED_KEY) &&
      isAbandoned(r),
  );

  console.log(`Moving to Abandoned: ${flips.length}`);
  for (const r of flips) {
    console.log(
      `  ${r.nameWithOwner}  (${abandonReason(r)}; was: ${slugsToListNames(
        cache.decisions[r.id] ?? [],
      ).join(", ")})`,
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
    await setRepoLists(r.id, [abandonedList.id]);
    cache.decisions[r.id] = [ABANDONED_KEY];
    done++;
    process.stdout.write(`\r  ${done}/${flips.length}`);
    if (done % CACHE_CHECKPOINT_EVERY === 0) await saveCache(cache);
    await sleep(250);
  }
  process.stdout.write("\n");
  await saveCache(cache);
  console.log("Done.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `Mode: ${args.resort ? "RESORT " : ""}${args.recategorize ? "RECATEGORIZE " : ""}${
      args.apply ? "APPLY (writing!)" : "dry-run"
    }${args.limit ? `, limit ${args.limit}` : ""}`,
  );

  if (args.resort) return resort(args.apply);
  if (args.recategorize) return recategorize(args.apply, args.limit);

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
  warnDrift(cache);
  await pruneCacheToStarred(cache, starred);
  const uncached = forAI.filter((r) => !(r.id in cache.decisions));
  console.log(`  cached: ${forAI.length - uncached.length}, new: ${uncached.length}`);

  if (uncached.length) {
    console.log("Classifying with AI…");
    const labels = await classifyAll(uncached, (done, total) =>
      process.stdout.write(`\r  AI: ${done}/${total}`),
    );
    process.stdout.write("\n");
    for (const r of uncached) {
      cache.decisions[r.id] = labels.get(r.nameWithOwner) ?? [UNCATEGORIZED_SLUG];
    }
    await saveCache(cache);
  }

  // Assemble final decisions.
  const decisions: Decision[] = [];
  for (const r of abandoned) {
    decisions.push({
      repo: r,
      slugs: [ABANDONED_KEY],
      reason: abandonReason(r) ?? "abandoned",
    });
  }
  for (const r of forAI) {
    decisions.push({ repo: r, slugs: cache.decisions[r.id]!, reason: "ai" });
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
    warnListClash(name, byName);
    console.log(`  creating list "${name}"…`);
    const created = await createList(name);
    byName.set(name, created);
    return created;
  };

  // Make sure every category list (plus the special ones) exists.
  for (const c of CATEGORIES) await ensure(c.listName);
  await ensure(ABANDONED_LIST);
  await ensure(UNCATEGORIZED_LIST);

  // Record the ids of all managed lists so later renames stay recognized.
  bootstrapManaged(cache, byName);
  await saveCache(cache);

  console.log(`Writing ${decisions.length} repositories…`);
  let done = 0;
  for (const d of decisions) {
    const ids = slugsToListNames(d.slugs).map((n) => byName.get(n)!.id);
    await setRepoLists(d.repo.id, ids);
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
