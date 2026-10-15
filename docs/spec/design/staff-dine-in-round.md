# DEC-STAFF-DINE-IN-ROUND — 店员代客堂食点单（Q7 第二片）

状态：**协调人按商用原则决定（2026-10-15），Owner 可推翻**。执行工作包：[WP-2423](../work-packages/WP-2423.md)（剩余工作第 3 项，Q7 第二片）。
依据：[DEC-COUNTER-PAYMENT-RECORD](counter-payment-record.md) 第 1 条（员工代客点单"取餐或堂食"可记录门店刷卡机收款）、
[DEC-DINING-ANY-PARTICIPANT-SUBMIT](dining-any-participant-submit.md)（任一在座参与者可提交本桌购物车，谁提交谁付款）。

## 问题

不会用或不愿用手机的堂食客人无法点单；断网期间纸单记下的堂食轮次在恢复后也只能"暂按柜台取餐补录"，不进本桌订单。
柜台点单（Q7 第一片）只支持取餐。

## 现状核实（决定前，按源码）

- 本店堂食是**每轮先付款**：每一轮由提交人当场付款，厨房只收到已付款并接单的轮次；付款窗口为封存后 30 分钟。系统自动取消
  只针对**线上付款失败**的轮次（`UnpaidDineInBatchCancellation`）；从未发起付款的轮次不会被自动取消，只是一直不进厨房。
- 本桌只有一辆共享购物车；加入一桌需要店员在 Tables 页发的一次性桌码（6 位，15 分钟，用一次即作废）；第一个加入的人成为桌主。
- 没有"整桌最后结账（挂账）"的产品能力。

## 决定

1. **入口**：Tables 页（DIN-FLOOR-BOARD）选中一张可入座的桌 →"Take order for table T4"→ 复用 OPS-ORDER-ENTRY 页面的"桌台模式"
   （`/operations/order-entry?table=…`）。显示该桌名称、堂食菜单（`?orderType=DineIn`，与桌上顾客看到的一致，含售罄），可选选项、
   数量、每道菜的厨房备注（≤140 字，服务端按 Ordering 备注规则校验）、小费、"断网后补录"。
2. **走顾客同一路径（不另写定价/售罄/提交逻辑）**：服务端命令 `POST /merchant/dining/staff-rounds` 在一次店员请求内依次：
   按店员的桌台权限给该桌发一次性桌码（无会话则开台，有会话则换发新码，与店员在 Tables 页的操作相同）→ 用该桌印刷的桌码二维码进入
   → 用桌码加入本桌 → 堂食绑定 → 选取本桌共享购物车 → 逐项加菜（售罄/下架/选项无效即拒绝并指出哪一行）→ 堂食报价（含税）→
   结账资料（无联系方式、现场收据）→ 堂食结账 → 首轮或加单轮的提交、小费记录与付款时钟（与顾客 `payment-intents` 相同的准备步骤，
   只是不调用支付服务商）。凭据只在内存中，不返回、不记日志。结果是该轮的金额（报价含税 + 小费）、桌名与付款截止时间。
3. **桌上已有未发送的菜**：本桌共享购物车里若有客人加了但没发送的菜，拒绝并列出菜名与数量，请客人在手机上发送或删除后再发——
   否则这些菜会被并入店员这一轮并由刷卡机收款。另一位客人正在手机上付款时同样拒绝（"稍等一分钟再发"）。
4. **付款**：与本店所有堂食轮次相同，**先付款再进厨房**：店员在桌边用门店刷卡机收这一轮，再点"Paid on card machine"记录
   （DEC-COUNTER-PAYMENT-RECORD 的同一记录与 `PaymentSucceeded`），随即自动接单进厨房。付款准入改用堂食规则（首轮：Dining 付款时钟；
   加单轮：加单批次历史 + 完整库存预留）。客人不能用手机为店员录入的一轮付款（付款归属提交人）。
5. **自动取消**：店员录入的一轮**不会**因为"没有客人在手机上付款"被取消——自动取消只作用于线上付款失败的轮次，店员轮次没有线上付款。
   页面在发送后提示"在 HH:MM 前记录付款；记录后厨房才开始"；超过付款窗口后不能再在系统里记录付款，需重新发送。订单页对未付款的
   店员轮次显示"Entered by staff · awaiting card-machine payment"，不显示"将被自动取消"。付款窗口到期后，付款期限观察把刷卡机付款
   认作该结账的成功付款（不再停在"等待付款结果"）。
6. **权限**：沿用 `ordering.order.create_staff`（代客下单；Owner、Store Manager、Front of House 已有），并要求该店员同时有
   `dining.operate`（发桌码/开台；三个角色同样已有）。**不新增权限、不改权限目录与角色模板**。PIN 会话可用（普通店员操作，
   不在须完整登录的路径清单里）。
7. **记录与审计**：Ordering 新增只追加记录 `rms_ordering.staff_dining_round_entry`（迁移 `2000_054`：店员、桌台、堂食会话、
   本轮的桌台客人会话、小费选择、是否断网补录、审计；门店 RLS、禁止改删）；同一操作编号重放返回同一轮，不会重复下单；
   审计 `ORDERING_STAFF_DINING_ROUND_STARTED`。该轮次即此桌台客人会话提交的订单批次。
8. **"Entered by staff"**：厨房卡片（店员录入的桌台轮次与柜台订单都标）、订单页批次标题与摘要、顾客"本桌"页（"Round 2 · Entered by
   staff"，未付款时说明"请向店员在刷卡机付款，付款后厨房开始"）；顾客页把刷卡机收款计入"已付"。不显示店员姓名、内部代码或编号。
9. **断网补录**：勾选"Recorded after an outage"并填实际付款时间（72 小时内），即使已打烊也可录入；记录原因 `RecordedAfterOutage`，
   日结按实际付款时间计入当天。若已做好上桌，页面提示在厨房标为已做好、在订单上标为已上桌。
10. **桌主**：店员的桌台客人在空桌开台时成为桌主（与第一个加入的客人相同规则）；之后有客人用手机加入时，店员可在 Tables 页转移桌主。
    每次店员录入都会换发该桌一次性桌码：此前发出而尚未使用的桌码作废，已加入的客人不受影响（页面与本决定说明）。

## 授权

新增 api 对 `rms_ordering.staff_dining_round_entry` 的 SELECT/INSERT（写入 `pilot-acl-additions.json`，
"Owner standing approval 2026-10-14 (WP-2423 Q7 staff dine-in)"）。其余读取（刷卡机付款、桌台、会话、加单批次历史）已有授权。

## 已知限制（后续）

- ~~超过付款窗口仍未付款的店员轮次不会被关闭~~：已由下方"实现决定（2026-10-15，剩余工作第 5 项）"解决——到期由系统取消（`PAYMENT_NOT_STARTED`），并提前在店员所在页面预警。
- 店员只能在发送该轮的那个点单页面上记录刷卡机收款；离开该页面后（刷新、换设备），订单页与桌台页只显示截止时间与预警，不能补记。
  到期未记录的轮次被取消；若刷卡机其实已扣款，按页面提示在刷卡机上退款，或在断网/误操作后用"Recorded after an outage"重新录入该轮（72 小时内）。
- 刷卡机付款的部分/按菜品退款仍是剩余工作第 4 项；店员录入的一轮被门店取消时按 Q6 记录"刷卡机退款"。
- 没有"整桌最后结账"：若门店将来改为先吃后付，需要另行决定挂账、厨房放行与付款的关系。

## 实现决定（2026-10-15，剩余工作第 5 项"订单收尾一致性"，协调人按商用原则决定，Owner 可推翻）

1. **到期关闭**：店员录入的一轮（以及顾客提交后从未开始付款的一轮）在付款窗口结束（封存后 30 分钟）时仍无任何付款——没有线上付款意向，
   也没有刷卡机收款记录——由系统取消。这与"付款失败的一轮到期取消"是同一个机制：同一 Pilot 工作流转换（`UnpaidDineInBatchCancellation`，
   权限 `order.batch.cancel.expired`，内容不变、无需重新发布）、同一只追加的 Ordering 取消记录 `order_batch_checkout_cancellation`、
   同一事务内释放库存预留（与其他未付关闭相同的释放）、同一审计 `ORDERING_BATCH_CHECKOUT_CANCELLED`，原因区分为
   `PAYMENT_NOT_STARTED`（付款失败仍为 `CHECKOUT_DEADLINE_REACHED`）。不新建并行机制，由现有业务 worker 的未付批次取消任务执行。
2. **只在确实没收钱时取消**：取消前在付款操作围栏下重读 Payment：只要该轮有线上付款意向（不论结果）或刷卡机收款记录，就不取消
   （`NotEligible`，等待付款结果，钱可能已经动了）；数据库触发器另行拒绝 Ordering 已记录付款（等待接单或付款处置）的一轮，并要求所依据的
   到期证据是该轮最新的一条（迁移 `2000_056`）。付款准入在截止后拒绝新付款，因此取消后不会再被收费；若仍有付款到达，沿用已有的
   "已付款无法履约（SubmissionCancelled）"自动退款。没有扣款，所以取消本身不退任何钱。
3. **事件**：每次系统取消一轮都在同一事务发布 Ordering 的 `OrderCancelled` v1（Handoff 第 48.4.4 / 52.16 节 `rms.ordering.OrderCancelled.v1`；
   Order 聚合、版本为取消后的订单版本、System 操作者、只含引用、原因、菜品数与记录摘要）。试点部署其消费者
   `ordering.order-status-projection:v1`：顾客订单状态投影推进到该版本与检查点；阶段与轮次不变（DEC-PILOT-BATCH-PHASE-01，取消的一轮从
   Ordering 取消记录显示）。
4. **到期前预警（AGENTS"warn before timeouts"）**：
   - 点单页（OPS-ORDER-ENTRY，发送后的收款面板）：显示"Record the payment by HH:MM…"，最后 10 分钟变为醒目的
     "N min left: record the payment by HH:MM or this round is cancelled…"，到期后说明已取消、未进厨房、系统内未收费，若刷卡机已扣款请在机上退款。
   - 桌台页（DIN-FLOOR-BOARD）：该桌当前这桌客人有店员录入、仍待刷卡机收款的轮次时，桌卡与选中桌详情显示截止时间，最后 10 分钟为醒目提示，
     到期后说明正在取消；有待收款轮次时每 15 秒更新倒计时、每 30 秒后台重读。
   - 订单页（OPS-ORDER-QUEUE）：未开始付款的一轮显示"Entered by staff · record the card-machine payment by HH:MM or it is cancelled"
     （顾客轮次为"Not paid · cancelled automatically at HH:MM unless paid"），最后 10 分钟加"(N min left)"并标为紧急；取消后显示
     "Batch cancelled · not paid…never went to the kitchen. Nothing was charged for it in the system."，店员轮次另提示"若刷卡机已扣款请在机上退款"。
   - 顾客"本桌"页：待付款且未开始付款的一轮说明"若在 HH:MM 前未付款，该轮会被取消，不会收费"；取消后显示"Cancelled — not paid in time"
     与"This round never went to the kitchen. No one was charged for it."。不显示内部代码或编号。
5. **断网与设备故障**：店员在发送后断网而无法记录收款时，该轮会在到期时取消；恢复后按"断网后补录"（Recorded after an outage，实际收款时间，
   72 小时内）重新录入该轮并记录收款，不会重复收费（刷卡机已扣的那笔即补录的收款）。运维手册的断网流程适用。
6. **授权与迁移**：迁移 `2000_056`（放宽取消原因与触发器，无新表）；不新增数据库授权（api 已有取消记录、修订、发件箱、审计与 Payment
   读取的授权），不改权限目录。

## 实现决定（2026-10-15，v15 实测"无桌码的桌点单 503 并留下空会话"，协调人按商用原则决定，Owner 可推翻）

v15 DEMO-01/03 没有签发桌码，"Take order for table"返回 503 并留下一个没有订单的 Active 堂食会话（先开台、后用桌码进入时失败）。

1. **店员轮次仍经桌码进入，不另开无码通道**。店员录入的一轮按决定 2 以本桌客人的身份走顾客同一路径；Dining 契约要求顾客会话的
   `qrRevocationVersion` 等于桌台当前 `qrVersion`，之后的购物车、报价、结账、提交每一步都按该桌码校验会话。"不凭桌码开台"需要新增一种
   绕过桌码作废规则的客人会话，等于重开已接受的 Guest/Dining 契约（AGENTS 不得重开已接受决定），且会让被停用的码所在桌仍可被
   当作客人入口。真实门店里桌码是桌台上线的一次性设置（店长在 Table QR codes 页"Create code"，可稍后打印），不是每次点单的前提；
   因此选"按钮不可用并说明原因与去处"。被停用（Turned off）的桌同样处理。
2. **桌台页（DIN-FLOOR-BOARD）**：没有可用桌码的桌不显示"Take order for table"，改为"Orders can't be taken for table T yet: it has no
   table QR code."，有 `dining.table.qr.manage` 的员工看到指向 Table QR codes 页的链接（"Create one on Table QR codes (it can be printed
   later), then take the order."），其他员工看到"Ask a manager to create one on the Table QR codes page…"。点单页直接打开该桌时同样先说明，
   不发送任何请求。
3. **不留空会话**：服务端命令改为先用桌码进入（只读桌码与签发一个尚未加入任何桌的客人会话，不改变桌台），再开台/换发桌台加入码；
   无桌码时在开台前拒绝，返回 409 `table_qr_missing`（页面："T has no table QR code, so orders can't be taken for it yet. Nothing was sent
   or charged…"），桌台与会话不变。门店不接单同样在开台前拒绝（原有）。
4. **剩余风险（已知）**：开台之后的步骤（加入、绑定）若因内部故障失败，仍可能留下没有订单的会话；店员没有 `dining.session.close`
   不能补偿关闭，系统补偿关闭需要新增 Dining 的"放弃空会话"命令与审计（未做，记为后续）。此时桌台页显示该桌已入座且无订单，
   店长在桌台页直接关桌（无订单时无需结单）。
