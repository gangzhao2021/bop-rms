# DEC-CHECKOUT-SESSION-OUTAGE — 取餐时段满不是"系统故障"，故障必须留下原因代码

状态：**Accepted（协调人按商用原则决定，2026-11-11；Owner 可推翻）**。执行工作包：[WP-2423](../work-packages/WP-2423.md)。
上位依据：[DEC-PICKUP-CAPACITY-SCHEDULE 与 DEC-COUNTER-WALK-UP-CAPACITY](pickup-capacity-schedule.md)（其"已知限制：线上顾客在时段满时看到的文字未核对"由本决定关闭）、
[DEC-OUTAGE-READS-AND-RETRY](outage-reads-and-retry.md)（故障不得读成无权限或会话结束）、AGENTS.md 顾客尊重 / 运营连续性 / 商用保真。
无迁移、无新授权、无目录/角色/工作进程变更。

## 根因（v15 只读核对，2026-11-11）

Test Merchant 2 Main 约 21:31Z–21:57Z 线上自取结账连续 503 `checkout_session_service_unavailable`，日志无原因。
只读 SQL（`rms_ordering.checkout_session_allocation` ⟕ `checkout_session_record`，`rms_fulfillment.capacity_asap_commitment`，
`capacity_slot_configuration`）确认：

- 失败的全部是线上（`Qr`）自取购物车：分配已写入、会话记录没有、也没有任何 ASAP 承诺。同一时间柜台（`Pos`）单和堂食照常成功。
- 当时取餐时段 21:00–22:00Z 的容量上限是 20（`PILOT_DEFAULT_PICKUP_CAPACITY_V1`）。按每个分配的最新版本重算占用：
  21:31:34 为 22、21:45 为 26、21:55 为 21——其中 14 张是并行测试员开出却未收款的柜台单（`WalkUp`、`PaymentPending`，
  各占 30 分钟付款窗口）加 9 张已接单的柜台单。柜台单按 DEC-COUNTER-WALK-UP-CAPACITY 不被拒但计入占用，线上单（`Paced`）因此被拒。
- 21:50 两张未付柜台单到期，空出 1 个位置，恰好有一张线上单（82 号）成功；21:57 再有两张到期，21:59 线上单恢复；22:00 起新时段。
- Fulfillment 拒绝为 `ASAP_CAPACITY_INSUFFICIENT`，结账服务把一切非自身错误改写为 `DEPENDENCY_UNAVAILABLE` → HTTP 503，
  不记录原因，所以四位测试员看到"无法开始结账，请重试"、客户端自动重试 11 次，支持人员在日志里找不到任何线索。

结论：不是数据库或服务故障，是**容量规则如实生效、但答复说错了**。

## 决定

1. **时段满的答复**：结账会话把 Fulfillment 的 `ASAP_CAPACITY_INSUFFICIENT`（按名称与代码识别，试点可能加载两份 Fulfillment）
   译为 Ordering 的 `PICKUP_FULL`，HTTP 409 `checkout_session_pickup_full`，`Retry-After: 60`。什么都没有创建或扣款。
   顾客看到："厨房这会儿的自取订单已经排满，这一单没有扣款。通常几分钟内就会空出名额：请稍后再试，或到柜台点单。"
   （英文同义），并保留"重试结账"按钮——同一次结账可再试（一张未付单到期或下一小时开始即有位置）。客户端不自动重试 409。
   不承诺具体时间：空位取决于未付单何时到期，系统不知道。柜台照常接单（站在柜台前的顾客总能下单）。
2. **故障留下原因代码**：结账会话、Ordering 校验依赖、Identity 入座绑定边界在把内部失败改写成对外答复时，以不可枚举的 `cause`
   保留原错误；结账会话（创建/读取）、入座绑定（prepare/activate/complete）、扫码入桌（qr-join）在回答 503 时用既有
   `markRequestFailure` + `customerFailureCode` 把最内层安全代码（可带 SQLSTATE）写进 `http_request_completed` 的 `error.code`。
   入座绑定的组合层与 Identity prepare 的各个拒绝点各有代码（如 `DINING_BINDING_TABLE_CONTEXT_STALE`、
   `GUEST_BINDING_SESSION_CHANGED`）；试点结账的内部失败改为带代码的错误（`INTERNAL_CHECKOUT_CART_CHANGED` 等）。
   只记录 `^[A-Z][A-Z0-9_]*$` 代码，不记录消息、引用、凭据或任何顾客信息。
3. **Accept all 不再误报断网**：只有一次接单真正以"结果未知"结束（`OutcomeUnknown`）的轮次才显示"再接一次 / 网络断了"；
   正在进行中的接单（Accept all 循环、另一处按钮）不再因为操作已登记而锁成"未知"。
4. **账单读取不被自己的刷新打断**：Tables 结账区每 5 秒重读账单；原实现每次刷新都中止上一读并重来，繁忙时（合并桌一读 7–8 秒）
   账单一直停在"正在读取账单…"，被中止的读仍在服务器上执行，加重负载。改为上一读未完成时跳过本次刷新；读超过 3 秒时
   显示"还在处理，系统有点忙。不用再按，会自己完成。"。合并桌账单本身每多一张单只多 2 条语句，慢的主因是主机满载（同时段单桌 3.5 秒）。
5. **入口连接保持 75 秒**：HTTPS 入口（含 front 声明地址的监听器）空闲 keep-alive 由 Node 默认 5 秒改为 75 秒（与常见 Web 服务器一致），
   请求头仍须 20 秒内到达。原 5 秒使一次页面加载打开的所有连接几乎同时关闭，在那一刻重新加载的请求会接连落在正在关闭的连接上，
   浏览器重试几次后报 `net::ERR_TOO_MANY_RETRIES`（样式表丢失时页面无样式）。店员页面每几秒自刷新，连接因此保持可用。

## 未决与已知限制

- **入座绑定 503（只见一次、未复现）**：v15 只读核对确认旧手机会话 `ContextOnly`、qr-join 成功（参与者与准入已写入、准入仍 Active），
  但 prepare 在写入任何绑定准备前被拒；同桌新手机正常。根因未定。本次让每个拒绝点留下代码，下次出现即可从 api.log 判断是哪一处。
- **店员看不到"线上自取已满"**：时段满时柜台照常接单，但 Orders/门店系统尚无"本小时线上自取已满、已婉拒 N 位顾客"的提示，
  且平台尚无门店可调的取餐容量配置（`capacityConfigurationReference` 为空，沿用试点默认）。二者一起在容量配置来源落地时做。
- 未付的柜台单会占用取餐容量直至付款窗口到期（30 分钟）；店员应取消顾客已离开的柜台单（既有操作）。
