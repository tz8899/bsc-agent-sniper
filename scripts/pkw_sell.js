// 独立私钥钱包自动秒卖脚本（不依赖币安钱包）
// 流程：授权 PancakeSwap V2 Router →（可选）等开盘块+1 避开首块高税 → 盯余额与 V2 WBNB 报价 → 自动卖 100%
// 用法：node scripts/pkw_sell.js <代币地址> [--slip 90] [--gwei 1 | --gm 4] [--gas 1000000] [--gate 0xfdf7ddd6]
const { signTx } = require('../lib/sign');
const { loadPk, loadRpcs } = require('../lib/config');

const av = process.argv.slice(2);
const TOK = av[0];
if (!/^0x[0-9a-fA-F]{40}$/.test(TOK || '')) {
  console.log('用法: node scripts/pkw_sell.js <代币地址> [--slip 90] [--gwei 1 | --gm 4] [--gas 1000000] [--gate 0x开盘块selector]');
  process.exit(1);
}
const opt = (k, d) => { const i = av.indexOf(k); return i >= 0 && av[i + 1] !== undefined ? av[i + 1] : d; };

const PK = loadPk();
const RPCS = loadRpcs().http;
const ROUTER = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const WBNB = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

const SLIP = Number(opt('--slip', '90'));
const GM_ARG = opt('--gm', null);
const GWEI_ARG = opt('--gwei', GM_ARG === null ? '1' : null);
const SELL_GAS = BigInt(opt('--gas', '1000000'));
const GATE_SEL = opt('--gate', process.env.GATE_SEL || '');

const A = PK.addr;
const h = v => BigInt(v).toString(16).padStart(64, '0');
const ad = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...x) => console.log(new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 23), ...x);

async function rpcU(u, m, p) {
  try {
    const r = await fetch(u, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'curl/8' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }),
      signal: AbortSignal.timeout(5000)
    });
    return await r.json();
  } catch { return {}; }
}
async function rpc(m, p) {
  for (const u of RPCS) {
    const j = await rpcU(u, m, p);
    if (j && (j.result !== undefined || j.error)) return j;
  }
  return {};
}
async function call(to, data) {
  const j = await rpc('eth_call', [{ to, data }, 'latest']);
  if (j.error || !j.result) throw new Error((j.error && j.error.message) || 'rpc fail');
  return j.result;
}
async function bcast(raw) {
  return new Promise(res => {
    let n = 0, done = false, err = '';
    for (const u of RPCS) {
      rpcU(u, 'eth_sendRawTransaction', [raw]).then(j => {
        if (j.result && !done) { done = true; res({ ok: 1 }); }
        else if (j.error) err = j.error.message;
      }).catch(e => err = e.message).finally(() => {
        if (++n === RPCS.length && !done) res({ ok: 0, err });
      });
    }
  });
}

let nonce = null;
async function calcGp(gas) {
  const [gpR, balR] = await Promise.all([rpc('eth_gasPrice', []), rpc('eth_getBalance', [A, 'latest'])]);
  const base = BigInt(gpR.result || '0x2faf080');
  let gp = GWEI_ARG !== null ? BigInt(Math.round(parseFloat(GWEI_ARG) * 1e9)) : base * BigInt(GM_ARG);
  const nb = BigInt(balR.result || '0x0');
  if (nb > 0n) {
    const cap = (nb * 95n) / 100n / gas;
    if (cap > 0n && gp > cap) gp = cap;
  }
  return gp;
}

async function send(tag, to, data, gas) {
  const t0 = Date.now();
  if (nonce === null) nonce = BigInt((await rpc('eth_getTransactionCount', [A, 'pending'])).result);
  const gp = await calcGp(gas);
  const { raw, hash } = signTx({ nonce, gasPrice: gp, gas, to, data, value: 0n }, PK.pk);
  const b = await bcast(raw);
  if (!b.ok && !/known|already/i.test(b.err || '')) {
    log(tag, '发送失败', b.err);
    nonce = null;
    return false;
  }
  nonce++;
  const t1 = Date.now();
  while (Date.now() - t1 < 20000) {
    const r = (await rpc('eth_getTransactionReceipt', [hash]).catch(() => ({}))).result;
    if (r) {
      const ok = r.status === '0x1';
      log(tag, ok ? '✅ 成功' : '❌ 失败', '块', parseInt(r.blockNumber, 16), 'gas', Number(gp) / 1e9, 'gwei 用时', ((Date.now() - t0) / 1000).toFixed(2) + 's', hash);
      if (!ok) nonce = null;
      return ok;
    }
    await sleep(100);
  }
  log(tag, '20 秒没回执', hash);
  nonce = null;
  return false;
}

const bal = async () => BigInt(await call(TOK, '0x70a08231' + ad(A)));
const quote = async amt => {
  const r = await call(ROUTER, '0xd06ca61f' + h(amt) + h(0x40) + h(2) + ad(TOK) + ad(WBNB));
  return BigInt('0x' + r.slice(-64));
};

(async () => {
  const gp0 = await calcGp(SELL_GAS);
  const bnb0 = Number(BigInt((await rpc('eth_getBalance', [A, 'latest'])).result || '0x0')) / 1e18;
  log('钱包', A, '币', TOK, '滑点', SLIP + '%', 'gas', Number(gp0) / 1e9, 'gwei', 'BNB', bnb0.toFixed(6));

  const al = BigInt(await call(TOK, '0xdd62ed3e' + ad(A) + ad(ROUTER)).catch(() => '0x0'));
  if (al < (1n << 200n)) {
    await send('授权', TOK, '0x095ea7b3' + ad(ROUTER) + 'f'.repeat(64), 100000n);
  }

  if (GATE_SEL) {
    let ob = 0n;
    while (true) {
      try { ob = BigInt(await call(TOK, GATE_SEL)); } catch {}
      if (ob > 0n) break;
      await sleep(300);
    }
    log('开盘块门控命中，开盘块', ob.toString(), '等待 +1 块…');
    while (true) {
      let bn = 0n;
      try { bn = BigInt((await rpc('eth_blockNumber', [])).result); } catch {}
      if (bn >= ob + 1n) { log('当前块', bn.toString(), '开卖'); break; }
      await sleep(100);
    }
  }

  let k = 0, waited = false;
  while (true) {
    let b;
    try { b = await bal(); } catch { await sleep(300); continue; }
    if (b === 0n) { await sleep(300); continue; }
    let q = 0n;
    try { q = await quote(b); } catch {}
    if (q <= 0n) {
      if (!waited) { log('已有币', b.toString(), '等开池…'); waited = true; }
      await sleep(300);
      continue;
    }
    k++;
    const min = (q * BigInt(100 - SLIP)) / 100n;
    log('卖#' + k, '数量', b.toString(), '报价', (Number(q) / 1e18).toFixed(6), 'BNB');
    const dl = Math.floor(Date.now() / 1000) + 300;
    const ok = await send('卖#' + k, ROUTER, '0x791ac947' + h(b) + h(min) + h(0xa0) + ad(A) + h(dl) + h(2) + ad(TOK) + ad(WBNB), SELL_GAS);
    if (ok) {
      const bnb = Number(BigInt((await rpc('eth_getBalance', [A, 'latest'])).result || '0x0')) / 1e18;
      log('卖完，当前 BNB', bnb.toFixed(6), '继续监听新到账代币（Ctrl+C 退出）');
    } else {
      await sleep(200);
    }
  }
})();
