# DEC-CANCELLED-ORDER-FREES-PICKUP-PLACE 与取餐时段满后的重试

状态：**Accepted（协调人按商用原则决定，2026-11-12；Owner 可推翻）**。执行工作包：[WP-2423](../work-packages/WP-2423.md)。
上位依据：[DEC-CHECKOUT-SESSION-OUTAGE](checkout-session-outage.md)（时段满的答复与店员提示）、
[DEC-PICKUP-CAPACITY-SCHEDULE / DEC-COUNTER-WALK-UP-CAPACITY](pickup-capacity-schedule.md)、
[Owner 默认 2026-11-06](owner-defaults-2026-11-06.md)、AGENTS.md 顾客尊重 / 运营连续性 / 商用保真。
无迁移、无 pilot ACL 变更（api 已有 `capacity_asap_commitment` 的 SELECT/INSERT），无目录/角色/工作进程变更。

## 1. 取消未付柜台单立即空出取餐名额（DEC-CANCELLED-ORDER-FREES-PICKUP-PLACE）

**根因**：时段满时 Orders 提示店员"顾客已离开的未付柜台单请取消：它占着名额"。但
`merchant-counter-order-cancellation.ts` 只结束订单（Ordering 终止记录）并退回库存，从不结束 Fulfillment 的
ASAP 承诺；占用按最新版本计算，`PaymentPending` 在付款窗口（30 分钟）内一直计入。v15 TM2：17–22 号取消后
承诺仍是 `PaymentPending v2`，占用 21→22→23/20，线上顾客继续收到 409，提示继续说已满，直到原付款截止时间。

**决定**：同一取消事务内，在 Ordering 终止与库存退回之后，Fulfillment 追加该承诺的 `Released`（第 3 版，
`terminal_at` 为数据库当前时刻），审计 `FULFILLMENT_ASAP_CAPACITY_RELEASED`（System 行为者，`ORDER_CANCELLED`，
`MERCHANT_WEB`，关联到终止记录，`OPERATIONAL` 保留）。只追加、不改写（表本身只追加，触发器已允许
`Prepared/PaymentPending → Released`）。在保存点内执行：承诺已结束（已接单 `Consumed`、已 `Released`）或触发器拒绝时，
取消照常成立，不因记账失败而拒绝店员。同一操作号重放会补放一张旧版本留下仍占位的承诺。
纸单重录（`COUNTER_PAPER_REENTERED`）走同一路径：旧纸单的付款窗口已过、本已不计占用，释放只让记录如实。

**已知限制（记录，不在本包）**：已接单后由店员取消（做不了）的线上单，承诺是 `Consumed`，按现有规则一直计入该小时；
数据库触发器不允许 `Consumed` 之后再追加版本，要改需迁移与新规则，另立事项。

## 2. 价格保留过期后再按"重试结账"

**根因**：报价保留 5 分钟（`price_quote.expires_at = created_at + 300 s`）。顾客看到"已排满，可以稍后再试"后等了 5 分钟以上
再按"重试结账"，客户端用同一张旧报价再发结账；容量来源（`customer-pickup-capacity-sources.ts`）在购物车来源校验里因报价过期
统一抛 `GUEST_SESSION_UNAVAILABLE`，结账会话答 503 `checkout_session_service_unavailable`（Retry-After 5），客户端自动重试约 11 次
后显示"无法开始结账"，再按重试仍是同一循环；日志看起来像服务故障。

**决定**：

- 服务端：容量来源先认出"这次结账用的报价已过期"（最新报价就是这张且 `quoteExpiresAt ≤ observedAt`），抛 Ordering 的
  `CHECKOUT_QUOTE_EXPIRED`；组合层只在新建结账（Prepare）时把它原样传出；会话校验把它译为 `REQUOTE_REQUIRED` →
  409 `checkout_session_requote_required`。永不再读成 503。别的拒绝不变。
- 顾客端：价格保留已过时，"重试结账"先重新计价，不再发旧报价；客户端收到 `requote_required` 时也一样。页面说明：
  "为您保留的价格在等待时已到期，我们已重新计价。订单尚未发送，也没有收费。请核对总价后继续。"顾客核对总价（重新选小费）后
  按继续，作为一次新的结账发出（新报价、新操作号）；若仍满，照常显示已排满。不自动替顾客下单：价格可能已变，必须本人确认。

## 3. "全部接单"完成后的行

**根因**：全部接单期间各行按钮被 `held` 禁用；完成后 `held` 解除，而列表要等重新读取（忙时约 3 s）才去掉已接的行，
这段时间每行又显示可点的"接单 N"，点了会再发一次接单（服务端幂等，但给店员一个错误的待办）。"全部接单 N"也仍可点。

**决定**：全部接单成功的轮次记在页面里，直到列表重读：这些行显示"已接单 N"（状态文字，不是按钮），也不再计入"全部接单"。
列表重读后它们按服务器状态离开"待接单"。读不到（断网）时它们继续显示已接单——它们确实已接。

## 4. 员工页重载 `net::ERR_TOO_MANY_RETRIES`（复核结论：测试环境，产品无需改）

本地复现（2026-11-12）：Chromium →（Docker Desktop 端口转发）→ 入口（Node HTTPS，75 s keep-alive）→ 商户静态页，
按测试员脚本 goto+reload 循环：

- 浏览器只"点过"自签证书警告（Playwright `ignoreHTTPSErrors`，测试员工具 `.local/sim-kit/lib.mjs` 的做法）：
  40–60 次导航失败 3–9 次（文档或样式表 `ERR_TOO_MANY_RETRIES`），入口每次导航记录约 27 次
  `ERR_SSL_SSL/TLS_ALERT_CERTIFICATE_UNKNOWN`（每个新连接的握手都被浏览器拒绝后重来），且 Service Worker 不能注册
  （证书有错误的来源不允许），所以也拿不到停机页。
- 同一环境只把证书改为被信任（固定公钥，`tooling/environment/pilot-tls-trust.mjs` 的 `pilotChromiumTrustArguments`）：
  40/40 成功，握手错误 0。不经 Docker 转发时点过警告也未复现（0/50）。

结论与 2026-10-15 的根因一致（见 `pilot-tls-trust.mjs` 注释）：原因是**本地 InternalTest 自签证书未被信任**，
与 keep-alive 无关（`f164444f` 的 75 s 保留，无害，但注释已更正）。正式托管用公网证书（`tls.mode: front`），不发生。
**仅测试环境**：v15 员工设备必须信任该证书（不是点过警告），自动化浏览器必须用公钥固定参数；按此复测才是有效的实测。
