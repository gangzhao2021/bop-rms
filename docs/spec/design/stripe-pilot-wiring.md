# DEC-STRIPE-PILOT-WIRING — 试点接入 Stripe（测试模式，接口先行）

状态：**Accepted（协调人按商用原则决定，2026-10-20；Owner 可推翻）**。执行工作包：[WP-2423](../work-packages/WP-2423.md)（P2）。
Owner 指示（2026-10-20）："先把接口都做好"——真实账户到位后只剩配置与真实验证。
相关：[DEC-PAYMENT-CARD-RETRY](payment-card-retry.md)、[DEC-DINING-ABANDONED-PAYMENT](dining-abandoned-payment.md)、
[退款升级](refund-escalation-pilot.md)、[退款审批边界](refund-approval-boundaries.md)、
[服务商收款对账](pilot-provider-capture-reconciliation.md)、[顾客付款交接](customer-order-payment-handoffs.md)、
[readiness inventory PILOT-PAY-01/02](../../runbooks/pilot-integration-readiness-inventory.md)。切换步骤见
[Stripe 切换 runbook](../../runbooks/pilot-stripe-switch.md)。

## 问题

仓库已有 Stripe REST 适配器（意图、客户端交接、退款、Webhook 签名）、Webhook 收件箱服务和终态服务，但试点装配始终使用
TEST-ONLY 模拟服务商：没有 Webhook 路由与收件箱存储、没有事件映射、没有从 Stripe 读收款与结算的来源、没有支付域名注册与就绪检查，
顾客端付款方式由构建时常量决定，`PaymentProvider` 能力缺口无法按配置解除。真实账户到来时仍要写代码，不符合"只剩配置"。

## 决定

1. **按配置选服务商**：运行目录 `payment.json`（0600，`schemaVersion: 1`）。缺省或 `"provider": "simulated"` → 模拟服务商（仅
   InternalTest）；`"provider": "stripe"` → Stripe 测试模式。密钥与 Webhook 签名密钥只放在各自的 0600 文件（`secretKeyFile`、
   `webhookSecretFile`、可选 `nextWebhookSecret` 轮换文件与 ≤7 天重叠窗口），每次使用时读取，不进配置文件、日志、消息或进程环境。
   `testApiBaseUrl`（仅 InternalTest、仅 `http://127.0.0.1:<port>`）把 Stripe 调用指向本地替身，标注 TEST-ONLY。
2. **同一接口面**：Stripe 绑定（`pilot-stripe-provider.mjs`）提供与模拟服务商相同的面——`adapter`（创建、读取、取消、退款、退款查询）、
   `readTerminalOccurrence`、`readCaptureJournal`、`readSettlementWindow`——所以下单、到期、退款、补偿、对账、日结各条既有 Payment
   所有者路径不变；只把"必须是模拟器"的守卫改为"已配置的服务商"。模拟确认按钮只在模拟模式存在。
3. **创建请求带 Payment 自己的引用**：`metadata[bop_payment_operation]`、`metadata[bop_payment_attempt]`（Payment 自有的不透明
   UUIDv7；不含订单、客人、员工、联系方式或任何顾客事实）。用途：服务商优先的收款发现能把一笔扣款连回付款操作（包括创建应答丢失时）。
   幂等键仍为 `create-intent:<attempt>`，重复同一创建得到同一意图（DEC-DINING-ABANDONED-PAYMENT）。
4. **拒卡即失败尝试**：Stripe 把拒卡的意图退回 `requires_payment_method` 并带失败的扣款；规范化为该尝试 `Failed`，不再交出客户端凭证。
   记录 Failed 后立即以 `cancel-declined:<attempt>` 取消该意图，旧凭证不能再付；换卡是新尝试、新意图（DEC-PAYMENT-CARD-RETRY）。
   3-D Secure 认证失败没有扣款，只以已验证事件的时间记为 `AuthenticationRequired`。
5. **终态时间用 Stripe 自己的时间**：捕获 = 扣款 `created`，失败 = 失败扣款 `created`（或认证失败事件 `created`），取消 = `canceled_at`。
   Webhook 来源的观测以该时间记录（终态所有者把已验证 Webhook 绑定到这个时间）；读取来源由终态所有者再向 Stripe 核对同一时间。
6. **公开 Webhook 端点** `POST /api/v1/payment-provider/stripe/webhook`（API 进程，在 JSON 解析之前按原始字节读取）：
   签名校验（当前/下一密钥、5 分钟窗口）→ Payment Webhook Inbox（每个 Stripe 事件一条不可改回执 + 30 天受限原始证据，按
   服务商/环境/账户/事件去重；新的 Postgres 存储基于 WP-1304 的三张表，表上有只追加规则，故不用 `ON CONFLICT`，以保存点处理并发）
   → 映射器：按元数据找到付款操作，向 Stripe 重新读取意图（权威状态，乱序或过期事件不会倒退），通过既有终态所有者写一次终态事实、审计与
   `PaymentSucceeded/PaymentFailed`。事件类型与 Stripe 现状一致时来源为 `VerifiedWebhook`，否则以 `ProviderRetrieval` 记录真实状态。
   应答：已接收并处理 → 200；签名/时间戳/载荷无效 → 400（重试无益）；依赖不可用 → 503（Stripe 重发，收件箱去重）。
   日志只记原因码。未消费的事件类型确认后无副作用；创建应答丢失时的事件由到期处理重复创建来解决。
7. **顾客"查看付款"** 与 Webhook 用同一记录器（幂等），Webhook 丢失时顾客端仍能确认；Webhook 迟到则发现已记录。
8. **收款发现与日结来源**：收款日志 = 回看窗口（默认 7 天，≤35 天，有界分页，超界则失败而非漏读）内带 BOP 元数据、已成功的意图，
   按意图引用排序、每页逐笔重新读取；日结 = 该窗口的余额交易（`charge/payment` 计收款，`refund/payment_refund` 计退款，
   `refund_failure` 冲回），其他账户变动单独计数、不混入。无 BOP 元数据的扣款不能关联，由日结金额比较暴露。
9. **顾客端运行时配置**：前端启动时读 `GET /bff/customer/payment-configuration`（模拟，或 Stripe 可发布密钥与返回地址），同一镜像两种模式；
   Stripe 模式下 `POST …/payment-handoff` 在当前客人、订单、付款窗口与所有者围栏下交出一次性客户端凭证（不存储、不记录）。
   返回地址必须是独立的净化来源（Stripe 会在返回地址上附带凭证）；仅卡支付不跳转。
10. **运维工具** `tooling/environment/pilot-stripe-operations.mjs`：`check` 只读报告（密钥模式、账户可收 CAD、本安装 Webhook URL
    的端点已启用且事件齐全、端点 API 版本等于固定版本、钱包域名已注册）；`register-domain` 默认试运行，`--apply --confirm-target <domain>`
    才向 Stripe 注册。输出不含密钥、签名密钥、客户端凭证或完整账户号。
11. **能力缺口诚实**：`PaymentProvider` 只在 `payment.json` 为 Stripe 且全部密钥文件存在、模式与环境相符时解除；Pilot 门店需要 Live，
    当前配置拒绝 `mode: "live"`，所以 Pilot 环境下该缺口仍在。
12. **本地 Stripe 替身**（`pilot-stripe-fake.mjs`，TEST-ONLY）：实现所用的 REST 子集与 Stripe 幂等语义、签名 Webhook 投递与故障注入
    （应答丢失、延迟、5xx、重复与乱序事件）。数据库验收 `stripe-pilot`（受限 NOBYPASSRLS 角色，渲染后的试点授权）以它验证：签名
    Webhook 记账、重复与重签投递无副作用、伪造/篡改/过期请求被拒且不落库、拒卡失败并取消意图、Webhook 丢失时顾客查看记账且迟到事件无副作用、
    **创建应答丢失**（`ab88fc83` ④）由重复创建得到同一意图并取消、不扣款。

## 授权

API 角色新增（`docs/spec/pilot-acl-additions.json`，Owner 2026-10-14 常设批准）：`provider_webhook_record` INSERT；
`provider_webhook_raw_evidence` INSERT、SELECT；`provider_webhook_processing_record` INSERT、SELECT。无新迁移。

## 故障时

- Stripe 不可用：新付款创建返回"未知"，顾客端可重试；已开始的付款由 Webhook、顾客查看与到期处理（重复同一创建）收尾；退款保持
  "需对账"由退款对账查询，不会重复退款。店员可用柜台刷卡机收款（Q7）。
- Webhook 端点或主机不可用：Stripe 最多重发 3 天；顾客查看与到期处理仍能确认结果；日结比较暴露遗漏。
- 网络断开：同既有流程（顾客端不重放、提示重连）。

## 仍需（仓库外 / 后续）

- **真实账户验证（Owner）**：测试账户密钥、Webhook 端点与签名密钥、钱包域名验证；用真实 Stripe 测试模式跑一次付款、拒卡、退款、
  创建应答丢失与日结，记录 API 版本。
- **Live 模式（仓库）**：Pilot 生产环境需要把 Provider 环境 `Live` 贯穿试点装配（现有约 50 处固定为 `Test`），与 Pilot 环境其他缺口
  （员工登录、托管密钥、TLS）一起交付；在此之前配置拒绝 Live。
- **原始证据 30 天清除**：表已允许过期后删除，尚无定时清除作业（需 worker 授权与作业）。
- **钱包按钮**：域名注册后，卡表单仍为 `wallets: never`，开启属后续变更。
- 公开 REST 目录（OpenAPI）未收录服务商回调路由（非顾客/商户接口）。
