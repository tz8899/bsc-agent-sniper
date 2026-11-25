// 独立命令行触发 BS.sol 合约（薄饼 V2 批量代卖）
// 用法：node scripts/bs_sell.js <代币地址> <账号如123> [--min wei] [--gwei 1 | --gm 4] [--gas 1000000] [--bs 0x合约] [--sim]
const { signTx } = require('../lib/sign');
const { keccak256 } = require('../lib/keccak');
const { loadWallets, loadPk, loadRpcs } = require('../lib/config');

const av = process.argv.slice(2);
if (av.length < 2 || !/^0x[0-9a-fA-F]{40}$/.test(av[0])) {
  console.log('用法: node scripts/bs_sell.js <代币地址> <账号如123> [--min wei] [--gwei 1 | --gm 4] [--gas 1000000] [--bs 0x合约] [--sim]');
  process.exit(1);
}
const opt = (k, d) => { const i = av.indexOf(k); return i >= 0 && av[i + 1] !== undefined ? av[i + 1] : d; };

const PK = loadPk();
const WCFG = loadWallets(true);
const RPCS = loadRpcs().http;

const BS_RAW = (opt('--bs', '') || (WCFG.contracts.bs2 ? '0x' + WCFG.contracts.bs2 : '')).trim();
if (!/^0x[0-9a-fA-F]{40}$/.test(BS_RAW) || /^0x0+$/.test(BS_RAW)) {
  console.log('未配置有效的 BS (V2) 合约地址：请先部署 BS.sol，并填入 config/wallets.json 的 contracts.bs2 或通过 --bs 传入');
  process.exit(1);
}
const BS = BS_RAW.toLowerCase();
const T = av[0].toLowerCase().replace(/^0x/, '');
const W = String(av[1]).split('').map(k => {
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
  const sel = keccak256(Buffer.from('sell(address,address[],uint256)')).slice(0, 8);
  const data = '0x' + sel + ad(T) + h(0x60) + h(MIN) + h(W.length) + W.map(ad).join('');

  const sim = await rpcAny('eth_call', [{ from: PK.addr, to: BS, data }, 'latest']);
  console.log(ts(), '模拟', sim.error ? ('失败 ' + sim.error.message) : '通过');
  const est = await rpcAny('eth_estimateGas', [{ from: PK.addr, to: BS, data }]);
  console.log(ts(), '估gas', est.result ? parseInt(est.result, 16) : (est.error && est.error.message));
  if (SIM || sim.error) return;

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
      console.log(ts(), 'gas 价按余额压顶', Number(gp) / 1e9, '→', Number(cap) / 1e9, 'gwei');
      gp = cap;
    }
  }
  const nonce = BigInt(ncR.result);
  const t0 = Date.now();
  const { raw, hash } = signTx({ nonce, gasPrice: gp, gas, to: BS, data, value: 0n }, PK.pk);
  await Promise.all(RPCS.map(u => rpcU(u, 'eth_sendRawTransaction', [raw])));
  console.log(ts(), '已发', hash, 'gas', Number(gp) / 1e9, 'gwei 签名+广播', Date.now() - t0, 'ms');

  for (let i = 0; i < 100; i++) {
    const r = (await rpcAny('eth_getTransactionReceipt', [hash])).result;
    if (r) {
      console.log(ts(), r.status === '0x1' ? '✅ 卖成' : '❌ 失败', '块', parseInt(r.blockNumber, 16), 'gasUsed', parseInt(r.gasUsed, 16), '用时', Date.now() - t0, 'ms');
      process.exit(r.status === '0x1' ? 0 : 1);
    }
    await new Promise(r => setTimeout(r, 150));
  }
  console.log(ts(), '未拿到回执', hash);
  process.exit(3);
})();
