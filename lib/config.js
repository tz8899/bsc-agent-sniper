// 公共配置加载器：统一读取 wallets.json / pk.json / rpc_live.json
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_HTTP_RPCS = [
  'https://bsc.rpc.blxrbdn.com',
  'https://bsc.blockrazor.xyz',
  'https://bsc-rpc.publicnode.com',
  'https://rpc-bsc.48.club',
  'https://bsc.publicnode.com',
  'https://bsc-mainnet.public.blastapi.io',
  'https://bsc.mytokenpocket.vip'
];
const DEFAULT_WSS_RPCS = ['wss://bsc-rpc.publicnode.com'];

function resolveFile(envKey, relDefault) {
  const p = process.env[envKey] || path.join(ROOT, relDefault);
  return path.isAbsolute(p) ? p : path.resolve(ROOT, p);
}

function loadWallets(required = true) {
  const fp = resolveFile('PY_WALLETS', 'config/wallets.json');
  if (!fs.existsSync(fp)) {
    if (!required) return { accounts: {}, contracts: {}, baw: {} };
    throw new Error(`找不到钱包配置文件：${fp}\n请先复制 config/wallets.example.json 为 config/wallets.json 并填入你的钱包地址`);
  }
  const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const accounts = {};
  for (const [k, v] of Object.entries(j.accounts || {})) {
    if (v) accounts[String(k)] = String(v).toLowerCase().replace(/^0x/, '');
  }
  const contracts = {};
  for (const [k, v] of Object.entries(j.contracts || {})) {
    if (v && /^0x[0-9a-fA-F]{40}$/.test(String(v).trim())) {
      contracts[k] = String(v).trim().toLowerCase().replace(/^0x/, '');
    }
  }
  return { accounts, contracts, baw: j.baw || {} };
}

function loadPk() {
  const fp = resolveFile('PY_PK', 'config/pk.json');
  if (!fs.existsSync(fp)) {
    throw new Error(`找不到私钥文件：${fp}\n请先运行 node scripts/gen_pk.js 或复制 config/pk.example.json 为 config/pk.json`);
  }
  const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
  if (!j.pk || !/^(0x)?[0-9a-fA-F]{64}$/.test(j.pk)) {
    throw new Error(`私钥格式无效：请检查 ${fp} 中的 pk 字段（64 位十六进制）`);
  }
  const { privToAddr } = require('./sign');
  const pk = j.pk.replace(/^0x/, '').toLowerCase();
  const addr = (j.addr || privToAddr(pk)).toLowerCase();
  return { addr: addr.startsWith('0x') ? addr : '0x' + addr, pk };
}

function loadRpcs() {
  const fp = resolveFile('PY_RPC_LIVE', 'config/rpc_live.json');
  let live = { http: [], wss: [] };
  try { live = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch {}
  const http = [...new Set([...(live.http || []), ...DEFAULT_HTTP_RPCS].filter(Boolean))];
  const wss = [...new Set([process.env.WSS, ...(live.wss || []), ...DEFAULT_WSS_RPCS].filter(Boolean))];
  return { http, wss };
}

module.exports = { ROOT, DEFAULT_HTTP_RPCS, DEFAULT_WSS_RPCS, loadWallets, loadPk, loadRpcs };
