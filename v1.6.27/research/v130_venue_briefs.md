# v1.3.0 六所适配器调研汇总（2026-10-04）

## 1. QFEX（qfex.com）
- 交易 WS：`wss://trade.qfex.com/`（**下单只能走 WS**）；行情 WS：`wss://mds.qfex.com/`；REST 只做账户管理/出入金（base URL 未在文档明确，勿猜）。
- 认证：API Key `qfex_pub_…`/`qfex_secret_…`，官网 Developer Settings 生成（需 2FA），secret 只显示一次；权限粒度（Execute orders/View orders/View positions/View balance/Deposit）；HMAC-SHA256(`nonce + ":" + unixSeconds`)，REST 放 `x-qfex-*` 头，交易 WS 发 `auth` 消息。
- UAT：`qfex.io`，`wss://trade.qfex.io/` + `wss://mds.qfex.io/`，独立实例无真实资金，官方 CLI 支持 prod/uat 切换。
- 下单：`add_order`（MARKET tif=IOC / LIMIT tif=GTC|IOC|FOK / ALO=post-only独立type）；撤单 `cancel_order`（order_id/client_order_id）/`cancel_all_orders`；`reduce_only` 独立布尔；STOP_LOSS 按 mark 触发转市价；订单 ACK 与成交两阶段异步（先 ACK 后 FILLED/CANCELLED/REJECTED）。
- 持仓/余额：交易 WS 私有查询；`get_order`/`get_user_orders`/`get_user_trades`。
- 限流：12,000 weight/60s/用户（EMA），general 与 cancel 独立桶；add_order/cancel_order=1.0，subscribe=0.1。
- 费用/资金费：5 档 maker-taker（Tier 1 maker 零费）；**资金费每小时**结算。标的格式如 `AAPL-USD`（CL 确切代码用 `market symbols` 实查，勿猜）。
- 坑：**500ms speed bump**（所有限价单进队列前延迟 500ms，市价单不受影响）；自成交保护（同 trader 两单相撞撤被动单）；有 `cancel_on_disconnect`（掉线自动全撤，可用于重启逻辑）。
- 文档：https://docs.qfex.com/api-reference/introduction

## 2. Entropy（EntropyIO，Hyperliquid HIP-3）
- 本质：Hyperliquid 上的 HIP-3 deployer，dex 名为 `io`，市场格式 `io:ANTH` / `io:SNDK`。
- 地址：`POST /info {"type":"perpDexs"}` 列 dex；`meta`/`metaAndAssetCtxs`/`clearinghouseState` 接受 `"dex"` 参数；`l2Book`/`fundingHistory` 用 `dex:COIN` 前缀；下单用整数 asset id = `100000 + perpDexIndex×10000 + indexInMeta`，**每 session 用 meta 实时解析，禁止硬编码**（主网/testnet 不同）。
- 认证：**无 API Key，钱包签名**。用户建 API/agent wallet（Hyperliquid UI），主账户签 `approveAgent`（EIP-712），agent key 签所有 L1 action（phantom agent  scheme，domain `Exchange`，chainId 1337，MessagePack→Keccak→secp256k1）；agent 可交易**不可提款**。
- Testnet：`https://api.hyperliquid-testnet.xyz`，独立账本、独立 agent 授权、asset index 不同。
- 下单：`POST /exchange` signed `order`（price/size 为**字符串**，tif `Gtc/Ioc/Alo`；**无原生市价单，用 IOC limit 代替**，SDK 默认 ~5% 滑点）；`cancel`、`updateLeverage`、`updateIsolatedMargin`；WS `wss://api.hyperliquid.xyz/ws` 无自动重连（自己实现）。
- 查询：`allMids`、`l2Book`、`fundingHistory`、`clearinghouseState`（positions + marginSummary.accountValue）、`openOrders`、`orderStatus`。
- 费用/资金费：HIP-3 约 2× 主站 = **0.09% taker / 0.03% maker**（一半归 deployer）；资金费**每小时**，deployer 定预言机与参数；**仅隔离保证金**。
- 限流：~1200/min/IP。
- JS SDK：`@nktkas/hyperliquid`（browser ESM，只用 fetch/WebSocket）；MV3 CSP 禁远程 import，**必须本地打包 vendoring**（esbuild tree-shaken）。
- 坑：预言机 deployer 运营（可 slash 但仓位先吃亏）；deployer 可 `haltTrading`（全撤单按 mark 结算；先例 io:OAI 零成交下架）；pre-IPO 按 deployer 估值方法结算；OI 薄 + 2× 费率不适合短线动量；每 dex 独立 backstop liquidator + ADL。
- 结论：6 家中**最易集成**（标准 Hyperliquid API，无需浏览器登录态）；工作量在 agent-wallet 开户 UX + 每调用加 `dex:"io"`。
- 文档：https://hyperliquid.gitbook.io/hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-3-builder-deployed-perpetuals

## 3. Lighter（lighter.xyz）
- API Key 生成（用户手动，一次）：app.lighter.xyz 连钱包 → 建交易子账户 → `/apikeys` → Generate，选未用 index **4–254**（0–3 保留，255=查询哨兵）；私钥**只显示一次**；再经 `ChangePubKey` 注册（一次 L1 签名）；`GET /api/v1/accountsByL1Address?l1_address=0x…` 查 account_index。
- 签名：L2 交易 ECDSA secp256k1，`POST /api/v1/sendTx`（`{tx_type, tx_info, signature}`；batch 用 sendTxBatch；WS `json/sendTx`）；tx 14=create、16=cancel；官方 Go SDK 可编 **WASM**（web-wasm target，`CreateAuthToken`+`Sign*`，有在浏览器跑的先例 lighter-signer.wasm）；备选 CCXT（browser build）或纯 JS noble-secp256k1 按文档拼 tx。
- 8h auth token：**全自动**，token=`{expiry_unix}:{account_index}:{api_key_index}:{random_hex}`，用 API 私钥签名 mint（≤8h，默认 10min）；REST 放 `Authorization` 头，WS 放 `auth`；每 ~7h mint 新的，**无需再碰 L1**；只读 token `ro:…` 可长达 10 年。
- Base：`https://mainnet.zklighter.elliot.ai`（testnet：`https://testnet.zklighter.elliot.ai`）；WS `wss://…/stream`。
- 行情：OrderApi `order_book_details`；`GET /api/v1/orderBookOrders?market_id=N&limit=250`；WS `order_book/{market_id}`；资金费公开 `/reference/funding-rates`（结算间隔实现时再确认）。
- 持仓/余额：AccountApi `account`（by index 或 l1_address）；挂单 `/reference/accountactiveorders`；K 线 `/reference/candles`。
- Nonce：per-API-key 递增，`GET /api/v1/nextNonce?account_index=X&api_key_index=Y` 或本地严格递增计数器 + skipNonce。
- 费用：标准账户 **0% maker / 0% taker**；Premium（LIT 质押）：~0.002–0.004% maker / ~0.02% taker，0ms maker 路径；`/changeAccountTier` 切换。
- Key 类型：有 **maker-only**（post-only + 改单 + 撤单），做市最安全；0–3 不能设 maker-only。
- 用户手动 vs 自动：手动=连钱包+入金、生成 key（存私钥）、ChangePubKey 一次 L1 签名、把 `{api私钥, account_index, api_key_index}` 填进插件、选 Standard/Premium；其余（token 轮换、nonce、签名、所有 REST/WS）全自动。
- 文档：https://apidocs.lighter.xyz/docs/api-keys

## 4. Arcus / TxFlow（状态）
- Arcus：永续 Beta 仅 waitlist（8.5万+），无 API 可接 → 适配器注册为 `status: waitlist`，UI 置灰，不写交易代码。
- TxFlow：条款禁止未经许可的自动化交易 → **不做交易适配器**（只可做行情观察或不做），UI 标注原因。

## 5. 凭证安全铁律
- 所有 API key / agent 私钥只存 `chrome.storage.local`（本机），**绝不进心跳/报警/中转站/聊天**。
- 每个 venue 未配置凭证前，UI 显示"未配置"，策略跳过该所。
