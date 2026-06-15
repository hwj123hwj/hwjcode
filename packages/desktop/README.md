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

## Signed & notarized macOS DMG

`npm run pack:desktop:mac` produces an **unsigned** build. To ship a DMG that
Gatekeeper accepts on other Macs you must **code-sign with a Developer ID
certificate and notarize with Apple**. The repo ships a one-command wrapper for
this — run it from the repo root:

```bash
npm run pack:mac:dmg            # build + Developer ID sign + Apple notarize + DMG
# (alias: npm run desktop:pack:mac:notarize — identical)
```

This runs `packages/desktop/scripts/interactive-build.cjs`, which resolves your
Apple credentials automatically (env vars → macOS Keychain), then drives
electron-builder's `notarize: true` flow (see `electron-builder.yml`). The
finished DMG lands in `packages/desktop/release/<version>/`.

### One-time setup (per Mac that packages)

Notarization/signing tooling is **macOS-only** (`codesign`, `xcrun notarytool`),
so this must run on a Mac. Each packaging machine needs three things:

1. **Xcode command-line tools**

   ```bash
   xcode-select --install
   ```

2. **The `Developer ID Application` certificate (with private key)** imported
   into the *login* keychain. Export it from a machine that already has it as a
   `.p12` and double-click to import, or request a new one from the Apple
   Developer portal. The whole team shares the same Developer ID certificate.

3. **The Apple App-specific password stored in the Keychain** — never hard-code
   it. The build script reads the entry named `EC_APPLE_NOTARY`:

   ```bash
   security add-generic-password \
     -a "<your-apple-id-email>" \
     -s "EC_APPLE_NOTARY" \
     -w "<app-specific-password>" \
     -U
   ```

   Generate the app-specific password at <https://appleid.apple.com> →
   Sign-In and Security → App-Specific Passwords (this is **not** your Apple
   account password).

4. **Shell env vars** (e.g. in `~/.zshrc`) — note the password is read from the
   Keychain, *not* written in plain text:

   ```bash
   export APPLE_ID="<your-apple-id-email>"
   export APPLE_TEAM_ID="6LUTP4CUH2"
   # electron-builder notarytool reads APPLE_APP_SPECIFIC_PASSWORD (NOT APPLE_ID_PASSWORD)
   export APPLE_APP_SPECIFIC_PASSWORD="$(security find-generic-password -a "$APPLE_ID" -s "EC_APPLE_NOTARY" -w 2>/dev/null)"
   ```

The build script falls back to a masked interactive prompt if neither the env
vars nor the Keychain entry are available, so it still works on an un-configured
machine.

### Team collaboration

- **Signing is tied to the Team, not to one person.** Any Apple ID that is a
  member of Team `6LUTP4CUH2` can sign and notarize. Each member uses **their
  own** Apple ID + **their own** app-specific password — do not share personal
  Apple ID passwords.
- Adding members requires an **Organization** developer account (an *Individual*
  account cannot add team members). Invite people in App Store Connect → Users
  and Access, the **Developer** role is enough for signing/notarizing.
- To package on another Mac, copy what is *portable*: import the Developer ID
  `.p12` (contains the private key — transfer securely, set a strong password,
  never commit it) and configure the Keychain entry above. It is **not** locked
  to any single machine.

### Verify a finished build

```bash
xcrun stapler validate "release/<version>/Easy Code.app"      # ticket stapled?
spctl -a -vvv -t install "release/<version>/Easy Code-<version>-arm64.dmg"
# expect: source=Notarized Developer ID  →  accepted
```

> ⚠️ Notarization (`notarytool ... --wait`) uploads to Apple and **blocks with no
> terminal output** while Apple's servers review — this can take minutes to tens
> of minutes. No output ≠ stuck. If it truly hangs, the usual cause is a hidden
> Keychain-access authorization prompt; the runner must execute as a logged-in
> GUI user so `codesign` can reach the private key.

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
