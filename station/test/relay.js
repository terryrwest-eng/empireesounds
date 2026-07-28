// NTRIP relay tests. Runs a fake caster on localhost and drives the relay
// against it — no network, no real credentials.
//   node station/test/relay.js
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..');
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

const SOURCETABLE = [
  'SOURCETABLE 200 OK',
  'Content-Type: text/plain',
  'Content-Length: 0',
  '',
  'STR;NEAR_RTCM32;Riverside;RTCM 3.2;1005(1),1074(1);2;GPS+GLO;TEST;USA;33.90;-117.40;1;0;sNTRIP;none;B;N;9600;',
  'STR;FAR_RTCM3;Barstow;RTCM 3.0;1004(1);2;GPS;TEST;USA;34.90;-117.02;0;0;sNTRIP;none;B;N;9600;',
  'ENDSOURCETABLE', ''
].join('\r\n');

// A minimal RTCM 3 frame carrying message 1005.
function rtcmFrame(type = 1005, payloadLen = 10) {
  const payload = Buffer.alloc(payloadLen);
  payload[0] = type >> 4;
  payload[1] = (type & 0x0f) << 4;
  const head = Buffer.from([0xd3, (payloadLen >> 8) & 0x03, payloadLen & 0xff]);
  return Buffer.concat([head, payload, Buffer.from([1, 2, 3])]);
}

function fakeCaster() {
  const seen = { gga: [], auth: null, mount: null, userAgent: null };
  const server = net.createServer(socket => {
    let head = '';
    socket.on('data', chunk => {
      const text = chunk.toString('latin1');
      if (head !== null) {
        head += text;
        const cut = head.indexOf('\r\n\r\n');
        if (cut < 0) return;
        const req = head.slice(0, cut);
        const rest = head.slice(cut + 4);
        head = null;
        const line = req.split('\r\n')[0];
        seen.mount = (line.match(/^GET \/(\S*)/) || [])[1];
        seen.auth = (req.match(/Authorization: Basic (\S+)/) || [])[1] || null;
        seen.userAgent = (req.match(/User-Agent: (.+)/) || [])[1] || null;
        if (rest.includes('GGA')) seen.gga.push(rest.trim());

        if (!seen.mount) { socket.end(SOURCETABLE); return; }
        if (seen.mount === 'SECURE' && seen.auth !== Buffer.from('bob:hunter2').toString('base64')) {
          socket.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="ntrip"\r\n\r\n');
          return;
        }
        if (seen.mount === 'MISSING') { socket.end(SOURCETABLE); return; }
        // NTRIP 1 style: status line, single CRLF, then straight into RTCM.
        socket.write('ICY 200 OK\r\n');
        socket.write(rtcmFrame(1005));
        const timer = setInterval(() => { if (!socket.destroyed) socket.write(rtcmFrame(1074, 20)); }, 60);
        socket.on('close', () => clearInterval(timer));
        return;
      }
      if (text.includes('GGA')) seen.gga.push(text.trim());
    });
    socket.on('error', () => {});
  });
  return { server, seen };
}

const startServer = (port, env) => {
  const p = spawn(process.execPath, ['server.js'], {
    cwd: REPO, env: { ...process.env, PORT: String(port), ...env }, stdio: 'ignore'
  });
  return p;
};

const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const { server, seen } = fakeCaster();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const casterPort = server.address().port;

  // One relay that may reach localhost (for the fake caster), one that may not
  // (to prove the guard is really on by default).
  const open = startServer(3211, { NTRIP_ALLOW_PRIVATE: '1', NTRIP_PORTS: String(casterPort) });
  const guarded = startServer(3212, {});
  await wait(900);

  const OPEN = 'http://127.0.0.1:3211';
  const GUARD = 'http://127.0.0.1:3212';
  const q = extra => `host=127.0.0.1&port=${casterPort}&${extra}`;

  console.log('\n— relay —');

  let res = await fetch(`${OPEN}/ntrip/status`);
  let body = await res.json();
  ok('status reports the relay is up', res.status === 200 && body.enabled === true, JSON.stringify(body));

  res = await fetch(`${OPEN}/ntrip/sourcetable?host=127.0.0.1&port=${casterPort}`);
  const table = await res.text();
  ok('sourcetable fetched', res.status === 200 && table.includes('NEAR_RTCM32'), String(res.status));
  ok('sourcetable http head stripped', !table.startsWith('SOURCETABLE 200'), table.slice(0, 40));
  ok('relay identifies itself to the caster', /NTRIP StationApp/.test(seen.userAgent || ''), String(seen.userAgent));

  // streaming
  const auth = Buffer.from('bob:hunter2').toString('base64');
  const stream = await fetch(`${OPEN}/ntrip/stream?${q('mount=SECURE&session=abc123')}`, {
    headers: { 'X-Ntrip-Auth': auth, 'X-Ntrip-Gga': '$GPGGA,120000.00,3348.0000,N,11712.0000,W,4,12,0.8,100.0,M,-32.0,M,1.0,0000*0C' }
  });
  ok('stream opens against an authenticated mountpoint', stream.status === 200, String(stream.status));
  ok('credentials reached the caster', seen.auth === auth);
  ok('the opening GGA was forwarded', seen.gga.some(g => g.includes('GPGGA')), JSON.stringify(seen.gga));

  const reader = stream.body.getReader();
  let got = 0, sawPreamble = false;
  const deadline = Date.now() + 3000;
  while (got < 30 && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) { got += value.length; sawPreamble = sawPreamble || value.includes(0xd3); }
  }
  ok(`RTCM flows through the relay (${got} bytes)`, got >= 30);
  ok('bytes are raw RTCM, not re-encoded', sawPreamble);

  // GGA push on the live session
  const before = seen.gga.length;
  const push = await fetch(`${OPEN}/ntrip/gga?session=abc123`, {
    method: 'POST',
    body: '$GPGGA,120010.00,3348.1000,N,11712.1000,W,4,12,0.8,100.0,M,-32.0,M,1.0,0000*05'
  });
  await wait(200);
  ok('GGA push accepted', push.status === 204, String(push.status));
  ok('GGA reached the caster mid-stream', seen.gga.length > before, `${before} -> ${seen.gga.length}`);

  const junk = await fetch(`${OPEN}/ntrip/gga?session=abc123`, { method: 'POST', body: 'rm -rf /\r\nGET /evil' });
  ok('non-GGA bodies are rejected', junk.status === 400, String(junk.status));

  await reader.cancel().catch(() => {});
  await wait(300);

  // failure paths
  res = await fetch(`${OPEN}/ntrip/stream?${q('mount=SECURE&session=zz1')}`, { headers: { 'X-Ntrip-Auth': Buffer.from('bob:wrong').toString('base64') } });
  body = await res.json().catch(() => ({}));
  ok('bad password surfaces as 401', res.status === 401, String(res.status));
  ok('401 says what is wrong without echoing the password',
     /username or password/i.test(body.error || '') && !/hunter2|wrong/.test(JSON.stringify(body)), JSON.stringify(body));

  res = await fetch(`${OPEN}/ntrip/stream?${q('mount=MISSING&session=zz2')}`);
  body = await res.json().catch(() => ({}));
  ok('a sourcetable answer means the mountpoint is wrong', res.status === 502 || res.status === 404, String(res.status));
  ok('bad mountpoint is explained', /mountpoint/i.test(body.error || ''), JSON.stringify(body));

  res = await fetch(`${OPEN}/ntrip/stream?host=127.0.0.1&port=25&mount=X&session=zz3`);
  ok('non-NTRIP ports are refused', res.status === 400, String(res.status));

  res = await fetch(`${OPEN}/ntrip/sourcetable?host=not+a+host&port=2101`);
  ok('malformed hosts are refused', res.status === 400, String(res.status));

  // the guarded instance
  res = await fetch(`${GUARD}/ntrip/sourcetable?host=127.0.0.1&port=2101`);
  body = await res.json().catch(() => ({}));
  ok('private addresses are blocked by default', res.status === 403, String(res.status));
  res = await fetch(`${GUARD}/ntrip/sourcetable?host=169.254.169.254&port=2101`);
  ok('link-local metadata addresses are blocked', res.status === 403, String(res.status));

  res = await fetch(`${GUARD}/`);
  ok('static files still serve alongside the relay', res.status === 200);
  res = await fetch(`${GUARD}/station/`);
  ok('the station app still serves', res.status === 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  open.kill(); guarded.kill(); server.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
