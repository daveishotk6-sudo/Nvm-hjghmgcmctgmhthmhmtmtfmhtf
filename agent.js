// Home agent: runs on a computer that has the Samsung attached via ADB.
// Talks to the Netlify relay over plain HTTPS (Netlify can't host WebSockets):
//   - a long-poll loop (/api/agent/wait) receives taps/swipes and viewer on/off
//   - screen frames are POSTed to /api/frame, newest-wins, with a few uploads in flight
// Needs Node 18+, adb and ffmpeg. No npm install required.
const { spawn, execFile } = require('child_process');

const SERVER = (process.env.SERVER_URL || '').replace(/\/$/, '');
const TOKEN = process.env.AGENT_TOKEN;
const SERIAL = process.env.ADB_SERIAL;
const OUT_W = +process.env.STREAM_WIDTH || 540;     // smaller = faster frames
const QUALITY = process.env.JPEG_Q || '8';          // ffmpeg mjpeg -q:v (2 best .. 31 worst)
const INFLIGHT = +process.env.INFLIGHT || 2;        // parallel frame uploads
if (!SERVER || !TOKEN) {
  console.error('Usage: SERVER_URL=https://your-site.netlify.app AGENT_TOKEN=... node agent.js');
  process.exit(1);
}
const auth = { Authorization: 'Bearer ' + TOKEN };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const adbArgs = (...a) => (SERIAL ? ['-s', SERIAL, ...a] : a);
const adb = (...a) => execFile('adb', adbArgs('shell', ...a.map(String)), () => {});

let viewers = false, size = null, procs = null, latest = null, inflight = 0;

function getSize() {
  return new Promise((resolve) =>
    execFile('adb', adbArgs('shell', 'wm', 'size'), (err, out) => {
      const m = /(\d+)x(\d+)/.exec((out || '').split('Override size:').pop());
      resolve(m ? { w: +m[1], h: +m[2] } : null);
    }));
}

const SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9]);

async function startStream() {
  if (procs) return;
  if (!size) {
    size = await getSize();
    if (!size) return console.error('No Samsung found. Check that "adb devices" lists it.');
  }
  if (procs || !viewers) return;
  const outH = Math.round(((size.h / size.w) * OUT_W) / 2) * 2;
  const rec = spawn('adb', adbArgs('exec-out', 'screenrecord', '--output-format=h264',
    '--size', `${OUT_W}x${outH}`, '--bit-rate', '3000000', '--time-limit', '170', '-'));
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-probesize', '32', '-analyzeduration', '0', '-f', 'h264', '-i', 'pipe:0',
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', QUALITY, 'pipe:1']);
  procs = { rec, ff };
  rec.stdout.pipe(ff.stdin);
  ff.stdin.on('error', () => {});

  let buf = Buffer.alloc(0);
  ff.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const s = buf.indexOf(SOI);
      if (s < 0) { buf = buf.subarray(Math.max(0, buf.length - 1)); break; }
      const e = buf.indexOf(EOI, s + 2);
      if (e < 0) { buf = buf.subarray(s); break; }
      latest = Buffer.from(buf.subarray(s, e + 2)); // newest wins; older unsent frames are dropped
      buf = buf.subarray(e + 2);
    }
    pump();
  });

  const done = (err) => {
    if (err && err.message) console.error('stream error:', err.message);
    if (procs && procs.rec === rec) {
      rec.kill(); ff.kill(); procs = null;
      if (viewers) setTimeout(startStream, 1000); // Android caps recordings at ~3 min
    }
  };
  rec.on('close', () => done()); ff.on('close', () => done());
  rec.on('error', done); ff.on('error', done);
}

function stopStream() {
  latest = null;
  if (!procs) return;
  const p = procs; procs = null;
  p.rec.kill(); p.ff.kill();
}

function setViewers(v) {
  if (v === viewers) return;
  viewers = v;
  if (v) startStream(); else stopStream();
}

// Upload the newest frame whenever an upload slot is free.
function pump() {
  if (!latest || inflight >= INFLIGHT || !viewers) return;
  const frame = latest; latest = null;
  inflight++;
  fetch(SERVER + '/api/frame', {
    method: 'POST',
    headers: { ...auth, 'content-type': 'image/jpeg', 'x-w': String(size.w), 'x-h': String(size.h) },
    body: frame,
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error('frame upload HTTP ' + r.status))))
    .then((j) => setViewers(!!j.viewers))
    .catch((e) => console.error('upload error:', e.message))
    .finally(() => { inflight--; pump(); });
}

const KEYS = new Set([3, 4, 187, 26]); // home, back, recents, power
const n = (v) => Math.max(0, Math.round(Number(v) || 0));
function handle(m) {
  if (!size) return;
  const cx = (v) => Math.min(size.w - 1, n(v)), cy = (v) => Math.min(size.h - 1, n(v));
  if (m.type === 'tap') adb('input', 'tap', cx(m.x), cy(m.y));
  else if (m.type === 'swipe')
    adb('input', 'swipe', cx(m.x1), cy(m.y1), cx(m.x2), cy(m.y2), Math.min(Math.max(n(m.ms), 50), 2000));
  else if (m.type === 'key' && KEYS.has(+m.code)) adb('input', 'keyevent', +m.code);
}

// Long-poll loop: returns immediately when a command arrives or viewers join/leave.
async function main() {
  size = await getSize();
  if (!size) console.error('No Samsung found. Check that "adb devices" lists it.');
  console.log('Agent talking to', SERVER);
  for (;;) {
    try {
      const q = new URLSearchParams({ v: viewers ? '1' : '0', w: size ? size.w : 0, h: size ? size.h : 0 });
      const r = await fetch(SERVER + '/api/agent/wait?' + q, { headers: auth });
      if (!r.ok) throw new Error('HTTP ' + r.status + (r.status === 401 ? ' (check AGENT_TOKEN)' : ''));
      const j = await r.json();
      (j.cmds || []).forEach(handle);
      setViewers(!!j.viewers);
      if (!size) size = await getSize();
    } catch (e) {
      console.error('connection error:', e.message, '- retrying in 3s');
      await sleep(3000);
    }
  }
}
main();
