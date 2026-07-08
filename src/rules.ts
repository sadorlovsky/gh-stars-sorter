// Pure decision logic shared by main.ts and classify.ts.
// Kept side-effect free (no IO, no network, no SDK) so it is trivially testable.

import {
  ABANDONED_LIST,
  ABANDONED_MAX_AGE_MS,
  ALL_SLUGS,
  CATEGORIES,
  UNCATEGORIZED_LIST,
  UNCATEGORIZED_SLUG,
  type Repo,
} from "./config";

export const ABANDONED_KEY = "__abandoned__"; // internal decision key

// Date of last real activity: last commit on the default branch (pushedAt is
// bumped by tags/branches without commits, so it's only a fallback).
export function lastActivity(r: Repo): string | null {
  return r.lastCommit ?? r.pushedAt;
}

// Explicit "dead" markers in a repository's description.
export const DEAD_RE =
  /\b(deprecated|unmaintained|no longer (actively )?maintained|not (actively )?maintained|no longer (actively )?developed|abandoned|discontinued|obsolete|archived|end[- ]of[- ]life|superseded by|use .* instead)\b/i;

export function abandonReason(r: Repo): string | null {
  if (r.isArchived) return "archived";
  if (r.description && DEAD_RE.test(r.description)) return "marked deprecated";
  const d = lastActivity(r);
  if (!d) return "no activity data";
  if (Date.parse(d) < Date.now() - ABANDONED_MAX_AGE_MS) return "no commits in >2y";
  return null;
}

export function isAbandoned(r: Repo): boolean {
  return abandonReason(r) !== null;
}

// decision slug → target list name
export function slugToListName(slug: string): string {
  if (slug === ABANDONED_KEY) return ABANDONED_LIST;
  if (slug === UNCATEGORIZED_SLUG) return UNCATEGORIZED_LIST;
  const cat = CATEGORIES.find((c) => c.slug === slug);
  return cat ? cat.listName : UNCATEGORIZED_LIST;
}

// slug[] → unique target list names, order-preserving.
export function slugsToListNames(slugs: string[]): string[] {
  return [...new Set(slugs.map(slugToListName))];
}

// All list names the tool manages (so the writer can tell them apart from the
// user's manual lists and leave those alone).
export const MANAGED_LIST_NAMES = new Set<string>([
  ...CATEGORIES.map((c) => c.listName),
  ABANDONED_LIST,
  UNCATEGORIZED_LIST,
]);

// Compute a repo's desired FULL list membership for --recategorize: keep the
// user's manual lists (neither a managed id nor a managed name), replace the
// tool-managed membership with the new target list names. Returns sorted unique
// names. A list counts as managed if its id is in `managedIds` (rename-proof —
// survives a list being renamed in the UI) OR its name is a current managed name.
export function desiredListNames(
  current: { id: string; name: string }[],
  managedIds: Set<string>,
  targetManaged: string[],
): string[] {
  const manual = current
    .filter((m) => !managedIds.has(m.id) && !MANAGED_LIST_NAMES.has(m.name))
    .map((m) => m.name);
  return [...new Set([...manual, ...targetManaged])].sort();
}

// Normalize a raw model list of slugs: keep only known slugs; drop
// 'uncategorized' if combined with real lists; fall back to ['uncategorized'].
export function normalizeSlugs(raw: string[]): string[] {
  const known = raw.filter((s) => ALL_SLUGS.includes(s));
  const real = known.filter((s) => s !== UNCATEGORIZED_SLUG);
  const uniq = [...new Set(real.length ? real : [UNCATEGORIZED_SLUG])];
  return uniq;
}

// Coerce a persisted `decisions` blob back into repoId → slug[]. Tolerates the
// legacy single-string form and drops anything unrecognizable.
export function normalizeDecisions(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (raw && typeof raw === "object") {
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      out[id] = Array.isArray(v)
        ? (v as string[])
        : typeof v === "string"
          ? [v]
          : [];
    }
  }
  return out;
}

// Unique slugs in the cache that no longer exist in the config (a renamed or
// removed category). These would otherwise map silently to Uncategorized.
export function driftSlugs(decisions: Record<string, string[]>): string[] {
  const known = new Set<string>([...ALL_SLUGS, ABANDONED_KEY]);
  const bad = new Set<string>();
  for (const slugs of Object.values(decisions)) {
    for (const s of slugs) if (!known.has(s)) bad.add(s);
  }
  return [...bad];
}

// Delete every decision whose repo id is not in `keep`; return how many were
// removed. Mutates `decisions` in place.
export function pruneCache(
  decisions: Record<string, string[]>,
  keep: Set<string>,
): number {
  let removed = 0;
  for (const id of Object.keys(decisions)) {
    if (!keep.has(id)) {
      delete decisions[id];
      removed++;
    }
  }
  return removed;
}
