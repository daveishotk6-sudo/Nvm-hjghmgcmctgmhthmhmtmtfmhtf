// Netlify Function relay (replaces the Railway WebSocket server).
// Netlify can't hold WebSockets, so the home agent and the iPad talk to this
// function over plain HTTP and share state through Netlify Blobs:
//   agent  --POST /api/frame-->  blob "frame"  --long-poll GET /api/frame-->  iPad
//   iPad   --POST /api/input-->  blobs "cmd/*" --long-poll GET /api/agent/wait--> agent
import { getStore } from '@netlify/blobs';
import crypto from 'node:crypto';
import { loginHtml, viewerHtml } from './viewer-html.mjs';

export const config = { path: ['/', '/api/*'] };

const APP_PASSWORD = process.env.APP_PASSWORD;
const AGENT_TOKEN = process.env.AGENT_TOKEN;
const POLL_MS = 7000;        // stay under Netlify's 10s sync function limit
const VIEWER_TTL = 10000;    // viewer counts as present this long after its last poll
const AGENT_TTL = 20000;
const CMD_TTL = 5000;        // drop taps older than this instead of replaying them late

const hmac = (s) => crypto.createHmac('sha256', APP_PASSWORD).update(s).digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const cookieOf = (req, name) => {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : '';
};
const viewerAuthed = (req) => safeEq(cookieOf(req, 'sid'), hmac('viewer-session'));
const agentAuthed = (req) => safeEq((req.headers.get('authorization') || '').replace(/^Bearer /, ''), AGENT_TOKEN);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export default async (req, context) => {
  if (!APP_PASSWORD || !AGENT_TOKEN)
    return new Response('Set the APP_PASSWORD and AGENT_TOKEN environment variables in Netlify.', { status: 500 });

  const url = new URL(req.url);
  const path = url.pathname;
  const store = getStore({ name: 'mirror', consistency: 'strong' });

  if (path === '/') {
    return new Response(viewerAuthed(req) ? viewerHtml : loginHtml(url.searchParams.has('e')), {
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  if (path === '/api/login' && req.method === 'POST') {
    const pw = new URLSearchParams((await req.text()).slice(0, 10000)).get('password') || '';
    await sleep(800); // slows down password guessing
    if (!safeEq(hmac(pw), hmac(APP_PASSWORD))) return new Response(null, { status: 302, headers: { location: '/?e=1' } });
    return new Response(null, {
      status: 302,
      headers: { location: '/', 'set-cookie': `sid=${hmac('viewer-session')}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000; Secure` },
    });
  }

  // ---------- viewer (iPad) ----------
  if (path === '/api/frame' && req.method === 'GET') {
    if (!viewerAuthed(req)) return new Response('Unauthorized', { status: 401 });
    const since = url.searchParams.get('seq') || '0';
    context.waitUntil(store.set('viewer', String(Date.now())));
    const deadline = Date.now() + POLL_MS;
    for (;;) {
      const f = await store.getMetadata('frame');
      if (f && String(f.metadata.seq) !== since) {
        const buf = await store.get('frame', { type: 'arrayBuffer' });
        if (buf) return new Response(buf, { headers: {
          'content-type': 'image/jpeg', 'cache-control': 'no-store',
          'x-seq': String(f.metadata.seq), 'x-w': String(f.metadata.w), 'x-h': String(f.metadata.h) } });
      }
      if (Date.now() >= deadline) break;
      await sleep(80);
    }
    const [f, a] = await Promise.all([store.getMetadata('frame'), store.getMetadata('agent')]);
    const last = Math.max(+(f?.metadata.t || 0), +(a?.metadata.t || 0));
    return new Response(null, { status: 204, headers: { 'x-agent': Date.now() - last < AGENT_TTL ? '1' : '0', 'cache-control': 'no-store' } });
  }

  if (path === '/api/input' && req.method === 'POST') {
    if (!viewerAuthed(req)) return new Response('Unauthorized', { status: 401 });
    const body = await req.text();
    if (body.length > 500) return new Response('Too large', { status: 413 });
    await store.set(`cmd/${String(Date.now()).padStart(15, '0')}-${crypto.randomBytes(3).toString('hex')}`, body);
    return json({ ok: true });
  }

  // ---------- agent (home computer) ----------
  const viewersNow = async () => Date.now() - +((await store.get('viewer')) || 0) < VIEWER_TTL;

  if (path === '/api/frame' && req.method === 'POST') {
    if (!agentAuthed(req)) return new Response('Unauthorized', { status: 401 });
    const buf = await req.arrayBuffer();
    const meta = { seq: `${Date.now()}${Math.floor(Math.random() * 1000)}`, t: Date.now(),
      w: +req.headers.get('x-w') || 0, h: +req.headers.get('x-h') || 0 };
    // Write the frame and read presence in parallel to keep the round trip short.
    const [, viewers] = await Promise.all([store.set('frame', buf, { metadata: meta }), viewersNow()]);
    return json({ viewers });
  }

  if (path === '/api/agent/wait' && req.method === 'GET') {
    if (!agentAuthed(req)) return new Response('Unauthorized', { status: 401 });
    const had = url.searchParams.get('v') === '1';
    context.waitUntil(store.set('agent', 'x', { metadata: { t: Date.now(), w: +url.searchParams.get('w') || 0, h: +url.searchParams.get('h') || 0 } }));
    const deadline = Date.now() + POLL_MS;
    for (;;) {
      const [{ blobs }, viewers] = await Promise.all([store.list({ prefix: 'cmd/' }), viewersNow()]);
      if (blobs.length || viewers !== had || Date.now() >= deadline) {
        const cmds = [];
        for (const b of blobs.sort((x, y) => (x.key < y.key ? -1 : 1))) {
          const raw = await store.get(b.key);
          await store.delete(b.key);
          const ts = +b.key.slice(4, 19);
          if (raw && Date.now() - ts < CMD_TTL) { try { cmds.push(JSON.parse(raw)); } catch {} }
        }
        return json({ viewers, cmds });
      }
      await sleep(150);
    }
  }

  return new Response('Not found', { status: 404 });
};
