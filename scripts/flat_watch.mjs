#!/usr/bin/env node
/**
 * flat_watch.mjs (V2) — BSC 平开盘链上实时强弱监控 + 60 秒自动打分告警 + 多钱包/右侧追多联动引擎
 *
 * 完整覆盖两大打法：
 *   1) 平盘打法一 (--mode play1，打新 + 开盘不秒卖监控拿利润):
 *      - 走强继续拿: 前 10s 砸不破 0.85x + 60s 内净流入 > +1.5 BNB + 出现 >= 0.8 BNB 主动大买单
 *      - 走弱立刻跑: 前 30s 净流出超底池 10% 或 砸破 0.80x -> 全部持仓号立刻止损清仓
 *      - 分批止盈:
 *          * 多号模式 (--wallets all 或 1,2,3): 1.5x 先卖第 1 个号保本 -> 2.5x 卖第 2 个号 -> 余号博 3.5x 或高点回撤 15% 移动止盈
 *          * 单号模式 (--wallets 1 或 pkw):     1.5x 先卖 50% 保本 -> 余仓高点回撤 15% 移动止盈博 2.5x~3.5x
 *   2) 打法二 (--mode play2，二级右侧追多):
 *      - 开盘 15~90s 内确认「底池 >= 10 BNB + 砸不破 0.90x + 净流入 > +1.5 BNB + 出现 >= 1.0 BNB 主动大买单
 *        + 独立大买方 >= 2(防单号诱多，可调) + 现价在 1.05x~1.20x + 买入预检无回滚」-> 毫秒市价买入 (pkw 多节点广播 / baw)
 *      - 进场后自动挂 -15% 止损 + 浮盈 +60% 先出一半保本 + 高点回撤 15% 移动止盈
 *   3) 纯监控打分告警 (--mode monitor，默认):
 *      - 60 秒综合强弱评分 (0~100, STRONG/WATCH/WEAK)、大单买/卖比、净流入、独立大买方数、
 *        到达 1.5x / 2.0x / 2.5x / 3.0x / 3.5x 响铃 + 文字告警 + Webhook 推送 + alerts.jsonl 落盘
 *
 * 安全红线：
 *   - 默认不下单；必须显式传 --arm 才执行链上交易
 *   - 卖出仅精确 approve 当次数量（不无限授权）；加 --revoke-after 清仓后自动 approve(0) 撤权
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { ROOT, loadWallets, loadPk, loadRpcs } = require("../lib/config.js");

let ethers;
try {
  ({ ethers } = require("ethers"));
} catch {
  ({ ethers } = require(path.join(ROOT, "lib", "ethers.cjs")));
}

// ------------------------------------------------------------ CLI Parsing
const argv = process.argv.slice(2).map((s) => s.trim());
const hasFlag = (k) => argv.includes(k);
const getOpt = (k, def = null) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};

if (hasFlag("--help") || hasFlag("-h") || !getOpt("--token")) {
  console.log(`用法: node scripts/flat_watch.mjs --token <ERC20地址> [选项]

基础参数:
  --pair <地址>              指定 PancakeV2 Pair 地址（默认自动查 Token/WBNB）
  --cost-bnb <数>            单份铸造成本 BNB（配合 --tokens 计算 1.00x 基准价）
  --tokens <数>              单份代币枚数（人类单位，如 14000000）
  --ref-bnb <数>             直接指定 1 枚代币基准 BNB 价（不传则自动锁开盘首价为 1.00x）
  --mode <monitor|play1|play2>  运行模式，默认 monitor
  --arm                      实盘开关（不加仅演练告警，绝不发单）
  --wallets <csv>            执行钱包列表：pkw / wallets.json 键名(如 1,2,3) / all，默认 pkw
  --wallet <name>            --wallets 的单钱包别名
  --buy-bnb <数>             play2 右侧追多买入 BNB（默认 0.05，硬上限 0.5 BNB）
  --min-lp-bnb <数>          play2 追多最低底池 BNB（默认 10）
  --min-big-buyers <数>      play2 至少需要几个独立大买方地址（默认 2，防单号诱多；设 1 关闭）

策略阈值:
  --min-hold-10s <数>        play1 前 10s 支撑线，默认 0.85
  --min-hold-p2 <数>         play2 支撑线，默认 0.90
  --stop-x <数>              play1 跌破止损线，默认 0.80
  --stop-outflow-pct <数>    前 30s 净流出超池子比例止损(%)，默认 10
  --inflow-bnb <数>          60s 净流入转正阈值(BNB)，默认 1.5
  --big-buy-p1 <数>          play1 主动大买单阈值(BNB)，默认 0.8
  --big-buy-p2 <数>          play2 主动大买单阈值(BNB)，默认 1.0
  --entry-min-x <数>         play2 追多最低倍数，默认 1.05
  --entry-max-x <数>         play2 追多最高倍数，默认 1.20
  --tp-levels <csv>          止盈告警/分批档位，默认 1.5,2.0,2.5,3.0,3.5
  --trail-pct <数>           高点回撤移动止盈(%)，默认 15
  --slippage <数>            交易滑点(%)，默认 15
  --gwei <数>                pkw Gas Price (gwei)，默认 1.2
  --duration <秒>            自动退出时长（0=持续运行），默认 660 (11分钟)
  --webhook <url>            告警 Webhook（支持 Telegram/Discord/飞书/Bark/自定义 POST）
  --revoke-after             清仓后自动 approve(0) 撤销 Router 授权
  --log-dir <目录>           日志目录，默认 ./logs`);
  process.exit(hasFlag("--help") || hasFlag("-h") ? 0 : 1);
}

// Load BAW profiles dynamically from config/wallets.json (zero hardcoded personal addresses)
const WCFG = loadWallets(false);
const BAW_CFG = WCFG.baw || {};
const BAW_BASE = path.resolve(ROOT, process.env.BAW_DIR || BAW_CFG.dir || "./baw");
const BAW_PROFILES = {};
for (const [k, rawAddr] of Object.entries(WCFG.accounts || {})) {
  const ov = (BAW_CFG.overrides && BAW_CFG.overrides[k]) || {};
  const accDir = ov.dir ? path.resolve(ROOT, ov.dir) : path.join(BAW_BASE, `acc${k}`);
  BAW_PROFILES[String(k).toLowerCase()] = {
    key: String(k),
    dir: accDir,
    home: ov.home ? path.resolve(ROOT, ov.home) : null,
    wid: `fw_${k}`,
    address: ethers.getAddress(rawAddr.startsWith("0x") ? rawAddr : "0x" + rawAddr),
  };
}

const rawWallets = getOpt("--wallets", getOpt("--wallet", "pkw")).toLowerCase();
const walletList = rawWallets === "all"
  ? Object.keys(BAW_PROFILES)
  : rawWallets.split(",").map((s) => s.trim()).filter(Boolean);

const CFG = {
  token: ethers.getAddress(getOpt("--token")),
  pair: getOpt("--pair") ? ethers.getAddress(getOpt("--pair")) : null,
  costBnb: getOpt("--cost-bnb") ? Number(getOpt("--cost-bnb")) : null,
  refTokens: getOpt("--tokens") ? Number(getOpt("--tokens")) : null,
  refBnbDirect: getOpt("--ref-bnb") ? Number(getOpt("--ref-bnb")) : null,
  mode: getOpt("--mode", "monitor").toLowerCase(),
  arm: hasFlag("--arm"),
  wallets: walletList,
  buyBnb: Math.min(0.5, Math.max(0.001, Number(getOpt("--buy-bnb", "0.05")))),
  minLpBnb: Number(getOpt("--min-lp-bnb", "10")),
  minBigBuyers: Math.max(1, Number(getOpt("--min-big-buyers", "2"))),
  minHold10s: Number(getOpt("--min-hold-10s", "0.85")),
  minHoldP2: Number(getOpt("--min-hold-p2", "0.90")),
  stopX: Number(getOpt("--stop-x", "0.80")),
  stopOutflowPct: Number(getOpt("--stop-outflow-pct", "10")),
  inflowBnb: Number(getOpt("--inflow-bnb", "1.5")),
  bigBuyP1: Number(getOpt("--big-buy-p1", "0.8")),
  bigBuyP2: Number(getOpt("--big-buy-p2", "1.0")),
  entryMinX: Number(getOpt("--entry-min-x", "1.05")),
  entryMaxX: Number(getOpt("--entry-max-x", "1.20")),
  tpLevels: getOpt("--tp-levels", "1.5,2.0,2.5,3.0,3.5").split(",").map(Number).filter((x) => x > 0).sort((a, b) => a - b),
  trailPct: Number(getOpt("--trail-pct", "15")),
  slippage: Number(getOpt("--slippage", "15")),
  gwei: Number(getOpt("--gwei", "1.2")),
  durationSec: Number(getOpt("--duration", "660")),
  webhook: getOpt("--webhook", process.env.FLAT_WATCH_WEBHOOK || null),
  revokeAfter: hasFlag("--revoke-after"),
  logDir: getOpt("--log-dir", path.join(ROOT, "logs")),
};

// ------------------------------------------------------------ Constants & RPC
const WBNB    = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT    = "0x55d398326f99059fF775485246999027B3197955";
const FACTORY = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const ROUTER  = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const SWAP_TOPIC = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");

const liveRpcs = loadRpcs();
const httpUrls = liveRpcs.http;
const wssUrls  = liveRpcs.wss;
const provider = new ethers.JsonRpcProvider(httpUrls[1] || httpUrls[0], 56, { staticNetwork: true });
const bcastProviders = httpUrls.slice(0, 3).map((u) => new ethers.JsonRpcProvider(u, 56, { staticNetwork: true }));

const factoryIface = new ethers.Interface(["function getPair(address,address) view returns (address)"]);
const erc20Iface = new ethers.Interface([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const pairIface = new ethers.Interface([
  "function token0() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)",
]);
const routerIface = new ethers.Interface([
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
  "function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);

// ------------------------------------------------------------ Time & Alerts
let clockOffsetMs = 0;
const chainNowMs = () => Date.now() + clockOffsetMs;
const bjTime = (ms = chainNowMs()) => new Date(ms + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 23) + " +08";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(CFG.logDir, { recursive: true });
let alertFile = null;

function log(msg) {
  console.log(`[${bjTime()}] ${msg}`);
}

async function emitAlert(type, title, detail = {}) {
  const payload = { at: bjTime(), type, title, ...detail };
  process.stdout.write("\x07");
  log(`🔔 ALERT [${type}] ${title} | ${JSON.stringify(detail)}`);
  if (alertFile) {
    try { fs.appendFileSync(alertFile, JSON.stringify(payload) + "\n"); } catch {}
  }
  if (CFG.webhook) {
    const text = `[flat_watch][${type}] ${title}\n${Object.entries(detail).map(([k, v]) => `${k}: ${v}`).join(" | ")}`;
    let bodyObj = { text, content: text, title: `[flat_watch] ${type}`, body: text, data: payload };
    if (CFG.webhook.includes("open.feishu.cn") || CFG.webhook.includes("open.larksuite.com")) {
      bodyObj = { msg_type: "text", content: { text } };
    } else if (CFG.webhook.includes("discord.com/api/webhooks")) {
      bodyObj = { content: text };
    }
    fetch(CFG.webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(bodyObj),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }
}

async function syncClock() {
  const blk = await provider.getBlock("latest");
  if (blk?.timestamp) clockOffsetMs = blk.timestamp * 1000 - Date.now();
  return blk;
}

// ------------------------------------------------------------ Trader (pkw / baw)
function loadPkwSigner() {
  const { pk } = loadPk();
  return new ethers.Wallet(pk.startsWith("0x") ? pk : "0x" + pk, provider);
}

function spawnBawWorker(prof) {
  const env = { ...process.env, BINANCE_BAW_DIR: prof.dir, WID: prof.wid };
  if (prof.home) env.HOME = prof.home;
  const child = spawn(process.execPath, [path.join(HERE, "bawworker.mjs")], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let seq = 1;
  const pending = new Map();
  let readyRes;
  const ready = new Promise((r) => (readyRes = r));
  const rl = readline.createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.ready) { readyRes(true); return; }
    const cb = pending.get(msg.id);
    if (cb) { pending.delete(msg.id); cb(msg); }
  });
  const call = (op, body, timeoutMs = 15000) => new Promise((resolve) => {
    const id = seq++;
    const timer = setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); resolve({ success: false, error: { message: "worker timeout" } }); }
    }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ id, op, body }) + "\n");
  });
  return { ready, call, kill: () => { try { child.kill(); } catch {} } };
}

class Trader {
  constructor(walletKind, tokenAddr, decimals) {
    this.kind = walletKind;
    this.tokenAddr = tokenAddr;
    this.decimals = decimals;
    this.pkw = null;
    this.baw = null;
    this.addr = null;
    this.busy = false;
    this.soldOut = false;
  }

  async init() {
    if (this.kind === "pkw") {
      this.pkw = loadPkwSigner();
      this.addr = this.pkw.address;
    } else if (BAW_PROFILES[this.kind]) {
      const prof = BAW_PROFILES[this.kind];
      this.addr = prof.address;
      if (CFG.arm) {
        this.baw = spawnBawWorker(prof);
        await this.baw.ready;
      }
    } else {
      throw new Error(`Unsupported wallet: ${this.kind} (check config/wallets.json or use pkw)`);
    }
    const [bnb, tok] = await Promise.all([
      provider.getBalance(this.addr),
      new ethers.Contract(this.tokenAddr, erc20Iface, provider).balanceOf(this.addr),
    ]);
    log(`[trader] ${this.kind} (${this.addr}) | BNB=${ethers.formatEther(bnb)} | TOK=${ethers.formatUnits(tok, this.decimals)} | ARM=${CFG.arm}`);
  }

  async sendTx(to, data, valueWei = 0n, gasLimit = 450000n) {
    if (!CFG.arm) {
      log(`[trader:${this.kind} DRY-RUN] would send to=${to} val=${ethers.formatEther(valueWei)} BNB sel=${data.slice(0, 10)}`);
      return { dryRun: true, txHash: "0xDRYRUN" };
    }
    if (this.kind === "pkw") {
      const nonce = await provider.getTransactionCount(this.addr, "pending");
      const gasPrice = ethers.parseUnits(String(CFG.gwei), "gwei");
      const signed = await this.pkw.signTransaction({
        chainId: 56,
        nonce,
        gasPrice,
        gasLimit,
        to,
        value: valueWei,
        data,
      });
      const txHash = ethers.keccak256(signed);
      await Promise.any(bcastProviders.map((p) => p.broadcastTransaction(signed))).catch(() => {});
      log(`[trader:pkw] SENT tx=${txHash}`);
      const rcpt = await provider.waitForTransaction(txHash, 1, 35000);
      return { ok: rcpt?.status === 1, txHash, rcpt };
    } else {
      const prev = await this.baw.call("preview", {
        binanceChainId: "56",
        from: this.addr,
        to,
        value: valueWei.toString(),
        inputData: data,
      }, 12000);
      if (!prev.success || !prev.data?.requestId) {
        throw new Error("baw preview fail: " + JSON.stringify(prev.error || prev).slice(0, 140));
      }
      const ex = await this.baw.call("execute", { requestId: prev.data.requestId }, 18000);
      const txHash = ex.data?.txHash || ex.data?.transactionHash || ex.data?.hash;
      if (!ex.success || !txHash) throw new Error("baw exec fail: " + JSON.stringify(ex.error || ex).slice(0, 140));
      log(`[trader:${this.kind}] SENT tx=${txHash}`);
      const rcpt = await provider.waitForTransaction(txHash, 1, 35000);
      return { ok: rcpt?.status === 1, txHash, rcpt };
    }
  }

  async ensureApprove(amountWei) {
    const tok = new ethers.Contract(this.tokenAddr, erc20Iface, provider);
    const cur = await tok.allowance(this.addr, ROUTER);
    if (cur >= amountWei) return;
    const data = erc20Iface.encodeFunctionData("approve", [ROUTER, amountWei]);
    log(`[trader:${this.kind}] Approving exact ${ethers.formatUnits(amountWei, this.decimals)} tokens to Router...`);
    const r = await this.sendTx(this.tokenAddr, data, 0n, 100000n);
    if (!r.dryRun && !r.ok) throw new Error("Approve tx reverted");
  }

  async revokeApprove() {
    const tok = new ethers.Contract(this.tokenAddr, erc20Iface, provider);
    const cur = await tok.allowance(this.addr, ROUTER);
    if (cur === 0n) return;
    const data = erc20Iface.encodeFunctionData("approve", [ROUTER, 0n]);
    log(`[trader:${this.kind}] Revoking Router allowance -> 0...`);
    await this.sendTx(this.tokenAddr, data, 0n, 100000n);
  }

  async buyWithBnb(bnbAmount) {
    if (this.busy) return null;
    this.busy = true;
    try {
      const valueWei = ethers.parseEther(String(bnbAmount));
      const router = new ethers.Contract(ROUTER, routerIface, provider);
      const out = await router.getAmountsOut(valueWei, [WBNB, this.tokenAddr]);
      const minOut = (out[1] * BigInt(Math.max(1, 100 - CFG.slippage))) / 100n;
      const dl = BigInt(Math.floor(chainNowMs() / 1000) + 120);
      const data = routerIface.encodeFunctionData("swapExactETHForTokensSupportingFeeOnTransferTokens", [
        minOut,
        [WBNB, this.tokenAddr],
        this.addr,
        dl,
      ]);
      if (CFG.arm) {
        try {
          await provider.call({ from: this.addr, to: ROUTER, value: valueWei, data });
        } catch (e) {
          throw new Error("Buy preflight eth_call REVERTED (possible honeypot/maxTx): " + (e.shortMessage || e.message).slice(0, 120));
        }
      }
      log(`[trader:${this.kind}] BUY ${bnbAmount} BNB -> est ${ethers.formatUnits(out[1], this.decimals)} tok (minOut ${ethers.formatUnits(minOut, this.decimals)})`);
      return await this.sendTx(ROUTER, data, valueWei, 450000n);
    } finally {
      this.busy = false;
    }
  }

  async sellFraction(pct = 100) {
    if (this.busy || this.soldOut) return null;
    this.busy = true;
    try {
      const tok = new ethers.Contract(this.tokenAddr, erc20Iface, provider);
      const bal = await tok.balanceOf(this.addr);
      if (bal === 0n) {
        log(`[trader:${this.kind}] SELL skipped: token balance = 0`);
        return null;
      }
      const sellAmt = pct >= 100 ? bal : (bal * BigInt(Math.floor(pct))) / 100n;
      if (sellAmt === 0n) return null;
      await this.ensureApprove(sellAmt);
      const router = new ethers.Contract(ROUTER, routerIface, provider);
      const out = await router.getAmountsOut(sellAmt, [this.tokenAddr, WBNB]);
      const minBnb = (out[1] * BigInt(Math.max(1, 100 - CFG.slippage))) / 100n;
      const dl = BigInt(Math.floor(chainNowMs() / 1000) + 120);
      const data = routerIface.encodeFunctionData("swapExactTokensForETHSupportingFeeOnTransferTokens", [
        sellAmt,
        minBnb,
        [this.tokenAddr, WBNB],
        this.addr,
        dl,
      ]);
      log(`[trader:${this.kind}] SELL ${pct}% (${ethers.formatUnits(sellAmt, this.decimals)} tok) -> est ${ethers.formatEther(out[1])} BNB`);
      const res = await this.sendTx(ROUTER, data, 0n, 450000n);
      if (pct >= 100 && (res.ok || res.dryRun)) {
        this.soldOut = true;
        if (CFG.revokeAfter && CFG.arm) {
          await this.revokeApprove().catch((e) => log(`[trader:${this.kind}] revoke err: ${e.message}`));
        }
      }
      return res;
    } finally {
      this.busy = false;
    }
  }

  close() {
    if (this.baw) this.baw.kill();
  }
}

// ------------------------------------------------------------ Scoring Engine
function computeScore(st, secSinceOpen) {
  let score = 0;
  const reasons = [];

  if (st.low10sX >= CFG.minHold10s) { score += 15; reasons.push(`10s稳>=${CFG.minHold10s}x`); }
  if (st.low60sX >= CFG.minHoldP2)  { score += 15; reasons.push(`60s稳>=${CFG.minHoldP2}x`); }

  if (st.netInflowBnb > 0) score += 10;
  if (st.netInflowBnb >= CFG.inflowBnb) { score += 20; reasons.push(`净流入+${st.netInflowBnb.toFixed(2)}BNB`); }

  if (st.maxSingleBuyBnb >= CFG.bigBuyP1) { score += 10; reasons.push(`大买>=${CFG.bigBuyP1}BNB`); }
  if (st.maxSingleBuyBnb >= CFG.bigBuyP2 && st.bigBuyers.size >= CFG.minBigBuyers) {
    score += 10;
    reasons.push(`强买>=${CFG.bigBuyP2}BNB(${st.bigBuyers.size}地址)`);
  } else if (st.maxSingleBuyBnb >= CFG.bigBuyP2) {
    score += 5;
    reasons.push(`单地址大买(防诱多)`);
  }
  const bigRatio = st.bigSellBnb > 0 ? st.bigBuyBnb / st.bigSellBnb : (st.bigBuyBnb > 0 ? 99 : 0);
  if (bigRatio >= 1.5 && st.bigBuyCount > 0) { score += 5; reasons.push(`大单比${bigRatio >= 99 ? "∞" : bigRatio.toFixed(1)}`); }

  const outflowPct = st.initPoolBnb > 0 ? (-st.netInflowBnb / st.initPoolBnb) * 100 : 0;
  if (outflowPct < CFG.stopOutflowPct) score += 10;
  if (st.currentX >= 1.0) score += 5;

  const grade = score >= 70 ? "STRONG" : score >= 45 ? "WATCH" : "WEAK";
  return { score, grade, bigRatio, outflowPct, reasons, secSinceOpen };
}

// ------------------------------------------------------------ Main
async function main() {
  const blk0 = await syncClock();
  const tokC = new ethers.Contract(CFG.token, erc20Iface, provider);
  const factoryC = new ethers.Contract(FACTORY, factoryIface, provider);
  const routerC = new ethers.Contract(ROUTER, routerIface, provider);

  const [symbol, decimals, bnbUsdtOut] = await Promise.all([
    tokC.symbol().catch(() => "TOK"),
    tokC.decimals().catch(() => 18),
    routerC.getAmountsOut(ethers.parseEther("1"), [WBNB, USDT]),
  ]);
  const dec = Number(decimals);
  const bnbUsd = Number(ethers.formatUnits(bnbUsdtOut[1], 18));

  let pairAddr = CFG.pair;
  if (!pairAddr) pairAddr = await factoryC.getPair(CFG.token, WBNB);
  if (!pairAddr || pairAddr === ethers.ZeroAddress) {
    log(`[wait] Pair (${symbol}/WBNB) not yet created on PancakeV2. Polling...`);
    while (!pairAddr || pairAddr === ethers.ZeroAddress) {
      await sleep(1500);
      pairAddr = await factoryC.getPair(CFG.token, WBNB).catch(() => ethers.ZeroAddress);
    }
    log(`[pair] Pair created: ${pairAddr}`);
  }

  alertFile = path.join(CFG.logDir, `flat_watch_${symbol.replace(/[^a-zA-Z0-9_-]/g, "")}_alerts.jsonl`);

  const pairC = new ethers.Contract(pairAddr, pairIface, provider);
  const token0 = await pairC.token0();
  const isTok0 = token0.toLowerCase() === CFG.token.toLowerCase();

  let refPriceBnb = CFG.refBnbDirect;
  if (!refPriceBnb && CFG.costBnb && CFG.refTokens) {
    refPriceBnb = CFG.costBnb / CFG.refTokens;
  }

  log(`====================================================================`);
  log(`FLAT_WATCH V2 | ${symbol} (${CFG.token}) | Pair=${pairAddr} | blk=${blk0.number} | BNB=$${bnbUsd.toFixed(2)}`);
  log(`  Mode=${CFG.mode} | ARM=${CFG.arm} | Wallets=[${CFG.wallets.join(",")}] | Ref1x=${refPriceBnb ? refPriceBnb.toExponential(4) + " BNB/tok" : "AUTO(开盘首价)"}`);
  log(`  Rules: 10s>=${CFG.minHold10s}x | P2>=${CFG.minHoldP2}x | Stop<${CFG.stopX}x or Outflow>${CFG.stopOutflowPct}% | Inflow>+${CFG.inflowBnb}BNB | BigBuy>=${CFG.bigBuyP1}/${CFG.bigBuyP2}BNB (独立地址>=${CFG.minBigBuyers}) | Entry=${CFG.entryMinX}~${CFG.entryMaxX}x | TP=[${CFG.tpLevels.join(",")}x] Trail=${CFG.trailPct}%`);
  log(`====================================================================`);

  const traders = [];
  if (CFG.mode !== "monitor") {
    for (const w of CFG.wallets) {
      const tr = new Trader(w, CFG.token, dec);
      await tr.init();
      traders.push(tr);
    }
  }

  let [r0, r1] = await pairC.getReserves();
  let rTok = Number(ethers.formatUnits(isTok0 ? r0 : r1, dec));
  let rBnb = Number(ethers.formatUnits(isTok0 ? r1 : r0, 18));

  const alreadyOpen = rTok > 0 && rBnb > 0;
  if (!alreadyOpen) {
    log(`[wait] Pool ${pairAddr} is PRE-OPEN (0 liquidity). Watching for open block...`);
    while (rTok <= 0 || rBnb <= 0) {
      await sleep(700);
      try {
        [r0, r1] = await pairC.getReserves();
        rTok = Number(ethers.formatUnits(isTok0 ? r0 : r1, dec));
        rBnb = Number(ethers.formatUnits(isTok0 ? r1 : r0, 18));
      } catch {}
    }
    await syncClock();
    log(`>>> POOL OPENED! LP=${rBnb.toFixed(4)} BNB ($${(rBnb * bnbUsd).toFixed(0)}) + ${rTok.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${symbol}`);
  } else {
    log(`[live] Pool ALREADY OPEN: LP=${rBnb.toFixed(4)} BNB ($${(rBnb * bnbUsd).toFixed(0)}) + ${rTok.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${symbol}`);
  }

  const initSpotBnb = rBnb / rTok;
  if (!refPriceBnb) {
    refPriceBnb = initSpotBnb;
    log(`[ref] Auto-locked 1.00x = ${refPriceBnb.toExponential(4)} BNB/${symbol} ($${(refPriceBnb * bnbUsd).toExponential(4)})`);
  }

  const openWallMs = Date.now();
  const initX = initSpotBnb / refPriceBnb;

  const st = {
    initPoolBnb: rBnb,
    rBnb,
    rTok,
    currentX: initX,
    low10sX: initX,
    low30sX: initX,
    low60sX: initX,
    highSinceOpenX: initX,
    buyCount: 0,
    sellCount: 0,
    buyBnb: 0,
    sellBnb: 0,
    netInflowBnb: 0,
    bigBuyCount: 0,
    bigBuyBnb: 0,
    bigSellCount: 0,
    bigSellBnb: 0,
    bigBuyers: new Set(),
    maxSingleBuyBnb: 0,
    maxSingleSellBnb: 0,
    swapsSeen: 0,
    alertedTp: new Set(),
    play1StrongSent: false,
    play1StopSent: false,
    play1Stage: 0,
    play2Entered: false,
    play2EntryX: null,
    play2HighX: 0,
    play2HalfSold: false,
    play2Exited: false,
  };

  await emitAlert("OPEN", `${symbol} 监控启动 (${alreadyOpen ? "已开盘" : "刚开盘"})`, {
    lpBnb: Number(rBnb.toFixed(3)),
    lpUsd: Math.round(rBnb * bnbUsd),
    initX: Number(initX.toFixed(3)),
  });

  // ------------------------------------------------------------ Signal & Execution Engine (serialized, race-free)
  let evalBusy = false;
  let evalPending = false;
  async function evaluateSignals() {
    if (evalBusy) { evalPending = true; return; }
    evalBusy = true;
    try {
      do {
        evalPending = false;
        await _evaluateSignalsCore();
      } while (evalPending && !stopping);
    } finally {
      evalBusy = false;
    }
  }

  async function _evaluateSignalsCore() {
    const sec = (Date.now() - openWallMs) / 1000;
    const sc = computeScore(st, sec);

    if (sec <= 10 && st.currentX < st.low10sX) st.low10sX = st.currentX;
    if (sec <= 30 && st.currentX < st.low30sX) st.low30sX = st.currentX;
    if (sec <= 60 && st.currentX < st.low60sX) st.low60sX = st.currentX;
    if (st.currentX > st.highSinceOpenX) st.highSinceOpenX = st.currentX;

    for (const lvl of CFG.tpLevels) {
      if (st.currentX >= lvl && !st.alertedTp.has(lvl)) {
        st.alertedTp.add(lvl);
        await emitAlert(`TP_${lvl}X`, `${symbol} 突破 ${lvl}x! 当前 ${st.currentX.toFixed(3)}x`, {
          score: sc.score,
          grade: sc.grade,
          netInflowBnb: Number(st.netInflowBnb.toFixed(3)),
          bigBuyers: st.bigBuyers.size,
          lpBnb: Number(st.rBnb.toFixed(3)),
          tSec: Number(sec.toFixed(1)),
        });
      }
    }

    if (
      !st.play1StrongSent &&
      sec >= 10 &&
      sec <= 90 &&
      st.low10sX >= CFG.minHold10s &&
      st.netInflowBnb >= CFG.inflowBnb &&
      st.maxSingleBuyBnb >= CFG.bigBuyP1
    ) {
      st.play1StrongSent = true;
      await emitAlert("PLAY1_HOLD_STRONG", `${symbol} 平盘走强确认！继续拿博 1.5x~3.5x`, {
        score: sc.score,
        curX: Number(st.currentX.toFixed(3)),
        low10sX: Number(st.low10sX.toFixed(3)),
        netInflowBnb: Number(st.netInflowBnb.toFixed(3)),
        maxBuyBnb: Number(st.maxSingleBuyBnb.toFixed(3)),
        bigBuyers: st.bigBuyers.size,
      });
    }

    const hitOutflowStop = sec <= 35 && sc.outflowPct >= CFG.stopOutflowPct;
    const hitPriceStop = st.currentX <= CFG.stopX;
    if (!st.play1StopSent && (hitOutflowStop || hitPriceStop)) {
      st.play1StopSent = true;
      await emitAlert("PLAY1_STOP_WEAK", `${symbol} 走弱立刻跑！(${hitPriceStop ? `砸破${CFG.stopX}x` : `前30s净流出${sc.outflowPct.toFixed(1)}%`})`, {
        score: sc.score,
        curX: Number(st.currentX.toFixed(3)),
        netInflowBnb: Number(st.netInflowBnb.toFixed(3)),
        outflowPct: Number(sc.outflowPct.toFixed(1)),
        tSec: Number(sec.toFixed(1)),
      });
      if (CFG.mode === "play1" && traders.length > 0 && st.play1Stage < 3) {
        st.play1Stage = 3;
        await Promise.all(traders.map((tr) => tr.sellFraction(100).catch((e) => log(`[play1 stop ${tr.kind} err] ${e.message}`))));
      }
    }

    if (CFG.mode === "play1" && traders.length > 0 && st.play1Stage < 3) {
      const tp1 = CFG.tpLevels[0] || 1.5;
      const tp2 = CFG.tpLevels.find((x) => x >= 2.5) || 2.5;
      const tp3 = CFG.tpLevels.find((x) => x >= 3.5) || 3.5;

      if (traders.length >= 2) {
        if (st.play1Stage === 0 && st.currentX >= tp1) {
          st.play1Stage = 1;
          await emitAlert("PLAY1_TP_WALLET1", `${symbol} 达 ${tp1}x，先出第 1 个号 (${traders[0].kind}) 保本`, { curX: Number(st.currentX.toFixed(3)) });
          await traders[0].sellFraction(100).catch((e) => log(`[play1 tp1 err] ${e.message}`));
        }
        if (st.play1Stage === 1 && traders.length >= 3 && st.currentX >= tp2) {
          st.play1Stage = 2;
          await emitAlert("PLAY1_TP_WALLET2", `${symbol} 达 ${tp2}x，出第 2 个号 (${traders[1].kind}) 锁利`, { curX: Number(st.currentX.toFixed(3)) });
          await traders[1].sellFraction(100).catch((e) => log(`[play1 tp2 err] ${e.message}`));
        }
        if (st.play1Stage >= 1) {
          const dropPct = ((st.highSinceOpenX - st.currentX) / st.highSinceOpenX) * 100;
          if (st.currentX >= tp3 || (st.highSinceOpenX >= tp1 && dropPct >= CFG.trailPct)) {
            st.play1Stage = 3;
            const why = st.currentX >= tp3 ? `达终极目标 ${tp3}x` : `从高点 ${st.highSinceOpenX.toFixed(2)}x 回撤 ${dropPct.toFixed(1)}%`;
            await emitAlert("PLAY1_EXIT_REST", `${symbol} ${why}，清仓剩余钱包`, { curX: Number(st.currentX.toFixed(3)) });
            await Promise.all(traders.filter((t) => !t.soldOut).map((tr) => tr.sellFraction(100).catch((e) => log(`[play1 exit ${tr.kind} err] ${e.message}`))));
          }
        }
      } else {
        const tr = traders[0];
        if (st.play1Stage === 0 && st.currentX >= tp1) {
          st.play1Stage = 1;
          await emitAlert("PLAY1_TP_HALF", `${symbol} 达 ${tp1}x，先卖 50% 保本 (${tr.kind})`, { curX: Number(st.currentX.toFixed(3)) });
          await tr.sellFraction(50).catch((e) => log(`[play1 half err] ${e.message}`));
        }
        if (st.play1Stage === 1 && st.highSinceOpenX >= tp1) {
          const dropPct = ((st.highSinceOpenX - st.currentX) / st.highSinceOpenX) * 100;
          if (st.currentX >= tp3 || dropPct >= CFG.trailPct) {
            st.play1Stage = 3;
            await emitAlert("PLAY1_TRAIL_EXIT", `${symbol} 高点 ${st.highSinceOpenX.toFixed(2)}x 回撤 ${dropPct.toFixed(1)}%，清仓余仓`, { curX: Number(st.currentX.toFixed(3)) });
            await tr.sellFraction(100).catch((e) => log(`[play1 trail err] ${e.message}`));
          }
        }
      }
    }

    if (
      !st.play2Entered &&
      sec >= 15 &&
      sec <= 90 &&
      st.rBnb >= CFG.minLpBnb &&
      st.low60sX >= CFG.minHoldP2 &&
      st.netInflowBnb >= CFG.inflowBnb &&
      st.maxSingleBuyBnb >= CFG.bigBuyP2 &&
      st.bigBuyers.size >= CFG.minBigBuyers &&
      st.currentX >= CFG.entryMinX &&
      st.currentX <= CFG.entryMaxX
    ) {
      st.play2Entered = true;
      st.play2EntryX = st.currentX;
      st.play2HighX = st.currentX;
      await emitAlert("PLAY2_ENTRY_LONG", `${symbol} 二级右侧追多确认！现价 ${st.currentX.toFixed(3)}x`, {
        score: sc.score,
        lpBnb: Number(st.rBnb.toFixed(2)),
        low60sX: Number(st.low60sX.toFixed(3)),
        netInflowBnb: Number(st.netInflowBnb.toFixed(3)),
        maxBuyBnb: Number(st.maxSingleBuyBnb.toFixed(3)),
        distinctBigBuyers: st.bigBuyers.size,
        buyBnb: CFG.buyBnb,
        armed: CFG.arm,
      });
      if (CFG.mode === "play2" && traders.length > 0) {
        try {
          const r = await traders[0].buyWithBnb(CFG.buyBnb);
          if (r && !r.dryRun && !r.ok) {
            log(`[play2] Buy tx reverted; resetting entry latch`);
            st.play2Entered = false;
          }
        } catch (e) {
          log(`[play2 buy blocked/err] ${e.message}`);
          st.play2Entered = false;
        }
      }
    }

    if (CFG.mode === "play2" && traders.length > 0 && st.play2Entered && !st.play2Exited && st.play2EntryX) {
      const tr = traders[0];
      if (st.currentX > st.play2HighX) st.play2HighX = st.currentX;
      const relX = st.currentX / st.play2EntryX;
      const relHighX = st.play2HighX / st.play2EntryX;
      if (relX <= 0.85) {
        st.play2Exited = true;
        await emitAlert("PLAY2_STOP", `${symbol} 右侧追多触发 -15% 硬止损清仓`, {
          entryX: Number(st.play2EntryX.toFixed(3)),
          curX: Number(st.currentX.toFixed(3)),
        });
        await tr.sellFraction(100).catch((e) => log(`[play2 stop err] ${e.message}`));
      } else if (!st.play2HalfSold && relX >= 1.6) {
        st.play2HalfSold = true;
        await emitAlert("PLAY2_TP_HALF", `${symbol} 右侧追多浮盈 +60%，先出一半保本`, {
          entryX: Number(st.play2EntryX.toFixed(3)),
          curX: Number(st.currentX.toFixed(3)),
        });
        await tr.sellFraction(50).catch((e) => log(`[play2 half err] ${e.message}`));
      } else if (st.play2HalfSold) {
        const dropPct = ((relHighX - relX) / relHighX) * 100;
        if (dropPct >= CFG.trailPct) {
          st.play2Exited = true;
          await emitAlert("PLAY2_TRAIL_EXIT", `${symbol} 右侧追多高点回撤 ${dropPct.toFixed(1)}%，清仓`, {
            highX: Number(st.play2HighX.toFixed(3)),
            curX: Number(st.currentX.toFixed(3)),
          });
          await tr.sellFraction(100).catch((e) => log(`[play2 trail err] ${e.message}`));
        }
      }
    }
  }

  // ------------------------------------------------------------ Live Swap Stream (WSS + HTTP block fallback)
  const seenLogKeys = new Set();
  async function handleSwapLog(lg) {
    const key = `${lg.transactionHash}:${lg.index ?? lg.logIndex ?? 0}`;
    if (seenLogKeys.has(key)) return;
    seenLogKeys.add(key);

    let parsed;
    try { parsed = pairIface.parseLog(lg); } catch { return; }
    if (!parsed || parsed.name !== "Swap") return;

    const a0In  = Number(ethers.formatUnits(parsed.args.amount0In, isTok0 ? dec : 18));
    const a1In  = Number(ethers.formatUnits(parsed.args.amount1In, isTok0 ? 18 : dec));
    const a0Out = Number(ethers.formatUnits(parsed.args.amount0Out, isTok0 ? dec : 18));
    const a1Out = Number(ethers.formatUnits(parsed.args.amount1Out, isTok0 ? 18 : dec));
    const toAddr = String(parsed.args.to || "").toLowerCase();

    const tokIn  = isTok0 ? a0In  : a1In;
    const bnbIn  = isTok0 ? a1In  : a0In;
    const tokOut = isTok0 ? a0Out : a1Out;
    const bnbOut = isTok0 ? a1Out : a0Out;

    st.swapsSeen++;
    const sec = ((Date.now() - openWallMs) / 1000).toFixed(1);

    if (bnbIn > 0 && tokOut > 0) {
      st.buyCount++;
      st.buyBnb += bnbIn;
      st.netInflowBnb += bnbIn;
      if (bnbIn > st.maxSingleBuyBnb) st.maxSingleBuyBnb = bnbIn;
      if (bnbIn >= CFG.bigBuyP1) {
        st.bigBuyCount++;
        st.bigBuyBnb += bnbIn;
        if (toAddr) st.bigBuyers.add(toAddr);
        const swapX = (bnbIn / tokOut) / refPriceBnb;
        log(`🟢 BIG BUY  +${bnbIn.toFixed(3)} BNB ($${(bnbIn * bnbUsd).toFixed(0)}) @ ${swapX.toFixed(3)}x | buyer=${toAddr.slice(0, 10)} (uniq=${st.bigBuyers.size}) | t=${sec}s | net=${st.netInflowBnb >= 0 ? "+" : ""}${st.netInflowBnb.toFixed(3)} BNB`);
      }
      st.rBnb += bnbIn;
      st.rTok = Math.max(1, st.rTok - tokOut);
      st.currentX = (st.rBnb / st.rTok) / refPriceBnb;
    } else if (tokIn > 0 && bnbOut > 0) {
      st.sellCount++;
      st.sellBnb += bnbOut;
      st.netInflowBnb -= bnbOut;
      if (bnbOut > st.maxSingleSellBnb) st.maxSingleSellBnb = bnbOut;
      if (bnbOut >= CFG.bigBuyP1) {
        st.bigSellCount++;
        st.bigSellBnb += bnbOut;
        const swapX = (bnbOut / tokIn) / refPriceBnb;
        log(`🔴 BIG SELL -${bnbOut.toFixed(3)} BNB ($${(bnbOut * bnbUsd).toFixed(0)}) @ ${swapX.toFixed(3)}x | t=${sec}s | net=${st.netInflowBnb >= 0 ? "+" : ""}${st.netInflowBnb.toFixed(3)} BNB`);
      }
      st.rBnb = Math.max(0.0001, st.rBnb - bnbOut);
      st.rTok += tokIn;
      st.currentX = (st.rBnb / st.rTok) / refPriceBnb;
    }
    await evaluateSignals();
  }

  let wsProvider = null;
  let wssConnected = false;
  function connectWss(urlIdx = 0) {
    if (!wssUrls.length) return;
    const u = wssUrls[urlIdx % wssUrls.length];
    try {
      wsProvider = new ethers.WebSocketProvider(u, 56, { staticNetwork: true });
      wsProvider.on({ address: pairAddr, topics: [SWAP_TOPIC] }, (lg) => {
        handleSwapLog(lg).catch(() => {});
      });
      wssConnected = true;
      log(`[wss] Subscribed live Swap stream on ${pairAddr} (wss[${urlIdx % wssUrls.length}])`);
      wsProvider.websocket?.addEventListener?.("close", () => {
        wssConnected = false;
        if (!stopping) {
          log(`[wss] Disconnected; reconnecting in 1.5s...`);
          setTimeout(() => connectWss(urlIdx + 1), 1500);
        }
      });
    } catch (e) {
      wssConnected = false;
      log(`[wss] Connect err: ${e.message}; HTTP fallback active`);
    }
  }
  connectWss(0);

  let lastPolledBlk = await provider.getBlockNumber().catch(() => blk0.number);
  let stopping = false;

  const finish = async (reason) => {
    if (stopping) return;
    stopping = true;
    clearInterval(tickTimer);
    if (wsProvider) { try { wsProvider.destroy(); } catch {} }
    for (const tr of traders) tr.close();
    const sec = (Date.now() - openWallMs) / 1000;
    const sc = computeScore(st, sec);
    log(`=== FLAT_WATCH SUMMARY (${reason}, ${sec.toFixed(1)}s) ===`);
    console.log(JSON.stringify({
      symbol,
      token: CFG.token,
      pair: pairAddr,
      elapsedSec: Number(sec.toFixed(1)),
      score: sc.score,
      grade: sc.grade,
      reasons: sc.reasons,
      initPoolBnb: Number(st.initPoolBnb.toFixed(4)),
      finalPoolBnb: Number(st.rBnb.toFixed(4)),
      currentX: Number(st.currentX.toFixed(3)),
      low10sX: Number(st.low10sX.toFixed(3)),
      low60sX: Number(st.low60sX.toFixed(3)),
      highX: Number(st.highSinceOpenX.toFixed(3)),
      swapsSeen: st.swapsSeen,
      buys: st.buyCount,
      sells: st.sellCount,
      buyBnb: Number(st.buyBnb.toFixed(4)),
      sellBnb: Number(st.sellBnb.toFixed(4)),
      netInflowBnb: Number(st.netInflowBnb.toFixed(4)),
      bigBuyCount: st.bigBuyCount,
      distinctBigBuyers: st.bigBuyers.size,
      bigBuyBnb: Number(st.bigBuyBnb.toFixed(4)),
      bigSellCount: st.bigSellCount,
      bigSellBnb: Number(st.bigSellBnb.toFixed(4)),
      maxSingleBuyBnb: Number(st.maxSingleBuyBnb.toFixed(4)),
      alertFile,
    }, null, 2));
    process.exit(0);
  };

  process.on("SIGINT", () => finish("SIGINT"));
  process.on("SIGTERM", () => finish("SIGTERM"));

  const tickTimer = setInterval(async () => {
    if (stopping) return;
    try {
      const [curBlk, [nr0, nr1]] = await Promise.all([
        provider.getBlockNumber(),
        pairC.getReserves(),
      ]);
      if (curBlk > lastPolledBlk) {
        const fromB = Math.max(lastPolledBlk + 1, curBlk - 15);
        const logs = await provider.getLogs({
          address: pairAddr,
          fromBlock: fromB,
          toBlock: curBlk,
          topics: [SWAP_TOPIC],
        }).catch(() => []);
        for (const lg of logs) await handleSwapLog(lg);
        lastPolledBlk = curBlk;
      }
      const nrTok = Number(ethers.formatUnits(isTok0 ? nr0 : nr1, dec));
      const nrBnb = Number(ethers.formatUnits(isTok0 ? nr1 : nr0, 18));
      if (nrTok > 0 && nrBnb > 0) {
        st.rTok = nrTok;
        st.rBnb = nrBnb;
        st.currentX = (nrBnb / nrTok) / refPriceBnb;
      }
      const sec = (Date.now() - openWallMs) / 1000;
      const sc = computeScore(st, sec);
      const ratioStr = sc.bigRatio >= 99 ? "∞" : sc.bigRatio.toFixed(1);
      log(
        `t=${sec.toFixed(0).padStart(3)}s | ${st.currentX.toFixed(3)}x (L10=${st.low10sX.toFixed(2)} H=${st.highSinceOpenX.toFixed(2)}) | ` +
        `LP=${st.rBnb.toFixed(2)}BNB | Net=${st.netInflowBnb >= 0 ? "+" : ""}${st.netInflowBnb.toFixed(2)}BNB | ` +
        `B/S=${st.buyCount}/${st.sellCount} Big=${st.bigBuyCount}/${st.bigSellCount}(r=${ratioStr},u=${st.bigBuyers.size}) MaxB=${st.maxSingleBuyBnb.toFixed(2)} | ` +
        `Score=${sc.score}/100 [${sc.grade}]${wssConnected ? "" : " (HTTP)"}`
      );
      await evaluateSignals();
      if (CFG.durationSec > 0 && sec >= CFG.durationSec) {
        await finish("DURATION_REACHED");
      }
    } catch (e) {
      log(`[tick err] ${(e.shortMessage || e.message).slice(0, 100)}`);
    }
  }, 3000);
}

main().catch((e) => {
  console.error("FATAL:", e.stack || e.message || e);
  process.exit(1);
});
