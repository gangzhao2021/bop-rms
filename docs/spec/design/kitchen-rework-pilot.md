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

## 与 Handoff 的差异与未做

- §26.6"重新计算 ETA"：试点无 ETA 计算，未实现。
- 用户要求的"撤销就绪（2 分钟内回退）"与 §26.6"原 Work Item 不回退"冲突，按 §26.6 以 NOT_READY 重做实现；
  因就绪结果不撤销，前厅依赖取餐队列的"正在重做"提示；堂食上菜页尚未显示该提示（后续项）。
- 已开的重做不能取消（顾客离开时重做项会留在看板上）；需要时由后续"取消重做"命令处理。
- 库存可用量不足（只剩其他订单的预留）时损耗写入失败，消费者重试后进入死信，由运营处理并在盘点中更正；不允许把预留量记为损耗。

## 故障时

看板离线或请求结果未知时显示"Remake result unknown"，"Retry same remake"用同一操作编号重试，不会建两条；
服务不可用时厨房口头通知并照常重做，恢复后在"Recently finished"补录（原因如实选择；超过 2 分钟的误点只能按重做补录）。
损耗消费者延迟时以记账时刻入账，厨房时间保留在重做记录与事件上。

## 部署（v15，Owner 常设批准）

迁移 `2000_046`；api 角色对 `rms_kitchen.kitchen_rework_item` SELECT/INSERT/UPDATE、`kitchen_rework_operation` SELECT/INSERT
（`pilot-acl-additions.json`）；权限目录 v11 安装；门店角色 v10→v11 升级；重建 API dist 并重启。目录未安装前，"Remake"按钮不出现、
请求被拒，其余厨房功能不受影响。
