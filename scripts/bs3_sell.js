// 独立命令行触发 BS3.sol 合约（直连 PancakeSwap V3 池批量代卖）
// 用法：node scripts/bs3_sell.js <代币地址> <V3池地址> <账号如123> [--min wei] [--gwei 1 | --gm 4] [--gas 1000000] [--bs 0x合约] [--sim]
const { signTx } = require('../lib/sign');
const { loadWallets, loadPk, loadRpcs } = require('../lib/config');

const av = process.argv.slice(2);
if (av.length < 3 || !/^0x[0-9a-fA-F]{40}$/.test(av[0]) || !/^0x[0-9a-fA-F]{40}$/.test(av[1])) {
  console.log('用法: node scripts/bs3_sell.js <代币地址> <V3池地址> <账号如123> [--min wei] [--gwei 1 | --gm 4] [--gas 1000000] [--bs 0x合约] [--sim]');
  process.exit(1);
}
const opt = (k, d) => { const i = av.indexOf(k); return i >= 0 && av[i + 1] !== undefined ? av[i + 1] : d; };

const PK = loadPk();
const WCFG = loadWallets(true);
const RPCS = loadRpcs().http;

const BS3_RAW = (opt('--bs', '') || (WCFG.contracts.bs3 ? '0x' + WCFG.contracts.bs3 : '')).trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(BS3_RAW) || /^0x0+$/.test(BS3_RAW)) {
  console.log('未配置有效的 BS3 (V3) 合约地址：请先部署 BS3.sol，并填入 config/wallets.json 的 contracts.bs3 或通过 --bs 传入');
  process.exit(1);
}
const BS3 = BS3_RAW.toLowerCase();
const T = av[0].toLowerCase();
const P = av[1].toLowerCase();
const W = String(av[2]).split('').map(k => {
  if (!WCFG.accounts[k]) throw new Error(`config/wallets.json 中未找到账号 "${k}"`);
  return WCFG.accounts[k];
});

const MIN = BigInt(opt('--min', '0'));
const GM_ARG = opt('--gm', null);
const GWEI_ARG = opt('--gwei', GM_ARG === null ? '1' : null);
const GAS_ARG = opt('--gas', null);
const SIM = av.includes('--sim');

const h = v => BigInt(v).toString(16).padStart(64, '0');
const ad = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const ts = () => new Date(Date.now() + 8 * 36e5).toISOString().slice(11, 23);
const log = (...a) => console.log(ts(), ...a);

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
async function rpcAny(m, p) {
  for (const u of RPCS) {
    const j = await rpcU(u, m, p);
    if (j && (j.result !== undefined || j.error)) return j;
  }
  return {};
}

(async () => {
  // sell3(address,address,address[],uint256) selector = 0x483c231f
  const data = '0x483c231f' + ad(T) + ad(P) + h(0x80) + h(MIN) + h(W.length) + W.map(ad).join('');
  const sim = await rpcAny('eth_call', [{ from: PK.addr, to: BS3, data }, 'latest']);
  if (sim.error) { log('模拟失败', (sim.error.message || '').slice(0, 100)); process.exit(2); }
  const est = await rpcAny('eth_estimateGas', [{ from: PK.addr, to: BS3, data }]);
  log('模拟通过，估 gas', est.result ? parseInt(est.result, 16) : '(未知)');
  if (SIM) return;

  const gas = GAS_ARG ? BigInt(GAS_ARG) : (est.result ? (BigInt(parseInt(est.result, 16)) * 15n) / 10n : 1000000n);
  const [gpR, ncR, balR] = await Promise.all([
    rpcAny('eth_gasPrice', []),
    rpcAny('eth_getTransactionCount', [PK.addr, 'pending']),
    rpcAny('eth_getBalance', [PK.addr, 'latest'])
  ]);
  const base = BigInt(gpR.result || '0x2faf080');
  let gp = GWEI_ARG !== null ? BigInt(Math.round(parseFloat(GWEI_ARG) * 1e9)) : base * BigInt(GM_ARG);
  const nb = BigInt(balR.result || '0x0');
  if (nb > 0n) {
    const cap = (nb * 95n) / 100n / gas;
    if (cap > 0n && gp > cap) {
      log('gas 价按余额压顶', Number(gp) / 1e9, '→', Number(cap) / 1e9, 'gwei');
      gp = cap;
    }
  }
  const nonce = BigInt(ncR.result);
  const t0 = Date.now();
  const { raw, hash } = signTx({ nonce, gasPrice: gp, gas, to: BS3, data, value: 0n }, PK.pk);
  await Promise.all(RPCS.map(u => rpcU(u, 'eth_sendRawTransaction', [raw])));
  log('已发', hash, 'gas', Number(gp) / 1e9, 'gwei 签名+广播', Date.now() - t0 + 'ms');

  for (let i = 0; i < 80; i++) {
    const r = (await rpcAny('eth_getTransactionReceipt', [hash])).result;
    if (r) {
      log(r.status === '0x1' ? '✅ 卖成' : '❌ 失败', '块', parseInt(r.blockNumber, 16), '用时', Date.now() - t0 + 'ms');
      process.exit(r.status === '0x1' ? 0 : 1);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  log('未拿到回执', hash);
  process.exit(3);
})();
