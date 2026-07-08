// Repository classification via Anthropic (claude-haiku-4-5, structured outputs).

import Anthropic from "@anthropic-ai/sdk";
import {
  ALL_SLUGS,
  CATEGORIES,
  UNCATEGORIZED_SLUG,
  type Repo,
} from "./config";

const MODEL = "claude-haiku-4-5";
const BATCH_SIZE = 40;

const client = new Anthropic();

const SYSTEM = [
  "You classify GitHub repositories into starred-repo lists.",
  "For each repository, pick EXACTLY ONE most-fitting list from the set below.",
  "",
  "Lists:",
  ...CATEGORIES.map((c) => `- ${c.slug}: ${c.description}`),
  `- ${UNCATEGORIZED_SLUG}: none of the above fits confidently.`,
  "",
  "Rules:",
  "- Assign a repo to a list only if it CLEARLY belongs there by nature. When in doubt, use uncategorized (better to under-file than to misfile).",
  "- Ordinary libraries, plugins, and frameworks meant to be embedded in other code (especially frontend jQuery/JS plugins and Ruby/Rails gems) are almost always uncategorized — EXCEPT when they are clearly about databases/storage/search/cache (stack), AI/ML (ai-ml), a self-hosted service, downloading/archiving content (data-hoarding), or privacy/security (privacy-security).",
  "- Do NOT put application-level libraries or general-purpose dev utilities in environment — only the developer's own personal tooling and environment configs.",
  "",
  "Return a result for EVERY repository, using its full name (owner/name) as the repo field.",
].join("\n");

const SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          repo: { type: "string" },
          list: { type: "string", enum: ALL_SLUGS },
        },
        required: ["repo", "list"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
} as const;

function repoLine(r: Repo): string {
  const parts = [r.nameWithOwner];
  if (r.primaryLanguage) parts.push(`[${r.primaryLanguage}]`);
  if (r.topics.length) parts.push(`{${r.topics.join(", ")}}`);
  const head = parts.join(" ");
  const desc = r.description ? `: ${r.description}` : "";
  return `${head}${desc}`;
}

async function classifyBatch(batch: Repo[]): Promise<Map<string, string>> {
  const user =
    "Repositories:\n" + batch.map((r) => `- ${repoLine(r)}`).join("\n");

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system: SYSTEM,
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [{ role: "user", content: user }],
  });

  const text = resp.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const parsed = JSON.parse(text) as {
    results: { repo: string; list: string }[];
  };

  const out = new Map<string, string>();
  for (const { repo, list } of parsed.results) {
    out.set(repo, ALL_SLUGS.includes(list) ? list : UNCATEGORIZED_SLUG);
  }
  return out;
}

async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}

// Classify every repository in batches.
// Returns a map of nameWithOwner → slug. onProgress(done, total).
export async function classifyAll(
  repos: Repo[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (let i = 0; i < repos.length; i += BATCH_SIZE) {
    const batch = repos.slice(i, i + BATCH_SIZE);
    const labels = await withRetry(() => classifyBatch(batch));
    for (const r of batch) {
      // if the model didn't return an entry for a repo, treat it as uncategorized
      result.set(r.nameWithOwner, labels.get(r.nameWithOwner) ?? UNCATEGORIZED_SLUG);
    }
    onProgress?.(Math.min(i + BATCH_SIZE, repos.length), repos.length);
  }
  return result;
}
