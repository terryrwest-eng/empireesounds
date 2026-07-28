// NTRIP relay.
//
// A browser cannot open a TCP socket, and NTRIP casters do not speak WebSocket,
// so corrections have to be bridged. This is deliberately a dumb pipe: it holds
// no accounts, stores no credentials, and keeps nothing after the socket closes.
//
//   GET  /ntrip/sourcetable?host=&port=[&tls=1]     -> the caster's mountpoint table
//   GET  /ntrip/stream?host=&port=&mount=&session=  -> RTCM, streamed to the client
//   POST /ntrip/gga?session=                        -> pushes a GGA up to the caster
//   GET  /ntrip/status                              -> relay availability
//
// Credentials travel in an X-Ntrip-Auth header (base64 user:pass), never in the
// URL, so they cannot end up in an access log or a browser history entry.

const net = require('net');
const tls = require('tls');
const dns = require('dns');
const { promisify } = require('util');

const lookup = promisify(dns.lookup);

const ENABLED = (process.env.NTRIP_RELAY || 'on').toLowerCase() !== 'off';
const MAX_SESSIONS = Number(process.env.NTRIP_MAX_SESSIONS || 8);
const IDLE_MS = Number(process.env.NTRIP_IDLE_MS || 60000);
const HOST_ALLOW = (process.env.NTRIP_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ALLOW_PRIVATE = process.env.NTRIP_ALLOW_PRIVATE === '1'; // tests only
const EXTRA_PORTS = (process.env.NTRIP_PORTS || '').split(',').map(n => Number(n)).filter(Boolean);

const sessions = new Map(); // id -> { socket, host, mount, startedAt, bytes }

const USER_AGENT = 'NTRIP StationApp/1.0';

/* ---------------- guards ---------------- */

function portAllowed(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (EXTRA_PORTS.includes(port)) return true;
  if (port === 80 || port === 443 || port === 8080 || port === 8000) return true;
  return port >= 2101 && port <= 2199; // the NTRIP range
}

function isPrivateAddress(ip) {
  if (ALLOW_PRIVATE) return false;
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (/^f[cd]/.test(v)) return true;        // unique local
    if (v.startsWith('fe80')) return true;    // link local
    if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
    return false;
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n))) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||   // CGNAT
    a >= 224;                               // multicast / reserved
}

async function resolveSafely(host) {
  if (!/^[a-z0-9.\-_]+$/i.test(host) || host.length > 253) throw httpError(400, 'Bad caster host.');
  if (HOST_ALLOW.length && !HOST_ALLOW.includes(host.toLowerCase())) {
    throw httpError(403, 'That caster is not on this relay\'s allowlist.');
  }
  let addrs;
  try { addrs = await lookup(host, { all: true }); }
  catch { throw httpError(502, `Cannot resolve ${host}.`); }
  if (!addrs.length) throw httpError(502, `Cannot resolve ${host}.`);
  // Every answer must be public, so a split-horizon name cannot smuggle us onto
  // the local network.
  for (const a of addrs) if (isPrivateAddress(a.address)) throw httpError(403, 'That address is not reachable through this relay.');
  return addrs[0].address;
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* ---------------- caster connection ---------------- */

function connectCaster({ address, host, port, useTls }) {
  return new Promise((resolve, reject) => {
    const opts = { host: address, port, servername: host };
    const socket = useTls
      ? tls.connect({ ...opts, rejectUnauthorized: true }, () => resolve(socket))
      : net.connect(opts, () => resolve(socket));
    socket.setTimeout(20000);
    socket.once('error', reject);
    socket.once('timeout', () => { socket.destroy(); reject(httpError(504, 'The caster did not answer.')); });
  });
}

function request(mount, host, auth, gga) {
  return [
    `GET /${mount} HTTP/1.1`,
    `Host: ${host}`,
    'Ntrip-Version: Ntrip/2.0',
    `User-Agent: ${USER_AGENT}`,
    auth ? `Authorization: Basic ${auth}` : null,
    'Accept: */*',
    'Connection: close',
    '', ''
  ].filter(v => v !== null).join('\r\n') + (gga || '');
}

// Casters answer either HTTP/1.1 (NTRIP 2) or the shoutcast-style "ICY 200 OK"
// (NTRIP 1), and the ICY form may end its header with one CRLF, not two.
function splitHead(buf) {
  const text = buf.toString('latin1');
  if (text.startsWith('ICY')) {
    const i = text.indexOf('\r\n');
    if (i < 0) return null;
    const doubled = text.slice(i + 2, i + 4) === '\r\n';
    return { head: text.slice(0, i), body: buf.subarray(i + (doubled ? 4 : 2)) };
  }
  const i = text.indexOf('\r\n\r\n');
  if (i < 0) return null;
  return { head: text.slice(0, i), body: buf.subarray(i + 4) };
}

function headStatus(head) {
  const first = head.split('\r\n')[0] || '';
  if (/^SOURCETABLE/i.test(first)) return { code: 404, reason: 'The caster does not have that mountpoint.' };
  const m = first.match(/\s(\d{3})\s/);
  const code = m ? Number(m[1]) : (/200 OK/i.test(first) ? 200 : 0);
  if (code === 200) return { code: 200 };
  if (code === 401) return { code: 401, reason: 'The caster rejected that username or password.' };
  return { code: code || 502, reason: `The caster answered: ${first.slice(0, 120)}` };
}

/* ---------------- endpoints ---------------- */

async function sourcetable(url, res) {
  const host = url.searchParams.get('host');
  const port = Number(url.searchParams.get('port') || 2101);
  const useTls = url.searchParams.get('tls') === '1';
  if (!host) throw httpError(400, 'Missing caster host.');
  if (!portAllowed(port)) throw httpError(400, `Port ${port} is not an NTRIP port.`);
  const address = await resolveSafely(host);
  const auth = authHeader(res.req);

  const socket = await connectCaster({ address, host, port, useTls });
  socket.write(request('', host, auth));

  const table = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const done = () => resolve(Buffer.concat(chunks).toString('latin1'));
    socket.on('data', d => {
      chunks.push(d); size += d.length;
      if (size > 2_000_000 || Buffer.concat(chunks.slice(-2)).includes('ENDSOURCETABLE')) { socket.destroy(); done(); }
    });
    socket.on('end', done);
    socket.on('close', done);
    socket.on('error', reject);
    socket.setTimeout(15000, () => { socket.destroy(); done(); });
  });

  const cut = table.indexOf('\r\n\r\n');
  const body = cut >= 0 ? table.slice(cut + 4) : table;
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function stream(url, req, res) {
  const host = url.searchParams.get('host');
  const port = Number(url.searchParams.get('port') || 2101);
  const mount = (url.searchParams.get('mount') || '').replace(/^\//, '');
  const id = url.searchParams.get('session') || '';
  const useTls = url.searchParams.get('tls') === '1';

  if (!host || !mount) throw httpError(400, 'Missing caster host or mountpoint.');
  if (!/^[\w.\-]{1,64}$/.test(id)) throw httpError(400, 'Missing session id.');
  if (!portAllowed(port)) throw httpError(400, `Port ${port} is not an NTRIP port.`);
  if (sessions.size >= MAX_SESSIONS) throw httpError(503, 'The relay is at capacity. Try again shortly.');
  if (sessions.has(id)) throw httpError(409, 'That session is already streaming.');

  const address = await resolveSafely(host);
  const gga = sanitizeGga(req.headers['x-ntrip-gga']);
  const socket = await connectCaster({ address, host, port, useTls });
  socket.setTimeout(0);
  socket.write(request(mount, host, authHeader(req), gga));

  const session = { socket, host, mount, startedAt: Date.now(), bytes: 0 };
  sessions.set(id, session);

  let head = null;
  let buffered = Buffer.alloc(0);
  let idle = setTimeout(() => socket.destroy(), IDLE_MS);
  const bump = () => { clearTimeout(idle); idle = setTimeout(() => socket.destroy(), IDLE_MS); };

  const cleanup = () => {
    clearTimeout(idle);
    sessions.delete(id);
    socket.destroy();
    if (!res.writableEnded) res.end();
  };

  socket.on('data', chunk => {
    bump();
    if (head) {
      session.bytes += chunk.length;
      if (!res.write(chunk)) socket.pause();
      return;
    }
    buffered = Buffer.concat([buffered, chunk]);
    const split = splitHead(buffered);
    if (!split && buffered.length < 8192) return;
    if (!split) { failStream(res, 502, 'The caster sent an unreadable response.'); return cleanup(); }
    head = split.head;
    const status = headStatus(head);
    if (status.code !== 200) { failStream(res, status.code === 401 ? 401 : 502, status.reason); return cleanup(); }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no'
    });
    if (split.body.length) { session.bytes += split.body.length; res.write(split.body); }
  });

  res.on('drain', () => socket.resume());
  socket.on('error', () => { failStream(res, 502, 'The connection to the caster failed.'); cleanup(); });
  socket.on('close', cleanup);
  req.on('close', cleanup);
}

function failStream(res, status, message) {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: message }));
}

// VRS mountpoints need the rover's position to build a virtual base near it.
function sanitizeGga(line) {
  if (!line) return '';
  const s = String(line).replace(/[\r\n]/g, '').trim();
  if (!/^\$G[A-Z]GGA,[\x20-\x7e]{10,120}$/.test(s)) return '';
  return s + '\r\n';
}

async function pushGga(url, req, res) {
  const id = url.searchParams.get('session') || '';
  const session = sessions.get(id);
  const body = await readBody(req, 256);
  if (!session) throw httpError(404, 'No such session.');
  const gga = sanitizeGga(body);
  if (!gga) throw httpError(400, 'That is not a GGA sentence.');
  session.socket.write(gga);
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', d => {
      data += d;
      if (data.length > limit) { reject(httpError(413, 'Body too large.')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function authHeader(req) {
  const raw = req.headers['x-ntrip-auth'];
  if (!raw || Array.isArray(raw)) return '';
  return /^[A-Za-z0-9+/=]{0,512}$/.test(raw) ? raw : '';
}

/* ---------------- entry point ---------------- */

function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/ntrip/')) return false;

  res.req = req;
  const send = (status, obj) => {
    if (res.headersSent) { res.end(); return; }
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  if (!ENABLED) { send(503, { error: 'The NTRIP relay is switched off on this server.' }); return true; }

  const run = async () => {
    switch (url.pathname) {
      case '/ntrip/status':
        return send(200, {
          enabled: true, sessions: sessions.size, maxSessions: MAX_SESSIONS,
          allowlist: HOST_ALLOW.length ? HOST_ALLOW : null
        });
      case '/ntrip/sourcetable': return sourcetable(url, res);
      case '/ntrip/stream': return stream(url, req, res);
      case '/ntrip/gga':
        if (req.method !== 'POST') throw httpError(405, 'POST only.');
        return pushGga(url, req, res);
      default: throw httpError(404, 'No such relay endpoint.');
    }
  };

  run().catch(err => {
    // Deliberately terse: never echo back anything that could carry credentials.
    send(err.status || 500, { error: err.status ? err.message : 'The relay failed to reach that caster.' });
  });
  return true;
}

module.exports = { handle, enabled: ENABLED, _internals: { isPrivateAddress, portAllowed, splitHead, headStatus, sanitizeGga } };
