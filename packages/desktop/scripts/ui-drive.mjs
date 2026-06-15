/**
 * CDP UI driver — connects to a running `electron-vite dev` (--remote-debugging-port=9222),
 * drives the renderer store to create a session + send a prompt, and reports the
 * DOM state so we can confirm ChatPane + PromptBar render and the reply streams.
 *
 *   node packages/desktop/scripts/ui-drive.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');

const CWD = process.env.UI_CWD || 'D:/projects/deepVcode/DeepCode';

async function getPageWs() {
  const res = await fetch('http://localhost:9222/json');
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('5173'));
  if (!page) throw new Error('no renderer page target');
  return page.webSocketDebuggerUrl;
}

function cdp(ws) {
  const sock = new WebSocket(ws);
  let id = 0;
  const pend = {};
  const ready = new Promise((r) => sock.on('open', r));
  sock.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.id && pend[m.id]) pend[m.id](m);
  });
  const send = (method, params) =>
    new Promise((r) => {
      const i = ++id;
      pend[i] = r;
      sock.send(JSON.stringify({ id: i, method, params: params || {} }));
    });
  const evalJs = async (expr) => {
    const m = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (m.result && m.result.exceptionDetails) {
      throw new Error('eval exception: ' + JSON.stringify(m.result.exceptionDetails));
    }
    return m.result?.result?.value;
  };
  return { ready, send, evalJs, close: () => sock.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const wsUrl = await getPageWs();
  const c = cdp(wsUrl);
  await c.ready;
  await c.send('Runtime.enable');

  const hasStore = await c.evalJs('!!window.__store');
  console.log('[ui] window.__store present:', hasStore);
  if (!hasStore) throw new Error('store not exposed — HMR may not have applied; reload needed');

  console.log('[ui] creating session, cwd=', CWD);
  await c.evalJs(`window.__store.getState().createSession(${JSON.stringify(CWD)}, 'default')`);

  // Wait for the session to start (backend spawn + newSession).
  let started = false;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const st = await c.evalJs(`(()=>{const s=window.__store.getState();const id=s.activeSessionId;const v=id&&s.sessions[id];return v?JSON.stringify({id,status:v.meta.status,model:v.meta.model,models:v.meta.availableModels.length}):'none'})()`);
    console.log('[ui] session state:', st);
    const parsed = st !== 'none' ? JSON.parse(st) : null;
    if (parsed && (parsed.status === 'idle')) { started = true; break; }
    if (parsed && parsed.status === 'error') throw new Error('session entered error state');
  }
  if (!started) throw new Error('session did not reach idle');

  // Confirm ChatPane + PromptBar rendered.
  const dom1 = await c.evalJs(`JSON.stringify({
    chatPane: !!document.querySelector('[class*=chat]'),
    promptBar: !!document.querySelector('textarea, [class*=prompt]'),
    sessionViewText: (document.querySelector('.app')||document.body).innerText.slice(0,200)
  })`);
  console.log('[ui] DOM after session create:', dom1);

  // Send a prompt.
  console.log('[ui] sending prompt...');
  const sid = await c.evalJs('window.__store.getState().activeSessionId');
  await c.evalJs(`window.__store.getState().sendPrompt(${JSON.stringify(sid)}, 'Reply with exactly the word: PONG', [])`);

  // Wait for streamed assistant reply.
  let reply = '';
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    reply = await c.evalJs(`(()=>{const s=window.__store.getState();const v=s.sessions[s.activeSessionId];if(!v)return '';const a=[...v.transcript].reverse().find(x=>x.kind==='assistant');return a?a.text:''})()`);
    const status = await c.evalJs(`(()=>{const s=window.__store.getState();const v=s.sessions[s.activeSessionId];return v?v.meta.status:'?'})()`);
    if (reply) console.log(`[ui] assistant text so far (status=${status}):`, JSON.stringify(reply));
    if (reply && status === 'idle') break;
  }

  const finalDom = await c.evalJs(`(()=>{const t=document.querySelector('[class*=chat], .app').innerText;return t.slice(0,400)})()`);
  console.log('[ui] final chat DOM text:\n', finalDom);

  c.close();
  if (reply && reply.includes('PONG')) {
    console.log('[ui] PASS ✅ — prompt streamed to UI');
    process.exit(0);
  } else {
    console.log('[ui] FAIL ❌ — no PONG in assistant transcript');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[ui] ERROR:', e.message);
  process.exit(1);
});
