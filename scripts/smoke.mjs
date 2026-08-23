// Boots the shell under a virtual display and asserts what the renderer sees.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOG = '/tmp/dtpos-smoke.log';
const EXPECTED_API = 24;

rmSync(LOG, { force: true });
// A previous run killed mid-flight leaves a singleton lock, and the next launch
// then exits 0 with no output at all — which reads exactly like a crash.
rmSync(join(homedir(), '.config', 'DT POS'), { recursive: true, force: true });

// A stand-in for the hosted deployment, so the server-function proxy can be
// verified without reaching the real backend.
const stub = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      path: req.url,
      method: req.method,
      sawAuthHeader: req.headers.authorization ?? null,
      body: body.slice(0, 100),
    }));
  });
});
await new Promise((r) => stub.listen(0, '127.0.0.1', r));
const stubOrigin = `http://127.0.0.1:${stub.address().port}`;

const display = process.platform === 'linux' ? ['xvfb-run', '-a'] : [];
const electron = join('node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const [cmd, ...pre] = [...display, electron];

const child = spawn(cmd, [...pre, '.', '--no-sandbox'], {
  stdio: 'ignore',
  env: { ...process.env, DTPOS_SMOKE: '1', DTPOS_SMOKE_LOG: LOG, DTPOS_API_ORIGIN: stubOrigin },
});

const deadline = Date.now() + 90_000;
const done = () => existsSync(LOG) && /DONE|PROBE ERROR|did-fail-load/.test(readFileSync(LOG, 'utf8'));
while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
try { child.kill('SIGKILL'); } catch {}
stub.close();

const log = existsSync(LOG) ? readFileSync(LOG, 'utf8') : '';
console.log(log || '(the app produced no output at all)');

const fail = (m) => { console.error(`\n[smoke] FAIL — ${m}`); process.exitCode = 1; };
const bridge = /^BRIDGE (.*)$/m.exec(log);
const painted = /^PAINTED (.*)$/m.exec(log);

if (!bridge) fail('the preload bridge never reported — window.electronAPI is missing');
else {
  const b = JSON.parse(bridge[1]);
  if (b.api.length !== EXPECTED_API) fail(`expected ${EXPECTED_API} bridged methods, saw ${b.api.length}`);
  if (b.hasNodeRequire) fail('require() is reachable from the page — nodeIntegration leaked');
  if (b.hasProcess) fail('process is reachable from the page — contextIsolation leaked');
  if (b.origin !== 'app://dtpos') fail(`origin is ${b.origin}, expected app://dtpos`);
}
if (!painted) fail('the POS never finished loading');
else {
  const p = JSON.parse(painted[1]);
  if (!p.rootMounted) fail('the POS did not mount — check the CSP and the console lines above');
  if (p.storageWorks !== true) fail(`localStorage is not usable: ${p.storageWorks}`);
  if (!p.idbWorks) fail('IndexedDB is unavailable — the offline queue needs it');
}
const serverfn = /^SERVERFN (.*)$/m.exec(log);
if (!serverfn) fail('the server-function proxy was never exercised');
else {
  const r = JSON.parse(serverfn[1]);
  if (r.status !== 200) fail(`server-function proxy returned ${r.status ?? r.error}`);
  else {
    const payload = JSON.parse(r.body);
    if (!payload.ok) fail('the proxy did not reach the backend');
    if (payload.method !== 'POST') fail(`proxy changed the method to ${payload.method}`);
    if (payload.sawAuthHeader !== 'Bearer smoke.token.value') {
      fail('the proxy dropped the Authorization header — staff sign-in would be rejected');
    }
    if (!payload.path.startsWith('/_serverFn/')) fail(`proxy rewrote the path to ${payload.path}`);
  }
}

if (!process.exitCode) console.log('\n[smoke] PASS — bridge, IPC, mount, storage all verified in a real window');
