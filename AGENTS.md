# AGENTS.md

## Purpose

This repository is a fork of `vovanbo/obsidian-github-stars`.

Primary fork goals:
- sync GitHub stars into Obsidian
- include repo-doc content in repo-pages
- keep sync reliable inside Obsidian desktop
- preserve enough diagnostics to debug long-running sync failures

## Current fork behavior

- Repository README content is called repo-doc content in this fork.
- Generated Obsidian Markdown pages for repositories are called repo-pages.
- Repo-doc content is fetched from the GitHub `readme` endpoint and rendered under `## Repo-doc`.
- Star metadata sync and repo-doc fetching are separate commands.
- `isArchived`, `isFork`, `isPrivate`, and `isTemplate` stay in plugin storage but are not written to note frontmatter
- GitHub API traffic uses Obsidian `requestUrl`
- Retry/backoff is enabled for retryable HTTP status codes:
  - `429`
  - `500`
  - `502`
  - `503`
  - `504`
- Sync diagnostics are written to `.obsidian/plugins/github-stars/debug.log`

## Important paths

- Fork repo: `.`
- Live vault: `../github-stars` or the active Obsidian vault where the plugin is installed
- Installed plugin dir: `.obsidian/plugins/github-stars` inside the target vault
- Plugin debug log: `.obsidian/plugins/github-stars/debug.log` inside the target vault
- Synced database: `GitHub/db/stars.db` inside the target vault
- Star Search CLI for Rajat's vault: `/Users/rajat/.local/bin/star-search`
- Star Search repo: `/Users/rajat/selfpro/star-search`

## Build and install

Build:

```bash
bun tsc --noEmit
bun biome check ./src
bun ./scripts/build.ts
```

Install into the live vault:

```bash
cp dist/main.js <vault>/.obsidian/plugins/github-stars/main.js
cp dist/styles.css <vault>/.obsidian/plugins/github-stars/styles.css
cp manifest.json <vault>/.obsidian/plugins/github-stars/manifest.json
obsidian vault="<vault-name>" plugin:disable id=github-stars filter=community
obsidian vault="<vault-name>" plugin:enable id=github-stars filter=community
```

## Live validation commands

Plugin state:

```bash
obsidian vault="<vault-name>" eval code='(() => { const p = app.plugins.plugins["github-stars"]; return JSON.stringify({ lock: p?.lock?.locked ?? null, enabled: app.plugins.enabledPlugins.has("github-stars"), stats: p?.settings?.stats ?? null }); })()'
```

repo-doc coverage:

```bash
sqlite3 <vault>/GitHub/db/stars.db "select count(*) as repos, sum(case when readmeFetchedAt is not null then 1 else 0 end) as repo_doc_checked, sum(case when readme is not null and trim(readme) <> '' then 1 else 0 end) as repos_with_repo_doc from repositories;"
```

Missing unchecked repo-docs:

```bash
sqlite3 <vault>/GitHub/db/stars.db "select owner, name from repositories where readmeFetchedAt is null order by owner, name;"
```

Loaded command IDs:

```bash
obsidian vault="<vault-name>" eval code='Object.keys(app.commands.commands).filter((id) => id.startsWith("github-stars:")).sort().join("\n")'
```

Star Search validation for Rajat's vault:

```bash
star-search search "kubernetes dashboard" --term cluster --limit 5
star-search search "tools for searching local markdown notes" --term sqlite --term full-text --limit 5
```

## Known successful state

Validated successful command-split sync in Rajat's vault on 2026-05-02:
- `1325` active repositories in SQLite
- `1324` repositories with repo-doc check completed
- `1322` repositories with repo-doc content
- Star Search indexed `1421` repositories and `1433` repo-pages on 2026-05-29

At that validation point, repos without repo-doc content were:
- `LANDrop/LANDrop-releases`
- `pushowl/pushowl_event`
- `tract-docs/tract-docs.dev`

## Known caveats

- Private repos are still imported if the token can access them; this is not yet filtered out globally
- Repo-doc import does not rewrite relative links or images
- Full star sync does not fetch repo-docs; use the repo-doc commands for that phase
- Long repo-doc refreshes can take many minutes depending on GitHub latency and concurrency

## Token requirements

Fine-grained GitHub token should include read access to:
- `Starring`
- `Contents`

## Guidance for future agents

- Read `README.md` and this file before changing behavior
- Do not print the live GitHub token from plugin settings
- Prefer small-scope reproduction before another full-vault sync when debugging
- If GitHub API failures recur, inspect the debug log first
- If changing sync reliability, preserve Obsidian `requestUrl` transport unless User explicitly approves a different approach
