# DEC-CHECKOUT-SESSION-OUTAGE — 取餐时段满不是"系统故障"，故障必须留下原因代码

状态：**Accepted（协调人按商用原则决定，2026-11-11；Owner 可推翻）**。执行工作包：[WP-2423](../work-packages/WP-2423.md)。
上位依据：[DEC-PICKUP-CAPACITY-SCHEDULE 与 DEC-COUNTER-WALK-UP-CAPACITY](pickup-capacity-schedule.md)（其"已知限制：线上顾客在时段满时看到的文字未核对"由本决定关闭）、
[DEC-OUTAGE-READS-AND-RETRY](outage-reads-and-retry.md)（故障不得读成无权限或会话结束）、AGENTS.md 顾客尊重 / 运营连续性 / 商用保真。
复核修正（2026-11-11）新增迁移 `2000_780_create_capacity_asap_refusal` 与 api 对该表的 SELECT/INSERT（pilot ACL additions，
Owner 2026-10-14 常设批准）；无目录/角色/工作进程变更。

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
   译为 Ordering 的 `PICKUP_FULL`，HTTP 409 `checkout_session_pickup_full`，**不带 `Retry-After`**。什么都没有创建或扣款。
   顾客看到："厨房这一小时能做的自取订单已经排满，这一单没有扣款。可以稍后再试，或到柜台点单。"（英文同义），
   并保留"重试结账"按钮——同一次结账可再试。客户端不自动重试 409。
   【复核更正】首版说"通常几分钟内就会空出名额"并带 `Retry-After: 60`，与"不承诺具体时间"相矛盾：v15 那一小时主要被
   9 张已接的柜台单占满，已接单永不到期，名额往往要到下一小时（最多约 60 分钟后）才有，按分钟承诺只会让顾客反复重试。
   现在只说这一小时已满，不承诺分钟。柜台照常接单（站在柜台前的顾客总能下单）。
2. **故障留下原因代码**：结账会话、Ordering 校验依赖、Identity 入座绑定边界在把内部失败改写成对外答复时，以不可枚举的 `cause`
   保留原错误；结账会话（创建/读取）、入座绑定（prepare/activate/complete）、扫码入桌（qr-join）在回答 503 时用既有
   `markRequestFailure` + `customerFailureCode` 把最内层安全代码（可带 SQLSTATE）写进 `http_request_completed` 的 `error.code`。
   入座绑定的组合层与 Identity prepare 的各个拒绝点各有代码（如 `DINING_BINDING_TABLE_CONTEXT_STALE`、
   `GUEST_BINDING_SESSION_CHANGED`）；试点结账的内部失败改为带代码的错误（`INTERNAL_CHECKOUT_CART_CHANGED` 等）。
   【复核补】组合层不再用自己的代码覆盖所有者的拒绝，而是把原错误链在后面（`withFailureCause`），日志记录最内层的所有者规则：
   桌台上下文逐条规则（`QR_CONTEXT_CODE_REISSUED`、`QR_CONTEXT_TABLE_NOT_ASSIGNED`、`QR_CONTEXT_EXPIRED`、`QR_CONTEXT_MISSING` 等）、
   Dining 准入（`DINING_ADMISSION_OTHER_PHONE`、`DINING_ADMISSION_OTHER_TABLE`、`DINING_ADMISSION_NOT_ACTIVE`、
   `DINING_ADMISSION_NOT_FOUND`、`DINING_ADMISSION_GUEST_REFUSED`）与 Identity 会话授权（`GUEST_SESSION_NOT_FOUND`、
   `GUEST_SESSION_CSRF_REFUSED`、`GUEST_SESSION_ENDED`、`GUEST_SESSION_BINDING_NOT_CURRENT`）；因此诊断链深度上限由 6 层放宽到 10 层。
   只记录 `^[A-Z][A-Z0-9_]*$` 代码，不记录消息、引用、凭据或任何顾客信息。
3. **Accept all 不再误报断网**：只有一次接单真正以"结果未知"结束（`OutcomeUnknown`）的轮次才显示"再接一次 / 网络断了"；
   正在进行中的接单（Accept all 循环、另一处按钮）不再因为操作已登记而锁成"未知"。【复核补】Accept all 运行期间各行自己的
   接单按钮暂停（不显示断网文字），同一轮不会被同时发两次。
4. **账单读取不被自己的刷新打断**：Tables 结账区每 5 秒重读账单；原实现每次刷新都中止上一读并重来，繁忙时（合并桌一读 7–8 秒）
   账单一直停在"正在读取账单…"，被中止的读仍在服务器上执行，加重负载。改为上一读未完成时跳过本次刷新；读超过 3 秒时
   显示"还在处理，系统有点忙。不用再按，会自己完成。"。合并桌账单本身每多一张单只多 2 条语句，慢的主因是主机满载（同时段单桌 3.5 秒）。
   【复核补】一次读取设上限 25 秒：永不返回的读（平板 Wi-Fi 中途断开、连接静默）到时中止，显示"账单暂时读不到，正在自动重试。"
   （已有账单时显示既有的"无法再次读取账单，显示的是上次结果，会自动重试"），下一次 5 秒刷新照常重读，S4 顾客手机付款时店员不会失去刷新。
5. **入口连接保持 75 秒**：HTTPS 入口（含 front 声明地址的监听器）空闲 keep-alive 由 Node 默认 5 秒改为 75 秒（与常见 Web 服务器一致），
   请求头仍须 20 秒内到达。**推断的原因，未经证实**：5 秒的空闲关闭可能使一次页面加载打开的连接几乎同时关闭，恰在那一刻的重新加载
   可能落在正在关闭的连接上，浏览器重试几次后报 `net::ERR_TOO_MANY_RETRIES`（样式表丢失时页面无样式）。本地未复现（12 次重新加载 0 次失败），
   只见于 v15 无头 Chromium，真实平板未确认。是否消除须在部署后的 v15 重新加载实测中确认（见 WP-2423 实测项）；未确认前不算已修复。
6. **【复核补】店员知道线上自取已满**：Fulfillment 在自身检查拒绝一张线上（`Paced`）单时，另起事务记录一行
   `rms_fulfillment.capacity_asap_refusal`（时段、购物车的不透明引用、时间；每个购物车每个时段一行，同一顾客重试只算一位；
   只追加、门店 RLS；不含姓名、联系方式或金额）；写入失败不改变给顾客的答复，柜台单（`WalkUp`）从不记录。Orders 列表随首页读取
   Fulfillment 的 `readCurrentPickupHour`（当前时段上限、占用、是否已满、婉拒人数；读不出不影响 Orders），在时段已满或本小时已婉拒顾客时显示：
   "到 {时间} 为止的这一小时线上自取已满。本小时已婉拒 N 位线上顾客。" 并提示"柜台单照常可以下。顾客已离开、还没付款的柜台单请取消：
   它占着名额。"；有名额后改为"线上自取又有名额了。本小时曾婉拒 N 位线上顾客。"，下一小时无婉拒时不显示。不需要容量配置来源。

## 未决与已知限制

- **入座绑定 503（只见一次、未复现）——根因仍未找到**：v15 只读核对确认旧手机会话 `ContextOnly`、qr-join 成功（参与者与准入已写入、准入仍 Active），
  但 prepare 在写入任何绑定准备前被拒；同桌新手机正常，DEMO 同样步骤正常。本批不碰 v15，无法再取证；代码审阅能列出的拒绝点
  （会话授权、桌台上下文逐条、Dining 准入逐条、组合层比对）现在都把具体规则码写进 api.log，下次出现即可定位。仍是未决项。
- 平台尚无门店可调的取餐容量配置（`capacityConfigurationReference` 为空，沿用试点默认）；店员提示不依赖它。
- 未付的柜台单会占用取餐容量直至付款窗口到期（30 分钟）；店员应取消顾客已离开的柜台单（既有操作）。
