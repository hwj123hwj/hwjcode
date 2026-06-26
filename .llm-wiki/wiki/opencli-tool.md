# OpenCliTool

## Overview

OpenCliTool is a thin, agent-native wrapper around the `opencli` CLI, which turns an already-logged-in real Chrome into a deterministic, CDP-driven browser the agent can script. It allows inspecting pages, filling forms, clicking through authenticated flows, and extracting data — reusing the user's browser session (no re-login, no scraping fragility).

## Key Features

1. **Thin primitive surface, knowledge in a skill**: This tool only exposes opencli's browser primitives as a passthrough argv. Per-site know-how lives in the `opencli-browser` skill.

2. **No shell, exact argv**: Spawns with `shell:false` against the resolved JS entry (or falls back to the binary) and passes `args` as a verbatim argv array — no hand-rolled quoting, no injection surface.

3. **Read passes, writes confirm**: Inspection verbs run unattended; any page mutation (click/type/fill/select/keys/upload/…) goes through the approval gate, and "always allow" whitelists that verb for the session.

4. **Health preflight**: Before the first browser command we probe the local daemon and extension so a missing prerequisite returns one clear, classified error instead of a confusing mid-flow failure.

5. **Structured error classification**: daemon-not-running / extension / not-logged-in / stale-ref / CDP-detach / timeout are surfaced as a machine-readable `errorKind` with an actionable hint.

## Session Model

- `browser` commands take a `<session>` positional right after `browser`: args=["browser","<session>","<verb>",...]
- Reuse the same session name across calls to keep the tab/state alive; use a different name for parallel work.
- State persists daemon-side.

## Core Rules

1. **Inspect before acting**: Run `state` or `find` first; numeric `[N]` refs are per-snapshot — never hard-code one from memory.

2. **After a navigation/submit**: Take a fresh `state`; old refs go stale.

3. **Verify writes that matter**: After `type`, run `get value`; check `match_level` (exact|stable|reidentified).

4. **Branch on the structured `error.code`**: Not on message text.

## Primitives

### Inspect (read)
- `state` | `find --css <sel>` | `find --role <r> --name <n>`
- `get title|url|text|value|attributes <target>` | `get html [--as json]`
- `frames` | `screenshot` | `network [--detail <key>]` | `extract` | `eval "<js>"`

### Interact (write — needs confirmation)
- `click` | `dblclick` | `hover` | `focus`
- `type <t> <text>` | `fill <t> <text>` | `select <t> <opt>`
- `check` | `uncheck` | `upload <t> <file>` | `drag <s> <t>`
- `keys <key>` | `scroll <dir>`

### Navigate (write)
- `open <url>` | `back` | `reload`
- `wait selector|text|download|time`
- `tab list|new|select|close`

## Error Kinds

| Kind | Description | Hint |
|------|-------------|------|
| `daemon-not-running` | OpenCLI daemon is not running | Run `opencli ["doctor"]` to diagnose |
| `extension-not-connected` | Browser Bridge Chrome extension not connected | Make sure Chrome is open and extension is installed |
| `not-logged-in` | Target site not logged in | Ask user to log in to the site in their Chrome |
| `stale-ref` | Numeric ref is stale (page changed) | Re-run `["browser","<session>","state"]` |
| `selector` | Target could not be resolved | Re-run `state`/`find` to get a valid ref |
| `cdp-detached` | Transient CDP/extension hiccup | Re-run `state` and retry the command |
| `timeout` | Command timed out | For `wait` commands raise the `timeout` param |
| `empty` | No data returned | Page structure may have changed |
| `not-installed` | OpenCLI is not installed | Run `npm install -g @jackwener/opencli@latest` |
| `launch-error` | Failed to launch opencli | Check binaryPath parameter |
| `aborted` | Execution was cancelled | - |
| `unknown` | Unknown error | - |

## Setup / Troubleshooting

1. **not-installed**: Run `npm install -g @jackwener/opencli@latest` (via run_shell_command), then retry this tool — it re-probes automatically, no easycode restart needed.

2. **Prerequisites**: The opencli daemon, the Browser Bridge Chrome extension, and a logged-in Chrome. If a command fails with daemon-not-running or extension-not-connected, run args=["doctor"] and follow its guidance.

3. **not-logged-in / auth_required**: The user must log in to the site in their Chrome; opencli reuses that session.

4. **stale-ref / selector errors**: Re-run `state` and use a fresh ref.

## Recent Fix (2026-06-26)

**Bug**: The `hintFor` method used `join('\\n')` which produced literal backslash-n characters instead of actual newlines. This caused hint messages to display incorrectly.

**Fix**: Changed `join('\\n')` to `join('\n')` to produce proper line breaks in hint messages.

## Related Files

- `packages/core/src/tools/opencli.ts` - Main implementation
- `packages/core/src/tools/opencli.test.ts` - Tests
- `packages/core/src/config/config.ts` - Tool registration