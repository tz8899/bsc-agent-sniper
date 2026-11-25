// BSC 公共 RPC（HTTP + WSS）延迟 / 同步块高 / 并发限流体检脚本
// 用法：node scripts/rpc_health.mjs [--write]   （加 --write 会把通过列表写入 config/rpc_live.json）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const WRITE = process.argv.includes('--write');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const HTTP = [
  'https://bsc.blockrazor.xyz',
  'https://bsc.rpc.blxrbdn.com',
  'https://bsc.publicnode.com',
  'https://bsc-rpc.publicnode.com',
  'https://rpc-bsc.48.club',
  'https://bsc-mainnet.public.blastapi.io',
  'https://bsc.mytokenpocket.vip',
  'https://56.rpc.thirdweb.com',
  'https://bsc.meowrpc.com',
  'https://bsc.drpc.org',
  'https://1rpc.io/bnb',
  'https://api.zan.top/bsc-mainnet',
  'https://binance.llamarpc.com',
  'https://bsc-pokt.nodies.app',
  'https://bnb.api.onfinality.io/public',
  'https://bsc-dataseed1.defibit.io',
  'https://bsc-dataseed.binance.org'
];
const WSS = [
  'wss://bsc-rpc.publicnode.com',
  'wss://rpc-bsc.48.club/ws',
  'wss://bsc.drpc.org',
  'wss://bsc-mainnet.public.blastapi.io',
  'wss://bsc.meowrpc.com/ws'
];

// 官方 PancakeSwap V2 WBNB/USDT 交易对，用于验证 eth_call 可用性
const REF_PAIR = '0x16b9a82891338f9bA80E2D6970Fdda79D1eb0daE';

const post = async (u, m, p, ms = 3000) => {
  const t = Date.now();
  const r = await fetch(u, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'curl/8' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }),
    signal: AbortSignal.timeout(ms)
  });
  const j = await r.json();
  return { j, ms: Date.now() - t };
};

async function probe(u) {
  const lat = [];
  let ok = 0, rl = 0, callOk = false;
  for (let i = 0; i < 4; i++) {
    try {
      const { j, ms } = await post(u, 'eth_blockNumber', []);
      if (j.result) { ok++; lat.push(ms); }
      else if (j.error && (j.error.code === -32005 || /rate|limit/i.test(j.error.message || ''))) rl++;
    } catch {}
  }
  const burst = await Promise.all(Array.from({ length: 6 }, () =>
    post(u, 'eth_blockNumber', [], 3000)
      .then(x => x.j.result ? 1 : (x.j.error && /rate|limit/i.test(x.j.error.message || '') ? 'rl' : 0))
      .catch(() => 0)
  ));
  const burstOk = burst.filter(x => x === 1).length;
  const burstRl = burst.filter(x => x === 'rl').length;
  try {
    const { j } = await post(u, 'eth_call', [{ to: REF_PAIR, data: '0x0902f1ac' }, 'latest']);
    callOk = !!(j.result && j.result.length >= 66);
  } catch {}
  lat.sort((a, b) => a - b);
  return { u, ok, rl: rl + burstRl, burstOk, callOk, bn: 0, med: lat.length ? lat[Math.floor(lat.length / 2)] : 99999 };
}

const wsTest = u => new Promise(res => {
  if (typeof WebSocket === 'undefined') return res({ u, ok: false });
  const t0 = Date.now();
  let n = 0, first = 0, done = false;
  let w;
  const fin = v => { if (!done) { done = true; try { w && w.close(); } catch {} res(v); } };
  try { w = new WebSocket(u); } catch { return res({ u, ok: false }); }
  w.onopen = () => w.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_subscribe', params: ['newHeads'] }));
  w.onmessage = e => {
    try {
      const j = JSON.parse(e.data);
      if (j.params) {
        n++;
        if (!first) first = Date.now() - t0;
        if (n >= 3) fin({ u, ok: true, first, span: Date.now() - t0 });
      }
    } catch {}
  };
  w.onerror = () => fin({ u, ok: false });
  setTimeout(() => fin({ u, ok: n >= 2, first, span: Date.now() - t0 }), 4500);
});

(async () => {
  const rs = await Promise.all([...new Set(HTTP)].map(probe));
  // 延迟测完后同步采样块高，消除串行结束时间差导致的误判
  await Promise.all(rs.filter(r => r.ok >= 3 && r.callOk).map(async r => {
    try { const { j } = await post(r.u, 'eth_blockNumber', [], 2000); if (j.result) r.bn = parseInt(j.result, 16); } catch {}
  }));
  const top = Math.max(0, ...rs.map(r => r.bn));
  const good = rs.filter(r => r.ok >= 3 && r.callOk && r.bn > 0 && top - r.bn <= 3 && r.burstOk >= 4).sort((a, b) => a.med - b.med);

  console.log('=== HTTP（同步块高比对，通过=ok≥3/4 + call✓ + 落后≤3块 + 突发≥4/6）===');
  for (const r of rs.sort((a, b) => a.med - b.med)) {
    console.log(
      good.includes(r) ? 'PASS' : 'FAIL',
      String(r.med === 99999 ? '-' : r.med).padStart(5) + 'ms',
      'ok' + r.ok + '/4',
      '突发' + r.burstOk + '/6',
      '限流' + r.rl,
      r.callOk ? 'call✓' : 'call✗',
      '落后' + (r.bn ? top - r.bn : '-'),
      r.u
    );
  }
  const ws = (await Promise.all(WSS.map(wsTest))).filter(x => x.ok).sort((a, b) => a.first - b.first);
  console.log('=== WSS（支持 newHeads 订阅）===');
  for (const x of ws) console.log('PASS 首块', x.first + 'ms', x.u);

  const live = { ts: Date.now(), http: good.map(r => r.u), wss: ws.map(x => x.u) };
  if (WRITE && live.http.length >= 2) {
    const outPath = path.join(ROOT, 'config', 'rpc_live.json');
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(live, null, 2) + '\n');
    console.log(`已写入 ${outPath}（HTTP ${live.http.length} 个，WSS ${live.wss.length} 个）`);
  }
  process.exit(0);
})();
