# DEC-DINE-IN-PAID-ROUND-WAIT — 堂食已付轮次等待接单

状态：协调人决定（2026-10-16，WP-2423），Owner 可推翻。

## 问题

堂食每一轮在顾客付款后要由店员在 Orders 页接单，厨房才收到。v15 订单 7、9 实测：已付轮次没有接单时限，也没有提醒，可以一直停在"已付、未接单"，顾客已付款并在桌边等待。

## 决定

1. 已付的堂食轮次**永不自动取消、永不自动退款**。顾客人在店内、已付款，只能由店员决定：接单；若做不了，先接单再由经理按现有"取消轮次"流程全额退款（含小费）。外卖自取订单保持原有接单时限（付款后 30 分钟，过期由 Payment 退款），不受本决定影响。
2. 提醒按"付款后已等待时间"分三级，起点为 Ordering 记录该轮"已付、待接单"的时间（`order_payment_acceptance_wait.evaluated_at`）：
   - 0–4 分钟：普通提示"Paid · the kitchen gets it once you accept it"。
   - 5–9 分钟：警告（黄）"Paid N min ago · the guest is waiting. Accept it to send it to the kitchen"。
   - 10 分钟起：紧急（红）"Paid N min ago and still not accepted · accept it now. It is never cancelled or refunded automatically; if it can't be made, accept it and a manager can cancel it for a full refund"。
3. 显示位置：
   - Orders：在该轮的接单按钮旁显示，每 10 秒更新。
   - Tables：桌台卡片和选中桌台面板显示最早一轮，例如"Round 2 paid 7 min ago · accept it on the Orders page…"，其余轮次显示"(and N more paid rounds)"。有待接单轮次时每 15 秒走时，每 30 秒重读。
   - Home：同一订单有多轮待接单时按轮次计数，例如"2 rounds awaiting acceptance in 1 order"；有等待 10 分钟以上的轮次时加注"(1 paid 10+ min ago)"。
4. 运行连续性：提醒只读现有 Ordering 事实，无新写入，也无定时任务。网络或云端中断时页面转为只读并重试（IDR-0039）；恢复后按真实付款时间重新计算等待时长，不会因中断而误退款。

## 理由

自动退款适合不在店内的自取顾客；堂食顾客就在店里，静默退款会让已付款的客人既没吃到也不知情。真实门店的做法是让前厅尽快处理，并在拖延时越来越醒目地提醒。5 和 10 分钟两个阈值分别对应"开始等待"和"明显拖延"，与未付轮次"末 10 分钟标红"的提醒保持一致。

## 实现

- Ordering：`listStorePaidOrderBatches` 增加 `awaitingSince`；新增 `listStorePaidDiningRoundsAwaitingAcceptance`，一次读出页面上所有开放会话的待接单轮次。
- API：订单队列每轮新增 `awaitingAcceptanceSince`，只在可接单的堂食轮次上给出；桌台读取新增 `roundsAwaitingAcceptance`（轮次号、付款时间，不含引用）。
- 商户端：新增 `paid-round-wait.ts`（阈值与文案），供 Orders、Tables、Home 使用。

无迁移，无新增授权（api 角色已有 `order_payment_acceptance_wait`、`order_payment_disposition_record` 的 SELECT）。
