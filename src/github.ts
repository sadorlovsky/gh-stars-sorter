// GitHub access via `gh api graphql` (reusing gh's authentication).
// Node ids and cursors are opaque base64 strings from GitHub, safe to embed
// directly in the query body.

import type { Repo } from "./config";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Run a GraphQL query via gh. Retries with backoff on secondary rate limits.
async function runGraphQL(query: string, attempt = 0): Promise<any> {
  const proc = Bun.spawn(["gh", "api", "graphql", "-f", `query=${query}`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  let parsed: any;
  try {
    parsed = stdout ? JSON.parse(stdout) : null;
  } catch {
    parsed = null;
  }

  const errText = (stderr + " " + (stdout || "")).toLowerCase();
  const rateLimited =
    errText.includes("rate limit") ||
    errText.includes("secondary") ||
    errText.includes("was submitted too quickly") ||
    errText.includes("abuse");
  const transient =
    /\b(502|503|504|500)\b/.test(errText) ||
    errText.includes("bad gateway") ||
    errText.includes("timeout") ||
    errText.includes("timed out") ||
    errText.includes("connection reset") ||
    errText.includes("eof");

  if (code !== 0 || parsed?.errors) {
    if ((rateLimited || transient) && attempt < 6) {
      const backoff = Math.min(60_000, 2000 * 2 ** attempt);
      console.warn(`  rate-limited, waiting ${backoff / 1000}s (attempt ${attempt + 1})…`);
      await sleep(backoff);
      return runGraphQL(query, attempt + 1);
    }
    const msg = parsed?.errors
      ? JSON.stringify(parsed.errors)
      : stderr || `gh exit ${code}`;
    throw new Error(`GraphQL error: ${msg}`);
  }

  if (!parsed?.data) {
    throw new Error(`Empty GraphQL response: ${stderr || stdout}`);
  }
  return parsed.data;
}

// ---- Reading ----

export interface ListMeta {
  id: string;
  name: string;
}

// All of the user's lists: name → metadata, the set of repo ids already in at
// least one list (the "non-naked" stars), and per-repo membership (repo id →
// list names it currently belongs to). Membership lets the writer preserve a
// repo's manual lists when replacing its tool-managed ones.
export async function fetchLists(): Promise<{
  byName: Map<string, ListMeta>;
  assigned: Set<string>;
  membership: Map<string, ListMeta[]>;
}> {
  const nodes: ListMeta[] = [];
  let listsAfter: string | null = null;
  while (true) {
    const afterArg = listsAfter ? `, after: "${listsAfter}"` : "";
    const listsData = await runGraphQL(`
      {
        viewer {
          lists(first: 100${afterArg}) {
            pageInfo { hasNextPage endCursor }
            nodes { id name }
          }
        }
      }
    `);
    const conn = listsData.viewer.lists;
    for (const n of conn.nodes) nodes.push({ id: n.id, name: n.name });
    if (!conn.pageInfo.hasNextPage) break;
    listsAfter = conn.pageInfo.endCursor;
  }
  const byName = new Map<string, ListMeta>();
  for (const n of nodes) byName.set(n.name, { id: n.id, name: n.name });

  const assigned = new Set<string>();
  const membership = new Map<string, ListMeta[]>();
  for (const list of nodes) {
    let after: string | null = null;
    while (true) {
      const afterArg = after ? `, after: "${after}"` : "";
      const data = await runGraphQL(`
        {
          node(id: "${list.id}") {
            ... on UserList {
              items(first: 100${afterArg}) {
                pageInfo { hasNextPage endCursor }
                nodes { ... on Repository { id } }
              }
            }
          }
        }
      `);
      const items = data.node?.items;
      if (!items) break;
      for (const it of items.nodes) {
        if (!it?.id) continue;
        assigned.add(it.id);
        (membership.get(it.id) ?? membership.set(it.id, []).get(it.id)!).push({
          id: list.id,
          name: list.name,
        });
      }
      if (!items.pageInfo.hasNextPage) break;
      after = items.pageInfo.endCursor;
    }
  }
  return { byName, assigned, membership };
}

// Flake safety net: in a heavy paginated query GitHub occasionally returns
// defaultBranchRef=null. For non-empty, non-archived repos with a missing commit
// date, re-fetch it individually (in aliased batches).
async function repairMissingCommits(repos: Repo[]): Promise<void> {
  const missing = repos.filter(
    (r) => r.lastCommit === null && r.pushedAt !== null && !r.isArchived,
  );
  if (!missing.length) return;
  process.stdout.write(`  re-fetching commit date for ${missing.length} repos…\n`);
  for (let i = 0; i < missing.length; i += 30) {
    const batch = missing.slice(i, i + 30);
    const q =
      "{" +
      batch
        .map((r, j) => {
          const [owner, name] = r.nameWithOwner.split("/");
          return `r${j}: repository(owner:${JSON.stringify(owner!)}, name:${JSON.stringify(name!)}){ defaultBranchRef{target{... on Commit{committedDate}}} }`;
        })
        .join(" ") +
      "}";
    try {
      const data = await runGraphQL(q);
      batch.forEach((r, j) => {
        const c = data[`r${j}`]?.defaultBranchRef?.target?.committedDate;
        if (c) r.lastCommit = c;
      });
    } catch {
      // repo may have been renamed/deleted — skip; it falls back to pushedAt
    }
  }
}

// All starred repositories with every field we need.
export async function fetchStarred(): Promise<Repo[]> {
  const repos: Repo[] = [];
  let after: string | null = null;
  while (true) {
    const afterArg = after ? `, after: "${after}"` : "";
    const data = await runGraphQL(`
      {
        viewer {
          starredRepositories(first: 100${afterArg}) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id nameWithOwner description url isArchived pushedAt stargazerCount
              primaryLanguage { name }
              defaultBranchRef { target { ... on Commit { committedDate } } }
              repositoryTopics(first: 8) { nodes { topic { name } } }
            }
          }
        }
      }
    `);
    const conn = data.viewer.starredRepositories;
    for (const n of conn.nodes) {
      repos.push({
        id: n.id,
        nameWithOwner: n.nameWithOwner,
        description: n.description ?? null,
        url: n.url,
        isArchived: n.isArchived,
        pushedAt: n.pushedAt ?? null,
        lastCommit: n.defaultBranchRef?.target?.committedDate ?? null,
        stargazerCount: n.stargazerCount,
        primaryLanguage: n.primaryLanguage?.name ?? null,
        topics: (n.repositoryTopics?.nodes ?? [])
          .map((t: any) => t?.topic?.name)
          .filter(Boolean),
      });
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
    process.stdout.write(`\r  stars loaded: ${repos.length}`);
  }
  process.stdout.write(`\r  stars loaded: ${repos.length}\n`);
  await repairMissingCommits(repos);
  return repos;
}

// ---- Writing ----

// Create a list and return its id.
export async function createList(
  name: string,
  description = "",
  isPrivate = true,
): Promise<ListMeta> {
  const data = await runGraphQL(`
    mutation {
      createUserList(input: {
        name: ${JSON.stringify(name)},
        description: ${JSON.stringify(description)},
        isPrivate: ${isPrivate}
      }) {
        list { id name }
      }
    }
  `);
  const list = data.createUserList.list;
  return { id: list.id, name: list.name };
}

// Set the full list membership of a repository (set semantics — this REPLACES
// every list the repo is in with exactly the given ids). Pass the complete
// desired set, including any manual lists to preserve.
export async function setRepoLists(
  repoId: string,
  listIds: string[],
): Promise<void> {
  const ids = listIds.map((id) => `"${id}"`).join(", ");
  await runGraphQL(`
    mutation {
      updateUserListsForItem(input: {
        itemId: "${repoId}",
        listIds: [${ids}]
      }) {
        item { __typename }
      }
    }
  `);
}
