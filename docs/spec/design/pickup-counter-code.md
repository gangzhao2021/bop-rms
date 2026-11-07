# DEC-PICKUP-COUNTER-CODE — 柜台可手输的六位取餐码

状态：**Accepted（协调人按商用原则决定，2026-10-14；Owner 可推翻）**。执行工作包：[WP-2423](../work-packages/WP-2423.md)（完整取餐流程 v15 实测交修 1）。
上位依据：Handoff 取餐凭证（Pickup proof，`HumanCode`/`Opaque` 两种形态，IDR 既有设计）、AGENTS.md 商用保真/运营连续性/顾客尊重/隐私规则、
[DEC-RECEIPT-TAX-AND-PRIVACY](receipt-tax-and-privacy.md)。

## 问题

v15 实测：顾客页把 22 位区分大小写的随机令牌作为"取餐码"展示，店员在柜台无法照读手输；扫码不可用（设备坏、手机屏碎、断网后
runbook 改为口头核对）时没有可手输的码。真实门店用短码：大字显示、可念出、可在数字键盘上输入。

## 决定

1. **短码形态**：六位数字（000000–999999），顾客页按"048 213"两组大字显示，屏幕阅读器逐位朗读；订单号仍单独显示。
   选数字而非字母：任何语言都能念、柜台数字键盘可输、天然不分大小写、无 0/O、1/I 混淆；与堂食桌台加入码（六位数字）一致。
   店员输入时忽略空格与连字符。长令牌保留为扫描形态（扫码枪键盘输入仍被接受），不再作为顾客看到的主码。
2. **范围与有效期**：短码只属于一个取餐凭证代次——该订单、该门店；与长令牌同时签发、同时失效（订单就绪后至多 60 分钟，
   必在签发当营业日内；之后改走已有的当面核对/未取关闭流程）。重新签发凭证即产生新短码。
3. **唯一性**：同一门店有效期重叠的两张订单不会出现相同短码。数据库插入触发器按（品牌、门店、门店级键控哈希）加咨询锁并拒绝
   重叠有效期内的重复；签发方随即取下一候选（同一凭证至多 16 个候选）。码过期后可再次出现在之后的订单上。不同门店可相同。
4. **存储**：只存键控哈希（`selector_hash` 绑定品牌/门店/订单履约，`lookup_hash` 仅绑定门店），不存码本身；顾客页由同一版本化
   派生密钥按保存的候选序号重新派生并与哈希核对后显示（与长令牌的恢复方式相同）。表 `rms_fulfillment.pickup_counter_code`
   （迁移 `2000_050`，只追加、RLS 按门店、`RestrictedCredential`）。
5. **错误次数与锁定**：每次核对不符记一条只追加的拒绝记录（`pickup_code_check_rejection`：核对人、长/短码方式、第几次、时间；
   不含所输内容），同一凭证代次第 5 次不符即锁定——之后连正确码也拒绝（HTTP 423）。同一请求重放不重复计数。原有每店员每单
   5 分钟 10 次的滥用预算保留。平台审计 `PICKUP_PROOF_REJECTED` / `PICKUP_PROOF_LOCKED`（摘要只有 operation，无码值）。
6. **锁定后的人工路径**：取餐页卡片显示"Too many wrong codes · check in person"，提供"Hand over after checking in person"：
   店员核对订单号 + 订单上的名字或手机后四位，记录当面核对（原因新增 `CodeLocked`，迁移同时放宽该检查约束）。
   凭证未锁且有效时，只能经第 6a 条的明确操作当面核对（防绕过）。
   6a. **顾客出示不了有效码（2026-10-18 补充，v15 实测 Low/运营连续性）**：手机没电/丢失、没收到码、订单页关掉时，店员不必先输错
   五次。取餐卡片在主操作"Check pickup code"旁提供次要文字按钮"Guest can't show the code"：先必选原因（固定列表，无自由文本：
   `PhoneUnavailable` "Phone is dead, lost or left behind" / `CodeNotReceived` "Customer never got the pickup code" /
   `OrderPageLost` "Order page was closed or lost"），选定后才读取订单上的名字与手机后四位，再核对订单号 + 名字或后四位。
   记录为当面核对，原因 `CodeNotShown` + `code_not_shown_cause`（迁移 `2000_085`，CHECK：原因恰在 `CodeNotShown` 时必填且在列表内），
   核对人即交付店员；平台审计 `reasonCode=PICKUP_HANDOFF_CODE_NOT_SHOWN`、摘要只含原因。浏览器只送意图（核对方式 + 原因），
   服务端在锁内重新判断：码必须仍有效且未锁；期间已过期或已锁则拒绝（422），界面提示刷新后走对应路径。权限同交付
   `fulfillment.pickup.complete`（Section 88 `FUL-PICKUP-HANDOFF` "approved alternative"）。同一幂等键重放须同一核对方式与原因。
7. **界面用语**：店员"Ask the customer to read the 6-digit pickup code"；不符"That code doesn't match this order. Check the order
   number, then ask the customer to read the code again."，输入框清空并聚焦，可再试；非六位"Pickup codes have 6 digits."；
   锁定"Too many wrong codes for this order. Check the customer in person instead…"。顾客"Show or read this code to staff"。
8. **隐私**：码不进日志、URL、分析、审计摘要、队列响应或浏览器存储；输入框不自动填充/纠错。
9. **授权**：pilot api 角色对两张新表 SELECT/INSERT（`pilot-acl-additions.json`，Owner standing approval 2026-10-14）。

## 不做 / 后续触发

- 顾客页不渲染长令牌二维码：门店暂无扫码设备，二维码无人可扫（无可达占位）。门店配置扫码工作站时再渲染（API 已有 QR 矩阵编码器）。
- 在此之前签发的凭证没有短码：顾客页照旧显示长令牌，店员可扫或当面核对；60 分钟内自然过期，不回填。
