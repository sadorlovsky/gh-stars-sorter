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
  {
    slug: "frontend",
    listName: "Frontend & Web",
    description:
      "Web/UI development: JS/TS frontend frameworks and their ecosystems (React, Vue, Svelte, Solid, Astro, Next, Remix, Hono), state management, routing, CSS frameworks and styling (Tailwind, styled-components, PostCSS), animation, UI component libraries and widgets, icon/font sets, web components, and browser/HTML5 game engines. Examples: svelte, tailwindcss, GSAP, shadcn-ui, tabler-icons, phaser.",
  },
  {
    slug: "dev-tooling",
    listName: "Dev tooling",
    description:
      "Tools that act ON a codebase or the build/release pipeline (not libraries you import into an app): bundlers and build tools (vite, esbuild, parcel, rspack), compilers/transpilers, linters and formatters (eslint, biome, black, prettier), test runners and frameworks (vitest, ava), git tooling, and CI/CD & deployment tools (fastlane, serverless, semantic-release).",
  },
  {
    slug: "libraries",
    listName: "Libraries & utilities",
    description:
      "General-purpose programming libraries you import into application code, in ANY language: date/time (date-fns, dayjs), validation & schemas (zod, yup), HTTP clients (got, ky, requests), functional programming (fp-ts), small utilities (nanoid, ms, lodash-likes), auth/OAuth libraries (jose, next-auth), ORMs/query builders (drizzle, kysely). Distinction from 'stack': stack is a standalone backend service you deploy; libraries is code you embed. If it also renders UI/DOM, prefer 'frontend'.",
  },
  {
    slug: "learning",
    listName: "Learning & references",
    description:
      "Knowledge, not code: awesome-lists, books, tutorials, roadmaps, cheatsheets, interview-prep, curated resource collections, and best-practice guides. Examples: free-programming-books, awesome-*, system-design-primer, developer-roadmap, coding-interview-university.",
  },
  {
    slug: "media",
    listName: "Media processing",
    description:
      "Working with images, video, or audio: processing/transform/encode libraries and tools (sharp, squoosh, ffmpeg.wasm, tesseract.js, moviepy), media players (mpv, iina, hls.js), audio frameworks (howler, Tone.js), and creative-coding/graphics (p5.js).",
  },
  {
    slug: "desktop-native",
    listName: "Desktop & native apps",
    description:
      "Building or running desktop/mobile native applications: desktop app shells (tauri, electron, Pake), cross-platform native frameworks (capacitor), and notable native macOS/iOS/Swift apps and frameworks (iina, Plash, vapor, Swiftcord). NOT ordinary web apps.",
  },
];

export const UNCATEGORIZED_SLUG = "uncategorized";

// Every label the AI is allowed to return.
export const ALL_SLUGS = [
  ...CATEGORIES.map((c) => c.slug),
  UNCATEGORIZED_SLUG,
];
