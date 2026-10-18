# DEC-KITCHEN-REWORK — 厨房重做（Rework）与误点"完成"的更正

状态：**Accepted（协调人按商用原则决定，2026-10-14；Owner 可推翻）**。执行工作包：[WP-2423](../work-packages/WP-2423.md)（Q26）。
上位依据：Handoff §26.1、§26.4、§26.6（Rework 与部分数量完成）、§30.6（库存按厨房进度扣减）、[DEC-INV-WASTE](stock-count-and-waste.md)、
[DEC-PERM-CATALOG](permission-catalog-and-store-roles.md)。

## 问题

真实厨房里菜做错、掉落、顾客退回或品质不合格时要重做；第一份菜扔掉就是损耗。原来看板只能"完成/就绪"，
重做只能线下口头处理，库存不知道多用了一份食材；误点"完成/就绪"也无法更正。

## 决定

1. **Create Rework（§26.6）**：在已完成（Completed）的原工作项上新建 Rework 工作项（`rms_kitchen.kitchen_rework_item`，
   迁移 `2000_046`），关联原工作项、厨房单与订单项；原工作项保持原结果、不回退状态（触发器与外键保证）。
   记录原因、可选说明（≤200 字，"其他"必填，只存库、不进事件/审计/日志）、份数（不超过原份数）、操作者与时间；
   每次变化一条只追加操作记录（创建/开始/完成）与一条平台审计；每个原工作项至多 20 次重做。
2. **原因**：做错（WRONG_ITEM）、掉落（DROPPED）、顾客退回（CUSTOMER_RETURNED）、品质问题（QUALITY_ISSUE）、其他（OTHER）
   ——第一份菜已做出并丢弃，记为损耗；**误点完成**（NOT_READY）——同一份菜还在做，不记损耗。
3. **误点"完成/就绪"的更正**：§26.6 规定原工作项不回退，故**不做"撤销就绪"的状态回退**（与 WP-2423 Q2 2026-10-10 更正一致）。
   改为 NOT_READY 重做项：直接进入 In Progress，只允许在原项完成或标记就绪后 **2 分钟内**（应用与数据库触发器两层），
   同一道菜同时只能有一条未完成的 NOT_READY。超过 2 分钟须选其他原因（视为重做）。
4. **事件与消费者**：新事件 `KitchenReworkCreated` v1（重做项、厨房单、原工作项、订单/批次/订单项、原因、份数、是否损耗、时间；
   无员工说明、顾客或健康信息）。Inventory 消费者 `inventory.kitchen-rework-waste:v1`：需要损耗时，经 Ordering 公开查询找到订单行，
   按该行自身的配方需求（逐行预留）取"重做份数 / 订单行份数"的份额（账本精度四舍五入），写一条 Store 损耗记录
   （`postStoreWaste`，来源 `KitchenRework`，原因映射为 PREPARATION_ERROR/DROPPED/CUSTOMER_RETURN/QUALITY/OTHER，执行人为厨房员工）；
   以事件编号为操作编号，消费者收件箱去重，重放不重复记损耗。重做的那份菜不再另扣库存：订单已按原工作项扣过一份，
   加上损耗正好等于实际做了两份。高值或无成本价的损耗照常进入独立复核（DEC-INV-WASTE）。
5. **权限**：新权限 `kitchen.work_item.rework`（中风险，权限目录 v11）：厨房、店长（`kitchen.` 前缀）、店主持有；前厅、库存管理员、
   品牌模板不持有。命名 KDS 操作员会话可执行此动作（仍以员工角色为准）。开始/完成重做只需厨房看板权限 `kitchen.operate`。
6. **界面**：厨房看板顶部"Remakes"栏，卡片标"Remake · Dropped"等员工用语（误点完成为"Back in progress · Marked done too early"），
   显示订单号/桌号、菜名、份数、加料与原因说明，按钮"Start remake"/"Remake done"；已完成卡片与"Recently finished"（2 小时内已就绪）
   列表有"Remake"，弹窗选原因、份数、说明，并说明"第一份记为损耗，顾客不会被再次收费、订单不会显示上菜两次"。
   取餐队列对仍有未完成重做的订单显示"Kitchen is remaking N items — wait for it before handing this order over"。
7. **不变的部分**：Ordering、Payment、Pricing 不变；顾客订单状态不变（不会出现同一菜两次）；Fulfillment 的就绪结果只追加、不撤销。

## v15 实测后修正（2026-10-14）

- **顾客端**：取餐订单有未完成重做时，订单页标题为"Remaking part of your order"，说明"We're remaking part of your order.
  We'll have it ready shortly — please wait before collecting it."，厨房状态"Remaking an item"，该菜"Being remade"；
  取餐码保留（不隐藏，避免顾客以为订单出错），码卡片改为"Almost ready"并提示重做完成后再出示。堂食桌页该菜显示
  "Being remade · we'll bring it to your table shortly"，该轮不再显示 Served/Ready（改为 Serving/Preparing）。
  读取经 Kitchen 公开查询 `listOpenKitchenReworkItems`（按订单与订单项引用，只含未完成份数）。
- **取餐页匹配**：重做提示按订单引用并且按该取餐单自身的订单项引用匹配，从不按单号（单号每营业日重置）。
  实测中旧"Order 2"卡片的原因：5 天前的厨房单一直留在看板上，当天被点完成并"Not ready yet"，重做确实属于那张旧订单。
  因此重做只允许在菜品进入厨房后 12 小时内（应用层 `KITCHEN_REWORK_WINDOW_CLOSED`；看板对更早的菜不显示 Remake）；
  取餐页对早于当前营业日的订单标"From Fri, Oct 9"，单独放在"From earlier days — check and close"区，等待时长按小时/天显示。
  这类旧单可用已有"未取餐关闭"流程：取餐码过期或未发出且就绪满 60 分钟后，店长关闭为未取餐（不自动退款，可另行普通退款）。
  旧厨房单在看板上滞留仍是已知问题，本次未处理。
- **看板**：命令确认后立即重读看板；投影未跟上时每 1.5 秒再读，最多 4 次（不再等 10 秒自动刷新）。

## 与 Handoff 的差异与未做

- §26.6"重新计算 ETA"：试点无 ETA 计算，未实现。
- 用户要求的"撤销就绪（2 分钟内回退）"与 §26.6"原 Work Item 不回退"冲突，按 §26.6 以 NOT_READY 重做实现；
  因就绪结果不撤销，前厅依赖取餐队列与堂食上菜页的"正在重做"提示（见下节）。
- 取消重做、堂食上菜页提示与库存不足时的损耗：2026-10-18 已处理，见下节。

## 取消重做、上菜页提示与库存不足（2026-10-18）

1. **取消重做**：未完成（Queued/In Progress）的重做可"Cancel remake"，需重做权限 `kitchen.work_item.rework`（同创建）。
   原因两种：顾客不要了（GUEST_DECLINED，"Guest doesn't want it any more"）——第一份已丢弃，损耗保留；
   误开（OPENED_BY_MISTAKE，"Opened by mistake"，含误点"Not ready yet"）——没有丢弃任何东西，损耗作废。
   Kitchen 迁移 `2000_086`：状态增加终态 Cancelled（一步、按版本、同请求重试同结果、异体冲突），记录取消人、时间、原因与事件编号，
   操作记录新增 Cancel，触发器保证只前进、每次变化有操作记录；"未完成"的定义改为 Queued/In Progress（看板、取餐、顾客订单/桌页、
   上菜页、旧单关单计数、同一道菜只能有一条未完成 NOT_READY）。平台审计 `KITCHEN_REWORK_CANCELLED`（原因 `KITCHEN_REWORK_CANCEL_<原因>`），
   事件 `KitchenReworkCancelled` v1（含创建事件编号，无员工说明）。重做本身从不预留或扣减库存（订单行已按原工作项扣过一次），
   所以取消不需要释放库存；误开时 Inventory 消费者 `inventory.kitchen-rework-cancelled-waste:v1` 按创建事件找到该重做的损耗记录，
   以 Correction 作废（数量回到库存），记为复核 Voided、原因 `KITCHEN_REMAKE_OPENED_BY_MISTAKE`、复核人为取消的员工；
   Inventory 迁移 `2000_087` 只对这一原因放宽"复核人≠记录人"（误开的人常是记录人）；损耗页的作废原因列表不含它，其余复核仍须他人。
   两个消费者在同一重做的损耗锁下处理：取消先到时无可作废，之后损耗消费者经 Kitchen 公开查询 `readKitchenReworkCancellation`
   看到"误开"即不记损耗（死信重试后同样）；店长已复核过的损耗不再改动（记为 AlreadyReviewed，在盘点中更正）。
2. **堂食上菜页**：`/merchant/dining/order-progress` 每行带 `remakingQuantity`（Kitchen 公开查询，按订单项引用匹配）；该行显示
   "Remaking — kitchen is making it again. Don't serve it until the kitchen marks the remake done; tell the guest it's being remade."，
   可上数量 = 剩余 − 重做中（同一行多份时无法知道是哪一份，重做完成前都不提供），全部在重做时状态写"Being remade"，
   "Serve all ready items"同样扣除。顾客端桌页原已显示"Being remade"。
3. **库存不足**：重做的损耗不再因可用量（在手 − 其他订单预留）不足而失败或进入死信：可用部分照常出库，其余作为 `shortfalls`
   （用量、已出库、未出库、单价与金额）保留在同一损耗记录上，记录金额含全部丢弃的食材，并标记需复核；损耗页列表注明
   "stock was short, count needed"，详情页"Stock was short — count these items"逐项列出，店长复核并盘点更正。仍不动用其他订单的预留。
   v15 已进死信的此类事件，部署后用常规恢复工具 `dead-letter-operations.mjs retry --consumer inventory.kitchen-rework-waste:v1`
   重试即按上述规则入账（原失败事务已整体回滚，收件箱无记录，不会重复）。
4. **故障时**：取消请求结果未知时显示"Remake result unknown"，"Retry same cancellation"以同一操作编号重试；Inventory 消费者延迟时
   作废以入账时刻记账。

已知遗留：订单列表"N ready to serve"计数（`merchant-order-queue-read.ts`）仍按厨房就绪计入正在重做的菜（上菜页已正确），列为后续项。

## 故障时

看板离线或请求结果未知时显示"Remake result unknown"，"Retry same remake"用同一操作编号重试，不会建两条；
服务不可用时厨房口头通知并照常重做，恢复后在"Recently finished"补录（原因如实选择；超过 2 分钟的误点只能按重做补录）。
损耗消费者延迟时以记账时刻入账，厨房时间保留在重做记录与事件上。

## 部署（v15，Owner 常设批准）

迁移 `2000_046`；api 角色对 `rms_kitchen.kitchen_rework_item` SELECT/INSERT/UPDATE、`kitchen_rework_operation` SELECT/INSERT
（`pilot-acl-additions.json`）；权限目录 v11 安装；门店角色 v10→v11 升级；重建 API dist 并重启。目录未安装前，"Remake"按钮不出现、
请求被拒，其余厨房功能不受影响。

2026-10-18 取消重做与库存不足：迁移 `2000_086`（Kitchen）、`2000_087`（Inventory）；无新表、无新授权（api 已有两张重做表与损耗复核表的所需权限）、
无权限目录变更；worker 新增消费者 `inventory.kitchen-rework-cancelled-waste:v1`；重建 API dist 并重启后，用 `dead-letter-operations.mjs`
重试 `inventory.kitchen-rework-waste:v1` 的死信。
