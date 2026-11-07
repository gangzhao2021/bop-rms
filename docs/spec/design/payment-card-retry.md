# DEC-PAYMENT-CARD-RETRY — 卡被拒后换卡重试

状态：**Accepted（协调人按商用原则决定，2026-10-14；Owner 可推翻）**。执行工作包：[WP-2423](../work-packages/WP-2423.md)（Q20）。
相关：[DEC-ORDER-CANCELLATION-PILOT](order-cancellation-pilot.md)（Q6 未付款堂食批次到期取消）、Q12 取餐付款窗口关闭。

## 问题

顾客的卡被拒后，结果页只写"Payment failed / Contact the store if you need help with this payment."，没有任何可用路径：
堂食这一轮在付款窗口结束时被系统取消，取餐单被关闭，顾客只能重新下单或找员工。真实门店里换一张卡再付是最常见的处理方式。

## 决定

1. 付款失败后，顾客可在**同一付款意图**上开新的付款尝试（Payment Attempt，只追加）：同一订单批次、同一金额与小费、同一付款窗口。
   每次尝试有自己的服务商意图与幂等键；旧尝试及其失败事实永不修改。
2. 允许条件（Payment 服务与数据库触发器两层）：上一次尝试的终态为 Failed、该意图没有任何成功、付款窗口（`capacity_expires_at`，
   即 Q6/Q12 的期限）未结束、尝试总数不超过 5。每个意图最多一条成功终态（部分唯一索引），因此不会重复扣款。
   开新尝试前仍经同一组所有者准入（订单仍有效、Dining/容量仍待付款、库存预留仍在）。
3. 幂等与并发：新尝试按"上一次失败的尝试"去重——同时发出的两次重试只产生一个新尝试；上一个尝试仍未出结果时，重试返回它本身，
   不再向服务商创建新意图。审计记 `PAYMENT_ATTEMPT_RETRY` / `CUSTOMER_RETRY_AFTER_DECLINE`（含尝试序号）。
4. 读取一律以**最新尝试**为准：付款结果页、顾客订单页、Q6 到期取消的付款证据、Q12 取餐窗口关闭、员工"Payment failed · will be
   cancelled"提示、订单付款清单与对账候选。换卡成功后该轮按已付款处理、员工提示消失、到期不取消；再次失败则照旧在期限时取消。
   付款状态投影：后一次尝试的结果取代前一次失败的投影（旧行保留、仅置为非活动）。
5. 顾客界面：结果页写"Your card was declined. Try another card or ask staff to pay at the counter."，显示应付金额与
   "Try another card"；点后在同页打开新的卡表单（模拟器为确认/模拟拒卡按钮，仅内部测试）。不能再试时用顾客语言说明原因
   （次数用完请到柜台付款；付款时间已过、未扣款请找员工；上一张卡仍在确认）。请求不带金额或小费，服务端沿用原付款。

## 故障时

- 网络断开：按钮不可用并提示"Reconnect to pay with another card."；不会自动重发。重连后重试使用同一去重规则。
- 服务器或服务商不可用：显示"We couldn't open another card payment…"并可重试；未生成尝试即未扣款。
- 付款窗口结束：不再接受新尝试，按 Q6/Q12 处理（堂食这一轮取消、取餐单关闭、未扣款）；员工可用柜台刷卡机收款（Q7）。
- 新尝试已打开但顾客离开：该尝试保持"处理中"，与首次尝试相同由服务商对账解决（见下"Stripe 接入要求"）。

## 外部关口（不在仓库内完成）

- **Apple Pay / Google Pay**：需要在 Stripe 后台为顾客端域名完成域名验证（Apple Pay 还需托管验证文件），属外部关口；
  在此之前卡表单保持 `wallets: { applePay: "never", googlePay: "never" }`，不显示钱包按钮。
- **Stripe 接入要求**（Stripe 适配器尚未接入试点）：新尝试对应新的 Stripe PaymentIntent；接入时须在开新尝试前取消上一个
  已失败尝试的 PaymentIntent（或改为在同一 PaymentIntent 上重新确认），并确认未完成的尝试会被服务商对账关闭，避免旧客户端密钥被再次确认。
