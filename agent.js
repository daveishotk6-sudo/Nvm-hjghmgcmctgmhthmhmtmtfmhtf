// Home agent: runs on a computer that has the Samsung attached via ADB.
// Connects OUT to the Railway server (no port forwarding needed), streams the
// screen as JPEG frames when someone is viewing, and executes taps/swipes.
const { spawn, execFile } = require('child_process');
const WebSocket = require('ws');

const SERVER = (process.env.SERVER_URL || '').replace(/^http/, 'ws').replace(/\/$/, '');
const TOKEN = process.env.AGENT_TOKEN;
const SERIAL = process.env.ADB_SERIAL;
const OUT_W = +process.env.STREAM_WIDTH || 720;
if (!SERVER || !TOKEN) {
  console.error('Usage: SERVER_URL=wss://your-app.up.railway.app AGENT_TOKEN=... node agent.js');
  process.exit(1);
}
const adbArgs = (...a) => (SERIAL ? ['-s', SERIAL, ...a] : a);
const adb = (...a) => execFile('adb', adbArgs('shell', ...a.map(String)), () => {});

let ws = null, viewers = 0, size = null, procs = null;

function getSize() {
  return new Promise((resolve) =>
    execFile('adb', adbArgs('shell', 'wm', 'size'), (err, out) => {
      const m = /(\d+)x(\d+)/.exec((out || '').split('Override size:').pop());
      resolve(m ? { w: +m[1], h: +m[2] } : null);
    }));
}
const sendInfo = () => ws && ws.readyState === 1 && size && ws.send(JSON.stringify({ type: 'info', ...size }));

const SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9]);

async function startStream() {
  if (procs) return;
  if (!size) {
    size = await getSize();
    if (!size) return console.error('No Samsung found. Check that "adb devices" lists it.');
    sendInfo();
  }
  if (procs || viewers === 0) return;
  const outH = Math.round(((size.h / size.w) * OUT_W) / 2) * 2;
  const rec = spawn('adb', adbArgs('exec-out', 'screenrecord', '--output-format=h264',
    '--size', `${OUT_W}x${outH}`, '--bit-rate', '4000000', '--time-limit', '170', '-'));
  const ff = spawn('ffmpeg', ['-loglevel', 'error', '-fflags', 'nobuffer', '-flags', 'low_delay',
    '-probesize', '32', '-analyzeduration', '0', '-f', 'h264', '-i', 'pipe:0',
    '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '7', 'pipe:1']);
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
      const frame = buf.subarray(s, e + 2);
      buf = buf.subarray(e + 2);
      if (ws && ws.readyState === 1 && ws.bufferedAmount < 2e6) ws.send(frame);
    }
  });

  const done = (err) => {
    if (err && err.message) console.error('stream error:', err.message);
    if (procs && procs.rec === rec) {
      rec.kill(); ff.kill(); procs = null;
      if (viewers > 0) setTimeout(startStream, 1000); // Android caps recordings at ~3 min
    }
  };
  rec.on('close', () => done()); ff.on('close', () => done());
  rec.on('error', done); ff.on('error', done);
}

function stopStream() {
  if (!procs) return;
  const p = procs; procs = null;
  p.rec.kill(); p.ff.kill();
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

function connect() {
  let watchdog;
  ws = new WebSocket(SERVER + '/ws/agent', { headers: { Authorization: 'Bearer ' + TOKEN } });
  const sock = ws;
  const arm = () => { clearTimeout(watchdog); watchdog = setTimeout(() => sock.terminate(), 70000); };
  sock.on('open', async () => {
    console.log('Connected to', SERVER);
    arm();
    size = await getSize();
    sendInfo();
    if (!size) console.error('No Samsung found. Check that "adb devices" lists it.');
  });
  sock.on('ping', arm);
  sock.on('message', (d, isBinary) => {
    if (isBinary) return;
    try {
      const m = JSON.parse(d.toString());
      if (m.type === 'viewers') { viewers = m.n; viewers > 0 ? startStream() : stopStream(); }
      else handle(m);
    } catch {}
  });
  sock.on('error', (e) => console.error('connection error:', e.message));
  sock.on('close', () => {
    clearTimeout(watchdog); stopStream(); viewers = 0;
    console.log('Disconnected, retrying in 3s...');
    setTimeout(connect, 3000);
  });
}
connect();
