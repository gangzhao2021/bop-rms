# DEC-PILOT-NOTIFICATIONS — 试点订单通知、退信处理与订单找回链接

状态：**Proposed（实现决定按商用原则作出，2026-10-20）**。依据：Owner 2026-10-20 解除 `@bop/notification` 冻结（仅试点需要，
[DEC-FOCUS-01 解除记录 2026-10-20](pilot-mainline-focus.md)）；Handoff §87.4 IDR-0031、§87.10.2.1 IDR-0027 修订 1；
[DEC-CUSTOMER-ORDER-CONTINUITY](customer-order-continuity.md) 第 3、6、7 条与剩余工作 R1、R3。执行工作包：[WP-2423](../work-packages/WP-2423.md)。
营销与推送仍冻结。本决定不需要真实账户即可完成仓库内工作；账户、发件身份、号码注册与真实投递验证是外部关口（见[运行手册](../../runbooks/notification-deliverability.md)）。

## 决定

1. **服务商（一个账户体系）**：邮件用 Amazon SES v2（`ca-central-1`），短信用 Amazon SNS 短信（`ca-central-1`，号码在 AWS End User Messaging SMS 中注册）。
   选 SNS 而不选 Twilio 的理由：与 SES 同一 AWS 账户、同一加拿大区域与同一套 IAM 凭据，顾客联系方式不经第二家服务商；
   IDR-0027 修订 1 已要求 `@aws-sdk/client-sns`（确认 SNS 订阅），短信不再增加依赖；退订（STOP）由 AWS 退订名单执行。
   代价：AWS 短信控制台对加拿大号码的注册流程比 Twilio 繁琐，需在上线前完成（运行手册）。新增依赖：`@aws-sdk/client-sesv2`、
   `@aws-sdk/client-sns`，均为仓库已固定的 `3.1094.0`（与 `@bop/media` 的 AWS 客户端同版本），锁文件只增加这两个包并把 AWS SDK
   子依赖去重到同一版本。SDK 一律 `maxAttempts: 1`、有界超时：超时或连接中断记为 `Unknown`，不盲目重发；只有服务商明确拒收（4xx 已知错误）记 `Rejected`。
2. **配置驱动、默认关闭**：运行目录 `notification.json`（0600，可缺省）选择每个渠道 `disabled`（默认，现状）或 `ses` / `sns`；凭据只按文件名引用运行目录里的
   私有密钥文件（`readPilotSecret` 规则），不进环境变量、日志或配置文件本身；未给凭据时用 AWS 默认凭据链（实例/任务角色）。任一渠道开启时必须给
   退信名单的摘要密钥文件。缺省或两渠道都 `disabled` 时：不注册事件消费者、不铸造链接、不发送、不记录，顾客页面不出现任何依赖通知的选项。
3. **试点消息（只发往顾客为该单给出的联系方式，只为说明的用途）**：
   - `PaymentSucceeded` →"已收到订单"（OrderPlaced），`KitchenOrderReady` →"可取餐"（PickupReady）：取餐单的取餐联系人，手机→短信，邮箱→邮件；
   - `PaymentSucceeded` →"邮件收据"（ReceiptEmail）：顾客结账时勾选"Email my receipt"并填写的地址，发送已开具的原始收据（自有模板、转义、无追踪），每单一次；
     收据尚未开具时消费者重试，直到收据由同一事件的收据消费者开具。
   - 每单每用途一次：先追加尝试记录，再查退信名单，再（可选）铸造找回链接，再调用服务商，再追加结果；记录不含地址、电话、姓名或正文。
   - 文本用顾客的话：门店名 + 订单号；链接句为"Open your order (the link works once, for 30 minutes)"。
4. **退信与投诉（IDR-0027 修订 1）**：SES 配置集把 Bounce/Complaint/Delivery 事件发到专用 SNS 主题，主题以 HTTPS 订阅 `POST /api/v1/provider/ses-feedback`。
   端点只接受该主题、SNS 签名第 2 版（RSA-SHA256，证书只从 `https://sns.ca-central-1.amazonaws.com/SimpleNotificationService-*.pem` 经 TLS 取得，不跟随重定向、
   有大小与时间上限、证书主题须为 SNS）；`SubscriptionConfirmation` 用 `ConfirmSubscription` 确认该主题，从不访问消息里的 `SubscribeURL`。
   验证通过后先把事件写入收件箱（`delivery_provider_event`，唯一）再回 2xx；存储不可用回 503 让 SNS 重投；不是本店发出的邮件回 200 且不存。
   硬退信和投诉：同一事务内把地址的带密钥摘要（HMAC-SHA-256，版本化密钥，读时兼容旧版本）加入本店退信名单（`contact_suppression`）并开一条投递问题
   （`delivery_issue_case`）；软退信只记录。被列入名单的地址此后不再发送（尝试记为 `Rejected`，结果 `Suppressed`）。
5. **订单找回链接 R1（IDR-0031，Identity 所有）**：
   - 铸造：通知尝试已持久化后、发送前，为该单原有的 Guest Session 铸造 256 位随机令牌；只存带密钥哈希（用途分离、版本化胡椒）、订单、会话、尝试编号、
     30 分钟到期；每单最多 2 个未到期未消费的兄弟（按订单的事务级咨询锁保证）。超过上限或铸造失败时消息照发但不带链接。
   - 链接：`https://<顾客域名>/resume#t=<令牌>`。页面在任何其他代码运行前把片段读入内存并 `history.replaceState('/resume')`，不启动会话引导、服务工作线程或入口；
     以一次同源 `POST /api/v1/customer/order-recovery`（JSON 正文，`no-referrer`）提交；`/resume` 列入服务工作线程私有路径（NetworkOnly）。
   - 消费：按订单 + 对端地址（IPv4 / IPv6 /64）带密钥的滥用预算每小时 5 次（未知令牌只按对端地址），限额器不可用时失败关闭；在一个事务里确认令牌未过期未消费、
     会话仍 Active 且在绝对 24 小时与订单结束后 2 小时内，追加 Consumed（并为所有兄弟追加 Revoked），把**同一** Guest Session 的会话/CSRF 选择器换新
     （空闲时限从此刻重新计算），追加会话操作快照，返回 `Set-Cookie` 与 `/orders/:orderReference`。数据库触发器只接受伴随 Consumed 记录、命名本次操作的换新。
   - 失败一律同一答复："This link can’t open your order / 链接已过期或已使用 / 店员按姓名或订单号找到订单 / Go to the start"；网络或服务失败可用内存中的同一令牌再试一次。
   - 原设备上的旧 Cookie 随换新失效（链接只发给顾客本人的联系方式，由其决定在哪台设备打开）。
6. **顾客界面**：结账页读取 `GET /api/v1/customer/order-messages`；只有能发送的渠道才说明"我们也会在门店收到订单与可取餐时发短信/邮件给你"；
   只有邮件接通时才出现"Email my receipt"与收据邮箱输入，并说明"只发一次，30 天后删除，可在订单页提前删除"。读取失败一律视为未接通。
   取餐联系方式与收据邮箱继续由既有 30 天保留任务与"删除我的联系方式"清除（DEC-CUSTOMER-ORDER-CONTINUITY 第 8 条）。
7. **营业连续性**：通知是附加服务，不参与下单、付款、出餐与交付。服务商、网络或云主机故障时：消息记为 `Unknown`/`Rejected` 或不发出，订单照常；
   顾客在原手机订单页（持久 Cookie）或在柜台报姓名/订单号取餐；店员在订单详情看到取餐联系人并可直接致电（第 6 条）。找回链接失效时同样到柜台。
   员工告警渠道（`pilot-alert-channels.mjs`）与本决定无关，未改。

## 迁移与授权（Owner 常设批准 2026-10-14；本决定的授权见 `docs/spec/pilot-acl-additions.json`）

- `2000_092_create_notification_delivery_feedback`（`@bop/notification`）：尝试用途增加 `ReceiptEmail`；新增 `delivery_provider_event`、`contact_suppression`、
  `delivery_issue_case`（只追加、RLS、只存摘要与不透明编号）。
- `2000_093_create_order_recovery_authorization`（`@bop/identity`）：`order_recovery_authorization`、`order_recovery_consumption`（只追加、RLS、令牌只存哈希、
  30 分钟 CHECK）；`guest_session` 选择器换新守卫触发器。
- `api` 角色（试点业务 worker 与 API 均以此角色运行）：`USAGE ON SCHEMA bop_notification`；对 041/092 五表 `SELECT, INSERT`；对两张找回表 `SELECT, INSERT`；
  `guest_session` 列 `UPDATE`（`session_selector_hash`、`csrf_selector_hash`、`operation_id`、`operation_intent_hash`、`last_seen_at`、`idle_expires_at`）。
- 其他工作树（Stripe、Cognito、密钥）也可能新增 2000 号迁移；合并时按应用顺序重新编号，运行器拒绝低于已应用最高号的待应用迁移。

## 剩余（外部关口与后续）

- 外部：AWS 账户、SES 域名验证（DKIM/SPF/DMARC）、生产访问、配置集与 SNS 主题/订阅、加拿大短信号码注册与月度花费上限、正式顾客域名；真实投递验证。
- 后续（仓库内，非阻塞）：商户端查看投递问题（现由运行手册查询 `delivery_issue_case`）；Unknown 的授权重发；多轮堂食只邮寄第一份收据。
