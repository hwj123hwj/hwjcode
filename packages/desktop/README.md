# Easy Code Desktop

A Claude-Code-Desktop-style GUI for Easy Code, built on **the same agent core**
as the CLI and VSCode plugin.

## Architecture

The desktop app is an **Electron** front-end that drives the agent core as a
separate process — exactly how Claude Code Desktop spawns CLI sessions. It never
reimplements the agent:

```
Electron main (Node)                         spawned per session
┌───────────────────────────┐   ACP/stdio   ┌──────────────────────────┐
│ SessionHub                 │ ───────────▶  │ easycode --acp           │
│  └ AcpSessionBridge        │ ◀─────────── │  (packages/cli ACP server │
│     (acp.ClientSideConn.)  │  sessionUpdate│   driving packages/core)  │
│ auth (ProxyAuthManager)    │  requestPerm. └──────────────────────────┘
│ IPC handlers               │
└──────────┬────────────────┘
           │ contextBridge (window.easycode)
┌──────────▼────────────────┐
│ Renderer (React + Vite)    │  sidebar · pane grid (chat/diff/plan/tasks/
│                            │  terminal/file) · permission dialog · prompt bar
└────────────────────────────┘
```

- **Backend**: `node bundle/easycode.js --acp` (the CLI's ACP server mode). The
  desktop is the ACP *client*, modeled on `packages/core/src/acp-client/
  acpAgentClient.ts`.
- **Auth**: shared with the CLI. Credentials live in `~/.easycode-user/`
  (`ProxyAuthManager`). The desktop offers its own login entry (browser/OAuth via
  core's `AuthServer`, or API key), writing to the same store — so login here
  logs you into the CLI too, and vice-versa.

## Develop

From the repo root:

```bash
npm install                 # installs all workspaces incl. desktop
npm run desktop:dev         # builds the agent bundle (dev) + launches Electron
```

`desktop:dev` runs `bundle:dev` first so `bundle/easycode.js` exists for the
backend to spawn. To point at a custom backend, set `EASYCODE_BACKEND_JS`.

Useful env (mirrors the CLI):

- `DEEPX_SERVER_URL` — proxy/auth server (default `https://api-code.deepvlab.ai`)
- `DEEPX_WEB_URL` — web login URL
- `EASYCODE_BACKEND_JS` — absolute path to the agent entry to spawn

## Package

Run from the repo root — these build a **production** agent bundle
(`BUILD_ENV=production`, so the live `api-code.deepvlab.ai` server is baked in and
existing CLI creds are reused) and then the installer for each OS:

```bash
npm run pack:desktop:win      # Windows NSIS installer
npm run pack:desktop:mac      # macOS dmg/zip
npm run pack:desktop:linux    # Linux AppImage
npm run pack:desktop          # all three (per-OS toolchain still required:
                              # mac dmg needs macOS, etc. — use a CI matrix)
```

`desktop:pack:win` / `desktop:pack:mac` are kept as aliases of the above.

Artifacts land in `packages/desktop/release/<version>/`. The agent bundle is
copied into the app under `resources/backend` via `electron-builder.yml`.

> Note: `deepv-code-core` is a `file:` workspace dep (symlinked, hoisted to the
> repo-root `node_modules`). electron-builder can't pack a symlink whose realpath
> escapes the app dir, so `scripts/pack-installer.cjs` wraps electron-builder:
> it swaps the link for a real `dist`-only copy during the pack and restores the
> link afterwards. `electron` is pinned (not `^`) so electron-builder can resolve
> its version under workspace hoisting.

## Feature map (Claude Code Desktop parity)

| Pattern | Status |
|---|---|
| Session = isolated unit (own cwd), sidebar with status/project filters + grouping | ✅ |
| Permission-mode selector (Plan / Ask / Auto-accept / Auto / Bypass), mid-session | ✅ (mapped to core default/autoEdit/yolo) |
| Streaming transcript, tool-call collapse/expand | ✅ |
| View-density toggle (Summary / Normal / Verbose) | ✅ |
| Pane grid: chat · diff · plan · tasks · terminal · file | ✅ |
| Diff viewer with inline comments → batch submit → re-prompt; "Review code" self-review | ✅ |
| Permission approval dialog with diff preview | ✅ |
| Steer-while-running (prompt during a turn) | ✅ |
| @file references with autocomplete | ✅ |
| Slash commands (`available_commands_update`) | ✅ (surfaced) |
| Resume / rewind (`session/load`, `_dvcode/session/rewind`) | ✅ |
| Runtime model switching + token/usage indicator | ✅ |
| MCP connectors UI | ◻ planned |
| Remote/SSH environments | ◻ planned |
