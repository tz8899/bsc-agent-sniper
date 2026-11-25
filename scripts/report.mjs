// 链上块级复盘战报（零依赖，自动支持薄饼 V2 WBNB 池、V2 USDT 池、V3 池）
// 用法：node scripts/report.mjs <代币地址> <起始块> <账号如123> [池子地址] [路由如pancake/usdt/v3:100]
import { createRequire } from 'node:module';

const rq = createRequire(import.meta.url);
const { keccak256 } = rq('../lib/keccak.js');
const { loadWallets, loadRpcs } = rq('../lib/config.js');

const [TOK0, SB, ACCS, POOL_ARG, ROUTE_ARG] = process.argv.slice(2);
if (!TOK0) {
  console.log('用法: node scripts/report.mjs <代币地址> <起始块> <账号如123> [池子地址] [路由如pancake/usdt/v3:100]');
  process.exit(1);
}

const WCFG = loadWallets(true);
const LIVE_HTTP = loadRpcs().http;
const TOK = TOK0.toLowerCase();
const ACC = String(ACCS || Object.keys(WCFG.accounts).join('')).split('').filter(k => WCFG.accounts[k]);
const RT = (ROUTE_ARG || 'pancake').toLowerCase();

const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
const USDT = '0x55d398326f99059ff775485246999027b3197955';
const V2F = '0xca143ce32fe78f1f7019d7d551a6402fc5350c73';
const V3F = '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865';

const post = async (u, m, p) => {
  const r = await fetch(u, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'curl/8' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }),
    signal: AbortSignal.timeout(7000)
  }).then(x => x.json());
  if (!r || r.result === undefined) throw new Error('rpc fail');
  return r.result;
};
const race = (m, p) => Promise.any(LIVE_HTTP.map(u => post(u, m, p)));

const hx = n => '0x' + n.toString(16);
const fmt = ms => new Date(ms + 8 * 36e5).toISOString().slice(11, 23);
const pad = a => '0x' + a.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const msOf = b => (b.milliTimestamp ? parseInt(b.milliTimestamp, 16) : parseInt(b.timestamp, 16) * 1000);
const isZero = a => !a || /^0x0+$/.test(a);
const topic = sig => '0x' + keccak256(sig);
const u256 = (data, idx) => BigInt('0x' + data.slice(2 + idx * 64, 2 + (idx + 1) * 64));
const i256 = (data, idx) => { const v = u256(data, idx); return v >= (1n << 255n) ? v - (1n << 256n) : v; };

(async () => {
  let PAIR = POOL_ARG && !isZero(POOL_ARG) ? POOL_ARG.toLowerCase() : null;
  let isV3 = RT.startsWith('v3');
  let quoteSym = RT === 'usdt' ? 'USDT' : 'BNB';
  let quoteAddr = RT === 'usdt' ? USDT : WBNB;

  if (!PAIR) {
    if (isV3) {
      const fee = BigInt(RT.split(':')[1] || 100);
      const pr = await race('eth_call', [{ to: V3F, data: '0x1698ee82' + pad(TOK).slice(2) + pad(WBNB).slice(2) + fee.toString(16).padStart(64, '0') }, 'latest']);
      PAIR = '0x' + pr.slice(26);
    } else {
      const [pBnb, pUsdt] = await Promise.all([
        race('eth_call', [{ to: V2F, data: '0xe6a43905' + pad(TOK).slice(2) + pad(WBNB).slice(2) }, 'latest']).then(r => '0x' + r.slice(26)).catch(() => null),
        race('eth_call', [{ to: V2F, data: '0xe6a43905' + pad(TOK).slice(2) + pad(USDT).slice(2) }, 'latest']).then(r => '0x' + r.slice(26)).catch(() => null)
      ]);
      if (RT === 'usdt' && !isZero(pUsdt)) { PAIR = pUsdt; quoteSym = 'USDT'; quoteAddr = USDT; }
      else if (!isZero(pBnb)) { PAIR = pBnb; quoteSym = 'BNB'; quoteAddr = WBNB; }
      else if (!isZero(pUsdt)) { PAIR = pUsdt; quoteSym = 'USDT'; quoteAddr = USDT; }
      else {
        for (const fee of [100n, 500n, 2500n]) {
          const pr = await race('eth_call', [{ to: V3F, data: '0x1698ee82' + pad(TOK).slice(2) + pad(WBNB).slice(2) + fee.toString(16).padStart(64, '0') }, 'latest']).catch(() => null);
          if (pr && !isZero('0x' + pr.slice(26))) { PAIR = '0x' + pr.slice(26); isV3 = true; break; }
        }
      }
    }
  }
  if (isZero(PAIR)) { console.log('未找到对应池子'); process.exit(0); }

  const latest = parseInt(await race('eth_blockNumber', []), 16);
  const from = Math.max(parseInt(SB || '0', 10) - 2, latest - 40000);
  const [t0Raw, t1Raw] = await Promise.all([
    race('eth_call', [{ to: PAIR, data: '0x0dfe1681' }, 'latest']),
    race('eth_call', [{ to: PAIR, data: '0xd21220a7' }, 'latest'])
  ]);
  const t0 = ('0x' + t0Raw.slice(26)).toLowerCase();
  const t1 = ('0x' + t1Raw.slice(26)).toLowerCase();
  if (t0 === USDT || t1 === USDT) { quoteSym = 'USDT'; quoteAddr = USDT; }
  const QIS0 = t0 === quoteAddr;

  const mintTopic = isV3 ? topic('Mint(address,address,int24,int24,uint128,uint256,uint256)') : topic('Mint(address,uint256,uint256)');
  let mint = [];
  for (let a = from; a <= latest && !mint.length; a += 2000) {
    mint = await race('eth_getLogs', [{ address: PAIR, fromBlock: hx(a), toBlock: hx(Math.min(a + 1999, latest)), topics: [mintTopic] }]);
  }
  if (!mint.length) { console.log('未找到开池(LP Mint)事件，池', PAIR); process.exit(0); }

  const ob = parseInt(mint[0].blockNumber, 16);
  const obb = await race('eth_getBlockByNumber', [mint[0].blockNumber, false]);
  console.log('=== 战报 币', TOK, isV3 ? 'V3池' : 'V2池', PAIR, '计价', quoteSym, '===');
  console.log('开池块', ob, '时间', fmt(msOf(obb)), '块内第', parseInt(mint[0].transactionIndex, 16) + '/' + obb.transactions.length, '笔');

  const xfer = topic('Transfer(address,address,uint256)');
  const swapV2 = topic('Swap(address,uint256,uint256,uint256,uint256,address)');
  const swapV3 = topic('Swap(address,address,int256,int256,uint160,uint128,int24,uint128,uint128)');
  const rows = [];

  for (const k of ACC) {
    const addr = '0x' + WCFG.accounts[k];
    const logs = await race('eth_getLogs', [{ address: TOK, fromBlock: hx(ob - 2), toBlock: hx(Math.min(latest, ob + 400)), topics: [xfer, pad(addr)] }]);
    const seen = new Set();
    for (const l of logs) {
      if (seen.has(l.transactionHash)) continue;
      seen.add(l.transactionHash);
      const [rc, tx, b] = await Promise.all([
        race('eth_getTransactionReceipt', [l.transactionHash]),
        race('eth_getTransactionByHash', [l.transactionHash]),
        race('eth_getBlockByNumber', [l.blockNumber, false])
      ]);
      let out = 0n;
      for (const rl of rc.logs) {
        if (rl.address.toLowerCase() !== PAIR) continue;
        if (!isV3 && rl.topics[0] === swapV2) {
          out += QIS0 ? u256(rl.data, 2) : u256(rl.data, 3);
        } else if (isV3 && rl.topics[0] === swapV3) {
          const v = QIS0 ? i256(rl.data, 0) : i256(rl.data, 1);
          if (v < 0n) out += -v;
        }
      }
      if (out === 0n) continue;
      const bn = parseInt(l.blockNumber, 16);
      const gp = Number(BigInt(rc.effectiveGasPrice || tx.gasPrice)) / 1e9;
      rows.push({ k, bn, t: fmt(msOf(b)), idx: parseInt(rc.transactionIndex, 16) + '/' + b.transactions.length, to: tx.to, gp, out: Number(out) / 1e18, tx: l.transactionHash });
    }
  }

  const bs2Addr = WCFG.contracts.bs2 ? '0x' + WCFG.contracts.bs2 : '';
  const bs3Addr = WCFG.contracts.bs3 ? '0x' + WCFG.contracts.bs3 : '';
  const chan = to => {
    to = (to || '').toLowerCase();
    if (to === '0xb300000b72deaeb607a12d5f54773d1c19c7028d') return '币安闪兑';
    if (to === '0x10ed43c718714eb63d5aa57b78b54704e256024e') return '薄饼V2';
    if (to === '0x13f4ea83d0bd40e75c8222255bc855a974568dd4') return '薄饼V3';
    if (bs2Addr && to === bs2Addr) return 'BS2合约';
    if (bs3Addr && to === bs3Addr) return 'BS3合约';
    return '其他 ' + to.slice(0, 10);
  };

  rows.sort((a, b) => a.bn - b.bn);
  let tot = 0;
  for (const r of rows) {
    tot += r.out;
    console.log('号' + r.k, '块', r.bn, '(开池+' + (r.bn - ob) + '块)', r.t, '块内', r.idx, chan(r.to), 'gas', r.gp.toFixed(3) + 'gwei', '池出', r.out.toFixed(6), quoteSym, r.tx);
  }
  console.log('合计池出', quoteSym, tot.toFixed(6), '（未扣 gas 与闪兑 0.5% 费）');
  process.exit(0);
})().catch(e => { console.log('report 出错', e.message); process.exit(1); });
