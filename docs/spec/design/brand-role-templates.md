# DEC-PERM-BRAND-ROLES — 品牌级角色模板

状态：**Accepted（实现决定）**。2026-10-07，在 Owner 的商用原则（“按实际出发，不要为了简便而做”）与技术选择授权下作出。
执行工作包：[WP-2423](../work-packages/WP-2423.md)。延续 [DEC-PERM-CATALOG](./permission-catalog-and-store-roles.md)。

## 背景

- 配方、菜单/商品、价格、配料主数据是**品牌级**事实：同一品牌下所有门店共用。配方模块的发布规则要求品牌范围的授权
  （上下文与权限决定都必须是 Brand 范围），门店角色授予的权限不满足。
- DEC-PERM-CATALOG 只开通了门店角色模板；品牌下没有可分配的品牌级角色，配方无法在后台维护。

## 决定

1. **品牌角色模板**（目录 v3，与门店模板一起纳入目录摘要）：
   - **Brand Owner 品牌负责人**：配方、菜单与商品、价格、配料主数据、媒体，以及品牌级员工与角色管理。
   - **Recipe Developer 配方研发**：读写配方草稿。
   - **Recipe Reviewer 配方审核**：审核配方成本与食品安全（发布前需两位不同的审核人，且都不是草稿作者）。
   - **Menu Manager 菜单经理**（目录 v4）：商品、菜单、选项、价目的编辑、提交、批准与发布——作为价目与菜单“他人批准”的第二人。
     品牌角色的授权对品牌及其全部门店有效。
2. **开通方式与门店角色相同**：平台运营人员准备完整计划（每个角色与权限逐条列出），由独立的平台审批人用专用密钥签名
   （用途 `BRAND_ROLE_PROVISIONING`，与门店开通、角色分配审批的密钥互不通用）；写入前与提交前各核验一次签名与信任；
   每个品牌开通一次，之后随目录版本单向升级（保留原角色标识）；可在品牌没有品牌负责人时指定一位（须为品牌的有效成员）。
   记录表 `bop_permission.brand_role_provisioning` 只追加。
3. **品牌角色分配**沿用门店员工页的规则：由有品牌级 `organization.staff.manage` 的人申请，由另一位有品牌级
   `identity.role.approve` 的人批准（不能是申请人或被分配人），撤销立即生效，品牌最后一位品牌负责人不能被移除。
   被分配人只需是品牌有效成员，不需要门店分配。品牌内暂无第二位审批人时，可用平台签名审批（与门店相同的工具流程）。
4. 员工页同时显示门店角色与品牌角色，并标明范围（“本门店”/“品牌所有门店”）。

## 落地

- 迁移 `2000_010_create_brand_role_provisioning`：开通记录表；角色分配变更表允许无门店（品牌）行，
  行级安全改为“品牌一致且（无门店或门店一致）”，决定触发器按 `IS DISTINCT FROM` 比较门店。
- 代码：目录 `brandRoleTemplates`；契约 `brand-role-provisioning.ts`；存储 `provisionBrandRoles`、`readBrandTemplateRoles`；
  `role-assignment-store` 的范围支持 `storeReference: null`；Membership 公开函数 `confirmBrandMemberScope`；
  平台审批 `RoleAssignmentPlatformApprovalV1` 的 `storeReference` 可为 null；工具 `tooling/environment/brand-role-provisioning.mjs`。
