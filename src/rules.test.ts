import { describe, expect, test } from "bun:test";
import {
  ABANDONED_KEY,
  DEAD_RE,
  abandonReason,
  desiredListNames,
  driftSlugs,
  isAbandoned,
  lastActivity,
  normalizeDecisions,
  normalizeSlugs,
  pruneCache,
  slugToListName,
  slugsToListNames,
} from "./rules";
import {
  ABANDONED_LIST,
  UNCATEGORIZED_LIST,
  UNCATEGORIZED_SLUG,
  type Repo,
} from "./config";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

function repo(over: Partial<Repo> = {}): Repo {
  return {
    id: "R_1",
    nameWithOwner: "acme/widget",
    description: null,
    url: "https://github.com/acme/widget",
    isArchived: false,
    pushedAt: iso(1000),
    lastCommit: iso(1000),
    stargazerCount: 0,
    primaryLanguage: null,
    topics: [],
    ...over,
  };
}

describe("lastActivity", () => {
  test("prefers lastCommit over pushedAt", () => {
    const r = repo({ lastCommit: "2020-01-01T00:00:00Z", pushedAt: "2024-01-01T00:00:00Z" });
    expect(lastActivity(r)).toBe("2020-01-01T00:00:00Z");
  });
  test("falls back to pushedAt when no commit date", () => {
    const r = repo({ lastCommit: null, pushedAt: "2024-01-01T00:00:00Z" });
    expect(lastActivity(r)).toBe("2024-01-01T00:00:00Z");
  });
  test("null when neither is present", () => {
    expect(lastActivity(repo({ lastCommit: null, pushedAt: null }))).toBeNull();
  });
});

describe("abandonReason / isAbandoned", () => {
  test("archived wins over everything", () => {
    const r = repo({ isArchived: true, lastCommit: iso(1000) });
    expect(abandonReason(r)).toBe("archived");
    expect(isAbandoned(r)).toBe(true);
  });
  test("deprecated keyword in description", () => {
    expect(abandonReason(repo({ description: "This project is deprecated." }))).toBe(
      "marked deprecated",
    );
  });
  test("no commits in >2y", () => {
    const r = repo({ lastCommit: iso(3 * YEAR_MS), pushedAt: iso(3 * YEAR_MS) });
    expect(abandonReason(r)).toBe("no commits in >2y");
  });
  test("fresh repo is alive", () => {
    expect(abandonReason(repo())).toBeNull();
    expect(isAbandoned(repo())).toBe(false);
  });
  test("no activity data", () => {
    expect(abandonReason(repo({ lastCommit: null, pushedAt: null }))).toBe(
      "no activity data",
    );
  });
  test("recent commit rescues an old pushedAt", () => {
    // lastCommit is recent even though pushedAt is ancient — not abandoned.
    const r = repo({ lastCommit: iso(1000), pushedAt: iso(5 * YEAR_MS) });
    expect(isAbandoned(r)).toBe(false);
  });
});

describe("DEAD_RE", () => {
  test.each([
    "deprecated",
    "no longer maintained",
    "no longer actively maintained",
    "not maintained",
    "superseded by foo",
    "use bar instead",
    "END-OF-LIFE",
  ])("matches %p", (s) => {
    expect(DEAD_RE.test(s)).toBe(true);
  });
  test.each(["actively maintained", "a well maintained library", "modern and supported"])(
    "does not match %p",
    (s) => {
      expect(DEAD_RE.test(s)).toBe(false);
    },
  );
});

describe("slugToListName", () => {
  test("known category slug → its list name", () => {
    expect(slugToListName("libraries")).toBe("Libraries & utilities");
    expect(slugToListName("self-hosted")).toBe("Self-hosted");
  });
  test("special keys", () => {
    expect(slugToListName(ABANDONED_KEY)).toBe(ABANDONED_LIST);
    expect(slugToListName(UNCATEGORIZED_SLUG)).toBe(UNCATEGORIZED_LIST);
  });
  test("unknown slug (config drift) → Uncategorized", () => {
    expect(slugToListName("this-slug-was-removed")).toBe(UNCATEGORIZED_LIST);
  });
});

describe("slugsToListNames", () => {
  test("maps and dedupes, order-preserving", () => {
    expect(slugsToListNames(["libraries", "frontend"])).toEqual([
      "Libraries & utilities",
      "Frontend & Web",
    ]);
  });
  test("collapses slugs that map to the same list", () => {
    // both unknown → both map to Uncategorized → single entry
    expect(slugsToListNames(["gone-a", "gone-b"])).toEqual([UNCATEGORIZED_LIST]);
  });
});

describe("normalizeSlugs", () => {
  test("drops unknown slugs", () => {
    expect(normalizeSlugs(["libraries", "bogus"])).toEqual(["libraries"]);
  });
  test("drops uncategorized when a real list is present", () => {
    expect(normalizeSlugs([UNCATEGORIZED_SLUG, "frontend"])).toEqual(["frontend"]);
  });
  test("dedupes", () => {
    expect(normalizeSlugs(["frontend", "frontend"])).toEqual(["frontend"]);
  });
  test("empty → uncategorized", () => {
    expect(normalizeSlugs([])).toEqual([UNCATEGORIZED_SLUG]);
  });
  test("only-unknown → uncategorized", () => {
    expect(normalizeSlugs(["nope"])).toEqual([UNCATEGORIZED_SLUG]);
  });
  test("only uncategorized stays uncategorized", () => {
    expect(normalizeSlugs([UNCATEGORIZED_SLUG])).toEqual([UNCATEGORIZED_SLUG]);
  });
});

describe("normalizeDecisions", () => {
  test("array passes through", () => {
    expect(normalizeDecisions({ a: ["libraries"] })).toEqual({ a: ["libraries"] });
  });
  test("legacy string is wrapped", () => {
    expect(normalizeDecisions({ a: "libraries" })).toEqual({ a: ["libraries"] });
  });
  test("garbage value becomes empty array", () => {
    expect(normalizeDecisions({ a: 42 })).toEqual({ a: [] });
  });
  test("non-object → empty map", () => {
    expect(normalizeDecisions(null)).toEqual({});
    expect(normalizeDecisions("nope")).toEqual({});
  });
});

describe("driftSlugs", () => {
  test("reports unknown slugs, ignores known + abandoned key", () => {
    const drift = driftSlugs({
      a: ["libraries"],
      b: [ABANDONED_KEY],
      c: ["removed-slug", "another-gone"],
      d: [UNCATEGORIZED_SLUG],
    });
    expect(drift.sort()).toEqual(["another-gone", "removed-slug"]);
  });
  test("no drift → empty", () => {
    expect(driftSlugs({ a: ["frontend"], b: [ABANDONED_KEY] })).toEqual([]);
  });
});

describe("desiredListNames", () => {
  const L = (id: string, name: string) => ({ id, name });

  test("preserves a manual (non-managed) list, replaces managed membership", () => {
    const current = [L("l1", "Self-hosted"), L("l2", "My favourites")];
    // AI now says frontend; "My favourites" is manual → kept.
    const out = desiredListNames(current, new Set(), ["Frontend & Web"]);
    expect(out).toEqual(["Frontend & Web", "My favourites"]);
  });

  test("managed-by-name is dropped even if id unknown", () => {
    const current = [L("l1", "Self-hosted")]; // managed name, id not tracked
    expect(desiredListNames(current, new Set(), ["Frontend & Web"])).toEqual([
      "Frontend & Web",
    ]);
  });

  test("rename-proof: a UI-renamed managed list (id tracked) is dropped", () => {
    // User renamed "Self-hosted" → "selfhosted" in the UI; its id l1 is tracked.
    const current = [L("l1", "selfhosted")];
    const out = desiredListNames(current, new Set(["l1"]), ["Frontend & Web"]);
    expect(out).toEqual(["Frontend & Web"]); // renamed list not preserved as manual
  });

  test("manual list with a tracked-managed sibling: only manual survives", () => {
    const current = [L("l1", "selfhosted"), L("l2", "Reading list")];
    const out = desiredListNames(current, new Set(["l1"]), ["Libraries & utilities"]);
    expect(out).toEqual(["Libraries & utilities", "Reading list"]);
  });

  test("empty current → just the targets, sorted & unique", () => {
    expect(
      desiredListNames([], new Set(), ["Frontend & Web", "Frontend & Web"]),
    ).toEqual(["Frontend & Web"]);
  });
});

describe("pruneCache", () => {
  test("removes entries not in keep set and returns count", () => {
    const decisions: Record<string, string[]> = {
      keep1: ["libraries"],
      drop1: ["frontend"],
      keep2: [ABANDONED_KEY],
      drop2: ["media"],
    };
    const removed = pruneCache(decisions, new Set(["keep1", "keep2"]));
    expect(removed).toBe(2);
    expect(Object.keys(decisions).sort()).toEqual(["keep1", "keep2"]);
  });
  test("no-op returns 0", () => {
    const decisions = { a: ["libraries"] };
    expect(pruneCache(decisions, new Set(["a"]))).toBe(0);
  });
});
