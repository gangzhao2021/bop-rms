# DEC-DINING-ABANDONED-PAYMENT — 堂食线上付款开了没付完

状态：**Accepted（协调人按商用原则决定，2026-10-16；Owner 可推翻）**。执行工作包：[WP-2423](../work-packages/WP-2423.md)
（"上线前 v15 全流程实测"问题 1）。相关：[DEC-PAYMENT-CARD-RETRY](payment-card-retry.md)、
[DEC-STAFF-DINE-IN-ROUND](staff-dine-in-round.md) 实现决定（未开始付款的一轮到期取消）、
[DEC-TABLE-CLOSE-GUESTS-LEFT](table-close-guests-left.md)、[DEC-ORDER-CANCELLATION-PILOT](order-cancellation-pilot.md)。

## 问题（v15 DEMO-02 第 1 轮）

客人点了"Continue to payment"进入付款页（服务商意图已建好），然后刷新或换了页面：

- 付款页显示"Payment confirmation pending… Do not submit another payment"，没有任何付款入口；本桌页只有"Waiting for payment"，没有付款链接；购物车已清空。
- 店员没有任何操作；到期时到期记录写成 `AwaitingPaymentResolution`，取消被跳过（"已开始付款，等结果"），
  但一个客人从未确认的意图永远不会有结果——这一轮永远不取消、库存一直占着、桌子关不了，到期前也没有提醒店员。

## 决定

1. **同一客人回来付同一笔（不建第二笔）**：Payment 新增 `resume`：同一结账会话、同一客人会话（任一标签页或重新载入）在付款窗口内
   取回该意图的最新尝试，原样返回；不开新尝试、不调用服务商、不接收请求里的金额或小费（`POST …/payment-intents {"resume":true}`）。
   顾客端：付款结果页对"未确认、窗口未过"的付款显示"Finish paying"（金额与截止时间，"到时未付即取消、不收费"），
   Stripe 模式取回同一意图的客户端密钥打开卡表单，模拟器为确认/拒卡按钮（仅内部测试）；本桌页对"本人点的、待付款"的一轮显示
   "Pay for round N"。结果页文字改为"若已输入卡，结果很快显示；若离开时未付，在下面付完，不会扣两次"。
2. **到期时问服务商（Payment 负责）**：到期未付且有线上付款的一轮，取消任务不再无限等待，而是在任何数据库事务之外让 Payment
   向服务商查询最新尝试：
   - 客人从未确认（Stripe `requires_payment_method|requires_confirmation|requires_action`）→ 先在服务商**取消**该意图
     （每次尝试一个固定幂等键 `cancel-abandoned:<attempt>`，Stripe `cancellation_reason=abandoned`），再按服务商查询记为失败
     （`Cancelled`，不可重试）——旧页面再也不能确认它；下一轮到期扫描记下 `PaymentFailed`，该轮以新原因
     **`PAYMENT_NOT_COMPLETED`** 取消（同一工作流转换、同一事务释放库存、`OrderCancelled`），不退款（未扣款）。
   - 服务商已扣款（回调没到）→ 记为成功，按已付处理（到期证据 `PaidBeforeDeadline`/`LatePayment`），不取消。
   - 处理中/服务商不可达 → 不记录，继续等待并每轮重试；店员页面显示截止时间与"正在取消/确认中"。
     取消之后若仍有扣款到达，沿用"已付款无法履约"的自动退款（不变）。
3. **店员"Cancel unpaid round N"**：Orders 页（未付的一轮）、Tables 页选中桌详情（客人点的未付轮次）和关桌"客人已离开"流程
   （`NotPaid`/`PaymentInProgress` 现在可在确认时处理）都可取消未付的一轮。权限沿用 `ordering.order.cancel`（店长、Owner；
   与取消订单同一批人；店员看到"请店长在此或 Orders 页取消"）。命令 `POST /merchant/orders/cancel-unpaid-round`：
   ① 读该轮付款标识；② 事务外由 Payment 按第 2 条处理线上尝试（已付 → 拒绝"已经付了"；处理中 → 拒绝"一分钟后再试"）；
   ③ 一个事务：再次授权店员，在付款操作围栏下由 Payment 证明未收钱（无刷卡机收款；线上尝试为失败终态），再写与系统相同的
   未付轮次取消，原因 **`STAFF_CANCELLED_UNPAID`**，审计操作者为该店员（`MERCHANT_WEB`），事件仍由系统执行工作流转换发布。
   同一操作编号重放返回原结果；页面确认文字为"Nobody has paid for this round… Nobody is charged"。
4. **到期前提醒店员**：
   - Orders：未付的一轮（包括客人已开始但没付完）一律显示"Not paid · cancelled automatically at HH:MM unless paid"，最后 10 分钟醒目，
     并说明"请客人在手机上付完（本桌页有付款按钮），或在下面取消"。
   - Tables：每张桌卡和选中桌详情显示客人未付的轮次与截止时间（"Round 1 isn't paid yet… unpaid at HH:MM, it is cancelled and nobody is
     charged"；最后 10 分钟"N min left"；到期后"正在取消"），有未付轮次时页面按既有节奏更新；有权限者旁边就是"Cancel unpaid round N"。
     读取为一次查询覆盖本页全部在座会话（不随桌数增长）。
5. **Tables 说明与现有控件一致**：关桌阻塞说明改为"请客人在手机上付完，或取消未付的一轮（客人已离开时在下面，或在 Orders 页）"；
   关单原因 `ORDER_BALANCE_UNPAID` 同步改为"请客人付完或在 Orders 页取消未付的一轮"。
6. **顾客文字**：本桌页取消的一轮显示"Cancelled — not paid"（系统到期或店员取消都适用），"这一轮没有进厨房，没有人被收费"；
   付款结果页对 `Cancelled` 失败显示"Payment not finished · 这笔付款没有及时完成，已取消，未扣款"，不再误称"卡被拒"。

## 故障时

- 网络断开（顾客）：结果页按钮不可用并提示重连；重连后"Finish paying"仍是同一笔。
- 服务商不可达（到期时）：不取消、不记录，下一轮再问；店员页面一直显示截止时间与"正在取消"，需要时按 runbook 在 Exceptions 页核对。
- 云端/API 不可用：店员可用刷卡机收款，网络恢复后按"断网后补录"录入（DEC-STAFF-DINE-IN-ROUND）；该轮若已被取消则不会重复收费。
- 店员设备离线：系统到期取消照常执行，不依赖店员页面。

## 迁移与授权

迁移 `2000_069_alter_batch_cancellation_abandoned_payment`：`order_batch_checkout_cancellation` 的原因增加 `PAYMENT_NOT_COMPLETED`、
`STAFF_CANCELLED_UNPAID`；店员原因不带到期证据（`expiry_record_id`/`expiry_evidence_digest` 可空，且仅此原因为空）；校验函数增加：
店员原因要求本单 Dining 拥有的本轮（提交与付款操作一致），且 Ordering 未记录付款；`PAYMENT_NOT_COMPLETED` 与
`CHECKOUT_DEADLINE_REACHED` 一样要求 `PaymentFailed` 到期证据；已有店员取消（`order_staff_cancellation`）的一轮拒绝。
`OrderCancelled` v1 原因枚举同步扩展（事件目录已重新生成）。不新增表与数据库授权（API 角色已有相关读写与 Payment 终态写入授权），
不改权限目录。按 Owner 常设批准（2026-10-14，WP-2423 abandoned payment）应用于 v15。

## 外部关口

- 真实 Stripe：适配器已支持取消（`POST /v1/payment_intents/:id/cancel`，幂等键，返回同一意图状态；已成功/处理中的意图 Stripe 拒绝取消，
  按"未确定"处理后再查询）。Stripe 接入试点本身仍是外部关口。

## 已知限制（2026-10-18 已处理）

- **服务商创建结果未知**（意图在本地已认领但创建应答丢失：无观测或 `Unknown` 失败；客人从未拿到卡表单）：Payment 用同一幂等键、同一请求
  再发一次创建向服务商查询——服务商返回它已建的意图，或此时新建一个未确认的意图——随后按第 2 条处理（通常在服务商取消并记为
  `Cancelled`，下一轮以 `PAYMENT_NOT_COMPLETED` 取消该轮）。创建幂等键改为由尝试派生（`create-intent:<attempt>`，每次尝试仍唯一），
  仅当其摘要与尝试记录的 `providerIdempotencyDigest` 一致时才查询；首次快照经 Payment 观测记录绑定该意图（尝试、金额、方式已校验），
  之后的快照必须为同一意图。早于此改动的尝试不能用猜测的键查询，保持等待。
- **仍无法确认时交给店员**：截止后 5 分钟（取消扫描每数秒重查一次）仍未解决的线上付款，Tables 与 Orders 显示"the card provider couldn't
  confirm the guest's payment… Ask the guest whether their card was charged. If it wasn't, cancel the round; a charge that still comes
  through is refunded automatically"；店长确认（`acknowledgeUnconfirmedPayment: true`，按钮"Not charged: cancel round N"）后取消，事务内按
  Ordering 截止时间重新判断宽限、Payment 已记成功仍拒绝；审计 `afterSummary {providerPaymentUnconfirmed: true}`。之后到达的扣款沿用
  "已付款无法履约"自动退款。
- **线上已付但 Ordering 尚未记录**（数秒）：Tables 读取 Payment 自己的终态事实（`listStoreOrderBatchesPaidOnline`），该轮不再显示为未付、
  不再提供取消；店长恰在此时取消时，对话框显示"Payment just arrived: the guest paid for this round, so nothing was cancelled"及"Refresh"。
