# DEC-INV-OPENING — 开业盘点与期初库存

状态：**Accepted**（2026-10-07，按 Owner 的商用原则由执行 agent 决定并记录）。执行工作包：[WP-2423](../work-packages/WP-2423.md)。

## 背景

Section 72 / 88 规定：期初库存（Opening Balance）不是配料主数据字段，不经配料导入，而是“受控、可审计的库存初始化流程”
（Opening Balance uses controlled Stock Movement / Count workflow）。此前系统没有这条流程。

## 决定

1. **开业盘点单**（Inventory 拥有，门店隔离）：草稿 → 已提交 → 已过账；已提交可退回草稿；草稿或已提交可作废。
   每家门店**只能过账一次**（`opening_count_posting` 以门店为主键）；过账后不能再新建盘点单，之后库存只经进货、盘点、损耗等变动。
2. **盘点行**：配料 × 存放位置 ×（按配料追踪方式）批次号与到期日、数量（配料基本单位，精度不超过记账精度）、
   可选单位成本（加元分，整数）。同一配料 + 位置 + 批次不重复。配料须为启用且追踪库存，位置须为启用。
3. **批次登记**（`stock_lot`）：门店内按配料 + 印刷批次号唯一，记录到期日与来源（开业盘点 / 进货）；同一批次号的到期日必须一致。
4. **过账**：一个事务内登记批次、按需开立库存账户（配料当前版本、单位与记账精度）、每行写一条 `OpeningBalance` 流水，
   并写一条门店审计；全部成功或全部不写。账本规则：`OpeningBalance` 只能是账户的第一笔流水（版本 1→2、在库与预留为 0、数量为正），
   可被 Correction 更正。已有流水的账户不能再接收期初（逐行指出）。
5. **权限**：查看 `inventory.count.read`；录入、提交、退回、作废 `inventory.count.execute`；过账 `inventory.opening_balance.post`
   （高风险，按模板仅店主持有）。即店长或库存管理员录入、店主过账；单人店店主可自行完成。
6. 页面 **`INV-OPENING-COUNT`**，路由 `/app/supply/opening-count[/:id]`，导航分组 Supply。

## 不改变

不改变配料主数据、库存账本既有流水类型的规则；进货、盘点调整、损耗另行实现。
