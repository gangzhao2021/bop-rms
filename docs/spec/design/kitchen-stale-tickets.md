# DEC-KITCHEN-STALE-TICKETS — 早于当前营业日的厨房单

状态：**Accepted（协调人按商用原则决定，2026-10-14；Owner 可推翻）**。执行工作包：[WP-2423](../work-packages/WP-2423.md)。
上位依据：Handoff §26.1（Kitchen 管理排队、开始、完成和取消；不负责商业订单、付款与退款）、§26.4、§30.6、
[DEC-KITCHEN-REWORK](kitchen-rework-pilot.md)、[DEC-PERM-CATALOG](permission-catalog-and-store-roles.md)。

## 问题

单号每个营业日重新开始。v15 实测：5 天前的"Order 2"一直留在厨房看板上，当天被误点完成并重做，与当天的"Order 2"
无法区分。所有厨房单永远是 Open，队列快照最多读 100 张单（看板、每个厨房命令的来源校验都读它），已完成的旧单也一直占位，
到第 101 张单时看板与厨房命令会一起失败。

## 决定

1. **看板分区**：看板读取经 Ordering 公开读取 `listStoreOrderBusinessDates` 给每个工作项带上订单营业日；早于门店当前营业日
   （Q21 `/merchant/business-day`）且仍有未完成工作的单不进今天的工位栏，放在默认折叠的"From earlier days — check and close"
   区，每张单显示"From Fri, Oct 9"与等待时长（分钟/小时/天）。筛选出已完成工作时，旧单的订单标签也带营业日。
   营业日未知时不分区（不隐藏任何工作）。
2. **确认**：对旧单执行 Accept / Start / Complete quantity / Mark ready / Remake 前弹出"This ticket is from Fri, Oct 9 — continue?"，
   说明单号每天重置；"Go back"不发送任何命令。重做仍只允许菜品进入厨房 12 小时内（DEC-KITCHEN-REWORK）。
3. **经理关单**：Kitchen 新命令 Close stale ticket（迁移 `2000_047`：`rms_kitchen.kitchen_ticket_closure`，每张单至多一行、只追加），
   原因：已出餐/已交付（ALREADY_SERVED）、在别处已取消（CANCELLED_ELSEWHERE）、未制作—订单放弃（NOT_MADE_ABANDONED）。
   只接受订单营业日早于当前营业日、且仍有未完成工作（未取消、未就绪的工作项或未完成的重做）的单；票据版本须与看板一致；
   同一请求重试返回同一结果。工作项保持厨房记录的状态（不改写历史）；记录订单营业日与关单营业日、未完成工作与证据摘要、
   操作者与时间；同一事务写平台审计 `KITCHEN_STALE_TICKET_CLOSED` 与事件 `KitchenTicketClosed` v1（无员工、顾客、健康或金额信息）。
   关闭后队列刷新时移出看板，看板读取在投影追上前也立即排除；数据库触发器拒绝此后为该单记录任何厨房步骤或重做（应用之外也拒绝），
   其未完成重做不再在取餐页/顾客页显示"正在重做"。
4. **钱与订单不动**：关单不退款、不取消订单、不改取餐。对话框明说："Closing the ticket does not refund or cancel the order. If the
   guest paid and did not get their food, cancel or refund Order 2 from Fri, Oct 9 in Orders"，并链接 Orders。
5. **库存**：ALREADY_SERVED 表示菜已做出，Inventory 消费者 `inventory.kitchen-ticket-closed-consumption:v1` 按完成一道菜的同一语义
   （订单行全额 Progress，重放无副作用）记录用料；其余原因不记用料，订单的库存预留随 Ordering 的取消流程释放。
6. **权限**：新权限 `kitchen.ticket.close_stale`（中风险，目录 v13）：店主、店长（`kitchen.` 前缀）持有；厨房、前厅、库存、品牌模板不持有。
   任何当前员工会话可用（含经理在厨房屏登录的命名 KDS 会话，仍以角色为准）；厨房员工看到分区但无关单按钮，提示"Ask a manager"。
7. **完成单退出看板**：队列来源读取（看板与厨房命令校验共用）在试点组合中设置 24 小时：全部工作已取消或已完成并就绪、
   无未完成重做、且 24 小时未变化的单不再读入，看板不会被历史单填满。

## 故障时

关单结果未知时显示"Close result unknown"，"Retry same close"用同一请求重试，不会记录两次；离线或看板过期时按钮不可用。
服务不可用时旧单留在折叠区，不影响今天的工作；经理恢复后再关。

## 部署（v15，Owner 常设批准 2026-10-14 (WP-2423 kitchen stale tickets)）

迁移 `2000_047`；api 角色对 `rms_kitchen.kitchen_ticket_closure` SELECT/INSERT（`pilot-acl-additions.json`）；权限目录 v13 安装；
门店角色 v12→v13 升级；重建 API dist 并重启。目录未安装前"Close ticket"不出现，分区与确认照常可用。
