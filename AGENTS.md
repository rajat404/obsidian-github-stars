# AGENTS.md

## Purpose

This repository is a fork of `vovanbo/obsidian-github-stars`.

Primary fork goals:
- sync GitHub stars into Obsidian
- include repository README content in repo notes
- keep sync reliable inside Obsidian desktop
- preserve enough diagnostics to debug long-running sync failures

## Current fork behavior

- Repository README content is fetched from the GitHub `readme` endpoint and rendered under `## README`
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

README coverage:

```bash
sqlite3 <vault>/GitHub/db/stars.db "select count(*) as repos, sum(case when readme is not null and trim(readme) <> '' then 1 else 0 end) as repos_with_readme from repositories;"
```

Missing READMEs:

```bash
sqlite3 <vault>/GitHub/db/stars.db "select owner, name from repositories where readme is null or trim(readme) = '' order by owner, name;"
```

## Known successful state

Validated successful full sync in the reference vault:
- `1250` repos synced
- `1247` repos with README content
- sync survived transient GitHub `502` errors via retry/backoff

At that validation point, repos without README content were:
- `LANDrop/LANDrop-releases`
- `pushowl/pushowl_event`
- `tract-docs/tract-docs.dev`

## Known caveats

- Private repos are still imported if the token can access them; this is not yet filtered out globally
- README import does not rewrite relative links or images
- Full sync writes to SQLite in one transaction, so imported README rows are not visible until commit
- Long syncs can take many minutes with README fetching enabled

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
