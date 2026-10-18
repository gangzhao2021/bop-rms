# DEC-CUSTOMER-ORDER-CONTINUITY — 顾客订单连续性、门店联系方式与订单通知

状态：**Proposed（实现决定按商用原则作出，2026-10-14）**；标"待 Owner 确认"的项需要 Owner 确认，标"PENDING OWNER APPROVAL (WP-2423 Q10)"的
迁移与授权需要 Owner 批准后才能在 v15 应用。执行工作包：[WP-2423](../work-packages/WP-2423.md)（Q10）。上位依据：Handoff §86（Guest Session）、
§87.4 IDR-0031（订单恢复链接）、§87.10.2.1 IDR-0027 修订 1（交易邮件）、[WP-1005](../work-packages/WP-1005.md)。

## 问题

1. 顾客关闭浏览器即失去订单：Guest Cookie 没有 `Max-Age`，是浏览器会话 Cookie；重新打开应用只看到"扫描二维码"，订单无从找回；再次扫码会签发新会话，
   正在等的取餐单在这台手机上就打不开了。
2. 堂食会话过期（或桌台关闭）的客人看到"Order access denied / 请在结账所用浏览器打开"，即使就在原浏览器，也没有回到本桌的路径。
3. 收集的取餐手机/邮箱从未使用：店员看不到，也没有任何通知；"邮件收据"可选但从不发送（无可达占位）。
4. "联系门店"不给门店电话与地址；收据显示 `Delivery status: Unavailable` 等内部代码。
5. 付款页：小费选择把所有内部失败都变成 404，顾客看到"This checkout is no longer available"，没有重试；付款结果页说"Payment confirmed"，
   随后订单状态页在接单前说"Payment pending"。

## 决定

1. **会话保持（不改 §86 时限）**：Guest Cookie 改为持久 Cookie，`Max-Age` = 会话绝对时长 24 小时（Identity 持有该常量与序列化，签发与
   换签都用同一函数）。服务端时限照旧：空闲 4 小时、绝对 24 小时、订单结束后 2 小时，以先到者为准。这样关闭/重开浏览器（同一设备）24 小时内
   订单仍可打开；订单页地址可加入书签或主屏幕。不延长会话：正常取餐单在数小时内完成，4/24 小时已覆盖；更长的跨设备找回走第 3 条的恢复链接。
2. **继续订单**：会话引导读取（`/api/v1/customer/session/csrf`）在确认会话后返回该会话最近一张订单（订单号、类型、引用；Ordering 所有者读取
   `findLatestGuestSessionOrder`，只按已确认的会话查）。重新打开应用（无二维码）时首页显示"Your order N / View order N"，堂食另给"Your table"。
   **再次扫码时先保护订单**：若当前会话有订单，入口页先显示该订单，不自动签发新会话；顾客选"Start a new order"并被告知"这会在本机关闭此订单，
   门店仍保有它"后才开始新访问。
3. **订单链接按 IDR-0031，不做可长期收藏的公开链接**：IDR-0031 规定 `orderReference` 不是凭据，订单与收据查询必须有该店该单的 Guest Session；
   带外恢复链接是 `https://<顾客域名>/resume#t=<令牌>`：256 位单次令牌、30 分钟、服务端只存带密钥哈希、消费即作废兄弟令牌、明文只存在于通知进程内存
   与送达的消息里。因此：
   - 同一设备的"收藏"由第 1 条实现（持久 Cookie + 订单页地址）。
   - 可长期收藏、可转发的公开订单链接与 IDR-0031 冲突，**不采用**；若 Owner 需要，须先修订 IDR-0031（待 Owner 确认是否需要）。
   - 恢复链接只能经短信/邮件送达；没有服务商就没有送达渠道。令牌持久化、`/resume` 消费端点与 Guest Session 重新签发（安全敏感的身份转换）
     与服务商接入同步实现，记为剩余工作 R1（设计见下）；通知组合已留好 `orderLink` 端口，当前为空（消息不含链接）。
4. **会话结束时说人话**：订单页、收据页、取餐码在会话已结束时显示"Your visit on this phone has ended"：堂食"桌台访问已结束或过期，重新扫桌台二维码并向店员
   要桌台码；桌台仍开着时，之前的订单都在本桌页"；取餐"门店仍有您的订单，在柜台报姓名或订单号"；并给"Go to the start"。付款后订单短暂未出现（404）
   时显示"可能需要几秒，Try again"而不是死路。不再出现"access denied / 请在结账所用浏览器打开 / session"等内部说法。
   **营业连续性**：顾客手机会话结束、没电或断网时，店员在订单页按订单号找到订单，订单详情显示取餐联系人姓名与电话（第 6 条），照常交付；
   服务器不可用时按 [DEC-COUNTER-PAYMENT-RECORD](counter-payment-record.md) 的纸单与断网补录流程（Q7）处理。
5. **门店电话与地址**：订单状态页与收据显示"Contact the store"：门店公开资料（Store 所有者、既有发布流程）中的营业电话（`tel:` 链接，可为空则不显示）
   与地址。读取在已授权的订单/收据读取事务内进行；资料不可用时不显示该卡片（不编造、不显示旧值）。收据不再显示内部投递/支持状态代码。
   **v15 事实**：显示的是 v15 已发布门店资料里的值；本次未读取 v15。若资料里还是测试值或电话为空，须由 Owner 在"门店设置 → 地址/联系方式"填写真实值并发布
   （待 Owner 确认/录入；仓库不编造真实电话与地址）。
6. **收集的联系方式真正被使用**：店员在订单详情（单张订单，不在列表、日志、事件或投影里）看到"Pickup for 姓名 · Call (416) 555-0123"或邮箱（`mailto:`），
   用于"就此订单联系您"（如售罄、未取）。结账页说明改为"门店只用它就此订单联系您，例如某菜品售罄"。联系方式已按保留期清除时显示"已于某日清除"。
   "邮件收据"选项在门店邮件账户接通前隐藏，不收邮箱（同 Q15"发送接通前隐藏"）；收据页给"Print or save receipt"。
7. **订单通知（服务商属外部关口）**：Notification 新增"顾客订单消息"端口与服务：只发往顾客为该单给出的联系方式，按其选择的渠道（手机→短信，邮箱→邮件）；
   内容只有门店名与订单号（"DEMO Store: we have your order 12…"/"…your order 12 is ready. Show this order number at the pickup counter."）。
   - **未配置服务商时不激活**：不渲染、不发送、不记录、不显示相关界面；触发组合（`PaymentSucceeded`→"已收到订单"，`KitchenOrderReady`→"可取餐"）
     在两个渠道都没有服务商时连订单都不读。试点当前即此状态，不注册该消费者。
   - **有服务商时**：每单每用途一次——先追加尝试记录再调用服务商，再追加结果（Accepted/Rejected/Unknown）；超时记 Unknown，不盲目重发。
   - **记录不含个人信息**：尝试记录只指向 Ordering 的结账资料记录（编号与版本），不存手机号/邮箱/姓名/消息正文；结果只存服务商的不透明消息编号。
   - 接入步骤（外部关口打开后）：Owner 提供短信/邮件账户与发件身份 → 实现服务商适配器 → 事件目录登记两个消费者 → 在试点 worker 注册 → 授权见下。
8. **联系方式保留与清除**：**保留 30 天（自结账资料记录时起；订单当天完成）——Owner 已确认（2026-10-18，"30 天（推荐）"）**。到期后从结账资料中清除取餐联系人与收据邮箱
   （置为"无联系方式、现场收据"），记录、订单、付款、审计的其他内容不变；每次清除先追加证据（何时、哪条政策、保留天数，不含被清除的值）。数据库只接受
   "带证据的这一种清除"，其他对结账资料的修改一律无效（与原规则相同，静默不生效）。机制：Ordering 所有者操作 `redactExpiredCheckoutContacts`
   （每次最多 N 条、按门店范围、`SKIP LOCKED`）。运行：试点业务 worker 每日清除（见 R2）。
   与 Q16（隐私声明、PIPEDA）共用此机制；隐私声明文本属外部。
9. **付款页不再死路，状态不再矛盾**：
   - 小费选择只有身份/绑定拒绝保持隐藏的 404；锁等待、数据库等内部失败改为可重试的 503。
   - 付款页把"结账已结束（服务端不再认得）"与"暂时读不到"分开：前者"This checkout has ended / 未扣款 / Back to your cart"，后者"We couldn't load
     your payment / 未扣款 / Try again"。
   - 矛盾的根因：付款结果页读 Payment 的终态事实，订单状态页读异步更新的付款状态投影，消费者滞后时状态页说"Payment pending"。现在状态页在投影
     尚无该笔付款时直接用 Payment 所有者的终态事实（`listOrderPaymentTerminalOutcomes`，同一服务商账户与环境范围），两页说法一致。扣款为自动扣款
     （`capture_method=automatic`），"扣款在接单时确认"的旧推测不成立。

## 迁移与授权（PENDING OWNER APPROVAL (WP-2423 Q10)）

- 迁移 `2000_040_create_checkout_contact_redaction`（`@rms/ordering`）：证据表 `checkout_contact_redaction`（只追加、RLS、保留期 CHECK）；
  以守卫触发器替换结账资料的"禁止更新"规则（只放行带证据的清除，其他更新照旧静默不生效）。
- 迁移 `2000_041_create_customer_order_notification`（`@bop/notification`，新 schema `bop_notification`）：尝试与结果两张只追加表（RLS，一单一用途唯一）。
- 授权：
  - `api`：`SELECT ON rms_ordering.checkout_contact_redaction`（订单详情显示"已清除"；**部署顺序：先应用迁移 040 并授予此权限，再部署本次代码，否则订单详情读取失败**）。
  - 保留任务角色（worker）：`USAGE ON SCHEMA rms_ordering`；`SELECT, UPDATE ON rms_ordering.checkout_details_record`；`SELECT, INSERT ON rms_ordering.checkout_contact_redaction`。
  - 通知发送角色（worker，仅在服务商接通时）：`USAGE ON SCHEMA bop_notification`；`SELECT, INSERT ON bop_notification.customer_order_notification_attempt,
bop_notification.customer_order_notification_outcome`。
  - 其余读取沿用 `api` 已有权限（`order_header`、`order_submission_record`、`order_checkout_details_link`、`checkout_details_record`、`payment_terminal_fact`、门店公开资料）。

## 剩余工作

- **R1 订单恢复链接（IDR-0031，与短信/邮件服务商同步）**：Identity 持有"订单恢复授权"（只存带密钥哈希、用途分离的胡椒版本、30 分钟、每单最多 2 个有效兄弟、
  消费即作废兄弟）；在通知尝试前铸造；顾客打开 `/resume#t=…`，页面把片段读入内存并立即 `replaceState`，单次同源 POST；服务端在一个事务里消费令牌并
  为该订单原有的 Guest Session 重新签发凭据（会话须仍在 §86 时限内且未撤销），返回 `/orders/:orderReference`；失败统一显示"链接已过期或已使用，请向店员
  报订单号"。按 §87.4.2 每单/联系方式/IP 每小时 5 次。验收：单次、过期、兄弟作废、跨店拒绝、令牌不进日志/Referrer/存储。
- **R2 保留任务调度（已完成，2026-10-14）**：试点业务 worker 常开 `business-contact-retention` 循环（`tooling/environment/pilot-contact-retention.mjs`），以 api 角色资源每 60 秒检查一次，到期即按门店范围每批最多 100 条清除；满批继续下一批，不满批则当天结束、24 小时后再跑；失败的批次整体回滚，下次重试。健康文件 `business-contact-retention.health.json`纳入启动检查。核对方法：`rms_ordering.checkout_contact_redaction` 当日新增行数与该循环健康文件的 `completedCycles`。
- **R3 服务商适配器**：短信/邮件账户、发件身份、退信/投诉处理（IDR-0027 修订 1）属外部关口。

## Owner 决定（2026-10-14，"按建议，批准"）

1. 顾客联系方式保留期：下单后 30 天删除，只留不含原值的删除记录。
2. 不做可收藏或分享的长期订单链接；接入短信/邮件服务后按 IDR-0031 做一次性、30 分钟有效的找回链接并经短信/邮件发送。
3. 批准迁移 040/041 与授权：api 对 `rms_ordering.checkout_contact_redaction` SELECT、INSERT，对 `rms_ordering.checkout_details_record` UPDATE（数据库只接受清空联系方式这一种更新）；30 天删除任务由试点后台任务以 api 身份运行。通知相关授权待服务就绪后另批。

## Owner 确认（2026-10-18）

- 第 8 项联系方式保留期：Owner 答"30 天（推荐）"。保留 30 天、到期清除并只留不含原值的证据，与已实现并在 v15 运行的
  `business-contact-retention` 一致，无需改动。
