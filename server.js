// Cloud relay (runs on Railway): password-protected web page + WebSocket bridge
// between the iPad (viewer) and the home agent that talks to the phone over ADB.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD;
const AGENT_TOKEN = process.env.AGENT_TOKEN;
if (!APP_PASSWORD || !AGENT_TOKEN) {
  console.error('Set the APP_PASSWORD and AGENT_TOKEN environment variables.');
  process.exit(1);
}

const hmac = (s) => crypto.createHmac('sha256', APP_PASSWORD).update(s).digest('hex');
const SESSION = hmac('viewer-session');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const cookieOf = (req, name) => {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : '';
};
const authed = (req) => safeEq(cookieOf(req, 'sid'), SESSION);

const viewerHtml = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
const loginHtml = (err) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Samsung Mirror</title>
<style>:root{color-scheme:dark}body{margin:0;height:100vh;display:grid;place-items:center;background:#111;color:#eee;font:17px -apple-system,system-ui,sans-serif}
form{display:flex;flex-direction:column;gap:12px;width:min(320px,86vw)}input,button{font:inherit;padding:12px;border-radius:12px;border:0}
input{background:#2a2a2e;color:#eee}button{background:#3478f6;color:#fff}p{margin:0;color:#ff6b6b}</style>
<form method="post" action="/login"><h2 style="margin:0">Samsung Mirror</h2>${err ? '<p>Wrong password</p>' : ''}
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus><button>Unlock</button></form>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return res.end('ok');
  if (req.method === 'POST' && url.pathname === '/login') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on('end', () => {
      const pw = new URLSearchParams(body).get('password') || '';
      setTimeout(() => { // small delay slows down password guessing
        if (safeEq(hmac(pw), hmac(APP_PASSWORD))) {
          const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
          res.writeHead(302, { 'Set-Cookie': `sid=${SESSION}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`, Location: '/' });
        } else res.writeHead(302, { Location: '/?e=1' });
        res.end();
      }, 800);
    });
    return;
  }
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(authed(req) ? viewerHtml : loginHtml(url.searchParams.has('e')));
  }
  res.writeHead(404);
  res.end('Not found');
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
let agent = null, info = null;
const viewers = new Set();
const status = () => JSON.stringify({ type: 'status', agent: !!agent, w: info ? info.w : 0, h: info ? info.h : 0 });
const toViewers = (msg) => viewers.forEach((v) => v.readyState === 1 && v.send(msg));
const notifyAgent = () => agent && agent.readyState === 1 && agent.send(JSON.stringify({ type: 'viewers', n: viewers.size }));

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
  let role = null;
  if (url.pathname === '/ws/agent' && safeEq(bearer, AGENT_TOKEN)) role = 'agent';
  else if (url.pathname === '/ws/viewer' && authed(req)) role = 'viewer';
  if (!role) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
  wss.handleUpgrade(req, socket, head, (ws) => onConnect(ws, role));
});

function onConnect(ws, role) {
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('error', () => {});
  if (role === 'agent') {
    if (agent) agent.terminate();
    agent = ws; info = null;
    toViewers(status());
    notifyAgent();
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        for (const v of viewers) if (v.readyState === 1 && v.bufferedAmount < 1e6) v.send(data, { binary: true });
        return;
      }
      try {
        const m = JSON.parse(data.toString());
        if (m.type === 'info' && m.w > 0 && m.h > 0) { info = { w: +m.w, h: +m.h }; toViewers(status()); }
      } catch {}
    });
    ws.on('close', () => { if (agent === ws) { agent = null; info = null; toViewers(status()); } });
  } else {
    viewers.add(ws);
    ws.send(status());
    notifyAgent();
    ws.on('message', (data, isBinary) => {
      if (!isBinary && data.length < 500 && agent && agent.readyState === 1) agent.send(data.toString());
    });
    ws.on('close', () => { viewers.delete(ws); notifyAgent(); });
  }
}

setInterval(() => wss.clients.forEach((c) => {
  if (!c.isAlive) return c.terminate();
  c.isAlive = false;
  c.ping();
}), 25000);

server.listen(PORT, '0.0.0.0', () => console.log(`Phone mirror relay listening on ${PORT}`));
