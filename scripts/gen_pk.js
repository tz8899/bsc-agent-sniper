// 生成新的 BSC 私钥钱包，用于 BS/BS3 合约触发或私钥直卖
// 用法：
//   node scripts/gen_pk.js           # 仅打印到终端
//   node scripts/gen_pk.js --write   # 写入 config/pk.json（权限 600，已有时不覆盖）
const fs = require('node:fs');
const path = require('node:path');
const { newKey, privToAddr } = require('../lib/sign');
const { ROOT } = require('../lib/config');

const pk = newKey();
const addr = privToAddr(pk);
const WRITE = process.argv.includes('--write');
const FORCE = process.argv.includes('--force');

if (WRITE) {
  const dest = path.join(ROOT, 'config', 'pk.json');
  if (fs.existsSync(dest) && !FORCE) {
    console.log(`已存在 ${dest}，为防止误覆盖已中止（如确需覆盖请加 --force）`);
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify({ addr, pk }, null, 2) + '\n', { mode: 0o600 });
  console.log(`✅ 已生成并写入 ${dest}（已设置 600 权限）`);
  console.log('地址:', addr);
  console.log('提醒：往该地址转入少量 BNB（例如 0.01 BNB）作 gas 即可，切勿存放大额资金。');
} else {
  console.log(JSON.stringify({ addr, pk }, null, 2));
}
