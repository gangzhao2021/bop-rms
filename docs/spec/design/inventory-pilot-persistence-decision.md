# DEC-PILOT-INV-01 — 单店试点 Inventory 持久化补充提案

状态：**Accepted，Owner 于 2026-09-11 在本任务明确回复“批准”**。当前执行工作包：WP-2402。

批准范围为本记录以下六项库存持久化补充；实现与完整试点验收尚未完成。

## 为什么需要这项决定

Inventory 已实现物料、单位、库存策略及库存操作服务，但 Module Manifest 仍为 Later、
schema=null、tables=[]。WP-2120 第 5 条和 WP-2122 第 6 条明确说明：Section 50 没有分配
Inventory 数据库命名空间，因此账本与持久化仅为注入接口。现有库存展示投影和 Catalog
可售观察不能证明提交时的最终库存资格。

本提案是对 [ADR-0031](../../adr/ADR-0031-migration-catalog-namespace-bootstrap-ownership.md)
及 Section 50/94 的窄范围补充；不修改已应用迁移、公共 Helper、其他 Domain 所有权或
已接受的 Dining/Payment 时钟规则。

## 已接受的具体内容

1. 在现有 migration namespace registry 末尾追加 1900-rms-inventory，
   前缀 1900，schema 为 rms_inventory，唯一写入所有者为 @rms/inventory。
   当前注册表没有使用该前缀。注册表仍只登记位置，不独立授予表权限。
2. 激活单店试点所需的 Inventory 持久化基础。每张表仍须在 owning Module Manifest、
   database-access manifest 和当前 WP 中逐项声明。首批范围为物料/策略版本、
   scoped balance 的事务并发控制、不可变 Stock Movement、库存 Reservation、
   幂等操作记录及精确提交绑定的最终库存验证记录。高级采购、预测、供应商目录和
   多仓调拨不因本提案自动上线。
3. 每笔库存量明确 Tenant、Brand、唯一 Store/Stock Site/Location、Item、Unit，
   并按策略携带 Lot/Expiry。只允许 Inventory 的公共服务读取或改变库存。
   账本是数量事实来源；任何事务内余额缓存必须与对应不可变账本及版本同步提交，
   不以异步展示投影作为提交许可。
4. 库存增减、预留/释放/消耗、幂等结果及 Audit 原子提交，强制作用域隔离，
   并发提交不得覆盖余额或重复占用；更正通过补偿操作，禁止改写历史。
   Reserve/Consume 时点继续由明确的 Store Workflow/Item Policy 决定，
   不新增“支付前统一扣库存”的默认规则。
5. Ordering/Payment 通过版本化公共合同取得精确 Cart/Quote/Submission/Operation
   对应的库存结果，实施缺货、过期、并发变化、取消释放及未知结果恢复。
   SKU/Recipe/Option 需求来自各自 owner 的公开事实，不能擅自建立私有表查询或
   默认一件 SKU 等于一件库存物料。
6. 先以明确标记的合成数据完成真实 PostgreSQL 和跨域提交验收。
   实际门店的物料、数量、库位、单位、追踪/负库存策略及流程配置仍需其真实来源，
   缺失时保持不可用；本批准不创建或认可这些门店事实。

## 明确不包含

不批准真实余额、Manager Override、负库存放行、实际供应商/收货事实、税务或过敏原事实；
不批准 Provider 调用、支付结果、部署、推送或生产数据迁移。过敏原审核所有权和
Payment 最终资格仍按各自规范落实。

## 确认后的执行与验收

将本记录改为 Accepted 并记录本任务中的明确回复；补充关联 ADR/规范索引及 owning WP，
再添加 namespace、manifest 和全新 forward migration。运行受影响的 registry/ownership/
permission/migration 检查，并验证真实 PostgreSQL 的隔离、余额与账本一致性、
并发预留、重复操作、补偿/恢复和审计回滚。未满足完整业务流程验收前不宣称试点完成。
