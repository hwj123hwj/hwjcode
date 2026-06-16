/**
 * Standalone ACP smoke test — reproduces packages/desktop/src/main/acpSession.ts
 * spawn → initialize → newSession → prompt chain WITHOUT Electron's window.
 *
 * Spawns the same backend the desktop drives (electron-as-node + bundle/easycode.js
 * --acp), runs one prompt, prints streamed updates, and auto-approves any
 * requestPermission to exercise the approval round-trip. Exits non-zero on failure.
 *
 *   node packages/desktop/scripts/acp-smoke.mjs "your prompt here"
 */
import * as acp from '@agentclientprotocol/sdk';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const backendEntry =
  process.env.EASYCODE_BACKEND_JS ||
  path.join(repoRoot, 'bundle', 'easycode.js');
const electronExe = path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe');

if (!existsSync(backendEntry)) {
  console.error('Backend entry not found:', backendEntry);
  process.exit(2);
}
const command = existsSync(electronExe) ? electronExe : process.execPath;

const promptText = process.argv[2] || 'Reply with exactly the word: PONG. Nothing else.';
const cwd = process.env.SMOKE_CWD || repoRoot;

console.error(`[smoke] backend = ${backendEntry}`);
console.error(`[smoke] command = ${command}`);
console.error(`[smoke] cwd     = ${cwd}`);

const child = spawn(command, [backendEntry, '--acp'], {
  cwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DEEPX_SERVER_URL: process.env.DEEPX_SERVER_URL || 'https://api-code.deepvlab.ai',
    DEEPX_WEB_URL: process.env.DEEPX_WEB_URL || 'https://dvcode.deepvlab.ai',
  },
});

child.stderr.on('data', (b) => process.stderr.write(`[backend] ${b}`));
child.on('exit', (code) => console.error(`[smoke] backend exited code=${code}`));

let sawText = false;

const handler = {
  async requestPermission(params) {
    const opts = params.options || [];
    console.error(`[smoke] requestPermission: ${params.toolCall?.title} -> options:`,
      opts.map((o) => `${o.optionId}(${o.kind})`).join(', '));
    // Approve once if available, else pick the first allow-ish option.
    const pick =
      opts.find((o) => o.kind === 'allow_once') ||
      opts.find((o) => o.kind === 'allow_always') ||
      opts[0];
    console.error(`[smoke] auto-selecting: ${pick?.optionId}`);
    return { outcome: { outcome: 'selected', optionId: pick.optionId } };
  },
  async sessionUpdate(params) {
    const u = params.update;
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const t = u.content?.type === 'text' ? u.content.text : '';
        if (t) { sawText = true; process.stdout.write(t); }
        break;
      }
      case 'agent_thought_chunk':
        process.stderr.write(`\n[thought] ${u.content?.text ?? ''}\n`);
        break;
      case 'tool_call':
        console.error(`\n[tool_call] ${u.kind} :: ${u.title}`);
        break;
      case 'tool_call_update':
        console.error(`[tool_update] ${u.toolCallId} -> ${u.status ?? ''}`);
        break;
      case 'plan':
        console.error(`[plan] ${(u.entries ?? []).length} entries`);
        break;
      default:
        break;
    }
  },
  async readTextFile() { return { content: '' }; },
  async writeTextFile() { return {}; },
};

const stream = acp.ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout),
);
const conn = new acp.ClientSideConnection(() => handler, stream);

async function main() {
  console.error('[smoke] initialize...');
  const init = await conn.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: false,
      _meta: { terminal_output: true },
    },
  });
  console.error('[smoke] initialize OK. protocolVersion=', init.protocolVersion);

  console.error('[smoke] newSession...');
  const created = await conn.newSession({ cwd, mcpServers: [] });
  console.error('[smoke] newSession OK. sessionId=', created.sessionId);
  const models = created.models?.availableModels?.length ?? 0;
  console.error(`[smoke] models available=${models}, current=${created.models?.currentModelId ?? '?'}`);

  console.error(`[smoke] prompt: ${JSON.stringify(promptText)}`);
  const res = await conn.prompt({
    sessionId: created.sessionId,
    prompt: [{ type: 'text', text: promptText }],
  });
  console.error(`\n[smoke] prompt done. stopReason=${res.stopReason}, sawText=${sawText}`);
  return sawText;
}

const timeout = setTimeout(() => {
  console.error('[smoke] TIMEOUT after 90s');
  child.kill();
  process.exit(3);
}, 90_000);

main()
  .then((ok) => {
    clearTimeout(timeout);
    child.kill();
    console.error(ok ? '[smoke] PASS ✅' : '[smoke] FAIL ❌ (no text received)');
    process.exit(ok ? 0 : 1);
  })
  .catch((err) => {
    clearTimeout(timeout);
    child.kill();
    console.error('[smoke] ERROR:', err);
    process.exit(1);
  });
