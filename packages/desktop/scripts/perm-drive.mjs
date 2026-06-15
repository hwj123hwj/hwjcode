/**
 * CDP driver for the permission approval round-trip.
 * Creates a 'default'-mode session, sends a prompt that forces a shell command,
 * waits for the PermissionDialog to appear, approves it, and confirms the tool ran.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const CWD = process.env.UI_CWD || 'D:/projects/deepVcode/DeepCode';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getPageWs() {
  const t = await (await fetch('http://localhost:9222/json')).json();
  const p = t.find((x) => x.type === 'page' && x.url.includes('5173'));
  return p.webSocketDebuggerUrl;
}
function cdp(ws) {
  const sock = new WebSocket(ws);
  let id = 0; const pend = {};
  const ready = new Promise((r) => sock.on('open', r));
  sock.on('message', (d) => { const m = JSON.parse(d); if (m.id && pend[m.id]) pend[m.id](m); });
  const evalJs = async (expr) => {
    const m = await new Promise((r) => { const i = ++id; pend[i] = r; sock.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })); });
    if (m.result?.exceptionDetails) throw new Error('eval exc: ' + JSON.stringify(m.result.exceptionDetails));
    return m.result?.result?.value;
  };
  return { ready, evalJs, close: () => sock.close() };
}

async function main() {
  const c = cdp(await getPageWs());
  await c.ready;
  if (!(await c.evalJs('!!window.__store'))) throw new Error('no __store');

  await c.evalJs(`window.__store.getState().createSession(${JSON.stringify(CWD)}, 'default')`);
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const st = await c.evalJs(`(()=>{const s=window.__store.getState();const v=s.sessions[s.activeSessionId];return v?v.meta.status:'none'})()`);
    if (st === 'idle') break;
    if (st === 'error') throw new Error('session error');
  }
  const sid = await c.evalJs('window.__store.getState().activeSessionId');
  console.log('[perm] session idle:', sid);

  console.log('[perm] sending file-delete prompt (forces a permission round-trip)...');
  await c.evalJs(`window.__store.getState().sendPrompt(${JSON.stringify(sid)}, 'Delete the file PERMTEST_DELETE_ME.txt in the current directory using the delete_file tool.', [])`);

  // Wait for a permission request to enter the queue + dialog to render.
  let req = null;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const q = await c.evalJs(`(()=>{const s=window.__store.getState();return JSON.stringify(s.permissionQueue.map(r=>({requestId:r.requestId,title:r.title,toolKind:r.toolKind,options:r.options.map(o=>({id:o.optionId,kind:o.kind}))})))})()`);
    const queue = JSON.parse(q);
    const status = await c.evalJs(`(()=>{const s=window.__store.getState();const v=s.sessions[s.activeSessionId];return v?v.meta.status:'?'})()`);
    if (queue.length) {
      req = queue[0];
      const dialog = await c.evalJs(`(()=>{const el=document.querySelector('[class*=permission], [class*=Permission], [class*=dialog], [class*=modal]');return el?el.innerText.slice(0,300):'NO-DIALOG-EL'})()`);
      console.log('[perm] permission request:', JSON.stringify(req));
      console.log('[perm] session status:', status);
      console.log('[perm] dialog DOM:', JSON.stringify(dialog));
      break;
    }
    if (status === 'idle') { console.log('[perm] turn ended with NO permission request (status idle)'); break; }
  }
  if (!req) {
    // Maybe ran without approval (mode/auto-allow). Show transcript to judge.
    const tx = await c.evalJs(`(()=>{const s=window.__store.getState();const v=s.sessions[s.activeSessionId];return JSON.stringify(v.transcript.map(i=>({k:i.kind,t:(i.title||i.text||'').slice(0,80),st:i.status})))})()`);
    console.log('[perm] transcript:', tx);
    throw new Error('no permission request observed');
  }

  // Approve (allow_once).
  const allow = req.options.find((o) => o.kind === 'allow_once') || req.options[0];
  console.log('[perm] approving with option:', allow.id);
  await c.evalJs(`window.__store.getState().respondPermission(${JSON.stringify(req.requestId)}, ${JSON.stringify(allow.id)})`);

  // Wait for the tool to complete + turn end; check transcript for the echo output.
  let ok = false;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    const tx = await c.evalJs(`(()=>{const s=window.__store.getState();const v=s.sessions[s.activeSessionId];return JSON.stringify(v.transcript.map(i=>({k:i.kind,t:(i.title||i.text||'').slice(0,60),st:i.status,term:(i.terminalOutput||'').slice(0,60)})))})()`);
    const status = await c.evalJs(`(()=>{const s=window.__store.getState();const v=s.sessions[s.activeSessionId];return v.meta.status})()`);
    const queueLen = await c.evalJs('window.__store.getState().permissionQueue.length');
    // Success = the approved tool reached 'completed' and the turn settled.
    const toolDone = await c.evalJs(`(()=>{const s=window.__store.getState();const v=s.sessions[s.activeSessionId];return v.transcript.some(i=>i.kind==='tool'&&i.status==='completed')})()`);
    if (toolDone && status === 'idle' && queueLen === 0) {
      ok = true;
      console.log('[perm] transcript:', tx, 'status:', status, 'queue:', queueLen);
      break;
    }
    if (status === 'idle' && queueLen === 0) {
      console.log('[perm] transcript:', tx, 'status:', status, 'queue:', queueLen);
      break;
    }
  }
  c.close();
  console.log(ok ? '[perm] PASS ✅ — approval round-trip executed the tool' : '[perm] PARTIAL — request+approve worked; verify tool output manually');
  process.exit(ok ? 0 : 2);
}
main().catch((e) => { console.error('[perm] ERROR:', e.message); process.exit(1); });
