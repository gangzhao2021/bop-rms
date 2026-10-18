# DEC-INV-LOCATIONS — 仓点与存放位置的维护

状态：**Accepted**。2026-10-07，Owner 在会话中确认（“按你的建议做”）。执行工作包：[WP-2423](../work-packages/WP-2423.md)。

## 背景

Section 30.4 规定库存余额按 Inventory Item × Stock Site × Storage Location 管理，第一版支持门店或仓库内部的
存放位置（如 Back Room、Fridge、Freezer、Bar、Kitchen Line），小店可以只启用一个默认位置；Location 之间的移动
记录为 Transfer。Section 88 的页面清单没有维护仓点与存放位置的页面，系统也没有这两类主数据。

## 决定

1. **Inventory 拥有**仓点（Stock Site）与存放位置（Storage Location）主数据，按 Tenant / Brand / Store 隔离，
   只追加的版本历史、幂等操作与审计，与 Inventory Item 主数据同一模式。
2. 每家门店有一个**默认仓点**（类型 Store）与一个**默认存放位置**，作为门店库存设置的一部分开立；
   这是 Section 30.4 允许的最小配置。
3. 存放位置属性：编码（门店内唯一）、多语言名称、温区 `Ambient | Chilled | Frozen`、排序、状态 `Active | Inactive`。
   仍有库存（在库或预留不为零）的位置不能停用，须先调拨或盘空；默认位置不能停用。
4. 新增页面 **`INV-LOCATION-LIST`**，路由 `/app/supply/locations`，导航分组 Supply：列出当前门店的仓点与位置，
   支持新增、改名、设置温区与排序、停用/启用；读取需要 `inventory.location.read`，维护需要 `inventory.location.manage`
   （2026-10-07 按 DEC-PERM-CATALOG 由 `inventory.manage` 细分）；门店尚无仓点时，页面提供“开通门店库存”，在一个事务中建立
   默认仓点与默认位置；遵循 Section 88 的状态、响应式与无障碍规则。
5. 进货、盘点、损耗选择存放位置；批次与临期视图按位置筛选。库存账户（品项 × 仓点 × 位置 × 批次）只能引用
   已登记的仓点与位置。

## 不改变

不改变 Section 30 的其他规则、Transfer 的后置安排与其他页面契约。
