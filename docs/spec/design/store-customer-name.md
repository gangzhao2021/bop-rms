# DEC-STORE-CUSTOMER-NAME：顾客看到的门店名称、地址与电话只有一个所有者（WP-2423 剩余工作 2）

状态：协调人决定，Owner 可推翻（2026-10-15）。无迁移、无新授权、无新权限；试点 api 角色已有的授权（`docs/spec/pilot-acl-matrix.json`）足够。

## 问题

v15 上顾客各页（入口、会话恢复、页眉、订单页"Contact the store"）读门店公开资料 `rms_store.public_store_profile_version`，但读哪一版由运营文件 `internal-test-profile.json` 的 `selection` 钉死；收据与取餐码读 `bop_tenant.store.display_name`。产品内两者都改不了，于是同一家店显示两个名字（"DEMO Store - Simulated payments only" 与 "DEMO Store - not production"）。

## 决定

1. **唯一所有者：门店已发布的公开资料（Store 所有者）。** 它已按语言区分（`localizedFields`）、已供收据营业地址与订单页联系方式，并带发布与生效期证据；`bop_tenant.store.display_name` 留作组织管理/员工内部名称（员工页眉、厨房屏等仍显示它），不是顾客可见名称。
2. **Owner 在产品内发布（Store setup →"Name and contact shown to customers"）。** 只有 `organization.store.publish`（Owner）可发布，`organization.store.read` 只读；未持读权限的员工看不到该区块。可改：每种已支持语言的门店名、街道地址（1–3 行）、城市、省/地区（加拿大 13 个）、邮编（规范为"A1A 1A1"）、电话（可空；北美号码规范为 E.164）。品牌名、语言、时区、网站、标志沿用当前版本。名称与地址沿用公开资料合同的纯文本规则（不允许 `# * _ < > { } [ ]` 与控制字符），页面就地说明。
3. **一次命令、一个事务、只追加（`createPostgresPublicStoreProfilePublisher`）**：先取门店发布锁（advisory + 资料表写锁，避免与顾客读取死锁）→ 读当前版本 → 预期版本校验（`expectedVersion`，不符 409）→ 无变化拒绝 → Publishing 同一资料族内新 lifecycle：草稿 → 系统校验证据 → Owner 批准证据（Owner 即批准人）→ 发布 release（序号 +1，取代当前 release）→ 新生效期族：自现在起、不设截止、门店时区 → 新资料版本（同一 `profileReference`，版本号 = 历史最大 +1）。各步骤各有审计：Publishing 四条（Confidential）、`STORE_PUBLIC_PROFILE_TIMING_RECORDED` 与 `STORE_PUBLIC_PROFILE_PUBLISHED`（Internal，只记版本与改动了哪些字段，不记地址、电话或名称）。所有引用由操作号派生，同一操作重试返回"AlreadyPublished"。旧版本保留为历史，不再是当前版本，不改写任何行。门店从未发布过时，以门店记录的语言、时区与品牌名做首次发布。
4. **读取最新已发布版本，不再钉版本。** `createPersistentPublicStoreProfilePorts` 未给 `selection` 时读 `loadLatestCurrent`：本店最新保存且其 release 仍是当前 Publishing release、生效期当前有效的版本。`selection` 仅作测试/诊断用的显式钉选；被新 release 取代的钉选版本不再解析（验收已断言）。试点 `pilot-resources.mjs` 不再传 `selection`，运营文件中的该字段被忽略。
5. **所有顾客面向同一来源**：入口、会话恢复、页眉、菜单、购物车本就读公开资料；取餐码面板改用订单状态同一次读取的公开资料名称（`CustomerStoreContact.storeDisplayName`，仅服务端使用，不进 JSON）；新收据在开具事务内由 `createStoreReceiptDetailsSource` 读公开资料名称并冻结进快照（收据快照字段不变，无需新版本）；打印的桌台二维码卡片也用公开资料名称。没有已发布资料时，取餐码与收据回退到门店记录名称（不阻断开票）。
6. **已开收据不改写**：收据快照在开具时冻结名称；之后的退款版本复制上一版快照，名称不变。

## 营业连续性

发布失败（断网、服务不可用）时页面保留 Owner 输入并说明可重试，同一操作只发布一次；顾客继续看到当前名称。公开资料读不到时顾客入口照旧不可用（与改动前相同），收据与取餐码回退门店记录名称。

## 外部关口

真实门店名称、营业地址与电话属 Owner 事实（"上线前事项"）；内部测试可录入明确的测试值。
