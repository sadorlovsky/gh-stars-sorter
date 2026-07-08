// Shared types and category configuration.

export interface Repo {
  id: string; // node id — used by the updateUserListsForItem mutation
  nameWithOwner: string;
  description: string | null;
  url: string;
  isArchived: boolean;
  pushedAt: string | null;
  lastCommit: string | null; // last commit date on the default branch — more reliable than pushedAt
  stargazerCount: number;
  primaryLanguage: string | null;
  topics: string[];
}

// Abandonment threshold: last activity older than 2 years.
export const ABANDONED_MAX_AGE_MS = 2 * 365 * 24 * 60 * 60 * 1000;

// Special lists the script creates on demand.
export const ABANDONED_LIST = "Abandoned";
export const UNCATEGORIZED_LIST = "Uncategorized";

// AI category: slug (stable key for the enum schema) → name of an existing
// GitHub list (must match viewer.lists.nodes.name exactly) + a description for
// the prompt. The names come from the account's real lists.
export interface Category {
  slug: string;
  listName: string;
  description: string;
}

export const CATEGORIES: Category[] = [
  {
    slug: "self-hosted",
    listName: "Self-hosted",
    description:
      "Services and apps you deploy on your own infrastructure: git servers, authentication/SSO systems, dashboards, self-hosted alternatives to SaaS. Examples: gitea, authentik, kanidm.",
  },
  {
    slug: "ai-ml",
    listName: "AI & ML",
    description:
      "Machine learning and AI models, libraries, and tools: generative models, inference, training, computer vision, LLM tooling. Examples: rembg, DeepFaceLive, dalle-mini.",
  },
  {
    slug: "environment",
    listName: "Environment",
    description:
      "PERSONAL developer-environment tooling and configs you run locally: terminal/shell/editor configs (wezterm, tmux, neovim), dotfiles, CLI productivity utilities, version/environment managers. NOT here: libraries/plugins/packages you embed in other code (jQuery plugins, npm/gem packages, frontend libs, framework debugging gems) — those are not personal environment.",
  },
  {
    slug: "data-hoarding",
    listName: "Data hoarding",
    description:
      "Downloaders, archivers, and scrapers for saving content and media: downloading videos/pages/accounts, offline archival. Examples: monolith, instaloader, cobalt.",
  },
  {
    slug: "stack",
    listName: "Stack",
    description:
      "Infrastructure building blocks you plug into an application as a standalone backend component: databases, storage, search, cache servers, queues, brokers. Examples: meilisearch, dragonfly, rqlite.",
  },
  {
    slug: "privacy-security",
    listName: "🔒 Privacy & security",
    description:
      "Privacy and security: VPNs, proxies, censorship circumvention, encryption, security tooling. Examples: hysteria, streisand, setup-ipsec-vpn.",
  },
];

export const UNCATEGORIZED_SLUG = "uncategorized";

// Every label the AI is allowed to return.
export const ALL_SLUGS = [
  ...CATEGORIES.map((c) => c.slug),
  UNCATEGORIZED_SLUG,
];
