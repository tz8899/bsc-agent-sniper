// 常驻 Binance Agentic Wallet (baw) 工作进程：省去每次冷启动 node（约 0.35s）+ 复用 HTTPS 长连接
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import readline from 'node:readline';

const here = path.dirname(fileURLToPath(import.meta.url));

function pkgDir() {
  if (process.env.BAWPKG) return process.env.BAWPKG;
  const b = execSync(process.platform === 'win32' ? 'where baw' : 'which baw').toString().split(/\r?\n/)[0].trim();
  let r = fs.realpathSync(b);
  if (r.endsWith('.cmd') || !r.endsWith('.js')) {
    r = path.join(execSync('npm root -g').toString().trim(), '@binance', 'agentic-wallet', 'dist', 'index.js');
  }
  return path.dirname(path.dirname(r));
}

const P = pkgDir();
const L = path.join(here, '.bawlib', 'w' + (process.env.WID || process.pid));
fs.mkdirSync(path.join(L, 'dist'), { recursive: true });
let src = fs.readFileSync(path.join(P, 'dist', 'index.js'), 'utf8').replace(/^#!.*\n/, '');
const tail = 'kr.parse();';
const k = src.lastIndexOf(tail);
if (k < 0) throw new Error('不识别当前 baw 版本（未找到入口标记）');
src = src.slice(0, k) + 'export {ce,me,ee};' + src.slice(k + tail.length);
fs.writeFileSync(path.join(L, 'dist', 'index.mjs'), src);
fs.copyFileSync(path.join(P, 'package.json'), path.join(L, 'package.json'));
const nm = path.join(L, 'node_modules');
if (!fs.existsSync(nm)) {
  const t = fs.existsSync(path.join(P, 'node_modules')) ? path.join(P, 'node_modules') : path.join(P, '..', '..');
  fs.symlinkSync(t, nm, process.platform === 'win32' ? 'junction' : 'dir');
}

const { ce, me, ee } = await import(pathToFileURL(path.join(L, 'dist', 'index.mjs')).href);
await me.getInstance().getSessionIdAsync();
const C = new ce();
const M = new ee();

const rl = readline.createInterface({ input: process.stdin });
process.stdout.write(JSON.stringify({ ready: 1 }) + '\n');

rl.on('line', async line => {
  let q;
  try { q = JSON.parse(line); } catch { return; }
  let out;
  try {
    let r;
    if (q.op === 'preview') r = await C.contractCallPreview(q.body);
    else if (q.op === 'execute') r = await C.contractCallExecute(q.body);
    else if (q.op === 'swap') r = { data: await M.marketOrder(q.body) };
    else if (q.op === 'quote') r = { data: M.quote ? await M.quote(q.body) : null };
    else if (q.op === 'ping') r = { data: 'pong' };
    else throw new Error('unknown op');
    out = { id: q.id, success: true, data: r.data };
  } catch (e) {
    out = { id: q.id, success: false, error: { code: e.code, message: e.message, data: e.data } };
  }
  process.stdout.write(JSON.stringify(out) + '\n');
});
