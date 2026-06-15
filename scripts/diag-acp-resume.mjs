/**
 * Standalone diagnostic for the desktop's session resume flow, WITHOUT Electron.
 *
 * Drives the real bundled backend (`bundle/easycode.js --acp`) as an ACP client,
 * mirroring packages/desktop/src/main/acpSession.ts:
 *   1. spawn backend → initialize → newSession → prompt (a tiny turn)
 *   2. kill the backend (simulates closing the app)
 *   3. inspect the on-disk session store (did the turn persist?)
 *   4. spawn a fresh backend → initialize → loadSession(sameId)
 *   5. capture every session/update the load replays (the "history")
 *
 * Run: node scripts/diag-acp-resume.mjs
 */
import * as acp from '@agentclientprotocol/sdk';
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const BACKEND = path.join(repoRoot, 'bundle', 'easycode.js');
const CWD = repoRoot; // use the repo as the project dir

function projectTempDir(projectRoot) {
  const hash = crypto.createHash('sha256').update(projectRoot).digest('hex');
  return path.join(os.homedir(), '.easycode-user', 'tmp', hash);
}

function makeClient(label, onUpdate) {
  return {
    async requestPermission(params) {
      const opt =
        params.options.find((o) => o.kind === 'allow_always') ??
        params.options.find((o) => o.kind === 'allow_once') ??
        params.options[0];
      return { outcome: { outcome: 'selected', optionId: opt.optionId } };
    },
    async sessionUpdate(params) {
      onUpdate?.(params.update);
    },
    async readTextFile(p) {
      return { content: fs.readFileSync(p.path, 'utf8') };
    },
    async writeTextFile(p) {
      fs.mkdirSync(path.dirname(p.path), { recursive: true });
      fs.writeFileSync(p.path, p.content, 'utf8');
      return {};
    },
  };
}

function startBackend(label, onUpdate) {
  const child = spawn(process.execPath, [BACKEND, '--acp'], {
    cwd: CWD,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  let stderr = '';
  child.stderr.on('data', (b) => (stderr = (stderr + b).slice(-4000)));
  child.stdin.on('error', () => {});
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );
  const conn = new acp.ClientSideConnection(() => makeClient(label, onUpdate), stream);
  return { child, conn, getStderr: () => stderr };
}

const INIT = {
  protocolVersion: acp.PROTOCOL_VERSION,
  clientCapabilities: {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: false,
    _meta: { terminal_output: true },
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!fs.existsSync(BACKEND)) throw new Error(`backend not found: ${BACKEND}`);
  console.log('backend:', BACKEND);
  console.log('cwd    :', CWD);

  // ── Phase 1: create + one prompt turn ────────────────────────────────────
  console.log('\n=== PHASE 1: newSession + prompt ===');
  const b1 = startBackend('b1');
  await b1.conn.initialize(INIT);
  const created = await b1.conn.newSession({ cwd: CWD, mcpServers: [] });
  const sessionId = created.sessionId;
  console.log('newSession sessionId:', sessionId);

  let answer = '';
  b1.conn = b1.conn; // noop
  const onUpd1 = (u) => {
    if (u.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
      answer += u.content.text;
    }
  };
  // Rewire the client to capture chunks (recreate connection handler view).
  // Simplest: just send prompt and rely on the handler we already installed,
  // so install capture by reattaching: we re-create with a capturing client.
  // (We didn't capture in b1's client; send prompt and poll history on disk.)
  const promptRes = await b1.conn.prompt({
    sessionId,
    prompt: [{ type: 'text', text: 'Reply with exactly the word PONG and nothing else.' }],
  });
  console.log('prompt stopReason:', promptRes.stopReason);
  await sleep(500);

  // ── Phase 2: inspect disk BEFORE killing (persist runs in finally) ───────
  const sdir = path.join(projectTempDir(CWD), 'sessions', sessionId);
  const histPath = path.join(sdir, 'history.json');
  const ctxPath = path.join(sdir, 'context.json');
  const idxPath = path.join(projectTempDir(CWD), 'sessions', 'index.json');
  const readJson = (p) => {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (e) {
      return { __error: e.code || String(e) };
    }
  };
  console.log('\n=== PHASE 2: on-disk session store ===');
  console.log('sessionDir       :', sdir);
  const hist = readJson(histPath);
  const ctx = readJson(ctxPath);
  console.log('history.json     :', Array.isArray(hist) ? `${hist.length} items` : hist);
  console.log('context.json     :', Array.isArray(ctx) ? `${ctx.length} items` : ctx);
  if (Array.isArray(hist) && hist.length) {
    console.log('history[0] keys  :', Object.keys(hist[0]));
    console.log('history[0]       :', JSON.stringify(hist[0]).slice(0, 200));
  }
  const idx = readJson(idxPath);
  const inIndex = Array.isArray(idx?.sessions) && idx.sessions.some((s) => s.sessionId === sessionId);
  console.log('in index.json    :', inIndex);

  b1.child.kill();
  await sleep(300);

  // ── Phase 3: fresh backend, loadSession, capture replay ──────────────────
  console.log('\n=== PHASE 3: fresh backend → loadSession ===');
  const replay = [];
  const b2 = startBackend('b2', (u) => replay.push(u));
  await b2.conn.initialize(INIT);
  let loadOk = false;
  let loadErr = null;
  try {
    const loaded = await b2.conn.loadSession({ sessionId, cwd: CWD, mcpServers: [] });
    loadOk = true;
    console.log('loadSession OK. keys:', Object.keys(loaded));
  } catch (e) {
    loadErr = e?.message || String(e);
    console.log('loadSession THREW:', loadErr);
    console.log('b2 stderr tail:', b2.getStderr().slice(-800));
  }
  await sleep(800); // let streamHistory replay arrive
  console.log('replay events    :', replay.length);
  const kinds = {};
  for (const u of replay) kinds[u.sessionUpdate] = (kinds[u.sessionUpdate] || 0) + 1;
  console.log('replay by kind   :', JSON.stringify(kinds));
  for (const u of replay.slice(0, 6)) {
    const t = u.content?.text ? ` "${u.content.text.slice(0, 60)}"` : '';
    console.log('   -', u.sessionUpdate + t);
  }

  b2.child.kill();

  // ── Verdict ──────────────────────────────────────────────────────────────
  console.log('\n=== VERDICT ===');
  console.log('persisted history :', Array.isArray(hist) && hist.length > 0 ? 'YES' : 'NO');
  console.log('loadSession works :', loadOk ? 'YES' : `NO (${loadErr})`);
  console.log('replayed messages :',
    (kinds['agent_message_chunk'] || 0) + (kinds['user_message_chunk'] || 0));
  process.exit(0);
}

main().catch((e) => {
  console.error('DIAG FAILED:', e);
  process.exit(1);
});
