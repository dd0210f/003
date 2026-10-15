# Variational 自动交易 v1.0.0

Profit / Volume 双模式 SWAP 自动交易插件,执行层基于 v1.1.7(2026-09-29 真实下单验证通过)。

## 策略(移植自 AlphaLabs R3 v0.6.3)
- **Profit**:趋势剥头皮。价差/1m动量/5m动量(bps)同向才开仓;TP 0.65%/SL 0.38%(XAU);持仓最长 45 分钟;信号冷却 5 分钟。
- **Volume**:高频剥头皮。阈值更小;TP 0.18%/SL 0.24%(XAU);持仓最长 8 分钟;冷却 90 秒。
- 风控:最大持仓数 / 连续亏损熔断 / 每日最大开仓 / 日亏损熔断,触发后不再开新仓。
- 仓位:保证金预算=权益×比例,杠杆取 min(目标,平台上限:XAU/XAG/US100/US500/TWI=10,UKOIL=5)。

## 和 R3 不同的地方
- **不用 API Key**,走浏览器 Variational 登录态(和 v1.1.7 一样)。
- **不用开着 variational.io 标签页**,直连 fetch(权限只有 storage/alarms + variational.io)。
- 下单 side 小写 buy/sell、数量按 min_qty_tick 取整(2026-09-29 实测修好的两个坑)。
- 报错可一键复制纯文本错误报告。

## 使用
1. chrome://extensions → 开发者模式 → 加载已解压的扩展程序,选此文件夹。
2. 默认 PAPER(模拟,不下单)。先点「测试连接」确认 Variational 会话。
3. 开 LIVE:拨开关(二次确认)→测试连接(10 分钟内有效)→启动(再确认一次)。
4. TradFi 标的(US100/US500/UKOIL/TWI)休市时自动跳过不开仓。

## 安全
- LIVE 默认关闭;停止/紧急停止不会盲目平掉已有仓位。
- 状态(历史/持仓/统计)存在 chrome.storage,service worker 被回收不丢。
