# DEC-SOLD-OUT-FLOOR-STAFF — 厨房与前厅标记"今日售罄"

状态：**Accepted（协调人按商用原则决定，2026-10-14；Owner 可推翻）**。执行工作包：[WP-2423](../work-packages/WP-2423.md)（Q17）。
上位依据：[DEC-PERM-CATALOG](permission-catalog-and-store-roles.md)、Handoff §88 `CAT-AVAILABILITY`。

## 问题

真实门店里最先发现某个菜卖完的是厨房（备料用完）和前厅（顾客点单时发现）。原来只有持 `catalog.sku.availability.manage`
的店长/店主能标记售罄；店长不在场时顾客仍能下单已卖完的菜，只能事后逐单取消、退款。

## 决定

1. 新权限 `catalog.sku.sold_out.mark`（"Mark an item sold out for the rest of today and back in stock"，Low），权限目录 v10。
   厨房（kitchen）与前厅（front_of_house）模板获得它；店长同时持有它与原有的 `catalog.sku.availability.manage`；店主持有全部。
   品牌模板（Brand Owner、Menu Manager）不取这项门店现场权限，继续用原有的广义权限。
2. 范围只限"今日售罄"：在本店把一个商品标记为售罄直到本营业日结束（`EndOfDay`，营业日结束时自动恢复），以及把今日的售罄标记恢复为有货。
   不能：在门店上架/下架商品、标记"售罄直到另行通知"、恢复经理设置的"直到另行通知"标记、修改菜单、价格或营业时间。
3. 强制在两层：商户接口（无广义权限时拒绝 `UntilBack`、上架/下架，以及存在无期限标记时的恢复）；Catalog 可用性服务
   （仅门店范围接受该权限；只能新建本店 `SOLD_OUT`、`Unavailable`、在 25 小时内结束的规则，只能 Draft→Active 与 Active→Inactive，
   不能改写规则）。每次操作写平台审计，记录具名员工与门店（`CATALOG_AVAILABILITY_CREATE`/`CHANGELIFECYCLE`）。
4. 入口：厨房看板标题栏"Mark an item sold out"按钮与工作台导航"Item availability"（对持该权限者显示，无需 `catalog.sku.read`）。
   现场员工在该页只看到本店在售与已售罄的商品，只有"Sold out today"与"Back in stock"，不显示内部商品编码；
   经理设置的无期限售罄显示"A manager marked this sold out until further notice. Ask a manager to bring it back."
5. 顾客端：顾客菜单每次读取都按同一条 `SOLD_OUT` 规则显示"售罄"（Q12），由谁标记不影响；下次读取即生效。

## 故障时

网络或服务器不可用时页面显示"Offline. Nothing was confirmed; retry sends the same request again."，重试使用同一操作编号，不会重复标记。
无法标记期间：前厅口头告知顾客，已下单的该菜按员工取消菜品流程处理（Q6）；需要停止全部线上点单时由店长用忙碌模式暂停（Q4）。
恢复后再标记即可；营业日结束后今日标记自动失效，不需要人工清理。

## 部署

权限目录 v10 安装与门店角色升级（v9→v10）在 v15 需 Owner 批准（已有常设批准）。目录未安装前，厨房与前厅看不到入口、请求被拒，
店长行为不变，因此代码与目录的部署顺序不影响现有功能。
