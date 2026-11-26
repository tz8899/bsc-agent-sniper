#!/usr/bin/env node
/**
 * hold_engine.mjs — BSC「平开盘不秒卖」标准 4 步闭环引擎
 *
 * 所有钱包与 RPC 均从 config/wallets.json 与 config/rpc_live.json 动态读取，零硬编码隐私。
 *
 * 标准 4 步闭环：
 *   Step 1 [只授 DEX，不授私钥 BS2 + 盘前绑返佣]
 *     - 预热全部参与钱包的常驻 bawworker（零冷启动延迟）
 *     - 可选盘前自动将 2-N 号绑定到 1 号推荐人吃返佣压低成本
 *     - 盘前精确双授权 V2R (PancakeSwap V2 Router) + FLASH (币安闪兑)，绝不授 BS2/BS3
 *   Step 2 [确认热度才进]
 *     - entryMode="heat"        : 开打 1 分钟纯链上进度过阈值（如 60% / 75%）自动全号并发拉满；未达标自动撤权退出
 *     - entryMode="manual"      : 预热待命，收到口令指令 BUY_NOW 后 10 秒内并发打满
 *     - entryMode="already_held": 跳过铸造，直接进入 Step 3 盯盘与退出控制
 *   Step 3 [开盘后绝不盲卖（两种模式任选）]
 *     - 自动监听开池，若配置 claim / claimRef 自动第一时间领币与领返佣进钱包
 *     - WSS 逐笔 Swap + 2s 储备兜底，实时汇报池子 BNB、净流入、现价倍数与估算市值
 *     - exitMode="manual"（默认 · 纯听口令）: 绝不擅自卖单；写入指令 SELL_ALL 后 3 秒内并发通过 V2R 砸光
 *     - exitMode="conditional"（条件单自动出）:
 *         * 分批出本留利润飞（如 1.5x 卖 67% 出本 + 2.0x 再出一半留尾仓，或按号分层止盈）
 *         * 目标市值全清（targetMcUsd）
 *         * 开盘超 N 分钟不拉自动全清（stallExit，如 300s 内高点不足 1.15x）
 *         * 可选硬止损线（stopX），且中途随时支持写入 SELL_ALL 一键强清
 *   Step 4 [卖完自动清零授权 + 实收盈亏总账]
 *     - 清仓确认上链（或未触发放弃退出）后，自动把所有参与号的 V2R / FLASH 授权撤回 0
 *     - 输出全口径实收盈亏总账（含铸造、返佣、卖出与全部 Gas）至 logs/<name>.report.json
 *
 * 用法：
 *   node scripts/hold_engine.mjs --self-test
 *   node scripts/hold_engine.mjs --config config/cfg.hold.example.json --dry-run
 *   node scripts/hold_engine.mjs --config config/cfg.myproject.hold.local.json
 *
 * 运行时口令控制（写入 logs/<name>.cmd，引擎 250ms 内响应并清空）：
 *   BUY_NOW              # 尾盘听口令一键 10 秒全号并发打满
 *   SELL_ALL             # 喊一声清仓，3 秒内全号并发走 V2R 砸光
 *   SELL_PCT 50          # 全号各卖当前余额的 50%
 *   SELL_WALLETS 1,2     # 指定钱包编号（如 1,2 或 acc1,acc2）清仓
 *   ABORT                # 立即停止并自动撤回全部 V2R + FLASH 授权退出
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

const ARGV = process.argv.slice(2).map((s) => s.trim());
const hasFlag = (k) => ARGV.includes(k);
const getOpt = (k, def = null) => {
  const i = ARGV.indexOf(k);
  return i >= 0 && ARGV[i + 1] !== undefined && !ARGV[i + 1].startsWith("--") ? ARGV[i + 1] : def;
};

// ------------------------------------------------------------ Pure Helpers (Unit-Testable)
function computeSellAmount(balWei, pct) {
  if (balWei <= 0n) return 0n;
  const clamped = Math.min(100, Math.max(0, Number(pct)));
  if (clamped <= 0) return 0n;
  if (clamped >= 100) return balWei;
  return (balWei * BigInt(Math.round(clamped * 100))) / 10000n;
}

function evaluateConditionalRules({ curX, highX, mcUsd, openAgeSec, tpRules, targetMcUsd, stallExit, stopX }) {
  const actions = [];
  for (const rule of tpRules || []) {
    if (!rule.fired && curX >= Number(rule.atX)) {
      actions.push({ type: "TP_RULE", rule });
    }
  }
  if (targetMcUsd > 0 && mcUsd >= targetMcUsd) {
    actions.push({ type: "TARGET_MC_ALL", mcUsd });
    return actions;
  }
  if (stallExit && openAgeSec >= Number(stallExit.afterSec) && highX < Number(stallExit.minX || 1.15)) {
    actions.push({ type: "STALL_EXIT_ALL", openAgeSec, highX });
    return actions;
  }
  if (stopX > 0 && curX <= stopX) {
    actions.push({ type: "STOP_LOSS_ALL", curX });
    return actions;
  }
  return actions;
}

function parseCmdLines(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const [op, ...rest] = line.split(/\s+/);
      return { op: op.toUpperCase(), arg: rest.join(" ") };
    });
}

// ------------------------------------------------------------ Offline Self-Test
if (hasFlag("--self-test")) {
  const assert = (ok, msg) => { if (!ok) throw new Error("FAIL: " + msg); };
  assert(computeSellAmount(10000n, 100) === 10000n, "100% sells full balance");
  assert(computeSellAmount(10000n, 67) === 6700n, "67% sells 6700");
  assert(computeSellAmount(10000n, 50) === 5000n, "50% sells 5000");

  const rules = [
    { id: 0, atX: 1.5, sellPct: 67, label: "1.5x出本", fired: false },
    { id: 1, atX: 2.0, sellPct: 50, label: "2.0x留利润飞", fired: false },
  ];
  let acts = evaluateConditionalRules({ curX: 1.55, highX: 1.55, mcUsd: 50000, openAgeSec: 60, tpRules: rules, targetMcUsd: 200000, stallExit: { afterSec: 300, minX: 1.15 }, stopX: 0.75 });
  assert(acts.length === 1 && acts[0].type === "TP_RULE" && acts[0].rule.id === 0, "1.55x triggers 1.5x rule");
  rules[0].fired = true;

  acts = evaluateConditionalRules({ curX: 2.05, highX: 2.05, mcUsd: 80000, openAgeSec: 120, tpRules: rules, targetMcUsd: 200000, stallExit: { afterSec: 300, minX: 1.15 }, stopX: 0.75 });
  assert(acts.length === 1 && acts[0].type === "TP_RULE" && acts[0].rule.id === 1, "2.05x triggers 2.0x rule");
  rules[1].fired = true;

  acts = evaluateConditionalRules({ curX: 1.05, highX: 1.10, mcUsd: 30000, openAgeSec: 305, tpRules: [], targetMcUsd: 0, stallExit: { afterSec: 300, minX: 1.15 }, stopX: 0 });
  assert(acts.some((a) => a.type === "STALL_EXIT_ALL"), "stallExit triggers after 300s below 1.15x");

  acts = evaluateConditionalRules({ curX: 2.5, highX: 2.5, mcUsd: 250000, openAgeSec: 90, tpRules: [], targetMcUsd: 200000, stallExit: null, stopX: 0 });
  assert(acts.some((a) => a.type === "TARGET_MC_ALL"), "targetMcUsd triggers full exit");

  const cmds = parseCmdLines("SELL_PCT 50\nSELL_WALLETS 1,2\nSELL_ALL");
  assert(cmds.length === 3 && cmds[0].op === "SELL_PCT" && cmds[0].arg === "50" && cmds[2].op === "SELL_ALL", "cmd parser ok");

  console.log("ALL HOLD_ENGINE SELF-TESTS PASSED");
  process.exit(0);
}

if (hasFlag("--help") || hasFlag("-h") || !getOpt("--config")) {
  console.log(`用法: node scripts/hold_engine.mjs --config <cfg.hold.json> [--dry-run] | --self-test

指令文件控制 (logs/<name>.cmd):
  BUY_NOW                  # 尾盘听口令一键 10s 全号并发打满
  SELL_ALL                 # 喊一声清仓，3s 内全号并发走 V2R 砸光
  SELL_PCT <1-100>         # 全号按当前余额卖出指定百分比
  SELL_WALLETS <1,2>       # 指定账号清仓（按 wallets.json 键名或 accN）
  ABORT                    # 放弃退出并自动清零全部 V2R + FLASH 授权`);
  process.exit(hasFlag("--help") || hasFlag("-h") ? 0 : 1);
}

const DRY_RUN = hasFlag("--dry-run");
const CFG = JSON.parse(fs.readFileSync(getOpt("--config"), "utf8"));

let ethers;
try {
  ({ ethers } = require("ethers"));
} catch {
  ({ ethers } = require(path.join(ROOT, "lib", "ethers.cjs")));
}

const ROUTER_ADDR  = "0x10ED43C718714eb63d5aA57B78B54704E256024E";
const FLASH_ADDR   = "0xb300000b72deaeb607a12d5f54773d1c19c7028d";
const WBNB_ADDR    = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";
const USDT_ADDR    = "0x55d398326f99059fF775485246999027B3197955";
const FACTORY_ADDR = "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73";
const SWAP_TOPIC   = ethers.id("Swap(address,uint256,uint256,uint256,uint256,address)");

const WCFG = loadWallets(true);
const BAW_CFG = WCFG.baw || {};
const BAW_BASE = path.resolve(ROOT, process.env.BAW_DIR || BAW_CFG.dir || "./baw");
const ACC_KEYS = Array.isArray(CFG.wallets)
  ? CFG.wallets.map(String)
  : String(CFG.acc || Object.keys(WCFG.accounts).join("")).split("");

const WALLET_DEFS = ACC_KEYS.map((k) => {
  const key = k.replace(/^acc/i, "");
  const raw = WCFG.accounts[key] || WCFG.accounts[k];
  if (!raw) throw new Error(`config/wallets.json 中缺少账号 "${k}"`);
  const ov = (BAW_CFG.overrides && (BAW_CFG.overrides[key] || BAW_CFG.overrides[k])) || {};
  return {
    key,
    name: `acc${key}`,
    dir: ov.dir ? path.resolve(ROOT, ov.dir) : path.join(BAW_BASE, `acc${key}`),
    home: ov.home ? path.resolve(ROOT, ov.home) : null,
    address: ethers.getAddress(raw.startsWith("0x") ? raw : "0x" + raw),
  };
});

const NAME        = String(CFG.name || "project").replace(/[^a-zA-Z0-9_-]/g, "");
const LOG_DIR     = CFG.logDir ? path.resolve(ROOT, CFG.logDir) : path.join(ROOT, "logs");
const CMD_FILE    = path.join(LOG_DIR, `${NAME}.cmd`);
const STATUS_FILE = path.join(LOG_DIR, `${NAME}.status.json`);
const REPORT_FILE = path.join(LOG_DIR, `${NAME}.report.json`);

const TOKEN_ADDR        = ethers.getAddress(CFG.token);
const SALE_ADDR         = CFG.sale ? ethers.getAddress(CFG.sale) : null;
const ENTRY_MODE        = (CFG.entryMode || "manual").toLowerCase(); // heat | manual | already_held
const EXIT_MODE         = (CFG.exitMode || "manual").toLowerCase();  // manual | conditional
const SELL_TAX_PCT      = Number(CFG.sellTaxPct ?? 3);
const SLIPPAGE_PCT      = Number(CFG.slippagePct ?? 15);
const PRE_APPROVE_FLASH = CFG.preApproveFlash !== false;             // 默认 V2R + FLASH 双精确预授权，绝不授 BS2
const MAX_HOURS         = Number(CFG.maxHours ?? 12);

const RPCS = loadRpcs();
const provider = new ethers.JsonRpcProvider(RPCS.http[0], 56, { staticNetwork: true });

const ercIface = new ethers.Interface([
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);
const pairIface = new ethers.Interface([
  "function token0() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
  "event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)",
]);
const factoryIface = new ethers.Interface(["function getPair(address,address) view returns (address)"]);
const routerIface = new ethers.Interface([
  "function getAmountsOut(uint256,address[]) view returns (uint256[])",
  "function swapExactTokensForETHSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);

const tokC     = new ethers.Contract(TOKEN_ADDR, ercIface, provider);
const factoryC = new ethers.Contract(FACTORY_ADDR, factoryIface, provider);
const routerC  = new ethers.Contract(ROUTER_ADDR, routerIface, provider);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let clockOffMs = 0;
const chainNowMs  = () => Date.now() + clockOffMs;
const chainNowSec = () => chainNowMs() / 1000;
const bjTime = (ms = chainNowMs()) => new Date(ms + 8 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 23) + " +08";
const log = (m) => console.log(`[${bjTime()}] ${m}`);

async function syncClock() {
  const b = await provider.getBlock("latest").catch(() => null);
  if (b?.timestamp) clockOffMs = b.timestamp * 1000 - Date.now();
}

function checkBaw(w) {
  try {
    const env = { ...process.env, BINANCE_BAW_DIR: w.dir };
    if (w.home) env.HOME = w.home;
    const out = execFileSync("baw", ["wallet", "status", "--json"], { env, encoding: "utf8", timeout: 12000 });
    return JSON.parse(out)?.data?.status || "UNKNOWN";
  } catch { return "ERR"; }
}

function spawnWorker(w) {
  const env = { ...process.env, BINANCE_BAW_DIR: w.dir, WID: `hold_${NAME}_${w.key}` };
  if (w.home) env.HOME = w.home;
  const child = spawn(process.execPath, [path.join(HERE, "bawworker.mjs")], { env, stdio: ["pipe", "pipe", "pipe"] });
  let seq = 1, readyRes;
  const pending = new Map();
  const ready = new Promise((r) => (readyRes = r));
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let m; try { m = JSON.parse(line); } catch { return; }
    if (m.ready) { readyRes(true); return; }
    const cb = pending.get(m.id);
    if (cb) { pending.delete(m.id); cb(m); }
  });
  const call = (op, body, timeoutMs = 18000) => new Promise((res) => {
    const id = seq++;
    const t = setTimeout(() => { pending.delete(id); res({ success: false, error: { message: "timeout" } }); }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    child.stdin.write(JSON.stringify({ id, op, body }) + "\n");
  });
  return { ready, call, kill: () => { try { child.kill(); } catch {} } };
}

async function sendTx(st, label, to, data, valueWei = 0n) {
  if (DRY_RUN) {
    log(`[DRY-RUN][${st.name} ${label}] to=${to} val=${ethers.formatEther(valueWei)} data=${data.slice(0, 18)}...`);
    return { ok: true, txHash: "0xDRY_RUN" };
  }
  const t0 = Date.now();
  const prev = await st.worker.call("preview", { binanceChainId: "56", from: st.address, to, value: valueWei.toString(), inputData: data }, 15000);
  if (!prev.success || !prev.data?.requestId) {
    return { ok: false, err: JSON.stringify(prev.error || prev).slice(0, 180) };
  }
  const ex = await st.worker.call("execute", { requestId: prev.data.requestId }, 20000);
  const txHash = ex.data?.txHash || ex.data?.transactionHash || ex.data?.hash;
  if (!ex.success || !txHash) {
    return { ok: false, err: JSON.stringify(ex.error || ex).slice(0, 180) };
  }
  log(`[${st.name} ${label}] SENT (${Date.now() - t0}ms) tx=${txHash}`);
  const rcpt = await provider.waitForTransaction(txHash, 1, 45000).catch(() => null);
  return { ok: rcpt?.status === 1, txHash, rcpt };
}

function pollCmds() {
  if (!fs.existsSync(CMD_FILE)) return null;
  const raw = fs.readFileSync(CMD_FILE, "utf8").trim();
  if (!raw) return null;
  try { fs.writeFileSync(CMD_FILE, ""); } catch {}
  return parseCmdLines(raw);
}

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  if (fs.existsSync(CMD_FILE)) fs.writeFileSync(CMD_FILE, "");
  await syncClock();

  const states = WALLET_DEFS.map((w) => ({
    ...w, worker: null, bnbStart: 0n, bought: false, claimed: false, soldAll: false, selling: false, txLog: [],
  }));

  const [decimals, totalSupplyRaw] = await Promise.all([
    tokC.decimals().catch(() => 18),
    tokC.totalSupply().catch(() => 0n),
  ]);
  const DEC = Number(decimals);
  const TOTAL_SUPPLY = Number(ethers.formatUnits(totalSupplyRaw, DEC));
  const expectedPerWalletWei = ethers.parseUnits(String(CFG.expectedTokensPerWallet || "0"), DEC);
  const refPriceBnb = CFG.costPerWalletBnb && CFG.expectedTokensPerWallet
    ? Number(CFG.costPerWalletBnb) / Number(CFG.expectedTokensPerWallet)
    : Number(CFG.refPriceBnb || 0);

  log(`========================================================================`);
  log(`HOLD ENGINE [${NAME}] | entry=${ENTRY_MODE} | exit=${EXIT_MODE} | dry=${DRY_RUN}`);
  log(`Wallets=${states.map((s) => s.name).join(",")} | Token=${TOKEN_ADDR} | PreApprove=V2R${PRE_APPROVE_FLASH ? "+FLASH" : ""} (NO BS2/BS3)`);
  log(`Command file: ${CMD_FILE}`);
  log(`========================================================================`);

  // Step 1: Pre-warm bawworkers + optional ref binding (2..N -> 1) + exact V2R & FLASH pre-approve
  await Promise.all(states.map(async (st) => {
    st.bnbStart = await provider.getBalance(st.address);
    if (!DRY_RUN) {
      st.worker = spawnWorker(st);
      await st.worker.ready;
    }
    log(`[${st.name}] ready | startBNB=${ethers.formatEther(st.bnbStart)}`);
  }));

  if (CFG.refBind?.to && CFG.refBind?.abi && CFG.refBind?.fn) {
    const refIface = new ethers.Interface([CFG.refBind.abi]);
    const refTarget = ethers.getAddress(CFG.refBind.referrer || states[0].address);
    const refContract = ethers.getAddress(CFG.refBind.to);
    const data = refIface.encodeFunctionData(CFG.refBind.fn, [refTarget]);
    await Promise.all(states.slice(1).map(async (st) => {
      if (CFG.refBind.checkAbi && CFG.refBind.checkFn) {
        const chkC = new ethers.Contract(refContract, [CFG.refBind.checkAbi], provider);
        const cur = await chkC[CFG.refBind.checkFn](st.address).catch(() => ethers.ZeroAddress);
        if (cur && cur !== ethers.ZeroAddress) {
          log(`[${st.name}] Referrer already bound: ${cur}`);
          return;
        }
      }
      const r = await sendTx(st, "bindRef", refContract, data);
      st.txLog.push({ step: "bindRef", ...r });
    }));
  }

  if (expectedPerWalletWei > 0n) {
    const spenders = PRE_APPROVE_FLASH ? [["V2R", ROUTER_ADDR], ["FLASH", FLASH_ADDR]] : [["V2R", ROUTER_ADDR]];
    await Promise.all(states.map(async (st) => {
      const bal = await tokC.balanceOf(st.address).catch(() => 0n);
      const targetAmt = bal > expectedPerWalletWei ? bal : expectedPerWalletWei;
      for (const [spName, spAddr] of spenders) {
        const alw = await tokC.allowance(st.address, spAddr).catch(() => 0n);
        if (alw < targetAmt) {
          const r = await sendTx(st, `preApprove_${spName}`, TOKEN_ADDR, ercIface.encodeFunctionData("approve", [spAddr, targetAmt]));
          st.txLog.push({ step: `preApprove_${spName}`, ...r });
        } else {
          log(`[${st.name}] ${spName} already approved (${ethers.formatUnits(alw, DEC)})`);
        }
      }
    }));
  }

  let stopping = false;
  let wsProvider = null;

  async function cleanupAndExit(reason) {
    if (stopping) return;
    stopping = true;
    if (wsProvider) { try { wsProvider.destroy(); } catch {} }

    // Step 4: Auto-revoke ALL V2R & FLASH residual allowances back to 0 + full realized PnL ledger
    log(`=== STEP 4: Revoking ALL V2R & FLASH allowances (${reason}) ===`);
    await Promise.all(states.map(async (st) => {
      for (const [spName, spAddr] of [["V2R", ROUTER_ADDR], ["FLASH", FLASH_ADDR]]) {
        const alw = await tokC.allowance(st.address, spAddr).catch(() => 0n);
        if (alw > 0n) {
          const r = await sendTx(st, `revoke_${spName}`, TOKEN_ADDR, ercIface.encodeFunctionData("approve", [spAddr, 0n]));
          st.txLog.push({ step: `revoke_${spName}`, ...r });
        }
      }
    }));

    const bnbUsdArr = await routerC.getAmountsOut(ethers.parseEther("1"), [WBNB_ADDR, USDT_ADDR]).catch(() => null);
    const bnbUsd = bnbUsdArr ? Number(ethers.formatUnits(bnbUsdArr[1], 18)) : 540;

    let totDeltaBnb = 0;
    const summaryWallets = [];
    for (const st of states) {
      if (st.worker) st.worker.kill();
      const [bnbEnd, tokEnd, alwV2, alwFl] = await Promise.all([
        provider.getBalance(st.address).catch(() => st.bnbStart),
        tokC.balanceOf(st.address).catch(() => 0n),
        tokC.allowance(st.address, ROUTER_ADDR).catch(() => 0n),
        tokC.allowance(st.address, FLASH_ADDR).catch(() => 0n),
      ]);
      const deltaBnb = Number(ethers.formatEther(bnbEnd - st.bnbStart));
      totDeltaBnb += deltaBnb;
      summaryWallets.push({
        name: st.name,
        address: st.address,
        bnbStart: Number(ethers.formatEther(st.bnbStart)).toFixed(6),
        bnbEnd: Number(ethers.formatEther(bnbEnd)).toFixed(6),
        netBnbDelta: Number(deltaBnb.toFixed(6)),
        netUsdDelta: Number((deltaBnb * bnbUsd).toFixed(2)),
        remToken: ethers.formatUnits(tokEnd, DEC),
        allowV2R: ethers.formatUnits(alwV2, DEC),
        allowFLASH: ethers.formatUnits(alwFl, DEC),
        txLog: st.txLog,
      });
    }

    const report = {
      name: NAME,
      finishedAt: bjTime(),
      reason,
      bnbUsd: Number(bnbUsd.toFixed(2)),
      totalNetBnbDelta: Number(totDeltaBnb.toFixed(6)),
      totalNetUsdDelta: Number((totDeltaBnb * bnbUsd).toFixed(2)),
      wallets: summaryWallets,
    };
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));
    log(`=== STEP 4 REALIZED LEDGER (${reason}) | TOTAL=${totDeltaBnb >= 0 ? "+" : ""}${totDeltaBnb.toFixed(6)} BNB ($${(totDeltaBnb * bnbUsd).toFixed(2)}) ===`);
    console.log(JSON.stringify(report, null, 2));
    process.exit(0);
  }

  // Step 2: Confirm heat OR wait for manual BUY_NOW command
  async function executeBuyAll(tag) {
    if (!SALE_ADDR || !CFG.mint?.calldata) {
      log(`[buy] Missing sale or mint.calldata in config!`);
      return false;
    }
    const valWei = ethers.parseEther(String(CFG.mint.valueBnb || "0"));
    log(`🚀 [STEP 2 ${tag}] Firing concurrent mint across ${states.length} wallets (val=${ethers.formatEther(valWei)} BNB each)...`);
    const rs = await Promise.all(states.map(async (st) => {
      if (st.bought) return { ok: true };
      const data = typeof CFG.mint.calldata === "string"
        ? CFG.mint.calldata
        : CFG.mint.calldata[st.key] || CFG.mint.calldata[st.name] || CFG.mint.calldata.default;
      const r = await sendTx(st, "mint", SALE_ADDR, data, valWei);
      st.txLog.push({ step: "mint", ...r });
      if (r.ok) st.bought = true;
      return r;
    }));
    const okCount = rs.filter((x) => x.ok).length;
    log(`✅ [STEP 2] Mint complete: ${okCount}/${states.length} succeeded.`);
    return okCount > 0;
  }

  if (ENTRY_MODE === "heat") {
    const startTs = Number(CFG.heat?.startTs || 0);
    const windowSec = Number(CFG.heat?.windowSec || 60);
    const targetPct = Number(CFG.heat?.thresholdPct || 60);
    const totalShares = Number(CFG.heat?.totalShares || 10000);
    const saleRead = new ethers.Contract(SALE_ADDR, [CFG.heat.progressAbi], provider);
    const progFn = CFG.heat.progressFn;

    log(`[STEP 2 heat] Waiting for launchTs=${startTs} (${bjTime(startTs * 1000)}), window=${windowSec}s, threshold>=${targetPct}%...`);
    let boughtAny = false;
    while (!stopping) {
      const cmds = pollCmds();
      if (cmds?.some((c) => c.op === "ABORT")) return cleanupAndExit("USER_ABORT_BEFORE_BUY");
      if (cmds?.some((c) => c.op === "BUY_NOW")) { boughtAny = await executeBuyAll("MANUAL_OVERRIDE"); break; }

      const nowS = chainNowSec();
      if (nowS >= startTs - 1) {
        const cur = Number(await saleRead[progFn]().catch(() => 0));
        const pct = (cur / totalShares) * 100;
        log(`[heat] ${Math.max(0, nowS - startTs).toFixed(1)}s | progress=${cur}/${totalShares} (${pct.toFixed(2)}%)`);
        if (pct >= targetPct) {
          boughtAny = await executeBuyAll(`HEAT_${pct.toFixed(1)}PCT`);
          break;
        }
        if (nowS > startTs + windowSec) {
          log(`[heat] Window ${windowSec}s ended at ${pct.toFixed(2)}% (< ${targetPct}%) — skipping & revoking!`);
          return cleanupAndExit(`HEAT_MISSED_${pct.toFixed(1)}PCT`);
        }
        await sleep(800);
      } else {
        await sleep(Math.min(2000, Math.max(200, (startTs - 2 - nowS) * 1000)));
      }
    }
    if (!boughtAny) return cleanupAndExit("BUY_FAILED");
  } else if (ENTRY_MODE === "manual") {
    log(`[STEP 2 manual] Pre-warmed & pre-approved! Waiting for BUY_NOW in ${CMD_FILE} (or ABORT)...`);
    let boughtAny = false;
    while (!stopping) {
      const cmds = pollCmds();
      if (cmds?.some((c) => c.op === "ABORT")) return cleanupAndExit("USER_ABORT_BEFORE_BUY");
      if (cmds?.some((c) => c.op === "BUY_NOW")) { boughtAny = await executeBuyAll("MANUAL_CMD"); break; }
      await sleep(250);
    }
    if (!boughtAny) return cleanupAndExit("BUY_FAILED");
  } else {
    log(`[STEP 2 already_held] Skipping mint, entering Step 3 directly.`);
  }

  // Step 3: Post-open auto-claim + live flow monitor + manual/conditional exit
  let pairAddr = CFG.pair ? ethers.getAddress(CFG.pair) : ethers.ZeroAddress;
  log(`[STEP 3] Waiting for PancakeV2 pool open...`);
  let pairC = null, isTok0 = true, initLpBnb = 0, openMs = 0;

  while (!stopping) {
    const cmds = pollCmds();
    if (cmds?.some((c) => c.op === "ABORT")) return cleanupAndExit("USER_ABORT_PRE_OPEN");
    if (pairAddr === ethers.ZeroAddress) {
      pairAddr = await factoryC.getPair(TOKEN_ADDR, WBNB_ADDR).catch(() => ethers.ZeroAddress);
    }
    if (pairAddr && pairAddr !== ethers.ZeroAddress) {
      pairC = new ethers.Contract(pairAddr, pairIface, provider);
      const [t0, res] = await Promise.all([pairC.token0(), pairC.getReserves()]).catch(() => [null, null]);
      if (t0 && res && res[0] > 0n && res[1] > 0n) {
        isTok0 = t0.toLowerCase() === TOKEN_ADDR.toLowerCase();
        initLpBnb = Number(ethers.formatEther(isTok0 ? res[1] : res[0]));
        openMs = Date.now();
        log(`🟢 [STEP 3] POOL OPEN! pair=${pairAddr} | initLP=${initLpBnb.toFixed(3)} BNB`);
        break;
      }
    }
    await sleep(600);
  }

  if (CFG.claim?.to && CFG.claim?.calldata) {
    const claimTo = ethers.getAddress(CFG.claim.to);
    await Promise.all(states.map(async (st) => {
      const r = await sendTx(st, "claimTokens", claimTo, CFG.claim.calldata);
      st.txLog.push({ step: "claimTokens", ...r });
      st.claimed = r.ok;
    }));
  }
  if (CFG.claimRef?.to && CFG.claimRef?.calldata) {
    const r = await sendTx(states[0], "claimRef", ethers.getAddress(CFG.claimRef.to), CFG.claimRef.calldata);
    states[0].txLog.push({ step: "claimRef", ...r });
  }

  let rTok = 0, rBnb = initLpBnb, curX = 1, highX = 1, bnbUsd = 540;
  let refPrice = refPriceBnb;

  async function refreshState() {
    const [[r0, r1], bnbUsdtArr] = await Promise.all([
      pairC.getReserves(),
      routerC.getAmountsOut(ethers.parseEther("1"), [WBNB_ADDR, USDT_ADDR]).catch(() => null),
    ]);
    rTok = Number(ethers.formatUnits(isTok0 ? r0 : r1, DEC));
    rBnb = Number(ethers.formatEther(isTok0 ? r1 : r0));
    if (bnbUsdtArr) bnbUsd = Number(ethers.formatUnits(bnbUsdtArr[1], 18));
    if (rTok > 0 && rBnb > 0) {
      const spotBnb = rBnb / rTok;
      if (!refPrice) refPrice = spotBnb;
      curX = spotBnb / refPrice;
      if (curX > highX) highX = curX;
    }
  }
  await refreshState();

  async function sellWallets(targetStates, pct = 100, tag = "SELL") {
    await Promise.all(targetStates.map(async (st) => {
      if (st.selling || st.soldAll) return;
      st.selling = true;
      try {
        const bal = await tokC.balanceOf(st.address).catch(() => 0n);
        if (bal === 0n) { st.soldAll = true; return; }
        const amtIn = computeSellAmount(bal, pct);
        if (amtIn === 0n) return;
        const alw = await tokC.allowance(st.address, ROUTER_ADDR).catch(() => 0n);
        if (alw < amtIn) {
          await sendTx(st, "topupApprove_V2R", TOKEN_ADDR, ercIface.encodeFunctionData("approve", [ROUTER_ADDR, amtIn]));
        }
        for (const slip of [SLIPPAGE_PCT, Math.min(45, SLIPPAGE_PCT + 15)]) {
          const curBal = await tokC.balanceOf(st.address).catch(() => 0n);
          const sendAmt = curBal < amtIn ? curBal : amtIn;
          if (sendAmt === 0n) { st.soldAll = true; return; }
          let minOut = 0n;
          try {
            const q = await routerC.getAmountsOut((sendAmt * BigInt(100 - SELL_TAX_PCT)) / 100n, [TOKEN_ADDR, WBNB_ADDR]);
            minOut = (q[1] * BigInt(100 - slip)) / 100n;
          } catch {}
          const dl = BigInt(Math.floor(chainNowSec()) + 180);
          const data = routerIface.encodeFunctionData("swapExactTokensForETHSupportingFeeOnTransferTokens", [
            sendAmt, minOut, [TOKEN_ADDR, WBNB_ADDR], st.address, dl,
          ]);
          const r = await sendTx(st, `${tag}_${pct}pct`, ROUTER_ADDR, data);
          st.txLog.push({ step: `${tag}_${pct}pct`, spotX: Number(curX.toFixed(3)), ...r });
          if (r.ok) {
            const rem = await tokC.balanceOf(st.address).catch(() => 0n);
            if (rem === 0n) st.soldAll = true;
            return;
          }
          await sleep(500);
        }
      } finally {
        st.selling = false;
      }
    }));
  }

  function connectWss(idx = 0) {
    if (!RPCS.wss.length || stopping) return;
    try {
      wsProvider = new ethers.WebSocketProvider(RPCS.wss[idx % RPCS.wss.length], 56, { staticNetwork: true });
      wsProvider.on({ address: pairAddr, topics: [SWAP_TOPIC] }, (lg) => {
        try {
          const parsed = pairIface.parseLog(lg);
          if (!parsed || parsed.name !== "Swap") return;
          const a0In = Number(ethers.formatUnits(parsed.args.amount0In, isTok0 ? DEC : 18));
          const a1In = Number(ethers.formatUnits(parsed.args.amount1In, isTok0 ? 18 : DEC));
          const a0Out = Number(ethers.formatUnits(parsed.args.amount0Out, isTok0 ? DEC : 18));
          const a1Out = Number(ethers.formatUnits(parsed.args.amount1Out, isTok0 ? 18 : DEC));
          const bnbIn = isTok0 ? a1In : a0In, tokOut = isTok0 ? a0Out : a1Out;
          const tokIn = isTok0 ? a0In : a1In, bnbOut = isTok0 ? a1Out : a0Out;
          if (bnbIn > 0 && tokOut > 0) { rBnb += bnbIn; rTok = Math.max(1, rTok - tokOut); }
          else if (tokIn > 0 && bnbOut > 0) { rBnb = Math.max(0.0001, rBnb - bnbOut); rTok += tokIn; }
          if (rTok > 0 && refPrice > 0) {
            curX = (rBnb / rTok) / refPrice;
            if (curX > highX) highX = curX;
          }
        } catch {}
      });
      wsProvider.on("error", () => {});
      wsProvider.websocket?.addEventListener?.("error", () => {});
      wsProvider.websocket?.addEventListener?.("close", () => { if (!stopping) setTimeout(() => connectWss(idx + 1), 1500); });
    } catch {}
  }
  connectWss(0);

  const tpRules = (CFG.conditional?.tpRules || []).map((r, idx) => ({ ...r, id: idx, fired: false }));
  const targetMcUsd = Number(CFG.conditional?.targetMcUsd || 0);
  const stallExit = CFG.conditional?.stallExit || null;
  const stopX = Number(CFG.conditional?.stopX || 0);

  let lastLogMs = 0, lastReserveMs = 0, lastKaMs = Date.now();
  while (!stopping) {
    const cmds = pollCmds();
    if (cmds) {
      for (const c of cmds) {
        if (c.op === "ABORT") return cleanupAndExit("USER_ABORT");
        if (c.op === "SELL_ALL") {
          log(`⚡ [CMD] SELL_ALL — firing concurrent V2R dump across all wallets!`);
          await sellWallets(states, 100, "CMD_SELL_ALL");
          return cleanupAndExit("CMD_SELL_ALL_DONE");
        }
        if (c.op === "SELL_PCT") {
          const pct = Math.min(100, Math.max(1, Number(c.arg || 0)));
          log(`⚡ [CMD] SELL_PCT ${pct}%!`);
          await sellWallets(states, pct, "CMD_SELL_PCT");
        }
        if (c.op === "SELL_WALLETS") {
          const wanted = new Set(c.arg.split(",").map((s) => s.trim().toLowerCase()));
          const targets = states.filter((s) => wanted.has(s.key.toLowerCase()) || wanted.has(s.name.toLowerCase()));
          log(`⚡ [CMD] SELL_WALLETS ${targets.map((s) => s.name).join(",")}!`);
          await sellWallets(targets, 100, "CMD_SELL_W");
        }
      }
    }

    if (Date.now() - lastReserveMs >= 2000) {
      try {
        await refreshState();
        lastReserveMs = Date.now();
        const netInflowBnb = rBnb - initLpBnb;
        const mcUsd = TOTAL_SUPPLY > 0 && rTok > 0 ? (rBnb / rTok) * bnbUsd * TOTAL_SUPPLY : 0;
        const openAgeSec = (Date.now() - openMs) / 1000;

        fs.writeFileSync(STATUS_FILE, JSON.stringify({
          updatedAt: bjTime(),
          exitMode: EXIT_MODE,
          openAgeSec: Math.round(openAgeSec),
          spotX: Number(curX.toFixed(3)),
          highX: Number(highX.toFixed(3)),
          lpBnb: Number(rBnb.toFixed(3)),
          netInflowBnb: Number(netInflowBnb.toFixed(3)),
          estMcUsd: Math.round(mcUsd),
          wallets: states.map((s) => ({ name: s.name, soldAll: s.soldAll })),
        }, null, 2));

        if (Date.now() - lastLogMs >= 15000) {
          log(`[live ${Math.round(openAgeSec)}s] spot=${curX.toFixed(3)}x (H=${highX.toFixed(3)}x) | LP=${rBnb.toFixed(2)}BNB (net ${netInflowBnb >= 0 ? "+" : ""}${netInflowBnb.toFixed(2)}BNB) | MC=$${Math.round(mcUsd).toLocaleString()} | mode=${EXIT_MODE}`);
          lastLogMs = Date.now();
        }

        if (EXIT_MODE === "conditional") {
          const acts = evaluateConditionalRules({ curX, highX, mcUsd, openAgeSec, tpRules, targetMcUsd, stallExit, stopX });
          for (const a of acts) {
            if (a.type === "TP_RULE") {
              a.rule.fired = true;
              const targets = a.rule.wallets?.length
                ? states.filter((s) => a.rule.wallets.map(String).includes(s.key) || a.rule.wallets.map(String).includes(s.name))
                : states;
              log(`🎯 [TP RULE] ${a.rule.label || a.rule.atX + "x"} HIT (spot=${curX.toFixed(3)}x) -> selling ${a.rule.sellPct || 100}%`);
              await sellWallets(targets, Number(a.rule.sellPct || 100), `TP_${a.rule.atX}X`);
            } else if (a.type === "TARGET_MC_ALL") {
              log(`🎯 [MC EXIT] estMC=$${Math.round(mcUsd)} >= $${targetMcUsd} -> selling ALL!`);
              await sellWallets(states, 100, "TARGET_MC");
              return cleanupAndExit("TARGET_MC_HIT");
            } else if (a.type === "STALL_EXIT_ALL") {
              log(`⏱️ [STALL EXIT] Open ${Math.round(openAgeSec)}s, highX=${highX.toFixed(3)}x < ${stallExit.minX}x -> selling ALL!`);
              await sellWallets(states, 100, "STALL_EXIT");
              return cleanupAndExit("STALL_EXIT");
            } else if (a.type === "STOP_LOSS_ALL") {
              log(`🛑 [STOP LOSS] spot=${curX.toFixed(3)}x <= ${stopX}x -> selling ALL!`);
              await sellWallets(states, 100, "STOP_LOSS");
              return cleanupAndExit("STOP_LOSS");
            }
          }
        }

        if (states.every((s) => s.soldAll)) return cleanupAndExit("ALL_SOLD");
        if ((Date.now() - openMs) / 3600000 >= MAX_HOURS) return cleanupAndExit(`TIMEOUT_${MAX_HOURS}H`);
      } catch (e) {
        log(`[tick err] ${e.message || e}`);
      }
    }

    if (Date.now() - lastKaMs >= 25 * 60 * 1000) {
      await syncClock();
      log(`[KEEPALIVE] ${states.map((s) => `${s.name}:${checkBaw(s)}`).join(" ")}`);
      lastKaMs = Date.now();
    }

    await sleep(250);
  }
}

process.on("unhandledRejection", (e) => console.error("[unhandledRejection]", e?.message || e));
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

main().catch((e) => { console.error("FATAL:", e.stack || e.message || e); process.exit(1); });
