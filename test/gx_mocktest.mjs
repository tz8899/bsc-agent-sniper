// gx_mocktest.mjs —— 本地假链 + 假币安 worker 8 场景回归测试（纯虚构测试地址，绝不碰真链）
// 用法：node test/gx_mocktest.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const GX = process.argv[2] || path.join(ROOT, 'scripts', 'gx.mjs');
const rq = createRequire(import.meta.url);
const { privToAddr } = rq('../lib/sign.js');

// 纯虚构测试地址与测试私钥（仅用于本地 mock，无任何真实资产）
const A = {
  1: '0000000000000000000000000000000000001001',
  2: '0000000000000000000000000000000000001002',
  3: '0000000000000000000000000000000000001003',
  4: '0000000000000000000000000000000000001004',
  5: '0000000000000000000000000000000000001005'
};
const MOCK_PK = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const PK_ADDR = privToAddr(MOCK_PK).replace(/^0x/, '').toLowerCase();
const BS2_ADDR = '000000000000000000000000000000000000b502';
const BS3_ADDR = '000000000000000000000000000000000000b503';
const TOKEN = '11'.repeat(20);
const POOL = '22'.repeat(20);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'py-gx-test-'));
const WALLETS_FILE = path.join(TMP, 'wallets.json');
const PK_FILE = path.join(TMP, 'pk.json');
const WORKER_FILE = path.join(TMP, 'mock_worker.mjs');
const CFG_FILE = path.join(TMP, 'cfg.json');

fs.writeFileSync(WALLETS_FILE, JSON.stringify({
  accounts: Object.fromEntries(Object.entries(A).map(([k, v]) => [k, '0x' + v])),
  contracts: { bs2: '0x' + BS2_ADDR, bs3: '0x' + BS3_ADDR },
  baw: { dir: TMP }
}));
fs.writeFileSync(PK_FILE, JSON.stringify({ addr: '0x' + PK_ADDR, pk: MOCK_PK }));

const word = x => BigInt(x).toString(16).padStart(64, '0');
let ST = null;
const curBal = k => (ST.zeroed[k] || Date.now() < ST.openAt) ? 0n : 100n * 10n ** 18n;
const nBlk = () => 134000000 + Math.floor(Date.now() / 450);
class Rev extends Error {}

function rpc(m, p) {
  switch (m) {
    case 'eth_blockNumber': return '0x' + nBlk().toString(16);
    case 'eth_getBlockByNumber': return { number: '0x' + nBlk().toString(16), timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16), milliTimestamp: '0x' + Date.now().toString(16), transactions: [] };
    case 'eth_gasPrice': return '0x2faf080'; // 0.05 gwei
    case 'eth_getBalance': {
      const addr = (p[0] || '').toLowerCase().replace(/^0x/, '');
      if (addr === PK_ADDR && ST.sc.pkBalWei !== undefined) return '0x' + BigInt(ST.sc.pkBalWei).toString(16);
      return '0x' + (5n * 10n ** 17n).toString(16);
    }
    case 'eth_getTransactionCount': return '0x2b';
    case 'eth_sendRawTransaction': { ST.bsSentAt = Date.now(); return '0x' + 'cd'.repeat(32); }
    case 'eth_getTransactionReceipt': {
      if (ST.bsSentAt > 0 && p[0] !== '0x' + 'ab'.repeat(32)) {
        if (ST.sc.bsReceiptDelayMs && Date.now() - ST.bsSentAt < ST.sc.bsReceiptDelayMs) return null;
        ST.zeroed['1'] = true;
      }
      return { status: '0x1', blockNumber: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [] };
    }
    case 'eth_call': {
      const { data } = p[0];
      const sel = data.slice(0, 10);
      const open = Date.now() >= ST.openAt;
      if (sel === '0x70a08231') {
        const addr = data.slice(34, 74).toLowerCase();
        const k = Object.keys(A).find(x => A[x] === addr);
        return '0x' + word(k ? curBal(k) : 0n);
      }
      if (sel === '0xdd62ed3e') return '0x' + word(10n ** 30n);
      if (sel === '0x313ce567') return '0x' + word(18);
      if (sel === '0xd06ca61f') { if (!open) throw new Rev(); const amt = BigInt('0x' + data.slice(10, 74)); return '0x' + word(32) + word(2) + word(amt) + word(amt / 2n); }
      if (sel === '0x0902f1ac') return '0x' + (open ? word(100n * 10n ** 18n) + word(ST.sc.shallow ? 2n * 10n ** 17n : 50n * 10n ** 18n) : word(0) + word(0)) + word(1);
      if (sel === '0xe6a43905') return '0x' + word('0x' + (ST.sc.wrongPool ? '99'.repeat(20) : POOL));
      if (sel === '0x0dfe1681') return '0x' + word('0x' + TOKEN);
      if (sel === '0x3a98ef39') return '0x' + word(1);
      if (sel === '0xd66517d4') { if (!open) throw new Rev(); return '0x' + word(1); }
      return '0x' + word(0);
    }
    default: return '0x0';
  }
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/state') { res.end(JSON.stringify({ openAt: ST.openAt, sc: ST.sc, now: Date.now() })); return; }
    if (u.pathname === '/zero') { ST.zeroed[u.searchParams.get('acc')] = true; res.end('{}'); return; }
    let j;
    try { j = JSON.parse(body); } catch { res.statusCode = 400; res.end('{}'); return; }
    res.setHeader('content-type', 'application/json');
    try { res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: rpc(j.method, j.params) })); }
    catch { res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, error: { code: 3, message: 'execution reverted' } })); }
  });
});

const WORKER = String.raw`import readline from 'node:readline';
const BASE=process.env.GX_MOCK_RPC;const acc=(process.env.BINANCE_BAW_DIR||'').slice(-1);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const st=async()=>(await fetch(BASE+'/state')).json();
const zero=()=>fetch(BASE+'/zero?acc='+acc,{method:'POST'}).catch(()=>{});
let busy=0,rid=0;const reqs={};
process.stdout.write(JSON.stringify({ready:1})+'\n');
readline.createInterface({input:process.stdin}).on('line',async line=>{const q=JSON.parse(line);let out;
 try{const S=await st();const sc=S.sc;const since=()=>Date.now()-S.openAt;
  if(q.op==='preview'){await sleep(sc.previewMs||500);const data=q.body.inputData||'';
    if(data.startsWith('0x095ea7b3')){const id='r'+(++rid);reqs[id]='approve';out={id:q.id,success:true,data:{requestId:id}}}
    else if(since()<(sc.pancakeOkAfterMs??0)){out={id:q.id,success:true,data:{},error:{code:351805,message:"This token can't be sold"}}}
    else{const id='r'+(++rid);reqs[id]='sell';out={id:q.id,success:true,data:{requestId:id}}}}
  else if(q.op==='execute'){const kind=reqs[q.body.requestId];
    if(busy){out={id:q.id,success:false,error:{code:351716,message:'in progress'}}}
    else if(kind==='sell'&&sc.execFail716Ms&&since()<sc.execFail716Ms){await sleep(200);out={id:q.id,success:false,error:{code:351716,message:'in progress'}}}
    else{busy=1;await sleep(sc.executeMs||500);busy=0;if(kind==='sell')setTimeout(zero,500);out={id:q.id,success:true,data:{txHash:'0x'+'ab'.repeat(32)}}}}
  else if(q.op==='swap'){if(busy){out={id:q.id,success:false,error:{code:351716,message:'in progress'}}}
    else{busy=1;await sleep(sc.swapMs||350);busy=0;
      if(since()<(sc.flashOkAfterMs??0)){out={id:q.id,success:false,error:{code:30003001,message:'There is currently insufficient liquidity for this trade.'}}}
      else{setTimeout(zero,500);out={id:q.id,success:true,data:{orderId:'o'+(++rid)}}}}}
  else out={id:q.id,success:true,data:'pong'};
 }catch(e){out={id:q.id,success:false,error:{message:String(e)}}}
 process.stdout.write(JSON.stringify(out)+'\n')});`;

fs.writeFileSync(WORKER_FILE, WORKER);
await new Promise(r => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;
const nodeMajor = Number(process.versions.node.split('.')[0]);
const wsFlag = nodeMajor < 22 ? ['--experimental-websocket'] : [];

async function run(name, sc, extraCfg = {}, limitMs = 22000) {
  ST = { sc, openAt: Date.now() + (sc.openInMs ?? 2500), zeroed: {}, bsSentAt: 0 };
  const cfg = {
    acc: sc.acc || '12345',
    ...extraCfg,
    sell: {
      token: '0x' + TOKEN, amt: 100, route: 'pancake', dex: true, slip: 100, giveup: 60,
      pool: '0x' + POOL, minPoolBnb: 1,
      cond: { to: '0x' + POOL, call: '0x0902f1ac' },
      pre: { to: '0x' + '33'.repeat(20), call: '0x3a98ef39', gte: 1 },
      report: false, revoke: true, ...(extraCfg.sell || {})
    }
  };
  fs.writeFileSync(CFG_FILE, JSON.stringify(cfg));
  const t0 = Date.now();
  const lines = [];
  const p = spawn('node', [...wsFlag, GX, CFG_FILE], {
    env: { ...process.env, GX_MOCK_RPC: 'http://127.0.0.1:' + PORT, GX_WORKER: WORKER_FILE, PY_WALLETS: WALLETS_FILE, PY_PK: PK_FILE }
  });
  const onData = d => { for (const l of String(d).split('\n')) if (l.trim()) lines.push({ t: Date.now() - ST.openAt, l }); };
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  let exited = false, code = null;
  p.on('exit', c => { exited = true; code = c; });
  while (!exited && Date.now() - t0 < limitMs) await new Promise(r => setTimeout(r, 150));
  const endT = Date.now() - ST.openAt;
  if (!exited) p.kill('SIGKILL');
  return { name, exited, code, lines, endT };
}

const has = (r, re) => r.lines.filter(x => re.test(x.l));
const first = (r, re) => { const x = has(r, re)[0]; return x ? x.t : null; };
const results = [];
function verdict(name, ok, detail) { results.push({ name, ok }); console.log((ok ? 'PASS ' : 'FAIL ') + name + ' | ' + detail); }

// T1 闪兑正常可用 + 撤授权
{
  const r = await run('T1', { flashOkAfterMs: 0, pancakeOkAfterMs: 0 });
  const done = has(r, /闪兑卖光|预发卖光|BS 已卖光|卖光，BNB/).length;
  verdict('T1 闪兑正常：五号全卖光并自动撤授权退出', r.exited && r.code === 0 && has(r, /gx 完/).length === 1 && done >= 5 && has(r, /撤授权/).length >= 10, '退出=' + r.exited + ' 卖光=' + done + ' 撤授权=' + has(r, /撤授权/).length + ' 用时=' + r.endT + 'ms');
}
// T2 闪兑延迟 4s、薄饼可用：开池后薄饼及时接管
{
  const r = await run('T2', { flashOkAfterMs: 4000, pancakeOkAfterMs: 200 });
  const t = first(r, /预发薄饼已发/);
  const done = has(r, /预发卖光|闪兑卖光|卖光，BNB/).length;
  verdict('T2 闪兑无流动性：薄饼及时接管', r.exited && r.code === 0 && done >= 5 && t !== null && t <= 2800, '首笔薄饼=' + t + 'ms 卖光=' + done + ' 退出=' + r.exited);
}
// T3 池子不一致 → 拒卖且自动退出
{
  const r = await run('T3', { wrongPool: true, flashOkAfterMs: 0, pancakeOkAfterMs: 0 }, {}, 10000);
  const sold = has(r, /DEX单 已下|已发 0x|预发薄饼已发|预发闪兑已下/).length;
  verdict('T3 池子不一致：拒卖并自动退出', r.exited && r.code === 0 && has(r, /池子核对失败/).length >= 1 && sold === 0, '退出=' + r.exited + ' code=' + r.code + ' 卖单=' + sold);
}
// T4 池子太浅 → 拒卖且自动退出、之后 0 新单
{
  const r = await run('T4', { shallow: true, flashOkAfterMs: 0, pancakeOkAfterMs: 0 }, {}, 10000);
  const tBad = first(r, /池子太浅/);
  const sellRe = /DEX单 已下|已发 0x|预发薄饼已发|预发闪兑已下/;
  const late = tBad === null ? -1 : r.lines.filter(x => sellRe.test(x.l) && x.t > tBad + 150).length;
  verdict('T4 池子太浅：拒卖并自动退出、之后0新单', r.exited && r.code === 0 && tBad !== null && late === 0, '退出=' + r.exited + ' 拒卖于=' + tBad + 'ms 后发=' + late);
}
// T5 外部 351716 + 闪兑延迟：能恢复卖光
{
  const r = await run('T5', { flashOkAfterMs: 3000, pancakeOkAfterMs: 200, execFail716Ms: 1200 });
  const done = has(r, /预发卖光|闪兑卖光|卖光，BNB/).length;
  verdict('T5 外部 351716 恢复', r.exited && r.code === 0 && done >= 5, '卖光=' + done + ' 用时=' + r.endT + 'ms');
}
// T6 预发模式 1s 闪兑优先窗口不被开池前报错破坏
{
  const r = await run('T6', { acc: '23', flashOkAfterMs: 500, pancakeOkAfterMs: 0, previewMs: 200, swapMs: 250 });
  const pkFired = has(r, /预发薄饼已发/).length;
  const dxFired = has(r, /预发闪兑已下/).length;
  verdict('T6 预发闪兑优先窗不被开池前报错破坏', r.exited && r.code === 0 && dxFired >= 2 && pkFired === 0, '闪兑=' + dxFired + ' 薄饼抢发=' + pkFired + ' 用时=' + r.endT + 'ms');
}
// T7 BS 慢于 graceMs 切进币安兜底后成交 → 兜底干净退出不死锁 + 自动撤 BS 授权
{
  const r = await run('T7', { acc: '1', bsReceiptDelayMs: 1800, flashOkAfterMs: 5000, pancakeOkAfterMs: 5000 }, { bs: { acc: '1', graceMs: 800, poll: 60 } }, 15000);
  const bsRevoke = has(r, /撤授权 BS合约/).length;
  verdict('T7 BS慢成交切兜底不死锁 + 自动撤BS授权', r.exited && r.code === 0 && has(r, /BS ✅ 卖成/).length === 1 && bsRevoke >= 1, '退出=' + r.exited + ' BS撤授权=' + bsRevoke + ' 用时=' + r.endT + 'ms');
}
// T8 BS 配 5 gwei 但私钥余额仅 0.0005 BNB → autoGp 自动压顶 <= 0.475 gwei
{
  const r = await run('T8', { acc: '1', pkBalWei: '500000000000000', bsReceiptDelayMs: 100, flashOkAfterMs: 5000, pancakeOkAfterMs: 5000 }, { bs: { acc: '1', gwei: 5, poll: 60 } }, 12000);
  const clamped = has(r, /gas 价按余额压顶/).length;
  const ready = has(r, /BS 就绪.*gas 0\.475 gwei/).length;
  verdict('T8 BS固定gwei余额不足自动压顶', r.exited && r.code === 0 && clamped >= 1 && ready >= 1, '压顶日志=' + clamped + ' 就绪0.475gwei=' + ready);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log('\n结果：' + results.filter(x => x.ok).length + '/' + results.length + ' 通过');
process.exit(results.every(x => x.ok) ? 0 : 1);
