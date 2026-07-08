// Repository classification via Anthropic (claude-haiku-4-5, structured outputs).

import Anthropic from "@anthropic-ai/sdk";
import {
  ALL_SLUGS,
  CATEGORIES,
  UNCATEGORIZED_SLUG,
  type Repo,
} from "./config";
import { normalizeSlugs } from "./rules";

const MODEL = "claude-haiku-4-5";
const BATCH_SIZE = 40;

const client = new Anthropic();

const SYSTEM = [
  "You classify GitHub repositories into starred-repo lists.",
  "For each repository, return ALL lists that clearly apply. A repository may",
  "belong to SEVERAL lists at once — include every one that genuinely fits.",
  "",
  "Lists:",
  ...CATEGORIES.map((c) => `- ${c.slug}: ${c.description}`),
  `- ${UNCATEGORIZED_SLUG}: use ONLY when none of the real lists fit.`,
  "",
  "Rules:",
  "- Add a list only if the repo CLEARLY belongs there by its nature; don't stretch.",
  "- Multi-label is expected and encouraged when a repo spans concerns. Examples:",
  "  a local-first AI tool → ai-ml + environment; a self-hosted media downloader → self-hosted + data-hoarding;",
  "  a React charting lib → frontend + libraries; an SVG icon set for the web → frontend.",
  "- Frontend/web libraries, UI components, CSS tooling and JS plugins DO belong in 'frontend' (this is a real list now — do NOT dump them in uncategorized).",
  "- A tool that acts on a codebase/build/release pipeline → dev-tooling; a library you import into app code → libraries; a standalone service you deploy → stack/self-hosted.",
  "- Do NOT put application-level libraries or general-purpose dev utilities in environment — only the developer's own personal tooling and environment configs.",
  "- 'lists' MUST be non-empty. If nothing real fits, return exactly [\"uncategorized\"].",
  "  Never combine 'uncategorized' with any other list.",
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
          lists: {
            type: "array",
            items: { type: "string", enum: ALL_SLUGS },
            minItems: 1,
          },
        },
        required: ["repo", "lists"],
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

async function classifyBatch(batch: Repo[]): Promise<Map<string, string[]>> {
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
    results: { repo: string; lists: string[] }[];
  };

  const out = new Map<string, string[]>();
  for (const { repo, lists } of parsed.results) {
    out.set(repo, normalizeSlugs(lists ?? []));
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
// Returns a map of nameWithOwner → slug[] (multi-label). onProgress(done, total).
export async function classifyAll(
  repos: Repo[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  for (let i = 0; i < repos.length; i += BATCH_SIZE) {
    const batch = repos.slice(i, i + BATCH_SIZE);
    const labels = await withRetry(() => classifyBatch(batch));
    for (const r of batch) {
      // if the model didn't return an entry for a repo, treat it as uncategorized
      result.set(r.nameWithOwner, labels.get(r.nameWithOwner) ?? [UNCATEGORIZED_SLUG]);
    }
    onProgress?.(Math.min(i + BATCH_SIZE, repos.length), repos.length);
  }
  return result;
}
