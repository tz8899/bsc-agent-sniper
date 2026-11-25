// gx.mjs 通用「触发 / 等池 / 秒卖 / 兜底 / 自动撤授权」一体热进程
// 用法：node scripts/gx.mjs <配置.json> [--sim]
// 配置字段（按需填写）：
//  acc "123"              参与账号（对应 config/wallets.json 中的 accounts 键名）
//  target "0x合约"        触发/条件默认合约地址（纯卖出可不填）
//  at 1794744000          开始时间（unix 秒，按区块时间校钟），early 提前秒数（默认 1.5）
//  cond {call,gte?,to?}   触发条件：eth_call 首 32 字节 >= gte（不写 gte 即非 0）
//  abort [{call,gte?}]    任一满足即放弃
//  cancel 1794744060      到该 unix 秒还没触发则放弃
//  tx {data,to?,value?,unit?,qty?,left?:{call,total},done?,tries?}   可选前置链上交互
//  sell {token,amt?,pct?,route?,slip?,pool?,minPoolBnb?,giveup?,cond?,pre?,dex?,revoke?,report?}
//      amt：预计每号到账数量（代币个数，支持小数）→ 启动即精确授权；到账更多自动补授权
//      route："pancake"（薄饼 V2，默认）/"v3:费率"（如 "v3:100"）/"usdt"/"dex"（币安聚合）
//      dex：默认 true（与薄饼并行，开池后默认给闪兑 1s 优先窗口，超时薄饼立刻接管；dex:false 关闭）
//      pool / minPoolBnb：池子核对保护，路由池不符或 V2 WBNB 储备低于下限（默认 1 BNB）立即拒卖并退出
//  bs {acc?,addr?,pool?,gwei?,gm?,gas?,poll?,graceMs?}
//      由私钥钱包触发 BS（V2）或 BS3（V3，填 bs.pool）批量代卖合约；默认固定 1 gwei、gas 1000000（余额不足自动压顶）
//      超 graceMs（默认 2000ms）未成交自动切币安侧闪兑+薄饼兜底
//  pk {gwei?,gm?,gas?,poll?,force?}
//      币到后转私钥钱包本地签名直卖；未转成功的号照旧走币安侧
// 不写 tx 只写 sell = 直接监听/卖出已有币。--sim = 仅模拟预览，不发任何交易。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const rq = createRequire(import.meta.url);
const { ROOT, loadWallets, loadPk, loadRpcs } = rq('../lib/config.js');

const FLASH = 'b300000b72deaeb607a12d5f54773d1c19c7028d'; // 币安闪兑合约（BSC 公开地址）
const V3R = '13f4ea83d0bd40e75c8222255bc855a974568dd4';   // PancakeSwap V3 SmartRouter
const QV3 = 'b048bbc1ee6b733fffcfb9e9cef7375518e25997';   // PancakeSwap V3 QuoterV2
const V2R = '10ed43c718714eb63d5aa57b78b54704e256024e';   // PancakeSwap V2 Router
const WBNB = 'bb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const USDT = '55d398326f99059ff775485246999027b3197955';
const NAT = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

if (!process.argv[2]) {
  console.log('用法: node scripts/gx.mjs <配置.json> [--sim]');
  process.exit(1);
}
const WCFG = loadWallets(true);
const A = WCFG.accounts;
const CF = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const FLX = !!(CF.sell && (CF.sell.dex !== false || CF.sell.route === 'dex') && CF.sell.flashApprove !== false);
const SIM = process.argv.includes('--sim');
const ACC = String(CF.acc || Object.keys(A).join('')).split('');
for (const k of ACC) {
  if (!A[k]) {
    console.error(`config/wallets.json 中缺少账号 "${k}" 的地址配置`);
    process.exit(1);
  }
}

const X = s => (s ? String(s).replace(/^0x/, '').toLowerCase() : null);
const TG = X(CF.target);
const LIVE = loadRpcs();
const MOCKRPC = process.env.GX_MOCK_RPC || null;

const ts = () => new Date(Date.now() + 8 * 36e5).toISOString().slice(11, 23);
const log = (...a) => console.log(ts(), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 新块推送：WSS newHeads 一到即唤醒等待，断线 1s 重连
let HEADR, HEADP = new Promise(r => HEADR = r), HEADN = 0;
const nap = ms => Promise.race([sleep(ms), HEADP]);
const WSSL = MOCKRPC ? [] : LIVE.wss;
function wsHead(u) {
  try {
    if (typeof WebSocket === 'undefined') return;
    const w = new WebSocket(u);
    w.onopen = () => w.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
    w.onmessage = e => {
      try {
        const j = JSON.parse(e.data);
        if (j.params) { HEADN++; const r = HEADR; HEADP = new Promise(x => HEADR = x); r(); }
      } catch {}
    };
    w.onclose = () => setTimeout(() => wsHead(u), 1000);
    w.onerror = () => { try { w.close(); } catch {} };
  } catch { setTimeout(() => wsHead(u), 1000); }
}
for (const u of WSSL) wsHead(u);
setInterval(() => { if (HEADN === 0 && !MOCKRPC) console.log(ts(), 'WSS 新块未收到，仅 HTTP 轮询'); }, 60000).unref();

const h = x => BigInt(x).toString(16).padStart(64, '0');
const ad = a => a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const RPCS = MOCKRPC ? [MOCKRPC] : LIVE.http;

const post = async (u, m, p, ms = 2500) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await (await fetch(u, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json', 'user-agent': 'curl/8' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p })
    })).json();
  } finally { clearTimeout(t); }
};

const COOL = {};
const live = () => { const t = Date.now(); const l = RPCS.filter(u => !(COOL[u] > t)); return l.length ? l : RPCS; };
const rl = j => !!(j && j.error && (j.error.code === -32005 || /rate|limit|too many|429/i.test(j.error.message || '')));
const rpc = async (m, p) => {
  for (let i = 0; i < 3; i++) {
    for (const u of live()) {
      try {
        const j = await post(u, m, p, m === 'eth_call' ? 1200 : 2500);
        if (rl(j)) { COOL[u] = Date.now() + 3000; continue; }
        if (j && j.result !== undefined) return j;
        if (j && j.error && m === 'eth_call' && (j.error.code === 3 || /revert|execution/i.test(j.error.message || ''))) return j;
      } catch { COOL[u] = Date.now() + 1500; }
    }
    await sleep(100);
  }
  return {};
};

// 读数多节点并发，谁先回用谁；限流/超时节点冷却 1.5~3s
const race = (m, p) => Promise.any(live().map(async u => {
  let j;
  try { j = await post(u, m, p, 2000); } catch (e) { COOL[u] = Date.now() + 1500; throw e; }
  if (rl(j)) { COOL[u] = Date.now() + 3000; throw 0; }
  if (!j || j.result === undefined) throw 0;
  return j;
})).catch(() => ({}));

// 并发模拟调用：任一节点返回成功 result 立刻放行（防首选节点慢 1-2 块），全节点均 revert 才返回 error
const raceCall = async tx => {
  let lastErr = null;
  try {
    return await Promise.any(live().map(async u => {
      let j;
      try { j = await post(u, 'eth_call', [tx, 'latest'], 1200); } catch (e) { COOL[u] = Date.now() + 1500; throw e; }
      if (rl(j)) { COOL[u] = Date.now() + 3000; throw 0; }
      if (j && j.result !== undefined && !j.error) return j;
      if (j && j.error) lastErr = j.error;
      throw 0;
    }));
  } catch {
    return { error: lastErr || { message: 'all rpc reverted' } };
  }
};

const call = async (to, d) => (await race('eth_call', [{ to: '0x' + X(to), data: d }, 'latest'])).result;
const num = async (to, d, w = 0) => {
  const r = await call(to, d);
  const o = 2 + 64 * w;
  return r && r.length >= o + 64 ? BigInt('0x' + r.slice(o, o + 64)) : null;
};
const pu = (s, d) => {
  const [i, f = ''] = String(s).split('.');
  return BigInt(i || '0') * 10n ** BigInt(d) + BigInt((f + '0'.repeat(d)).slice(0, d) || '0');
};
const fu = x => {
  const t = x.toString().padStart(dec + 1, '0');
  return (t.slice(0, -dec) + '.' + t.slice(-dec)).replace(/\.?0+$/, '');
};
const fill = (d, k, q) => d.replace(/\{addr\}/g, ad(A[k])).replace(/\{qty\}/g, h(q || 0));
const chk = async c => {
  const v = await num(c.to || TG, c.call, c.w || 0);
  if (v === null) return [false, v];
  return [c.gte !== undefined ? v >= BigInt(c.gte) : v > 0n, v];
};

// 常驻 baw 工作进程连接
const BAW_CFG = WCFG.baw || {};
const BAW_BASE = path.resolve(ROOT, process.env.BAW_DIR || BAW_CFG.dir || './baw');
function worker(k) {
  const ov = (BAW_CFG.overrides && BAW_CFG.overrides[k]) || {};
  const accDir = ov.dir ? path.resolve(ROOT, ov.dir) : path.join(BAW_BASE, `acc${k}`);
  const env = { ...process.env, BINANCE_BAW_DIR: accDir, WID: 'gx' + k };
  if (ov.home) env.HOME = path.resolve(ROOT, ov.home);
  const idFile = ov.instanceIdFile || BAW_CFG.instanceIdFile;
  if (idFile && !process.env.GX_WORKER) {
    const fp = path.isAbsolute(idFile) ? idFile : path.join(BAW_BASE, idFile);
    if (fs.existsSync(fp)) env.BINANCE_INSTANCE_ID = fs.readFileSync(fp, 'utf8').trim();
  }
  const w = spawn('node', [process.env.GX_WORKER || path.join(HERE, 'bawworker.mjs')], { env });
  let buf = '', n = 0;
  const P = {};
  let ready;
  const R0 = new Promise(r => ready = r);
  w.stderr.on('data', () => {});
  w.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let j;
      try { j = JSON.parse(l); } catch { continue; }
      if (j.ready) ready();
      else if (P[j.id]) { P[j.id](j); delete P[j.id]; }
    }
  });
  return {
    R0,
    kill: () => { try { w.kill(); } catch {} },
    call: (op, body) => new Promise(r => { const id = ++n; P[id] = r; w.stdin.write(JSON.stringify({ id, op, body }) + '\n'); })
  };
}

const W = {};
for (const k of ACC) W[k] = worker(k);
await Promise.all(ACC.map(k => W[k].R0));
log('gx 连接就绪 号', ACC.join(''), SIM ? '(模拟，不发交易)' : '');

const prev = async (k, to, data, value) => {
  const t0 = Date.now();
  const p = await W[k].call('preview', { binanceChainId: '56', from: '0x' + A[k], to: '0x' + X(to), value: String(value || 0), inputData: data }).catch(e => ({ error: e.message }));
  return { rid: p.data && p.data.requestId, err: JSON.stringify(p.error || p.data || '').slice(0, 140), ms: Date.now() - t0 };
};
const exe = async (k, rid) => {
  const t0 = Date.now();
  const e = await W[k].call('execute', { requestId: rid }).catch(e => ({ error: e.message }));
  return { tx: e.data && e.data.txHash, pend: !!(e.data && e.data.status === 'PENDING_CONFIRMATION'), err: JSON.stringify(e.error || e.data || '').slice(0, 140), ms: Date.now() - t0 };
};
const cc = async (k, to, data, value) => {
  const p = await prev(k, to, data, value);
  if (!p.rid) return { ok: false, msg: '预览失败 ' + p.err, ms: [p.ms] };
  if (SIM) return { ok: false, msg: '(模拟不发)', ms: [p.ms] };
  const e = await exe(k, p.rid);
  return { ok: !!e.tx, pend: e.pend, tx: e.tx, msg: e.pend ? '⚠️ 已推到币安 App 待确认，请在 App 点确认' : e.err, ms: [p.ms, e.ms] };
};
const rcpt = async tx => {
  for (let i = 0; i < 60; i++) {
    const r = (await rpc('eth_getTransactionReceipt', [tx])).result;
    if (r) return r.status === '0x1';
    await sleep(400);
  }
  return null;
};

async function off() {
  const t = Date.now();
  const b = (await rpc('eth_getBlockByNumber', ['latest', false])).result;
  const t2 = Date.now();
  return b ? (b.milliTimestamp ? parseInt(b.milliTimestamp, 16) : parseInt(b.timestamp, 16) * 1000) + (t2 - t) / 2 - t2 : 0;
}
async function offAcc() {
  const obs = [];
  let lastN = 0;
  const t00 = Date.now();
  while (Date.now() - t00 < 2600) {
    const ta = Date.now();
    const j = await rpc('eth_getBlockByNumber', ['latest', false]);
    const tb = Date.now();
    const b = j.result;
    if (b) {
      const n = parseInt(b.number, 16);
      if (n !== lastN) {
        lastN = n;
        const ms = b.milliTimestamp ? parseInt(b.milliTimestamp, 16) : parseInt(b.timestamp, 16) * 1000;
        obs.push(tb - (tb - ta) / 2 - ms);
      }
    }
    await sleep(40);
  }
  if (obs.length < 3) return off();
  const mn = Math.min(...obs.slice(1));
  log('对时：采样', obs.length, '个新块，最小到达延迟', Math.round(mn), 'ms，按传播 80ms 估钟差', Math.round(mn - 80), 'ms');
  return -(mn - 80);
}

const O = CF.at ? await offAcc() : await off();
log('钟差', Math.round(O) + 'ms（按区块时间校正）');
const now = () => Date.now() + O;
let BTS = 0;
if (CF.at) {
  (async () => {
    let lg = 0;
    for (;;) {
      try {
        const j = await race('eth_getBlockByNumber', ['latest', false]);
        const b = j && j.result;
        if (b) {
          const t = parseInt(b.timestamp, 16);
          if (t > BTS) {
            BTS = t;
            if (t >= CF.at && !lg) { lg = 1; log('区块到开盘时间 块', parseInt(b.number, 16), '时间戳', t); }
          }
        }
      } catch {}
      await sleep(60);
    }
  })();
}

const STARTBLK = parseInt(((await rpc('eth_blockNumber', [])).result) || '0x0', 16);
let ACTIVE_SELL = false;
let POOLBAD = false, POOLOK = false;

// ===== 批量代卖合约 BS / BS3（私钥钱包触发）=====
const BSP3 = CF.bs && CF.bs.pool ? X(CF.bs.pool) : null;
const BSA = X((CF.bs && CF.bs.addr) || (BSP3 ? WCFG.contracts.bs3 : WCFG.contracts.bs2));
if (CF.bs && (!BSA || /^0+$/.test(BSA))) {
  console.error('已开启 bs 模式，但未配置有效的 BS/BS3 合约地址：请先部署合约并填入 config/wallets.json 或 cfg.bs.addr');
  process.exit(1);
}
const BSACC = String((CF.bs && CF.bs.acc) || '1');
let BSDONE = false, BS_ALIVE = false, POOL_OPEN_AT = 0;
let TAXOK = false;
const TX = CF.tax || null;
const TXM = BigInt(TX ? TX.max ?? 10 : 0);
const TX2 = TX && TX.x2 ? BigInt(Math.round(parseFloat(TX.x2) * 1e18)) : 0n;

const PKW = (CF.bs || CF.pk) ? loadPk() : null;
const SIGN = (CF.bs || CF.pk) ? rq('../lib/sign.js').signTx : null;
const BRPC = MOCKRPC ? [MOCKRPC] : [...RPCS];
const rpcU = async (u, m, p) => {
  try {
    return await (await fetch(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'curl/8' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }),
      signal: AbortSignal.timeout(4000)
    })).json();
  } catch { return {}; }
};

// 默认固定 1 gwei；cfg 写了 gwei 用 gwei，写了 gm（数字倍数或 'auto'）则按 gm；统一受私钥余额压顶保护
const gwDef = o => (o && o.gwei) || ((o && o.gm !== undefined) ? 0 : 1);
function autoGp(gm, base, nb, gas, fixedGwei) {
  let g;
  if (fixedGwei) g = BigInt(Math.round(fixedGwei * 1e9));
  else if (gm === 'auto') {
    const cap = (nb * 95n) / 100n / gas;
    const ceil = BigInt(Math.round(((CF.pk && CF.pk.maxGwei) || (CF.bs && CF.bs.maxGwei) || 20) * 1e9));
    g = cap < ceil ? cap : ceil;
    const floor = base * 2n;
    if (g < floor) g = floor;
  } else g = base * BigInt(gm);
  if (nb > 0n) {
    const cap = (nb * 95n) / 100n / gas;
    if (cap > 0n && g > cap) {
      log('gas 价按余额压顶', Number(g) / 1e9, '→', Number(cap) / 1e9, 'gwei');
      g = cap;
    }
  }
  return g;
}

async function pkChainInfo(gm, gasLimit, fixedGwei) {
  for (;;) {
    const [gpR, ncR, bR] = await Promise.all([
      race('eth_gasPrice', []),
      race('eth_getTransactionCount', [PKW.addr, 'pending']),
      race('eth_getBalance', [PKW.addr, 'latest'])
    ]);
    if (ncR && typeof ncR.result === 'string' && ncR.result.startsWith('0x')) {
      const base = BigInt((gpR && gpR.result) || '0x2faf080');
      const nb = BigInt((bR && bR.result) || '0x0');
      return { gp: autoGp(gm, base, nb, BigInt(gasLimit || 1000000), fixedGwei), nonce: BigInt(ncR.result), nb };
    }
    await sleep(120);
  }
}

async function bsLoop(L) {
  BS_ALIVE = true;
  try {
    const poll = CF.bs.poll ?? 80, GMB = CF.bs.gm ?? 4, BSGAS = CF.bs.gas ?? 1000000, BSGW = gwDef(CF.bs);
    const ws = L.map(k => A[k]);
    let { gp, nonce } = await pkChainInfo(GMB, BSGAS, BSGW);
    log('BS 就绪：私钥', PKW.addr, '号', L.join(''), 'gas', Number(gp) / 1e9, 'gwei');
    let n = 0, lastErr = '', lastSign = Date.now();

    if (!TX && SLIP >= 100) {
      const d = BSP3
        ? '0x483c231f' + ad(ST) + ad(BSP3) + h(0x80) + h(0n) + h(ws.length) + ws.map(ad).join('')
        : '0xd66517d4' + ad(ST) + h(0x60) + h(0n) + h(ws.length) + ws.map(ad).join('');
      let pre = SIGN({ nonce, gasPrice: gp, gas: BigInt(BSGAS), to: '0x' + BSA, data: d, value: 0n }, PKW.pk);
      log('BS 快速模式：nonce', String(nonce), '已预签名，开池只剩 模拟+广播');
      while (!BSDONE && !POOLBAD) {
        if (!SIM && Date.now() - lastSign > 5000) {
          try {
            const inf = await pkChainInfo(GMB, BSGAS, BSGW);
            gp = inf.gp; nonce = inf.nonce;
            pre = SIGN({ nonce, gasPrice: gp, gas: BigInt(BSGAS), to: '0x' + BSA, data: d, value: 0n }, PKW.pk);
            lastSign = Date.now();
          } catch {}
        }
        const [bs, sim] = await Promise.all([
          Promise.all(L.map(k => bal(k).catch(() => 0n))),
          raceCall({ from: PKW.addr, to: '0x' + BSA, data: d })
        ]);
        const tot = bs.reduce((a, b) => a + (b || 0n), 0n);
        if (POOLBAD) { log('BS 池子核对失败，退出拒卖'); return; }
        if (tot === 0n || sim.error) {
          const e = tot === 0n ? '号上还没币' : ((sim.error && sim.error.message) || '').slice(0, 60);
          if (e !== lastErr || ++n % 100 === 0) { log('BS 等开池', e); lastErr = e; }
          await nap(poll);
          continue;
        }
        if (!POOL_OPEN_AT) POOL_OPEN_AT = Date.now();
        if (SIM) { log('BS 模拟通过（不发）'); return; }
        const t0 = Date.now();
        const { raw, hash } = pre;
        await Promise.all(BRPC.map(u => rpcU(u, 'eth_sendRawTransaction', [raw])));
        log('BS 已发', hash, '广播', Date.now() - t0 + 'ms');
        quote(tot).then(q => log('BS 发单时报价', Number(q) / 1e18, 'BNB')).catch(() => {});
        let st = null;
        for (let i = 0; i < 50 && st === null; i++) {
          const r = (await rpc('eth_getTransactionReceipt', [hash])).result;
          if (r) st = r.status === '0x1' ? r : false;
          else await sleep(120);
        }
        if (st) { BSDONE = true; log('BS ✅ 卖成 块', parseInt(st.blockNumber, 16), '用时', Date.now() - t0 + 'ms'); return; }
        log('BS', st === false ? '❌ revert，重试' : '未确认，重试');
        const inf = await pkChainInfo(GMB, BSGAS, BSGW);
        gp = inf.gp; nonce = inf.nonce;
        pre = SIGN({ nonce, gasPrice: gp, gas: BigInt(BSGAS), to: '0x' + BSA, data: d, value: 0n }, PKW.pk);
        lastSign = Date.now();
      }
      if (POOLBAD) log('BS 池子核对失败，退出拒卖');
      return;
    }

    while (!BSDONE && !POOLBAD) {
      let tot = 0n;
      for (const k of L) {
        const b = await bal(k);
        const a = (await num(ST, '0xdd62ed3e' + ad(A[k]) + ad(BSA))) || 0n;
        tot += b < a ? b : a;
      }
      if (tot === 0n) { await nap(poll); continue; }
      const q = await quote(tot).catch(() => 0n);
      const tg = TX && !TAXOK && !(TX2 && q >= TX2 * BigInt(L.length));
      const mn = tg ? (q * (100n - TXM)) / 100n : (q * BigInt(100 - SLIP)) / 100n;
      const d = BSP3
        ? '0x483c231f' + ad(ST) + ad(BSP3) + h(0x80) + h(mn) + h(ws.length) + ws.map(ad).join('')
        : '0xd66517d4' + ad(ST) + h(0x60) + h(mn) + h(ws.length) + ws.map(ad).join('');
      const sim = await raceCall({ from: PKW.addr, to: '0x' + BSA, data: d });
      if (POOLBAD) { log('BS 池子核对失败，退出拒卖'); return; }
      if (sim.error || q === 0n) {
        const e = ((sim.error && sim.error.message) || '无报价').slice(0, 60) + (tg && q > 0n ? ' [税门 >' + TXM + '%? 报价 ' + (Number(q) / 1e18).toFixed(4) + ']' : '');
        if (e !== lastErr || ++n % 100 === 0) { log('BS 等开池', e); lastErr = e; }
        await nap(poll);
        continue;
      }
      if (!POOL_OPEN_AT) POOL_OPEN_AT = Date.now();
      if (TX && !TAXOK) { TAXOK = true; log('税门过：' + (tg ? '实测损耗≤' + TXM + '%' : '报价≥2x 不看税'), '报价', Number(q) / 1e18); }
      if (SIM) { log('BS 模拟通过（不发）报价', Number(q) / 1e18); return; }
      const inf = await pkChainInfo(GMB, BSGAS, BSGW);
      gp = inf.gp; nonce = inf.nonce;
      const t0 = Date.now();
      const { raw, hash } = SIGN({ nonce, gasPrice: gp, gas: BigInt(BSGAS), to: '0x' + BSA, data: d, value: 0n }, PKW.pk);
      await Promise.all(BRPC.map(u => rpcU(u, 'eth_sendRawTransaction', [raw])));
      log('BS 已发', hash, '报价', Number(q) / 1e18, 'BNB', '签名广播', Date.now() - t0 + 'ms');
      let st = null;
      for (let i = 0; i < 50 && st === null; i++) {
        const r = (await rpc('eth_getTransactionReceipt', [hash])).result;
        if (r) st = r.status === '0x1' ? r : false;
        else await sleep(120);
      }
      if (st) { BSDONE = true; log('BS ✅ 卖成 块', parseInt(st.blockNumber, 16), '用时', Date.now() - t0 + 'ms'); return; }
      log('BS', st === false ? '❌ revert，重试' : '未确认，重试');
    }
  } finally { BS_ALIVE = false; }
}

// ===== 私钥钱包直卖模式 =====
let PKN = null;
const PKG = {};
async function pkSend(tag, to, data, gas, gm, isSell = false) {
  const inf = await pkChainInfo(gm, gas, isSell ? gwDef(CF.pk) : 0);
  if (PKN === null) PKN = inf.nonce;
  const gp = inf.gp, t0 = Date.now();
  const { raw, hash } = SIGN({ nonce: PKN, gasPrice: gp, gas: BigInt(gas), to: '0x' + X(to), data, value: 0n }, PKW.pk);
  PKN++;
  await Promise.all(BRPC.map(u => rpcU(u, 'eth_sendRawTransaction', [raw])));
  log(tag, '已发', hash, 'gas', Number(gp) / 1e9, 'gwei', '签名广播', Date.now() - t0 + 'ms');
  for (let i = 0; i < 80; i++) {
    const r = (await rpc('eth_getTransactionReceipt', [hash])).result;
    if (r) {
      log(tag, r.status === '0x1' ? '✅ 成功' : '❌ 失败', '块', parseInt(r.blockNumber, 16), '用时', Date.now() - t0 + 'ms');
      if (r.status !== '0x1') PKN = null;
      return r.status === '0x1';
    }
    await sleep(150);
  }
  log(tag, '没回执');
  PKN = null;
  return false;
}
const pkBal = async () => (await num(ST, '0x70a08231' + ad(PKW.addr))) || 0n;
async function pkApprove(amt) {
  const a = (await num(ST, '0xdd62ed3e' + ad(PKW.addr) + ad(V2R))) || 0n;
  if (a >= amt) return log('私钥 已授权够');
  if (SIM) return log('私钥 精确授权(模拟不发)', Number(amt) / 10 ** dec);
  await pkSend('私钥 精确授权', ST, '0x095ea7b3' + ad(V2R) + h(amt), 100000, 3, false);
}
let PKPEND = 0;
async function toPk(k) {
  let b = 0n;
  const t0 = Date.now();
  PKPEND++;
  try {
    while ((b = await bal(k)) === 0n) {
      if (POOLBAD) return false;
      if (Date.now() - t0 > (S.giveup ?? 86400) * 1000) { log(k, '等币超时'); return false; }
      await sleep(150);
    }
    if (!CF.pk.force && (await quote(b).catch(() => 0n)) > 0n) { log(k, '币到时池已开，不转了'); return false; }
    const r = await cc(k, ST, '0xa9059cbb' + ad(PKW.addr) + h(b));
    log(k, '转私钥', fu(b), r.ok ? '已发 ' + r.tx : r.msg);
    if (!r.ok) return false;
    const st = await rcpt(r.tx);
    log(k, '转私钥上链', st === true ? '成功' : st === false ? '失败' : '未确认');
    return st === true;
  } finally { PKPEND--; }
}
async function pkLoop() {
  const poll = CF.pk.poll ?? 100, gm = CF.pk.gm ?? 4;
  let n = 0, last = '';
  for (;;) {
    if (PKG.stop || POOLBAD) { if (POOLBAD) log('私钥 池子核对失败，退出拒卖'); return; }
    const b = await pkBal();
    if (b === 0n) {
      if (SIM) return log('私钥 现无币（模拟）');
      if (PKPEND === 0 && PKG.started) return;
      await nap(poll);
      continue;
    }
    PKG.started = 1;
    if (!SIM && ((await num(ST, '0xdd62ed3e' + ad(PKW.addr) + ad(V2R))) || 0n) < b) {
      log('私钥 到账比授权多，补授权');
      await pkSend('私钥 补授权', ST, '0x095ea7b3' + ad(V2R) + h(b), 100000, 4, false);
    }
    const q = await quote(b).catch(() => 0n);
    const mn = (q * BigInt(100 - SLIP)) / 100n;
    const dl = BigInt(Math.floor(Date.now() / 1000) + 600);
    const d = '0x791ac947' + h(b) + h(mn) + h(0xa0) + ad(PKW.addr) + h(dl) + pth();
    const sim = q > 0n ? await raceCall({ from: PKW.addr, to: '0x' + V2R, data: d }) : { error: { message: '无报价' } };
    if (POOLBAD) { log('私钥 池子核对失败，退出拒卖'); return; }
    if (sim.error) {
      const e = (sim.error.message || '').slice(0, 60);
      if (e !== last || ++n % 100 === 0) { log('私钥 等开池', fu(b), e); last = e; }
      await nap(poll);
      continue;
    }
    if (SIM) { log('私钥 卖模拟通过（不发）', fu(b), Number(q) / 1e18); return; }
    await pkSend('私钥 卖 ' + fu(b) + ' 报价 ' + (Number(q) / 1e18).toFixed(6), V2R, d, CF.pk.gas ?? 1000000, gm, true);
  }
}

// ===== 卖出准备（启动即做，不等触发）=====
const S = CF.sell;
let dec = 18, RT = V2R, FEE = null, PATH = [], SLIP = 100, AMT = null, PCT = 100;
const ST = X(S && S.token);
const allow = async k => (await num(ST, '0xdd62ed3e' + ad(A[k]) + ad(RT))) || 0n;
const BALC = {};
const bal = async k => {
  for (let i = 0; i < 20; i++) {
    const v = await num(ST, '0x70a08231' + ad(A[k]));
    if (v !== null) { BALC[k] = v; return v; }
    await sleep(100);
  }
  return BALC[k] !== undefined && BALC[k] > 0n ? BALC[k] : 1n << 200n;
};
const pth = () => h(PATH.length) + PATH.map(ad).join('');
const quote0 = async amt => {
  if (FEE) {
    const r = await call(QV3, '0xc6a5026a' + ad(ST) + ad(WBNB) + h(amt) + h(FEE) + h(0));
    return r && r.length >= 66 ? BigInt(r.slice(0, 66)) : 0n;
  }
  const r = await call(V2R, '0xd06ca61f' + h(amt) + h(0x40) + pth());
  return r && r.length >= 130 ? BigInt('0x' + r.slice(-64)) : 0n;
};
const QCH = new Map();
const quote = amt => {
  const key = String(amt), n = Date.now(), c = QCH.get(key);
  if (c && n - c.t < 120) return c.p;
  const p = quote0(amt);
  QCH.set(key, { t: n, p });
  p.then(v => { if (!v) QCH.delete(key); }, () => QCH.delete(key));
  if (QCH.size > 50) QCH.clear();
  return p;
};

const V2F = 'ca143ce32fe78f1f7019d7d551a6402fc5350c73';
const V3F = '0bfbcf9fa4f9c56b0f40a671ad40e0805a091865';

// 池子核对：路由实际池必须等于 sell.pool；V2 WBNB 池要求 BNB 储备 >= sell.minPoolBnb（默认 1）
async function poolWatch() {
  const want = S.pool ? X(S.pool) : null;
  const minB = BigInt(Math.round((S.minPoolBnb ?? 1) * 1e18));
  let n = 0, warned = false, pairSeen = false;
  for (;;) {
    if (POOLOK || POOLBAD) return;
    try {
      let pair = null;
      if (FEE) {
        const r = await call(V3F, '0x1698ee82' + ad(ST) + ad(WBNB) + h(FEE));
        if (r && r.length >= 66) pair = r.slice(26, 66);
      } else {
        const r = await call(V2F, '0xe6a43905' + ad(PATH[0]) + ad(PATH[1]));
        if (r && r.length >= 66) pair = r.slice(26, 66);
      }
      if (pair && !/^0+$/.test(pair)) {
        pair = pair.toLowerCase();
        pairSeen = true;
        if (want && pair !== want) {
          POOLBAD = true;
          log('❌ 池子核对失败：路由会走 0x' + pair, '但配置的官方池是 0x' + want, '→ 全部拒卖');
          return;
        }
        if (!want && !warned) { warned = true; log('池子（自动解析，建议在 cfg 写 sell.pool）0x' + pair); }
        if (!FEE && PATH.length === 2) {
          const rr = await call(pair, '0x0902f1ac'), t0 = await call(pair, '0x0dfe1681');
          if (rr && rr.length >= 130 && t0) {
            const r0 = BigInt('0x' + rr.slice(2, 66)), r1 = BigInt('0x' + rr.slice(66, 130));
            const bnbRes = t0.slice(26, 66).toLowerCase() === WBNB ? r0 : r1;
            if (bnbRes > 0n) {
              if (bnbRes < minB) {
                POOLBAD = true;
                log('❌ 池子太浅：BNB 储备', (Number(bnbRes) / 1e18).toFixed(4), '< 下限', Number(minB) / 1e18, '→ 全部拒卖（cfg sell.minPoolBnb 可调）');
                return;
              }
              POOLOK = true;
              log('池子核对通过 0x' + pair, 'BNB 储备', (Number(bnbRes) / 1e18).toFixed(3));
              return;
            }
          }
        } else {
          POOLOK = true;
          log('池子核对通过 0x' + pair);
          return;
        }
      }
    } catch {}
    await nap(pairSeen ? 50 : 200);
    if (++n % 300 === 0) log('池子核对：等池子/储备出现…');
  }
}

async function approve(k, amt, sp = RT) {
  const allowSp = async k2 => (await num(ST, '0xdd62ed3e' + ad(A[k2]) + ad(sp))) || 0n;
  if ((await allowSp(k)) >= amt) return log(k, '已授权够', Number(amt) / 10 ** dec);
  for (let i = 0; i < 5; i++) {
    const r = await cc(k, ST, '0x095ea7b3' + ad(sp) + h(amt));
    log(k, sp === RT ? '精确授权' : sp === FLASH ? '精确授权闪兑' : '精确授权BS', Number(amt) / 10 ** dec, r.ok ? '已发 ' + r.tx : r.msg);
    if (r.ok || SIM || r.pend) break;
    await sleep(500);
  }
  if (!SIM) {
    for (let i = 0; i < (sp === BSA ? 1500 : 40) && (await allowSp(k)) < amt; i++) await sleep(400);
    log(k, '授权到位');
  }
}

let PRE = Promise.resolve();
if (S) {
  const rt = S.route || 'pancake';
  if (rt.startsWith('v3')) { FEE = +rt.split(':')[1]; RT = V3R; }
  PATH = rt === 'usdt' ? [ST, USDT, WBNB] : [ST, WBNB];
  SLIP = S.slip ?? 100;
  PCT = S.pct ?? 100;
  dec = Number((await num(ST, '0x313ce567')) ?? 18n);
  if (S.amt !== undefined) AMT = pu(S.amt, dec);
  log('卖出：币', ST, '路由', rt, '滑点', SLIP + '%', AMT ? '预计每号 ' + S.amt + '，现在就精确授权' : '没给 amt，到账后再授权（会慢）');
  if (AMT) {
    PRE = Promise.all([
      ...(CF.pk ? [pkApprove(AMT * BigInt(ACC.length))] : []),
      ...ACC.map(async k => {
        if (CF.bs && BSACC.includes(k)) approve(k, (AMT * BigInt(PCT)) / 100n, BSA).catch(e => log(k, 'BS授权出错', e.message));
        await Promise.all([approve(k, (AMT * BigInt(PCT)) / 100n), FLX ? approve(k, (AMT * BigInt(PCT)) / 100n, FLASH) : null]);
      })
    ]);
  } else {
    log('⚠⚠ 没给 amt：授权要等币到账才发，开盘会慢几秒！建议 cfg 填写 sell.amt');
  }
}

if (S) poolWatch();
if (!CF.at && !SIM && S && ST && !MOCKRPC) {
  setInterval(async () => {
    if (ACTIVE_SELL || POOL_OPEN_AT) return;
    try {
      const r = await Promise.all(ACC.map(async k => (await prev(k, WBNB, '0x095ea7b3' + ad(V2R) + h(1), 0)).rid ? '' : k));
      const bad = r.join('');
      if (bad) {
        log('连接保活 ❌ 号', bad, '预览不通，重连');
        for (const k of bad) { try { W[k].kill(); } catch {} W[k] = worker(k); await W[k].R0; log(k, '已重连'); }
      }
    } catch {}
  }, 120000).unref();
}

// ===== 触发 =====
async function trigger() {
  if (SIM) { log('(模拟) 跳过等待，直接当触发'); return true; }
  if (CF.at) {
    const E = (CF.early ?? 1.5) * 1000;
    let w = CF.at * 1000 - E - now();
    if (w > 0) log('等开始', Math.round(w / 1000), '秒（时间+区块双盯）');
    let PBN = 0;
    while (w > 0) {
      if (BTS >= CF.at) { log('区块先到开盘时间，提前开打'); break; }
      if (CF.probe && CF.tx) {
        const T = CF.tx, k = ACC[0], q = T.qty || 1;
        const val = T.unit ? pu(T.unit, 18) * BigInt(q) : pu(T.value || '0', 18);
        const j = await race('eth_call', [{ from: '0x' + A[k], to: '0x' + X(T.to || TG), data: fill(T.data, k, q), value: '0x' + val.toString(16) }, 'latest']).catch(() => null);
        if (j && j.result !== undefined) { log('链上盲探提前通过，开打'); break; }
        if (++PBN % 3000 === 1) log('链上盲探中，未开', (j && j.error && j.error.message || '').slice(0, 50));
      }
      const z = CF.probe ? Math.min(w, CF.probeGap ?? 300) : w < 15000 ? Math.min(w, 40) : Math.min(w, 90000);
      await sleep(z);
      w = CF.at * 1000 - E - now();
      if (z >= 15000 && w > 5000 && S && ST) {
        const r = await Promise.all(ACC.map(async k => (await prev(k, ST, '0x095ea7b3' + ad(V2R) + h(1), 0)).rid ? '' : k));
        const bad = r.join('');
        log('连接保活', bad ? '❌ 号 ' + bad + ' 预览不通，重连' : '各号正常');
        for (const k of bad) { try { W[k].kill(); } catch {} W[k] = worker(k); await W[k].R0; log(k, '已重连'); }
      }
    }
  }
  if (!CF.cond && !CF.abort && !CF.cancel && !CF.sigIn && !CF.probe) return true;
  const SD = path.join(ROOT, 'sig') + path.sep;
  const SIGI = CF.sigIn ? SD + CF.sigIn : null;
  const SIGO = CF.sigOut ? SD + CF.sigOut : null;
  const T0 = Date.now();
  let STOP = false, PROBE = false;
  const fire = why => {
    STOP = true;
    log('触发！', why);
    if (SIGO) {
      try { fs.mkdirSync(SD, { recursive: true }); fs.writeFileSync(SIGO, String(Date.now())); log('已发联动信号', CF.sigOut); } catch {}
    }
    return true;
  };
  const sigOn = () => { try { const st = fs.statSync(SIGI); return st.mtimeMs > T0 - 2 * 36e5; } catch { return false; } };
  if (CF.probe && CF.tx) {
    const T = CF.tx, k = ACC[0], q = T.qty || 1;
    const val = T.unit ? pu(T.unit, 18) * BigInt(q) : pu(T.value || '0', 18);
    log('预览盲探已开，号', k, '每', (CF.probeGap ?? 300) + 'ms');
    (async () => {
      let pn = 0;
      while (!STOP) {
        const j = await race('eth_call', [{ from: '0x' + A[k], to: '0x' + X(T.to || TG), data: fill(T.data, k, q), value: '0x' + val.toString(16) }, 'latest']);
        if (j.result !== undefined) { PROBE = true; break; }
        if (++pn % 300 === 0) log('预览还不过');
        await sleep(CF.probeGap ?? 300);
      }
    })();
  }
  let last = null, lt = 0, n = 0, nul = 0;
  for (;;) {
    for (const c of CF.abort || []) {
      const [hit, v] = await chk(c);
      if (hit) { STOP = true; log('放弃条件满足', c.call, String(v), '→ 不打'); return false; }
    }
    if (CF.cancel && now() > CF.cancel * 1000) { STOP = true; log('到取消时间还没触发 → 不打'); return false; }
    if (SIGI && sigOn()) return fire('收到联动信号 ' + CF.sigIn);
    if (PROBE) return fire('预览通过');
    if (!CF.cond && !CF.sigIn && !CF.probe) return true;
    if (CF.cond) {
      const [ok, v] = await chk(CF.cond);
      if (v === null) { if (++nul % 20 === 1) log('⚠ 条件读数为空', nul, '次'); }
      else if (String(v) !== last && Date.now() - lt > 500) { log('条件值', String(v), CF.cond.gte !== undefined ? '/ 门槛 ' + CF.cond.gte : ''); last = String(v); lt = Date.now(); }
      else if (++n % 300 === 0) log('还在等，当前', String(v));
      if (ok) return fire('值 ' + String(v));
    }
    await nap(CF.poll ?? 100);
  }
}

// ===== 可选前置链上交互 =====
async function doTx(k) {
  const T = CF.tx, to = T.to || TG;
  for (let i = 1; i <= (T.tries || 100000); i++) {
    if (T.done) { const v = await num(to, fill(T.done, k)); if (v && v > 0n) { log(k, '已完成', String(v)); return true; } }
    if (i > 1) for (const c of CF.abort || []) { const [hit] = await chk(c); if (hit) { log(k, '放弃条件满足，停'); return false; } }
    let q = T.qty || 1;
    if (T.left) { const l = await num(to, T.left.call); q = Math.min(q, T.left.total - Number(l ?? 0n)); if (q <= 0) { log(k, '没剩余，停'); return false; } }
    const val = T.unit ? pu(T.unit, 18) * BigInt(q) : pu(T.value || '0', 18);
    const p = await prev(k, to, fill(T.data, k, q), val);
    if (!p.rid) {
      if (i % 10 === 1) log(k, '预览未过', q + '份', '第' + i + '次', p.ms + 'ms', p.err);
      if (SIM && i >= 3) return false;
      const b0 = BTS >= (CF.at || 0), t9 = Date.now() + (T.gap ?? 200);
      while (Date.now() < t9) { if (!b0 && CF.at && BTS >= CF.at) break; await sleep(20); }
      continue;
    }
    if (SIM) { log(k, '预览通过（模拟不发）', q + '份', p.ms + 'ms'); return false; }
    const e = await exe(k, p.rid);
    log(k, e.tx ? '已发 ' + e.tx : '执行失败 ' + e.err, q + '份', '预览/执行', p.ms + '/' + e.ms + 'ms');
    if (!e.tx) { await sleep(200); continue; }
    const st = await rcpt(e.tx);
    log(k, '上链', st === true ? '成功' : st === false ? '失败(revert)，重来' : '未确认');
    if (st !== false) return true;
  }
  return false;
}

const okT = await trigger();
if (!CF.at && !CF.cond) await PRE;
if (!okT) { log('gx 结束（未触发，不卖）'); process.exit(); }

let L = ACC;
if (CF.tx) {
  const r = {};
  await Promise.all(ACC.map(async k => { r[k] = await doTx(k); }));
  L = ACC.filter(k => r[k]);
  log('执行成功号', L.join('') || '无');
  if (SIM && S) L = ACC;
}
if (!S || !L.length) { log('gx 结束'); process.exit(); }

// ===== 卖出执行 =====
await PRE;
const BSL = L.filter(k => BSACC.includes(k));
const BSP = CF.bs && BSL.length ? bsLoop(BSL).catch(e => log('BS 出错', e.stack)) : null;
let PKP = null;
if (CF.pk && !SIM) PKP = pkLoop().catch(e => log('私钥卖 出错', e.message));
if (CF.pk && SIM) { await pkLoop(); }
if (SIM) {
  if (BSP) await Promise.race([BSP, sleep(3000)]);
  for (const k of L) log(k, '(模拟) 现有币', Number(await bal(k)) / 10 ** dec, '授权', Number(await allow(k)) / 10 ** dec, '报价', Number(await quote(AMT || 10n ** BigInt(dec))) / 1e18, 'BNB');
  log('模拟完');
  process.exit();
}
if (!AMT) {
  for (const k of L) {
    const b = ((await bal(k)) * BigInt(PCT)) / 100n;
    if (b > 0n) await Promise.all([approve(k, b), FLX ? approve(k, b, FLASH) : null]);
  }
}

const DEXR = S.route === 'dex';
const DSTOP = {}, DEX_OK = {}, TX_BUSY = {};
const DEX1 = S.dex !== false && !DEXR;
const GAP = S.gap ?? 250, INF = S.inflight ?? 2, DEX_FIRST_MS = S.dexFirstMs ?? 1000, BS_GRACE_MS = (CF.bs && CF.bs.graceMs) ?? 2000;
const stopped = k => !!(DSTOP[k] || DEX_OK[k] || POOLBAD || (BSDONE && BSACC.includes(k)));

const sellData = async (k, amt, mo) => {
  const q = await quote(amt).catch(() => 0n);
  if (q > 0n && !POOL_OPEN_AT) POOL_OPEN_AT = Date.now();
  const mn = mo !== undefined ? (q * (100n - mo)) / 100n : (q * BigInt(100 - SLIP)) / 100n;
  const dl = BigInt(Math.floor(Date.now() / 1000) + 1200);
  if (FEE) {
    const bb = x => h(x.length / 2) + x + '0'.repeat((64 - (x.length % 64)) % 64);
    const e1 = bb('04e45aaf' + ad(ST) + ad(WBNB) + h(FEE) + h(2) + h(amt) + h(0) + h(0));
    const e2 = bb('49404b7c' + h(mn) + ad(A[k]));
    return [q, '0x5ae401dc' + h(dl) + h(0x40) + h(2) + h(0x40) + h(0x40 + e1.length / 2) + e1 + e2];
  }
  return [q, '0x791ac947' + h(amt) + h(mn) + h(0xa0) + ad(A[k]) + h(dl) + pth()];
};

// 薄饼叠发预览：互斥只锁 execute；开池前 DEX_FIRST_MS（默认 1s）让路给高 gas 闪兑，超时薄饼立刻接管
async function burst(k, amt) {
  return new Promise(res => {
    let done = false, fly = 0, n = 0;
    const t0 = Date.now();
    const fin = v => { if (!done) { done = true; res(v); } };
    const one = async () => {
      if (stopped(k)) return;
      fly++;
      const id = ++n;
      let q, d, p;
      try { [q, d] = await sellData(k, amt); p = await prev(k, RT, d, 0); } finally { fly--; }
      if (done) return;
      if (stopped(k)) { fin(null); return; }
      if (!p.rid) { if (id % 10 === 1) log(k, '卖预览未过', id, p.ms + 'ms', p.err); return; }
      if (!POOL_OPEN_AT) POOL_OPEN_AT = Date.now();
      if (DEX1 && Date.now() - POOL_OPEN_AT < DEX_FIRST_MS) return;
      if (stopped(k) || TX_BUSY[k]) return;
      TX_BUSY[k] = 1;
      let e;
      try { e = await exe(k, p.rid); } finally { TX_BUSY[k] = 0; }
      log(k, '卖', fu(amt), '报价', Number(q) / 1e18, 'BNB', e.tx ? '已发 ' + e.tx : '执行失败 ' + e.err, '预览/执行', p.ms + '/' + e.ms + 'ms', '距开始', Date.now() - t0 + 'ms');
      if (e.tx) fin(e.tx);
    };
    const tick = () => {
      if (done) return;
      if (stopped(k)) { fin(null); return; }
      if (fly < INF) one().catch(e => log(k, '出错', e.message));
      setTimeout(tick, GAP);
    };
    tick();
  });
}

const DXN = {};
async function dexSell(k, amt) {
  if (stopped(k) || TX_BUSY[k]) return false;
  const t0 = Date.now();
  TX_BUSY[k] = 1;
  let r;
  try {
    r = await W[k].call('swap', { amount: fu(amt), fromToken: '0x' + ST, toToken: NAT, slippage: String(SLIP), binanceChainId: '56', mev: false, gasLevel: 'HIGH' });
  } finally { TX_BUSY[k] = 0; }
  const ok = !!(r && r.success && r.data && (r.data.orderId || r.data.txHash));
  if (ok) { DEX_OK[k] = 1; if (!POOL_OPEN_AT) POOL_OPEN_AT = Date.now(); }
  if (ok || !(DXN[k] = (DXN[k] || 0) + 1) || DXN[k] % 10 === 1) {
    log(k, 'DEX单', ok ? '已下' : '失败' + (DXN[k] > 1 ? '(第' + DXN[k] + '次)' : ''), Date.now() - t0 + 'ms', JSON.stringify((r && (r.data || r.error)) || '').slice(0, 140));
  }
  return ok;
}

async function waitZero(k, dust, ms = 2500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if ((await bal(k)) <= dust) return true; await sleep(100); }
  return (await bal(k)) <= dust;
}
const poolLive = async () => {
  if (S.cond) return (await chk(S.cond))[0];
  return (await quote(AMT || 10n ** BigInt(dec)).catch(() => 0n)) > 0n;
};

async function bnSell(k) {
  const bnb = async () => BigInt((await rpc('eth_getBalance', ['0x' + A[k], 'latest'])).result || '0x0');
  const b0 = await bnb();
  const isBsAcc = !!(CF.bs && BSACC.includes(k));
  const abortCheck = () => POOLBAD || (BSDONE && isBsAcc);

  if (isBsAcc) {
    log(k, 'BS 专属号：让路给私钥 BS 秒卖，币安侧待命兜底');
    const t0 = Date.now();
    while ((await bal(k)) === 0n && !abortCheck()) {
      if (Date.now() - t0 > (S.giveup ?? 86400) * 1000) return;
      await nap(100);
    }
    if (POOLBAD) { log(k, '池子核对失败，退出拒卖'); return; }
    let pn = 0;
    while (!abortCheck() && BS_ALIVE) {
      if (!POOL_OPEN_AT && (pn++ % 3 === 0) && await poolLive()) POOL_OPEN_AT = Date.now();
      if (POOL_OPEN_AT && Date.now() - POOL_OPEN_AT >= BS_GRACE_MS) {
        log(k, 'BS 超过 ' + BS_GRACE_MS + 'ms 未成交，启动币安闪兑+薄饼兜底！');
        break;
      }
      if ((await bal(k)) <= 1000n) break;
      await nap(80);
    }
    if (POOLBAD) { log(k, '池子核对失败，退出拒卖'); return; }
    if (BSDONE || (await bal(k)) <= 1000n) {
      DSTOP[k] = 1;
      log(k, 'BS 已卖光，BNB 变化', (Number((await bnb()) - b0) / 1e18).toFixed(6));
      return;
    }
  } else if (S.pre && AMT) {
    let n = 0;
    for (;;) {
      if (POOLBAD) { log(k, '池子核对失败，退出拒卖'); return; }
      const [p] = await chk(S.pre);
      if (p) { log(k, '预发条件满足'); break; }
      if (await poolLive()) { POOL_OPEN_AT = POOL_OPEN_AT || Date.now(); log(k, '池子已有储备'); break; }
      if ((await bal(k)) > 0n) { log(k, '号上已有币'); break; }
      if (n++ % 400 === 0) log(k, '等预发条件');
      await nap(150);
    }
    ACTIVE_SELL = true;
    log(k, '开始预发（闪兑优先 ' + DEX_FIRST_MS + 'ms + 互斥防351716）', fu(AMT));
    DSTOP[k] = 0;
    const dustPre = AMT / 100000n;
    const d = (async () => {
      while (!DSTOP[k] && !abortCheck()) {
        if (!POOL_OPEN_AT) poolLive().then(v => { if (v && !POOL_OPEN_AT) POOL_OPEN_AT = Date.now(); }).catch(() => {});
        const ok = await dexSell(k, AMT).catch(() => false);
        if (ok) {
          log(k, '预发闪兑已下，等链上归零');
          if (await waitZero(k, dustPre, 2500)) { DSTOP[k] = 1; return 'dex'; }
          DEX_OK[k] = 0;
        }
        await sleep(S.dexGap ?? 150);
      }
      return null;
    })();
    const p = (async () => {
      while (!DSTOP[k] && !abortCheck()) {
        const tx = await burst(k, AMT);
        if (!tx) { if (abortCheck()) return null; await sleep(40); continue; }
        log(k, '预发薄饼已发', tx);
        const st = await rcpt(tx);
        if (st === true || (await bal(k)) <= dustPre) { DSTOP[k] = 1; return 'pancake'; }
      }
      return null;
    })();
    await Promise.race([d, p]);
    DSTOP[k] = 1;
    if (POOLBAD) { log(k, '池子核对失败，退出拒卖'); return; }
    if ((await bal(k)) <= dustPre) {
      log(k, '预发卖光，BNB 变化', (Number((await bnb()) - b0) / 1e18).toFixed(6));
      return;
    }
  }

  const t0 = Date.now();
  let b = 0n;
  while ((b = await bal(k)) === 0n) {
    if (abortCheck()) { if (POOLBAD) log(k, '池子核对失败，退出拒卖'); return; }
    if (Date.now() - t0 > (S.giveup ?? 86400) * 1000) { log(k, '等币超时，不卖'); return; }
    await nap(100);
  }
  if (POOLBAD) { log(k, '池子核对失败，退出拒卖'); return; }
  const bb = (b * BigInt(PCT)) / 100n;
  const dust = bb / 100000n || 1000n;
  log(k, '币到账', fu(bb));
  if (S.cond) {
    let n = 0;
    while (!(await chk(S.cond))[0]) {
      if (abortCheck()) { if (POOLBAD) log(k, '池子核对失败，退出拒卖'); return; }
      if (n++ % 400 === 0) log(k, '等卖出条件');
      await nap(100);
    }
    POOL_OPEN_AT = POOL_OPEN_AT || Date.now();
    log(k, '卖出条件满足');
  } else POOL_OPEN_AT = POOL_OPEN_AT || Date.now();

  ACTIVE_SELL = true;
  if (TX) {
    let n = 0;
    while (!TAXOK && !abortCheck()) {
      const [q, d] = await sellData(k, bb, TXM);
      if (q > 0n && TX2 && q >= TX2) { TAXOK = true; log(k, '报价≥2x 不看税', Number(q) / 1e18); break; }
      if (q > 0n) {
        const r = await rpc('eth_call', [{ from: '0x' + A[k], to: '0x' + (FEE ? V3R : V2R), data: d }, 'latest']);
        if (!r.error) { TAXOK = true; log(k, '税门过（链上模拟损耗≤' + TXM + '%）报价', Number(q) / 1e18); break; }
        if (n % 20 === 0) log(k, '税门未过/等', (r.error.message || '').slice(0, 50), '报价', Number(q) / 1e18);
      }
      n++;
      await sleep(100);
    }
  }
  if (abortCheck()) { if (POOLBAD) log(k, '池子核对失败，退出拒卖'); return; }
  if (!DEXR && (await allow(k)) < bb) { log(k, '到账比授权多，补授权'); await approve(k, bb); }

  for (let i = 1; ; i++) {
    if (abortCheck()) break;
    const amt = PCT < 100 ? bb : await bal(k);
    if (amt <= dust) break;
    DSTOP[k] = 0; DEX_OK[k] = 0;
    if (DEX1) {
      const dl = (async () => {
        while (!DSTOP[k] && !abortCheck()) {
          const ok = await dexSell(k, amt);
          if (ok) { if (await waitZero(k, dust, 2500)) { DSTOP[k] = 1; log(k, '闪兑卖光'); return; } DEX_OK[k] = 0; }
          await sleep(S.dexGap ?? 150);
        }
      })();
      const bp = (async () => {
        while (!DSTOP[k] && !abortCheck()) {
          const tx = await burst(k, amt);
          if (!tx) { if (abortCheck()) return; await sleep(40); continue; }
          const st = await rcpt(tx);
          log(k, '合约调用卖上链', st === true ? '成功' : st === false ? '失败' : '未确认');
          if (st === true || (await bal(k)) <= dust) { DSTOP[k] = 1; return; }
        }
      })();
      await Promise.race([dl, bp]);
      DSTOP[k] = 1;
    } else if (DEXR) {
      await dexSell(k, amt);
      await waitZero(k, dust, 2500);
    } else {
      const tx = await burst(k, amt);
      if (tx) { const st = await rcpt(tx); log(k, '卖上链', st === true ? '成功' : st === false ? '失败' : '未确认'); }
    }
    if (abortCheck()) break;
    if (PCT < 100) { log(k, '按比例卖已发'); return; }
    if ((await bal(k)) <= dust) break;
    log(k, '没卖光，第', i + 1, '轮');
    await sleep(100);
  }
  DSTOP[k] = 1;
  if (POOLBAD) { log(k, '池子核对失败，退出拒卖'); return; }
  log(k, BSDONE && isBsAcc ? 'BS 已卖光（兜底收尾），BNB 变化' : '卖光，BNB 变化', (Number((await bnb()) - b0) / 1e18).toFixed(6));
}

// 卖完清零授权（路由 + 闪兑 + BS 合约）
async function revokeAll(L2) {
  const tasks = L2.map(async k => {
    if ((await bal(k)) > 1000n) return;
    const sps = [RT];
    if (FLX) sps.push(FLASH);
    if (CF.bs && BSACC.includes(k)) sps.push(BSA);
    for (const sp of sps) {
      const a = (await num(ST, '0xdd62ed3e' + ad(A[k]) + ad(sp))) || 0n;
      if (a === 0n) continue;
      const r = await cc(k, ST, '0x095ea7b3' + ad(sp) + h(0n));
      log(k, '撤授权', sp === RT ? '路由' : sp === FLASH ? '闪兑' : 'BS合约', r.ok ? '已发 ' + r.tx : r.msg);
    }
  });
  if (CF.pk) {
    tasks.push((async () => {
      const a = (await num(ST, '0xdd62ed3e' + ad(PKW.addr) + ad(V2R))) || 0n;
      if (a > 0n) await pkSend('私钥 撤授权', ST, '0x095ea7b3' + ad(V2R) + h(0n), 100000, 3, false);
    })());
  }
  await Promise.all(tasks.map(t => t.catch(e => log('撤授权出错', e.message))));
}

let PKT = 0, PKM = 0;
if (CF.pk) {
  await Promise.all([
    ...L.map(async k => {
      const ok = await toPk(k).catch(() => false);
      PKT++;
      if (ok) PKM++;
      if (PKT === L.length && PKM === 0) PKG.stop = 1;
      if (ok) return;
      log(k, '没转私钥，币安直卖');
      await bnSell(k);
    }),
    PKP
  ]);
} else {
  await Promise.all(L.map(k => bnSell(k).catch(e => log(k, '卖出流程出错', (e && e.stack) || e))));
}

BSDONE = true;
if (PKP) await PKP;
if (!SIM && S.revoke !== false && !POOLBAD) await revokeAll(L);
log('gx 完');

if (S.report !== false && !MOCKRPC && !POOLBAD) {
  try {
    const logDir = path.join(ROOT, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const fd = fs.openSync(path.join(logDir, 'report_' + ST.slice(0, 6) + '.txt'), 'w');
    spawn('node', [path.join(HERE, 'report.mjs'), '0x' + ST, String(STARTBLK), ACC.join(''), S.pool || '', S.route || 'pancake'], {
      detached: true,
      stdio: ['ignore', fd, fd]
    }).unref();
  } catch {}
}
process.exit();
