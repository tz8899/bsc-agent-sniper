# BSC Agent Sniper & Flat-Open Toolkit

一套面向 **BNB Smart Chain (BSC)** 的链上自动化打新、双通道秒卖、平开盘实时强弱监控与公平发射一体化工具箱。

> 本仓库基于开源项目 [`lyl0709/Py`](https://github.com/lyl0709/Py)（MIT License）的核心秒卖引擎（`gx.mjs`、`bawworker.mjs`、`BS.sol`、`BS3.sol`、`report.mjs`）扩展而来，新增了**平开盘不秒卖标准 4 步闭环引擎 `hold_engine.mjs`**、**60 秒实时强弱评分与右侧追多引擎 `flat_watch.mjs`** 及**免费抢 + 限期进度付费冲锋模板 `fairlaunch_master.mjs`**。

---

## 核心组件一览

```text
.
├── contracts/
│   ├── BS.sol                        # PancakeSwap V2 多钱包原子代卖合约（适合私钥自托管场景）
│   ├── BS3.sol                       # PancakeSwap V2 + V3 多钱包原子代卖合约
│   ├── compile.js / deploy.js        # solc 0.8.24 编译与 CREATE2 确定性部署脚本
├── scripts/
│   ├── gx.mjs                        # 模板 A（开盘秒卖）：定时/进度触发 + 盘前双预授权 + 币安闪兑/薄饼叠发双通道秒卖 + 块级战报
│   ├── hold_engine.mjs               # 模板 B（平开盘不秒卖 4 步闭环）：只授 V2R+FLASH 不授 BS2 + 绑返佣 + 热度/口令进场 + 纯听口令3秒清仓/条件单自动出 + 自动撤权总账
│   ├── flat_watch.mjs                # 平开盘链上监控引擎：60s 强弱打分 + 大单/净流入告警 + 平盘打法一/打法二(右侧追多)
│   ├── fairlaunch_master.mjs         # 一体化模板：免费 EIP-712 抢领（绝不自动卖）+ 限期达标付费满打 + 开盘自动 claimTokens
│   ├── bawworker.mjs                 # 常驻 Binance Agentic Wallet (baw) 子进程（复用连接降延迟）
│   ├── bs_sell.js / bs3_sell.js      # 独立触发 BS / BS3 批量代卖
│   ├── pkw_sell.js                   # 独立私钥钱包秒卖（可选开盘块+1 避税门控）
│   ├── rpc_health.mjs                # BSC HTTP / WSS 节点延迟与块高体检
│   ├── report.mjs                    # 块级复盘战报生成器
│   └── gen_pk.js                     # 生成本地触发私钥钱包（config/pk.json）
├── lib/
│   ├── config.js                     # 统一读取 config/wallets.json、pk.json、rpc_live.json
│   ├── keccak.js / sign.js           # 零依赖 Keccak-256 与 EIP-155 本地签名
├── config/
│   ├── wallets.example.json          # 多钱包映射模板（复制为 wallets.json 后填写）
│   ├── pk.example.json               # 私钥配置模板（复制为 pk.json 后填写）
│   ├── cfg.timed_sell.example.json   # gx.mjs 定时 + 进度达标触发 + 开盘双通道秒卖示例
│   ├── cfg.hold.example.json         # hold_engine.mjs 平开盘不秒卖 4 步闭环配置模板
│   ├── cfg.fairlaunch.example.json   # fairlaunch_master.mjs 配置模板
│   ├── cfg.sell_bs.example.json      # V2 + BS 批量代卖示例
│   ├── cfg.bs3_v3.example.json       # V3 + BS3 批量代卖示例
│   └── cfg.pk_only.example.json      # 纯私钥直卖示例
└── test/
    └── gx_mocktest.mjs               # 本地假链 8 场景回归测试（不触碰真链）
```

---

## 快速开始

### 1. 安装依赖与初始化配置

要求 **Node.js 20+**（推荐 22+）：

```bash
npm install

# 1) 配置钱包地址与 baw 隔离目录（切勿提交 wallets.json）
cp config/wallets.example.json config/wallets.json

# 2) （可选）生成私钥触发/二级交易钱包（切勿提交 pk.json）
node scripts/gen_pk.js --write

# 3) 测速生成可用 BSC RPC 列表（也可手动把私人 WSS/HTTP 节点写入 config/rpc_live.json，切勿提交）
npm run rpc

# 4) 跑一遍本地假链回归测试
npm test
```

### 2. 四种主力打法用法

#### 场景 A：开盘秒卖 / 抢跑型 —— 定时/进度触发 + 双通道秒卖（`gx.mjs`）
复制 `config/cfg.timed_sell.example.json` 为 `config/cfg.myproject.local.json` 并填入已审计的合约与选择器：

```bash
# 先演练体检（不发真实交易）
node scripts/gx.mjs config/cfg.myproject.local.json --sim

# 正式挂机（启动即提前完成 Router + 币安闪兑双精确授权，建议放 tmux 后台运行）
node scripts/gx.mjs config/cfg.myproject.local.json 2>&1 | tee logs/myproject.log
```

#### 场景 B：平开盘不秒卖 —— 标准 4 步闭环引擎（`hold_engine.mjs` · 推荐）
专为「不盲目秒卖、看盘面/按条件吃大肉」的项目设计，完整落地 4 步闭环：
1. **只授 DEX，不授私钥 BS2 + 盘前绑返佣**：提前给 1–N 号做好精确 `V2R + FLASH` 双授权，绝不授 `BS2/BS3`（根绝开盘第 1 秒盲砸与风控 `351803`），同时 2–N 号盘前自动绑 1 号吃返佣压低成本，常驻预热 `bawworker`。
2. **确认热度才进（双入口）**：支持 `entryMode: "heat"`（开打 1 分钟纯链上过 60%/75% 自动全号打满，未达标自动撤权退出）或 `entryMode: "manual"`（预热待命，尾盘喊一声写入 `BUY_NOW` 10 秒并发打满）。
3. **开盘后绝不盲卖（两种模式任选）**：开池自动第一时间领币/领返佣，实时汇报池子 BNB、净流入、现价倍数与估算市值：
   - **默认 · 纯听口令（`exitMode: "manual"`）**：绝不擅自卖单；喊一声清仓写入 `SELL_ALL`（或 `SELL_PCT 50`），预热进程 **3 秒内并发通过 V2R 砸光**。
   - **可选 · 条件单自动出（`exitMode: "conditional"`）**：支持「分批出本留利润飞（如 `1.5x` 卖 67% 出本 + `2.0x` 再出一半）」、「按号分层止盈」、「目标市值全清（`targetMcUsd`）」、「开盘超 5 分钟不拉自动全清（`stallExit`）」，中途随时可用 `SELL_ALL` 强清。
4. **卖完自动清零授权 + 实收盈亏总账**：清仓上链或放弃退出前自动把全部号的 `V2R` 与 `FLASH` 授权撤回 `0`，并落盘实收盈亏总账 `logs/<name>.report.json`。

```bash
# 离线单测
node scripts/hold_engine.mjs --self-test

# 复制模板并演练
cp config/cfg.hold.example.json config/cfg.myproject.hold.local.json
node scripts/hold_engine.mjs --config config/cfg.myproject.hold.local.json --dry-run

# 正式后台值守
node scripts/hold_engine.mjs --config config/cfg.myproject.hold.local.json 2>&1 | tee logs/myproject_hold.log

# 运行时口令控制（250ms 级响应）
echo "BUY_NOW"  > logs/myproject.cmd    # 尾盘一键并发打满
echo "SELL_ALL" > logs/myproject.cmd    # 3 秒内全号并发通过 V2R 清仓并自动撤权
echo "SELL_PCT 50" > logs/myproject.cmd # 全号各减仓一半
echo "ABORT"    > logs/myproject.cmd    # 放弃退出并清零所有 V2R / FLASH 授权
```

#### 场景 C：平开盘 60 秒实时强弱打分监控 / 右侧追多（`flat_watch.mjs`）
默认纯监控打分告警（不发单）；只有显式传 `--arm` 才会执行链上交易：

```bash
# 纯监控打分 + 1.5x~3.5x 里程碑告警（支持 --webhook 推送飞书/Discord/Telegram/Bark）
node scripts/flat_watch.mjs --token 0x代币地址 --cost-bnb 0.003 --tokens 14000000

# 平盘打法一（开盘不盲卖，多钱包分批止盈 1.5x -> 2.5x -> 3.5x/回撤15%，走弱 <0.80x 或 30s 净流出>10% 止损）
node scripts/flat_watch.mjs --token 0x代币地址 --cost-bnb 0.003 --tokens 14000000 \
  --mode play1 --wallets all --revoke-after --arm

# 打法二（不打新，开盘 15~90s 确认底池>=10BNB + 砸不破0.90x + 净流入>+1.5BNB + >=2 独立大买方 后右侧追多）
node scripts/flat_watch.mjs --token 0x代币地址 --mode play2 --wallets pkw \
  --buy-bnb 0.05 --min-big-buyers 2 --revoke-after --arm
```

#### 场景 D：免费 EIP-712 抢领 + 限期达标付费满打 + 平盘不秒卖（`fairlaunch_master.mjs`）
适合同时存在免费券额度与付费预售、且希望**免费份额保留手动处理、仅对付费仓自动执行平盘监控策略**的项目：

```bash
cp config/cfg.fairlaunch.example.json config/cfg.myfairlaunch.local.json
# 离线单测 + 体检
node scripts/fairlaunch_master.mjs --self-test
node scripts/fairlaunch_master.mjs --config config/cfg.myfairlaunch.local.json --dry-run
# 实盘运行
node scripts/fairlaunch_master.mjs --config config/cfg.myfairlaunch.local.json
```

---

## 实战安全与避坑红线

1. **严禁提交任何敏感文件**：`.gitignore` 已屏蔽 `pk.json`、`wallets.json`、`rpc_live.json*`、`*.local.json`、`logs/`、`baw*/` 等，提交前务必执行 `git status` 和密钥正则扫描。
2. **盘前必须提前完成精确授权**：只要目标代币合约允许零余额/开盘前 `approve`，**一律在开打前就先完成对 `PancakeV2 Router (0x10ED...024E)` 和 `币安闪兑 FLASH (0xb300...028d)` 的精确数量授权**，绝不要拖到买完或开盘后再临时授权；任务结束或超时未触发退出后务必 `approve(spender, 0)` 撤权。
3. **币安 `baw` 风控（`351803`）已知坑点**：`baw` 风控会拦截对自定义未认证代卖合约（`BS`/`BS3`）的 `approve`，而放行官方 PancakeSwap V2 Router 与币安闪兑 `FLASH`。因此使用 `baw` 账户跑 `gx.mjs` 时**请关闭 `bs` 字段**，直接走「币安闪兑 + 薄饼 V2 `inflight: 2`」双通道并发秒卖；`BS`/`BS3` 仅适合自托管私钥钱包。
4. **合约审计优先，严禁第三方网页盲签**：任何链上交互前务必先校验 Sourcify / BscScan 开源源码、函数选择器与资金流向，切勿在不明第三方站点扫码盲签。

---

## Disclaimer / 免责声明

本项目仅供区块链技术研究与个人链上自动化学习使用。链上交易与新盘打新存在极高本金损失风险，使用前请自行审计目标合约并先通过 `--sim` / `--dry-run` 充分演练，一切盈亏与链上风险由使用者自行承担。
