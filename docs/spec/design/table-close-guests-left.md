# DEC-TABLE-CLOSE-GUESTS-LEFT：客人已离开时由店长关桌

状态：已实现（2026-10-15，WP-2423；工作区未提交）。业务决定来源：Owner 2026-10-15"只有 Owner 和 Store
Manager 可以关闭桌台会话"；本页其余为实现决定（按"技术选择自行决定、按真实门店运营"）。

## 问题

v15 实测：DEMO-02 桌 10-11 起的轮次中，第 4–8 轮客人已在线付款但从未被接单，第 1 轮付款后已由普通退款全额
退回但仍处于"未接单"；关桌对话框只列出"10 个菜品等待付款或接单"，没有任何可走的路径。真实门店里客人走了，
店长必须能当场把桌子收尾：已付未做的退钱，未付的作废，做了没上的说明去向，然后关桌。

## 决定

1. **入口与权限**：Tables → 选桌 → "Close the table"。对话框在原有阻塞说明下增加"If the guests have left"，
   仅向可关桌者（`dining.session.close`、`order.close`、`dining.item.serve` 全部允许，即 Owner/Store Manager）
   显示；每一步命令仍按 `ordering.order.cancel` 及 PIN 二次验证（`full_sign_in_required`）重新授权。
2. **逐轮计划（服务端只读）**：新 `POST /merchant/dining/table-close-plan`（`merchant-dining-table-close-plan.ts`）
   由各领域所有者事实组成，每轮给出状态与金额：
   - 未付（`NotPaid`）：无收款，到付款截止时间由系统自动取消（显示门店时间）；在线付款进行中则等待结果。
   - 已付未接单（`PaidNotSent`）：整轮取消并全额退款（含小费）；在线→服务商退款（补偿工作负载），刷卡机→"在刷卡机退款
     并在订单页记录"。
   - 已付未接单且已全额退款（`AlreadyRefunded`）：只关闭该轮，不再退款。
   - 已接单、厨房未开始（`NotStarted`）：沿用既有整轮员工取消与退款。
   - 部分已开始（`PartlyStarted`，仅在线付款）：未开始的菜品用既有按菜品取消（退款金额来自其预览），已在做的须上桌或
     在订单页标记已上。刷卡机付款的轮次不能按菜品取消，归入 `BeingMade`，提示上桌/标记已上。
   - 已取消待退款：刷卡机待退（`RefundOnCardMachine`）或在线退款进行中（`Refunding`），桌子在退款完成前不能关。
     确认前显示合计："refunds CAD x to the guest online and CAD y to refund on the card machine"。
3. **执行**：勾选"The guests at table T have left"后逐轮调用既有命令（`/merchant/orders/cancel`、
   `/merchant/orders/cancel-items`），原因一律 `GUEST_LEFT`（员工文字"Guests left"，顾客文字"The table was closed
   after your party left, before this was made."）；每轮一个操作号，结果未知时以同一操作号重试，绝不重复取消或退款；
   每步后重读计划（订单版本随每次取消递增）。全部处理后按原流程关桌（停止点单→关单→释放桌台）。
4. **已付未接单轮次的员工取消（扩展既有命令，不新建命令）**：`order_staff_cancellation` 增加
   `previous_phase='Submitted'`（仅堂食；付款依据为 Ordering 记录的"等待接单"付款 `order_payment_acceptance_wait`，
   其 `wait_id` 即等待处置号，触发器校验，不再用外键指向 Confirmed 处置）与 `refund_disposition`
   （`Refund`/`AlreadyRefunded`，后者只用于从未接单且服务端在订单围栏下由 Payment 证明已全额退回的轮次，不开补偿）。
   取消后：该等待付款不再被重放（`listUnresolved` 排除）、订单页不再提供"Accept"、接单触发器拒绝再接单、库存在同一事务释放、
   审计 `ORDER_CANCELLED_BY_STAFF` 记录原因与 `previousPhase`、`refund`。历史只追加，不改任何既有记录。
5. **全部轮次已取消的订单（v15 DEMO-03/DEMO-01）**：员工读取（上菜进度、关桌证据、关单）以 `includeCancelled`
   读取该订单（顾客与结账读取不变），`order-progress` 不再 404；关桌时以 `ORDER_CANCELLED` 关闭该订单后释放桌台。
   订单确实不存在时提示"This table's order wasn't found at this store"，不再误报网络问题。

## 迁移与授权

迁移 `2000_057_alter_staff_cancellation_guest_left`：两张员工取消表的原因增加 `GUEST_LEFT`；
`order_staff_cancellation` 的 `previous_phase`、`expected_order_version`（首轮未接单可为 1）约束放宽、去掉付款处置外键、
增加 `refund_disposition` 列（默认 `Refund`）与两条一致性约束、替换校验函数。无新表、无新授权
（API 角色已有相关表读写；新读取的 `order_payment_acceptance_wait` 已在试点授权内）。按 Owner 常设批准
（2026-10-14，WP-2423 table closure）应用于 v15。

## 已知限制

- 刷卡机付款且部分已开始的轮次不能按菜品取消（沿用 Q7 第一步规则），需上桌或标记已上。
- 在线退款由补偿工作负载异步完成，桌子在退款确认前保持"Refunding"，不能关；这是有意的财务完整性约束。
