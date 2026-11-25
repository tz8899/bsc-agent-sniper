#!/usr/bin/env node
/**
 * fairlaunch_master.mjs — BSC 公平发射全流程一体化模板引擎
 * （免费 EIP-712 抢领[绝不自动卖] + 1分钟达标付费满打 + 开盘秒领 claimTokens + 平盘不秒卖 60s 监控策略）
 *
 * 所有钱包与 RPC 均从 config/wallets.json 与 config/rpc_live.json 动态读取，项目参数从 --config JSON 加载，零硬编码隐私。
 *
 * 用法：
 *   node scripts/fairlaunch_master.mjs --self-test
 *   node scripts/fairlaunch_master.mjs --config config/cfg.fairlaunch.example.json --dry-run
 *   node scripts/fairlaunch_master.mjs --config config/cfg.fairlaunch.local.json
 */

import fs from "fs";
import path from "path";
import readline from "readline";
import { spawn, execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { ROOT, loadWallets, loadRpcs } = require("../lib/config.js");

let ethers;
try {
  ({ ethers } = require("ethers"));
} catch {
  ({ ethers } = require(path.join(ROOT, "lib", "ethers.cjs")));
}

// ------------------------------------------------------------ CLI Parsing
const ARGV = process.argv.slice(2).map((s) => s.trim());
const DRY_RUN = ARGV.includes("--dry-run");
const SELF_TEST = ARGV.includes("--self-test");
const getOpt = (k, def = null) => {
  const i = ARGV.indexOf(k);
  return i >= 0 && ARGV[i + 1] !== undefined && !ARGV[i + 1].startsWith("--") ? ARGV[i + 1] : def;
};

// ------------------------------------------------------------ Pure Helpers (Unit-Testable)
function computeSafePaidShares(balanceWei, curSharesSold, remQuota, openShares, priceWei, gasReserveWei, targetShares) {
  const leftBeforeOpen = Math.max(0, openShares - Number(curSharesSold));
  if (leftBeforeOpen <= 0) return { shares: 0, reason: "already_at_open_boundary" };
  const availForCost = balanceWei > gasReserveWei ? balanceWei - gasReserveWei : 0n;
  const maxByBal = Number(availForCost / priceWei);
  const maxByQuota = Math.max(0, Number(remQuota));
  const shares = Math.min(targetShares, leftBeforeOpen, maxByBal, maxByQuota);
  if (shares <= 0) {
    return { shares: 0, reason: `clamped_zero(bal=${ethers.formatEther(balanceWei)},left=${leftBeforeOpen},quota=${maxByQuota})` };
  }
  const note = shares < targetShares ? `clamped(${targetShares}->${shares})` : "full";
  return { shares, reason: note };
}

// Strict isolation: NEVER sells free shares — only sells up to remaining paid tokens!
function computePaidSellAmount(balWei, paidRemainWei, pct) {
  if (balWei <= 0n || paidRemainWei <= 0n) return 0n;
  const target = pct >= 100 ? paidRemainWei : (paidRemainWei * BigInt(Math.floor(pct))) / 100n;
  return target > balWei ? balWei : target;
}

function computeScore(st, secSinceOpen, P1) {
  let score = 0;
  const reasons = [];
  if (st.low10sX >= P1.minHold10s) { score += 15; reasons.push(`10s稳>=${P1.minHold10s}x`); }
  if (st.low60sX >= P1.minHold60s) { score += 15; reasons.push(`60s稳>=${P1.minHold60s}x`); }
  if (st.netInflowBnb > 0) score += 10;
  if (st.netInflowBnb >= P1.inflowBnb) { score += 20; reasons.push(`净流入+${st.netInflowBnb.toFixed(2)}BNB`); }
  if (st.maxSingleBuyBnb >= P1.bigBuyP1) { score += 10; reasons.push(`大买>=${P1.bigBuyP1}BNB`); }
  if (st.maxSingleBuyBnb >= P1.bigBuyP2 && st.bigBuyers.size >= 2) {
    score += 10; reasons.push(`强买>=${P1.bigBuyP2}BNB(${st.bigBuyers.size}地址)`);
  } else if (st.maxSingleBuyBnb >= P1.bigBuyP2) {
    score += 5; reasons.push("单地址大买");
  }
  const bigRatio = st.bigSellBnb > 0 ? st.bigBuyBnb / st.bigSellBnb : (st.bigBuyBnb > 0 ? 99 : 0);
  if (bigRatio >= 1.5 && st.bigBuyCount > 0) { score += 5; reasons.push(`大单比${bigRatio >= 99 ? "∞" : bigRatio.toFixed(1)}`); }
  const outflowPct = st.initPoolBnb > 0 ? (-st.netInflowBnb / st.initPoolBnb) * 100 : 0;
  if (outflowPct < P1.stopOutflowPct) score += 10;
  if (st.currentX >= 1.0) score += 5;
  const grade = score >= 70 ? "STRONG" : score >= 45 ? "WATCH" : "WEAK";
  return { score, grade, bigRatio, outflowPct, reasons, secSinceOpen };
}

function decideFlatOpenActions(st, sec, activeCount, P1) {
  const actions = [];
  const sc = computeScore(st, sec, P1);
  if (sec <= 10 && st.currentX < st.low10sX) st.low10sX = st.currentX;
  if (sec <= 30 && st.currentX < st.low30sX) st.low30sX = st.currentX;
  if (sec <= 60 && st.currentX < st.low60sX) st.low60sX = st.currentX;
  if (st.currentX > st.highSinceOpenX) st.highSinceOpenX = st.currentX;

  for (const lvl of [1.5, 2.0, 2.5, 3.0, 3.5]) {
    if (st.currentX >= lvl && !st.alertedTp.has(lvl)) {
      st.alertedTp.add(lvl);
      actions.push({ type: "ALERT_TP", lvl, sc });
    }
  }

  if (
    !st.strongSent &&
    sec >= 10 && sec <= 90 &&
    st.low10sX >= P1.minHold10s &&
    st.netInflowBnb >= P1.inflowBnb &&
    st.maxSingleBuyBnb >= P1.bigBuyP1
  ) {
    st.strongSent = true;
    actions.push({ type: "ALERT_STRONG", sc });
  }

  const hitOutflowStop = sec <= 35 && sc.outflowPct >= P1.stopOutflowPct;
  const hitPriceStop = st.currentX <= P1.stopX;
  if (!st.stopSent && st.stage < 3 && (hitOutflowStop || hitPriceStop)) {
    st.stopSent = true;
    st.stage = 3;
    actions.push({
      type: "SELL_ALL_STOP",
      reason: hitPriceStop ? `砸破${P1.stopX}x` : `前30s净流出${sc.outflowPct.toFixed(1)}%`,
      sc,
    });
    return { actions, sc };
  }

  if (activeCount > 0 && st.stage < 3) {
    if (activeCount >= 2) {
      if (st.stage === 0 && st.currentX >= P1.tp1) {
        st.stage = 1;
        actions.push({ type: "SELL_WALLET_IDX", idx: 0, pct: 100, tag: `TP1(${P1.tp1}x保本)`, sc });
      }
      if (st.stage === 1 && activeCount >= 3 && st.currentX >= P1.tp2) {
        st.stage = 2;
        actions.push({ type: "SELL_WALLET_IDX", idx: 1, pct: 100, tag: `TP2(${P1.tp2}x锁利)`, sc });
      }
      if (st.stage >= 1) {
        const dropPct = st.highSinceOpenX > 0 ? ((st.highSinceOpenX - st.currentX) / st.highSinceOpenX) * 100 : 0;
        if (st.currentX >= P1.tp3 || (st.highSinceOpenX >= P1.tp1 && dropPct >= P1.trailPct)) {
          st.stage = 3;
          const why = st.currentX >= P1.tp3 ? `达终极目标${P1.tp3}x` : `从高点${st.highSinceOpenX.toFixed(2)}x回撤${dropPct.toFixed(1)}%`;
          actions.push({ type: "SELL_REST", reason: why, sc });
        }
      }
    } else {
      if (st.stage === 0 && st.currentX >= P1.tp1) {
        st.stage = 1;
        actions.push({ type: "SELL_WALLET_IDX", idx: 0, pct: 50, tag: `TP1(${P1.tp1}x卖半保本)`, sc });
      }
      if (st.stage === 1 && st.highSinceOpenX >= P1.tp1) {
        const dropPct = st.highSinceOpenX > 0 ? ((st.highSinceOpenX - st.currentX) / st.highSinceOpenX) * 100 : 0;
        if (st.currentX >= P1.tp3 || dropPct >= P1.trailPct) {
          st.stage = 3;
          const why = st.currentX >= P1.tp3 ? `达终极目标${P1.tp3}x` : `从高点${st.highSinceOpenX.toFixed(2)}x回撤${dropPct.toFixed(1)}%`;
          actions.push({ type: "SELL_REST", reason: why, sc });
        }
      }
    }
  }
  return { actions, sc };
}

function makeFreshFlatState(initPoolBnb, rTok, initX) {
  return {
    initPoolBnb, rBnb: initPoolBnb, rTok,
    currentX: initX, low10sX: initX, low30sX: initX, low60sX: initX, highSinceOpenX: initX,
    buyCount: 0, sellCount: 0, buyBnb: 0, sellBnb: 0, netInflowBnb: 0,
    bigBuyCount: 0, bigBuyBnb: 0, bigSellCount: 0, bigSellBnb: 0,
    bigBuyers: new Set(), maxSingleBuyBnb: 0, maxSingleSellBnb: 0,
    swapsSeen: 0, alertedTp: new Set(),
    strongSent: false, stopSent: false, stage: 0,
  };
}

// ------------------------------------------------------------ Self-Test Mode
if (SELF_TEST) {
  const assert = (c, m) => { if (!c) { console.error("FAIL:", m); process.exit(1); } };
  const P1 = { minHold10s: 0.85, minHold60s: 0.90, stopX: 0.80, stopOutflowPct: 10, inflowBnb: 1.5, bigBuyP1: 0.8, bigBuyP2: 1.0, tp1: 1.5, tp2: 2.5, tp3: 3.5, trailPct: 15 };
  const price = ethers.parseEther("0.003");
  const reserve = ethers.parseEther("0.0012");

  let r = computeSafePaidShares(ethers.parseEther("0.032"), 7600, 10, 10000, price, reserve, 10);
  assert(r.shares === 10 && r.reason === "full", "0.032 BNB should mint full 10 shares");
  r = computeSafePaidShares(ethers.parseEther("0.0309"), 7600, 10, 10000, price, reserve, 10);
  assert(r.shares === 9, "0.0309 BNB should clamp to 9 shares to keep gas reserve");
  r = computeSafePaidShares(ethers.parseEther("0.05"), 9996, 10, 10000, price, reserve, 10);
  assert(r.shares === 4, "boundary should clamp to 4 shares");

  const oneFree = 14_000_000n * 10n ** 18n;
  const tenPaid = 10n * oneFree;
  assert(computePaidSellAmount(oneFree + tenPaid, tenPaid, 100) === tenPaid, "100% paid sell must keep free share untouched");
  assert(computePaidSellAmount(oneFree, 0n, 100) === 0n, "free-only wallet must never auto-sell");

  let s = makeFreshFlatState(15, 70e9, 1.0);
  s.low10sX = 0.91; s.low60sX = 0.91; s.netInflowBnb = 2.2; s.maxSingleBuyBnb = 1.1; s.bigBuyers.add("0x1"); s.bigBuyers.add("0x2");
  s.currentX = 1.55;
  assert(decideFlatOpenActions(s, 40, 3, P1).actions.some((a) => a.type === "SELL_WALLET_IDX" && a.idx === 0), "1.55x sells wallet #1");
  s.currentX = 2.55;
  assert(decideFlatOpenActions(s, 80, 3, P1).actions.some((a) => a.type === "SELL_WALLET_IDX" && a.idx === 1), "2.55x sells wallet #2");
  s.currentX = 3.20;
  decideFlatOpenActions(s, 110, 3, P1);
  s.currentX = 2.65;
  assert(decideFlatOpenActions(s, 130, 3, P1).actions.some((a) => a.type === "SELL_REST"), "15% trail exits wallet #3");

  console.log("ALL FAIRLAUNCH_MASTER SELF-TESTS PASSED");
  process.exit(0);
}

// ------------------------------------------------------------ Load Config & Wallets
const cfgPath = getOpt("--config");
if (!cfgPath || !fs.existsSync(cfgPath)) {
  console.error("用法: node scripts/fairlaunch_master.mjs --config <cfg.json> [--dry-run] | --self-test");
  process.exit(1);
}
const CFG = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
const P1 = CFG.flatOpen || {
  minHold10s: 0.85, minHold60s: 0.90, stopX: 0.80, stopOutflowPct: 10,
  inflowBnb: 1.5, bigBuyP1: 0.8, bigBuyP2: 1.0, tp1: 1.5, tp2: 2.5, tp3: 3.5,
  trailPct: 15, slippage: 15, retrySlippage: 25, maxWatchSec: 5400,
};

const WCFG = loadWallets(true);
const BAW_CFG = WCFG.baw || {};
const BAW_BASE = path.resolve(ROOT, process.env.BAW_DIR || BAW_CFG.dir || "./baw");
const ACC_KEYS = String(CFG.acc || Object.keys(WCFG.accounts).join("")).split("");
const WALLET_DEFS = ACC_KEYS.map((k) => {
  const raw = WCFG.accounts[k];
  if (!raw) throw new Error(`config/wallets.json 中缺少账号 "${k}"`);
  const ov = (BAW_CFG.overrides && BAW_CFG.overrides[k]) || {};
  return {
    name: `acc${k}`,
    key: k,
    dir: ov.dir ? path.resolve(ROOT, ov.dir) : path.join(BAW_BASE, `acc${k}`),
    home: ov.home ? path.resolve(ROOT, ov.home) : null,
    wid: `fl_m_${k}`,
    address: ethers.getAddress(raw.startsWith("0x") ? raw : "0x" + raw),
  };
});

const LOG_DIR = path.join(ROOT, "logs");
fs.mkdirSync(LOG_DIR, { recursive: true });
const TAG = String(CFG.name || "fairlaunch").replace(/[^a-zA-Z0-9_-]/g, "");
const RESULTS_PATH = path.join(LOG_DIR, `${TAG}_results.json`);
const ALERTS_PATH = path.join(LOG_DIR, `${TAG}_alerts.jsonl`);
const WEBHOOK = process.env.FLAT_WATCH_WEBHOOK || null;

const MINT_ADDR       = ethers.getAddress(CFG.mintContract);
const TOKEN_ADDR      = ethers.getAddress(CFG.tokenContract);
const PAIR_ADDR       = ethers.getAddress(CFG.pairContract);
const EXPECTED_SIGNER = ethers.getAddress(CFG.expectedSigner);
const FREE_ADDR_API   = CFG.freeVoucherApi;
const WBNB            = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT            = "0x55d398326f99059fF775485246999027B3197955";
const ROUTER          = "0x10ED43C718714eb63d5aA57B78B54704E256024E";

const MINT_START      = Number(CFG.mintStartUnix);
const FREE_CAP        = Number(CFG.freeCap || 500);
const OPEN_SHARES     = Number(CFG.openShares || 10000);
const PAID_TRIGGER    = Number(CFG.paidTriggerShares || 7500);
const PAID_WINDOW_SEC = Number(CFG.paidWindowSec || 60);
const TARGET_SHARES   = Number(CFG.targetSharesPerWallet || 10);
const PRICE_WEI       = ethers.parseEther(String(CFG.pricePerShareBnb || "0.003"));
const TOKENS_PER_SHARE_WEI = BigInt(CFG.tokensPerShare || "14000000") * 10n ** 18n;
const GAS_RESERVE_WEI = ethers.parseEther(String(CFG.gasReserveBnb || "0.0012"));
const REF_PRICE_BNB   = Number(CFG.pricePerShareBnb || "0.003") / Number(CFG.tokensPerShare || "14000000");

const PREWARM_SEC     = Number(CFG.prewarmSec || 65);
const EARLY_SEC       = Number(CFG.earlyFireSec || 30);
const FAST_SEC        = Number(CFG.fastPollSec || 8);
const FREE_STOP_AFTER = Number(CFG.freeStopAfterSec || 180);

// ------------------------------------------------------------ RPC & Contracts
const liveRpcs = loadRpcs();
const httpUrls = liveRpcs.http;
const wssUrls  = liveRpcs.wss;
const provider = new ethers.JsonRpcProvider(httpUrls[1] || httpUrls[0], 56, { staticNetwork: true });

const mintIface = new ethers.Interface([
  "function mintStart() view returns (uint64)",
  "function opened() view returns (bool)",
  "function sharesSold() view returns (uint256)",
  "function freeClaimed() view returns (uint256)",
  "function SIGNER() view returns (address)",
  "function hasClaimedFree(address) view returns (bool)",
  "function mintedShares(address) view returns (uint256)",
  "function pendingTokens(address) view returns (uint256)",
  "function remainingQuota(address) view returns (uint256)",
  "function refundOpen() view returns (bool)",
  "function freeClaimDigest(address user, uint256 deadline) view returns (bytes32)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function claimFree(uint256 deadline, bytes sig)",
  "function mint(uint256 shares, address referrer, uint256 minTokens, uint256 deadline, uint256 refDeadline, bytes refSig) payable",
  "function claimTokens()",
  "event FreeClaimed(address indexed user, uint256 tokens, uint256 index, bool preOpen)",
  "event Minted(address indexed user, address indexed referrer, uint256 startShare, uint256 shares, uint256 cost, uint256 userTokens, uint256 poolTokens, bool preOpen)",
  "event PoolOpened(uint256 bnb, uint256 tokens, uint256 liquidity)",
]);
const erc20Iface = new ethers.Interface([
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
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);

const SWAP_TOPIC = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");
const MINTED_TOPIC = ethers.id("Minted(address,address,uint256,uint256,uint256,uint256,uint256,bool)");
const POOL_OPENED_TOPIC = ethers.id("PoolOpened(uint256,uint256,uint256)");

const minter  = new ethers.Contract(MINT_ADDR, mintIface, provider);
const tokenC  = new ethers.Contract(TOKEN_ADDR, erc20Iface, provider);
const pairC   = new ethers.Contract(PAIR_ADDR, pairIface, provider);
const routerC = new ethers.Contract(ROUTER, routerIface, provider);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let clockOffsetMs = 0;
const chainNowMs = () => Date.now() + clockOffsetMs;
const chainNowSec = () => chainNowMs() / 1000;
const bjTime = (ms = chainNowMs()) => new Date(ms + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 23) + " +08";
const log = (msg) => console.log(`[${bjTime()}] ${msg}`);

async function syncClock() {
  const blk = await provider.getBlock("latest").catch(() => null);
  if (blk?.timestamp) clockOffsetMs = blk.timestamp * 1000 - Date.now();
  return blk;
}

async function emitAlert(type, title, detail = {}) {
  const payload = { at: bjTime(), type, title, ...detail };
  process.stdout.write("\x07");
  log(`🔔 ALERT [${type}] ${title} | ${JSON.stringify(detail)}`);
  try { fs.appendFileSync(ALERTS_PATH, JSON.stringify(payload) + "\n"); } catch {}
  if (WEBHOOK) {
    const text = `[${TAG}][${type}] ${title}\n${Object.entries(detail).map(([k, v]) => `${k}: ${v}`).join(" | ")}`;
    fetch(WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, content: text, msg_type: "text" }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  }
}

function checkBawStatus(w) {
  try {
    const env = { ...process.env, BINANCE_BAW_DIR: w.dir };
    if (w.home) env.HOME = w.home;
    const out = execFileSync("baw", ["wallet", "status", "--json"], { env, encoding: "utf8", timeout: 15000 });
    return JSON.parse(out)?.data?.status || "UNKNOWN";
  } catch (e) {
    return "ERR:" + (e.message || "").slice(0, 40);
  }
}

function spawnWorker(w) {
  const env = { ...process.env, BINANCE_BAW_DIR: w.dir, WID: w.wid };
  if (w.home) env.HOME = w.home;
  const child = spawn(process.execPath, [path.join(HERE, "bawworker.mjs")], { env, stdio: ["pipe", "pipe", "pipe"] });
  let seq = 1, readyRes;
  const pending = new Map();
  const ready = new Promise((r) => (readyRes = r));
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let msg; try { msg = JSON.parse(line); } catch { return; }
    if (msg.ready) { readyRes(true); return; }
    const cb = pending.get(msg.id);
    if (cb) { pending.delete(msg.id); cb(msg); }
  });
  const call = (op, body, timeoutMs = 15000) => new Promise((resolve) => {
    const id = seq++;
    const timer = setTimeout(() => { pending.delete(id); resolve({ success: false, error: { message: "timeout" } }); }, timeoutMs);
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ id, op, body }) + "\n");
  });
  return { ready, call, kill: () => { try { child.kill(); } catch {} } };
}

function withTxLock(st, fn) {
  const next = st.txChain.then(fn, fn);
  st.txChain = next.catch(() => {});
  return next;
}

async function sendBawTx(st, label, to, data, valueWei = 0n) {
  if (DRY_RUN) {
    log(`[${st.name} DRY-RUN ${label}] to=${to} val=${ethers.formatEther(valueWei)} sel=${data.slice(0, 10)}`);
    return { ok: true, dryRun: true, txHash: "0xDRYRUN", rcpt: null };
  }
  const prev = await st.worker.call("preview", { binanceChainId: "56", from: st.address, to, value: valueWei.toString(), inputData: data }, 12000);
  if (!prev.success || !prev.data?.requestId) return { ok: false, err: JSON.stringify(prev.error || prev).slice(0, 140) };
  const ex = await st.worker.call("execute", { requestId: prev.data.requestId }, 18000);
  const txHash = ex.data?.txHash || ex.data?.transactionHash || ex.data?.hash;
  if (!ex.success || !txHash) return { ok: false, err: JSON.stringify(ex.error || ex).slice(0, 140) };
  log(`[${st.name} ${label}] SENT tx=${txHash}`);
  const rcpt = await provider.waitForTransaction(txHash, 1, 40000).catch(() => null);
  return { ok: rcpt?.status === 1, txHash, rcpt };
}

async function ensureTokensClaimed(st) {
  if (st.claimPromise) return st.claimPromise;
  st.claimPromise = withTxLock(st, async () => {
    for (let i = 1; i <= 6; i++) {
      const pend = await minter.pendingTokens(st.address).catch(() => 0n);
      if (pend === 0n) { st.claimedDone = true; return true; }
      const r = await sendBawTx(st, "claimTokens", MINT_ADDR, mintIface.encodeFunctionData("claimTokens", []), 0n);
      if (r.ok || r.dryRun) { st.claimTx = r.txHash; st.claimedDone = true; return true; }
      await sleep(500);
    }
    return false;
  });
  return st.claimPromise;
}

async function revokeRouterIfNeeded(st) {
  if (DRY_RUN || !st.worker) return;
  const cur = await tokenC.allowance(st.address, ROUTER).catch(() => 0n);
  if (cur === 0n) return;
  await sendBawTx(st, "revoke", TOKEN_ADDR, erc20Iface.encodeFunctionData("approve", [ROUTER, 0n]), 0n);
}

async function sellPaidFraction(st, pct, tag) {
  if (st.soldOut || !st.paidRemainWei || st.paidRemainWei <= 0n) return null;
  await ensureTokensClaimed(st);
  return withTxLock(st, async () => {
    if (st.soldOut || !st.paidRemainWei || st.paidRemainWei <= 0n) return null;
    for (const slip of [P1.slippage, P1.retrySlippage]) {
      const bal = await tokenC.balanceOf(st.address).catch(() => 0n);
      const sellAmt = computePaidSellAmount(bal, st.paidRemainWei, pct);
      if (sellAmt === 0n) { if (pct >= 100) st.soldOut = true; return null; }

      const curAllow = await tokenC.allowance(st.address, ROUTER).catch(() => 0n);
      if (curAllow < sellAmt) {
        const app = await sendBawTx(st, "approve", TOKEN_ADDR, erc20Iface.encodeFunctionData("approve", [ROUTER, sellAmt]), 0n);
        if (!app.ok && !app.dryRun) { await sleep(500); continue; }
      }
      let minBnb = 0n;
      try {
        const out = await routerC.getAmountsOut(sellAmt, [TOKEN_ADDR, WBNB]);
        minBnb = (out[1] * BigInt(Math.max(1, 100 - slip))) / 100n;
      } catch {}
      const swapData = routerIface.encodeFunctionData("swapExactTokensForETHSupportingFeeOnTransferTokens", [
        sellAmt, minBnb, [TOKEN_ADDR, WBNB], st.address, BigInt(Math.floor(chainNowSec()) + 120),
      ]);
      const res = await sendBawTx(st, `sell:${tag}`, ROUTER, swapData, 0n);
      if (res.ok || res.dryRun) {
        st.sellTxs.push({ tag, pct, txHash: res.txHash });
        st.paidRemainWei = st.paidRemainWei > sellAmt ? st.paidRemainWei - sellAmt : 0n;
        if (pct >= 100 || st.paidRemainWei === 0n) st.soldOut = true;
        await revokeRouterIfNeeded(st);
        return res;
      }
      await sleep(700);
    }
    await revokeRouterIfNeeded(st);
    return { ok: false };
  });
}

async function main() {
  const blk0 = await syncClock();
  const [dom, onSold, onFree, token0, bnbUsdtOut] = await Promise.all([
    minter.eip712Domain(),
    minter.sharesSold(),
    minter.freeClaimed(),
    pairC.token0(),
    routerC.getAmountsOut(ethers.parseEther("1"), [WBNB, USDT]),
  ]);
  const domain = { name: dom.name, version: dom.version, chainId: Number(dom.chainId), verifyingContract: dom.verifyingContract };
  const isTok0 = token0.toLowerCase() === TOKEN_ADDR.toLowerCase();
  const bnbUsd = Number(ethers.formatUnits(bnbUsdtOut[1], 18));

  log(`========================================================================`);
  log(`FAIRLAUNCH MASTER [${TAG}] | DRY_RUN=${DRY_RUN} | blk=${blk0?.number} | BNB=$${bnbUsd.toFixed(2)}`);
  log(`  Mint=${MINT_ADDR} | Token=${TOKEN_ADDR} | Pair=${PAIR_ADDR}`);
  log(`  mintStart=${bjTime(MINT_START * 1000)} | sold=${onSold}/${OPEN_SHARES} | free=${onFree}/${FREE_CAP}`);
  log(`  Paid trigger: ${PAID_TRIGGER}/${OPEN_SHARES} (${((PAID_TRIGGER / OPEN_SHARES) * 100).toFixed(0)}%) within ${PAID_WINDOW_SEC}s -> ${TARGET_SHARES}sh/wallet | Free shares NEVER auto-sold`);
  log(`========================================================================`);

  const states = [];
  for (const w of WALLET_DEFS) {
    const status = checkBawStatus(w);
    const [bnb, rq] = await Promise.all([provider.getBalance(w.address), minter.remainingQuota(w.address).catch(() => BigInt(TARGET_SHARES))]);
    const plan = computeSafePaidShares(bnb, onSold, rq, OPEN_SHARES, PRICE_WEI, GAS_RESERVE_WEI, TARGET_SHARES);
    log(`  [${w.name}] ${w.address} | baw=${status} | BNB=${ethers.formatEther(bnb)} | plan=${plan.shares}sh (${plan.reason})`);
    states.push({
      ...w, worker: null, txChain: Promise.resolve(),
      freeDone: false, voucher: null, paidAttempted: false, paidDone: false, paidShares: 0, paidRemainWei: 0n,
      claimPromise: null, claimedDone: false, claimTx: null, soldOut: false, sellTxs: [],
    });
  }

  if (DRY_RUN) {
    for (const st of states) {
      st.worker = spawnWorker(st);
      await st.worker.ready;
      const p = await st.worker.call("ping", {}, 5000);
      log(`[DRY-RUN] [${st.name}] bawworker ping=${JSON.stringify(p.data)}`);
      st.worker.kill();
    }
    log("[DRY-RUN] ALL CHECKS PASSED.");
    return;
  }

  // Wait until T-PREWARM_SEC
  const prewarmAt = MINT_START - PREWARM_SEC;
  while (chainNowSec() < prewarmAt) {
    await sleep(Math.min((prewarmAt - chainNowSec()) * 1000, 25 * 60 * 1000));
    await syncClock();
  }

  // Prewarm workers & ensure exact paid-share pre-approval to Router BEFORE launch
  const exactPaidApprove = BigInt(TARGET_SHARES) * TOKENS_PER_SHARE_WEI;
  await Promise.all(states.map(async (st) => {
    st.worker = spawnWorker(st);
    await st.worker.ready;
    const alw = await tokenC.allowance(st.address, ROUTER).catch(() => 0n);
    if (alw < exactPaidApprove) {
      await sendBawTx(st, "preApproveRouter", TOKEN_ADDR, erc20Iface.encodeFunctionData("approve", [ROUTER, exactPaidApprove]), 0n);
    }
  }));

  let shuttingDown = false, latestSold = Number(onSold), latestOpened = false, paidTriggered = false, paidWindowClosed = false, freeSoldOut = false;
  let openResolve; const openPromise = new Promise((r) => (openResolve = r));
  const swapHandlers = [];
  let wssPaidHook = null;

  const wsProvider = wssUrls[0] ? new ethers.WebSocketProvider(wssUrls[0], 56, { staticNetwork: true }) : null;
  if (wsProvider) {
    wsProvider.on({ address: MINT_ADDR, topics: [MINTED_TOPIC] }, (lg) => {
      try {
        const parsed = mintIface.parseLog(lg);
        if (parsed?.name === "Minted" && parsed.args.preOpen) {
          const endShare = Number(parsed.args.startShare) + Number(parsed.args.shares) - 1;
          if (endShare > latestSold) latestSold = endShare;
          const el = chainNowSec() - MINT_START;
          if (!paidTriggered && !paidWindowClosed && !latestOpened && el >= 0 && el <= PAID_WINDOW_SEC && endShare >= PAID_TRIGGER && wssPaidHook) {
            wssPaidHook(endShare, el);
          }
        }
      } catch {}
    });
    wsProvider.on({ address: MINT_ADDR, topics: [POOL_OPENED_TOPIC] }, () => { latestOpened = true; openResolve?.("wss"); });
    wsProvider.on({ address: PAIR_ADDR, topics: [SWAP_TOPIC] }, (lg) => swapHandlers.forEach((fn) => fn(lg)));
  }

  while (chainNowSec() < MINT_START - EARLY_SEC) await sleep(250);

  let paidFirePromise = null;
  async function execPaidWallet(st) {
    if (st.paidAttempted) return;
    st.paidAttempted = true;
    await withTxLock(st, async () => {
      const [op, curSold, bal, rq] = await Promise.all([minter.opened(), minter.sharesSold(), provider.getBalance(st.address), minter.remainingQuota(st.address)]);
      if (op || Number(curSold) >= OPEN_SHARES) return;
      const plan = computeSafePaidShares(bal, curSold, rq, OPEN_SHARES, PRICE_WEI, GAS_RESERVE_WEI, TARGET_SHARES);
      if (plan.shares <= 0) return;
      const k = BigInt(plan.shares);
      const data = mintIface.encodeFunctionData("mint", [k, ethers.ZeroAddress, k * TOKENS_PER_SHARE_WEI, BigInt(Math.floor(chainNowSec()) + 45), 0n, "0x"]);
      const res = await sendBawTx(st, `paidMint(${plan.shares})`, MINT_ADDR, data, k * PRICE_WEI);
      if (res.ok) { st.paidDone = true; st.paidShares = plan.shares; st.paidRemainWei = k * TOKENS_PER_SHARE_WEI; }
    });
  }

  wssPaidHook = (sold, el) => {
    if (paidTriggered || paidWindowClosed || latestOpened) return;
    paidTriggered = true;
    emitAlert("PAID_TRIGGERED", `突破门槛 ${sold}/${OPEN_SHARES} (${el.toFixed(1)}s)，并发满打！`);
    paidFirePromise = Promise.all(states.map((st, idx) => sleep(idx * 80).then(() => execPaidWallet(st))));
  };

  // Free claim loop (if API configured)
  const freePromise = FREE_ADDR_API ? Promise.all(states.map(async (st, idx) => {
    await sleep(idx * 120);
    while (!shuttingDown && !st.freeDone && !freeSoldOut && chainNowSec() < MINT_START + FREE_STOP_AFTER) {
      if (paidTriggered && !st.paidAttempted) { await sleep(150); continue; }
      if (!st.voucher) {
        try {
          const r = await fetch(`${FREE_ADDR_API}?address=${st.address}`, { signal: AbortSignal.timeout(4500) });
          const j = await r.json().catch(() => null);
          const src = j?.voucher || j?.data || j;
          const dl = src?.deadline ?? j?.deadline;
          const sig = src?.sig ?? src?.signature ?? j?.sig ?? j?.signature;
          if (r.status === 200 && dl && sig) {
            const rec = ethers.verifyTypedData(domain, { FreeClaim: [{ name: "user", type: "address" }, { name: "deadline", type: "uint256" }] }, { user: st.address, deadline: BigInt(dl) }, sig);
            if (rec.toLowerCase() === EXPECTED_SIGNER.toLowerCase()) st.voucher = { deadline: BigInt(dl), sig };
          }
        } catch {}
      }
      if (st.voucher) {
        await withTxLock(st, async () => {
          if (st.freeDone || shuttingDown) return;
          const res = await sendBawTx(st, "claimFree", MINT_ADDR, mintIface.encodeFunctionData("claimFree", [st.voucher.deadline, st.voucher.sig]), 0n);
          if (res.ok || await minter.hasClaimedFree(st.address).catch(() => false)) st.freeDone = true;
        });
      }
      const rem = MINT_START - chainNowSec();
      await sleep(rem > FAST_SEC ? 1000 : rem > -25 ? 250 : 600);
    }
  })) : Promise.resolve();

  // Paid 1-min watcher
  while (!paidTriggered && !latestOpened && chainNowSec() <= MINT_START + PAID_WINDOW_SEC) {
    if (chainNowSec() >= MINT_START) {
      const [soldBn, op] = await Promise.all([minter.sharesSold().catch(() => 0n), minter.opened().catch(() => false)]);
      latestSold = Math.max(latestSold, Number(soldBn));
      if (op) { latestOpened = true; openResolve?.("poll"); break; }
      if (latestSold >= PAID_TRIGGER) { wssPaidHook(latestSold, chainNowSec() - MINT_START); break; }
    }
    await sleep(400);
  }
  paidWindowClosed = true;
  if (paidFirePromise) await paidFirePromise;

  // Refresh paid exposure (free shares stay 100% manual)
  for (const st of states) {
    const ms = Number(await minter.mintedShares(st.address).catch(() => BigInt(st.paidShares)));
    st.paidShares = ms;
    st.paidRemainWei = BigInt(ms) * TOKENS_PER_SHARE_WEI;
  }
  const activeHolders = states.filter((s) => s.paidShares > 0);
  if (!activeHolders.length) {
    await freePromise;
    await saveAndExit("FREE_ONLY_OR_SKIPPED", null);
    return;
  }

  // Wait for pool open -> claimTokens -> Flat-Open Play 1 (paid shares only)
  let [r0, r1] = await pairC.getReserves().catch(() => [0n, 0n]);
  let rTok = Number(ethers.formatUnits(isTok0 ? r0 : r1, 18));
  let rBnb = Number(ethers.formatUnits(isTok0 ? r1 : r0, 18));
  while (!(latestOpened && rTok > 0 && rBnb > 0)) {
    await Promise.race([sleep(600), openPromise]);
    latestOpened = Boolean(await minter.opened().catch(() => false));
    [r0, r1] = await pairC.getReserves().catch(() => [0n, 0n]);
    rTok = Number(ethers.formatUnits(isTok0 ? r0 : r1, 18));
    rBnb = Number(ethers.formatUnits(isTok0 ? r1 : r0, 18));
  }

  const openWallMs = Date.now();
  const fState = makeFreshFlatState(rBnb, rTok, (rBnb / rTok) / REF_PRICE_BNB);
  for (const st of activeHolders) ensureTokensClaimed(st).catch(() => {});

  let evalBusy = false, evalPending = false, finished = false;
  async function evalLoop() {
    if (finished) return;
    if (evalBusy) { evalPending = true; return; }
    evalBusy = true;
    try {
      do {
        evalPending = false;
        const sec = (Date.now() - openWallMs) / 1000;
        const { actions } = decideFlatOpenActions(fState, sec, activeHolders.length, P1);
        for (const a of actions) {
          if (a.type === "SELL_ALL_STOP" || a.type === "SELL_REST") {
            await emitAlert(a.type, `${TAG} ${a.reason}，清仓付费份额`, { curX: Number(fState.currentX.toFixed(3)) });
            await Promise.all(activeHolders.filter((h) => !h.soldOut).map((h) => sellPaidFraction(h, 100, a.reason)));
          } else if (a.type === "SELL_WALLET_IDX" && activeHolders[a.idx] && !activeHolders[a.idx].soldOut) {
            await emitAlert("TP", `${TAG} ${a.tag}`, { curX: Number(fState.currentX.toFixed(3)) });
            await sellPaidFraction(activeHolders[a.idx], a.pct, a.tag);
          } else {
            await emitAlert(a.type, `${TAG} ${fState.currentX.toFixed(3)}x`, { score: a.sc.score });
          }
        }
        if (fState.stage >= 3 && activeHolders.every((h) => h.soldOut)) finished = true;
      } while (evalPending && !finished);
    } finally { evalBusy = false; }
  }

  const seen = new Set();
  const onSwap = async (lg) => {
    const key = `${lg.transactionHash}:${lg.index ?? lg.logIndex ?? 0}`;
    if (finished || seen.has(key)) return;
    seen.add(key);
    let parsed; try { parsed = pairIface.parseLog(lg); } catch { return; }
    if (!parsed || parsed.name !== "Swap") return;
    const a0In = Number(ethers.formatUnits(parsed.args.amount0In, 18));
    const a1In = Number(ethers.formatUnits(parsed.args.amount1In, 18));
    const a0Out = Number(ethers.formatUnits(parsed.args.amount0Out, 18));
    const a1Out = Number(ethers.formatUnits(parsed.args.amount1Out, 18));
    const bnbIn = isTok0 ? a1In : a0In, tokOut = isTok0 ? a0Out : a1Out;
    const tokIn = isTok0 ? a0In : a1In, bnbOut = isTok0 ? a1Out : a0Out;
    if (bnbIn > 0 && tokOut > 0) {
      fState.buyCount++; fState.buyBnb += bnbIn; fState.netInflowBnb += bnbIn;
      if (bnbIn > fState.maxSingleBuyBnb) fState.maxSingleBuyBnb = bnbIn;
      if (bnbIn >= P1.bigBuyP1) { fState.bigBuyCount++; fState.bigBuyBnb += bnbIn; fState.bigBuyers.add(String(parsed.args.to || "").toLowerCase()); }
      fState.rBnb += bnbIn; fState.rTok = Math.max(1, fState.rTok - tokOut);
    } else if (tokIn > 0 && bnbOut > 0) {
      fState.sellCount++; fState.sellBnb += bnbOut; fState.netInflowBnb -= bnbOut;
      if (bnbOut >= P1.bigBuyP1) { fState.bigSellCount++; fState.bigSellBnb += bnbOut; }
      fState.rBnb = Math.max(0.0001, fState.rBnb - bnbOut); fState.rTok += tokIn;
    }
    fState.currentX = (fState.rBnb / fState.rTok) / REF_PRICE_BNB;
    await evalLoop();
  };
  swapHandlers.push((lg) => onSwap(lg).catch(() => {}));

  while (!finished && (Date.now() - openWallMs) / 1000 < (P1.maxWatchSec || 5400)) {
    try {
      const [nr0, nr1] = await pairC.getReserves();
      const nt = Number(ethers.formatUnits(isTok0 ? nr0 : nr1, 18));
      const nb = Number(ethers.formatUnits(isTok0 ? nr1 : nr0, 18));
      if (nt > 0 && nb > 0) { fState.rTok = nt; fState.rBnb = nb; fState.currentX = (nb / nt) / REF_PRICE_BNB; }
      await evalLoop();
    } catch {}
    await sleep(2000);
  }
  await saveAndExit(finished ? "ALL_EXITED" : "MAX_DURATION", fState);

  async function saveAndExit(reason, fsSt) {
    shuttingDown = true;
    if (wsProvider) { try { wsProvider.destroy(); } catch {} }
    for (const st of states) {
      await revokeRouterIfNeeded(st).catch(() => {});
      if (st.worker) st.worker.kill();
    }
    fs.writeFileSync(RESULTS_PATH, JSON.stringify({ finishedAt: bjTime(), reason, paidTriggered, latestSold, stage: fsSt?.stage ?? null }, null, 2));
    log(`=== FINISHED (${reason}) ===`);
    process.exit(0);
  }
}

main().catch((e) => { console.error("FATAL:", e.stack || e.message || e); process.exit(1); });
