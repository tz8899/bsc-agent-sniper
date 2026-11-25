// 经 CREATE2 确定性部署器部署 BS（V2）或 BS3（V2+V3）批量代卖合约
// 用法：
//   node contracts/deploy.js v2           # 仅预演地址与估 gas（不发交易）
//   node contracts/deploy.js v2 go        # 正式上链部署 BS.sol
//   node contracts/deploy.js v3 go        # 正式上链部署 BS3.sol
// 可选参数：--salt 0x627301  自定义 CREATE2 盐值
const fs = require('node:fs');
const path = require('node:path');
const { signTx } = require('../lib/sign');
const { keccak256 } = require('../lib/keccak');
const { ROOT, loadWallets, loadPk, loadRpcs } = require('../lib/config');

const D = '0x4e59b44847b379578588920ca78fbf26c0b4956c'; // 标准 CREATE2 Deterministic Deployment Proxy
const av = process.argv.slice(2);
const mode = (av[0] || '').toLowerCase();
if (mode !== 'v2' && mode !== 'v3') {
  console.log('用法：node contracts/deploy.js <v2|v3> [go] [--salt 0x...]');
  process.exit(1);
}
const GO = av.includes('go');
const si = av.indexOf('--salt');
const SALT_VAL = si >= 0 && av[si + 1] ? BigInt(av[si + 1]) : (mode === 'v3' ? 0x627333n : 0x627332n);

const PK = loadPk();
const WCFG = loadWallets(false);
const RPCS = loadRpcs().http;

// 操作员白名单 = 私钥钱包 + wallets.json 中配置的所有业务钱包
const OPS = [...new Set([
  PK.addr.toLowerCase(),
  ...Object.values(WCFG.accounts).map(a => '0x' + a.toLowerCase().replace(/^0x/, ''))
])];

const h = v => BigInt(v).toString(16).padStart(64, '0');
const ad = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0');
const kh = x => keccak256(Buffer.from(x.replace(/^0x/, ''), 'hex'));

async function rpc(m, p) {
  let lastErr;
  for (const u of RPCS) {
    try {
      const r = await fetch(u, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'curl/8' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: m, params: p }),
        signal: AbortSignal.timeout(6000)
      });
      const j = await r.json();
      if (j && (j.result !== undefined || j.error)) return j;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('所有 RPC 均失败');
}

(async () => {
  const buildFile = path.join(ROOT, 'build', mode === 'v3' ? 'bs3.json' : 'bs.json');
  if (!fs.existsSync(buildFile)) {
    console.log(`找不到编译产物：${buildFile}\n请先执行 npm run compile`);
    process.exit(1);
  }
  const c = JSON.parse(fs.readFileSync(buildFile, 'utf8'));
  const init = c.bin + h(0x20) + h(OPS.length) + OPS.map(ad).join('');
  const salt = h(SALT_VAL);
  const addr = '0x' + kh('ff' + D.slice(2) + salt + kh(init)).slice(24);

  console.log('合约版本:', mode === 'v3' ? 'BS3 (V2 + V3)' : 'BS (V2)');
  console.log('部署钱包:', PK.addr);
  console.log('操作员白名单 (' + OPS.length + '个):', OPS.join(', '));
  console.log('预计算合约地址:', addr);

  const code = (await rpc('eth_getCode', [addr, 'latest'])).result;
  if (code && code.length > 2) {
    console.log('该地址已部署，字节码长度:', code.length / 2 - 1);
    return;
  }

  const data = '0x' + salt + init;
  const est = await rpc('eth_estimateGas', [{ from: PK.addr, to: D, data }]);
  if (est.error || !est.result) {
    console.log('估 gas 失败:', est.error || est);
    process.exit(1);
  }
  const gas = (BigInt(est.result) * 13n) / 10n;
  const gp = BigInt((await rpc('eth_gasPrice', [])).result || '0x2faf080');
  console.log('估 gas:', parseInt(est.result, 16), '上限:', Number(gas), '当前 gasPrice:', Number(gp) / 1e9, 'gwei 预计费用:', (Number(gas * gp) / 1e18).toFixed(6), 'BNB');

  if (!GO) {
    console.log('（仅预演未发交易；确认无误后在命令末尾加 go 正式部署）');
    return;
  }

  const nonce = BigInt((await rpc('eth_getTransactionCount', [PK.addr, 'pending'])).result);
  const { raw, hash } = signTx({ nonce, gasPrice: gp, gas, to: D, data, value: 0n }, PK.pk);
  console.log('广播交易:', hash);
  await Promise.all(RPCS.map(u => fetch(u, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'curl/8' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }),
    signal: AbortSignal.timeout(5000)
  }).catch(() => 0)));

  for (let i = 0; i < 60; i++) {
    const r = (await rpc('eth_getTransactionReceipt', [hash])).result;
    if (r) {
      console.log('status:', r.status, 'gasUsed:', parseInt(r.gasUsed, 16), '块:', parseInt(r.blockNumber, 16));
      break;
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  const deployed = ((await rpc('eth_getCode', [addr, 'latest'])).result || '').length / 2 - 1;
  console.log('链上字节码长度:', deployed);
  if (deployed > 0) {
    console.log(`\n✅ 部署完成！请把合约地址填入 config/wallets.json 的 contracts.${mode === 'v3' ? 'bs3' : 'bs2'}：\n   "${mode === 'v3' ? 'bs3' : 'bs2'}": "${addr}"`);
  }
})();
