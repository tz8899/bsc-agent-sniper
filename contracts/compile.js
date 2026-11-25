// 编译 BS.sol（V2 批量代卖）和 BS3.sol（V2+V3 批量代卖）→ build/bs.json & build/bs3.json
// 用法：npm install && npm run compile
const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');

const DIR = __dirname;
const OUT = path.resolve(DIR, '..', 'build');
fs.mkdirSync(OUT, { recursive: true });

function buildOne(file, contractName, outName) {
  const src = fs.readFileSync(path.join(DIR, file), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { [file]: { content: src } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['evm.bytecode.object', 'evm.deployedBytecode.object', 'abi'] } }
    }
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  let fatal = false;
  if (out.errors) {
    for (const e of out.errors) {
      console.log(e.formattedMessage);
      if (e.severity === 'error') fatal = true;
    }
  }
  if (fatal) process.exit(1);
  const c = out.contracts[file][contractName];
  const dest = path.join(OUT, outName);
  fs.writeFileSync(dest, JSON.stringify({ bin: c.evm.bytecode.object, rt: c.evm.deployedBytecode.object, abi: c.abi }, null, 2));
  console.log(`✅ ${file} (${contractName}) → ${path.relative(process.cwd(), dest)} | init=${c.evm.bytecode.object.length / 2}B runtime=${c.evm.deployedBytecode.object.length / 2}B`);
}

buildOne('BS.sol', 'BS', 'bs.json');
buildOne('BS3.sol', 'BS3', 'bs3.json');
