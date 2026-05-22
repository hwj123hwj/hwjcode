# LLM Wiki Log

> Chronological record of wiki operations.

## [2026-05-22] feat | Built-in Tool Checklist (from local_time debugging)

### Pages Added
- `wiki/adding-builtin-tool-checklist.md` — Checklist & pitfalls for adding
  a new built-in tool to `packages/core/src/tools/`. Captures lessons from
  the `local_time` bug where the tool registered correctly but Anthropic/
  proxy parsed `functionCalls=0` from a `FUNCTION_CALL` finishReason because
  of schema/description format drift from canonical tools.

### Key Lessons Captured
- Description strings must not start with `\n` or contain em-dashes / smart
  quotes / embedded ISO-format quotes
- Constructor should not over-specify the 4 boolean flags; rely on
  [[BaseTool]] defaults like `web-search.ts` does
- `validateToolParams` must call `SchemaValidator.validate` first
- `displayName` should be a single PascalCase word
- Avoid emoji in `returnDisplay` for cross-context safety
- Always `summary` field for UI history collapse
- Bundle must be rebuilt for source changes to take effect
- Reference tools by complexity: `web-search.ts`, `read-lints.ts`,
  `local-time.ts`, `ask-user-question.ts`

### Index Updated
- Added "Guides & Checklists" section with link to the new page

---

## [2026-01-23] feat | Debate UI Enhancement Documentation

### Pages Added
- `wiki/debate-i18n-enhancement.md` — Comprehensive documentation of multilingual debate mode
  - I18n support for Chinese/English UI
  - Language selection workflow
  - Dual-language prompt phrases
  - Settings integration with `preferredLanguage`
  - Implementation details for all 9 modified files

### Index Updated
- Added "Features & Enhancements" section to `index.md`
- Listed new `debate-i18n-enhancement` page

---

## [2026-04-10] lint | Health Check

### Scan Results (32 pages)
- **Dead links:** 0 — all wikilink targets resolve to existing pages
- **Orphan pages:** 0 — all wiki files listed in index.md
- **Incomplete frontmatter:** 1 — `overview.md` used `source:` (string) instead of `sources:` (array)
- **Contradictions:** 0 — tool counts, architecture descriptions consistent across pages
- **Stale content:** 0 — all pages dated 2026-04-09, no outdated references found

### Fixes Applied
1. `wiki/overview.md` — Standardized frontmatter: `source: README.md, package.json` → `sources: [README.md, package.json]` to match convention used by all other pages

### Recommendations (not auto-fixed)
- **Missing entity pages:** Several components mentioned across multiple pages lack dedicated pages:
  - `CompressionService` — referenced in GeminiClient, source-02
  - `LoopDetectionService` — referenced in GeminiClient, source-02
  - `HookPlanner`, `HookRunner`, `HookAggregator`, `HookEventHandler` — 4 of 5 hook layers have no pages
  - `HookTranslator` — version isolation layer mentioned in source-05
- **Thin content pages:** `SkillLoader.md`, `MarketplaceManager.md`, `ProxyAuthManager.md`, `SessionManager.md` have minimal detail (~5-8 lines each)

## [2026-04-09] init | Wiki Initialized
- Created wiki directory structure
- Ready for source ingestion

## [2026-04-09] ingest | Bulk Source Generation from Codebase Analysis
- Analyzed project architecture via docs/architecture.md, package.json, README.md
- Analyzed packages/core/src/ directory structure and key classes
- Analyzed packages/cli/src/ directory structure and entry point
- Analyzed tools system: 27 built-in tools, tool patterns, execution engine
- Analyzed hooks system: 5-layer architecture, 11 event types
- Analyzed build system: esbuild, CI/CD pipelines, npm publishing
- Analyzed MCP system: transports, OAuth, two-phase loading
- Generated 7 raw source documents:
  - raw/01-architecture.md
  - raw/02-core-module.md
  - raw/03-cli-module.md
  - raw/04-tools-system.md
  - raw/05-hooks-system.md
  - raw/06-build-and-scripts.md
  - raw/07-mcp-system.md
- Updated index.md with source listing

## [2026-04-09] lint | Health Check

### Scan Results (32 pages)
- **Dead links:** 0 — all 31 unique wikilink targets resolve correctly
- **Orphan pages (filesystem):** 0 — all wiki files listed in index.md
- **Orphan pages (graph):** 1 — `overview.md` had no incoming `[[overview]]` links
- **Incomplete frontmatter:** 1 — `overview.md` missing `type` field
- **Missing cross-references:** 2 — `overview.md` (0 outgoing wikilinks), `build-system.md` (1 outgoing, missing module links)
- **Thin content:** 4 pages — `SkillLoader.md`, `MarketplaceManager.md`, `ProxyAuthManager.md`, `SessionManager.md`
- **Contradictions:** 0
- **Stale content:** Not applicable (all pages dated 2026-04-09, same-day generation)

### Fixes Applied
1. `wiki/overview.md` — Added missing `type: overview` field to frontmatter
2. `wiki/overview.md` — Added "Related Pages" section with 7 wikilinks to all major system modules; added inline wikilinks in Core Capabilities list
3. `wiki/build-system.md` — Added `[[core-module]]` and `[[cli-module]]` wikilinks in Pipelines section

### Remaining Recommendations (manual)
- Enrich thin entity pages: `SkillLoader.md`, `MarketplaceManager.md`, `ProxyAuthManager.md`, `SessionManager.md`
- Standardize or document `source` (string) vs `sources` (array) convention across page types
- Add `[[overview]]` link from at least one other page to eliminate graph orphan status
- Update individual page dates when content is modified in future edits

## [2026-04-09] ingest | Full Ingestion of All 7 Raw Sources
- Processed all 7 raw source documents into wiki pages
- Created 7 source summary pages:
  - wiki/source-01-architecture.md — Architecture, monorepo, design patterns, dependencies
  - wiki/source-02-core-module.md — Core module structure, 16 directories, key classes
  - wiki/source-03-cli-module.md — CLI module, Ink/React UI, bootstrap sequence, two modes
  - wiki/source-04-tools-system.md — 27 built-in tools, execution state machine, confirmation types
  - wiki/source-05-hooks-system.md — 5-layer pipeline, 11 event types, I/O protocol
  - wiki/source-06-build-system.md — Two build pipelines, CI/CD, TypeScript/ESLint config
  - wiki/source-07-mcp-system.md — MCP transports, two-phase loading, OAuth, tool discovery
- Created 7 system/module entity pages:
  - wiki/core-module.md, wiki/cli-module.md, wiki/tools-system.md
  - wiki/hooks-system.md, wiki/mcp-system.md, wiki/build-system.md, wiki/skills-system.md
- Created 10 class/component entity pages:
  - wiki/GeminiClient.md, wiki/ContentGenerator.md, wiki/DeepVServerAdapter.md
  - wiki/SceneManager.md, wiki/Turn.md, wiki/SubAgent.md
  - wiki/ToolRegistry.md, wiki/BaseTool.md, wiki/ToolExecutionEngine.md
  - wiki/DiscoveredMCPTool.md, wiki/mcp-client.md
  - wiki/HookSystem.md, wiki/HookRegistry.md
  - wiki/ProxyAuthManager.md, wiki/SessionManager.md
  - wiki/SkillLoader.md, wiki/MarketplaceManager.md
- All pages include YAML frontmatter (type, date, tags) and [[wikilink]] cross-references
- Updated index.md with full source summaries, entities, and classes
- No contradictions detected between sources
