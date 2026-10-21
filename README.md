# omp-memory-obsidian

Long-term memory for [omp](https://omp.sh) backed by a plain **Obsidian vault** — the agent maintains a Karpathy-style wiki (`MEMORY.md` index, `[[wiki-linked]]` topic pages, append-only daily logs) that you can read and edit in Obsidian while the agent is not running.

This is an **extension package**, not a `memory.backend` value: omp's backend registry is a closed enum, so this package wires the same capabilities through the extension API instead — prompt-time recall injection, turn-cadence retention, memory tools, and a `/vault` command.

## What it does

| Capability | Mechanism |
|---|---|
| Recall | `before_agent_start` searches the vault with your prompt and appends ranked hits to the system prompt (cached 5 min) |
| Retain | every `OMP_MEMORY_RETAIN_EVERY` turns (default 4), a side turn (`runEphemeralTurn`) extracts durable facts from the conversation buffer → daily log + topic pages (importance ≥ 3) |
| Compaction | `session.compacting` injects the vault's `MEMORY.md` index as summarization context |
| Tools | with `memory.backend: off` the tools register under the **native names** `recall` / `retain` / `memory_edit`; with a native backend configured they register as `vault_search` / `vault_remember` / `vault_edit` so both stores coexist |
| Inspect | `/vault stats`, `/vault path`, `/vault reindex`, `/vault sync` (force extraction) |

`memory_edit` accepts `action: "update"` (replace page body) or `"forget"` (delete page), addressed by vault-relative path. Native `invalidate` has no vault equivalent and is not offered.

Auto recall/retain runs only in the main session; subagents share the vault but don't run their own loops. If the host lacks side-turn support, retention degrades to appending the raw excerpt to the daily log. Detection of a native backend keys off `ctx.memory`, so with `memory.backend: local` (which has no recall/retain tools but does provide the runtime facade) the tools register under `vault_*` names.

## Vault layout

```
<vault>/
  MEMORY.md              # generated index, grouped by tag
  topics/<slug>.md       # durable pages; repeated facts append dated sections
  daily/YYYY-MM-DD.md    # append-only capture log
```

Pages carry minimal YAML frontmatter (`title`, `created`, `updated`, `source`, `importance`, `tags`); hand edits in Obsidian (including block-style tag lists) parse fine. All writes are atomic and per-path serialized, so concurrent omp sessions can't interleave a page.

## Install

Published/development install into omp's plugin dir:

```sh
omp plugin install omp-memory-obsidian        # once published
```

Local development — point omp at the working tree (the `omp.extensions` manifest in package.json declares the entry):

```yaml
# ~/.omp/agent/config.yml
extensions:
  - ~/workspace/omp-memory-obsidian
```

Then open the vault in Obsidian: **Open folder as vault** → the vault root below.

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `OMP_MEMORY_VAULT` | see below | Vault root |
| `OMP_MEMORY_AUTO_RECALL` | `true` | Inject recall on prompts |
| `OMP_MEMORY_RECALL_LIMIT` | `5` | Max pages injected per prompt |
| `OMP_MEMORY_AUTO_RETAIN` | `true` | Extract memories automatically |
| `OMP_MEMORY_RETAIN_EVERY` | `4` | Turns between extractions |

Vault root resolution: `OMP_MEMORY_VAULT` → `<cwd>/.omp/memory-vault` if it exists (per-project vault) → platform default.

Platform default:

- **Native Windows** → `%USERPROFILE%\Documents\omp-memory-vault`
- **WSL** → `C:\Users\<user>\Documents\omp-memory-vault` (via `/mnt/c`, so Windows-side Obsidian opens it as a normal vault). The Windows user name is taken from `OMP_MEMORY_WINDOWS_USER`, else `USERPROFILE`, else the Linux `USER`. If `/mnt/c` or the profile isn't reachable, it falls back to the Linux home. Note: drvfs/9P doesn't deliver file-watch events into WSL, so Obsidian's graph may need a manual refresh after agent writes; our own search index doesn't rely on watchers. Existing vaults are never moved — this only selects the default for a fresh vault.
- **Linux/macOS** → `~/.omp/agent/memory-vault`

## Develop

```sh
bun install
bun test          # vault engine + extraction parsing
bun run typecheck
```

## Roadmap

- Pluggable embeddings for semantic recall (FTS only today)
- Core `MemoryBackend` PR to oh-my-pi so `/memory *` commands and `ctx.memory` route here — the `src/vault/` engine is backend-agnostic by design
