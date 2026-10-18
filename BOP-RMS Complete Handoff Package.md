---
document_id: BOP-RMS-HANDOFF
canonical_title: BOP-RMS Complete Handoff Package
document_version: 0.5.9
architecture_baseline: v1.0
specification_status: Implementation Underway — WP-0023 Integrated; WP-0024 Decision Closed
current_discussion_node: Closed — Section 97
current_discussion_topic: WP-0024 Seed、Fixture and Isolated Test Database Framework Authority Closed
last_updated: 2026-07-21
supersession_rule: Later numbered sections override conflicting historical text; Section 80 is the canonical remediation baseline, Section 86 is the delegated completion baseline, Section 87 is the autonomous hardening baseline, Section 88 is the authoritative complete Page and Function baseline, Section 89 is the authoritative repository agent-guidance and Windows/WSL execution baseline, Section 90 is the authoritative Codex, Figma Design, Figma Make, plugin, project-skill and implementation operating model, Section 91 is the authoritative GitHub Free solo-development governance baseline, Section 92 is the authoritative WP-0013 database-ownership evidence baseline, Section 93 is the authoritative WP-0014 Domain-layer technology-dependency boundary and static-enforcement protocol, Section 94 is the authoritative WP-0020 migration-runner, namespace, bootstrap-control-plane and deterministic execution protocol, Section 95 is the authoritative WP-0021 foundation-schema, ownership, ACL, isolation and verification protocol, Section 96 is the authoritative WP-0022 database-helper protocol, and Section 97 is the authoritative WP-0024 seed、fixture and parallel isolated-test-database framework protocol.
---

# BOP-RMS Complete Handoff Package

## 0. Document Control and Reading Rule

Canonical Library filename：`BOP-RMS Complete Handoff Package.md`。

Document Version：`0.5.9`。

Architecture Baseline：`v1.0`。

当前文档状态：`Implementation Underway — WP-0023 Integrated; WP-0024 Decision Closed`。

阅读与执行规则：

1. 先读取本节，再读取 Section 80、Section 86、Section 87、Section 88、Section 89、Section 90、Section 91 的 authoritative GitHub Free solo-development governance baseline、Section 92 的 authoritative Database Ownership Evidence Contract、Section 93 的 authoritative Domain Layer Technology Dependency Boundary、Section 94 的 authoritative Migration Runner and Namespace Rules、Section 95 的 authoritative Foundation Schema Authority、Section 96 的 authoritative Database Helper Authority，最后读取 Section 97 的 authoritative Seed、Fixture and Isolated Test Database Framework Authority。
2. 带有 `历史讨论节点` 的章节只保存决策形成过程，不代表当前状态。
3. 新章节与旧章节冲突时，较高编号章节优先；Section 80 对审计修复具有明确 Supersede 权限，Section 88 对页面与功能具有最终权威，Sections 89–91 分别对 Repository execution、Codex / Figma operation 与 GitHub governance 具有最终权威，Section 92 对 database ownership 与 staged enforcement、Section 93 对 Domain dependency enforcement、Section 94 对 migration execution、Section 95 对 WP-0021 foundation schema behavior、Section 96 对 WP-0022 helper objects / ACL / Tenant Context / verifier behavior、Section 97 对 WP-0024 reusable seed / fixture / parallel isolated-test-database behavior 具有最终权威。
4. `Specification Ready`、`Execution Ready` 与 `Implemented` 是三个不同状态，不得互换。
5. 文档版本表示交接包修订版本；Architecture Baseline 表示架构冻结版本，两者不再共用一个版本号。

本次修订摘要：

* 修正 WP-0001 Specification / Execution Readiness 混用
* 统一 IDR 状态词汇并移除未确认的 GitHub Hosting 假设
* 补全核心 Business Object、Screen、Field、Projection、Command 与 Event Contract
* 消除 Pickup Task、Menu Item Assignment、Recipe Ownership 等 Registry 矛盾
* 锁定 Bundle / Menu 继承、Barcode Namespace 与 Inventory Quantity Scope
* 建立 ADR Deferred Register、量化 NFR、渠道 Screen Baseline 与视觉设计门禁
* 将全部旧的“当前讨论节点”改为历史记录，并建立唯一当前节点
* `ADR-0018` 已确认 Canada-first；Section 81 已归档，进入 Canada Pilot Province 单一决策
* `ADR-0023` 已确认 Ontario-first；Section 82 已归档，进入 Pilot Operating Entity 模式单一决策
* `ADR-0024` 已确认 Single Canadian Operating Entity；Section 83 已归档，进入 Pilot Legal Entity provenance 单一决策
* `ADR-0025` 已确认 new dedicated Ontario corporation；Section 84 已归档，进入 Pilot Corporate Name Mode 单一决策
* 用户授权由本交接包一次性替其完成全部剩余 pre-code choices；Section 85 已归档，Section 86 关闭当前讨论节点并锁定完整默认执行基线
* 最终审计消除 Provider / tooling 旧文案，补齐 frontend integration、database driver、contract、telemetry、AWS、Stripe、Cognito 与 self-hosted font package baseline，并验证视觉对比度与 Markdown 结构
* `0.3.1` 修复 private GitHub 单人 bootstrap、独立审批与 required checks 的启动死锁；采用 staged governance，并将最小 `bootstrap / verify` workflow 纳入 WP-0001
* `0.3.2` 锁定 Cognito same-origin BFF 会话架构；OAuth Token 不进入浏览器存储，补齐 secure Cookie、CSRF、server-side Session、revocation 与 Customer Guest Session 边界
* `0.4.0` 在用户授权下完成最终自主修复：锁定 PWA Cache / Offline、公共 Capability Token 与 copied-QR Abuse Control、Staff-started Dine-in、Pilot Allergen Safety、HTTP / Browser Security、PostgreSQL Session Store、first-Owner / KDS identity、SES / digital receipt、Supply-chain Provenance、AWS Organization / Network / DR、Payment Orchestration、statutory archive、Crypto / Audit / Privacy 及 Ontario / Toronto launch evidence gates
* `0.4.1` 对 Claude 独立审计逐项交叉验证并完成真实缺口修复：补齐 Dine-in Guest Session rotation 语义、Business Date resolver、Terminal capture watchdog、paid-but-unfulfillable compensation、Dine-in unpaid closure task、Order Exception Workbench、相关 Projection / Gate / Critical Path 映射及 Ontario AODA applicability evidence；External Evidence、Future Trigger 与误报未改写为设计缺陷
* `0.5.0` 完成写代码前的全产品 Page & Function Closure：建立 Customer、Merchant、Operations 与 Platform 四个 Surface 的权威页面总表，补齐不同餐饮类型 / 规模 Capability Profile、页面字段与视图、Search / Filter / Sort、Command / Action、Permission、State、Navigation、Responsive、Accessibility、Projection 与 Work Package 映射；Section 60.29 的“后续细化”不再表示页面设计缺口
* `0.5.1` 完成 Section 88 反向审计与执行环境修复：补齐 Staff Counter / Table-side Order Entry 页面，规范 Inventory legacy alias 与 shared utility Screen placement，锁定 root `AGENTS.md`、后续 nested guidance、machine-checkable Screen Registry、intentional non-scope register，并将 Windows-native bootstrap 改为 WSL2 + Linux filesystem + Bash / Linux toolchain baseline；原生 Windows 仅管理宿主与 Windows-only 工具
* `0.5.2` 完成最终 implementation operating model 封版：选择 Figma Design 为视觉交付权威、Figma Make 为 disposable interaction prototype、Codex 为逐 Work Package 实施 Agent，锁定核心 plugin、project-scoped skills、Figma artifact / Screen ID mapping、权限与 external-mutation boundaries、UI readiness gate、WP-0001 启动授权模板及 WP-0007 skills materialization；本次仍不创建 Repository、Figma file 或业务代码
* `0.5.3` 接受 `IDR-0012 Revision 1`：在单一 Owner、private Repository、GitHub Free、非生产阶段采用 PR + successful CI + explicit self-review 的 auditable solo governance；server-side Branch Protection / Rulesets 在该阶段为 capability-unavailable 而非 WP-0001 blocker，任何第二名开发者 / Reviewer 或 production / PII / payment enablement 前必须升级到具备保护能力的计划并恢复强制 Stage 2 / Stage 3；同时记录 WP-0001 已在 Draft PR 实现并通过 `bootstrap / verify`

* `0.5.4` 接受 `ADR-0029` 与 `IDR-0042`：锁定 WP-0013 的 business schema / table ownership 唯一来源、table governance evidence、shared infrastructure technical ownership / write authority、纯 literal access evidence、declaration-only architecture scan、确定性诊断与在 WP-0020 / 首个 Persistence WP 前对真实数据库资产 fail-closed 的 staged enforcement

* `0.5.5` 接受 `ADR-0030` 与 `IDR-0043`：锁定 WP-0014 的 Canonical Domain source scan、type-only 等价 Layer boundary、Domain-safe dependency classification evidence、Node runtime / I/O 与 ORM / database / HTTP / Provider SDK 禁止类别、alias / package / relative resolution、dynamic / unresolved fail-closed、closed diagnostics、确定性输出及 `0 | 1 | 2` exit contract；本次仅闭合文档决策，不授权检查器实现或真实 Module

* `0.5.6` 接受 `ADR-0031` 与 `IDR-0044`：锁定 WP-0020 的唯一 root migration catalog、Canonical namespace bands、Manifest / platform-registry ownership、byte-exact SHA-256 immutability、append-only migration history、PostgreSQL advisory-lock concurrency、per-migration transaction、forward-fix-only lifecycle、safe connection / redaction contract、minimal `platform_core.migration_history` bootstrap exception、deterministic CLI / diagnostics / `0 | 1 | 2` exits及 WP-0013 staged fail-closed coexistence；WP-0021 Core / Eventing / Audit / Job functional schemas and tables remain excluded

* `0.5.7` 接受 `ADR-0032` 与 `IDR-0045`：锁定 WP-0021 为 schema-only foundation WP，只 harden `platform_core` ACL 并创建空的 `platform_eventing`、`platform_audit`、`platform_jobs`；不创建功能表、role / login 或 `platform_projection`，不改变 WP-0020 runner contract；采用 dedicated external migration owner、default-deny ACL、independent read-only verifier、synthetic isolated PostgreSQL evidence、forward-fix / separately approved restore recovery，并明确 Outbox、Inbox、Job、Audit、Projection 与 API Command Idempotency 的后续所有权

* `0.5.8` 接受 `ADR-0033` 与 `IDR-0046`：锁定 WP-0022 的 `platform_helpers` 纯技术 schema、UUIDv7 validation、Money storage domains、IANA / local-time domains、transaction-local Tenant Context readers、default-deny ACL、无 advance runtime grant、四个有序 immutable migrations、read-only verifier 及 synthetic / isolated evidence；Money rounding、Business Date resolution、实际 table constraint / index / RLS policy 和业务事实继续归属其 owning Domain / future table WP

* `0.5.9` 接受 `ADR-0034` 与 `IDR-0047`：锁定 WP-0024 的唯一 test-only lifecycle owner、WP-0020 runner reuse、closed synthetic fixture boundary、parallel-safe Compose / database / port / lease namespace、bounded success / failure / signal / timeout cleanup、closed diagnostics / exits、acceptance-only failure injection、redacted logging and exact owned-resource residue detection；不创建业务 seed、Tenant / Brand / Store 事实、生产账号、Provider 数据、migration、role / grant 或 application persistence abstraction

## 1. 项目定位

项目名称：

**BOP-RMS**

全称：

* Business Operating Platform（BOP）
* Restaurant Management System（RMS）

项目目标：

为加拿大和中国的各类餐饮商家提供统一、可配置的扫码点餐与餐厅运营管理系统。

系统需要覆盖：

* 独立小店
* 多门店品牌
* 连锁直营
* 加盟体系
* 堂食
* 到店自取
* 外送
* 加拿大与中国的语言、税务、支付及运营差异

总体架构决定：

* BOP 提供跨业务领域复用的通用平台能力
* RMS 是建立在 BOP 之上的第一个业务应用
* 第一阶段采用模块化单体架构
* 代码和数据必须保持清晰的 Domain 边界
* 暂不因为领域较多而提前拆分微服务

依赖方向：

RMS
→ 使用 BOP

BOP 不得依赖 Catalog、Ordering、Kitchen 等餐饮专属领域。

---

## 2. 核心架构原则

### 2.1 Configuration 与 Transaction 分离

Configuration 描述系统当前应该如何运行，可以修改、发布、版本化和回滚。

例如：

* Product
* Menu
* Option
* Price
* Tax
* Promotion
* Workflow
* Permission

Transaction 记录当时实际发生的业务事实，不允许因后续配置变化而被改写。

例如：

* Order
* Payment
* Refund
* Event
* Audit Log
* Order Item Snapshot

核心原则：

**Configuration 可以演进，Transaction 永远记录事实。**

### 2.2 交易快照

订单项必须同时保存：

* Sellable 的稳定引用
* 交易发生时的完整配置快照

快照应包括：

* Product 与 SKU 名称
* Variant
* Option
* 数量
* 原价
* 成交价
* 折扣
* 税率与税额
* 备注
* 配置版本

后续商品改名、调价、停售或修改税率，不得影响历史订单。

### 2.3 稳定对象与可扩展关系

稳定身份应保留在核心 Entity 中。

变化尽量通过关系对象表达，例如：

* User 与 Brand 通过 Membership
* Membership 与 Store 通过 Store Assignment
* Role 与 Permission 通过 Permission Grant
* Product 与 Option Set 通过 Product Option Binding

避免把多个 Brand ID、Store ID 或权限数组直接塞入核心对象。

### 2.4 默认拒绝

没有明确规则允许的业务动作，默认拒绝。

权限判断不能只在前端完成，后端必须作为最终判断依据。

### 2.5 记录事实，不重写历史

核心记录采用追加式设计：

* Audit Log 不覆盖
* Event 不覆盖
* 付款与退款不覆盖
* 订单修改通过新记录表达
* 身份合并不改写历史操作主体

### 2.6 Action 驱动状态

员工不直接选择“把订单改为什么状态”。

员工执行具有业务含义的 Action，例如：

* 接单
* 完成商品
* 顾客已取餐
* 拒单
* 退款

系统根据 Workflow 自动完成状态转换。

### 2.7 Event 驱动协作

业务模块发布已经发生的事实，例如：

* OrderSubmitted
* PaymentSucceeded
* ItemCompleted
* InventoryLow

其他模块独立订阅处理。

一个非关键订阅者失败，不应阻断其他订阅者。

### 2.8 平台、品牌、门店三级管理

平台提供标准能力和模板。

品牌统一管理标准配置。

门店在授权范围内进行本地覆盖。

常见继承关系：

平台模板
→ 品牌模板
→ 门店配置

---

## 3. BOP 主要能力

BOP 当前包含以下通用能力：

* Identity
* Permission
* Workflow
* Rule / Policy
* Approval
* Delegation
* Change Impact
* Event
* Notification
* Task
* Audit
* Publishing
* Effective Period
* Feature Flag
* Kill Switch

### 3.1 Identity

统一身份系统，但账号边界隔离：

* Customer Account
* Merchant Account
* Platform Administrator Account

同一个自然人可以共享同一个 User ID，但不同账号身份：

* 使用不同入口
* 使用不同安全策略
* 不自动共享权限

### 3.2 Permission

权限采用：

User
→ Role
→ Permission
→ Business Action

权限粒度包括：

* 页面访问权限
* 具有明确业务意义的动作权限

最终优先级：

1. 用户级 Explicit Deny
2. 用户级 Explicit Allow
3. Role Permission
4. Default Deny

还需结合：

* Brand
* Store
* 金额
* 时间
* Workflow State
* Approval Requirement

### 3.3 Workflow

Workflow 负责：

Current State
→ Allowed Action
→ Rule Check
→ Next State

每次转换记录：

* 当前状态
* Action
* 下一状态
* 执行人
* 执行时间
* 原因
* 是否系统自动执行

### 3.4 Approval

支持：

* 单人审批
* 多人会签
* 多级审批
* 退回修改
* 版本保留
* 审批超时
* 提醒
* 升级
* 自动拒绝
* 审批委托

等待审批期间采用：

**局部锁定，而不是整体锁定。**

### 3.5 Event

Event 必须支持：

* 唯一 Event ID
* Event Type
* Version
* 发生时间
* Producer
* Brand ID
* Store ID
* Payload
* 幂等处理
* 自动重试
* 失败队列
* 同一 Aggregate 内顺序控制

不同 Aggregate 的 Event 可以并行处理。

### 3.6 Notification

通知由 Event 触发，不由业务模块直接发送。

支持：

* 系统内通知
* Push
* SMS
* Email
* 微信
* POS
* KDS
* 打印设备
* 店内显示设备

支持：

* 主渠道
* 备用渠道
* 多渠道
* 延迟发送
* 定时发送
* 通知取消条件
* 接收者动态解析
* 接收者去重
* Read
* Acknowledged
* 确认时限与升级

优先级统一为：

* Low
* Normal
* High
* Critical

### 3.7 Task

Task 表示需要被实际完成并追踪的工作。

任务可以分配给：

* 指定员工
* Role
* 岗位
* 工作队列

支持：

* 员工领取
* 主管分配
* 系统自动分配

### 3.8 Audit

必须记录会改变以下内容的操作：

* 数据
* 金额
* 权限
* 库存
* 业务结果

Audit Log 采用：

* Append-only
* Correction Record
* Controlled Deletion

核心审计日志不允许普通员工、店长或老板直接删除。

### 3.9 Publishing

统一 Publishing Workflow 支持：

* Draft
* Ready
* In Review
* Approved
* Published
* Archived
* 定时发布
* 分批发布
* 回滚

核心原则：

**回滚配置，不回滚已经发生的交易。**

### 3.10 Effective Period

通用有效期能力包括：

* Effective From
* Effective Until
* 到期提醒
* 自动生效
* 自动失效
* 续期
* 审批

可用于：

* Membership
* Role Assignment
* Permission Override
* Menu
* Price
* Promotion
* Coupon

### 3.11 Feature Flag 与 Kill Switch

Feature Flag 同时控制：

* 前端入口
* 后端业务执行

类型分为：

* Release Flag
* Kill Switch

Kill Switch 支持：

* 阻止新操作
* 安全暂停
* 立即终止
* Shutdown Policy
* Recovery Policy
* 自动恢复
* 人工恢复
* 分批恢复

---

## 4. BOP 开放架构决策

以下问题暂时未最终锁定：

### 4.1 Policy Engine

未来可能把以下机制统一为 Policy：

* Permission
* Approval
* Workflow
* Notification
* Publishing
* Effective Period
* Feature Flag

暂时保留独立模块，避免过度抽象。

### 4.2 Configuration Domain

以下能力已在多个 Domain 重复出现：

* Version
* Publishing
* Rollback
* Overlay
* Effective Period
* Compatibility
* Change Impact
* Release
* Version Resolution

未来可能形成 BOP 下独立的 Configuration Domain。

### 4.3 Overlay Model

多个场景存在：

Base Configuration

* Overlay
  = Runtime Configuration

例如：

* Brand Menu + Delivery Overlay
* Brand Product + Store Override
* Base Workflow + Store Adjustment

该历史开放项已由 Section 42.4 关闭：v0.1 使用统一有限层级 Overlay Resolver，但不建立独立 Overlay Aggregate Root。

### 4.4 Operating Entity

已经确认：

* 一个 Brand 可以关联多个 Legal Entity
* 一个 Legal Entity 可以管理多个 Brand
* 不同 Store 可以对应不同税号、银行账户与许可证

该历史开放项已由 Section 42.5 关闭：Operating Entity 是独立 Aggregate Root，Brand / Store 通过带有效期的 Assignment 关联。

---

## 5. RMS 一级子领域

RMS 当前包含：

### 核心经营

* Catalog
* Ordering
* Dining
* Kitchen
* Reservation & Waiting

### 商品、库存与供应

* Recipe
* Inventory
* Procurement & Supplier

### 价格与资金

* Pricing & Promotion
* Payment

### 顾客与履约

* Customer & Loyalty
* Delivery & Fulfillment

### 运营支持

* Printing & Device Integration
* Business Intelligence
* Compliance & Food Safety

---

## 6. Restaurant 基础业务决策

### 6.1 订单方式

系统支持：

* 堂食
* 到店自取
* 外送

每个门店可启用一种或多种。

### 6.2 使用者

主要角色：

* 顾客
* 员工
* 店长
* 老板
* 平台管理员

厨房、收银、服务员等不是固定账号类型，而是员工职责与权限。

### 6.3 商家结构

平台
→ Brand
→ Store
→ Order

独立餐厅也作为一个 Brand。

### 6.4 员工归属

员工账号属于 Brand，可以被分配到一家或多家 Store。

同一员工在不同 Store 可以拥有不同 Role 与 Permission。

### 6.5 顾客账号

顾客账号全平台统一。

会员关系按 Brand 隔离。

### 6.6 顾客登录方式

支持：

* 游客
* 手机验证码
* 邮箱验证码
* 微信
* Apple
* Google

### 6.7 订单安全

风险越高，验证越严格。

可使用：

* 桌码
* 临时会话码
* 登录
* 手机验证
* 在线付款
* 员工确认
* 设备与频率限制
* 黑名单
* 异常检测

### 6.8 Dining Session

只用于堂食。

一次完整 Session 可以包含：

* 入座
* 多人点餐
* 多个 Order Batch
* 加菜
* 分开或统一付款
* 顾客离店

同一 Table 同一时间只能存在一个进行中的 Dining Session。

### 6.9 Dining Area 与 Table

Store
→ Dining Area
→ Table

Table 记录：

* 标准座位数
* 最大人数
* 是否允许加座
* 当前状态

桌台状态：

* 空闲
* 已预留
* 已入座
* 待清理
* 停用

支持 Table Merge 与 Split。

### 6.10 桌台二维码

支持：

* 便捷模式：固定桌码
* 标准模式：固定桌码 + 临时短码
* 严格模式：每次 Session 临时二维码或链接

### 6.11 订单负责人

多人点餐设置 Order Host。

负责人可以：

* 邀请参与者
* 提交订单
* 统一付款
* 管理未提交内容

其他参与者默认只管理自己添加的商品。

### 6.12 加菜

已提交订单允许继续加菜。

追加内容作为同一订单下的 Order Batch 管理。

---

## 7. Store、Brand 与地区配置

### 7.1 Legal Entity Profile

负责：

* 法定公司名称
* 注册号
* 税号
* 开票资料
* 财务资料
* 银行及法律主体信息

### 7.2 Brand Profile

负责：

* 品牌名称
* Logo
* 品牌介绍
* 默认语言
* 默认币种
* 品牌标准配置

### 7.3 Store Profile

负责：

* 门店名称
* 地址
* 联系方式
* 时区
* 语言
* 币种
* 营业时间
* 订单方式
* 税务区域
* 收据信息
* 许可证
* 经纬度与配送范围

时间内部统一保存 UTC，界面按 IANA 时区显示，例如：

* America/Toronto
* America/Vancouver
* Asia/Shanghai

### 7.4 门店上线最低要求

至少需要：

* 门店名称
* 所属 Brand
* 地址
* 国家或地区
* 时区
* 币种
* 默认语言
* 营业时间
* 一种订单方式
* 税务配置
* 收据信息
* 一个有效 Menu
* 一个可售商品
* 付款规则
* 联系人
* 门店状态

未满足时可以测试，但不能正式发布。

---

## 8. Identity Domain v1.0 摘要

Identity Domain 已暂时 Freeze。

### 8.1 Aggregate

* User Aggregate
* Membership Aggregate
* Role Aggregate

### 8.2 User Aggregate

包含：

* User
* User Profile
* Account Identity
* Authentication Identity
* Contact Method
* Security Settings
* Locale Preference
* Merge Reference

User 本身不直接保存：

* Brand
* Store
* Role
* Permission

### 8.3 Membership Aggregate

User 与 Brand 通过 Membership 关联。

Membership 包含：

* Brand Role Assignment
* Store Assignment
* Store Role Assignment
* Permission Override
* Effective Period
* Status

Membership 失效后：

* Brand 权限立即失效
* Store Assignment 级联失效
* 历史记录保留
* 未完成任务与审批重新分配

### 8.4 Role

Role 分为：

* Platform Role
* Brand Role

两者使用统一 Permission Catalog，但相互隔离。

### 8.5 Identity Merge

支持受控账号合并。

合并：

* Authentication Identity
* Contact Method
* Membership
* Store Assignment

但不改写：

* Audit Log
* 订单历史
* 付款历史
* 原 User ID 的历史事实

---

## 9. Catalog Domain 已确认边界

Catalog 负责定义：

* 卖什么
* 如何组织
* 如何展示
* 可选择什么
* 哪些对象可以加入订单

Catalog 不负责：

* 最终价格计算
* 实时库存
* Recipe
* Kitchen Workflow
* Payment
* 历史交易

---

## 10. Catalog Aggregate

已确认 Aggregate Root：

* Product Aggregate
* Category Aggregate
* Menu Aggregate
* Option Set Aggregate
* Bundle Aggregate

该历史候选已由 Section 42.6 关闭：Media Asset 是 BOP Shared Media Capability，在模块化单体中以独立 Module 实现。

---

## 11. Product Aggregate

### 11.1 Product

Product 只保存稳定 Identity，例如：

* Product ID
* Brand ID
* Product Code
* Product Type
* Lifecycle
* Created At
* Created By

### 11.2 Product Version

Product Version 保存完整 Configuration，例如：

* 多语言名称
* 描述
* Media Reference
* Variant Definition
* SKU
* Product Option Binding
* Tags
* Attributes
* Nutrition
* Allergen
* Tax Classification

每个 Product Version 是完整快照，不只保存差异。

### 11.3 Product Version 状态

可包括：

* Draft
* In Review
* Approved
* Scheduled
* Published
* Superseded
* Archived

### 11.4 Product 生命周期

可包括：

* Draft
* Active
* Suspended
* Discontinued
* Archived

Suspended 可以恢复。

Discontinued 重新上市时：

* 商品本质未变：创建新 Product Version
* 商品含义已根本变化：创建新 Product

### 11.5 多版本并行发布

同一 Product 可以有多个 Published Version，但范围不能产生歧义。

适用范围可包括：

* Store
* Store Group
* Region
* Channel
* Order Type
* Effective Period
* 灰度范围

同一业务上下文最终只能解析出一个版本。

Version Resolution 优先级暂定：

1. Store
2. Store Group
3. Region
4. Channel
5. Order Type
6. Effective Period
7. Brand Default

---

## 12. SKU

SKU 是 Product Aggregate 内部 Entity，不是独立 Aggregate Root。

SKU：

* 有独立稳定 ID
* 可被其他 Domain 引用
* 是定价、Recipe、Inventory、Ordering、Kitchen 与 BI 的最小销售单位

SKU 跨 Product Version 保持稳定的条件：

* 销售单位含义未改变
* 规格本质未改变
* 统计口径未改变

以下情况应创建新 SKU：

* 销售单位改变
* 规格意义根本改变
* 条码或统计口径需要独立
* 旧 SKU 被新销售单位替代

### 12.1 SKU Replacement Relationship

SKU 被新 SKU 替代后，需要保存 Replacement Relationship。

关系基数与边界：

* 只保存 `旧 SKU → 新 SKU` 的单向直接关系
* 每个旧 SKU 同时最多拥有一个非 Cancelled、非 Voided 的直接替代关系
* 多个旧 SKU 可以指向同一个新 SKU，因此整体允许 N:1
* 不允许一个旧 SKU 同时指向多个新 SKU
* 允许跨 Product，但必须位于同一 Brand/Catalog 边界
* 新 SKU 的反向关系通过查询获得，不重复保存

替代链：

* 允许形成 `A → B → C`
* 保留每一次直接替代事实，不把 `A → B` 改写为 `A → C`
* 禁止指向自身和形成循环
* 替代链按照指定 `asOf` 时间解析
* 如果目标 SKU 在关系生效时已经被替代，必须直接指向该时间点的最终有效 SKU

Replacement Relationship 只表达 SKU 血缘和接替事实：

* 不自动替换历史订单
* 不自动替换顾客正在购买的 SKU
* 不自动迁移 Menu、Bundle、Pricing、Recipe 或 Inventory 引用
* 不自动停用旧 SKU
* 旧 SKU 是否可售仍由 Product Version、Menu 与 Availability 控制
* 跨 Domain 迁移必须由管理员明确执行，并重新验证相关配置

聚合归属：

* 关系关联稳定的 SKU Identity，不属于 Product Version
* 不是独立 Aggregate Root
* 作为旧 SKU 所属 Product Aggregate 内的 Relationship Entity
* 目标新 SKU 只保存稳定 ID 引用
* 跨 Product 验证由 Catalog Domain Service 完成
* Relationship Entity 拥有独立稳定 ID

时间与修改规则：

* 必须保存 `Effective From`
* 允许提前创建未来生效的关系
* 不保存 `Effective To`，因为 Replacement 表示永久接替，不用于临时替换
* `Scheduled` 与 `Effective` 根据当前时间和 `Effective From` 动态计算，不保存为可修改状态
* 生效前可以修改或取消
* 生效后不可直接修改；配置错误时标记为 `Voided`，保留审计，再创建正确关系
* 生效前不可修改 Relationship ID 与 Source SKU ID
* 生效前可以修改 Replacement SKU ID、Effective From、Reason Code 与备注
* 更换 Source SKU 时必须取消原关系并重新创建
* 普通操作只能使用当前或未来时间
* 历史迁移或纠错可由具备专门权限的用户回填过去时间，但必须填写原因并记录完整审计

状态结果：

* 生效前撤销持久化为 `Cancelled`
* 生效后纠错作废持久化为 `Voided`
* Cancelled 与 Voided 都必须填写文本原因，并记录操作者与操作时间
* Cancelled 或 Voided 的关系不参与替代链解析

创建关系时必须保存结构化 Reason Code：

* `SALES_UNIT_CHANGED`
* `SPECIFICATION_CHANGED`
* `IDENTIFIER_OR_REPORTING_CHANGED`
* `SKU_CONSOLIDATION`
* `PRODUCT_REPLACEMENT`
* `OTHER`

选择 `OTHER` 时备注必填；其他 Reason Code 的备注可选。

验证与治理：

* 目标 SKU 创建关系时不必已经发布或可售
* 目标 SKU 必须拥有稳定 ID、位于同一 Brand/Catalog，且未被删除或作废
* 不存在、跨 Brand、指向自身或形成循环属于结构错误，必须拒绝
* 缺少价格、Recipe、库存映射或菜单配置时，不在 Relationship 层阻止，而是生成 Change Impact 警告与处理任务
* 是否必须完成依赖处理后才能发布，由统一审批策略决定
* 建立关系后，新旧 SKU 都不能物理删除，只能停用或归档
* Relationship 不建立独立 Draft、In Review、Approved 状态，按需复用统一 Catalog Publishing / Approval Workflow

Domain Event 至少包括：

* `SkuReplacementScheduled`
* `SkuReplacementBecameEffective`
* `SkuReplacementCancelled`
* `SkuReplacementVoided`

事件用于影响检查、通知和任务，不表示消费者可以自动迁移业务数据。

查询能力同时提供：

* Direct Replacement
* 按 `asOf` 时间解析的 Final Replacement
* 可选完整 Replacement Chain

### 12.2 SKU Lifecycle

SKU 拥有独立于 Product 与 Product Version 的 Lifecycle。

第一版状态包括：

* `Draft`：尚未投入使用
* `Active`：允许被当前配置使用
* `Suspended`：临时暂停，可以恢复
* `Discontinued`：停止新增销售引用
* `Archived`：仅保留历史与审计，默认不在后台普通列表显示

`Active` 只表示 Catalog 层具备使用资格，不等于当前门店一定可售；实际可售性仍需结合 Product Version、Menu、Availability、Inventory 等规则判断。

`Discontinued` SKU 可以受控重新启用，但必须同时满足：

* 销售单位含义未改变
* 规格本质未改变
* 统计口径未改变
* 通过新的 Product Version 重新发布
* 完成影响检查并记录审计

如果含义已经改变，必须创建新 SKU，并按需建立 Replacement Relationship。

归档规则：

* `Draft → Archived` 可以直接执行
* `Active` 或 `Suspended` 必须先转为 `Discontinued`，才能进入 `Archived`
* `Archived` 可以受控恢复到归档前的 `Draft` 或 `Discontinued`
* `Archived` 不允许直接恢复为 `Active`
* 恢复必须记录原因、操作者和时间

`Suspended` 的交易处理：

* 不删除 Menu、Pricing、Recipe 等现有引用
* 不影响已经提交并接受的订单
* 禁止创建新的购买配置
* 暂停前已加入购物车但尚未提交的配置，在提交验证时拒绝，并提示商品暂时不可用
* 恢复为 `Active` 后，原有配置引用可以继续使用

`Discontinued` 不强制指定 Replacement SKU。只有存在明确接替者时才建立 Replacement Relationship。

即使仍被已发布 Menu、Bundle 或默认 SKU 配置引用，也允许受控执行 `Discontinued`：

* 不自动删除或改写现有引用
* 必须先显示 Change Impact
* 为受影响位置生成警告或处理任务
* 生命周期生效后不再允许新订单提交
* 是否必须先处理引用再批准，由 Brand 的统一审批策略决定
* 紧急情况下，具备权限的用户可以立即停用

---

## 13. Variant

Variant 决定 SKU。

例如：

* 杯型
* 尺寸
* 重量
* 份量

结构：

Product
→ Variant Dimension
→ Variant Value
→ 有效组合
→ SKU

不是所有组合都必须生成 SKU。

需要严格区分：

* Variant：决定 SKU
* Option：顾客个性化选择
* Recipe：制作与原料消耗

---

## 14. Category

Category 是独立 Aggregate Root。

Category 负责品牌业务分类。

支持：

* 一个 Product 属于多个 Category
* 最多默认三级分类
* 多语言
* 生命周期
* 适用门店

Category 不负责 Menu 展示结构。

---

## 15. Menu Aggregate

Menu 决定在特定条件下顾客看到哪些 Sellable，以及如何展示。

Menu 包含：

* Menu
* Menu Section
* Sellable Placement
* 展示顺序
* 适用门店
* Order Type
* 时段
* Channel
* Visibility Rule
* 版本和发布状态

### 15.1 Menu Section

Menu Section 与 Category 分离。

Menu Section 可以：

* 引用一个 Category
* 不引用 Category
* 混合多个 Category
* 完全手工组织 Sellable

Category 是 Master Data。

Menu Section 是展示结构。

### 15.2 Sellable Placement

Placement 表示某个 Sellable 在当前 Menu Section 如何展示。

可以包含：

* Sellable ID
* 名称覆盖
* 图片覆盖
* 描述
* Badge
* 排序
* 是否置顶
* Presentation Role
* Channel Context
* Visibility Rule
* 默认 SKU 或配置引用

同一个 Sellable：

* 可出现在不同 Section
* 同一 Section 默认只有一个普通 Placement
* 特殊重复展示使用不同 Presentation Role

### 15.3 Presentation Role

Catalog 不定义具体 UI 组件。

只定义业务展示角色：

* Standard
* Featured
* Promotional
* Sponsored
* Hidden

前端决定映射为：

* Card
* Banner
* Carousel
* Grid
* Tile

### 15.4 Menu 继承

支持单层继承：

Base Menu
→ Derived Menu

Derived Menu 只保存差异，不复制全部父菜单。

v0.1 锁定规则：

* Menu 继承最多一层
* Derived Menu 不得继续作为另一个 Menu 的 Base Menu
* 任何超过一层的继承设计必须创建 ADR，并提供解析顺序、冲突检测与迁移方案

---

## 16. Option Set Aggregate

Option Set 是独立 Aggregate Root。

包含：

* Option Set
* Option
* Selection Rule
* Conflict Rule
* Conditional Rule
* 多语言内容
* Lifecycle
* Version

Selection Rule 支持：

* 最少选择数量
* 最多选择数量
* 是否允许重复
* 单个 Option 最大数量
* Option Set 最大总数量

Option 可以：

* 加价
* 消耗库存
* 触发其他 Option Set
* 与其他 Option 冲突

---

## 17. Product Option Binding

Product Option Binding 是 Product Aggregate 内部核心 Entity。

它定义 Product Version 如何使用某个 Option Set。

包括：

* Binding ID
* Option Set ID
* 用途
* 展示顺序
* 启用 Option 范围
* 默认值
* Selection Rule Override
* Pricing Rule Reference
* Conditional Rule
* Conflict Rule
* SKU Scope
* Variant Condition
* Channel Scope
* 是否允许 Store Override

同一 Option Set 可以在同一 Product 中绑定多次，但每次必须拥有不同 Binding ID 和用途。

Binding 默认适用于全部 SKU，也可以：

* Include SKUs
* Exclude SKUs
* 根据 Variant Condition 生效

---

## 18. Bundle Aggregate

Bundle 是独立 Aggregate Root，不是 Product 的特殊类型。

Bundle 可以包含：

* Bundle Group
* Bundle Item Reference
* Selection Rule
* Upgrade Rule
* Substitution Rule
* Version
* Lifecycle

Bundle 引用 Sellable，不复制 Product 或 SKU 定义。

Bundle 本身也是 Sellable。

v0.1 锁定规则：Bundle Item Reference 不得引用另一个 Bundle。Bundle 嵌套在 v0.1 明确不支持；未来如需启用，必须创建 ADR，并定义最大深度、循环检测、价格解析、库存可用性与历史快照规则。

---

## 19. Sellable

Sellable 是 Catalog 中的统一抽象，不是独立 Domain。

可以作为 Sellable 的对象包括：

* SKU
* Bundle
* Gift Card
* Membership Plan
* Service Item
* Deposit

Ordering、Pricing 和 Payment 统一通过 Sellable ID 协作。

Sellable 至少提供：

* ID
* Type
* Brand
* Lifecycle
* 是否可售
* 数量单位
* 税务分类引用

---

## 20. Product Configuration

Product Configuration 是临时 Value Object。

表示顾客最终准备购买的完整配置：

* Product ID
* Product Version ID
* SKU ID
* Variant
* Product Option Binding ID
* Option
* Option 数量
* 默认值与修改结果
* 顾客备注
* 配置时间

职责：

* Catalog 验证合法性
* Pricing 计算价格
* Recipe 计算消耗
* Ordering 转换为不可变 Order Item Snapshot
* Kitchen 生成制作指令
* Printing 生成打印内容

采用双层验证：

* 实时验证
* 提交前后端完整验证

---

## 21. 配置与价格一致性

顾客开始配置商品时记录：

* Product Version
* Menu Version
* Option Set Version
* Product Option Binding Version
* 配置创建时间

提交时结果可以是：

* Accepted
* Migrated
* Reconfirmation Required
* Rejected

价格采用短时 Price Lock：

* 锁定期内可按展示价格提交
* 超时后重新计算
* 降价自动应用
* 涨价要求重新确认
* 税务、法律和明显错误价格可立即失效

---

## 22. Media Asset

Media Asset 负责文件本身。

Product、Menu 和 Placement 只保存引用。

Media Asset 支持：

* 图片
* 视频
* 文件格式与尺寸
* 安全扫描
* Processing
* Review
* Rendition
* Version
* Publishing
* Rollback

所有权通过：

* Owner Type
* Owner ID

跨 Brand 默认不能直接引用，只能复制。

图片处理支持：

* 自动压缩
* 自动旋转
* 缩略图
* 多比例裁剪
* 1:1
* 4:3
* 16:9
* Web 格式转换
* 手动焦点调整

原图不直接修改。

媒体引用分为：

* Dynamic Reference：跟随当前发布版本
* Pinned Reference：固定 Media Asset Version

草稿可以 Dynamic。

正式发布配置默认 Pinned。

---

## 23. Catalog 相关开放决策

本节是历史开放项清单；当前处理结果以 Section 42 与 Section 80 为准：

* Media Asset：已锁定为 BOP Shared Media Capability
* Overlay Model：已锁定为 BOP 通用解析模式，不建立独立 Aggregate Root
* Configuration Domain：延期，但 Shared Configuration Contract 已锁定
* Operating Entity：已锁定为独立 Aggregate Root
* Policy Engine：延期，见 ADR Deferred Register
* Bundle 嵌套：v0.1 不支持，最大嵌套深度为 0
* Menu 继承：v0.1 最多一层
* Product Version Resolution：由 Domain-owned Resolver 执行并遵循 Shared Configuration Contract

---

## 24. Ordering Domain

### 24.1 职责边界

Ordering 负责：

* 管理 Cart 与提交前的订单意图
* 提交时协调 Catalog、Pricing 等 Domain 完成验证
* 创建不可变的 Order、Order Batch、Order Item 与交易快照
* 管理提交、接受、拒绝、取消、完成等订单业务动作
* 保存订单金额结果，但不负责计算价格

Ordering 不负责：

* 商品和菜单定义
* 价格、折扣和税费计算
* 收付款与退款执行
* 厨房制作流程
* 桌台与 Dining Session 管理
* 实时库存计算

其他 Domain 通过稳定引用和 Domain Event 与 Ordering 协作。

### 24.2 Cart 与 Order

Cart 与正式 Order 分开：

* Cart 是可修改、可过期的临时购买意图
* 顾客提交并通过完整验证后才创建正式 Order
* Order 创建时生成 Order Number，并保存商品、价格、税费等交易快照
* 需要预付款时，Order 可以先等待付款
* 付款失败不删除 Order，而是记录实际结果

每个 Order 只能拥有一种 Order Type：

* Dine-in
* Pickup
* Delivery

同一 Order 不允许混合多种履约方式。不同履约需求必须分别创建 Order。

Order Status 与 Payment Status 必须分开。Order 可以在付款成功前创建，是否允许接单或进入厨房由 Store 针对 Order Type 的付款策略决定。

### 24.3 Workflow 与标准阶段

Dine-in、Pickup 与 Delivery 不使用一套写死流程，而是使用 BOP Workflow。

平台提供标准 Workflow Template。Brand 可以在允许范围内调整接单方式、付款前置条件、自动确认、超时和通知；Store 只能在 Brand 授权范围内覆盖。Ordering 保留必要安全约束，不能配置出非法转换。

Brand 自定义 Workflow 状态必须映射到 Canonical Order Phase：

* `Submitted`
* `Accepted`
* `In Progress`
* `Ready`
* `Fulfilled`
* `Rejected`
* `Cancelled`

不同 Order Type 可以跳过不适用阶段。Payment Status 不属于 Canonical Order Phase。

### 24.4 Order Aggregate

第一阶段采用一个 Order Aggregate：

`Order → Order Batch → Order Item`

Payment、Kitchen Ticket 与 Delivery Task 不属于 Order Aggregate，只保存引用并通过 Event 协作。

一个 Dining Session 同时只能有一个活动 Order：

* 首次提交创建 Order 与第一个 Order Batch
* 后续加菜创建新的 Order Batch，仍属于同一个 Order
* 多人点餐通过 Participant 信息区分
* 分开付款通过 Payment Allocation 处理，不拆分多个 Order
* Dining Session 结束后，Order 才进入最终完成状态

### 24.5 Shared Cart 与来源渠道

多人堂食时，一个 Dining Session 共用一个 Shared Cart：

* 每个 Cart Item 记录 Added By Participant
* 普通参与者只能修改自己添加的未提交项目
* Order Host 可以查看并提交整个 Shared Cart
* 提交成功后，当前内容形成新的 Order Batch
* Shared Cart 清空后可以继续添加下一批加菜

顾客扫码、员工 POS、Web 与 API 订单统一使用同一个 Order Aggregate 和 Workflow。

Order 记录：

* Source Channel
* Created By Actor
* Submitted By Actor

渠道可以拥有不同权限和界面，但不建立不同订单数据模型。

### 24.6 Order Type 变更与追加下单

Order Type 在 Order 创建后只能于早期阶段受控更改：

* 仅限 `Submitted`、尚未付款成功且尚未开始制作
* 必须通过明确的 Change Order Type Action
* 重新验证门店能力、桌台或配送地址
* 重新计算价格、税费、优惠和服务费
* 保存变更记录，不覆盖原始提交事实
* 已接单、已付款或已开始制作后，只能取消并重新创建 Order

Dine-in 可以通过新的 Order Batch 向同一个 Order 加菜。

Pickup 与 Delivery 提交后的顾客加菜必须创建新 Order，不能改变原 Order 的付款金额、预计时间、配送任务和厨房进度。员工改单使用受控 Order Amendment。

### 24.7 Order Amendment

第一版支持员工对已提交 Order 执行受控 Amendment，但不覆盖原 Order Item 与交易快照。

支持：

* Add Item
* Reduce / Void Item
* Replace Item Configuration
* Update Note

Replace Item Configuration 在内部表现为旧配置作废并新增配置。

每个 Amendment 必须：

* 通过明确业务 Action 执行
* 保存修改内容、原因和操作者
* 重新计算金额及应付差额
* 通知 Payment、Kitchen、Inventory 等相关 Domain
* 不允许员工直接输入新价格；折扣、补差价和退款通过 Pricing 与 Payment 的正式 Action 处理

已 Fulfilled 或 Closed 的 Order 不允许普通 Amendment。

Kitchen 已开始制作后：

* Reduce、Void 或 Replace Amendment 先进入 Pending
* Kitchen 确认可以停止制作后才生效
* 已制作完成时 Kitchen 可以拒绝 Amendment
* 被拒绝时原 Order Item 保持不变
* 退款、免单和损耗通过对应 Action 另行处理
* 新增商品生成新的 Kitchen 工作项，不撤销原项目

### 24.8 Rejected、Cancelled 与顾客取消

顾客取消规则：

* `Submitted` 且尚未被商家接受时，顾客可以直接取消
* 已 `Accepted` 时，顾客只能提交取消请求，由商家确认
* 已开始制作时，由具备权限的员工决定是否接受，并记录损耗
* 已 `Fulfilled` 或 `Closed` 时不能取消，只能进入退款、投诉或补偿流程
* 取消 Order 不自动触发退款，Payment 独立处理

`Rejected` 与 `Cancelled` 必须严格区分：

* `Rejected`：商家从未接受 Order
* `Cancelled`：Order 创建后由顾客、员工或系统终止
* 两者都必须保存 Reason、Actor 与时间
* 付款失败本身不等于 Rejected 或 Cancelled，由付款策略决定等待、重试或超时取消

### 24.9 Closure Status

Canonical Order Phase 与 Closure Status 分开。

Closure Status：

* `Open`
* `Closed`

例如：

* 已送达但未付款：`Fulfilled + Open`
* 已拒单但退款处理中：`Rejected + Open`
* 退款完成：`Rejected + Closed`

进入 `Closed` 必须同时满足：

* 所有 Order Item 与 Order Batch 已有最终结果
* 没有待处理的 Amendment 或取消请求
* 履约已完成，或 Order 已 Rejected / Cancelled
* 应付余额已经结清、退款处理完成，或经过授权执行 Write-off
* 没有阻止关闭的关键异常任务

系统可以自动关闭，也允许具备权限的员工处理异常后关闭。

已经 Closed 的 Order 支持受控 Reopen：

* 仅具备权限的经理可以执行
* 必须填写原因并记录完整 Audit
* 尚未进入锁定的日结或会计期间时可以重新打开
* 已进入锁定结算期后不能 Reopen，只能通过退款、调整或新 Order 纠正
* Reopen 不删除原关闭记录

### 24.10 幂等提交与订单标识

所有 Cart 与 Order Batch 提交都必须携带唯一 Submission ID / Idempotency Key：

* 第一次提交成功时创建 Order 或 Order Batch
* 同一个 Submission ID 重试时返回第一次结果，不重复创建
* Cart 内容发生变化后必须生成新的 Submission ID
* 后端使用唯一约束作为最终保护，不能只依赖前端禁用按钮
* POS、QR、Web 与 API 使用同一规则

Order 同时保存：

* `Order ID`：全局唯一、永不改变，供系统与跨 Domain 引用
* `Order Number`：供顾客、收据、Kitchen 与员工沟通，在 Store + Business Date 范围内唯一

Business Date 按 Store 营业日计算，不强制等同于午夜切换的自然日。内部时间统一保存 UTC。

已经正式分配的 Order Number 永不回收或重复使用：

* Rejected、Cancelled 或 Voided 后仍保留原编号
* 编号允许出现间隔
* Order 创建前提交失败时不消耗正式编号

### 24.11 Item 级进度与部分出餐

系统支持 Order Item 级别的进度与部分出餐：

* 每个 Order Item 拥有稳定 ID
* Kitchen 是制作状态的事实来源
* Ordering 通过 Kitchen Event 更新订单履约摘要
* 一个 Order Batch 可以部分 Item 已完成、其他仍在制作
* 顾客和员工可以看到部分完成状态
* Order Canonical Phase 根据各 Batch 与 Item 的总体情况推进

具体 Kitchen Item 状态在 Kitchen Domain 设计时确定。

---

## 25. Dining Domain

> Pilot baseline override：本节保留 Dining Domain 的完整能力边界；第一 live Pilot 只启用 Section 87.11.2 已接受的 `Staff Started` 模式。`Guest Self-Start`、`Convenience Mode` 与固定 Table QR 直接加入 / 建单均为禁用的 future-trigger capability，不属于 v0.1 实现范围。

### 25.1 职责边界

Dining 负责：

* Dining Area 与 Table
* Table 当前占用和清洁状态
* Dining Session 的开始、进行与结束
* Party、Participant 与 Order Host
* 入座、换桌、并桌和拆桌
* 桌码、临时访问码与扫码会话权限
* 关联当前活动 Order，但不管理订单内容

Dining 不负责：

* Reservation 与 Waiting
* Catalog、Cart 与 Order Item
* Kitchen 制作与出餐
* Payment 与 Refund

### 25.2 Dining Session 创建与阶段

完整能力模型可支持两种可配置创建模式；v0.1 Pilot 只实现 `Staff Started`：

* `Staff Started`
* `Guest Self-Start`

未来若经 IDR revision 启用，Store 或 Dining Area 才可选择 Guest Self-Start；届时必须检查 Table 是否已有活动 Session，并应用桌码、临时码和风险控制。

Canonical Dining Session Phase：

* `Pending`：已创建，等待员工确认或自助验证完成
* `Active`：顾客已经入座，可以点餐和加菜
* `Closing`：已请求结账，正在处理剩余订单和付款
* `Closed`：用餐结束
* `Cancelled`：Session 尚未正常开始便被取消

Payment Status 与 Dining Session Phase 分开。

Session 进入 `Closing` 后默认锁定 Shared Cart，顾客不能提交新 Order Batch。需要继续用餐时，由 Order Host 或员工执行 Cancel Checkout，在确认不存在不可逆付款或结算冲突后返回 `Active`。

### 25.3 Table Assignment 与清洁

一个 Dining Session 可以同时关联一张或多张 Table：

* 每张 Table 同一时间只能属于一个活动 Session
* 合桌不创建新的 Order
* 拆桌或换桌只改变 Table Assignment，不改写 Dining Session 与 Order 历史

Session 与 Table 的默认状态联动：

* Active Session → Table Occupied
* Session Closed → Table Needs Cleaning
* Mark Table Clean → Table Available

合桌 Session 关闭时，所有关联 Table 分别进入 Needs Cleaning。不跟踪清洁流程的 Store 可以配置为 Session 关闭后自动 Available。

### 25.4 Participant 与 Order Host

每位加入 Session 的顾客都获得 Session-scoped Participant ID，包括未登录顾客：

* Customer Account ID 可以为空
* Participant ID 用于记录 Cart Item 添加者和权限
* 顾客退出或重新加入时不删除历史操作
* Participant 不是平台账号，也不强制注册

Order Host 可以转移：

* future-trigger Guest Self-Start 启用后，创建 Session 的 Participant 默认成为 Host
* Staff Started 时可以由员工指定；未指定时首位加入者成为 Host
* 同一时间只能有一个 Host
* 当前 Host 或具备权限的员工可以转移 Host
* 转移只影响后续权限，不改写历史操作主体

### 25.5 Session Access

默认情况下，固定 Table QR 只识别 Store 与 Table：

* 浏览菜单不要求加入 Dining Session
* 参与点餐需要当前 Session 的临时短码、邀请链接或其他 Session Credential
* Convenience Mode 属于 future-trigger；只有先修订 Section 87.11.2 并通过安全评审后，才可允许扫描固定 QR 后直接加入
* Session Credential 在 Session 结束后失效

### 25.6 Dining 与 Order 关闭

Dining Session 与 Order 独立关闭：

* 顾客离桌且不会继续加菜时，Dining Session 可以关闭并释放桌台
* Dining Session Closed 后禁止新增 Order Batch
* Order 保留原 Dining Session 引用
* Order 可能因付款处理中、退款或异常任务继续保持 Open
* 未付款或异常情况生成任务继续处理
* Order 满足自身关闭条件后再独立 Closed

这样避免 Dining 与 Ordering 互相等待形成循环依赖。

---

## 26. Kitchen Domain

### 26.1 职责边界

Kitchen 负责：

* 接收符合进入厨房条件的 Order Batch 与 Order Item
* 创建 Kitchen Ticket 与 Kitchen Work Item
* 按 Station 路由
* 管理排队、暂缓、开始制作、完成和取消
* 支持分批制作、部分完成与出餐协调
* 处理改单、催单、优先级和重做
* 向 Ordering 发布 Item 制作进度与完成事件
* 计算和更新预计等待时间

Kitchen 不负责：

* 商业订单是否接受
* Catalog、Option 与 Recipe 定义
* Pricing、Payment 与 Refund
* 实时 Inventory 扣减
* Delivery 与 Table 管理
* 打印机和 KDS 设备连接

### 26.2 Release 与工作结构

Kitchen 不自行判断 Order 是否已付款或已接单。

Ordering Workflow 满足 Store 与 Order Type 的前置条件后发布：

`OrderBatchReleasedToKitchen`

Kitchen 只处理明确 Release 的 Batch。

工作结构：

`Order Batch → 1 Kitchen Ticket → 多个 Kitchen Work Item`

* Kitchen Ticket 表示该 Batch 的整体厨房工作单
* Work Item 是可以独立路由和制作的任务
* 每个 Work Item 分配给一个 Kitchen Station
* 同一个 Order Item 必要时可以拆成多个 Work Item
* Station Queue 是查询视图，不复制多份业务 Ticket
* 同一 Batch 重复收到 Release Event 时不得重复创建 Ticket

### 26.3 Kitchen Snapshot

Ticket 在 Release 时保存 Kitchen Snapshot，至少包括：

* Product、Variant 与 Option 显示名称
* 数量与顾客备注
* 制作说明
* Station Routing 结果
* Recipe / Preparation Version 引用
* Order Item 与 Order Batch ID

后续 Catalog、Recipe 或 Station 配置变化不得改变已经进入 Kitchen 的任务。

### 26.4 Work Item 状态与 Expo

Kitchen Work Item 第一版状态：

* `Queued`
* `Held`
* `In Progress`
* `Completed`
* `Cancelled`

`Ready` 不属于 Work Item 状态。当一个 Order Item 所需的全部 Work Item 完成后，由 Ticket / Expo 判断是否可以出餐。

Store 可以选择是否启用 Expo：

* 未启用：全部必要 Work Item 完成后自动 Ready
* 已启用：完成制作后等待 Expo 检查、组装并执行 Mark Ready

### 26.5 Course Control 与 ETA

第一版支持基础且可选的 Course Control：

* Order Item 可以携带 Course / Serving Sequence
* 后续 Course 的 Work Item 先进入 Held
* 服务员、Kitchen 或 Workflow 执行 Fire Course
* 不使用 Course 的 Store 在 Release 后直接进入 Queued
* 第一版不建立复杂任务依赖图

第一版采用确定性动态 ETA：

* Catalog / Recipe 提供基础 Preparation Time
* Kitchen 根据 Station 当前队列和进行中 Work Item 调整
* 多 Station 商品使用关键路径预计完成时间
* Order ETA 根据 Item 与 Course 汇总
* 队列变化时重新计算，并向 Ordering 和顾客端发布更新
* 第一版不引入机器学习

### 26.6 Rework 与部分数量完成

商品做错、掉落或需要重做时执行 Create Rework：

* 原 Work Item 保持原有结果，不回退状态
* 创建新的 Rework Work Item
* 关联原 Work Item 与 Order Item
* 必须记录原因、操作者和时间
* 按需通知 Inventory 记录额外消耗或 Waste
* 重新计算 ETA

Work Item 数量大于 1 时允许部分完成：

* 保存 Completed Quantity
* 尚有剩余数量时保持 In Progress
* 全部完成后进入 Completed
* 需要不同处理或出餐节奏时拆成多个 Work Item

### 26.7 Station 与 Routing

Kitchen Station 与 Routing Rule 属于 Kitchen Domain：

* Recipe 描述制作步骤和所需能力
* Kitchen 定义每个 Store 实际拥有的 Station
* Routing Rule 决定 Work Item 进入哪个 Station
* 路由可以参考 SKU、Category、Recipe Step、Order Type 等信息
* 路由结果在 Ticket 创建时写入 Snapshot

---

## 27. Pricing & Promotion Domain

### 27.1 职责边界

Pricing & Promotion 负责：

* 按 Brand、Store、Channel、Order Type 与生效时间解析基础价格
* 计算 Variant、Option、Bundle Upgrade 与数量价格
* 管理 Price Book、Price Rule 与 Effective Period
* 计算 Promotion、Coupon 与员工授权折扣
* 汇总服务费、配送费等外部费用结果
* 根据税务分类与地区规则计算税费
* 处理货币精度、舍入与分摊
* 生成包含完整明细和有效期的 Price Quote / Price Lock
* 向 Ordering 返回最终金额结果与计算依据

Pricing & Promotion 不负责：

* Product、SKU 与 Option 定义
* Order 生命周期
* 实际收款、退款与结算
* Loyalty 积分余额
* 配送距离与实时配送成本
* Inventory 与 Recipe

其他 Domain 可以提供费用输入，但订单最终金额由 Pricing 统一汇总。

### 27.2 Price Book 与价格解析

基础价格不保存在 SKU 上。Price Book 通过 Sellable ID 定义价格。

Pricing 使用 Base + Override：

* Brand 维护 Base Price Book
* Store Group、Region 或 Store 只保存需要调整的 Price Entry
* 没有 Override 时继承 Brand Base Price
* Channel、Order Type 与 Effective Period 可以进一步限定 Entry
* 最终上下文必须解析出唯一价格，否则拒绝销售并提示配置错误

该能力先保留在 Pricing Domain 内部；未来是否抽成 BOP Overlay Model 继续作为开放架构决策。

多个 Price Entry 同时匹配时采用确定性优先级：

1. Store + Channel / Order Type
2. Store
3. Store Group + Channel / Order Type
4. Store Group
5. Region + Channel / Order Type
6. Region
7. Brand + Channel / Order Type
8. Brand Default

Effective Period 只判断是否有效，不参与优先级比较。同一优先级出现多个匹配价格属于配置冲突，必须拒绝发布。

### 27.3 Currency

每个 Price Book 只使用一种 Currency：

* Store 配置默认交易 Currency
* Price Quote 与 Order 只能使用一种 Currency
* 同一个 Sellable 可以在不同 Currency Price Book 中拥有不同价格
* 顾客下单时不自动根据汇率换算价格
* Currency 必须随金额明确保存

### 27.4 Option 与 Bundle Pricing

Option 定义不保存固定价格。

Option Pricing Rule 引用 Product Option Binding + Option Choice，并可以进一步限定 SKU 与业务上下文，从而支持：

* 在某个 Product 中免费、另一个 Product 中收费
* 不同 SKU、Store 或 Channel 使用不同价格
* 包含免费数量，超出后收费

Bundle 默认作为独立 Sellable 定价：

* Bundle Base Price 由 Price Book 定义
* 默认包含选择不额外收费
* 升级或超出包含数量时应用 Upgrade Price Rule
* 内部商品单卖价格变化不自动改变已发布 Bundle Price
* 组件价格自动求和可以作为另一种明确 Pricing Mode

### 27.5 Promotion

Promotion 必须明确声明组合规则：

* `Exclusive`
* `Same Group Exclusive`
* `Stackable`

多个不可叠加优惠同时符合时，默认选择顾客节省最多的方案。Coupon 与员工 Manual Discount 同样遵守组合规则。Price Quote 保存最终选择过程和未采用原因。

第一版支持：

* Item 百分比或固定金额折扣
* Order 百分比或固定金额折扣
* 满额优惠
* Buy X Get Y
* Happy Hour / 指定时间优惠
* Coupon Code
* 员工授权 Manual Discount

Bundle 基础价与 Upgrade 不属于 Promotion；Loyalty 积分兑换由 Customer & Loyalty Domain 处理。

### 27.6 Tax

Tax Rate 不保存在 Price Entry 上：

* Catalog 提供 Tax Classification
* Store 提供税务地区与注册信息
* Pricing 内的 Tax Rule Set 根据地区、日期、商品分类、Order Type 与费用类型计算
* 支持含税价、未含税价、复合税和免税规则
* Order 保存最终税率、税额与 Tax Rule Version 快照

### 27.7 Service Charge、Tip 与 Price Quote

Service Charge / Automatic Gratuity 与 Optional Tip 严格分开：

* Service Charge 属于 Pricing，按规则自动加入，并依据 Tax Rule 判断是否计税
* Optional Tip 属于 Checkout / Payment，由顾客自愿选择，不作为商品价格或 Promotion

Order 分别保存：

* Subtotal
* Discount
* Service Charge
* Tax
* Tip
* Grand Total

Price Quote / Price Lock 继续遵循 Catalog 章节已经确认的配置与价格一致性规则，包括有效期、重新计价、涨价重新确认和完整计算快照。

---

## 28. Payment Domain

> Pilot baseline override：本节保留 Payment Domain 的长期能力模型；第一 live Pilot 的可执行 Tender、capture、refund、reconciliation 与 continuity 只以 Section 87.9 为准。Cash、split tender、gift / stored balance、wallet / BNPL、manual pay-later、offline collection 与复杂 partial refund 不进入 v0.1。

### 28.1 职责边界

Payment 负责：

* Payment Intent、Payment Attempt 与 Payment Transaction
* Cash、Card、Online Payment、Gift Card 等 Tender
* Authorization、Capture、Void、Refund 与 Chargeback
* 一单多次付款、混合付款与 Split Payment
* Tip 与付款人信息
* 支付平台 Webhook 的验证与幂等处理
* Order 已付、待付、退款与余额摘要
* Provider Adapter、Reconciliation 与 Settlement
* 发布付款成功、失败、退款等事实事件

Payment 不负责：

* 商品价格、折扣、Tax 与 Service Charge 计算
* Order 是否接单或进入 Kitchen
* Loyalty 积分规则
* Order Item 修改
* 打印设备与收据版式
* 会计总账

Ordering Workflow 根据 Payment Event 决定后续动作，Payment 不直接修改 Order Status。

### 28.2 追加式 Payment 模型

一个 Order 可以关联多个支付对象：

* `Payment Intent`：本次准备支付的金额与 Tender
* `Payment Attempt`：一次实际渠道请求；失败重试创建新的 Attempt
* `Payment Transaction`：已经发生的授权、扣款、现金收取、退款等资金事实

失败记录和旧记录不覆盖或删除。Order 当前余额通过 Transaction 与 Payment Allocation 计算。

### 28.3 Split Payment 与并发保护

以下是 future-trigger 完整能力候选，不是第一 Pilot scope：

* `Equal Split`
* `Custom Amount`
* `Pay by Item`
* `Pay Remaining Balance`
* 不同付款人使用不同 Tender

折扣、Service Charge 与 Tax 分摊由 Pricing 提供，Payment 记录最终金额 Allocation。

多人同时付款时，Payment Intent 对目标金额建立短时 Payment Reservation：

* 已被有效 Intent 预留的金额不能再次选择
* 成功后 Reservation 转为实际 Payment Allocation
* 失败、取消或超时后自动释放
* 最终入账时再次检查 Order Balance
* Cash 找零单独记录，不作为 Order 超付

### 28.4 Provider Adapter 与支付确认

Payment Core 保持 Provider-neutral。Stripe、Moneris、Square、微信支付、支付宝等通过 Adapter 转换到统一概念。

核心不保存完整银行卡号、CVV 或支付密码，只保存必要脱敏信息与 Provider Reference。

在线支付结果：

* 不能根据顾客浏览器返回页直接判定成功
* 必须来自经过验证的 Provider Webhook 或主动查询
* Webhook 按 Provider Event ID 幂等处理
* 重复、乱序或延迟事件不能产生重复入账
* 未来经 IDR revision 启用的受支持线下 Tender，才可由具备权限的员工 Action 确认；v0.1 不允许 Staff 以 Action 声称 Cash 或人工 Payment Success

### 28.5 Tip 与 Refund

Tip 属于每个 Payment Intent / Transaction：

* 每位付款人可以独立选择 Tip
* Tip 不占用 Order 未付余额的 Payment Reservation
* Payment Total = Order Allocation + 该付款人的 Tip
* Order Tip Total 汇总所有成功 Transaction 的 Tip
* Refund 时可以分别选择是否退还对应 Tip

Refund 必须引用原始成功 Transaction：

* 支持 Full Refund 与 Partial Refund
* 累计退款不能超过原 Transaction 的可退金额
* 保存退款原因、操作者与 Provider Reference
* 每次 Refund 创建新的追加式记录，不修改原付款
* Order Cancellation 不自动等于 Refund
* Provider Refund 失败时保留失败记录，可以受控重试

### 28.6 Tender、Authorization 与 Settlement

完整能力模型的候选 Tender Type；第一 Pilot 仅启用 Section 87.9 明列的 Stripe online `card` 与 Stripe Terminal card-present / Interac：

* `Cash`
* `Card Present`
* `Card Not Present`
* `Digital / QR Wallet`
* `Gift Card`
* `External Prepaid`

Loyalty Points 与 House Account 留到对应 Domain。

Authorization 与 Capture 分开：

* `Authorized` 表示渠道已预留额度，默认不计入 Order Paid Balance
* `Captured` 表示顾客付款义务已完成，可以计入 Paid Balance
* `Sale` 可以一次完成 Authorization + Capture
* Ordering Workflow 可以决定 Authorization 是否足以放行 Kitchen

Order 不等待 Provider Settlement：

* Captured 后即可按已付款处理并在满足其他条件时关闭
* Settled 表示 Provider 后续向商家结算
* Settlement 差异生成 Reconciliation Exception，不改写 Order 与 Capture 事实

### 28.7 Chargeback

Closed Order 后发生 Chargeback 时：

* 不自动 Reopen Order
* 创建新的 Chargeback / Dispute 记录
* 更新支付与对账结果
* 生成调查、证据提交或追款任务
* Order 保留原 Fulfilled 与 Closed 事实
* 经理可以按业务需要执行受控 Reopen 或其他补偿 Action

---

## 29. Recipe Domain

### 29.1 职责边界

Recipe 负责：

* Recipe、Ingredient Requirement 与 Preparation Step
* 份量、Yield、损耗率和计量单位
* 半成品 / Sub-recipe
* 根据 SKU、Variant 与 Option 解析最终配方
* 计算 Product Configuration 的理论 Inventory Item 消耗
* 提供 Kitchen 所需制作说明、时间与能力要求
* 汇总 Nutrition 与 Allergen 来源，供 Catalog 展示或审核
* Recipe 版本、发布与生效管理

Recipe 不负责：

* Product、SKU、Menu 与 Option 定义
* Inventory Item 实时库存数量
* Procurement、Supplier 与成本结算
* Kitchen 实际制作状态
* Pricing 与 Order 生命周期

Recipe 引用 Catalog SKU / Binding 与 Inventory Item ID，不复制定义。

### 29.2 SKU Binding 与 Modifier

最终可执行 Recipe 绑定 SKU：

* Product 可以提供共享 Recipe Template
* 每个需要制作的 SKU 必须最终解析出唯一 Recipe Version
* 不需要制作的 Sellable 可以没有 Recipe

Option 使用 Base Recipe + Recipe Modifier Rule，不复制每种完整组合。

Modifier Rule 通过 Product Option Binding + Option Choice 生效，可以：

* 增加 Ingredient
* 移除 Ingredient
* 替换 Ingredient
* 调整用量
* 修改 Preparation Step
* 调整制作时间或能力要求

### 29.3 Sub-recipe

Recipe 可以引用 Sub-recipe / 半成品：

* Parent Recipe 引用明确的 Sub-recipe Version
* Sub-recipe 定义 Batch Yield 与单位
* 系统按实际使用量换算原料消耗
* 禁止直接或间接循环引用
* 已发布 Parent Recipe 默认固定 Sub-recipe Version

### 29.4 Measurement Conversion

Recipe 用量单位可以与 Inventory 基础单位不同，但必须存在明确且兼容的转换规则：

* `g ↔ kg`、`ml ↔ L` 等使用同维度标准转换
* `piece ↔ g`、`case ↔ piece` 等必须配置 Inventory Item 专属转换
* 不同维度且没有转换规则时拒绝发布 Recipe
* 转换规则需要版本化，保证历史消耗可以复算

Measurement / Unit Conversion 是否未来抽为 BOP 通用能力，记录为 Open Architecture Decision，不在当前阶段抽离。

### 29.5 理论消耗与 Inventory

Recipe 不直接修改实时 Inventory，只输出标准理论消耗：

* Inventory Item ID
* 标准用量
* 单位换算结果
* Yield / Waste 调整
* Recipe Version
* SKU、Option 或 Sub-recipe 来源

Inventory 根据 Order、Kitchen 完成、取消、Rework 与 Waste Event 决定何时预留或实际扣减。

### 29.6 Store Recipe Override

Store 可以在 Brand 明确授权下覆盖 Recipe：

* Brand 提供默认 Recipe Version
* Store Group 或 Store 绑定自己的完整 Recipe Version
* 不对已发布 Recipe 零散修改 Ingredient
* 每个 Store + SKU + Effective Time 必须解析出唯一 Recipe Version
* 覆盖后重新检查 Allergen、Nutrition、成本与 Kitchen Routing 影响
* Order / Kitchen Snapshot 固定实际 Recipe Version

### 29.7 Preparation Step 与 Kitchen Work Item

Recipe Step 不直接等同于 Kitchen Work Item：

* Recipe Step 定义制作说明、预计时间、所需能力和基本顺序
* Kitchen 按 Store Station 与 Routing Rule，将一个或多个 Step 转换为 Work Item
* 多个简单 Step 可以合并为一个 Work Item
* 多 Station 协作的 Step 可以拆分
* 第一版只支持基本顺序与并行分组，不建立复杂流程图

---

## 30. Inventory Domain

### 30.1 职责边界

Inventory 负责：

* Inventory Item
* Store、Warehouse 与 Storage Location 库存
* On Hand、Reserved、Available 与 In Transit
* 追加式 Stock Ledger
* Receiving、Consumption、Waste、Transfer、Count 与 Adjustment
* Lot / Batch、Expiry Date 与 FEFO 建议
* 按 Recipe 理论消耗和 Kitchen Event 处理预留与扣减
* 低库存、安全库存与补货提醒
* 库存成本和估值所需事实
* 向 Catalog / Ordering 发布缺货与恢复事件

Inventory 不负责：

* Product、SKU 与 Recipe 定义
* Purchase Order 与 Supplier 管理
* Kitchen 制作流程
* 商品销售价格
* Order 生命周期
* 会计总账

Procurement 负责向谁买、买多少；Inventory 负责实际收到、存放位置与剩余数量。

### 30.2 Inventory Item 与 SKU

Inventory Item 与 Catalog SKU 是独立对象。

Inventory Item 可以是：

* 原材料
* 包装材料
* 半成品
* 可库存成品

多个 SKU 可以消耗同一 Inventory Item；一个 SKU 可以通过 Recipe 消耗多个 Inventory Item。瓶装饮料等成品可以建立 SKU 与 Inventory Item 的一对一映射，但身份仍然分开。

### 30.3 Stock Ledger

Stock Ledger 是库存事实来源，不直接覆盖 Current Quantity。

每次变化创建 Stock Movement，例如：

* Receive
* Reserve / Release
* Consume
* Waste
* Transfer
* Count Adjustment

On Hand、Reserved 与 Available 是 Ledger 计算或投影结果。错误通过反向 Adjustment 更正，不能修改或删除原 Movement。

### 30.4 Stock Site 与 Storage Location

第一版支持 Store 或 Warehouse 内部的 Storage Location，例如 Back Room、Fridge、Freezer、Bar 与 Kitchen Line。

库存余额按 Inventory Item + Stock Site + Storage Location 管理。小店可以只启用一个默认位置。Location 之间移动记录 Transfer。

### 30.5 Lot、Expiry 与 FEFO

Lot / Expiry Tracking 按 Inventory Item 配置：

* `No Lot Tracking`
* `Lot Optional`
* `Lot Required`
* `Lot + Expiry Required`

有 Expiry 的物料使用 FEFO。缺少 Item Policy 要求的 Lot 或 Expiry 时，不能完成 Receiving。

### 30.6 Reservation 与 Consumption

Reservation 与 Consumption 分开：

* Reserve 暂时占用库存
* 制作前取消时 Release Reservation
* Consume 表示原料已投入制作或成品已交付
* 开始制作后取消的原料记录 Consumption 或 Waste，不能直接释放
* Reserve 与 Consume 时点由 Store Workflow 与 Item Policy 决定

### 30.7 Negative Stock Policy

库存不足策略按 Inventory Item / Store 配置：

* `Block`
* `Manager Override`
* `Allow with Warning`

负库存不能静默产生。Override 与 Allow with Warning 必须生成异常记录或处理任务。

### 30.8 Availability 协作

Inventory 缺货时不直接修改 Catalog，而是发布 Availability Result：

* 基础必需 Ingredient 不足时，相关 SKU 暂时不可售
* 可选 Ingredient 不足时，只禁用对应 Option
* Bundle 选择缺货时，禁用该选择；没有有效选择时 Bundle 才不可售
* 库存恢复后发布恢复事件

Ordering 提交时仍执行最终库存验证。

---

## 31. Procurement & Supplier Domain

### 31.1 职责边界

Procurement & Supplier 负责：

* Supplier 资料、联系人、资质与合作状态
* Supplier 与 Inventory Item 的供货关系
* 供应商货号、采购单位、换算规则、MOQ、Lead Time、采购报价和币种
* Purchase Requisition、审批与 Purchase Order
* 供应商确认、采购单变更、取消、部分履行与关闭
* 根据 Inventory 补货需求决定向谁买、买多少
* 根据实际收货结果更新采购单履行进度
* Supplier 交付表现记录

Procurement & Supplier 不负责：

* 实际收货、Lot、Expiry、Storage Location 与 Stock Ledger；这些属于 Inventory
* Recipe、Catalog、销售价格、Order 与 Kitchen
* 供应商付款、应付账款和会计总账；这些留给未来 Finance / Accounting Domain

核心协作：

`Procurement 发布 Purchase Order → Inventory 记录实际收货 → Procurement 根据收货事件更新 PO`

### 31.2 Supplier Aggregate Root

Supplier 是独立 Aggregate Root：

* Supplier 拥有独立且稳定的身份与生命周期
* Supplier 可以被多个 Purchase Order 和供货关系引用
* Supplier 停用后不删除或改写历史采购记录
* Purchase Order 不属于 Supplier Aggregate 内部，只保存 Supplier ID 引用
* Supplier 的归属与共享范围单独讨论

### 31.3 Supplier 归属范围

第一版 Supplier 归属于 Brand，不归属于单个 Store：

* Supplier Aggregate 保存 Brand ID
* 同一 Brand 下的多家 Store 可以共同使用同一个 Supplier
* Store 不需要重复创建 Supplier
* 不同 Brand 即使使用同一家现实供应商，也分别维护自己的 Supplier 记录
* 第一版不建立跨 Brand 共享的全平台 Supplier Directory
* 跨 Brand 共享能力记录为 Open Architecture Decision，未来按需设计

### 31.4 Supplier Lifecycle

第一版状态：

* `Draft`：资料尚未完成，不能用于正式采购
* `Active`：可以创建新的采购关系和 Purchase Order
* `Suspended`：临时暂停新采购，可以恢复
* `Inactive`：合作关系已经结束，不允许新增采购
* `Archived`：仅保留历史和审计，默认不在普通列表显示

核心规则：

* `Suspended` 或 `Inactive` 不自动取消、删除或改写已有 Purchase Order
* 已有 Purchase Order 仍可继续收货、关闭或通过明确 Action 取消
* `Inactive` 可以经过受控审核恢复为 `Active`
* `Archived` 不能直接恢复为 `Active`，必须先恢复为 `Inactive`
* Supplier 不允许物理删除

### 31.5 Supplier Item Offering Aggregate

Supplier 与 Inventory Item 之间通过独立的 Supplier Item Offering Aggregate Root 建立供货关系：

`Supplier → Supplier Item Offering ← Inventory Item`

核心规则：

* Supplier 不直接保存庞大的 Inventory Item 列表
* Inventory Item 不直接保存 Supplier 数据
* 每个 Offering 同时引用 Supplier ID 与 Inventory Item ID
* 一个 Supplier 可以提供多个 Inventory Item
* 一个 Inventory Item 可以由多个 Supplier 提供
* 同一 Supplier 对同一 Inventory Item 可以拥有多个 Offering，例如不同包装规格或供应商货号
* Offering 拥有独立稳定 ID
* Offering 承载采购单位、包装换算、MOQ、Lead Time 等非价格采购配置，并被采购价格记录引用

### 31.6 Supplier Item Offering Version

Supplier Item Offering 采用稳定身份与版本化配置分离。

Supplier Item Offering 保存：

* Offering ID
* Brand ID
* Supplier ID
* Inventory Item ID
* Lifecycle

Supplier Item Offering Version 保存：

* 供应商货号与名称
* Purchase Unit
* 包装数量与单位换算
* MOQ
* Order Multiple
* Lead Time
* 其他订购限制

核心规则：

* 配置变化时创建新的 Offering Version，不覆盖旧版本
* Supplier 或 Inventory Item 身份改变时创建新的 Offering
* Purchase Order Line 保存 Offering ID、Offering Version ID 与采购快照
* 后续配置变化不得改变历史 Purchase Order
* 报价与价格的具体归属单独讨论

### 31.7 Supplier Price Record

采购价格与 Supplier Item Offering Version 分离。

Supplier Item Offering Version 负责如何采购，包括：

* Purchase Unit
* 包装与单位换算
* MOQ
* Order Multiple
* Lead Time
* 订购限制

独立的 Supplier Price Record 负责采购价格，包括：

* Currency
* Unit Cost
* Price Unit
* 数量阶梯价
* Effective Period
* Price List、Contract、Quote 或 Manual Entry 等价格来源

核心规则：

* 调价不要求创建完整的新 Offering Version
* 同一 Offering 可以同时拥有按数量、时期或适用范围区分的价格
* 历史价格记录必须保留
* Purchase Order Line 保存 Price Record ID 与完整成交成本快照

### 31.8 Purchase Requisition 与 Purchase Order

Purchase Requisition 与 Purchase Order 是两个独立 Aggregate Root。

Purchase Requisition 表示内部采购需求：

* 记录需要采购的 Inventory Item、数量与需要时间
* 创建时可以尚未确定 Supplier
* 负责内部提交与审批
* 不代表已经向 Supplier 作出采购承诺

Purchase Order 表示对外采购订单：

* 必须指定 Supplier
* 包含最终数量、采购价格、交付地点与预计日期
* 发出后形成正式采购承诺
* 拥有独立的变更、取消与履行状态

关系规则：

* 一个 Requisition 可以拆分到多个 Purchase Order
* 一个 Purchase Order 可以合并多个已批准 Requisition
* Requisition Line 与 Purchase Order Line 通过 Allocation Relationship 追踪来源
* Requisition 获批不自动等于 Purchase Order 已发出
* 必须执行明确的 Create / Issue Purchase Order Action

### 31.9 Purchase Requisition 状态模型

Purchase Requisition 分开保存审批、PO 分配与关闭状态。

Workflow Status：

* `Draft`
* `Submitted`
* `In Review`
* `Approved`
* `Rejected`
* `Cancelled`

PO Allocation Status：

* `Not Allocated`
* `Partially Allocated`
* `Fully Allocated`

Closure Status：

* `Open`
* `Closed`

核心规则：

* 已批准的 Requisition 可以只部分转换为 Purchase Order
* PO Allocation 不改变原来的审批结果
* 全部需求已分配到 PO，或剩余需求被明确取消、豁免后，Requisition 才能关闭
* 实际是否收货属于 Purchase Order 与 Inventory，不属于 Requisition 状态
* 所有转换通过明确 Action 与 BOP Workflow 完成

### 31.10 Purchase Order 单据范围

每张 Purchase Order 只对应：

* 一个 Supplier
* 一个 Buyer Legal Entity
* 一种 Currency
* 一个 Ship-To Stock Site / 收货地址

一张 Purchase Order 可以包含：

* 多个 Purchase Order Line
* 来自多个已批准 Requisition 的需求

核心规则：

* Supplier、Currency、Buyer Entity 或收货地点不同，必须拆分为不同 Purchase Order
* 同一 Supplier 向多家 Store 分别送货时，第一版创建多张 Purchase Order
* Purchase Order 发出时保存 Supplier、Buyer、收货地址与商业条款快照
* Buyer Legal Entity 通过 Section 42.5 的 `Procurement Buyer` Business Function + Effective Time 解析为唯一 Operating Entity，并在 PO 发出时固定 Snapshot

### 31.11 Purchase Order 状态模型

Purchase Order 分开保存 Workflow、Fulfillment 与 Closure 状态。

Workflow Status：

* `Draft`
* `Submitted`
* `Approved`
* `Issued`
* `Acknowledged`
* `Supplier Declined`
* `Cancelled`

Fulfillment Status：

* `Not Received`
* `Partially Received`
* `Fully Received`

Closure Status：

* `Open`
* `Closed`

核心规则：

* `Approved` 不等于已经发送给 Supplier
* 只有执行 `Issue Purchase Order` 后才进入 `Issued`
* Supplier 确认或拒绝必须单独记录
* 部分收货不改变 Purchase Order 的审批与发出事实
* `Cancelled` 不自动撤销已经发生的收货
* 所有 Purchase Order Line 已有最终结果且没有待处理变更或异常后，才能进入 `Closed`

### 31.12 Purchase Order Revision / Amendment

已经发出的 Purchase Order 不得直接覆盖，必须通过 Revision / Amendment 修改。

核心规则：

* `Draft` 阶段可以直接编辑
* 已批准但尚未发出的 Purchase Order 如果发生实质修改，原审批失效并重新审批
* `Issued` 或 `Acknowledged` 后，原始版本不可修改
* 数量、采购价格、预计交付日期或商业条款变化时创建新 Revision
* Revision 保存版本号、修改原因、操作者、时间、审批结果及 Supplier 确认结果
* 历史 Revision 全部保留
* Supplier、Buyer Legal Entity、Currency 或 Ship-To Location 改变时，不使用 Revision；应取消尚未履行部分并创建新的 Purchase Order
* 已经发生的收货不因 Revision 或取消而被改写

### 31.13 Purchase Order Line Snapshot

每个 Purchase Order Line 同时保存稳定引用与完整采购快照。

稳定引用包括：

* Purchase Order Line ID
* Inventory Item ID
* Supplier Item Offering ID
* Offering Version ID
* Supplier Price Record ID
* Requisition Line Allocation Reference

Purchase Order 发出时保存的快照包括：

* Inventory Item 名称
* Supplier Item Code 与名称
* Purchase Unit
* 包装数量与单位换算
* Ordered Quantity
* Unit Cost 与 Currency
* Discount 与 Line Total
* Expected Delivery Date
* 适用的商业条款

核心规则：

* Offering、Price Record 或 Inventory Item 后续变化不得改变已经发出的 Purchase Order
* Inventory 收货时使用该快照将采购单位转换为库存基础单位
* 实际收货数量、Lot、Expiry 与库存成本仍由 Inventory 保存
* Purchase Order Revision 产生新的有效行版本，不覆盖原始采购快照

### 31.14 Inventory Replenishment Collaboration

Inventory 通过 `ReplenishmentNeedDetected` Event 向 Procurement 提出补货需求，至少包含：

* Inventory Item ID
* Stock Site / Storage Location
* 建议补货数量与基础单位
* Required By
* 缺货原因或安全库存规则
* 当前库存预测快照
* 唯一 Replenishment Need ID

Procurement 收到后：

* 根据 Brand Policy 创建 Draft Purchase Requisition，或生成采购处理任务
* 根据 MOQ、Order Multiple、Lead Time、价格与 Supplier 情况决定最终采购数量和 Supplier
* 不自动批准 Purchase Requisition
* 不自动创建或发出 Purchase Order

核心规则：

* 使用 Replenishment Need ID 保证幂等，不重复创建需求
* Inventory 只提出库存需求，不选择 Supplier
* 库存需求消失时，不自动取消已经创建的 Requisition 或 Purchase Order，只生成影响提示或处理任务
* 只有明确启用 Auto-Replenishment Policy 时，才允许自动创建 Draft Purchase Requisition

### 31.15 Goods Receipt Collaboration

Inventory 是实际收货的事实来源，Procurement 只维护 Purchase Order 履行投影。

Inventory 发布：

* `GoodsReceiptPosted`
* `GoodsReceiptAdjusted`
* `GoodsReceiptVoided`

Event 至少包含：

* Goods Receipt ID 与 Receipt Line ID
* Purchase Order ID 与 Purchase Order Line ID
* 实收数量和单位
* 接受、拒收或损坏数量
* Stock Site
* 收货时间
* Event ID

Procurement 根据 Event 更新：

* Cumulative Received Quantity
* Remaining Quantity
* `Not Received`、`Partially Received` 或 `Fully Received`
* 收货差异与异常任务

核心规则：

* Procurement 不允许人工直接输入或覆盖 Received Quantity
* 重复 Event 必须幂等处理
* 收货错误通过 Inventory Adjustment 或 Void Event 更正
* 不修改或删除原始收货事实
* 超收、短收、拒收和损坏不得静默处理，必须生成明确差异记录

### 31.16 Receiving Discrepancy Policy

Purchase Order 定义 Receiving Tolerance Policy，由 Inventory 在收货时执行。

超收策略：

* `Block`
* `Manager Override`
* `Allow Within Tolerance`

短收处理：

* 保留 Remaining Quantity，等待后续补货
* 标记为 Backordered
* 通过明确 Action 取消或豁免剩余数量并关闭 Purchase Order Line

拒收或损坏处理：

* 不计入 Accepted Received Quantity
* 记录拒收或损坏数量与原因
* 生成处理任务或 Supplier Discrepancy

核心规则：

* 任何超收都不能静默发生
* Override 必须记录原因、操作者与时间
* 短收不自动视为 Purchase Order 已完成
* 被接受的容差内超收可以进入库存，但 Purchase Order 必须保留差异记录
* 差异结果后续可以用于 Supplier Performance，但不直接自动处罚 Supplier

### 31.17 Supplier Performance

Supplier Performance 是基于采购事实生成的派生投影，不允许人工直接覆盖底层数据。

第一版指标：

* On-Time Delivery Rate
* Fill Rate
* Accepted Quality Rate
* 超收、短收、拒收与损坏频率
* Supplier Acknowledgement Response Time
* Supplier Decline / Cancellation Rate
* Purchase Price Variance

计算范围可以按：

* Supplier
* Supplier Item Offering
* Stock Site
* 时间区间

核心规则：

* 指标来源于 Purchase Order、Revision、Supplier Acknowledgement 与 Goods Receipt Event
* 原始事实不因重新计算评分而改变
* 允许员工添加独立的 Manual Assessment 与备注，但不能改写系统指标
* 低评分默认只生成 Alert、Review Task 或审批要求
* 不因一次低评分自动将 Supplier 设为 `Suspended` 或 `Inactive`
* 自动限制必须通过明确的 Brand Policy 与审批流程

### 31.18 Supplier Qualification

Supplier Qualification 是 Supplier Aggregate 内具有稳定 ID 的 Entity，并复用 BOP Effective Period。

记录内容：

* Qualification Type
* Jurisdiction
* Certificate / Licence Number
* Issuer
* Effective From / Expiry Date
* Document Reference
* Review Status
* 适用的 Supplier、Offering 或物料类别范围

核心规则：

* 资质要求由国家、地区、Supplier Type 与 Inventory Item Category Policy 决定
* 证件更新创建新版本，不覆盖旧证件
* 到期前自动提醒并生成续期任务
* 必需资质过期时，默认阻止新的 Offering 发布与 Purchase Order 发出
* 不自动取消已经发出的 Purchase Order，也不阻止对已到货商品完成必要收货处理
* 紧急采购可以通过受控 Manager Override 放行，但必须记录原因、审批人和临时有效期
* 历史证件与审核结果永久保留

### 31.19 Supplier Price Resolution

多个采购价格同时有效时采用确定性 Supplier Price Resolution。

优先级：

1. 当前 Requisition / Purchase Order 明确关联的 Approved Quote
2. 匹配适用范围的 Contract Price
3. Stock Site 专属 Price List
4. Store Group / Region Price List
5. Supplier 在该 Brand 下的 Default Price
6. 经过授权的 Manual Price Record

核心规则：

* Effective Period 只判断价格是否有效，不参与优先级比较
* 数量满足条件后应用对应 Quantity Tier
* Currency 必须与 Purchase Order Currency 一致
* 同一优先级出现多个有效匹配价格属于配置冲突
* 发生冲突时不得随机选择，必须阻止 Purchase Order 发出并要求修复
* 员工不能直接在 Purchase Order Line 任意输入价格
* 特殊价格必须通过受权限与审批控制的 Price Record
* Purchase Order 发出后保存最终 Price Record ID、解析依据与价格快照

### 31.20 Domain Events

第一版最小 Domain Event 集合：

Supplier：

* `SupplierActivated`
* `SupplierSuspended`
* `SupplierDeactivated`
* `SupplierQualificationExpiring`
* `SupplierQualificationExpired`

Supplier Item Offering：

* `SupplierItemOfferingPublished`
* `SupplierItemOfferingSuspended`
* `SupplierPriceBecameEffective`

Purchase Requisition：

* `PurchaseRequisitionSubmitted`
* `PurchaseRequisitionApproved`
* `PurchaseRequisitionRejected`
* `PurchaseRequisitionCancelled`

Purchase Order：

* `PurchaseOrderIssued`
* `PurchaseOrderAcknowledged`
* `PurchaseOrderDeclined`
* `PurchaseOrderRevised`
* `PurchaseOrderCancelled`
* `PurchaseOrderPartiallyReceived`
* `PurchaseOrderFullyReceived`
* `PurchaseOrderReceivingDiscrepancyDetected`
* `PurchaseOrderClosed`

核心规则：

* Event 只描述已经发生的事实，不作为命令
* 每个 Event 必须包含 Event ID、Version、Brand ID、相关 Aggregate ID 与发生时间
* 消费者必须幂等处理
* Purchase Order 收货类 Event 基于 Inventory 的 Goods Receipt Event 生成
* Notification、Task、BI 与 Supplier Performance 通过订阅 Event 协作
* 非关键订阅者失败不得阻断采购主流程

### 31.21 v0.1 阶段状态

Procurement & Supplier Domain v0.1 已阶段性完成并 Freeze。

Freeze 表示：

* 核心职责边界与结构暂不继续细化
* 联系人字段、编号格式与页面流程等实现细节留到开发阶段
* 以后发现跨 Domain 冲突时仍可受控修订
* 后续讨论不重新展开已经确认的内容

---

## 32. Reservation & Waiting Domain

### 32.1 职责边界

Reservation & Waiting 负责：

* 未来日期与时段的 Reservation
* Party Size、预计用餐时长与特殊需求
* Capacity / Time Slot 查询与预留
* Reservation 的确认、修改、取消、迟到与 No-show
* Walk-in Waitlist
* 等候顺序、预计等待时间与优先级
* Check-in、Call Party、确认到场、过号与移除
* 向 Dining 发布可以安排入座的事实
* 触发提醒、到号通知与超时任务

Reservation & Waiting 不负责：

* Table 当前占用、清洁与实际 Table Assignment；这些属于 Dining
* Dining Session 的创建与关闭
* Cart、Order 与 Kitchen
* 订金或 No-show Fee 的金额计算与收款；分别由 Pricing 与 Payment 处理
* Customer Profile 与 Loyalty 数据
* 直接发送 SMS、Email 或 Push；由 BOP Notification 处理

核心边界：

**Reservation & Waiting 管理未来需求与等待队列；Dining 管理实际入座、桌台和用餐过程。**

### 32.2 Aggregate 划分

第一版 Aggregate Root：

* Reservation Aggregate Root
* Waitlist Entry Aggregate Root

整个 Waitlist Queue 是排序后的查询投影，不建立一个包含所有 Waitlist Entry 的巨大 Aggregate。

核心规则：

* 每个 Reservation 拥有独立的确认、修改、取消、迟到与 No-show 生命周期
* 每个 Waitlist Entry 拥有独立的 Check-in、Call、过号、入座与移除流程
* 多个员工同时操作队列时不争用同一个巨大 Aggregate
* 排队顺序与预计等待时间可以根据桌台情况动态重新计算
* 入座后只保存 Dining Session ID 关联，不把 Dining Session 放入这两个 Aggregate

### 32.3 Reservation Lifecycle

第一版状态：

* `Pending`：等待门店确认、容量验证或其他前置条件
* `Confirmed`：Reservation 已经成立
* `Checked In`：顾客已经到店，但尚未入座
* `Seated`：Dining 已完成实际入座并创建 Dining Session
* `Cancelled`：Reservation 被顾客、员工或系统取消
* `No Show`：超过 Grace Period 后确认未到店
* `Expired`：临时 Reservation 请求或 Capacity Hold 未在时限内完成

核心规则：

* 支持自动确认与人工确认两种模式
* Payment / Deposit Status 与 Reservation Status 分开
* `Checked In` 不等于已经入座
* `Seated` 必须来自 Dining 的实际入座结果
* No-show 只能在预约时间加 Grace Period 后通过明确 Policy / Action 判定
* 修改时间、人数或区域等关键内容时必须重新验证容量，必要时返回 `Pending`
* `Cancelled`、`No Show` 与 `Expired` 都保留原因、Actor 与时间
* 已 `Seated` 的 Reservation 不再取消；后续由 Dining Session 管理

### 32.4 Waitlist Entry Lifecycle

第一版状态：

* `Waiting`：已经进入队列，可以是远程加入
* `Checked In`：顾客已经到店并继续等待
* `Called`：系统或员工已经通知顾客可以准备入座
* `Ready`：顾客已回应并确认在场，等待 Dining 安排桌台
* `Seated`：Dining 已完成实际入座
* `Missed`：Call 后在 Response Window 内没有回应
* `Cancelled`：顾客或员工主动取消
* `Expired`：超过最大等待时限或门店停止接待

核心规则：

* 现场加入的顾客可以直接进入 `Checked In`
* 远程加入者可以从 `Waiting` 完成 Check-in
* 调整队列顺序不会改变 Lifecycle
* `Called` 必须保存通知时间与 Response Deadline
* `Ready` 不等于已经入座
* `Seated` 必须来自 Dining 的实际入座结果
* `Missed` 可以由具备权限的员工恢复到 `Waiting` 或 `Checked In`
* 所有终止与恢复操作必须保存原因、Actor 与时间

### 32.5 Reservation Capacity Model

第一版采用 Capacity Pool + Time Interval，默认不提前锁定具体 Table。

Reservation 预留：

* Store
* Dining Area / Capacity Pool
* Party Size
* Start Time
* Expected Duration
* Turn-time Buffer

容量计算参考：

* Dining 提供的桌台数量、座位数与并桌能力
* 营业时间与区域开放时间
* 已确认 Reservation
* 尚未过期的临时 Capacity Hold
* 特殊关闭、活动或人工容量调整

核心规则：

* 顾客可以提交 Table Preference、无障碍需求等，但默认不保证具体桌号
* 实际 Table Assignment 仍由 Dining 在入座时完成
* 顾客填写资料或支付订金期间，可以创建具有 TTL 的临时 Capacity Hold
* Capacity Hold 超时后自动释放
* 容量检查与确认预留必须原子执行，防止并发超卖
* 第一版不允许普通员工直接突破容量；特殊超额 Reservation 通过受控 Manager Override
* 具体 Table 的硬性预留能力未来按需单独设计

### 32.6 Waitlist Ordering

Waitlist 不是单一固定 FIFO，而是先判断桌台兼容性，再在符合条件的 Entry 中排序。

Eligibility：

* Party Size 与可用桌台容量匹配
* Dining Area / Seating Preference 匹配
* 无障碍或其他必要条件满足
* Waitlist Entry 处于可处理状态

Priority：

* 默认按 Queue Joined At 先后排序
* Store 可以配置 `Checked In` 顾客优先于尚未到店的远程顾客
* Reservation 延误补偿、无障碍需求等特殊优先级必须通过明确 Policy
* Manager 可以执行 Priority Override，但必须填写原因并记录 Audit

核心规则：

* Queue Position 是动态查询结果，不保存为不可变业务事实
* Party Size 不同可能进入不同的可用桌台匹配队列
* 后加入的小桌 Party 可能先获得合适桌台，这不等于改写原始排队时间
* 顾客端优先显示 Estimated Wait Range
* 精确排位只能作为参考，不能承诺
* 系统必须保留原始 Joined At、每次优先级变化及 Override 记录

### 32.7 Estimated Wait

第一版采用确定性的动态计算，不引入机器学习。

计算参考：

* 当前可用 Table
* Active Dining Session 的预计结束时间
* Table Cleaning Buffer
* 与该 Party 兼容且排在前面的 Waitlist Entry
* 即将开始的 Confirmed Reservation
* 尚未过期的 Capacity Hold
* Party Size、Dining Area 与 Seating Constraint
* Store 配置的标准 Turn Time

输出：

* Estimated Wait Minimum
* Estimated Wait Maximum
* Calculated At
* Calculation Version

核心规则：

* Table、Dining Session、Reservation 或 Waitlist 状态变化时重新计算
* Estimated Wait 是预测范围，不是承诺时间
* 预计等待显著延长时通过 Notification Event 通知顾客
* Manager 可以临时调整等待时间，但必须记录原因、Actor 与有效期
* 历史估算结果保留，用于后续 BI 分析和改进模型
* 第一版不使用机器学习；未来可以在不改变业务边界的情况下替换估算算法

### 32.8 Deposit / No-show Fee Collaboration

Reservation & Waiting：

* 判断当前 Reservation 是否需要 Deposit 或 No-show Guarantee
* 保存适用 Policy ID、Policy Version 与相关支付引用
* 在付款期间维持具有 TTL 的 Capacity Hold
* 发布 `Cancelled`、`No Show` 等事实 Event

Pricing：

* 计算 Deposit、Cancellation Fee 与 No-show Fee
* 返回金额、Currency、退费条件与 Policy Snapshot

Payment：

* 创建 Payment Intent
* 执行 Authorization、Capture、Void 与 Refund
* 发布支付成功或失败 Event

核心规则：

* Deposit Status 与 Reservation Status 分开
* 需要 Deposit 时，支付成功且其他条件满足后 Reservation 才能进入 `Confirmed`
* 支付失败不立即删除 Reservation；可以在 Capacity Hold 有效期内重试
* Capacity Hold 到期仍未满足条件时，Reservation 进入 `Expired`
* `Cancelled` 或 `No Show` 不直接等于扣费或退款
* Pricing 根据确认时保存的 Policy Snapshot 计算结果，再由 Payment 执行
* Reservation Domain 不直接收款、扣款或退款
* 已确认的费用 Policy 后续修改不得追溯改变现有 Reservation

### 32.9 Reservation Revision

Reservation 修改与改期保留同一个 Reservation ID，并通过追加式 Reservation Revision 记录变更。

普通修改：

* 联系人姓名
* 联系方式
* Special Request
* 非关键备注

关键修改：

* 日期或开始时间
* Party Size
* Expected Duration
* Dining Area / Capacity Pool
* 影响 Deposit 或取消 Policy 的内容

关键修改规则：

* 先为新条件创建临时 Capacity Hold
* 重新验证容量、Policy 与 Deposit Requirement
* 新条件确认成功后才释放原来的容量
* 如果新条件失败，原 Reservation 保持不变
* 需要补交金额或接受新 Policy 时，先进入 `Pending`，待顾客重新确认

其他规则：

* 每次 Revision 保存修改前后内容、原因、Actor 与时间
* 不覆盖原始 Reservation 事实
* 使用 Aggregate Version 防止员工与顾客同时修改造成冲突
* `Checked In` 后只允许具备权限的员工修改关键内容
* `Seated` 后不允许修改 Reservation；后续由 Dining Session 管理

### 32.10 Dining Seating Handoff

由 Dining 执行唯一的 `Seat Party` Action。

流程：

1. Reservation 处于 `Checked In`，或 Waitlist Entry 处于 `Ready`
2. 员工在 Dining 选择实际 Table
3. Dining 验证桌台可用性、Party Size 与并桌规则
4. Dining 原子创建 Dining Session 与 Table Assignment
5. Dining 发布 `PartySeated`
6. Reservation 或 Waitlist 消费 Event 后进入 `Seated`

`Seat Party` 请求必须包含：

* 唯一 Seating Request ID
* Source Type：Reservation 或 Waitlist
* Source ID
* Party 信息快照
* Table ID / Table Group
* 执行员工

核心规则：

* Reservation & Waiting 不得在 Dining 成功前自行标记 `Seated`
* 同一个 Reservation 或 Waitlist Entry 最多关联一个 Dining Session
* 重复请求必须返回第一次成功结果，不能创建多个 Dining Session
* Dining 验证失败时，原 Entry 保持原状态
* 实际 Table Assignment 与 Dining Session 始终由 Dining 负责
* 成功后保存 Dining Session ID，形成可追踪的跨 Domain 关联

### 32.11 Domain Events

第一版最小 Domain Event 集合：

Reservation：

* `ReservationPending`
* `ReservationConfirmed`
* `ReservationModified`
* `ReservationCheckedIn`
* `ReservationCancelled`
* `ReservationMarkedNoShow`
* `ReservationExpired`
* `ReservationSeated`

Capacity Hold：

* `CapacityHoldCreated`
* `CapacityHoldReleased`
* `CapacityHoldExpired`

Waitlist：

* `WaitlistEntryJoined`
* `WaitlistEntryCheckedIn`
* `WaitlistEntryCalled`
* `WaitlistEntryReady`
* `WaitlistEntryMissed`
* `WaitlistEntryRestored`
* `WaitlistEntryCancelled`
* `WaitlistEntryExpired`
* `WaitlistEntrySeated`
* `EstimatedWaitChanged`

核心规则：

* Event 只描述已经发生的事实
* Event 必须包含 Event ID、Version、Brand ID、Store ID、Aggregate ID 与发生时间
* 消费者必须幂等处理
* `ReservationSeated` 与 `WaitlistEntrySeated` 基于 Dining 的 `PartySeated` Event 生成
* Notification、Payment、Pricing、Dining、BI 与 Task 通过订阅 Event 协作
* Notification 发送失败不得回滚 Reservation 或 Waitlist 的业务状态

### 32.12 v0.1 阶段状态

Reservation & Waiting Domain v0.1 已阶段性完成并 Freeze。

Freeze 表示：

* 核心职责边界与结构暂不继续细化
* 具体表单字段、通知文案与排队页面等留到实现阶段
* 未来可以受控增加指定 Table、活动 Reservation 与机器学习 ETA
* 后续讨论不重新展开已经确认的内容

---

## 33. Customer & Loyalty Domain

### 33.1 职责边界

Customer & Loyalty 负责：

* Brand-specific Customer Profile
* 顾客与 Brand 的会员关系
* Loyalty Enrollment 与会员状态
* Loyalty Tier
* Points Ledger、余额、过期与受控调整
* Reward、Benefit 与 Customer Entitlement
* 顾客偏好、服务备注与 Brand 内标签
* 根据 Order、Payment、Refund 等事实计算积分获得、撤销或调整
* 向 Pricing / Ordering 提供可用权益与兑换结果

Customer & Loyalty 不负责：

* 登录、Authentication Identity 与全平台 User Identity；这些属于 Identity
* Order、Reservation、Payment 与 Refund 的业务事实
* Promotion、Coupon、价格与 Tax 计算
* Gift Card 等具有货币价值的 Stored Value
* Email、SMS、Push 或微信的实际发送
* BI 报表、营销活动与广告 Campaign

核心边界：

**Customer & Loyalty 管理 Brand 与顾客之间的关系及非现金忠诚度价值；交易 Domain 继续拥有 Order、Payment 与 Refund 事实。**

### 33.2 Customer Profile 与 Loyalty Account Aggregate

Customer Profile 与 Loyalty Account 是两个独立 Aggregate Root。

Customer Profile Aggregate 包含：

* Brand-specific Customer ID
* 可选的全平台 User ID 引用
* 顾客姓名与 Brand 内显示资料
* Preferences
* Service Notes
* Tags
* Customer Relationship Status

Loyalty Account Aggregate 包含：

* Loyalty Account ID
* Customer Profile ID
* Loyalty Program ID
* Enrollment Status
* Tier
* Points Balance Projection
* Reward / Entitlement 引用

核心规则：

* Customer Profile 可以存在，但顾客不一定加入 Loyalty Program
* 顾客加入 Loyalty 后才创建 Loyalty Account
* Profile 修改与 Points Transaction 不需要锁定同一个 Aggregate
* Customer Profile 不保存登录密码或 Authentication Identity
* Loyalty Account 不复制 Customer Profile 资料
* 同一 Customer Profile 可以参加不同 Loyalty Program，但每个 Program 最多拥有一个有效 Loyalty Account

### 33.3 Guest 与 Customer Profile

Guest Order 或 Reservation 默认不自动创建长期 Customer Profile。

创建 Customer Profile 的条件：

* 顾客主动注册或登录
* 顾客加入 Loyalty Program
* 顾客明确同意 Brand 保存其资料
* 具备权限的员工因明确业务需要创建，并记录来源与依据

Guest Transaction：

* Order / Reservation 保存当时的 Guest Contact Snapshot
* 保存 Guest Session / Participant 等交易身份
* 不因为填写手机号或 Email 就自动建立会员档案
* 不根据相同手机号或 Email 自动合并顾客

后续关联规则：

* 顾客完成身份或联系方式验证后，可以把 Customer Profile 关联到 User ID
* 原 Order、Reservation 与 Audit Actor 不被改写
* 需要补记历史积分时创建独立 Points Transaction，不修改历史 Order
* 重复 Customer Profile 通过受控 Merge 处理，保留原 Profile ID 与完整审计
* Profile Merge 只在同一 Brand 范围内进行

### 33.4 Loyalty Program Aggregate

Loyalty Program 是独立、Brand-scoped Aggregate Root，并采用完整版本化配置。

Loyalty Program 保存稳定身份：

* Loyalty Program ID
* Brand ID
* Program Code
* Lifecycle
* Created At / By

Loyalty Program Version 保存：

* Program Name
* Points 名称与显示方式
* Enrollment Eligibility
* Earning Rule
* Redemption Rule
* Expiration Policy
* Tier Definition
* Store / Channel / Order Type Scope
* Effective Period

核心规则：

* 配置变化创建新的 Program Version，不覆盖旧版本
* 已发布版本后续变化不得追溯改变历史 Points Transaction
* 每笔积分获得、撤销、兑换与过期都保存 Program Version 与 Rule Version
* 同一业务上下文只能解析出一个有效 Program Version
* Loyalty 决定积分与权益；涉及 Order 金额折扣时，由 Pricing 计算最终金额
* 第一版允许一个 Brand 配置多个 Loyalty Program，但同一 Customer Profile 在每个 Program 最多一个有效 Account

### 33.5 Points Ledger

Points 采用追加式 Ledger，余额只是投影结果。

每笔 Points Transaction 独立保存：

* Points Transaction ID
* Loyalty Account ID
* Transaction Type
* Points Amount
* Source Type / Source ID
* Program Version / Rule Version
* Occurred At / Effective At
* Expiry Date
* Idempotency Key
* 原 Transaction Reference
* Actor 与 Reason

第一版 Transaction Type：

* `Earn`
* `Activate`
* `Reserve`
* `Release`
* `Redeem`
* `Reverse`
* `Adjust`
* `Expire`

余额投影：

* `Pending Points`
* `Available Points`
* `Reserved Points`
* `Lifetime Earned Points`

核心规则：

* 不直接覆盖 Points Balance
* 错误通过 `Reverse` 或 `Adjust` 更正
* Checkout 兑换时先 `Reserve`，成功后 `Redeem`，取消或超时后 `Release`
* 同一个 Order / Payment Event 重复到达时不得重复记积分
* Points Transaction 不允许修改或物理删除
* Loyalty Account 不保存无限增长的 Transaction 数组，只保存余额投影与必要摘要

### 33.6 Points Earning 与 Activation

积分默认采用 `Earn → Pending Points` 与 `Activate → Available Points` 两阶段。

创建 Earn 的条件：

* Order 已关联有效 Loyalty Account
* Payment 已 `Captured`
* Pricing 提供 Eligible Spend Snapshot
* 同一 Order / Loyalty Account 尚未重复 Earn

Activate 的条件：

* Order 已 `Fulfilled`
* 没有阻止积分生效的取消、拒单或关键异常
* 已经过 Program 配置的 Activation Delay；可以为 0

核心规则：

* Payment Authorization 不产生积分
* Payment 失败、Void 或未完成的 Order 不产生可用积分
* Eligible Spend 由 Pricing 根据确认时的 Loyalty Rule 计算
* Tax、Tip、Gift Card Purchase、Service Charge 等是否计分由 Program Rule 明确配置
* Order 取消或退款时通过 `Reverse` Transaction 处理，不删除原 Earn
* Program 可以配置立即 Activate，但默认仍要求 `Captured + Fulfilled`
* 每次 Earn 与 Activate 都保存 Order、Payment、Program Version 与 Rule Version 引用

### 33.7 Points Redemption

Points Redemption 使用具有 TTL 的 Points Reservation，防止并发重复兑换。

流程：

1. 顾客选择兑换 Points / Reward
2. Loyalty 验证 Available Points、Account Status 与 Redemption Rule
3. 创建 Points Reservation，并将对应 Points 从 `Available` 转为 `Reserved`
4. Pricing 根据 Reservation 计算 Discount / Benefit
5. Price Quote 保存 Points Reservation ID 与 Rule Version
6. Order 成功创建并接受该 Price Quote 后执行 `Redeem`
7. Checkout 取消、失败或超时后执行 `Release`

核心规则：

* 只有 Available Points 可以 Reserve
* 同一 Points 不能被多个 Cart 或 Checkout 同时使用
* Points Reservation 必须包含唯一 Redemption Request ID、目标 Cart / Order、数量与 Expiry
* Price Quote 重新计算导致兑换结果变化时，必须重新确认并调整 Reservation
* Points 在第一版作为 Loyalty Discount / Benefit，不作为 Payment Tender
* Payment 只处理折扣后的剩余应付金额
* Order 后续取消或退款时，通过新的 `Reverse` / `Adjust` Transaction 返还或扣回积分
* Ledger 与余额更新必须原子完成，默认不允许 Available Points 变为负数

### 33.8 Refund / Cancellation Points Handling

退款或取消后分别处理本次 Order 赚取的 Points 与本次 Order 兑换的 Points。

扣回 Earned Points：

* Pricing 根据退款项目重新计算 Eligible Spend Reduction
* Loyalty 按原 Earning Rule 计算需要扣回的 Points
* 尚未 Activate 的 Pending Points 通过 `Reverse` 抵销
* 已 Activate 的 Points 从 Available Balance 扣回
* 如果 Points 已被使用且 Available 不足，不静默忽略，创建 `Points Debt`
* 后续 Earned Points 优先偿还 Points Debt，再进入 Available

返还 Redeemed Points：

* 根据确认时保存的 Refund Points Policy 判断是否返还
* 通过引用原 Redeem Transaction 的 `Reverse` 返还
* 不修改或删除原 Redeem
* 返还后的 Expiry 使用原 Policy；如原 Points 已过期，可以配置 Grace Period
* Payment 只退还顾客实际支付的金额，不把 Points 当作现金退款

核心规则：

* Refund Event 按 Refund Transaction ID 幂等处理
* Partial Refund 按 Pricing 提供的金额与项目分摊结果计算
* Points Debt 与 Available Points 分开显示
* 不因退款改写历史 Order、Earn 或 Redeem 事实
* 所有扣回、返还与 Debt 必须保存原始 Order、Payment、Refund 及 Rule Version 引用

### 33.9 Points Expiration

Points 按每笔 Earn 批次分别到期，不只为总余额设置一个 Expiry Date。

核心规则：

* 每笔 Earn 保存独立 Expiry Date 与 Expiration Policy Version
* 兑换时默认优先使用最早到期的 Available Points
* 到期时创建新的 `Expire` Transaction，不修改原 Earn
* Expire Job 使用 Earn Transaction ID 保证幂等
* 已 Reserved 的 Points 在 Points Reservation TTL 内暂不 Expire
* Points Reservation 释放时，如果原 Expiry 已经过期，立即创建 `Expire` Transaction
* Program Policy 后续改变不追溯修改已有 Points 的 Expiry
* 到期前由 Notification 发送提醒
* Manager 延长有效期必须通过受权限控制的 `Adjust Expiry` Action，并记录原因与 Audit
* Points Debt 不会因时间自动过期

### 33.10 Loyalty Tier

Tier 与 Points Balance 分开计算，由 Loyalty Program Version 定义 Qualification Metric。

可以使用：

* Eligible Spend
* Qualified Order Count
* Qualified Visit Count
* Lifetime Earned Points
* 指定活动或任务完成情况

Program 必须配置：

* 每个 Tier 的 Threshold
* Evaluation Window，例如 Rolling 12 Months 或 Membership Year
* Upgrade Timing
* Downgrade Review Date
* Grace Period
* Tier Benefit

核心规则：

* 默认达到门槛后立即 Upgrade
* Downgrade 默认只在固定 Review Date 执行，不因单次退款立即降级
* Refund / Cancellation 会调整 Qualification Progress
* Tier History 采用追加式记录，保存原 Tier、新 Tier、Rule Version、原因与生效时间
* Points Balance 不自动等于 Tier Progress，除非 Program 明确配置
* Manager Override 必须设置原因、Effective Period 与审批
* Tier Benefit 由 Loyalty 提供；涉及金额优惠时仍由 Pricing 计算
* Program Rule 改变不追溯改写历史 Tier 事实

### 33.11 Reward / Entitlement

Reward Definition 属于 Loyalty Program Version，定义：

* Reward Type
* Eligibility Rule
* Benefit Reference
* Points Cost（如适用）
* Validity Rule
* Usage Limit
* Stackability Reference

Customer Entitlement 是独立 Aggregate Root，表示某位顾客实际获得的一份权益，包含：

* Entitlement ID
* Loyalty Account ID
* Reward Definition / Version ID
* Granted Source
* Effective Period
* Remaining Usage
* Status

第一版状态：

* `Pending`
* `Available`
* `Reserved`
* `Redeemed`
* `Expired`
* `Revoked`

核心规则：

* 离散发放的一次性 Reward 创建 Customer Entitlement
* Tier 长期 Benefit 可以动态解析，不必为每位顾客复制大量 Entitlement
* Checkout 使用 Entitlement 时先进入 `Reserved`，成功后进入 `Redeemed`，失败或超时后释放
* Entitlement 只表示使用资格；具体折扣金额仍由 Pricing 计算
* Coupon Code 属于 Pricing，Entitlement 可以引用对应 Promotion / Benefit Rule
* Reward 默认不可转让、不可兑换现金
* `Revoked`、`Expired` 与 `Redeemed` 都保留完整历史，不物理删除

### 33.12 Split Payment Points Attribution

多人堂食与 Split Payment 按每个付款人的 Payment Allocation 分配 Points，不默认全部归属于 Order Host。

核心规则：

* 每个成功的 Payment Allocation 可以关联一个 Loyalty Account
* Pricing 根据该付款人实际承担的商品、折扣、Service Charge 与 Tax 分摊计算 Eligible Spend
* Loyalty 只为该 Payment Allocation 关联的 Account 创建 Earn
* 同一笔 Eligible Spend 不能同时计入多个 Loyalty Account
* `Pay by Item` 按所选 Item 归属
* `Equal Split` 或 `Custom Amount` 按 Pricing 提供的 Allocation 结果归属
* Order Host 不因 Host 身份自动获得其他付款人的 Points
* 未关联 Loyalty Account 的付款默认不产生会员积分
* Program 可以允许在 Claim Window 内凭 Receipt 与验证信息补记，但通过独立 Points Transaction 完成
* 多个付款人可以分别使用自己的 Points / Entitlement，只能抵扣各自的 Payment Allocation
* Tip 不计入任何付款人的 Eligible Spend，除非未来法律与 Program Rule 明确允许

### 33.13 Consent 与 Contact Preference

Contact Preference 与 Consent Record 严格分开。

Contact Preference 表示顾客希望如何联系，包括：

* Preferred Language
* Preferred Channel
* Quiet Hours
* Frequency Preference
* Store / Brand Preference

Consent Record 表示是否具备特定用途的联系授权，包括：

* Purpose，例如 Marketing、Loyalty、Personalization
* Channel，例如 Email、SMS、Push、微信
* `Granted` 或 `Withdrawn`
* Contact Method Reference
* Policy Version
* Jurisdiction
* Source
* Actor
* Recorded At
* Evidence Reference

核心规则：

* Consent Record 采用追加式记录，不直接覆盖历史
* 加入 Loyalty Program 不自动等于同意 Marketing
* 顾客撤回 Consent 后立即阻止新的相关 Marketing 发送
* Notification 在实际发送前必须检查最新 Consent 与 Preference
* Identity 保存真实 Email / Phone；Customer Profile 只保存引用与 Brand-specific Preference
* Order、Reservation、Payment Result 等必要运营通知与 Marketing Consent 分开判断
* 具体保留期限与删除要求由未来 Compliance Domain 提供 Policy
* Consent 变化必须发布 Event，供 Notification 与 Audit 使用

### 33.14 Loyalty Account Lifecycle

第一版状态：

* `Pending`：等待 Enrollment 验证或接受 Program Terms
* `Active`：可以 Earn、Redeem 与获得 Entitlement
* `Suspended`：因风险、争议或 Policy 临时暂停
* `Closed`：顾客退出或 Brand 终止会员关系

核心规则：

* `Pending` 不允许 Redeem，是否补记期间消费由 Program Policy 决定
* `Suspended` 默认阻止新的 Earn、Reserve、Redeem 与 Reward Grant
* Suspension 不删除已有 Points、Tier、Entitlement 或历史记录
* 已存在的 Points Reservation 在 Suspension 后释放或生成 Review Task
* Points Expiration 默认继续执行；只有明确的 Legal / Investigation Hold 才暂停
* `Closed` 前必须处理 Reserved Points、未完成 Redemption 与 Pending Adjustment
* Closing 不物理删除 Loyalty Account 或 Points Ledger
* Account 可以经过重新验证与审批恢复为 `Active`
* 恢复不自动返还已经合法 Expire 或 Forfeit 的 Points
* Points Debt 在 Suspension、Closing 与恢复后继续保留

### 33.15 Domain Events

第一版最小 Domain Event 集合：

Customer Profile：

* `CustomerProfileCreated`
* `CustomerProfileLinkedToUser`
* `CustomerProfilesMerged`
* `CustomerConsentChanged`

Loyalty Account：

* `LoyaltyAccountEnrolled`
* `LoyaltyAccountActivated`
* `LoyaltyAccountSuspended`
* `LoyaltyAccountClosed`

Points：

* `PointsEarned`
* `PointsActivated`
* `PointsReserved`
* `PointsReservationReleased`
* `PointsRedeemed`
* `PointsReversed`
* `PointsExpired`
* `PointsDebtCreated`
* `PointsDebtSettled`

Tier / Entitlement：

* `LoyaltyTierChanged`
* `EntitlementGranted`
* `EntitlementReserved`
* `EntitlementRedeemed`
* `EntitlementExpired`
* `EntitlementRevoked`

核心规则：

* Event 只描述已经发生的事实
* 必须包含 Event ID、Version、Brand ID、Customer / Loyalty Account ID 与发生时间
* Points Event 必须包含 Points Transaction ID、Program Version、Rule Version 与 Source Reference
* 消费者必须幂等处理
* Pricing、Ordering、Payment、Notification、BI 与 Audit 通过订阅协作
* 非关键订阅者失败不得回滚 Points Ledger 或 Loyalty Account 状态

### 33.16 v0.1 阶段状态

Customer & Loyalty Domain v0.1 已阶段性完成并 Freeze。

Freeze 表示：

* 核心职责边界与结构暂不继续细化
* 具体页面、营销功能与高级 Points 玩法留到实现或后续版本
* 未来发现跨 Domain 冲突时仍可受控修订
* 后续讨论不重新展开已经确认的内容

---

## 34. Delivery & Fulfillment Domain

### 34.1 职责边界

Delivery & Fulfillment 负责 Pickup 与 Delivery 的履约执行：

* Delivery Address 验证
* Service Area、距离与 Delivery Eligibility
* Pickup / Delivery Time Window
* Delivery Fee 与 ETA 的计算输入
* Fulfillment Task
* Driver / Courier / Third-party Provider Assignment
* Dispatch、Pickup from Store、En Route 与 Delivered
* 顾客到店取餐验证与 Handoff
* Delivery Tracking
* Proof of Delivery
* Delivery Failed、无法联系与重新派送
* 向 Ordering 发布履约进度与完成结果

Delivery & Fulfillment 不负责：

* Order 是否接受、取消或关闭；这些属于 Ordering
* Kitchen 制作与 Ready 判断
* Delivery Fee、Promotion 与 Tax 的最终金额计算；这些属于 Pricing
* 实际收款、退款与 Driver Payout
* Table Service 与 Dine-in Serving
* SMS、Push 或微信的实际发送
* 地图供应商与第三方配送平台的底层连接细节；由 Adapter 隔离

核心边界：

**Delivery & Fulfillment 管理商品 Ready 之后如何交给 Pickup / Delivery 顾客；Ordering 继续拥有商业订单生命周期。**

### 34.2 Fulfillment Aggregate Root

Pickup 与 Delivery 共用一个 `Fulfillment Aggregate Root`，不分别建立两个顶层 Aggregate。

通过 `Fulfillment Type` 区分：

* `Pickup`
* `Delivery`

核心规则：

* 两种履约方式共享准备、交接、完成与失败等核心履约概念
* Pickup 与 Delivery 的专属数据可以根据 `Fulfillment Type` 分别扩展
* Dine-in 不进入 Fulfillment Aggregate，由 Dining Domain 管理
* Driver、Route 等 Delivery 专属结构是否拆为独立 Aggregate，后续单独讨论

### 34.3 Order 与 Fulfillment 的数量关系

第一版中，Pickup / Delivery Order 与 Fulfillment Aggregate 采用一对一关系：

* 每个 Pickup 或 Delivery Order 对应一个 Fulfillment Aggregate
* 每个 Fulfillment Aggregate 只属于一个 Order
* Dine-in Order 不创建 Fulfillment Aggregate
* 配送重试或更换配送员仍属于原 Fulfillment，不因此创建多个 Fulfillment Aggregate

### 34.4 Delivery Task Aggregate Root

Delivery 专属的配送执行拆分为独立的 `Delivery Task Aggregate Root`。

职责划分：

* Fulfillment Aggregate 管理对顾客的履约承诺与最终交接结果
* Delivery Task Aggregate 管理派单、配送员或第三方平台分配、取货、运输和配送尝试
* Delivery Task 通过 Fulfillment ID 关联原 Fulfillment
* 更换配送员不创建新的 Delivery Task，而是在同一任务中保留 Assignment History
* Pickup 不创建 Delivery Task

拆分后，高频定位、派单和第三方 Provider 回调不需要持续锁定 Fulfillment Aggregate。

### 34.5 Pickup Handoff Record

Pickup Handoff 不拆分为独立 Aggregate，而是作为 Fulfillment Aggregate 内部的 `Handoff Record`。

Handoff Record 记录：

* 取餐验证方式
* 实际交接对象
* 执行交接的员工
* 交接时间
* 必要的交接凭证

核心规则：

* 执行 `Complete Pickup Handoff` 时，原子写入 Handoff Record 并完成 Fulfillment
* Handoff Record 不能脱离 Fulfillment 独立存在
* Pickup 不建立单独的 `Pickup Task Aggregate Root`

至此，Fulfillment Aggregate 的第一版划分已阶段性确认。

### 34.6 Canonical Fulfillment Phase

第一版统一使用以下 Canonical Fulfillment Phase：

* `Pending`：Fulfillment 已创建，仍在等待必要条件
* `Planned`：履约方式、时间等已经确定，等待商品完成
* `Ready`：商品已经可以取走或交给配送员
* `In Progress`：正在执行交接或配送
* `Completed`：已经成功交给顾客
* `Failed`：最终无法完成履约
* `Cancelled`：完成交接前被取消

核心规则：

* Pickup 可以从 `Ready` 直接进入 `Completed`
* Delivery 通常经过 `In Progress`
* Brand 自定义状态必须映射到 Canonical Fulfillment Phase
* 不同 Fulfillment Type 可以跳过不适用阶段，但不能配置非法转换

### 34.7 Fulfillment Failed 判定

`Failed` 只表示最终履约失败，不用于表示暂时异常。

核心规则：

* 单次派单失败、配送员拒单、更换配送员或一次配送尝试失败，不直接把 Fulfillment 改为 `Failed`
* 暂时失败与重试过程记录在 Delivery Task 中，Fulfillment 保持 `Ready` 或 `In Progress`
* 只有允许的重试、重新派单和其他交接方案都已耗尽，才执行 `Mark Fulfillment Failed`
* 进入 `Failed` 必须保存失败原因、最终尝试记录、操作者或触发 Policy，以及发生时间
* 不允许第三方 Provider 的单次失败回调直接把 Fulfillment 标记为最终失败

### 34.8 Cancelled 与 Failed

`Cancelled` 与 `Failed` 表示不同的终止原因：

* `Cancelled`：在成功交接前，由人员或系统通过明确业务决定停止履约
* `Failed`：履约仍应继续，但经过允许的尝试后客观上无法完成

示例：

* 顾客取消且 Ordering 已接受取消时，Fulfillment 进入 `Cancelled`
* 无法联系顾客或地址无法进入，并在允许的重试后仍无法交付时，Fulfillment 进入 `Failed`

两种状态都必须保存 Reason、Actor 或触发 Policy，以及发生时间。

### 34.9 Fulfillment Cancellation Collaboration

Fulfillment 不能脱离 Order 独立决定商业取消。

核心规则：

* 商业 Order 是否取消由 Ordering Domain 决定
* 顾客或员工要求停止履约时，先向 Ordering 发起取消请求
* Ordering 确认取消并发布 `OrderCancelled` 后，Fulfillment 才停止相关履约工作并进入 `Cancelled`
* Fulfillment 最终失败时发布 `FulfillmentFailed`，但不能自行取消 Order
* 已经 `Completed` 的 Fulfillment 不因迟到的 `OrderCancelled` Event 改为 `Cancelled`
* 已完成后收到冲突的取消 Event 时生成异常任务，并保留双方原始事实

### 34.10 Fulfillment Completed 判定

Fulfillment 只有在商品已经实际交给顾客后才能进入 `Completed`。

Pickup：

* 成功执行 `Complete Pickup Handoff`
* 原子写入有效的 Handoff Record

Delivery：

* Delivery Task 返回成功交付结果
* 满足 Store 配置的 Proof of Delivery 要求

共同规则：

* 所有属于本次 Fulfillment 的商品都必须已有最终交接结果
* Kitchen `Ready`、配送员接单、从门店取货或到达地址，都不等于 Fulfillment `Completed`
* 完成后发布 `FulfillmentCompleted`
* Ordering 消费该 Event 后，根据自己的 Workflow 决定 Order 的后续状态

### 34.11 Fulfillment Item 与部分交接

Fulfillment Aggregate 内建立 `Fulfillment Item` Entity，用于按 Order Item 跟踪履约与部分交接。

每个 Fulfillment Item 至少保存：

* Fulfillment Item ID
* Order Item ID
* 应交数量
* 已交数量
* 最终交接结果

核心规则：

* Fulfillment Item 引用 Ordering 中的 Order Item，不复制商品价格或 Catalog 定义
* 商业交易快照继续由 Ordering 保存
* 部分商品已经交付时，Fulfillment 保持 `In Progress`
* 只有全部 Fulfillment Item 都已有最终结果后，Fulfillment 才能进入 `Completed`、`Failed` 或其他终止状态
* 漏餐、部分取餐和部分配送必须保留 Item 级事实，不能只修改 Fulfillment 总体状态

### 34.12 Fulfillment Item 状态

第一版 Fulfillment Item 状态：

* `Pending`：尚未可以交接
* `Ready`：已经可以交接
* `In Progress`：正在取餐或配送
* `Partially Handed Over`：只交付了部分数量
* `Handed Over`：全部成功交付，属于最终成功状态
* `Not Handed Over`：最终未能交付，必须填写原因
* `Cancelled`：对应 Order Item 已经通过 Ordering 正式取消

具体数量分别保存，Fulfillment Item 状态只是当前进度与结果摘要。

### 34.13 Fulfillment Item 状态汇总

Fulfillment Aggregate 在后端统一计算并验证总体阶段，前端不能直接指定汇总结果。

第一版汇总规则：

* 所有未取消 Fulfillment Item 都是 `Ready` 时，Fulfillment 可以进入 `Ready`
* 任一 Item 已经开始交接、部分交接或已经交接，但仍有 Item 未完成时，Fulfillment 进入或保持 `In Progress`
* 所有未取消 Item 都是 `Handed Over` 时，Fulfillment 进入 `Completed`
* 存在 `Not Handed Over`，且已经没有允许的补救或重试时，Fulfillment 进入 `Failed`
* 全部 Item 因 Ordering 确认取消而成为 `Cancelled` 时，Fulfillment 才进入 `Cancelled`
* 已由 Ordering 正式取消的 Item 不再阻止其余 Item 完成履约

### 34.14 Fulfillment Item Ready 来源

Fulfillment Item 的 `Ready` 来源按商品类型区分。

需要 Kitchen 制作的商品：

* 以 Kitchen 发布的 Item Ready Event 为事实来源
* Fulfillment 不自行推测厨房商品已经完成

无需 Kitchen 制作的现成商品：

* 由 Fulfillment 中具备权限的员工执行 `Mark Item Ready`
* 也可以由明确配置的自动规则触发

其他边界：

* Ordering 只提供 Order Item 引用和变更事实，不判断商品是否已经准备好
* Inventory 有库存不等于商品已经完成拣货、包装并可以交接
* Ready Event 与 Action 必须幂等处理，避免重复更新数量或状态

### 34.15 Fulfillment Aggregate 创建时点

Cart 阶段不创建 Fulfillment Aggregate，只进行地址、配送范围与时间窗口等临时验证。

Pickup / Delivery 正式 Order 创建后：

* Ordering 发布 Order 创建事实 Event
* Fulfillment 幂等创建一个初始为 `Pending` 的 Fulfillment Aggregate
* 不等待付款成功、商家接单或 Kitchen 开始制作才创建
* 使用 Order ID 唯一约束，保证重复 Event 不会创建多个 Fulfillment
* 后续满足付款、接单和履约计划条件后，再从 `Pending` 进入 `Planned`

Fulfillment 创建失败时通过 Event 重试与异常任务处理，不重复创建 Order。

### 34.16 Pending → Planned

Fulfillment 从 `Pending` 进入 `Planned` 必须同时满足：

* Ordering 已接受 Order，并根据 Store 付款策略确认可以进入履约
* Ordering 发布 `OrderFulfillmentAuthorized`
* Pickup 已有有效的 Store、取餐时间或窗口及取餐人信息
* Delivery 已有验证通过的地址、配送范围、时间窗口及联系人信息
* Order 尚未取消
* 不存在阻止履约的关键异常

进入 `Planned` 不要求：

* Kitchen 商品已经完成
* 配送员已经分配
* 第三方配送平台已经接单

必要信息缺失时保持 `Pending`，并生成处理任务。

### 34.17 Fulfillment Snapshot

Fulfillment 同时保存稳定引用与履约时使用的 Operational Snapshot。

Delivery Snapshot 包括：

* 标准化配送地址
* 经纬度
* 门禁与配送说明
* 联系人及联系方式
* 配送时间窗口

Pickup Snapshot 包括：

* Store ID
* 取餐地点信息
* 取餐人及联系方式
* 取餐时间窗口

核心规则：

* 同时保留 Customer、Address 或 Store 的稳定引用
* Fulfillment 进入 `Planned` 时固定当前 Snapshot
* Customer Profile、地址簿或 Store Profile 后续修改，不自动改变已经建立的 Fulfillment
* 后续确需修改时必须通过受控 Fulfillment Revision，不能直接覆盖原 Snapshot

### 34.18 Fulfillment Revision

Fulfillment 修改采用追加式 `Fulfillment Revision`，Fulfillment ID 保持不变。

每次 Revision 保存：

* 修改前内容
* 修改后内容
* 修改原因
* 操作者
* 修改时间
* Revision Version

核心规则：

* 地址、联系人、时间窗口或交接说明变化时创建新 Revision
* 原始 Snapshot 与历史 Revision 不覆盖、不删除
* 只有验证成功并被接受的 Revision 才成为当前执行版本
* Revision 失败时，原 Fulfillment 继续按原有效版本执行
* 使用 Aggregate Version 防止顾客、员工和系统同时修改造成冲突

### 34.19 Fulfillment Revision 分类

Fulfillment Revision 分为普通修改与关键修改。

普通修改包括：

* 联系人姓名或电话的更正
* 不影响路线和费用的交接说明

普通修改验证通过后可以生效，并通知当前 Delivery Task。

关键修改包括：

* Delivery Address 或经纬度
* Pickup Store
* Pickup / Delivery Time Window
* 取餐或交付验证方式

关键修改必须重新检查：

* 配送范围
* Delivery Fee 与 Tax 影响
* ETA 与 Store 能力
* 当前 Delivery Task 与 Provider Assignment

全部检查通过后 Revision 才能生效；失败时继续使用原版本。

`Fulfillment Type` 不能通过 Fulfillment Revision 修改，必须由 Ordering 执行 Change Order Type。

### 34.20 Fulfillment Revision 阶段限制

不同 Fulfillment Phase 允许的 Revision：

* `Pending` / `Planned`：允许普通修改与关键修改；关键修改必须重新验证
* `Ready`：允许普通修改；关键修改先暂停交接，验证成功后通常返回 `Planned`
* `In Progress`：默认只允许普通修改
* `Completed` / `Failed` / `Cancelled`：不允许新的 Operational Revision

`In Progress` 后修改地址、Pickup Store 或时间窗口等关键内容时：

* 必须由具备权限的 Manager 授权
* 必须获得当前 Delivery Task 与 Provider 接受
* 任一必要检查失败时拒绝 Revision，并继续使用原有效版本

终止状态发现错误时，只能创建 Correction Record、补偿任务或新 Order，不覆盖原 Fulfillment 事实。

### 34.21 Revision 费用变化协作

关键 Fulfillment Revision 导致费用变化时：

* Fulfillment 不直接修改 Delivery Fee、Tax 或 Order Total
* Fulfillment 将新地址、时间窗口等计算输入交给 Pricing 重新计算
* Ordering 根据新的 Price Quote 创建 Order Amendment
* 金额增加时，顾客确认并满足追加付款条件后，Revision 才能生效
* 金额减少时，Ordering 记录金额调整，退款或余额处理由 Payment 执行
* 重新计价、顾客确认和必要付款完成前，原 Fulfillment Revision 继续有效
* 任一步失败时，新 Revision 作废，不改变原履约计划

至此，Fulfillment Revision 的第一版核心结构已阶段性确认。

### 34.22 Address Validation 与 Service Area Eligibility

Delivery Address Validation 与 Service Area Eligibility 分开处理并分别保存结果。

Address Validation 负责：

* 检查地址是否完整
* 标准化地址
* 判断能否准确定位
* 产生经纬度与验证可信度

Service Area Eligibility 负责：

* 判断指定 Store 在当前时间与规则下是否可以配送到该位置
* 返回适用的 Service Area Rule Version 与不符合原因

核心规则：

* 地址真实有效不等于位于配送范围内
* 位置看似位于配送范围，但地址无法准确定位时也不能视为可配送
* 两项分别保存 Result、Rule / Provider Version 与失败原因
* 两项都通过后，Delivery Fulfillment 才能进入 `Planned`

### 34.23 Address Validation 结果状态

第一版 Address Validation 状态：

* `Pending`：尚未完成验证
* `Validated`：地址已经标准化并可以可靠定位
* `Needs Confirmation`：存在多个候选、缺少单元号或定位可信度不足，需要顾客或员工确认
* `Invalid`：地址不完整、无法识别或无法可靠定位

核心规则：

* 地图或地址服务暂时不可用时，不把地址标记为 `Invalid`
* 技术故障时保持 `Pending`，记录错误并自动重试
* 只有 `Validated` 的地址才能继续进行 Service Area Eligibility 检查
* 每次验证保存原始输入、标准化结果、Provider、Provider Version、可信度与验证时间

### 34.24 Needs Confirmation 处理

Address Validation 为 `Needs Confirmation` 时：

* 向顾客或员工具体显示标准化候选地址与地图位置
* 允许选择候选地址、补充单元号或调整地图定位
* 确认后必须重新执行 Address Validation
* 不能仅因顾客点击确认就直接改为 `Validated`
* 重新验证前，Fulfillment 保持 `Pending`
* 重新验证前不进行正式 Service Area Eligibility 判断或最终计价
* 所有确认、修改与重新验证结果保留 Audit

### 34.25 Manual Address Validation Override

允许受控的人工 Address Validation Override。

执行条件：

* 仅具备专门权限的员工或 Manager 可以执行
* 必须填写标准化地址、精确地图定位、Override 原因与验证依据
* 应取得顾客对最终地址与地图位置的确认

核心规则：

* 结果保存为 `Validated`，同时明确记录 Validation Method 为 `Manual Override`
* 不能把人工结果伪装成地图 Provider 自动验证成功
* Override 只解决地址定位问题，仍必须单独通过 Service Area Eligibility
* 本次 Override 不自动把 Customer 地址簿中的地址永久标记为已验证
* 保存操作者、执行时间与完整 Audit

至此，Address Validation 的第一版核心流程已阶段性确认。

### 34.26 Service Area Aggregate Root

Service Area 建立独立的 `Service Area Aggregate Root`。

Service Area 保存稳定身份：

* Service Area ID
* Brand ID
* Lifecycle
* 适用 Store Scope

Service Area Version 保存：

* 范围规则
* 优先级
* Effective Period
* Publishing Status

核心规则：

* 一个 Store 可以使用多个 Service Area
* Service Area 可以被 Fulfillment、Pricing 与 ETA 计算共同引用
* 复杂范围规则不直接塞入 Store Profile
* Fulfillment 保存实际使用的 Service Area ID 与 Version
* Service Area 后续变化不追溯改变已经建立的 Fulfillment

### 34.27 Service Area 范围规则

第一版 Service Area Version 支持：

* `Radius`：以 Store 为中心的半径范围
* `Polygon / MultiPolygon`：自定义地图配送区域
* `Postal / Administrative Area`：按邮编、区域或行政区匹配
* `Route Distance / Travel Time Limit`：根据实际路线距离或时间进一步限制
* `Exclusion Zone`：排除无法进入或不提供配送的特殊位置

核心规则：

* 每个 Service Area 使用一种主要范围规则
* 可以叠加 Route Distance、Travel Time Limit 与 Exclusion Zone
* 不允许任意组合多个主要范围规则，避免无法确定匹配语义
* 范围计算使用的地图 Provider、算法版本与计算时间必须保留

### 34.28 Service Area Resolution

多个 Service Area 同时匹配时采用确定性解析：

1. 先检查 `Exclusion Zone`；命中排除区域时默认不可配送
2. 过滤 Store Scope、Channel、Order Type 与 Effective Period
3. 在剩余匹配 Area 中选择明确 `Priority` 最高的 Service Area
4. 同一 Priority 出现多个匹配结果时视为配置冲突

核心规则：

* 不允许在多个匹配结果中随机选择
* 可预先检测的重叠冲突必须阻止发布
* 运行时发现冲突时拒绝继续下单，并生成配置处理任务
* Fulfillment 保存最终 Service Area ID、Version 与解析依据
* 不能自动选择 Delivery Fee 最低的 Area；最终费用仍由 Pricing 计算

### 34.29 Service Area Eligibility 结果状态

第一版 Service Area Eligibility 状态：

* `Pending`：尚未完成判断
* `Eligible`：符合当前 Service Area 规则
* `Ineligible`：明确不符合，并保存结构化原因
* `Indeterminate`：因地图服务异常、路线无法计算或配置冲突，暂时无法得出可靠结果

`Ineligible` Reason Code 至少包括：

* `OUTSIDE_SERVICE_AREA`
* `EXCLUDED_ZONE`
* `ROUTE_DISTANCE_EXCEEDED`
* `TRAVEL_TIME_EXCEEDED`
* `NO_ACTIVE_SERVICE_AREA`

核心规则：

* `Indeterminate` 不得当作 `Ineligible`
* `Indeterminate` 需要自动重试或生成处理任务
* 只有 `Eligible` 才能继续正式下单或使 Delivery Fulfillment 进入 `Planned`
* Eligibility Result 保存 Service Area Version、计算输入、Provider / Algorithm Version 与计算时间

### 34.30 Service Area Eligibility Override

允许针对单个 Fulfillment 执行受控 Service Area Eligibility Override，但仅限可覆盖规则。

核心规则：

* Service Area Rule 必须明确标记 `Override Allowed`
* `Exclusion Zone`、法律限制或安全限制默认属于 `Hard Block`，不能 Override
* 仅具备权限的 Manager 可以执行
* 必须保存 Override 原因、批准人、原始 `Ineligible` Result 与临时有效期
* 生效前仍需确认 Driver / Provider 能力，并由 Pricing 重新计算 Delivery Fee 与 ETA
* 顾客确认并满足追加付款条件后才能生效
* Override 只适用于当前 Fulfillment，不修改 Service Area 配置，也不适用于后续 Order
* `Indeterminate` 不能通过 Override 绕过，必须先解决技术或配置问题

### 34.31 Service Area Eligibility 有效期

Service Area Eligibility Result 具有短时有效期，并在 Order 提交前进行后端复验。

Result 保存：

* Calculated At
* Expires At
* Address Hash
* Store ID
* Delivery Time Context
* Service Area ID 与 Version

核心规则：

* Cart 中显示的可配送结果只是短时有效结果
* 提交 Order 时后端必须再次验证
* Address、Store、Delivery Time 或 Service Area Version 变化时，Result 立即失效
* Result 未过期且输入完全一致时可以复用计算，但仍需检查 Kill Switch 与当前 Store 配送能力
* 正式 Fulfillment 进入 `Planned` 后固定当时 Eligibility Result
* 普通 Service Area 修改不追溯影响已 Planned 的 Fulfillment
* 紧急安全或合规限制通过 Kill Switch 处理

至此，Service Area 的第一版核心结构已阶段性确认。

### 34.32 Fulfillment Time Window

Pickup 与 Delivery 统一使用 `Fulfillment Time Window`。

Time Window 保存：

* Window Start
* Window End
* Window Type：`ASAP` 或 `Scheduled`
* Store IANA Time Zone

核心规则：

* `ASAP` 也使用时间区间，不保存为一个模糊的单一时间点
* ASAP Window 根据 Kitchen ETA、Store Load 与 Delivery Travel Time 动态生成
* `Scheduled` 保存顾客确认的固定 Pickup 或 Delivery 区间
* 内部时间保存 UTC，显示时使用 Store IANA Time Zone
* 顾客界面可以显示相对时间或本地时间区间，但内部模型保持一致

### 34.33 Requested 与 Confirmed Time Window

Requested Time Window 与 Confirmed Time Window 分开保存。

* `Requested Time Window`：顾客希望的 Pickup 或 Delivery 时间
* `Confirmed Time Window`：系统或 Store 检查 Kitchen、容量与配送条件后实际确认的时间

核心规则：

* Requested 与 Confirmed 不能互相覆盖，必须同时保留
* Confirmed Window 明显偏离 Requested Window 时，顾客必须重新确认
* `ASAP` 的 Requested 值表示尽快，Confirmed 值保存实际预计区间
* Fulfillment 进入 `Planned` 后，以 Confirmed Time Window 作为执行依据
* Planned 后的时间调整通过 Fulfillment Revision 记录

### 34.34 Scheduled Fulfillment Capacity Hold

Scheduled Time Window 在 Checkout 期间使用具有 TTL 的 `Fulfillment Capacity Hold`。

Capacity Hold 保存：

* Hold ID
* Store ID
* Fulfillment Type
* Time Window
* Capacity Units
* Expiry
* Idempotency Key

核心规则：

* Hold 在有效期内占用该 Time Window 的可用容量
* Order 成功创建并确认该 Window 后，Hold 转换为正式 Capacity Allocation
* Cart 放弃、Payment 失败或 TTL 到期后自动释放
* 重复请求必须幂等，不能重复占用容量
* `ASAP` 第一版不建立长期 Hold，只在 Order 提交时重新检查当前容量

### 34.35 Fulfillment Capacity Hold Aggregate Root

`Fulfillment Capacity Hold` 是独立 Aggregate Root。

核心规则：

* Hold 在 Cart 阶段创建，此时 Fulfillment 尚不存在，不能放入 Fulfillment Aggregate
* 每个 Hold 拥有独立 Hold ID、TTL 与 Lifecycle
* Hold 创建时通过 Cart ID 关联临时购买意图
* 转换后再关联 Order ID 与 Fulfillment ID
* Capacity Domain Service 使用数据库原子操作检查并占用 Time Window 容量，防止并发超卖
* Hold 到期、释放或转换不锁定 Fulfillment Aggregate
* 正式 Capacity Allocation 保留原 Hold ID，形成完整追踪关系

### 34.36 Fulfillment Capacity Hold Lifecycle

第一版 Capacity Hold 状态：

* `Active`：正在占用容量，且尚未过期
* `Converted`：已经成功转换为正式 Capacity Allocation
* `Released`：Cart 变化、顾客取消或 Payment 失败后主动释放
* `Expired`：TTL 到期后自动释放

核心规则：

* Hold 创建与容量占用原子完成，因此不保存 `Pending`
* `Converted`、`Released` 与 `Expired` 都是最终状态
* 最终状态不能恢复为 `Active`
* 顾客重新选择 Time Window 时创建新 Hold，不能修改旧 Hold 的 Window
* 可以受控延长仍为 `Active` 的 TTL，但必须限制次数并记录原因

### 34.37 Fulfillment Capacity Units 计算

第一版默认使用简单容量单位：

* `1 Fulfillment = 1 Capacity Unit`

门店可以选择启用可配置的整数工作量积分，根据以下因素计算 Capacity Units：

* 商品数量
* 包装或袋数
* 大件或批量商品
* Delivery 执行复杂度

核心规则：

* Capacity Units 使用正整数工作量积分，便于原子扣减与配额计算
* Kitchen 备餐工作量不计入 Fulfillment Capacity Units；Kitchen Capacity 独立管理
* 创建 Capacity Hold 时完成计算，并保存计算输入、结果及 Rule Version
* Cart 变化导致 Capacity Units 改变时，释放旧 Hold 并创建新 Hold
* 已创建 Hold 的 Capacity Units 不允许原地修改

### 34.38 Fulfillment Capacity Pool 与扣减

第一版为每个 `Store + Fulfillment Type` 建立独立 Fulfillment Capacity Pool。

Pool 包含可配置的 Time Slot，例如 15 分钟或 30 分钟；每个 Slot 设置最大 Capacity Units。

核心规则：

* 每个 Scheduled Confirmed Time Window 必须明确映射到一个 Capacity Slot
* 可用容量 = Slot Capacity Limit − Active Hold Units − 尚未释放的 Allocation Units
* 创建 Hold 时必须使用数据库原子操作检查并扣减容量
* 可用容量不足时 Hold 创建失败，不允许超卖
* Hold 转换为 Allocation 时只改变占用类型，不再次扣减容量
* Hold 进入 `Released` 或 `Expired` 后立即归还容量
* Capacity Pool 配置按版本发布，已有 Hold 与 Allocation 保留原配置版本
* 下调 Slot 上限不会撤销已有 Hold；若当前占用超过新上限，则停止接受新的 Hold

### 34.39 Fulfillment Capacity Allocation Lifecycle

第一版 Capacity Allocation 状态：

* `Active`：由 Hold 转换而来，正式占用未来 Slot 容量
* `Consumed`：Slot 已开始，或 Fulfillment 已进入 `In Progress`，以较早发生者为准；容量视为已实际消耗
* `Released`：在消耗前因取消或改期而释放，并归还 Capacity Units

核心规则：

* Hold 进入 `Converted` 与 Allocation 进入 `Active` 必须原子完成
* `Consumed` 与 `Released` 都是最终状态
* 改期时先成功取得新 Slot 的 Hold 或 Allocation，再释放旧 Allocation
* 新时段容量获取失败时保留旧 Allocation，不得先释放旧时段
* 已 `Consumed` 的容量不因后续 `Completed`、`Failed` 或迟到取消而返还
* Allocation 保留原 Hold ID、Order ID、Fulfillment ID、Slot、Units 及 Capacity Config Version

### 34.40 Fulfillment Capacity Adjustment

第一版不允许针对单个 Order 直接绕过容量检查。容量不足时只能使用受控的临时 `Capacity Adjustment`。

核心规则：

* 只有具备专门权限的 Manager 可以创建 Capacity Adjustment
* Adjustment 必须限定 Store、Fulfillment Type 与 Capacity Slot
* 必须保存增加的 Capacity Units、原因、操作者、时间及有效期
* 增量不得超过门店配置的 `Max Adjustment Units`
* Adjustment 使用追加记录，不静默修改已发布的基础 Capacity
* Adjustment 生效后仍通过正常原子容量检查创建 Hold
* 不允许直接创建超过当前有效容量的超卖 Hold
* Emergency Stop、Store Closed 或其他 Hard Block 不能通过 Adjustment 绕过

### 34.41 Delivery Task 创建时机

Delivery Task 仅在 Delivery Fulfillment 成功进入 `Planned` 后幂等创建。

核心规则：

* Fulfillment 仍为 `Pending` 时不创建 Delivery Task
* Address Validation、Service Area Eligibility 或 Confirmed Time Window 尚未完成时不创建
* Delivery Task 创建不等待 Kitchen Ready，以支持 Scheduled Delivery 提前规划或派单
* 创建时保存 Fulfillment ID、Store、Validated Address Snapshot、Confirmed Time Window、Capacity Allocation 及 Delivery Requirements
* 同一 Fulfillment 始终只有一个 Delivery Task，重复事件不得重复创建
* Pickup Fulfillment 不创建 Delivery Task
* Fulfillment 在 Task 创建前已经取消时不再创建
* Task 创建后发生取消时，向现有 Delivery Task 传递取消指令

### 34.42 Delivery Task Canonical Execution Status

Delivery Task 的执行状态与派单状态分开建模。

第一版 Canonical Execution Status：

* `Planned`：Task 已创建，尚未到 Store 取货
* `At Store`：Delivery Worker 已到取货地点
* `Picked Up`：商品已经正式交给 Delivery Worker
* `En Route`：Delivery Worker 已离开取货地点并前往顾客地址
* `Delivered`：已经完成有效 Delivery Proof
* `Failed`：所有允许的配送与补救方案均已耗尽
* `Cancelled`：收到已经确认的 Fulfillment 取消指令

核心规则：

* Searching、Offered、Assigned、Accepted、Rejected 与 Reassignment Required 等派单状态不进入 Execution Status
* 单次派单、Provider 或 Delivery Attempt 失败不能直接使 Task 进入 `Failed`
* `Delivered` 必须由满足规则的 Delivery Proof 支持
* `Failed` 与 `Cancelled` 的语义必须与 Fulfillment Aggregate 保持一致

### 34.43 Delivery Task Assignment Status

Delivery Task 保存独立于 Execution Status 的当前 Assignment Status。

第一版 Assignment Status：

* `Unassigned`：尚未开始派单
* `Searching`：正在寻找内部 Delivery Worker 或外部 Provider
* `Offered`：任务已经发出，等待接单
* `Assigned`：已经选定 Delivery Worker 或 Provider，但尚未最终承诺
* `Accepted`：Delivery Worker 或 Provider 已确认承接
* `Reassignment Required`：原指派被拒绝、超时、取消或失效，需要重新派单

核心规则：

* 每次 Offer、Accept、Reject、Timeout 与 Release 都写入 Assignment History
* `Rejected` 与 `Timed Out` 是单次 Assignment Attempt 的结果，不作为 Task 的长期当前状态
* `Reassignment Required` 可以重新进入 `Searching`
* 单次 Assignment Attempt 失败不能使 Delivery Task 进入 `Failed`
* 只有允许的重试策略与补救方案均已耗尽后，Delivery Task 才能最终失败

### 34.44 Delivery Offer 并行限制

第一版不允许 BOP 为同一个 Delivery Task 同时保留多个 Active Offer。

核心规则：

* 每个 Delivery Task 同一时间最多只有一个 Active Offer
* 每个 Offer 必须设置 TTL
* 只有当前 Offer 被拒绝、超时或撤回后，才能创建下一个 Assignment Attempt
* 外部 Delivery Provider 可以在其内部同时寻找多个 Delivery Worker，但对 BOP 仍表现为一个 Provider Offer
* 迟到的 Accept 必须根据 Attempt ID 与 Assignment Version 拒绝，不能覆盖新的派单结果
* 所有 Offer 创建、关闭及迟到响应都必须保留 Audit
* 单 Active Offer 规则用于避免重复接单、重复取消及额外 Provider 费用

### 34.45 Delivery Offer Timeout 与 Retry Policy

每个 Store 或 Delivery Provider 使用版本化 Dispatch Policy，并在 Delivery Task 开始派单时固定所用版本。

Dispatch Policy 包含：

* Offer TTL
* 最大自动 Assignment Attempts
* Retry Interval
* Candidate Ordering
* Provider Fallback
* Dispatch Deadline

核心规则：

* Offer 超时后关闭当前 Attempt，Task 进入 `Reassignment Required`
* 后续按 Dispatch Policy 顺序创建新的 Assignment Attempt
* Provider API 的技术重试沿用同一 Attempt ID 与 Idempotency Key，不计为新的派单 Attempt
* 达到自动重试上限后建立 Dispatch Exception，转人工处理或备用配送方案
* 达到自动重试上限本身不能直接使 Task 进入 `Failed`
* 只有人工与备用方案也耗尽，或超过不可继续的 Dispatch Deadline，Task 才能最终 `Failed`
* Task 已经 `Accepted`、`Cancelled` 或商品已经 `Picked Up` 时，禁止继续自动派单

### 34.46 Dispatch Exception 归属

第一版 `Dispatch Exception` 是 Delivery Task Aggregate 内部的追加式记录，不建立独立 Aggregate Root。

Dispatch Exception 保存：

* Exception ID
* Exception Type
* Severity
* Reason
* Source
* Created At
* Handler
* Resolution

第一版状态：

* `Open`
* `Acknowledged`
* `Resolved`
* `Escalated`

核心规则：

* 每个 Dispatch Exception 只对应一个 Delivery Task
* 同一个 Task 可以保存多个历史 Exception
* 同一问题只能有一个当前 `Open` Exception
* 人工处理、备用配送及最终失败决定都必须写入 Task Audit
* 如果未来需要管理同时影响多个 Task 的 Provider 大规模故障，再单独设计 Operations Incident

### 34.47 Assignment Attempt 最小记录结构

每次派单尝试作为 Delivery Task 内部的追加式 Assignment Attempt 保存。

Assignment Attempt 至少保存：

* Attempt ID
* Sequence Number
* Target Type：`Internal Worker` 或 `External Provider`
* Target Reference
* Dispatch Mode：`Automatic` 或 `Manual`
* Dispatch Policy Version
* Assignment Version
* Offered At
* Expires At
* Responded At
* Provider Request ID
* Idempotency Key
* Estimated Pickup Time
* Estimated Delivery Time
* Provider Quote Snapshot
* Outcome
* Reason Code
* Actor 或 System Source

第一版 Outcome：

* `Pending`
* `Accepted`
* `Rejected`
* `Timed Out`
* `Withdrawn`
* `Provider Error`
* `Released`

核心规则：

* Attempt 一旦结束不得覆盖或重新打开
* 后续派单必须创建具有新 Attempt ID 与递增 Sequence Number 的记录
* Provider 技术重试仍属于同一个 Attempt
* Assignment History 必须能够还原完整的派单顺序与决定依据

### 34.48 Dispatch Route Plan

Internal Delivery Worker 与 External Provider 的选择顺序使用版本化、可配置的 `Dispatch Route Plan`，不在代码中固定。

第一版默认顺序：

1. 符合条件的 Internal Delivery Worker
2. Store 的 Preferred External Provider
3. Backup External Provider
4. Manual Dispatch

核心规则：

* Store 可以配置 `Internal First`、`Provider First` 或 `Provider Only`
* 必须先过滤 Service Area、Availability、Vehicle / Load、Delivery Requirements 与 Hard Block，再进行候选排序
* 同一层候选可以综合 ETA、Estimated Cost、Success Rate 与 Reliability Score
* 不强制只选择最低报价候选
* 当前候选 `Rejected`、`Timed Out` 或 `Provider Error` 后，才进入下一个候选或下一层
* Route Plan Version 在开始派单时固定，并写入 Assignment Attempt
* 任一候选 `Accepted` 后立即停止后续选择

### 34.49 Internal Delivery Worker 建模边界

Internal Delivery Worker 使用独立的 `Delivery Worker Profile Aggregate Root`，但不重复建立员工身份资料。

核心规则：

* Delivery Worker Profile 引用 Identity / Staff Actor ID
* Name、Login Account、Employment Relationship 与 Permission 仍由 Identity / Staff 管理
* Profile 只保存 Delivery 专属信息：Store Scope、Operational Status、Vehicle Type / Load、Service Area Capability、Concurrent Assignment Limit、Delivery Qualification 与 Expiry
* 排班与出勤只保存 Availability Reference 或 Snapshot，不在 Delivery Domain 重建完整 Scheduling System
* Profile 可以被多个 Delivery Task 引用，并具有独立生命周期
* External Provider 的临时 Courier 不创建 Internal Delivery Worker Profile
* Delivery Task 仅保存 Provider 提供的 Courier Snapshot

Open Architecture Decision：

* 通用 Workforce / Scheduling 能力未来是否抽为 BOP Platform Capability
* 第一版只通过明确 Reference 或 Snapshot 集成，不在 Delivery Domain 提前抽象

### 34.50 Delivery Worker Profile Lifecycle

第一版 Delivery Worker Profile 状态：

* `Draft`：资料尚未完整，不可参与派单
* `Active`：可以作为派单候选，但仍需实时检查 Availability 与任务要求
* `Suspended`：临时停止接收新任务
* `Inactive`：已经停止承担内部配送工作

核心规则：

* 只有 `Active` Profile 可以进入派单候选列表
* Identity Account 被停用或 Employment Relationship 失效时，Profile 立即失去派单资格
* 必要 Delivery Qualification 过期时自动进入 `Suspended`，并记录原因
* `Suspended` 或 `Inactive` 不自动取消已经 `Accepted` 或正在执行的 Delivery Task
* 已承接 Task 必须由 Manager 明确决定继续或重新派单
* 恢复为 `Active` 前必须重新验证 Identity、Permission、Qualification、Vehicle 与 Store Scope
* Profile 不做硬删除
* 历史 Assignment 始终保留原 Worker Reference 与 Snapshot

### 34.51 Internal Delivery Worker Availability 计算

Delivery Worker Availability 不保存为可长期手动维护的布尔值，而是在派单时动态计算。

计算输入：

* Delivery Worker Profile 必须为 `Active`
* Identity、Employment Relationship 与 Delivery Qualification 必须有效
* Worker 必须处于排班 / 当班时间，或存在有效的 Available Session
* 当前 `Accepted` 与执行中的 Tasks 不得超过 Concurrent Assignment Limit
* 现有 Task 与新 Task 的预计时间不能冲突
* 当前或最近 Location 必须足以判断能否在 Pickup Deadline 前到达 Store
* Vehicle、Load、Service Area 与 Delivery Requirements 必须匹配

第一版 Availability Result：

* `Available`
* `Unavailable`
* `Indeterminate`

核心规则：

* `Indeterminate` 不能自动收到 Offer，必须刷新资料或由人工确认
* Availability Result 使用短 TTL
* Worker Status、Location、Task 或时间变化后，旧结果立即失效
* Assignment Attempt 保存当时的 Availability Result、Reason Codes 与 Calculated At
* 第一版没有完整 Scheduling Module 时，由 Worker 开始与结束 Available Session 表示当班状态

### 34.52 Delivery Worker Available Session Lifecycle

Available Session 是 Delivery Worker Profile 内部记录。

第一版状态：

* `Active`：Worker 正在指定 Store 接受新派单
* `Ended`：Worker 主动结束当班
* `Expired`：Heartbeat 超时后系统自动结束
* `Revoked`：Manager 或系统因权限、资格或安全原因强制结束

核心规则：

* 同一 Worker 同一时间最多只有一个 `Active` Session
* 开始 Session 时必须验证 Profile `Active`、Identity、Qualification 与 Store Scope
* Session 保存 Session ID、Store、Started At、Expected End、Device / App Source 与 Heartbeat
* App 暂时断线时经过可配置 Grace Period 后才进入 `Expired`
* 切换 Store 必须结束旧 Session，再创建新 Session
* Session 结束只阻止新的 Offer，不自动取消已经 `Accepted` 或执行中的 Delivery Task
* `Ended`、`Expired` 与 `Revoked` 都是最终状态
* 再次上线必须创建新的 Available Session

### 34.53 Internal Delivery Worker Location Tracking 与隐私边界

Internal Delivery Worker Location 使用最小化追踪原则。

核心规则：

* 仅在存在 `Active` Available Session，或 Worker 正在执行 `Accepted` / `In Progress` Delivery Task 时采集位置
* Available Session 与执行中的 Task 都结束后立即停止采集
* 不允许在 Worker 下班后继续后台追踪
* 待派单期间使用较低采集频率；Task Accepted 后根据 Delivery Phase 提高频率
* Worker App 必须持续显示明确的 Location Tracking 指示
* Customer 只看到必要的 Delivery Progress、ETA 或经过降精度处理的位置
* Customer 不得访问原始 Location History
* Store Staff 只能按 Permission 查看当前运营所需位置，所有访问保留 Audit
* 原始 Location Points 使用较短 Retention Period；之后只保留任务里程、关键时间点等必要派生数据
* Location 缺失或过期时，Availability 进入 `Indeterminate`
* 执行中 Task 的 Location 缺失时建立 Exception，并允许人工更新进度
* External Provider Courier 只使用 Provider 返回的标准化 Location / ETA，不由 BOP 持续追踪其个人设备

### 34.54 External Delivery Provider 建模边界

External Delivery Provider 使用独立的 `Delivery Provider Account Aggregate Root`。

Delivery Provider Account 表示某个 Brand / Merchant 与一个外部 Delivery Platform 之间的业务及集成关系。

保存：

* Provider Type
* Merchant Account Reference
* Store Scope
* Supported Service Area / Delivery Service
* Vehicle 或 Package Limits
* SLA
* Dispatch Priority
* Webhook Capability
* Operational Status
* Secret Reference

核心规则：

* API Key、Token 等敏感凭证只保存 Secret Reference，不进入 Domain Data
* Provider External Job ID 保存到 Assignment Attempt，不复制建立另一套 Delivery Task
* Provider Courier 只在 Task 保存必要的 Name / Contact Mask、Vehicle 与 Tracking Link Snapshot
* External Provider Courier 不建立 Internal Delivery Worker Profile
* 每个 Provider 通过 Adapter 将外部状态映射到 BOP Canonical Assignment 与 Execution Status
* Provider Billing、Settlement 与 Contract 不由 Delivery Task 管理，后续由相应 Finance / Procurement Capability 处理

### 34.55 Delivery Provider Account Lifecycle 与 Health

Delivery Provider Account Lifecycle 与实时 Provider Health 分开建模。

第一版 Account Lifecycle：

* `Draft`：配置尚未完成
* `Testing`：进行 Credential、Quote、Create、Cancel、Webhook 与状态映射测试，不接收真实任务
* `Active`：允许参与正式派单
* `Suspended`：临时停止新的派单
* `Inactive`：已经停止使用该 Provider Account

第一版 Provider Health：

* `Healthy`
* `Degraded`
* `Unavailable`
* `Unknown`

核心规则：

* 只有 Lifecycle 为 `Active` 且 Health 不为 `Unavailable` 的 Account 才能成为派单候选
* 激活前必须完成 Credential、Store Scope、Webhook、Idempotency 与 Status Mapping 验证
* `Suspended` 或 `Inactive` 只阻止新的 Offer
* 已有 Provider Job 仍需继续接收状态、执行取消或完成收尾
* Health 变化不直接修改 Account Lifecycle
* Circuit Breaker 可以根据 Health 暂时阻止或降级派单
* 恢复 `Active` 前必须重新验证配置与连接
* Account 不做硬删除，历史 Assignment 保留原 Account Reference 与 Snapshot

### 34.56 Delivery Provider Circuit Breaker

Circuit Breaker 按 `Delivery Provider Account + API Operation` 分别维护，避免 Create 故障影响已有任务的查询与取消。

第一版状态：

* `Closed`：正常调用
* `Open`：停止该 Operation 的新请求
* `Half-Open`：只允许少量受控 Probe 验证是否恢复

核心规则：

* 根据滚动时间窗内的 Consecutive Failures、Error Rate、Timeout、Latency 或 Invalid Response 自动进入 `Open`
* Quote / Create Breaker Open 后停止向该 Provider 创建新 Offer，并进入 Dispatch Route Plan Fallback
* Status、Cancel 与 Webhook 分别维护 Breaker 或 Health，不与 Quote / Create 共用单一开关
* Create 故障不能阻止已有 Provider Job 查询、取消或完成收尾
* Open 经过 Cooldown 后进入 `Half-Open`
* Half-Open 达到 Success Threshold 后恢复 `Closed`，失败则重新进入 `Open`
* 已经 `Accepted` 的 Provider Job 不因 Breaker Open 自动取消
* Breaker 变化必须生成 Alert，并保存原因、指标、时间与影响范围
* Manager 可以手动 Open
* 手动恢复仍需通过受控 Probe，不能直接绕过健康验证

### 34.57 External Provider Webhook 与 Status Event

External Provider Event 使用“先可靠接收，再异步映射”的处理方式。

核心规则：

* Webhook 必须验证 Signature、Timestamp 与 Replay Window
* 接收后先保存不可覆盖的 Provider Event Envelope，再快速返回成功
* Envelope 保存 Provider Account、External Job ID、Provider Event ID、Occurred At、Received At、Payload Version 与 Payload Hash
* 使用 `Provider Account + Provider Event ID` 幂等去重
* 重复 Event 只确认接收，不重复改变 Delivery Task
* Provider Adapter 将外部 Status 映射为 BOP Canonical Assignment / Execution Event
* 未识别 Status 进入 Quarantine 并建立 Provider Exception，禁止猜测映射
* 乱序 Event 保留在历史中，但不得使 Delivery Task 回退到较早状态
* Webhook 缺失或延迟时，对 Active Provider Job 使用受限 Polling 进行 Reconciliation
* Provider 与 BOP 的 Terminal Status 冲突时建立 Exception 并人工核查，不能自动覆盖
* 原始 Payload 按敏感数据规则加密、限制访问并设置 Retention Period

### 34.58 Provider Quote 与 Final Delivery Cost 边界

Customer Delivery Fee 与 Merchant 承担的 Provider Delivery Cost 分开管理。

核心规则：

* Customer Delivery Fee 由 Pricing / Ordering 决定，并固定在 Order Snapshot
* Provider Quote 是 Merchant 的运营成本，不直接修改 Customer Delivery Fee
* Quote Snapshot 保存 Provider Quote ID、Amount、Currency、Tax / Surcharge、Quoted At、Expires At 与 Estimated Pickup / Delivery Time
* Quote 过期后必须重新获取，不能使用旧 Quote 创建 Provider Job
* Quote 超过 Store 配置的 `Max Provider Cost` 或 Allowed Variance 时，进入 Fallback 或要求 Manager Approval
* Accepted Quote 不可覆盖
* Provider 最终收费另存为 Final Delivery Cost
* Final Cost 与 Quote 差异超过阈值时建立 Reconciliation Exception
* Provider 调价、Cancellation Fee 与重复派单成本分别记录责任原因
* Final Delivery Cost 发送给后续 Finance / Settlement 处理，不自动向 Customer 补收或退款
* Customer 金额如需改变，仍必须通过 Pricing Recalculation、Ordering Amendment 与 Payment 流程

### 34.59 Delivery Proof 最小结构

Delivery Proof 是 Delivery Task 内部的追加式记录。

至少保存：

* Proof ID
* Delivery Task ID
* Fulfillment ID
* Assignment / Courier / Provider Reference
* Delivery Proof Policy Version
* Proof Method：`OTP/PIN`、`Signature`、`Photo`、`QR/Scan`、`Recipient Confirmation`、`Provider Attestation` 或 `Manager Override`
* Delivered At
* Location / Accuracy
* Recipient Type：`Customer`、`Authorized Recipient` 或 `Leave-at-door`
* Recipient Name / Contact Mask
* 实际交付的 Package、Fulfillment Item 与 Quantity Result
* Evidence Asset Reference、Hash 与 Metadata
* Device / App Source
* Provider External Proof Reference
* Created By
* Created At

核心规则：

* Photo、Signature 等文件只保存 Asset Reference，不直接放入 Aggregate
* Proof 一旦提交不得覆盖；更正必须追加 Revision
* External Provider Proof 必须映射并保存 Provider Reference，不能只接受一个 `Delivered` 文本状态
* 敏感证据按 Permission 访问，并设置独立 Retention Policy
* Delivery Task 只有在 Proof 满足当时 Delivery Proof Policy 后才能进入 `Delivered`

### 34.60 Delivery Proof Validation Status

第一版 Delivery Proof Validation Status：

* `Pending`：Proof 已提交，等待自动验证
* `Validated`：满足固定的 Delivery Proof Policy
* `Needs Review`：证据存在但无法自动确定，需要人工审核
* `Rejected`：证据明确无效、不完整或与 Task 不符

自动验证至少检查：

* Required Proof Method 是否齐全
* OTP / PIN 或 QR 是否匹配
* Evidence Asset Hash 与完整性
* Delivered At 与 Task 时间合理性
* Location / Accuracy 与 Delivery Address 是否符合规则
* Recipient Type、Package、Fulfillment Item 与 Quantity 是否一致
* External Provider Signature / Reference 是否可信

核心规则：

* 只有 `Validated` 才能使 Delivery Task 进入 `Delivered`
* `Pending` 或 `Needs Review` 时，Task 保持当前 Execution Status
* 技术故障不能误判为 `Rejected`
* 每个 Proof Revision 独立验证
* 已经 `Validated` 或 `Rejected` 的旧版本不得覆盖
* 人工审核必须保存 Reviewer、Reason、Evidence 与 Reviewed At
* Manager Override 仍产生新的 Proof Revision，并按专门 Policy 验证

### 34.61 Required Delivery Proof Policy

不同交付方式通过版本化 `Delivery Proof Policy` 决定 Required Proof。Policy 在 Delivery Task 创建时根据 Store、Handoff Mode、Item Risk 与 Provider Capability 固定。

第一版默认规则：

* `Hand to Customer / Authorized Recipient`：OTP/PIN、QR 或 Signature 至少一种，并包含 Time 与 Location
* `Leave at Door`：Photo + Location + Timestamp + Drop-off Note
* `High Risk / Restricted Delivery`：OTP/PIN + Signature，或适用的 Identity / Age Verification Reference；Policy 可以禁止 Leave-at-door
* `External Provider`：Provider 的 Proof Capability 必须满足当前 Policy 才能参与派单
* Provider Attestation 不能默认替代全部证据
* 普通低风险 Order 不强制收集不必要的 Photo、Signature 或 Identity Data

核心规则：

* Policy 支持 `AND / OR` Evidence Combination
* Platform Hard Requirement 不能被 Store Configuration 降低
* Fulfillment Revision 改变 Address、Recipient、Handoff Mode 或 Item Risk 时，必须重新确定 Proof Policy
* Delivery Task 开始执行后如需降低证据要求，只能通过受权限控制的 Manager Override
* Manager Override 必须保留 Reason 与 Audit

### 34.62 Delivery Proof Manager Override 限制

Delivery Proof Manager Override 仅在“Delivery 很可能已经发生，但标准 Evidence 因技术或现场原因无法取得”时允许。

核心规则：

* 只有具备专门 Permission 的 Manager 可以发起
* 执行 Delivery 的 Worker 不能审批自己的 Override
* Platform Hard Requirement、Restricted Item、安全或法规要求不能被 Override
* High Risk Delivery 如允许 Override，必须经过第二名授权人员批准
* Override 必须创建新的 Proof Revision，不能修改原 Proof
* 必须保存 Original Policy、Missing Evidence、Reason Code、详细说明、Alternative Evidence、Customer Confirmation、Manager、Approver 与时间
* Override 不能改变实际 Fulfillment Item / Quantity Result
* 未交付 Item 仍必须记录为未交付
* Override Proof 必须带永久 Risk Flag，并进入 Audit / Exception Review
* 同一 Worker、Store 或 Manager 的 Override Frequency 超过阈值时自动 Alert
* Override 只解决 Proof Validation，不能绕过 Order、Payment、Cancellation 或 Customer Dispute 流程

### 34.63 Pickup Handoff Record 最小结构

Pickup Handoff 是 Fulfillment Aggregate 内部的追加式记录。

至少保存：

* Handoff ID
* Fulfillment ID
* Store
* Pickup Location
* Handoff Policy Version
* Verification Method：`OTP/PIN`、`QR/Scan`、`Signature`、`Order Code` 或 `Manager Override`
* Recipient Type：`Customer` 或 `Authorized Pickup Person`
* Recipient Name / Contact Mask
* Staff Actor ID
* 实际交接的 Fulfillment Item 与 Quantity
* Handed Over At
* Device / App Source
* Evidence Asset Reference
* Reason / Note
* Created At

核心规则：

* 一个 Fulfillment 可以有多个 Handoff Record，以支持部分领取或补领遗漏 Item
* 每个 Record 只追加本次实际交接 Quantity，不覆盖之前记录
* Fulfillment Item 必须为 `Ready` 才能正常交接
* 异常交接需要授权并保留 Reason 与 Audit
* Handoff Record 不复制 Pricing 或 Catalog Data
* 只有所有非取消 Item 都有有效 Handoff Record 后，Pickup Fulfillment 才能进入 `Completed`
* 更正必须追加 Revision，不能修改原 Handoff Record

### 34.64 Pickup Handoff Validation Status

第一版 Pickup Handoff Validation Status：

* `Pending`：Handoff 已提交，等待验证
* `Validated`：Identity Verification、Fulfillment Item 与 Quantity 均符合 Handoff Policy
* `Needs Review`：资料存在，但需要人工核查
* `Rejected`：Pickup Code、Recipient、Item 或 Quantity 明确不符合规则

核心规则：

* 只有 `Validated` Handoff 的 Quantity 才能累计到 Fulfillment Item 的 Handed Over Quantity
* 部分领取验证成功后，Fulfillment 保持 `In Progress`，不能提前进入 `Completed`
* 验证必须检查 Pickup Code、Recipient Authorization、Staff Permission、Item Ready Status 及累计 Quantity 是否超限
* 技术故障不能误判为 `Rejected`
* `Pending` 与 `Needs Review` 不产生最终交接结果
* 更正或 Manager Override 必须追加新的 Handoff Revision

### 34.65 Pickup Handoff Verification Policy

Pickup Handoff 使用版本化 Policy，并按 `Brand Default → Store Override` 解析。

第一版默认规则：

* 普通 Pickup：`Order Code`、`QR` 或 `OTP/PIN` 至少一种
* `Authorized Pickup Person`：Customer 必须预先授权，并使用一次性 OTP/PIN 或 QR
* `High Value / High Risk Order`：OTP/PIN + Signature，或适用的 Identity Verification Reference
* `Curbside Pickup`：Verification Method + Vehicle / Pickup Spot Note

核心规则：

* Platform Hard Requirement 不能被 Store Override 降低
* Policy 在 Fulfillment 进入 `Planned` 时固定版本
* 后续 Configuration 变化不影响当前 Fulfillment
* Recipient、Pickup Store 或 Risk Level 发生 Fulfillment Revision 时，必须重新确定 Policy
* 标准验证无法完成时，只能使用受权限控制的 Manager Override
* Staff 不能直接跳过 Required Verification

### 34.66 Pickup Handoff Manager Override 限制

Pickup Handoff Manager Override 仅在 Item 已经实际交给正确 Recipient，但标准 Verification 因技术或现场原因无法使用时允许。

核心规则：

* 只有具备专门 Permission 的 Manager 可以批准
* 执行 Handoff 的 Staff 不能审批自己的 Override
* Platform Hard Requirement 与 High Risk / Restricted Item 的 Mandatory Verification 不能绕过
* 如果 Policy 允许 High Risk Override，必须经过第二名授权人员批准
* Override 必须创建新的 Handoff Revision，不能修改原 Record
* 必须保存 Original Policy、Missing Verification、Reason Code、Alternative Evidence、Recipient Confirmation、Staff、Manager 与时间
* Override 不能交接尚未 `Ready` 的 Fulfillment Item
* Override 不能增加超过 Required Quantity 的 Handed Over Quantity
* Override 后向 Customer 发送 Handoff Notification
* Override 永久保存 Risk Flag，并计入 Staff / Manager / Store 的异常频率监控
* Override 只解决 Pickup Verification，不能绕过 Order、Payment、Cancellation、Refund 或 Dispute 流程

### 34.67 Pickup No-show 处理

Pickup No-show 作为 Fulfillment 内部 Exception Record，不新增 Canonical Fulfillment Phase。

核心规则：

* Confirmed Time Window 结束后先进入可配置 Grace Period，并发送 Customer Reminder
* Grace Period 结束仍未领取时建立 `Pickup No-show Incident`
* 未领取的 Fulfillment 保持 `Ready`
* 已经部分领取的 Fulfillment 保持 `In Progress`
* No-show 不能立即自动使 Fulfillment 进入 `Failed` 或 `Cancelled`
* Store 根据版本化 No-show Policy 选择延长保留、联系 Customer、重新预约或停止履约
* 重新预约必须创建 Fulfillment Revision，并重新检查 Time Window、Capacity 与 Item Freshness
* Perishable Item 超过 Holding Deadline 后，由 Kitchen / Inventory 记录 Disposal 或 Remake
* 不允许静默继续交付超过 Freshness Rule 的 Item
* No-show 本身不自动触发 Refund、Fee 或 Order Cancellation
* 商业结果仍由 Ordering、Pricing 与 Payment 决定
* 只有所有允许的 Contact、Holding 与 Reschedule 方案耗尽后，才根据最终业务决定进入 `Failed`，或在 Ordering 确认取消后进入 `Cancelled`
* 原 Capacity Allocation 在 Slot 开始时已经 `Consumed`，不因 No-show 返还

### 34.68 Pickup No-show Incident Lifecycle

第一版 Pickup No-show Incident 状态：

* `Open`：Grace Period 结束后建立
* `Contacting`：正在联系 Customer 或等待回复
* `Escalated`：达到 Holding / Freshness Deadline，需要 Manager 决定
* `Resolved`：已经形成明确处理结果

Incident 进入 `Resolved` 时必须保存 Resolution Type：

* `Picked Up`
* `Rescheduled`
* `Cancelled by Ordering`
* `Fulfillment Failed`
* `Created in Error`

核心规则：

* 同一次 No-show 只能有一个 Active Incident
* 每次 Call、Message、Notification 与 Customer Response 都追加保存
* 只有新的 Time Window 与 Capacity 成功确认后，才能以 `Rescheduled` 解决 Incident
* Reschedule 失败时 Incident 继续保持 `Open` 或 `Contacting`
* Customer 再次错过新的 Time Window 时创建新的 Incident，不能重开旧 Record
* Freshness Deadline 到期只触发 `Escalated`，不自动决定 Refund、Cancellation 或 Failure
* Incident Resolution 记录处理结果，但 Fulfillment、Ordering 与 Payment 状态仍由各自 Domain Action 改变

### 34.69 Store-to-Courier Pickup Handoff

Store 向 Delivery Courier 交货时，在 Delivery Task 内建立追加式 `Courier Pickup Handoff Record`。

核心规则：

* 当前 Assignment 必须已经 `Accepted`
* Courier / Provider 必须与当前 Assignment Version 一致
* 使用 Courier App QR、Provider Pickup Code、一次性 PIN 或 Staff Scan 验证 Courier Identity
* Store Staff 必须扫描全部 Package，并确认所有非取消 Fulfillment Item 已 `Ready`、包装完成且 Seal 完好
* Record 保存 Staff Actor、Courier / Provider Snapshot、Assignment Attempt、Package / Item / Quantity、Seal Code、Verification Method、Picked Up At、Store Location 与 Device
* Internal Delivery Worker 由 Worker App 与 Store Staff 双方确认
* External Provider 使用 Store Scan 加 Provider Pickup Event
* 单独收到 Provider 的 `Picked Up` 文本状态不足以完成验证
* 第一版正常流程不允许 Partial Courier Pickup
* Item 不齐时必须先处理 Missing Item，不能让同一 Delivery Task 带着不完整商品离店
* Record 验证成功后，Delivery Task 才进入 `Picked Up`
* Courier Pickup 成功后 Fulfillment 才进入 `In Progress`
* 更正必须追加 Revision，不能覆盖原 Record

### 34.70 Courier Pickup Handoff Validation Status

第一版 Courier Pickup Handoff Validation Status：

* `Pending`：一方已经确认，等待另一方或自动验证
* `Validated`：Courier、Assignment、Package、Item、Seal 与双方确认均符合规则
* `Needs Review`：Item 可能已经离开 Store，但验证资料缺失或双方记录冲突
* `Rejected`：Courier Identity、Assignment、Package 或 Quantity 明确不匹配，且 Item 尚未交出

验证至少检查：

* Assignment 是否仍为当前 `Accepted` Version
* Courier / Provider Identity
* Staff Permission
* 全部 Package、Fulfillment Item 与 Quantity
* Seal Code / Integrity
* Store 与 Courier 双方确认
* Pickup Time、Location 与 Device
* Provider Pickup Event 的真实性与 Idempotency

核心规则：

* 只有 `Validated` 才能使 Delivery Task 进入 `Picked Up`
* 技术故障或只缺一方 Receipt 不能误判为 `Rejected`
* Item 已经离开 Store 但验证不完整时，必须进入 `Needs Review` 并建立 Custody Exception
* `Pending` 超过 Policy TTL 后自动进入 `Needs Review`
* 更正与 Manager Resolution 必须追加 Revision，不能覆盖原 Record

### 34.71 Courier Pickup Custody Exception

Custody Exception 是 Delivery Task 内部追加式记录。

第一版状态：

* `Open`
* `Investigating`
* `Escalated`
* `Resolved`

Exception 建立后：

* 立即冻结相关 Handoff Evidence，并通知 Store Manager
* 暂停自动 Reassignment，避免另一名 Courier 重复领取
* Delivery Task 暂不进入 `Picked Up`
* 设置 `Custody Unconfirmed` Risk Flag
* 核查 Staff Scan、Courier App、Provider Event、Location、Device Log、Seal 与必要的 CCTV Reference

进入 `Resolved` 时保存 Resolution Type：

* `Handoff Validated`
* `Returned to Store`
* `Wrong Courier / Package`
* `Lost or Unknown`
* `Created in Error`

核心规则：

* `Handoff Validated`：追加新的 Handoff Revision 后，Task 才进入 `Picked Up`
* `Returned to Store`：重新检查 Package、Seal 与 Freshness 后，才能重新派单
* `Wrong Courier / Package` 或 `Lost or Unknown`：升级为 Operations Incident，并由 Fulfillment、Ordering、Kitchen 与 Inventory 分别决定 Remake、Failure、Refund 或 Cancellation
* Custody Exception 本身不自动 Refund、Cancel 或修改 Order
* 必须设置 Resolution Deadline，超时自动进入 `Escalated`
* 同一 Handoff 同时只能有一个 `Open` Custody Exception

### 34.72 Delivery Task `Picked Up` → `En Route`

Delivery Task 从 `Picked Up` 进入 `En Route` 前必须满足：

* Courier Pickup Handoff 已经 `Validated`
* 当前 Assignment 仍为 `Accepted`
* 没有 Open Custody、Safety 或 Cancellation Exception
* 全部 Package 仍由当前 Courier 持有
* Delivery Address、Instructions 与 Contact Snapshot 为当前有效版本
* 没有等待处理的 Critical Fulfillment Revision

确认离开 Store 的方式：

* Internal Delivery Worker：Worker 执行 `Start Delivery` Action，并由 Store Geofence / Location 辅助确认已经离店
* External Provider：收到可信的 `En Route` Event，并在 Provider 支持时同时验证 Location
* Location 暂时不可用时，可以接受明确的 Worker / Provider Action，但必须记录 Location Exception

进入 `En Route` 后：

* 保存 Departed At、Location、Route / ETA Snapshot 与 Assignment Version
* 重新计算 ETA 并通知 Customer
* 状态转换必须 Idempotent
* 迟到 Event 不能使 Task 回退
* Courier 仍在 Store 等待时保持 `Picked Up`
* 不能仅因时间经过自动进入 `En Route`

### 34.73 En Route Delivery Delay 识别

Delivery Delay 不新增 Delivery Task Execution Status；Task 继续保持 `En Route`，并建立独立的 `Delivery Delay Signal / Incident`。

系统持续根据以下信息重新计算预计到达时间：

* 最新或近期有效 Location
* 当前路线与交通情况
* 配送进度
* External Provider ETA
* Confirmed Delivery Time Window

满足以下任一条件时，可以产生 Delivery Delay Signal：

* Projected Arrival 超过 Confirmed Window End 与可配置 Grace Period
* 在可配置时长内 Location 没有有效推进
* Route Deviation 超过允许阈值
* External Provider 明确报告 Delay
* Courier 明确报告延误及原因

为避免误报：

* 自动信号必须连续两次成立，或持续超过配置阈值后才确认
* Location 过期或缺失时，结果为 `Indeterminate` 并建立 Location Exception，不能直接判定为 Delayed
* 短暂的 ETA 波动不能单独建立已确认的 Delay Incident

Delay Severity 为：

* `At Risk`
* `Delayed`
* `Critical`

确认 Delay 后：

* 重新计算并保存 ETA
* 通知 Operations，并在适用时提示 Courier
* 达到 Customer Communication Threshold 后通知 Customer
* 不自动将 Delivery Task 标记为 `Failed` 或 `Cancelled`
* 不自动修改 Order Price

Delay Record 必须保存 Reason Code、Detected At、Expected Delay Duration、Signal Source、Location / Route / ETA Snapshot，以及最终 Resolution。

### 34.74 Delivery Delay Incident 生命周期

Delivery Delay Incident Lifecycle 为：

* `Open`：Delay Signal 达到确认阈值后建立
* `Acknowledged`：Operations 或 Courier 已经确认知悉
* `Mitigating`：正在执行改道、联系 Customer、重新派送等缓解措施
* `Resolved`：Incident 已结束；该状态为终态，不能重新打开

Delay Severity 与 Lifecycle 分开维护；`At Risk`、`Delayed` 与 `Critical` 可以在 Incident 存续期间独立升降级。

同一 Delivery Task 同时最多存在一个未解决的 Delay Incident。后续重复信号只向当前 Incident 追加 Evidence、ETA Snapshot 与 Severity Revision，不创建并行 Incident。

以下情况允许解除 Incident：

* ETA 恢复到允许范围，并连续两次评估保持正常
* Delivery Task 已实际送达，Resolution Outcome 记录为 `Recovered` 或 `Delivered Late`
* Delivery Task 进入 `Failed` 或 `Cancelled`，Incident 以对应终止结果关闭，但不能标记为已经恢复
* 经授权人员确认属于 `False Positive`，并保存原因与支持证据

解除时必须保存 Resolution Outcome、Resolved At、Resolved By、最终 ETA / Delivery Time 及已经采取的措施。

如果 Customer 此前已经收到 Delay Notification，ETA 明显恢复时应发送更新通知。

Incident 进入 `Resolved` 后发生新的延误，必须建立新的 Incident，并保留与前一 Incident 的关联。

### 34.75 Customer 无法联系或无法接收时的 Delivery Attempt

Courier 每次到达 Delivery Location 时，必须建立不可覆盖的 `Delivery Attempt Record`；同一 Delivery Task 可以追加多次 Attempt，但不得为单次失败创建新的 Task。

开始 Attempt 后：

* 验证当前 Location 与 Delivery Address / Geofence
* 按固定 Contact Sequence 尝试 App、Phone 或 SMS 联系 Customer
* 等待版本化 Policy 规定的 Grace Period
* 遵守 Contact Privacy、Quiet Hours 与受限信息显示规则

如果 Handoff Mode 允许 `Leave at Door`，并且同时满足 Address、Location、Product Safety 与 Required Delivery Proof Policy，可以完成无接触交付。

如果要求 In-person Handoff、PIN、Signature、Age Verification，或 Customer 明确禁止 Unattended Delivery，则不得擅自留下商品。

Grace Period 结束后仍无法交付时：

* 当前 Attempt 记录为 `Unsuccessful`
* Delivery Task 暂时保持 `En Route`
* 建立 `Delivery Completion Exception`
* 由固定 Policy 或 Operations 决定 Reattempt、Return to Store 或 Authorized Disposal

单次 Unsuccessful Attempt 不得自动使 Delivery Task 或 Fulfillment 进入 `Failed`，也不得自动 Refund 或 Cancel Order；商业结果仍由 Ordering 决定。

Delivery Attempt Record 必须保存 Arrived At、Location / Geofence Result、Contact Attempts、Wait Duration、Failure Reason、Package Condition、Evidence Reference 与 External Provider Raw Event Reference。

### 34.76 Delivery Completion Exception Lifecycle

Delivery Attempt 在 Grace Period 后仍无法完成交付时，在 Delivery Task 内建立追加式 `Delivery Completion Exception`。

第一版 Lifecycle：

* `Open`：由失败的 Delivery Attempt 触发，等待处理
* `Contacting`：正在联系 Customer、Store、Courier 或 Provider
* `Action Required`：已经确认不能立即完成，需要决定 Reattempt、Return、Disposal 或终止处理
* `Escalated`：超过 Resolution Deadline，或触发 Freshness、安全、高价值等升级条件
* `Resolved`：已经形成并执行明确 Resolution；属于终态，不能重新打开

核心规则：

* 同一 Delivery Task 同时最多存在一个未解决的 Delivery Completion Exception
* 可以根据实际情况跳过中间状态，但不能跳过最终 Resolution
* 每个 Exception 必须保存 Resolution Deadline
* 超时只触发 `Escalated`，不能自动把 Delivery Task 或 Fulfillment 标记为 `Failed`
* 已 `Resolved` 后再次发生新的交付失败，必须建立新的 Exception
* Lifecycle、Severity 与具体处理动作分开维护

### 34.77 Delivery Completion Exception Resolution

第一版 Resolution Type：

* `Delivered on Reattempt`
* `Returned to Store`
* `Authorized Disposal`
* `Fulfillment Failed`
* `Cancelled by Ordering`
* `Created in Error`

Resolution 前置条件：

* `Delivered on Reattempt`：必须存在新的 `Validated Delivery Proof`
* `Returned to Store`：必须存在 `Validated Return to Store Handoff`
* `Authorized Disposal`：必须满足版本化 Disposal Policy，并保存授权、原因、位置及 Evidence
* `Fulfillment Failed`：必须确认允许的 Reattempt、Return、Remake、Replacement 与其他补救方案已经耗尽或不适用
* `Cancelled by Ordering`：必须已经收到 Ordering 的正式取消事实
* `Created in Error`：必须填写创建错误原因，并确认没有实际交付处理需要继续

对 Delivery Task 的影响：

* `Delivered on Reattempt`：有效 Proof 通过后，Task 进入 `Delivered`
* `Returned to Store`：Task 保持非终态，等待 Return Disposition 与后续处理
* `Authorized Disposal`：不直接决定 Task 最终状态；由 Fulfillment 判断是否仍可 Remake、Replace 或 Reattempt
* `Fulfillment Failed`：Task 进入 `Failed`，并发布最终失败事实
* `Cancelled by Ordering`：Task 进入 `Cancelled`
* `Created in Error`：只关闭错误 Exception，不改变 Task 状态

核心规则：

* Exception Resolution 只记录处理结果，不能绕过对应 Domain 的正式 Action、Proof 或状态验证
* Resolution 不直接修改 Order、Payment、Refund、Remake、Waste 或 Inventory
* 缺少对应前置证据时不得进入 `Resolved`

### 34.78 Delivery Completion Policy

Delivery Completion 使用版本化 `Delivery Completion Policy`。

Policy 在 Delivery Task 创建时，根据以下上下文解析并固定版本：

* Store
* Order Type
* Handoff Mode
* Item Risk
* Provider Capability
* Delivery Requirements

Policy 至少定义：

* Contact Sequence
* Grace Period
* 最大 Reattempt 次数
* 最晚 Reattempt 时间
* Return-to-Store 规则
* Authorized Disposal 条件
* Resolution Deadline
* Escalation Threshold
* Freshness / Safety Deadline

核心规则：

* 后续配置变化不追溯影响当前 Delivery Task
* Fulfillment Revision 改变 Address、Recipient、Handoff Mode、Item Risk 或 Time Window 时，必须重新解析 Policy
* Task 已进入执行阶段后，不允许直接降低 Platform Hard Requirement
* 特殊处理只能通过受权限控制的 Manager Override

### 34.79 Delivery Completion Manager Override

Manager Override 只允许调整可配置的运营限制，例如：

* 增加一次受限 Reattempt
* 延长 Resolution Deadline
* 改为 Return to Store
* 在 Policy 明确允许范围内批准 Authorized Disposal

不得绕过：

* 法律、安全或 Food Safety 限制
* Restricted Item Mandatory Verification
* 已确认的商品变质、污染或不可接受包装损坏
* Ordering 对商业取消的最终决定
* Delivery Proof Hard Requirement

Override 必须保存：

* Original Policy 与原限制
* Override Type
* Reason
* Manager
* 必要的第二审批人
* Effective Until
* Audit Record

执行配送的 Courier 或处理 Exception 的 Staff 不能单独批准自己的 Override。Override 本身不能使 Exception 进入 `Resolved`。

### 34.80 Delivery Completion Exception Record

Delivery Completion Exception 至少保存：

* Exception ID
* Delivery Task ID
* Fulfillment ID
* Triggering Delivery Attempt ID
* Lifecycle Status
* Primary Reason Code
* Supporting Reason Codes
* Delivery Completion Policy Version
* Resolution Deadline
* Current Handler / Operations Owner
* Customer Contact Attempt References
* Package Condition Snapshot
* Location / Geofence Result
* Courier / Provider / Assignment Reference
* Created At / Created By
* Escalated At / Escalation Reason
* Resolution Type
* Resolution Evidence Reference
* Resolved At / Resolved By
* Manager Override Reference

第一版 Reason Code：

* `CUSTOMER_UNREACHABLE`
* `CUSTOMER_UNAVAILABLE`
* `RECIPIENT_VERIFICATION_FAILED`
* `ACCESS_BLOCKED`
* `ADDRESS_OR_LOCATION_MISMATCH`
* `UNATTENDED_DELIVERY_NOT_ALLOWED`
* `PACKAGE_DAMAGED`
* `PACKAGE_SAFETY_OR_FRESHNESS_RISK`
* `DELIVERY_INSTRUCTIONS_CONFLICT`
* `PROVIDER_REPORTED_COMPLETION_FAILURE`
* `OTHER`

核心规则：

* `OTHER` 必须填写详细说明
* Provider 原始原因必须保留，并映射到标准 Reason Code
* 技术故障或证据缺失不能错误映射为 Customer 原因
* 每次联系、升级、决定与处理动作通过 Timeline / Revision 追加保存
* Photo、录音与文件只保存 Asset Reference
* 必须能够追溯原 Attempt、后续 Reattempt 与最终 Resolution

### 34.81 Delivery Reattempt

Reattempt 不创建新的 Delivery Task，仍属于原 Delivery Task。

每次 Reattempt 必须：

* 创建新的 `Delivery Attempt Record`
* 使用递增的 Attempt Sequence
* 重新确认 Customer Availability
* 重新确认 Address、Instructions 与 Recipient
* 建立新的 Confirmed Time Window
* 检查 Package Condition、Freshness 与 Holding Deadline
* 检查 Courier / Provider Assignment
* 重新解析并固定 Delivery Proof Policy

核心规则：

* 原 Courier 不一定继续执行；更换 Courier 必须创建新的 Assignment Attempt
* 易腐、损坏或超过安全时限的商品不能直接重新配送
* Reattempt 次数与最晚执行时间由 Delivery Completion Policy 限制
* 达到最大次数后进入 `Action Required` 或 `Escalated`，不能静默继续
* Reattempt 成功必须由新的 Validated Delivery Proof 支持

### 34.82 Reattempt Time Window 与 Capacity

Reattempt 不直接沿用原 Confirmed Time Window。

新 Window 必须重新检查：

* Customer Availability
* Fulfillment Capacity
* Package Freshness / Holding Deadline
* Courier / Provider Availability
* ETA
* Delivery Completion Policy

Scheduled Reattempt：

* 创建新的 Fulfillment Capacity Hold
* Hold 成功后转换为新的 Capacity Allocation
* 原 Window 对应 Allocation 已经 `Consumed`，不能释放或重复利用
* Reattempt Capacity 作为新的容量占用单独记录

ASAP Reattempt：

* 第一版不建立长期 Hold
* 执行前必须重新检查当前 Capacity

新 Hold 创建失败时：

* 不开始重新派单
* 不覆盖原 Fulfillment Snapshot 或 Revision
* Exception 保持 `Action Required` 或 `Escalated`

新 Allocation 必须关联 Fulfillment ID、Delivery Task ID、Reattempt Sequence 与新 Confirmed Time Window。

### 34.83 Reattempt Delivery Proof Policy

每次 Reattempt 开始前必须重新解析并保存新的 Delivery Proof Policy Resolution Result。

解析依据：

* 当前 Recipient
* Handoff Mode
* Delivery Address
* Item Risk
* Return Disposition Result
* Courier / Provider Capability
* Reattempt Sequence

核心规则：

* 条件未变化时可以解析出与原 Attempt 相同的 Policy Version，但仍保存本次解析结果
* Return、Remake、Replacement 或 Customer Instruction 变化可以提高 Proof Requirement
* 不允许因为是 Reattempt 而自动降低 OTP、Signature、Photo、Age Verification 等要求
* 当前 Provider 无法满足新 Policy 时，不得向其重新派单

### 34.84 Return to Store Handoff Record

Courier 将商品退回门店时，在原 Delivery Task 内追加 `Return to Store Handoff Record`。

至少保存：

* Return Handoff ID
* Delivery Task ID
* 原 Delivery Attempt ID
* Courier / Provider / Assignment Reference
* Store 与 Receiving Staff Actor
* Returned At 与 Location
* Package、Fulfillment Item 与 Quantity
* Package Condition
* Seal Code / Integrity
* Temperature / Freshness Evidence
* Return Reason
* 双方确认
* Evidence Asset Reference

核心规则：

* 只有 Return Handoff 验证成功，Exception 才能以 `Returned to Store` 解决
* Provider 的单独 `Returned` 文本状态不足以确认实物已经回店
* Record 采用追加式设计，更正必须创建 Revision
* 退回门店不等于商品仍可重新配送

### 34.85 Return to Store Handoff Validation

第一版 Validation Status：

* `Pending`
* `Validated`
* `Needs Review`
* `Rejected`

验证至少检查：

* 当前或相关 Assignment Reference
* Courier / Provider Identity
* Receiving Staff Permission
* Package、Fulfillment Item 与 Quantity
* Seal 与 Package Condition
* Returned At、Location 与 Device
* 双方确认与 Provider Event 真实性

核心规则：

* 只有 `Validated` 才能确认商品正式回到门店
* 技术故障或缺少一方确认不能误判为 `Rejected`
* 门店已实际接收但资料不完整时进入 `Needs Review`，并禁止重新派送
* `Needs Review` 超过 Deadline 后升级
* Manager Resolution 必须追加 Return Handoff Revision

### 34.86 Return Disposition

每个退回的 Package / Fulfillment Item 保存独立的 `Return Disposition`。

第一版状态：

* `Pending Inspection`
* `Eligible for Reattempt`
* `Remake Required`
* `Replacement Required`
* `Disposal Required`
* `Held for Investigation`
* `Finalized`

核心规则：

* Return Handoff `Validated` 不等于商品可以重新配送
* 检查必须保存 Condition、Seal、Freshness、Temperature、Evidence、Policy Version、Actor 与时间
* 在 `Eligible for Reattempt` 前不得重新派单
* Decision 与实际执行分开记录
* `Finalized` 只能在对应 Domain Action 已完成后进入
* 原判断不能覆盖；纠错通过 Revision / Correction Record

### 34.87 Return Disposition Decision Boundary

决策归属：

* `Eligible for Reattempt`：Fulfillment 根据 Inspection、Freshness Policy 与 Delivery Completion Policy 决定
* `Remake Required`：Fulfillment 提出需求，Kitchen 决定是否接受与执行
* `Replacement Required`：Fulfillment 提出需求，Inventory / Store Operations 确认可用替代商品
* `Disposal Required`：Food Safety / Inventory Policy 判断，并通过正式 Disposal / Waste Action 执行
* `Held for Investigation`：Operations 或 Manager 启动，调查期间禁止重新配送或处置
* `Finalized`：对应实际 Domain Action 完成后更新

Fulfillment 负责协调后续履约，但不能代替 Kitchen、Inventory 或 Food Safety 记录领域内实际事实。

### 34.88 Return Disposition Record 与 Reason Code

Return Disposition 至少保存：

* Disposition Decision ID
* Delivery Task ID
* Return Handoff Record ID
* Package / Fulfillment Item / Quantity
* Current Disposition Status
* Inspection Result
* Package Condition
* Seal Integrity
* Freshness / Temperature Result
* Applicable Policy Version
* Primary Reason Code
* Supporting Reason Codes
* Decision By / Decision At
* Required Domain Action Reference
* Investigation Hold Reference
* Finalized At / Finalized By
* Correction / Revision Reference

第一版 Reason Code：

* `PACKAGE_INTACT_AND_SAFE`
* `SEAL_BROKEN`
* `PACKAGE_DAMAGED`
* `TEMPERATURE_OUT_OF_RANGE`
* `FRESHNESS_WINDOW_EXCEEDED`
* `CONTAMINATION_RISK`
* `WRONG_PACKAGE_OR_ITEM`
* `ITEM_MISSING_OR_QUANTITY_MISMATCH`
* `CUSTOMER_HANDLING_RISK`
* `DELIVERY_DELAY_EXCEEDED_LIMIT`
* `INVESTIGATION_REQUIRED`
* `OTHER`

`PACKAGE_INTACT_AND_SAFE` 只是允许 Reattempt 的必要支持条件之一，仍需检查 Customer、Time Window、Capacity 与 Proof Policy。

### 34.89 Customer Dispute Boundary

Delivery Completion Exception 只处理当前交付未完成的运营问题。

Customer 后续声称未收到、收到错误商品、商品损坏或 Proof 有争议时，应创建独立 Customer Dispute / Complaint。

核心规则：

* Exception 已 `Resolved` 不阻止后续建立 Dispute
* Dispute 不覆盖原 Delivery Attempt、Proof、Exception Resolution 或 Return Disposition
* 调查证明原 Resolution 有误时，追加 Correction / Investigation Record
* Refund、Compensation、Remake 或 Fraud Review 由对应 Domain 决定
* Delivery Domain 只提供交付事实与证据，不独立决定退款或赔偿

### 34.90 Delivery Task Final Failure

Delivery Task 只有在全部允许的执行与补救方案耗尽后才能进入 `Failed`。

进入前至少验证：

* 没有可继续的 Assignment 或 Reattempt
* Return、Remake、Replacement 或 Alternative Handoff 已确认不可用或已经失败
* 没有仍在处理的 Critical Completion Exception
* 所有 Package / Fulfillment Item 已有最终结果
* Failure Decision 通过权限与 Policy 验证

进入 `Failed` 时保存：

* Failure Reason
* Final Delivery Attempt
* Exhausted Remedy Summary
* Package / Item Final Result
* Actor 或 Policy Source
* Failed At

核心规则：

* Delivery Task 发布 `DeliveryTaskFailed`
* Fulfillment 根据 Item 最终结果与自身规则决定是否进入 `Failed`
* Fulfillment 发布 `FulfillmentFailed`，但不能自行取消 Order
* Ordering 决定商业取消、补单或其他订单结果
* Payment 决定 Refund，不由 Delivery 自动执行

### 34.91 Delivery & Fulfillment Domain Events

第一版最小 Domain Event 集合补充如下。

Delivery Attempt / Completion：

* `DeliveryAttemptStarted`
* `DeliveryAttemptSucceeded`
* `DeliveryAttemptUnsuccessful`
* `DeliveryCompletionExceptionOpened`
* `DeliveryCompletionExceptionContacting`
* `DeliveryCompletionActionRequired`
* `DeliveryCompletionExceptionEscalated`
* `DeliveryCompletionExceptionResolved`
* `DeliveryReattemptScheduled`

Return：

* `DeliveryReturnedToStore`
* `ReturnHandoffSubmitted`
* `ReturnHandoffValidated`
* `ReturnHandoffNeedsReview`
* `ReturnDispositionInspectionStarted`
* `ReturnDispositionDetermined`
* `ReturnEligibleForReattempt`
* `ReturnRemakeRequired`
* `ReturnReplacementRequired`
* `ReturnDisposalRequired`
* `ReturnHeldForInvestigation`
* `ReturnDispositionFinalized`
* `ReturnDispositionCorrected`

Task / Fulfillment：

* `DeliveryTaskDelivered`
* `DeliveryTaskFailed`
* `DeliveryTaskCancelled`
* `FulfillmentCompleted`
* `FulfillmentFailed`
* `FulfillmentCancelled`

核心规则：

* Event 只描述已经发生的事实，不作为跨 Domain Command
* 每个 Event 必须包含 Event ID、Version、Brand、Store、Aggregate ID 与 Occurred At
* Completion Resolution Event 必须包含 Resolution Type、Attempt、Evidence 与处理时间
* Remake、Replacement、Waste、Refund 与 Order Cancellation 由对应 Domain 发布自身 Event
* 消费者必须幂等处理
* Notification、Ordering、Kitchen、Inventory、BI 与 Operations 的非关键订阅失败不得回滚 Delivery 主流程

### 34.92 v0.1 阶段状态

Delivery & Fulfillment Domain v0.1 已阶段性完成并 Freeze。

Freeze 表示：

* Fulfillment、Delivery Task、Capacity、Dispatch、Provider、Proof、Pickup Handoff、Courier Handoff、Delay、Delivery Attempt、Completion Exception、Return 与 Reattempt 的核心边界已经确认
* 具体地图 Provider、Courier App 页面、通知文案、字段格式与运营后台交互留到实现阶段
* 多订单批量配送、复杂路线优化、多 Stop Route、跨 Store Consolidation 与 Fleet Optimization 留到后续版本
* 未来发现跨 Domain 冲突时仍可受控修订
* 后续讨论不重新展开已经确认的内容


---

## 历史讨论节点 H-035（已完成）

Printing & Device Integration Domain 的第一个核心决定已经确认：

* Printer、KDS、POS、Customer Display、Label Printer、Kitchen Buzzer 等共用统一的 `Device Aggregate Root`
* 通过 `Device Type` 与 Capability 区分设备
* Device Aggregate 只负责设备身份、生命周期、注册、绑定、能力、健康状态与通信配置
* 打印任务、显示内容、KDS 页面和业务通知不放入 Device Aggregate

---

## 36. Printing & Device Integration Domain

> Future-trigger boundary：本节是可复用的 Printing / Device architecture，不表示第一 Pilot 部署这些能力。Section 87.11.1 的现行 baseline 禁用 Store Gateway、physical printer 与 application Offline Queue，只启用 named-operator browser KDS；任何启用均须先修订 IDR-0039。

### 36.1 职责边界

Printing & Device Integration 负责：

* Device 注册、认证、绑定、配置与生命周期
* Printer、KDS、POS、Customer Display、Label Printer、Kitchen Buzzer 等设备的统一管理
* Device Capability、Health、Connectivity 与 Heartbeat
* Print Job、Display Job、Alert Job 等输出任务的可靠投递
* 模板解析、Routing、Fallback、Retry、Acknowledgement 与失败处理
* 本地网络、Cloud Agent、Device Adapter 与第三方硬件 SDK 的隔离
* 向 Ordering、Kitchen、Payment、Dining、Fulfillment 等 Domain 提供设备输出能力

Printing & Device Integration 不负责：

* Order、Payment、Kitchen Work Item 或 Fulfillment 的业务状态
* 收据金额、税费、商品名称或制作内容的业务计算
* 员工权限与身份定义
* 设备厂商底层驱动实现细节
* BI 报表与长期业务分析

核心边界：

**业务 Domain 决定“需要输出什么业务事实”，Printing & Device Integration 决定“通过哪些设备、以何种格式、可靠地输出”。**

### 36.2 Device Aggregate Root

所有门店设备共用统一的 `Device Aggregate Root`。

第一版 Device Type：

* `POS Terminal`
* `Receipt Printer`
* `Kitchen Printer`
* `Label Printer`
* `Kitchen Display`
* `Customer Display`
* `Order Status Display`
* `Kitchen Buzzer / Alert Device`
* `Payment Terminal Reference`
* `Store Gateway / Local Agent`
* `Other`

Device 保存稳定身份：

* Device ID
* Brand ID
* Store ID
* Device Type
* Device Code
* Lifecycle
* Created At / By

Device Configuration 保存：

* Display Name
* Physical Location
* Network / Connection Type
* Adapter Type 与 Adapter Version
* Capability Set
* Routing Tags
* Default Language / Locale
* Time Zone
* Paper / Label / Screen Profile
* Heartbeat Policy
* Secret / Credential Reference

核心规则：

* 不同 Device Type 共享统一身份、生命周期、健康与连接模型
* 设备专属配置通过 Capability 与 Type-specific Configuration 扩展
* 不为每类设备建立完全独立的顶层身份模型
* Device 不保存无限增长的 Print Job 或 Display Job 数组
* 设备厂商 Credential 只保存 Secret Reference，不保存明文

### 36.3 Device Lifecycle

第一版 Lifecycle：

* `Draft`：已建立记录，但尚未完成注册或配置
* `Provisioning`：正在配对、下载配置或验证连接
* `Active`：允许接收正式任务
* `Suspended`：临时阻止新任务，可以恢复
* `Inactive`：设备已退出日常使用
* `Retired`：永久退役，仅保留历史与审计

核心规则：

* 只有 `Active` Device 可以进入新任务 Routing 候选
* `Suspended`、`Inactive` 或 `Retired` 不自动删除历史任务
* Device 被替换时保留旧 Device ID，并创建新 Device
* `Retired` 不能直接恢复为 `Active`；如确需重新启用，先恢复为 `Inactive` 并重新 Provision
* Device 不允许物理删除

### 36.4 Device Provisioning 与 Pairing

Device Provisioning 使用一次性或短时有效的 Pairing Credential。

流程：

1. 管理员创建 Draft Device
2. 系统生成短时 Pairing Code / QR
3. 设备或 Store Agent 提交 Device Identity 与 Capability
4. 后端验证 Store、Device Type、App / Firmware Version 与 Pairing Credential
5. 建立受信 Device Credential
6. 下发当前配置
7. 完成连接测试后进入 `Active`

核心规则：

* Pairing Code 必须有 TTL，且只能成功使用一次
* 重复 Pairing Request 必须幂等
* 设备自报 Capability 不能直接信任，必须与 Adapter / Model Allowlist 验证
* Credential 轮换不改变 Device ID
* Credential 泄露或设备丢失时可以立即 Revoke
* Provisioning 失败保留失败记录，不创建重复 Device

### 36.5 Device Capability

Capability 使用结构化、版本化声明。

示例：

* `Print Text`
* `Print Raster Image`
* `Print QR / Barcode`
* `Auto Cut`
* `Cash Drawer Pulse`
* `Color Print`
* `Label Size Support`
* `Touch Input`
* `Order Acknowledgement`
* `Audio Alert`
* `Customer-facing Display`
* `Offline Queue`
* `Local Network Discovery`

核心规则：

* Routing 只把 Job 分配给满足 Required Capability 的 Device
* Capability 变化必须重新验证并保存版本
* Firmware 或 App 更新导致 Capability 降级时，Device 可以保持 Active，但不再匹配对应 Job
* Platform Hard Requirement 不能由 Store 人工伪造 Capability 绕过

### 36.6 Device Health 与 Connectivity

Device Lifecycle 与实时 Health 分开。

第一版 Health：

* `Healthy`
* `Degraded`
* `Unavailable`
* `Unknown`

Connectivity：

* `Online`
* `Offline`
* `Intermittent`
* `Not Applicable`

Health 参考：

* Heartbeat
* Last Seen At
* Job Acknowledgement Latency
* Error Rate
* Paper / Label / Cover / Cutter Status
* App / Firmware Version
* Local Agent 状态

核心规则：

* Health 变化不直接修改 Device Lifecycle
* `Unavailable` Device 不进入新 Job 的首选 Routing
* `Degraded` 可以按 Policy 继续接收低风险 Job，或进入 Fallback
* Heartbeat 暂时缺失时先进入 `Unknown`，不能立即判定设备故障
* Health Signal 采用带时间戳的追加记录，Current Health 是投影

### 36.7 Store Gateway / Local Agent

第一版支持可选的 `Store Gateway / Local Agent`，用于连接只能在局域网内访问的设备。

核心规则：

* Gateway 本身也是 Device Aggregate
* Gateway 可以代理多个 Printer、Display 或 Peripheral
* 每个下游 Device 仍拥有独立 Device ID 与 Lifecycle
* Gateway 不把多个物理设备合并成一个 Device
* Cloud 到 Gateway 的任务、Gateway 到下游设备的执行结果分别保存
* Gateway 离线时可以在受限范围内使用 Local Queue
* Local Queue 必须有容量、TTL、加密与去重机制
* Gateway 恢复后按 Job ID 对账，不能重复打印或重复显示

### 36.8 Output Job Aggregate Root

打印、显示和设备提醒统一使用独立的 `Output Job Aggregate Root`。

Output Type：

* `Print`
* `Display`
* `Alert`
* `Peripheral Action`

Job 保存：

* Output Job ID
* Brand / Store
* Source Domain / Source Reference
* Output Type
* Document / Payload Snapshot
* Template Version
* Routing Policy Version
* Required Capability
* Priority
* Created At
* Expiry / Deadline
* Idempotency Key
* Current Delivery Status

核心规则：

* Device 只被引用，不包含 Job 集合
* 一个业务事件可以产生多个 Output Job，例如 Kitchen Printer + KDS
* 每个 Job 保存当时的内容快照，后续订单或模板变化不改写已创建 Job
* Source Domain 不直接向具体硬件发送命令
* 同一业务动作重试必须复用 Idempotency Key，不能产生重复输出

### 36.9 Output Job 状态

第一版 Job Status：

* `Pending`：已创建，等待 Routing
* `Routed`：已解析目标 Device 或 Device Group
* `Dispatched`：已发送到 Device / Gateway / Adapter
* `Acknowledged`：设备或受信 Agent 已确认接收
* `Completed`：设备确认输出成功，或满足对应 Completion Policy
* `Retrying`：当前 Attempt 失败，等待重试
* `Failed`：允许的 Retry 与 Fallback 已耗尽
* `Cancelled`：在不可逆执行前被明确取消
* `Expired`：超过业务有效期限，不再执行

核心规则：

* 状态由明确 Action / Event 推进，不能仅凭时间推测 Completed
* `Acknowledged` 不一定等于物理打印成功；是否可视为 Completed 由 Device Capability 与 Completion Policy 决定
* 已经 `Completed` 的 Job 不因迟到失败事件回退
* 取消只在设备尚未执行且 Adapter 支持时有效
* Print Job 已经进入物理打印后，不能保证撤销

### 36.10 Output Attempt

每次向具体 Device 或 Adapter 投递均创建追加式 `Output Attempt`。

至少保存：

* Attempt ID
* Output Job ID
* Sequence Number
* Device ID
* Gateway / Adapter Reference
* Device Configuration Version
* Routed At / Dispatched At / Responded At
* Request ID / Provider Reference
* Idempotency Key
* Outcome
* Error Code
* Raw Status Reference
* Latency

Outcome：

* `Pending`
* `Acknowledged`
* `Completed`
* `Rejected`
* `Timed Out`
* `Device Error`
* `Adapter Error`
* `Cancelled`
* `Expired`

核心规则：

* Attempt 结束后不得覆盖或重新打开
* 技术重试是否复用同一 Attempt，由 Adapter Operation 的幂等语义决定
* 切换 Device 必须创建新 Attempt
* 历史 Attempt 必须能够还原完整投递链路

### 36.11 Routing Policy

Output Routing 使用版本化 `Device Routing Policy`。

Routing 输入：

* Store
* Output Type
* Source Domain / Document Type
* Order Type
* Kitchen Station
* Service Area / Dining Area
* Language
* Priority
* Required Capability
* Device Health
* Routing Tag

第一版解析顺序：

1. 过滤 Store Scope、Lifecycle 与 Required Capability
2. 应用明确的 Document / Station / Area Binding
3. 过滤 Health 为 Unavailable 的设备
4. 按 Routing Priority 选择 Primary Device
5. 根据 Policy 解析 Backup Device / Device Group

核心规则：

* 同一优先级出现多个无法区分的候选属于配置冲突
* 不允许随机选择关键打印设备
* Routing 结果与 Policy Version 写入 Job / Attempt
* Device 后续配置变化不改写已路由 Attempt

### 36.12 Device Group 与 Broadcast

多个 Device 可以通过独立的 `Device Group` 配置组织。

示例：

* Front Counter Printers
* Hot Kitchen KDS
* Bar Printers
* All Customer Displays

Delivery Mode：

* `Any One`：任一合格设备成功即可
* `Primary with Fallback`：主设备失败后切换备用
* `All Required`：所有目标均需成功
* `Best Effort Broadcast`：尽可能发送，不因单个失败阻断整体

核心规则：

* Group 是配置对象，不是 Device Aggregate 内部数组
* Group Membership 版本化并带 Effective Period
* Job 创建时固定实际目标解析结果
* `All Required` 的部分成功必须明确显示，不得整体伪装为成功

### 36.13 Print Document Snapshot

Print Job 保存不可变 `Print Document Snapshot`。

至少包括：

* Document Type
* Locale
* Store / Legal Entity / Receipt Header Snapshot
* Order / Payment / Kitchen / Fulfillment Reference
* 已渲染的结构化内容
* Template ID / Version
* Render Engine Version
* Page / Paper / Label Profile
* Barcode / QR Payload
* Copy Purpose
* Sensitive Data Masking Result

核心规则：

* 业务 Domain 提供事实数据，Template 负责版式
* 已创建 Job 的 Snapshot 不因模板更新而改变
* 重打印默认使用原 Snapshot，除非明确选择“按当前模板重新生成”
* 税务收据、付款凭证等受监管内容必须固定原 Template / Rule Version
* 不在设备端重新查询可变化的业务数据拼装正式凭证

### 36.14 Template Aggregate Root

输出模板建立独立的 `Output Template Aggregate Root`。

Template Type：

* Customer Receipt
* Kitchen Ticket
* Prep Label
* Order Label
* Refund Receipt
* Payment Receipt
* Pickup Slip
* Delivery Label
* Customer Display Layout
* KDS Card Layout

Template Version 保存：

* Layout Definition
* Supported Locale
* Required Data Contract Version
* Device / Paper / Screen Profile
* Conditional Section
* Branding
* Compliance Fields
* Publishing Status
* Effective Period

核心规则：

* Template 变化创建新 Version，不覆盖已发布版本
* 发布前必须验证 Data Contract 与目标 Device Profile
* Store 只能在 Brand 授权范围内覆盖
* 法定字段不能被 Store Override 删除
* 运行时必须解析出唯一有效 Template Version

### 36.15 Kitchen Routing Collaboration

Kitchen 继续拥有 Ticket、Work Item、Station 与制作状态。

协作方式：

* Kitchen 发布 Ticket / Work Item 已创建或状态变化事实
* Printing & Device Integration 根据 Kitchen Station、Document Type 与 Routing Policy 创建 KDS / Print Job
* Printer 或 KDS 输出成功不等于 Work Item 已开始或完成
* 员工在 KDS 上执行 Action 时，Action 通过 Kitchen API / Command 进入 Kitchen Domain
* Device Domain 只认证 Device / Session，并转交 Actor 与 Action Context

核心规则：

* 不能由 KDS 本地状态直接覆盖 Kitchen Aggregate
* 离线 KDS Action 仅在允许的 Action Type 下进入 Local Command Queue
* 恢复连接后必须按 Command ID 幂等提交并处理冲突

### 36.16 POS 与 Payment Terminal 边界

POS Terminal 作为 Device 管理，但 POS 应用中的 Order、Payment 与 Staff Session 仍由对应 Domain 管理。

Payment Terminal：

* Device Domain 可以保存 Payment Terminal 的 Device Reference、Store Binding、Health 与 Adapter Capability
* Payment Intent、Authorization、Capture、Refund 与敏感支付流程仍属于 Payment Domain
* Device Domain 不保存完整卡数据、PIN 或 Provider Credential
* Payment Terminal 返回结果必须由 Payment Adapter 验证后才能形成 Payment 事实

核心规则：

* “终端显示 Approved”不能单独作为 Payment Succeeded
* Terminal Reboot、Offline 或 Pairing Error 只产生 Device Exception
* Payment 状态不能由 Device Health 直接修改

### 36.17 Customer Display 与 Order Status Display

Customer-facing Display 使用 Display Job，不复制业务 Aggregate。

核心规则：

* Customer Display 只显示经过专门 View Model 与隐私过滤的内容
* Order Status Display 默认使用 Order Number / Pickup Code，不显示完整姓名或联系方式
* Display Content 必须带 TTL；过期后自动移除或替换
* Device 离线恢复时不能重新显示已经过期的旧顾客信息
* 敏感页面在 Staff Session 结束、付款完成或超时后立即清除
* 广告或 Marketing Content 与运营 Display Job 分开优先级与 Consent 判断

### 36.18 Offline Queue 与 Store Continuity

本节定义 future-trigger Store Gateway / trusted POS / KDS Offline Queue 的安全下限；第一 Pilot 不部署或启用 application Offline Queue。

允许离线缓存：

* 已经由服务器创建并签名的 Output Job
* 低风险、可幂等的 Kitchen Display Update
* 已授权的有限 Kitchen Action Command

默认不允许离线决定：

* 新 Order 的最终接受
* Payment Success
* Refund
* 权限提升
* Price / Tax 重算
* 高风险 Manager Override

核心规则：

* Offline Job / Command 必须包含签名、TTL、Sequence 与 Idempotency Key
* 超过 TTL 后不得恢复执行
* 重连后先对账，再处理未确认任务
* 冲突时服务器事实优先，保留本地原始记录并建立 Exception
* Offline Queue 容量有限，溢出必须 Alert，不能静默丢弃

### 36.19 Retry、Fallback 与 Dead-letter

每类 Output Job 使用版本化 Delivery Policy，定义：

* Acknowledgement Timeout
* Completion Timeout
* Maximum Attempts
* Retry Interval / Backoff
* Primary / Backup Device
* Fallback Channel
* Expiry
* Escalation Threshold

核心规则：

* 同一 Device 的技术重试必须使用幂等请求，避免重复打印
* 是否允许自动重打印取决于 Document Type
* Customer Receipt、Kitchen Ticket、Label 等分别配置 Duplicate Risk Policy
* 重试与 Fallback 耗尽后进入 `Failed`，并写入 Dead-letter / Exception Queue
* 非关键 Display Job 失败不阻断 Order 或 Kitchen 主流程
* 关键 Kitchen Ticket 输出全部失败时必须生成 Operations Task / Alert

### 36.20 Duplicate Print 与 Reprint

自动重试与人工 Reprint 严格分开。

自动重试：

* 目标是完成原 Output Job
* 复用原 Job ID，创建新的 Attempt
* 受 Duplicate Risk Policy 控制

人工 Reprint：

* 创建新的 Reprint Job
* 引用原 Output Job 与原 Document Snapshot
* 保存 Reprint Reason、Actor、时间与 Copy Number
* 受 Permission 控制

核心规则：

* 已确认物理打印成功后，不允许系统自动再次打印
* 状态不确定时不能盲目自动重试高重复风险凭证
* Reprint 文档应在适用场景标记 `COPY` / `REPRINT`
* 法定票据的 Reprint 必须保留原交易时间与原编号

### 36.21 Device Exception

设备与输出异常使用追加式 `Device Exception`。

第一版类型：

* Device Offline
* Paper / Label Empty
* Cover Open
* Cutter / Jam Error
* Unsupported Capability
* Configuration Conflict
* Gateway Unavailable
* Adapter Error
* Repeated Timeout
* Duplicate Risk
* Offline Queue Overflow

Lifecycle：

* `Open`
* `Acknowledged`
* `Mitigating`
* `Resolved`
* `Escalated`

核心规则：

* 同一 Device + Exception Type 同时最多一个未解决 Exception
* 重复 Signal 向当前 Exception 追加 Evidence
* Exception 不直接修改 Order、Payment、Kitchen 或 Fulfillment 状态
* 关键设备故障可以触发 Routing Fallback、Alert、Task 或 Kill Switch
* Resolution 必须保存措施、操作者、时间与最终 Health Result

### 36.22 Configuration Publishing 与 Change Impact

Device、Routing Policy、Device Group 与 Template 配置复用统一 Publishing / Approval 能力。

发布前检查：

* 至少存在一个可用目标 Device
* Required Capability 匹配
* Template 与 Data Contract 兼容
* Routing 无歧义
* Backup / Fallback 符合关键业务要求
* Device / Gateway Version 满足最低要求

核心规则：

* 配置发布不改变已经创建的 Output Job
* 删除或停用 Device 前必须显示受影响 Routing、Template 与关键业务流程
* 紧急故障可以使用 Kill Switch 阻止新 Job 路由到指定 Device / Adapter
* Change Impact 只生成警告与任务，不自动迁移所有配置

### 36.23 Security 与 Privacy

核心规则：

* Device Credential 使用短期 Token、证书或受控 Secret Reference
* Device 与 Gateway 通信必须认证、加密并防重放
* 每次 Job 与 Action 保存 Device ID、App / Firmware Version 与 Request ID
* Customer Display、Receipt 与 Label 根据用途执行字段最小化与 Masking
* 原始 Device Log 不得长期保存完整支付或顾客敏感数据
* Remote Support 必须有明确授权、时间限制与 Audit
* Lost / Stolen Device 可以立即 Revoke，并清除可远程清除的敏感缓存

### 36.24 Observability 与 Metrics

第一版指标：

* Device Online Rate
* Job Success Rate
* Acknowledgement / Completion Latency
* Retry Rate
* Fallback Rate
* Duplicate / Reprint Rate
* Offline Queue Depth
* Exception Frequency
* Template Render Failure Rate
* Adapter / Firmware Version Distribution

核心规则：

* 指标来自 Device Signal、Output Job 与 Attempt 事实
* BI 可以消费汇总 Event，但不得改写原 Job
* Health 与 SLA 投影可以重算，原始 Signal 与 Attempt 不覆盖
* 监控数据与业务敏感内容分开保存

### 36.25 Domain Events

第一版最小 Domain Event：

Device：

* `DeviceProvisioned`
* `DeviceActivated`
* `DeviceSuspended`
* `DeviceRetired`
* `DeviceCredentialRevoked`
* `DeviceHealthChanged`
* `DeviceCapabilityChanged`

Output Job：

* `OutputJobCreated`
* `OutputJobRouted`
* `OutputJobDispatched`
* `OutputJobAcknowledged`
* `OutputJobCompleted`
* `OutputJobRetrying`
* `OutputJobFailed`
* `OutputJobCancelled`
* `OutputJobExpired`
* `OutputJobReprinted`

Exception：

* `DeviceExceptionOpened`
* `DeviceExceptionEscalated`
* `DeviceExceptionResolved`
* `OfflineQueueOverflowDetected`

核心规则：

* Event 只描述已经发生的事实
* 每个 Event 包含 Event ID、Version、Brand、Store、Device / Job ID 与 Occurred At
* Output Event 包含 Source Reference、Document Type、Template Version 与 Attempt Reference
* 消费者必须幂等处理
* 非关键 Notification、BI 或 Audit 投影失败不得回滚已完成的物理输出事实

### 36.26 Open Architecture Decisions

暂时保留：

* Device Management 是否未来抽为 BOP 通用 Platform Capability
* 通用 Document Rendering / Template Engine 是否独立为 BOP Capability
* Store Gateway 是否采用自研 Agent、第三方 Edge Runtime 或混合方案
* 多门店集中 Device Fleet Management 是否在后续版本支持
* Remote Device Management、Firmware Rollout 与 MDM 是否纳入平台
* 复杂广告排期与 Digital Signage 是否拆为独立 Domain

第一版保持在 RMS Printing & Device Integration 内实现清晰边界，不提前抽象。

### 36.27 v0.1 阶段状态

Printing & Device Integration Domain v0.1 已阶段性完成并 Freeze。

Freeze 表示：

* Device、Capability、Lifecycle、Provisioning、Health 与 Gateway 边界已确认
* Output Job、Attempt、Routing、Group、Template、Retry、Fallback 与 Reprint 结构已确认
* Kitchen、POS、Payment Terminal、Customer Display 与 Offline Queue 的协作边界已确认
* Device Exception、Security、Observability 与 Domain Event 已确认
* 具体厂商 SDK、驱动、纸张命令、UI、网络部署与硬件采购型号留到实现阶段
* 后续讨论不重新展开已经确认的核心结构

---


## 历史讨论节点 H-037（已完成）

Business Intelligence Domain 的核心分层已经确定：

* Operational Reporting、Analytics Warehouse 与 Metric Definition 分层建模
* Operational Reporting 服务当前经营查询，不作为长期分析事实来源
* Analytics Warehouse 保存跨 Domain、跨时间的分析模型
* Metric Definition 统一定义指标语义、粒度、过滤、时间口径与版本
* BI 不改写业务 Domain 的原始交易事实

---

## 38. Business Intelligence Domain

### 38.1 职责边界

Business Intelligence 负责：

* 汇聚各业务 Domain 的事实 Event、Snapshot 与受控数据导出
* 建立 Operational Reporting Projection
* 建立 Analytics Warehouse 的 Fact、Dimension 与 Aggregate
* 管理 Metric Definition、KPI Catalog 与语义版本
* 提供实时、近实时与批量分析查询
* 支持 Store、Brand、Region、Channel、Order Type 与时间维度分析
* 管理报表、Dashboard、Export 与 Scheduled Delivery
* 执行数据质量、迟到数据、重放、重算与血缘追踪
* 向管理者提供经营洞察，但不替代业务 Domain 做业务决定

Business Intelligence 不负责：

* 创建或修改 Order、Payment、Inventory、Kitchen、Fulfillment 等业务事实
* 作为交易流程的强一致依赖
* 直接修复源 Domain 的错误数据
* 重新定义 Tax、Revenue、Refund、Inventory Cost 等业务语义
* 保存银行卡、密码、完整认证凭证或不必要的敏感原始内容
* 代替 Finance / Accounting 建立法定总账

核心边界：

**业务 Domain 拥有事实与业务语义；BI 负责在明确口径下投影、汇总、比较和解释这些事实。**

### 38.2 三层分析模型

第一版明确分为三层：

1. `Operational Reporting Layer`
2. `Analytics Warehouse Layer`
3. `Metric Semantic Layer`

Operational Reporting Layer：

* 面向当前经营状态与短周期查询
* 由业务 Event 构建可重算 Projection
* 支持订单队列、今日销售、当前库存、设备异常等运营视图
* 允许最终一致，不成为业务写入的事实来源

Analytics Warehouse Layer：

* 保存历史 Fact、Dimension、Snapshot 与 Aggregate
* 支持跨 Domain、跨门店、跨时间分析
* 面向趋势、对比、归因、预测输入与长期留存

Metric Semantic Layer：

* 定义指标名称、公式、粒度、过滤、时间语义和版本
* 为 Dashboard、Report、API 与 Export 提供统一指标口径
* 不把复杂指标公式散落在每个页面或 SQL 中

### 38.3 Operational Reporting Projection

Operational Reporting Projection 是可重建的查询模型，不是 Aggregate Root。

第一版典型 Projection：

* Current Order Board
* Current Kitchen Queue
* Current Fulfillment Board
* Store Daily Sales Summary
* Current Inventory Availability
* Current Reservation / Waitlist View
* Device Health Dashboard
* Open Exception Dashboard

核心规则：

* Projection 只消费已发生的事实 Event
* Projection 可以重算、重建或删除后恢复
* Projection 延迟不得阻断交易流程
* Projection 中的当前值不得反向覆盖源 Domain
* 需要强一致判断时必须查询对应业务 Domain，而不是依赖 BI Projection
* 每个 Projection 保存 Last Processed Event / Checkpoint 与 Freshness 状态

### 38.4 Analytics Warehouse 分层

第一版采用：

`Raw Event / Extract → Conformed Fact & Dimension → Aggregate / Data Mart`

Raw Layer：

* 保存经过验证、标准化的源 Event Envelope 或抽取记录
* 保留 Source Domain、Schema Version、Occurred At、Received At 与 Payload Hash
* 不把 Raw Layer 直接暴露给普通报表用户

Conformed Layer：

* 建立跨 Domain 可连接的 Fact 与 Dimension
* 统一 Brand、Store、Business Date、Currency、Channel 等公共维度

Aggregate / Data Mart：

* 为高频 Dashboard 与业务主题建立可重算汇总
* 例如 Sales、Kitchen、Inventory、Customer、Delivery、Procurement、Device

### 38.5 Fact 建模原则

第一版核心 Fact 包括：

* Order Fact
* Order Item Fact
* Payment Transaction Fact
* Refund Fact
* Kitchen Work Item Fact
* Fulfillment / Delivery Attempt Fact
* Inventory Movement Fact
* Goods Receipt Fact
* Purchase Order Line Fact
* Reservation / Waitlist Fact
* Loyalty Points Transaction Fact
* Device Output Attempt Fact

核心规则：

* Fact 粒度必须明确且不可含糊
* 同一 Fact Row 对应一个稳定业务事实或明确快照粒度
* 不把多个不同粒度混入同一 Fact
* Monetary Fact 必须保存 Currency、Amount、Source Reference 与 Accounting / Business Date Context
* 更正通过新的 Source Fact 或 BI Correction Mapping 表达，不覆盖原始事实
* 每个 Fact 必须可追溯到 Source Domain、Aggregate、Event 或 Snapshot

### 38.6 Dimension 建模原则

第一版公共 Dimension：

* Date
* Time
* Business Date
* Brand
* Store
* Region / Store Group
* Channel
* Order Type
* Product / SKU
* Category
* Customer Segment
* Staff / Role Snapshot
* Supplier
* Inventory Item
* Device

核心规则：

* Dimension 使用稳定业务 ID 与 BI Surrogate Key 分开保存
* 需要历史分析的属性使用 Slowly Changing Dimension
* 名称、分类、门店归属等历史变化不得改写过去分析语境
* 敏感身份默认使用受控、去标识化或聚合后的 Dimension
* 不在 BI 中自行创造新的业务身份

### 38.7 Slowly Changing Dimension

第一版默认：

* Type 1：仅用于明确无历史意义的纠错字段
* Type 2：用于会影响历史分析语境的属性变化

Type 2 至少保存：

* Effective From
* Effective To
* Is Current
* Source Version
* Change Reason / Source Event

典型 Type 2 场景：

* Product Category 归属变化
* Store Group / Region 变化
* Supplier Classification 变化
* Customer Segment 变化
* Device Capability 变化

历史交易必须关联当时有效的 Dimension Version。

### 38.8 Time 与 Business Date

BI 必须区分：

* Event Occurred At
* Source Recorded At
* BI Received At
* Store Local Date / Time
* Business Date
* Settlement Date

核心规则：

* 内部时间统一保存 UTC
* Store Local Time 根据当时 Store IANA Time Zone 解析
* Business Date 使用业务 Domain 已确认的营业日，不由 BI按午夜自行推断
* 跨午夜营业必须归属正确 Business Date
* 迟到 Event 仍按实际 Occurred At 与 Business Date 回填
* Dashboard 必须明确展示使用的时间口径

### 38.9 Currency 与金额口径

BI 中所有金额必须保留原 Currency。

核心规则：

* 不静默把不同 Currency 直接相加
* 多币种汇总必须明确使用原币分组，或使用版本化 FX Conversion
* FX Rate 保存 Source、Rate Date、Rate Type 与 Version
* Order Revenue、Payment Captured、Provider Cost、Tax、Tip 与 Refund 分开建模
* BI 不把 Payment Settlement 当作 Order Revenue
* 法定财务口径由未来 Finance / Accounting 决定，BI 只提供来源清晰的分析指标

### 38.10 Metric Definition Aggregate Root

Metric Definition 建立独立 Aggregate Root，并采用版本化配置。

稳定身份保存：

* Metric ID
* Metric Code
* Owner Domain / Business Owner
* Lifecycle

Metric Version 保存：

* Display Name
* Business Definition
* Formula / Expression Reference
* Base Fact
* Grain
* Dimensions Allowed
* Required Filters
* Time Semantics
* Currency Semantics
* Inclusion / Exclusion Rules
* Null / Missing Data Policy
* Effective Period
* Certification Status

核心规则：

* 指标口径变化创建新 Metric Version
* 历史 Dashboard / Report 保存所用 Metric Version
* 指标不得仅以名称表达，必须有可执行或可验证定义
* Metric Definition 不能改写底层 Fact

### 38.11 Metric Lifecycle 与 Certification

第一版 Metric Lifecycle：

* `Draft`
* `In Review`
* `Certified`
* `Deprecated`
* `Archived`

核心规则：

* 只有 `Certified` Metric 默认用于正式管理 Dashboard
* Draft Metric 可以在 Sandbox 使用，但必须明确标识
* Deprecated Metric 保留历史查询能力，并指向 Replacement Metric（如有）
* 认证必须包含 Business Owner 与 Data Owner
* 实质公式或口径变化必须重新 Review
* 拼写、描述等不影响结果的修正可以使用受控 Minor Revision

### 38.12 KPI Catalog

KPI 是被业务目标正式采用的 Certified Metric，不另建完全独立计算体系。

KPI Catalog 至少保存：

* KPI ID
* Metric Version Reference
* Business Objective
* Owner
* Target / Threshold
* Evaluation Period
* Scope
* Direction：Higher / Lower / Range
* Warning / Critical Threshold
* Effective Period

核心规则：

* Target 与实际 Metric 结果分开
* Target 变化不改写历史 KPI 结果
* KPI Alert 只产生通知或任务，不自动修改业务状态
* 同一 Metric 可以在不同 Store 或时期拥有不同 Target

### 38.13 核心指标口径边界

第一版至少明确以下概念不能混用：

* Gross Sales
* Net Sales
* Collected Amount
* Captured Payment
* Refunded Amount
* Tax
* Tip
* Service Charge
* Discount
* Provider Delivery Cost
* Inventory Consumption Cost
* Waste Cost

示例原则：

* Gross Sales 基于确认的销售金额，不等于实际已收款
* Net Sales 必须明确是否扣除 Discount、Void、Refund 与 Tax
* Tip 不默认计入 Sales
* Tax 不默认计入 Revenue
* Refund 与 Order Cancellation 分开统计
* Closed Order 不代表 Payment 已 Settled

具体法定会计定义留给 Finance / Accounting Domain。

### 38.14 Near-real-time 与 Batch

第一版同时支持：

* Near-real-time Projection
* Micro-batch Warehouse Load
* Daily Reconciliation Batch

核心规则：

* 运营 Dashboard 优先使用 Near-real-time Projection
* 长期趋势与正式分析优先使用 Warehouse
* 页面必须显示 Data Freshness / Last Updated At
* Near-real-time 与 Warehouse 出现差异时，不静默覆盖；进入 Reconciliation
* 不要求所有指标都实时计算
* 高成本指标可以使用预计算 Aggregate

### 38.15 Event Ingestion 与幂等

BI Event Ingestion 至少保存：

* Source Event ID
* Source Domain
* Event Type / Version
* Aggregate ID / Version
* Brand / Store
* Occurred At / Received At
* Payload Hash
* Processing Status
* Retry Count

核心规则：

* 使用 Source Event ID 幂等去重
* 同一 Aggregate 内按必要顺序处理
* 乱序 Event 不丢弃，进入迟到或重排处理
* 未识别 Schema Version 进入 Quarantine
* BI 处理失败不得回滚源业务 Transaction
* Event 重放必须可区分 Replay 与新的业务事实

### 38.16 Late-arriving Data

迟到数据按原业务时间回填，不按 BI 到达时间伪装为新业务。

核心规则：

* 保存 Occurred At 与 Received At 差异
* 受影响的 Aggregate、Partition 与 Metric Window 进入 Recalculation
* 已发送的 Report 不被静默替换；生成新 Revision 或 Data Correction Notice
* 迟到数据超过可配置阈值时建立 Data Quality Incident
* Dashboard 可以显示 Preliminary / Finalized 状态

### 38.17 Correction、Rebuild 与 Backfill

BI 数据更正分为：

* Source Correction：源 Domain 发布新的 Correction / Reversal Fact
* Pipeline Correction：BI 修复解析、映射或计算错误
* Backfill：补载历史数据
* Rebuild：从可信事实重新生成 Projection / Aggregate

核心规则：

* 不直接修改 Raw Source Fact
* Pipeline Correction 保存变更范围、原因、代码 /规则版本与执行人
* Backfill 使用独立 Run ID 与 Idempotency Key
* 重建前后必须做数量、金额和主键对账
* 对外发布结果发生实质变化时必须保留 Revision 与影响说明

### 38.18 Data Quality Framework

第一版 Data Quality Check：

* Completeness
* Uniqueness
* Referential Integrity
* Valid Range
* Timeliness
* Reconciliation
* Schema Compatibility
* Currency / Time Zone Consistency

Data Quality Result 至少保存：

* Check ID / Version
* Dataset / Partition
* Rule
* Expected Result
* Actual Result
* Severity
* Detected At
* Resolution

Severity：

* `Info`
* `Warning`
* `Error`
* `Critical`

Critical 数据问题可以暂停正式报表发布，但不能暂停业务交易。

### 38.19 Reconciliation

第一版必须支持：

* Order Total 与 Order Item 汇总对账
* Captured / Refunded Payment 与 Payment Ledger 对账
* Inventory Balance Projection 与 Stock Ledger 对账
* Purchase Order Received Quantity 与 Goods Receipt 对账
* Loyalty Balance 与 Points Ledger 对账
* Output Job Summary 与 Attempt 对账

核心规则：

* 差异生成 Reconciliation Exception
* 不允许 BI 自动修改源 Domain
* Exception 保存 Source、Expected、Actual、Difference 与 Investigation Result
* 解决后重新运行对账并保留历史结果

### 38.20 Report Definition

Report Definition 建立独立、版本化 Aggregate Root。

Report Version 保存：

* Report Name
* Purpose
* Metric Version References
* Dimensions / Filters
* Default Time Range
* Layout / Visualization Definition
* Data Freshness Requirement
* Access Policy
* Export Policy
* Effective Period

核心规则：

* 正式 Report 固定 Metric Version
* 修改指标或过滤逻辑创建新 Report Version
* Dashboard 只是 Report / Widget 的组合，不复制指标公式
* 报表发布使用统一 Publishing Workflow

### 38.21 Dashboard 与 Widget

Dashboard 保存：

* Dashboard ID
* Owner Scope
* Widget Placement
* Filter Context
* Refresh Policy
* Visibility / Sharing Policy

Widget 引用：

* Metric
* Report Query
* Visualization Type
* Drill-down Definition

核心规则：

* Visualization 不得改变 Metric 计算结果
* Drill-down 必须保持粒度与权限一致
* Dashboard Cache 可以重建
* Personal Dashboard 与 Certified Management Dashboard 明确区分

### 38.22 Scheduled Report 与 Export

Scheduled Report：

* 使用版本化 Schedule
* 保存 Recipient Scope、Format、Time Zone 与 Delivery Channel
* 运行时固定 Report Version 与 Metric Version
* 每次生成 Report Run Record

Export：

* 支持 CSV、Spreadsheet、PDF 等受控格式
* 大型 Export 使用异步 Job
* Export 文件保存过期时间、下载审计与敏感级别
* 已生成文件不因后续数据变化而静默改变
* 重新生成创建新 Export Revision

实际 Email、Push 或文件通知由 Notification / Output 能力处理。

### 38.23 Report Run Record

每次正式报表运行至少保存：

* Report Run ID
* Report Version
* Metric Versions
* Scope / Filters
* Data As Of
* Warehouse / Projection Checkpoint
* Generated At
* Status
* Row Count / Summary Hash
* Output Asset Reference
* Triggered By

第一版状态：

* `Queued`
* `Running`
* `Completed`
* `Completed with Warning`
* `Failed`
* `Cancelled`

Report Run 采用追加式记录，不覆盖已经发布的结果。

### 38.24 数据权限与范围隔离

BI 权限必须同时检查：

* Platform / Brand / Store Scope
* Role / Permission
* Data Classification
* Metric / Report Access Policy
* Row-level Scope
* Export Permission

核心规则：

* Brand 默认不能访问其他 Brand 数据
* Store 用户默认只访问授权 Store
* Platform Benchmark 必须去标识化并满足最小样本阈值
* 前端隐藏不等于权限控制，后端查询必须执行范围过滤
* Export 权限可以比 Dashboard 查看权限更严格
* 权限变化对后续访问立即生效，但不改写历史 Report Run

### 38.25 Sensitive Data 与去标识化

第一版 Data Classification：

* `Public / Non-sensitive`
* `Internal`
* `Confidential`
* `Restricted`

核心规则：

* BI 默认不复制完整手机号、Email、地址或身份凭证
* Customer 分析优先使用 Customer Profile ID、Segment 与匿名标识
* 需要明细时采用 Masking、Tokenization 或受控 Lookup
* 小样本分析应用 Minimum Group Size，降低重新识别风险
* 敏感字段访问与 Export 必须记录 Audit
* Retention 与删除要求由 Compliance & Food Safety / Privacy Policy 提供

### 38.26 Customer 360 与跨 Brand 边界

第一版不建立可被 Merchant 使用的跨 Brand Customer 360。

核心规则：

* Brand 只能分析自己的 Customer Profile 与 Loyalty 数据
* Platform 可以进行受控、去标识化的跨 Brand Aggregation
* 不因手机号或 Email 相同在 BI 中自动合并身份
* Identity Merge Event 只更新受控关联，不改写历史交易 Actor
* 跨 Brand Benchmark 不暴露竞争品牌、门店或顾客明细

### 38.27 Benchmarking

第一版 Benchmark 可支持：

* Brand 内 Store Comparison
* Store Group / Region Comparison
* 时间区间 Comparison
* 匿名 Platform Percentile（未来可启用）

核心规则：

* 使用相同 Certified Metric Version
* 不同 Currency、Time Zone 或 Business Calendar 必须先统一口径
* Platform Benchmark 需要最小参与样本
* 不返回可推断单个其他 Brand 的结果
* Benchmark 结果保存 Calculation Version 与 Cohort Definition

### 38.28 Alert 与 Anomaly Signal

BI 可以产生：

* Threshold Alert
* Trend Deviation Signal
* Data Quality Alert
* Forecast Variance Signal

核心规则：

* Alert / Signal 不直接修改 Order、Inventory、Price 或 Staff 状态
* 通过 Notification、Task 或 Operations Workflow 处理
* 每个 Signal 保存 Metric Version、Expected Range、Observed Value、Window 与算法版本
* 第一版以确定性 Threshold 和简单统计规则为主
* 机器学习异常检测留到后续版本

### 38.29 Forecast 与预测边界

第一版可以提供基础 Forecast 输入与确定性预测：

* Sales Forecast
* Demand / Inventory Need Forecast
* Kitchen Load Forecast
* Staffing Demand Input

核心规则：

* Forecast 与 Actual 分开保存
* 每次 Forecast 保存 Model / Rule Version、Training Window、Generated At 与 Confidence Range
* Forecast 不能自动创建 Purchase Order、调整价格或排班
* 自动行动必须由对应 Domain 的明确 Policy 与 Approval 决定
* 第一版不把高级 ML 平台作为 BI 核心前置条件

### 38.30 Retention、Archive 与 Legal Hold

BI Dataset、Report Run 与 Export 使用分类化 Retention Policy。

核心规则：

* Raw、Fact、Aggregate、Report 与 Export 可以拥有不同保留期限
* 到期删除不能破坏法定审计或正在进行的 Legal Hold
* 删除优先去除或匿名化个人数据，不随意删除必要财务事实
* Legal Hold 由未来 Compliance / Privacy 能力控制
* Retention Job 必须产生可审计结果

### 38.31 Lineage 与可解释性

每个 Certified Metric 与正式 Report 必须可追踪：

`Report → Metric Version → Aggregate / Fact → Source Event / Snapshot`

至少保存：

* Source Dataset
* Transformation Version
* Query / Expression Reference
* Dependency Graph
* Last Successful Build
* Data Freshness
* Data Quality Status

核心规则：

* 管理者应能查看指标定义与更新时间
* 数据团队应能定位结果来自哪些事实
* 变更影响分析在发布新 Metric / Report Version 前执行

### 38.32 BI Pipeline Run

每次 Pipeline 执行保存独立 Run Record：

* Pipeline Run ID
* Pipeline / Transformation Version
* Input Checkpoint
* Output Partition
* Started / Completed At
* Status
* Records Read / Written / Rejected
* Data Quality Result
* Error Reference

状态：

* `Queued`
* `Running`
* `Succeeded`
* `Succeeded with Warning`
* `Failed`
* `Cancelled`

失败重试使用同一逻辑批次的 Idempotency Key，不能重复生成 Fact。

### 38.33 BI Domain Events

第一版最小 Domain Event：

Metric：

* `MetricDefinitionPublished`
* `MetricCertified`
* `MetricDeprecated`

Report：

* `ReportPublished`
* `ReportRunStarted`
* `ReportRunCompleted`
* `ReportRunFailed`
* `ScheduledReportDelivered`

Data Pipeline / Quality：

* `AnalyticsLoadCompleted`
* `AnalyticsLoadFailed`
* `DataQualityIssueDetected`
* `DataQualityIssueResolved`
* `ReconciliationDifferenceDetected`
* `AnalyticsBackfillCompleted`

Alert：

* `MetricThresholdBreached`
* `AnalyticsAnomalyDetected`

核心规则：

* BI Event 只描述分析与数据处理事实
* 业务 Domain 不应依赖 BI Event 完成核心 Transaction
* Event 包含 Brand / Store Scope、Metric / Report / Run ID、Version 与 Occurred At
* 消费者必须幂等处理
* BI 失败不能回滚源业务事实

### 38.34 Open Architecture Decisions

暂时保留：

* Analytics Warehouse 使用单一平台 Warehouse、Brand 隔离 Schema，还是混合部署
* Semantic Layer 是否未来抽为 BOP 通用 Metric Platform
* 是否引入独立 Streaming Platform
* 高级 ML Feature Store 与 Model Registry 是否归入 BI
* Finance / Accounting 建立后，法定财务报表与 BI 的最终边界
* Privacy / Data Governance 是否抽为独立 BOP Capability
* Embedded Analytics 是否允许 Merchant 自建 Query 与 Dashboard

第一版保持模块化边界，不提前拆分独立数据平台 Domain。

### 38.35 v0.1 阶段状态

Business Intelligence Domain v0.1 已阶段性完成并 Freeze。

Freeze 表示：

* Operational Reporting、Analytics Warehouse 与 Metric Semantic Layer 的分层已确认
* Fact、Dimension、SCD、Time、Currency 与指标版本化原则已确认
* Event Ingestion、Late Data、Correction、Backfill、Rebuild 与 Reconciliation 已确认
* Metric、KPI、Report、Dashboard、Export 与 Scheduled Report 边界已确认
* 权限、去标识化、Benchmark、Alert、Forecast、Retention 与 Lineage 已确认
* 具体 Warehouse 产品、BI 工具、SQL 引擎、图表库与云部署留到实现阶段
* 后续讨论不重新展开已经确认的核心结构

---

## 历史讨论节点 H-039（已完成）

Compliance & Food Safety Domain 的核心模型已经确定：

* 许可证、检查、温度记录、过敏原控制、清洁、员工资质、监管审计、食品安全 Incident 与整改统一使用 `Compliance Case / Record` 模型
* 建立独立的 `Compliance Case Aggregate Root`
* Compliance 负责监管要求、检查、证据、整改、验证与审计，不改写 Kitchen、Inventory、Recipe、Procurement 等 Domain 的业务事实
* 统一 Canonical Lifecycle 为 `Open`、`Investigating`、`Corrective Action`、`Verification` 与 `Closed`
* 特殊类型可以跳过不适用阶段，但必须保留追加式历史

---

## 40. Compliance & Food Safety Domain

### 40.1 职责边界

Compliance & Food Safety 负责：

* 法规、许可、食品安全与经营合规要求的版本化管理
* Store、Kitchen、Storage Location、Employee、Supplier、Inventory Item、Recipe 与设备相关的 Compliance Scope
* License / Permit、Inspection、Monitoring、Certification、Incident、Investigation 与 Corrective Action
* 温度、清洁、过敏原、交叉污染、保质期、召回与员工食品安全资质记录
* 监管检查、内部检查、自检、第三方审核与整改验证
* 合规证据、Deadline、Escalation、Regulatory Notification 与 Audit Trail
* 向其他 Domain 发布合规限制、风险与已验证结果

Compliance & Food Safety 不负责：

* Recipe、库存、采购、厨房制作、配送或订单状态本身
* 代替主管机关作出法律解释
* 直接修改 Product、Inventory Item、Supplier、Employee 或 Device 主数据
* 直接执行退款、取消、报废、停业或召回交易
* 会计、保险理赔或诉讼管理

核心边界：

**Compliance 记录“适用什么要求、发现什么事实、采取什么整改并如何验证”；业务 Domain 继续拥有其实际运营动作与交易事实。**

### 40.2 Compliance Case Aggregate Root

第一版统一建立 `Compliance Case Aggregate Root`。

Compliance Type 包括：

* `License / Permit`
* `Food Safety Inspection`
* `Temperature Monitoring`
* `Allergen Control`
* `Cleaning & Sanitation`
* `Employee Certification`
* `Supplier / Product Compliance`
* `Regulatory Audit`
* `Food Safety Incident`
* `Compliance Investigation`
* `Corrective Action`
* `Recall / Withdrawal`
* `Other`

核心规则：

* 不同类型共用 Case Identity、Lifecycle、Evidence、Finding、Action、Deadline 与 Audit
* 每个 Case 拥有独立稳定 ID
* Case 可以引用多个业务对象，但不把完整业务对象复制进 Aggregate
* 同一原始问题只能存在一个 Active Primary Case，相关记录通过 Child / Related Case 关联
* 跨 Store 或跨 Brand 的大规模事件可以由多个 Case 关联到一个 Operations Incident；第一版不合并成超大 Aggregate

### 40.3 Compliance Case Lifecycle

统一 Canonical Lifecycle：

* `Open`
* `Investigating`
* `Corrective Action`
* `Verification`
* `Closed`

补充状态：

* `On Hold`
* `Escalated`
* `Cancelled`

核心规则：

* License Renewal、Routine Inspection 等可以跳过 `Investigating`
* 没有整改事项的检查可以从 `Open` 直接进入 `Verification` 或 `Closed`
* `Closed` 前必须所有 Critical Finding 已解决、接受风险或正式移交监管处理
* `Cancelled` 只用于错误创建、重复 Case 或确认不适用；必须保存原因
* `Closed` 后发现新问题创建新 Case，不重开旧 Case；原结论错误时追加 Correction Record

### 40.4 Case Scope 与关联对象

Compliance Case 可以关联：

* Brand
* Legal Entity
* Store
* Dining Area / Kitchen Station / Storage Location
* Employee / Membership / Qualification
* Supplier / Supplier Item Offering
* Inventory Item / Lot / Batch
* Product / SKU / Recipe / Allergen Definition
* Device / Sensor
* Order / Kitchen Ticket / Fulfillment / Delivery Task
* External Authority / Inspector

核心规则：

* Case 保存稳定 Reference 与必要 Snapshot
* 业务对象后续改名或配置变化不改变 Case 当时证据
* 一个 Case 可以有 Primary Scope 与多个 Supporting Scope
* Scope 变化通过 Case Revision 追加保存

### 40.5 Compliance Policy 与 Regulatory Requirement

建立版本化 `Compliance Policy / Regulatory Requirement` 配置。

至少保存：

* Requirement ID
* Jurisdiction
* Authority
* Requirement Type
* Applicable Scope
* Effective Period
* Mandatory / Advisory
* Evidence Requirement
* Monitoring Frequency
* Threshold / Limit
* Retention Period
* Escalation Rule
* Regulatory Notification Requirement
* Policy Version

核心规则：

* 法规内容变化创建新 Version，不覆盖旧要求
* Case、Inspection、Monitoring Record 保存实际使用的 Requirement Version
* Platform 可以提供模板；Brand 与 Store 只能在允许范围增加更严格规则，不能降低 Hard Requirement
* 法律解释不确定时标记 `Legal Review Required`，不得静默猜测

### 40.6 License / Permit Record

License / Permit 使用 Compliance Case 与内部 `License Record`。

至少保存：

* License Type
* Authority
* Licence / Permit Number
* Holder Legal Entity
* Store / Scope
* Issued At
* Effective From
* Expiry Date
* Renewal Window
* Status
* Document Reference
* Verification Result

状态：

* `Draft`
* `Pending Verification`
* `Active`
* `Expiring`
* `Expired`
* `Suspended`
* `Revoked`
* `Closed`

核心规则：

* 到期前按 Policy 自动提醒并生成 Renewal Task
* `Expired`、`Suspended` 或 `Revoked` 不自动删除历史交易
* 是否阻止新订单、采购、生产或营业，由 Kill Switch / Workflow 与对应 Domain 执行
* 更新证照创建新版本或新 Record，旧证照永久保留

### 40.7 Inspection Record

Inspection Record 作为 Case 内追加式 Entity。

Inspection Type：

* `Internal Self-Inspection`
* `Manager Inspection`
* `Third-party Audit`
* `Regulatory Inspection`
* `Triggered Investigation`

每次 Inspection 至少保存：

* Inspection ID
* Checklist / Requirement Version
* Scope
* Inspector / Authority
* Scheduled / Started / Completed At
* Finding
* Score / Rating（如适用）
* Evidence Reference
* Immediate Action
* Follow-up Requirement

核心规则：

* Checklist 版本固定，后续修改不改变历史 Inspection
* 原始 Finding 不允许覆盖
* 错误通过 Inspection Correction 追加更正
* 监管机构原始评级与内部评级分开保存

### 40.8 Finding 与 Severity

每个 Finding 具有稳定 ID。

Severity：

* `Observation`
* `Minor`
* `Major`
* `Critical`
* `Immediate Danger`

Finding Status：

* `Open`
* `Accepted Risk`
* `Corrective Action In Progress`
* `Pending Verification`
* `Resolved`
* `Not Applicable`

核心规则：

* Severity 与 Status 分开
* `Critical` 或 `Immediate Danger` 必须触发明确 Escalation
* `Accepted Risk` 只允许非 Hard Requirement，并需要授权与到期复审
* Finding 解决不删除原 Finding
* 同一 Finding 的证据、评论与状态变化追加保存

### 40.9 Corrective Action Aggregate 边界

第一版 Corrective Action 作为 Compliance Case 内具有稳定 ID 的 Entity，不建立独立 Aggregate Root。

至少保存：

* Corrective Action ID
* Finding ID
* Required Action
* Owner
* Due Date
* Priority
* Status
* Completion Evidence
* Verified By / At
* Outcome

状态：

* `Planned`
* `In Progress`
* `Blocked`
* `Completed`
* `Verification Failed`
* `Verified`
* `Cancelled`

核心规则：

* 业务动作仍由对应 Domain 执行
* Compliance Action 只引用实际 Action / Event
* `Completed` 不等于 `Verified`
* 原责任人变化保留 Assignment History
* 逾期自动 Escalate，但不自动伪造完成

### 40.10 Verification

Case 进入 `Verification` 时，系统检查：

* 所有 Mandatory Corrective Action 已完成
* 所有 Critical Finding 已有有效处理结果
* 必要 Evidence 完整
* Required Reinspection 已完成
* Regulatory Notification 已提交或确认不需要
* 相关业务 Domain 的 Action Reference 有效

Verification Result：

* `Passed`
* `Passed with Conditions`
* `Failed`
* `Unable to Verify`

核心规则：

* 执行整改的人员不能单独验证自己的高风险 Action
* `Failed` 返回 `Corrective Action`
* `Unable to Verify` 保持 Case 非关闭状态并建立任务
* 条件通过必须保存条件、有效期与后续复审日期

### 40.11 Temperature Monitoring Record

温度记录不为每次读数创建独立 Compliance Case。

采用：

* `Temperature Monitoring Policy`
* 追加式 `Temperature Reading Record`
* 仅在异常、缺失或设备故障达到阈值时创建 Compliance Case

Reading 至少保存：

* Reading ID
* Store / Location / Equipment / Inventory Scope
* Sensor / Device Reference
* Measurement Type
* Value 与 Unit
* Measured At
* Captured At
* Method：Manual / Sensor / Imported
* Operator
* Policy Version
* Threshold Result
* Calibration Reference

核心规则：

* 原始 Reading 不覆盖
* 手工更正创建 Correction Reading
* 设备离线不自动假设温度正常或异常
* 超阈值、缺失窗口或异常趋势根据 Policy 建立 Alert / Case

### 40.12 Temperature Excursion

温度超限产生 `Temperature Excursion Record`，必要时关联 Compliance Case。

至少保存：

* Excursion ID
* Start / End
* Maximum / Minimum Deviation
* Affected Location / Lot / Item
* Detection Source
* Immediate Containment
* Product Disposition Reference
* Root Cause
* Resolution

核心规则：

* 超限不直接自动报废库存
* Inventory / Food Safety Policy 决定 Hold、Release、Dispose 或 Recall
* 在处置确认前受影响库存进入受控 Hold
* 合规记录保留判断依据，不改写 Stock Ledger

### 40.13 Cleaning & Sanitation

Cleaning Schedule 使用版本化 Policy。

支持：

* Area / Equipment 清洁频率
* Cleaning Method
* Chemical / Concentration Requirement
* Responsible Role
* Verification Method
* Missed Task Escalation

每次执行形成 Cleaning Record：

* Task / Schedule Reference
* Performed By
* Started / Completed At
* Method / Chemical Snapshot
* Verification Result
* Evidence / Exception

核心规则：

* 清洁任务未完成或验证失败达到阈值时创建 Compliance Finding / Case
* 清洁记录不能以勾选框覆盖历史
* 化学品与浓度异常应触发 Safety Review

### 40.14 Allergen Control

Allergen Control 负责监管与安全控制，不取代 Recipe / Catalog 的 Allergen 定义。

记录：

* Applicable Allergen Policy Version
* Product / Recipe / Ingredient Allergen Reference
* Cross-contact Control
* Label / Menu Disclosure Verification
* Staff Training Requirement
* Allergen Incident

核心规则：

* Catalog / Recipe 是声明与来源事实
* Compliance 验证声明、流程与实际操作是否符合要求
* 过敏原信息冲突属于 Critical Finding
* 过敏原相关 Order / Kitchen Incident 需要保存当时配置与操作 Snapshot
* 未经验证不得通过员工口头保证“无过敏原”

### 40.15 Employee Certification

食品安全、酒类服务或其他法定员工资质通过 `Employee Qualification Record` 管理。

至少保存：

* Qualification Type
* Employee / Membership Reference
* Jurisdiction
* Certificate Number
* Issuer
* Effective From / Expiry Date
* Status
* Document Reference
* Verified At / By

核心规则：

* 到期前提醒
* 过期后是否阻止排班或特定 Action，由 Permission / Workforce / Workflow 执行
* Compliance 发布 Qualification Status，不直接修改 Identity
* 新证书创建新 Record，不覆盖旧证书

### 40.16 Supplier 与 Product Compliance

Supplier / Inventory Item 相关合规通过 Case 与 Requirement 关联。

包括：

* Supplier Qualification
* Product Certificate
* Country / Origin Requirement
* Import / Export Requirement
* Food Contact Packaging
* Restricted Ingredient
* Recall Status
* Traceability Requirement

核心规则：

* Procurement 继续拥有 Supplier 与 Offering
* Inventory 继续拥有 Lot、Receipt 与 Stock
* Compliance 判断资质与要求是否满足，并发布 Restriction / Hold 事实
* 已发出的 PO 与已收货事实不被合规记录改写

### 40.17 Food Safety Incident

Food Safety Incident 使用 Compliance Case，Incident Type 包括：

* Suspected Foodborne Illness
* Allergen Exposure
* Contamination
* Foreign Object
* Temperature Abuse
* Pest / Sanitation Failure
* Mislabeling
* Regulatory Complaint
* Employee Health Risk
* Other

至少保存：

* Incident Time / Reported Time
* Reporter
* Store / Product / Order / Lot / Employee Scope
* Symptoms / Allegation Snapshot
* Immediate Containment
* Evidence
* Notification
* Investigation
* Outcome

核心规则：

* Incident 建立后立即保护证据
* 不因投诉本身直接认定责任
* 医疗或健康敏感信息使用严格权限与 Retention
* 退款、赔偿、召回、报废和停业由对应 Domain / Operations 正式执行

### 40.18 Evidence Model

Evidence 统一保存 Asset Reference，不直接嵌入 Aggregate。

Evidence Type：

* Document
* Photo / Video
* Sensor Reading
* Signature
* Checklist
* Lab Result
* External Authority Record
* System Event / Snapshot
* Statement / Interview Note

核心规则：

* 保存 Hash、Source、Captured At、Owner、Access Class 与 Retention Policy
* 原始 Evidence 不覆盖
* 更正、翻译或标注作为派生版本
* Chain of Custody 对高风险 Incident 必须可追踪
* 删除受 Legal Hold 与 Retention Policy 控制

### 40.19 Regulatory Notification

需要向主管机关报告时，建立 `Regulatory Notification Record`。

状态：

* `Required`
* `Preparing`
* `Submitted`
* `Acknowledged`
* `Rejected / Returned`
* `Completed`
* `Not Required`

至少保存：

* Authority
* Requirement Version
* Deadline
* Submitted By / At
* Submission Reference
* Content Snapshot
* Acknowledgement
* Follow-up

核心规则：

* 系统不能仅因 Deadline 经过就假设已报告
* `Not Required` 必须保存依据
* Submission 内容固定快照
* 后续补充通过新 Submission Revision

### 40.20 Recall / Withdrawal

Recall / Withdrawal 使用 Compliance Case 协调，但不独占各 Domain 事实。

Scope：

* Supplier
* Inventory Item
* Lot / Batch
* Product / SKU
* Store / Region
* Effective Period

核心规则：

* Compliance 发布 Recall / Withdrawal Scope 与 Requirement Version
* Inventory 执行 Hold、Transfer Block、Dispose 等库存动作
* Catalog / Ordering 执行停售或阻止新订单
* Procurement 停止新的采购或收货
* Customer / Notification 根据 Order Traceability 处理通知
* 历史订单不改写

### 40.21 Product Traceability

Food Safety Traceability 通过跨 Domain Reference 实现：

`Supplier / PO → Goods Receipt / Lot → Inventory Movement → Recipe / Kitchen → Order Item → Customer / Fulfillment`

核心规则：

* Compliance 不复制完整交易链
* 使用稳定 ID 与 BI / Query Projection 进行追溯
* Traceability 查询结果保存 Run ID、查询范围、时间与数据版本
* 数据不完整时明确标记 Gap，不得伪造完整链路

### 40.22 Immediate Containment 与 Hard Block

发现 Immediate Danger 时可以触发受控 Hard Block：

* Stop Selling
* Stop Production
* Stop Receiving
* Hold Inventory
* Disable Equipment
* Suspend Delivery / Pickup
* Store Emergency Closure

核心规则：

* Compliance 产生要求或风险事实
* 实际 Block 由对应 Domain 的 Kill Switch / Workflow 执行
* 每个 Block 保存 Scope、Reason、Authority、Effective From、Review Deadline
* 解除必须通过验证与明确 Action
* 不能通过普通 Manager Override 绕过法律或安全 Hard Block

### 40.23 Manager Override 边界

允许 Override 的仅是 Advisory 或明确标记 `Override Allowed` 的内部规则。

Override 必须保存：

* Original Requirement
* Override Scope
* Reason
* Risk Assessment
* Approver
* Second Approver（高风险时）
* Effective Period
* Compensating Control

不能 Override：

* 法定许可证要求
* Immediate Danger
* Mandatory Allergen / Age / Health Requirement
* Regulatory Reporting Deadline
* Recall Hard Block
* 已确认的产品不安全事实

### 40.24 SLA、Deadline 与 Escalation

Case、Finding、Action、License 与 Notification 都可以设置 Deadline。

核心规则：

* Deadline 使用 Store / Jurisdiction Time Zone，同时保存 UTC
* 到期前提醒
* 超时自动进入 `Escalated` 或生成 Task
* 超时不自动把 Action 标记完成或 Case 关闭
* Severity 越高，默认 SLA 越短
* Critical Case 必须设置明确 Owner 与 Escalation Chain

### 40.25 Privacy、Retention 与 Legal Hold

Compliance 数据按分类保存：

* Operational Compliance
* Regulatory Record
* Employee Qualification
* Customer Health / Complaint
* Investigation Evidence
* Legal Hold

核心规则：

* 最小权限访问
* 健康、身份、员工纪律与投诉数据分区保护
* Retention 由 Jurisdiction、Record Type 与 Legal Hold 决定
* Retention 到期前检查是否有关联 Open Case / Investigation
* 删除使用 Controlled Deletion，不修改 Audit 事实

### 40.26 Case Merge、Split 与 Duplicate

第一版支持受控：

* Duplicate Link
* Case Merge
* Case Split

核心规则：

* Merge 不删除原 Case ID
* Primary Case 保存来源 Case Reference
* Split 创建新 Case 并引用原 Evidence / Finding
* 原历史和 Audit 保留
* 不同法律主体或不同监管机关的 Case 默认不合并

### 40.27 Root Cause 与 Preventive Action

Major、Critical 或重复 Incident 需要 Root Cause Analysis。

支持：

* Direct Cause
* Contributing Factor
* Systemic Cause
* Preventive Action
* Effectiveness Review

核心规则：

* Root Cause 结论采用版本化 Revision
* 预防措施与纠正措施分开
* 关闭 Case 前可以要求后续 Effectiveness Review Date
* 复发时创建新 Case，并关联原 Preventive Action

### 40.28 Dashboard 与 Compliance Projection

Operational Compliance Projection 可以显示：

* Open Case
* Expiring License
* Overdue Corrective Action
* Unverified Finding
* Temperature Excursion
* Missing Cleaning Record
* Employee Qualification Expiry
* Recall Scope

核心规则：

* Projection 可以重建
* 原 Case、Record 与 Evidence 不因 Dashboard 变化而改写
* BI 可以消费 Compliance Event 做趋势分析
* Compliance Dashboard 不替代正式 Regulatory Record

### 40.29 Domain Events

第一版最小 Domain Event：

Case：

* `ComplianceCaseOpened`
* `ComplianceCaseEscalated`
* `ComplianceCaseEnteredCorrectiveAction`
* `ComplianceCaseVerificationStarted`
* `ComplianceCaseClosed`
* `ComplianceCaseCancelled`

Finding / Action：

* `ComplianceFindingRecorded`
* `CriticalComplianceFindingDetected`
* `CorrectiveActionAssigned`
* `CorrectiveActionCompleted`
* `CorrectiveActionVerified`
* `CorrectiveActionVerificationFailed`

License / Qualification：

* `LicenseExpiring`
* `LicenseExpired`
* `LicenseSuspended`
* `EmployeeQualificationExpiring`
* `EmployeeQualificationExpired`

Monitoring / Incident：

* `TemperatureExcursionDetected`
* `CleaningVerificationFailed`
* `AllergenControlFailureDetected`
* `FoodSafetyIncidentReported`
* `RegulatoryNotificationRequired`
* `RegulatoryNotificationSubmitted`
* `RecallInitiated`
* `RecallClosed`

核心规则：

* Event 只描述已经发生的 Compliance 事实
* 每个 Event 包含 Case / Record ID、Brand、Store、Requirement Version、Severity 与 Occurred At
* 业务 Domain 消费 Event 后自行执行正式 Action
* 消费者必须幂等
* 非关键 Notification、BI 或 Task 失败不得回滚原 Compliance Record

### 40.30 Open Architecture Decisions

暂时保留：

* Compliance Case 是否未来抽为 BOP 通用 Case Management Capability
* Privacy / Data Governance 是否独立为 BOP Domain
* Legal Hold、Insurance Claim 与 Litigation 是否拆出独立 Legal / Risk Domain
* IoT Sensor Platform 是否从 Device Domain 独立
* 跨 Brand Recall 与 Public Authority Integration 是否进入平台层
* Employee Health / Occupational Safety 是否与 Food Safety 合并或拆分
* Jurisdiction Rule Content 是否由平台维护、第三方提供或 Merchant 自行确认

第一版继续保留在 RMS Compliance & Food Safety 内，不提前过度抽象。

### 40.31 v0.1 阶段状态

Compliance & Food Safety Domain v0.1 已阶段性完成并 Freeze。

Freeze 表示：

* Compliance Case / Record、Lifecycle、Scope、Policy 与 Requirement 边界已确认
* License、Inspection、Finding、Corrective Action 与 Verification 已确认
* Temperature、Cleaning、Allergen、Employee Qualification、Supplier / Product Compliance 已确认
* Incident、Evidence、Regulatory Notification、Recall、Traceability 与 Hard Block 已确认
* Privacy、Retention、Legal Hold、Deadline、Override、Root Cause 与 Domain Event 已确认
* 具体法规文本、政府 API、检查表字段、设备型号与页面流程留到实现阶段
* 后续讨论不重新展开已经确认的核心结构

---

## 历史讨论节点 H-041（已完成）

以下 Domain v0.1 已完成核心结构设计并阶段性 Freeze：

* Catalog
* Ordering
* Dining
* Kitchen
* Pricing & Promotion
* Payment
* Recipe
* Inventory
* Procurement & Supplier
* Reservation & Waiting
* Customer & Loyalty
* Delivery & Fulfillment
* Printing & Device Integration
* Business Intelligence
* Compliance & Food Safety

Compliance & Food Safety 已确认：

* 统一 Compliance Case / Record 模型
* 法规要求、证照、检查、Finding、整改与验证全部版本化、追加式保存
* 温度、清洁等高频记录不逐条创建 Case，只有异常达到 Policy 阈值时建立 Case
* Compliance 发布风险与限制事实，实际业务动作由对应 Domain 执行
* Incident、Recall、Traceability、Evidence、Regulatory Notification 与 Hard Block 边界已确认

下一步进入：

**Platform / BOP Open Architecture Decisions Consolidation。**

首先需要处理：

**此前保留的 Policy Engine、Configuration Domain、Overlay Model、Operating Entity、Media、Workforce、Device、Semantic Layer、Compliance Case、Privacy / Data Governance 等开放决策，哪些需要在 v0.1 开发前锁定，哪些继续延期。**

后续继续遵循：

* 用户已授权自动推进无争议设计
* 已确认内容不重新讨论
* 遇到真正需要业务取舍的分歧时再暂停确认
* 只锁定会直接影响 v0.1 数据模型与模块边界的开放决策
* 不为未来可能性提前拆分微服务或平台能力

---

## 42. Platform / BOP Open Architecture Decisions Consolidation

### 42.1 Consolidation 目标

本阶段不新增业务 Domain，而是统一处理此前在各 Domain 中保留的 Open Architecture Decisions。

分类标准：

* `Locked for v0.1`：直接影响数据模型、Aggregate 边界、模块依赖或开发基础设施，必须在开发前锁定
* `Deferred`：不会阻止当前开发，保留明确边界后延期
* `Removed / Absorbed`：已被现有设计覆盖，不再作为独立开放决策
* `Implementation Choice`：架构边界已经确定，但具体技术产品或供应商留到实现阶段选择

核心原则：

* 第一阶段继续采用模块化单体
* 不因未来扩展可能性提前拆分微服务
* 跨 Domain 通用模式先通过共享 Kernel、Library、Interface 或 Policy Contract 复用
* 只有在多个 Domain 已形成稳定、同构且独立演进的需求后，才升级为独立 BOP Capability
* 已完成的业务 Domain Freeze 不因本次 Consolidation 被重新展开

### 42.2 Policy Engine

Decision：`Deferred`

v0.1 不建立统一的通用 Policy Engine。

继续保留独立能力：

* Permission
* Workflow
* Approval
* Publishing
* Effective Period
* Feature Flag / Kill Switch
* Domain-specific Versioned Policy

统一最小 Contract：

* Policy ID
* Policy Version
* Scope
* Effective Period
* Priority
* Hard Requirement / Override Allowed
* Evaluation Input
* Evaluation Result
* Reason Code
* Evaluated At

核心规则：

* 各 Domain 可以复用统一 Policy Contract 与评估基础设施
* 不把所有规则转换为同一种 DSL
* Permission、Workflow 与 Pricing Rule 等继续保留各自语义
* 后续只有在规则编排、解释、测试与发布流程高度统一后，才重新评估独立 Policy Engine

### 42.3 Configuration Domain

Decision：`Deferred with Locked Shared Contract`

v0.1 不建立独立 Configuration Domain，但锁定统一 Configuration Contract。

所有版本化 Configuration 至少支持：

* Stable Configuration ID
* Version ID / Version Number
* Lifecycle
* Publishing Status
* Effective Period
* Scope
* Created By / At
* Approved By / At
* Superseded Version
* Change Reason
* Compatibility / Impact Result
* Immutable Published Snapshot

核心规则：

* 每个业务 Domain 继续拥有自己的 Configuration Aggregate
* 通用 Publishing、Approval、Effective Period、Change Impact 与 Audit 由 BOP 基础能力提供
* 已发布版本不能直接覆盖
* 交易对象保存实际解析出的 Configuration Version
* Configuration Domain 是否独立拆出，延期到出现跨 Domain 统一发布编排需求后再决定

### 42.4 Overlay Model

Decision：`Locked for v0.1`

v0.1 采用统一的有限层级 Overlay 解析模式，但不建立独立 Overlay Aggregate Root。

统一层级：

`Platform Template → Brand Base → Region / Store Group Override → Store Override → Runtime Context`

核心规则：

* Override 只保存允许变化的字段
* 每个 Override 必须声明 Scope、Priority、Effective Period 与 Base Version Compatibility
* 运行时必须解析出唯一结果
* 同一优先级多重匹配属于配置冲突
* Store 只能覆盖 Brand 明确标记为 Override Allowed 的字段
* Platform Hard Requirement 不能被下层覆盖
* 交易与执行 Snapshot 固定最终解析结果及各层 Version Reference
* Overlay Resolution 由共享 BOP Resolver Library 实现，各 Domain 提供自己的 Merge / Validation 规则

### 42.5 Operating Entity

Decision：`Locked for v0.1`

建立独立的 `Operating Entity Aggregate Root`。

Operating Entity 表示实际承担经营、税务、收付款或合同责任的经营主体。

第一版类型：

* `Legal Entity`
* `Sole Proprietorship`
* `Operating Unit`
* `Franchise Entity`

Operating Entity 保存：

* Operating Entity ID
* Legal Name
* Trade Name
* Registration Number
* Jurisdiction
* Tax Registration Reference
* Billing / Receipt Identity
* Banking / Settlement Reference
* Lifecycle
* Effective Period

关系模型：

* Brand 与 Operating Entity 通过 `Brand Operating Entity Assignment` 关联
* Store 与 Operating Entity 通过 `Store Operating Entity Assignment` 关联
* 一个 Operating Entity 可以关联多个 Brand 或 Store
* 一个 Brand 可以关联多个 Operating Entity
* 每个 Store + Business Function + Effective Time 必须解析出唯一 Operating Entity

Business Function 至少包括：

* Sales / Receipt Issuer
* Tax Registrant
* Payment Settlement Owner
* Procurement Buyer
* License Holder
* Employer（如适用）

核心规则：

* 不把税号、银行账户和许可证直接固定在 Brand 上
* Order、Receipt、Payment、Purchase Order 与 Compliance Record 保存实际 Operating Entity Snapshot
* Operating Entity 后续变化不追溯改写历史交易
* 敏感银行与税务数据只保存受控 Reference 或加密字段

### 42.6 Media

Decision：`Locked as BOP Shared Capability`

Media Asset 从 Catalog 候选正式提升为 BOP 共享 `Media Capability`，但第一阶段仍作为模块化单体中的独立 Module。

统一服务对象：

* Catalog Product / Menu
* Customer / Staff Profile
* Delivery Proof
* Compliance Evidence
* Device Output Asset
* Supplier Document
* Reservation / Incident Evidence

核心规则：

* Media Asset 拥有稳定 ID 与独立 Version
* 所有业务 Domain 只保存 Media Asset / Version Reference
* 原始文件不可直接覆盖
* 支持 Virus Scan、Processing、Rendition、Retention、Access Policy 与 Legal Hold
* Dynamic Reference 与 Pinned Reference 均支持
* 交易、Proof、Compliance 与正式发布内容默认使用 Pinned Version
* Owner Type / Owner ID 只表达业务归属，不改变 Media Asset 的独立生命周期

### 42.7 Workforce / Scheduling

Decision：`Deferred`

v0.1 不建立通用 Workforce / Scheduling Domain。

继续使用：

* Identity / Membership 管理员工身份与权限
* 各业务 Domain 保存必要的 Role、Availability Reference 或执行 Snapshot
* Delivery Worker、Kitchen Station Assignment、Task Assignment 保留在各自 Domain
* BOP Task 支持分配给 User、Role、Position 或 Queue

延期范围：

* Shift Scheduling
* Time Clock
* Attendance
* Labor Forecasting
* Break Compliance
* Cross-store Workforce Pool
* Payroll Integration

核心规则：

* 不在各 Domain 复制员工身份
* 各 Domain 的 Availability 只是本地执行资格，不升级为全局排班事实
* 后续建立 Workforce Domain 时，通过稳定 Staff Actor ID 与 Assignment Reference 集成

### 42.8 Device Management

Decision：`Deferred as BOP Extraction`

v0.1 保持 `Printing & Device Integration Domain` 的现有边界，不立即抽为 BOP Device Platform。

已锁定：

* 统一 Device Aggregate
* Capability、Provisioning、Health、Gateway 与 Credential
* Output Job、Attempt、Routing、Retry、Fallback 与 Exception

延期：

* 通用 IoT Device Platform
* Fleet Management
* Firmware / MDM
* 跨业务 Device SDK
* Remote Command Orchestration

核心规则：

* Device Module 的接口保持业务无关
* RMS 专属 Output Template 与 Routing 留在 RMS
* 若后续第二个 BOP 应用复用设备能力，再评估抽离

### 42.9 Document Rendering / Template Engine

Decision：`Deferred with Shared Library`

v0.1 不建立独立 Document Rendering Domain。

建立共享 Library / Service Contract，支持：

* Template ID / Version
* Locale
* Data Contract Version
* Render Format
* Validation
* Preview
* Immutable Published Template
* Pinned Template Version

第一版使用范围：

* Receipt
* Kitchen Ticket
* Label
* Compliance Report
* Scheduled BI Report
* Email / Notification Document

业务内容与法律要求仍由对应 Domain 决定。

### 42.10 Metric Semantic Layer

Decision：`Locked inside BI`

Metric Semantic Layer 在 v0.1 继续属于 Business Intelligence Domain，不抽为 BOP 通用平台能力。

核心规则：

* Certified Metric 使用统一 Metric Definition / Version
* Operational Domain 不依赖 BI Metric 完成核心交易
* 其他 BOP 应用如未来需要统一指标平台，再评估抽离
* BI 对外提供稳定 Query / Export Contract，不暴露底层 Warehouse 表作为业务依赖

### 42.11 Compliance Case Management

Decision：`Locked inside Compliance`

Compliance Case / Record 在 v0.1 继续属于 Compliance & Food Safety Domain。

不建立通用 BOP Case Management。

核心规则：

* BOP Task、Workflow、Approval、Evidence、Deadline 与 Audit 提供通用基础能力
* Case Lifecycle、Finding、Corrective Action、Verification 与 Regulatory Result 保持 Compliance 语义
* Customer Dispute、Payment Dispute、Delivery Exception 等不强制改造成 Compliance Case
* 后续出现多个同构 Case Domain 后再评估抽离

### 42.12 Privacy / Data Governance

Decision：`Locked as Cross-cutting BOP Capability`

v0.1 必须建立跨 Domain 的 Privacy / Data Governance 基础能力，但不建立独立业务 Domain Aggregate。

统一能力包括：

* Data Classification
* Purpose of Use
* Consent Reference
* Access Policy
* Data Residency
* Retention Policy
* Deletion / Anonymization Request
* Legal Hold
* Export / Portability
* Sensitive Field Masking
* Audit Access
* Encryption Requirement

核心规则：

* 数据仍由原业务 Domain 拥有
* Privacy Capability 定义和执行跨 Domain Policy
* 删除请求不能物理删除依法必须保留的交易、支付、审计或合规事实
* 需要删除时优先采用去标识化、访问限制或 Cryptographic Erasure
* Legal Hold 优先于普通 Retention 到期
* 每个敏感数据对象必须能解析适用的 Retention、Access 与 Residency Policy
* Customer Marketing Consent 仍由 Customer & Loyalty 保存，Privacy Capability 提供通用治理规则

### 42.13 Event Platform

Decision：`Locked for v0.1`

BOP Event 作为模块化单体内的统一基础能力实现。

必须支持：

* Transactional Outbox
* Event ID
* Aggregate ID / Version
* Event Type / Version
* Occurred At / Recorded At
* Brand / Store Scope
* Idempotent Consumer
* Retry
* Dead-letter Queue
* Same Aggregate Ordering
* Replay
* Consumer Checkpoint
* Schema Compatibility

核心规则：

* Domain Event 只描述已经发生的事实
* 跨 Domain Command 使用明确 Application Service / Command Contract，不伪装成 Event
* 非关键 Consumer 失败不得回滚源 Aggregate Transaction
* 第一阶段不要求独立 Kafka 等 Streaming Platform
* Event Bus 可以进程内调度，但 Outbox 与持久化消费状态必须保留

### 42.14 Task、Notification 与 Approval

Decision：`Locked as BOP Shared Capabilities`

Task、Notification 与 Approval 保持独立 BOP Module，不合并为通用 Workflow Engine 的内部子类型。

核心规则：

* Workflow 决定允许 Action 与状态转换
* Approval 决定受控决策是否通过
* Task 追踪需要被实际完成的工作
* Notification 负责消息投递
* 四者通过稳定 Reference 与 Event 协作
* 一个模块失败不能静默改变另一个模块的业务结果

### 42.15 Search

Decision：`Deferred`

v0.1 不建立独立 Enterprise Search Domain。

实现方式：

* 每个 Domain 提供自己的查询接口
* 后台全局搜索通过 Application Query Layer 聚合
* 搜索索引只是可重建 Projection
* 搜索结果必须经过源 Domain 权限复验
* 后续需要全文、跨 Brand、语义搜索时再引入独立 Search Platform

### 42.16 Finance / Accounting

Decision：`Deferred but Boundary Locked`

v0.1 不建立完整 Finance / Accounting Domain。

已锁定边界：

* Pricing 计算顾客金额
* Payment 管理收付款、退款、Chargeback、Settlement 与 Reconciliation
* Procurement 保存采购承诺与成本快照
* Inventory 保存库存估值所需事实
* BI 提供经营分析，不作为法定总账
* Operating Entity 提供交易责任主体

延期：

* General Ledger
* Chart of Accounts
* Accounts Payable / Receivable
* Journal Entry
* Tax Filing
* Financial Close
* Consolidation

核心规则：

* 所有现有 Domain 必须发布足够的不可变资金事实，以便未来生成 Journal Entry
* 不在 BI 中伪造法定会计账簿

### 42.17 Multi-tenancy 与数据隔离

Decision：`Locked for v0.1`

租户边界以 Brand 为主要业务隔离单位，Platform Administrator 通过受控跨租户权限访问。

核心规则：

* 核心业务记录必须包含 Brand ID
* Store-scoped 数据同时保存 Store ID
* Operating Entity 可以跨 Brand，但访问仍通过明确 Assignment
* Customer User Identity 可以全平台共享，但 Customer Profile、Loyalty、Consent 与经营数据按 Brand 隔离
* 所有查询默认要求 Tenant Scope
* 数据库层使用约束、Repository Guard 与测试防止跨 Brand 泄漏
* 高敏感模块按需增加 Row-level Security 或独立加密边界
* 第一阶段不为每个 Brand 建立独立数据库

### 42.18 API 与 Adapter Boundary

Decision：`Locked for v0.1`

每个 Domain 通过 Application Service、Query Service、Event 与 Adapter Contract 协作。

核心规则：

* 不允许跨 Domain 直接修改数据库表
* 不允许绕过 Aggregate 直接更新业务状态
* 外部 Provider 通过 Anti-corruption Layer / Adapter 转换为 Canonical Model
* API Contract 必须版本化
* Webhook 使用签名验证、幂等、Replay Protection 与原始 Envelope
* 模块化单体内部调用也必须遵守 Domain Interface，避免未来无法拆分

### 42.19 Technology Deployment Boundary

Decision：`Locked for v0.1`

第一阶段继续采用模块化单体。

逻辑模块：

* BOP Shared Modules
* RMS Business Domains
* Application / Orchestration Layer
* Adapter / Integration Layer
* Operational Projection
* Analytics Pipeline

核心规则：

* 一个主要 Transactional Database 可以承载多个 Schema / Module Table
* 每个 Aggregate 只能由所属 Module Repository 写入
* Background Worker 可以独立部署，但共享同一代码库与 Domain Contract
* Web、POS、KDS、Worker 与 API 使用同一后端业务规则
* 不提前拆微服务
* 只有出现独立扩展、故障隔离、团队所有权或数据边界需求时才评估拆分

### 42.20 Removed / Absorbed Decisions

以下项目不再作为独立 Open Architecture Decision：

* `Product Version Resolution 是否完全由 Configuration Domain 接管`
  * 已吸收到 Shared Configuration Contract 与 Domain-owned Resolver
* `Overlay 是否独立 Aggregate`
  * 已确定为共享解析模式，不建立 Aggregate Root
* `Media Asset 是否仍只是 Catalog Candidate`
  * 已锁定为 BOP Shared Media Capability
* `Operating Entity 是否保留`
  * 已锁定为独立 Aggregate Root
* `Device 是否每种设备独立 Aggregate`
  * 已由统一 Device Aggregate 解决
* `Metric Definition 是否与 Warehouse 混合`
  * 已由 BI Semantic Layer 分层解决
* `所有 Incident / Exception 是否统一 Case`
  * 明确不统一；保留各 Domain 语义，仅共享 Task、Workflow、Evidence 与 Audit

### 42.21 Deferred Decision Register

以下决策继续延期，不阻止 v0.1 开发：

* Unified Policy Engine / Rule DSL
* Independent Configuration Domain
* Generic Workforce / Scheduling Domain
* BOP Device / IoT Platform
* Enterprise Search Platform
* Streaming Platform
* Finance / Accounting Domain
* Legal / Risk Domain
* Generic Case Management
* ML Feature Store / Model Registry
* Cross-brand Supplier Directory
* Cross-brand Recall Platform
* Fleet / Route Optimization
* Digital Signage Domain
* Public Authority Direct Integration
* Multi-database Tenant Isolation
* Microservice Decomposition

每项延期决策必须在 Architecture Decision Register 中记录：

* Decision ID
* Current Status
* Reason Deferred
* Trigger for Revisit
* Affected Modules
* Earliest Review Milestone
* Owner

### 42.22 Implementation Choice Register

以下属于实现选择，不再阻塞架构：

* PostgreSQL Hosting Provider
* Queue / Job Runner 产品
* Object Storage Provider
* Map / Geocoding Provider
* Payment Provider
* Delivery Provider
* BI Warehouse / Query Engine
* Dashboard Library
* Printer / POS 厂商 SDK
* Store Gateway Runtime
* SMS / Email / Push Provider
* Observability Platform

选择标准：

* 满足既定 Domain Contract
* 支持数据驻留与合规要求
* 支持幂等、审计和可替换 Adapter
* 不允许供应商特有概念渗入核心 Domain Model

### 42.23 v0.1 Architecture Freeze

v0.1 开发前正式锁定：

* 模块化单体
* BOP 与 RMS 依赖方向
* Domain-owned Aggregate 与跨 Domain Interface
* Configuration / Transaction 分离
* Immutable Transaction Snapshot
* Append-only Event、Audit、Ledger、Proof 与 Revision
* Action 驱动状态
* Transactional Outbox 与幂等 Consumer
* Brand 为主要 Tenant Boundary
* Operating Entity Aggregate
* Shared Media Capability
* Shared Privacy / Data Governance Capability
* Limited Hierarchical Overlay Resolution
* Domain-owned Versioned Configuration
* BOP Task、Notification、Approval、Workflow、Publishing、Effective Period、Feature Flag
* RMS 各业务 Domain v0.1 Freeze 结果
* 外部系统 Adapter / Anti-corruption Layer
* Operational Projection 可重建，源交易事实不可改写

变更控制：

* Architecture Freeze 后的结构性变更必须创建 Architecture Decision Record
* 必须说明问题、备选方案、影响、数据迁移与回滚策略
* 影响多个 Domain 时必须执行 Change Impact Review
* 不允许在实现过程中通过临时跨表写入绕过 Domain 边界
* 紧急修复可以先通过 Feature Flag / Kill Switch 控制，但后续仍需补充 ADR

### 42.24 Consolidation 阶段状态

Platform / BOP Open Architecture Decisions Consolidation 已完成并 Freeze。

本阶段结果：

* 直接影响 v0.1 数据模型与模块边界的决策已经锁定
* 未来平台化能力已经明确延期触发条件
* 已被现有设计覆盖的问题已从 Open Decision 中移除
* 技术供应商选择被降级为 Implementation Choice，不再阻塞领域设计
* v0.1 Architecture Freeze 已形成，可进入实施规划

---

## 历史讨论节点 H-043（已完成）

业务领域设计与 Platform / BOP Architecture Consolidation 已完成。

下一步进入：

**Implementation Planning / Development Roadmap。**

首先需要完成：

**把 v0.1 Architecture Freeze 转换为可执行的开发阶段、模块依赖顺序、里程碑、交付物与验收标准。**

规划原则：

* 先建立 BOP 基础能力，再实现 RMS 核心交易链路
* 先完成最小端到端闭环，再扩展高级运营能力
* 每个阶段必须有可运行、可验证的 Increment
* 数据迁移、测试、Observability、Security 与 Deployment 不留到最后补做
* 继续保持模块化单体，不在 Roadmap 阶段提前拆微服务

---

## 44. Implementation Planning / Development Roadmap

### 44.1 Roadmap 目标

本 Roadmap 将已经 Freeze 的 v0.1 Architecture 转换为可执行的开发顺序、阶段边界、交付物、依赖关系与验收标准。

核心原则：

* 每个阶段必须交付可以部署、运行和验证的 Increment
* 先建立最小平台能力，再完成最小端到端交易闭环
* 不以“模块代码已完成”作为阶段完成标准，必须以业务场景通过验收为准
* Security、Observability、Migration、Testing 与 Deployment 从 Phase 0 开始持续建设
* 第一版继续采用模块化单体，不在 Roadmap 阶段拆分微服务
* 高级能力不得阻塞核心扫码点餐闭环
* 所有跨 Domain 协作必须通过已经冻结的 Interface、Command、Event 与 Snapshot 边界完成

### 44.2 Increment 与 Release 层级

开发工作分为四级：

* `Work Package`：单一模块或基础能力的可测试开发单元
* `Increment`：可以在集成环境运行并完成一个明确业务场景
* `Milestone`：多个 Increment 组合形成可演示、可验收的产品能力
* `Release Candidate`：满足上线前功能、质量、安全与运营标准的版本

每个 Increment 必须具备：

* 明确 Owner
* 输入与依赖
* Domain Contract
* Database Migration
* API / Event Contract
* Automated Test
* Observability
* Rollback / Disable Strategy
* Acceptance Scenario

### 44.3 总体阶段

v0.1 Roadmap 分为：

* `Phase 0`：Engineering Foundation 与 BOP Minimum Kernel
* `Phase 1`：Minimum End-to-End Ordering Loop
* `Phase 2`：Store Operations MVP
* `Phase 3`：Multi-store Business Operations
* `Phase 4`：Hardening、Pilot 与 General Availability
* `Post-v0.1`：Enterprise Enhancement，不进入 v0.1 Critical Path

Roadmap 不使用固定日历承诺。实际日期由团队规模、技术选型、外部 Provider 接入和 Pilot 范围决定；依赖顺序和 Exit Criteria 保持固定。

### 44.4 模块依赖主链

最小开发依赖顺序：

`Engineering Foundation`

→ `Identity / Tenant / Operating Entity`

→ `Permission / Audit / Event / Outbox`

→ `Store Configuration / Media / Publishing`

→ `Catalog`

→ `Pricing / Tax Quote`

→ `Cart / Ordering`

→ `Payment Adapter`

→ `Kitchen Execution`

→ `Printing / Device Output`

→ `Pickup Fulfillment`

→ `Operational Reporting`

关键规则：

* Catalog 发布能力完成前，不开始真实 Cart 集成
* Price Quote 可复算与快照完成前，不允许创建正式 Order
* Outbox 与 Idempotent Consumer 完成前，不接入跨 Domain 异步流程
* Payment Webhook 幂等完成前，不开放真实在线支付
* Kitchen Item Ready 事实完成前，不完成 Pickup Handoff
* Audit、权限和 Tenant Scope 必须在每个业务模块首次交付时同时具备

### 44.5 Phase 0 — Engineering Foundation

Phase 0 目标：建立可持续开发、测试、部署和运行的基础，而不是一次性搭建空框架。

#### 44.5.1 Repository 与模块结构

交付：

* Monorepo 或统一 Repository
* Backend、Merchant Web、Customer PWA、Shared Contracts、Infrastructure 分区
* BOP 与 RMS 模块边界目录
* Domain、Application、Infrastructure、Interface 分层约束
* Architecture Dependency Test，阻止非法反向依赖
* ADR 目录与模板

验收：

* 新模块可以按模板创建
* CI 能检测循环依赖、跨模块非法 Import 与未授权数据库访问
* RMS 可以依赖 BOP，BOP 不依赖 RMS

#### 44.5.2 Environment 与 Delivery Pipeline

交付：

* Local、Test、Staging、Production-like 环境定义
* Database Migration Pipeline
* Seed / Fixture Framework
* CI：Lint、Type Check、Unit、Integration、Contract、Migration Test
* CD：Staging 自动部署与 Production 受控部署
* Secret Management 与 Environment Validation
* Feature Flag / Kill Switch 基础接入

验收：

* 新 Commit 可以自动构建、测试并部署到 Staging
* Migration 可以前向执行并具备受控回滚或补偿方案
* 不允许在 Repository 中保存真实 Secret

#### 44.5.3 Observability Minimum Baseline

交付：

* Structured Log
* Trace / Correlation ID
* Request、Command、Event、Job 统一关联
* Error Tracking
* Health / Readiness Endpoint
* Database、Queue / Job、External Provider 指标
* Alert Routing

验收：

* 可以从一次 API 请求追踪到 Database Transaction、Outbox Event 与 Consumer
* Staging 中故意制造的失败可以被发现、定位与告警

#### 44.5.4 Database 与 Persistence Baseline

交付：

* PostgreSQL Schema 规范
* Brand / Store Scope 字段与索引规范
* Aggregate Version / Optimistic Concurrency
* Append-only Record 模式
* Soft Delete / Archive 规范
* Transactional Outbox
* Consumer Inbox / Idempotency Record
* UTC、IANA Time Zone、Currency / Money 类型规范

验收：

* 并发修改可以检测冲突
* 同一 Event 重复消费不会产生重复业务结果
* Transaction 与 Outbox 在同一数据库事务内提交

### 44.6 Phase 0 — BOP Minimum Kernel

Phase 0 不实现所有 BOP 高级能力，只完成所有后续模块必需的 Minimum Kernel。

#### 44.6.1 Identity 与 Account Boundary

交付：

* Customer、Merchant Staff、Platform Admin Account Boundary
* Authentication Provider Adapter
* User、Account、Membership、Store Assignment
* Session 与 Token Revocation
* Guest Session
* Actor Snapshot

验收：

* 同一 User 可以拥有不同 Account Context，但权限不自动共享
* Guest 可以建立 Customer Session，但不能访问 Merchant 能力
* 已停用账号无法继续执行受保护 Action

#### 44.6.2 Tenant、Brand、Store 与 Operating Entity

交付：

* Brand Aggregate
* Store Aggregate / Profile
* Operating Entity Aggregate
* Brand / Store / Entity Relationship
* Store Time Zone、Currency、Locale、Tax Registration Reference
* Tenant Scope Resolver

验收：

* 所有业务请求必须解析 Brand Scope
* Store 不可读取另一 Brand 的数据
* 一家 Brand 可以关联多个 Store 与 Operating Entity

#### 44.6.3 Permission、Audit 与 Action Guard

交付：

* Role、Permission、Grant、Explicit Allow / Deny
* Brand / Store Context Permission
* Action Authorization Middleware
* Append-only Audit Log
* Correction Record
* Sensitive Action Reason Requirement

验收：

* 后端拒绝未授权 Action，即使前端伪造请求
* 关键数据修改可追踪 Actor、Reason、Before / After Reference 与时间

#### 44.6.4 Event、Task、Notification 与 Approval Minimum

交付：

* Domain Event Envelope
* Outbox Publisher 与 Idempotent Consumer
* Retry / Dead-letter / Exception Handling
* BOP Task 最小 Lifecycle
* Notification Request 与 Provider Adapter
* Approval Request / Decision Minimum

验收：

* Consumer 暂时失败不回滚源 Transaction
* 重试后只产生一次结果
* 通知失败可以重试，但不能改变源业务状态

#### 44.6.5 Shared Media 与 Privacy Minimum

交付：

* Media Asset Reference、Upload、Virus / Type Validation
* Signed Access / Permission
* Retention Classification
* Personal Data Classification
* Masking / Redaction Utility
* Consent 与 Deletion Request 的基础 Contract

验收：

* Domain Aggregate 只保存 Asset Reference
* 未授权用户无法访问敏感 Asset
* Log 中不输出完整支付、身份或联系敏感数据

#### 44.6.6 Phase 0 Exit Criteria

Phase 0 只有同时满足以下条件才完成：

* Staging 环境可重复部署
* Identity、Tenant、Permission、Audit、Outbox 通过集成测试
* 一个示例 Aggregate 可以完成 Command → Transaction → Outbox → Consumer → Projection
* Database Migration、Backup / Restore 演练通过
* Security Baseline Review 通过
* Observability 可以定位完整请求链路
* Architecture Dependency Test 已启用

### 44.7 Phase 1 — Minimum End-to-End Ordering Loop

Phase 1 目标：交付第一条真实可运行闭环：

`Customer Scan QR → Menu → Cart → Quote → Pay → Order → Kitchen → Output → Pickup → Complete`

Phase 1 只支持受控 Pilot 所需最小范围，不加入高级促销、复杂库存、外送、会员或预约。

### 44.8 Phase 1A — Store、Catalog 与 Menu Publication

交付：

* Store 基础配置
* Product、SKU、Option Set、Choice、Binding
* Menu、Menu Section、Sellable Placement
* Store Availability 基础规则
* Tax Classification
* Media Asset
* Draft、Publish、Effective Period
* Customer Menu Read Model
* QR Entry 与 Store / Table Context Validation

第一版范围：

* 单 Brand、多 Store 数据结构保留
* Pilot 可以只启用单 Store
* 支持 Product + SKU + 基础 Option
* Bundle、复杂 Replacement 与高级 Overlay 可以不进入第一条闭环 UI

验收场景：

* Merchant 创建商品、规格与选项并发布 Menu
* Customer 扫描有效 QR 后只能看到当前 Store、当前时间可售内容
* 已发布版本后修改 Draft 不影响当前 Menu
* 商品停售后新 Cart 不可添加，历史 Order Snapshot 不改变

### 44.9 Phase 1B — Pricing、Tax 与 Cart

交付：

* Money / Currency
* Price Book、Price Entry
* 基础 Option Price
* Store Tax Rule Set
* Price Quote Aggregate / Snapshot
* Cart Session、Cart Item、Configuration
* Cart Validation
* Quote Expiry 与 Requote

第一版支持：

* Base Price
* Option Surcharge
* Item / Order 基础折扣接口，但 Promotion UI 可以延期
* 未含税价格与加拿大基础税务场景
* Dine-in 与 Pickup 两种 Order Type 中至少先打通 Pickup

验收场景：

* 同一 Cart 在 Quote 有效期内金额稳定
* 价格或税率更新后旧 Quote 不被静默改写
* Quote 过期后重新计算，金额上涨时要求 Customer 重新确认
* 前端修改金额无法绕过后端 Quote

### 44.10 Phase 1C — Ordering Core

交付：

* Order Aggregate
* Order Item Snapshot
* Submission、Acceptance、Rejection、Cancellation 最小 Action
* Order Number
* Idempotent Order Submission
* Order Timeline
* Merchant Order Queue Projection
* Customer Order Status Projection

第一版 Workflow：

`Draft / Submitted → Accepted → In Preparation → Ready → Fulfilled → Closed`

异常状态：

* Rejected
* Cancelled

验收场景：

* 重复提交同一 Checkout Request 只创建一个 Order
* Order 保存 Catalog、Price、Tax、Option 与 Customer Context 快照
* Merchant 执行 Action，而不是直接指定状态
* Customer 与 Staff 同时修改时能够检测冲突

### 44.11 Phase 1D — Payment Minimum

交付：

* Payment Intent、Attempt、Transaction
* Provider Adapter
* Online Sale / Capture
* Webhook Signature、Replay Protection 与 Idempotency
* Stripe online Card-not-present + Stripe Terminal Card-present / Interac；Cash is excluded by Section 87.9
* Order Payment Summary Projection
* Full Refund 基础能力

Phase 1 限制：

* Cash、Split Payment、Gift Card、stored balance、pay-later、Chargeback workflow and complex Partial Refund enter only a later accepted Increment
* 只选择一个 Pilot Payment Provider

验收场景：

* Browser Return Page 不能单独把 Payment 标记成功
* 重复 Webhook 不重复入账
* Payment 成功后 Ordering 通过 Event 得到事实
* Payment Provider 超时后状态保持可对账，不误判成功或失败
* Refund 不删除原 Payment Transaction

### 44.12 Phase 1E — Kitchen Minimum

交付：

* Kitchen Order / Work Item Projection
* 基础 Station
* Accepted Order 转换为 Work Item
* Start、Complete、Ready Action
* Item-level Ready
* Basic KDS 或 Kitchen Queue
* Kitchen Event

Phase 1 限制：

* 复杂 Routing、Course、Batch、Rework、Capacity Forecast 延期
* 可以先启用单 Station

验收场景：

* Accepted Order 自动出现在正确 Store 的 Kitchen Queue
* Item 未完成前不能被 Fulfillment 标记 Ready
* 重复 Event 不创建重复 Work Item
* Kitchen 完成状态不直接改写 Ordering Aggregate

### 44.13 Phase 1F — Printing / Output Minimum

交付：

* Device 注册与 Store Binding
* Receipt Printer / Kitchen Printer 最小 Capability
* Output Template
* Output Job、Attempt、Retry
* Kitchen Ticket / Customer Receipt
* Device Health 基础状态
* Manual Reprint 与 Audit

验收场景：

* Order Accepted 后产生一次 Kitchen Output Job
* Printer 暂时离线时 Job 可重试且不重复生成业务 Order
* Manual Reprint 有权限、原因与原 Job Reference
* 打印失败不回滚 Order Acceptance

### 44.14 Phase 1G — Pickup Fulfillment Minimum

交付：

* Pickup Fulfillment Aggregate
* Fulfillment Item
* Pending、Planned、Ready、In Progress、Completed、Cancelled 最小流程
* Confirmed Pickup Time Window
* Pickup Code / QR / OTP 中至少一种验证
* Pickup Handoff Record
* Customer Ready Notification

验收场景：

* 所有未取消 Item Ready 后 Fulfillment 才进入 Ready
* 只有 Validated Handoff Quantity 才完成 Item
* 重复 Pickup Scan 不重复累计数量
* 完成交接后 Ordering 根据 Event 完成后续状态

### 44.15 Phase 1H — Operational Reporting Minimum

交付：

* Current Order Queue
* Kitchen Queue
* Payment Exception Queue
* Output Job Exception Queue
* Daily Order / Sales Summary Projection
* Basic Store Dashboard

验收：

* Projection 可以从 Event 重建
* Projection 故障不改写源 Transaction
* Merchant 可以查看当前订单、付款和出餐状态

### 44.16 Phase 1 End-to-End Acceptance

Phase 1 必须通过以下自动化与人工验收：

1. Merchant 创建并发布 Menu
2. Customer 扫码进入正确 Store
3. Customer 选择 SKU 与 Option
4. Backend 生成有效 Quote
5. Customer Checkout 并完成真实或 Sandbox Payment
6. Order 只创建一次
7. Merchant 接单
8. Kitchen 收到 Work Item 和 Ticket
9. Staff 完成 Item
10. Customer 收到 Ready 通知
11. Staff 验证 Pickup Code 并完成 Handoff
12. Order 与 Fulfillment 正确关闭
13. Receipt 可以查询或重新输出
14. 全链路 Audit、Trace、Event 与 Projection 可追踪

Phase 1 Exit Criteria：

* 上述 Happy Path 与关键 Failure Path 全部通过
* Payment、Order、Kitchen、Output、Pickup 的幂等测试通过
* Pilot Store 配置可从零建立
* 数据 Backup / Restore 与 Event Projection Rebuild 演练通过
* P1 Security Review 与 Load Smoke Test 通过

### 44.17 Phase 2 — Store Operations MVP

Phase 2 目标：从“可以完成订单”提升为“真实餐厅可以日常运营”。

#### 44.17.1 Dining

交付：

* Dining Area、Table、Table Group
* Dining Session
* Table QR 与 Session Token
* 多人点餐与 Order Host
* Add-on Batch
* Table Merge / Split 基础能力
* Serving 与 Table Cleaning State

#### 44.17.2 Advanced Kitchen

交付：

* 多 Station Routing
* Course / Fire / Hold
* Partial Ready
* Rework、Waste Reference
* Station Load 与 ETA 基础计算
* Kitchen Exception

#### 44.17.3 Recipe 与 Inventory Minimum

交付：

* Inventory Item
* Recipe / Ingredient Requirement
* Unit Conversion
* Stock Ledger
* Receive、Reserve、Consume、Release、Waste、Adjustment
* Availability Event
* Negative Stock Policy
* Basic Count

验收：

* Order 配置能够解析理论消耗
* 重复 Kitchen / Order Event 不重复扣减
* 缺少关键 Ingredient 时对应 SKU 不可售
* Adjustment 不覆盖原 Stock Movement

#### 44.17.4 Reservation 与 Waitlist

交付：

* Reservation
* Capacity Pool
* Check-in
* Waitlist
* Estimated Wait 基础算法
* Seat Party Handoff
* No-show 基础处理

#### 44.17.5 Promotion 与 Split Payment

交付：

* Item / Order Discount
* Coupon
* Happy Hour
* Promotion Stackability
* Equal / Custom / Pay-by-item Split
* Tip
* Partial Refund

#### 44.17.6 Device Operations

交付：

* Device Group 与 Routing
* Fallback Printer
* KDS Device
* Customer Display / Order Status Display
* Offline Queue
* Device Exception Dashboard

#### 44.17.7 Phase 2 Exit Criteria

* Dine-in、Pickup 两种 Order Type 可独立配置并完成闭环
* 多 Station Kitchen、部分出餐和 Table Service 通过 Pilot 验收
* Inventory Ledger 与实际盘点差异可追踪
* Reservation / Waitlist 与 Dining 入座无重复 Session
* Split Payment 与 Partial Refund 对账通过
* 门店在短时网络或单设备故障下能够继续受控运营

### 44.18 Phase 3 — Multi-store Business Operations

Phase 3 目标：支持品牌级、多门店运营与完整后台管理。

#### 44.18.1 Procurement & Supplier

交付：

* Supplier
* Supplier Item Offering / Version
* Supplier Price
* Requisition
* Approval
* Purchase Order / Revision
* Goods Receipt Collaboration
* Receiving Discrepancy
* Supplier Performance

#### 44.18.2 Customer & Loyalty

交付：

* Customer Profile
* Loyalty Program / Version
* Points Ledger
* Earn、Activate、Reserve、Redeem、Reverse、Expire
* Tier
* Reward / Entitlement
* Refund Points Handling
* Consent / Preference

#### 44.18.3 Delivery & Fulfillment

交付：

* Address Validation
* Service Area
* Delivery Fee Input 与 Time Window
* Delivery Task
* Internal Worker 或单一 External Provider Adapter
* Dispatch、Proof、Attempt、Completion Exception
* Return / Reattempt

第一版上线限制：

* Pilot 可以选择 Internal 或一个 External Provider
* 多 Provider 智能 Route、Fleet Optimization 延期

#### 44.18.4 Business Intelligence

交付：

* Operational Reporting 扩展
* Analytics Fact / Dimension
* Metric Catalog
* Daily / Weekly KPI
* Store Comparison
* Export / Scheduled Report
* Data Quality 与 Reconciliation

#### 44.18.5 Compliance & Food Safety

交付：

* License / Permit
* Inspection Checklist
* Finding / Corrective Action
* Temperature / Cleaning Record
* Allergen Control
* Employee Qualification
* Incident / Recall Minimum
* Compliance Dashboard

#### 44.18.6 Multi-store Configuration

交付：

* Brand Default + Store Override
* Store Group Scope
* Configuration Resolution Diagnostics
* Publish Impact Review
* Staged Rollout
* Store-level Feature Flag

#### 44.18.7 Phase 3 Exit Criteria

* Brand 可以管理至少两个 Store，且数据、权限和配置正确隔离
* Brand 配置可发布到多个 Store，并保留 Store Override
* Procurement 到 Receiving 到 Inventory Ledger 闭环通过
* Loyalty Earn / Redeem / Refund 闭环通过
* Delivery Happy Path 与失败 / Return Path 通过
* BI 指标可追溯到源事实并完成 Payment / Order 对账
* Compliance Critical Finding 可触发 Hard Block 并由业务 Domain 执行正式 Action

### 44.19 Phase 4 — Hardening、Pilot 与 General Availability

Phase 4 不再大规模增加业务范围，重点是上线质量与运营准备。

#### 44.19.1 Reliability

* Retry、Timeout、Circuit Breaker 统一校验
* Dead-letter 与人工恢复工具
* Projection Rebuild
* Backup、Restore、Point-in-time Recovery 演练
* Provider Outage Runbook
* Store Offline / Degraded Mode 演练

#### 44.19.2 Security 与 Privacy

* Threat Model
* Authentication / Authorization Penetration Test
* Tenant Isolation Test
* Secret Rotation
* PII Inventory
* Retention / Deletion Workflow
* Audit Review
* Payment Scope Review
* Vulnerability Management

#### 44.19.3 Performance 与 Capacity

* Peak Order Load Test
* Menu Read / Cart / Checkout Latency
* Kitchen Queue Fan-out
* Webhook Burst
* Device Offline Queue
* BI Query Isolation
* Database Index / Lock Review

#### 44.19.4 Pilot Operations

* Store Onboarding Runbook
* Menu Import / Setup Checklist
* Device Installation Checklist
* Staff Training
* Support Escalation
* Incident Management
* Daily Reconciliation
* Pilot Feedback Register
* Kill Switch 与 Rollback Procedure

#### 44.19.5 General Availability Exit Criteria

GA 前必须满足：

* 所有 P0 / P1 缺陷关闭或具有正式 Accepted Risk
* 核心订单闭环达到目标成功率
* Payment 与 Order Daily Reconciliation 无未解释差异
* Backup / Restore、Provider Failure、Device Failure 演练通过
* Tenant Isolation 与权限安全测试通过
* Pilot Store 连续稳定运营达到预定观察周期
* Support、On-call、Runbook、Status Communication 已准备
* Data Retention、Privacy Request 与 Audit Export 可执行
* Release Candidate 获得 Product、Engineering、Operations 与 Security Sign-off

### 44.20 Post-v0.1 Enterprise Enhancement

以下内容不进入 v0.1 Critical Path：

* Advanced Promotion Optimization
* AI Menu / Demand Forecast
* Advanced Labor / Workforce Scheduling
* Multi-stop Route Optimization
* Fleet Management
* Cross-brand Supplier Directory
* Cross-brand Recall Platform
* Finance / Accounting
* Marketplace / Public API Ecosystem
* Advanced Enterprise Search
* ML Feature Store / Model Registry
* Multi-database Tenant Isolation
* Microservice Decomposition
* Digital Signage Campaign Management

只有在 v0.1 真实运行数据证明需求与边界稳定后，才创建新的 Architecture Decision 与 Roadmap。

### 44.21 Testing Strategy by Stage

测试层级：

* Domain Unit Test：Invariant、Value Object、State Transition
* Application Test：Command、Permission、Idempotency、Transaction
* Database Integration Test：Constraint、Concurrency、Migration、Outbox
* Contract Test：跨 Domain Event 与 Provider Adapter
* End-to-End Test：Customer、Merchant、Kitchen、Payment、Device、Fulfillment
* Chaos / Failure Test：重复 Event、延迟 Webhook、Provider Timeout、Printer Offline
* Security Test：Tenant、Permission、Session、Sensitive Data
* Reconciliation Test：Order、Payment、Refund、Inventory、BI

核心规则：

* 每个 Bug 修复必须添加能够重现问题的测试
* 关键状态转换使用 Property / Table-driven Test
* 不以大量 Mock 代替 Database 与 Contract Integration Test
* Production Migration 必须先在 Production-like 数据副本或合成大数据集上验证

### 44.22 Definition of Done

任何 Work Package 只有满足以下条件才算完成：

* Domain Rule 与 Acceptance Criteria 已实现
* Permission、Tenant Scope 与 Audit 已覆盖
* Database Migration 已提交并验证
* API / Event Contract 已版本化
* Unit、Integration 与关键 E2E Test 通过
* Log、Metric、Trace 与 Alert 已配置
* Error / Retry / Idempotency Path 已验证
* Documentation 与 Runbook 已更新
* Feature Flag、Rollback 或 Compensating Action 已明确
* Code Review 与 Security Review 要求已满足

### 44.23 Milestone 清单

`M0 — Foundation Ready`

* Phase 0 Exit Criteria 全部通过

`M1 — Menu to Order`

* Published Menu、Cart、Quote、Order Submission 可运行

`M2 — Paid Order`

* Payment Webhook 与 Order Payment Collaboration 可运行

`M3 — Kitchen to Pickup`

* Kitchen、Output、Ready、Pickup Handoff 闭环可运行

`M4 — Store Operations Pilot`

* Dining、Inventory、Reservation、Split Payment 与 Device Operations 可运行

`M5 — Multi-store Pilot`

* Multi-store Config、Procurement、Loyalty、Delivery、BI、Compliance 可运行

`M6 — Release Candidate`

* Reliability、Security、Performance 与 Operations Gate 通过

`M7 — v0.1 General Availability`

* GA Exit Criteria 与 Sign-off 完成

### 44.24 Critical Path

v0.1 Critical Path：

1. Repository / CI / Environment
2. Identity / Tenant / Permission
3. Database / Outbox / Audit
4. Store / Catalog / Publishing
5. Pricing / Tax / Quote
6. Cart / Ordering
7. Payment
8. Kitchen
9. Device Output
10. Pickup Fulfillment
11. Operational Reporting
12. Pilot Hardening

非 Critical Path 模块可以并行，但不能改变主链 Contract。

### 44.25 Parallel Workstreams

团队规模允许时，可以并行：

* Customer PWA 与 Merchant Web Shell
* Provider Adapter Spike
* Device / Gateway Spike
* Test Automation Framework
* Observability / Deployment
* UX Design System
* Data Migration / Import Tool

并行规则：

* 先冻结 Contract，再并行实现
* Spike 结果不能直接渗入 Domain Model
* 未通过 Contract Review 的 Provider-specific 字段不能进入核心表

### 44.26 Risk Register

第一版主要风险：

* Domain 范围过大导致迟迟无法形成闭环
* Payment、Printer、Delivery Provider 接入不稳定
* 多门店 Overlay 过早复杂化
* 前端为了进度绕过后端规则
* Event Consumer 幂等遗漏
* 历史快照不完整导致后续争议无法还原
* Inventory 与实际门店操作偏差
* Pilot Store 网络与设备环境不可控
* 安全、隐私和运维工作被推迟

控制策略：

* Phase 1 严格 Scope Control
* 单 Provider、单 Store、单 Station 先完成闭环
* Contract Test 与 Failure Injection
* Feature Flag / Kill Switch
* Pilot 前设备与网络现场验证
* 每个 Milestone 执行 Architecture Conformance Review

### 44.27 Roadmap Change Control

Roadmap 调整分为：

* Scope Change
* Sequence Change
* Architecture Change
* Provider Change
* Release Gate Change

核心规则：

* Architecture Change 必须创建 ADR
* Critical Path Sequence Change 必须进行 Dependency Review
* 新功能进入当前 Phase 前必须说明替代或延后的原 Scope
* 不允许持续增加 Scope 而不调整 Milestone
* Pilot Feedback 优先形成 Bug、Usability Fix 或明确 Future Enhancement，不自动扩展 v0.1 Domain

### 44.28 Roadmap 阶段状态

Implementation Planning / Development Roadmap v0.1 已完成并 Freeze。

本阶段已确认：

* Phase 0–4 的开发顺序与范围
* BOP Minimum Kernel 与最小端到端交易链路
* 模块依赖、Critical Path 与并行 Workstream
* Milestone、Exit Criteria 与 Definition of Done
* Testing、Security、Observability、Migration、Pilot 与 GA Gate
* Post-v0.1 能力不进入当前 Critical Path

---

## 历史讨论节点 H-045（已完成）

业务领域设计、Platform Architecture Consolidation 与 Development Roadmap 已完成。

下一步进入：

**Implementation Specification / Engineering Blueprint。**

首先需要完成：

**把 Phase 0 与 Phase 1 转换为实际 Repository 结构、模块 Package、Database Schema 顺序、API / Event Contract、首批 Backlog 与第一个可执行 Sprint / Work Package。**

推进原则：

* 先形成 Engineering Blueprint，再开始批量写业务代码
* Blueprint 只细化 Phase 0 与 Phase 1，不提前为所有后续 Phase 写详细实现
* 首批 Backlog 必须能够直接进入开发工具
* 每个 Work Package 必须对应明确验收场景
* 技术选型只在影响首批实现时锁定


---

## 46. Implementation Specification / Engineering Blueprint

### 46.1 Blueprint 范围

本阶段只细化 Phase 0 与 Phase 1，使代码仓库可以立即建立，并让首批 Work Package 可以直接进入开发。

当前顺序：

* Repository Blueprint
* Module Blueprint
* Database Blueprint
* API / Event Contract Blueprint
* Initial Backlog
* First Executable Work Package

### 46.2 Repository Strategy

v0.1 采用 TypeScript Monorepo，并继续保持模块化单体。

建议基础工具：

* Package Manager：`pnpm`
* Workspace / Task Orchestration：`Turborepo`
* Backend：Node.js + TypeScript + Express 5
* Frontend：React 19 + TypeScript
* Customer Channel：PWA
* Database：PostgreSQL
* Local Dependencies：Docker Compose
* Test：Unit、Integration、Contract、E2E 分层

Hosting、Queue、Object Storage、Payment、ORM 与 Observability 产品继续属于 Implementation Choice，但不得改变已经冻结的 Domain Contract。

### 46.3 Top-level Repository Structure

```text
bop-rms/
├─ apps/
│  ├─ api/
│  ├─ worker/
│  ├─ merchant-web/
│  ├─ customer-pwa/
│  └─ store-gateway/
├─ packages/
│  ├─ bop/
│  ├─ rms/
│  ├─ contracts/
│  ├─ database/
│  ├─ observability/
│  ├─ testing/
│  ├─ ui/
│  ├─ config/
│  └─ tooling/
├─ infrastructure/
│  ├─ docker/
│  ├─ deployment/
│  ├─ environments/
│  ├─ monitoring/
│  └─ scripts/
├─ docs/
│  ├─ architecture/
│  ├─ adr/
│  ├─ api/
│  ├─ events/
│  ├─ runbooks/
│  └─ onboarding/
├─ tests/
│  ├─ architecture/
│  ├─ contract/
│  ├─ e2e/
│  ├─ performance/
│  └─ security/
├─ migrations/
├─ fixtures/
├─ package.json
├─ pnpm-workspace.yaml
├─ turbo.json
├─ tsconfig.base.json
├─ eslint.config.js
└─ README.md
```

核心规则：

* `apps` 只负责 Composition Root、Transport、Runtime 与 Deployment Entry Point
* 业务规则必须位于 `packages/bop` 或 `packages/rms`
* `packages/contracts` 只保存跨模块公开 Contract，不保存业务实现
* `packages/database` 提供连接、Migration Runner 与基础 Persistence Contract，不拥有业务表
* `infrastructure` 不得被 Domain Layer Import
* `apps/api` 不允许直接访问其他模块私有 Repository
* `apps/worker` 只通过公开 Application Handler、Event Consumer 与 Job Contract 执行工作

### 46.4 Application Responsibilities

`apps/api` 负责 REST、Authentication、Tenant Context、Command / Query Dispatch、Webhook、Health 与 OpenAPI Composition。Controller 内不得实现业务规则、跨模块 Join 或写入其他模块私有表。

`apps/worker` 负责 Outbox、Inbox、Scheduled Job、Retry、Projection Rebuild、Expiration 与 Provider Reconciliation。

`apps/merchant-web` 在 Phase 0–1 负责 Brand / Store Context、Catalog、Order、Kitchen、Pickup、Device Status 与 Basic Reporting；权限最终判断仍在后端。

`apps/customer-pwa` 在 Phase 1 只包含 QR Entry、Menu、Cart、Quote、Checkout、Payment Status、Order Status 与 Pickup Code。

`apps/store-gateway` 作为 future-trigger Runtime Boundary，负责本地 Printer / Display Adapter、Offline Queue、Heartbeat 与 Device Credential；核心 Domain 不依赖 Gateway 是否启用。Section 87.11.1 明确第一 live Pilot 不部署 Gateway、physical printer 或 offline command queue。

### 46.5 BOP Package Structure

```text
packages/bop/
├─ kernel/
├─ identity/
├─ tenancy/
├─ operating-entity/
├─ permission/
├─ audit/
├─ eventing/
├─ outbox/
├─ inbox/
├─ task/
├─ notification/
├─ workflow/
├─ approval/
├─ publishing/
├─ effective-period/
├─ feature-flag/
├─ media/
├─ privacy/
└─ shared/
```

Phase 0 优先实现：`kernel`、`identity`、`tenancy`、`operating-entity`、`permission`、`audit`、`eventing`、`outbox`、`inbox`、`feature-flag`、`publishing`、`media`。

### 46.6 RMS Package Structure

```text
packages/rms/
├─ store/
├─ catalog/
├─ pricing/
├─ ordering/
├─ payment/
├─ kitchen/
├─ printing-device/
├─ fulfillment/
├─ dining/
├─ reservation-waiting/
├─ recipe/
├─ inventory/
├─ procurement/
├─ customer-loyalty/
├─ delivery/
├─ business-intelligence/
├─ compliance-food-safety/
└─ shared/
```

Phase 1 Critical Path：

```text
store
→ catalog
→ pricing
→ ordering
→ payment
→ kitchen
→ printing-device
→ fulfillment
→ business-intelligence projection
```

### 46.7 Standard Module Internal Structure

```text
<module>/
├─ src/
│  ├─ domain/
│  │  ├─ aggregates/
│  │  ├─ entities/
│  │  ├─ value-objects/
│  │  ├─ policies/
│  │  ├─ services/
│  │  ├─ events/
│  │  └─ errors/
│  ├─ application/
│  │  ├─ commands/
│  │  ├─ queries/
│  │  ├─ handlers/
│  │  ├─ ports/
│  │  ├─ dto/
│  │  └─ mappers/
│  ├─ infrastructure/
│  │  ├─ persistence/
│  │  ├─ adapters/
│  │  ├─ jobs/
│  │  └─ projections/
│  ├─ interface/
│  │  ├─ http/
│  │  ├─ events/
│  │  └─ internal/
│  ├─ public.ts
│  └─ index.ts
├─ test/
│  ├─ unit/
│  ├─ integration/
│  └─ contract/
└─ package.json
```

规则：

* `domain` 不 Import Infrastructure、HTTP、ORM 或 Provider SDK
* `application` 可以依赖 Domain 与 Port
* `infrastructure` 实现 Application Port
* `interface` 适配 Transport，但不拥有业务规则
* 外部模块只能 Import `public.ts`
* 模块私有路径不得通过 Workspace Alias 暴露

### 46.8 Shared Contract Structure

```text
packages/contracts/
├─ api/
├─ events/
├─ commands/
├─ queries/
├─ webhooks/
├─ errors/
├─ pagination/
├─ identity/
├─ tenant-context/
└─ versioning/
```

每个 Contract 必须包含 Name、Version、Owner、Consumer、Schema、Required / Optional Fields、Idempotency Rule、Compatibility Rule、Example 与 Error Model。

核心规则：

* Contract 不复制完整 Aggregate
* API DTO 与 Domain Entity 分开
* Breaking Change 必须发布新版本
* Provider Webhook 先映射为内部 Canonical Contract
* 前端不得依赖数据库字段结构

### 46.9 Naming Convention

* Workspace Scope：`@bop-rms/*`
* BOP Module：`@bop-rms/bop-identity`
* RMS Module：`@bop-rms/rms-ordering`
* Contract：`@bop-rms/contracts-events`
* Shared UI：`@bop-rms/ui`

代码命名：

* Aggregate Root：`Order`
* Command：`SubmitOrderCommand`
* Handler：`SubmitOrderHandler`
* Domain Event：`OrderSubmitted`
* Integration Event：`OrderSubmittedV1`
* Repository Port：`OrderRepository`
* Persistence Adapter：`PostgresOrderRepository`
* Query Service：`OrderReadModel`
* API DTO：`SubmitOrderRequestV1`

### 46.10 Dependency Rules

允许：

```text
apps → module public interface → application → domain
rms modules → bop public capabilities
infrastructure → application ports
```

禁止：

* BOP → RMS
* Domain → Infrastructure
* Domain → HTTP / ORM / SDK
* 一个 RMS Module → 另一个 RMS Module 的 private path
* Controller → Foreign Repository
* Projection → 修改 Source Aggregate
* Shared Package → 引入业务 Domain
* Provider Adapter → 改变 Canonical Domain Model

跨 Domain 协作优先级：

1. 同步公开 Application Interface
2. Domain / Integration Event
3. Query Contract
4. Snapshot / Reference
5. 禁止直接访问对方私有数据库表

### 46.11 Architecture Enforcement

CI 必须执行：

* Workspace Dependency Graph Check
* Circular Dependency Check
* Public Export Boundary Check
* Forbidden Import Check
* BOP → RMS Reverse Dependency Check
* Domain Layer Dependency Check
* Database Ownership Check
* Contract Version Check
* Migration Naming / Ownership Check

每个业务表必须声明 Owning Module、Aggregate / Projection Type、Write Owner、Allowed Read Pattern、Retention Category 与 PII Classification。

### 46.12 Test、Configuration 与 Documentation

测试分层：Module Unit、Module Integration、Contract、Architecture、E2E、Failure Injection、Security 与 Migration Test。

环境：`local`、`test`、`staging`、`production`。Environment Variable 必须启动时验证；Secret 只通过 Secret Reference 注入；Brand / Store 业务配置不放入环境变量。

必须维护：

* `docs/architecture/system-context.md`
* `docs/architecture/module-map.md`
* `docs/architecture/dependency-rules.md`
* `docs/adr/ADR-xxxx.md`
* `docs/api/openapi.md`
* `docs/events/event-catalog.md`
* `docs/runbooks/deployment.md`
* `docs/runbooks/outbox-recovery.md`
* `docs/runbooks/payment-reconciliation.md`
* `docs/onboarding/developer-setup.md`

### 46.13 Repository Bootstrap Deliverables

* 初始化 Monorepo
* Root Scripts
* TypeScript Base Config
* ESLint / Formatter
* Unit Test Runner
* Integration Test Harness
* Architecture Test
* Docker Compose
* API / Worker Skeleton
* Merchant / Customer App Skeleton
* Shared Contract Package
* Database Migration Runner
* Structured Logging
* Health / Readiness
* CI Workflow
* ADR Template
* Module Generator

### 46.14 Repository Bootstrap Acceptance Criteria

必须通过：

1. 单条命令启动 Database、API、Worker、Merchant Web 与 Customer PWA
2. API `/health` 与 `/ready` 返回结构化状态
3. 示例 Command 在数据库事务内写入记录与 Outbox Event
4. Worker 幂等消费 Event 并写入 Projection
5. 重复消费不产生重复结果
6. CI 检测非法 `BOP → RMS` Import
7. CI 检测 Domain Import ORM
8. Migration 可在空数据库完成安装
9. Test 可在隔离数据库运行
10. Staging Pipeline 可构建并部署 Skeleton
11. Repository 不包含真实 Secret
12. Module Generator 可建立标准模块结构

### 46.15 Repository Blueprint 状态

Repository Blueprint v0.1 已完成并 Freeze。

已锁定：

* TypeScript Monorepo
* 顶层目录结构
* BOP 与 RMS Package 划分
* 标准模块内部结构
* Public Contract 与 Dependency Rules
* Architecture Enforcement
* Test、Configuration 与 Documentation 结构
* Repository Bootstrap Deliverables 与 Acceptance Criteria

---

## 历史讨论节点 H-047（已完成）

Implementation Specification / Engineering Blueprint 已开始。

已完成：

* Repository Blueprint

下一步进入：

**Module Blueprint。**

首先需要完成：

* Phase 0 BOP Minimum Kernel 的实际模块清单
* Phase 1 RMS Critical Path 的模块 Package
* 每个模块的职责、公开 Interface、依赖与禁止依赖
* 模块创建顺序
* 模块级验收标准

---

## 48. Module Blueprint

### 48.1 目标与范围

Module Blueprint 将 Phase 0 的 BOP Minimum Kernel 与 Phase 1 的 RMS Critical Path 映射为实际 Package、公开 Contract、依赖关系、创建顺序与模块级验收标准。

本阶段只锁定模块边界，不展开具体 Database Table、REST Route、Event Payload 字段与 UI 页面；这些内容分别在 Database Blueprint、API / Event Contract Blueprint 与后续 Work Package 中完成。

核心规则：

* 每个 Module 拥有自己的 Domain Model、Application Handler、Persistence Adapter、Interface Adapter 与 Migration
* 跨 Module 写操作只能调用对方 Public Application Contract 或消费事实 Event
* 任何 Module 不得直接写入其他 Module 的业务表
* Public Contract 只暴露稳定业务语义，不暴露 ORM Entity、数据库 Row 或内部 Aggregate
* 同步依赖只用于当前请求必须获得结果的场景；其余协作优先使用 Event
* BOP Module 不得依赖 RMS Module
* Projection、Reporting 与 Search Read Model 不获得源 Aggregate 的写权限

### 48.2 Module Manifest

每个 Module 根目录必须包含 `module.manifest.ts`，至少声明：

* Module Name
* Layer：`BOP` 或 `RMS`
* Lifecycle：`Phase 0`、`Phase 1` 或 Later
* Public Exports
* Allowed Synchronous Dependencies
* Consumed Events
* Published Events
* Owned Database Schema / Tables
* Owned Jobs
* Feature Flags / Kill Switches
* PII Classification
* Module Owner

Architecture Test 根据 Manifest 验证依赖，不允许仅依靠团队约定。

### 48.3 Phase 0 — BOP Minimum Kernel 模块清单

#### 48.3.1 `@bop/common-kernel`

职责：

* ID、Clock、Money、Currency、Time Zone、Result、Domain Error 等基础类型
* Actor、Tenant、Brand、Store、Correlation、Causation 等 Context Value Object
* Aggregate Version、Optimistic Concurrency、Idempotency Key
* Domain Event Envelope 与 Pagination Contract

公开：稳定 Value Object、基础 Interface 与无业务含义的纯工具。

允许依赖：无业务 Module。

禁止：

* 不保存业务 Entity
* 不实现权限、订单、价格等领域规则
* 不形成“万能 Shared Model”

验收：所有模块可复用基础类型；Common Kernel 不反向依赖任何 BOP / RMS 模块。

#### 48.3.2 `@bop/identity`

职责：User、Credential、Authentication Session、External Identity Link、MFA / Verification。

公开 Interface：

* Authenticate
* Resolve Actor
* Issue / Revoke Session
* Verify Credential / One-time Code
* Get Actor Reference

发布 Event：`UserRegistered`、`IdentityLinked`、`SessionRevoked`、`CredentialCompromised`。

依赖：Common Kernel、Audit、Event / Outbox；可通过 Adapter 使用 Email / SMS Provider。

禁止：不拥有 Brand Membership、Store Role 或业务权限。

验收：可建立 Customer、Merchant Staff 与 Platform Admin 的隔离身份；Session 撤销可立即生效；敏感 Credential 不进入普通日志。

#### 48.3.3 `@bop/tenant`

职责：Platform、Brand、Store 的 Tenant Scope、Tenant Context Resolution 与 Scope Guard。

公开 Interface：

* Resolve Tenant Context
* Assert Brand / Store Scope
* List Accessible Tenant References

依赖：Common Kernel、Identity；只读取 Operating Entity 的公开 Reference。

禁止：不拥有 Legal Entity、Membership 或 Permission Grant。

验收：所有业务 Request 均可解析 Brand / Store Context；跨 Brand 访问默认拒绝；后台 Job 必须显式携带 Scope。

#### 48.3.4 `@bop/operating-entity`

职责：Legal Entity、Brand 与 Store 之间的经营主体关系，税号、注册地址、法定名称与有效期 Reference。

公开 Interface：

* Create / Update Operating Entity
* Bind Brand / Store
* Resolve Effective Operating Entity
* Get Legal / Tax Snapshot Reference

依赖：Common Kernel、Tenant、Publishing、Audit、Event。

禁止：不计算税额、不处理付款结算、不拥有许可证 Case。

验收：同一 Brand 可关联多个 Legal Entity；Store 可解析交易时有效主体；历史交易 Snapshot 不因主体变更而改写。

#### 48.3.5 `@bop/membership`

职责：Merchant User 与 Brand 的 Membership、Store Assignment、Employment / Contractor Status Reference。

公开 Interface：

* Create / Suspend Membership
* Assign / Remove Store
* Resolve Active Membership

依赖：Identity、Tenant、Effective Period、Audit、Event。

禁止：不定义 Permission；不管理排班或工资。

验收：同一 User 可属于多个 Brand；不同 Store Assignment 独立生效；Suspended Membership 不能获得业务访问。

#### 48.3.6 `@bop/permission`

职责：Role、Permission、Grant、Explicit Allow / Deny、Scope 与 Business Action Authorization。

公开 Interface：

* Authorize Action
* Explain Authorization Decision
* Manage Role / Grant / Override

依赖：Identity、Tenant、Membership、Effective Period、Audit。

禁止：

* 前端 Permission 不作为最终依据
* 不直接改变业务 Aggregate 状态
* 不把 Workflow 条件塞入通用 Role

验收：支持 Brand / Store / User Scope；符合 Deny 优先级；每次高风险拒绝或 Override 有审计解释。

#### 48.3.7 `@bop/audit`

职责：Append-only Audit Record、Actor、Action、Before / After Reference、Reason、Correlation 与 Retention。

公开 Interface：

* Append Audit Entry
* Query Authorized Audit Trail
* Register Correction / Controlled Redaction

依赖：Common Kernel、Tenant、Privacy Governance。

禁止：普通业务模块不可更新或删除历史 Audit；Audit 失败不得被静默忽略。

验收：关键写操作均关联 Audit；普通员工不可篡改；敏感字段按权限 Mask。

#### 48.3.8 `@bop/eventing`

职责：Domain Event Envelope、In-process Dispatch、Transactional Outbox、Consumer Inbox、Retry 与 Dead-letter。

公开 Interface：

* Append Event in Transaction
* Publish Outbox Batch
* Register Consumer
* Claim / Complete / Retry Inbox Item

依赖：Common Kernel、Observability、Database Infrastructure。

禁止：不包含具体业务 Event 语义；不允许 Consumer 绕过 Application Handler 写其他模块表。

验收：事务与 Event 原子提交；重复 Event 不重复产生结果；失败可重试与追踪；支持 Replay 到新 Projection。

#### 48.3.9 `@bop/workflow`

职责：Versioned Workflow Definition、Allowed Action、Transition Evaluation 与 Transition Record。

公开 Interface：

* Resolve Workflow Version
* Evaluate Action
* Record Transition

依赖：Common Kernel、Permission、Publishing、Effective Period、Audit。

禁止：不成为统一 Policy DSL；业务 Module 仍拥有状态语义与最终不变量。

验收：工作流版本可固定到交易；未授权 Action 被拒绝；历史 Transition 可完整还原。

#### 48.3.10 `@bop/approval`

职责：Approval Request、Step、Approver Scope、Decision、Expiry 与 Delegation Reference。

公开 Interface：

* Request Approval
* Approve / Reject / Cancel
* Resolve Approval Outcome

依赖：Identity、Membership、Permission、Task、Notification、Audit。

禁止：不直接执行被审批的业务动作；审批通过后由发起 Module 再次验证并执行。

验收：申请人与审批人限制有效；过期审批不能执行；Decision 追加保存。

#### 48.3.11 `@bop/task`

职责：可执行工作项、Queue、Assignment、Claim、Due Date、Escalation 与 Completion Reference。

公开 Interface：Create、Assign、Claim、Complete、Fail、Cancel Task。

依赖：Identity、Membership、Permission、Notification、Audit。

禁止：Task Completion 不等同于业务事实完成；业务 Module 必须确认结果。

验收：支持 User、Role、Queue；重复 Completion 幂等；逾期可升级。

#### 48.3.12 `@bop/notification`

职责：Notification Request、Template Reference、Channel Routing、Delivery Attempt、Preference 与 Suppression。

公开 Interface：

* Request Notification
* Resolve Preference
* Query Delivery Status

依赖：Identity、Tenant、Publishing、Privacy Governance、Eventing。

禁止：不拥有业务事实；Provider Payload 不进入业务 Domain。

验收：支持 Email / SMS / Push Adapter；重复请求去重；营销与交易通知偏好分离。

#### 48.3.13 `@bop/media`

职责：Asset Metadata、Upload Session、Virus / Content Check、Variant、Access Policy 与 Retention。

公开 Interface：Create Upload、Finalize Asset、Authorize Access、Create Variant、Archive Asset。

依赖：Tenant、Identity、Privacy Governance、Audit、Eventing。

禁止：业务 Aggregate 只保存 Asset Reference；不在业务表保存文件 Binary。

验收：上传与业务绑定分离；未完成或被隔离 Asset 不可公开；访问按 Scope 验证。

#### 48.3.14 `@bop/publishing`

职责：Draft、Review、Approval、Publish、Schedule、Archive、Rollback 与 Release Record。

公开 Interface：Create Draft、Submit Review、Approve、Publish、Schedule、Rollback Configuration Version。

依赖：Permission、Approval、Effective Period、Audit、Eventing。

禁止：回滚只影响 Configuration，不回滚已发生 Transaction。

验收：发布版本不可覆盖；定时发布幂等；Rollback 产生新 Release Record。

#### 48.3.15 `@bop/effective-period`

职责：Effective From / Until、Time Zone、Activation、Expiry、Renewal 与 Overlap Validation。

公开 Interface：Validate Period、Resolve Effective Version、Schedule Activation / Expiry。

依赖：Common Kernel、Task / Notification（提醒）。

禁止：不拥有调用方配置内容。

验收：边界时刻与 Time Zone 一致；重叠策略可验证；历史解析可复现。

#### 48.3.16 `@bop/feature-control`

职责：Release Flag、Kill Switch、Scope、Rollout、Recovery Policy 与 Evaluation Record。

公开 Interface：Evaluate Flag、Activate Kill Switch、Begin Recovery、Get Effective Control。

依赖：Tenant、Permission、Audit、Effective Period。

禁止：前端隐藏不等于后端禁用；业务模块仍需执行安全状态处理。

验收：Brand / Store / Percentage Scope 生效；Kill Switch 可阻止新操作；恢复过程可审计。

#### 48.3.17 `@bop/privacy-governance`

职责：Data Classification、Purpose、Consent Reference、Retention、Deletion / Anonymization Request、Legal Hold 与 Access Policy。

公开 Interface：Classify、Authorize Purpose、Resolve Retention、Request Erasure、Apply / Release Legal Hold。

依赖：Identity、Tenant、Audit、Task、Eventing。

禁止：不直接修改其他模块数据；通过受控 Command / Job 协调各 Data Owner。

验收：PII 字段有分类；Legal Hold 阻止删除；删除请求可追踪各模块执行结果。

#### 48.3.18 `@bop/configuration-contract`

职责：提供 Domain-owned Versioned Configuration 的共享 Contract、Overlay Resolution、Compatibility 与 Change Impact Interface。

公开：Configuration Metadata、Scope Resolution、Version Status、Effective Period 与 Validation Contract。

依赖：Publishing、Effective Period、Tenant、Audit。

禁止：v0.1 不建立统一 Configuration Aggregate 或通用字段存储。

验收：各 Domain 保持配置所有权；平台可统一解析 Platform → Brand → Store Overlay；不存在跨域万能配置表。

### 48.4 Phase 1 — RMS Critical Path 模块

#### 48.4.1 `@rms/store`

职责：Store Profile、Operating Hours、Order Channel Enablement、Time Zone、Contact、Fulfillment Capability 与基础门店配置。

公开 Interface：Resolve Store、Get Effective Store Configuration、Validate Store Operational State。

同步依赖：Tenant、Operating Entity、Publishing、Effective Period、Media。

发布 Event：`StoreActivated`、`StoreConfigurationPublished`、`StoreTemporarilyClosed`。

禁止：不拥有 Catalog、价格、容量、设备或员工权限。

验收：可建立一个 Pilot Store；能判断某时刻是否允许 Dine-in / Pickup / Delivery；配置版本可追溯。

#### 48.4.2 `@rms/catalog`

职责：Product、SKU、Variant、Option Set、Menu、Sellable、Availability Configuration 与发布 Snapshot。

公开 Interface：

* Get Published Menu
* Resolve Sellable Snapshot
* Validate Selection
* Publish Catalog Version

同步依赖：Store Reference、Media、Publishing、Effective Period、Configuration Contract。

发布 Event：`CatalogVersionPublished`、`SellableAvailabilityChanged`。

禁止：不计算最终价格、税或 Promotion；不读取 Cart / Order 表。

验收：Customer 可读取门店已发布 Menu；选择可由后端重新验证；历史 Order Snapshot 不依赖当前 Catalog 名称。

#### 48.4.3 `@rms/pricing`

职责：Base Price、Tax、Fee、Promotion Evaluation、Price Quote 与 Quote Snapshot。

公开 Interface：Create Quote、Recalculate Quote、Validate Quote、Explain Price Components。

同步依赖：Catalog Public Snapshot、Store Configuration、Customer / Loyalty Reference（可选）、Operating Entity Tax Reference。

发布 Event：`PriceQuoteCreated`、`PriceQuoteExpired`、`PricingConfigurationPublished`。

禁止：不创建 Order、不捕获 Payment、不直接修改 Catalog。

验收：相同输入与版本产生可复算结果；Money / Tax 舍入稳定；Quote 过期或输入改变必须重算。

#### 48.4.4 `@rms/ordering`

职责：Cart、Checkout、Order、Order Item Snapshot、Order Amendment、Cancellation 与 Canonical Order Lifecycle。

公开 Interface：

* Create / Update Cart
* Submit Checkout
* Create Order from Valid Quote
* Confirm / Cancel / Amend Order
* Query Order Snapshot

同步依赖：Store、Catalog Selection Validation、Pricing Quote、Permission / Workflow；Payment 通过公开 Command / Event 协作。

发布 Event：`OrderSubmitted`、`OrderConfirmed`、`OrderCancelled`、`OrderAmended`。

禁止：不直接写 Payment、Kitchen、Inventory 或 Fulfillment 表；不从当前 Catalog 重建历史订单。

验收：正式 Order 保存完整不可变交易快照；重复 Submit 幂等；取消与修改保留历史。

#### 48.4.5 `@rms/payment`

职责：Payment Intent、Authorization、Capture、Failure、Refund、Provider Webhook、Ledger Reference 与 Reconciliation。

公开 Interface：Create Intent、Confirm Payment、Capture、Refund、Get Payment Status、Process Provider Webhook。

同步依赖：Ordering Reference、Operating Entity、Permission、Audit；外部 Provider 经 Adapter。

发布 Event：`PaymentAuthorized`、`PaymentCaptured`、`PaymentFailed`、`RefundCompleted`、`PaymentReconciliationDifferenceDetected`。

禁止：不改变 Order 状态；不允许 Provider Status 直接成为内部事实；不保存卡片敏感数据。

验收：Webhook 幂等；重复 Capture / Refund 不重复执行；Provider 与内部状态冲突进入 Reconciliation。

#### 48.4.6 `@rms/kitchen`

职责：Kitchen Work Item、Station Routing、Preparation Status、Ready Result 与 Exception。

公开 Interface：Create Work from Order、Accept、Start、Complete Item、Mark Ready、Report Exception。

事件依赖：消费 `OrderConfirmed`；发布 `KitchenWorkCreated`、`KitchenItemReady`、`KitchenWorkFailed`。

同步依赖：Catalog Preparation Snapshot、Store / Station Configuration、Workflow、Permission。

禁止：不重新计算订单金额；不直接完成 Fulfillment；不写 Order 状态。

验收：Order Confirm 后幂等创建 Work；重复 Event 不创建重复 Item；Ready 数量不超过 Required Quantity。

#### 48.4.7 `@rms/printing-device`

职责：Device、Capability、Output Job、Routing、Template、Attempt、Retry、Fallback 与 Reprint。

公开 Interface：Register Device、Evaluate Health、Request Output、Reprint、Query Output Status。

事件依赖：消费 Order / Kitchen 事实；发布 Output Job 与 Device Health Event。

同步依赖：Store、Media、Publishing、Permission；Gateway / SDK 经 Adapter。

禁止：不把打印成功当成业务完成；不修改 Order / Kitchen 状态。

验收：同一 Source + Document Type 幂等创建 Job；设备失败可 Fallback；物理输出与业务事实分离。

#### 48.4.8 `@rms/fulfillment`

职责：Phase 1 先实现 Pickup Fulfillment、Fulfillment Item、Time Window、Handoff Record 与 Completion。

公开 Interface：Create Fulfillment、Plan Pickup、Mark Item Ready、Validate Handoff、Complete / Fail / Cancel Fulfillment。

事件依赖：消费 `OrderConfirmed`、`KitchenItemReady`、`OrderCancelled`；发布 `FulfillmentReady`、`PickupHandedOver`、`FulfillmentCompleted`。

同步依赖：Ordering Snapshot、Store、Permission、Workflow、Notification。

禁止：不决定商业取消、退款或价格；不直接改变 Kitchen Work。

验收：Order Confirm 后幂等创建；只有全部非取消 Item Validated Handoff 后 Completed；部分交接不能提前完成。

#### 48.4.9 `@rms/operational-reporting`

职责：Phase 1 最小 Read Projection，包括当前订单、厨房队列、付款状态、输出状态与取餐状态。

公开 Interface：只读 Query Contract。

事件依赖：消费 Ordering、Payment、Kitchen、Output、Fulfillment Event。

禁止：不成为源事实；不允许通过 Projection 修改业务状态；可完全重建。

验收：可以从 Event Replay 重建；Projection 延迟可监控；敏感字段按权限过滤。

### 48.5 Phase 1 不进入 Critical Path 的模块

以下模块保留 Package 名称与边界，但不阻塞 Phase 1：

* `@rms/dining`
* `@rms/reservation-waiting`
* `@rms/recipe`
* `@rms/inventory`
* `@rms/procurement-supplier`
* `@rms/customer-loyalty`
* `@rms/delivery-fulfillment` 的 Delivery 扩展
* `@rms/business-intelligence`
* `@rms/compliance-food-safety`

Phase 1 可以使用明确的 Stub / Adapter Contract，但禁止在 Ordering 等模块内临时实现这些模块的业务规则。

### 48.6 Dependency Graph

Phase 0 主链：

`common-kernel`

→ `identity`

→ `tenant` / `operating-entity` / `membership`

→ `permission` / `audit` / `eventing`

→ `workflow` / `approval` / `task` / `notification`

→ `media` / `publishing` / `effective-period` / `feature-control` / `privacy-governance` / `configuration-contract`

Phase 1 主链：

`store`

→ `catalog`

→ `pricing`

→ `ordering`

→ `payment`

→ `kitchen`

→ `printing-device`

→ `fulfillment`

→ `operational-reporting`

依赖类型：

* `Direct Code Dependency`：只允许依赖对方 Public Contract / Value Object
* `Synchronous Application Call`：当前操作必须立即获得结果时使用
* `Domain Event`：传播已经发生的事实
* `Projection Feed`：只读模型消费事实
* `Adapter Dependency`：外部 Provider，仅 Infrastructure Layer 可依赖

明确禁止：

* BOP → RMS
* Catalog → Ordering / Payment / Kitchen
* Pricing → Ordering / Payment
* Payment → Ordering 私有实现
* Kitchen → Ordering Repository
* Fulfillment → Payment Repository
* Reporting → 任意 Source Module 写接口
* 任意 Module → 其他 Module 的 ORM Model、Migration 或私有 Table

### 48.7 Module Creation Order

推荐顺序：

1. Common Kernel
2. Eventing + Database Baseline
3. Identity
4. Tenant
5. Operating Entity
6. Membership
7. Permission
8. Audit
9. Effective Period + Publishing
10. Workflow + Approval + Task
11. Notification + Media + Feature Control + Privacy Governance
12. Configuration Contract
13. Store
14. Catalog
15. Pricing
16. Ordering
17. Payment
18. Kitchen
19. Printing & Device
20. Fulfillment
21. Operational Reporting

规则：每个新 Module 必须先完成 Manifest、Public Contract、Architecture Test 与最小 Integration Test，再添加业务实现。

### 48.8 Module Generator Template

Module Generator 输入：

* Layer：BOP / RMS
* Module Name
* Package Name
* Phase
* Allowed Dependencies
* Database Schema Name
* Owner

生成：

```text
packages/{layer}/{module}/
├─ src/
│  ├─ domain/
│  │  ├─ aggregates/
│  │  ├─ entities/
│  │  ├─ value-objects/
│  │  ├─ services/
│  │  ├─ events/
│  │  └─ errors/
│  ├─ application/
│  │  ├─ commands/
│  │  ├─ queries/
│  │  ├─ handlers/
│  │  ├─ ports/
│  │  └─ dto/
│  ├─ infrastructure/
│  │  ├─ persistence/
│  │  ├─ adapters/
│  │  ├─ jobs/
│  │  └─ config/
│  ├─ interface/
│  │  ├─ http/
│  │  ├─ events/
│  │  └─ jobs/
│  ├─ contracts/
│  ├─ module.manifest.ts
│  └─ index.ts
├─ migrations/
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  └─ contract/
├─ package.json
├─ tsconfig.json
└─ README.md
```

Generator 同时建立：

* 空白 ADR（如存在新架构决定）
* Package Export Map
* Dependency Rule
* Test Project
* Migration Namespace
* Module README 模板

### 48.9 Module-level Definition of Done

每个 Module 首次可用必须满足：

1. Manifest 完整且 Architecture Test 通过
2. Public Contract 有类型定义与版本策略
3. Domain Invariant 有 Unit Test
4. Persistence 有隔离 Integration Test
5. Command / Query Handler 有授权与 Tenant Scope 检查
6. 写操作包含 Audit 与必要 Outbox Event
7. Consumer 具备 Inbox / Idempotency
8. Migration 可从空数据库执行
9. 日志不泄露 Secret / PII
10. Health、Metric 与错误码可观测
11. Feature Flag / Disable Strategy 明确
12. README 说明职责、依赖、数据所有权与运行方式
13. 禁止依赖测试通过
14. 至少一个业务 Acceptance Scenario 在集成环境通过

### 48.10 Module Blueprint 验收场景

必须能够证明：

* `@bop/common-kernel` 不依赖任何业务模块
* `@bop/identity` 可认证 Actor，但无法自行授予 Store 权限
* `@bop/permission` 可解释授权结果，但不能直接修改 Order
* `@rms/catalog` 可发布 Menu，但不能读取 Cart 表
* `@rms/pricing` 可生成 Quote，但不能创建 Order
* `@rms/ordering` 只能通过 Payment Public Contract / Event 协作
* `@rms/kitchen` 通过 Event 接收已确认订单，不直接查询 Ordering 私有表
* `@rms/fulfillment` 通过 Ready Event 推进，不直接更新 Kitchen
* Reporting 删除并重建后，源交易数据不受影响
* CI 对任何越界 Import 或跨 Schema 写入直接失败

### 48.11 Module Blueprint 状态

Module Blueprint v0.1 已完成并 Freeze。

已锁定：

* Phase 0 BOP Minimum Kernel 模块清单
* Phase 1 RMS Critical Path 模块清单
* 模块职责与 Public Interface 边界
* 同步依赖、Event 依赖与禁止依赖
* Module Dependency Graph
* Module Creation Order
* Module Generator Template
* Module-level Definition of Done 与验收场景

---

## 历史讨论节点 H-049（已完成）

Implementation Specification / Engineering Blueprint 已完成：

* Repository Blueprint
* Module Blueprint

下一步进入：

**Database Blueprint。**

首先需要完成：

* PostgreSQL Schema 与 Migration Namespace
* Phase 0 / Phase 1 建表顺序
* Aggregate、Entity、Append-only Record 与 Projection 的 Table 映射
* 主键、外键、Tenant Scope、Optimistic Concurrency 与 Money / Time 类型规范
* Outbox、Inbox、Audit、Snapshot 与 Idempotency 表
* 跨 Module 数据读取与禁止写入规则
* Database Migration、Seed、Fixture 与测试数据库策略

---

## 50. Database Blueprint

### 50.1 目标与范围

Database Blueprint 将 Repository Blueprint 与 Module Blueprint 转换为可执行的 PostgreSQL Schema、Migration、Table Ownership、数据类型、并发、系统表与治理规则。

本阶段只细化 Phase 0 与 Phase 1，后续 Domain 使用同一规范扩展。

核心原则：

* 每个业务 Module 拥有自己的 Schema 或受控 Table Namespace
* 只有 Owning Module 可以写入自己的业务表
* 跨 Module 协作通过 Public Application Contract、Event 或受控 Projection 完成
* Transaction Source of Truth 与 Projection / Reporting 数据分离
* 所有业务写入必须具备 Tenant Scope、Audit、Concurrency 与必要 Outbox Event
* 不把 Provider-specific Payload、UI State 或临时流程塞入核心业务表
* Migration 是代码的一部分，必须经过 Review、测试与部署控制

### 50.2 PostgreSQL Schema Strategy

v0.1 采用单一 PostgreSQL Database、多 Schema 的模块化单体结构。

平台级 Schema：

* `platform_core`：数据库版本、系统锁、全局技术元数据
* `platform_eventing`：Outbox、Inbox、Event Delivery 与 Dead Letter
* `platform_audit`：Audit、Change Record 与访问审计
* `platform_jobs`：Job、Schedule、Lease 与 Execution Record
* `platform_projection`：跨 Module Operational Projection

BOP Module Schema：

* `bop_identity`
* `bop_tenancy`
* `bop_operating_entity`
* `bop_permission`
* `bop_workflow`
* `bop_approval`
* `bop_notification`
* `bop_task`
* `bop_media`
* `bop_publishing`
* `bop_feature_flag`
* `bop_privacy`

RMS Phase 1 Schema：

* `rms_store`
* `rms_catalog`
* `rms_pricing`
* `rms_ordering`
* `rms_payment`
* `rms_kitchen`
* `rms_device`
* `rms_fulfillment`
* `rms_reporting`

规则：

* 一个 Module 默认只拥有一个业务 Schema
* 高频或大规模 Projection 可使用独立 Projection Schema，但 Write Owner 仍需明确
* Schema 名称稳定，不包含环境、Brand 或 Store 名称
* Tenant 隔离通过 Row Scope 实现，不为每个 Brand 创建独立 Schema
* `public` Schema 不保存业务表，只保留经过批准的 Extension 与最小 Bootstrap 对象

### 50.3 Migration Namespace 与目录

Migration 目录按层级组织：

```text
migrations/
├─ 0000-platform/
├─ 0100-bop-common/
├─ 0200-bop-identity-tenancy/
├─ 0300-bop-governance/
├─ 0400-bop-operations/
├─ 1000-rms-store/
├─ 1100-rms-catalog/
├─ 1200-rms-pricing/
├─ 1300-rms-ordering/
├─ 1400-rms-payment/
├─ 1500-rms-kitchen/
├─ 1600-rms-device/
├─ 1700-rms-fulfillment/
└─ 1800-rms-reporting/
```

文件命名：

`<namespace>_<sequence>_<action>_<object>.sql`

示例：

* `1100_001_create_catalog_schema.sql`
* `1100_010_create_product_table.sql`
* `1300_020_create_order_tables.sql`

规则：

* 已在 Shared Environment 执行的 Migration 不允许修改
* 修改通过新的 Forward Migration 表达
* 破坏性变更使用 Expand → Migrate → Contract
* 一个 Migration 只处理一个可审查的结构变化
* 每个 Migration 必须声明 Owning Module、风险级别、预计锁时间与回退方式
* Migration Runner 使用全局顺序并记录 Checksum

### 50.4 Phase 0 / Phase 1 建表顺序

#### Stage DB-0：Platform Baseline

1. Schema Registry / Migration History
2. Outbox
3. Inbox / Consumer Idempotency
4. Audit Record
5. Job / Lease / Execution
6. Projection Checkpoint

#### Stage DB-1：Tenant 与 Identity

1. Brand / Tenant
2. Store Scope 基础引用
3. User / Actor Identity
4. Credential / External Identity Link
5. Membership
6. Operating Entity
7. Store–Operating Entity Assignment

#### Stage DB-2：Governance

1. Role
2. Permission Definition
3. Permission Grant / Override
4. Workflow Definition / Version
5. Approval Request / Decision
6. Feature Flag / Kill Switch
7. Publishing Record
8. Media Asset / Attachment Reference
9. Privacy Classification / Retention Rule

#### Stage DB-3：Store 与 Catalog

1. Store Configuration
2. Catalog Product
3. SKU / Variant
4. Option Set / Option
5. Product Binding
6. Menu / Menu Section
7. Menu Item Binding
8. Published Catalog Version / Snapshot

#### Stage DB-4：Pricing 与 Ordering

1. Tax Configuration
2. Price Definition / Price Book
3. Quote / Quote Line / Tax Line
4. Cart / Cart Line
5. Order / Order Line
6. Order Snapshot / Revision
7. Order Action / Status History

#### Stage DB-5：Payment、Kitchen、Device、Fulfillment

1. Payment Intent / Attempt
2. Payment Transaction / Webhook Inbox
3. Kitchen Ticket / Work Item
4. Kitchen Status History
5. Device / Device Capability
6. Output Job / Attempt
7. Fulfillment / Handoff Record
8. Completion Record
9. Operational Reporting Projection

依赖表必须先于引用表建立；异步 Event Consumer 可以在源表之后独立部署。

### 50.5 Table Classification

每张表必须标记为以下一种：

* `Aggregate Root`
* `Aggregate Child Entity`
* `Immutable Snapshot`
* `Append-only Record`
* `Configuration Version`
* `Relationship / Assignment`
* `Projection / Read Model`
* `Integration Record`
* `Technical Control Record`

映射规则：

* Aggregate Root 使用独立 Table，保存 `id`、`version`、Tenant Scope 与 Lifecycle Status
* Child Entity 使用独立 Table；不得默认把可查询、可约束的 Child 全部存入 JSONB
* Value Object 可内联为列；只有结构高度变化且不参与关键约束时使用 JSONB
* Snapshot 保存交易发生时完整事实，后续配置变化不得覆盖
* Append-only Record 禁止普通 Update / Delete
* Projection 可删除重建，但必须保存 Source Checkpoint 与 Projection Version
* Relationship 必须保存生效期与来源，不使用无审计的 ID Array

### 50.6 Primary Key 与 Identifier

统一规则：

* 业务主键使用 UUID
* v0.1 business、Command、Event and Correlation IDs use UUIDv7；Idempotency Key remains an independent opaque contract
* 数据库内部禁止依赖自增 ID 作为外部业务标识
* 对外显示编号使用独立 `display_number` / `public_code`
* Provider ID 必须保存为 `provider_name + provider_reference`，不得作为主键
* Event ID、Command ID、Idempotency Key 与 Correlation ID 使用独立 UUID / String

所有外部可见 ID 在 API 中以 String 表达，避免前端数值精度问题。

### 50.7 Tenant Scope

Brand 是主要 Tenant Boundary。

业务表根据范围保存：

* `brand_id`：所有 Brand-owned 数据必填
* `store_id`：Store-owned 数据必填
* `operating_entity_id`：财务、税务、许可证或法定归属需要时保存
* `customer_account_id`：顾客数据按用途保存，不代替 Brand Scope

规则：

* Tenant Scope 必须由服务端 Context 注入和验证
* 禁止信任客户端自行提交的 Brand / Store Scope
* 所有关键 Unique Index 必须包含 Tenant Scope
* 所有常用查询 Index 必须以 `brand_id` 或 `store_id` 为前导列之一
* 跨 Brand 查询只允许受权限控制的 Platform / BI 路径
* 第一版对 Brand / Store-owned table 使用 PostgreSQL RLS 作为 defense-in-depth，具体采用 Section 87.7.5；应用层 Tenant / Permission authorization 仍是不可替代的主控制

### 50.8 Foreign Key 规则

Module 内部：

* 默认使用真实 Foreign Key
* Aggregate Child 必须引用 Aggregate Root
* 禁止无业务理由的 Cascade Delete

跨 Module：

* 默认保存稳定 Reference ID，不建立跨 Schema 强 FK
* 只有强一致、生命周期共同且经过 ADR 批准时建立跨 Module FK
* 跨 Module Reference 的有效性由 Application Contract、Event 与 Reconciliation 保证
* Projection 可以保存 Denormalized Reference，但不得反向写入源 Module

禁止通过跨 Schema FK 将两个独立 Aggregate 隐式合并。

### 50.9 Optimistic Concurrency

所有可变 Aggregate Root 必须包含：

* `version bigint not null`
* `created_at timestamptz not null`
* `updated_at timestamptz not null`
* `created_by_actor_id`
* `updated_by_actor_id`

更新条件：

`WHERE id = :id AND version = :expectedVersion`

成功后 `version = version + 1`。

冲突必须返回明确的 Concurrency Error，不允许 Last Write Wins。

Append-only Record 不使用 Update Version，但必须保存 Sequence / Occurred At / Recorded At。

### 50.10 Money、Decimal 与 Currency

Money 统一保存：

* `amount_minor bigint`
* `currency_code char(3)`

规则：

* Currency 使用 ISO 4217 Code
* 业务计算在 Domain Money Type 内完成
* 禁止使用 PostgreSQL `money` 类型
* 禁止使用 Float / Double 保存金额、税率、数量或配方用量
* 百分比、税率与可分数量使用 `numeric(precision, scale)`
* Quote、Order、Payment、Refund 分别保存自身 Money Snapshot
* 不因后续 Currency Minor Unit 或 Tax Rule 变化重算历史金额

### 50.11 Time、Business Date 与 Time Zone

统一规则：

* 事件时间使用 `timestamptz`，以 UTC 写入
* Store 保存 IANA Time Zone，例如 `America/Toronto`
* Local Operating Date 使用独立 `business_date date`
* 仅表示当地墙钟时间的配置使用 `time without time zone`
* Scheduled Rule 同时保存 Time Zone 与 Local Schedule Definition
* `occurred_at` 表示事实发生时间
* `recorded_at` 表示系统记录时间
* `effective_from / effective_until` 表示配置有效期
* 日期边界不能通过 UTC 零点硬编码

### 50.12 Status、Enum 与 Code Table

稳定、技术性的有限状态可使用 PostgreSQL Check Constraint 或代码层 Enum。

业务可配置、需多语言或可能扩展的 Reason Code 使用 Code Table / Versioned Configuration。

规则：

* 不使用 PostgreSQL Enum 承载频繁变化的业务状态
* Lifecycle 状态变化必须由 Action / Workflow 产生
* Reason Code 与 Free-text Note 分开保存
* `OTHER` 必须带说明

### 50.13 JSONB 使用规则

允许使用 JSONB：

* Immutable Snapshot Payload
* Provider Raw Payload
* 非关键扩展 Metadata
* Versioned Rule Definition
* Audit Before / After 摘要

禁止使用 JSONB：

* 需要 Foreign Key 的核心关系
* 需要 Unique Constraint 的业务字段
* 高频过滤、排序或 Join 的关键列
* Money、Tenant Scope、Status、Version、Occurred At
* 为避免设计 Table 而存放整个 Aggregate

Provider Raw Payload 必须与标准化字段分离，并配置 Retention 与 PII Classification。

### 50.14 Soft Delete、Archive 与 Append-only

规则：

* Transaction、Payment、Audit、Event、Proof、Handoff、Snapshot 不进行普通 Soft Delete
* Configuration 可使用 `archived_at`，但历史 Version 不删除
* 主数据停用使用 Lifecycle Status，不使用删除代表业务状态
* PII 删除请求通过 Anonymization / Tombstone / Controlled Deletion 执行
* Append-only Table 只允许 Insert；Correction 通过新 Record 与 `corrects_record_id` 表达
* Database Role 与 Trigger 可作为 Append-only 防护，但不能替代应用测试

### 50.15 Outbox Table

`platform_eventing.outbox_event` 至少保存：

* `event_id`
* `event_type`
* `event_version`
* `aggregate_type`
* `aggregate_id`
* `aggregate_version`
* `brand_id`
* `store_id`
* `correlation_id`
* `causation_id`
* `payload_json`
* `occurred_at`
* `recorded_at`
* `available_at`
* `published_at`
* `attempt_count`
* `last_error_code`

规则：

* 与业务写入同一 Database Transaction
* Event Payload 使用稳定 Public Contract，不序列化 ORM Entity
* Publisher 使用 Lease / `FOR UPDATE SKIP LOCKED`
* 发布成功后保留记录用于审计与恢复
* Payload 过大时保存 Asset / Snapshot Reference，不把大型文件塞入 Outbox

### 50.16 Inbox 与 Idempotency

`platform_eventing.consumer_inbox` 至少保存：

* `consumer_name`
* `event_id`
* `event_type`
* `received_at`
* `processed_at`
* `status`
* `attempt_count`
* `result_hash`
* `last_error_code`

Unique：`consumer_name + event_id`。

API Command Idempotency 使用独立 `platform_core.idempotency_record`：

* Scope
* Idempotency Key
* Request Hash
* Actor / Tenant
* Status
* Response Code / Response Reference
* Created / Expires At

相同 Key 不同 Request Hash 必须拒绝。

### 50.17 Audit Table

`platform_audit.audit_record` 至少保存：

* `audit_id`
* `brand_id / store_id`
* `actor_id / actor_type`
* `impersonation_reference`
* `action_code`
* `target_type / target_id`
* `before_summary_json`
* `after_summary_json`
* `reason_code / note`
* `correlation_id`
* `occurred_at / recorded_at`
* `source_ip / device_reference`（适用时）
* `pii_classification`

规则：

* Audit 与业务写入尽量同事务完成
* 不记录 Secret、完整支付凭据或不必要的敏感正文
* v0.1 禁止生成 impersonation Session / Token；`impersonation_reference` remains null unless a future accepted IDR introduces the controlled capability
* Audit 不作为业务 Aggregate 的 Source of Truth
* 更正 Audit 通过新的 Correction Record 表达

### 50.18 Event Store 与 Snapshot

v0.1 不采用完整 Event Sourcing。

决定：

* Aggregate 当前状态保存在标准业务表
* 关键变化保存 Domain Event、Action History、Revision 与 Snapshot
* `domain_event_log` 可用于可观测、回放与审计，但不作为所有 Aggregate 的唯一重建来源
* Order、Quote、Payment、Proof 等保存独立 Immutable Snapshot
* Projection 重建优先使用源业务表与 Event Checkpoint

未来若个别 Aggregate 需要 Event Sourcing，必须单独 ADR。

### 50.19 Job 与 Lease Table

`platform_jobs.job` 保存：

* Job Type / Version
* Scope
* Payload Reference
* Status
* Priority
* Available At
* Attempt / Max Attempt
* Lease Owner / Lease Until
* Timeout
* Correlation ID
* Last Error

规则：

* Job Handler 必须幂等
* Lease 过期后允许重新领取
* 长任务保存 Progress / Checkpoint
* Job Success 不代表业务成功，业务结果仍由对应 Domain Record 表达

### 50.20 Operational Projection

Projection 使用独立表，并保存：

* `projection_name`
* `projection_version`
* `source_checkpoint`
* `last_rebuilt_at`
* `freshness_status`

规则：

* Projection Table 可以 Denormalize
* 只允许 Projection Builder 写入
* API Query 读取 Projection 时必须声明允许的陈旧度
* Projection 失败不能回滚源 Transaction
* 重建采用 Shadow Table / Version Switch，避免长时间不可用

### 50.21 Phase 1 核心 Table Mapping

#### Store

* `rms_store.store`
* `rms_store.store_operating_profile`
* `rms_store.store_channel_config`
* `rms_store.store_qr_entry`

#### Catalog

* `rms_catalog.product`
* `rms_catalog.sku`
* `rms_catalog.option_set`
* `rms_catalog.option`
* `rms_catalog.product_option_binding`
* `rms_catalog.menu`
* `rms_catalog.menu_section`
* `rms_catalog.menu_item_binding`
* `rms_catalog.catalog_version`
* `rms_catalog.catalog_snapshot`

#### Pricing

* `rms_pricing.tax_rule_version`
* `rms_pricing.price_definition`
* `rms_pricing.price_quote`
* `rms_pricing.price_quote_line`
* `rms_pricing.price_quote_tax_line`

#### Ordering

* `rms_ordering.cart`
* `rms_ordering.cart_line`
* `rms_ordering.order_header`
* `rms_ordering.order_line`
* `rms_ordering.order_snapshot`
* `rms_ordering.order_action_record`
* `rms_ordering.order_revision`

#### Payment

* `rms_payment.payment_intent`
* `rms_payment.payment_attempt`
* `rms_payment.payment_transaction`
* `rms_payment.provider_webhook_record`
* `rms_payment.payment_reconciliation_record`

#### Kitchen

* `rms_kitchen.kitchen_ticket`
* `rms_kitchen.kitchen_work_item`
* `rms_kitchen.kitchen_action_record`

#### Device

* `rms_device.device`
* `rms_device.device_capability`
* `rms_device.output_job`
* `rms_device.output_attempt`

#### Fulfillment

* `rms_fulfillment.fulfillment`
* `rms_fulfillment.fulfillment_item`
* `rms_fulfillment.handoff_record`
* `rms_fulfillment.completion_record`

具体列与 Constraint 在相应 Module Work Package 中根据本 Blueprint 建立，不在此阶段生成所有 DDL。

### 50.22 Cross-module Database Access

允许：

* Owning Module 通过自身 Repository 读写自身 Schema
* Query Module 通过 Public Query Contract 读取其他 Module
* Reporting / Projection Builder 使用只读 Database Role 读取批准的 Source View / Event Feed
* Reconciliation Job 读取批准字段并写入自身结果表

禁止：

* Module A 直接 `INSERT / UPDATE / DELETE` Module B Schema
* Controller 使用 ORM 跨 Module Join 并回写
* Frontend 直接访问数据库
* BI / Reporting 修改业务 Transaction
* 通过共享 ORM Entity 绕过 Public Contract
* 在数据库 Trigger 内跨 Module 修改业务状态

数据库权限应为每个 Runtime / Module 配置最小 Role。CI 与 Integration Test 检测非法写入。

### 50.23 View 与 Read Contract

跨 Module 高性能读取优先顺序：

1. Public Query Contract
2. Module-owned Read View
3. Event-driven Projection
4. 批量 Export / Analytics Feed

Read View：

* 由 Owning Module 创建和版本化
* 只暴露批准字段
* 不暴露私有 PII 或内部状态
* Consumer 不得依赖未声明列
* Breaking Change 创建新 View Version

### 50.24 Index 与 Constraint Baseline

每张业务表必须评估：

* Primary Key
* Tenant-scoped Unique Constraint
* Foreign Key / Reference Integrity
* Lifecycle Check Constraint
* Version Check
* Created / Updated Time Index
* 常用 Queue / Status Partial Index
* Outbox `published_at is null` Partial Index
* Inbox Unique Index

规则：

* 不为所有列盲目加 Index
* Index 必须对应明确查询或约束
* 大表新增 Index 使用低锁方案
* 查询计划与慢查询在 Staging 验证

### 50.25 Partitioning Strategy

v0.1 默认不对普通业务表分区。

以下表达到数据量阈值后可按时间分区：

* Audit
* Outbox / Event Log
* Device Signal
* Job Execution
* High-frequency Monitoring Record

分区不是 Phase 0 阻塞项。启用前必须有数据量证据、Retention Strategy 与查询测试。

### 50.26 Retention 与 Data Classification

每张表必须声明：

* Retention Category
* PII Classification
* Financial / Compliance Classification
* Legal Hold Capability
* Archive Strategy
* Deletion / Anonymization Method

规则：

* Retention Job 只处理 Policy 明确允许的数据
* Legal Hold 优先于普通 Retention
* Transaction Reference 在 PII 匿名化后仍可保留必要审计关系
* Provider Raw Payload 使用更短 Retention，除非 Compliance 要求保留

### 50.27 Seed 与 Fixture

Seed 分类：

* `system_seed`：Permission Code、基础 Reason Code、Currency Metadata
* `demo_seed`：示例 Brand、Store、Menu，仅用于 Local / Demo
* `test_fixture`：测试场景专用，不进入 Production
* `migration_seed`：与结构版本绑定的必要数据

规则：

* Production 不自动加载 Demo Seed
* Seed 必须幂等
* Fixture 使用 Builder / Factory，不依赖全局固定 ID
* 测试时每个 Suite 获得隔离 Tenant 与数据

### 50.28 Test Database Strategy

测试分层：

* Unit Test 不访问真实数据库
* Repository Integration Test 使用真实 PostgreSQL
* 每个测试 Suite 使用独立 Database 或 Schema
* Migration Test 从空数据库执行完整 Migration
* Upgrade Test 从最近支持版本升级
* Contract Test 验证 View / Event / API Schema
* Concurrency Test 验证 Version Conflict
* Failure Injection 验证 Transaction Rollback、Outbox 与重试

测试结束必须清理资源，不复用开发者本地业务数据。

### 50.29 Backup、Restore 与 Recovery

Phase 0 必须具备：

* 自动 Backup
* Point-in-time Recovery 能力
* Restore Runbook
* Migration 前 Backup / Recovery Check
* Outbox / Inbox Recovery Runbook
* Projection Rebuild Runbook

至少在 Staging 完成一次 Restore Drill，不能只验证 Backup Job 显示成功。

### 50.30 Database Security

规则：

* Runtime 使用非 Owner Role
* Migration 使用受控高权限 Role
* Read-only Reporting 使用独立 Role
* Secret 不保存于业务表
* Connection 强制 TLS（非本地环境）
* Sensitive Column 不进入普通 Log
* Production 禁止开发者共享账号
* Break-glass 访问必须审批并 Audit
* Database Export 受 Privacy / Permission 控制

### 50.31 Database Observability

必须监控：

* Connection Pool
* Transaction Duration
* Lock Wait
* Deadlock
* Slow Query
* Replication / Backup Status
* Outbox Lag
* Inbox Failure
* Job Queue Lag
* Projection Freshness
* Migration Duration

告警必须包含 Environment、Module、Schema、Query / Job Reference 与 Correlation ID。

### 50.32 Database Change Review Checklist

每个 Database PR 必须回答：

1. Owning Module 是什么
2. Table Classification 是什么
3. Tenant Scope 如何保证
4. 数据类型是否符合 Money / Time / ID 规范
5. 是否引入跨 Module FK 或写依赖
6. Migration 是否可在线执行
7. 是否存在锁表或长事务风险
8. 回退 / 补偿方式是什么
9. Retention 与 PII 分类是什么
10. Index 对应哪个查询
11. 是否需要 Backfill
12. 是否影响 Event、View 或 API Contract
13. 是否通过空库与升级 Migration Test

### 50.33 Database Blueprint Acceptance Criteria

必须证明：

1. 空数据库可以按顺序完成 Phase 0 / Phase 1 Migration
2. Migration 重复执行受到安全保护
3. RMS Module 无法写入其他 RMS Module Schema
4. BOP Module 无法写入 RMS Schema
5. Tenant Scope 缺失的写入被拒绝
6. 两个并发更新只有一个可以成功
7. 业务写入与 Outbox Event 原子提交
8. Consumer 重复处理不产生重复结果
9. Append-only Table 的普通 Update / Delete 被阻止
10. Money 计算不存在 Float
11. Store Local Business Date 可正确跨 DST 计算
12. Projection 可删除并重建
13. Audit 不包含 Secret 或完整支付凭据
14. Production Seed 不包含 Demo 数据
15. Backup 可以在 Staging 成功恢复
16. Database 权限测试可以发现非法跨 Schema 写入

### 50.34 Database Blueprint 状态

Database Blueprint v0.1 已完成并 Freeze。

已锁定：

* 单 Database、多 Schema 的模块化单体策略
* Schema Ownership 与 Migration Namespace
* Phase 0 / Phase 1 建表顺序
* Table Classification 与 Aggregate Mapping
* ID、Tenant Scope、FK 与 Optimistic Concurrency
* Money、Decimal、Currency、Time 与 JSONB 规范
* Outbox、Inbox、Idempotency、Audit、Job、Snapshot 与 Projection 结构
* 跨 Module Database Access 与 Read Contract
* Migration、Seed、Fixture、Test Database、Backup 与 Security
* Database Acceptance Criteria

---

## 历史讨论节点 H-051（已完成）

Implementation Specification / Engineering Blueprint 已完成：

* Repository Blueprint
* Module Blueprint
* Database Blueprint

下一步进入：

**API / Event Contract Blueprint。**

首先需要完成：

* REST API 资源、Command 与 Query 边界
* API Versioning、Error、Idempotency、Pagination 与 Tenant Context
* Webhook Inbound / Outbound Contract
* Domain Event Envelope 与 Event Catalog
* Phase 1 Critical Path 的首批 API 与 Event
* SSE / Realtime Message 边界；WebSocket is future-trigger only under Section 87
* Contract Test、Compatibility 与 Deprecation 策略

---

## 52. API / Event Contract Blueprint

### 52.1 目标与范围

本 Blueprint 将 Repository、Module 与 Database Blueprint 转换为 Phase 0 / Phase 1 可直接实现的 REST、Webhook、Domain Event 与 Realtime Contract。

核心原则：

* 外部 API、内部同步 Contract、Domain Event 与 Realtime Message 必须分层
* REST Controller 只处理 Transport，不承载业务规则
* Command 表达请求执行的业务动作，Query 只读取 Projection 或模块公开 Read Contract
* Domain Event 只描述已经发生的事实，不充当跨模块 Command
* 所有写接口必须明确 Tenant Scope、Actor、Permission、Idempotency 与 Audit
* Provider-specific Payload 仅存在于 Adapter Boundary，不进入核心 Public Contract
* Contract 以 Schema 为准，代码类型、OpenAPI、AsyncAPI / Event Catalog 与测试必须由同一来源生成或校验

### 52.2 Contract 类型分层

第一版定义五类 Contract：

1. `Public REST API`
   * Customer PWA 与 Merchant Web 使用
   * 通过 `/api/v1` 暴露
   * 只暴露稳定 Resource、Command 与 Query DTO

2. `Internal Application Contract`
   * 模块化单体内部同步调用
   * 只允许调用对方公开 Application Interface
   * 不经 HTTP，但必须具有稳定输入、输出与错误语义

3. `Domain / Integration Event`
   * 通过 Transactional Outbox 发布
   * Worker 使用 Inbox / Idempotency 消费
   * 用于非即时结果依赖的跨模块协作

4. `Inbound / Outbound Webhook`
   * Payment、Delivery、Notification 等 Provider 回调或对外通知
   * 使用独立签名、重放保护与 Delivery Attempt 记录

5. `Realtime Message`
   * same-origin SSE 推送 Projection 变化与运营提醒
   * 不作为业务事实来源，不允许客户端通过 Realtime Message 直接改变状态

### 52.3 REST 资源与 Command / Query 边界

REST 采用资源导向 URL，但写操作使用具有业务含义的 Action Endpoint，不通过任意状态字段更新 Aggregate。

示例：

```text
GET    /api/v1/stores/{storeId}/menu
POST   /api/v1/carts
GET    /api/v1/carts/{cartId}
POST   /api/v1/carts/{cartId}/items
PATCH  /api/v1/carts/{cartId}/items/{cartItemId}
DELETE /api/v1/carts/{cartId}/items/{cartItemId}
POST   /api/v1/carts/{cartId}/quote
POST   /api/v1/carts/{cartId}/checkout
GET    /api/v1/orders/{orderId}
POST   /api/v1/orders/{orderId}/cancel
POST   /api/v1/kitchen/work-items/{workItemId}/accept
POST   /api/v1/kitchen/work-items/{workItemId}/start
POST   /api/v1/kitchen/work-items/{workItemId}/complete
POST   /api/v1/fulfillments/{fulfillmentId}/handoff
```

禁止：

```text
PATCH /orders/{id} { "status": "COMPLETED" }
```

写接口返回：

* 已完成的 Resource Snapshot；或
* `202 Accepted` + Operation / Job Reference（异步处理时）

Query 不得产生业务副作用。需要记录“查看”行为的敏感查询，只追加 Audit，不改变业务状态。

### 52.4 API Versioning

第一版使用 URL Major Version：

```text
/api/v1/...
```

规则：

* 向后兼容字段新增不升级 Major Version
* 删除字段、改变语义、改变必填性或枚举含义必须新建 Major Version
* 同一 Major Version 内使用 Additive Change
* Response Consumer 必须忽略未知字段
* Enum 扩展视为潜在兼容风险；客户端必须具备 Unknown Fallback
* Deprecated Endpoint 必须返回 `Deprecation` 与 `Sunset` Header（适用时）
* v0.1 只维护一个公开 Major Version，但内部 Contract 仍需独立版本号

### 52.5 Request Context 与标准 Header

所有受保护请求使用：

```text
Authorization: Bearer <token>
X-Request-Id: <uuid>
X-Correlation-Id: <uuid>
Idempotency-Key: <opaque-key>      # 需要幂等的写接口
If-Match: "<aggregate-version>"    # 需要并发控制的更新
Accept-Language: en-CA / zh-CN / ...
```

Merchant 请求的 Brand / Store Scope 从授权后的 Membership / Assignment 与 Route Resource 共同解析。

不允许仅相信客户端提交的 `brandId`、`storeId` Header 来授予访问权限。

Customer 公共菜单请求可通过 Store Public Identifier / QR Token 解析 Scope；服务端仍需验证 Store、Menu 与 Channel 是否有效。

### 52.6 Authentication 与 Authorization Contract

Authentication 结果形成统一 `ActorContext`：

* Actor ID
* Account Type
* Authentication Method
* Session / Token ID
* Brand Scope
* Store Scope
* Roles / Permission Evaluation Reference
* Customer / Merchant Identity Reference（适用时）
* Risk / Verification Level

每个 Command Handler 必须：

1. 验证 Actor
2. 解析 Tenant Scope
3. 调用 Permission Decision Contract
4. 验证 Aggregate / Resource Scope
5. 执行业务 Invariant
6. 写 Audit 与必要 Event

前端隐藏按钮不是授权控制。

### 52.7 Idempotency Contract

以下请求必须支持 `Idempotency-Key`：

* Cart Checkout
* Order Submit / Confirm
* Payment Intent / Capture / Refund
* Fulfillment Handoff
* Provider Webhook
* Reprint / External Notification 等可能重复触发的动作

服务端保存：

* Idempotency Key
* Actor / Client Scope
* Endpoint / Operation Name
* Request Fingerprint
* First Received At
* Status
* Response Status / Body Reference
* Resource Reference
* Expires At

规则：

* 相同 Key + 相同 Fingerprint 返回原结果
* 相同 Key + 不同 Fingerprint 返回 `409 IDEMPOTENCY_KEY_REUSED`
* 正在处理返回原 Operation Reference 或 `409 IDEMPOTENCY_IN_PROGRESS`
* 幂等记录与业务事务的边界必须防止“业务已完成但结果未保存”
* Provider Event 使用 Provider Event ID + Account / Endpoint Scope 作为去重依据

Canonical retention（Section 87 hardening）：

* ordinary Cart / configuration command：24 hours
* Checkout、Order submit / confirm、Fulfillment handoff、Import commit、external Notification / reprint：30 days
* Provider webhook Event ID / Account dedupe：90 days
* Payment create / capture / refund keeps replayable response for 90 days and retains the minimal key、fingerprint、operation / transaction reference with the seven-year normalized Payment fact
* expiry cleanup never deletes the underlying Order、Payment、Audit or Handoff fact；a high-risk operation cannot reuse a still-retained minimal key with a different fingerprint

### 52.8 Optimistic Concurrency Contract

需要防止覆盖的 Resource 返回：

```text
ETag: "7"
```

客户端更新时发送：

```text
If-Match: "7"
```

版本不一致返回：

```text
409 AGGREGATE_VERSION_CONFLICT
```

Response 包含当前 Version 与可重新读取的 Resource Reference，不自动覆盖较新状态。

### 52.9 标准 Response Envelope

单 Resource：

```json
{
  "data": {},
  "meta": {
    "requestId": "uuid",
    "correlationId": "uuid",
    "apiVersion": "v1"
  }
}
```

集合：

```json
{
  "data": [],
  "page": {
    "nextCursor": "opaque-or-null",
    "hasMore": false
  },
  "meta": {
    "requestId": "uuid"
  }
}
```

Command 可额外返回：

* Resource Version
* Operation ID
* Warnings
* Next Allowed Actions（Projection，仅供 UI 提示，后端仍重新验证）

### 52.10 Error Contract

统一错误结构：

```json
{
  "error": {
    "code": "ORDER_NOT_CANCELLABLE",
    "message": "The order cannot be cancelled in its current state.",
    "category": "BUSINESS_RULE",
    "retryable": false,
    "details": [],
    "resource": {
      "type": "order",
      "id": "uuid"
    }
  },
  "meta": {
    "requestId": "uuid",
    "correlationId": "uuid"
  }
}
```

Category：

* `VALIDATION`
* `AUTHENTICATION`
* `AUTHORIZATION`
* `NOT_FOUND`
* `CONFLICT`
* `BUSINESS_RULE`
* `RATE_LIMIT`
* `PROVIDER`
* `TEMPORARY`
* `INTERNAL`

HTTP Mapping：

* `400` DTO / Validation 错误
* `401` 未认证
* `403` 已认证但无权限
* `404` Resource 不存在或为防泄漏不可见
* `409` 幂等、并发、状态或业务冲突
* `422` 合法格式但业务语义无法处理（仅在团队统一使用时）
* `429` Rate Limit
* `502 / 503 / 504` 外部依赖或临时不可用
* `500` 未分类内部错误

禁止向客户端返回 Stack Trace、SQL、Secret 或完整 Provider Payload。

### 52.11 Validation Error

字段错误使用稳定 Path：

```json
{
  "path": "items[0].quantity",
  "code": "MIN_VALUE",
  "message": "Quantity must be at least 1."
}
```

业务错误与字段 Validation 分离，例如“商品已停售”不是普通字段格式错误。

### 52.12 Pagination、Filtering 与 Sorting

大列表默认使用 Cursor Pagination：

```text
?limit=50&cursor=<opaque>
```

规则：

* Cursor 不暴露可篡改 SQL Offset
* 默认与最大 Page Size 由 Endpoint 定义
* Sort Field 必须白名单
* Filter 使用明确参数，不允许开放任意 SQL-like Query
* 时间范围必须明确使用 UTC Timestamp 或 Store Business Date
* Export 与大规模分析不复用普通列表 Endpoint

Offset Pagination 只允许低变动、小数据配置列表。

### 52.13 Phase 1 Public REST API

#### Store / Catalog

* `GET /api/v1/public/stores/{storePublicId}`
* `GET /api/v1/public/stores/{storePublicId}/menu`
* `GET /api/v1/public/stores/{storePublicId}/menu/items/{sellableId}`
* `POST /api/v1/public/qr-sessions/resolve`

Menu Response 必须包含 Published Menu Version、Channel、Availability、Sellable Snapshot、Option Rules、Display Price 与 Tax Display Context；最终成交仍以 Quote 为准。

#### Cart / Pricing

* `POST /api/v1/carts`
* `GET /api/v1/carts/{cartId}`
* `POST /api/v1/carts/{cartId}/items`
* `PATCH /api/v1/carts/{cartId}/items/{cartItemId}`
* `DELETE /api/v1/carts/{cartId}/items/{cartItemId}`
* `POST /api/v1/carts/{cartId}/quote`

Cart Item Command 使用 Sellable ID、Quantity、Option Selection 与 Customer Note；服务端重新解析配置，不能相信客户端价格。

Quote Response 至少包含：

* Quote ID / Version
* Currency
* Subtotal
* Discount
* Tax
* Fee
* Total
* Line Breakdown
* Applied Promotion Reference
* Expiry
* Warnings / Blocking Reasons

#### Checkout / Payment / Order

* `POST /api/v1/carts/{cartId}/checkout-sessions`
* `GET /api/v1/checkout-sessions/{checkoutSessionId}`
* `POST /api/v1/checkout-sessions/{checkoutSessionId}/payment-intents`
* `POST /api/v1/checkout-sessions/{checkoutSessionId}/confirm`
* `GET /api/v1/orders/{orderId}`
* `POST /api/v1/orders/{orderId}/cancel`

`confirm` 必须幂等，并验证 Quote 未过期、Payment 状态、Availability、Capacity 与 Cart Version。

#### Kitchen / Merchant

* `GET /api/v1/merchant/stores/{storeId}/kitchen/work-items`
* `GET /api/v1/merchant/kitchen/work-items/{workItemId}`
* `POST /api/v1/merchant/kitchen/work-items/{workItemId}/accept`
* `POST /api/v1/merchant/kitchen/work-items/{workItemId}/start`
* `POST /api/v1/merchant/kitchen/work-items/{workItemId}/complete`
* `POST /api/v1/merchant/kitchen/work-items/{workItemId}/report-exception`

#### Printing / Fulfillment

* `GET /api/v1/merchant/stores/{storeId}/output-jobs`
* `POST /api/v1/merchant/output-jobs/{outputJobId}/retry`
* `GET /api/v1/merchant/stores/{storeId}/fulfillments`
* `GET /api/v1/merchant/fulfillments/{fulfillmentId}`
* `POST /api/v1/merchant/fulfillments/{fulfillmentId}/handoff`

### 52.14 Internal Application Contract

内部同步调用使用 TypeScript Interface 与 DTO，示例：

```ts
interface PricingQuoteService {
  quoteCart(input: QuoteCartInput): Promise<QuoteCartResult>;
}
```

规则：

* Contract 包位于模块公开 `contracts`
* 输入输出不暴露 ORM、Repository 或 Domain Private Entity
* 调用方不能传入“目标状态”绕过对方 Action
* 被调用模块负责权限 / Scope / Invariant 的最终判断
* Internal Contract 的 Breaking Change 同样需要版本与 Consumer Review
* 事务边界默认不跨模块共享；确需同事务的 Phase 1 同步链必须有 ADR 与明确 Owner

### 52.15 Domain Event Envelope

统一 Envelope：

```json
{
  "eventId": "uuid",
  "eventType": "rms.ordering.OrderConfirmed",
  "eventVersion": 1,
  "occurredAt": "2026-07-15T12:00:00.000Z",
  "publishedAt": "2026-07-15T12:00:00.100Z",
  "producer": "@rms/ordering",
  "environment": "staging",
  "tenant": {
    "brandId": "uuid",
    "storeId": "uuid"
  },
  "aggregate": {
    "type": "Order",
    "id": "uuid",
    "version": 3
  },
  "actor": {
    "actorId": "uuid-or-null",
    "actorType": "CUSTOMER"
  },
  "correlationId": "uuid",
  "causationId": "uuid",
  "traceId": "string",
  "payload": {}
}
```

规则：

* `occurredAt` 是业务事实发生时间，`publishedAt` 是进入消息通道时间
* Payload 只包含 Consumer 完成反应所需事实，不复制整个 Aggregate
* Event 不包含 Secret、完整支付凭据或不必要 PII
* Event Schema 不直接复用 REST Response DTO
* Event Version 只在不兼容 Payload 变化时递增
* Consumer 以 `eventId` 幂等处理
* Event 顺序只在同 Aggregate 内通过 Aggregate Version 判断，不承诺全局顺序

### 52.16 Phase 1 Event Catalog

Store / Catalog：

* `rms.store.StoreActivated.v1`
* `rms.catalog.MenuPublished.v1`
* `rms.catalog.SellableAvailabilityChanged.v1`

Ordering / Pricing：

* `rms.ordering.CartCreated.v1`
* `rms.ordering.CartItemAdded.v1`
* `rms.pricing.QuoteCreated.v1`
* `rms.ordering.CheckoutStarted.v1`
* `rms.ordering.OrderConfirmed.v1`
* `rms.ordering.OrderCancelled.v1`

Payment：

* `rms.payment.PaymentIntentCreated.v1`
* `rms.payment.PaymentAuthorized.v1`
* `rms.payment.PaymentCaptured.v1`
* `rms.payment.PaymentFailed.v1`
* `rms.payment.PaymentRefunded.v1`

Kitchen：

* `rms.kitchen.KitchenWorkCreated.v1`
* `rms.kitchen.KitchenWorkAccepted.v1`
* `rms.kitchen.KitchenWorkStarted.v1`
* `rms.kitchen.KitchenItemCompleted.v1`
* `rms.kitchen.OrderReadyForHandoff.v1`
* `rms.kitchen.KitchenExceptionReported.v1`

Printing / Fulfillment：

* `rms.device.OutputJobCreated.v1`
* `rms.device.OutputJobCompleted.v1`
* `rms.device.OutputJobFailed.v1`
* `rms.fulfillment.FulfillmentCreated.v1`
* `rms.fulfillment.FulfillmentReady.v1`
* `rms.fulfillment.FulfillmentHandedOff.v1`
* `rms.fulfillment.FulfillmentCompleted.v1`

Projection / Reporting Consumer 不发布伪业务事件覆盖源事实。

### 52.17 Event Consumer Contract

每个 Consumer 声明：

* Consumer Name / Version
* Consumed Event Type / Version
* Inbox Scope
* Retry Policy
* Dead-letter Policy
* Ordering Requirement
* Side Effect
* Rebuild / Replay Safety
* Owner

处理流程：

1. 验证 Envelope 与 Schema
2. 检查 Inbox
3. 验证 Tenant / Aggregate Reference
4. 执行本地事务
5. 保存 Inbox Result
6. 写必要 Outbox Event
7. Commit

不可重试的 Schema / Business Rejection 与可重试的临时故障必须分开。

### 52.18 Inbound Webhook Contract

Provider Endpoint：

```text
POST /api/v1/webhooks/{providerType}/{providerAccountId}
```

处理步骤：

1. 保留必要 Raw Body Hash / Reference
2. 验证 Provider Signature、Timestamp 与 Endpoint Secret
3. 检查 Replay Window
4. 解析 Provider Event ID
5. 写 Webhook Receipt
6. 快速返回 Provider 要求的成功响应
7. 异步映射为内部 Provider Fact / Command
8. 使用 Inbox / Idempotency 去重

Webhook Controller 不直接修改多个 Domain。

无效签名返回 Provider 约定状态，并记录 Security Event；不得在日志中输出 Secret。

### 52.19 Outbound Webhook Contract

Outbound Subscription 至少保存：

* Subscription ID
* Tenant Scope
* Event Types
* Endpoint
* Secret Reference
* Status
* Retry Policy
* Rate Limit
* Created / Rotated At

Delivery Envelope 包含 Delivery ID、Event ID、Attempt、Timestamp 与 Signature。

状态：

* `Pending`
* `Delivered`
* `Retrying`
* `Failed`
* `Suspended`

Consumer Endpoint 返回 `2xx` 才算成功；Redirect 默认不自动跟随；重试使用指数退避并设置最大期限。

### 52.20 SSE / Realtime Contract

第一版 Realtime 用于：

* Kitchen Work Queue 更新
* Order / Fulfillment Status 更新
* Output / Device Exception 提醒
* Merchant Operational Alert

连接建立后必须完成 Authentication 与 Scope Subscription。

Message Envelope：

```json
{
  "messageId": "uuid",
  "type": "kitchen.work-item.updated",
  "version": 1,
  "occurredAt": "timestamp",
  "scope": {
    "brandId": "uuid",
    "storeId": "uuid"
  },
  "resource": {
    "type": "kitchenWorkItem",
    "id": "uuid",
    "version": 5
  },
  "data": {}
}
```

规则：

* Realtime Message 可以丢失或重复，客户端必须重新 Query 获取权威状态
* 不保证离线期间无限回放
* Message 不替代 Domain Event
* Client Command 仍通过 REST / Application Command Endpoint 提交
* 服务端按 Actor / Store Scope 过滤，不允许客户端任意订阅其他 Store

Transport、authentication、connection limit、heartbeat、reconnect and no-replay semantics use the accepted Section 87.12 SSE contract；WebSocket is not a v0.1 dependency.

### 52.21 Rate Limit 与 Abuse Control

Rate Limit Key 可结合：

* IP
* Actor / Account
* Customer Session
* Store / Brand
* Endpoint Class
* Provider Account

公共菜单、QR Resolve、OTP、Checkout、Payment 与 Webhook 使用不同 Policy。

Response：

```text
429 RATE_LIMIT_EXCEEDED
Retry-After: <seconds>
```

高风险操作还需结合 Device Fingerprint、Velocity、Challenge 与 Kill Switch。

### 52.22 Contract Schema 与文档治理

必须维护：

* OpenAPI：Public / Merchant REST
* Internal Contract Type Package
* Event Catalog / AsyncAPI-like Schema
* Webhook Provider Mapping
* Realtime Message Catalog
* Error Code Catalog

每个 Contract 声明：

* Owner Module
* Version
* Stability
* Consumers
* PII Classification
* Authentication / Permission
* Idempotency Requirement
* Compatibility Notes
* Deprecation Status

生成的 SDK 只能依赖公开 Contract，不能引入服务端私有类型。

### 52.23 Compatibility 与 Deprecation

兼容变更：

* 新增 Optional Field
* 新增 Endpoint
* 新增 Event Type
* 在明确允许 Unknown 的位置新增枚举值

不兼容变更：

* 删除 / 重命名字段
* Optional 改 Required
* 改变字段单位、时区或金额语义
* 改变 Error Code 含义
* 复用旧 Event Type 表示新事实

Deprecation 流程：

1. 标记 Deprecated
2. 通知 Consumer Owner
3. 提供 Replacement
4. 记录 Usage
5. 设置 Sunset Gate
6. 迁移完成后删除

内部 Consumer 也不得无通知强制升级。

### 52.24 Contract Test Strategy

必须包含：

* OpenAPI Schema Validation
* Request / Response Example Test
* Consumer-driven Contract Test（关键内部 Consumer）
* Event Schema Validation
* Event Replay / Duplicate Test
* Webhook Signature Test
* Provider Fixture Test
* Error Contract Test
* Idempotency Test
* Backward Compatibility Diff
* Realtime Scope / Authorization Test

CI 阻止未更新 Schema、Event Catalog 或错误码目录的 Contract 变更。

### 52.25 API / Event Observability

所有请求 / Event / Webhook 记录：

* Request / Event ID
* Correlation / Causation ID
* Actor 与 Tenant Scope（按隐私规则）
* Endpoint / Event Type / Version
* Duration
* Result / Error Code
* Provider Reference
* Retry / Attempt

指标：

* API Latency / Error Rate
* Idempotency Hit / Conflict
* Rate Limit
* Webhook Signature Failure
* Webhook Processing Lag
* Outbox Publish Lag
* Consumer Lag / Retry / Dead-letter
* SSE Connection / Delivery Failure

### 52.26 API / Event Security Checklist

每个 Contract Review 必须确认：

1. Authentication 是否明确
2. Tenant / Store Scope 是否由服务端验证
3. Permission Action 是否明确
4. IDOR 是否被防止
5. DTO 是否存在 Mass Assignment
6. 是否泄露 PII / Secret
7. Idempotency 与 Replay 是否处理
8. Rate Limit 是否配置
9. Webhook Signature 是否验证
10. Error 是否泄露内部实现
11. Event Consumer 是否信任了未经验证的 Payload
12. Realtime Subscription 是否越权

### 52.27 Phase 1 End-to-End Contract Scenario

必须通过以下 Contract Chain：

1. QR Token 解析为 Store / Table / Channel Session
2. Customer 读取 Published Menu
3. 创建 Cart 并添加 Item / Option
4. Pricing 生成带有效期 Quote
5. Checkout 创建 Payment Intent
6. Provider Webhook 幂等确认 Payment
7. Order Confirmed Event 由 Outbox 发布
8. Kitchen Consumer 创建 Work Item
9. Kitchen 完成后发布 Ready Event
10. Output Consumer 创建并完成 Output Job
11. Fulfillment Consumer 标记 Ready
12. Staff 使用 Handoff Command 完成交付
13. Customer 与 Merchant Realtime 收到状态提示
14. 所有步骤可通过 Correlation ID 追踪
15. 重放 Payment Webhook、Order Event 与 Ready Event 不产生重复 Order、Work Item 或 Handoff

### 52.28 API / Event Contract Acceptance Criteria

必须证明：

1. OpenAPI 可通过 Schema Validation
2. 所有 Phase 1 写接口声明 Idempotency 与 Permission
3. 客户端不能通过提交 `status` 跳过业务 Action
4. 无效 Tenant / Store Scope 被拒绝
5. 错误返回统一 Error Contract
6. Cursor Pagination 在数据变化时不重复或遗漏已定义范围
7. 相同 Idempotency Key 返回相同结果
8. 相同 Key 不同 Payload 返回冲突
9. Event 与业务写入通过 Outbox 原子提交
10. Consumer 重复处理不重复产生副作用
11. Event Schema 不包含 Secret / 不必要 PII
12. Payment Webhook 可验证签名并防重放
13. Realtime 越权订阅被拒绝
14. Realtime 丢失后可通过 Query 恢复状态
15. Breaking Contract Change 被 CI Diff 阻止
16. Phase 1 End-to-End Contract Scenario 通过

### 52.29 API / Event Contract Blueprint 状态

API / Event Contract Blueprint v0.1 已完成并 Freeze。

已锁定：

* REST Resource、Command 与 Query 边界
* API Version、Context、Authentication、Authorization 与 Tenant Scope
* Idempotency、Concurrency、Pagination、Rate Limit 与 Error Contract
* Phase 1 Public / Merchant REST API
* Internal Application Contract
* Domain Event Envelope 与 Phase 1 Event Catalog
* Event Consumer、Inbound / Outbound Webhook
* SSE / Realtime Message
* Contract Compatibility、Deprecation、Testing、Security 与 Observability
* End-to-End Contract Scenario 与 Acceptance Criteria

---

## 历史讨论节点 H-053（已完成）

Implementation Specification / Engineering Blueprint 已完成：

* Repository Blueprint
* Module Blueprint
* Database Blueprint
* API / Event Contract Blueprint

下一步进入：

**Initial Backlog。**

首先需要完成：

* 将 Phase 0 / Phase 1 转换为 Epic、Feature、Story 与 Work Package
* 明确 Dependency、Owner Role、Acceptance Criteria 与 Definition of Done
* 标记 Critical Path、Parallel Workstream 与 Provider Spike
* 生成可直接导入 Linear / GitHub Issues / Jira 的首批 Backlog
* 选出第一个可执行 Sprint / Work Package

---

## 54. Initial Backlog

### 54.1 目标与范围

Initial Backlog 将已经 Freeze 的 Phase 0 与 Phase 1 转换为可执行的 Epic、Feature、Story 与 Work Package。

本阶段只做任务拆分、依赖排序、验收标准与交付计划，不生成业务代码。

层级定义：

* `Epic`：一个可独立管理的大型结果领域
* `Feature`：Epic 下可形成明确产品或工程能力的交付单元
* `Story`：面向用户、运营人员或工程团队的可验收需求
* `Work Package`：可以直接分配给开发者或 AI Coding Agent 的最小工程包
* `Spike`：用于消除技术或供应商不确定性的受时限研究任务

每个 Backlog Item 至少包含：

* ID
* Title
* Type
* Phase
* Priority
* Critical Path 标记
* Owner Role
* Dependencies
* Scope
* Deliverables
* Acceptance Criteria
* Definition of Done Reference
* Risks / Notes

### 54.2 Priority 与执行分类

优先级：

* `P0`：阻塞最小端到端闭环
* `P1`：Phase 0 / Phase 1 必须完成，但可以在部分 Critical Path 工作之后进行
* `P2`：增强可运营性，不阻塞首次闭环
* `P3`：明确延期到后续 Phase

执行分类：

* `Critical Path`
* `Parallel Workstream`
* `Provider Spike`
* `Hardening`
* `Documentation / Governance`

### 54.3 Epic Register

#### EPIC-00 — Engineering Foundation

目标：建立可持续开发、测试、部署和运行的 Monorepo 基础。

Priority：`P0`

Owner Role：Platform / Lead Engineer

关键依赖：无

包含 Feature：

* Repository Bootstrap
* Local Environment
* CI / CD Baseline
* Architecture Enforcement
* Observability Baseline
* Test Harness
* Documentation Baseline

#### EPIC-01 — Identity, Tenant and Access Foundation

目标：建立 Actor、Brand、Store、Operating Entity、Membership、Role 与 Permission 的最小可运行链路。

Priority：`P0`

Owner Role：Backend / Platform Engineer

依赖：EPIC-00

#### EPIC-02 — Eventing, Audit and Reliability Kernel

目标：建立 Transactional Outbox、Inbox、Idempotency、Audit、Job 与 Correlation 能力。

Priority：`P0`

Owner Role：Backend / Platform Engineer

依赖：EPIC-00、EPIC-01 Tenant Context

#### EPIC-03 — Configuration, Media and Store Foundation

目标：建立 Store Configuration、Publishing、Media、Feature Flag 与基础门店上下文。

Priority：`P0`

Owner Role：Backend + Merchant Web

依赖：EPIC-01、EPIC-02

#### EPIC-10 — Catalog and Menu Publication

目标：让 Merchant 可以建立并发布最小可售 Menu，让 Customer 可以通过 Store / QR Context 查询。

Priority：`P0`

Owner Role：Catalog Squad

依赖：EPIC-03

#### EPIC-11 — Pricing and Tax Quote

目标：根据已发布 Catalog、Store 与 Channel Context 生成可复算、可过期的 Price Quote。

Priority：`P0`

Owner Role：Pricing / Backend Engineer

依赖：EPIC-10

#### EPIC-12 — Cart and Ordering

目标：完成 Cart、Checkout Validation、Order Creation 与 Immutable Snapshot。

Priority：`P0`

Owner Role：Ordering Squad

依赖：EPIC-10、EPIC-11、EPIC-02

#### EPIC-13 — Payment Integration

目标：完成单一 Payment Provider 的 Payment Intent、Webhook、Idempotency 与 Reconciliation 基线。

Priority：`P0`

Owner Role：Payment Engineer

依赖：EPIC-12、EPIC-02

#### EPIC-14 — Kitchen Execution

目标：将已确认订单转换为 Kitchen Ticket / Item，并支持 Accept、Prepare、Ready。

Priority：`P0`

Owner Role：Kitchen / Backend Engineer

依赖：EPIC-12、EPIC-13、EPIC-02

#### EPIC-15 — Printing and Device Output（Future Trigger）

目标：仅在 IDR-0039 经真实 Store evidence 修订后，为订单链路生成 physical Kitchen / Receipt Output Job 并完成单设备 Adapter 验证；第一 Pilot 不排期或部署本 Epic。

Priority：`P3`

Owner Role：Device Integration Engineer

依赖：EPIC-14、EPIC-02

#### EPIC-16 — Pickup Fulfillment

目标：在 Kitchen Ready 后完成 Pickup Handoff 与 Order Completion。

Priority：`P0`

Owner Role：Fulfillment / Backend Engineer

依赖：EPIC-14、EPIC-12

#### EPIC-17 — Customer PWA Critical Path

目标：完成 Scan QR、Menu、Cart、Checkout、Payment Status、Order Status 与 Pickup Confirmation 体验。

Priority：`P0`

Owner Role：Frontend / PWA Engineer

依赖：EPIC-03、EPIC-10、EPIC-11、EPIC-12、EPIC-13、EPIC-16

#### EPIC-18 — Merchant Operations Critical Path

目标：完成 Store Setup、Catalog Publication、Order Queue、Kitchen Board、Pickup Action 与基础异常查看。

Priority：`P0`

Owner Role：Frontend / Merchant Engineer

依赖：EPIC-01、EPIC-03、EPIC-10、EPIC-14、EPIC-16

#### EPIC-19 — Operational Reporting Baseline

目标：提供最小订单、支付、厨房与履约运行投影。

Priority：`P1`

Owner Role：Backend / Reporting Engineer

依赖：EPIC-02、EPIC-12、EPIC-13、EPIC-14、EPIC-16

#### EPIC-20 — Security, Quality and Release Readiness

目标：持续执行 Security、Contract、E2E、Failure Injection、Migration、Backup 与 Release Gate。

Priority：`P0`

Owner Role：QA / Platform / Security

依赖：贯穿全部 Epic

### 54.4 Phase 0 Backlog

#### Feature F00.1 — Repository Bootstrap

Stories / Work Packages：

* `WP-0001` 初始化 pnpm + Turborepo Monorepo
* `WP-0002` 建立 apps 与 packages 顶层目录
* `WP-0003` 建立 TypeScript Base Config、Lint、Formatter、Unit Test Runner
* `WP-0004` 建立 API、Worker、Merchant Web、Customer PWA Skeleton
* `WP-0005` 建立 Docker Compose 与 PostgreSQL Local Environment
* `WP-0006` 建立 Root Scripts 与 Environment Validation
* `WP-0007` 建立 ADR、Module README、Developer Setup 模板与 Section 90 repository-scoped project skills

Acceptance Criteria：

* 单条命令启动所有 Skeleton 与 PostgreSQL
* 所有 Workspace 可以构建、Lint、Type Check 与 Test
* Repository 中不存在真实 Secret

#### Feature F00.2 — Architecture Enforcement

Work Packages：

* `WP-0010` 建立 Module Manifest Schema
* `WP-0011` 建立 Module Generator
* `WP-0012` 建立 Import Boundary Architecture Test
* `WP-0013` 建立 Database Schema Ownership Test
* `WP-0014` 建立禁止 Domain Layer Import ORM / Infrastructure Test

Acceptance Criteria：

* CI 可以阻止 BOP → RMS 依赖
* CI 可以阻止跨 Module Private Import
* CI 可以阻止非 Owner Schema 写入

#### Feature F00.3 — Database and Migration Baseline

Work Packages：

* `WP-0020` 建立 Migration Runner 与 Namespace 规则
* `WP-0021` 建立 Core Schema、Eventing Schema、Audit Schema 与 Job Schema
* `WP-0022` 建立 UUID、Money、Time、Tenant Scope Database Helpers
* `WP-0023` 建立 Optimistic Concurrency Integration Test
* `WP-0024` 建立 Seed、Fixture 与 Isolated Test Database Framework
* `WP-0025` 建立 Backup / Restore Staging Runbook

Acceptance Criteria：

* 空数据库可完成所有 Foundation Migration
* 测试数据库可隔离并行运行
* Migration 重复执行受到保护

#### Feature F00.4 — Eventing and Reliability Kernel

Work Packages：

* `WP-0030` 建立 Transactional Outbox Contract 与 Table
* `WP-0031` 建立 Worker Outbox Dispatcher
* `WP-0032` 建立 Inbox / Consumer Idempotency
* `WP-0033` 建立 Job / Retry / Dead-letter Baseline
* `WP-0034` 建立 Correlation / Causation Context
* `WP-0035` 建立 Event Catalog Tooling 与 Contract Test
* `WP-0036` 建立 same-origin SSE Realtime Hint Transport、Scope Revalidation 与 Reconnect Contract

Acceptance Criteria：

* 示例业务写入和 Outbox 在同一 Transaction 提交
* 重复事件消费不会产生重复 Projection
* Consumer Failure 可以重试并可观测

#### Feature F00.5 — Audit and Observability Baseline

Work Packages：

* `WP-0040` 建立 Structured Logging
* `WP-0041` 建立 Request / Command / Event Correlation
* `WP-0042` 建立 Audit Append-only Contract 与 Table
* `WP-0043` 建立 Health / Readiness Endpoint
* `WP-0044` 建立 Error Tracking 与 Core Metrics
* `WP-0045` 建立 Alert Routing 与基础 Runbook
* `WP-0046` 建立 Audit Hash Chain、KMS-signed Daily Digest 与 Immutable Archive Verification

Acceptance Criteria：

* 可以从 API Request 追踪至 Database Transaction、Outbox 与 Consumer
* Audit 不记录 Secret、Token 或完整支付凭据
* Staging 故障可以触发告警

#### Feature F01.1 — Identity and Tenant Context

Work Packages：

* `WP-0100` Identity Actor 与 Authentication Session Contract
* `WP-0101` Brand、Store 与 Operating Entity Aggregate
* `WP-0102` Membership 与 Store Assignment
* `WP-0103` Tenant Context Middleware
* `WP-0104` Permission Evaluation Contract
* `WP-0105` Role、Permission Grant 与 Explicit Deny / Allow
* `WP-0106` Merchant Authentication Integration Scenario
* `WP-0107` Cognito same-origin BFF、PostgreSQL Session Store 与 CSRF Contract
* `WP-0108` Workforce Invite、TOTP MFA、Recovery 与 Session Revocation Policy
* `WP-0109` Object-level Authorization、Store Switch 与 Cross-Tenant Negative Test

Acceptance Criteria：

* 同一 Actor 可以在不同 Store 获得不同权限
* 缺少 Brand / Store Scope 的 Merchant 写操作被拒绝
* Identity 不能自行授予业务权限

#### Feature F01.2 — Minimum Shared BOP Capabilities

Work Packages：

* `WP-0120` Feature Flag / Kill Switch Minimum Contract
* `WP-0121` Media Asset Metadata 与 Upload Reference
* `WP-0122` Publishing Lifecycle Minimum Contract
* `WP-0123` Configuration Version / Effective Period Contract
* `WP-0124` Notification Stub 与 Delivery Adapter Contract
* `WP-0125` Task Minimum Contract

Acceptance Criteria：

* Store Feature 可以按 Scope 禁用
* Published Configuration 可以解析当前有效 Version
* Media 业务表只保存 Asset Reference

### 54.5 Phase 1 Critical Path Backlog

#### Feature F10.1 — Store and QR Context

Work Packages：

* `WP-1000` Store Public Profile Query
* `WP-1001` Store Operating Status Query
* `WP-1002` QR Token / Table Context Resolution
* `WP-1003` Customer Session Context
* `WP-1004` Invalid / Expired QR Error Contract
* `WP-1005` Order Resume、Public Reference 与 Pickup Proof Capability Contract
* `WP-1006` Pilot Staff-started Dining Session、short-lived Join Credential 与 copied-Table-QR Abuse Contract
* `WP-1007` Dine-in Session Closing、Unpaid Batch Exception Task 与 Authorized Write-off Boundary

Acceptance Criteria：

* Customer 扫码后可以解析 Brand、Store、Dining / Pickup Context
* 无效或过期 QR 不暴露内部信息
* Session Closing 锁定新 Batch；任何 unpaid / indeterminate Batch 都以幂等方式创建 Store Manager 可见的异常任务，Order 保持 `Open`，直到付款、Provider-confirmed refund、authorized Write-off 或其他受控最终结果完成

#### Feature F10.2 — Catalog Authoring and Publication

Work Packages：

* `WP-1020` Product / Sellable / SKU Minimum Aggregate
* `WP-1021` Category 与 Menu Structure
* `WP-1022` Option Set / Option / Binding Minimum Model
* `WP-1023` Store Availability Overlay
* `WP-1024` Menu Draft / Publish / Archive
* `WP-1025` Published Menu Projection
* `WP-1026` Customer Menu Query API
* `WP-1027` Merchant Catalog Management API
* `WP-1028` Pilot Ingredient / Allergen Provenance、Menu Disclosure 与 Publish-blocking Validation

Acceptance Criteria：

* Merchant 可以发布一个包含规格与加料的 Menu
* Customer Query 只返回当前 Store / Channel 有效内容
* 历史 Order 不依赖当前 Catalog 名称和价格

#### Feature F11.1 — Price and Tax Quote

Work Packages：

* `WP-1100` Money / Tax Calculation Domain Contract
* `WP-1101` Store Tax Configuration
* `WP-1102` Price Resolution
* `WP-1103` Quote Creation API
* `WP-1104` Quote Expiration 与 Requote
* `WP-1105` Quote Recalculation Test Suite
* `SPIKE-1106` 加拿大首个 Pilot Jurisdiction 税务规则核对

Acceptance Criteria：

* 相同输入与 Version 产生可复算 Quote
* Quote 包含 Subtotal、Discount、Tax、Total 与 Currency
* 不使用 Floating Point 计算金额

#### Feature F12.1 — Cart

Work Packages：

* `WP-1200` Cart Aggregate 与 Cart Item
* `WP-1201` Add / Update / Remove Item Command
* `WP-1202` Option Selection Validation
* `WP-1203` Cart Quote Attachment
* `WP-1204` Cart Expiration / Abandonment
* `WP-1205` Customer Cart API 与 PWA State Integration

Acceptance Criteria：

* Cart 只能引用当前有效 Sellable 与 Option
* Price 变化后 Checkout 必须 Requote
* 重复 Add Command 在相同 Idempotency Key 下不重复添加

#### Feature F12.2 — Checkout and Order Creation

Work Packages：

* `WP-1220` Checkout Validation
* `WP-1221` Order Aggregate Minimum Model
* `WP-1222` Order Item Immutable Snapshot
* `WP-1223` Store Business Date Resolution 与 Order Number Generation
* `WP-1224` Create Order API
* `WP-1225` Order Status Projection
* `WP-1226` OrderCreated Event

Acceptance Criteria：

* Order 保存 Catalog、Price、Tax 与 Option Snapshot
* 后续 Catalog 修改不改变历史 Order
* 重复 Create Order 不生成第二个 Order
* Business Date 由 Store IANA timezone + versioned configurable Business Day Start（default `04:00` local）解析，而不是 UTC midnight；Order Number sequence 仅在该边界重置，并在 DST gap / overlap、跨午夜和并发创建测试中保持 Store + Business Date 唯一

#### Feature F13.1 — Payment Provider Baseline

Work Packages：

* `SPIKE-1300` Payment Provider Capability / Cost / Region Spike
* `WP-1301` Payment Adapter Interface
* `WP-1302` Payment Intent Creation
* `WP-1303` Provider Webhook Verification
* `WP-1304` Payment Webhook Idempotency
* `WP-1305` PaymentSucceeded / Failed Event
* `WP-1306` Payment Status Projection
* `WP-1307` Payment Reconciliation Job Baseline
* `WP-1308` Payment Kill Switch
* `WP-1309` Terminal Authorization Capture Watchdog
* `WP-1310` PaidWithoutFulfillableOrder Compensation、Refund Reconciliation 与 Exception Projection Source

Acceptance Criteria：

* 重复 Webhook 不重复记账或推进 Order
* Provider Payload 不进入核心 Payment Aggregate
* Payment Success 可以可靠推进 Order Confirmation
* non-Interac Terminal authorization 在 Order acceptance 后立即幂等 capture，10 分钟告警、最迟 20 分钟 capture 或 cancel / resolve 并创建 Reconciliation Exception；Interac 永不调用独立 capture
* capacity / submission cancellation 后的 late Provider success 或任何 paid-but-unfulfillable inconsistency 幂等创建 Critical `PaidWithoutFulfillableOrder`，阻止 Kitchen release，使用稳定 compensation key 启动原支付方式全额退款，并保持 Case Open 直到 Provider-confirmed refund 与 Operations reconciliation

#### Feature F14.1 — Kitchen Order Intake

Work Packages：

* `WP-1400` Confirmed Order Consumer
* `WP-1401` Kitchen Ticket / Item Minimum Aggregate
* `WP-1402` Station Routing Minimum Rule
* `WP-1403` Kitchen Queue Projection
* `WP-1404` Accept / Start / Ready Command
* `WP-1405` Kitchen Realtime Message
* `WP-1406` ItemReady / OrderReady Event
* `WP-1407` Structured Allergen-assistance Review、KDS Cue / Acknowledgement 与 Incident Link
* `WP-1408` KDS Stale / Read-only Continuity、Operator Lock / Handover 与 Recovery Reconciliation

Acceptance Criteria：

* Kitchen 不直接读取 Ordering 私有表
* 重复 OrderConfirmed Event 不重复创建 Ticket
* Ready 之前必须满足当前 Kitchen Workflow

#### Feature F15.1 — Physical Output Job Baseline（Future Trigger）

IDR-0039 excludes physical printers、Store Gateway and browser Offline Queue from the first Pilot. The following packages remain designed future work and are not scheduled or installed unless IDR-0039 becomes `Revisit Required` and is revised with real device evidence.

Work Packages：

* `SPIKE-1500` 首个 Printer / Gateway Adapter Spike
* `WP-1501` Output Job Contract
* `WP-1502` Kitchen Ticket Template Snapshot
* `WP-1503` Output Routing Minimum Rule
* `WP-1504` Output Attempt / Retry
* `WP-1505` Device Health Stub
* `WP-1506` Print Failure Alert

Acceptance Criteria：

* Order / Kitchen Event 可以建立 Output Job
* 重试不会重复生成业务事实
* 打印失败不回滚已确认 Order

#### Feature F16.1 — Pickup Fulfillment

Work Packages：

* `WP-1600` Pickup Fulfillment Aggregate
* `WP-1601` Ready for Pickup Consumer
* `WP-1602` Pickup Code / Verification Minimum Contract
* `WP-1603` Complete Pickup Command
* `WP-1604` FulfillmentCompleted Event
* `WP-1605` Order Completion Projection

Acceptance Criteria：

* Kitchen Ready 后才能完成 Pickup
* 重复 Complete Command 不产生重复完成事实
* Fulfillment 不能直接修改 Kitchen 数据

#### Feature F17.1 — Customer PWA Flow

Work Packages：

* `WP-1700` QR Entry 与 Store Context Screen
* `WP-1701` Menu Browse / Product Detail
* `WP-1702` Cart UI
* `WP-1703` Checkout / Quote Review
* `WP-1704` Payment Redirect / Result Handling
* `WP-1705` Order Status Realtime Screen
* `WP-1706` Pickup Ready / Confirmation Screen
* `WP-1707` PWA Offline Shell 与 Retry UX Baseline
* `WP-1708` Workbox Cache Allowlist、Private-route NetworkOnly 与 Safe Service Worker Update
* `WP-1709` Accessible Immutable Digital Receipt、Correction / Reissue 与 Guest-authorized Retrieval

Acceptance Criteria：

* Customer 可以完成完整扫码下单闭环
* 网络重试不重复创建 Order / Payment
* 错误信息使用公开 Error Contract

#### Feature F17.2 — Transactional Email and Receipt Delivery

Work Packages：

* `WP-1720` SES Domain Identity、DKIM / SPF / DMARC、Sandbox Exit 与 Regional Evidence
* `WP-1721` Localized Escaped Transactional Template、Minimal Receipt Body 与 No-tracking Contract
* `WP-1722` Idempotent Delivery、Bounce / Complaint Suppression、Retry / Dead-letter 与 Delivery Observability
* `WP-1723` Notification-worker Minted Resume Token、Fragment-link Delivery 与 Clean Recovery E2E
* `WP-1724` SES Event Authentication、Recipient Privacy、Retention 与 Deliverability Runbook

Acceptance Criteria：

* 交易通知与营销 Consent 完全分离，v0.1 不发送营销邮件
* 重复 Job 不创建第二个逻辑 Notification；Provider 超时进入 `Unknown` / explicit resend attempt，Bounce / Complaint 会进入 Suppression 和可观测处置
* Email / Event / Provider Log 不包含 Payment Secret、Pickup Proof 或不必要 Order 明细

#### Feature F18.1 — Merchant Web Flow

Work Packages：

* `WP-1800` Merchant Sign-in 与 Store Switch
* `WP-1801` Store Setup Minimum Screen
* `WP-1802` Catalog Authoring / Publish Screen
* `WP-1803` Order Queue
* `WP-1804` Kitchen Board
* `WP-1805` Pickup Completion Screen
* `WP-1806` Device / Output Failure View
* `WP-1807` Permission-aware Navigation
* `WP-1808` Managed KDS Browser Profile、Named Operator Session、Auto-lock / Handover 与 Device UAT
* `WP-1809` Order Exception Workbench、merchant_order_exception_v1 Projection 与 Authorized Compensation Actions

Acceptance Criteria：

* 用户只能看到被授权 Store 与 Action
* Kitchen / Pickup Action 通过后端 Business Command 执行
* 前端不能直接选择任意状态值
* `OPS-ORDER-EXCEPTION` 只展示 server-authorized Store scope，支持 acknowledge、assign 与受控 resolve / compensate Command；Critical Payment / unpaid Dine-in exception 在创建后 15 分钟内可见，UI 不伪造 Provider-confirmed final state

#### Feature F19.1 — Operational Projection

Work Packages：

* `WP-1900` Order Operational Projection
* `WP-1901` Payment Operational Projection
* `WP-1902` Kitchen Operational Projection
* `WP-1903` Fulfillment Operational Projection
* `WP-1904` Projection Rebuild Command
* `WP-1905` Basic Merchant Dashboard Query

Acceptance Criteria：

* Projection 可以删除并从事实 Event 重建
* Reporting Role 无业务表写权限
* Projection Lag 可观测

### 54.6 Cross-cutting Quality Backlog

#### Feature F20.1 — Contract and Architecture Tests

* `WP-2000` OpenAPI Schema Validation
* `WP-2001` Event Envelope Contract Test
* `WP-2002` Consumer Compatibility Test
* `WP-2003` Provider Adapter Contract Test
* `WP-2004` Module Dependency Test
* `WP-2005` Database Permission Test

#### Feature F20.2 — E2E and Failure Injection

* `WP-2020` QR → Menu → Cart → Order E2E
* `WP-2021` Payment Success E2E
* `WP-2022` Duplicate Webhook Scenario
* `WP-2023` Outbox Dispatcher Failure Scenario
* `WP-2024` Printer Offline Scenario
* `WP-2025` Projection Rebuild Scenario
* `WP-2026` Concurrent Update Scenario
* `WP-2027` Allergen Unknown / Conflict、Modifier Propagation、Staff Review 与 Kitchen Acknowledgement E2E
* `WP-2028` Receipt / Resume Email Duplicate、Bounce、Token Leak 与 No-contact Recovery E2E

#### Feature F20.3 — Security and Privacy

* `WP-2040` Authentication Threat Model
* `WP-2041` Tenant Isolation Security Test
* `WP-2042` Rate Limit / Abuse Baseline
* `WP-2043` PII Log Redaction
* `WP-2044` Secret Scanning
* `WP-2045` Payment Webhook Security Review
* `WP-2046` Break-glass Access Runbook
* `WP-2047` HTTP Security Header、CSP、CORS 与 Request Limit Baseline
* `WP-2048` Public Capability Token、Enumeration 与 Pickup Attempt Security Test
* `WP-2049` PWA Cache Storage、Offline Mutation 与 Update-interruption Security Test
* `WP-2050` SBOM、Build Provenance、Container Scan、Signing 与 Digest Promotion Gate
* `WP-2051` Privacy Rights、Necessary-cookie、Consent and Retention Execution Test
* `WP-2052` KMS / Secret Rotation、Audit Integrity 与 Immutable Archive Test
* `WP-2053` Cross-Region Backup / Replica、Failover and Reconciliation Drill
* `WP-2054` Upload Quarantine、Content Sniffing、Signed Download and SSRF / Egress Test
* `WP-2055` Statutory Record Archive、Retention / Legal Hold、Restore and Privacy-tombstone Verification

#### Feature F20.4 — AWS Cloud Foundation and Release Controls

* `WP-2060` AWS Organizations Accounts、IAM Identity Center、Root / Break-glass and SCP Baseline
* `WP-2061` Organization CloudTrail、AWS Config、GuardDuty、Security Hub、IAM Access Analyzer and Central Log Archive
* `WP-2062` Route 53 / Registrar / ACM、Regional WAF、ALB and Public-asset CloudFront Baseline
* `WP-2063` CDK VPC、ECS、RDS、S3、KMS、Secrets、VPC Endpoint、NAT / Network Firewall Egress and Least-privilege Role Stacks
* `WP-2064` GitHub OIDC、ECR Immutable Digest、CodeDeploy Blue / Green and Migration Task Pipeline
* `WP-2065` CloudWatch / X-Ray、Alert Routing、Budget / Cost Anomaly、Capacity and Acknowledgement Drill
* `WP-2066` CloudFormation Change-set / Drift、Deletion Protection、Backup Policy and Cross-account Restore Evidence

Acceptance Criteria：

* development、staging and production are isolated accounts and no workload runs in the management account
* production change deploys only a signed scanned digest through an approved change set and can roll back without schema incompatibility
* organization security controls、backup / restore、alerts、cost guardrails and drift detection produce reviewable evidence

### 54.7 Critical Path

Critical Path 顺序：

`WP-0001–0007`

→ `WP-0010–0014`

→ `WP-0020–0025`

→ `WP-0030–0036` + `WP-0040–0046`

→ `WP-0100–0109` + `WP-2040–2041`

→ `WP-1000–1007` + `WP-2042` + `WP-2048`

→ `WP-1020–1028`

→ `WP-1100–1105`

→ `WP-1200–1205`

→ `WP-1220–1226`

→ `WP-1301–1310` + `WP-2045`

→ `WP-1400–1408`

→ `WP-1600–1605`

→ `WP-1700–1709` + `WP-1720–1724` + `WP-1800–1809`

→ `WP-2043–2055` + `WP-2060–2066`

→ `WP-2020–2023` + `WP-2025–2028` + Phase 1 E2E / Security / Recovery Acceptance

Physical Printing packages and `WP-2024` are future-trigger work under IDR-0039，not first-Pilot dependencies. Operational Reporting may proceed after its source Event contracts freeze.

### 54.8 Parallel Workstreams

可并行但必须遵守 Contract Freeze：

* Customer PWA Shell
* Merchant Web Shell
* UI Design System
* Payment Provider Spike
* Printer / Gateway Spike（future trigger only under IDR-0039）
* Test Automation
* Observability / Deployment
* Security Threat Modeling
* Seed / Fixture Preparation
* API / Event Documentation

规则：

* Spike 输出必须是 Decision / Adapter Contract / Risk，不直接写入核心 Domain Model
* 前端可使用 Mock Contract 开发，但 Contract 变化必须通过兼容 Review
* 并行任务不能绕过未完成的 Tenant、Permission、Idempotency 与 Audit 基线

### 54.9 Owner Role Matrix

* Platform Lead：Repository、Architecture Enforcement、Shared Kernel
* Backend Engineer：BOP / RMS Module、Database、API、Event
* Frontend PWA Engineer：Customer PWA
* Frontend Merchant Engineer：Merchant Web
* Integration Engineer：Payment、Notification Adapter；Printer only after the IDR-0039 trigger
* QA / Automation Engineer：Contract、Integration、E2E、Failure Injection
* DevOps / Platform Engineer：CI/CD、Environment、Observability、Backup
* Security Reviewer：Threat Model、Tenant Isolation、Webhook、Secret / PII
* Product / Domain Owner：Acceptance Scenario、Scope 与 Priority

实际团队较小时，同一人可以承担多个 Role，但审批、代码 Review 与生产访问应尽量避免完全由同一人闭环。

### 54.10 Backlog Import Contract

导入 Linear / GitHub Issues / Jira 时，建议字段：

* `external_id`
* `title`
* `description`
* `type`
* `epic_id`
* `feature_id`
* `phase`
* `priority`
* `critical_path`
* `owner_role`
* `dependencies`
* `labels`
* `acceptance_criteria`
* `definition_of_done`
* `risk_notes`

推荐 Labels：

* `phase-0`
* `phase-1`
* `bop`
* `rms`
* `critical-path`
* `parallel`
* `provider-spike`
* `backend`
* `frontend`
* `database`
* `eventing`
* `security`
* `testing`
* `documentation`

### 54.11 Backlog Item Definition of Ready

Work Package 进入执行前必须满足：

1. Scope 明确且不包含多个无关目标
2. 所属 Module 与 Owning Schema 明确
3. Public Contract 或 Draft Contract 已存在
4. Dependency 已完成或提供受控 Mock
5. Acceptance Criteria 可自动或人工验证
6. Tenant、Permission、Audit 与 Idempotency 要求已声明
7. Migration / Event / API 影响已说明
8. Feature Flag / Disable Strategy 已说明
9. 不包含未决的重大架构问题
10. Provider Spike 已完成或明确隔离 Adapter Boundary

### 54.12 Backlog Item Definition of Done

除 Blueprint 中已有 Module DoD 外，每个 Work Package 还必须：

* 通过 Review
* 更新相关 Contract / Documentation
* 包含必要 Migration 与 Test
* 在 Staging 或 Integration Environment 完成 Acceptance Scenario
* 具备 Observability
* 不增加未登记的跨 Module Dependency
* 明确 Rollback、Compensation 或 Disable 方法
* 关闭或关联发现的后续 Issue

### 54.13 第一个可执行 Work Package 选择

第一个可执行 Work Package 选定为：

**`WP-0001 — Initialize TypeScript Monorepo and Workspace Baseline`**

选择原因：

* 无业务前置依赖
* 是全部 Phase 0 / Phase 1 工作的共同基础
* 可以独立验收
* 不需要提前锁定 Payment、ORM、Hosting 等供应商
* 可以验证 Repository Blueprint 是否真正可执行

该 Work Package 目前只形成任务规格，不开始编码。

### 54.14 Initial Backlog 状态

Initial Backlog v0.1 已完成并 Freeze。

已锁定：

* Epic、Feature、Story / Work Package 层级
* Phase 0 与 Phase 1 首批 Backlog
* Critical Path 与 Parallel Workstream
* Provider Spike 边界
* Owner Role、Dependency、Definition of Ready 与 Definition of Done
* Backlog Import Contract
* 第一个可执行 Work Package 选择

---

## 历史讨论节点 H-055（已完成）

Implementation Specification / Engineering Blueprint 已完成：

* Repository Blueprint
* Module Blueprint
* Database Blueprint
* API / Event Contract Blueprint
* Initial Backlog

下一步进入：

**First Executable Sprint / Work Package Specification。**

首先需要完成：

* `WP-0001` 的完整任务说明
* 输入、输出、非目标与约束
* 子任务与执行顺序
* 验收场景与检查清单
* 风险与回退策略
* 交给 Codex / Claude Code / Cursor 时使用的标准实施 Prompt

当前继续遵循：

* 暂不生成业务代码
* 只完成施工规格与执行计划
* 用户明确授权后才进入实际代码实现

---

## 56. Master Development Playbook

### 56.1 目的与适用范围

Master Development Playbook 是 BOP-RMS 的统一开发执行规范。

适用于：

* 人类开发者
* Codex
* Claude Code
* Cursor
* Copilot 或其他代码生成工具
* Code Reviewer
* QA、Security 与 DevOps 参与者

本 Playbook 不替代 Architecture、Module、Database 或 API Blueprint，而是规定实现这些 Blueprint 时必须遵守的统一工程行为。

优先级：

`Architecture Freeze`

→ `Module / Database / API Contract`

→ `Work Package Specification`

→ `Master Development Playbook`

→ `局部实现选择`

低层级内容不得覆盖高层级决定。发现冲突时必须暂停当前实现，创建 Issue 或 ADR，不得自行修改架构。

### 56.2 核心开发原则

所有实现必须遵循：

* 业务正确性优先于代码简短
* Domain Boundary 优先于局部便利
* 明确 Contract 优先于隐式约定
* 可验证事实优先于推测
* Transaction Source of Truth 不被 Projection、Cache 或 UI State 取代
* 配置可版本化，交易事实不可被后续配置改写
* 同一业务事实只有一个 Write Owner
* 跨 Module 协作不通过私有数据库表
* 默认拒绝访问，按 Scope 与 Permission 明确授权
* 失败必须可观察、可重试或可补偿
* 任何自动化生成的代码与人工代码执行相同质量门槛

禁止为了“先跑起来”而引入未登记的跨 Module 依赖、共享业务表、跳过 Tenant Scope、跳过 Audit 或跳过 Idempotency。

### 56.3 语言、运行时与工具基线

v0.1 基线：

* TypeScript 使用 Strict Mode
* Node.js 使用项目锁定的 LTS / Repository Version
* Package Manager 使用 `pnpm`
* Workspace / Task Orchestration 使用 Turborepo
* Backend 使用 Express 5 Composition Root
* Frontend 使用 React 19 + TypeScript
* Customer Channel 使用 PWA
* Database 使用 PostgreSQL
* 本地依赖通过 Docker Compose 管理

工具版本必须由 Repository 文件锁定，不依赖个人全局环境。

禁止：

* 在同一 Repository 混用多个 Package Manager
* 未经 ADR 替换核心 Runtime 或 Framework
* 在代码中依赖未锁定的全局 CLI 行为
* 手工修改 Lockfile 解决冲突

### 56.4 Repository 与 Folder Convention

顶层目录必须遵循 Repository Blueprint。

规则：

* `apps/*` 仅作为 Composition Root、Transport、Runtime 与 Deployment Entry Point
* `packages/bop/*` 保存通用平台 Module
* `packages/rms/*` 保存餐饮业务 Module
* `packages/contracts/*` 保存跨 Module 公开 Contract
* `packages/database/*` 只提供通用 Persistence Infrastructure
* `packages/testing/*` 提供 Test Harness、Fixture Builder 与 Assertion Helper
* `infrastructure/*` 保存部署、环境和运维资源
* `docs/*` 保存 Architecture、ADR、API、Event、Runbook 与 Onboarding
* `tests/*` 保存跨模块 Architecture、Contract、E2E、Security 与 Performance Test

Module 内部标准目录：

```text
src/
├─ domain/
│  ├─ aggregates/
│  ├─ entities/
│  ├─ value-objects/
│  ├─ services/
│  ├─ policies/
│  ├─ events/
│  └─ errors/
├─ application/
│  ├─ commands/
│  ├─ queries/
│  ├─ handlers/
│  ├─ ports/
│  └─ dto/
├─ infrastructure/
│  ├─ persistence/
│  ├─ messaging/
│  ├─ providers/
│  └─ jobs/
├─ interfaces/
│  ├─ http/
│  ├─ webhook/
│  ├─ realtime/
│  └─ consumers/
├─ contracts/
├─ tests/
├─ module.manifest.ts
└─ index.ts
```

空目录不应为了形式而保留；Generator 可以建立结构，但未使用目录在提交前可删除。

### 56.5 Naming Convention

统一命名：

* Package：`@bop/<kebab-case>`、`@rms/<kebab-case>`
* File：`kebab-case.ts`
* Class / Type / Interface：`PascalCase`
* Function / Variable：`camelCase`
* Constant：`UPPER_SNAKE_CASE`
* Database Schema / Table / Column：`snake_case`
* REST Resource：复数名词与 kebab-case
* Command：动词开头，例如 `CreateOrder`、`PublishMenu`
* Query：`Get`、`List`、`Search`、`Resolve` 开头
* Domain Event：过去式，例如 `OrderConfirmed`、`KitchenItemReady`
* Error Code：`MODULE_CATEGORY_REASON`
* Feature Flag：`module.capability.variant`
* Metric：`module.operation.result`

禁止使用无业务语义的通用名称，例如：

* `Manager`
* `Helper`
* `Utils`
* `CommonService`
* `DataProcessor`
* `HandleData`

通用函数必须按明确能力命名，并放入拥有该语义的 Package。

### 56.6 TypeScript Coding Convention

必须：

* 开启 `strict`
* 公共函数与 Public Contract 明确输入输出类型
* 避免 `any`；确需使用时必须局部隔离并说明原因
* 对外部输入先解析和验证，再进入 Application Layer
* 使用不可变数据表达 Contract 与 Domain Event
* 使用 Exhaustive Check 处理有限状态
* 对 `null` 与 `undefined` 采用一致语义
* 时间、Money、ID 等使用明确 Value Object 或 Branded Type
* Async 函数返回明确 Promise 类型
* 错误不得通过字符串匹配判断业务类别

禁止：

* Domain Layer Import Express、ORM、Queue SDK 或 Provider SDK
* 在 Controller、React Component 或 SQL Mapper 中实现业务规则
* 以 `as any`、双重类型断言或关闭 Lint 绕过 Contract
* 捕获 Error 后静默忽略
* 在业务代码中使用浮点数计算金额
* 将 Date Object 直接当作 Store Local Business Date

### 56.7 Function 与 Class 设计

规则：

* 一个函数只承担一个明确业务或技术目的
* Application Handler 编排事务，不实现复杂 Domain Rule
* Aggregate 执行自身 Invariant 与状态变化
* Domain Service 只用于无法自然归属单一 Aggregate 的业务规则
* Infrastructure Adapter 负责技术转换，不决定业务结果
* Public Interface 返回稳定 DTO，不返回 ORM Entity
* Constructor 不执行网络、数据库或异步副作用
* 依赖通过明确 Port / Interface 注入

不设机械式行数限制，但出现多重职责、深层嵌套或大量布尔参数时必须重构。

### 56.8 DDD 规则

Aggregate：

* Aggregate Root 是一致性边界
* 外部只能通过 Aggregate Root 修改内部 Entity
* 一个 Transaction 默认只修改一个业务 Aggregate；跨 Aggregate 通过 Application Orchestration 或 Event
* Aggregate 保存自身状态，不查询其他 Module 私有数据
* Aggregate Method 使用业务语言命名
* 状态变化由合法 Action 触发，不允许任意 Setter
* Domain Event 在状态成功变化后产生

Entity：

* 具有稳定 Identity
* Equality 基于 Identity，不基于全部字段
* 不直接暴露可变 Collection

Value Object：

* 无独立 Identity
* 创建时验证 Invariant
* 默认不可变
* Equality 基于 Value

Domain Service：

* 必须有清晰业务名称
* 不作为贫血模型的通用逻辑收容箱

Repository：

* 一个 Aggregate Root 对应 Repository Contract
* Repository 不承担 Reporting、跨 Aggregate 搜索或任意 Join
* Save 时执行 Optimistic Concurrency

### 56.9 CQRS 规则

Command：

* 表达用户或系统请求执行的业务动作
* 必须包含执行所需 Context，不依赖隐式全局状态
* 写入前验证 Tenant Scope、Permission、Idempotency 与业务前置条件
* 成功后返回最小稳定 Result，不返回内部 Aggregate
* Command Handler 负责 Transaction Boundary、Audit 与 Outbox 协调

Query：

* 不修改 Source of Truth
* 优先读取 Projection 或 Module-owned Read Model
* Query DTO 不暴露内部 Table Structure
* Query 可按用途优化，不要求复用 Aggregate Repository
* Projection 延迟必须能够被客户端识别或由 SLA 管理

禁止：

* 在 Query Handler 中执行业务写入
* 在 Command Handler 内拼接复杂 Reporting Query
* 为追求“纯 CQRS”而过度拆分简单内部调用

### 56.10 Application Transaction 规则

每个写操作必须明确：

* Transaction Boundary
* Owning Module
* Tenant Scope
* Actor / System Actor
* Permission Decision
* Idempotency Strategy
* Aggregate Version
* Audit Record
* Outbox Event
* Failure / Compensation Strategy

数据库 Transaction 内只执行必要的本地 Persistence 操作。

禁止在 Database Transaction 中等待外部 Provider、发送 Email、调用 Printer 或执行长时间计算。

外部副作用通过 Outbox、Job 或受控 Post-commit Process 执行。

### 56.11 Event 规则

Domain / Integration Event：

* 名称使用已经发生的事实与过去式
* Event ID 全局唯一
* 包含 Event Type、Version、Occurred At、Producer、Aggregate ID、Tenant Scope 与 Correlation / Causation ID
* Payload 只保存消费者需要的稳定事实
* 不包含 Secret、完整支付凭据或无关 PII
* 同一逻辑事实不得由多个 Module 竞争发布
* 发布与业务写入通过 Transactional Outbox 原子提交

Consumer：

* 必须使用 Inbox / Idempotency
* 允许 At-least-once Delivery
* 重复消息不得产生重复业务结果
* 失败必须记录 Attempt、Error 与 Retry Schedule
* Poison Message 进入隔离或人工处理流程
* 不因非关键 Consumer 失败回滚源业务 Transaction

Event Evolution：

* 新增 Optional Field 通常属于兼容变化
* 删除、重命名或改变语义必须升 Major Version 或发布新 Event Type
* Consumer 必须声明支持的 Version
* 禁止复用旧字段表达新语义

### 56.12 API 与 Webhook 规则

REST：

* `/api/v1` 作为第一版稳定入口
* Resource Query 与业务 Command 路由区分清楚
* 写请求支持 Idempotency Key
* 并发敏感资源使用 Version / ETag / If-Match
* Error 使用统一 Error Contract 与稳定 Error Code
* Validation Error 提供字段级原因
* Pagination 默认 Cursor-based
* Tenant Context 不信任客户端任意声明，必须与认证和授权共同解析

Webhook：

* 验证签名、时间窗口与 Replay
* 保存 Provider Event ID 与原始 Payload Reference
* 先去重，再映射到内部 Contract
* Provider-specific 字段不得渗入 Domain Model
* 返回状态与内部业务成功分离，必要时异步处理
* Webhook Handler 必须具备 Observability 与 Reconciliation

### 56.13 Database 与 Persistence 规则

必须遵守 Database Blueprint：

* 单 Database、多 Schema
* 每个 Module 只写自己的 Schema
* 跨 Module 默认不建立强 FK
* Aggregate Root 使用 Optimistic Concurrency
* 金额使用 Minor Unit + Currency Code
* 时间保存 UTC Instant；Store 同时保存 IANA Time Zone 与必要 Business Date
* Append-only Record 普通流程不得 Update / Delete
* Projection 可删除重建
* JSONB 只用于有明确边界的扩展数据、原始 Provider Reference 或 Snapshot
* JSONB 不用于规避关系建模、索引设计或 Contract
* 所有 Index 必须对应已知 Query
* Migration 不依赖手工生产操作

Repository / Mapper：

* ORM Entity 与 Database Row 不进入 Domain 或 Public Contract
* Mapper 负责 Domain 与 Persistence Model 转换
* Persistence Error 转换为稳定 Application Error
* 避免 N+1 与无边界全表读取

### 56.14 Migration 规则

Migration：

* 按 Module Namespace 管理
* Filename 包含顺序、Module 与动作
* 在空库与升级路径同时测试
* 生产 Migration 优先 Forward-only
* 破坏性变化使用 Expand → Migrate → Contract
* 大数据 Backfill 与 Schema Change 分离
* 长时间操作必须评估 Lock 与 Deployment Impact
* Migration 不插入 Demo 数据
* Reference Seed 必须幂等并有 Owner

每个 Migration PR 必须包含：

* 目的
* Owning Module
* 向前执行方式
* 回退或补偿方式
* 数据影响
* Lock / Performance 风险
* Backfill 计划
* Contract 影响
* 测试证据

### 56.15 Error Handling 规则

错误分层：

* Domain Error：业务 Invariant 或状态不允许
* Application Error：权限、Scope、Idempotency、Conflict、Not Found
* Infrastructure Error：Database、Queue、Provider、Network
* Transport Error：Request Parse、Authentication、Protocol

规则：

* Error Code 稳定，Message 可本地化
* 对外不暴露 Stack、SQL、Secret 或内部文件路径
* 原始 Error 通过 Correlation ID 在受控日志中追踪
* 可重试错误与永久错误必须区分
* Retry 必须有上限、Backoff 与最终处置
* 不允许空 `catch`
* 不允许将所有异常统一返回 500

### 56.16 Logging 与 Observability 规则

每次 Request、Command、Event、Job 与 Webhook 必须可通过以下字段关联：

* Correlation ID
* Causation ID
* Request / Command / Event / Job ID
* Environment
* Module
* Brand / Store Scope（允许时）
* Actor Reference（允许时）
* Operation
* Result
* Duration
* Error Code

日志：

* 使用 Structured Log
* 不记录 Password、Token、Secret、完整支付信息或不必要 PII
* 不将大量 Payload 默认写入 Log
* Customer Note 等自由文本按 PII 处理
* Debug Log 不得成为业务审计来源

每个新能力至少定义：

* Success Metric
* Error Metric
* Latency Metric
* Queue / Event Lag（适用时）
* Health / Readiness 影响
* Alert Threshold 或明确不告警原因

### 56.17 Security 规则

必须：

* Default Deny
* Authentication 与 Authorization 分离
* 每个写操作执行 Tenant Scope 与 Permission Check
* Service / Worker 使用最小权限身份
* Secret 只通过受控 Secret Store / Environment Reference
* Provider Credential 不进入普通配置表或日志
* 输入 Validation、Output Encoding 与 Content Security 规则按接口实施
* Webhook 防重放
* Rate Limit 按 Customer、Actor、IP、Brand 或 Provider 风险组合
* 敏感操作要求 Audit
* Break-glass 访问要求审批、期限与记录

禁止：

* 依赖隐藏 UI 按钮作为权限控制
* 客户端传入 Role 后直接信任
* 在前端或 Repository 保存真实 Secret
* 使用生产数据作为普通本地 Fixture
* 未经评审自行采集新的 PII

### 56.18 Privacy 与 Data Governance 规则

每个新增字段必须判断：

* 是否 PII
* Classification
* Purpose
* Retention
* Access Scope
* Export / Delete / Correction 行为
* 是否进入 Event、Log、Projection 或 Analytics

原则：

* Data Minimization
* Purpose Limitation
* Projection 仅复制必要字段
* Analytics 优先去标识化
* Legal Hold 可覆盖普通 Retention，但必须受控
* 删除请求不允许破坏法定交易、财务或审计记录
* Customer-facing 删除与内部受控保留必须区分

### 56.19 Testing Strategy

测试层级：

1. Domain Unit Test
2. Application Handler Test
3. Module Persistence Integration Test
4. Contract Test
5. Architecture Test
6. Cross-module Integration Test
7. E2E Acceptance Test
8. Failure Injection Test
9. Security Test
10. Migration Test
11. Performance / Load Test（达到对应阶段时）

规则：

* 测试验证业务行为，不只验证实现细节
* Domain Invariant 必须有 Unit Test
* 每个 Public Contract 必须有 Contract Test
* Event Consumer 必须测试重复消费
* Payment / Webhook 必须测试重复、乱序、延迟与签名失败
* Migration 必须测试空库和已有版本升级
* Projection 必须测试重建
* Critical Path 必须具有 E2E Acceptance Scenario
* Bug Fix 必须先补充可复现测试或明确无法自动化的原因

测试数据：

* 使用 Builder / Factory
* Fixture 表达业务语义
* 不依赖执行顺序
* 不共享可变全局状态
* 不复制生产 PII
* 时间相关测试使用可控 Clock

### 56.20 Mock、Stub 与 Test Double 规则

* Domain Unit Test 不连接真实 Infrastructure
* Module Integration Test 使用真实 PostgreSQL 或等价隔离环境
* Provider Adapter 使用 Contract-backed Stub / Simulator
* 不 Mock 被测模块的核心业务对象
* Mock 必须只模拟外部 Boundary
* 过度 Mock 导致测试只验证调用次数时应改为行为测试
* Provider Spike 产生的测试样本必须去敏并进入受控 Fixture

### 56.21 Frontend 规则

Merchant Web 与 Customer PWA：

* UI 不拥有核心业务规则
* Form Validation 提升体验，但后端仍执行权威验证
* Server State、Local UI State 与 Offline Queue 分离
* API DTO 通过生成或共享 Contract Type 使用
* 不直接依赖数据库或内部 Module Type
* Loading、Empty、Error、Retry 与 Offline State 必须显式设计
* Realtime Message 只触发状态刷新或安全的 UI Transition，不取代 Source Query
* Accessibility、Keyboard、Focus、Contrast 与 Screen Reader 基线进入 DoD
* Customer PWA 必须考虑弱网、重复提交与恢复

### 56.22 Performance 规则

每个变更评估：

* Query 数量与 Index
* Payload 大小
* N+1
* Transaction Duration
* Lock 范围
* Event / Job Fan-out
* Retry Storm
* Cache Invalidation
* Projection Freshness
* Customer PWA 网络成本

原则：

* 先基于可观察数据优化
* 不以破坏 Domain Boundary 换取未经证明的性能
* Cache 不是 Source of Truth
* Cache Key 必须包含正确 Tenant / Version Scope
* 所有 Cache 必须有失效与降级策略
* 大列表使用 Pagination
* 批处理使用受控 Batch Size 与 Checkpoint

### 56.23 Feature Flag 与 Kill Switch 规则

Feature Flag：

* 有 Owner、Purpose、Scope 与 Expiry / Review Date
* 同时控制前端入口与后端执行
* 默认状态明确
* 测试启用与禁用路径
* 不作为永久配置系统替代品

Kill Switch：

* 用于阻止新操作、安全暂停或关闭外部 Provider
* 必须定义当前进行中 Transaction 的处理规则
* 操作必须 Audit
* 恢复必须有验证步骤

过期 Flag 必须清理，不能无限累积。

### 56.24 Git Branch 与 Commit Strategy

默认策略：

* 主分支始终可构建、可测试、可部署
* Work Package 使用短生命周期 Branch
* Branch 名包含 Work Package ID 与简短描述
* Commit 小而完整，描述“为什么”而非只描述文件变化
* 不混入无关格式化或重构
* Generated Artifact 与 Source Contract 同步提交
* 不直接推送未 Review 的业务变更到主分支

推荐 Branch：

`wp/WP-0001-monorepo-baseline`

推荐 Commit：

`WP-0001 initialize pnpm workspace and turbo pipeline`

禁止将多个独立 Work Package 压入同一巨大 PR。

### 56.25 Pull Request 规则

每个 PR 必须包含：

* Work Package / Issue Reference
* Scope
* Non-goals
* Architecture / Contract 影响
* Database / Migration 影响
* API / Event 影响
* Security / Privacy 影响
* Test Evidence
* Observability
* Rollback / Disable Strategy
* Screenshots 或 Scenario Evidence（适用时）
* Follow-up Issues

PR 应可由 Reviewer 在合理范围内理解和验证。

若必须提交大型 PR，需先说明拆分不可行原因与 Review Plan。

### 56.26 Code Review Checklist

Reviewer 必须检查：

1. 是否符合 Work Package Scope
2. 是否违反 Architecture Freeze
3. Module Ownership 与 Dependency 是否正确
4. Domain Rule 是否位于正确 Layer
5. Tenant、Permission、Audit、Idempotency 是否完整
6. Transaction 与 Outbox 是否原子
7. API / Event Contract 是否兼容
8. Database Migration 是否安全
9. Error、Retry 与 Compensation 是否明确
10. PII、Secret 与 Log 是否安全
11. Test 是否覆盖主要行为和失败路径
12. Observability 是否足够
13. 是否存在不必要复杂度或过度抽象
14. 是否引入未登记的 Future Scope
15. Documentation 是否同步

仅“代码可以运行”不足以批准 PR。

### 56.27 Architecture Conformance Review

以下变化必须进行 Architecture Review：

* 新 Module
* 新同步跨 Module Dependency
* 跨 Schema Read Contract
* 新 Shared Capability
* 新 Event Type 或 Major Version
* 新 Provider Boundary
* 新 PII Category
* 新长期 Job / Workflow
* 改变 Transaction Boundary
* 改变 Tenant Isolation
* 绕过 Outbox / Inbox

发现必须改变已 Freeze 决定时，创建 ADR，不在普通 PR 中隐式完成。

### 56.28 AI Collaboration Rules

所有 AI 工具在开始任务前必须获得：

* Work Package ID
* Scope 与 Non-goals
* 相关 Blueprint / Contract
* Owning Module
* Allowed Dependencies
* Acceptance Criteria
* Definition of Done
* 禁止修改范围

AI 必须：

* 先读取当前 Repository 与相关文档
* 只修改任务需要的文件
* 不自行扩大 Scope
* 不自行选择破坏 Contract 的捷径
* 不编造不存在的 API、Table、Event 或 Requirement
* 发现冲突时明确报告
* 提交前运行规定的 Test 与 Architecture Check
* 输出变更摘要、测试结果、风险与未完成项

AI 禁止：

* 重写大量无关代码
* 未经授权升级核心依赖
* 删除失败测试以让 CI 通过
* 通过 `any`、禁用 Lint 或跳过 Test 掩盖问题
* 改写 Migration 历史
* 直接修改其他 Module 私有表或 Contract
* 将 Provider SDK 类型暴露到 Domain
* 将临时 Mock 当作生产实现

### 56.29 多 AI 职责建议

在多人或多 AI 协作时建议分工：

* Architecture / Product Agent：维护 Blueprint、ADR、Scope 与验收
* Implementation Agent：实现单一 Work Package
* Test Agent：补充独立测试与 Failure Scenario
* Review Agent：检查架构、Contract、安全与可维护性
* DevOps Agent：CI/CD、Environment、Observability 与 Runbook

同一个 AI 可以承担多个角色，但必须分阶段执行，不能以“自我 Review”替代必要的独立 Review。

### 56.30 AI Handoff Format

每次 AI 完成 Work Package 后必须提供：

* Work Package ID
* 完成内容
* 修改文件
* Contract / Migration / Event 变化
* 运行的 Test 与结果
* 未运行的 Test 与原因
* Acceptance Criteria 对照
* Known Risks
* Follow-up Items
* 是否建议 Merge

不得只回复“完成”或只提供代码 Diff。

### 56.31 Standard Implementation Prompt Structure

交给 Codex、Claude Code、Cursor 或其他工具的标准 Prompt 必须包含：

1. 项目与架构背景
2. Work Package ID 与目标
3. Scope
4. Non-goals
5. 相关文件与 Contract
6. Allowed Dependencies
7. 禁止修改内容
8. Required Deliverables
9. Acceptance Criteria
10. Required Tests
11. Security / Privacy / Observability 要求
12. 输出格式

Prompt 必须要求工具先检查现有代码，不假设 Repository 为空。

### 56.32 Documentation Rules

代码与文档必须同步。

需要更新文档的情况：

* 新 Module 或 Dependency
* Public API / Event 变化
* Database Migration 或 Schema Ownership 变化
* 新 Feature Flag / Kill Switch
* 新 Provider Adapter
* 新 Runbook 操作
* 新 Error Code
* 新 PII / Retention 规则
* 新 Architecture Decision

文档以 Repository 为 Source of Truth；聊天记录不能作为唯一规范来源。

### 56.33 Dependency Management

* 所有 Dependency 由 Package Manifest 与 Lockfile 管理
* 引入前检查 License、维护状态、安全与 Bundle / Runtime 影响
* 核心能力优先使用稳定、必要的依赖
* 不因单一小函数引入大型 Library
* Provider SDK 只存在于 Adapter Package
* Dependency Upgrade 单独提交或在 PR 中明确说明
* Major Upgrade 必须有 Migration 与 Compatibility Plan
* 自动化安全更新仍需测试，不直接盲目合并

### 56.34 Technical Debt 规则

允许受控技术债，但必须：

* 建立 Issue
* 说明原因
* 说明影响
* 说明临时保护措施
* 指定 Owner 与 Review Milestone
* 不违反 Security、Tenant Isolation、Payment Integrity、Audit 或 Transaction Truth

不得以 `TODO` 注释替代 Backlog Issue。

### 56.35 Definition of Ready 补充

进入实际编码前，Work Package 除 Initial Backlog 的 DoR 外，还必须确认：

* 已指定适用的 Playbook Version
* 开发工具与技术版本已锁定
* 需要的 Test Harness 可用
* Architecture / Contract 引用可以访问
* 预计修改的 Module 与 Schema 已列出
* Reviewer Role 已明确
* AI 使用时已提供禁止修改范围

### 56.36 Definition of Done 补充

Work Package 完成时必须：

* 代码、Migration、Contract 与文档一致
* 所有适用测试通过
* Architecture Test 通过
* 没有未授权跨 Module Dependency
* 没有新增高风险安全或隐私问题
* Observability 可定位成功与失败
* Acceptance Scenario 已执行
* Rollback / Disable / Compensation 已验证或记录
* Reviewer 已确认
* Handoff 已完成

### 56.37 Playbook Exception Process

如某 Work Package 无法遵守本 Playbook：

1. 明确具体规则
2. 说明业务或技术原因
3. 提供替代方案
4. 评估架构、安全、数据与维护影响
5. 指定临时或永久性质
6. 获得 Architecture Owner 批准
7. 创建 ADR 或 Exception Record
8. 设定复查日期

未经记录的例外视为缺陷。

### 56.38 Playbook Governance

Playbook 使用版本管理。

每次变更必须记录：

* Version
* Changed Sections
* Reason
* Compatibility Impact
* Effective Date
* Approved By

新规则不自动要求改写全部历史代码；必须按风险与 Milestone 制定 Adoption Plan。

安全、隐私、Tenant Isolation、Payment Integrity 与 Audit 相关修订可以要求立即执行。

### 56.39 Master Development Playbook Acceptance Criteria

必须证明：

1. 一个新开发者或 AI 可以根据 Playbook 判断代码应放置的 Layer 与 Module
2. 对同一 Work Package，不同 AI 使用相同 Naming、Contract、Test 与 Handoff 结构
3. CI 可以执行核心 Architecture、Type、Lint、Test 与 Migration Gate
4. Reviewer 可以使用统一 Checklist 判断是否批准
5. Domain、Application、Infrastructure 与 Interface 不发生反向依赖
6. Command、Query、Event 与 Webhook 具有不同清晰语义
7. Money、Time、Tenant、PII、Audit 与 Idempotency 规则无歧义
8. Provider-specific 类型不会进入核心 Domain
9. Migration、Contract 与 Documentation 变化可以追踪
10. Playbook Exception 必须经过记录和批准
11. AI 不会因缺少规则自行扩大 Scope
12. WP-0001 Specification 可以直接引用本 Playbook，而无需重复全部工程规则

### 56.40 Master Development Playbook 状态

Master Development Playbook v0.1 已完成并 Freeze。

已锁定：

* Repository、Folder、Naming 与 TypeScript Coding Convention
* DDD、CQRS、Transaction、Event、API 与 Database 实现规则
* Migration、Error、Observability、Security 与 Privacy 规则
* Testing、Frontend、Performance 与 Feature Flag 规则
* Git、Commit、PR、Code Review 与 Architecture Review 规则
* AI Collaboration、Handoff 与 Standard Prompt 结构
* Documentation、Dependency、Technical Debt 与 Exception Governance
* Definition of Ready / Done 补充与验收标准

本 Playbook 只规定开发方法与质量门槛，没有生成业务代码。

---

## 历史讨论节点 H-057（已完成）

Architecture、Engineering Blueprint、Initial Backlog 与 Master Development Playbook 已完成。

下一步进入：

**First Executable Sprint / Work Package Specification。**

首先细化：

**`WP-0001 — Initialize TypeScript Monorepo and Workspace Baseline`**

需要完成：

* Work Package Goal、Scope 与 Non-goals
* 输入文档、约束与允许的 Implementation Choice
* Deliverables 与文件级结果
* 子任务和执行顺序
* CI / Test / Architecture Gate
* Acceptance Scenario
* 风险、回退与失败处理
* Reviewer Checklist
* 标准 AI Implementation Prompt
* Sprint / Work Package 完成后的 Handoff 格式

当前继续遵循：

* 暂不生成代码
* 只形成可执行施工规格
* 用户明确授权进入编码后，才执行 `WP-0001`

---

## 58. Implementation Decision Record

### 58.1 目的与边界

Implementation Decision Record（IDR）用于记录不会改变已冻结业务架构，但会直接影响某个 Work Package、Repository Baseline、运行方式、工具链或交付流程的具体实现选择。

IDR 与 ADR 的边界：

* ADR 记录 Architecture、Domain Boundary、数据所有权、依赖方向或长期平台结构决策
* IDR 记录在既定 Architecture 内的工具、框架配置、运行方式、测试实现与供应商选择
* 实现选择一旦改变 Module Boundary、Public Contract、Database Ownership、Tenant Boundary 或交易事实模型，必须升级为 ADR
* 不能用 IDR 绕过 Architecture Freeze 或 Playbook

优先级：

`Architecture Freeze`

→ `Module / Database / API Blueprint`

→ `Work Package Specification`

→ `Master Development Playbook`

→ `Approved IDR`

→ `局部代码实现`

### 58.2 IDR 状态

统一状态：

* `Proposed`
* `Under Review`
* `Accepted`
* `Rejected`
* `Superseded`
* `Deprecated`
* `Revisit Required`

只有 `Accepted` 的 IDR 可以作为执行基线。

### 58.3 IDR 最小结构

每份 IDR 至少保存：

* IDR ID
* Title
* Status
* Decision Scope
* Related Work Package / Module
* Context
* Decision
* Alternatives Considered
* Decision Drivers
* Consequences
* Risks
* Compatibility Impact
* Security / Privacy Impact
* Operational Impact
* Rollback / Exit Strategy
* Validation Plan
* Revisit Trigger
* Owner
* Reviewers
* Decision Date
* Effective Version
* Supersedes / Superseded By

命名格式：

`IDR-0001-short-kebab-title.md`

### 58.4 何时必须创建 IDR

以下情况必须创建 IDR：

* 选择或替换 ORM / Query Builder
* 选择 Test Runner、E2E Framework 或 Contract Schema 工具
* 选择 Logging、Tracing 或 Error Tracking 实现
* 选择 Queue / Job Runner、Object Storage 或 Cache 产品
* 选择 Payment、Delivery、SMS、Email、Map、Printer 等 Provider
* 决定 API Schema 生成、OpenAPI / AsyncAPI 工具链
* 决定 Docker、Worker、Migration、Seed 或 Fixture 的具体执行方式
* 决定 Repository 中影响多个 Package 的 TypeScript、Lint、Formatting 或 Build 配置
* 决定 CI/CD Provider、Branch Protection、Release 或 Deployment 执行方式
* 引入会进入多个模块的新 Runtime Dependency
* 采用 Temporary Workaround，且该方案可能持续超过一个 Work Package

以下情况通常不需要 IDR：

* 不影响 Contract 的局部函数实现
* 单个文件内的等价重构
* 遵循既有 Playbook 的常规命名或目录选择
* 已由 Accepted IDR 明确覆盖的配置

### 58.5 IDR Review Gate

IDR Review 必须确认：

1. 不改变已冻结 Architecture
2. 不引入新的跨 Module 写依赖
3. 不将 Provider-specific 类型带入核心 Domain
4. 不降低 Tenant、Permission、Audit、Idempotency 或 Security 门槛
5. 与 Repository、Database、API Blueprint 兼容
6. 有明确替代方案比较
7. 有可验证的 Exit / Rollback Strategy
8. 未把未来所有可能性过早引入 v0.1
9. License、Cost、Data Residency 与 Vendor Lock-in 已评估
10. 结果可以被后续开发者和 AI 明确执行

### 58.6 IDR Ownership

建议角色：

* Architecture Owner：判断是否应升级为 ADR
* Engineering Owner：提出实现选择并负责验证
* Security / Privacy Reviewer：审查敏感选择
* DevOps Reviewer：审查 CI、Deployment、Runtime 与 Observability
* Domain Owner：确认实现不破坏业务语义

AI 可以起草 IDR，但不能自行批准高影响 IDR。

### 58.7 IDR-0001 — Package Manager

Status：`Accepted`

Decision：v0.1 Monorepo 使用 `pnpm`，不混用 npm、Yarn 或 Bun Package Manager。

原因：

* Workspace 支持成熟
* 依赖隔离与磁盘效率较好
* 与 Turborepo 兼容
* Lockfile 可重复安装

约束：

* Repository 锁定 pnpm 版本
* CI 使用 Frozen Lockfile
* 不手工编辑 Lockfile
* 更换 Package Manager 必须创建新 IDR，并评估整个 Workspace 影响

### 58.8 IDR-0002 — Workspace Orchestration

Status：`Accepted`

Decision：v0.1 使用 Turborepo 管理跨 Package Task Graph、Cache 与 Pipeline。

原因：

* 适配 TypeScript Monorepo
* 支持 build、lint、typecheck、test 等依赖顺序
* 不改变业务 Module Boundary

非目标：

* 不把 Turborepo 作为业务 Workflow Engine
* 不依赖 Remote Cache 才能完成本地开发

Revisit Trigger：

* Task Graph 无法支持 Repository 规模
* CI Cache 可靠性不足
* 需要其他语言构建系统

### 58.9 IDR-0003 — Runtime Baseline

Status：`Accepted`

Decision：Node.js 使用 Repository 锁定的 Active LTS 版本；TypeScript 开启 Strict Mode。

规则：

* 通过 `.nvmrc`、`.node-version` 或等价文件锁定
* `package.json` 声明 engines
* Local、CI 与 Production 使用同一 Major Version
* 升级 Major Version 必须经过兼容测试和 IDR Review

### 58.10 IDR-0004 — Backend HTTP Framework

Status：`Accepted`

Decision：v0.1 API Composition Root 使用 Express 5。

适用范围：

* HTTP Transport
* Middleware Composition
* Routing
* Webhook Endpoint
* Health / Readiness

禁止：

* 在 Express Controller 中实现 Domain Rule
* 将 Express Request / Response 类型传入 Domain / Application Layer
* 使用 Framework-specific Error 作为 Public Domain Error

Revisit Trigger：

* Express 不能满足性能、安全或运行环境要求
* 需要统一迁移到其他 Runtime / Framework

### 58.11 IDR-0005 — Frontend Baseline

Status：`Accepted`

Decision：Merchant Web 与 Customer PWA 使用 React 19 + TypeScript。

规则：

* UI 不复制后端业务规则
* Server State 与 Local UI State 分离
* Contract Type 来自共享 Schema / Generated Client
* Customer Channel 保持 PWA 能力

Router、Form、State、Data-fetching、component primitive 与 styling choices 已由 `IDR-0021` / Section 86 锁定；对应 Work Package 只做 compatibility validation，不再重新选型。

### 58.12 IDR-0006 — Primary Database

Status：`Accepted`

Decision：v0.1 使用 PostgreSQL，单 Database、多 Schema 支撑模块化单体。

该决定执行 Database Blueprint，不重新讨论 Schema Ownership、Tenant Scope 或跨 Module 写限制。

Production Hosting 与 PostgreSQL Runtime 已由 `IDR-0022`、`IDR-0028`、`IDR-0029` / Section 86 锁定；对应 Work Package 只收集 account、Region、restore、cost 与 compatibility evidence。

### 58.13 IDR-0007 — ORM / Query Builder

Status：`Accepted`

Decision：v0.1 采用 Drizzle ORM `0.45.2` + Drizzle Kit `0.31.10`，并保留受控 SQL Escape Hatch。版本已于 `2026-07-15` 通过 npm registry 核对；首次安装仍必须执行 security、license、engine 与 multi-schema / outbox transaction 验证。

Validation Timing：首个 Persistence Work Package 的 Definition of Ready；选择本身已接受。

首次 compatibility validation 必须覆盖：

* PostgreSQL Schema 支持
* Migration Ownership
* Transaction 与 Outbox 原子写入
* Optimistic Concurrency
* Raw SQL Escape Hatch
* Type Safety
* Multi-schema 支持
* Testability
* Vendor Lock-in
* 不向 Domain Layer 暴露 ORM Entity

Domain Layer 不导入 Drizzle Entity；Persistence 继续通过 Module-owned Repository 隔离。

### 58.14 IDR-0008 — Unit / Integration Test Runner

Status：`Accepted`

Decision：使用 Vitest；WP-0001 Baseline 版本为 `4.1.10`，实际安装位于 WP-0003。

首次安装验证：

* TypeScript / ESM 兼容
* Workspace Test Isolation
* Coverage
* Mock / Fake Timer
* Integration Test Setup
* CI Performance

禁止同一 Repository 无理由混用多个 Unit Test Runner。

### 58.15 IDR-0009 — End-to-End Browser Testing

Status：`Accepted`

Decision：使用 Playwright；当前验证版本为 `1.61.1`，首次 E2E Work Package 安装前重新核对 Patch。

验证范围：

* Customer PWA 扫码点餐路径
* Merchant Web 关键运营路径
* 多浏览器基础覆盖
* API / Database Test Fixture 协作
* Screenshot / Trace 失败诊断

E2E 不替代 Module Integration 与 Contract Test。

### 58.16 IDR-0010 — Contract Schema Source

Status：`Accepted`

Decision：Contract Package 使用 Zod-first Runtime Schema；OpenAPI、JSON Schema / Event Catalog 与 TypeScript Type 从统一 Contract Source 生成或相互校验。

必须保证：

* Public Contract 不依赖 ORM
* Breaking Change 可检测
* API 与 Event 分开版本化
* Consumer Contract Test 可执行

### 58.17 IDR-0011 — Local Development Dependencies

Status：`Accepted`

Decision：本地 Database 与必要依赖通过 Docker Compose 管理。

规则：

* Application 代码本地运行与容器运行均可支持
* Compose 不保存真实 Secret
* Volume、Port 与 Healthcheck 明确
* Local Setup 使用单一文档与单条入口命令
* 不把 Production Deployment 逻辑等同于 Local Compose

### 58.18 IDR-0012 — CI Provider

Status：`Accepted`

Decision：建立新的 private GitHub Repository `bop-rms`，使用 GitHub Actions，并按 Section 86.4 的 staged governance 启用控制。默认分支 `main` 最终使用 protected branch / ruleset、Pull Request、required status checks、conversation resolution、linear history 与 squash merge；禁止常规 direct push、force push 和 branch deletion。独立 Reviewer / CODEOWNERS requirement 只在第二名授权人工 Reviewer 已存在时启用，并在任何 production enablement 前强制满足；不得伪造独立审批。AWS deployment 只使用 GitHub OIDC 短期凭据，不保存长期 AWS access key。

Portability Contract：若未来通过 `Revisit Required` 更换 GitHub，以下 CI Gate 仍保持不变。

CI 必须执行：

* Install with Frozen Lockfile
* Lint
* Type Check
* Unit Test
* Integration Test
* Architecture Test
* Contract Test
* Migration Test
* Secret / Dependency Scan
* Build

CI Provider 不能改变这些 Gate。

### 58.19 IDR-0013 — Logging Baseline

Status：`Accepted`

Decision：使用 Pino Structured JSON Logging；WP-0001 Baseline 版本为 `10.3.1`，在首个 Runtime Package 安装。

要求：

* Structured JSON Log
* Correlation / Trace ID
* Environment、Service、Module、Actor / Tenant Reference
* Error Code 与 Stack
* PII Redaction
* 不记录 Secret、Token、完整支付凭据

Logging Config 必须集中管理并执行 PII / Secret Redaction。

### 58.20 IDR-0014 — Tracing and Metrics

Status：`Accepted`

Decision：采用 OpenTelemetry Node SDK `0.220.0` + AWS Distro for OpenTelemetry Collector，导出到 Amazon CloudWatch Metrics / Logs 与 AWS X-Ray。v0.1 不采用独立第三方 Error Tracking SaaS；Pino structured logs、trace / correlation ID 与 CloudWatch alarm 是统一基线。

WP-0001 只预留 Observability Contract 与 Correlation ID，不要求完整 OpenTelemetry Backend。

Section 86 已锁定具体 SDK、Collector 与 AWS observability backend。首个跨 API、Database、Outbox、Worker 的集成 Increment 必须验证：

* Tracing SDK
* Metrics Export
* Error Tracking
* Dashboard / Alert Provider

完整 telemetry rollout 尚未发生，但任何 Runtime Work Package 都不得缺少 structured log 或 Health Check。

### 58.21 IDR-0015 — Job / Queue Runtime

Status：`Accepted`

Decision：v0.1 使用 PostgreSQL-backed pg-boss `12.26.0` 作为 Job Execution Runtime。版本已于 `2026-07-15` 通过 npm registry 核对；Eventing WP 必须验证 retry、dead letter、schedule、graceful shutdown、idempotency 与 outbox relay 后才能进入 production。

Validation Timing：Eventing Work Package 的 Definition of Ready；选择本身已接受。

v0.1 不提前引入独立 Streaming Platform。

首次 compatibility validation 必须证明：

* Transactional Outbox Polling / Relay
* Retry 与 Backoff
* Dead-letter / Failed Job 可见性
* Idempotent Consumer
* Scheduled Job
* Graceful Shutdown
* Local Development

Queue 产品不可改变 Domain Event Contract；Transactional Outbox / Inbox 继续使用 BOP 自有 Contract。

### 58.22 IDR-0016 — API Documentation

Status：`Accepted`

Decision：REST Contract 必须生成或维护 OpenAPI 文档；Event Contract 使用 version-controlled AsyncAPI 3.x 文档并生成 / 维护 Event Catalog。

Tooling Decision：Zod `4.4.3` 是 Runtime Contract Source；OpenAPI 使用 `@asteasolutions/zod-to-openapi` `9.0.0`；JSON Schema 使用 Zod 4 内建转换；AsyncAPI 3.x 文档使用 `@asyncapi/parser` `3.6.0` 与 `@asyncapi/cli` `6.0.2` 校验。Contract Tooling Work Package 不再重新选型；只有 compatibility validation 失败才进入 `Revisit Required`。

### 58.23 IDR-0017 — Branch and Merge Baseline

Status：`Accepted`

Decision：使用短生命周期 Feature Branch + Pull Request。

规则：

* Protected Main Branch
* 禁止直接 Push Main
* Required CI Checks
* staged governance 按 IDR-0012 / Section 86.4 执行；solo bootstrap 阶段保留 PR、CI 与 self-review checklist，但不声明不存在的独立 Reviewer
* 第二名授权人工 Reviewer 存在后至少一名独立 Reviewer；production enablement 前该控制必须启用
* Architecture / Security 高风险变更需要指定 Reviewer
* Squash 或 Rebase 策略由 Repository 设置统一，不允许团队成员自行混用

### 58.24 IDR-0018 — Dependency Update Strategy

Status：`Accepted`

规则：

* 自动工具只创建 PR，不自动合并 Major Update
* Major Update 必须有 Compatibility Review
* Security Patch 按风险加速处理
* Lockfile 与 Manifest 同时 Review
* 新 Runtime Dependency 必须说明用途、License、维护状态与替代方案

### 58.25 IDR-0019 — Provider Adapter Rule

Status：`Accepted`

Payment、Delivery、Notification、Storage、Map、Printer 等外部 Provider 必须通过 Adapter / Anti-corruption Layer 接入。

规则：

* Provider Payload 仅存在于 Adapter Boundary 与受控 Raw Evidence
* 核心 Domain 使用标准 Contract
* Webhook 必须签名验证、去重与审计
* Provider 切换不改写历史交易事实
* 每个 Provider 选择单独建立 IDR

### 58.26 IDR-0020 — Initial Provider Scope

Status：`Accepted`

Decision：v0.1 Provider Scope 按 Section 86 锁定：AWS Canada hosting、Stripe Canada payment、BOP-owned versioned Ontario tax engine、Amazon Cognito merchant authentication、Amazon S3 object storage、Amazon SES transactional email；SMS、Map、third-party Delivery、external Cache、external Search、BI Warehouse 与 vendor-specific Printer / POS SDK 不进入首个 Pilot。

Provider selection 已完成，不再保留并行候选：Stripe Canada / Terminal、AWS Canada、Cognito、S3 与 SES 是 v0.1 accepted baseline；Square、WeChat Pay、Alipay、third-party Delivery、SMS、external Cache / Search / BI Warehouse 与 vendor-specific POS / Printer SDK 均不进入首个 Pilot。对应 Provider Spike、contract、cost、residency、webhook、refund、sandbox 与 professional review 是 execution / live-enablement evidence；验证失败时进入 `Revisit Required`，不得静默替换 Provider。

### 58.27 IDR Register

当前 Accepted：

* IDR-0001 Package Manager
* IDR-0002 Workspace Orchestration
* IDR-0003 Runtime Baseline
* IDR-0004 Backend HTTP Framework
* IDR-0005 Frontend Baseline
* IDR-0006 Primary Database
* IDR-0007 ORM / Query Builder
* IDR-0008 Unit / Integration Test Runner
* IDR-0009 E2E Browser Testing
* IDR-0010 Contract Schema Source
* IDR-0011 Local Development Dependencies
* IDR-0012 CI Provider
* IDR-0013 Logging Baseline
* IDR-0014 Tracing and Metrics
* IDR-0015 Job / Queue Runtime
* IDR-0016 API Documentation Requirement
* IDR-0017 Branch and Merge Baseline
* IDR-0018 Dependency Update Strategy
* IDR-0019 Provider Adapter Rule
* IDR-0020 Initial Provider Scope
* IDR-0021 Frontend UI Foundation（canonical detail in Section 86）
* IDR-0022–0029 Provider / Deployment Records（canonical detail in Section 86）

当前 Under Review：

* None

当前 Proposed，且 Decision Timing 延期：

* None required before v0.1 implementation；future-trigger IDR must be created only when its trigger occurs

Register 不使用 `Accepted Direction`、`Accepted with Tool Pending` 或 `Deferred` 作为状态。方向、工具待选与延期时点必须记录在独立字段中。

### 58.28 Implementation Choice Gate for WP-0001

WP-0001 开始前必须锁定：

* Node.js Exact Major / Version File
* pnpm Version
* Turborepo Version
* TypeScript Version
* Lint / Formatter Tooling
* Unit Test Runner
* CI Provider（若 Repository Hosting 已确认）
* Minimal Logging Library

WP-0001 不需要锁定：

* ORM
* Payment Provider
* Delivery Provider
* Queue Product
* Object Storage Provider
* Full Observability Backend
* Production Hosting

### 58.29 IDR Change Process

更改 Accepted IDR 时：

1. 创建新 IDR 或新 Revision
2. 引用被替代 IDR
3. 说明触发原因
4. 评估 Migration、Contract、CI 与 Runtime 影响
5. 提供 Adoption / Rollback Plan
6. 完成 Reviewer Approval
7. 更新 IDR Register
8. 在相关 Work Package 中引用新版本

不得直接覆盖原 Decision History。

### 58.30 Implementation Decision Record Acceptance Criteria

必须证明：

1. 团队能区分 ADR 与 IDR
2. 每个高影响实现选择都有 Context、Alternative 与 Consequence
3. Accepted IDR 不违反 Architecture Freeze
4. Proposed IDR 不会被当作已锁定实现
5. Provider 选择不会污染核心 Domain
6. WP-0001 可以明确知道哪些选择必须先锁定
7. 替换工具或 Provider 时有 Revisit 与 Exit Strategy
8. AI 无权自行批准高影响 IDR
9. IDR History 不被覆盖
10. Implementation Choice 不再散落在聊天或代码注释中

### 58.31 Implementation Decision Record 状态

Implementation Decision Record v0.1 已完成并 Freeze。

已锁定：

* ADR 与 IDR 边界
* IDR 状态、结构、命名与 Review Gate
* IDR Ownership 与 Change Process
* WP-0001 前必须锁定的实现选择
* 已接受、待定与延期的首批 IDR Register
* Provider、CI、Testing、ORM、Observability 与 Queue 的决策入口

本阶段没有生成代码，也没有启动 WP-0001。

---

## 历史讨论节点 H-059（已完成）

Architecture、Engineering Blueprint、Initial Backlog、Master Development Playbook 与 Implementation Decision Record 已完成。

BOP-RMS Complete Handoff Package 当前可以作为：

**v1.0 Architecture and Engineering Baseline Candidate。**

进入正式 Baseline 前，下一步只完成：

**`WP-0001 — First Executable Work Package Specification`**

需要细化：

* Goal、Scope 与 Non-goals
* Required Accepted IDR
* Inputs 与 Constraints
* Deliverables 与 File-level Results
* Subtasks 与 Execution Order
* CI / Test / Architecture Gates
* Acceptance Scenario
* Risk、Rollback 与 Failure Handling
* Reviewer Checklist
* Standard AI Implementation Prompt
* Handoff Template

继续遵循：

* 暂不生成代码
* 不启动 Repository
* 只完成施工规格
* 用户明确授权后才执行 WP-0001

---

## 60. Merchant Information Architecture and Core Screen Specification

### 60.1 目的与范围

本阶段定义 Merchant 后台的 Information Architecture、Screen Catalog、Data Grid、Search、Filter、Action、Form Field 与 Query Projection 要求。

本阶段不生成 UI 代码，不决定具体视觉样式，不替代 Domain、Database 或 API Contract。

核心原则：

* Screen 只展示和操作其 Owning Module 公开的 Command、Query 与 Projection
* UI Field 不等于 Domain Field；敏感、内部或无操作意义字段不得直接暴露
* Search、Filter、Sort、Pagination 与 Export 必须拥有明确 Query Contract
* 表格列、筛选条件和批量操作必须考虑 Permission、Tenant Scope 与 Store Scope
* Customer-facing、Merchant-facing 与 Platform Admin Screen 分开定义
* Configuration Screen 与 Transaction Screen 的交互模式分开
* 历史交易页面不得通过编辑表单改写已发生事实
* UI 不复制后端业务规则；前端校验只用于即时反馈，最终规则由 Application Layer 执行

### 60.2 Screen Specification 分层

每个 Screen 使用三层规格：

1. `Screen Catalog`
   * Screen ID
   * Navigation Group
   * Owning Module
   * Persona
   * Permission
   * Route Intent
   * Screen Type

2. `Screen Specification`
   * Header、Summary、Tabs、Fields、Table Columns、Forms、Actions
   * Empty、Loading、Error、Permission Denied 与 Partial Data State
   * Mobile / Tablet / Desktop Priority

3. `List Query Contract`
   * Search Fields
   * Filters
   * Sorts
   * Pagination
   * Saved View
   * Column Preference
   * Export
   * Bulk Action
   * Projection Freshness

### 60.3 Merchant Navigation Information Architecture

第一版 Merchant Navigation：

* Home
  * Operations Overview
  * Alerts and Tasks
* Orders
  * Orders
  * Payments
  * Refunds
* Kitchen
  * Kitchen Board
  * Production History
  * Exceptions
* Catalog
  * Products
  * SKUs
  * Categories
  * Option Sets
  * Menus
  * Availability
* Inventory
  * Stock Overview
  * Inventory Items
  * Stock Movements
  * Stock Counts
  * Adjustments
  * Waste
  * Transfers
* Fulfillment
  * Pickup
  * Delivery
  * Exceptions
* Customers
  * Customers
  * Loyalty
* Store
  * Store Profile
  * Hours
  * Tax and Pricing
  * Devices
  * Fulfillment Settings
* Team and Access
  * Users
  * Roles
  * Assignments
* Reports
  * Operational Reports
  * Sales
  * Inventory
  * Kitchen
* Compliance
  * Cases
  * Inspections
  * Temperature
  * Corrective Actions
* Settings
  * Brand Settings
  * Feature Flags
  * Integrations
  * Audit

Navigation visibility由 Permission、Feature Flag、Store Capability 与 Tenant Scope共同决定。

### 60.4 通用 Data Grid 规范

所有 Merchant Data Grid 默认支持：

* Server-side Pagination
* Server-side Filter 与 Sort
* URL Query State
* Clear All Filters
* Active Filter Count
* Loading Skeleton
* Empty State
* No Result State
* Error State 与 Retry
* Column Visibility Preference
* Column Order Preference
* Default View Reset
* Density Preference
* Row Selection（仅存在 Bulk Action 时）
* Export Request（按权限）
* Saved View（后续 Phase 可开启）

默认分页：25 行；允许 25、50、100。超过 100 必须使用 Export 或专门查询。

禁止：

* 前端下载全量数据后自行分页或筛选
* 将 Search 当作任意跨 Module 全局数据库查询
* 未授权用户通过隐藏列仍取得敏感字段
* 导出绕过普通列表权限或 Tenant Scope

### 60.5 通用 Column Metadata

每个 Column 记录：

* Field Key
* Display Label
* Source Projection
* Default Visible
* Optional
* Sortable
* Searchable
* Filterable
* Exportable
* Sensitive Classification
* Required Permission
* Desktop Priority
* Tablet Priority
* Mobile Priority
* Format
* Null Display
* Tooltip / Definition

### 60.6 通用 Search Contract

每个 Screen 必须明确：

* Search Scope
* Searchable Fields
* Exact / Prefix / Partial Match
* Case Sensitivity
* Accent / Locale Handling
* Minimum Characters
* Debounce
* Archived Record Inclusion
* Store / Brand Boundary
* Result Ranking
* Search Audit Requirement

第一版普通列表 Search：

* 最少 2 个字符；Barcode、Order Number、SKU Code 等 Exact Identifier 允许 1 个字符起搜
* 默认 300ms Debounce
* Case-insensitive
* Identifier Exact / Prefix Match 优先于 Name Partial Match
* 默认不包含 Archived，除非 Filter 明确开启
* Search Query 长度、特殊字符和频率受限

### 60.7 通用 Filter Contract

每个 Filter 记录：

* Filter Key
* Label
* Type：Single、Multi、Boolean、Range、Date Range、Entity Picker
* Source
* Default
* Allowed Values
* Dependent Filter
* URL Serialization
* Clearable
* Permission
* Performance Constraint

常见跨 Screen Filter：

* Brand / Store Scope
* Status
* Active / Archived
* Created Date
* Updated Date
* Updated By

Brand 级用户可以切换 Store；Store 级用户不得通过 Query 参数扩大 Scope。

### 60.8 通用 Action Contract

每个 Action 记录：

* Action Key
* Display Label
* Command Contract
* Required Permission
* Single / Bulk
* Enabled Condition
* Disabled Reason
* Confirmation
* Reason Required
* Audit Requirement
* Idempotency Requirement
* Success Feedback
* Failure Recovery

危险 Action，例如 Archive、Delete、Void、Refund、Stock Adjustment、Role Change，必须有确认、权限、Audit，并按规则要求 Reason。

### 60.9 Screen CAT-PRODUCT-LIST — Products

Owning Module：Catalog。

Persona：Owner、Manager、Catalog Editor、Read-only Analyst。

Permission：`catalog.product.read`；写操作使用对应 create / update / publish / archive 权限。

默认 Columns：

* Product Name
* Internal Code
* Category
* Product Type
* Status
* Sellable Status
* Active SKU Count
* Assigned Menu Count
* Store Coverage
* Tax Category
* Updated At
* Updated By

可选 Columns：

* Product ID
* Default Language Name
* Secondary Language Name
* Media Status
* Option Set Count
* Availability Rule Count
* Created At
* Created By
* Archive Reason

Search：

* Product Name
* Alternate Language Name
* Internal Code
* SKU Name
* SKU Code
* Barcode
* External Reference

Filters：

* Status：Draft、Active、Suspended、Discontinued、Archived
* Product Type
* Category
* Has Active SKU
* Sellable Status
* Assigned Menu
* Store Coverage
* Tax Category
* Missing Image
* Missing Translation
* Updated Date
* Archived

Sort：Product Name、Internal Code、Status、Updated At、Created At。

Row Actions：View、Edit、Duplicate、Publish、Suspend、Resume、Discontinue、Archive、Restore、Manage SKUs、Assign Menu。

Bulk Actions：Assign Category、Assign Menu、Change Tax Category、Suspend、Archive、Export；Publish 不默认支持无差别批量执行。

### 60.10 Screen CAT-PRODUCT-DETAIL — Product Detail / Editor

Tabs：

* General
* Translations
* Media
* SKUs
* Options
* Menus
* Availability
* Tax
* Store Overrides
* History

General Fields：

* Product Name（必填）
* Internal Code（必填、Brand 内唯一）
* Product Type（必填）
* Category
* Description
* Short Description
* Preparation Notes Default
* Tax Category
* Status
* Tags

规则：已进入交易的 Product Identity 不删除；修改名称、选项、税或价格只影响新版本和新交易。

### 60.11 Screen CAT-SKU-LIST — SKUs

默认 Columns：

* SKU Name
* SKU Code
* Parent Product
* Variant Summary
* Barcode
* Status
* Sellable Status
* Base Price Reference
* Inventory Tracking
* Replacement Status
* Store Coverage
* Updated At

Search：SKU Name、SKU Code、Product Name、Barcode、External Reference。

Filters：Status、Product、Category、Variant、Inventory Tracked、Replacement Relationship、Store、Price Missing、Archived。

Actions：View、Edit、Duplicate、Activate、Suspend、Archive、Create Replacement Relationship。

### 60.12 Screen CAT-MENU-LIST — Menus

默认 Columns：Menu Name、Channel、Store Scope、Status、Published Version、Effective Period、Category Count、Sellable Count、Last Published At、Updated At。

Search：Menu Name、Internal Code、Published Version Reference。

Filters：Status、Channel、Store、Effective Now、Scheduled、Has Unpublished Changes、Archived。

Actions：Create、Edit、Preview、Validate、Publish、Schedule、Rollback to Published Version、Archive。

### 60.13 Screen INV-STOCK-OVERVIEW — Stock Overview

Owning Module：Inventory。

默认 Columns：

* Inventory Item Name
* Internal Code
* Store
* Storage Location
* Unit of Measure
* On Hand Quantity
* Reserved Quantity
* Available Quantity
* Reorder Point
* Stock Status
* Count Status
* Expiry Risk
* Last Movement At
* Last Count At

Search：Item Name、Internal Code、Barcode、Supplier Item Code、Storage Location。

Filters：

* Store
* Stock Status：Healthy、Low、Out、Negative、Unknown
* Below Reorder Point
* Storage Location
* Category
* Supplier
* Count Required
* Expiring Soon
* Has Reservation
* Negative Inventory
* Active / Archived

Sort：Item Name、Available Quantity、Stock Status、Last Movement At、Last Count At、Expiry Date。

Actions：View Item、View Movements、Start Count、Create Adjustment、Record Waste、Transfer Stock、Set Reorder Point。

Bulk Actions：Start Count、Export；批量 Adjustment 默认禁止。

### 60.14 Screen INV-ITEM-LIST — Inventory Items

默认 Columns：

* Inventory Item Name
* Internal Code
* Category
* Base Unit
* Tracking Method
* Current Store Count
* Primary Supplier
* Reorder Policy
* Expiry Tracking
* Status
* Updated At

可选 Columns：Barcode、Yield / Conversion Rule、Recipe Usage Count、Last Purchase Cost、Created At、Updated By。

Search：Item Name、Internal Code、Barcode、Supplier Item Code。

Filters：Status、Category、Base Unit、Tracking Method、Supplier、Used in Recipe、Expiry Tracking、Store Coverage、Missing Reorder Rule、Archived。

Actions：Create、View、Edit、Assign Supplier、Assign Store、Configure Conversion、Archive、Restore。

### 60.15 Screen INV-MOVEMENT-LIST — Stock Movements

这是 Append-only Transaction Screen。

默认 Columns：Occurred At、Store、Inventory Item、Movement Type、Quantity Delta、Unit、Balance After、Source Type、Source Reference、Reason Code、Performed By。

Search：Item Name、Internal Code、Source Reference、Movement ID。

Filters：Store、Movement Type、Item、Category、Date Range、Source Type、Reason Code、Performed By、Positive / Negative Delta。

Actions：View Evidence、View Source、Create Correction / Compensating Action（按权限）。

禁止直接 Edit 或 Delete Movement。

### 60.16 Screen INV-COUNT-LIST — Stock Counts

默认 Columns：Count Number、Store、Location、Scope、Status、Expected Item Count、Counted Item Count、Variance Count、Assigned To、Started At、Completed At、Approved By。

Search：Count Number、Location、Assigned User。

Filters：Store、Status、Location、Assigned To、Has Variance、Date Range、Approval Required。

Actions：Create Count、Assign、Start、Continue、Submit、Approve、Reject、Cancel、View Variance。

### 60.17 Screen ORD-ORDER-LIST — Orders

默认 Columns：Order Number、Created At、Store、Channel、Fulfillment Type、Customer / Guest、Item Count、Total、Payment Status、Order Status、Kitchen Status、Fulfillment Status。

Search：Order Number、Customer Name、Phone Suffix、Payment Reference、Table / Pickup Code。

Filters：Store、Channel、Fulfillment Type、Order Status、Payment Status、Kitchen Status、Fulfillment Status、Created Date、Scheduled Time、Has Exception、Refunded、Cancelled。

Actions：View、Print / Reprint、Cancel（条件允许时）、Start Refund、Resend Notification、Open Exception。

历史 Order 不通过通用 Edit Form 修改；允许的变化必须执行明确 Command / Amendment。

### 60.18 Screen KIT-KITCHEN-BOARD — Kitchen Board

不是传统 Data Grid，而是实时 Operational Board。

Card Fields：Order Number、Elapsed Time、Promise Time、Channel、Fulfillment Type、Item / Course、Modifiers、Allergen Indicator、Station、Priority、Current Status、Exception。

Filters：Station、Status、Channel、Priority、Allergen、Late / At Risk、Course、Store。

Search：Order Number、Item Name。

Actions：Accept、Start、Ready、Hold、Resume、Mark Exception、Recall；每个动作受状态机和权限控制。

Realtime Message 只推动刷新；最终状态必须从 Query / Projection 校验。

### 60.19 Screen PAY-PAYMENT-LIST — Payments

默认 Columns：Payment Reference、Order Number、Created At、Store、Method、Provider、Amount、Currency、Status、Captured Amount、Refunded Amount、Last Provider Update。

Search：Payment Reference、Order Number、Provider Reference、Customer Receipt Reference。

Filters：Store、Method、Provider、Status、Date Range、Has Refund、Reconciliation Status、Exception。

Actions：View、Capture（适用时）、Cancel / Void（适用时）、Start Refund、Reconcile、View Provider Evidence。

完整卡号、CVV、Secret 与非必要 Provider Payload 永不显示。

### 60.20 Screen STORE-PROFILE — Store Configuration

Sections：Identity、Address、Time Zone、Business Date、Contact、Locale、Currency、Channels、Hours、Tax、Fulfillment、Kitchen、Devices、Notifications。

每个 Section 显示：Effective Value、Source Level、Override Status、Draft / Published Version、Last Updated。

Search 不适用；复杂配置使用 Section Navigation。

Actions：Edit Draft、Validate、Publish、Schedule、Discard Draft、View Effective Configuration、View History。

### 60.21 Screen IAM-USER-LIST — Users and Access

默认 Columns：Display Name、Email / Login Identifier、Membership Status、Brand Role、Store Assignment Count、MFA Status、Last Active At、Updated At。

Search：Name、Email、Employee / External Reference。

Filters：Membership Status、Role、Store Assignment、MFA Enabled、Invited / Active / Suspended、Last Active Date。

Actions：Invite、View、Change Role、Assign Store、Suspend Membership、Revoke Session、Resend Invite。

Identity Credential 与业务 Membership 分开操作。

### 60.22 Screen IAM-ROLE-LIST — Roles

默认 Columns：Role Name、Scope、Type、Permission Count、Assigned User Count、Status、Updated At。

Search：Role Name、Description、Permission Key。

Filters：Scope、System / Custom、Status、Store / Brand Applicability。

Actions：Create、View、Edit、Duplicate、Deactivate、Compare Permissions。

高风险 Permission 变化必须显示影响用户数量并要求确认。

### 60.23 Detail、Create 与 Edit Form Field Registry

除 Screen Specification 外，建立 `Field Registry`，每个输入字段保存：

* Field Key
* Business Meaning
* Owning Module
* Data Type
* Required / Optional / Conditional
* Default
* Read-only Condition
* Validation
* Normalization
* Permission
* PII Classification
* Localization
* Help Text
* Error Code Mapping
* API Contract Field
* Persistence Owner

Field Registry 不允许成为跨 Domain Shared Entity；它只是产品与 Contract 对照文档。

### 60.24 Query Projection Requirement

每个列表页面在实现前必须声明 Projection：

* Projection Name
* Owning Query Module
* Source Events / Tables
* Freshness Target
* Search Index Fields
* Filter Index Fields
* Sort Index Fields
* Tenant Scope
* PII Fields
* Rebuild Strategy
* Export Strategy

页面不能因为缺少 Projection 而直接跨 Module Join 私有业务表。

### 60.25 Screen State 规范

所有核心 Screen 必须定义：

* First Load
* Loading
* Refreshing
* Empty
* No Search Result
* Permission Denied
* Partial Data
* Stale Projection
* Offline / Network Failure
* Command Pending
* Command Success
* Validation Failure
* Concurrency Conflict
* Provider Failure

Concurrency Conflict 必须提示数据已变化并要求刷新，不静默覆盖。

### 60.26 Saved View 与 User Preference

第一版 Column Visibility 与 Density 可以保存为用户偏好。

Saved View 完整能力可延期，但 Contract 应预留：

* View Name
* Screen ID
* Filters
* Sort
* Columns
* Scope
* Owner
* Shared Visibility

用户偏好不能改变权限，也不能保存其无权再次访问的敏感 Filter 值。

### 60.27 Export 规范

Export 必须：

* 使用与列表相同的 Tenant、Permission 与 Filter
* 记录 Export Request、Requester、Scope、Row Count 与 Completion
* 大数据量使用异步 Job
* 对 PII 与财务字段进行字段级授权
* 限制文件有效期
* 支持审计和撤销访问

### 60.28 UI Specification Governance

任何新增核心 Merchant Screen 必须同时完成：

1. Screen Catalog Entry
2. Permission Mapping
3. Field / Column Registry
4. Search / Filter / Sort Contract
5. Query Projection Requirement
6. Actions 与 Command Mapping
7. State / Error Handling
8. Analytics Event（如需要）
9. Accessibility Requirement
10. Acceptance Scenario

### 60.29 第一轮 Screen Specification 范围状态（Historical；completed by Section 88）

本轮已覆盖：

* Products
* Product Detail
* SKUs
* Menus
* Stock Overview
* Inventory Items
* Stock Movements
* Stock Counts
* Orders
* Kitchen Board
* Payments
* Store Configuration
* Users
* Roles

本 Section 当时延期的下列页面，现已由 Section 88 在写代码前完成；不得再解释为实现期设计项：

* Category / Option Set Detail
* Menu Builder
* Recipe
* Procurement / Supplier
* Delivery Operations
* Customer / Loyalty
* Reporting
* Compliance
* Device Fleet
* Promotion

其权威 Screen ID、Route、fields / views、Search / Filter、Actions、Permissions、States、Projection 与 Work Package mapping 见 Section 88。

### 60.30 Merchant IA and Core Screen Specification 状态

Merchant Information Architecture and Core Screen Specification v0.1 已完成并阶段性 Freeze。

已锁定：

* Merchant Navigation Information Architecture
* Screen Catalog、Screen Specification 与 List Query Contract 分层
* Data Grid、Column、Search、Filter、Action、Export 与 Saved View 通用规则
* 核心 Catalog、Inventory、Order、Kitchen、Payment、Store 与 Access Screen
* Field Registry 与 Query Projection Requirement
* Screen State 与 UI Governance

本阶段没有生成 UI 或业务代码。

---

---

## 61. Merchant UX / Screen Pattern Architecture

### 61.1 目的与层级

Merchant UX / Screen Pattern Architecture 负责建立可复用的后台产品设计语言，使业务页面不以单页方式各自设计，而是由统一的 UX Foundation、Screen Family、Pattern、Business Screen Instance 与 Field / Query Contract 组合形成。

层级固定为：

`UX Foundation`

→ `Screen Pattern Library`

→ `Business Screen Instance`

→ `Field / Column Registry`

→ `Query / Command Contract`

→ `Projection / Database Ownership`

→ `Domain Rule`

核心规则：

* Pattern 统一交互结构，但不拥有业务事实
* Business Screen 声明使用哪些 Pattern，以及覆盖哪些业务差异
* Field Registry 负责字段语义与 Contract 对照，不取代 Domain Model
* Screen 不得为了复用而绕过 Owning Module、Permission 或 Tenant Scope
* Pattern 的一致性不能降低高风险业务操作的确认、Audit 与 Reason 要求
* Customer、Merchant、Platform Admin 可以共享基础 Component，但 Screen Pattern 与权限语义分别定义

### 61.2 UX Foundation

UX Foundation 第一版必须定义：

* Layout Grid、Spacing Scale 与 Density
* Typography Hierarchy
* Color Token、Status Token 与 Semantic Feedback
* Icon、Badge、Avatar、Thumbnail 与 Empty Illustration 使用规则
* Focus、Hover、Selected、Disabled、Read-only 与 Destructive State
* Responsive Breakpoint 与 Desktop / Tablet / Mobile Priority
* Keyboard Navigation、Screen Reader、Contrast 与 Reduced Motion
* Loading、Skeleton、Progress、Optimistic Feedback 与 Long-running Job Feedback
* Modal、Drawer、Popover、Toast、Inline Alert 与 Full-page Error 的选择规则
* Date、Time、Money、Quantity、Unit、Address 与 Localization 显示格式

UX Foundation 只定义产品行为和 Token 语义；具体视觉值、组件库和 Figma Token 在对应 UI Implementation IDR 中锁定。

### 61.3 Screen Family Catalog

第一版建立八个核心 Screen Family：

1. `Master Data`
   * Product、SKU、Inventory Item、Supplier、Customer、User、Device
   * 支持 List、Detail、Create / Edit、Archive、Import / Export

2. `Configuration and Publishing`
   * Menu、Pricing、Tax、Store Settings、Permission、Workflow、Promotion
   * 支持 Draft、Validation、Preview、Publish、Version、Effective Period、Rollback

3. `Transaction Explorer`
   * Order、Payment、Refund、Stock Movement、Delivery、Audit
   * 强调不可改写事实、Timeline、Correction / Compensation 与 Export

4. `Operational Workbench`
   * Kitchen、Pickup、Delivery、Task、Approval、Compliance Queue
   * 强调实时状态、优先级、SLA、批量动作、异常与 Hand-off

5. `Dashboard and Monitoring`
   * Operations Overview、Sales、Inventory、Kitchen、Device Health
   * 强调 KPI、趋势、异常、Freshness、Drill-down 与 Alert

6. `Wizard and Guided Setup`
   * Store Onboarding、Product Setup、Menu Publish、Integration Setup、Stock Count
   * 强调 Step、Prerequisite、Draft、Resume、Validation Summary 与 Completion

7. `Lookup and Selection`
   * Product Picker、SKU Picker、Store Picker、Customer Picker、Supplier Picker
   * 强调搜索、Filter、Scope、最近使用、多选与权限裁剪

8. `Exception and Case Management`
   * Payment Exception、Delivery Exception、Compliance Case、Device Exception
   * 强调 Ownership、Evidence、Timeline、Corrective Action、Escalation 与 Closure

### 61.4 Pattern Composition Rule

一个 Business Screen 可以组合多个 Pattern，但必须声明一个 Primary Pattern。

例如：

* Product List = Master List + Bulk Action + Import / Export
* Product Detail = Master Detail + Related Records + Activity Timeline
* Menu Builder = Configuration Editor + Tree / Sort + Publish Workflow + Preview
* Stock Count = Guided Wizard + Editable Line Grid + Variance Review
* Kitchen Board = Operational Board + Realtime Update + Exception Drawer
* Order Detail = Transaction Detail + Timeline + Related Payment / Fulfillment

禁止：

* 为单一页面复制并修改 Pattern，而不登记 Variant
* 在 Pattern 内写死 Product、Inventory、Order 等业务字段
* 用视觉一致性掩盖不同权限或不可逆业务动作

### 61.5 Pattern 01 — Master List

结构：

* Page Header
* Scope Selector（如 Brand / Store）
* Primary Action
* Search Bar
* Quick Filters
* Advanced Filter Panel
* Saved View / View Preference
* Data Grid 或 Card List
* Bulk Action Bar
* Pagination / Infinite Result Boundary
* Export / Import Entry

标准行为：

* URL 保存 Search、Filter、Sort、Page 与 View State
* Search 与 Filter 改变后重置分页
* 无权限的 Column、Filter 与 Action 不渲染
* Selection 跨页默认不保留，除非进入明确的 Select-all-matching 模式
* Bulk Action 必须显示匹配数量、成功数量、失败数量和可下载结果
* Archive 默认不混入 Active 结果，需显式 Filter
* Row Click 与 Row Action 不得产生冲突

适用：Product、SKU、Inventory Item、Supplier、Customer、User、Device。

### 61.6 Pattern 02 — Master Detail

结构：

* Breadcrumb
* Identity Header
* Status / Scope / Warning Badge
* Primary and Secondary Actions
* Summary Panel
* Tabs / Sections
* Related Records
* Activity / Audit Timeline
* Attachment / Media Region

标准行为：

* Header 始终显示稳定身份、状态与 Owning Scope
* Edit 进入独立 Form、Drawer 或 Edit Mode，不在只读页面中隐式修改
* Unsaved Change 必须拦截导航
* Concurrency Conflict 不静默覆盖
* Related Records 使用公开 Query，不跨模块私有 Join
* Archive 后默认 Read-only，但可保留允许的 Restore / View History Action

### 61.7 Pattern 03 — Create / Edit Form

结构：

* Form Header
* Status / Draft Indicator
* Section Navigation
* Field Groups
* Inline Validation
* Validation Summary
* Sticky Action Footer
* Save Draft / Save / Publish 或 Submit

字段行为统一声明：

* Required、Optional、Conditional
* Default、Normalization、Read-only Condition
* Immediate Validation 与 Server Validation
* Dependency / Visibility Rule
* Permission 与 PII Classification
* Error Code 与 Help Text

规则：

* 前端验证提供即时反馈，后端仍为最终裁决者
* 高风险字段修改显示影响范围
* Draft 与 Published Configuration 分离
* 自动保存只用于明确支持 Draft 的页面
* 禁止表单提交后因 Provider 或网络超时产生重复 Command；必须使用 Idempotency

### 61.8 Pattern 04 — Configuration Editor and Publish Workflow

适用：Menu、Price、Tax、Promotion、Workflow、Permission、Store Configuration。

结构：

* Version Header
* Draft / Published / Scheduled 状态
* Configuration Canvas / Form
* Validation Panel
* Change Summary
* Preview
* Publish / Schedule / Rollback Actions
* Version History

规则：

* Edit 只修改 Draft
* Publish 前执行完整 Validation
* 显示影响 Store、Channel、Time Window 与依赖对象
* Publish 创建不可变 Version
* Rollback 创建新 Version，不覆盖历史 Version
* Preview 必须基于待发布 Snapshot，而不是当前 Published Projection

### 61.9 Pattern 05 — Transaction Explorer

适用：Order、Payment、Refund、Stock Movement、Delivery、Audit。

结构：

* Search and Advanced Filter
* Date / Business Date Range
* Status / Type / Channel Filter
* Transaction Grid
* Transaction Detail
* Timeline
* Related References
* Correction / Compensation Actions

规则：

* 历史事实不可直接编辑
* 修改通过 Action、Amendment、Correction、Refund、Reversal 或 Compensation 表达
* Date Range 默认有限范围，避免无界查询
* Export 遵循字段级权限与审计
* Detail 必须可追踪 Correlation、Actor、Version 与 Source Reference

### 61.10 Pattern 06 — Operational Board / Workbench

适用：Kitchen、Pickup、Delivery、Task、Approval、Exception Queue。

结构：

* Work Scope Header
* Realtime Connection / Freshness Indicator
* Lane / Queue / Group
* Work Card
* Priority / SLA Indicator
* Quick Action
* Batch Action
* Detail Drawer
* Exception / Escalation Region

规则：

* 拖拽只在业务允许的状态转换中启用
* 所有状态变化仍通过 Command 执行
* Realtime Message 只提示刷新或更新 Projection，不充当 Source of Truth
* 断线时明确显示 Stale / Offline，不伪装为实时
* Action Pending 必须防止重复操作
* 高风险批量操作要求确认和结果报告

### 61.11 Pattern 07 — Dashboard and Monitoring

结构：

* Scope and Time Selector
* Freshness / Certification Indicator
* KPI Cards
* Trend / Comparison
* Breakdown
* Alert / Exception Panel
* Drill-down Link
* Export / Scheduled Report

规则：

* Metric 显示 Definition、Version、Time Zone、Currency 与 Freshness
* Dashboard 不直接执行高风险业务修改
* Alert 可链接到对应 Operational Workbench 或 Transaction Detail
* 空数据、延迟数据和质量问题必须与真实零值区分

### 61.12 Pattern 08 — Lookup Picker

Picker Contract 包括：

* Entity Type
* Scope
* Searchable Fields
* Filter
* Single / Multi-select
* Selected Item Summary
* Disabled / Ineligible Reason
* Recently Used（可选）
* Create-in-context（可选且受权限控制）

规则：

* Picker 只返回稳定 Reference 与必要 Display Snapshot
* 不暴露私有 Entity 或 ORM Row
* Ineligible Item 可以显示但必须说明原因，或按业务要求隐藏
* 大结果集必须 Server-side Search 与 Pagination

### 61.13 Pattern 09 — Wizard and Guided Setup

结构：

* Step Indicator
* Prerequisite Check
* Step Form / Task
* Save and Resume
* Validation Summary
* Review
* Completion / Next Action

规则：

* Wizard Progress 不等于 Domain Transaction 状态
* 每个 Step 明确其持久化方式：Local Draft、Server Draft 或正式 Command
* 跳过 Step 必须符合业务规则
* 最终提交前重新验证所有关键条件

### 61.14 Pattern 10 — Exception / Case Management

结构：

* Case Header
* Severity / Status / Owner / Deadline
* Evidence
* Timeline
* Findings
* Actions / Corrective Actions
* Escalation
* Resolution / Closure

规则：

* Evidence、Finding 与历史 Action 追加保存
* Case 不能直接改写其他 Domain 的源事实
* 业务整改由 Owning Domain 执行，Case 引用执行结果
* Closure 需要满足 Resolution Criteria

### 61.15 Cross-pattern Component Registry

第一版需要统一以下复用 Component Contract：

* Page Header
* Scope Selector
* Status Badge
* Search Bar
* Filter Bar / Filter Drawer
* Data Grid
* Column Chooser
* Bulk Action Bar
* Entity Header
* Summary Card
* Timeline
* Related Record List
* Form Field
* Validation Summary
* Sticky Action Footer
* Version Banner
* Publish Panel
* Realtime Indicator
* Work Card
* KPI Card
* Empty / Error State
* Confirm / Reason Dialog
* Export Job Status
* Lookup Picker

每个 Component 必须定义：Purpose、Inputs、States、Accessibility、Permission Behavior、Responsive Behavior 与 Analytics Hook；不得内置业务 Module 依赖。

### 61.16 Pattern Variant Governance

允许的 Variant：

* Density：Comfortable / Compact
* Layout：Table / Card / Split View
* Detail：Full Page / Drawer
* Filter：Inline / Drawer
* Selection：Single / Multi
* Update：Manual Refresh / Realtime-assisted
* Form：Single Page / Sectioned / Wizard

新增 Variant 前必须证明：

* 现有 Pattern 无法合理覆盖
* 不只是视觉偏好差异
* 不会破坏 Accessibility 或 Permission
* 有至少两个合理复用场景，或属于明确高价值例外

### 61.17 Business Screen Mapping

第一轮映射：

* Products：Master List + Master Detail + Create / Edit Form
* SKUs：Master List + Master Detail + Create / Edit Form
* Categories / Option Sets：Master List + Master Detail + Configuration Editor
* Menus：Master List + Configuration Editor + Publish Workflow + Preview
* Inventory Items：Master List + Master Detail + Create / Edit Form
* Stock Overview：Dashboard / Monitoring + Transaction Drill-down
* Stock Movements：Transaction Explorer
* Stock Counts：Wizard + Editable Workbench + Variance Review
* Orders：Transaction Explorer + Transaction Detail
* Payments / Refunds：Transaction Explorer + Exception / Case
* Kitchen：Operational Board / Workbench
* Pickup / Delivery：Operational Board + Transaction Detail + Exception
* Customers：Master List + Master Detail
* Users / Roles：Master List + Master Detail + Configuration Editor
* Store Settings：Configuration Editor + Publish Workflow
* Devices：Master List + Master Detail + Monitoring
* Reports：Dashboard + Report Explorer
* Compliance：Exception / Case Management + Transaction Timeline

### 61.18 Pattern-to-Contract Traceability

每个 Business Screen Instance 必须声明：

* Screen ID
* Primary Pattern
* Secondary Patterns
* Owning Module
* Query Contract
* Command Contract
* Projection
* Field / Column Registry
* Permission
* Tenant / Store Scope
* Feature Flag
* Realtime Requirement
* Analytics Event
* Acceptance Scenario

Figma Frame、UI Story、Frontend Route、API Endpoint 与 Projection 必须引用同一 Screen ID。

### 61.19 Accessibility and Inclusive Operation

最低要求：

* 所有核心操作可键盘完成
* Focus 顺序与视觉顺序一致
* 状态不只依赖颜色表达
* Grid、Board 与 Drag Action 提供非拖拽替代方式
* Form Error 与字段关联
* Realtime 更新不强制抢占焦点
* 动画支持 Reduced Motion
* Touch Target 适合 Tablet 门店操作
* 中英文内容扩展不破坏布局
* 日期、金额、单位和时区表达清晰

### 61.20 Pattern Acceptance Criteria

必须证明：

1. Product、Inventory Item 与 Supplier 可以共享 Master Data Pattern，而不共享业务规则
2. Order、Payment 与 Stock Movement 可以共享 Transaction Explorer，而不允许直接编辑历史事实
3. Kitchen 与 Delivery Workbench 可以共享 Board 基础交互，但状态转换分别由各 Domain 控制
4. Menu Builder 使用 Configuration / Publish Pattern，而不是普通 Edit Form
5. Search、Filter、Sort 与 Export 均可追踪到 Query Contract 和 Projection
6. Component 不直接依赖业务 Module
7. Pattern Variant 有登记且不造成同类页面无理由分裂
8. 权限、Tenant Scope、Audit 和 Accessibility 在所有 Pattern 中一致执行
9. Figma、前端、API 与测试可通过 Screen ID 建立追踪
10. 新业务页面可以先选择 Pattern，再补充业务 Field 与 Action，而无需重新设计基础结构

### 61.21 Merchant UX / Screen Pattern Architecture 状态

Merchant UX / Screen Pattern Architecture v0.1 已完成并阶段性 Freeze。

已锁定：

* UX Foundation 层级与责任
* 八类核心 Screen Family
* 十个核心 Screen Pattern
* Cross-pattern Component Registry
* Pattern Composition 与 Variant Governance
* Business Screen Mapping
* Pattern-to-Contract Traceability
* Accessibility 与 Acceptance Criteria

本阶段不决定具体视觉稿、组件库品牌或 CSS 实现，也没有生成 UI / 业务代码。

---

## 历史讨论节点 H-062（已完成）

Architecture、Engineering Blueprint、Initial Backlog、Master Development Playbook、Implementation Decision Record、Merchant Information Architecture，以及 Merchant UX / Screen Pattern Architecture 已完成。

BOP-RMS Complete Handoff Package 当前仍为：

**v1.0 Architecture and Engineering Baseline Candidate。**

下一步进入：

**Core Screen Specification Expansion — Master Data Screen Family。**

首先细化：

* Product Create / Edit Field Registry 与 Validation Matrix
* SKU Create / Edit、Variant、Option 与 Replacement Interaction
* Inventory Item Create / Edit、Unit、Tracking 与 Reorder Rules
* Master Data List / Detail 对应的 Search、Filter、Sort、Projection 与 API 字段
* Category、Option Set 与 Lookup Picker Contract

继续遵循：

* 暂不生成代码
* 不启动 Repository
* 一次完成一个 Screen Family
* Pattern 先行，业务 Screen 只声明差异
* 完成核心 Screen Family 后，再回到 WP-0001 Specification

---

## 63. Business Object Registry

### 63.1 目的与定位

Business Object Registry 是 BOP-RMS 产品层的统一对象目录，位于 Domain Model 与具体 Screen Specification 之间。

固定层级：

`Domain / Aggregate`

→ `Business Object Registry`

→ `Screen Family / Pattern`

→ `Business Screen Matrix`

→ `Field / Column Registry`

→ `Query / Command Contract`

→ `Projection / Database Ownership`

→ `Work Package / Code`

Registry 不取代 Domain Model、Database Schema 或 API Contract。它负责回答：系统有哪些稳定业务对象、对象由谁拥有、通过哪些页面和工作流呈现、哪些查询与权限围绕该对象建立。

### 63.2 核心规则

* 每个可被用户独立识别、查询、操作、审计或引用的稳定业务概念，必须先登记为 Business Object
* Business Object 可以对应 Aggregate Root、Entity、Append-only Record、Case、Configuration、Projection 或 Platform Resource
* 不是每个数据库表都成为 Business Object
* UI-only State、Provider Payload、临时 DTO、Join Result 与纯技术记录不得登记为 Business Object
* 每个 Object 只有一个 Owning Module 与一个 Write Owner
* 一个 Object 可以拥有多个 Screen，但 Screen 不改变对象的数据所有权
* 跨 Module 展示通过 Projection、Read Contract 或 Event 建立，不得借 Registry 合并 Domain Boundary
* Object 的状态、权限、审计、Retention 与 PII 分类必须可追踪
* 新增对象必须先登记，再展开 Screen、Field、API、Projection 与 Work Package

### 63.3 Registry Entry 标准字段

每个 Business Object Entry 至少包含：

* Object ID
* Object Name
* Business Meaning
* Object Classification
* Owning Layer：BOP / RMS
* Owning Module
* Write Owner
* Aggregate / Source of Truth
* Tenant Scope
* Store Scope
* Parent / Child Relationship
* Lifecycle / Status Model
* Primary Identifier
* Human-readable Identifier
* Screen Family
* Primary Screen Pattern
* Primary Screens
* Secondary Screens
* Workflow / Publish / Approval Requirement
* Permission Namespace
* Audit Requirement
* PII Classification
* Retention Category
* Import Support
* Export Support
* Search Requirement
* Projection Requirement
* API / Event Contract Reference
* Feature Flag / Capability Dependency
* Phase / Milestone
* Registry Status
* Notes / Open Decision

### 63.4 Object Classification

第一版分类：

1. `Master Data`
   * Product、SKU、Category、Option Set、Inventory Item、Supplier、Customer、User、Device
2. `Configuration`
   * Menu、Availability Rule、Pricing Rule、Tax Rule、Store Configuration、Role、Workflow、Feature Flag
3. `Transaction`
   * Cart、Quote、Order、Payment、Refund、Stock Movement、Purchase Order、Fulfillment
4. `Operational Work`
   * Kitchen Ticket、Pickup Handoff Record、Delivery Task、Output Job、Stock Count
5. `Case / Exception`
   * Compliance Case、Payment Exception、Delivery Exception、Device Exception、Corrective Action
6. `Relationship`
   * Membership、Store Assignment、Product Option Binding、Supplier Item Mapping、Sellable Placement
7. `Append-only Record`
   * Audit Entry、Ledger Entry、Temperature Record、Proof、Revision、Attempt
8. `Projection / Analytical Object`
   * Stock Overview、Order Search View、Kitchen Queue View、Metric Definition、Report

Classification 只描述产品和数据行为，不改变 Domain Aggregate 边界。

### 63.5 Object ID 与命名规范

Object ID 使用稳定、不可复用的机器标识：

`BOP-<MODULE>-<OBJECT>` 或 `RMS-<MODULE>-<OBJECT>`

示例：

* `RMS-CAT-PRODUCT`
* `RMS-CAT-SKU`
* `RMS-INV-INVENTORY-ITEM`
* `RMS-ORD-ORDER`
* `RMS-PAY-PAYMENT`
* `BOP-IAM-USER`
* `BOP-PERM-ROLE`

规则：

* Object ID 不包含版本号
* 改名不更换 Object ID
* Object 被替代时保留原 Entry，并标记 `Deprecated / Replaced`
* 不允许删除已被 Contract、Screen、Event 或历史数据引用的 Object ID

### 63.6 Registry Status

状态：

* `Proposed`
* `Active`
* `Deprecated`
* `Replaced`
* `Retired`

`Active` 前必须确认 Owning Module、Source of Truth、Permission、Tenant Scope 与至少一个使用场景。

### 63.7 Screen Matrix Contract

每个 Active Business Object 必须维护 Screen Matrix：

* List / Explorer
* Detail
* Create
* Edit
* Duplicate / Clone
* Archive / Deactivate
* Restore / Reactivate
* History / Timeline
* Audit
* Import
* Export
* Compare
* Related Object Picker
* Workflow / Approval
* Operational Action

不适用的 Screen 必须显式标记 `Not Applicable`，不能因遗漏而保持不确定。

Screen Matrix 每项保存：

* Screen ID
* Pattern ID
* Route Intent
* Persona
* Permission
* Action / Query Contract
* Projection
* Phase
* Status

### 63.8 Product Object Entry

Object ID：`RMS-CAT-PRODUCT`

* Object Name：Product
* Classification：Master Data
* Owning Module：Catalog
* Source of Truth：Product Aggregate
* Tenant Scope：Brand
* Optional Store Scope：通过 Availability / Assignment 表达
* Lifecycle：Draft、Active、Suspended、Discontinued、Archived
* Screen Family：Master Data
* Patterns：Master List、Master Detail、Create / Edit Form、History Timeline、Lookup Picker
* Primary Screens：Product List、Product Detail、Create Product、Edit Product
* Secondary Screens：Duplicate、Archive、Restore、History、Menu Assignment、Store Availability
* Permission Namespace：`catalog.product.*`
* Search：Name、Internal Code、SKU Name、SKU Code、Barcode、External Reference
* Projection：Product Search Projection
* Import / Export：支持，字段级权限与 Validation Required
* Audit：Create、Edit、Publish、Archive、Restore、Assignment Change
* PII：None
* Retention：Configuration History

### 63.9 SKU Object Entry

Object ID：`RMS-CAT-SKU`

* Classification：Master Data
* Owning Module：Catalog
* Source of Truth：Product Aggregate 内的 Product-owned SKU Entity Boundary
* Parent Object：Product
* Lifecycle：Draft、Active、Suspended、Discontinued、Archived
* Replacement Status：None、Scheduled、Effective、Cancelled、Voided；不与 SKU Lifecycle 混用
* Screen Family：Master Data
* Primary Screens：SKU List、SKU Detail、Create SKU、Edit SKU
* Secondary Screens：Variant Matrix、Replacement Relationship、Barcode Management、Availability、History
* Permission Namespace：`catalog.sku.*`
* Search：SKU Name、SKU Code、Barcode、Product Name、External Reference
* Projection：SKU Search Projection
* Audit：Variant、Barcode、Replacement、Status 与 Assignment Change

### 63.10 Inventory Item Object Entry

Object ID：`RMS-INV-INVENTORY-ITEM`

* Classification：Master Data
* Owning Module：Inventory
* Source of Truth：Inventory Item Aggregate
* Tenant Scope：Brand / Store Policy
* Lifecycle：Active、Inactive、Archived
* Screen Family：Master Data
* Primary Screens：Inventory Item List、Inventory Item Detail、Create、Edit
* Secondary Screens：Stock History、Reorder Settings、Supplier Mapping、Count、Adjustment、Transfer、Waste
* Permission Namespace：`inventory.item.*`
* Search：Name、Internal Code、Barcode、Supplier Item Code
* Projection：Inventory Item Search Projection、Stock Overview Projection
* Import / Export：支持
* Audit：Unit、Tracking、Reorder、Supplier Mapping、Archive

### 63.11 第一版 Registry Catalog

第一轮必须登记以下对象：

Catalog：

* Product
* SKU
* Category
* Option Set
* Option
* Menu
* Menu Section
* Sellable Placement
* Availability Rule
* Bundle

Recipe：

* Recipe
* Recipe Version
* Ingredient Usage

Inventory / Procurement：

* Inventory Item
* Stock Balance
* Stock Movement
* Stock Count
* Inventory Adjustment
* Waste Record
* Transfer
* Supplier
* Supplier Item Mapping
* Purchase Order
* Goods Receipt

Ordering / Payment：

* Cart
* Quote
* Order
* Order Item Snapshot
* Order Amendment
* Payment
* Payment Attempt
* Refund
* Payment Exception

Kitchen / Fulfillment：

* Kitchen Ticket
* Kitchen Item
* Production Batch
* Pickup Handoff Record（Fulfillment Aggregate 内部 Append-only Record，不是 Aggregate Root）
* Delivery Task
* Fulfillment
* Delivery Exception
* Delivery Proof

Store / Platform：

* Brand
* Store
* Operating Entity
* User
* Membership
* Store Assignment
* Role
* Permission Grant
* Device
* Output Job
* Feature Flag

Customer / Compliance / BI：

* Customer
* Loyalty Account
* Compliance Case
* Inspection
* Corrective Action
* Temperature Record
* Metric Definition
* Report

### 63.12 Object Relationship Registry

Business Object Registry 同时维护对象关系，但不把关系自动实现为数据库 Foreign Key。

关系类型：

* Owns
* Contains
* References
* Assigned To
* Replaces
* Derived From
* Produces
* Consumes
* Governed By
* Displayed Through Projection

每条关系保存：

* Source Object ID
* Relationship Type
* Target Object ID
* Owning Module
* Cardinality
* Required / Optional
* Historical Snapshot Requirement
* Cross-module Contract
* Mutation Owner

### 63.13 Search 与 Projection Registry

每个声明支持搜索的 Object 必须登记：

* Search Profile ID
* Searchable Fields
* Exact / Prefix / Partial Match
* Normalization
* Language / Localization
* Tenant / Store Scope
* Archived Inclusion Rule
* Permission-trimmed Fields
* Projection Name
* Freshness Target
* Rebuild Strategy
* API Query Reference

Registry 不直接规定索引产品，但必须让后续 PostgreSQL、Search Engine 或 Projection 实现具备同一 Contract。

### 63.14 Permission 与 Action Registry

每个 Object 必须声明标准 Action：

* Read
* Create
* Update
* Archive / Deactivate
* Restore
* Export
* Import
* Bulk Update
* Publish
* Approve
* Execute Operational Action
* View Audit / Sensitive Field

权限使用 Object Namespace，但最终授权仍由 Permission Domain 决定。

### 63.15 Retention、PII 与 Audit Registry

每个 Object 必须登记：

* Retention Category
* Legal / Compliance Hold Applicability
* PII Classification
* Sensitive Field Set
* Audit Event Set
* Export Restriction
* Redaction / Anonymization Rule
* Historical Snapshot Requirement

Transaction、Ledger、Proof、Audit 与 Compliance Record 不得因 Master Data Archive 而删除。

### 63.16 Registry 与 Screen Pattern 的关系

固定规则：

* Registry 决定“对象是什么”
* Screen Pattern 决定“同类对象如何交互”
* Business Screen 决定“该对象在此场景展示什么”
* Field Registry 决定“字段如何输入、显示和验证”
* Query Contract 决定“如何搜索、过滤、排序和分页”
* Domain 决定“业务动作是否合法”

Pattern 不得发明 Registry 中不存在的业务对象；Registry 也不得规定具体像素布局。

### 63.17 Registry 与 Work Package Gate

任何对象进入实现 Work Package 前必须满足：

1. Registry Entry 为 Active
2. Owning Module 与 Source of Truth 明确
3. Screen Matrix 已登记或明确 No UI
4. Permission Namespace 已登记
5. Query / Projection Requirement 已登记
6. Retention、PII 与 Audit 已分类
7. Cross-object Relationship 已声明
8. Open Decision 不影响当前 Work Package

未通过时，Work Package 不进入 Ready。

### 63.18 Registry Governance

新增、合并、拆分、替代或退休 Business Object 时：

* 更新 Registry Entry
* 执行 Domain Boundary Review
* 更新 Screen Matrix
* 更新 API / Event / Projection Traceability
* 评估 Migration 与历史数据
* 更新 Permission、Retention 与 Audit
* 影响架构时创建 ADR
* 仅影响实现方式时创建 IDR

AI 可以起草 Registry Entry，但不能自行改变 Owning Module 或 Aggregate Boundary。

### 63.19 Acceptance Criteria

必须证明：

1. Product、SKU 与 Inventory Item 可以通过统一模板登记，同时保持不同 Owning Module
2. 数据库表、DTO 或临时 Projection 不会被误当成 Business Object
3. 每个 Object 可追踪到 Domain、Screen、Permission、Query、Projection 与 Work Package
4. 新对象必须先登记，不能直接从 UI 或 Migration 开始实现
5. Object Replacement 与 Retirement 保留历史 ID
6. Transaction Object 不通过 Edit Screen 改写事实
7. Cross-module Relationship 不产生未授权写依赖
8. Search 与 Filter 能追踪到 Search Profile 和 Projection
9. PII、Retention、Audit 与 Export 规则不遗漏
10. AI 工具可以根据 Object ID 找到统一产品上下文

### 63.20 Business Object Registry 状态

Business Object Registry v0.1 已完成并阶段性 Freeze。

已锁定：

* Registry 在 Domain 与 Screen Specification 之间的定位
* Registry Entry 标准字段
* Object Classification、ID、Status 与 Screen Matrix
* Product、SKU、Inventory Item 首批 Entry
* 第一版 Object Catalog
* Relationship、Search、Permission、Retention 与 Audit Registry
* Work Package Gate 与 Governance

本阶段不创建运行时 Registry Service，不生成数据库表、UI 或业务代码。第一版 Registry 作为产品与工程文档资产维护；未来是否平台化为 Metadata Service 另行评估。

---

## 历史讨论节点 H-064（已完成）

Architecture、Engineering Blueprint、Initial Backlog、Master Development Playbook、Implementation Decision Record、Merchant Information Architecture、Merchant UX / Screen Pattern Architecture，以及 Business Object Registry 已完成。

BOP-RMS Complete Handoff Package 当前仍为：

**v1.0 Architecture and Engineering Baseline Candidate。**

下一步进入：

**Core Screen Specification Expansion — Master Data Screen Family。**

执行顺序：

1. 以 Business Object Registry 的 `RMS-CAT-PRODUCT` 为入口，完成 Product Screen Matrix
2. 完成 Product Create / Edit Field Registry 与 Validation Matrix
3. 完成 Product List / Detail Search、Filter、Sort、Projection 与 API 字段
4. 继续 `RMS-CAT-SKU`
5. 继续 `RMS-INV-INVENTORY-ITEM`
6. 完成 Category、Option Set 与 Lookup Picker Contract

继续遵循：

* 暂不生成代码
* 不启动 Repository
* 一次完成一个 Business Object / Screen Family
* Registry 先行，Pattern 提供结构，Business Screen 只声明差异
* 完成核心 Master Data Screen 后，再回到 WP-0001 Specification


---

## 64. Business Capability Registry

### 64.1 目的与定位

Business Capability Registry 是 BOP-RMS 产品与工程规划层的统一能力目录，位于 Domain Architecture 与 Business Object Registry 之前。

固定层级：

`Business Capability Registry`

→ `Business Object Registry`

→ `Workflow / Process Registry`

→ `Merchant UX Pattern / Business Screen`

→ `Field / Column Registry`

→ `Query / Command Contract`

→ `Projection / Database Ownership`

→ `Work Package / Code`

Capability 回答“系统需要具备什么业务能力”；Business Object 回答“该能力围绕哪些稳定业务对象运作”。Capability 不取代 Domain、Module、Aggregate 或 Screen，也不作为新的运行时 Service Boundary。

### 64.2 核心规则

* Capability 描述业务结果和职责范围，不等同于菜单项、页面、Module 或单一 Aggregate
* 一个 Capability 可以跨多个 Business Object，但必须有一个 Primary Owning Domain / Module
* 一个 Business Object 可以被多个 Capability 使用，但只能有一个 Write Owner
* Capability Dependency 不允许绕过已冻结的 Module Dependency Rule
* Capability Map 用于 Roadmap、Scope、Coverage、Release、Gap Analysis 与 Work Package 组织
* Capability 不直接规定数据库表、DTO、Provider 或具体 UI Layout
* 新功能进入 Roadmap 前必须先归属现有 Capability，或先创建新的 Capability Entry
* Capability 名称使用业务语言，不以技术框架、团队或供应商命名

### 64.3 Capability Entry 标准字段

每个 Capability Entry 至少包含：

* Capability ID
* Capability Name
* Business Description
* Business Outcome / Goal
* Capability Level：Level 1 / Level 2 / Level 3
* Parent Capability
* Primary Owning Layer：BOP / RMS
* Primary Owning Domain / Module
* Supporting Modules
* Primary Personas
* Tenant / Store Scope
* Included Business Object IDs
* Included Workflow / Process IDs
* Primary Screen / Workspace IDs
* Command / Query / Event Contract References
* Permission Namespace
* KPI / Report References
* Upstream Dependencies
* Downstream Consumers
* External Provider / Integration Dependency
* Data / PII / Compliance Classification
* Availability / Feature Flag Dependency
* Phase / Milestone
* Capability Maturity
* Registry Status
* Notes / Open Decisions

### 64.4 Capability ID 与层级

Capability ID 使用稳定、不可复用的机器标识：

`BOP-CAP-<NAME>` 或 `RMS-CAP-<NAME>`

示例：

* `RMS-CAP-CATALOG-MANAGEMENT`
* `RMS-CAP-INVENTORY-MANAGEMENT`
* `RMS-CAP-ORDERING`
* `RMS-CAP-PAYMENT-PROCESSING`
* `RMS-CAP-KITCHEN-OPERATIONS`
* `BOP-CAP-IDENTITY-ACCESS`

Level 定义：

* `Level 1`：顶层业务能力域，例如 Commerce Operations、Store Operations、Platform Governance
* `Level 2`：可独立规划和验收的能力，例如 Catalog Management、Inventory Management、Ordering
* `Level 3`：具体子能力，例如 Product Management、Stock Counting、Refund Processing

第一版 Roadmap 和 Work Package 默认以 Level 2 为主；Level 3 仅在需要拆分验收范围时使用。

### 64.5 Capability Status 与 Maturity

Registry Status：

* `Proposed`
* `Active`
* `Deprecated`
* `Replaced`
* `Retired`

Capability Maturity：

* `Defined`：边界、对象和目标已明确
* `Designed`：Domain、Workflow、Screen 与 Contract 已完成
* `Implementation Ready`：依赖、IDR、Backlog 与验收已完成
* `Implemented`
* `Pilot Validated`
* `Production Ready`

Status 描述目录生命周期；Maturity 描述交付成熟度，两者不可混用。

### 64.6 Level 1 Capability Map

第一版 Level 1 Capability：

1. `Platform Foundation and Governance`
2. `Merchant and Organization Management`
3. `Commerce Configuration`
4. `Customer Ordering and Transaction Processing`
5. `Store Operations`
6. `Supply and Inventory Operations`
7. `Customer Engagement`
8. `Fulfillment and Delivery`
9. `Data, Reporting and Compliance`
10. `Integration and Device Operations`

### 64.7 第一版 Level 2 Capability Catalog

Platform Foundation and Governance：

* Identity and Authentication
* Tenant and Operating Entity Management
* Permission and Access Control
* Workflow and Approval
* Audit and Data Governance
* Notification and Task Management
* Configuration Publishing and Feature Control
* Media Management

Commerce Configuration：

* Catalog Management
* Menu Management
* Pricing and Tax Management
* Promotion Management
* Recipe Management
* Availability Management

Customer Ordering and Transaction Processing：

* Cart and Checkout
* Ordering
* Payment Processing
* Refund and Payment Exception Management

Store Operations：

* Kitchen Operations
* Dining and Table Operations
* Reservation and Waitlist
* Store Configuration
* Printing and Device Operations

Supply and Inventory Operations：

* Inventory Management
* Stock Counting and Adjustment
* Transfer and Waste Management
* Procurement and Supplier Management

Customer Engagement：

* Customer Profile Management
* Loyalty and Membership
* Customer Communication

Fulfillment and Delivery：

* Pickup Operations
* Delivery Planning and Execution
* Fulfillment Exception Management

Data, Reporting and Compliance：

* Operational Reporting
* Business Intelligence and Metric Management
* Compliance and Food Safety
* Product Traceability and Recall

### 64.8 Catalog Management Capability Entry

Capability ID：`RMS-CAP-CATALOG-MANAGEMENT`

* Level：2
* Parent：Commerce Configuration
* Primary Owner：Catalog Module
* Business Outcome：让 Merchant 可以建立、维护、发布和审计可销售商品结构
* Primary Personas：Owner、Catalog Manager、Store Manager、Catalog Editor
* Included Objects：Product、SKU、Category、Option Set、Option、Product Option Binding
* Supporting Capabilities：Menu Management、Pricing and Tax、Availability、Recipe、Inventory
* Primary Workflows：Create Draft、Validate、Activate、Archive、Restore、Replace SKU、Assign Option
* Primary Screens：Product List / Detail / Form、SKU List / Detail / Form、Category、Option Set、Lookup Picker
* Permission Namespace：`catalog.*`
* Core Events：ProductCreated、ProductActivated、ProductArchived、SKUCreated、SKUReplaced、CategoryChanged、OptionSetPublished
* Primary KPIs：Active Products、Draft Aging、Products Without Active SKU、Catalog Validation Failure Rate
* Phase：Phase 1
* Maturity：Designed
* Status：Active

### 64.9 Inventory Management Capability Entry

Capability ID：`RMS-CAP-INVENTORY-MANAGEMENT`

* Level：2
* Parent：Supply and Inventory Operations
* Primary Owner：Inventory Module
* Business Outcome：按 Store 与库存地点准确追踪可用量、保留量、移动、盘点和补货状态
* Included Objects：Inventory Item、Stock Balance、Stock Movement、Stock Count、Adjustment、Transfer、Waste Record、Reorder Policy
* Supporting Capabilities：Recipe、Procurement、Kitchen、Reporting、Compliance
* Primary Screens：Stock Overview、Inventory Item List / Detail / Form、Movement Explorer、Count Workbench
* Permission Namespace：`inventory.*`
* Core Events：InventoryItemCreated、StockReceived、StockAdjusted、StockTransferred、StockCountCompleted、ReorderThresholdBreached
* Primary KPIs：Inventory Accuracy、Stockout Rate、Waste Rate、Count Variance、Items Below Reorder Point
* Phase：Phase 2
* Maturity：Designed
* Status：Active

### 64.10 Ordering Capability Entry

Capability ID：`RMS-CAP-ORDERING`

* Level：2
* Parent：Customer Ordering and Transaction Processing
* Primary Owner：Ordering Module
* Business Outcome：将经过验证和定价的购物意图转换为不可被后续配置改写的订单事实
* Included Objects：Cart、Checkout Session、Order、Order Item Snapshot、Order Amendment
* Dependencies：Catalog、Pricing、Store、Identity / Guest Context、Payment、Fulfillment
* Primary Screens：Customer Cart / Checkout、Merchant Order Explorer、Order Detail
* Permission Namespace：`ordering.*`
* Core Events：CartCheckedOut、OrderCreated、OrderConfirmed、OrderAmended、OrderCancelled
* Phase：Phase 1
* Maturity：Designed
* Status：Active

### 64.11 Capability-to-Object Mapping Contract

每个 Active Capability 必须列出：

* Primary Object：该能力最主要围绕的 Business Object
* Owned Objects：由 Primary Owning Module 写入的对象
* Referenced Objects：只通过 Contract / Projection 使用的对象
* Relationship Objects：连接对象但不改变双方 Write Ownership
* Operational / Projection Objects：用于执行与查询的对象

Capability Map 不允许把跨 Module Referenced Object 误标为 Owned Object。

### 64.12 Capability-to-Workflow Mapping

每个 Capability 必须登记至少一个可验收 Workflow / Process：

* Trigger
* Actor
* Preconditions
* Steps / Actions
* Business Objects
* Commands
* Events
* Exception Paths
* Completion Outcome
* KPI / SLA

Workflow Registry 可以后续独立展开，但 Capability Entry 必须先保留 Workflow ID 与业务目标。

### 64.13 Capability-to-Screen Mapping

Screen 必须通过 Business Object 或 Workflow 归属 Capability。

每个 Capability 保存：

* Primary Navigation Entry
* Primary Workspace
* Object-centric Screens
* Workflow / Operational Screens
* Reporting / Monitoring Screens
* Administration Screens

一个 Screen 可以服务多个 Capability，但必须指定 Primary Capability，避免导航、权限和产品 Ownership 模糊。

### 64.14 Capability Dependency Registry

每条 Capability Dependency 保存：

* Source Capability
* Target Capability
* Dependency Type：Synchronous Validation、Event Fact、Projection Feed、Configuration Reference、Provider Integration
* Required / Optional
* Phase
* Failure Impact
* Fallback / Degraded Mode
* Owning Contract

Capability Dependency 只能描述业务依赖，实际代码依赖仍由 Module Blueprint 和 Contract Blueprint 约束。

### 64.15 Capability Coverage Matrix

每个 Capability 维护覆盖矩阵：

* Domain Model：Not Started / Defined / Frozen
* Business Objects：Coverage %
* Workflow：Coverage %
* Screen：Coverage %
* Field / Query Contract：Coverage %
* API / Event Contract：Coverage %
* Database / Projection：Coverage %
* Backlog：Coverage %
* Test / Acceptance：Coverage %
* Implementation：Coverage %

Coverage 不以文档长度衡量，只以必须交付项是否存在且通过 Review 衡量。

### 64.16 Capability 与 Roadmap

Roadmap 默认以 Capability Increment 组织，而不是以孤立页面或数据库表组织。

每个 Capability Increment 必须说明：

* Business Outcome
* Included Object Scope
* Included Workflow
* Included Screen
* Required Dependencies
* Exit Criteria
* Deferred Sub-capabilities

Work Package 可以实现单一对象或技术基础，但必须引用其支持的 Capability ID。

### 64.17 Capability 与 Permission / KPI / Report

每个 Capability 必须登记：

* Permission Namespace
* High-risk Actions
* Required Audit Categories
* Operational KPI
* Quality / Guardrail Metric
* Primary Reports
* Alert / Exception Trigger

Capability 不直接授予权限；Permission Module 仍是授权事实来源。

### 64.18 Capability 与 Product Navigation

Merchant Navigation 应主要反映用户任务和 Capability，而不是数据库对象清单。

规则：

* 顶层导航通常对应 Level 1 或重要 Level 2 Capability Group
* 对象列表和配置页作为 Capability 下的 Screen
* 低频或高风险管理能力可以放入 Settings / Administration
* 导航结构不改变 Capability Ownership
* Feature Flag、Permission、Store Capability 和 Tenant Scope 决定可见性

### 64.19 Capability Gate

任何 Capability 进入 Implementation Ready 前必须满足：

1. Capability Entry 为 Active
2. Business Outcome 与 Scope 明确
3. Primary Owning Module 明确
4. Included Object IDs 已登记
5. 至少一个 Workflow / Acceptance Scenario 已定义
6. Primary Screens 或明确 No UI
7. Dependency 与 Contract 已登记
8. Permission、Audit、PII、Compliance 已分类
9. KPI / Report 或明确 Not Applicable
10. Backlog 与 Exit Criteria 已建立
11. 不存在阻塞当前实现的 Architecture Decision

### 64.20 Governance

新增、拆分、合并、替代或退休 Capability 时：

* 更新 Capability Entry 与 Parent Map
* 评估 Business Object Ownership 是否变化
* 更新 Workflow、Screen、Permission、KPI 与 Roadmap
* 更新 Dependency Registry
* 影响 Domain / Module Boundary 时创建 ADR
* 仅影响实现方式时创建 IDR
* 保留原 Capability ID 与 Replacement Reference

AI 可以起草 Capability Entry 和 Coverage Matrix，但不能自行改变 Primary Owning Module、Domain Boundary 或 Roadmap Scope。

### 64.21 Acceptance Criteria

必须证明：

1. Catalog、Inventory 和 Ordering 可以作为独立 Capability 规划，同时引用各自 Business Object
2. Capability 不被误用为 Module、Screen 或数据库表
3. 一个 Object 被多个 Capability 引用时仍保持单一 Write Owner
4. Roadmap 可以从 Capability 展开到 Object、Workflow、Screen、Contract 与 Work Package
5. Search、Filter、Report 与 KPI 可以追踪到 Capability
6. Capability Dependency 不产生未授权代码依赖
7. 新功能先归属 Capability，再进入 Object / Screen / Work Package
8. Capability Replacement 保留历史 ID
9. Capability Coverage 可以识别设计或实现缺口
10. AI 工具可通过 Capability ID 获取完整产品上下文

### 64.22 Business Capability Registry 状态

Business Capability Registry v0.1 已完成并阶段性 Freeze。

已锁定：

* Capability Registry 的定位、层级和标准 Entry
* Capability ID、Status、Maturity 与 Coverage Matrix
* Level 1 Map 与第一版 Level 2 Catalog
* Catalog、Inventory、Ordering 首批完整 Entry
* Capability-to-Object、Workflow、Screen、Dependency 与 Roadmap Mapping
* Permission、KPI、Report、Implementation Gate 与 Governance

本阶段不创建运行时 Capability Service，不生成数据库表、UI 或业务代码。Capability Registry 第一版作为产品规划、架构追踪和 Work Package 组织资产维护。

---

## 历史讨论节点 H-065（已完成）

Architecture、Engineering Blueprint、Initial Backlog、Master Development Playbook、Implementation Decision Record、Business Capability Registry、Business Object Registry、Merchant Information Architecture，以及 Merchant UX / Screen Pattern Architecture 已完成。

BOP-RMS Complete Handoff Package 当前仍为：

**v1.0 Architecture and Engineering Baseline Candidate。**

最终产品工程链路固定为：

`Capability Registry`

→ `Business Object Registry`

→ `Workflow / Process Registry`

→ `Merchant UX Pattern / Business Screen`

→ `Field / Column Registry`

→ `Query / Command Contract`

→ `Projection / Database Ownership`

→ `Work Package / Code`

下一步进入：

**Core Screen Specification Expansion — Catalog Management Capability / Product Object。**

执行顺序：

1. 从 `RMS-CAP-CATALOG-MANAGEMENT` 展开 `RMS-CAT-PRODUCT`
2. 完成 Product Screen Matrix
3. 完成 Product Create / Edit Field Registry 与 Validation Matrix
4. 完成 Product List / Detail Search、Filter、Sort、Projection 与 API 字段
5. 继续 SKU、Category、Option Set 与 Lookup Picker
6. 完成 Catalog Management Capability 的首轮 Coverage Matrix

继续遵循：

* 暂不生成代码
* 不启动 Repository
* 一次完成一个 Capability / Business Object
* Capability 定义范围，Registry 定义对象，Pattern 提供结构，Business Screen 只声明差异
* 完成核心 Catalog / Inventory Master Data Screen 后，再回到 WP-0001 Specification

---

## 66. Pre-Implementation Readiness Boundary（Historical scope；expanded by Section 88）

### 66.1 本轮目标

本轮把“写代码前的工作”定义为：

* 让 `WP-0001` 达到可以直接交给 Developer 或 AI Coding Agent 执行的 `Ready` 状态
* 补齐 Phase 1 最先依赖的 Catalog Master Data 产品、交互和 Contract 规格
* 补齐后续 Inventory Master Data 工作所需的对象、页面、字段和查询契约
* 建立从 Capability、Object、Workflow、Screen、Field、Query、Projection 到 Work Package 的完整追踪链
* 本轮当时不要求在第一行代码之前详细设计所有 Post-v0.1 页面和所有未来 Work Package；该限制后来已由 Section 88 的全产品 Page / Function Closure 主动扩大并完成

核心原则：

* 当前不生成 Repository、Migration、API、UI 或测试代码
* 已 Freeze 的 Domain、Aggregate 与 Module Boundary 不重新讨论
* 不用 UI 字段反向改变 Domain Ownership
* 尚未进入执行的 Work Package 仍使用 Just-in-time Gate 完成文件 / component / test 级拆分与真实 evidence，但不得重新决定 Section 88 已锁定的页面、功能或交互 Contract
* 当前规格已足以让全部登记 Capability 的后续 Work Package 不再依赖页面 / 产品方向选择；Repository Bootstrap 状态不变

### 66.2 缺口审计结果

已经完成并可直接引用：

* v0.1 Domain Architecture Freeze
* Platform / BOP Open Architecture Decisions Consolidation
* Development Roadmap
* Repository、Module、Database 与 API / Event Blueprint
* Initial Backlog
* Master Development Playbook
* Implementation Decision Record Framework
* Merchant Information Architecture
* Merchant UX / Screen Pattern Architecture
* Business Object Registry
* Business Capability Registry

本轮必须补齐：

1. Product Screen Matrix
2. Product Field / Validation Registry
3. Product Search / Filter / Sort / Projection / API Contract
4. SKU Screen、Field、Replacement 与 Query Contract
5. Category、Option Set 与 Lookup Picker Contract
6. Inventory Item Screen、Field、Tracking、Reorder 与 Query Contract
7. 核心 Workflow / Process Registry
8. Permission、Audit、Import / Export、State 与 Acceptance Traceability
9. Catalog / Inventory Scope Coverage Matrix
10. WP-0001 Implementation Choice Gate 与完整 Work Package Specification

### 66.3 历史开放项处理

早期章节保留的 Open Decision 仅是历史记录，不重新打开。

以 Section 42 的 Consolidation 结果为最终依据：

* Operating Entity：`Locked for v0.1`，独立 Aggregate Root
* Media：`Locked as BOP Shared Capability`
* Overlay：`Locked for v0.1`
* Configuration Domain：`Deferred with Locked Shared Contract`
* Policy Engine：`Deferred`
* Workforce、Enterprise Search、Finance 等：按 Deferred Register 执行，不阻塞当前开发

### 66.4 Scope Exit Criteria

本轮完成必须证明：

1. Product、SKU、Category、Option Set 与 Inventory Item 的 Screen Matrix 没有隐含空项
2. Create / Edit 字段有 Ownership、Required、Validation、Permission 与 Lifecycle Rule
3. List / Detail 的 Search、Filter、Sort、Pagination 与 Projection 可直接转换为 Contract
4. 危险 Action 有 Permission、Reason、Impact、Audit 与 Idempotency 规则
5. Workflow 可以从 Trigger 追踪到 Command、Event、Exception 与 Completion Outcome
6. Capability Coverage 能区分“设计完成”与“代码尚未开始”
7. WP-0001 的版本、文件、任务、非目标、验收与 Handoff 已全部锁定
8. 当前不存在阻塞 WP-0001 的架构或实现选择

---

## 67. Product Screen Matrix

### 67.1 核心交互决定

Product Detail 与 Product Edit 分为两个独立 Screen Intent：

* `CAT-PRODUCT-DETAIL` 是只读 Master Detail
* `CAT-PRODUCT-EDIT` 是显式进入的 Draft Editor
* `CAT-PRODUCT-CREATE` 是独立 Create Intent
* 三者可以复用 Section、Field Renderer 与 Validation Component，但 Permission、Route、Unsaved Change 与 Command 不混用
* 修改 Active Product 时创建或打开可编辑 Draft Product Version，不直接修改 Published Version
* 保存 Draft 不等于发布，也不改变当前线上解析结果

此前 `CAT-PRODUCT-DETAIL — Product Detail / Editor` 的名称解释为历史粗粒度 Screen Specification；本节以分离后的 Matrix 为准，不改变 Product Aggregate 或 Product Version 设计。

### 67.2 Product Screen Matrix

| Matrix Item | Screen ID | Pattern | Route Intent | Primary Persona | Permission | Contract / Projection | Phase | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| List / Explorer | `CAT-PRODUCT-LIST` | Master List | `/catalog/products` | Owner、Catalog Manager、Store Manager、Analyst | `catalog.product.read` | `ListProducts` / Product Search Projection | Phase 1 | Active |
| Detail | `CAT-PRODUCT-DETAIL` | Master Detail | `/catalog/products/:productId` | Owner、Catalog Manager、Store Manager、Analyst | `catalog.product.read` | `GetProductDetail` / Product Detail Projection | Phase 1 | Active |
| Create | `CAT-PRODUCT-CREATE` | Create Form | `/catalog/products/new` | Owner、Catalog Manager、Catalog Editor | `catalog.product.create` | `CreateProduct` | Phase 1 | Active |
| Edit | `CAT-PRODUCT-EDIT` | Edit Form + Draft Banner | `/catalog/products/:productId/edit` | Owner、Catalog Manager、Catalog Editor | `catalog.product.update` | `CreateProductDraft`、`UpdateProductDraft` | Phase 1 | Active |
| Duplicate / Clone | `CAT-PRODUCT-DUPLICATE` | Guided Dialog / Form | Product Detail Action | Owner、Catalog Manager、Catalog Editor | `catalog.product.create` | `DuplicateProductAsDraft` | Phase 1 | Active |
| Archive / Deactivate | `CAT-PRODUCT-ARCHIVE` | Impact Dialog | Product List / Detail Action | Owner、Catalog Manager | `catalog.product.archive` | `ArchiveProduct` + Change Impact | Phase 1 | Active |
| Restore / Reactivate | `CAT-PRODUCT-RESTORE` | Guided Dialog | Archived Product Action | Owner、Catalog Manager | `catalog.product.restore` | `RestoreProduct` | Phase 1 | Active |
| History / Timeline | `CAT-PRODUCT-HISTORY` | History Timeline | `/catalog/products/:productId/history` | Owner、Manager、Auditor | `catalog.product.history.read` | `ListProductHistory` / History Projection | Phase 1 | Active |
| Audit | `CAT-PRODUCT-AUDIT` | Audit Drawer / Explorer | Product Detail Related View | Owner、Auditor | `audit.catalog.product.read` | `ListAuditEntries` / Audit Projection | Phase 1 | Active |
| Import | `CAT-PRODUCT-IMPORT` | Import Wizard | `/catalog/products/import` | Owner、Catalog Manager、Catalog Editor | `catalog.product.import` | `ValidateProductImport`、`CommitProductImport` | Phase 1 | Active |
| Export | `CAT-PRODUCT-EXPORT` | Export Dialog / Job | Product List Action | Owner、Manager、Analyst | `catalog.product.export` | `CreateProductExport` / Product Search Projection | Phase 1 | Active |
| Compare | `CAT-PRODUCT-COMPARE` | Version Compare | `/catalog/products/:productId/compare` | Owner、Catalog Manager、Approver | `catalog.product.history.read` | `CompareProductVersions` | Phase 1 | Active |
| Related Object Picker | `CAT-PRODUCT-PICKER` | Lookup Picker | Embedded / Modal | Authorized Editor | `catalog.product.read` | `SearchProductPicker` / Picker Projection | Phase 1 | Active |
| Workflow / Approval | `CAT-PRODUCT-REVIEW` | Publish Workflow | Product Detail / Edit Panel | Catalog Manager、Approver | `catalog.product.submit` / `catalog.product.approve` / `catalog.product.publish` | Product Publishing Commands | Phase 1 | Active |
| Operational Action | `CAT-PRODUCT-AVAILABILITY` | Related Configuration Panel | Product Detail Tab | Store Manager、Catalog Manager | `catalog.product.availability.manage` | Availability / Assignment Contract | Phase 1 | Active |

### 67.3 Product List Composition

Primary Pattern：`PATTERN-MASTER-LIST`。

Composition：

* Page Header
* Brand Scope Context
* Primary Action：Create Product
* Search Bar
* Quick Filters
* Advanced Filter Panel
* Saved Views
* Column Chooser
* Data Grid
* Row Action Menu
* Bulk Action Bar
* Import / Export Entry
* Pagination
* Result Count 与 Projection Freshness

Product List 只读取 Product Search Projection；Row Action 执行前必须回源验证 Permission、Lifecycle、Aggregate Version 与 Change Impact。

### 67.4 Product Detail Composition

Primary Pattern：`PATTERN-MASTER-DETAIL`。

Header：

* Product Name
* Internal Code
* Lifecycle Status
* Effective / Published Version
* Draft Presence
* Sellable Summary
* Last Updated
* Primary Action：Edit Draft / Create Draft

Tabs：

1. Overview
2. Translations
3. Media
4. SKUs
5. Variants
6. Options
7. Categories
8. Menus
9. Availability
10. Tax
11. Store Overrides
12. Versions
13. History

Detail 默认展示当前上下文解析出的 Effective Version，并清楚标记：

* Stable Product Identity
* Effective Version ID
* Version Scope
* Effective Period
* Draft / Published / Superseded Status
* Source Level 与 Overlay Source

### 67.5 Product Create Composition

Product Create 使用分段 Form，不使用长页面一次暴露全部高级配置。

第一步必须完成：

* Identity
* Default-language Content
* Product Type
* Primary Category（可选但建议）
* Tax Classification（可由 Brand Default 解析）

创建成功结果：

* 生成稳定 Product ID
* 创建 Draft Product Version
* 跳转 `CAT-PRODUCT-EDIT`
* 不自动发布
* 不自动创建价格、菜单 Placement、Recipe 或 Inventory Item

### 67.6 Product Edit Composition

Edit Header 必须显示：

* Editing Draft Version
* Base Published Version
* Aggregate Version / ETag
* Unsaved Changes
* Validation State
* Change Impact State

Actions：

* Save Draft
* Validate
* Preview Effective Result
* Compare with Published
* Submit for Review
* Publish（有权限且 Policy 允许）
* Schedule Publish
* Discard Draft

离开页面时存在未保存内容必须提示；Concurrency Conflict 不允许静默覆盖。

### 67.7 Duplicate、Archive 与 Restore

Duplicate 默认复制：

* 当前选定 Product Version 的可配置内容
* Category、Tag、Media Reference 与 Option Binding
* Variant Definition 与 SKU 结构仅作为新 Draft 候选

Duplicate 不复制：

* Product ID、SKU ID、Internal Code、Barcode
* Pricing Record
* Inventory Balance / Movement
* Historical Order Reference
* Audit、History、Published Status
* Menu Placement，除非用户显式选择并通过重复检查

Archive 前必须显示：

* Active SKU Count
* Published Menu Reference
* Bundle Reference
* Pricing / Recipe / Inventory / Availability Reference 摘要
* Future Effective Version
* 当前未完成审批或发布任务

Restore 只恢复到 `Draft`，不直接恢复为线上 `Active`；Product Lifecycle 不使用 `Inactive`。恢复后必须重新执行 Validate 与 Publish。

### 67.8 Product Screen State

所有 Product Screen 必须实现或显式继承：

* Loading
* Refreshing
* Empty
* No Search Result
* Permission Denied
* Not Found
* Archived
* Partial Projection
* Stale Projection
* Draft Exists
* Validation Failure
* Change Impact Warning
* Approval Pending
* Command Pending / Succeeded / Failed
* Concurrency Conflict
* Offline / Network Failure

---

## 68. Product Field and Validation Registry

### 68.1 Field Ownership Rule

Product Form 只写 Catalog-owned Product / Product Version 配置。

以下内容不得在 Product Form 中作为 Catalog-owned Field 直接写入：

* 最终价格与 Promotion
* 实时库存与库存余额
* Recipe 消耗数量
* Menu Placement Display Override
* Payment、Kitchen 或 Order 状态
* Supplier Agreement 与 Purchase Cost

这些内容只能通过 Related Screen、Reference、Projection 或对应 Module Action 管理。

### 68.2 Stable Product Identity Fields

| Field Key | Label | Type | Required | Editable Rule | Validation | Permission / Audit |
| --- | --- | --- | --- | --- | --- | --- |
| `product_id` | Product ID | UUID / Opaque ID | System | Never | Globally unique; never reused | Read permission; create audit |
| `brand_id` | Brand | Tenant Context | Yes | Never after create | Must match actor tenant scope | Server-derived; audit create |
| `internal_code` | Internal Code | Text | Yes | Draft freely; after first publish controlled correction | Trimmed; Brand-unique; case-normalized; 1–64 chars; allowed character policy | `catalog.product.identity.update`; audit before/after |
| `product_type` | Product Type | Enum | Yes | Draft; after publish impact review | Must be registered Product Type; compatible with SKU / Sellable rules | Update permission; impact audit |
| `lifecycle` | Lifecycle | Read-only State | System | Action only | Valid Product Lifecycle transition | Separate lifecycle permission and reason |
| `created_at` | Created At | Instant | System | Never | UTC | Read-only |
| `created_by` | Created By | Actor Ref | System | Never | Valid Actor Snapshot | Read-only |
| `aggregate_version` | Record Version | Integer / ETag | System | Never directly | Monotonic optimistic concurrency | Required on mutation |

### 68.3 Product Version Content Fields

| Field Key | Section | Type | Required | Validation / Business Rule |
| --- | --- | --- | --- | --- |
| `version_id` | Version | ID | System | Immutable published version identifier |
| `base_version_id` | Version | ID | Conditional | Required when Draft derives from Published Version |
| `default_locale` | Localization | BCP 47 Locale | Yes | Must be enabled by Brand |
| `localized_name` | Localization | Locale Map Text | Yes | Default locale required; each value 1–120 chars; normalized whitespace |
| `localized_short_description` | Localization | Locale Map Text | No | Maximum 240 chars per locale |
| `localized_description` | Localization | Locale Map Plain Text | No | v0.1 allows normalized text + line breaks only；HTML / Markdown rejected |
| `preparation_notes_default` | General | Locale Map Text | No | Operational note only; no secret or customer PII |
| `category_ids` | Organization | ID Set | No | Same Brand; Active or Draft allowed by Policy; no duplicate IDs |
| `primary_category_id` | Organization | ID | No | Must be included in `category_ids` |
| `tag_ids` | Organization | ID Set | No | Registered Brand tag; deduplicated |
| `attribute_values` | Attributes | Typed Map | No | Key must exist in Attribute Registry; value matches declared type / unit |
| `media_references` | Media | Ordered Reference Set | No | Same Brand or authorized shared media; published content defaults to pinned version |
| `primary_media_reference` | Media | Reference | No | Must be contained in media references and have valid rendition |
| `tax_classification_id` | Tax | Reference | Conditional | Explicit value or resolvable Brand default required before publish |
| `allergen_references` | Safety | ID Set | Conditional | Required when Brand / jurisdiction policy demands; controlled vocabulary |
| `nutrition_profile_reference` | Nutrition | Reference | No | Versioned reference; unit and serving basis required in source profile |
| `variant_definition` | Variants | Structured Config | Conditional | Dimension codes unique; values unique per dimension; valid combination rules |
| `product_option_bindings` | Options | Ordered Binding Set | No | Binding ID unique; Option Set version valid; override within allowed bounds |
| `version_scope` | Publishing | Scope Set | Yes before publish | Must resolve without ambiguity for Store / Region / Channel / Order Type context |
| `effective_from` | Publishing | Instant | Conditional | Required for scheduled publish; UTC; not before allowed backdate policy |
| `effective_until` | Publishing | Instant | No | Must be after Effective From; no overlapping ambiguous version scope |
| `change_reason` | Governance | Text / Reason Code | Conditional | Required for publish, archive, identity correction and high-impact change |

### 68.4 Media Field Rules

Product Media 至少支持：

* Asset Reference
* Asset Version Reference
* Role：Primary、Gallery、Thumbnail Candidate、Instructional
* Alt Text by Locale
* Sort Order
* Crop / Focus Reference

Validation：

* Primary media 同时最多一个
* Publish 前所有必需 Rendition 必须 Ready
* Rejected、Quarantined 或 Processing Failed Asset 不得发布
* Alt Text Requirement 按 Accessibility Policy 执行
* Product 不保存文件二进制或外部临时 URL

### 68.5 Variant Definition Rules

每个 Variant Dimension 保存：

* Dimension ID
* Stable Code
* Localized Name
* Sort Order
* Selection Requirement

每个 Variant Value 保存：

* Value ID
* Stable Code
* Localized Name
* Sort Order
* Optional Attribute / Media Reference

Validation：

* Product 内 Dimension Code 唯一
* Dimension 内 Value Code 唯一
* 已被 SKU 使用的 Dimension / Value Identity 不物理删除
* 组合规则必须能判断 Valid / Invalid，不允许得到歧义结果
* Variant 决定 SKU；不把顾客可选加料当作 Variant
* 未映射到 SKU 的组合可以保留为 Invalid / Not Generated，不强制笛卡尔积生成 SKU

### 68.6 Product Option Binding Rules

每个 Binding 保存：

* Binding ID
* Option Set ID 与 Version Resolution Rule
* Purpose / Display Group
* Sort Order
* Enabled Option Scope
* Default Selection
* Selection Rule Override
* Pricing Rule Reference
* Conditional / Conflict Rule Reference
* SKU Include / Exclude Scope
* Variant Condition
* Channel Scope
* Store Override Allowed

Validation：

* 同一 Product 可以重复绑定同一 Option Set，但 Binding ID 与 Purpose 必须独立
* Default Selection 必须满足最终 Selection Rule
* Override 不得放宽 Platform / Brand Hard Limit
* SKU Scope 引用的 SKU 必须属于当前 Product
* 跨 Module Pricing / Inventory Reference 只验证 Reference Contract，不由 Catalog 改写源对象

### 68.7 Create Validation Matrix

| Rule ID | Trigger | Severity | Rule | Failure Result |
| --- | --- | --- | --- | --- |
| `PROD-C-001` | Create | Error | Brand Context 必须有效 | Reject |
| `PROD-C-002` | Create | Error | Internal Code 在 Brand 内唯一 | Reject with duplicate reference |
| `PROD-C-003` | Create | Error | Product Type 必须有效 | Reject |
| `PROD-C-004` | Create | Error | Default Locale Name 必填 | Reject |
| `PROD-C-005` | Create | Error | Actor 具有 Create Permission | Reject / Audit denied action |
| `PROD-C-006` | Create | Warning | Category、Media 或 Tax 尚未完整 | Allow Draft; block publish if required |
| `PROD-C-007` | Create | Error | Idempotency Key 不得映射到不同 Request | Conflict |

### 68.8 Draft Save Validation Matrix

Draft Save 允许不完整配置，但不允许结构损坏。

保存时必须拒绝：

* 跨 Brand Reference
* 重复或非法稳定 Code
* 无效 Locale Key
* Variant / Option Binding Identity 冲突
* 不合法 Aggregate Version
* 不受支持的 Product Type
* 违反 Hard Limit 的 Selection Rule

保存时可以 Warning：

* 缺少翻译
* 缺少图片
* 没有 Active SKU
* 没有 Menu Assignment
* 没有显式 Tax Classification，但存在可解析 Default
* 跨 Domain Reference 尚未配置完成

### 68.9 Publish Validation Matrix

Publish 必须通过：

1. Default Locale Name 存在
2. Internal Code 唯一且有效
3. 至少一个符合目标 Scope 的 Active / Publishable SKU，除非 Product Type 明确无需 SKU
4. Variant 与 SKU Mapping 无悬空组合
5. Option Binding Selection Rule 可满足
6. 必需 Media 已完成处理
7. Tax Classification 可解析
8. Version Scope 唯一且无歧义重叠
9. Effective Period 有效
10. Change Impact 已完成
11. 必需 Approval 已通过
12. 所有 Hard Error 已清零

Warning 可以按 Policy 允许发布，但必须记录 Override Actor 与 Reason；Hard Error 永不允许 Override。

### 68.10 Concurrency 与 Draft Ownership

* 所有 Update Command 必须携带 Expected Aggregate Version / ETag
* 同一 Product 默认只允许一个可编辑主 Draft；并行区域 Draft 必须有明确 Scope，且不得重叠
* Draft 可以由多人协作，但保存采用乐观并发
* 冲突时返回 Changed Fields、Current Version 与 Refresh Requirement
* UI 可以辅助合并非冲突字段，但最终必须重新 Validate
* 不允许 Last-write-wins 静默覆盖

---

## 69. Product Query, Projection and API Contract

### 69.1 Product Search Profile

Search Profile ID：`SEARCH-CAT-PRODUCT-V1`。

Searchable Fields：

| Field | Match Mode | Normalization | Notes |
| --- | --- | --- | --- |
| Product Name | Prefix + Partial | Unicode normalization、case fold、locale-aware | 搜索所有授权 Locale |
| Internal Code | Exact + Prefix | Trim、case-insensitive normalized code | Exact result priority higher |
| SKU Name | Prefix + Partial | Locale-aware | 来自 Product Search Projection |
| SKU Code | Exact + Prefix | Code normalization | Permission-trimmed |
| Barcode | Exact | Remove allowed formatting separators | 不做模糊匹配 |
| External Reference | Exact + Prefix | Provider-specific normalization | 只返回有权限字段 |

Rules：

* Search 先应用 Brand Tenant Scope
* Store Scope 只影响结果可用性 /覆盖摘要，不改变 Product Ownership
* 默认不包含 Archived
* 搜索结果不得因索引过期绕过源对象权限
* Exact Code / Barcode Match 排在普通文本相关性之前
* 空 Query 不触发全文搜索，返回默认 Sort 结果

### 69.2 Product Filter Contract

Supported Filters：

* `lifecycle_status`
* `publishing_status`
* `product_type`
* `category_id`
* `has_active_sku`
* `sellable_status`
* `assigned_menu_id`
* `store_id` / `store_coverage`
* `tax_classification_id`
* `missing_image`
* `missing_translation_locale`
* `has_draft`
* `has_validation_error`
* `has_change_impact`
* `updated_from` / `updated_until`
* `created_from` / `created_until`
* `include_archived`

Filter Set 使用：

* 不同字段默认 AND
* 同一多值字段默认 OR
* Range 使用闭区间 / 开区间语义必须在 Contract 中明确
* 无权限 Filter 返回 Forbidden Field，不静默忽略
* Invalid Filter 返回结构化 Validation Error

### 69.3 Product Sort Contract

允许 Sort：

* `name`
* `internal_code`
* `lifecycle_status`
* `publishing_status`
* `updated_at`
* `created_at`
* `active_sku_count`

默认：`updated_at DESC, product_id ASC`。

所有 Sort 必须追加稳定 Tie-breaker `product_id ASC`，保证 Cursor Pagination 不重复、不跳行。

### 69.4 Pagination Contract

* 使用 Cursor Pagination
* `limit` 默认 50，最小 1，最大 200
* Cursor 绑定 Tenant、Filter、Sort 与最后一行排序值
* Cursor 为不透明值，客户端不得解析
* Filter / Sort 改变后旧 Cursor 失效
* 返回 `next_cursor`、`has_more` 与可选 `estimated_total`
* Exact Total 仅在成本可控或用户明确请求时计算

### 69.5 Product Search Projection

Projection Name：`catalog_product_search_v1`。

必须包含：

* Product ID
* Brand ID
* Internal Code
* Product Type
* Localized Display Names
* Primary Category ID / Name Snapshot
* Lifecycle Status
* Effective Version ID / Status
* Draft Version ID / Validation Summary
* Active SKU Count
* SKU Search Tokens
* Barcode Exact Tokens
* Assigned Menu Count
* Store Coverage Summary
* Sellable Status Summary
* Tax Classification ID / Display Snapshot
* Media Status
* Translation Completeness
* Updated At / By
* Created At / By
* Projection Updated At

Projection 通过 Catalog Event 与授权的跨 Module Projection Feed 更新；不得直接跨 Module Join 私有表。

Freshness Target：

* 正常目标：Command Commit 后 5 秒内
* Detail Command 成功响应返回 Source Aggregate Result，不等待 Projection
* Projection 超过 30 秒未更新时显示 Stale Indicator
* Projection 可从 Source of Truth 重建

### 69.6 Product Detail Projection

`catalog_product_detail_v1` 是 Read Model，不是 Source of Truth。

包含：

* Stable Product Identity
* 当前 Lifecycle
* Effective Version 与 Scope
* Draft Version 与 Validation Result
* Localized Content
* Media Summary
* Category / Tag
* Variant / SKU Summary
* Option Binding Summary
* Menu / Availability / Tax Related Projection
* Version Timeline Summary
* Pending Approval / Task
* Last Audit Summary

敏感或无权限 Related Data 必须省略并返回 Field Availability Metadata，不返回伪造空值。

### 69.7 Product REST Query Contract

第一版 Query：

* `GET /api/v1/catalog/products`
* `GET /api/v1/catalog/products/{productId}`
* `GET /api/v1/catalog/products/{productId}/versions`
* `GET /api/v1/catalog/products/{productId}/versions/{versionId}`
* `GET /api/v1/catalog/products/{productId}/history`
* `GET /api/v1/catalog/products/{productId}/impact`
* `GET /api/v1/catalog/products/{productId}/compare?fromVersion=&toVersion=`
* `GET /api/v1/catalog/product-picker`

所有 Query 继承 API Blueprint 的 Tenant Context、Error Envelope、Field Masking、Pagination、Locale 与 Correlation ID 规范。

### 69.8 Product Command Contract

第一版 Command：

* `POST /api/v1/catalog/products`
* `POST /api/v1/catalog/products/{productId}/drafts`
* `PATCH /api/v1/catalog/products/{productId}/drafts/{versionId}`
* `POST /api/v1/catalog/products/{productId}/drafts/{versionId}:validate`
* `POST /api/v1/catalog/products/{productId}/drafts/{versionId}:submit-review`
* `POST /api/v1/catalog/products/{productId}/drafts/{versionId}:approve`
* `POST /api/v1/catalog/products/{productId}/drafts/{versionId}:reject`
* `POST /api/v1/catalog/products/{productId}/drafts/{versionId}:publish`
* `POST /api/v1/catalog/products/{productId}/drafts/{versionId}:schedule-publish`
* `POST /api/v1/catalog/products/{productId}/drafts/{versionId}:reschedule-publish`
* `POST /api/v1/catalog/products/{productId}/drafts/{versionId}:cancel-scheduled-publish`
* `POST /api/v1/catalog/products/{productId}:duplicate`
* `POST /api/v1/catalog/products/{productId}:suspend`
* `POST /api/v1/catalog/products/{productId}:resume`
* `POST /api/v1/catalog/products/{productId}:discontinue`
* `POST /api/v1/catalog/products/{productId}:archive`
* `POST /api/v1/catalog/products/{productId}:restore`

Command Rules：

* Create、Duplicate、Publish、Lifecycle 与 Import Commit 必须支持 Idempotency Key
* Update Draft 使用 Expected Version / If-Match
* 危险 Command 必须包含 Reason Code / Text
* Command 成功只声明 Source Aggregate 已提交；Projection Read-your-write 通过返回 Resource Snapshot 或 Operation Reference 处理
* Action 是否允许由 Domain / Workflow 判断，不由路由名称决定

### 69.9 Product Event Contract

最小 Event：

* `ProductCreated`
* `ProductDraftUpdated`
* `ProductValidationCompleted`
* `ProductReviewSubmitted`
* `ProductVersionApproved`
* `ProductVersionRejected`
* `ProductVersionPublishScheduled`
* `ProductVersionPublishRescheduled`
* `ProductVersionPublishScheduleCancelled`
* `ProductVersionPublished`
* `ProductVersionSuperseded`
* `ProductSuspended`
* `ProductResumed`
* `ProductDiscontinued`
* `ProductArchived`
* `ProductRestored`

Event 不包含完整敏感 Draft；Payload 保存稳定引用、Version、Scope、Result Summary 与必要 Snapshot，遵循 Event Blueprint 的 Schema Version、Outbox、Idempotency 与 Replay 规则。

---

## 70. SKU Screen, Field and Contract Specification

### 70.1 Source of Truth Clarification

以已 Freeze 的 Catalog Domain 为准：

* SKU 是 Product Aggregate 内部 Entity，不是独立 Aggregate Root
* SKU 拥有可跨 Product Version 保持稳定的 SKU ID
* SKU 可以作为独立 Business Object 被搜索、查看和引用
* SKU Command 必须通过 Product Aggregate / Catalog Application Service 执行
* `RMS-CAT-SKU` Registry 中的 `SKU Aggregate / Product-owned SKU Boundary` 统一解释为 `Product-owned SKU Entity Boundary`

该澄清修正 Registry 用词歧义，不改变 Aggregate Boundary。

### 70.2 SKU Screen Matrix

| Matrix Item | Screen ID | Pattern | Route Intent | Primary Persona | Permission | Contract / Projection | Phase | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| List / Explorer | `CAT-SKU-LIST` | Master List | `/catalog/skus` | Owner、Catalog Manager、Store Manager、Analyst | `catalog.sku.read` | `ListSkus` / `catalog_sku_search_v1` | Phase 1 | Active |
| Detail | `CAT-SKU-DETAIL` | Master Detail | `/catalog/skus/:skuId` | Owner、Catalog Manager、Store Manager、Analyst | `catalog.sku.read` | `GetSkuDetail` / `catalog_sku_detail_v1` | Phase 1 | Active |
| Create | `CAT-SKU-CREATE` | Create Form | `/catalog/products/:productId/skus/new` | Owner、Catalog Manager、Catalog Editor | `catalog.sku.create` | `CreateSku` via Product Aggregate | Phase 1 | Active |
| Edit | `CAT-SKU-EDIT` | Edit Form | `/catalog/skus/:skuId/edit` | Owner、Catalog Manager、Catalog Editor | `catalog.sku.update` | `UpdateSkuDraft` | Phase 1 | Active |
| Duplicate / Clone | `CAT-SKU-DUPLICATE` | Guided Dialog | SKU Detail Action | Owner、Catalog Manager、Catalog Editor | `catalog.sku.create` | `DuplicateSkuAsDraft` | Phase 1 | Active |
| Archive / Deactivate | `CAT-SKU-ARCHIVE` | Impact Dialog | SKU Detail / List Action | Owner、Catalog Manager | `catalog.sku.archive` | `ArchiveSku` + Impact Result | Phase 1 | Active |
| Restore / Reactivate | `CAT-SKU-RESTORE` | Guided Dialog | Archived SKU Action | Owner、Catalog Manager | `catalog.sku.restore` | `RestoreSku` | Phase 1 | Active |
| History / Timeline | `CAT-SKU-HISTORY` | History Timeline | `/catalog/skus/:skuId/history` | Owner、Catalog Manager、Auditor | `catalog.sku.history.read` | `ListSkuHistory` / History Projection | Phase 1 | Active |
| Audit | `CAT-SKU-AUDIT` | Audit Drawer | SKU Detail Related View | Owner、Auditor | `audit.catalog.sku.read` | `ListAuditEntries` / Audit Projection | Phase 1 | Active |
| Import | `CAT-SKU-IMPORT` | Import Wizard | `/catalog/skus/import` | Owner、Catalog Manager、Catalog Editor | `catalog.sku.import` | `ValidateSkuImport`、`CommitSkuImport` | Phase 1 | Active |
| Export | `CAT-SKU-EXPORT` | Export Dialog / Job | SKU List Action | Owner、Catalog Manager、Analyst | `catalog.sku.export` | `CreateSkuExport` / `catalog_sku_search_v1` | Phase 1 | Active |
| Compare | `CAT-SKU-COMPARE` | Version Compare | `/catalog/skus/:skuId/compare` | Owner、Catalog Manager、Approver | `catalog.sku.history.read` | `CompareSkuConfiguration` | Phase 1 | Active |
| Related Object Picker | `CAT-SKU-PICKER` | Lookup Picker | Embedded / Modal | Authorized Editor | `catalog.sku.read` | `SearchSkuPicker` / `catalog_sku_picker_v1` | Phase 1 | Active |
| Workflow / Approval | `CAT-SKU-WORKFLOW` | Product Draft Workflow Panel | Product Draft Context | Catalog Manager、Approver | Product publish permissions | Product Version Workflow / Draft Projection | Phase 1 | Active; inherited from Product Aggregate |
| Replacement | `CAT-SKU-REPLACEMENT` | Guided High-risk Action | `/catalog/skus/:skuId/replacement` | Owner、Catalog Manager | `catalog.sku.replace` | Replacement Commands / `catalog_sku_replacement_chain_v1` | Phase 1 | Active |
| Variant Matrix | `CAT-SKU-VARIANT-MATRIX` | Editable Matrix | Product Detail / Edit Tab | Catalog Manager、Catalog Editor | `catalog.sku.update` | Generate / Map SKU Combination Draft | Phase 1 | Active |
| Barcode Management | `CAT-SKU-BARCODE` | Related Record Editor | SKU Detail Tab | Catalog Manager、Catalog Editor、Data Steward | `catalog.sku.barcode.manage` | Add / Retire Barcode | Phase 1 | Active |
| Availability | `CAT-SKU-AVAILABILITY` | Related Configuration | SKU Detail Tab | Catalog Manager、Store Manager | `catalog.sku.availability.manage` | Availability Contract | Phase 1 | Active |

### 70.3 SKU List Contract

Default Columns：

* SKU Name
* SKU Code
* Parent Product
* Variant Summary
* Primary Barcode
* Lifecycle Status
* Sellable Status
* Replacement Status
* Store Coverage
* Base Price Reference Status
* Recipe Mapping Status
* Inventory Mapping Status
* Updated At

Optional Columns：

* SKU ID
* Product ID / Code
* All Barcodes
* External Reference
* Unit of Sale
* Tax Classification Result
* Active Menu Count
* Created At / By
* Updated By
* Replacement Target
* Replacement Effective From

Row Actions：View、Edit、Duplicate、Suspend、Discontinue、Archive、Restore、Manage Barcode、Schedule Replacement、Manage Availability。

Bulk Actions：Export、Suspend、Discontinue、Assign Availability Policy；Replacement、Barcode Identity Change 与 Archive 不支持无差别批量执行。

### 70.4 SKU Stable Fields

| Field Key | Type | Required | Editable Rule | Validation |
| --- | --- | --- | --- | --- |
| `sku_id` | Stable ID | System | Never | Unique; never reused |
| `product_id` | Product Reference | Yes | Never after create | Same Brand; valid Product Aggregate |
| `brand_id` | Tenant Context | System | Never | Derived from Product |
| `sku_code` | Text | Yes | Draft; controlled correction after use | Brand-unique; normalized; 1–64 chars |
| `lifecycle` | State | System | Action only | Valid SKU transition |
| `created_at` / `created_by` | Audit Metadata | System | Never | UTC / Actor Snapshot |

### 70.5 SKU Configuration Fields

| Field Key | Section | Required | Rule |
| --- | --- | --- | --- |
| `localized_name` | Localization | Conditional | Can derive from Product + Variant; explicit override supported; default locale result must resolve |
| `variant_value_ids` | Variant | Conditional | Exactly one value for each required Product Variant Dimension; combination unique within Product |
| `unit_of_sale` | Selling Unit | Yes | Registered unit; changing semantic unit after use requires new SKU |
| `unit_quantity` | Selling Unit | Yes | Greater than zero; precision follows unit policy |
| `barcode_records` | Identifier | No | Each active barcode unique within Brand / registered global scope; type and checksum validated when applicable |
| `external_references` | Integration | No | Provider + Reference unique according to provider contract |
| `media_reference_override` | Media | No | Same rules as Product Media; fallback to Product allowed |
| `tax_classification_override` | Tax | No | If absent inherit Product / Pricing Tax policy; reference only |
| `availability_policy_reference` | Availability | No | Reference only; Catalog does not store inventory balance |
| `recipe_mapping_summary` | Related | Read-only | Owned by Recipe; displayed through Projection |
| `inventory_mapping_summary` | Related | Read-only | Owned by Inventory / Recipe; not written by SKU Form |
| `price_reference_summary` | Related | Read-only | Owned by Pricing; no price value stored in SKU Entity |
| `replacement_summary` | Replacement | Read-only in main form | Mutated only through Replacement Workflow |

### 70.6 SKU Identity Change Rule

必须创建新 SKU，而不是修改原 SKU Identity 的情况：

* Unit of Sale 语义改变
* 规格含义根本改变
* Variant Combination 的统计口径改变
* 条码 / 外部标识需要独立销售与报表口径
* 原 SKU 被新的销售单位接替

可以保留 SKU ID 的情况：

* 展示名称、描述或图片变化
* 不改变销售单位含义的翻译修正
* Barcode 追加替代标识且报表口径不变
* 可逆的 Availability、Lifecycle 或 Display 变化

当规则不确定时，默认创建新 SKU，并在影响评审中说明是否建立 Replacement Relationship。

### 70.7 Variant Matrix Rules

Variant Matrix 显示：

* Dimension / Value Axis
* Combination Status
* Existing SKU ID / Code
* Generate Candidate
* Duplicate Combination Error
* Missing Required Combination（仅 Policy 要求时）
* Inactive / Archived Combination

规则：

* Matrix 只是 Product Aggregate Draft 的编辑辅助，不直接批量写独立 SKU Aggregate
* 只有明确选中的有效组合生成 SKU
* 生成前展示预览 Code / Name，但最终 Code 仍必须通过唯一性验证
* 已经进入交易历史的组合删除时只能停用 / Discontinue SKU
* Dimension / Value 变化必须先执行 SKU Impact Analysis

### 70.8 Barcode Record

每个 Barcode Record 保存：

* Barcode Record ID
* SKU ID
* Barcode Namespace：`CATALOG_SELLABLE`
* Scanner Context：Selling / Menu Lookup / Catalog Administration
* Barcode Type：UPC-A、EAN-13、EAN-8、Code 128、QR Payload Reference、Internal
* Normalized Value
* Display Value
* Status：Active、Retired、Voided
* Effective From
* Retired At / Reason
* Created By / At

规则：

* Active Barcode 不允许指向多个 Active SKU
* Retired Barcode 默认不重新分配，除非受控 Data Steward Action 明确允许
* 格式支持 Check Digit 时必须校验
* Barcode 修改通过 Add + Retire 表达，不覆盖历史记录
* Voided 只用于错误录入纠正，并保留原值与审计

跨 Domain Barcode Resolution：

* v0.1 Namespace 固定为 `CATALOG_SELLABLE`、`INVENTORY_RECEIVING`、`LOGISTICS`、`DEVICE` 与 `EXTERNAL_REFERENCE`
* Active 唯一性键是 `brand_id + namespace + normalized_value`；全球分配的 GTIN 仍额外执行格式与受控全局冲突检查
* Selling / POS / Customer Menu Scan 只解析 `CATALOG_SELLABLE`
* Receiving / Count / Inventory Lookup 只解析 `INVENTORY_RECEIVING`
* 同一物理值出现在不同 Namespace 时允许保存，但必须通过显式 SKU ↔ Inventory Item Mapping 关联；不得自动认定为同一业务对象
* 缺少 Scanner Context 的通用搜索如果命中多个 Namespace，返回 `BARCODE_AMBIGUOUS` 与候选类型，不静默选中
* Barcode 历史扫描事实保存当时的 Namespace、Resolved Object ID、Record ID 与 Occurred At

### 70.9 Replacement Interaction

Replacement Screen 分为四步：

1. 选择 Target SKU
2. 设置 Effective From 与 Reason Code
3. 查看 Replacement Chain 与 Change Impact
4. Confirm / Schedule

必须显示：

* Source SKU Identity / Lifecycle
* Target SKU Identity / Lifecycle
* Direct Replacement 与 Final Replacement
* 是否跨 Product
* Menu、Bundle、Pricing、Recipe、Inventory、Availability 引用摘要
* 未解决 Warning 与生成的 Task
* Effective From
* Reason Code / Note

提交验证完全继承 Section 12.1：

* 禁止 Self Reference、Cycle、Cross-brand 与不存在目标
* 每个 Source 同时最多一个非 Cancelled、非 Voided Direct Relationship
* 目标如果在 Effective From 已被替代，必须指向该时间点最终有效 SKU
* 生效前允许修改 Target、Effective From、Reason 与 Note
* 生效后只能 Void，再创建正确关系
* Replacement 不自动迁移任何跨 Domain Reference

### 70.10 SKU Validation Matrix

| Rule ID | Trigger | Severity | Rule |
| --- | --- | --- | --- |
| `SKU-001` | Create / Save | Error | Parent Product 有效且同 Brand |
| `SKU-002` | Create / Save | Error | SKU Code Brand-unique |
| `SKU-003` | Create / Save | Error | Unit Quantity > 0 且 Precision 合法 |
| `SKU-004` | Save | Error | Variant Combination 在 Product 内唯一 |
| `SKU-005` | Save | Error | 每个 Required Dimension 恰好一个 Value |
| `SKU-006` | Barcode Add | Error | Active Barcode 唯一且格式有效 |
| `SKU-007` | Publish | Error | SKU Lifecycle 可用于目标 Product Version |
| `SKU-008` | Publish | Warning / Policy Error | Pricing、Recipe、Inventory、Menu Reference 完整性 |
| `SKU-009` | Replace | Error | Replacement Chain 无循环且同 Brand |
| `SKU-010` | Discontinue | Warning | 必须展示全部 Active Reference Impact |
| `SKU-011` | Archive | Error | Lifecycle 转换满足 Draft 或 Discontinued 前置条件 |
| `SKU-012` | Update | Error | Expected Product Aggregate Version 匹配 |

### 70.11 SKU Search / Filter / Sort

Search Profile ID：`SEARCH-CAT-SKU-V1`。

Search：

* SKU Name：Prefix + Partial
* SKU Code：Exact + Prefix
* Barcode：Exact
* Product Name / Code：Prefix + Partial / Exact
* External Reference：Exact + Prefix

Filters：

* Product ID / Category
* Lifecycle Status
* Sellable Status
* Variant Dimension / Value
* Has Barcode / Barcode Type
* Replacement Status
* Has Price Reference
* Has Recipe Mapping
* Has Inventory Mapping
* Store Coverage
* Updated Date
* Include Archived

Sort：SKU Name、SKU Code、Product Name、Lifecycle、Updated At、Created At。

默认：`updated_at DESC, sku_id ASC`；Pagination 继承 Product Cursor Contract。

### 70.12 SKU Projection and API

Projection：

* `catalog_sku_search_v1`
* `catalog_sku_detail_v1`
* `catalog_sku_picker_v1`
* `catalog_sku_replacement_chain_v1`

Query：

* `GET /api/v1/catalog/skus`
* `GET /api/v1/catalog/skus/{skuId}`
* `GET /api/v1/catalog/skus/{skuId}/history`
* `GET /api/v1/catalog/skus/{skuId}/replacement`
* `GET /api/v1/catalog/skus/{skuId}/replacement-chain?asOf=`
* `GET /api/v1/catalog/sku-picker`

Command：

* `POST /api/v1/catalog/products/{productId}/skus`
* `PATCH /api/v1/catalog/products/{productId}/skus/{skuId}`
* `POST /api/v1/catalog/skus/{skuId}:duplicate`
* `POST /api/v1/catalog/skus/{skuId}:activate`
* `POST /api/v1/catalog/skus/{skuId}:suspend`
* `POST /api/v1/catalog/skus/{skuId}:resume`
* `POST /api/v1/catalog/skus/{skuId}:discontinue`
* `POST /api/v1/catalog/skus/{skuId}:archive`
* `POST /api/v1/catalog/skus/{skuId}:restore`
* `POST /api/v1/catalog/skus/{skuId}/barcodes`
* `POST /api/v1/catalog/skus/{skuId}/barcodes/{barcodeRecordId}:retire`
* `POST /api/v1/catalog/skus/{skuId}/barcodes/{barcodeRecordId}:void`
* `POST /api/v1/catalog/skus/{skuId}/replacement`
* `PATCH /api/v1/catalog/skus/{skuId}/replacement/{relationshipId}`
* `POST /api/v1/catalog/skus/{skuId}/replacement/{relationshipId}:cancel`
* `POST /api/v1/catalog/skus/{skuId}/replacement/{relationshipId}:void`

所有 Mutation 通过 Product Aggregate / Catalog Application Service 执行并使用 Expected Aggregate Version；路由按 Business Object 提供入口，不改变 Source of Truth。

### 70.13 SKU Events

最小 Event：

* `SkuCreated`
* `SkuConfigurationUpdated`
* `SkuActivated`
* `SkuSuspended`
* `SkuResumed`
* `SkuDiscontinued`
* `SkuArchived`
* `SkuRestored`
* `SkuBarcodeAdded`
* `SkuBarcodeRetired`
* `SkuBarcodeVoided`
* `SkuReplacementScheduled`
* `SkuReplacementBecameEffective`
* `SkuReplacementCancelled`
* `SkuReplacementVoided`

---

## 71. Category, Option Set and Lookup Picker Specification

### 71.1 Category Screen Matrix

| Matrix Item | Screen ID | Pattern | Route Intent | Primary Persona | Permission | Contract / Projection | Phase | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| List / Explorer | `CAT-CATEGORY-LIST` | Master List + Tree | `/catalog/categories` | Owner、Catalog Manager、Catalog Editor | `catalog.category.read` | `ListCategories` / `catalog_category_tree_v1` | Phase 1 | Active |
| Detail | `CAT-CATEGORY-DETAIL` | Master Detail | `/catalog/categories/:categoryId` | Owner、Catalog Manager、Catalog Editor、Analyst | `catalog.category.read` | `GetCategoryDetail` / `catalog_category_search_v1` | Phase 1 | Active |
| Create | `CAT-CATEGORY-CREATE` | Create Form | `/catalog/categories/new` | Owner、Catalog Manager、Catalog Editor | `catalog.category.create` | `CreateCategory` | Phase 1 | Active |
| Edit | `CAT-CATEGORY-EDIT` | Edit Form | `/catalog/categories/:categoryId/edit` | Owner、Catalog Manager、Catalog Editor | `catalog.category.update` | `UpdateCategory` | Phase 1 | Active |
| Duplicate / Clone | Not Applicable | — | — | — | — | Category tree identity is created explicitly | Phase 1 | Explicit N/A |
| Archive / Deactivate | `CAT-CATEGORY-ARCHIVE` | Impact Dialog | Category Detail / Tree Action | Owner、Catalog Manager | `catalog.category.archive` | `DeactivateCategory`、`ArchiveCategory` + Impact Result | Phase 1 | Active |
| Restore / Reactivate | `CAT-CATEGORY-RESTORE` | Guided Dialog | Archived Category Action | Owner、Catalog Manager | `catalog.category.restore` | `RestoreCategory` | Phase 1 | Active |
| History / Timeline | `CAT-CATEGORY-HISTORY` | History Timeline | `/catalog/categories/:categoryId/history` | Owner、Catalog Manager、Auditor | `catalog.category.history.read` | `ListCategoryHistory` / History Projection | Phase 1 | Active |
| Audit | `CAT-CATEGORY-AUDIT` | Audit Drawer | Category Detail Related View | Owner、Auditor | `audit.catalog.category.read` | `ListAuditEntries` / Audit Projection | Phase 1 | Active |
| Import | `CAT-CATEGORY-IMPORT` | Import Wizard | `/catalog/categories/import` | Owner、Catalog Manager、Catalog Editor | `catalog.category.import` | `ValidateCategoryImport`、`CommitCategoryImport` | Phase 1 | Active |
| Export | `CAT-CATEGORY-EXPORT` | Export Dialog / Job | Category List Action | Owner、Catalog Manager、Analyst | `catalog.category.export` | `CreateCategoryExport` / Tree Projection | Phase 1 | Active |
| Compare | Not Applicable | — | — | — | — | Timeline and audit provide v0.1 change inspection | Phase 1 | Explicit N/A |
| Related Object Picker | `CAT-CATEGORY-PICKER` | Lookup Picker + Tree | Embedded / Modal | Authorized Editor | `catalog.category.read` | `SearchCategoryPicker` / `catalog_category_tree_v1` | Phase 1 | Active |
| Workflow / Approval | `CAT-CATEGORY-WORKFLOW` | Publish Panel | Category Detail Panel | Catalog Manager、Approver | category submit / approve permissions | Category Publishing Commands | Phase 1 | Active when policy requires |
| Operational Action | `CAT-CATEGORY-REORDER` | Tree Reorder | Category Tree Action | Catalog Manager、Catalog Editor | `catalog.category.reorder` | `MoveCategory`、`ReorderCategory` | Phase 1 | Active |

### 71.2 Category Fields and Rules

Fields：

* Category ID：system、stable
* Brand ID：tenant context
* Internal Code：required、Brand-unique
* Localized Name：default locale required
* Localized Description：optional
* Parent Category ID：optional
* Level：system derived
* Sort Order：required within sibling scope
* Store Applicability：optional scoped assignment
* Lifecycle：Draft、Active、Inactive、Archived
* Media Reference：optional
* External References：optional

Rules：

* 第一版最多三级
* Parent 必须同 Brand
* 禁止 Self Parent 与 Cycle
* Move 后整个子树深度不得超过三级
* 一个 Product 可以属于多个 Category
* Category 不等于 Menu Section，不保存 Menu Placement
* Archive Parent 前必须处理或一并影响评估 Active Child
* Archive 不移除历史 Product / Order Snapshot
* Internal Code 在 Archive 后仍不自动释放

Search：Name、Internal Code、External Reference。

Filters：Lifecycle、Level、Parent、Store Applicability、Has Product、Empty、Missing Translation、Archived。

Sort：Tree Order、Name、Internal Code、Updated At。

Projection：`catalog_category_tree_v1`、`catalog_category_search_v1`。

### 71.3 Option Set Screen Matrix

| Matrix Item | Screen ID | Pattern | Route Intent | Primary Persona | Permission | Contract / Projection | Phase | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| List / Explorer | `CAT-OPTIONSET-LIST` | Master List | `/catalog/option-sets` | Owner、Catalog Manager、Catalog Editor | `catalog.option_set.read` | `ListOptionSets` / `catalog_option_set_search_v1` | Phase 1 | Active |
| Detail | `CAT-OPTIONSET-DETAIL` | Master Detail | `/catalog/option-sets/:optionSetId` | Owner、Catalog Manager、Catalog Editor、Analyst | `catalog.option_set.read` | `GetOptionSetDetail` / `catalog_option_set_detail_v1` | Phase 1 | Active |
| Create | `CAT-OPTIONSET-CREATE` | Create Form | `/catalog/option-sets/new` | Owner、Catalog Manager、Catalog Editor | `catalog.option_set.create` | `CreateOptionSet` | Phase 1 | Active |
| Edit | `CAT-OPTIONSET-EDIT` | Configuration Editor | `/catalog/option-sets/:optionSetId/edit` | Owner、Catalog Manager、Catalog Editor | `catalog.option_set.update` | Create / Update Option Set Draft | Phase 1 | Active |
| Duplicate / Clone | `CAT-OPTIONSET-DUPLICATE` | Guided Dialog | Option Set Detail Action | Owner、Catalog Manager、Catalog Editor | `catalog.option_set.create` | `DuplicateOptionSetAsDraft` | Phase 1 | Active |
| Archive / Deactivate | `CAT-OPTIONSET-ARCHIVE` | Impact Dialog | Option Set Detail Action | Owner、Catalog Manager | `catalog.option_set.archive` | `ArchiveOptionSet` + Impact Result | Phase 1 | Active |
| Restore / Reactivate | `CAT-OPTIONSET-RESTORE` | Guided Dialog | Archived Option Set Action | Owner、Catalog Manager | `catalog.option_set.restore` | `RestoreOptionSet` | Phase 1 | Active |
| History / Timeline | `CAT-OPTIONSET-HISTORY` | History Timeline | `/catalog/option-sets/:optionSetId/history` | Owner、Catalog Manager、Auditor | `catalog.option_set.history.read` | `ListOptionSetHistory` / History Projection | Phase 1 | Active |
| Audit | `CAT-OPTIONSET-AUDIT` | Audit Drawer | Option Set Detail Related View | Owner、Auditor | `audit.catalog.option_set.read` | `ListAuditEntries` / Audit Projection | Phase 1 | Active |
| Import | `CAT-OPTIONSET-IMPORT` | Import Wizard | `/catalog/option-sets/import` | Owner、Catalog Manager、Catalog Editor | `catalog.option_set.import` | `ValidateOptionSetImport`、`CommitOptionSetImport` | Phase 1 | Active |
| Export | `CAT-OPTIONSET-EXPORT` | Export Dialog / Job | Option Set List Action | Owner、Catalog Manager、Analyst | `catalog.option_set.export` | `CreateOptionSetExport` / Search Projection | Phase 1 | Active |
| Compare | `CAT-OPTIONSET-COMPARE` | Version Compare | `/catalog/option-sets/:optionSetId/compare` | Owner、Catalog Manager、Approver | `catalog.option_set.history.read` | `CompareOptionSetVersions` | Phase 1 | Active |
| Related Object Picker | `CAT-OPTIONSET-PICKER` | Lookup Picker | Embedded / Modal | Authorized Editor | `catalog.option_set.read` | `SearchOptionSetPicker` / `catalog_option_set_picker_v1` | Phase 1 | Active |
| Workflow / Approval | `CAT-OPTIONSET-PUBLISH` | Configuration Publish | Option Set Detail / Edit Panel | Catalog Manager、Approver | submit / approve / publish permissions | Option Set Publishing Commands | Phase 1 | Active |
| Operational Action | Not Applicable | — | — | — | — | No independent operational action in v0.1 | Phase 1 | Explicit N/A |

### 71.4 Option Set Fields

Stable Fields：

* Option Set ID
* Brand ID
* Internal Code
* Lifecycle
* Created By / At

Version Fields：

* Localized Name / Description
* Display Style Hint：Single Choice、Multi Choice、Quantity；只表达业务交互语义，不指定 UI Component
* Minimum Selection
* Maximum Selection
* Allow Repeated Option
* Per-option Maximum Quantity
* Option Set Maximum Total Quantity
* Option Records
* Conditional Rule
* Conflict Rule
* Effective Scope / Period

每个 Option 保存：

* Option ID 与 Stable Code
* Localized Name / Description
* Sort Order
* Default Eligibility
* Quantity Rule
* Media Reference
* Pricing Rule Reference
* Inventory / Recipe Consumption Reference
* Triggered Option Set Reference
* Conflict References
* Lifecycle

### 71.5 Option Set Validation

* Minimum 必须大于等于 0
* Maximum 为空表示按 Policy 无显式上限；有值时必须大于等于 Minimum
* Default Selection 数量必须位于最终 Min / Max 内
* Disabled Option 不得作为 Default
* Per-option Maximum 不得超过 Option Set Maximum Total
* Triggered Option Set 不得形成无限循环
* Conflict Rule 不得同时要求与禁止同一组合
* Product Binding Override 只能在允许范围内调整
* Published Version 不直接覆盖，创建新 Draft Version
* 被 Active Product Binding 引用的 Option Identity 不物理删除
* Publish 前必须运行 Rule Satisfiability Check

Search：Option Set Name、Internal Code、Option Name、Option Code。

Filters：Lifecycle、Publishing Status、Selection Type、Has Product Binding、Has Pricing Reference、Has Inventory / Recipe Reference、Missing Translation、Archived。

Projection：`catalog_option_set_search_v1`、`catalog_option_set_detail_v1`、`catalog_option_set_picker_v1`。

### 71.6 Lookup Picker Contract

所有 Catalog Lookup Picker 继承统一 Contract：

* `picker_type`
* Tenant / Brand Context
* Optional Store Context
* Search Query
* Structured Filters
* Excluded IDs
* Preselected IDs
* Single / Multi Selection
* Maximum Selection Count
* Required Capability / Permission
* Cursor / Limit
* Locale
* As-of / Effective Context（适用时）

Picker Result 至少包含：

* Object ID
* Primary Display Name
* Secondary Identifier
* Status
* Scope / Availability Summary
* Selection Disabled Flag
* Disabled Reason Code
* Optional Thumbnail

### 71.7 Picker Behavior

* 输入 250 ms 后 Debounce；Exact Code / Barcode 可以立即执行
* 默认 Limit 25，最大 100
* 最近使用只保存 Object ID 与 User Preference，不绕过权限复验
* Selected Item 即使不在当前页也必须保留并显示
* 已失效 Selected Item 显示 Invalid 状态，不静默删除
* 禁止选择的结果可以显示，但必须附原因；敏感对象按权限完全隐藏
* Multi-select 支持批量移除和 Clear，危险替换必须单独确认
* Keyboard Navigation、Focus、Screen Reader Label 与触控目标符合 Pattern Accessibility Rule

### 71.8 Picker APIs

* `GET /api/v1/catalog/product-picker`
* `GET /api/v1/catalog/sku-picker`
* `GET /api/v1/catalog/category-picker`
* `GET /api/v1/catalog/option-set-picker`
* `GET /api/v1/catalog/option-picker`

Picker API 只返回选择所需最小 Projection，不返回完整对象，也不能作为绕过 Detail Permission 的后门。

### 71.9 Category API Contract

Query：

* `GET /api/v1/catalog/categories`
* `GET /api/v1/catalog/categories/{categoryId}`
* `GET /api/v1/catalog/categories/{categoryId}/history`
* `GET /api/v1/catalog/category-picker`

Command：

* `POST /api/v1/catalog/categories`
* `PATCH /api/v1/catalog/categories/{categoryId}`
* `POST /api/v1/catalog/categories/{categoryId}:move`
* `POST /api/v1/catalog/categories/{categoryId}:reorder`
* `POST /api/v1/catalog/categories/{categoryId}:deactivate`
* `POST /api/v1/catalog/categories/{categoryId}:archive`
* `POST /api/v1/catalog/categories/{categoryId}:restore`

Move / Reorder 使用 Expected Aggregate Version 和 Parent / Sibling Version，避免并发树更新产生重复 Sort Order。

### 71.10 Option Set API Contract

Query：

* `GET /api/v1/catalog/option-sets`
* `GET /api/v1/catalog/option-sets/{optionSetId}`
* `GET /api/v1/catalog/option-sets/{optionSetId}/versions`
* `GET /api/v1/catalog/option-sets/{optionSetId}/history`
* `GET /api/v1/catalog/option-set-picker`
* `GET /api/v1/catalog/option-picker`

Command：

* `POST /api/v1/catalog/option-sets`
* `POST /api/v1/catalog/option-sets/{optionSetId}/drafts`
* `PATCH /api/v1/catalog/option-sets/{optionSetId}/drafts/{versionId}`
* `POST /api/v1/catalog/option-sets/{optionSetId}/drafts/{versionId}:validate`
* `POST /api/v1/catalog/option-sets/{optionSetId}/drafts/{versionId}:submit-review`
* `POST /api/v1/catalog/option-sets/{optionSetId}/drafts/{versionId}:approve`
* `POST /api/v1/catalog/option-sets/{optionSetId}/drafts/{versionId}:reject`
* `POST /api/v1/catalog/option-sets/{optionSetId}/drafts/{versionId}:publish`
* `POST /api/v1/catalog/option-sets/{optionSetId}/drafts/{versionId}:schedule-publish`
* `POST /api/v1/catalog/option-sets/{optionSetId}/drafts/{versionId}:reschedule-publish`
* `POST /api/v1/catalog/option-sets/{optionSetId}/drafts/{versionId}:cancel-scheduled-publish`
* `POST /api/v1/catalog/option-sets/{optionSetId}:duplicate`
* `POST /api/v1/catalog/option-sets/{optionSetId}:archive`
* `POST /api/v1/catalog/option-sets/{optionSetId}:restore`

Events：`CategoryCreated`、`CategoryUpdated`、`CategoryMoved`、`CategoryReordered`、`CategoryDeactivated`、`CategoryArchived`、`CategoryRestored`；`OptionSetCreated`、`OptionSetUpdated`、`OptionSetValidated`、`OptionSetReviewSubmitted`、`OptionSetApproved`、`OptionSetRejected`、`OptionSetPublishScheduled`、`OptionSetPublishRescheduled`、`OptionSetPublishScheduleCancelled`、`OptionSetPublished`、`OptionSetArchived`、`OptionSetRestored`。正式 Event Type 在 Event Catalog 使用稳定 PascalCase 名称与版本。

---

## 72. Inventory Item Screen, Field and Contract Specification

### 72.1 Ownership Boundary

Inventory Item 是 Inventory Module 的 Master Data Aggregate / Source of Truth，与 SKU 分离。

Inventory Item Form 负责：

* 物料身份
* 计量单位与换算
* 库存追踪策略
* Lot / Expiry Policy
* Negative Stock Policy
* Storage Requirement
* Reorder Policy Reference / Store Override
* Barcode 与外部 Reference

Inventory Item Form 不直接修改：

* Stock Balance
* Stock Movement
* Purchase Order
* Supplier Contract / Price
* Recipe Definition
* SKU Definition
* Accounting Ledger

相关信息通过 Projection、Related Screen 或对应 Domain Action 展示。

### 72.2 Inventory Item Screen Matrix

| Matrix Item | Screen ID | Pattern | Route Intent | Primary Persona | Permission | Contract / Projection | Phase | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| List / Explorer | `INV-ITEM-LIST` | Master List | `/inventory/items` | Owner、Inventory Manager、Store Manager、Analyst | `inventory.item.read` | `ListInventoryItems` / `inventory_item_search_v1` | Phase 2 | Active |
| Detail | `INV-ITEM-DETAIL` | Master Detail | `/inventory/items/:itemId` | Owner、Inventory Manager、Store Manager、Analyst | `inventory.item.read` | `GetInventoryItemDetail` / `inventory_item_detail_v1` | Phase 2 | Active |
| Create | `INV-ITEM-CREATE` | Create Form | `/inventory/items/new` | Owner、Inventory Manager、Inventory Editor | `inventory.item.create` | `CreateInventoryItem` | Phase 2 | Active |
| Edit | `INV-ITEM-EDIT` | Edit Form | `/inventory/items/:itemId/edit` | Owner、Inventory Manager、Inventory Editor | `inventory.item.update` | `UpdateInventoryItem` | Phase 2 | Active |
| Duplicate / Clone | `INV-ITEM-DUPLICATE` | Guided Dialog | Inventory Item Detail Action | Owner、Inventory Manager、Inventory Editor | `inventory.item.create` | `DuplicateInventoryItem` | Phase 2 | Active |
| Archive / Deactivate | `INV-ITEM-ARCHIVE` | Impact Dialog | Inventory Item List / Detail Action | Owner、Inventory Manager | `inventory.item.deactivate` / `inventory.item.archive` | `DeactivateInventoryItem`、`ArchiveInventoryItem` + Impact Result | Phase 2 | Active |
| Restore / Reactivate | `INV-ITEM-RESTORE` | Guided Dialog | Archived Item Action | Owner、Inventory Manager | `inventory.item.restore` | `RestoreInventoryItem` | Phase 2 | Active |
| History / Timeline | `INV-ITEM-HISTORY` | History Timeline | `/inventory/items/:itemId/history` | Owner、Inventory Manager、Auditor | `inventory.item.history.read` | Item Configuration History Projection | Phase 2 | Active |
| Audit | `INV-ITEM-AUDIT` | Audit Drawer | Inventory Item Detail Related View | Owner、Auditor | `audit.inventory.item.read` | Audit Projection | Phase 2 | Active |
| Import | `INV-ITEM-IMPORT` | Import Wizard | `/inventory/items/import` | Owner、Inventory Manager、Inventory Editor | `inventory.item.import` | `ValidateInventoryItemImport`、`CommitInventoryItemImport` | Phase 2 | Active |
| Export | `INV-ITEM-EXPORT` | Export Dialog / Job | Inventory Item List Action | Owner、Inventory Manager、Analyst | `inventory.item.export` | `CreateInventoryItemExport` / `inventory_item_search_v1` | Phase 2 | Active |
| Compare | `INV-ITEM-COMPARE` | Configuration Compare | `/inventory/items/:itemId/compare` | Owner、Inventory Manager、Auditor | `inventory.item.history.read` | `CompareInventoryItemRevision` | Phase 2 | Active |
| Related Object Picker | `INV-ITEM-PICKER` | Lookup Picker | Embedded / Modal | Authorized Editor | `inventory.item.read` | `SearchInventoryItemPicker` / `inventory_item_picker_v1` | Phase 2 | Active |
| Workflow / Approval | `INV-ITEM-POLICY-REVIEW` | High-risk Change Review | Inventory Item Detail / Edit Panel | Inventory Manager、Approver | tracking / unit policy permissions | Tracking / Unit Policy Revision Workflow | Phase 2 | Active when policy requires |
| Reorder Settings | `INV-ITEM-REORDER` | Related Configuration | Inventory Item Detail Tab | Inventory Manager、Store Manager | `inventory.item.reorder.manage` | Reorder Policy Commands / `inventory_reorder_status_v1` | Phase 2 | Active |
| Supplier Mapping | `INV-ITEM-SUPPLIER-MAPPING` | Related Record | Inventory Item Detail Tab | Procurement Manager、Inventory Manager | Procurement mapping permission | Supplier Mapping Cross-module Contract | Phase 2 | Active |
| Stock History | `INV-ITEM-STOCK-HISTORY` | Transaction Explorer | `/inventory/items/:itemId/movements` | Inventory Manager、Store Manager、Auditor | `inventory.movement.read` | Stock Movement Projection | Phase 2 | Active |
| Stock Count | `INV-STOCK-COUNT` | Operational Workbench | `/inventory/counts` | Inventory Manager、Store Manager、Counter | `inventory.count.execute` | Stock Count Commands / Count Projection | Phase 2 | Active; separate resource |
| Adjustment | `INV-STOCK-ADJUSTMENT` | Guided High-risk Action | Inventory Item / Stock Context Action | Inventory Manager、Authorized Manager | `inventory.adjustment.execute` | Post Adjustment Command | Phase 2 | Active; separate resource |
| Transfer | `INV-STOCK-TRANSFER` | Operational Workbench | `/inventory/transfers` | Inventory Manager、Store Manager | `inventory.transfer.execute` | Transfer Commands / Transfer Projection | Phase 2 | Active; separate resource |
| Waste | `INV-WASTE-RECORD` | Operational Entry | `/inventory/waste` | Inventory Manager、Store Manager、Authorized Staff | `inventory.waste.record` | Record Waste Command | Phase 2 | Active; separate resource |

### 72.3 Inventory Item List

Default Columns：

* Item Name
* Internal Code
* Item Type
* Base Unit
* Tracking Mode
* Lot / Expiry Policy
* On Hand
* Reserved
* Available
* In Transit
* Below Reorder Point
* Preferred Supplier Summary
* Status
* Updated At

Rules：

* Quantity Columns 必须带 Unit
* 数量必须绑定明确 `Stock Scope`：Store、Stock Site 或 Location；不能只有 Brand Context
* 未选择 Stock Scope 时，列表仍可显示 Item Identity，但必须隐藏 On Hand、Reserved、Available、In Transit 与 Reorder Status，禁用 Quantity Filter / Sort / Stock Action，并显示 `Location Scope Missing`
* 默认数量按当前 Store / Stock Site Context 汇总；只有用户偏好中仍有权限且当前有效的 Scope 才可作为默认值
* 跨 Store 汇总必须明确标记，不把不同 Unit / Conversion 混合
* Balance 来自 Stock Projection，不是 Inventory Item Aggregate Field
* Projection Stale 时数量列显示 Freshness，不允许用旧值执行未经回源验证的 Adjustment

Row Actions：View、Edit、Deactivate、Archive、Restore、Manage Reorder、View Movements、Start Count、Adjust、Transfer、Record Waste。

危险 Action：Adjustment、Archive、Unit Conversion Change、Tracking Policy Change 必须显示影响并要求 Reason。

### 72.4 Inventory Item Detail

Header：

* Item Name
* Internal Code
* Status
* Base Unit
* Tracking Policy
* Store / Site Scope
* Current Availability Summary
* Last Updated

Tabs：

1. Overview
2. Units and Conversions
3. Tracking and Lot / Expiry
4. Stock by Location
5. Movements
6. Reorder Policies
7. Supplier Mappings
8. Recipe / SKU Usage
9. Counts and Adjustments
10. History

Stock、Movement、Count、Supplier 与 Recipe Tab 使用各自 Module / Projection Contract；Item Detail 不获得跨 Module Write Ownership。

### 72.5 Inventory Item Stable Fields

| Field Key | Type | Required | Editable Rule | Validation |
| --- | --- | --- | --- | --- |
| `inventory_item_id` | Stable ID | System | Never | Unique; never reused |
| `brand_id` | Tenant Context | Yes | Never | Valid Brand scope |
| `internal_code` | Text | Yes | Draft; controlled correction after movement exists | Brand-unique; 1–64 chars; normalized |
| `item_type` | Enum | Yes | Before first movement; later change impact / new item when semantics change | Raw Material、Packaging、Semi-finished、Finished Good、Non-food Supply |
| `lifecycle` | State | System | Action only | Active、Inactive、Archived transition |
| `created_at` / `created_by` | Metadata | System | Never | UTC / Actor Snapshot |
| `aggregate_version` | Integer / ETag | System | Never directly | Required on mutation |

### 72.6 Inventory Item Descriptive Fields

| Field Key | Type | Required | Rule |
| --- | --- | --- | --- |
| `localized_name` | Locale Map | Yes | Default locale required; 1–120 chars |
| `localized_description` | Locale Map | No | Sanitized content |
| `category_reference` | Inventory Classification | No | Inventory-owned classification; not Catalog Category unless explicit reference type |
| `barcode_records` | Identifier Set | No | Active barcode unique in applicable scope |
| `external_references` | Provider Reference Set | No | Provider + Reference uniqueness |
| `storage_requirement` | Structured Policy | No | Temperature / humidity / hazard / segregation references |
| `allergen_handling_reference` | Compliance Reference | No | Reference only; controlled vocabulary |
| `notes` | Operational Text | No | No secret or unnecessary PII |

Inventory Item Barcode Record 固定声明 `Barcode Namespace = INVENTORY_RECEIVING` 及 Receiving / Count Scanner Context，并遵循 Section 70.8 的跨 Domain Resolution Rule。

### 72.7 Unit of Measure Registry

每个 Inventory Item 必须声明一个 Base Stock Unit。

Base Unit Fields：

* Unit Code
* Measurement Dimension：Count、Mass、Volume、Length、Area 或 Other Controlled Unit
* Display Precision
* Ledger Precision
* Rounding Mode

Additional Unit Conversion：

* From Unit
* To Base Unit
* Multiplier / Rational Conversion
* Effective From
* Source / Reason
* Status

Rules：

* 同一 Item 的可转换 Unit 必须属于兼容 Measurement Dimension，除非使用经批准的 Item-specific Conversion
* Conversion Factor 必须大于 0
* Ledger 使用 Decimal，不使用 Binary Floating Point
* Base Unit 在存在 Stock Movement 后不得直接改变
* 需要改变 Base Unit 时创建受控 Unit Migration，或创建新 Inventory Item 并转移余额；不得重写历史 Movement
* Conversion Revision 只影响新 Movement；历史 Movement 保存当时 Conversion Snapshot
* Purchase / Receiving Unit 可以由 Procurement Mapping 提供，但 Inventory 保存实际 Receiving Conversion Snapshot

### 72.8 Tracking and Lot / Expiry Fields

| Field Key | Required | Values / Rule |
| --- | --- | --- |
| `stock_tracking_enabled` | Yes | Boolean; disabled item 不生成 Stock Ledger |
| `lot_tracking_mode` | Yes | No Lot、Lot Optional、Lot Required、Lot + Expiry Required |
| `default_shelf_life` | No | Positive duration; only default, actual lot expiry can differ |
| `expiry_warning_days` | Conditional | Non-negative; required when expiry monitoring enabled |
| `issue_policy` | Yes when tracked | FEFO when expiry exists; otherwise FIFO / Policy-defined |
| `negative_stock_policy` | Yes | Block、Manager Override、Allow with Warning |
| `reservation_policy_reference` | No | Defines reservation / consumption timing; versioned reference |
| `serial_tracking` | v0.1 N/A | Explicitly Not Applicable for restaurant inventory v0.1 |

Policy Change Rules：

* No Lot → Required 只影响生效后的 Receiving；现有未分 Lot 余额必须先生成 Migration / Exception Plan
* Required → Optional / No Lot 属于高影响变更，必须保留历史 Lot 事实
* Lot + Expiry Item Receiving 缺少 Expiry 必须拒绝
* Negative Stock Policy 不能追溯合法化已有异常；旧异常继续保留
* Policy Change 必须保存 Effective From、Reason、Actor 与 Impact Result

### 72.9 Reorder Policy Fields

Reorder Policy 不是全局单值，可以按 Store / Stock Site / Location Scope 配置。

Fields：

* Reorder Policy ID
* Inventory Item ID
* Scope Type / Scope ID
* Reorder Point
* Safety Stock
* Target Stock Level
* Minimum Order Quantity Hint
* Order Multiple Hint
* Lead Time Hint
* Preferred Supplier Mapping Reference
* Enabled
* Effective Period
* Override Source

Rules：

* 所有数量使用 Item Base Unit 或明确的可转换 Unit
* Reorder Point、Safety Stock、Target Stock 不得为负
* Target Stock 必须大于等于 Reorder Point
* Minimum Order Quantity 与 Order Multiple 大于 0
* Preferred Supplier Mapping 由 Procurement 拥有，Inventory 只保存 Reference
* Reorder Alert 不自动创建 Purchase Order，除非未来明确启用并通过 Approval Policy
* 多层 Policy 按 Platform / Brand / Store Overlay 解析；同 Scope 不允许歧义重叠

### 72.10 SKU, Recipe and Supplier Relationships

SKU / Inventory Item：

* 可以一对一映射成品，但身份仍分离
* 多个 SKU 可以消耗同一 Inventory Item
* Mapping 通过 Recipe / Inventory Reference Contract 表达

Recipe / Inventory Item：

* Recipe 拥有 Ingredient Usage Definition
* Inventory Item Detail 可以显示 Recipe Usage Projection
* Inventory Item 不反向写 Recipe

Supplier / Inventory Item：

* Procurement 拥有 Supplier Item Mapping、Purchase Unit、Price 与 Contract
* Inventory Item Detail 通过 Cross-module Query 显示 Mapping Summary
* Inventory Item Form 不直接修改 Supplier Price

### 72.11 Inventory Item Validation Matrix

| Rule ID | Trigger | Severity | Rule |
| --- | --- | --- | --- |
| `INV-I-001` | Create | Error | Brand Context 与 Permission 有效 |
| `INV-I-002` | Create / Update | Error | Internal Code Brand-unique |
| `INV-I-003` | Create | Error | Base Unit 与 Measurement Dimension 有效 |
| `INV-I-004` | Unit Conversion | Error | Factor > 0 且 Dimension 兼容 |
| `INV-I-005` | Update | Error | 有历史 Movement 后禁止直接改变 Base Unit |
| `INV-I-006` | Tracking Change | Error / Guided Migration | Existing Balance 与新 Policy 兼容 |
| `INV-I-007` | Reorder Save | Error | Target >= Reorder Point >= 0 |
| `INV-I-008` | Archive | Error | 无未完成 Count、Transfer、Receiving 或 Reservation |
| `INV-I-009` | Archive | Warning / Policy Error | On Hand / Reserved / In Transit 不为零 |
| `INV-I-010` | Deactivate | Warning | 显示 Recipe、SKU、Supplier 与 Reorder Impact |
| `INV-I-011` | Update | Error | Expected Aggregate Version 匹配 |
| `INV-I-012` | Import | Error | Unit、Tracking、Code 与 Scope 全部可解析 |

### 72.12 Lifecycle Rules

* Active：允许 Receiving、Reservation、Consumption 与 Movement
* Inactive：禁止新的普通 Receiving / Reservation；允许完成既有 Transfer、释放 Reservation 与受控 Adjustment
* Archived：默认从普通列表隐藏，只允许历史查询、Audit 与受控 Restore
* On Hand、Reserved 或 In Transit 不为零时默认禁止 Archive
* Restore 从 Archived 回到 Inactive，不直接 Active
* Item Semantic Meaning 根本改变时创建新 Inventory Item，不复用旧 ID

### 72.13 Inventory Item Search Profile

Search Profile ID：`SEARCH-INV-ITEM-V1`。

Search：

* Item Name：Prefix + Partial
* Internal Code：Exact + Prefix
* Barcode：Exact
* Supplier Item Code：Exact + Prefix，来自授权 Projection
* External Reference：Exact + Prefix

Filters：

* Item Type
* Lifecycle
* Stock Site / Location
* Tracking Mode
* Lot Required
* Expiry Required
* Negative Stock Policy
* Below Reorder Point
* Out of Stock
* Has On Hand
* Preferred Supplier
* Has Recipe Usage
* Has SKU Mapping
* Missing Reorder Policy
* Updated Date
* Include Archived

Sort：Name、Internal Code、Available Quantity、On Hand、Reorder Status、Updated At、Created At。

Quantity Sort 必须绑定单一 Store / Stock Site Context 与 Base Unit；跨不兼容 Scope 时拒绝 Quantity Sort。

`Below Reorder Point`、`Out of Stock`、`Has On Hand`、Quantity Sort 与任何数量范围 Filter 在没有 `stock_scope_type + stock_scope_id` 时返回 `INV_STOCK_SCOPE_REQUIRED`，不得以 Brand-wide 隐式汇总代替。

### 72.14 Inventory Projections

* `inventory_item_search_v1`
* `inventory_item_detail_v1`
* `inventory_item_picker_v1`
* `inventory_stock_overview_v1`
* `inventory_item_usage_v1`
* `inventory_reorder_status_v1`

`inventory_item_search_v1` 包含：

* Inventory Item Identity / Name / Code / Type
* Base Unit
* Tracking / Lot / Expiry / Negative Stock Policy
* Lifecycle
* Store / Site scoped On Hand、Reserved、Available、In Transit
* Reorder Status
* Preferred Supplier Summary
* Recipe / SKU Usage Summary
* Updated At / By
* Projection Freshness

Stock Ledger 仍是事实来源；Projection 可以重建，任何 Adjustment Command 必须回源检查当前 Balance Version。

### 72.15 Inventory Item APIs

Query：

* `GET /api/v1/inventory/items`
* `GET /api/v1/inventory/items/{itemId}`
* `GET /api/v1/inventory/items/{itemId}/history`
* `GET /api/v1/inventory/items/{itemId}/stock`
* `GET /api/v1/inventory/items/{itemId}/movements`
* `GET /api/v1/inventory/items/{itemId}/usage`
* `GET /api/v1/inventory/item-picker`

`GET /api/v1/inventory/items` 的 Identity-only 查询允许不带 Stock Scope；一旦请求 Quantity Column、Quantity Filter、Quantity Sort、Reorder Status 或 Stock Action Link，必须同时携带 `stock_scope_type` 与 `stock_scope_id`。响应回显 resolved scope 与 projection freshness。

Command：

* `POST /api/v1/inventory/items`
* `PATCH /api/v1/inventory/items/{itemId}`
* `POST /api/v1/inventory/items/{itemId}:duplicate`
* `POST /api/v1/inventory/items/{itemId}:deactivate`
* `POST /api/v1/inventory/items/{itemId}:archive`
* `POST /api/v1/inventory/items/{itemId}:restore`
* `POST /api/v1/inventory/items/{itemId}/barcodes`
* `POST /api/v1/inventory/items/{itemId}/barcodes/{barcodeRecordId}:retire`
* `POST /api/v1/inventory/items/{itemId}/barcodes/{barcodeRecordId}:void`
* `POST /api/v1/inventory/items/{itemId}/unit-conversions`
* `POST /api/v1/inventory/items/{itemId}/tracking-policy-revisions`
* `PUT /api/v1/inventory/items/{itemId}/reorder-policies/{scopeType}/{scopeId}`

Count、Adjustment、Transfer、Waste 与 Movement 使用独立 Operational Resource / Command，不嵌入 Item Edit Command。

### 72.16 Inventory Item Events

最小 Event：

* `InventoryItemCreated`
* `InventoryItemUpdated`
* `InventoryItemDeactivated`
* `InventoryItemArchived`
* `InventoryItemRestored`
* `InventoryItemBarcodeAdded`
* `InventoryItemBarcodeRetired`
* `InventoryItemBarcodeVoided`
* `InventoryUnitConversionAdded`
* `InventoryTrackingPolicyChanged`
* `ReorderPolicyChanged`
* `ReorderThresholdBreached`
* `InventoryItemBackInStock`

Event 只发布配置或业务事实，不发布可由 Consumer 任意覆盖的 Current Quantity。

### 72.17 Inventory Screen States

除通用 Screen State 外，Inventory 必须支持：

* Stock Projection Stale
* Location Scope Missing
* Unit Conversion Missing
* Count In Progress
* Reservation Conflict
* Negative Stock Exception
* Lot / Expiry Data Incomplete
* Reorder Policy Inherited / Overridden
* Movement Posted but Projection Pending
* High-risk Command Requires Manager Override

---

## 73. Core Workflow and Process Registry

### 73.1 Registry Purpose

Workflow / Process Registry 位于 Business Object Registry 与 Business Screen 之间，用于固定：

* Trigger
* Actor
* Preconditions
* Business Actions
* Business Objects
* Commands
* Events
* Exception Paths
* Completion Outcome
* KPI / SLA

Workflow Registry 不复制 Aggregate State Machine；Domain 仍是合法状态转换的最终来源。

### 73.2 Workflow Entry Contract

每个 Entry 保存：

* Workflow ID
* Workflow Name
* Primary Capability ID
* Owning Module
* Actor / Persona
* Trigger
* Preconditions
* Input Object / Version
* Ordered Actions
* Commands
* Events
* Approval / Task / Notification
* Success Outcome
* Exception / Compensation
* Idempotency Scope
* Audit Category
* Screen IDs
* KPI / SLA
* Phase
* Status

### 73.3 Workflow Catalog

| Workflow ID | Name | Capability | Primary Object | Phase | Status |
| --- | --- | --- | --- | --- | --- |
| `WF-CAT-001` | Create Product Draft | Catalog Management | Product | Phase 1 | Active |
| `WF-CAT-002` | Validate and Publish Product Version | Catalog Management | Product Version | Phase 1 | Active |
| `WF-CAT-003` | Change Product Lifecycle | Catalog Management | Product | Phase 1 | Active |
| `WF-CAT-004` | Create or Update SKU | Catalog Management | SKU | Phase 1 | Active |
| `WF-CAT-005` | Replace SKU | Catalog Management | SKU Replacement | Phase 1 | Active |
| `WF-CAT-006` | Maintain Category Tree | Catalog Management | Category | Phase 1 | Active |
| `WF-CAT-007` | Publish Option Set Version | Catalog Management | Option Set | Phase 1 | Active |
| `WF-CAT-008` | Import Catalog Master Data | Catalog Management | Import Job | Phase 1 | Active |
| `WF-INV-001` | Create Inventory Item | Inventory Management | Inventory Item | Phase 2 | Active |
| `WF-INV-002` | Change Inventory Tracking Policy | Inventory Management | Inventory Item Policy Revision | Phase 2 | Active |
| `WF-INV-003` | Maintain Reorder Policy | Inventory Management | Reorder Policy | Phase 2 | Active |
| `WF-INV-004` | Deactivate or Archive Inventory Item | Inventory Management | Inventory Item | Phase 2 | Active |
| `WF-INV-005` | Import Inventory Items | Inventory Management | Import Job | Phase 2 | Active |

### 73.4 WF-CAT-001 — Create Product Draft

Trigger：Authorized user selects Create Product or duplicates an existing Product.

Actors：Owner、Catalog Manager、Catalog Editor。

Preconditions：

* Brand Context resolved
* `catalog.product.create` allowed
* Idempotency Key valid
* Required Lookup references readable

Actions：

1. Enter minimum Identity and default-language content
2. Validate structure and Internal Code uniqueness
3. Create stable Product Identity
4. Create Draft Product Version
5. Write Audit and Outbox Event
6. Return Product / Draft resource snapshot

Commands：`CreateProduct` or `DuplicateProductAsDraft`。

Events：`ProductCreated`；Duplicate additionally records Source Product / Version Reference in Audit, not as identity ancestry unless specifically modeled.

Success：User lands on Product Edit with Draft saved.

Exceptions：Duplicate Code、invalid tenant、permission denied、idempotency conflict、reference invalid。

KPI：Create Success Rate、Validation Failure Rate、Median Time to First Saved Draft。

### 73.5 WF-CAT-002 — Validate and Publish Product Version

Trigger：User selects Validate、Submit Review、Approve、Publish or Schedule.

Actors：Catalog Editor、Catalog Manager、Approver、System Scheduler。

Preconditions：

* Draft exists and Expected Version matches
* Structural validation passed
* Actor has action-specific permission
* Scope / Effective Period can resolve uniquely

Actions：

1. Run Product / SKU / Variant / Option validation
2. Run cross-domain Change Impact checks
3. Classify Errors / Warnings
4. If Policy requires, create Approval Request
5. On approval, pin referenced configuration / media versions
6. Publish immediately or schedule
7. At Effective Time, mark new version Published and previous overlapping version Superseded where applicable
8. Emit Event and update Projection asynchronously

Commands：Validate Draft、Submit Review、Approve、Reject、Publish、Schedule Publish、Reschedule Publish、Cancel Scheduled Publish。

Events：`ProductValidationCompleted`、`ProductReviewSubmitted`、`ProductVersionApproved`、`ProductVersionRejected`、`ProductVersionPublishScheduled`、`ProductVersionPublishRescheduled`、`ProductVersionPublishScheduleCancelled`、`ProductVersionPublished`、`ProductVersionSuperseded`。

Exception Paths：

* Validation Error：remain Draft
* Approval Rejected：return to Draft / Changes Requested
* Schedule Conflict：reject schedule
* Reference changed before publish：revalidate and block
* Projection lag：source publish remains committed; show pending projection

Success：Target context resolves exactly one Published Product Version.

KPI：Draft Aging、Validation Failure Rate、Approval Cycle Time、Publish Failure Rate。

### 73.6 WF-CAT-003 — Change Product Lifecycle

Actions：Suspend、Resume、Discontinue、Archive、Restore。

Rules：

* Suspend is reversible and affects new submit validation, not accepted historical Orders
* Discontinue prevents new sales reference according to Product / SKU rule and requires Impact Review
* Archive is historical retention, not delete
* Restore returns to Draft / Inactive and requires validation before publish
* Reason required for Suspend、Discontinue、Archive、Restore

Commands：`SuspendProduct`、`ResumeProduct`、`DiscontinueProduct`、`ArchiveProduct`、`RestoreProduct`。

Events：`ProductSuspended`、`ProductResumed`、`ProductDiscontinued`、`ProductArchived`、`ProductRestored`。

Exception：Active references may create Warning、Approval or Block according to policy; no automatic cross-domain rewrite.

### 73.7 WF-CAT-004 — Create or Update SKU

Preconditions：Product exists、same Brand、actor permission、Product Aggregate version matches.

Actions：

1. Select / confirm Product
2. Define SKU Code、Variant Combination and Unit of Sale
3. Add optional Barcode / Reference
4. Validate identity and combination uniqueness
5. Save in Product Aggregate Draft
6. Emit SKU fact and refresh Product / SKU Projection

Semantic unit change routes to Create New SKU, not Update.

### 73.8 WF-CAT-005 — Replace SKU

Preconditions：Source SKU stable、Target valid、same Brand、no cycle、permission allowed.

Actions：

1. Select Target
2. Set Effective From、Reason Code、Note
3. Resolve chain at Effective From
4. Run Change Impact
5. Confirm / Schedule
6. Create Direct Replacement Relationship
7. Generate tasks / warnings for affected references
8. At effective time publish effective fact

Commands：Schedule、Update Before Effective、Cancel Before Effective、Void After Effective。

Events：Section 12.1 Event set.

Compensation：After effective configuration error, Void old relationship and create correct new relationship; never mutate historical relation.

### 73.9 WF-CAT-006 — Maintain Category Tree

Actions：Create、Rename、Move、Reorder、Deactivate、Archive、Restore.

Preconditions：Same Brand、maximum depth、no cycle、permission.

Move / Archive must run Product and Child Category Impact. Menu Section is not automatically moved.

Success：Tree Projection has deterministic sibling order and valid maximum depth.

### 73.10 WF-CAT-007 — Publish Option Set Version

Actions：Create Draft、Edit Options / Rules、Validate Satisfiability、Impact Review、Approve、Publish.

Critical Validation：

* Min / Max consistent
* Defaults valid
* Conditional / Conflict graph satisfiable
* Trigger graph has no forbidden cycle
* Active Product Binding remains compatible or receives explicit migration task

Success：Published Option Set Version is immutable and resolvable by Product Binding.

### 73.11 WF-CAT-008 — Import Catalog Master Data

Stages：Upload → Scan → Parse → Map → Validate → Preview → Approve → Commit → Result.

Rules：

* Upload never writes source objects directly
* Every row receives deterministic Row ID and Result
* Validation separates Error / Warning
* User can download error file without exposing unauthorized data
* Commit uses Import Job ID + Idempotency Key
* Partial Commit default disabled for Product / SKU graph; if enabled later, successful unit boundaries must be explicit
* Re-run with same input and key does not duplicate objects

Success Result：Created、Updated、Skipped、Failed counts plus per-row reason.

### 73.12 WF-INV-001 — Create Inventory Item

Actions：Enter Identity → Base Unit → Tracking Policy → Validate → Create → optionally add Reorder / Supplier Mapping.

Create does not add Opening Balance. Opening Balance uses controlled Stock Movement / Count workflow.

Success：Active or Inactive Inventory Item exists with no fabricated stock.

### 73.13 WF-INV-002 — Change Tracking Policy

Trigger：Manager edits Lot、Expiry、Negative Stock、Reservation or Base Unit-related policy.

Preconditions：Permission、Reason、Expected Version、Impact Result.

Actions：

1. Compare current and proposed policy
2. Inspect On Hand / Lot / Reservation / Open Movement
3. Classify as direct-safe、migration-required or prohibited
4. If migration required, create Task / Plan
5. Approve and set Effective From
6. Apply only to future facts

History remains unchanged. Prohibited Base Unit direct change routes to Unit Migration / New Item process.

### 73.14 WF-INV-003 — Maintain Reorder Policy

Actions：Select Scope → Set thresholds / hints → Validate Overlay → Save → recalculate Reorder Status.

Success：Each Item + Store / Site + Effective Time resolves one policy or explicit no-policy result.

Alert generation is idempotent and does not automatically create a Purchase Order.

### 73.15 WF-INV-004 — Deactivate or Archive Inventory Item

Preconditions：Impact check includes balances、reservations、transfers、counts、recipes、supplier mappings and reorder policies.

Rules：

* Deactivate can preserve balances for run-down / correction
* Archive normally requires On Hand、Reserved、In Transit = 0 and no open operation
* Override, if policy allows, requires Manager + reason and creates exception task
* Restore returns to Inactive

### 73.16 WF-INV-005 — Import Inventory Items

Inherits Catalog Import stages and additionally validates：

* Unit Registry / Conversion
* Tracking Policy
* Reorder Scope
* Duplicate Barcode / Code
* Supplier Mapping reference authorization

Opening Balance is never imported through Inventory Item Master Data Import; it uses a separate audited stock initialization workflow.

---

## 74. Cross-cutting Screen and Contract Controls

### 74.1 Permission Registry

Catalog Product：

* `catalog.product.read`
* `catalog.product.create`
* `catalog.product.update`
* `catalog.product.identity.update`
* `catalog.product.validate`
* `catalog.product.submit`
* `catalog.product.approve`
* `catalog.product.publish`
* `catalog.product.suspend`
* `catalog.product.resume`
* `catalog.product.discontinue`
* `catalog.product.archive`
* `catalog.product.restore`
* `catalog.product.import`
* `catalog.product.export`
* `catalog.product.history.read`
* `catalog.product.availability.manage`

Catalog SKU：

* `catalog.sku.read`
* `catalog.sku.create`
* `catalog.sku.update`
* `catalog.sku.barcode.manage`
* `catalog.sku.replace`
* `catalog.sku.activate`
* `catalog.sku.suspend`
* `catalog.sku.resume`
* `catalog.sku.discontinue`
* `catalog.sku.archive`
* `catalog.sku.restore`
* `catalog.sku.import`
* `catalog.sku.export`
* `catalog.sku.history.read`

Category / Option Set：use separate `catalog.category.*` and `catalog.option_set.*` namespace; Publish and Approval remain action-specific.

Inventory Item：

* `inventory.item.read`
* `inventory.item.create`
* `inventory.item.update`
* `inventory.item.barcode.manage`
* `inventory.item.unit.manage`
* `inventory.item.tracking.manage`
* `inventory.item.reorder.manage`
* `inventory.item.deactivate`
* `inventory.item.archive`
* `inventory.item.restore`
* `inventory.item.import`
* `inventory.item.export`
* `inventory.item.history.read`

Read Permission never implies Export、Update or high-risk action permission.

### 74.2 High-risk Action Registry

| Action | Risk | Required Control |
| --- | --- | --- |
| Publish Product / Option Set | Changes customer-visible configuration | Validate、Impact、Approval policy、Idempotency、Audit |
| Product / SKU Identity Correction | Breaks references / reporting | Special permission、before/after、reason、impact |
| Suspend / Discontinue / Archive | Stops new sales or hides master data | Confirmation、reason、impact、event |
| SKU Replacement | Cross-domain lineage impact | Guided workflow、chain validation、reason、tasks |
| Barcode Retire / Void | Identifier risk | Exact target、reason、audit、no silent reuse |
| Inventory Base Unit / Tracking Change | Corrupts stock semantics | Impact、migration plan、manager permission、effective date |
| Inventory Archive | Open stock / operation risk | Balance and open-operation check、reason、audit |
| Bulk Import Commit | Large-scale mutation | Preview、approval threshold、idempotency、result file、rollback strategy |
| Export | Data leakage | Field permission、scope、audit、expiry、row limit |

### 74.3 Audit Categories

必须审计：

* Create / Duplicate
* Field Update with changed field keys
* Identity Correction
* Validation and Override
* Submit / Approve / Reject / Publish / Schedule
* Lifecycle Action
* SKU Replacement Schedule / Cancel / Void
* Barcode Add / Retire / Void
* Unit / Conversion / Tracking Policy Revision
* Reorder Policy Change
* Import / Export Request and Result
* Permission Denied for high-risk action

Audit 保存 Actor、Tenant、Store Context、Object ID、Version、Action、Reason、Before / After Reference、Correlation ID、Occurred At 与 Source Channel。

### 74.4 Import Contract

每个 Import Template 必须版本化并声明：

* Template ID / Version
* Object Type
* Required / Optional Columns
* Locale / Unit / Enum Dictionary
* Create / Update Matching Key
* Blank Field Semantics
* Maximum Rows / File Size
* Validation Rules
* Partial Commit Policy
* Permission and Approval Threshold

Blank Field 默认表示“未提供”，不是“清空”。清空必须使用显式 Clear Marker，并且字段允许清空。

### 74.5 Export Contract

Export 继承当前 List Filter / Sort / Scope，并声明：

* Export Template / Columns
* Requested Locale
* Time Zone
* Unit Display
* Field Permission
* Row Count Estimate
* Synchronous / Asynchronous Mode
* Expiry

大于 10,000 行或预计超过 10 秒的 Export 使用异步 Job；阈值是 Operational Default，可在不改变 Contract 的前提下调整。

### 74.6 Localization Contract

* Locale 使用 BCP 47
* Default Locale Field 必须存在时由 Object Validation 强制
* Missing Translation 与 Fallback Translation 分开显示
* Search 支持 Unicode normalization 和 locale-aware tokenization
* API 接收 `Accept-Language` / explicit locale，但 stable code search 不受 locale 影响
* Export 明确 requested locale；不能把 fallback 文本伪装为已翻译

### 74.7 Money and Quantity Display

* Catalog Product / SKU 不拥有 Money Amount；Price 只通过 Pricing Reference / Projection 显示
* Inventory Quantity 总是同时显示 Value 与 Unit
* Decimal Precision 由 Unit / Money Contract 决定
* 前端不得使用浮点近似执行业务验证
* 任何汇总必须标记 Scope、As-of 与 Freshness

### 74.8 Accessibility Acceptance

* 全部 Form Field 有程序化 Label、Description 和 Error Association
* Validation Summary 可以跳转到错误字段
* Data Grid 支持 Keyboard Navigation 与非颜色状态提示
* Dialog 管理 Focus Trap、Return Focus 与 Escape Policy
* 高风险确认不能只依赖颜色或图标
* Lookup Picker 支持 Screen Reader Announcement
* Touch Target、Contrast 与 Zoom 继承 UX Foundation

### 74.9 Analytics Events

只记录产品改进所需最小行为，不记录 Field 内容或敏感值。

允许：

* Screen Viewed
* Search Submitted（分类 / 长度，不记录敏感原文）
* Filter Applied
* Draft Saved
* Validation Completed Summary
* Publish Started / Completed / Failed
* Import Stage Completed
* Command Error Code

禁止把 Product 描述、Barcode、Supplier Reference、PII 或自由文本 Reason 发送到非必要 Analytics。

### 74.10 Contract Acceptance Scenarios

必须通过：

1. Read-only Analyst 可以搜索 Product，但看不到 Edit / Export when unauthorized
2. Catalog Editor 保存不完整 Draft，但不能发布有 Hard Error 的 Version
3. 两个用户并发编辑同一 Draft 时，后提交者收到 Conflict，不覆盖前者
4. Product Archive 前显示 SKU、Menu、Bundle 与跨 Domain Impact
5. SKU Replacement Cycle 被拒绝，合法链按 asOf 正确解析
6. Barcode Retire 不改写历史订单扫描事实
7. Category Move 不产生超过三级或循环树
8. Option Set 不可满足的规则不能发布
9. Inventory Base Unit 在已有 Movement 后不能直接修改
10. Inventory Item Archive 不静默丢失 Balance 或 Open Operation
11. Import 重试不会重复创建对象
12. Export 只包含当前 Filter 和有权限字段
13. Projection 延迟时 UI 显示 Stale，但 Source Command Result 不被回滚
14. Archived Object 可以查询历史，但默认不出现在普通 Picker
15. 所有危险 Action 产生 Audit 与 Event / Task where required

---

## 75. Capability Coverage and Design Readiness

### 75.1 Coverage Interpretation

Coverage 百分比只表示本 Baseline 要求的设计资产是否已经存在并通过一致性检查，不表示代码已经实现、测试已经执行或产品已经经过 Pilot 验证。

状态定义：

* `100% Design Coverage`：当前 Scope 的必需设计资产完整
* `Implementation Ready`：对应 Work Package 的依赖、IDR、文件级 Scope 与 Acceptance 全部完成
* `Implemented`：代码和 Migration 已存在并通过测试
* `Pilot Validated`：真实商家场景已经验证

### 75.2 Core Object Coverage

| Object | Domain / Object | Workflow | Screen | Field / Validation | Query / Projection | API / Event | Acceptance | Implementation |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Product | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 0% |
| SKU | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 0% |
| Category | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 0% |
| Option Set / Option | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 0% |
| Inventory Item | 100% | 100% | 100% | 100% | 100% | 100% | 100% | 0% |

### 75.3 Catalog Management Capability Coverage

当前 `RMS-CAP-CATALOG-MANAGEMENT`：

| Coverage Dimension | Result | Notes |
| --- | --- | --- |
| Domain Model | Frozen | Catalog Aggregate、Version、SKU、Category、Option Set、Menu、Bundle 已 Freeze |
| Business Objects | Complete | Product、SKU、Category、Option Set / Option、Menu、Bundle、Availability、Pricing / Tax、Promotion 与 Recipe 页面 / 功能已由 Sections 67–71、88 完成；文件级实现拆分不再承担产品设计选择 |
| Workflow | Complete for core authoring | Product / SKU / Category / Option Set / Import |
| Screen | Complete for the registered Commerce scope | Master List / Detail / Form / Picker / Builder / Preview / Publish / History / Simulation / Import / Export；见 Section 88.8–88.9 |
| Field / Query Contract | Complete for core authoring | 当前对象无阻塞字段选择 |
| API / Event Contract | Complete at resource / action level | Payload Schema 在对应 Work Package 生成 |
| Database / Projection | Blueprint-ready | Ownership、Projection Name、Freshness 与 Rebuild 已定义；具体 DDL 在 WP-1020+ |
| Backlog | Defined | F10.2 / WP-1020–1027 |
| Test / Acceptance | Defined | Section 74 + Domain / API Blueprint |
| Implementation | Not Started | 0%，符合当前不写代码要求 |

Maturity：`Complete pre-code product design`；Implementation evidence remains `Not Started`。

进入 `Implementation Ready` 的下一 Gate 是对应的 `WP-1020–1027` 文件级 Specification；这不阻塞 `WP-0001`。

### 75.4 Inventory Management Capability Coverage

当前 `RMS-CAP-INVENTORY-MANAGEMENT`：

| Coverage Dimension | Result | Notes |
| --- | --- | --- |
| Domain Model | Frozen | Item、Ledger、Movement、Site、Location、Lot、Reservation、Availability |
| Inventory Item Object | Complete | Screen、Field、Tracking、Unit、Reorder、Query、API、Event |
| Operational Workflow | Complete at pre-code Screen / Function level | Receiving、Count、Adjustment、Transfer、Waste、Lot / Expiry、Replenishment 已在 Section 88.12–88.13 完成；Phase 2 Work Package 只做文件级实现拆分与证据 |
| Master Data Screen | Complete | Inventory Item List / Detail / Form / Related Views |
| Field / Query Contract | Complete for Item | Balance / Movement 保持独立事实与 Projection |
| Database / Projection | Blueprint-ready | Item 与 Stock Projection Ownership 已明确 |
| Backlog | Complete at capability-package level | Section 88.25 已登记 WP-2120–2126；Phase 2 进入时展开文件级 Scope，不重开页面设计 |
| Test / Acceptance | Defined for Item | Section 72 / 74 |
| Implementation | Not Started | 0% |

Maturity：`Complete pre-code product design for Inventory Capability`；implementation remains governed by the Phase 2 Roadmap。

### 75.5 Traceability Matrix

| Capability | Object | Workflow | Primary Screens | Projection | Backlog |
| --- | --- | --- | --- | --- | --- |
| `RMS-CAP-CATALOG-MANAGEMENT` | `RMS-CAT-PRODUCT` | `WF-CAT-001`、`002`、`003` | Product List / Detail / Create / Edit | `catalog_product_search_v1`、`detail_v1` | WP-1020、1027 |
| `RMS-CAP-CATALOG-MANAGEMENT` | `RMS-CAT-SKU` | `WF-CAT-004`、`005` | SKU List / Detail / Variant / Replacement | `catalog_sku_search_v1`、`replacement_chain_v1` | WP-1020、1027 |
| `RMS-CAP-CATALOG-MANAGEMENT` | Category | `WF-CAT-006` | Category Tree / Form / Picker | `catalog_category_tree_v1` | WP-1021、1027 |
| `RMS-CAP-CATALOG-MANAGEMENT` | Option Set / Option | `WF-CAT-007` | Option Set List / Editor / Publish / Picker | `catalog_option_set_*_v1` | WP-1022、1027 |
| `RMS-CAP-CATALOG-MANAGEMENT` | Import Job | `WF-CAT-008` | Product / SKU / Category / Option Import | Import Job Projection | WP-1027 or dedicated split |
| `RMS-CAP-INVENTORY-MANAGEMENT` | `RMS-INV-INVENTORY-ITEM` | `WF-INV-001`–`005` | Item List / Detail / Form / Reorder | `inventory_item_*_v1` | Phase 2 Inventory Backlog |

### 75.6 Readiness Result

Repository Bootstrap 的业务与架构规格没有未解决问题；但开始执行仍需要确认 Repository Location、Hosting / CI 条件、既有 Git 状态与 Branch / Worktree Strategy。它们属于 Execution Context，不得被写成已完成的产品决策。

后续仍允许通过受控流程修改：

* 新发现的业务需求：Registry / ADR / Backlog Change
* 实现工具兼容问题：IDR Revision
* 页面可用性问题：UX Variant / Field Registry Revision
* Pilot 运营差异：Capability / Workflow / Policy Revision

这些变化不得通过临时代码绕过已 Freeze Boundary。

---

## 76. Implementation Choice Resolution Before WP-0001

### 76.1 Resolution Principle

版本核对日期：`2026-07-15`。

规则：

* WP-0001 使用精确版本并写入 Lockfile / Version File
* 不自动追随 `latest`
* Patch / Minor 升级通过 Dependency PR 和验证处理
* Major 升级需要 IDR Review
* 当前选择优先考虑 Node 24 LTS、TypeScript / ESLint 兼容和 WSL2 / Linux CI / Linux production container 一致性；Windows 仅作为受支持宿主

### 76.2 WP-0001 Exact Baseline

| Tool | Decision | Status | Reason |
| --- | --- | --- | --- |
| Node.js | `24.18.0` LTS | Accepted | 当前 Active LTS；Production 使用 LTS，不选择 Node 26 Current |
| Corepack | `0.35.0` | Accepted | WSL2 Linux shell 中先更新 Corepack，再由 Corepack 激活精确 pnpm；支持当前 Node 24 baseline |
| pnpm | `11.13.0` | Accepted | Exact packageManager pin；Frozen Lockfile |
| Turborepo | `2.10.5` | Accepted | Workspace task graph baseline |
| TypeScript | `6.0.3` | Accepted | Strict baseline；与当前 `typescript-eslint` peer range 兼容 |
| ESLint | `10.7.0` | Accepted | Flat Config baseline |
| typescript-eslint | `8.64.0` | Accepted | 支持 ESLint 10 与 TypeScript `<6.1.0`；因此暂不采用 TypeScript 7.0.2 |
| Prettier | `3.9.5` | Accepted | Formatter 与 ESLint 职责分离 |
| Vitest | `4.1.10` | Accepted | Unit / Integration test runner；支持 Node 24 |
| Pino | `10.3.1` | Accepted | Minimal structured JSON logging baseline |
| CI Gate Contract | Provider-neutral checks | Accepted | Install、Lint、Type Check、Test、Architecture、Contract、Migration、Scan、Build 门禁已锁定 |
| CI Provider | GitHub Actions in new private GitHub Repository `bop-rms` | Accepted | IDR-0012；staged `main` protection、minimal `bootstrap / verify` in WP-0001、later required checks、conditional human review、OIDC deployment |

ESLint 负责代码质量规则；Prettier 只负责格式。CI 分别执行 Lint 与 Format Check，禁止把格式错误隐藏在 Lint Autofix 中。

### 76.3 Proposed IDR Resolution

此前 Proposed IDR 更新：

* `IDR-0008 Unit / Integration Test Runner` → `Accepted: Vitest 4.1.10`
* `IDR-0009 End-to-End Browser Testing` → `Accepted: Playwright 1.61.1`，在首次 E2E Work Package 安装并重新核对 Patch
* `IDR-0010 Contract Schema Source` → `Accepted: Zod-first Runtime Contract in dedicated Contract Package; OpenAPI / JSON Schema generated and checked`
* `IDR-0012 CI Provider` → `Accepted: new private GitHub Repository + GitHub Actions`
* `IDR-0013 Logging Baseline` → `Accepted: Pino 10.3.1`

不阻塞 WP-0001、且现已接受：

* `IDR-0007 ORM / Query Builder`：`Accepted — Drizzle ORM + Drizzle Kit + controlled SQL escape hatch`；首个 Persistence WP 仍验证 multi-schema / outbox transaction
* `IDR-0015 Job / Queue Runtime`：`Accepted — PostgreSQL-backed pg-boss`；Eventing WP 仍执行 reliability validation；Domain Outbox / Inbox 继续使用自有 Contract

Contract Tooling Baseline：

* Zod `4.4.3`
* `@asteasolutions/zod-to-openapi` `9.0.0`
* Breaking Change 检测、Event Schema Version 与 Consumer Contract Test 仍按 API / Event Blueprint 执行

Persistence Baseline Candidate verified：

* Drizzle ORM `0.45.2`
* Drizzle Kit `0.31.10`

Job Baseline Candidate verified：

* pg-boss `12.26.0`

这些 later-WP 版本不是 WP-0001 Dependency；安装前必须再次执行 Security、License、Engine 与 Compatibility Check。

### 76.4 Resolved v0.1 Provider Choices

Section 86 已锁定 Payment、Tax、Identity、Notification、Object Storage、Production Hosting、Observability、Deployment、Delivery / Map exclusion、BI Warehouse exclusion 与 Printer / POS SDK exclusion。所有 Provider 只能通过既定 Adapter Boundary 接入；实际账户、credential 与 production enablement 仍属于 External Execution Evidence。

### 76.5 WP-0001 Gate Result

WP-0001 的 Specification Baseline 已锁定：

* Node Exact Version
* pnpm
* Turborepo
* TypeScript
* ESLint / Prettier
* Vitest
* Provider-neutral CI Gate
* Minimal Logging Library

Specification Gate：`PASS`。

Pre-Code Decision Gate：`PASS`。

Execution Context Gate：`PENDING`。

已决定：

* 新建 private GitHub Repository `bop-rms`
* CI 使用 GitHub Actions
* staged `main` governance + short-lived feature branch + Pull Request + squash merge；required check and human-review controls are activated only when their real prerequisites exist
* 每个并行 Coding Task 使用独立 Git worktree；不得把 Library working file 放入 Repository

仍需在真正开始 WP-0001 时取得的环境事实：

* GitHub owner / organization、Repository URL、private-branch-protection plan capability 与 Reviewer availability
* 实际 local checkout root；Windows developer baseline 默认 WSL2 Linux filesystem 中的 `~/src/bop-rms`，不得默认放在 `/mnt/c`、OneDrive 或其他跨文件系统同步目录
* 新 Repository 的 clean Git status / ownership inspection evidence
* Node / pnpm / command availability evidence
* 用户明确编码授权

---

## 77. WP-0001 — First Executable Work Package Specification

### 77.1 Identity

Work Package ID：`WP-0001`。

Name：`Initialize TypeScript Monorepo and Workspace Baseline`。

Epic / Feature：`EPIC-00 / F00.1 Repository Bootstrap`。

Priority：`P0`。

Owner Role：Platform Engineer。

Reviewer Roles：Engineering Owner、DevOps Reviewer；Security Reviewer only if secret / execution policy changes.

Supported Capability：Platform Foundation and Governance；enables all BOP and RMS v0.1 capabilities.

### 77.2 Goal

建立一个最小、可重复安装、版本锁定、可扩展的 TypeScript Monorepo Root Baseline，使后续 `WP-0002–0007` 可以在不重新选择工具链的前提下创建 Workspace、应用 Skeleton、Quality Tooling 与本地环境。

### 77.3 Scope

In Scope：

* Initialize Git-aware repository root without altering unrelated user files
* Pin Node.js、pnpm and Turborepo exact versions
* Create pnpm Workspace definition
* Create root private Package Manifest
* Create and commit Lockfile
* Create initial Turborepo Task Graph contract
* Create baseline package-manager settings
* Create repository text / ignore defaults required before package installation
* Create concise root `AGENTS.md` and repository specification index according to Section 89
* Create one minimal GitHub Actions workflow whose unique required-check name is `bootstrap / verify`
* Record and execute the staged `main` protection sequence without claiming unavailable review evidence
* Document minimum setup and verification
* Verify reproducible install from clean dependency state

### 77.4 Non-goals

WP-0001 不包含：

* apps / packages implementation or business code
* Express API、React Web、PWA、Worker Skeleton
* TypeScript source files
* Database、Docker Compose、Migration or Seed
* ESLint / Prettier / Vitest full configuration（WP-0003）
* full CI matrix、deployment、environment or provider workflow；WP-0001 owns only the minimal `bootstrap / verify` workflow needed to remove the repository-governance startup cycle
* Domain Module、API Contract or Event Schema
* Production Deployment or Provider setup
* Secret、`.env` value or cloud credential

### 77.5 Required Inputs

* Repository Blueprint
* Module Blueprint
* Master Development Playbook
* IDR-0001、0002、0003、0008、0012、0013、0017、0018
* Section 76 Exact Baseline
* Current Git status and existing user changes

### 77.6 Preconditions / Definition of Ready

1. User explicitly authorizes coding
2. Target Repository location confirmed
3. Existing Git changes inspected and preserved
4. Node `24.18.0` available or install method approved
5. pnpm `11.13.0` available through exact install / package manager activation
6. No unresolved repository ownership conflict
7. No real secret present in planned files
8. WP-0001 Branch / Worktree strategy selected according to Playbook
9. Acceptance commands can run in target environment
10. GitHub owner、private-Repository plan capability and human Reviewer availability are recorded as facts；missing independent Reviewer does not block solo bootstrap, but missing Pro / Team / Enterprise capability blocks activation of the accepted private-branch protection controls
11. On Windows host，WSL2、supported Linux distribution、Linux-filesystem checkout、Bash、Git and Codex WSL agent mode are verified；WSL1 and mixed Windows / Linux tool execution against the same checkout are prohibited

Current documentation readiness：`PASS`。

Execution authorization：`NOT YET GRANTED`；用户授权完成全部 pre-code choices，但没有授权开始写代码。

Pre-Code Decision Readiness：`PASS`。Repository / CI / Branch / Worktree choices 已由 Section 86 锁定。

Execution readiness：`PENDING`，仅因实际 GitHub owner / URL / plan capability、local checkout、clean Git inspection、environment command evidence 与 coding authorization 尚未存在；这些是外部事实，不是未决设计选择。

Windows-hosted WSL2 Package Manager Bootstrap Baseline（Section 89 supersedes native-Windows execution）：

1. Host 必须运行仍受 Microsoft 支持的 Windows 11 build；Edition / lifecycle 是 execution evidence，不在规范中假定
2. 安装 / 更新 WSL2 并使用受支持的 Ubuntu LTS distribution；WSL1 不受支持
3. ChatGPT / Codex Windows app 将 Agent 切换为 WSL 后重启；primary integrated terminal 使用 WSL / Bash
4. Repository clone 到 WSL Linux filesystem `~/src/bop-rms`；Git、Node、pnpm、Docker CLI 与测试命令全部从同一 WSL distribution 执行
5. 在 WSL 中按受审安装路径安装或确认 Node.js `24.18.0` Linux x64；`.nvmrc` 是 repo pin，实际 installer / version-manager 版本记录为 environment evidence
6. 使用 Node 随附 npm 执行 `npm install --global corepack@0.35.0`，再执行 `corepack enable pnpm` 与 `corepack install --global pnpm@11.13.0`
7. 安装 `bubblewrap` 供 Codex Linux sandbox 使用；Docker Desktop 使用 WSL2 backend 并只对选定 distribution 启用 integration
8. 验证 `wsl --version` / distribution 为 version 2、`uname`、repository real path、`git`、`node`、`corepack`、`pnpm`、`docker` 与 `docker compose`；repo path 不得解析到 `/mnt/*`

如果企业设备策略禁止全局 Corepack 或 Shim 写入，不得静默改用另一个 Package Manager；记录环境限制并通过 IDR-0001 Revision 批准等价的 exact-version 安装方式。

### 77.7 File-level Deliverables

| Path | Purpose | Required Content |
| --- | --- | --- |
| `package.json` | Root manifest | private、name、packageManager exact pin、engines、minimum root scripts / Turbo entry only |
| `pnpm-workspace.yaml` | Workspace discovery | `apps/*`、`packages/*`、`tooling/*` patterns; no generated package required |
| `pnpm-lock.yaml` | Reproducible dependency graph | Generated by pnpm 11.13.0; never hand-edited |
| `turbo.json` | Task graph contract | build、dev、lint、typecheck、test、test:integration、format:check task names; outputs / cache intent |
| `.npmrc` | Package manager policy | engine / lock / workspace policy; no registry token |
| `.nvmrc` | Node pin | exactly `24.18.0` |
| `.gitignore` | Repository exclusions | node_modules、build、coverage、local env、logs、IDE / OS noise without hiding required fixtures |
| `.gitattributes` | Line ending / text policy | consistent LF for repository-controlled text and lockfile |
| `.editorconfig` | Editor baseline | charset、newline、indent and final newline |
| `AGENTS.md` | Durable Codex / agent repository guidance | Section 89 concise root contract；commands、scope、architecture、verification、security、Git and handoff rules；不得复制整份 Handoff Package |
| `docs/spec/README.md` | Repository specification index | authoritative Section / WP references、decision precedence、how a Coding Agent obtains the current task brief；no Library credential / signed URL |
| `docs/spec/work-packages/WP-0001.md` | Executable bootstrap brief | only WP-0001 scope、file set、acceptance、commands、evidence and exclusions extracted from the authoritative Handoff Package；no unrelated future scope |
| `.github/workflows/bootstrap.yml` | Startup CI and future required check | workflow name `bootstrap`、job name `verify`、read-only permissions、exact Node / pnpm setup、frozen install and WP-0001 verification；third-party Actions pinned by full commit SHA；no `pull_request_target` |
| `README.md` | Minimum setup | prerequisites、install、verification、workspace roadmap |

Optional only if target repository already has an equivalent file：update the existing file instead of creating a duplicate source of truth.

### 77.8 Root Manifest Contract

Root `package.json` must：

* set `private: true`
* set `packageManager: pnpm@11.13.0`
* set Node engine to the accepted Node 24 baseline without allowing unsupported major versions
* install Turborepo as an exact development dependency
* avoid runtime business dependencies
* avoid postinstall scripts unless explicitly justified and reviewed
* provide only scripts whose target already exists or whose no-package behavior is intentionally valid

### 77.9 Turborepo Task Contract

Canonical task names：

* `build`
* `dev`
* `lint`
* `typecheck`
* `test`
* `test:integration`
* `format:check`
* `clean`

Rules：

* `build` depends on upstream build
* `lint` / `typecheck` can depend on upstream generated contract tasks when introduced
* `dev` is persistent and not cached
* `test` declares coverage / result outputs only after WP-0003 defines them
* Secret-bearing environment variables are never added as global cache inputs without review
* No task hides a failed command by forcing zero exit status

WP-0001 can define task names before packages exist; later Work Packages fill package-level scripts without renaming the contract.

### 77.10 Execution Tasks

1. Inspect WSL2 / distribution / Linux-filesystem checkout、Git ownership / status and line-ending policy
2. Confirm WSL-local exact Node / pnpm / Docker availability and absence of mixed Windows executable resolution
3. Create or minimally update root manifest and version files
4. Create Workspace and Turbo configuration
5. Install exact dependencies and generate Lockfile
6. Create / update ignore、attributes、editor、root `AGENTS.md`、spec index and setup documentation
7. Run reproducibility and structure checks
8. Add and run the minimal `bootstrap / verify` GitHub Actions workflow on the WP-0001 Pull Request
9. After that named check has appeared and passed, enable it as the required status check for `main`
10. Enable independent approval / CODEOWNERS only if a second authorized human Reviewer exists；otherwise retain PR + CI + self-review checklist and mark independent review as required before production enablement
11. Review diff for accidental files、secrets、absolute paths and unrelated changes
12. Produce Handoff with command and repository-governance evidence

### 77.11 Verification Commands

The implementation must run equivalent checks for：

* Node version equals `v24.18.0`
* pnpm version equals `11.13.0`
* Turborepo version equals `2.10.5`
* Workspace manifest parses successfully
* `pnpm install --frozen-lockfile` succeeds after Lockfile exists
* root dependency list contains only intended baseline dependencies
* Turbo can load task graph with zero application packages
* JSON / YAML files parse
* Git whitespace check passes
* no tracked `.env`、credential、token or generated `node_modules`
* Pull Request emits exactly one unambiguous `bootstrap / verify` check and it passes without secrets or write permissions
* on Windows host，all repository commands resolve to WSL Linux executables、checkout real path is under the Linux home filesystem、tracked text is LF and filename / import casing passes on Linux
* `AGENTS.md` stays within the configured project guidance budget、references rather than duplicates large specs and names only commands that exist at the current WP stage

Exact shell syntax can vary by OS, but acceptance evidence must show the same result.

### 77.12 Acceptance Criteria

1. Fresh clone with Node 24.18.0 and pnpm 11.13.0 completes frozen install
2. Root is a private pnpm Workspace
3. Package Manager、Node and Turbo versions are deterministic
4. Lockfile is generated and unchanged after a second frozen install
5. Turbo recognizes canonical task graph without application code
6. No business module、database or provider dependency is introduced
7. No secret、local absolute path or machine-specific configuration is tracked
8. Existing unrelated user changes remain untouched
9. README gives a new developer enough information to reproduce verification
10. Diff contains only WP-0001 files and intentional updates
11. Minimal GitHub Actions workflow runs the same accepted bootstrap checks and exposes the unique `bootstrap / verify` check name
12. Required-check protection is activated only after the check exists；independent-review protection is activated only when a real second authorized human Reviewer exists and always before production enablement
13. Any initial-main or administrator bypass is a one-time bootstrap / break-glass event with actor、reason、scope and timestamp evidence；it is never represented as normal merge policy
14. Windows-hosted development runs in WSL2 from the Linux filesystem；no required workflow depends on PowerShell、drive-letter paths、case-insensitive filenames or Windows-only line endings
15. Root `AGENTS.md` and `docs/spec/README.md` match Section 89 and give future Coding Agents durable scope / verification guidance without embedding secrets or the full 1 MB handoff

### 77.13 Test Evidence

Handoff must include：

* Environment versions
* WSL version / distribution、Linux checkout real path and executable-resolution evidence on a Windows host
* Install command and exit result
* Lockfile reproducibility result
* Turbo config load result
* File parse / whitespace result
* Secret scan result
* `bootstrap / verify` workflow run and result
* current branch / ruleset stage、GitHub plan capability、Reviewer availability and any bootstrap exception record
* root `AGENTS.md` size / content review and spec-index resolution result
* Changed file list
* Any skipped check and reason

Screenshots are not required; text command evidence is sufficient.

### 77.14 Security and Privacy

* No registry auth token in `.npmrc`
* No `.env` or provider key
* No install script from unreviewed package
* Lockfile reviewed for unexpected package source / Git URL
* GitHub Actions default permissions are read-only；write permission requires job-local justification
* reusable third-party Actions are pinned to reviewed full commit SHAs and updated only through reviewed dependency PRs
* `pull_request_target` is prohibited in the bootstrap workflow
* Dependency license / security scan can begin in later CI package, but known critical issue blocks merge
* README uses placeholder environment names only

### 77.15 Observability

WP-0001 has no runtime service. Required observability is limited to deterministic command output and CI-ready exit codes.

Pino is accepted as later runtime logging baseline but is not installed merely to satisfy WP-0001 if no runtime code exists.

### 77.16 Rollback / Disable Strategy

Rollback is repository-only：

* revert WP-0001-owned files through normal Git change
* preserve unrelated pre-existing files and changes
* no database、cloud、provider or user data rollback exists
* if package version is incompatible, update through an IDR revision and regenerated Lockfile; do not hand-edit Lockfile

### 77.17 Expected Follow-up

After WP-0001 passes：

1. `WP-0002` create apps / packages / tooling directory baseline
2. `WP-0003` install and configure TypeScript、ESLint、Prettier、Vitest
3. `WP-0004` create API、Worker、Merchant Web、Customer PWA Skeleton
4. `WP-0005` local PostgreSQL / Docker Compose
5. `WP-0006` complete root scripts and environment validation
6. `WP-0007` ADR、Module README、setup templates and Section 90 repository-scoped project skills

### 77.18 Handoff Format

Implementation Handoff：

* Work Package ID / Name
* Outcome
* Files Changed
* Decisions Applied
* Commands Run
* Acceptance Criteria Result
* Tests / Checks Result
* Security Result
* Deviations / Exceptions
* Remaining Follow-up
* Git Branch / Commit / PR reference when authorized

### 77.19 WP-0001 Status

Specification：`Complete`。

Specification Readiness：`PASS`。

Execution Definition of Ready：`PENDING`。

Implementation：`Not Started`。

Execution Blockers：Coding Authorization、actual GitHub owner / Repository URL / plan capability、WSL2 Linux-filesystem local checkout creation、clean Git Inspection 与 environment evidence。Reviewer availability controls the governance stage but does not reopen Repository / CI / Branch / Worktree choices。

Next Allowed Action：获得明确编码授权后，创建 / 连接已决定的 private GitHub `bop-rms` Repository，收集真实 Execution Context evidence，然后执行 WP-0001 exactly within this Scope。

---

## 78. Pre-Implementation Readiness Audit

### 78.1 Gate Results

| Gate | Result | Evidence |
| --- | --- | --- |
| Architecture Freeze | PASS | Domain、Platform / BOP Consolidation、Module Boundary |
| Roadmap / Backlog | PASS | Phase 0 / Phase 1 Epic、Feature、Work Package、DoR / DoD |
| Repository / Module Blueprint | PASS | Repository topology、dependency、package and schema ownership |
| Database Blueprint | PASS | schema order、tenant、concurrency、outbox / inbox、audit、snapshot |
| API / Event Blueprint | PASS | REST、command / query、error、idempotency、event envelope |
| Merchant IA / UX Pattern | PASS | navigation、screen family、pattern、state、accessibility |
| Capability / Object / Page Registry | PASS | Sections 80、88 complete object / page ownership；Section 89 completes execution guidance；per-WP Gate now handles file-level implementation and evidence only |
| Product Master Data Specification | PASS | Screen Matrix、Field、Validation、Query、Projection、API、Workflow |
| SKU Specification | PASS | Variant、Barcode、Lifecycle、Replacement、Query、API、Workflow |
| Category / Option / Picker | PASS | Screen、field、rule、query、API、workflow |
| Inventory Item Specification | PASS | Unit、tracking、lot / expiry、reorder、screen、query、API、workflow |
| Permission / Audit / Import / Export | PASS | explicit namespace、risk control、traceability |
| Acceptance Scenarios | PASS | product、catalog、inventory、concurrency、projection、security |
| Implementation Choices for WP-0001 | DECISION PASS / EXEC PENDING | exact tool、new private GitHub repo、GitHub Actions、branch / worktree strategy locked；only external repo / environment evidence and authorization pending |
| WP-0001 Specification | PASS | scope、files、tasks、checks、acceptance、rollback、handoff |

### 78.2 Consistency Corrections Applied

本轮同时消除以下歧义：

* Product Detail 与 Edit 分离为独立 Intent
* Product Lifecycle 统一为 Draft、Active、Suspended、Discontinued、Archived
* SKU Lifecycle 与 Replacement Status 分开
* SKU Source of Truth 统一为 Product Aggregate 内 Product-owned Entity
* Published Version 不允许通过 Edit Screen 直接覆盖
* Inventory Balance / Movement 不作为 Inventory Item Form Field
* Category 不与 Menu Section 混用
* Product / SKU 不拥有价格和实时库存
* 早期 Open Decision 由 Section 42 后续 Freeze 结果覆盖，不再误判为阻塞项

### 78.3 Explicitly Deferred and Non-blocking

以下工作仍未实现或未展开到文件级，但不阻塞第一行代码：

* WP-0002 及以后各 Work Package 的执行
* WP-1020–1027 的文件级 Work Package Specification
* Inventory Operational Workbench 的 Phase 2 implementation / evidence；Screen-level product design 已由 Section 88 完成
* 已选 Provider、Production Hosting 与 Observability Backend 的账户创建、credential、contract / pricing validation 与 deployment
* Payment / Tax sandbox validation、professional review 与 live onboarding evidence
* Pilot Store 数据导入、UAT 与运营验证

这些内容均已有 Owner、Phase、Gate 或 Revisit Trigger，不能以“待以后决定”绕过现有 Contract。

### 78.4 Baseline Status

BOP-RMS 当前状态：

**Pre-Implementation Baseline Complete。**

此处的 `Complete` 仅表示当时记录的 Specification Baseline；Section 80 后续将其细分，Section 86 再完成全部可委托的 pre-code decisions。真实 Execution Context、外部身份 / 账号证据与 implementation 结果仍不得伪报为已完成。

含义：

* Repository Bootstrap 的规格没有未解决的产品或架构问题
* `WP-0001` 的所有选择已完成；仍需真实 Repository / Git / Environment evidence 与明确编码授权，不能把尚未执行写成 Execution Ready
* 当前实现进度仍为 `0%`
* 本轮没有生成代码、Repository、Migration、UI、API 或云资源

### 78.5 Change Control From This Point

从此节点开始：

* 业务或架构边界变更使用 ADR / Registry Revision
* 实现工具变更使用 IDR Revision
* Screen / Field 变更更新 Matrix、Contract 与 Acceptance
* Work Package 开始前再次验证 dependency patch、security、license 和 environment
* 任何 Coding Agent 必须先读取本交接包、目标 Work Package 和相关 IDR
* 不允许 Coding Agent 自行扩大 Scope 或推翻 Freeze

---

## 历史讨论节点 H-079（已完成）

历史状态快照；已由 Section 80 与 delegated completion baseline Section 86 取代，不得作为当前执行指令。

所有开始写代码前、且会阻塞第一项开发工作的准备已经完成。

已完成：

* Architecture and Engineering Baseline
* Capability / Object / Workflow / Screen / Field / Query / Projection Traceability
* Catalog Product、SKU、Category、Option Set 与 Lookup Picker 核心规格
* Inventory Item Master Data 核心规格
* Cross-cutting Permission、Audit、Import / Export 与 Acceptance
* WP-0001 所需 Implementation Choice
* `WP-0001 — Initialize TypeScript Monorepo and Workspace Baseline` 完整规格

当时记录的状态（已废止）：

* Pre-coding preparation：历史记录曾写 `Complete`；当前以 Section 80.12 为准
* WP-0001 Definition of Ready：历史记录曾写 `PASS`；当前拆分为 Specification `PASS` / Execution `PENDING`
* Code / Repository implementation：`Not Started`

下一步只有在用户明确授权开始写代码后执行：

**`WP-0001 — Initialize TypeScript Monorepo and Workspace Baseline`**。

执行时必须严格遵守 Section 77，不顺带执行 WP-0002 或任何业务代码。

---

## 80. Final Pre-Code Audit Remediation and Canonical Baseline

### 80.1 Authority and Status Vocabulary

本节是 2026-07-15 复审后的规范性补丁，覆盖此前与本节冲突的 Readiness、Registry、Screen、Field、Projection、Lifecycle、ADR、NFR 与 Current Node 描述。

统一状态含义：

| Dimension | Allowed Result | Meaning |
| --- | --- | --- |
| Specification Readiness | `PASS` / `PENDING` / `BLOCKED` | 文档是否足以执行指定 Work Package |
| Execution Readiness | `PASS` / `PENDING` / `BLOCKED` | 真实 Repository、Environment、Authorization 与 Git Context 是否满足 |
| Implementation | `Not Started` / `In Progress` / `Complete` | 代码与运行资产的实际进度 |
| IDR | `Proposed` / `Under Review` / `Accepted` / `Rejected` / `Superseded` / `Deprecated` / `Revisit Required` | 实现决策状态；只有 `Accepted` 可作为执行基线 |
| ADR | `Proposed` / `Under Review` / `Accepted` / `Rejected` / `Superseded` / `Deprecated` / `Revisit Required` | 架构决策状态；延期时点写入 Decision Timing，不新增状态词 |

不得再使用 `Accepted Direction`、`Accepted with Tool Pending`、`Deferred`、`Deferred for Initial Bootstrap` 作为 IDR / ADR Status。

#### 80.1.1 Resolved IDR Metadata Completion

Section 58 各 IDR 的 Context、Decision / Recommended Direction、Alternatives、Drivers、Consequences 与具体约束继续有效。本表补齐其统一治理元数据；字段解析顺序为具体 IDR正文 → 本表 → 以下全局值。

全局值：

* Baseline Review Date：`2026-07-15`
* Effective Version：`v0.1` only for `Accepted`; other statuses are not executable
* Compatibility：must preserve Module Boundary、Public Contract、Tenant and Database Ownership
* Security / Privacy：no new PII or Secret exposure；dependency / provider-specific review before install
* Supersedes / Superseded By：`None` unless an explicit revision states otherwise
* Rollback：create a reviewed IDR Revision, remove / replace dependency or provider through its boundary, regenerate lock / contract artifacts, and run affected acceptance suite；never silently downgrade

| IDR | Owner / Required Reviewers | Related WP / Scope | Validation Plan | Revisit Trigger / Operational Risk |
| --- | --- | --- | --- | --- |
| `IDR-0001` | Platform Engineer / Engineering、DevOps | WP-0001 package manager / developer OS | exact version、frozen install、clean clone、WSL2 Linux-filesystem bootstrap and Linux CI parity | lockfile / workspace incompatibility、WSL / sandbox limitation or corporate install restriction |
| `IDR-0002` | Platform Engineer / Engineering、DevOps | WP-0001–0003 task graph | zero-package graph、cache correctness、CI parity | graph / cache reliability or polyglot build need |
| `IDR-0003` | Platform Engineer / Engineering、Security | runtime baseline | Local / CI / production major parity、engine checks | LTS lifecycle or dependency engine conflict |
| `IDR-0004` | API Engineering Owner / Architecture、Security | API skeleton and HTTP transport | error、middleware、security、load and graceful shutdown tests | performance / security / runtime limitation |
| `IDR-0005` | Frontend Engineering Owner / Product Design、Accessibility、Architecture | Merchant Web / Customer PWA | browser matrix、hydration / PWA、contract and accessibility tests | framework lifecycle or unsupported platform |
| `IDR-0006` | Data Engineering Owner / Architecture、Security、DevOps | PostgreSQL and schema baseline | transaction、backup / restore、tenant and schema ownership tests | isolation / scale / regulatory trigger |
| `IDR-0007` | Persistence Owner / Architecture、Data、Security | first Persistence WP | multi-schema migration、transaction + outbox、concurrency、raw SQL escape tests | accepted Drizzle baseline fails required capability |
| `IDR-0008` | Quality Engineering Owner / Engineering | WP-0003 test runner | ESM / TS、workspace isolation、coverage、timer and CI performance | runner incompatibility or unacceptable performance |
| `IDR-0009` | Quality Engineering Owner / Frontend、DevOps | first E2E WP | customer / merchant critical paths、browser trace / screenshot evidence | browser support or runtime incompatibility |
| `IDR-0010` | Contract Engineering Owner / API、Event、Architecture | Contract Tooling WP | generation determinism、breaking-change and consumer tests | source divergence or unsupported schema semantics |
| `IDR-0011` | DevOps Owner / Security、Engineering | WP-0005 local dependencies | healthcheck、volume、port、secret and clean setup tests | platform incompatibility or local / CI drift |
| `IDR-0012` | DevOps Owner / Engineering、Security | CI implementation | GitHub Actions gate、branch protection、OIDC and secret controls | GitHub hosting changes or controls cannot meet baseline |
| `IDR-0013` | Observability Owner / Security、Privacy、Engineering | first runtime package | structured output、correlation、redaction、failure and performance tests | logging leak / cost / runtime issue |
| `IDR-0014` | Observability Owner / DevOps、Security、Engineering | first cross-runtime integration | trace continuity、metric cardinality、alert and export failure tests | ADOT / CloudWatch / X-Ray baseline fails SLO、privacy or cost controls |
| `IDR-0015` | Eventing Owner / Architecture、Data、DevOps | Eventing WP | outbox relay、retry、dead letter、schedule、shutdown and idempotency tests | accepted pg-boss baseline fails throughput / reliability |
| `IDR-0016` | Contract Owner / API、Event、Product Engineering | Contract Tooling WP | OpenAPI / Event Catalog generation and drift check | tooling cannot express canonical schema |
| `IDR-0017` | Engineering Owner / DevOps、Architecture | repository collaboration | protected main、required checks、review and merge audit | hosting workflow changes |
| `IDR-0018` | Dependency Governance Owner / Security、Engineering | all dependency WPs | update PR、license、security、engine and lockfile review | automation risk or dependency policy change |
| `IDR-0019` | Integration Architecture Owner / Security、Domain Owner | all provider WPs | adapter contract、webhook signature / idempotency、provider swap test | adapter leaks provider types or cannot preserve facts |
| `IDR-0020` | Product Owner / Compliance、Security、Domain Owner | market-specific provider WPs | market / provider spike、cost、residency、webhook and refund evidence | a Section 86 provider cannot pass sandbox、contract、privacy or professional review |
| `IDR-0021` | Frontend Engineering Owner / Product Design、Accessibility、Architecture、Security | WP-0004 or first feature UI WP | token / theme、bundle、license、keyboard / screen reader、visual regression and exit test | accepted frontend foundation fails accessibility、bundle、license or browser baseline |
| `IDR-0022` | DevOps Owner / Security、Privacy、Architecture | cloud infrastructure WPs | Region / service availability、backup / restore、failover、cost and privacy evidence | AWS Canada profile fails SLO、contract、residency or cost gate |
| `IDR-0023` | Payment Owner / Finance、Security、Compliance、Store Ops | Payment WP | Stripe test mode、Terminal / Interac、webhook、refund、reconciliation、settlement | onboarding、capability、cost or settlement evidence fails |
| `IDR-0024` | Tax Owner / Finance、Compliance、Architecture | Tax WP | accountant-approved Ontario basket / refund / receipt cases、effective-date replay | professional ruling requires unsupported semantics |
| `IDR-0025` | Identity Owner / Security、Privacy、Architecture | Identity / Authentication WPs | same-origin BFF、OIDC / PKCE、secure Cookie、CSRF、session fixation / revocation、MFA、tenant mapping、region and threat tests | Cognito / BFF cannot meet identity、session、region or security baseline |
| `IDR-0026` | File Storage Owner / Security、Privacy、Compliance | Media / Evidence WPs | encryption、upload、malware、retention、legal hold and restore tests | S3 profile cannot meet data-class controls |
| `IDR-0027` | Notification Owner / Security、Privacy、Product | transactional email WPs | SES identity、deliverability、bounce / complaint、localization、idempotency | deliverability、contract or privacy evidence fails |
| `IDR-0028` | DevOps Owner / Security、Architecture | Infrastructure / Deployment WPs | CDK synth / diff、OIDC、migration、rollout、rollback and environment isolation | CDK / ECS profile cannot meet deployment controls |
| `IDR-0029` | Data Owner / Security、DevOps、Architecture | Persistence / Production Runtime | PostgreSQL 18.4 compatibility、Multi-AZ、PITR、restore、role / schema isolation | extension、upgrade、RDS or compatibility evidence fails |

Accepted IDR-0001–0029 records use the Baseline Review Date or the Section 86 completion date as their v0.1 confirmation date. Future Proposed records remain non-executable until explicitly accepted.

### 80.2 Canonical Business Object Registry Completion

以下 Entry 补全核心 Catalog / Inventory Authoring 与审计发现涉及对象。Section 63 的旧目录在名称、分类或所有权冲突时，以本节为准。

#### 80.2.1 Identity, Meaning and Ownership

| Object ID | Object / Business Meaning | Classification | Layer / Owning Module / Write Owner | Source of Truth | Tenant / Store Scope | Parent / Child |
| --- | --- | --- | --- | --- | --- | --- |
| `RMS-CAT-PRODUCT` | 可稳定引用、版本化发布的商品族 | Master Data | RMS / Catalog / Catalog | Product Aggregate | Brand；Store 通过 Assignment / Overlay | Root；owns SKU and Product Option Binding |
| `RMS-CAT-SKU` | 可销售、可统计的最小稳定商品身份 | Master Data | RMS / Catalog / Catalog | Product Aggregate 内 Product-owned SKU Entity | Brand | Child of Product |
| `RMS-CAT-SKU-BARCODE` | SKU 的版本化扫描标识记录 | Append-only Identity Record | RMS / Catalog / Catalog | Product Aggregate Barcode Record | Brand + `CATALOG_SELLABLE` namespace | Child of SKU |
| `RMS-CAT-CATEGORY` | Catalog 商品分类树节点 | Master Data | RMS / Catalog / Catalog | Category Aggregate | Brand；可选 Store Applicability | Parent / child Category tree |
| `RMS-CAT-OPTION-SET` | 可版本化发布的选择规则集合 | Configuration | RMS / Catalog / Catalog | Option Set Aggregate | Brand；Effective Scope 可含 Store / Channel | Root；owns Option |
| `RMS-CAT-OPTION` | Option Set 内稳定可引用的选项身份 | Configuration Entity | RMS / Catalog / Catalog | Option Set Aggregate | Inherits Option Set | Child of Option Set |
| `RMS-CAT-PRODUCT-OPTION-BINDING` | Product Version 对 Option Set 的有序绑定与约束覆盖 | Relationship | RMS / Catalog / Catalog | Product Aggregate / Product Version | Inherits Product Scope | Child of Product Version; references Option Set Version |
| `RMS-CAT-MENU` | 按渠道、门店和时间发布的菜单配置 | Configuration | RMS / Catalog / Catalog | Menu Aggregate | Brand + explicit Store / Channel / Order Type scope | Root；owns Menu Section and Sellable Placement |
| `RMS-CAT-MENU-SECTION` | Menu 内的展示结构节点 | Configuration Entity | RMS / Catalog / Catalog | Menu Aggregate | Inherits Menu | Child of Menu |
| `RMS-CAT-SELLABLE-PLACEMENT` | Sellable 在 Menu Section 中的展示、排序和可见性关系 | Relationship | RMS / Catalog / Catalog | Menu Aggregate | Inherits Menu | Child of Menu Section; references Sellable |
| `RMS-CAT-BUNDLE` | 带选择与升级规则的可销售组合 | Configuration / Sellable | RMS / Catalog / Catalog | Bundle Aggregate | Brand + published scope | Root；v0.1 cannot contain Bundle |
| `RMS-CAT-AVAILABILITY-RULE` | Sellable 在门店、渠道和时段中的可用性配置 | Configuration | RMS / Catalog / Catalog | Availability-owned Catalog Configuration | Brand + Store / Channel / Order Type | References Product / SKU / Bundle |
| `RMS-RCP-RECIPE` | 将 SKU / Product preparation 映射为 Ingredient Usage 的版本化配方 | Configuration | RMS / Recipe / Recipe | Recipe Aggregate | Brand；可按 Store Override | Root；references Inventory Item |
| `RMS-INV-INVENTORY-ITEM` | 库存台账中的稳定物料身份与追踪策略 | Master Data | RMS / Inventory / Inventory | Inventory Item Aggregate | Brand；balance scoped by Store / Site / Location | Root |
| `RMS-INV-ITEM-BARCODE` | Inventory Item 的收货与盘点扫描标识记录 | Append-only Identity Record | RMS / Inventory / Inventory | Inventory Item Aggregate Barcode Record | Brand + `INVENTORY_RECEIVING` namespace | Child of Inventory Item |
| `RMS-INV-REORDER-POLICY` | Item 在指定 Stock Scope 的补货阈值与提示配置 | Configuration | RMS / Inventory / Inventory | Reorder Policy Record / Inventory Configuration | Brand + Store / Site / Location | Child configuration of Inventory Item |
| `RMS-CAT-CATALOG-IMPORT-JOB` | Catalog Master Data 导入的扫描、映射、校验与提交状态机 | Operational Work | RMS / Catalog / Catalog | Catalog Import Job | Brand | References uploaded artifact and target objects |
| `RMS-INV-INVENTORY-IMPORT-JOB` | Inventory Item Master Data 导入状态机；不导入 Opening Balance | Operational Work | RMS / Inventory / Inventory | Inventory Import Job | Brand | References uploaded artifact and target objects |
| `RMS-FUL-PICKUP-HANDOFF-RECORD` | 实际取餐交接的不可变证据 | Append-only Record | RMS / Fulfillment / Fulfillment | Fulfillment Aggregate 内 Handoff Record | Brand + Store | Child of Fulfillment；not an Aggregate Root |

#### 80.2.2 Lifecycle, Governance and Stable Identity

| Object ID | Lifecycle / Status | Primary / Human Identifier | Workflow / Publish | Permission Namespace | Audit / PII / Retention | Capability / Phase / Registry Status | Notes / Open Decision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `RMS-CAT-PRODUCT` | Draft、Active、Suspended、Discontinued、Archived | Product ID / Internal Code | Draft → Review → Publish；Lifecycle workflow | `catalog.product.*` | Full configuration audit；PII None；Configuration History | Catalog Management / Phase 1 / Active | Restore → Draft |
| `RMS-CAT-SKU` | Draft、Active、Suspended、Discontinued、Archived；replacement separate | SKU ID / SKU Code | Product-owned draft and lifecycle workflow | `catalog.sku.*` | Identity、barcode、replacement audit；PII None；Configuration History | Catalog Management / Phase 1 / Active | Stable across Product versions |
| `RMS-CAT-SKU-BARCODE` | Active、Retired、Voided | Barcode Record ID / Display Value | Add + Retire / Void | `catalog.sku.barcode.*` | Before / after、reason、scanner namespace；PII None；identifier history retained | Catalog Management / Phase 1 / Active | No silent reuse |
| `RMS-CAT-CATEGORY` | Draft、Active、Inactive、Archived | Category ID / Internal Code | Optional approval by policy；move / reorder workflow | `catalog.category.*` | Tree and assignment audit；PII None；Configuration History | Catalog Management / Phase 1 / Active | Max depth 3 |
| `RMS-CAT-OPTION-SET` | Draft、Published、Superseded、Archived plus stable lifecycle | Option Set ID / Internal Code | Draft → Validate → Review → Publish | `catalog.option_set.*` | Rule and version audit；PII None；Configuration History | Catalog Management / Phase 1 / Active | Published versions immutable |
| `RMS-CAT-OPTION` | Draft、Active、Inactive、Archived within version | Option ID / Stable Code | Inherits Option Set publish | `catalog.option_set.*` | Change audit；PII None；Configuration History | Catalog Management / Phase 1 / Active | Identity not physically deleted after use |
| `RMS-CAT-PRODUCT-OPTION-BINDING` | Draft、Effective、Superseded through Product Version | Binding ID / Purpose | Inherits Product publish | `catalog.product.option_binding.*` | Rule override audit；PII None；Configuration History | Catalog Management / Phase 1 / Active | Same Option Set may be bound more than once with distinct Binding ID |
| `RMS-CAT-MENU` | Draft、Published、Superseded、Archived | Menu ID / Internal Code | Versioned publish | `catalog.menu.*` | Full configuration audit；PII None；Configuration History | Menu Management / Phase 1 / Active | Inheritance max one level |
| `RMS-CAT-MENU-SECTION` | Inherits Menu Version | Section ID / Stable Code | Inherits Menu publish | `catalog.menu.*` | Ordering / move audit；PII None；Configuration History | Menu Management / Phase 1 / Active | Not Category |
| `RMS-CAT-SELLABLE-PLACEMENT` | Inherits Menu Version | Placement ID / presentation role | Inherits Menu publish | `catalog.menu.placement.*` | Presentation override audit；PII None；Configuration History | Menu Management / Phase 1 / Active | Canonical name replaces Menu Item Assignment |
| `RMS-CAT-BUNDLE` | Draft、Published、Suspended、Discontinued、Archived | Bundle ID / Internal Code | Versioned publish and lifecycle | `catalog.bundle.*` | Rule / item audit；PII None；Configuration History | Catalog Management / later Phase 1 / Active | v0.1 nested Bundle depth 0 |
| `RMS-CAT-AVAILABILITY-RULE` | Draft、Active、Inactive、Archived | Rule ID / Internal Code | Validate and activate | `catalog.availability.*` | Scope and decision audit；PII None；Configuration History | Availability Management / Phase 1 / Active | Inventory fact remains external |
| `RMS-RCP-RECIPE` | Draft、Published、Superseded、Archived | Recipe ID / Internal Code | Versioned publish | `recipe.*` | Ingredient / yield audit；PII None；Configuration History | Recipe Management / Phase 2 / Active | Owned by Recipe Domain, not Catalog |
| `RMS-INV-INVENTORY-ITEM` | Active、Inactive、Archived | Inventory Item ID / Internal Code | Direct update with high-risk policy revision | `inventory.item.*` | Unit / tracking / archive audit；PII None；Master Data History | Inventory Management / Phase 2 / Active | Balance is not a field on this object |
| `RMS-INV-ITEM-BARCODE` | Active、Retired、Voided | Barcode Record ID / Display Value | Add + Retire / Void | `inventory.item.barcode.*` | Identifier audit；PII None；identifier history retained | Inventory Management / Phase 2 / Active | Namespace is Inventory Receiving |
| `RMS-INV-REORDER-POLICY` | Draft / Active by Effective Period / Inactive | Policy ID / scope label | Validate overlay and activate | `inventory.item.reorder.*` | Threshold and scope audit；PII None；Configuration History | Inventory Management / Phase 2 / Active | One unambiguous resolved policy per scope and time |
| `RMS-CAT-CATALOG-IMPORT-JOB` | Uploaded、Scanning、Parsed、Mapped、Validated、Awaiting Approval、Committing、Completed、Failed、Cancelled | Import Job ID / filename snapshot | Preview → approval threshold → commit | `catalog.*.import` | Actor and artifact metadata may be Internal PII；result artifact default 90 days, audit per policy | Catalog Management / Phase 1 / Active | Partial commit off by default |
| `RMS-INV-INVENTORY-IMPORT-JOB` | Same import lifecycle | Import Job ID / filename snapshot | Preview → approval threshold → commit | `inventory.item.import` | Same import retention and restricted artifact access | Inventory Management / Phase 2 / Active | Opening balance prohibited |
| `RMS-FUL-PICKUP-HANDOFF-RECORD` | Immutable after append; correction by linked corrective record | Handoff Record ID / Fulfillment Number | Complete Pickup Handoff | `fulfillment.pickup.complete` / restricted read | Operational PII possible；Fulfillment retention / legal hold；full audit | Fulfillment Management / Phase 1 / Active | Never exposed as independent Pickup Task |

#### 80.2.3 Surface, Search and Contract Traceability

| Object ID | Screen Family / Primary and Secondary Screens | Search / Projection | API / Event Contract | Import / Export |
| --- | --- | --- | --- | --- |
| `RMS-CAT-PRODUCT` | Section 67 Product List / Detail / Create / Edit / History / Workflow | `SEARCH-CAT-PRODUCT-V1` / `catalog_product_search_v1`、`detail_v1` | Section 69 commands and Product events | Both；permission-trimmed |
| `RMS-CAT-SKU` | Section 70 SKU List / Detail / Form / Variant / Replacement / Barcode | `SEARCH-CAT-SKU-V1` / `catalog_sku_*_v1` | Section 70.12–13 | Both；identity changes controlled |
| `RMS-CAT-SKU-BARCODE` | SKU Barcode Related Record Editor | Exact barcode lookup / SKU detail projection | Add、Retire、Void / Barcode events | Import only through validated SKU template；restricted export |
| `RMS-CAT-CATEGORY` | Section 71 Category Tree / Detail / Form / History / Picker | Category search / `catalog_category_tree_v1`、`search_v1` | Section 71.9 / Category events | Both |
| `RMS-CAT-OPTION-SET` | Section 71 Option Set List / Detail / Editor / Compare / Publish / Picker | Option Set search / `catalog_option_set_*_v1` | Section 71.10 / Option Set events | Both |
| `RMS-CAT-OPTION` | Option Set Editor + Option Picker | Option search / `catalog_option_set_detail_v1`、picker | Mutated only through Option Set Draft / Option events in published aggregate | Through Option Set template |
| `RMS-CAT-PRODUCT-OPTION-BINDING` | Product Edit Options tab / impact view | Product detail projection | Product Draft commands / Product Version events | Product template only；no standalone bulk export by default |
| `RMS-CAT-MENU` | Menu List / Detail / Editor / Publish / Preview | Menu search and effective menu projection | Menu version commands / events | Both when Menu WP is specified |
| `RMS-CAT-MENU-SECTION` | Menu Editor tree | Menu detail projection | Mutated through Menu Draft | Through Menu template |
| `RMS-CAT-SELLABLE-PLACEMENT` | Menu Editor placement panel / preview | Effective menu projection | Mutated through Menu Draft | Through Menu template |
| `RMS-CAT-BUNDLE` | Bundle List / Detail / Editor / Publish | Bundle search / detail projection | Bundle version commands / events | Both when Bundle WP is specified |
| `RMS-CAT-AVAILABILITY-RULE` | Availability List / Rule Editor / Related panels | Availability rule and effective-result projection | Availability commands / events | Both when Availability WP is specified |
| `RMS-RCP-RECIPE` | Recipe List / Detail / Editor / Compare / Usage | Recipe search / detail / usage projection | Recipe version commands / events | Both when Recipe WP is specified |
| `RMS-INV-INVENTORY-ITEM` | Section 72 Item List / Detail / Form / Related / History | `SEARCH-INV-ITEM-V1` / `inventory_item_*_v1` | Section 72.15–16 | Both；no Opening Balance |
| `RMS-INV-ITEM-BARCODE` | Item Identifier panel | Exact inventory barcode lookup | Inventory item barcode add / retire / void events | Validated item template；restricted export |
| `RMS-INV-REORDER-POLICY` | Item Reorder Settings / status panel | `inventory_reorder_status_v1` | Scoped PUT command / `ReorderPolicyChanged` | Item template and scoped export |
| `RMS-CAT-CATALOG-IMPORT-JOB` | Catalog Import Wizard / Result | Import Job projection | Validate / approve / commit / cancel commands and stage events | Input and result artifact |
| `RMS-INV-INVENTORY-IMPORT-JOB` | Inventory Import Wizard / Result | Import Job projection | Validate / approve / commit / cancel commands and stage events | Input and result artifact |
| `RMS-FUL-PICKUP-HANDOFF-RECORD` | Pickup Queue / Fulfillment Detail read-only evidence | Fulfillment detail / pickup queue projection | `CompletePickupHandoff` / `PickupHandoffCompleted` | No ordinary import；restricted evidence export |

### 80.3 Screen Matrix Completeness Closure

Sections 67、70、71 与 72 的 canonical tables 已满足 Screen Matrix 的九个元数据字段。复审规则：

* Product Matrix：Complete，所有标准项显式存在
* SKU Matrix：已补 Persona，并显式登记 inherited Workflow / Approval
* Category Matrix：Archive / Restore、History / Audit、Import / Export 已拆分；Route、Persona、Contract、Projection、Phase 已补齐
* Option Set Matrix：Lifecycle、History / Compare、Import / Export 已拆分；Route、Persona、Contract、Projection、Phase 已补齐
* Inventory Matrix：已补 Persona；Count、Adjustment、Transfer、Waste 各自成为独立 Operational Screen，不再合并为一个隐含入口
* 任何 `Not Applicable` 必须有原因与适用版本；空白单元格不等于 N/A

### 80.4 Resolved Field Registry Contract

Sections 68、70、71、72 中现有 Field 表与 Field List 是 canonical Field Key Index。每个字段的完整记录按以下优先级解析：

`Field-specific Rule`

→ `Field Class Profile`

→ `Object Registry Profile`

→ `Global Default`

解析后的 Field Record 必须包含：Field Key、Business Meaning、Owning Module、Data Type、Required、Default、Read-only Condition、Validation、Normalization、Permission、PII、Localization、Help Text、Error Code Mapping、API Contract Field、Persistence Owner。生成 Contract / Form / Migration 前必须 materialize resolved record，不允许把“继承”当成未知值。

#### 80.4.1 Global Defaults

| Metadata | Normative Default |
| --- | --- |
| Business Meaning | 使用现有 Label / Section rule；若仍不唯一则 Work Package `BLOCKED` |
| Required | 采用现有 Field row；未声明时为 `No`，但 Publish / action conditional rule 仍生效 |
| Default | `null / absent`；Boolean、Enum、Quantity 不得发明业务默认值；server-derived 字段明确标 `Server-derived` |
| Read-only Condition | System identity、audit metadata、aggregate version、projection fields永远只读；其余遵循 lifecycle / published-state rule |
| Validation | 现有 Field rule + tenant / permission / reference existence + type bounds |
| Normalization | Unicode NFC、trim boundary whitespace；Code case-fold to registered canonical form；ID 不变；v0.1 display fields are plain text，future Rich Text requires an accepted format / sanitizer IDR |
| Permission | Object update permission；identity、lifecycle、publish、barcode、tracking、unit、reorder 等使用专门 action permission |
| PII | `None`，除非本节 Profile / Override 明确为 Internal、Personal 或 Sensitive |
| Localization | `No`，除非 Data Type 是 Locale Map / localized content；localized field 必须含 Brand default locale |
| Help Text | `help.<module>.<object>.<field_key>`；在 UI WP 中提供 locale resource，不允许硬编码说明 |
| Error Code Mapping | `<MODULE>_<OBJECT>_<FIELD>_<RULE>`；跨对象通用错误使用 Section 52 Error Catalog |
| API Contract Field | 默认与 canonical `field_key` 一致；任何 alias 必须显式登记并保持 backwards compatibility |
| Persistence Owner | Owning Module schema / Aggregate Repository；Projection 只能复制授权字段，不能成为 Write Owner |

#### 80.4.2 Field Class Profiles

| Field Class | Applies To | Default / Read-only | Validation and Normalization | Permission | PII / Localization | Help / Error Family |
| --- | --- | --- | --- | --- | --- | --- |
| `SYSTEM_IDENTITY` | `*_id` stable identity created by server | Server-derived / always read-only | valid opaque ID；never reused；no normalization | object read | None / No | identity help / `*_ID_INVALID` |
| `TENANT_CONTEXT` | `brand_id`、resolved store scope | Server-derived / always read-only after create | must match Actor scope；ID unchanged | scope-derived | Internal / No | scope help / `TENANT_SCOPE_MISMATCH` |
| `STABLE_CODE` | internal code、SKU code、Option code | absent until user enters / controlled after use | trim、NFC、registered case canonicalization、scope uniqueness、1–64 chars | identity update permission | None / No | code help / `*_CODE_*` |
| `LOCALIZED_TEXT` | localized name / description / alt text | absent | NFC、whitespace / length；v0.1 plain text + line breaks only，HTML / Markdown rejected；default locale when required | object update | None / Yes | locale help / `*_LOCALE_*` |
| `FREE_TEXT` | notes、reason note、description | absent | trim、length、sanitize；no secret or unnecessary PII | update or reason-specific permission | Internal unless explicitly customer PII / locale as declared | text help / `*_TEXT_INVALID` |
| `REFERENCE` | `*_id` / version reference selected by user | absent / read-only when pinned by publish | same tenant、read permission、valid lifecycle、version pin rule | object update plus referenced-object read | depends on referenced object / No | picker help / `*_REFERENCE_*` |
| `REFERENCE_SET` | ordered or unordered ID sets | empty set only when field contract says collection | deduplicate、tenant check、cardinality、order stability | object update | inherited / No | selection help / `*_REFERENCE_SET_*` |
| `ENUM_BOOLEAN` | type、policy、flag、lifecycle input | no implicit default unless field rule declares | value in registered enum；unknown values rejected | field / action permission | None / No | policy help / `*_VALUE_UNSUPPORTED` |
| `QUANTITY_DECIMAL` | quantities、thresholds、multipliers | absent | decimal precision、unit dimension、bounds、rounding policy；no binary float | inventory or rule permission | None / No | unit help / `*_QUANTITY_*` |
| `TIME_PERIOD` | effective from / until、expiry | absent | UTC instant、start < end、overlap rule、time-zone only for display | publish / policy permission | None / locale display only | schedule help / `*_PERIOD_*` |
| `LIFECYCLE` | object state | server-derived / action-only | state machine and impact validation | dedicated lifecycle action | None / localized label only | lifecycle help / `INVALID_STATE_TRANSITION` |
| `AGGREGATE_VERSION` | ETag / expected version | server-derived / always read-only | positive monotonic integer or opaque ETag | mutation caller must supply expected value | None / No | concurrency help / `CONCURRENCY_CONFLICT` |
| `BARCODE_VALUE` | Catalog / Inventory Barcode record | absent; immutable after record creation | namespace-aware normalization、type / check digit、active uniqueness | barcode manage permission | None / No | scanner help / `BARCODE_INVALID`、`BARCODE_AMBIGUOUS`、`BARCODE_DUPLICATE` |
| `STRUCTURED_CONFIG` | variant、option rules、tracking、storage | absent / published snapshot read-only | schema validation + graph / satisfiability / impact rules | object update or high-risk policy permission | None by default / localized children explicit | section help / object-specific rule code |
| `PROJECTION_ONLY` | balance、price、usage、status summaries | no write default / always read-only | freshness、scope and source metadata required | related-object read | field classification inherited / localized display only | freshness help / `PROJECTION_STALE` |

#### 80.4.3 Object Registry Profiles and Persistence Mapping

| Field Source | Owning Module / Persistence Owner | Base Permission | API Namespace | Default Field Classes / Explicit Overrides |
| --- | --- | --- | --- | --- |
| Section 68.2–68.3 Product | Catalog / Product Aggregate Repository in Catalog schema | `catalog.product.update` | Product request / response schema | IDs=`SYSTEM_IDENTITY`；brand=`TENANT_CONTEXT`；internal_code=`STABLE_CODE`；localized fields=`LOCALIZED_TEXT`；lifecycle=`LIFECYCLE`；aggregate_version=`AGGREGATE_VERSION`；effective period=`TIME_PERIOD` |
| Section 70.4–70.5 SKU | Catalog / Product Aggregate Repository | `catalog.sku.update` | SKU schema nested under Product command and standalone read schema | SKU / Product IDs、code、localized text、enum、reference and projection profiles apply；barcode uses separate record profile |
| Section 71.2 Category | Catalog / Category Repository | `catalog.category.update` | Category schema | ID / brand / code / localized text profiles；parent=`REFERENCE`；level=`PROJECTION_ONLY`；sort order=`QUANTITY_DECIMAL` integer subtype；lifecycle action-only |
| Section 71.4 Option Set / Option | Catalog / Option Set Repository | `catalog.option_set.update` | Option Set Draft schema | IDs / code / localized text；selection numbers=`QUANTITY_DECIMAL` non-negative integer subtype；rules=`STRUCTURED_CONFIG`；published version read-only |
| Section 72.5–72.8 Inventory Item | Inventory / Inventory Item Repository | `inventory.item.update` | Inventory Item schema | IDs / brand / code / localized text；unit and tracking=`STRUCTURED_CONFIG`；notes=`FREE_TEXT` Internal；stock summaries=`PROJECTION_ONLY` |
| Section 72.9 Reorder Policy | Inventory / Reorder Policy Repository | `inventory.item.reorder.manage` | Reorder Policy schema | scope=`REFERENCE`；thresholds / hints=`QUANTITY_DECIMAL`；effective period=`TIME_PERIOD`；override source server-derived |
| Section 70.8 / 72.6 Barcode Record | Owning Catalog or Inventory Aggregate Repository | module barcode-manage permission | Barcode Record schema | ID=`SYSTEM_IDENTITY`；value=`BARCODE_VALUE`；namespace / status=`ENUM_BOOLEAN`；created metadata system-derived |
| Section 73.11 / 73.16 Import Job | Target module / Import Job Repository; artifact bytes in approved BOP File Storage | object import permission | Import Job / Row Result schema | IDs system-derived；filename and actor Internal PII；mapping=`STRUCTURED_CONFIG`；counts projection-only；reason text Internal |

#### 80.4.4 Mandatory Field-specific Overrides

| Field Key / Pattern | Override |
| --- | --- |
| `primary_category_id` | Must be a member of `category_ids`; error `CAT_PRODUCT_PRIMARY_CATEGORY_NOT_ASSIGNED` |
| `primary_media_reference` | Must exist in `media_references` and have publishable rendition; error `CAT_PRODUCT_PRIMARY_MEDIA_INVALID` |
| `product_option_bindings` | Every Binding ID unique; Option Set version resolvable; error family `CAT_PRODUCT_OPTION_BINDING_*` |
| `variant_definition` / `variant_value_ids` | Product graph satisfiable and SKU combination unique; error family `CAT_VARIANT_*` |
| `unit_of_sale` / Inventory Base Unit | Semantic unit change after use routes to new SKU / migration; never silent update |
| `notes` / `preparation_notes_default` | No Secret、Token、customer PII or provider credential；redaction applies to logs and analytics |
| `on_hand` / `reserved` / `available` / `in_transit` | `PROJECTION_ONLY`; require resolved Stock Scope and Unit; never accepted in Item create / update payload |
| `lifecycle` | Never accepted as a generic PATCH field; only named lifecycle command can change it |
| `aggregate_version` | Returned by Query; mutation sends `expectedVersion` / `If-Match`; mismatch maps to `CONCURRENCY_CONFLICT` |
| `change_reason` / high-risk reason | Required by command; stored in Audit; PII classification Internal; not copied to analytics free text |

### 80.5 Projection Registry Completion

每个 Projection 都有一个 Write Owner 以外的 `Projection Owner`，但 Projection Owner 无权回写 Source Aggregate。所有 Projection Query 先应用 Tenant / Store / Permission Scope，再执行 Search / Sort。

| Projection | Owner | Source / Rebuild Inputs | Key / Search / Index Contract | Tenant / PII | Freshness / Rebuild | Export Rule / Status |
| --- | --- | --- | --- | --- | --- | --- |
| `catalog_product_search_v1` | Catalog Read Model | Product、SKU、Category、Menu assignment events | `brand_id + product_id`; code / barcode exact; localized name tokens; lifecycle / updated sort | Brand；PII None | target 5s；rebuild from Catalog source + authorized feeds | Permission-trimmed list export / Active |
| `catalog_product_detail_v1` | Catalog Read Model | Product Aggregate snapshot + authorized related summaries | `brand_id + product_id`; effective / draft version lookup | Brand；related fields field-masked | target 5s；source snapshot rebuild | No bulk export；detail export by policy / Active |
| `catalog_sku_search_v1` | Catalog Read Model | Product / SKU / Barcode / replacement events | `brand_id + sku_id`; SKU code and barcode exact; name tokens | Brand；PII None | target 5s；rebuild from Product Aggregate | Permission-trimmed export / Active |
| `catalog_sku_detail_v1` | Catalog Read Model | Product Aggregate + authorized Pricing / Recipe / Inventory summaries | `brand_id + sku_id` | Brand；PII None | target 5s；source + feed rebuild | Detail only / Active |
| `catalog_sku_picker_v1` | Catalog Read Model | SKU search projection | `brand_id + sku_id`; compact exact / prefix fields | Brand；PII None | same as SKU search | No standalone export / Active |
| `catalog_sku_replacement_chain_v1` | Catalog Read Model | SKU replacement facts | `brand_id + source_sku_id + as_of`; cycle and final-target index | Brand；PII None | target 5s；replay replacement facts | Restricted lineage export / Active |
| `catalog_category_tree_v1` | Catalog Read Model | Category create / move / reorder / lifecycle events | `brand_id + category_id`; parent / path / sibling order | Brand；PII None | target 5s；rebuild full tree with cycle check | Tree export allowed / Active |
| `catalog_category_search_v1` | Catalog Read Model | Category source | code exact; localized name tokens; lifecycle | Brand；PII None | target 5s；source rebuild | Permission-trimmed export / Active |
| `catalog_option_set_search_v1` | Catalog Read Model | Option Set version / lifecycle events | code exact; name / option tokens; publishing status | Brand；PII None | target 5s；source rebuild | Permission-trimmed export / Active |
| `catalog_option_set_detail_v1` | Catalog Read Model | Option Set Aggregate snapshots | `brand_id + option_set_id + version_id` | Brand；PII None | target 5s；source rebuild | Version detail only / Active |
| `catalog_option_set_picker_v1` | Catalog Read Model | Published / eligible Option Set view | `brand_id + option_set_id`; name / code | Brand + effective scope；PII None | target 5s；search rebuild | No standalone export / Active |
| `catalog_option_picker_v1` | Catalog Read Model | Option Set versions | `brand_id + option_id + option_set_id`; name / code | Brand + effective scope；PII None | target 5s；source rebuild | No standalone export / Active |
| `inventory_item_search_v1` | Inventory Read Model | Inventory Item + optional scoped stock / reorder feeds | `brand_id + item_id`; code / barcode exact; name tokens; quantity indexes require scope | Brand + explicit Stock Scope；PII None | item target 5s；stock freshness target 5s；rebuild item + ledger projection | Identity export without scope；quantity export requires scope / Active |
| `inventory_item_detail_v1` | Inventory Read Model | Inventory Item source + scoped stock + authorized usage / supplier feeds | `brand_id + item_id + optional stock_scope` | Brand + Stock Scope；notes Internal | item 5s；stock freshness included；rebuild by source | Detail export permission / Active |
| `inventory_item_picker_v1` | Inventory Read Model | Inventory Item search | `brand_id + item_id`; code / barcode / name | Brand；PII None | target 5s；source rebuild | No standalone export / Active |
| `inventory_stock_overview_v1` | Inventory Read Model | Stock Ledger、Reservation、Transfer facts | `brand_id + stock_scope + item_id + lot/location`; quantity sort only one scope | Brand + Store / Site / Location；PII None | target 5s；full ledger replay / reconciliation | Restricted scoped export / Active |
| `inventory_item_usage_v1` | Inventory Read Model | Authorized Recipe / SKU mapping feeds | `brand_id + item_id + consumer_ref` | Brand；PII None | target 30s；rebuild from authorized feeds | Restricted dependency export / Active |
| `inventory_reorder_status_v1` | Inventory Read Model | Reorder Policy + scoped stock + lead-time summary | `brand_id + stock_scope + item_id`; breached / status index | Brand + explicit Stock Scope；PII None | target 30s；recompute from policy + stock | Scoped export / Active |
| `catalog_import_job_v1` | Catalog Import Read Model | Catalog Import Job and row results | `brand_id + job_id`; status / requested_at | Brand；actor / filename Internal PII | target 5s；rebuild from job source | Result artifact restricted and expiring / Active |
| `inventory_import_job_v1` | Inventory Import Read Model | Inventory Import Job and row results | `brand_id + job_id`; status / requested_at | Brand；actor / filename Internal PII | target 5s；rebuild from job source | Result artifact restricted and expiring / Active |
| `fulfillment_pickup_queue_v1` | Fulfillment Read Model | Fulfillment、Kitchen readiness、handoff events | `store_id + fulfillment_id`; ready time / SLA sort | Store；customer display data Personal and field-masked | target 2s；event replay + source reconciliation | No ordinary bulk export / Required before Pickup WP |

### 80.6 API Request, Response and Event Payload Baseline

#### 80.6.1 Mandatory Transport Metadata

Mutation Request 必须解析：

* Authenticated Actor and Tenant Context
* optional Store / Stock Scope when operation requires it
* `Idempotency-Key` for create、publish、lifecycle、import commit、payment-like or high-risk commands
* `If-Match` or body `expectedVersion` for aggregate mutation
* `X-Correlation-ID` or server-generated equivalent
* locale / time zone only for presentation and validation messages，不改变 stored UTC fact

Command Result：

| Field | Rule |
| --- | --- |
| `operationId` | Stable command execution identifier |
| `resourceId` / `aggregateId` | Stable affected object identifier |
| `aggregateVersion` | Committed source version |
| `status` | `Succeeded`、`Accepted`、`Rejected` or domain-specific result；HTTP success alone is insufficient |
| `resourceSnapshot` | Optional permission-trimmed read-your-write snapshot |
| `projectionPending` | Boolean plus expected projection name / freshness hint |
| `warnings` | Structured code、field / object reference、override requirement；never free-text only |
| `auditReference` | Returned for high-risk action when policy permits |

Query Result：

* `data`
* `page.nextCursor` / `page.hasMore` for collections
* resolved Tenant / Store / Stock Scope metadata
* `fieldAvailability` for permission-trimmed related fields
* `projection.name`、`projection.updatedAt`、`projection.stale`
* stable error envelope from Section 52 on failure

#### 80.6.2 Command Shape Registry

| Command Family | Required Body / Preconditions | Success Result | Primary Errors | Emitted Facts |
| --- | --- | --- | --- | --- |
| Create Product | `internal_code`、`product_type`、`default_locale`、default-locale name、optional references；idempotency | Product ID、Draft Version ID、aggregate version | duplicate code、scope、permission、reference、idempotency conflict | `ProductCreated` |
| Update Product Draft | changed field set、`expectedVersion`；published version never patched | Draft snapshot + new aggregate version | field validation、reference、concurrency | `ProductDraftUpdated` |
| Review Product Version | action=`submit / approve / reject`、version ID、expected version；reject requires reason | review / approval state | invalid state、separation-of-duty、permission、concurrency | submitted / approved / rejected event |
| Schedule Product Publish | version ID、scope、`effectiveFrom`、expected version、idempotency | schedule ID / status | validation、overlap、time、approval | scheduled / rescheduled / schedule-cancelled event |
| Publish Product | version ID、scope、expected version、idempotency、optional approved warning overrides | published snapshot + version | validation、approval、reference changed、scope conflict | published / superseded events |
| Product Lifecycle | named action、expected version、reason、impact acknowledgement、idempotency | new lifecycle + impact tasks | invalid transition、active reference policy、permission | suspended / resumed / discontinued / archived / restored |
| Create / Update SKU | parent Product ID、code、unit、variant mapping、expected Product version | SKU ID + Product aggregate version | duplicate code / combination、unit semantics、concurrency | created / configuration updated / activated as applicable |
| SKU Lifecycle | named activate / suspend / resume / discontinue / archive / restore、reason、expected Product version | new SKU lifecycle | invalid transition、reference impact、permission | exact SKU lifecycle event including `SkuResumed` |
| Barcode Add / Retire / Void | namespace、scanner context、type、value；retire / void require record ID and reason | Barcode Record snapshot | invalid checksum、duplicate、ambiguous namespace、record state | barcode added / retired / voided |
| SKU Replacement | source / target、effective time、reason、expected Product version、idempotency | relationship ID + resolved final target | self / cycle / cross-brand / time / concurrency | scheduled / effective / cancelled / voided |
| Category Create / Update / Move | code / localized name；move includes parent, sibling order, category and parent versions | category / tree version | cycle、depth、duplicate code、concurrency | created / moved / reordered / lifecycle events |
| Option Set Draft / Publish | stable code、version content、rules、expected version；workflow action-specific fields | draft or published version | unsatisfiable rules、default invalid、reference impact、approval | validated / submitted / approved / rejected / scheduled / published events |
| Inventory Item Create / Update | identity、base unit、tracking policy、expected version | Item ID / version | duplicate code、unit / tracking invalid、concurrency | created / updated |
| Inventory Policy Revision | proposed policy、effective time、reason、impact plan、expected version | revision ID / status | balance incompatible、migration required、permission | tracking policy / unit conversion event |
| Reorder Policy Put | stock scope、thresholds、effective period、expected version | resolved policy and status | scope missing、negative threshold、target below reorder point、overlap | `ReorderPolicyChanged` |
| Import Validate / Commit | template version、artifact reference、mapping、job ID；commit has approval and idempotency | job / row result counts and expiring artifact | scan、parse、mapping、permission、row validation、idempotency | stage / completed / failed facts |
| Complete Pickup Handoff | Fulfillment ID、verification method / result、actor、expected version、idempotency | immutable Handoff Record + completed Fulfillment | not ready、verification failed、already completed、concurrency | `PickupHandoffCompleted` |

#### 80.6.3 Event Envelope and Payload Registry

所有 Event 必须包含：

* `eventId`
* stable PascalCase `eventType`
* `schemaVersion`
* `occurredAt` UTC
* `producerModule`
* `tenantId` and optional `storeId`
* `aggregateType`、`aggregateId`、`aggregateVersion`
* `correlationId`、optional `causationId`
* Actor reference or `System` actor classification
* payload with stable IDs and minimum business fact
* redaction classification and replay metadata

| Event Family | Mandatory Payload Beyond Envelope | Forbidden / Restricted Payload |
| --- | --- | --- |
| Product Version | Product ID、Version ID、scope、effective time、validation / approval summary | full rich-text Draft、secret、unrestricted related data |
| Product / SKU Lifecycle | object ID、from / to state、reason code、effective time | free-text reason in analytics feed |
| SKU Barcode | SKU ID、Barcode Record ID、namespace、type、normalized value hash or value according to consumer permission、status | unrelated Product description or inventory data |
| SKU Replacement | source / target SKU、relationship ID、effective time、final target at fact time | automatic rewritten cross-domain references |
| Category | Category ID、parent ID before / after、tree version、status | entire Product list |
| Option Set | Option Set / Version ID、scope、rule validation summary、publish time | complete consumer-specific pricing data |
| Inventory Item | Item ID、configuration revision、changed field keys、effective time | current quantity as mutable configuration fact |
| Reorder | Item ID、Stock Scope、Policy ID、threshold revision、status transition | supplier contract price unless explicitly authorized |
| Import Job | Job ID、template version、stage、counts、result artifact reference / expiry | uploaded row content、secrets、unauthorized PII |
| Pickup Handoff | Fulfillment ID、Handoff Record ID、verification method category、completed time、store | raw verification secret or unnecessary customer PII |

Breaking change detection、Schema Registry / Event Catalog、consumer contract tests and retention rules remain mandatory before the first producer is implemented.

### 80.7 Architecture Decision Register

本节建立 Section 42.21 要求但此前缺失的稳定 ADR ID。Repository 尚未创建前，本表是 canonical Register；WP-0007 创建对应 `docs/adr/ADR-xxxx-*.md` 文件时必须保持 ID、状态和语义一致。

#### 80.7.1 Deferred / Review Decisions

| ADR ID | Topic | Status | Reason / Current Position | Revisit Trigger | Affected Modules | Earliest Decision Timing | Owner |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `ADR-0001` | Unified Policy Engine / Rule DSL | Proposed | Shared evaluation contract is sufficient；generic DSL would be premature | three or more modules duplicate rule authoring, evaluation and explainability needs | BOP Policy、Pricing、Promotion、Availability、Compliance | before first shared policy-authoring WP | Architecture Owner |
| `ADR-0002` | Independent Configuration Domain | Proposed | Domain-owned configuration plus shared contract preserves ownership | cross-domain configuration requires one write owner or shared publication workflow | Catalog、Store、Pricing、BOP Configuration | before extracting shared configuration runtime | Architecture Owner |
| `ADR-0003` | Generic Workforce / Scheduling Domain | Proposed | Delivery worker availability is sufficient for v0.1 | shift planning、labor compliance、time clock or multi-domain staffing enters committed scope | Delivery、Store Ops、Kitchen、Identity | before workforce Phase | Product + Architecture Owner |
| `ADR-0004` | BOP Device / IoT Platform | Proposed | Device Aggregate and adapters cover initial printers / KDS | fleet provisioning、remote commands、telemetry scale or many device classes | Device、Printing、KDS、Store Ops | before device fleet WP | Platform Owner |
| `ADR-0005` | Enterprise Search Platform | Proposed | PostgreSQL / module projections meet current needs | search SLO、cross-module ranking、language scale or index size fails defined NFR | Catalog、Order、Customer、BI | after measured projection search limit | Architecture Owner |
| `ADR-0006` | Independent Streaming Platform | Proposed | Transactional outbox + PostgreSQL-backed job runtime is preferred initial direction | sustained event throughput / backlog violates NFR or independent retention / replay needed | All event producers / consumers | after eventing load evidence | Platform Owner |
| `ADR-0007` | Finance / Accounting Domain | Proposed | RMS preserves business facts but does not create a general ledger | statutory accounting、journal、reconciliation or ERP ownership enters scope | Order、Payment、Procurement、Tax、BI | before accounting feature commitment | Finance Product Owner |
| `ADR-0008` | Legal / Risk Domain | Proposed | Compliance cases remain domain-specific | formal legal case lifecycle or enterprise risk controls required | Compliance、Payment、Delivery、Privacy | before legal / risk WP | Compliance Owner |
| `ADR-0009` | Generic Case Management | Proposed | Shared Task / Evidence / Audit is enough；case semantics remain local | at least three domains require identical case lifecycle and shared queue | Compliance、Payment、Delivery、Device | before case platform extraction | Architecture Owner |
| `ADR-0010` | ML Feature Store / Model Registry | Proposed | No production ML model dependency in v0.1 | online model serving、feature reuse or regulated model governance committed | BI、Recommendation、Fraud | before ML production WP | Data / ML Owner |
| `ADR-0011` | Cross-brand Supplier Directory | Proposed | Supplier ownership remains tenant-scoped | marketplace / shared supplier identity and consent model committed | Procurement、Inventory、BOP Directory | before cross-brand procurement | Procurement Product Owner |
| `ADR-0012` | Cross-brand Recall Platform | Proposed | Recall handled inside tenant / compliance boundaries | regulator or supplier recall must fan out across tenants | Compliance、Inventory、Supplier | before shared recall integration | Compliance Owner |
| `ADR-0013` | Fleet / Route Optimization | Proposed | Delivery Task and provider adapter are sufficient | owned fleet、batch routing or optimization KPI committed | Delivery、Maps、Workforce | before fleet phase | Delivery Product Owner |
| `ADR-0014` | Digital Signage Domain | Proposed | Menu presentation and device output cover v0.1 | scheduled multi-screen signage content and proof-of-play required | Menu、Media、Device | before signage WP | Product Owner |
| `ADR-0015` | Public Authority Direct Integration | Proposed | Export / evidence workflow preferred initially | jurisdiction mandates direct API submission | Compliance、Tax、Operating Entity | jurisdiction-specific milestone | Compliance Owner |
| `ADR-0016` | Multi-database Tenant Isolation | Proposed | single PostgreSQL database with module schemas and tenant controls is baseline | regulatory isolation、enterprise contract or scale cannot meet controls | All persistence modules | before first isolated enterprise tenant | Security + Architecture Owner |
| `ADR-0017` | Microservice Decomposition | Proposed | modular monolith is frozen for v0.1 | independent scale、fault isolation、team ownership or deployment evidence | Any candidate module | architecture review after measured trigger | Architecture Owner |
| `ADR-0018` | Pilot Market and Regulatory Baseline | Accepted | Canada-first production pilot；China remains a supported architecture / later market profile | revisit only if business owner explicitly changes first production market before irreversible provider / hosting commitment | Tax、Payment、Privacy、Hosting、Localization、Operations | Effective for v0.1 pilot planning from 2026-07-15 | Product Owner + Compliance Owner |

#### 80.7.2 Accepted Audit-remediation Decisions

| ADR ID | Topic | Status | Decision | Consequence / Revisit Trigger | Owner |
| --- | --- | --- | --- | --- | --- |
| `ADR-0019` | Barcode Namespace and Scanner Context | Accepted | Namespace-aware uniqueness and context-specific resolution per Section 70.8 / 80.6 | prevents SKU / Inventory ambiguity；revisit only with global identity service | Catalog + Inventory Owners |
| `ADR-0020` | Inventory Quantity Scope | Accepted | quantity, reorder and stock actions require explicit Store / Site / Location scope | brand-only list is identity-only；revisit with explicit cross-scope aggregate product | Inventory Owner |
| `ADR-0021` | Bundle Nesting and Menu Inheritance | Accepted | v0.1 Bundle nesting depth 0；Menu inheritance maximum one level | simplifies resolution and prevents cycles；future change needs new ADR | Catalog Owner |
| `ADR-0022` | Pickup Handoff Modeling | Accepted | Pickup Handoff Record is inside Fulfillment Aggregate；no Pickup Task Aggregate Root | Registry and screen naming must follow Fulfillment ownership | Fulfillment Owner |
| `ADR-0023` | Ontario Pilot Jurisdiction | Accepted | first Canada production Pilot uses Ontario jurisdiction profile；currency remains CAD | revisit only if first Pilot Province changes before irreversible registration / provider commitment | Product Owner + Compliance Owner |
| `ADR-0024` | Pilot Operating Entity Model | Accepted | one Canadian Operating Entity resolves all mandatory v0.1 Pilot Business Functions；no Franchise or multiple Operating Entities in v0.1 | revisit only if multi-entity or franchise scope is explicitly committed；legal identity remains a separate decision | Product Owner + Finance / Compliance Owner |
| `ADR-0025` | Pilot Legal Entity Provenance | Accepted | create one new dedicated Ontario corporation for the v0.1 Pilot；do not reuse an unrelated existing entity | revisit only before incorporation if professional due diligence supports reuse；no corporation is created by this decision | Product Owner + Finance / Compliance Owner |
| `ADR-0026` | Pilot Corporate Name Mode | Accepted | use a numbered Ontario corporation as legal name；Brand and operating name remain separate | revisit only before filing or through later legal name amendment | Product Owner + Legal / Compliance Owner |
| `ADR-0027` | Pilot Corporate Formation Planning Profile | Accepted | simple single-founder control baseline、one voting common share class、one director / officer profile、Ontario professional registered office、December 31 fiscal year；actual personal and filing data require lawyer / accountant evidence | revisit before filing if tax、investment、immigration、estate or ownership facts require a different structure | Product Owner + Legal / Finance Owners |
| `ADR-0028` | Pilot Store and Fulfillment Baseline | Accepted | Toronto planning location；one synthetic Pilot Store `CA-ON-TOR-PILOT-001`；Dine-in + Pickup enabled；third-party Delivery disabled for first Pilot | revisit when real Store agreement / address or Delivery Phase is approved | Product Owner + Store Operations Owner |

### 80.8 Quantified Non-functional Baseline

这些数字是 v0.1 Engineering SLO / test target，不是未经验证的流量预测。Pilot 数据出现后可通过 accepted NFR revision 调整，但不得删除测量与告警责任。

#### 80.8.1 Availability and Recovery

| Service Class | Monthly Availability Target | RPO | RTO | Notes |
| --- | --- | --- | --- | --- |
| Customer ordering read / quote / submit path | 99.9% excluding approved maintenance | ≤ 5 minutes | ≤ 60 minutes | submit and payment handoff receive highest priority |
| Merchant operational order / kitchen / pickup path | 99.9% | ≤ 5 minutes | ≤ 60 minutes | degraded read-only operational projection（not an offline command queue）must be covered by the runbook |
| Merchant configuration authoring | 99.5% | ≤ 15 minutes | ≤ 4 hours | published effective configuration must remain available during authoring outage |
| BI / asynchronous export | 99.0% | ≤ 24 hours according to source replay | ≤ 24 hours | does not block operational transaction path |

Backup / recovery rules：

* encrypted PostgreSQL backups with point-in-time recovery capability
* quarterly restore drill before production maturity；evidence records duration and data validation
* Outbox / Inbox、Audit、Ledger and immutable transaction snapshots included in recovery validation
* recovery never treats Projection as sole source；projections rebuild from sources and feeds

#### 80.8.2 Performance and Freshness

| Journey / Operation | Target |
| --- | --- |
| Public Menu / Product read API | p95 ≤ 300 ms, p99 ≤ 800 ms server time under approved pilot load |
| Cart / Quote recalculation | p95 ≤ 500 ms, p99 ≤ 1.2 s excluding external provider latency |
| Order submit before external payment | p95 ≤ 800 ms, p99 ≤ 2 s；idempotent retry supported |
| Merchant list / search | p95 ≤ 500 ms for first page up to 50 rows |
| Master-data command | p95 ≤ 800 ms source commit；projection catch-up reported separately |
| Product / SKU / Inventory item projection | normal ≤ 5 s；stale indicator after 30 s |
| Pickup / Kitchen operational projection | normal ≤ 2 s；alert threshold 10 s |
| Customer PWA LCP | p75 ≤ 2.5 s on defined mid-tier mobile / 4G profile |
| Customer PWA INP / CLS | p75 INP ≤ 200 ms；CLS ≤ 0.1 |

External payment / delivery provider time is measured separately; provider latency cannot be hidden inside internal API SLO.

#### 80.8.3 Pilot Load Validation Envelope

Minimum pre-pilot performance test envelope：

* 60 concurrent Customer sessions per Store
* 20 concurrent Merchant / Kitchen / Pickup sessions per Store
* 5 order submissions per second per Brand for a 5-minute burst
* 100,000 Product / SKU search records per Brand test dataset
* 250,000 Inventory Item + scoped balance projection rows per Brand test dataset
* 1,000,000 Order / Payment / Movement historical records for query / retention smoke testing

These numbers are test floors. Capacity Planning must replace them with forecast + headroom before production launch.

#### 80.8.4 Browser, Device and Accessibility Support

* Customer PWA：latest and previous major iOS Safari and Android Chrome；responsive widths 320–1440 px
* Merchant Web：latest and previous major Chrome and Edge；latest Safari for supported manager workflows
* Kitchen / Pickup：approved touch tablet / display profile with minimum 1024 × 768 logical resolution
* Keyboard-only access for all Merchant authoring and operational actions
* WCAG 2.2 AA target；contrast、focus visibility、label、error association、zoom 200%、reduced motion and touch target acceptance required
* Unsupported browser receives explicit upgrade message；never silently degrades payment or order submission semantics

#### 80.8.5 Security and Privacy Targets

* no Critical / High exploitable vulnerability accepted for production release without time-bound risk acceptance
* authentication and permission denial must fail closed
* Merchant / Admin browser authentication uses the Section 86 same-origin BFF；OAuth Token、Session Identifier and credential material are prohibited from Web Storage、IndexedDB、Service Worker persistence、URL and client log
* Secret detection、dependency / license scan、SAST and contract security checks are required CI gates when their owning WP is implemented
* audit clock uses UTC and tamper-evident retention controls
* payment credentials never enter BOP-RMS logs or general database fields；provider tokenization boundary required
* PII access logging, export expiry and deletion / anonymization workflow must be verified before a Customer PII feature enters production

### 80.9 Customer PWA and Merchant Operational Screen Baseline

#### 80.9.1 Customer PWA Screen Matrix

| Journey Step | Screen ID | Route Intent | Persona | Query / Command | Projection / State | Phase | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| QR / Link Resolve | `CUST-ENTRY-CONTEXT` | signed QR or public Store link | Guest / Customer | `ResolveQrSession`、`GetPublicStore` | resolved Store、Table / Order Type、Channel、locale、expiry | Phase 1 | Active |
| Menu Browse | `CUST-MENU` | `/menu` within resolved session | Guest / Customer | `GetPublishedMenu` | effective Menu Version、Sections、Sellable snapshots、availability freshness | Phase 1 | Active |
| Menu Search | `CUST-MENU-SEARCH` | `/menu/search` | Guest / Customer | `SearchPublicMenu` | permission-free public menu search projection | Phase 1 | Active |
| Product Detail | `CUST-SELLABLE-DETAIL` | `/menu/items/:sellableId` | Guest / Customer | `GetPublicSellable` | pinned Product / SKU / Bundle display snapshot | Phase 1 | Active |
| Product Configurator | `CUST-SELLABLE-CONFIGURE` | Product Detail configure intent | Guest / Customer | validate option selection、`AddCartItem` | Option Set rule graph、selection validity、display price estimate | Phase 1 | Active |
| Cart | `CUST-CART` | `/cart` | Guest / Customer | get / add / update / remove Cart Item、`QuoteCart` | Cart Version、Quote、warnings、expiry | Phase 1 | Active |
| Checkout Details | `CUST-CHECKOUT` | `/checkout` | Guest / Customer | `CreateCheckoutSession`、update fulfillment / contact | Checkout Session、capacity hold、quote status | Phase 1 | Active |
| Payment | `CUST-PAYMENT` | `/checkout/payment` | Guest / Customer | `CreatePaymentIntent`、provider handoff | Payment Intent / Attempt status；provider UI boundary | Phase 1 | Active after Provider IDR |
| Confirmation / Recovery | `CUST-CHECKOUT-RESULT` | `/checkout/result` | Guest / Customer | idempotent `ConfirmCheckout`、poll payment / order result | Pending、Succeeded、Failed、Unknown / Recoverable | Phase 1 | Active |
| Order Tracking | `CUST-ORDER-STATUS` | `/orders/:orderReference`；reference is not a credential | Guest / Customer with authorized Guest Session | `GetPublicOrderStatus` | customer-safe Order / Kitchen / Fulfillment status | Phase 1 | Active |
| Pickup Code / Handoff | `CUST-PICKUP-CODE` | Order Status panel | Customer | display signed / expiring pickup proof | Pickup-ready projection；never exposes verification secret in logs | Phase 1 | Active |
| Receipt / Support | `CUST-RECEIPT-SUPPORT` | `/orders/:orderReference/receipt`；reference is not a credential | Customer with authorized Guest Session | get receipt、request support / cancellation when allowed | immutable receipt snapshot、support eligibility | Phase 1 | Active |

Customer Journey Contract：

`Resolve Context → Read Effective Menu → Configure Sellable → Versioned Cart → Server Quote → Checkout Session → Payment Intent → Idempotent Confirm → Order Status → Pickup Handoff / Receipt`

Rules：

* expired / invalid QR never guesses another Store；show recoverable Store selection only when policy allows
* public Menu price is display context；final amount always comes from valid Quote
* Product Configurator must explain missing required selection、maximum、conflict and unavailable option inline
* Quote expiration or price increase requires explicit customer reconfirmation
* refresh / back navigation / provider callback cannot create duplicate Order or Payment
* `Unknown` payment result must not be presented as failure or success；continue verification safely
* Customer Order Status exposes customer-safe phases, not internal Kitchen or Payment exception details

Mandatory States：Loading、Offline、Expired Context、Store Closed、Menu Unavailable、Item Unavailable、Selection Invalid、Cart Changed、Quote Expired、Price Changed、Capacity Lost、Payment Pending、Payment Failed、Payment Unknown、Order Confirming、Order Confirmed、Ready、Completed、Cancelled、Support Required。

#### 80.9.2 Merchant Order / Kitchen / Pickup Screen Matrix

| Screen ID | Screen / Route Intent | Persona | Permission | Query / Command | Projection | Phase | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `OPS-ORDER-QUEUE` | Order Queue `/operations/orders` | Owner、Store Manager、Order Staff | `ordering.order.read` | list / filter / claim / accept according to policy | `merchant_order_queue_v1` | Phase 1 | Active |
| `OPS-ORDER-DETAIL` | Order Detail `/operations/orders/:orderId` | Manager、Order Staff、Auditor | order read + field permissions | get detail、accept / reject / cancel / amend when legal | `merchant_order_detail_v1` | Phase 1 | Active |
| `OPS-ORDER-EXCEPTION` | Exception Workbench `/operations/order-exceptions` | Store Manager、Authorized Support | exception permissions | acknowledge、assign、resolve / compensate through domain action | `merchant_order_exception_v1` | Phase 1 | Active |
| `KIT-KITCHEN-QUEUE` | Kitchen Board `/operations/kitchen` | Kitchen Staff、Kitchen Lead | `kitchen.work_item.read` | accept / start / prioritize under policy | `kitchen_work_queue_v1` | Phase 1 | Active |
| `KIT-WORK-ITEM` | Work Item Detail / full-screen ticket | Kitchen Staff、Kitchen Lead | work-item read / execute | start、complete item、report exception | `kitchen_work_item_detail_v1` | Phase 1 | Active |
| `KIT-EXCEPTION` | Kitchen Exception Dialog / queue | Kitchen Lead、Store Manager | kitchen exception permission | report、acknowledge、resolve / route | `kitchen_exception_v1` | Phase 1 | Active |
| `FUL-PICKUP-QUEUE` | Pickup Queue `/operations/pickup` | Pickup Staff、Store Manager | `fulfillment.pickup.read` | list Ready / waiting / overdue fulfillments | `fulfillment_pickup_queue_v1` | Phase 1 | Active |
| `FUL-PICKUP-HANDOFF` | Handoff Verification Panel | Pickup Staff、Store Manager | `fulfillment.pickup.complete` | verify proof、`CompletePickupHandoff` | Fulfillment source snapshot + handoff evidence | Phase 1 | Active |
| `FUL-FULFILLMENT-DETAIL` | Fulfillment Detail `/operations/fulfillments/:id` | Manager、Support、Auditor | fulfillment read / sensitive field permission | get history、allowed corrective action | `fulfillment_detail_v1` | Phase 1 | Active |
| `FUL-DELIVERY-DISPATCH` | Delivery Dispatch `/operations/delivery` | Delivery Coordinator、Manager | delivery task permissions | assign / accept / start / exception / complete | delivery task queue projection | Later Phase 1 | Active when Delivery WP enters Ready |

Operational UX Rules：

* Queue is projection-backed, but every action revalidates Source state and Expected Version
* new / changed / overdue work uses non-color cue plus sound / notification policy；sound alone is insufficient
* Kitchen completion is per work item / item according to Domain state, not a client-only checkbox
* Pickup completion requires explicit target、proof result and confirmation；one action atomically appends Handoff Record and completes Fulfillment
* no standalone Pickup Task ID is shown or persisted
* exception resolution never edits historical Order、Payment、Kitchen or Handoff facts in place
* Store Scope is mandatory and always visible on operational screens

Mandatory States：Initial Sync、Live、Reconnecting、Stale、Empty、Overdue、Claimed Elsewhere、Source Conflict、Permission Lost、Command Pending、Command Failed、Projection Pending、Offline Read-only、Emergency Fallback。

#### 80.9.3 Key Acceptance Journeys

1. Invalid QR → no cross-store leakage → valid recovery path
2. Menu version changes while Cart exists → revalidation / requote → explicit customer decision
3. payment callback duplicated → one Payment result and one Order only
4. confirm response lost → idempotent retry returns same outcome
5. accepted Order reaches Kitchen within operational projection SLO
6. two Kitchen devices complete same item → one source transition, second receives current state
7. Pickup Code wrong / expired → no completion；audited failed attempt according to policy
8. Pickup completion response lost → retry returns same Handoff Record, not a duplicate
9. operational projection stale → visible stale state；dangerous action revalidates source
10. Store Scope / permission changes mid-session → next query / action fails closed and refreshes context

### 80.10 Visual System, Component and Wireframe Baseline

#### 80.10.1 Product-specific Visual Direction

* Customer PWA is food-first and brand-led：large product imagery、clear price / availability、progressive configuration；不得呈现通用后台模板外观
* Merchant authoring is structured and calm：dense but legible information hierarchy、persistent scope、explicit draft / published distinction
* Kitchen / Pickup is glanceable and operational：large state / SLA cues、high contrast、few primary actions、touch-first；decorative motion不得干扰
* Third-party component defaults不得直接决定最终品牌观感；BOP semantic tokens are the only visual source of truth
* no “AI-generated generic dashboard” acceptance：screens must show restaurant-specific objects、states、exceptions and decision hierarchy from this document

#### 80.10.2 Design Token Contract

| Token Family | Baseline |
| --- | --- |
| Spacing | 4 px base；steps 4、8、12、16、24、32、48、64 |
| Radius | 4 compact control、8 standard surface、12 prominent card、full pill only for status / chips |
| Typography | semantic roles Display、Heading 1–3、Body、Label、Caption、Numeric；Customer base body ≥ 16 px；Merchant dense body ≥ 14 px；Kitchen primary content ≥ 18 px |
| Color | Brand、Surface、Text、Border、Focus、Success、Warning、Danger、Info semantic tokens；no component-owned raw color |
| Contrast | WCAG 2.2 AA minimum；operational critical text / control targets stronger contrast where possible |
| Motion | fast 120 ms、standard 180 ms、emphasis 240 ms；no essential information conveyed only by motion；respect reduced motion |
| Elevation | flat、raised、overlay semantic levels；avoid stacking visual effects without interaction meaning |
| Grid | Customer responsive single / two-column flow；Merchant 12-column desktop + tablet adaptation；Kitchen fixed operational grid by approved device profile |
| Iconography | one coherent icon family；icon-only action requires accessible name and tooltip unless universally obvious and repeatedly tested |
| Data density | Customer comfortable；Merchant compact / comfortable user setting；Kitchen fixed high-readability density |

Each Brand Theme must fill semantic color、font、logo、image treatment and tone tokens without changing interaction semantics or accessibility requirements.

#### 80.10.3 Canonical Low-fidelity Wireframes

Customer Menu：

```text
[Brand / Store / Context]        [Language] [Cart count]
[Store status / order type / table]
[Search]
[Section navigation]
[Featured food image + item + price + availability]
[Product grid / list]
[Sticky cart summary when non-empty]
```

Customer Configurator / Checkout：

```text
[Back] [Product image + name + base display price]
[Required option groups, one decision at a time]
[Optional groups / quantity / note]
[Selection errors and availability inline]
[Server-calculated item summary] [Add / Update Cart]
----------------------------------------------------
[Checkout progress: Details → Review → Pay → Result]
[Quote lines + expiry / change warning]
[Primary action] [safe recovery / support]
```

Merchant Order Queue：

```text
[Store scope] [Live / stale status] [time] [alerts]
[New] [Accepted] [In preparation] [Ready] [Exceptions]
[Order card: number, channel, age/SLA, payment, fulfillment]
[one primary next action] [secondary menu]
[Detail side panel with immutable timeline]
```

Kitchen / Pickup：

```text
[Store + station / queue] [sync status] [overdue count]
[Ticket/work cards ordered by policy and SLA]
[large item state + modifiers + allergen / exception cues]
[Start / Complete / Exception]
----------------------------------------------------
[Pickup queue: ready age, order number, proof status]
[Verify] → [explicit Complete Handoff confirmation]
```

These wireframes lock hierarchy and interaction intent, not pixels. High-fidelity visual composition may vary only if it preserves the same contracts and passes usability / accessibility review.

#### 80.10.4 Frontend Design Readiness Gate

`IDR-0021 — Frontend UI Foundation` status：`Accepted`。

Decision Timing：before WP-0004 installs shared UI runtime or before the first feature UI Work Package, whichever is earlier.

Section 86 已决定 accessible primitives、form / validation、data grid、icon、CSS / token、router、server state、localization、PWA、license / bundle 与 exit plan。

Pre-code frontend decision gate is `PASS`。以下项目已由 Section 86 的 approved artifact IDs 与 acceptance contract 满足；对应 code / screenshot evidence 在首个 UI Work Package 生成：

1. Customer、Merchant and Kitchen visual direction reference is approved
2. semantic Brand Theme tokens are filled for the pilot
3. key flows above have responsive annotated wireframes or equivalent prototype IDs
4. component / primitive IDR is `Accepted`
5. accessibility review covers keyboard、screen reader、contrast、zoom、touch and reduced motion
6. screenshot / visual regression acceptance references approved artifacts

Coding Agent 必须实现已接受的 Section 86 baseline，不得自行发明另一套 visual direction 或 component stack。真实 keyboard、screen reader、contrast、zoom、touch、reduced-motion 与 visual-regression results 仍是实现验收证据，不是未决设计选择。

### 80.11 Pilot Market, Tax, Payment and Data Residency Gate

#### 80.11.1 Common Architecture Guardrails

Regardless of pilot market：

* every Store belongs to an explicit Operating Entity and jurisdiction profile
* Currency is immutable on Quote、Order、Payment、Refund and accounting-relevant snapshots
* Tax calculation uses versioned jurisdiction / product / order context；no UI or provider adapter hardcodes tax rates
* Payment provider types remain inside Adapter Boundary；core Payment facts use canonical contracts
* data region、subprocessor、cross-border transfer、retention and deletion rules are recorded before production data is created
* legal / tax / privacy specialist review is a launch gate；this document does not substitute for professional jurisdiction advice
* Sandbox / test credentials and synthetic data are mandatory before live provider testing

#### 80.11.2 Canada-first Accepted Profile

Decision：Canada-first。ADR Status：`Accepted` under `ADR-0018`，confirmed on `2026-07-15`。

Accepted market baseline：

* first production pilot market：Canada
* first production pilot Province：Ontario
* currency：CAD
* locale baseline：`en-CA`；`fr-CA` remains supported by the localization contract and becomes required according to selected Province / operating obligations
* tax：versioned Canada / Ontario jurisdiction profile；rates、classification、place-of-supply and effective dates require tax review before live use
* payment：Stripe Canada + Stripe Terminal is accepted in Section 86；sandbox evidence must cover authorization、capture、refund、webhook、idempotency、Interac / card capability、fees and settlement
* data residency：AWS `ca-central-1` primary with the Section 87 Canada DR profile；contract、subprocessor and actual account / Region evidence remain required
* receipt、tip、service charge、refund and chargeback behavior must be validated against the selected Operating Entity / Province

#### 80.11.3 Ontario-first Accepted Province Profile

Decision：Ontario-first。ADR Status：`Accepted` under `ADR-0023`，confirmed on `2026-07-15`。

Accepted Province baseline：

* Jurisdiction Code：`CA-ON`
* Currency：CAD
* all Store、Quote、Order、Payment、Receipt and Tax snapshots resolve the effective Ontario jurisdiction profile
* tax rate or food / beverage classification is never embedded in UI、Catalog or provider-specific code
* planning City：Toronto；synthetic Store：`CA-ON-TOR-PILOT-001`；Operating Entity profile and Provider choices are accepted in ADR-0024–0028 / Section 86；real addresses、registration numbers and account IDs remain external evidence
* professional tax、privacy and legal validation remains a production launch gate

#### 80.11.4 China Candidate Profile

Profile Role：`Supported Architecture / Not Initial Pilot unless ADR-0018 is changed`。

Candidate requirements：

* currency：CNY
* locale baseline：`zh-CN`
* payment provider、merchant onboarding、webhook reachability and settlement must be validated with a China-specific spike
* production hosting、network access、data localization / cross-border transfer、identity verification、content / filing or licensing obligations require China-specific legal and infrastructure review
* Canada-selected provider、hosting or tax assumptions must never be reused silently

#### 80.11.5 Market-dependent Work Package Gate

`ADR-0018` Market Gate、`ADR-0023` Province Gate、`ADR-0024` Operating Entity Model Gate、`ADR-0025` Legal Entity Provenance Gate 与 ADR-0026–0028 formation / Store planning gates 已通过。Provider-neutral implementation 可按 Roadmap 开始；以下 live / production enablement 仍为 `BLOCKED`，直到专业人士审阅完成，且对应 corporation、jurisdiction、Store、provider 与 account evidence 实际建立：

* production Tax Rule implementation / provider integration
* live Payment Provider integration
* production Hosting / Data Region account、contract、service-availability and recovery evidence；the AWS Canada design choice itself is already accepted
* Customer PII retention / deletion launch configuration
* legal Receipt / Invoice output
* live Pilot Store onboarding and UAT

WP-0001 through provider-neutral repository / architecture bootstrap are not blocked by market choice.

### 80.12 Canonical Readiness Ledger

| Area | Specification Readiness | Execution Readiness | Implementation | Next Gate |
| --- | --- | --- | --- | --- |
| Architecture / Domain Boundary | PASS | N/A until affected WP | Not Started | ADR only on trigger |
| Repository / Module / Database / API Blueprint | PASS | Pre-code choices PASS；actual Repository evidence PENDING | Not Started | create / connect new private GitHub `bop-rms` only after coding authorization |
| WP-0001 Specification | PASS | Decision PASS；Execution PENDING | Not Started | coding authorization、actual repo URL / plan / checkout、clean Git and environment evidence |
| Tool Version Baseline for WP-0001 | PASS | environment verification PENDING | Not Installed by this work | verify exact versions in target environment |
| CI Gate | PASS | GitHub Actions + staged governance Accepted；configuration PENDING execution | Not Started | create `bootstrap / verify` in WP-0001，then activate each protection only after its prerequisite exists |
| Core Business Object Registry | PASS for all registered objects；Section 88 completes page/function surface ownership | N/A | Not Started | per-object WP file / evidence gate |
| Product / SKU / Category / Option Set and Commerce Screen Contract | PASS；Sections 67–71、88.8–88.9 | frontend implementation / repo PENDING | Not Started | file-level WP + visual evidence gate |
| Inventory / Supply / Procurement Screen Contract | PASS；Sections 72、88.12–88.13 | Phase 2 / 3 repo / evidence PENDING | Not Started | WP-2120–2137 file-level specification |
| Field Registry | PASS by resolved metadata contract | materialization in Contract tooling PENDING | Not Started | generate and test schemas in owning WP |
| Projection Registry | PASS for core + Section 88 projection families | storage / index evidence PENDING | Not Started | owning projection WP load / rebuild test |
| Customer PWA Screen Baseline | PASS；Section 88.6 includes ordering and future account / reservation channel | pre-code product decisions PASS；repo / Provider evidence PENDING | Not Started | implement and produce accessibility / visual-regression evidence in owning WP |
| Merchant / Operations / Platform Page Baseline | PASS；Sections 88.7–88.19 | pre-code product decisions PASS；repo / device / Provider evidence PENDING | Not Started | implement by Phase and validate against Section 88.29 |
| Visual System | PASS — `VIS-BOP-PILOT-001` + IDR-0021 Accepted | implementation evidence PENDING | Not Started | materialize tokens / components and screenshot baselines in first UI WP |
| NFR / SLO | baseline PASS | capacity / recovery evidence PENDING | Not Measured | automated tests、monitoring and drills |
| Pilot Market / Tax / Payment / Residency | Canada + Ontario + numbered dedicated entity + Toronto Store + Provider stack Accepted | external legal、account、Store、sandbox and professional evidence PENDING | Not Started | collect evidence before live enablement；no further product choice required |

Canonical interpretation：

* `WP-0001 Specification Ready = PASS`
* `All User-Delegable Pre-Code Decisions = PASS`
* `WP-0001 Decision Ready = PASS`
* `WP-0001 Execution Ready = PENDING — external repository / environment evidence and coding authorization only`
* `Current Discussion Node = Closed`
* `Implementation Progress = 0%`

Section 88 update：later feature specifications remain Just-in-time only for file-local implementation、visual materialization、test fixture and real evidence. Page / function decisions are now globally complete；a Coding Agent may not use a later Gate to redesign or omit the accepted registry silently.

### 80.13 Audit Finding Closure Matrix

| Audit Finding | Resolution | Result |
| --- | --- | --- |
| WP-0001 DoR contradiction | Specification and Execution readiness split in Sections 76、77、80.12 | Closed |
| invalid IDR statuses | normalized to allowed vocabulary；direction / timing moved to fields | Closed |
| unconfirmed GitHub assumption | new private GitHub `bop-rms` + GitHub Actions accepted under IDR-0012 | Closed；actual owner / URL is external evidence |
| Windows pnpm bootstrap undefined | Section 77 / 89 lock WSL2、Linux-filesystem checkout、Linux Node 24.18.0 + Corepack 0.35.0 + pnpm 11.13.0 and same-distribution execution | Closed；native-Windows toolchain is superseded |
| incomplete Screen Matrix metadata | SKU / Category / Option Set / Inventory matrices completed and combined rows split | Closed |
| Field Registry only a list | resolved 16-field metadata contract、profiles、persistence and overrides added | Closed |
| Business Object Registry missing / contradictory | stable IDs and full traceability added；Pickup / Placement / Recipe names corrected | Closed for audited core scope |
| lifecycle / command / event gaps | Product Resume、SKU Activate / Resume、reject / schedule / cancel / reschedule commands and events added | Closed |
| Bundle / Menu unresolved depth | v0.1 depth locked and ADR registered | Closed |
| barcode cross-domain ambiguity | Namespace + Scanner Context + ambiguity result locked | Closed |
| inventory quantities lack scope | explicit Stock Scope required；identity-only fallback defined | Closed |
| customer / merchant operational screens missing | screen matrices、states and acceptance journeys added | Closed at low-fidelity specification level |
| design system / wireframe missing | exact `VIS-BOP-PILOT-001` theme、approved flow artifact IDs and IDR-0021 stack locked in Section 86 | Closed；implementation screenshots are test evidence, not a design decision |
| API and event payload shapes missing | transport、command result、command family and event payload registries added | Closed for core scope |
| quantified NFR missing | SLO、RPO / RTO、performance、load、browser and security targets added | Closed |
| pilot / tax / payment / residency unresolved | ADR-0018 / 0023–0028 and Section 86 provider records lock market、Province、entity、Store、payment、tax、hosting and residency direction | Closed for pre-code decisions；external launch evidence remains |
| ADR Register absent | ADR-0001–0028 stable register established | Closed |
| document numbering / current node / filename governance | front matter、canonical filename、unique historic nodes and closed Section 86 pointer added | Closed through same Library item writeback |

### 80.14 Remaining External Evidence — No Open Pre-Code Choice

不存在仍需用户逐项选择的 pre-code decision。Section 86 已替用户锁定全部当前可决定事项。

以下项目是不能伪造的真实世界证据，不是设计选择：

1. GitHub owner / organization、Repository URL、private-branch-protection plan capability、Reviewer availability、governance stage、any seed / break-glass record、local checkout 与 clean Git state
2. incorporator / beneficial owner / director / officer 的真实身份、地址、consent、share subscription 与专业签字
3. registered office、Business Number、corporation income tax、GST/HST / payroll（如适用）与 municipal licence records
4. real Pilot Store lease / address、device inventory、network profile 与 operating permits
5. AWS、Stripe、Cognito / SES account IDs、contracts、pricing、sandbox / live credentials、settlement bank account 与 subprocessor review
6. lawyer、accountant、privacy、security 与 accessibility review evidence
7. actual install、migration、load、backup / restore、browser、device、payment、tax and UAT test results

这些证据按 Section 86 的 Gate 阻止 live enablement 或对应 execution；Coding Agent 不得把缺失证据伪造为 `PASS`，也不得借此重新选择已接受的方案。

### 80.15 Current Canonical Status

No business code、Repository、Migration、UI runtime、API runtime、cloud resource or provider account was created by this remediation.

The handoff package is now：

* internally consistent for the audited core scope
* honest about Specification versus Execution readiness
* complete for all currently user-delegable pre-code decisions
* contains no active discussion node and requires no further choice before WP-0001 execution-context collection
* not authorization to write code

---

## 历史讨论节点 H-081（已完成）

已确认：`ADR-0018 — First Pilot Market`。

Decision：`Canada-first pilot`。

确认日期：`2026-07-15`。

已锁定含义：

* 首个生产 Pilot 以 Canada 为市场基线，Currency 为 CAD
* China 保留 Architecture、Localization 与 Adapter Compatibility，但不是首个生产 Pilot
* 本决定没有选择 Province、Operating Entity、Payment、Tax、Hosting Provider，也没有授权编码

---

## 历史讨论节点 H-082（已完成）

已确认：`Canada Pilot Province`。

Decision：`Ontario-first pilot`。

确认日期：`2026-07-15`。

已锁定含义：

* 首个 Pilot jurisdiction profile 采用 `Canada / Ontario`
* Currency 继续为 CAD
* Tax 使用 Ontario-specific versioned jurisdiction profile，不硬编码税率
* 本决定没有选择 City、具体 Store、Operating Entity 或任何 Provider，也没有授权编码

---

## 历史讨论节点 H-083（已完成）

已确认：`ADR-0024 — Pilot Operating Entity Model`。

Decision：`Single Canadian Operating Entity for the v0.1 pilot`。

确认日期：`2026-07-15`。

已锁定含义：

* v0.1 Pilot 的全部必需 Business Functions 解析到一个 Canadian Operating Entity
* Brand 与 Store 不能代替法律主体身份
* v0.1 不引入 Franchise 或 multiple Operating Entities
* 本决定没有选择具体 legal identity、registration、account 或 Provider，也没有授权编码

---

## 历史讨论节点 H-084（已完成）

已确认：`ADR-0025 — Pilot Legal Entity Provenance`。

Decision：`new dedicated Ontario corporation for the v0.1 Pilot`。

确认日期：`2026-07-15`。

已锁定含义：

* v0.1 Pilot 使用新设的 dedicated Ontario corporation，不复用无关的既有 entity
* 新 corporation 在完成注册与专业审阅后成为已确认的 Single Canadian Operating Entity
* 本决定没有确定 corporation name mode、formation details、account 或 Provider，也没有创建 corporation 或授权编码

官方核对来源保留：

* Government of Canada，[Registering a corporation](https://www.canada.ca/en/services/business/start/register-with-gov/register-corp.html)
* Government of Canada，[Incorporating in a specific province or territory](https://www.canada.ca/en/services/business/start/register-with-gov/register-corp/register-corp-prov.html)

---

## 历史讨论节点 H-085（已完成）

已确认：`ADR-0026 — Pilot Corporate Name Mode`。

Decision：`numbered Ontario corporation as legal name；Brand / operating name remains separate`。

确认方式：用户于 `2026-07-15` 授权本交接包替其一次性完成全部剩余 pre-code choices。

已锁定含义：

* incorporation articles 不预先指定自定义 corporate name，由 Ontario Director 分配 number name
* legal entity identity 不绑定 BOP-RMS、restaurant Brand 或 Store
* numbered corporation 以后仍可按法定 amendment 程序改名
* 本决定没有提交 incorporation、注册 business name / trademark、创建账号或授权编码

官方核对来源：Ontario [Business Corporations Act](https://www.ontario.ca/laws/statute/90b16)，s. 8–10、168(4)–(5)。

---

## 86. Delegated Complete Pre-Code Decision Baseline（Accepted）

### 86.1 Authority、Supersession and Closure

用户于 `2026-07-15` 明确要求：把写代码前的工作全部完成，并授权本交接包替其决定。

本节因此：

* 接受并关闭 `ADR-0026`
* 接受此前 `Under Review` / `Proposed` 且会影响 v0.1 implementation 的 IDR-0007、0012、0014、0015、0020、0021
* 建立 IDR-0022–0029 的 Provider / Runtime / Deployment 记录
* 接受 ADR-0027–0028 的 formation planning、Pilot Store 与 Fulfillment baseline
* 取代 Section 58、76–80 与历史节点中相冲突的开放状态、推荐方向和“下一次讨论”指令
* 关闭当前讨论节点；不再要求用户逐项回复 `1 / 2`

Canonical status：

* `All User-Delegable Pre-Code Decisions = PASS`
* `No Active Discussion Node`
* `WP-0001 Specification Ready = PASS`
* `WP-0001 Decision Ready = PASS`
* `WP-0001 Execution Ready = PENDING — external repository / environment evidence and explicit coding authorization only`
* `Implementation Progress = 0%`

Future-trigger ADR-0001–0017 保持 `Proposed`，表示其能力不进入当前 v0.1 baseline；它们不是未决 pre-code choices，也不阻塞 WP-0001。只有对应 Revisit Trigger 真正出现时才重新评审。

### 86.2 Final Accepted Decision Index

| Record | Accepted Decision | Effective Scope | Revisit Only If |
| --- | --- | --- | --- |
| `ADR-0026` | numbered Ontario corporation；Brand / operating name separate | Pilot legal identity planning | lawyer requires change before filing or later legal-name amendment is approved |
| `ADR-0027` | simple single-founder corporate planning profile | formation brief only | real ownership、tax、investment、immigration or estate facts require another structure |
| `ADR-0028` | Toronto planning location；one synthetic Store；Dine-in + Pickup；Delivery off | first v0.1 Pilot | real Store agreement or Delivery Phase changes scope |
| `IDR-0007` | Drizzle ORM + Drizzle Kit + controlled SQL | Persistence | validation proves a required capability cannot be met |
| `IDR-0012` | new private GitHub `bop-rms` + GitHub Actions | Repository / CI | hosting changes or GitHub controls cannot satisfy the gate |
| `IDR-0014` | OpenTelemetry + ADOT + CloudWatch / X-Ray | Observability | privacy、SLO、cost or operational evidence fails |
| `IDR-0015` | PostgreSQL-backed pg-boss | Jobs / Queue | measured reliability or throughput fails |
| `IDR-0020` | complete initial Provider scope defined below | v0.1 Pilot integrations | a selected Provider fails its mandatory evidence gate |
| `IDR-0021` | exact frontend foundation and visual artifact baseline below | all v0.1 UI | accessibility、license、bundle or browser validation fails |
| `IDR-0022` | AWS Canada production hosting / residency profile | cloud runtime | contract、availability、privacy or cost review fails |
| `IDR-0023` | Stripe Canada + Stripe Terminal | payment | onboarding、Interac、refund、settlement or cost spike fails |
| `IDR-0024` | BOP-owned versioned Ontario tax engine；no external Tax SaaS | tax calculation | accountant / ruling requires a capability the engine cannot express |
| `IDR-0025` | Amazon Cognito + same-origin BFF for Merchant / Admin authentication | workforce access | region、MFA、OIDC、session or privacy review fails |
| `IDR-0026` | Amazon S3 private object storage | files / media / evidence | residency、retention or malware-control validation fails |
| `IDR-0027` | Amazon SES transactional email；SMS disabled | notification | deliverability or region / contract review fails |
| `IDR-0028` | AWS CDK v2 + CloudFormation + ECS Fargate deployment | infrastructure / deployment | operational evidence requires another deployment runtime |
| `IDR-0029` | PostgreSQL 18.4 on Amazon RDS | production database runtime | extension、upgrade、compatibility or RDS validation fails |

All accepted choices preserve Adapter Boundaries、Module ownership、Public Contracts and exit strategies. A failed validation creates `Revisit Required`; it does not authorize a Coding Agent to silently substitute another product.

### 86.3 Corporate Formation and Pilot Operating Profile

Default formation brief：

* jurisdiction：Ontario provincial corporation
* legal name mode：numbered corporation
* ownership planning assumption：one founder / beneficial owner
* authorized share baseline：unlimited voting Common Shares；no preferred or non-voting class in the Pilot brief
* initial issuance baseline：100 Common Shares for aggregate CAD 100 consideration，subject to lawyer / accountant confirmation before filing
* governance baseline：one director；the same eligible individual may initially hold President and Secretary / Treasurer officer roles
* registered office：Ontario professional registered-office / legal-service address；exact address is external evidence
* fiscal year end：December 31
* corporate records：encrypted digital minute book plus legally required originals / certified records
* public product label：`BOP-RMS` remains a project / product label，not the corporation legal name
* business / operating name or trademark：no registration until a formal name and trademark clearance is completed；this does not block software implementation

This is a planning default, not a filed legal instrument. Lawyer / accountant review may change share issuance、officer allocation or registered-office mechanics without reopening the software Architecture or Operating Entity Aggregate.

Pilot operating profile：

* planning City：Toronto, Ontario
* synthetic Store ID：`CA-ON-TOR-PILOT-001`
* Store status：`Planned / Synthetic` until a real address and operating evidence are attached
* Currency：CAD
* Locale：`en-CA` primary；`fr-CA` supported by the localization contract
* Order Types：Dine-in and Pickup enabled
* Dine-in Session Mode：`Staff Started`；fixed Table QR is context-only and Guest Self-Start / Convenience Mode is disabled for the first Pilot
* Delivery：disabled for first Pilot；Delivery Architecture remains frozen and reusable for a later Phase
* Sellable Scope：prepared food and non-alcoholic beverage only；alcohol、tobacco、cannabis、age-restricted item、Gift Card and stored value are disabled
* Customer identity：guest / order-scoped session first；no mandatory customer account
* Merchant staff：named accounts with MFA according to role risk
* no production Customer PII is created while the Store remains Synthetic

### 86.4 Repository、Git and CI Execution Context

Accepted repository profile：

* create a new private GitHub Repository named `bop-rms`
* actual slug：`<github-owner-or-org>/bop-rms`；owner / organization is external identity evidence and cannot be invented
* default local checkout on a Windows host：WSL2 Linux filesystem `~/src/bop-rms`；a non-Windows developer uses the native Linux / macOS workspace root；`/mnt/c`、OneDrive and mixed-filesystem checkout are not defaults
* the Library working directory and this Markdown file are not the application Repository
* current inspected workspace contains no target Git Repository or application files；WP-0001 must not bootstrap inside `library_work`
* default branch：`main`
* branch model：short-lived feature branches
* merge model：Pull Request + squash merge + linear history
* each parallel Coding Task uses an isolated Git worktree on the same native filesystem as the primary checkout；Windows-hosted worktrees remain inside the WSL2 Linux filesystem
* private-Repository protection capability requires an eligible GitHub plan：GitHub Pro for a personal private Repository or GitHub Team / Enterprise for an organization private Repository；the actual plan is external execution evidence and no subscription is purchased by this decision
* `Stage 0 — Seed`：create private Repository and one auditable seed `main` commit containing no business code or Secret；the owner may perform this single pre-ruleset action only because a protected branch and Pull Request cannot target a nonexistent default branch
* `Stage 1 — Bootstrap PR`：all WP-0001 work occurs on a short-lived branch；the Pull Request runs the minimal unique `bootstrap / verify` GitHub Actions check；no independent approval is claimed when no second authorized human exists
* `Stage 2 — Check Protection`：only after `bootstrap / verify` has appeared and passed，enable Pull Request、that required check、conversation resolution、linear history、no direct push、no force push and no deletion on `main`
* `Stage 3 — Human Review`：when a second authorized human Reviewer exists，enable one independent approval、stale-approval dismissal and CODEOWNERS approval for Architecture、Security、Payment、Tax、Privacy、Migration and Infrastructure paths
* `Production Gate`：Stage 3 is mandatory before any production deployment or production PII / payment enablement；solo bootstrap is not misrepresented as independent review
* administrator bypass is disabled after staged activation where the plan / owner model supports it；any unavoidable seed or break-glass bypass records actor、timestamp、reason、scope、diff / commit and follow-up review
* GitHub Actions uses least-privilege permissions and AWS OIDC；no long-lived cloud credential in GitHub Secrets
* environments：`development`、`staging`、`production`；production deploy requires manual environment approval

CI target checks remain：frozen install、format、lint、typecheck、unit、integration、architecture、contract、migration、secret / dependency scan and build. A check becomes required only after its owning Work Package creates it and it has produced an unambiguous successful result；nonexistent future checks are never configured as required. Deployment is not a merge prerequisite until the deployment WP creates the environment.

### 86.5 Exact Engineering Foundation

Core baseline verified on `2026-07-15`：

* Node.js `24.18.0` LTS
* Corepack `0.35.0`
* pnpm `11.13.0`
* Turborepo `2.10.5`
* TypeScript `6.0.3`；TypeScript 7 is not used because the accepted typescript-eslint peer range is `<6.1.0`
* ESLint `10.7.0` + typescript-eslint `8.64.0`
* Prettier `3.9.5`
* Express `5.2.1`
* React / React DOM `19.2.7`
* Vitest `4.1.10`
* Playwright `1.61.1`
* Pino `10.3.1`
* Zod `4.4.3` + `@asteasolutions/zod-to-openapi` `9.0.0`
* `uuid` `14.0.1` for application-owned UUIDv7 generation
* `jose` `6.2.3` for compact JWS parsing / verification behind the Capability Token adapter；KMS performs private-key signing
* `canonicalize` `3.0.0` for RFC 8785 audit canonical JSON
* `sharp` `0.35.3` behind the Media adapter for bounded raster normalization / metadata stripping；its native install is an explicit pnpm build-script allowlist entry
* qpdf `12.3.2` in the isolated Media scanner image for resource-bounded PDF structural check / decoded-object inspection；release signature + digest are pinned，and qpdf is never installed in the API image
* `csv-parse` `7.0.1` + `csv-stringify` `6.8.1` for streaming UTF-8 CSV import / export；relaxed column count、automatic type casting and unbounded record buffering are disabled
* AsyncAPI parser `3.6.0` + AsyncAPI CLI `6.0.2`
* Helmet `8.3.0` for the Express HTTP security-header baseline

Persistence / asynchronous baseline：

* Drizzle ORM `0.45.2`
* Drizzle Kit `0.31.10`
* node-postgres `pg` `8.22.0` as the Drizzle / PostgreSQL driver；do not introduce a second PostgreSQL driver without an IDR revision
* pg-boss `12.26.0`
* PostgreSQL `18.4` development / production major baseline
* Module-owned Repository remains the Domain boundary；Drizzle types never enter Domain / Public Contracts
* pg-boss uses a dedicated schema、role、connection pool and operational dashboard / alert path
* transactional outbox / inbox remains BOP-owned；pg-boss executes jobs but does not own Domain Event semantics
* no Redis / external Cache in v0.1；add only after measured need
* PostgreSQL module projections provide search；no external Search Engine or BI Warehouse in v0.1

Provider / telemetry adapter package baseline：

* OpenTelemetry API `1.9.1` + Node SDK `0.220.0`
* AWS SDK for JavaScript v3 clients `3.1087.0` for S3、SES v2、SNS、Secrets Manager、Cognito Identity Provider and `@aws-sdk/lib-storage`
* Stripe Node SDK `22.3.1`、Stripe.js `9.10.0`、React Stripe.js `6.8.0` and Stripe Terminal JS `0.26.0`
* Cognito OIDC BFF uses server-side `openid-client` `6.8.4`；resource-side Cognito token validation uses `aws-jwt-verify` `5.2.1`
* `oidc-client-ts` and `react-oidc-context` are not Merchant Runtime dependencies；browser JavaScript never receives Cognito access、refresh or ID Tokens
* every package remains behind the accepted Provider Adapter / authentication boundary；SDK objects never become Domain or Public Contract types

All npm versions above were checked against the npm registry on `2026-07-15`. Installation still performs lockfile、license、engine、security and compatibility checks; a newer package existing later is not permission to change the accepted version silently.

### 86.6 IDR-0021 Frontend Foundation — Accepted Detail

Runtime and component baseline：

| Concern | Accepted Choice | Verified Baseline |
| --- | --- | --- |
| Build | Vite + `@vitejs/plugin-react` | `8.1.4` + `6.0.3` |
| Router | React Router | `8.2.0` |
| Accessible primitives | `radix-ui`；BOP-owned wrapper components | `1.6.2` |
| CSS / tokens | Tailwind CSS + `@tailwindcss/vite` + CSS custom properties | `4.3.2` + `4.3.2` |
| Variants / class composition | class-variance-authority、clsx、tailwind-merge | `0.7.1`、`2.1.1`、`3.6.0` |
| Forms | React Hook Form + `@hookform/resolvers` + Zod | `7.81.0` + `5.4.0` + `4.4.3` |
| Server state | TanStack Query | `5.101.2` |
| Data grid | TanStack Table + Virtual | `8.21.3` + `3.14.6` |
| Icons | Lucide React | `1.24.0` |
| Localization | i18next + react-i18next | `26.3.6` + `17.0.9` |
| Date / time presentation | date-fns；Domain time remains Instant + Zone contract | `4.4.0` |
| PWA | vite-plugin-pwa / Workbox with the Section 87 explicit cache allowlist、NetworkOnly denylist and safe-update contract | `1.3.0` |
| Fonts | self-hosted Fontsource packages；no runtime Google Fonts request | Inter Variable `5.2.8`、Noto Sans SC `5.2.9`、JetBrains Mono Variable `5.2.8` |

Frontend rules：

* no Redux in v0.1；server state uses TanStack Query，local interaction state stays component / bounded context，cross-page business facts come from backend contracts
* Radix is a primitive layer，not the visual source of truth；all product components are BOP-owned wrappers with semantic tokens
* no component exposes raw Provider、ORM or HTTP error types
* Forms submit explicit commands；Zod client validation improves UX but backend remains authoritative
* Data Grid is used only for Merchant information density；Customer and Kitchen use purpose-built layouts
* route-level code splitting、bundle budgets、keyboard / screen-reader tests and visual regression are mandatory
* all listed runtime packages use permissive licenses at the registry versions checked；license scan remains a CI gate
* exit strategy：replace one adapter / wrapper at a time without changing Screen、Field、Command or accessibility contracts

### 86.7 Approved Visual and Interaction Artifact

Artifact：`VIS-BOP-PILOT-001 — BOP Pilot Neutral`。

Approval status：`Accepted` under delegated authority on `2026-07-15`。

Exact visual tokens：

* Primary：`#0B5D4B`；On Primary：`#FFFFFF`
* Accent：`#F4B942`；On Accent：`#1F2937`
* Canvas：`#F7F9F7`；Surface：`#FFFFFF`；Raised：`#F0F4F1`
* Text：`#17201C`；Muted Text：`#5B665F`；Border：`#D6DDD8`
* Focus / Info：`#1D4ED8`；On Focus：`#FFFFFF`
* Success：`#16794B`；Warning：`#F59E0B` with dark text；Danger：`#B42318`
* Typography：Inter Variable for English / French UI；Noto Sans SC fallback for later `zh-CN`；JetBrains Mono only for codes、IDs and diagnostic numeric tables
* font files are self-hosted from the accepted Fontsource packages；production UI makes no runtime request to Google Fonts or another font CDN
* Customer：comfortable spacing、food-first imagery、one dominant action、warm neutral surfaces
* Merchant：compact but calm、persistent Store scope、clear draft / published distinction、tabular numerals
* Kitchen / Pickup：high contrast、large status / SLA、touch targets at least 44 × 44 CSS px、no decorative motion
* logo：typographic `BOP` wordmark placeholder；merchant Brand logo remains a Theme asset and cannot alter interaction semantics
* imagery：natural food photography、neutral daylight、no fake menu content in acceptance artifacts
* tone：direct、calm、operational；errors state what happened、what remains safe and the next recovery action
* audit result：all foreground / background pairs specified above meet at least WCAG AA normal-text contrast；state still uses icon / label / pattern and never color alone

Approved flow references：

* `UX-CUST-MENU-001` → Section 80.10.3 Customer Menu
* `UX-CUST-CHECKOUT-001` → Section 80.10.3 Customer Configurator / Checkout
* `UX-MERCHANT-OPS-001` → Section 80.10.3 Merchant Order Queue
* `UX-KDS-PICKUP-001` → Section 80.10.3 Kitchen / Pickup

These text / token artifacts remain the approved implementation reference. Section 90 now selects Figma Design / Make as the visual-materialization workflow；absence of a Figma file does not block WP-0001–0003，but the Section 90 Figma UI Readiness Gate applies before WP-0004 writes shared UI components or any feature UI Work Package begins. Rendered screenshots and Playwright visual baselines remain implementation evidence, not a new business-design choice.

### 86.8 Provider、Cloud and Runtime Decisions

#### 86.8.1 IDR-0022 — AWS Canada Hosting

* primary Region：AWS Canada (Central) `ca-central-1`
* encrypted backup / disaster-recovery copy target：AWS Canada West (Calgary) `ca-west-1` after account-level service verification
* Compute：ECS Fargate behind Application Load Balancer；no Kubernetes / EKS in v0.1
* Container Registry：Amazon ECR
* Database：Amazon RDS for PostgreSQL 18.4，Multi-AZ in production，PITR and encrypted snapshots
* Files：Amazon S3 with SSE-KMS、versioning and lifecycle rules
* Edge：CloudFront only for public / non-PII static assets；private transaction responses are not edge-cached
* Security：KMS、Secrets Manager、WAF、organization-wide CloudTrail、GuardDuty and Security Hub；production enablement cannot silently omit a control because of account tier or budget
* Observability：Pino → CloudWatch Logs；OpenTelemetry / ADOT → CloudWatch Metrics + X-Ray
* Alert routing：CloudWatch Alarms / EventBridge → encrypted Amazon SNS → verified operational email subscriptions；no SMS、Slack or PagerDuty in v0.1
* Backup restore drill and regional failover runbook must pass before live launch

Canadian-region hosting is a chosen risk-minimization baseline，not a claim that PIPEDA universally prohibits cross-border processing. Every external processor still requires contract、subprocessor、access、breach and transparency review.

#### 86.8.2 IDR-0023 — Stripe Canada Payment

* Stripe Canada is the single v0.1 Payment Provider
* online payment uses PaymentIntent + hosted / tokenized Stripe components；application never stores PAN / CVV
* in-person payment uses Stripe Terminal in Canada，CAD only，with `card_present` and `interac_present`
* online Customer payment uses automatic capture after a valid final Quote and capacity / Order precondition；Terminal uses `manual_preferred` only for the accepted-card flow，so Interac is captured in one step and non-Interac card-present authorization is captured immediately after Order acceptance under the Section 87 watchdog
* Stripe Terminal offline collection is disabled for every payment method in v0.1；Interac additionally never receives a separate capture call
* Interac refund uses the required in-person reader flow；refund / chargeback / reconciliation acceptance tests are mandatory
* webhooks require signature verification、raw-evidence retention、idempotency、ordering tolerance and reconciliation
* Stripe test mode + simulated reader + synthetic data precede any live credential
* live activation requires Canadian Stripe account、corporation / Store records、settlement bank、pricing / contract review and professional sign-off

#### 86.8.3 IDR-0024 — Ontario Tax Calculation

* no external Tax SaaS in v0.1
* BOP Tax module owns a versioned `CA-ON` jurisdiction profile reviewed by a qualified Canadian tax professional
* rules resolve place of supply、product / beverage classification、taxability、effective date、price inclusion、rounding、rebate / exemption evidence and receipt presentation
* UI、Catalog、Stripe adapter and Store configuration never hardcode a tax rate
* every Quote / Order / Refund stores the resolved rule version and calculation explanation
* production seed is blocked until accountant-approved test cases cover restaurant meals、beverages、basic groceries / zero-rated cases、discounts、tips、service charges、refunds and mixed baskets

#### 86.8.4 IDR-0025 — Authentication

* Amazon Cognito User Pool is the Merchant / Admin authentication provider in `ca-central-1`
* staging and production use the Cognito `Plus` feature plan；threat protection runs at least 14 days in Audit mode in staging / pre-live production，then Enforced mode blocks compromised credentials、blocks high risk and requires TOTP for medium risk before live login is enabled
* Merchant / Admin Web uses a same-origin Backend for Frontend（BFF）；the BFF is the confidential OIDC client and uses server-side `openid-client` `6.8.4`
* OAuth 2.0 / OIDC Authorization Code + PKCE、exact redirect URI、state、nonce、issuer / audience validation and refresh-token rotation are mandatory；Cognito client credentials stay in Secrets Manager
* Cognito access and ID Token validity default to 15 minutes；refresh / BFF absolute session validity defaults to 12 hours，subject to a shorter risk policy；a token lifetime change requires Identity + Security review
* the BFF receives Cognito access、refresh and ID Tokens only on the server；after issuer / audience / nonce validation it canonicalizes the minimum identity claims and discards the raw ID Token，retaining an encrypted refresh token and only a still-required access token；no Token appears in browser JavaScript、Web Storage、IndexedDB、Service Worker persistence、URL、analytics or logs
* browser state is one opaque high-entropy session identifier in `__Host-bop-merchant` with `Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/` and no `Domain` attribute；the server stores only a keyed hash of the identifier plus Actor、Account、auth time、idle / absolute expiry and revocation facts
* standard Merchant idle timeout is 30 minutes；privileged Platform Admin / Owner / Finance idle timeout is 15 minutes；high-risk identity、permission、PII export、payment configuration and infrastructure actions require recent MFA / step-up authentication
* session creation and privilege elevation rotate the Session ID；logout、membership disable、role removal、credential reset and detected compromise revoke the server session and related refresh token
* all state-changing BFF requests are same-origin JSON requests and require exact Origin / Fetch Metadata validation plus a session-bound `X-BOP-CSRF` token held only in page memory；permissive credentialed CORS is prohibited
* BFF responses containing identity、authorization or transaction data use `Cache-Control: no-store`；the browser receives only the minimum canonical Actor / Membership / Store Context required by the screen
* MFA is mandatory for Platform Admin、Owner、Manager、Finance and high-risk support roles
* Identity Domain retains canonical User、Membership、Role、Store assignment、session revocation and external identity link
* Customer v0.1 QR / signed context resolves to a server-side order-scoped Guest Session；the browser receives only `__Host-bop-guest` with `Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/` and no `Domain` attribute
* Guest Session identifiers / credentials never enter Web Storage or Service Worker persistence；the session is limited to one Store / Cart / Order context，rotates at Pickup / Delivery checkout or any binding change；for Dine-in，an individual Batch submission is not Session checkout，so the same authorized Guest Session remains valid across Batches in the same active Dining Session and rotates only at final Session checkout / closure or another binding change；it expires after 4 hours idle、24 hours absolute or 2 hours after Order closure，whichever applicable limit occurs first
* mandatory Customer accounts are out of scope；Guest access never grants Merchant capability or arbitrary Customer / Order lookup
* provider subject、email or token is never used as Tenant / Brand / Store authorization by itself
* acceptance tests cover login CSRF、authorization-code injection、session fixation、Cookie flags、CSRF rejection、token / secret leakage、idle / absolute expiry、logout / revocation、role and Store switch、concurrent-session termination and cross-Tenant denial

#### 86.8.5 IDR-0026–0029 — Storage、Notification、Deployment and Database

* S3：private by default、SSE-KMS、presigned upload、content-type / size validation、malware scan、retention / legal hold、environment separation
* SES：transactional email only；verified domain、DKIM / SPF / DMARC、bounce / complaint suppression、localized templates、deduplicated Notification request and explicit unknown / resend attempt handling；SMS and marketing messaging disabled
* AWS CDK `2.261.0` + constructs `10.7.0`：TypeScript IaC synthesized to CloudFormation；AWS Organizations separates management、security / log archive、development、staging and production accounts，and no workload runs in the management account
* GitHub Actions deployment uses OIDC；database migration is a reviewed one-shot task before application rollout；production requires manual approval and rollback evidence
* RDS PostgreSQL 18.4 uses encryption、Multi-AZ、PITR、least-privilege roles、separate schema ownership and tested restore；no public endpoint

Excluded from first Pilot：third-party Delivery Provider、Map Provider、SMS Provider、external Cache、external Search、BI Warehouse、ML runtime、vendor-specific Printer / POS SDK and independent Streaming Platform. Their existing adapters / architecture remain available only when a future trigger is accepted.

### 86.9 Privacy、Retention and Security Defaults

* production Customer / Employee PII primary storage stays in `ca-central-1` where the selected service supports it
* cross-border Stripe、GitHub or support processing requires Data Processing Agreement / contract review、subprocessor inventory、comparable safeguards and clear privacy notice
* TLS 1.2 minimum；TLS 1.3 preferred；encryption at rest uses service-managed or customer-managed KMS according to data class
* no Secret in Repository、logs、events、analytics or business configuration；all production secrets use Secrets Manager and rotation runbooks
* tax、accounting、receipt、payment and supporting business records：retain seven years from fiscal-year end as an operational buffer over CRA's general six-year rule，or longer under legal hold / professional direction
* corporate share register、minute book and records affecting sale / liquidation：retain indefinitely unless counsel directs otherwise
* normalized Order / Payment / Refund facts：seven years；unnecessary Customer contact fields anonymized after 24 months from the last closed transaction unless consent、dispute、legal hold or another valid purpose applies
* restricted raw Stripe webhook / provider payload：30 days by default，extended only for an open dispute / investigation；normalized evidence follows the transaction retention rule
* application logs：30 days hot；security / audit archive up to 365 days unless the classified Audit Record requires the seven-year policy；PII / secret redaction mandatory
* import result artifacts：90 days as already registered；malware quarantine follows incident policy
* deletion is policy-driven anonymization / controlled deletion；financial facts and legal-hold records are never silently erased
* every breach creates a Breach Record；real-risk assessment、reporting and notification follow the applicable PIPEDA process

### 86.10 External Execution Evidence — Not Open Decisions

| Evidence Area | Required Real Evidence | Blocks |
| --- | --- | --- |
| GitHub | owner / org、Repository URL、private-branch-protection plan capability、permissions、clean initial state、human Reviewer availability、current governance stage and any seed / break-glass record | WP-0001 remote execution / protected merge；independent approval and CODEOWNERS block production enablement, not solo bootstrap |
| Local environment | checkout path、Node / pnpm / Docker availability、command results | WP-0001 execution |
| Corporation | real incorporator / owner / director / officer identity、address、consent、share subscription、lawyer / accountant filing approval | incorporation / live Operating Entity record |
| Tax | BN / RC / RT or other program accounts、effective dates、accountant-approved rule cases | live tax / receipt output |
| Store / Food Safety | lease / authorization、real address、permits、menu / supplier / Recipe / allergen evidence、training、device / network inventory and continuity plan | live Store onboarding、Menu publication / UAT |
| AWS / Domain | account / organization、Region availability、contract / budget、KMS / backup / access、registrar / DNS / certificate and security-control evidence | cloud deployment and public hostname |
| Stripe | Canadian account、business verification、bank settlement、Terminal reader、pricing / contract、sandbox acceptance | live payment |
| Identity | Cognito Plus User Pool / pricing、confidential app client、exact redirect / logout URI、Threat Protection audit / enforce evidence、Secrets Manager rotation、BFF Session Store / KMS、first-Owner approval、Cookie / CSRF / fixation / revocation threat-test evidence | Merchant authentication and production identity enablement |
| Notification | SES regional availability / Production Access、verified sending domain、DKIM / SPF / DMARC、SNS event / suppression and deliverability evidence | production email receipt / resume delivery |
| Records | professional retention / legal-hold schedule、Object Lock configuration and archive / restore verifier evidence | statutory-record archive and live legal receipt retention claim |
| Privacy / Security | DPA / subprocessor review、PIA / threat model、incident contacts、penetration / recovery evidence | production PII |
| Accessibility / Devices | real browser、tablet、KDS and assistive-technology results；printer results only after IDR-0039 physical-output trigger | corresponding feature release |

No agent may fabricate these values or mark them `PASS` without evidence. Missing evidence does not reopen the accepted design; it blocks only the relevant execution or live-enablement gate.

### 86.11 Final Readiness Result

The complete handoff result is：

* Architecture、Domain、Registry、Workflow、Screen、Field、Projection、API / Event、NFR、Security and Work Package planning：`PASS for current baseline`
* all current Product / Architecture / Implementation / Provider choices that can be delegated before coding：`Accepted`
* frontend design direction and component stack：`Accepted`
* Canada / Ontario / Toronto Pilot planning profile：`Accepted`
* Repository / CI / Git strategy：`Accepted`
* no additional user decision is required before collecting WP-0001 execution evidence
* later Coding Agents may make only file-local implementation choices that remain inside accepted contracts；they must not ask the user to reselect an accepted global choice
* any material scope、legal fact or failed validation uses the existing ADR / IDR Revisit process
* coding is still not authorized by this completion pass

Next allowed action after an explicit user instruction to start coding：create or connect the new private GitHub `bop-rms` Repository、verify the actual environment and Git state，then execute `WP-0001` without reopening this baseline.

### 86.12 Primary Verification Sources

* [Government of Canada — Registering a corporation](https://www.canada.ca/en/services/business/start/register-with-gov/register-corp.html)
* [Government of Canada — Incorporating in a province or territory](https://www.canada.ca/en/services/business/start/register-with-gov/register-corp/register-corp-prov.html)
* [Ontario Business Corporations Act](https://www.ontario.ca/laws/statute/90b16)
* [Node.js release schedule and current v24 LTS](https://nodejs.org/en/about/previous-releases)
* [PostgreSQL versioning policy](https://www.postgresql.org/support/versioning/)
* [Amazon RDS PostgreSQL supported versions](https://docs.aws.amazon.com/AmazonRDS/latest/PostgreSQLReleaseNotes/postgresql-versions.html)
* [AWS Regions and Availability Zones](https://aws.amazon.com/about-aws/global-infrastructure/regions_az/)
* [GitHub protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches)
* [GitHub required reviews and self-approval limitation](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/approving-a-pull-request-with-required-reviews)
* [Stripe Terminal Canada regional requirements](https://docs.stripe.com/terminal/payments/regional?integration-country=CA)
* [CRA charge and collect GST/HST](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/gst-hst-businesses/charge-collect-which-rate.html)
* [CRA Basic Groceries GST/HST memorandum](https://www.canada.ca/en/revenue-agency/services/forms-publications/publications/4-3/basic-groceries.html)
* [CRA record location and retention](https://www.canada.ca/en/revenue-agency/services/tax/businesses/topics/keeping-records/where-keep-your-records-long-request-permission-destroy-them-early.html)
* [Office of the Privacy Commissioner — cross-border processing](https://www.priv.gc.ca/en/privacy-topics/airports-and-borders/gl_dab_090127/)
* [Office of the Privacy Commissioner — breach obligations](https://www.priv.gc.ca/en/privacy-topics/business-privacy/breaches-and-safeguards/privacy-breaches-at-your-business/gd_pb_201810/)
* [IETF OAuth 2.0 for Browser-Based Applications active draft — BFF guidance](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-browser-based-apps)
* [OWASP HTML5 Security Cheat Sheet — browser storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html)
* [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
* [OWASP Cross-Site Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)

---

## 87. Autonomous Final Pre-Code Hardening and Defect Closure（Accepted）

### 87.1 Authority、Supersession and Result

用户于 `2026-07-15` 明确授权：后续 pre-code 缺陷无需逐项确认，由本交接包直接完成全部可合理预先决定的修复。

本节是最终规范性基线，覆盖 Section 80、86 及更早章节中与下列安全、缓存、运行和 launch gate 冲突的描述。它不会重新打开已经接受的 Product、Market、Architecture、Provider、Visual 或 Repository 决定。

Canonical result：

* `All User-Delegable Pre-Code Decisions = PASS`
* `Autonomous Hardening Findings = Closed`
* `No Active Discussion Node`
* `WP-0001 Specification / Decision Ready = PASS`
* `WP-0001 Execution Ready = PENDING — explicit coding authorization and real Repository / environment evidence only`
* `Production / Live Enablement = BLOCKED until the evidence gates below pass`
* `Implementation Progress = 0%`

本节没有创建 Repository、代码、账号、法人、Store、云资源或 Provider 凭据，也不构成编码授权。无法伪造的外部事实继续作为 evidence gate；它们不再被误写成待用户选择的设计问题。

### 87.2 Accepted Hardening Record Index

Section 80.1.1 的全局 IDR metadata、rollback 和 revision 规则适用于以下记录。

| Record | Accepted Decision | Owner / Mandatory Review | Owning Work Packages | Validation / Revisit Trigger |
| --- | --- | --- | --- | --- |
| `IDR-0025 Revision 1` | Cognito same-origin BFF uses a PostgreSQL Identity-owned Session Store；workforce invitation、TOTP MFA、recovery and concurrent-session policy are fixed below | Identity / Security、Privacy、Architecture | WP-0100、0106–0109、2040 | fixation、revocation、recovery、load or privacy test fails |
| `IDR-0027 Revision 1` | SES remains transactional-only；domain authentication、suppression、idempotent receipt / resume delivery and no-tracking privacy controls are fixed | Notification / Security、Privacy、Product、Operations | WP-1720–1724、2028 | regional、deliverability、bounce / complaint or token-leak evidence fails |
| `IDR-0029 Revision 1` | PostgreSQL initialization、UUIDv7、collation、extension allowlist and connection budget are fixed below | Data / Security、Architecture、Platform | WP-0020–0024、2005 | RDS / ICU / extension compatibility or query evidence fails |
| `IDR-0030` | Customer PWA uses an explicit public-cache allowlist；all transaction / identity routes are NetworkOnly；no background mutation replay | Frontend / Security、Ordering、Payment、Privacy | WP-1707–1708、2049 | Cache Storage leak、stale transaction or unsafe update is observed |
| `IDR-0031` | QR、Dining Join、Order Resume、Order Reference and Pickup Proof use the capability and abuse-control contract below | Security / Store Ops、Ordering、Fulfillment、Privacy | WP-1002–1006、2042、2048 | enumeration、replay、copied-QR、cross-Store or usability test fails |
| `IDR-0032` | strict same-origin HTTP、CSP / security headers、request limits、upload quarantine and outbound SSRF controls | Security / Frontend、API、Platform、Privacy | WP-0004、0121、2047、2054 | browser / Stripe compatibility or penetration test fails |
| `IDR-0033` | AWS Organizations account separation、identity / SCP guardrails、private workload network、immutable digest deployment and verifiable software-supply-chain evidence | Platform / Security、DevOps、Architecture | WP-2050、2060–2066 | account、cost、provenance、drift or rollout controls cannot meet the gate |
| `IDR-0034` | Multi-AZ primary plus encrypted Canada cross-Region backup and read-replica DR profile is required for the accepted transaction RPO / RTO | Data / Platform、Security、Finance、Operations | WP-0025、2053 | Region / engine support、lag、cost or drill misses RPO / RTO |
| `IDR-0035` | Stripe direct-account online / Terminal capture、webhook authority、refund and reconciliation state contract is fixed below | Payment / Finance、Security、Store Ops、Ordering | WP-1301–1308、2045 | Stripe capability、Interac、settlement or reconciliation evidence fails |
| `IDR-0036` | necessary-cookie-only v0.1、no advertising / session replay、classified retention、rotation、privacy-rights workflow、tamper-evident audit and statutory-record archive | Privacy / Security、Compliance、Data | WP-0042、0046、2043、2051–2052、2055 | PIA、legal、key rotation、archive or audit verification fails |
| `IDR-0037` | Ontario corporate-record and Toronto Store launch evidence checklist gates live operation；it does not gate provider-neutral code | Compliance / Legal、Finance、Store Ops、Product | formation / Store onboarding plan | professional or authority evidence changes an applicable obligation |
| `IDR-0038` | same-origin Server-Sent Events is the only v0.1 Realtime browser transport；it carries lossy hints，never commands or source truth | Platform / Security、Frontend、Operations | WP-0036、1405、1705 | bidirectional transport or measured connection limits require WebSocket review |
| `IDR-0039` | first live Pilot uses a named-operator browser KDS + immutable digital receipt；Store Gateway、physical printer and offline command queue are disabled | Store Ops / Product、Architecture、Security、Accessibility | WP-1408、1709、1804、1808；SPIKE-1500 only on later trigger | accepted Store requires physical output or KDS device / identity evidence fails |
| `IDR-0040` | application authorization plus mandatory PostgreSQL RLS protects Brand / Store-owned rows；ordinary Runtime has no bypass | Security / Data、Architecture、Module Owners | WP-0103、2005、2041 | pool-context leakage、unsupported query or material performance failure |
| `IDR-0041` | first Pilot locks Staff-started Dine-in and a structured allergen disclosure / assistance workflow；a fixed Table QR or free-text note never authorizes ordering or promises allergen safety | Food Safety / Store Ops、Catalog、Kitchen、Privacy、Product | WP-1006、1028、1407、2027 | professional policy、supplier / recipe evidence or Pilot workflow cannot meet the safety gate |

No Coding Agent may replace one of these choices silently. A failed validation sets only the affected IDR to `Revisit Required` and records the evidence.

### 87.3 IDR-0030 — PWA Cache、Offline and Update Contract

Workbox Cache Storage is separate from the HTTP cache；`Cache-Control: no-store` remains mandatory for private responses but is not, by itself, the Service Worker routing policy. Runtime caching therefore uses a deny-by-default route table.

| Request / Resource Class | Required Strategy | Cache Scope / Maximum | Offline Behavior |
| --- | --- | --- | --- |
| hashed application JS、CSS、self-hosted font and static shell assets from the same deployment | Precache / `CacheFirst` | cache name includes deployment ID；immutable hash key；old cache removed only after safe activation | shell may open；no claim that business data is current |
| versioned public food image / public Brand asset on the separate CloudFront asset host | outside Service Worker Cache Storage；immutable CloudFront + HTTP cache | content-hash key；30 days；no Cookie、Authorization、PII or user query | offline shell uses an accessible placeholder when the browser HTTP cache lacks the image |
| public Menu / Store / Sellable GET from `/api/v1/public/*` | `NetworkFirst` with 3-second network timeout | only `GET` + `2xx` + `X-BOP-Cache-Class: public`；5 minutes；key includes deployment、Store、locale、Menu Version and request variant | latest cached public snapshot may display as explicitly `Offline / Possibly Outdated / Read-only` |
| navigation document | `NetworkFirst` with static offline fallback | never caches personalized HTML or redirect / error response | offline shell only |
| `/auth/*`、`/bff/*`、Guest Session、Cart、Quote、Checkout、Order、Payment、Refund、Receipt、Support、PII、Merchant and Admin requests | `NetworkOnly` and explicit Workbox denylist | never enters Cache Storage regardless of HTTP method or response header | fail closed；show recovery state |
| `POST`、`PUT`、`PATCH`、`DELETE` and any command / Provider callback | `NetworkOnly` | zero cache and zero Service Worker queue | no background execution or replay |

Mandatory rules：

* cacheable public endpoints are credential-free and requested with `credentials: omit`；they cannot vary by Guest Cookie、Actor、Cart、Order or Customer
* public JSON responses use `Cache-Control: no-store` at the browser / intermediary layer plus the explicit `X-BOP-Cache-Class: public` marker；only the owned Service Worker may place an eligible response in its versioned Cache Storage allowlist
* unknown routes default to `NetworkOnly`，not to a generic runtime-cache strategy
* `workbox-background-sync` and equivalent mutation replay are not installed or registered in v0.1
* foreground retry is explicit，shows the prior outcome as `Unknown` when necessary，and reuses the original Idempotency Key；a retry never manufactures a new Order or Payment key
* cached Menu never supplies an authoritative Quote、tax、capacity、availability、Checkout or Payment amount；network recovery always requotes and requires explicit confirmation when facts changed
* cached allergen / ingredient disclosure keeps its pinned Menu / Recipe-policy version and is visibly `Possibly Outdated` with Allergen Assistance disabled；the offline screen directs the Customer to Staff and never claims current safety information
* offline mode disables Checkout、Order submission、Payment、refund、support mutation and Merchant operational commands；only the cached public Menu and unsaved in-memory UI selection may remain visible
* Service Worker cache names include deployment ID and cache-schema version；activation deletes obsolete BOP caches but never arbitrary origin caches
* Service Worker script is same-origin、scope-limited to the Customer PWA、served with `Cache-Control: no-cache` and never itself stored by a Workbox runtime route；Merchant / Admin hostname does not register the Customer Service Worker
* Store / locale / Menu change cannot reuse a response from another scope；logout or Guest Session revocation leaves no private cache to clear
* TanStack Query persistence is disabled for private / transaction queries；logout、Session revocation、Store / role switch and Guest Order closure cancel requests and clear the relevant in-memory query / form state before navigation
* browser `pageshow` / back-forward-cache restoration revalidates Session and scope before rendering sensitive content；the screen remains covered by a neutral loading state until validation succeeds
* a new Service Worker may download in the background but cannot call unconditional `skipWaiting` during Cart、Checkout、Payment handoff、Order confirmation or Pickup proof display；the UI activates it only at a safe route boundary or after explicit user consent
* a security revocation may force activation，but must first preserve the Idempotency / recovery reference and present a deterministic recovery screen

WP-1708 / WP-2049 acceptance inspects Cache Storage directly and proves：no private response or identifier exists；cross-Store / locale cache isolation；stale labels and disabled commands offline；no duplicate mutation after reconnect；and no lost outcome when an update arrives mid-payment.

### 87.4 IDR-0031 — Public Capability、QR、Order Resume and Abuse Control

#### 87.4.1 Capability Boundaries

* a dining / table QR is context，not authorization；it may select Brand、Store、Table、Channel and locale but never grants Merchant capability or arbitrary Order access
* static QR payload is a compact `ES256` signed record containing schema version、`kid`、Store / Table / Channel references、issued / expiry time and revocation version；the private key is non-exportable in KMS and verification accepts only an explicit current / overlap key set
* default QR validity is 180 days；reprint / rotate starts 30 days before expiry，and Store closure、table reassignment、key compromise or revocation-version change invalidates it immediately
* the first Pilot uses `Staff Started` Dine-in and disables `Convenience Mode` / `Guest Self-Start`；a fixed Table QR may browse the public Menu and propose Table context，but cannot join a Dining Session、create a Dining Order or become Host by itself
* an authorized Staff action opens the Dining Session；joining requires a separate 128-bit invitation link or six-digit short code bound to Store、Table and Session，valid for 15 minutes and invalidated on successful join、regeneration、Session closure or Table reassignment；short-code attempts use the stricter budget below
* a verified QR creates only a context-limited Section 86 server-side Guest Session after Store status and abuse checks；Pickup may order through the accepted Store context，while Dine-in Order commands additionally require an active Dining Session credential；invalid input receives a uniform public error and never reveals whether an internal Store / Table ID exists
* `orderReference` is a 128-bit-or-stronger random public display / routing reference，but it is not a bearer credential；every Order / Receipt query also requires a Guest Session authorized for that exact Store and Order
* an out-of-band Order Resume link uses `https://<customer-host>/resume#t=<token>` with a separate 256-bit single-use random token in the URL fragment；the fragment is not sent in the HTTP request，and the server stores only its keyed hash、purpose、Order scope、expiry and consumption fact；default expiry is 30 minutes
* the minimal no-third-party resume page reads the fragment into memory，immediately calls `history.replaceState` to remove it，then sends one same-origin redacted-body `POST` to the NetworkOnly resume endpoint；the Service Worker、telemetry、Referrer、ALB / application access log and Web Storage never receive the token
* successful POST consumes the token atomically，sets / rotates the Guest Session and returns only the clean `/orders/:orderReference` redirect path；failure clears memory and returns a uniform recovery screen
* resume token plaintext exists only in the notification worker memory and delivered message；Outbox / Notification records store the token record ID / hash reference，not rendered body or link，and SES open / click tracking is disabled
* Pickup Proof uses either a 128-bit signed / opaque QR proof or a six-digit human code bound to Store、Fulfillment and Ready state；default validity is 60 minutes after Ready or until completion / cancellation，whichever is first；regeneration invalidates the prior proof
* Pickup Proof never bypasses Fulfillment readiness、quantity、staff permission or already-completed checks；a Manager Override requires reason、step-up and Audit

#### 87.4.2 Default Abuse Budgets

These are conservative v0.1 application + WAF defaults，not capacity claims. Keys combine IP、Session、Store、Account and resource as specified；trusted-proxy parsing accepts forwarded IP only from the owned ALB / CloudFront chain，canonicalizes IPv4 and an IPv6 `/64` prefix before keyed hashing，and ignores a client-injected forwarding chain.

| Endpoint Class | Default Budget | Failure / Recovery Behavior |
| --- | --- | --- |
| public Store / Menu / Sellable read | 120 requests / minute / IP and 600 / minute / Store；burst 30 | `429` + `Retry-After`；cached public read may remain available |
| QR Resolve | 60 / 5 minutes / IP and 600 / 5 minutes / Store；burst 20 | uniform invalid / expired response；no identifier oracle |
| Guest Session create / rotate | 20 / 10 minutes / IP and 300 / 10 minutes / Store | progressive delay，then `429` |
| Dine-in Session Join failures | 5 / 10 minutes / Session and 20 / 10 minutes / IP / device | invalidate / cooldown after threshold；Staff may regenerate after identity / Table check |
| Cart / Quote | 60 / minute / Guest Session and 300 / minute / IP | idempotent retry allowed；invalid Session fails closed |
| Checkout / Create Order / Create Payment | 10 / 10 minutes / Guest Session and 50 / 10 minutes / IP | original Idempotency Key and operation reference returned；Kill Switch on anomaly |
| Order Resume request / consume | 5 / hour / Order / contact / IP combination | generic response whether the Order or contact exists |
| Pickup Proof failures | 5 / 10 minutes / Fulfillment and 20 / 10 minutes / device / IP | 15-minute cooldown；audited Manager recovery path |
| Merchant login failures | 10 / 15 minutes / Account + IP risk combination | generic error、progressive delay、Cognito / WAF protection and security alert on threshold |
| signed Provider webhook | size、signature、timestamp、Provider Account and queue-backpressure policy | a valid signed event is not discarded solely because many Provider events share one source IP；durable inbox + alert / reconciliation absorbs bursts |

Rate-limit configuration is versioned、observable and load-tested. Lowering protection below these defaults requires Security approval and an expiring risk record；emergency tightening may occur through WAF / Kill Switch without a Product redesign.

Implementation split is fixed：AWS WAF owns coarse IP / path burst control；an atomic PostgreSQL `security.abuse_bucket` time-bucket table owns Session、Account、Store、Order and Fulfillment combinations，with keyed-hash identifiers and scheduled expiry. In-memory counters are advisory only，and Redis is not introduced. If the application limiter is unavailable，login、resume、pickup、checkout and payment creation fail closed；public read remains protected by WAF and a bounded degraded policy.

Raw abuse buckets expire after 24 hours；only an alert / Security Case aggregate may remain up to 365 days. IP and device evidence is treated as `Confidential` personal / security data，is not reused for marketing and is never exposed to a Merchant as a raw cross-Customer list.

### 87.5 IDR-0032 — HTTP、Browser、Upload and Outbound Security Contract

#### 87.5.1 Same-origin and Security Headers

* Merchant、Admin and Customer browser APIs are same-origin；credentialed cross-origin CORS is disabled；server-to-server webhooks have dedicated routes and never enable browser credentials
* `GET`、`HEAD` and `OPTIONS` never execute a business mutation；the narrowly scoped OIDC callback may consume its one-time authorization transaction，and all other state changes require the declared command method、JSON content type、CSRF proof and Idempotency contract where applicable
* HTTP method override、JSONP、form-encoded command fallback and open redirect parameters are disabled
* production sends HSTS with `max-age=31536000; includeSubDomains` only after every owned subdomain is HTTPS-ready；preload is a separate operational approval
* all HTML / API responses use `X-Content-Type-Options: nosniff`、`Referrer-Policy: strict-origin-when-cross-origin` and an explicit `Permissions-Policy` denying camera、microphone、geolocation、USB、Bluetooth and payment features unless an accepted route-specific integration requires the minimum permission
* Merchant / Admin and ordinary Customer documents use `Cross-Origin-Opener-Policy: same-origin`；Customer payment / 3DS routes use `same-origin-allow-popups` only where Stripe testing requires it；private APIs / assets use same-origin `Cross-Origin-Resource-Policy`，while the separate public-image host uses `cross-origin` plus exact CORS；COEP is not enabled in v0.1 because Stripe frames are an accepted cross-origin dependency
* interactive BOP pages use `frame-ancestors 'none'` and `X-Frame-Options: DENY`；an embedding use case requires an IDR revision
* no page uses inline executable script or `eval`；online HTML has a per-response CSP nonce for any owned script element that requires one，while the precached offline fallback contains no inline executable script and loads only same-origin hash-versioned assets
* base CSP is deny-by-default：`default-src 'self'`、`object-src 'none'`、`base-uri 'none'`、`form-action 'self'`、`frame-ancestors 'none'`、`script-src 'self'` plus nonce、`connect-src 'self'`、`font-src 'self'`、`manifest-src 'self'` and `worker-src 'self'`；`img-src` adds only the exact owned public-asset hostname plus reviewed `data:` / `blob:` cases
* style elements use owned files / nonce；`style-src-attr 'unsafe-inline'` is allowed only for reviewed component positioning / CSS-variable compatibility，never as permission for inline script
* Stripe payment routes extend only the exact Stripe script、frame and connection origins proven necessary by the accepted Stripe integration；wildcards and unrelated third-party origins are prohibited
* CSP begins in `Report-Only` in development / staging，with violation collection and zero unexplained production-flow violations，then becomes enforcing before production PII / Payment
* the CSP reporting endpoint accepts at most 64 KiB without Cookie / business authorization，rate-limits abuse、drops query / fragment / sample content、normalizes document / blocked URLs to approved origin + route class and expires raw reports after 7 days
* public / transaction pages never load advertising pixels、third-party tag managers、session replay or remote fonts

#### 87.5.2 Request and Response Limits

* default JSON request body maximum is 1 MiB；authentication、QR、public command and ordinary form endpoints use a 64 KiB maximum unless their contract states less
* Stripe webhook raw-body limit is 1 MiB unless Stripe evidence requires a reviewed increase；signature verification occurs against the untouched raw bytes before parsing
* upload bytes never pass through the general JSON API；they use the quarantined S3 flow below
* application request headers are limited to 100 fields / 16 KiB total and the target URL to 8 KiB；a lower managed ALB limit wins；multipart part count and decompressed size are finite，and oversize input returns a stable `413` / `414` / `431` without echoing the payload
* the edge and Fastify reject conflicting / duplicate `Host`、`Content-Length`、`Transfer-Encoding` or authority semantics，ambiguous encoded slash / dot-segment paths and response-header control characters；request-smuggling / path-normalization fixtures are mandatory
* Zod command schemas are strict and reject unknown / prototype-pollution keys；Tenant、Actor、role、price、tax、currency、permission and lifecycle state are always server-derived or revalidated，never mass-assigned
* v0.1 Catalog / Customer-authored display fields are plain text；HTML and Markdown input are rejected，React renders text nodes without `dangerouslySetInnerHTML`，and external links are separate validated `https` fields with safe `rel` behavior
* API request timeout defaults to 15 seconds；Provider operations use an operation reference and bounded adapter timeout rather than holding an unbounded browser connection
* response compression is disabled for responses containing secrets or attacker-controlled reflection when it would create a compression side channel
* all object reads and writes perform server-side Tenant、Store、Actor / Guest Session、purpose and field-level authorization；`404` / `403` behavior cannot become an enumeration oracle
* WAF logging redacts `Cookie`、`Authorization`、CSRF、request body and declared sensitive query fields；application access log records route templates rather than raw path parameters，and no general request / response body logging middleware is enabled

#### 87.5.3 Upload and SSRF / Egress Controls

* browser uploads use a short-lived S3 presigned `POST` policy bound to Actor / Guest Session、Tenant、purpose、exact random quarantine key、declared type、SSE-KMS fields and `content-length-range`；the client never chooses an arbitrary bucket or final object key
* object names are random；original filename is metadata after normalization and is never a filesystem path or executable response header
* Upload Session is one-time and expires after 15 minutes；finalize re-authorizes purpose / owner and verifies S3-reported key、version、size、checksum、encryption and declared metadata，then closes the Session atomically；a client success callback alone never marks an object clean
* new objects land in a quarantine prefix / bucket；server-side type sniffing、size / decompression limits and malware scan must pass before an immutable clean version becomes referenceable
* Amazon GuardDuty Malware Protection for S3 is the accepted malware scanner；EventBridge consumes its tagged result，and only a clean result may invoke the Media promotion job；actual `ca-central-1` capability / quota evidence is a live gate and failure sets IDR-0032 to `Revisit Required`
* uploaders cannot set / overwrite scan、processing or clean tags；promotion rechecks the exact quarantine bucket + Version ID + checksum + GuardDuty result，then server-side copies to a new random clean key under the Media role and records immutable provenance before deleting quarantine only according to policy
* abandoned / unscanned quarantine objects expire after 24 hours；malicious / scanner-failed objects are inaccessible to ordinary users and retained 30 days for the restricted Security Case，then deleted unless an active incident / legal hold records a later date
* active HTML、SVG、script and executable content is rejected for food / Brand images；downloads of non-display evidence use `Content-Disposition: attachment` and a safe content type
* accepted raster images enforce pixel / dimension limits，normalize orientation，strip EXIF / GPS / IPTC / XMP metadata and are re-encoded into an approved derivative；the public asset is the derivative，not the untrusted original
* public image input allowlist is JPEG、PNG and WebP，maximum 10 MiB and 25 megapixels；output is bounded JPEG / WebP at 320、640 and 1280 px widths；animation is flattened and SVG / GIF / AVIF upload is disabled in v0.1
* private evidence allowlist is PDF、JPEG and PNG，maximum 25 MiB；an isolated no-network qpdf `12.3.2` scanner runs `--check` + decoded-object inspection with 30-second wall time、512 MiB memory、200-page、100,000-object and 100 MiB total-decoded-stream ceilings，and rejects encryption、parse repair warning、JavaScript / OpenAction / additional action、Launch / URI action、XFA、RichMedia、embedded file / attachment or limit breach；Catalog / Inventory v0.1 import accepts UTF-8 CSV only，maximum 10 MiB / 100,000 rows；XLSX / XLSM、PDF table import、archive and nested container are disabled
* CSV parsing is streaming with optional UTF-8 BOM removal、comma delimiter、RFC-style quoting、at most 200 columns and 64 KiB per field；headers must exactly match a versioned template，column count is strict、automatic type casting is off and every mapped cell / row passes the owning Zod / authorization / cross-reference contract before Preview / Commit
* an ordinary private-evidence signed download URL lasts at most 5 minutes and is issued only after a fresh authorization check；it uses a generic non-PII filename，never enters telemetry / referrer，and is not claimed to be single-use；private S3 objects are never public or CloudFront-cacheable，and untrusted originals are served as attachment from a no-BOP-Cookie S3 download hostname rather than rendered inline on a Session origin
* v0.1 export is asynchronous UTF-8 CSV or canonical JSON only、Tenant / field-permission trimmed and audited；CSV prefixes text cells beginning with `= + - @`、tab or carriage return so spreadsheet software cannot execute a formula，while typed numeric values serialize as numbers，and JSON is used when exact raw text must be preserved；XLSX / macro / PDF export is disabled
* export artifact is encrypted、expires after 24 hours and is limited to 100,000 rows / 100 MiB；its application grant is atomically consumed once and the authorized BFF streams the object with `no-store` / attachment rather than returning a reusable presigned URL；cancellation prevents unbounded work，and PII export requires the Section 87 Support / step-up controls
* remote business-content URL import is disabled in v0.1；the only security-metadata fetch is the IDR-0027 SNS signing certificate from the exact approved AWS SNS HTTPS hostname / path with no redirect；any later outbound fetch requires an explicit HTTPS host allowlist、DNS resolution and redirect revalidation，blocks loopback、private、link-local、multicast、metadata and non-HTTP schemes，caps bytes / time and does not forward inbound credentials
* production ECS task subnets have no direct Internet route；AWS service traffic uses VPC endpoints where supported，and the remaining outbound TLS path traverses per-AZ NAT + AWS Network Firewall with a stateful SNI / HTTP-host allowlist and central flow / alert logs；the application adapter also validates exact scheme / host / certificate，and an unregistered destination fails closed

WP-2047 and WP-2054 include CSP browser tests、CORS preflight / credential denial、header snapshots、body-limit tests、polyglot / decompression-bomb fixtures、malware quarantine、presigned-URL scope and DNS-rebinding / redirect SSRF tests.

### 87.6 IDR-0025 Revision 1 — Identity and Session Completion

* workforce public self-signup is disabled；a named Actor is invited only after an approved Membership / Store assignment exists，and acceptance verifies the intended email without using email as authorization
* Platform Admin、Owner、Manager、Finance and high-risk Support use TOTP MFA in v0.1；SMS MFA is disabled；recovery is a controlled identity-proofing / break-glass workflow with revocation and Audit，not an email-only bypass
* password baseline for password-capable workforce accounts is at least 14 characters with the previous 10 values blocked，generic login / recovery messages and no forced periodic reset absent compromise；temporary credentials expire within 24 hours
* Cognito account recovery is `admin_only` for the invite-only workforce pool；self-service email / SMS password recovery and SMS MFA are disabled，and an authorized recovery command performs the identity-proofing / approval / Session-revocation workflow before Cognito issues a one-time temporary credential
* staging / production Cognito uses the `Plus` feature plan；threat protection runs at least 14 days in Audit mode against synthetic / approved workforce evidence，then Enforced mode blocks compromised credentials and high-risk sign-in、requires TOTP at medium risk and exports minimized activity logs under the 30-day restricted-security retention；a dedicated WAF web ACL on the User Pool owns volumetric limits
* Cognito owns password and TOTP verifier material；BOP stores only external subject、factor status and Audit reference，never the TOTP seed；factor reset for Owner、Finance or Platform Admin requires a distinct active privileged approver or the tested two-person break-glass path
* the first production Owner is created by a one-shot reviewed deployment task only after the Operating Entity and named corporate email evidence pass；it issues one 24-hour invitation、forces TOTP before any business action、records approvers / exact role / Store scope and permanently disables the seed path；there is no default password、hidden superuser or reusable bootstrap endpoint
* the Cognito app client enables `PreventUserExistenceErrors`；login、invite acceptance、password reset and recovery use uniform public errors and bounded timing，email / username existence is never disclosed，and changing the verified login identifier revokes Sessions and requires a new verification workflow
* the BFF Session Store is an Identity-owned PostgreSQL table in the Identity schema；the Runtime role may create / read / rotate / revoke only Session rows and cannot decrypt tokens without its KMS grant
* each OIDC authorization transaction is a separate one-time PostgreSQL record with a 10-minute expiry、keyed-hash state selector、encrypted PKCE verifier / nonce、exact redirect URI and allowlisted post-login path；the browser has only `__Host-bop-auth` with `Secure`、`HttpOnly`、`SameSite=Lax`、`Path=/` and 10-minute `Max-Age`
* callback atomically consumes the authorization transaction before code exchange；unknown、expired、replayed or mismatched state / issuer / nonce fails closed and clears the ephemeral Cookie without revealing which check failed
* Cognito returns the one-time authorization code / state in the callback query；because ALB access logging cannot redact a request line per route，those access logs are encrypted `Restricted` security data with a 7-day default retention and security-only access；PKCE、state / auth Cookie binding、single use and immediate clean redirect limit replay，and application / analytics logs still omit the query
* Merchant and Guest Cookie identifiers contain 256 random bits；the database selector is `HMAC-SHA-256` over the identifier with an environment-specific pepper in Secrets Manager，and OAuth token bundles use KMS data-key envelope encryption with `AES-256-GCM` and bound encryption context
* a Session row stores keyed-hash selector、Actor / Membership snapshot references、Cognito subject reference、encrypted token bundle、auth / MFA time、created / last-seen / idle / absolute expiry、revocation reason、client risk metadata and row version；raw Cookie value and raw Token never enter the database or log
* envelope-encryption data keys are scoped to environment；authenticated encryption binds Session ID、Actor and environment as associated context；decrypt failure revokes the Session and alerts
* Cognito refresh-token rotation is enabled with a 10-second retry grace period，`REFRESH_TOKEN_AUTH` is disabled，and the BFF atomically replaces its encrypted token bundle after a successful server-side refresh；a rotated token outside grace or version conflict revokes the BFF Session and alerts rather than forking two token chains
* Cognito confidential-client secret rotation uses replacement app clients，not an in-place fictitious rotation：a Session records its exact client ID，new login switches to the reviewed next client，old Sessions drain for at most their remaining 12-hour absolute life，then the old client / secret is disabled after logout / refresh / callback evidence shows no dependency；both clients keep exact callback / logout URIs and no wildcard
* standard Merchant default maximum is five active Sessions；privileged Platform Admin / Owner / Finance maximum is two；a successful new login beyond the limit revokes the oldest Session and notifies / audits the Actor
* standard Merchant idle / absolute expiry defaults to 30 minutes / 12 hours；privileged idle / absolute expiry defaults to 15 minutes / 8 hours；the least-privilege named KDS Operator profile uses 60 minutes idle / 12 hours absolute，but SSE、polling and background refresh never extend idle time
* idle expiry is evaluated server-side on every authenticated request with bounded write coalescing；an hourly cleanup job removes expired token material while retaining the minimal revocation / Audit fact according to policy
* Session ID rotates on login、MFA completion、privilege or Store-context elevation、account recovery and suspicious-risk change；the former ID is immediately unusable
* `recent MFA` means a successful TOTP challenge within the preceding 15 minutes on the same rotated Session；step-up starts a new one-time OIDC transaction with `prompt=login`、fresh state / nonce / PKCE and cannot be satisfied by a client timestamp or the existing managed-login Cookie alone
* logout revokes server Session and Cognito refresh token before clearing the Cookie，then uses the exact allowlisted Cognito logout endpoint / clean return URI so the managed-login Cookie cannot silently reauthenticate；global logout、Membership disable、role / Store removal、credential reset and compromise revoke every affected Session through an idempotent job
* Store switch is an authorized server command that re-evaluates Membership and rotates Session context；a client-supplied Store ID never changes authorization by itself
* both Merchant and Customer / Guest state-changing requests require exact same-origin / Fetch Metadata validation and a Session-bound CSRF token held only in page memory；Guest Cookie rotation also rotates the CSRF token，while the initial QR / resume capability endpoint is origin-checked and consumes its own one-time proof
* a browser KDS is always operated under one named low-privilege human Session；shared usernames and unattended authenticated screens are prohibited，device lock / visibility loss covers the board，and operator handover signs out or rotates to the next named Actor before further commands
* v0.1 Support cannot impersonate a Merchant or Customer；Support selects one ticket-bound、time-limited and audited Tenant / Store context，sees masked fields by default，and every allowed action records the real Support Actor、reason and delegated permission
* Restricted PII reveal requires recent MFA、declared purpose and a maximum 15-minute view grant；it cannot be exported or extended silently
* BFF callback、session bootstrap and CSRF endpoints use `Cache-Control: no-store` and clean redirects；OAuth error detail、code、state and Token never enter client logs or analytics
* acceptance includes database compromise simulation proving stored selectors / ciphertext cannot directly impersonate a Session，plus fixation、CSRF、concurrent limit、recovery、global logout、role change and cross-Tenant negative tests

No Redis is introduced for v0.1. PostgreSQL load evidence may trigger a later Session Store IDR without changing browser Cookie or authorization contracts.

### 87.7 IDR-0033 — AWS Account、Network、Deployment and Supply-chain Contract

#### 87.7.1 Account and Network Topology

* AWS Organizations contains a management account with no workloads，a security / log-archive account，and separate development、staging and production workload accounts；production data、KMS keys、Secrets and IAM roles never share an account with development
* organization-level CloudTrail writes to the log-archive account；GuardDuty、Security Hub and IAM Access Analyzer are delegated / aggregated in the security account before production enablement，and external / cross-account access findings page the security owner
* human cloud access uses IAM Identity Center permission sets with short sessions and MFA；long-lived IAM user access keys are prohibited；member-account root credentials are centrally removed where supported，and the management-account root has no access keys、hardware MFA、group-controlled recovery contacts and a tested emergency procedure
* SCPs deny leaving the approved Canada Region set except required global services，public S3 / RDS、disabling or diverting CloudTrail / Config / GuardDuty / Security Hub、unencrypted storage and unauthorized Organization exit；a documented break-glass exception is time-bound、two-person approved and centrally alerted
* S3 account / bucket Block Public Access is enabled，Object Ownership is `Bucket owner enforced` with ACLs disabled，and bucket policies deny non-TLS、missing required SSE-KMS / encryption context and access outside the named role / OAC / VPC-endpoint paths
* AWS Config aggregator、CloudTrail log-file validation、S3 versioning / Object Lock for the central archive、VPC Flow Logs、WAF logs and required S3 / KMS data events are encrypted in the security / log account；ordinary workload administrators cannot alter their destination or retention
* production spans at least two Availability Zones；public subnets contain only ALB / required managed edge resources，ECS tasks run in private subnets，and RDS runs in isolated database subnets with no public endpoint
* Customer and Merchant use separate owned HTTPS hostnames that resolve to the Canadian regional ALB under regional WAF；each hostname serves its own HTML、same-origin hashed application assets、`/bff/*` and API routes，so Session Cookie and private request data do not transit a global CDN
* every public ALB listener explicitly uses `ELBSecurityPolicy-TLS13-1-2-Res-PQ-2025-09`（never the legacy CloudFormation / CDK default），and HTTP only performs a fixed HTTPS redirect；CloudFront public assets use minimum `TLSv1.2_2021`；the accepted browser / Stripe / SNS compatibility matrix is tested before promotion
* CloudFront has one separate public-asset hostname backed by private S3 through Origin Access Control；it accepts no Cookie、Authorization header or user-specific query，contains only content-hashed non-PII images / public Brand assets and returns restrictive CORS for the exact Customer / Merchant origins
* `/api/v1/public/*` remains edge-cache-disabled in v0.1 and uses the explicit five-minute PWA policy；Merchant、Guest Session、transaction、receipt、support and Provider-result responses never enter CloudFront
* Stripe / Provider webhooks use a separate `integrations` ALB hostname with no browser Cookie、no CORS and no cache；regional WAF protects Customer、Merchant and integration hosts，while CloudFront WAF protects only the public asset distribution
* WAF baseline enables AWS Managed Core、Known Bad Inputs、SQL database and Amazon IP-reputation rule groups plus the Section 87 rate rules；changes run in Count against staging / replay evidence before Block，and every exclusion is path + rule scoped、owned、expiring and cannot replace Stripe / SNS signature verification
* ECS security groups accept application traffic only from ALB，and RDS accepts PostgreSQL only from the owning ECS / migration security groups；the ALB DNS name is not treated as an application origin and Host validation rejects unknown hosts
* ALB enables deletion protection、`routing.http.desync_mitigation_mode=strictest` and invalid-header dropping，uses a 120-second idle timeout compatible with the 15-second SSE heartbeat，and appends the forwarding chain；the application derives client IP only from the final owned-ALB hop and never trusts a client-prepended value
* production runs at least two API / BFF tasks and two Worker tasks across AZs where the workload exists；autoscaling has min / max、scale signals and database connection budget，and deployment cannot exhaust the RDS pool
* separate task roles exist for API / BFF、Worker、Migration and operational break-glass；permissions are resource- and action-scoped，and no application uses the account root or shared IAM user key
* production ECS Exec、SSH and public debug endpoints are disabled by default；diagnosis uses logs / metrics / traces，and any exceptional one-shot diagnostic task requires the break-glass workflow、a purpose-built least-privilege task definition、time limit and retained command / artifact Audit
* VPC endpoints cover S3、ECR、CloudWatch Logs、Secrets Manager and KMS where supported；remaining Internet egress uses the multi-AZ NAT + AWS Network Firewall allowlist path above，not a public task address；actual `ca-central-1` service / cost evidence is a production gate
* operational alerts use encrypted SNS topics with least-privilege publish policy、verified email subscriptions and no Customer payload；actual primary / backup contact and acknowledgement drill are external launch evidence
* Route 53 / ACM manage the actual production hostname and certificate after domain evidence exists；registrar MFA / transfer lock、least-privilege DNS change、DNSSEC where the registrar / zone path supports it、TLS renewal and DNS ownership / unexpected-record alarms are launch requirements
* AWS Budgets、Cost Anomaly Detection、resource-owner / environment / data-class tags and service-quota alarms notify Finance / Operations；a cost alarm never automatically deletes production data or stops a transaction service
* CDK bootstraps each account / Region with environment-specific least-privilege deployment roles；CI reviews `cdk synth` + security scan + CloudFormation change set，production stacks use termination / deletion protection for stateful resources，and weekly drift detection creates an owned exception rather than auto-reconciling an unexplained change

#### 87.7.2 Build and Artifact Integrity

* third-party GitHub Actions are pinned to immutable commit SHA and reviewed；workflow permissions default to read-only and are elevated per job only
* untrusted Pull Requests receive no production Secret、OIDC production role or privileged runner；`pull_request_target` cannot check out or execute untrusted contribution code
* AWS OIDC role trust pins GitHub organization / Repository ID、approved workflow file at an immutable default-branch revision、environment and protected branch / tag claims；fork / pull-request claims cannot assume a deployment role，and production additionally requires the GitHub Environment approval gate
* pnpm uses the accepted registry / lockfile and an explicit dependency build-script allowlist；unexpected Git URL、mutable source、postinstall or new license fails review
* GitHub Dependabot opens weekly grouped non-major npm / Actions updates and immediate security PRs；Major updates remain separate，nothing auto-merges，and every accepted update regenerates / freezes the lockfile and full evidence set
* release container is a multi-stage `linux/amd64` build from the exact `node:24.18.0-bookworm-slim` base pinned by digest；it installs production dependencies from the frozen lockfile，contains no source-control metadata、package-manager cache or development dependency，and runs as the non-root `node` user
* production frontend / server source maps、test reports and debug bundles are not served publicly or copied into the runtime image；when needed for a release investigation they are encrypted restricted CI artifacts with 30-day expiry and access Audit
* ECS sets read-only root filesystem、drops Linux capabilities、uses bounded memory / CPU and provides only an ephemeral size-limited `/tmp`；a shell is not used by health checks or normal operations
* CI produces an SPDX JSON SBOM、in-toto BuildKit provenance、OSV-Scanner dependency result、Gitleaks secret result、Semgrep SAST result and Trivy container / IaC result for each release image；staging runs an authenticated OWASP ZAP baseline against the owned routes；each tool / container is pinned to an immutable reviewed version or digest by WP-2050
* MIT、Apache-2.0、BSD、ISC、0BSD and Unicode-style dependencies are allowlisted subject to notice obligations；MPL / LGPL requires Legal + Architecture review，and AGPL、SSPL or unknown / noncommercial Runtime license is blocked；release produces `THIRD_PARTY_NOTICES`
* production blocks Critical / High exploitable findings unless the Section 80 time-bound risk-acceptance rule is satisfied；the exception names package / CVE、compensating control、owner and expiry
* release image is signed with `cosign` using a dedicated KMS asymmetric signing key，stored in ECR with its provenance / SBOM OCI references，and deployed only by immutable digest
* staging and production promote the exact same digest；production never rebuilds source into a different image
* an artifact built from an untrusted Pull Request or unprotected ref is test-only and can never be relabelled / promoted；release provenance binds source commit、workflow identity、builder、base-image digest and resulting image digest
* ECR tag immutability and enhanced scanning / Amazon Inspector are enabled；a failed signature、provenance、SBOM or scan gate prevents deployment

#### 87.7.3 Deployment and Migration

* production uses AWS CodeDeploy ECS blue / green with two target groups、health alarms、10-percent canary observation for at least 10 minutes，then full traffic；automatic rollback returns traffic to the prior healthy digest
* configuration is schema-validated at startup；missing or unknown production configuration fails readiness，not midway through a transaction
* database migration is a reviewed one-shot task with a dedicated role，backup / recovery check and advisory lock；application tasks never auto-migrate on startup
* every breaking schema change uses Expand → Backfill → dual-compatible application → verify → Contract；the Contract step waits at least one normal release observation window and has an explicit restore / compensation path
* rollout readiness distinguishes liveness from dependencies；readiness fails when the task cannot safely serve，while transient downstream failure does not cause a restart storm
* application shutdown first fails readiness，stops new work，drains HTTP / job leases within a bounded deadline，then exits；abandoned Job / Outbox leases are recoverable
* feature flags / Kill Switches can stop new Checkout、Payment、Order、Notification or Provider work，but cannot rewrite completed facts

#### 87.7.4 IDR-0029 Revision 1 — PostgreSQL Initialization and Connection Contract

* application database encoding is `UTF8`，database default collation / character classification is deterministic `C`，server / Session time zone is `UTC` and `DateStyle` is ISO `YMD`
* user-facing `en-CA` / `fr-CA` sort and search use explicitly named ICU collations on read models and a UUID tie-breaker；collation provider / version is recorded，and an ICU upgrade requires comparison、`REINDEX` plan and pagination-regression evidence
* identifiers、permission codes、Idempotency fingerprints and machine ordering never depend on locale collation
* application-owned primary、Command、Event and Correlation IDs are UUIDv7 generated through accepted `uuid 14.0.1`；database defaults may call PostgreSQL 18 `uuidv7()` only for migration / repair paths，and externally supplied IDs are validated
* extension allowlist is `pg_trgm` and `unaccent` only，installed by the migration role in a controlled extension schema；`public` contains no business table，and another extension requires an IDR revision
* case-insensitive uniqueness uses an explicit normalized column + Tenant-scoped unique index，not database-default case behavior；normalization algorithm / version is part of the owning field contract
* API / BFF、Worker、Migration and read-only roles use separate `pg` pools；production reserves database connections for administration / failover，and the sum of every ECS task maximum cannot exceed 70 percent of RDS `max_connections`
* every non-local connection requires TLS with hostname and current Amazon RDS CA verification；certificate rotation is rehearsed before expiry，and no production client uses `rejectUnauthorized=false`
* transaction、statement、lock and idle-in-transaction timeouts are role-specific and finite；ordinary API transaction target is at most 5 seconds，and long backfill uses a dedicated bounded job
* the RDS parameter / log profile records connection、DDL、lock / deadlock and bounded slow-query metadata without bind values or complete sensitive statements；database errors exposed to the application are mapped to stable codes before logging
* AWS / RDS UTC time is authoritative；browser time never determines token、Quote、tax、payment、schedule or retention validity；runtime clock-skew warning is 30 seconds and fail-safe threshold is 60 seconds for internal signed facts，while Provider signature tolerance follows the stricter accepted Provider contract
* Runtime cannot create schema / extension or bypass row / Tenant guards；Migration cannot serve application traffic；reporting is read-only and cannot query unmasked Restricted fields
* WP-0020–0024 and WP-2005 verify empty-create / upgrade、collation ordering、extension ownership、pool exhaustion、timeout、role denial、backup restore and cross-Tenant query plans

#### 87.7.5 IDR-0040 — Tenant Row-level Defense in Depth

* every Brand- or Store-owned source / projection table has an explicit Tenant key and PostgreSQL RLS policy；global reference tables are an enumerated exception and cannot acquire Tenant data through JSONB
* ordinary API / BFF and Worker roles are non-owner roles without `BYPASSRLS`；tables use `FORCE ROW LEVEL SECURITY` where the owning migration role could otherwise become an accidental Runtime path
* each database transaction sets validated `bop.brand_id` and optional `bop.store_id` with `SET LOCAL` from the server-resolved Tenant Context；pool-level persistent `SET` is prohibited，and a missing / invalid Context returns zero rows or denies writes
* Store policy requires matching Brand and，for Store-owned rows，matching Store；application permission and object-state checks still run before every query / command
* cross-Tenant jobs iterate one authorized Tenant context per transaction；Migration、restore verifier and narrowly scoped emergency roles are the only bypass paths and are never used by a public request
* Platform support access selects one audited Tenant / Store context through the approved support workflow；there is no unrestricted “all tenants” application toggle
* foreign-key / unique / upsert and `ON CONFLICT` paths are tested so existence or conflict detail from another Tenant cannot leak
* transaction cleanup、pool reuse、nested transaction、parallel query、prepared statement、background job and failure paths prove Tenant Context cannot bleed to the next request
* WP-0103、WP-2005 and WP-2041 run positive and negative tests against every registered Tenant-owned table；a new table without declared RLS / exception metadata fails migration CI

#### 87.7.6 Observability Privacy and Cardinality

* OpenTelemetry HTTP spans use the registered route template，not raw URL / query；database spans record module、operation and normalized table / query reference but never SQL text、bind values or result rows；headers、Cookie、body、email and Provider payload capture is disabled
* log / trace attributes use an allowlisted schema；Correlation / Trace IDs are server-validated random identifiers，and Customer / Actor / Order / Session / Token / IP values are neither metric dimensions nor unrestricted span attributes
* the production Collector tail-sampling policy retains 10 percent of ordinary successful traces and 100 percent of sanitized errors / SLO outliers up to a tested per-service emergency cap；beyond the cap it keeps bounded exemplars + aggregate counters and alerts，while a temporary sampling increase is scoped、time-limited and cannot disable redaction
* metric labels are bounded enums such as environment、service、route template、operation and result code；Tenant / Store / object IDs and free text are prohibited dimensions，and CI load tests fail an unbounded-cardinality instrument
* Pino error stacks and diagnostic references are `Restricted` operational data with 30-day default retention；Customer-facing errors expose only the stable code + Correlation ID，and a redaction failure pages Security and disables the leaking exporter / log path
* WP-0040–0045、2043 verify cross-runtime trace continuity、redaction canaries、cardinality budget、Collector backpressure / outage、alert routing and that observability failure never blocks the committed business transaction

### 87.8 IDR-0034 — Backup、Cross-Region DR and Recovery Consistency

The Section 80 transaction-path target of `RPO ≤ 5 minutes / RTO ≤ 60 minutes` is not considered satisfied by an occasional snapshot copy.

* primary RDS PostgreSQL is encrypted Multi-AZ in `ca-central-1` with PITR；production also enables encrypted cross-Region automated backup replication to `ca-west-1`
* production automated backup / PITR retention is 35 days in both Regions；pre-migration manual snapshots expire after 7 days once verification passes，unless an active incident / legal hold records another expiry；backup is recovery media，not the seven-year legal-record archive
* development / staging retention is 7 days and never receives an unmasked production restore；a restore for incident investigation enters an isolated account / subnet with time-bound access and destruction evidence
* before claiming the transaction RPO，production creates an encrypted cross-Region PostgreSQL read replica in `ca-west-1`，monitors replica lag and alerts at 2 minutes / pages at 5 minutes；Region and PostgreSQL version support must be proven in the actual account
* the replica is not used as a writable split brain；failover is an explicit incident command that fences primary writes、records last confirmed position、promotes the destination and rotates application / migration endpoints
* S3 enables versioning and cross-Region replication for required clean objects / audit archives；ECR replicates release images；destination KMS keys、Secrets / configuration replicas、IaC state access and certificates are prepared without copying unnecessary PII
* pg-boss、Outbox、Inbox、Idempotency、Session revocation、Audit and source transaction data are recovered with PostgreSQL；projections and caches rebuild and never determine the recovery point
* every restore remains fenced from Customer / Provider traffic until schema、audit chain、malware / object reference、authorization and privacy-deletion checks pass；a durable keyed privacy-tombstone ledger reapplies completed deletion / anonymization actions so an old backup cannot resurrect previously removed PII
* after database promotion，Payment / webhook / email adapters perform provider reconciliation before unknown operations are retried；Idempotency Keys remain stable across Region failover
* Route 53 change / failover uses a documented low-TTL production record and health evidence；manual authority、communications and rollback / fail-forward criteria are named in the runbook
* quarterly restore drill validates PITR and data semantics；semiannual cross-Region drill measures detection、fencing、promotion、application recovery、reconciliation and rollback against RPO / RTO
* if `ca-west-1` engine / feature availability or measured lag cannot meet the target，production transaction SLO is `BLOCKED` and IDR-0034 becomes `Revisit Required`；the document cannot silently claim the old RPO

### 87.9 IDR-0035 — Stripe Payment State、Capture、Refund and Reconciliation

* v0.1 uses one direct Canadian Stripe account owned by the accepted Operating Entity；Stripe Connect、marketplace split settlement and sub-merchant onboarding are out of scope
* first live Pilot is cashless：Customer PWA accepts Stripe online `card` only，authorized Staff accepts Stripe Terminal card-present / Interac；Cash、cash drawer、Gift Card、stored balance、split tender、cheque、manual pay-later、BNPL、Stripe Link and Apple / Google wallet methods are disabled
* test and live modes use separate restricted keys、webhook secrets、Terminal Locations and data；Stripe API version is explicitly pinned and upgrade fixtures run before change
* server derives amount、CAD currency、Store、Quote and allowed payment-method set；browser input、Stripe metadata or callback cannot override financial facts；metadata contains stable references only and no unnecessary PII
* online card uses Stripe Radar account protection and `request_three_d_secure=automatic`；a Provider decline / risk block remains authoritative，while BOP retains only the minimum normalized outcome / reference and does not copy card fingerprint or Radar payload into analytics
* online Customer PaymentIntent uses automatic capture after a current final Quote、capacity / Checkout preconditions and one canonical Payment Attempt exist
* the `/payment-intents` command first commits an immutable `Submitted / Payment Pending` Order submission（new Order + first Batch，or a new Batch on the already-active Dine-in Order）、its exact Quote / Cart / allergen / Fulfillment snapshots and a capacity allocation in one PostgreSQL transaction；only after that commit does the adapter create the linked PaymentIntent，so external payment is never the first durable business fact
* the online capacity allocation is reserved for 30 minutes from PaymentIntent creation；a watchdog stops new confirmation / cancels the intent at expiry and cancels the unpaid submission / Batch，while `Processing / Unknown` enters reconciliation rather than extending capacity forever；Kitchen receives no work before authoritative Payment success and the accepted Order workflow
* Stripe.js keeps the PaymentIntent client secret only in page memory and uses `redirect: if_required` for the card-only online baseline；the value never enters BOP URL construction、Web Storage、analytics or application log
* Canadian Terminal PaymentIntent includes `card_present` and `interac_present`；`payment_method_options.card_present.capture_method=manual_preferred` allows Interac single-step capture while non-Interac card-present remains authorization-only
* reader registration and every connection-token request require a named authorized Staff Session and server-resolved Store / Stripe Terminal Location；connection secrets are short-lived、single-purpose、`no-store` and never logged，and a reader assigned to another Store cannot collect the PaymentIntent
* non-Interac Terminal authorization is captured idempotently immediately after Order acceptance，target within 15 minutes；a watchdog alerts at 10 minutes and cancels / resolves any still-uncaptured attempt at 20 minutes unless Provider evidence requires a shorter deadline
* code never calls a separate capture for Interac；Stripe Terminal offline collection is disabled for every payment method in v0.1，network loss enters the IDR-0039 continuity path without deferred browser / reader replay，and Interac refund uses the required in-person reader flow
* v0.1 tip is selected and included before payment confirmation；post-authorization tip adjustment is disabled；tip、tax、service charge and refund allocation are immutable Money snapshots
* an Order marked for Allergen Assistance cannot create or confirm a PaymentIntent until the structured Staff review has accepted the exact configuration；a subsequent item / modifier change invalidates that acceptance and requires a new review / Quote
* redirect / client result is UX evidence only；authoritative Payment progression comes from a verified webhook or server-side Provider retrieval，mapped through the Payment state machine
* Stripe `return_url` points to a dedicated Canadian regional `payment-return` sanitizer hostname with no BOP Cookie and no application target；its WAF log redacts the full query，ALB access logging is disabled for this single redirect-only load balancer，and a fixed `302` drops every query parameter before sending the browser to the clean Customer `/checkout/result` route
* that redirect-only ALB is the sole documented access-log exception：AWS Config records the approved exception，while WAF request-count / block metrics、TLS / health alarms and fixed-response synthetic checks remain enabled；adding any target、dynamic redirect or second route invalidates the exception
* the sanitizer never reads or forwards `payment_intent_client_secret` / PaymentIntent ID；the clean result route resolves the current Checkout from Guest Session and operation reference，then waits for authoritative reconciliation
* webhook verifies the Stripe signature with a five-minute timestamp tolerance against raw bytes，persists Provider Event ID uniquely and durably accepts into Inbox before `2xx`；processing is idempotent、order-independent and replayable
* webhook-secret rotation supports current + next secret during a maximum seven-day overlap；failed signature detail is restricted and never echoed
* one BOP Payment Attempt maps to one intended Provider PaymentIntent；retry reuses the existing intent when safe or explicitly closes it before creating a replacement，preventing double charge
* every server-side Stripe create / capture / cancel / refund call uses a deterministic Provider idempotency key bound to environment + BOP operation / Attempt；browser confirmation retries the same PaymentIntent under the BOP operation，and a changed amount / purpose requires a new operation after the prior one reaches an explicit terminal / replaced state
* `Unknown` / `Processing` never becomes success or failure from timeout alone；the UI shows pending recovery and the reconciliation job queries Provider truth
* a late Provider success after capacity / submission cancellation or any paid-but-unfulfillable inconsistency creates a Critical `PaidWithoutFulfillableOrder` exception，prevents Kitchen release and immediately starts an idempotent full refund to the original method；the case stays open until Provider-confirmed refund，Customer receipt / status shows the real pending / refunded outcome，and Operations must reconcile every case
* reconciliation runs at least every 15 minutes for pending / mismatched operational attempts and daily against settlement / balance evidence；mismatch creates an owned exception and cannot silently mutate an Order
* refunds require an allowed source state、server-calculated refundable balance、permission、reason、Idempotency Key and Audit；concurrent / cumulative refunds cannot exceed captured amount
* refund returns only through the original Stripe charge / payment method and accepted Provider flow；BOP never collects alternate bank / card credentials or marks an off-platform payment as a completed refund
* v0.1 refund modes are Full Refund and item / quantity-based Partial Refund against immutable Order lines；the server derives tax、tip and service-charge allocation from the original snapshots，and arbitrary unallocated refund amounts are disabled
* Store Manager may initiate same-day cumulative refunds up to CAD 100；a larger amount、refund after 24 hours、Manager Override or change to tip / service-charge refund requires recent MFA plus Owner / Finance approval by a different active Actor
* chargeback / dispute is an append-only Payment case fact；it does not rewrite the original charge、Order or receipt
* production evidence includes Stripe test-mode matrix、simulated and real approved reader、Interac present / refund、duplicate / delayed webhook、unknown result、capacity-expiry / late-success compensation、capture watchdog、partial / repeated refund、settlement and failover reconciliation
* PCI DSS scope / SAQ eligibility、Stripe Terminal responsibility and annual attestation are external Compliance evidence；the handoff does not claim a SAQ type，and live Payment remains blocked until the actual integration / entity scope is confirmed

### 87.10 IDR-0036 — Privacy、Cryptography and Audit Integrity

#### 87.10.1 Canonical Data Classification

| Class | v0.1 Examples | Minimum Control |
| --- | --- | --- |
| `Public` | published Menu、public Store hours、content-hashed Brand assets | approved publication only；integrity / version control；may use public CDN |
| `Internal` | non-sensitive configuration、operational metrics、reason codes、source references | authenticated workforce / service need-to-know；encrypted transport / storage；no public cache |
| `Confidential` | Customer contact、Order / employee detail、supplier / settlement fact、non-public business report | explicit field permission and Tenant / purpose check；mask by default；no ordinary log / event copy；audited export |
| `Restricted` | Secret / token / private signing material、raw Provider evidence、PII export、customer-declared allergy / health detail、significant-control register data、security investigation | dedicated role and recent MFA / service identity；envelope encryption or managed Secret store；shortest retention / access grant；no analytics、browser cache or lower-environment copy |

Unknown data defaults to `Confidential` until the owner classifies it. PAN / CVV and raw authentication credentials are prohibited data rather than a class the application may retain. Every schema / event / projection / export field carries classification metadata，and CI fails an unclassified new field.

#### 87.10.2 Collection and Customer Rights

* v0.1 uses only strictly necessary Merchant / Guest Session cookies；no advertising cookie、cross-site tracker、third-party analytics、fingerprinting or session replay is enabled
* essential operational telemetry is first-party、minimized and never records raw URL secrets、form text、Customer note、Token、pickup proof or full contact detail
* Customer contact is optional unless the selected Fulfillment / receipt workflow needs it；email / phone purpose is stored，and operational communication is separated from marketing Consent
* Checkout offers an accessible in-session receipt and an optional transactional email receipt；`orderReference` alone never retrieves it；a verified Order email may receive a fresh one-time resume link，while a Customer who supplied no contact and lost the Guest Session has no remote recovery path；in-Store reissue requires an authorized Manager with recent MFA plus two matching transaction facts，including original payment receipt / Provider-safe last-four evidence，never a full card number，and returns only the audited receipt
* SES open / click tracking and tracking pixels are disabled；email subject contains no sensitive Order detail，and every receipt / resume link follows the one-time token contract
* marketing messaging remains disabled；a future Marketing phase requires consent evidence、withdrawal / unsubscribe and a new Privacy / CASL review before any send
* privacy notice、terms、refund policy and contact channel are versioned and linked from Customer flows before production PII collection；acceptance fact is stored only when legally / operationally required
* Access / Portability、Correction、Consent Withdrawal and Deletion / Anonymization requests use a tracked Privacy Request；identity proof is proportional and the response target is 30 calendar days unless applicable law / professional direction sets another period
* export is data-minimized、encrypted and available through a single-use link for at most 24 hours；it never travels as an unencrypted email attachment
* correction preserves required financial / audit history；deletion anonymizes non-required contact / profile data and records the reason when legal hold or statutory retention prevents erasure
* the privacy-tombstone ledger stores only an opaque stable internal subject ID + field reference、policy version、completion time and replay status，never raw email / phone / name；it is inaccessible to product search / analytics and is applied before any restored environment may reconnect to Customer or Provider traffic
* every PII field declares purpose、classification、source、access roles、event / projection / log behavior、retention trigger and deletion / correction behavior before migration

##### 87.10.2.1 IDR-0027 Revision 1 — Transactional Email Execution

* SES sends from the approved `ca-central-1` identity after Production Access evidence；the owned domain has verified DKIM、SPF alignment and a staged DMARC policy with aggregate reports reviewed before enforcement
* v0.1 uses a BOP-owned deterministic email renderer built on the already accepted React / React DOM server runtime；template inputs are typed / escaped plain values，styles are inline owned values，and no MJML、remote font、third-party image、tracking pixel、script、form or unreviewed HTML is introduced
* every email has localized plain-text and accessible HTML alternatives、a non-sensitive subject、one recipient per send and validated header values；recipient addresses never appear in `CC` / `BCC` lists or another Tenant's delivery evidence
* the logical Notification idempotency key binds purpose、business reference、recipient reference、locale and Template Version；a duplicate job returns the existing logical Notification and cannot silently create another Delivery Attempt
* because SES does not provide an exactly-once delivery guarantee，a timeout after submission remains `Unknown` and is not blindly retried；an authorized resend creates a linked Attempt，and receipt / recovery UI tolerates duplicate messages without duplicating an Order、Payment or business fact
* a resume token is minted only immediately before an Attempt；each Attempt stores only its hash reference，at most two unexpired tokens for the same Order / purpose may coexist after an unknown send，and consuming one atomically revokes every sibling token
* SES Provider Message ID、recipient reference、Template Version、Attempt status and timestamps are retained as classified delivery evidence；the rendered body、resume URL and email-provider payload are not stored in ordinary Notification / Audit records
* SES bounce / complaint events arrive through a dedicated SNS HTTPS subscription using SNS Signature Version 2；the adapter validates certificate chain、signature、Topic ARN、account、Region and message type，then persists a unique Provider Event into Inbox before `2xx`；certificate retrieval uses only the exact approved AWS SNS HTTPS hostname / path and the SSRF controls
* a valid `SubscriptionConfirmation` is confirmed through the scoped `@aws-sdk/client-sns` `ConfirmSubscription` call for the exact IaC-owned Topic ARN；the application never follows the message-supplied `SubscribeURL` / `UnsubscribeURL`，and unsubscribe requires an infrastructure change
* hard bounce and complaint immediately suppress that address / purpose、stop retry and create an owned operational case；soft bounce uses bounded backoff，while an address correction creates a new verified recipient reference rather than mutating old evidence
* WP-1720–1724 / 2028 test domain authentication、escaping、header injection、cross-Tenant recipient isolation、duplicate / unknown send、sibling-token revocation、signed / forged SNS event、bounce / complaint suppression and log / archive leakage

#### 87.10.3 Key and Secret Lifecycle

* production KMS keys are environment- and purpose-separated for database / backup、S3、Session token envelope、QR signing、audit signing and CI image signing；signing keys use dedicated `ECC_NIST_P256` `SIGN_VERIFY` keys，and key policy excludes broad wildcard principals
* eligible symmetric KMS keys enable automatic annual rotation；asymmetric signing keys rotate at least annually or immediately on compromise，publish `kid` and retain verify-only overlap for the shortest required validity window
* disabling or scheduling deletion of a production KMS key requires dependency inventory、restore / decrypt proof、two-person approval and an alarmed minimum 30-day deletion window；legal-hold / archive keys cannot be deleted while protected records depend on them
* Secrets Manager automatic rotation target is 90 days or the Provider's shorter supported interval；non-rotatable Provider secrets have an owner、manual runbook、last-rotated date and maximum 180-day review
* webhook and signing-key rotation is dual-read / single-write：new writes use the new key，the prior key verifies only during a bounded overlap，then is disabled after evidence shows no valid dependency
* every keyed-hash selector stores a non-secret pepper version；rotation writes only the new version and either dual-reads the prior version for at most the longest 24-hour Guest / token lifetime or performs an announced global Session revocation，then destroys the prior pepper after expiry evidence；a rotation never makes an active Session、token or abuse decision silently unresolvable
* Secret values never appear in IaC output、CI artifacts、shell trace、exception、telemetry or support export；secret-access CloudTrail events and unusual decrypt rates alert

#### 87.10.4 Tamper-evident Audit

* Audit Record is append-only in a dedicated schema / role；ordinary Runtime has no Update / Delete privilege and correction is a linked corrective record
* each Tenant / audit partition forms an ordered `SHA-256` hash chain over RFC 8785 canonical JSON content、prior hash、sequence and UTC timestamp；concurrency assigns sequence transactionally
* a daily manifest records range、first / last sequence、root hash、gap count and verifier version；the dedicated KMS ECDSA P-256 key signs it and an independent task copies it to versioned S3 Object Lock Governance retention in the log-archive account
* application and ordinary administrator roles have no `s3:BypassGovernanceRetention` permission；any exceptional archive bypass requires the separate break-glass role、two-person production approval and a second retained Audit record
* verifier runs daily and after restore，detecting changed content、missing / duplicate sequence、invalid chain / signature and unexpected archive deletion；failure pages Security and freezes affected high-risk export
* Audit contains references / classified deltas，not raw Secrets、tokens、PAN / CVV or unrestricted PII；field masking applies to authorized viewers
* retention follows the classified business fact，legal hold and Section 86 defaults；Object Lock period is configured before bucket creation and is not shortened by application code

#### 87.10.5 Statutory Business-record Archive

* finalized Order、receipt、tax、Payment、refund and settlement facts remain canonical normalized records；a daily archive job emits data-minimized canonical JSON snapshots、the original inert rendered receipt HTML snapshot and a manifest containing schema / policy / Template version、Business Date range、object count and hashes
* an independent archive role signs the manifest with the records KMS signing key and writes versioned SSE-KMS objects to the log-archive account under S3 Object Lock Governance；application、Migration and ordinary cloud-admin roles cannot overwrite、delete or bypass retention
* archive retention is seven years from the applicable fiscal-year end for the Section 86 business-record class，extended by legal hold；Object Lock Compliance mode is enabled only after counsel confirms the exact class / period because an incorrect irreversible retention cannot be shortened
* expiration is computed from the recorded fiscal-year-end anchor；lifecycle deletion runs only after retention + legal-hold release and records manifest / object-version destruction evidence，while application code cannot shorten or directly delete the archive
* unnecessary Customer contact、free text、pickup proof and allergy / health detail are excluded from the statutory archive unless a specific legal / dispute purpose requires them；correction、refund and void are new linked records and never replace the original
* the operational database remains the normal query source；the archive is not an application cache or analytics feed，and access requires Finance / Compliance permission、recent MFA、purpose、case reference and Audit
* a daily verifier checks source-to-manifest count / hash and archive presence；quarterly restore / search sampling proves the snapshot can reconstruct a legal receipt and transaction history without exposing another Tenant

#### 87.10.6 Incident and Breach Execution

* incident severity、on-call owner、evidence preservation、containment、credential rotation、Customer / regulator decision and post-incident action are in a versioned runbook
* every suspected privacy breach creates a Breach Record and a documented real-risk assessment；notification timing and recipients use current legal / professional guidance，not an application hardcode
* production launch requires a tabletop incident exercise and tested contact tree；quarterly access review covers privileged roles、break-glass、KMS、database export and support access
* production publishes an owned `/.well-known/security.txt` contact / policy with no bounty promise unless separately approved；reports create a restricted Security Case and receive an acknowledgement target of two business days
* actively exploited or Internet-reachable Critical vulnerability has a 4-hour containment target and 7-day permanent-fix target；High has 7-day mitigation and 30-day fix，Medium 90-day fix；a shorter vendor / legal deadline wins
* an exception records exploitability、affected digest / data、compensating control、owner and expiry；Critical exception cannot authorize production launch，and no exception auto-renews

### 87.11 IDR-0037 — Ontario Corporation and Toronto Store Live-evidence Gate

This section is a planning / evidence checklist，not legal、tax or food-safety advice and not authority to file or operate.

Corporate evidence before the dedicated Ontario corporation is marked `Active`：

* filed articles / corporation number、registered office、initial directors / officers、organizational resolutions、share subscription / payment、securities register and minute-book custody reviewed by Ontario counsel
* an Ontario `Register of Individuals with Significant Control` containing the required information，annual reasonable-step review and updates recorded within the statutory window；access and disposal follow the current Act / professional direction
* Business Number and applicable corporation income tax、GST/HST、payroll、WSIB / employer registrations determined by accountant / counsel from real facts；no placeholder number enters a receipt
* operating / business name、domain and trademark clearance before public Brand use；any registration is external execution，not implied by `BOP-RMS`
* banking、Stripe ownership and signing authority match the legal entity and approved officers

Toronto Store evidence before synthetic Store `CA-ON-TOR-PILOT-001` becomes `Live`：

* lease / owner authorization and exact address；zoning、building、HVAC、plumbing、mechanical、sign、fire and accessibility evidence applicable to the premises
* notification to Toronto's Medical Officer of Health before operating，Public Health / DineSafe inspection path and required food-handler certification from an accepted provider
* applicable municipal business / trade licence determination；AGCO is not required by the accepted non-alcoholic Pilot scope，and enabling alcohol first requires an IDR revision + authorization；CFIA / provincial evidence applies only when the actual activity triggers it
* approved food-safety / allergen plan、supplier ingredient evidence、recipe / modifier verification、cross-contact controls、temperature / cleaning records、recall / incident runbook and required staff training；manual records are acceptable where no sensor capability is enabled
* real KDS device / Stripe reader serials、Stripe Terminal Location、network / failover profile、KDS tests、support contacts and Store-hours / emergency policy；printer evidence is required only after IDR-0039 is revised to enable physical output
* at least two distinct trained active Actors cover Manager initiation and Owner / Finance approval for high-value / delayed refunds、MFA recovery and break-glass actions；a single person may not self-approve merely because the corporation has one shareholder
* accountant-approved Ontario tax fixtures、legal receipt content、GST/HST number applicability、tip / service-charge treatment and refund examples
* cashless-payment notice、accepted-method signage and network / Provider-outage continuity procedure reviewed before Customer entry
* published privacy notice、terms、refund / cancellation policy、accessibility contact and incident / breach contacts
* Ontario AODA / IASR applicability determination based on the real Pilot entity、employee count、public Customer access and operations；all applicable accessible-customer-service policy、training、feedback、documentation / reporting and public-web obligations must be reviewed by qualified Ontario counsel / accessibility personnel，with the accepted WCAG 2.2 AA evidence retained before public Customer access

#### 87.11.1 IDR-0039 — First Pilot Device Output Lock

* the first live Pilot uses the responsive Merchant Kitchen / Pickup Web screen as KDS on a managed touch device with at least 1024 × 768 logical resolution；one approved current Chrome / Edge profile、screen-wake policy、power、network and replacement procedure must pass UAT
* one named low-privilege KDS Operator is active per browser Session；shared credentials are prohibited，operator handover locks / signs out first，and privileged Manager actions require a separate named Session + recent MFA
* Customer receipt is an immutable versioned snapshot of actual Operating Entity、Store、Order、tax、Payment / refund and template facts；correction、void、refund and reissue append linked records and never regenerate old facts from current configuration
* the accessible receipt is rendered in the PWA and may be delivered through accepted SES transactional email；a physical receipt printer is not required for the initial Pilot，subject to professional receipt review
* kitchen ticket and pickup queue are digital KDS views；vendor-specific printer / POS SDK、IPP / ESC-POS adapter、Store Gateway and application Offline Queue are disabled and not deployed
* loss of network puts KDS into explicit stale / read-only mode；staff uses the approved manual continuity runbook，and the browser never queues operational completion、payment or handoff commands offline
* continuity defaults to pausing new Order / Payment acceptance；Staff may safely fulfill already-authorized work from verified evidence but never writes down PAN / CVV、keys a card manually、enables cash or invents a success state；if a later professionally approved external contingency produces a Provider receipt，it is recorded on the incident sheet and reconciled through an authorized post-recovery workflow with external reference、reason and duplicate check
* Stripe Terminal remains a separate accepted managed device boundary and is not treated as a generic Store Gateway peripheral
* `SPIKE-1500` and physical Printer WPs are future-trigger work only；a real Store requirement for printed kitchen / legal output changes IDR-0039 to `Revisit Required` before any printer dependency is installed

#### 87.11.2 IDR-0041 — Pilot Dine-in and Allergen Safety Contract

* every Pilot Ingredient、Recipe、Product / SKU、Option and Sellable uses a versioned Canada allergen registry reviewed against current Health Canada / CFIA guidance and the Store's approved food-safety policy；the exact legal disclosure is professional launch evidence，not developer-authored copy
* each source distinguishes `Contains`、`Cross-contact Possible` and `Unverified`；absence is never inferred from a missing value，and every Pilot Sellable / modifier path with `Unverified` or conflicting evidence is blocked from publication
* supplier ingredient / allergen evidence and Recipe version are pinned；a supplier、ingredient、Recipe、substitution or preparation-area change invalidates the affected verification and published availability until re-approved
* Product configuration recomputes the union of base + added Option allergens；removing an Ingredient / Option does not remove a cross-contact warning or create an `allergen-free` claim
* Customer Menu and Checkout display approved localized allergen / cross-contact information and a prominent assistance path；no UI、receipt、employee script or generated content promises that an item is allergen-free unless a later professionally approved policy explicitly establishes that capability
* Customer free text is NFC-normalized plain text，maximum 240 Unicode code points / four lines，with control / bidirectional-override characters rejected；it is never interpreted as an allergy accommodation、ingredient deletion or safety approval，and the first Pilot does not accept an automated allergy accommodation through a note
* a Customer needing accommodation must use `Allergen Assistance Required` and contact / speak with Staff；an authorized named Staff member records only the controlled allergen reference、exact configuration、policy / Recipe versions and outcome `Accepted` or `Cannot Safely Accommodate`
* `Accepted` is configuration-specific and time-bound to that Order attempt；an item / Option / Recipe / Store-context change invalidates it；`Cannot Safely Accommodate` blocks Checkout / Payment and provides a safe cancellation / alternative path
* Kitchen / Pickup shows a persistent high-priority non-color cue；the assigned named operator acknowledges the structured review before `Start` and again before handoff，while the KDS never exposes unnecessary medical narrative
* Customer-declared allergy data is `Restricted`，excluded from receipt、email、analytics、search and ordinary logs；the structured request expires / anonymizes after 24 months unless an open food-safety incident、dispute、legal hold or professionally approved retention rule requires longer
* an allergen mismatch、unapproved substitution or exposure immediately creates a Food Safety Incident linked to immutable Order / Recipe / handling snapshots，stops affected availability through the Kill Switch and follows the Store emergency / escalation runbook
* WP-1006、1028、1407 and 2027 must prove copied Table QR denial、unknown-source publish block、modifier propagation、Staff review invalidation、Payment block、KDS acknowledgement、cross-Tenant privacy and incident traceability

The canonical gate ID is `STORE-LIVE-GATE-CA-ON-TOR-001`. It is `BLOCKED` while any applicable evidence is missing. Provider-neutral development and synthetic UAT may continue，but production Customer PII、live Payment、legal receipt and public ordering cannot be enabled.

### 87.12 IDR-0038 — Realtime Browser Transport

v0.1 uses Server-Sent Events（SSE），not WebSocket，because every accepted Realtime browser flow is server-to-client notification and every command already uses the authoritative REST / Application Command contract.

* Merchant opens one same-origin credentialed `EventSource` to `/bff/realtime`；Customer opens one to the Guest Session route；OAuth / Guest Token is never placed in URL or `Last-Event-ID`
* connect validates Session、Tenant、Store、permission and exact Origin / Fetch Metadata；scope is server-derived，and a client filter can only narrow the authorized scope
* response is `text/event-stream` with `Cache-Control: no-store, no-transform`、compression off and CloudFront / proxy buffering and caching disabled
* heartbeat comment is sent every 15 seconds；connection lifetime is at most two hours and reconnect uses exponential backoff with jitter from 1 to 30 seconds
* maximum is three active streams per Merchant Session and two per Guest Session；excess connection receives `429` and replaces only an explicitly superseded stream
* authorization / Session status is revalidated at least every 60 seconds and on Store / role change signal；revocation emits no further business hint and closes the stream
* message contains only ID、type、version、UTC time、authorized scope、resource reference and projection version；no Token、contact、note、payment detail or unrestricted PII
* delivery is lossy and may duplicate；`Last-Event-ID` is an opaque diagnostic cursor with no authorization meaning and no guaranteed replay；connect / reconnect immediately triggers canonical Query refresh
* graceful deployment emits `system.reconnect` when possible，fails readiness，drains streams and closes；client reconnects and requeries without replaying a command
* SSE is never a Domain Event bus、Audit source or source of truth；it cannot carry a client command

WP-0036 acceptance covers cross-Store subscription denial、revoked Session closure、duplicate / missed message recovery、CloudFront no-buffer behavior、connection limits、task drain and multi-instance load. WebSocket remains excluded until a committed bidirectional use case and an accepted IDR revision exist.

### 87.13 Work-package Gates and Final Readiness

| Capability / Release Boundary | Required Work Packages / Evidence | Blocks |
| --- | --- | --- |
| Merchant authentication | WP-0100、0106–0109、2040；Cognito / BFF / Session / MFA threat evidence | any production Merchant login |
| Tenant data isolation | WP-0103、2005、2041；application authorization + RLS matrix / pool-leak evidence | any multi-Tenant production data |
| Customer QR / Order access | WP-1002–1007、2042、2048 | public Customer context、Dine-in join / closing、unpaid exception task、Order status and Pickup proof |
| Menu / allergen safety | WP-1028、1407、2027；supplier / Recipe provenance、professional policy and Store training | Pilot Menu publication、allergy assistance and Kitchen start |
| Customer PWA offline | WP-1707–1708、2049；direct Cache Storage inspection | installable PWA and offline public Menu claim |
| Receipt / transactional email | WP-1709、1720–1724、2028；receipt fixtures、SES authentication / suppression / token-leak evidence | production digital receipt、resume and email delivery |
| Realtime hints | WP-0036、1405、1705；SSE scope / reconnect / load evidence | production Kitchen / Order live indicator |
| Observability / alerts | WP-0040–0045、2043；trace redaction、cardinality、Collector outage and acknowledgement evidence | production SLO monitoring and incident response claim |
| HTTP / upload / outbound security | WP-2047、2054；enforced CSP、header、upload and SSRF evidence | production browser traffic and private file use |
| Payment | WP-1301–1310、1809、2045；Stripe / Interac / capture-watchdog / paid-without-fulfillable compensation / reconciliation evidence | live Payment / Refund / Terminal and payment-exception operations |
| Audit / privacy / cryptography / records | WP-0042、0046、2043、2051–2052、2055；PIA、rights、archive and verifier evidence | production PII、statutory records and privileged operations |
| Cloud foundation / deployment | WP-2050、2060–2066；Org guardrails、CDK change set、SBOM、provenance、signature、scan、drift and immutable digest | staging promotion and production deploy |
| Recovery | WP-0025、2053；PITR / cross-Region drill within SLO | production transaction SLO claim |
| Pilot devices | WP-1408、1804、1808；IDR-0039 named-operator KDS / managed-device UAT；printer is out | live Kitchen / Pickup operation |
| Legal entity / Store | external IDR-0037 evidence + `STORE-LIVE-GATE-CA-ON-TOR-001` | live Store、receipt、PII and public ordering |

Final interpretation：

* no further user choice is required before WP-0001 execution-context collection
* the new work packages are implementation / evidence work，not unanswered design questions
* later Coding Agents implement these contracts in dependency order and may decide only file-local details that do not weaken them
* a real incompatibility uses an evidence-backed ADR / IDR revision；time pressure、missing subscription or implementation convenience is not silent permission to downgrade
* coding remains unauthorized until the user explicitly starts it

### 87.14 Additional Primary Verification Sources

* [Chrome for Developers — Workbox service worker caching strategies and Cache Storage separation](https://developer.chrome.com/docs/workbox/caching-strategies-overview/)
* [Amazon RDS — Creating a cross-Region read replica](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReadRepl.XRgn.html)
* [Amazon RDS — Replicating automated backups to another Region](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ReplicateBackups.html)
* [AWS Organizations — Best practices for a multi-account environment](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_best-practices.html)
* [AWS Network Firewall — Stateful domain allowlist rules](https://docs.aws.amazon.com/network-firewall/latest/developerguide/stateful-rule-groups-domain-names.html)
* [Elastic Load Balancing — ALB TLS policies and the explicit post-quantum TLS 1.3 / 1.2 recommendation](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/describe-ssl-policies.html)
* [Amazon S3 — Object Lock retention and legal holds](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html)
* [Amazon Cognito — Authorization code、state、nonce and PKCE endpoint contract](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html)
* [Amazon Cognito — Refresh-token rotation and revocation](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-refresh-token.html)
* [Amazon Cognito — Plus-plan threat protection and staged enforcement](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pool-settings-threat-protection.html)
* [Amazon Cognito — Password history and admin-only recovery settings](https://docs.aws.amazon.com/cognito/latest/developerguide/managing-users-passwords.html)
* [Amazon SNS — Verifying signatures of HTTPS messages](https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html)
* [Amazon SES — Bounce、complaint and delivery event data published through SNS](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-sns-contents.html)
* [Stripe Terminal — Canada and Interac regional requirements](https://docs.stripe.com/terminal/payments/regional?integration-country=CA)
* [Stripe Terminal — Connect to a reader](https://docs.stripe.com/terminal/payments/connect-reader)
* [RFC 8785 — JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785)
* [MDN — Using Server-Sent Events](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events)
* [Ontario Business Corporations Act — sections 140–140.3 corporate records and significant-control register](https://www.ontario.ca/laws/statute/90b16)
* [City of Toronto — Starting a Food Business](https://www.toronto.ca/community-people/health-wellness-care/health-programs-advice/food-safety/food-safety-for-businesses/starting-a-food-business/)
* [City of Toronto — Food Handler Certification](https://www.toronto.ca/community-people/health-wellness-care/health-programs-advice/food-safety/food-handler-certification/)
* [Health Canada — Food allergies and gluten-related disorders](https://www.canada.ca/en/health-canada/services/food-allergies-intolerances.html)
* [Canadian Food Inspection Agency — Ingredients and allergens on food labels](https://inspection.canada.ca/en/food-labels/labelling/industry/list-ingredients-and-allergens)
* [OWASP Content Security Policy Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)
* [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
* [OWASP Server Side Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html)
* [qpdf — 12.3.2 release notes and structural-check baseline](https://qpdf.readthedocs.io/en/stable/release-notes.html)
* [GitHub Docs — Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)

## 88. Complete Page and Function Master Registry（Accepted）

### 88.1 Authority、Scope and Closure Rule

Section 88 是所有产品 Surface 的权威 Page / Function Baseline。它整合并补全 Sections 60–75、80、86–87；若早期章节写有“在对应 Work Package 前继续细化”，其含义只剩文件级实现拆分、视觉稿像素和 Provider / Repository evidence，**不再表示页面、功能、字段组、权限、状态、Projection 或验收行为尚未决定**。

本 Section 覆盖：

* `Customer PWA`：Guest / Customer 扫码、浏览、配置、下单、堂食、支付、状态、取餐、收据与支持
* `Merchant Web`：Owner / Manager 的组织、Store、Commerce、Supply、Customer、Reporting、Compliance 与 Integration 管理
* `Operations Web`：Order、Dining、Kitchen、Pickup、Delivery、Inventory 与现场异常工作台
* `Platform Operations`：仅 Platform Administrator / Authorized Support 使用的 Tenant、Live Gate、Provider、Job 与 Incident 视图

规则：

1. Screen ID、Route Intent、Persona、Permission、字段 / 视图、Search / Filter、Action、State、Projection、Phase 与 Work Package 均须可追踪。
2. Screen 是 Domain Contract 的客户端，不拥有业务事实；所有 Mutation 使用明确 Command、Expected Version、Idempotency Key、Reason / MFA / Approval（适用时）和 Audit。
3. `Phase 2+`、`Future Trigger` 或 Feature-disabled 页面已经设计，但不会因此进入首个 Pilot Build；其导航项在 Capability 未启用时完全隐藏，深链返回 authorized `404` / Feature unavailable，不渲染空壳页面。
4. External Evidence 只影响 Live / Publish / Provider Gate，不把未取得证据伪装成设计缺陷或已完成事实。
5. Desktop / tablet / mobile 可以改变布局，不改变字段语义、权限、Command 或状态机。
6. 页面总表是最小完整集合；Dialog、Drawer、Picker、Wizard Step、Full-screen Work Item 作为独立 Screen ID 登记，但不要求独立导航入口。

### 88.2 Restaurant Archetype and Scale Profiles

系统使用同一 Domain Model 与页面注册表，通过 Store Capability、Service Mode、Policy 和权限组合适配餐饮类型，不为不同餐厅复制代码分支。

| Profile | Default enabled capability | Default hidden / conditional | Page behavior |
| --- | --- | --- | --- |
| Café / Bakery / Bubble Tea | Pickup、counter ordering、options、scheduled Menu、basic inventory、KDS | Table / reservation、delivery fleet、advanced procurement | fast Product Configurator、daypart availability、batch / ingredient alerts；pre-order 通过 Pickup time slot |
| QSR / Fast Casual | Pickup、Dine-in QR、KDS stations、capacity、high-volume Order Queue | Reservation optional、loyalty optional | dense live boards、claim / accept SLA、modifier-first kitchen ticket、quick exception recovery |
| Full-service Restaurant | Table / Dining Session、multi-Batch Order、reservation / waitlist、allergen assistance、table-side Terminal | Delivery optional | Floor / Session Board 是主入口；Guest Session 跨 Batch；Session Closing 和 unpaid exception 强制可见 |
| Ghost Kitchen / Delivery-first | Kitchen、Pickup handoff、Delivery dispatch / provider adapter、multi-brand Menu | Dining floor、reservation / waitlist | channel / promise-time filter、handoff staging、delivery exception优先；Customer tracking仍使用同一 Order truth |
| Food Truck / Pop-up | single Store / Site、limited Menu、pickup、cashless Terminal、offline-safe read-only continuity | reservation、large procurement、fixed floor | compact mobile operations；Store Hours / Location 与 sold-out controls 置顶；无网络不伪造交易成功 |
| Multi-store Brand | Brand catalog overlay、Store assignment、central price / promotion、supplier、BI、compliance | none by scale alone | persistent Brand / Store scope、cross-store comparison only through authorized projections；Store override需显示 inheritance / source |

Scale does not change truth ownership：

* `Small`：一名 Actor 可拥有多个低风险 Role，但 refund、break-glass、live-gate 等已锁定 two-person control 仍不得自批。
* `Medium`：Store-specific roles、station KDS、approval inbox、scheduled reports 默认启用。
* `Enterprise / Multi-store`：Brand / Store scope picker、shared Saved Views、bulk jobs、approval segregation、central governance、projection freshness和export audit必须启用。

### 88.3 Surface Shell、Navigation and Route Policy

| Surface | Route namespace | Persistent shell | Global functions |
| --- | --- | --- | --- |
| Customer PWA | public clean routes (`/menu`、`/cart`、`/checkout`、`/orders/...`) | Brand header、Store / service context、Cart summary、locale / accessibility access | context expiry、offline / stale、support、allergen assistance、safe resume；无 Merchant navigation |
| Merchant Web | `/app/*` | Brand / Store scope、primary nav、Task / Alert Center、global search、help、profile / session | permission-trimmed nav、scope switch impact、command status、saved view、export job、recent objects |
| Operations Web | `/operations/*` | always-visible Store、business date、live / stale indicator、shift-neutral named Actor、incident shortcut | full-screen mode、sound / notification policy、claim state、SSE reconnect、manual continuity link |
| Platform Operations | `/platform/*` | environment、Tenant / Store scope、production warning、case reference、recent MFA indicator | support purpose、impersonation prohibited、break-glass banner、provider / job health、immutable audit trail |

Merchant primary navigation is fixed as：`Home`、`Operations`、`Commerce`、`Supply`、`Customers`、`Reports`、`Compliance`、`Organization`、`Integrations`。Children appear only when both Capability and Permission allow them. Global Search returns permission-trimmed object references and never searches unrestricted notes、allergy data、payment secrets or cross-Tenant content.

### 88.4 Universal Screen Contract

Every registered screen inherits the following unless an explicit row overrides it：

* Header：title、scope、status / lifecycle、primary action、overflow actions、freshness / last updated when projection-backed
* List：keyword / exact identifier search、Filter Drawer、sort、pagination / virtualization、column preferences、row actions、bulk bar only for safe eligible actions、export job when authorized
* Detail：summary、status、stable identity、version / effective period、related tabs、history / audit、available Commands；sensitive tabs are independently permission-checked
* Form：sectioned fields、required / optional / inherited markers、inline validation、draft save、unsaved-change guard、Expected Version、review summary、server conflict recovery
* Workbench：initial sync、Live / Reconnecting / Stale、claim / ownership、SLA / overdue、source conflict、command pending / failed、offline read-only、emergency fallback
* Wizard：step status、back without fact loss、server validation before commit、idempotent final submit、recoverable interrupted session、final impact summary

Universal field metadata：Field Key、business meaning、owner、data type、required rule、default source、editable states、permission、classification、validation、localization、audit、API mapping、projection mapping、empty / redacted display。

Universal states：`Loading`、`Refreshing`、`Empty`、`No Results`、`Permission Denied`、`Not Found`、`Feature Disabled`、`Partial`、`Stale`、`Conflict`、`Command Pending`、`Command Failed`、`Rate Limited`、`Offline Read-only`。Transaction pages additionally include `Unknown / Reconciliation Required` and never infer success from client state.

Universal responsive behavior：

* `<768px`：single column、filters in sheet、tables become priority-card / horizontal-safe view、primary action sticky only when it does not cover content
* `768–1199px`：two-pane where useful；operations boards preserve large touch targets and non-color status cues
* `≥1200px`：full grid / master-detail；maximum readable form width and persistent contextual rail
* 320% CSS zoom、200% browser zoom、keyboard-only、screen-reader labels、reduced motion、minimum touch target and focus visibility follow Sections 74、80、86–87

### 88.5 Canonical Screen Specification Row Semantics

The following registry tables use compact cells：

* `Views / Fields` lists mandatory page regions or field groups；object-level detailed validators remain authoritative in Sections 68、70–72 and Domain sections.
* `Search / Filters` is mandatory for list / queue screens；`—` means the screen is context-bound and must not invent global search.
* `Actions` lists user intents; each maps to a server Command or safe Query / navigation.
* `Access` lists primary roles and permission family; actual access is the intersection of Tenant、Brand、Store、Actor、purpose and field permission.
* `Package` is the owning implementation / evidence package, not permission to start coding.

### 88.6 Customer PWA Page Registry

| Screen ID / Route | Views / Fields | Search / Filters | Actions | Access / State | Phase / Package |
| --- | --- | --- | --- | --- | --- |
| `CUST-ENTRY-CONTEXT` / verified QR or Store link | Brand、Store、service mode、Table / pickup context、locale、hours、expiry、accessibility / allergen help | Store selection only when safe policy allows；never internal ID lookup | resolve、choose allowed service mode、retry、start / resume Guest Session | public input → context-limited Guest Session；invalid / copied / expired / Store closed states | Phase 1 / WP-1000–1007、1700、2042、2048 |
| `CUST-MENU` `/menu` | Menu header、daypart、sections、Sellable card（name、image、display price、availability、diet / allergen cues） | localized name / approved tokens；section、dietary tag、availability；allergen filter cannot promise absence / safety | browse、open item、change allowed order type、open cart、request assistance | Guest Session；offline public allowlist / freshness visible | Phase 1 / WP-1025–1026、1701、1707–1708 |
| `CUST-MENU-SEARCH` `/menu/search` | result cards、matched term、section、availability | query、section、dietary tag、available-now；no unrestricted ingredient inference | search、clear、open item | uniform empty / unavailable results | Phase 1 / WP-1026、1701 |
| `CUST-SELLABLE-DETAIL` `/menu/items/:sellableId` | localized content、media、base / from price、portion / variant、approved allergen / cross-contact、availability、option summary | — | configure、add default-valid item、request allergen assistance、back | pinned effective Menu / Product snapshot；unavailable / changed state | Phase 1 / WP-1020–1028、1701、2027 |
| `CUST-SELLABLE-CONFIGURE` contextual | quantity、required / optional Option Sets、min / max、conflicts、incremental price、structured allergen result、plain note boundary | option search only for long approved sets | select / remove option、quantity、validate、add / update Cart | Guest；selection invalid、price estimate changed、assistance required | Phase 1 / WP-1200–1205、1702、2027 |
| `CUST-ALLERGEN-ASSIST` contextual | controlled allergen references、exact configuration、Store contact / Staff review status、policy copy | — | request Staff assistance、cancel item / checkout、view accepted / cannot-accommodate outcome | Restricted data；no free-text medical narrative；payment blocked until accepted | Phase 1 / WP-1028、1006、1407、2027 |
| `CUST-CART` `/cart` | Cart items、configuration、quantity、line estimate、warnings、Quote summary、expiry、service mode | — | add / update / remove、requote、clear with confirm、continue shopping、checkout | versioned Cart；changed / unavailable / quote-expired / offline read-only | Phase 1 / WP-1200–1205、1702、2049 |
| `CUST-DINE-IN-SESSION` `/dine-in/session` | Table / Dining Session、participants without exposed identity、active Order batches、shared payable summary、service / allergen notices | batch / status local view only | submit new Batch、refresh、view Order status、start allowed payment、request Staff | active Dining credential + Guest Session；Closing locks new Batch | Phase 1 / WP-1006–1007、1220–1226、1703 |
| `CUST-CHECKOUT` `/checkout` | service / fulfillment detail、contact minimum、capacity hold、Quote / tax / tip、policy acknowledgement、receipt choice | address / time-slot choices are policy-scoped, not global search | update allowed detail、requote、confirm price increase、continue to payment | Guest；capacity lost、validation / allergen block、hold expiry | Phase 1 / WP-1100–1105、1220–1226、1703 |
| `CUST-PAYMENT` `/checkout/payment` | amount、tip already selected、allowed method、provider secure component、processing notice | — | create / retry PaymentIntent with same operation rules、provider handoff、cancel before allowed boundary | online card baseline；Staff Terminal handled outside Customer browser；Pending / Failed / Unknown | Phase 1 / WP-1301–1310、1704、2045 |
| `CUST-CHECKOUT-RESULT` `/checkout/result` | operation reference、Payment reconciliation status、Order reference when created、safe recovery instruction | — | idempotent confirm / poll、return to status、contact support | clean route；never trusts redirect result；Pending / Succeeded / Failed / Unknown | Phase 1 / WP-1303–1310、1704 |
| `CUST-ORDER-STATUS` `/orders/:orderReference` | customer-safe Order / Batch、Kitchen / Fulfillment phase、ETA range、ready / exception-safe message | — | refresh、open pickup proof、receipt、support；Dine-in add Batch when eligible | exact Order-authorized Guest Session；reference alone insufficient | Phase 1 / WP-1225、1403–1405、1605、1705 |
| `CUST-PICKUP-CODE` contextual | expiring proof visual、Order number、Store / pickup instruction、ready state | — | reveal / refresh proof、accessibility alternative | never logged / cached；not shown before eligible state | Phase 1 / WP-1602–1605、1706 |
| `CUST-DELIVERY-STATUS` `/orders/:orderReference/delivery` | delivery-safe status、ETA range、handoff / proof summary、support path | — | refresh、contact support、approved instruction update before cutoff | Feature-enabled Delivery only；no courier unrestricted PII | Later Phase 1 / delivery package WP-2150–2155 |
| `CUST-RECEIPT-SUPPORT` `/orders/:orderReference/receipt` | immutable receipt / correction / refund chain、actual entity / Store / transaction snapshot、delivery status、support eligibility | — | view / accessible print、request email / fresh resume、request allowed cancellation / support | authorized Guest Session or one-time resume；lost anonymous Session has no remote recovery | Phase 1 / WP-1709、1720–1724、2028 |
| `CUST-LOYALTY` `/account/loyalty` | profile minimum、program、tier、available / pending / expiring points、rewards、consents | ledger date / type filter | enroll、link eligible transaction、reserve redemption、manage preference、close / privacy request | authenticated Customer capability；marketing consent separate | Phase 3 / WP-2140–2146 |

Customer navigation is journey-driven rather than a permanent application menu. Browser Back, refresh, duplicated callback and multi-tab operation must converge on the same Cart / Checkout / Payment / Order facts. No Customer page offers Cash、manual card entry、split tender、Gift Card、Wallet、alcohol or automated allergy accommodation in the first Pilot.

Future Customer channel pages are also decided now and remain hidden until their Roadmap / abuse / identity gate is committed：

| Screen ID / Route | Views / Fields | Actions / State | Phase / Package |
| --- | --- | --- | --- |
| `CUST-ACCOUNT-AUTH` `/account/sign-in` | verified email / phone method selected by future IDR、challenge / recovery、privacy notice | start / complete / recover authenticated Customer Session；no social / password choice is implied before Provider evidence | Phase 3 / WP-2140 + Customer Identity IDR |
| `CUST-PROFILE` `/account/profile` | minimum profile、verified contacts、locale / accessibility preference、linked loyalty、privacy / consent entry | update / verify、request export / correction / deletion、sign out / revoke Session | Phase 3 / WP-2140、2144、2146 |
| `CUST-RESERVATION-SEARCH` `/reservations` | Store、date / time range、party size、available slots、capacity / deposit policy、accessibility contact | search exact scenario、select slot / capacity hold、continue to details；Unavailable / Hold Expired | Phase 3 channel / WP-2113 + public-channel hardening |
| `CUST-RESERVATION-DETAIL` `/reservations/:reference` | confirmed snapshot、revision history、deposit status separate、Store policy、check-in / cancel eligibility | create / revise atomically、cancel、check-in intent、view refund / notification status；reference requires authorized Customer Session / resume | Phase 3 channel / WP-2113 |
| `CUST-WAITLIST` `/waitlist/:reference` | party、quoted / current ETA range、ready / expiry、Store instruction、notification status | join if Store policy allows、confirm ready / cancel、refresh；ETA is estimate, not guarantee | Phase 3 channel / WP-2114 |

These routes reuse Reservation / Waitlist Domain Commands and never create a second customer-only Aggregate. Public launch remains blocked until rate limit、contact verification、capacity abuse、notification and privacy evidence pass.

### 88.7 Organization、Store、Identity and Shared-service Page Registry

| Screen ID / Route | Views / Fields | Search / Filters | Actions | Access | Phase / Package |
| --- | --- | --- | --- | --- | --- |
| `HOME-OVERVIEW` `/app` | selected scope、live Store status、today summary、open tasks / exceptions、system / Provider health summary | Store / business date | open owning workbench、acknowledge navigation-only alerts | any Merchant Actor, permission-trimmed | Phase 1 / WP-1800、1905 |
| `ORG-ENTITY-LIST` `/app/organization/entities` | legal / operating name、jurisdiction、status、Brand / Store count、effective dates | name / BN exact when authorized；status、jurisdiction | create draft、view、activate / suspend through approval | Owner、Finance、Compliance / `organization.entity.*` | Phase 3 / WP-2190 |
| `ORG-ENTITY-DETAIL` `/app/organization/entities/:id` | stable identity、registration / tax references、addresses、officers / authority summary、Brands / Stores、history / evidence | — | edit draft、submit / approve、manage effective Business Function assignment | field-masked; recent MFA for restricted identifiers | Phase 3 / WP-2190 |
| `ORG-BRAND-LIST` `/app/organization/brands` | name、code、status、locale、Store count、catalog source | name / code；status、country / locale | create、view、edit、activate、archive | Owner / Brand Admin | Phase 1A / WP-0101、0120–0123、2191 |
| `ORG-BRAND-DETAIL` `/app/organization/brands/:id` | identity、locales、media / theme refs、Store membership、configuration inheritance、history | — | edit draft、publish config、manage Store assignment | Brand Admin | Phase 1A / WP-2191 |
| `STORE-LIST` `/app/organization/stores` | code、name、status、timezone、address、service modes、today hours、live-gate、configuration source | name / code / address；status、Brand、region、service mode、live-gate | create draft、open setup、suspend / resume、compare configuration | Owner、Brand / Store Manager | Phase 1 / WP-1000–1001、1801、2192 |
| `STORE-DETAIL` `/app/organization/stores/:id` | Summary、Hours、Service Modes、Capacity、Payments、Tax、Devices、People、Evidence、History | — | edit relevant draft、validate、publish / schedule、open live gate | Store-scoped permissions | Phase 1 / WP-1801、2192 |
| `STORE-SETUP` `/app/organization/stores/:id/setup` | wizard：identity → address / timezone → service modes → hours → tax / payment refs → capacity → contacts → review | Store / address validation lookups | save draft、validate step、publish only when evidence gate allows | Owner / Store Manager；restricted steps permission-trimmed | Phase 1 / WP-1801、2192 |
| `STORE-HOURS-SERVICE` `/app/organization/stores/:id/service` | weekly / exception hours、order-type availability、cutoffs、lead time、Business Day Start、holiday / temporary closure | date range、service mode | create override、validate overlap、schedule、pause service safely | Store Manager / `store.service.*` | Phase 1 / WP-1001、1101、1223、2192 |
| `STORE-CAPABILITY` `/app/organization/stores/:id/capabilities` | enabled modules、inheritance source、dependencies、effective period、impact | capability / enabled / inherited | enable draft、disable with impact、submit / approve / publish | Owner / Brand Admin；cannot bypass Future Trigger IDR | Phase 2 / WP-2193 |
| `STORE-LIVE-GATE` `/app/organization/stores/:id/live-gate` | canonical evidence checklist、owner、status、expiry、blocking reason、last review | gate status、category、owner、expiry | attach approved evidence reference、request review、approve / reject、reopen | Owner、Compliance、Finance; segregation enforced | Phase 1 / WP-2194 + external evidence |
| `IAM-USER-LIST` `/app/organization/users` | display name、login、membership、role、Store assignments、MFA、last active、session risk | name / email exact；status、role、Store、MFA、last active | invite、view、suspend、resend invite、revoke sessions | Owner / Access Admin | Phase 0–1 / WP-0100–0109、1807 |
| `IAM-USER-DETAIL` `/app/organization/users/:id` | membership、role grants、Store assignments、MFA / recovery、active sessions、access history | — | change role / assignment via approval、suspend、revoke session、start recovery | least privilege；cannot edit own protected grants | Phase 0–1 / WP-0100–0109 |
| `IAM-ROLE-LIST` `/app/organization/roles` | role、scope、status、member count、permission count、system / custom | name；status、scope、system / custom | create、duplicate、view、deactivate、compare | Access Admin | Phase 1 / WP-1807、2195 |
| `IAM-ROLE-EDITOR` `/app/organization/roles/:id` | role identity、scope、permission groups、deny / dependency warnings、assigned users、version / history | permission search / capability filter | save draft、compare、submit / approve、activate / deactivate | high-risk role change audited / reasoned | Phase 1 / WP-1807、2195 |
| `IAM-SESSION-LIST` `/app/organization/sessions` | Actor、device / browser summary、Store scope、created / last active / expires、risk / revoked | Actor、Store、status、time | revoke selected authorized session、revoke all for Actor | Access Admin / Support; token never displayed | Phase 1 / WP-0106–0109 |
| `TASK-INBOX` `/app/tasks` | type、severity、owner、scope、due / SLA、source、status | keyword safe refs；status、type、severity、owner、Store、overdue | claim、assign、acknowledge、open source、resolve only via owning Domain | all Merchant roles, permission-trimmed | Phase 1 / WP-0125、0045 |
| `TASK-DETAIL` `/app/tasks/:id` | source snapshot、timeline、SLA、assignment、allowed resolution intents | — | assign、comment controlled、open source action、close when source permits | task + source permission | Phase 1 / WP-0125 |
| `MEDIA-LIBRARY` `/app/media` | thumbnail、purpose、owner scope、scan / publish state、type、size、usage count、retention | filename / tag safe；purpose、status、type、unused | upload to quarantine、view、approve use、replace reference、archive | media permission; malware / content checks | Phase 1A / WP-0121、2047 |
| `FEATURE-FLAG-LIST` `/app/organization/features` | flag、scope、effective value / source、status、expiry、owner | key / description；scope、status、temporary | create config draft、schedule、disable、view evaluation / audit | Platform / authorized Owner; not a permission bypass | Phase 2 / WP-0120、2193 |

Tax identifiers、registration evidence、officer / signing authority and sensitive contact fields are never placed in generic global search, list exports or dashboards. Store scope switch shows the destination before navigation and clears incompatible unsaved / selected state after explicit confirmation.

### 88.8 Commerce Configuration Page Registry

Product、SKU、Category、Option Set and Inventory Item field-level rules in Sections 67–72 remain canonical. The rows below close the rest of Commerce Configuration and establish the navigation / function boundary.

| Screen ID / Route | Views / Fields | Search / Filters | Actions | Access | Phase / Package |
| --- | --- | --- | --- | --- | --- |
| `CAT-PRODUCT-LIST` `/app/commerce/products` | identity、localized name、type、lifecycle、SKU / Menu counts、availability、version / updated | Sections 69.1–69.4 | create、view、duplicate、draft / publish workflow、suspend、archive、export | Catalog roles / `catalog.product.*` | Phase 1 / WP-1020、1027、1802 |
| `CAT-PRODUCT-DETAIL`、`CAT-PRODUCT-CREATE`、`CAT-PRODUCT-EDIT` `/app/commerce/products/...` | Sections 67–69：identity、content、media、variants、Option bindings、availability summary、related / history / audit | related picker search only | save draft、validate、compare、review、publish / schedule、discard、archive / restore | Catalog Editor / Manager / Approver | Phase 1 / WP-1020–1024、1802 |
| `CAT-SKU-LIST`、`CAT-SKU-DETAIL`、`CAT-SKU-CREATE`、`CAT-SKU-EDIT` `/app/commerce/skus/...` | Sections 70：identity、variant values、barcode records、replacement chain、authorized pricing / inventory summaries | code / barcode exact、name token；Product、status、variant、replacement、missing barcode | create within Product draft、edit config、retire barcode、replace、suspend / archive | Catalog roles / `catalog.sku.*` | Phase 1 / WP-1020、1027 |
| `CAT-CATEGORY-TREE` `/app/commerce/categories` | tree、localized names、code、lifecycle、Product count、Menu use、depth / sibling order | name / code；status、empty / used | create、edit、move / reorder、archive / restore、history、import / export | Catalog Manager | Phase 1 / WP-1021、1027 |
| `CAT-OPTIONSET-LIST`、`CAT-OPTIONSET-DETAIL`、`CAT-OPTIONSET-CREATE`、`CAT-OPTIONSET-EDIT` `/app/commerce/option-sets/...` | version、selection rule、Options、price / availability refs、bindings、publish state、history / compare | name / code / option；status、published、binding / conflict | create、edit draft、reorder、validate、review、publish、archive、import / export | Catalog Editor / Approver | Phase 1 / WP-1022、1027 |
| `CAT-MENU-LIST` `/app/commerce/menus` | name、code、scope、channels、status、current / future version、effective period、sections / placements、validation | name / code；status、Store、channel、locale、scheduled / error | create、view builder、duplicate、preview、validate、publish / schedule、rollback by new version、archive | Menu Manager / Approver | Phase 1A / WP-1024–1027、1802 |
| `CAT-MENU-BUILDER` `/app/commerce/menus/:id/edit` | identity / scope、version、Section tree、Sellable placements、localized overrides、channel / daypart、availability ref、validation rail | Product / SKU / Bundle picker；section、unplaced、invalid | add / move / reorder section or placement、edit presentation override、validate、preview、save draft、submit | Menu Editor; drag action has keyboard alternative | Phase 1A / WP-1024、1802 |
| `CAT-MENU-PREVIEW` `/app/commerce/menus/:id/preview` | effective Customer rendering by Store / channel / locale / time、price / availability / allergen snapshot、diff | scenario controls only | change preview scenario、open source issue、approve preview evidence | Menu Editor / Approver; read-only | Phase 1A / WP-1024–1026 |
| `CAT-MENU-PUBLISH` contextual | version diff、validation / unresolved reference、impacted Stores / channels、effective time、approval / rollback plan | issue severity / object | submit、approve / reject、publish now / schedule、cancel schedule | Menu Approver / Publish permission | Phase 1A / WP-1024、1027 |
| `CAT-BUNDLE-LIST` `/app/commerce/bundles` | name、code、lifecycle、price mode、component / choice count、Menu refs、effective version | name / code；status、Menu、fixed / computed price | create、duplicate、edit、validate、publish、suspend、archive | Catalog / Pricing roles by field | Later Phase 1 / WP-2100 |
| `CAT-BUNDLE-EDITOR` `/app/commerce/bundles/:id/edit` | identity、localized content、component groups、min / max、eligible Sellables、upgrade rule、price source、availability、history | Sellable / Option picker | save draft、validate circular / nesting depth 0、simulate configuration、review / publish | Catalog Editor + Pricing approval for money fields | Later Phase 1 / WP-2100 |
| `CAT-AVAILABILITY` `/app/commerce/availability` | rule、scope、Store / channel、schedule、stock / manual source、priority、effective result、reason | item / code；Store、channel、source、active / future、unavailable | create / edit rule、simulate effective result、schedule、pause / resume、Kill Switch with reason | Catalog / Store Manager | Phase 1 / WP-1023、2101 |
| `PRICE-BOOK-LIST` `/app/commerce/pricing` | Price Record / book、scope、currency、source、status、effective period、conflict / coverage | Product / SKU / code；Store、channel、currency、active / future、missing price | create draft、import、view coverage、compare、schedule、archive | Pricing Manager | Phase 1 / WP-1100–1105、2102 |
| `PRICE-BOOK-EDITOR` `/app/commerce/pricing/:id` | identity、scope hierarchy、Sellable prices、effective period、rounding / tax category refs、conflict resolution、history | Sellable picker、missing / conflict rows | edit draft、bulk validated import、simulate resolution、submit / approve / publish | Pricing Editor / Approver; four-eyes when policy | Phase 1 / WP-1100–1105、2102 |
| `TAX-CONFIG` `/app/commerce/tax` | Store registration applicability reference、tax categories、rates / inclusive flag、jurisdiction、effective dates、receipt fixture status | category / code；jurisdiction、active / future | create professional-fixture-backed draft、simulate basket / refund、submit / approve / publish | Finance / Tax Admin; no developer-authored legal assumption | Phase 1 / WP-1100–1105、2103 + SPIKE-1106 evidence |
| `PROMO-LIST` `/app/commerce/promotions` | name、code、type、status、scope、eligibility、benefit、budget / usage summary、effective dates、stacking | name / code；status、Store / channel、type、scheduled / conflict | create、duplicate、edit、simulate、submit / approve、pause、archive | Promotion Manager / Approver | Phase 2 / WP-2104 |
| `PROMO-EDITOR` `/app/commerce/promotions/:id/edit` | identity、audience / basket condition、eligible items、benefit、limits、stacking / priority、schedule、customer copy、impact | Product / Category / Customer-segment picker；rule search | save draft、validate、simulate representative baskets、compare、publish / schedule | Promotion Editor; PII-free segment refs | Phase 2 / WP-2104 |
| `RECIPE-LIST` `/app/commerce/recipes` | name、code、status、yield / unit、cost summary、allergen verification、Product / SKU usage、effective version | name / code / Ingredient；status、unverified allergen、missing mapping、cost changed | create、duplicate、edit、review、publish、archive | Recipe Manager / Food Safety reviewer | Phase 2 / WP-2105 |
| `RECIPE-EDITOR` `/app/commerce/recipes/:id/edit` | identity、yield、Ingredient usage / quantities / loss、preparation version、substitution policy、allergen union / evidence、cost derivation、usage / history | Inventory Item picker；Ingredient / allergen / unresolved source | save draft、recalculate yield / cost / allergens、validate、submit dual review、publish / invalidate | Recipe Editor + Food Safety Approver | Phase 2 / WP-2105、2027 |
| `IMPORT-JOB-LIST` `/app/commerce/imports` | object type、file metadata、scan / parse / validate / approval / commit status、row counts、requester、expiry | job / filename safe；object、status、requester、date | upload、resume mapping、review errors、approve commit、cancel before commit、download expiring result | object import permission | Phase 1 / WP-1027、2000 |
| `IMPORT-JOB-WIZARD` `/app/commerce/imports/new` | upload → scan → column mapping → normalize → validate → diff → approval → commit；row-level error codes | row / error / severity | map、fix source / reupload、exclude only policy-allowed rows、submit / approve、idempotent commit | Importer / Approver; partial commit off by default | Phase 1 / WP-1027、2000 |
| `EXPORT-JOB-LIST` `/app/exports` | source screen / view、scope、filter snapshot、classification、status、row count、expiry、requester | type、status、requester、date | create from source、cancel、download before expiry、revoke | export + field permissions | Phase 1 / cross-cutting WP-2196 |

Commerce inheritance is always visible as `Value + Source + Effective Period`：Platform Default → Brand → Store → Channel / Order Type → explicit permitted exception. An inherited value is not silently copied into a Store draft. All simulations display the exact Store、channel、locale、Business Date / time and configuration versions used.

#### 88.8.1 Existing Catalog Auxiliary Screen ID Closure

The detailed matrices in Sections 67、70–71 remain active. Their auxiliary Screen IDs map to the following decided functions and inherit the parent object's fields、permission、states and Package：

| Object | Screen IDs | Decided function |
| --- | --- | --- |
| Product lifecycle | `CAT-PRODUCT-DUPLICATE`、`CAT-PRODUCT-ARCHIVE`、`CAT-PRODUCT-RESTORE` | guided clone exclusions；dependency / impact review；Restore to Draft + revalidation |
| Product evidence | `CAT-PRODUCT-HISTORY`、`CAT-PRODUCT-AUDIT`、`CAT-PRODUCT-COMPARE` | version / Event timeline；permission-masked Audit；structured version diff |
| Product jobs / lookup | `CAT-PRODUCT-IMPORT`、`CAT-PRODUCT-EXPORT`、`CAT-PRODUCT-PICKER` | validated import job；frozen scoped export；eligible permission-trimmed picker |
| Product workflow | `CAT-PRODUCT-REVIEW`、`CAT-PRODUCT-AVAILABILITY` | submit / approve / publish panel；Store / channel availability relation and effective source |
| SKU lifecycle | `CAT-SKU-DUPLICATE`、`CAT-SKU-ARCHIVE`、`CAT-SKU-RESTORE` | clone identity exclusions；impact；Restore according to Product Draft rule |
| SKU evidence | `CAT-SKU-HISTORY`、`CAT-SKU-AUDIT`、`CAT-SKU-COMPARE` | configuration / replacement / barcode timeline、masked Audit、diff |
| SKU jobs / lookup | `CAT-SKU-IMPORT`、`CAT-SKU-EXPORT`、`CAT-SKU-PICKER` | validated job、scoped export、eligible compact selection |
| SKU specialized | `CAT-SKU-WORKFLOW`、`CAT-SKU-REPLACEMENT`、`CAT-SKU-VARIANT-MATRIX`、`CAT-SKU-BARCODE`、`CAT-SKU-AVAILABILITY` | Product-owned publish；acyclic replacement；combination mapping；append / retire barcode；effective availability |
| Category core | `CAT-CATEGORY-LIST`、`CAT-CATEGORY-DETAIL`、`CAT-CATEGORY-CREATE`、`CAT-CATEGORY-EDIT` | tree / list、identity / usage、create / edit localized category and parent / order rules |
| Category lifecycle / evidence | `CAT-CATEGORY-ARCHIVE`、`CAT-CATEGORY-RESTORE`、`CAT-CATEGORY-HISTORY`、`CAT-CATEGORY-AUDIT` | impact、restore、tree / assignment timeline、Audit |
| Category jobs / lookup / workflow | `CAT-CATEGORY-IMPORT`、`CAT-CATEGORY-EXPORT`、`CAT-CATEGORY-PICKER`、`CAT-CATEGORY-WORKFLOW`、`CAT-CATEGORY-REORDER` | validated tree job、export、eligible picker、approval when policy、keyboard-accessible move / reorder |
| Option Set lifecycle | `CAT-OPTIONSET-DUPLICATE`、`CAT-OPTIONSET-ARCHIVE`、`CAT-OPTIONSET-RESTORE` | clone as Draft、binding impact、restore and republish |
| Option Set evidence | `CAT-OPTIONSET-HISTORY`、`CAT-OPTIONSET-AUDIT`、`CAT-OPTIONSET-COMPARE` | version / binding timeline、Audit、rule / Option diff |
| Option Set jobs / lookup / workflow | `CAT-OPTIONSET-IMPORT`、`CAT-OPTIONSET-EXPORT`、`CAT-OPTIONSET-PICKER`、`CAT-OPTIONSET-PUBLISH` | validated import、scoped export、published / eligible picker、submit / approve / publish |

Dialog / Drawer entries are separate Screen IDs for accessibility、permission and acceptance tracking even when they do not have independent routes.

### 88.9 Commerce Field-group Closure

The following mandatory groups remove any remaining ambiguity for pages without a dedicated Section 68 / 70–72 field registry：

| Object | Stable identity | Versioned / editable configuration | Mandatory related views | Publish-blocking validation |
| --- | --- | --- | --- | --- |
| Menu | Menu ID、Brand ID、internal code | localized name、channels、Store scope、Sections、Placements、presentation overrides、effective period | preview、validation、versions、history、audit、Store resolution | duplicate code、empty publishable Menu、invalid placement、unavailable / unpublished Sellable、locale / price / allergen gap、schedule overlap |
| Bundle | Bundle ID、Brand ID、code | localized content、component groups、choice rules、eligible Sellables、price / upgrade、availability | configuration simulator、Menu usage、price / allergen result、history | nested Bundle depth >0、unsatisfiable min / max、unpriced path、unverified allergen、unavailable required component |
| Availability Rule | Rule ID、owner scope、code | target、Store / channel / order type、schedule、source / priority、reason | effective-result simulator、conflict list、history | ambiguous equal-priority result、invalid scope、schedule overlap without deterministic resolution |
| Price Record / Book | stable price / book ID、currency、scope | Sellable amount、channel / Store overlay、effective period、reason / approval | coverage、resolution simulator、history、audit | floating point、currency mismatch、overlap conflict、missing Pilot path、unapproved tax ref |
| Tax Configuration | stable config / category IDs、jurisdiction ref | rates / treatment supplied by approved fixture、inclusive / exclusive display、effective period | basket / discount / tip / service / refund fixtures、receipt preview、history | missing professional approval、placeholder registration、uncovered Sellable tax category、fixture failure |
| Promotion | Promotion ID、Brand ID、code | eligibility、benefit、limits、stacking、budget、schedule、localized copy | simulation、usage、conflicts、history | circular benefit、negative total、ambiguous stacking、timezone / schedule overlap、missing approval |
| Recipe | Recipe ID、Brand ID、code | version、yield、Ingredient Usage、loss、preparation、substitution、evidence refs | cost、allergen / cross-contact、SKU usage、supplier evidence、history | invalid unit conversion、zero / negative yield、unknown Ingredient、unverified allergen path、unapproved substitution |

### 88.10 Ordering、Payment、Kitchen and Fulfillment Page Registry

| Screen ID / Route | Views / Fields | Search / Filters | Actions | Access | Phase / Package |
| --- | --- | --- | --- | --- | --- |
| `OPS-ORDER-QUEUE` `/operations/orders` | Order number、channel / type、table / pickup ref、phase、payment / Kitchen / fulfillment summary、promise / age、claim、exception | Order / public ref exact、customer-safe contact exact only with permission；status、type、channel、payment、Kitchen、overdue、exception、claimed | claim、accept / reject per policy、open detail / exception；no arbitrary status select | Order Staff / Manager | Phase 1 / WP-1225、1803、1900 |
| `OPS-ORDER-DETAIL` `/operations/orders/:id` | immutable header / snapshots、Batch / items、money / tax、Payment allocations、Kitchen / fulfillment、amendments、notifications、timeline、audit | — | accept / reject、allowed cancel / amendment、open refund、resend notification、print future-trigger only | field / action permissions | Phase 1 / WP-1221–1226、1803 |
| `OPS-ORDER-AMEND` contextual wizard | reason、eligible items / quantities / configuration、repricing / tax delta、Kitchen / fulfillment impact、payment / refund consequence、customer notice | item lookup within Order only | validate impact、submit amendment、request approval、abort | Manager; state / cutoff / expected version enforced | Phase 2 / WP-2110 |
| `OPS-ORDER-ENTRY` `/operations/order-entry` | fixed Store / service context、public-effective Menu、Sellable configurator、staff Cart / Quote、optional Dining Session / verified Customer ref、structured allergen review、cashless Payment / Terminal handoff | localized Menu item / code；section、available now、service mode | create staff-scoped Cart、configure、requote、attach eligible Dining Session、record Staff allergen assistance、submit Order / Batch idempotently、start Terminal payment | Counter / Server Staff + explicit `ordering.order.create_staff`；no arbitrary price / tax / status override | Later Phase 1 / Phase 2 / WP-2116 |
| `OPS-ORDER-EXCEPTION` `/operations/order-exceptions` | type / severity、Order / Payment / Dining refs、Store、created / SLA、owner、reconciliation / compensation status、timeline | safe refs；type、severity、status、owner、Store、overdue、Provider state | acknowledge、assign、open evidence、execute owning-domain compensate / retry / write-off request、resolve only when invariants pass | Store Manager / Authorized Support | Phase 1 / WP-1007、1310、1809 |
| `PAY-PAYMENT-LIST` `/app/operations/payments` | Payment / attempt ref、Order、method family、authorized / captured / refunded amounts、state、Provider reconciliation、age | Payment / Order / Provider-safe ref exact；state、method、Store、date、amount range、exception、unreconciled | view、open refund / reconciliation、capture / cancel only when contract allows | Finance / Manager / Support | Phase 1 / WP-1301–1308、1901 |
| `PAY-PAYMENT-DETAIL` `/app/operations/payments/:id` | Payment state machine、attempts、allocations、capture / refund chain、Provider-safe evidence、webhook / reconciliation timeline、audit | — | idempotent allowed capture / cancel、start refund、retry reconciliation、open exception | payment permissions; no PAN / secret / raw unrestricted payload | Phase 1 / WP-1301–1310 |
| `PAY-REFUND-WIZARD` `/app/operations/payments/:id/refund` | eligible amount / lines、tax / tip / service allocation、reason、original method、approval threshold、Terminal presence requirement、customer outcome | refundable Order lines only | calculate、submit request、approve / reject、execute idempotently、track Pending / Unknown | Manager + Owner / Finance approval per threshold; recent MFA | Phase 1 / WP-1301–1308、2045 |
| `PAY-RECONCILIATION` `/app/operations/payment-reconciliation` | internal / Provider amount / state、settlement ref、difference、last checked、exception / owner | Payment / settlement ref；date、Store、state、difference、age、owner | fetch evidence、match、create / assign exception、record authorized resolution | Finance / Support | Phase 1 / WP-1307、1310、1901 |
| `PAY-TERMINAL` `/operations/terminal` | Store / Location、reader label / serial safe suffix、connection / battery / network、current operation、last health | reader label；status、Location | connect named reader、collect eligible PaymentIntent、cancel allowed attempt、open device incident | named Staff; server-resolved Location; no connection token display | Phase 1 / WP-1301–1309、1408 |
| `KIT-KITCHEN-QUEUE` `/operations/kitchen` | station lanes、ticket / item、course / priority、age / SLA、allergen flag、hold / exception、claim | Order / ticket ref；station、state、course、priority、allergen、overdue | accept、start、hold / resume、ready according to item state、prioritize by policy、open detail / exception | named Kitchen Operator | Phase 1 / WP-1400–1408、1804 |
| `KIT-WORK-ITEM` `/operations/kitchen/work-items/:id` full-screen child route | exact item / modifier / quantity、Recipe / handling snapshot needed for execution、allergen structured cue / acknowledgements、timers、dependencies、history | — | acknowledge safety、start、complete / ready、hold、report exception、recall under policy | Kitchen Staff / Lead; privacy-minimized；return preserves Queue scope | Phase 1 / WP-1401–1408 |
| `KIT-EXCEPTION` contextual / queue | exception type、affected item / ticket、severity、reason code、containment / reroute、owner、SLA | safe ref；type、severity、status、station、overdue | report、acknowledge、assign、reroute / remake / block Sellable through authorized action、resolve | Kitchen Lead / Store Manager | Phase 1 / WP-1406–1408 |
| `KIT-PRODUCTION-BATCH` `/operations/production-batches` | batch、Recipe / version、planned / actual yield、station、lot / ingredient refs、state、variance、quality hold | batch / Recipe；state、station、date、variance / hold | create plan、start、record controlled yield / consumption、complete、quarantine / exception | Kitchen Lead / Inventory authorized roles | Phase 2 / WP-2111 |
| `FUL-PICKUP-QUEUE` `/operations/pickup` | fulfillment / Order、ready time、wait / overdue、proof readiness、staging location、claim / exception | Order / pickup ref；ready / waiting / overdue、claimed、exception | claim、open proof verification、report exception | Pickup Staff / Manager | Phase 1 / WP-1600–1605、1805 |
| `FUL-PICKUP-HANDOFF` contextual | target Order / Fulfillment、customer-safe identifiers、proof result、items / package count、allergen cue、handoff evidence summary | — | verify signed proof / approved alternative、confirm explicit target、complete atomically、fail / escalate | `fulfillment.pickup.complete` | Phase 1 / WP-1602–1605、1805 |
| `FUL-FULFILLMENT-DETAIL` `/app/operations/fulfillments/:id` | type、Order、promise / actual、handoff / delivery proof、exceptions、timeline、corrections / audit | — | allowed corrective action、open source facts / support | Manager / Support / Auditor | Phase 1 / WP-1600–1605 |
| `FUL-DELIVERY-DISPATCH` `/operations/delivery` | unassigned / assigned / active / exception lanes、promise、zone、provider / courier ref、handoff state、age | Order / task ref；state、zone、provider、overdue、exception | assign / offer、accept、start、handoff、reassign under policy、open exception | Delivery Coordinator / Manager | Later Phase 1 / WP-2150–2155 |
| `FUL-DELIVERY-DETAIL` `/operations/delivery/:id` | immutable address snapshot field-masked、task legs、courier / provider、proof、contact attempts、fees snapshot、timeline | — | allowed update before cutoff、dispatch / cancel / reassign、record exception / proof through commands | delivery permissions / purpose | Later Phase 1 / WP-2150–2155 |
| `FUL-DELIVERY-EXCEPTION` `/operations/delivery/exceptions` | type、severity、Task / Order、owner、SLA、customer impact、resolution / compensation refs | safe refs；type、status、provider、owner、overdue | acknowledge、assign、reroute / cancel / support handoff、resolve after source finality | Coordinator / Support | Later Phase 1 / WP-2154 |

Operational page rules：

* Money、Kitchen、Dining and Fulfillment phases remain separate status columns; UI never compresses them into one editable status.
* Board actions are optimistic only in visual pending state; source confirmation is required before moving a card permanently.
* Realtime is a hint. On initial connect / reconnect every board re-runs its canonical scope Query; a gap cannot be repaired by replaying a browser Command.
* Order / Payment / Refund / Handoff history is append-only. “Edit” is replaced by Amendment、Correction、Compensation or linked Reissue.
* Staff Order Entry reuses the same Cart、Quote、Order、Batch、Allergen and Payment contracts as Customer ordering；it records the named Staff Actor / channel and does not introduce a POS-only truth model. It remains hidden in the first Pilot unless the owning package is committed.

### 88.11 Dining、Table、Reservation and Waitlist Page Registry

| Screen ID / Route | Views / Fields | Search / Filters | Actions | Access | Phase / Package |
| --- | --- | --- | --- | --- | --- |
| `DIN-FLOOR-BOARD` `/operations/dining` | floor / area、Table label / capacity / state、active party / Session、elapsed time、Order / payment summary、reservation / waitlist handoff、attention cue | Table / Session / reservation ref；area、state、server / owner、attention | start Staff Dining Session、seat eligible party、open Session、mark Table unavailable through command | Host / Server / Manager | Phase 2 / WP-2112 |
| `DIN-TABLE-LIST` `/app/operations/tables` | Table stable label、area、capacity、accessibility attributes、QR state、operational state、current Session | label；area、capacity、state、QR active / replacement | create / edit configuration draft、issue / revoke QR capability、set temporary operational block | Store Manager | Phase 2 / WP-2112 |
| `DIN-SESSION-DETAIL` `/operations/dining/sessions/:id` | Table / party、participants、Batches / Order、payment balance / reservations、allergen assistance、timeline、Closing tasks | — | add / move Table under policy、join Staff participant、lock / start Closing、resolve unpaid task、close when invariants pass | Server / Manager; sensitive fields minimized | Phase 1–2 / WP-1006–1007、2112 |
| `DIN-SESSION-START` contextual wizard | Table、party size、source reservation / waitlist、capacity / duplicate check、short-lived join credential / expiry | eligible Table / checked-in party lookup | validate、start idempotently、display / rotate short-lived join credential | named Staff | Phase 1 / WP-1006、2048 |
| `RES-CALENDAR` `/operations/reservations/calendar` | day / week capacity bands、reservations、holds、closures、Table / area hints、waitlist | customer-safe name / ref / contact exact with permission；date、party size、status、channel、accessibility request | create、open、check in、reschedule via revision、cancel、mark no-show | Host / Manager | Phase 2 / WP-2113 |
| `RES-LIST` `/operations/reservations` | ref、date / time、party size、customer snapshot、status、deposit / guarantee separate、source、special controlled needs | ref / contact exact；date、status、party size、source、deposit、late / no-show | create、view、check in、revise、cancel、no-show per policy | Host / Manager | Phase 2 / WP-2113 |
| `RES-DETAIL` `/operations/reservations/:id` | original + revisions、capacity hold、customer snapshot、deposit collaboration、notifications、check-in / seating handoff、history | — | revise atomically with capacity check、check in、cancel、mark late / no-show、seat by Dining command | reservation permissions | Phase 2 / WP-2113 |
| `RES-CREATE-EDIT` contextual wizard | date / time、party size、contact minimum、channel、accessibility / controlled request、capacity result、deposit policy、confirmation | availability lookup by exact scenario | hold capacity、save request、collect deposit through Payment boundary、confirm、release on expiry | Host / Customer future extension | Phase 2 / WP-2113 |
| `WAIT-BOARD` `/operations/waitlist` | ordered entries、party size、quoted / current ETA、priority reason、contact state、ready expiry、seating eligibility | customer-safe name / ref；status、party size、area、priority、overdue | add、update estimate、notify ready、hold / remove with reason、seat through Dining handoff | Host / Manager | Phase 2 / WP-2114 |
| `WAIT-ENTRY` contextual | identity / contact snapshot、party / preferences、arrival / wait metrics、notifications、revision / timeline | — | edit controlled details、mark Ready、extend once by policy、cancel、seat | Host / Manager | Phase 2 / WP-2114 |
| `RES-CAPACITY-CONFIG` `/app/operations/reservation-capacity` | Store / area、time buckets、capacity、online allocation、overbook policy、closures、deposit / no-show refs、effective period | date / area / service | edit draft、simulate demand / conflicts、publish / schedule | Store Manager / Reservation Admin | Phase 2 / WP-2115 |

Reservation `Seated` is derived only after Dining creates the Session. Dining `Closed` does not erase an unpaid / indeterminate Order; it creates / retains the Section 88.10 exception task until an authorized final outcome exists.

### 88.12 Inventory、Stock and Procurement Page Registry

| Screen ID / Route | Views / Fields | Search / Filters | Actions | Access | Phase / Package |
| --- | --- | --- | --- | --- | --- |
| `INV-STOCK-OVERVIEW` `/operations/inventory` | one explicit Stock Scope、on-hand / reserved / available、reorder / expiry / negative / count alerts、freshness、value only if authorized | item / code / barcode / supplier item code；category、location、availability、below reorder、expiry、negative、tracking | open item / movements、start count、adjust / waste / transfer through wizard、set policy | Inventory Staff / Manager; cost separately gated | Phase 2 / WP-2120 |
| `INV-ITEM-LIST`、`INV-ITEM-DETAIL`、`INV-ITEM-CREATE`、`INV-ITEM-EDIT` `/app/supply/items/...` | Sections 72：identity、units、tracking、lot / expiry、reorder、Store assignment、usage / supplier summaries、history | Section 72.13 | create、edit、conversion / policy、archive / restore、open related workflows | Inventory Manager | Phase 2 / WP-2120 |
| `INV-MOVEMENT-LIST` `/app/supply/movements` | movement ref、type、item、lot / location、quantity / unit、source / destination、business source、Actor / time、correction link | ref / item / barcode / source ref；type、scope、location、lot、date、Actor、corrected | view evidence / source、create compensating correction when eligible、export | Inventory / Auditor | Phase 2 / WP-2121 |
| `INV-MOVEMENT-DETAIL` `/app/supply/movements/:id` | immutable quantity / conversion、before / after projection snapshot、source Event / document、lot / expiry、audit / correction chain | — | open source、start correction wizard | scoped inventory read | Phase 2 / WP-2121 |
| `INV-COUNT-LIST` `/operations/inventory/counts` | count ref、scope、type、status、assignee、freeze / snapshot、progress、variance、due | ref；status、scope、assignee、date、variance / overdue | create、assign、start / continue、submit、approve / reject、cancel | Inventory Staff / Manager; submitter cannot approve when policy | Phase 2 / WP-2122 |
| `INV-COUNT-WORKBENCH` `/operations/inventory/counts/:id` | blind expected quantity policy、item / lot / location rows、counted quantity / unit、variance / reason、progress / conflict | item / barcode scan；counted / missing / variance / exception | enter / scan、save progress、recount、submit、approve / reject、post idempotent movements | Count assignee / Approver | Phase 2 / WP-2122 |
| `INV-ADJUSTMENT-WIZARD` contextual | scope、item / lot / location、current projection、quantity delta / unit、reason、evidence、impact / approval | exact item / barcode / lot | validate、submit / approve、post one immutable movement | authorized Inventory Manager; high-risk control | Phase 2 / WP-2123 |
| `INV-WASTE-WIZARD` `/operations/inventory/waste/new` | item / lot、quantity / unit、waste reason、source Kitchen / incident、evidence、cost summary if allowed | item / barcode / lot | record、submit / approve by threshold、link food-safety incident | Kitchen Lead / Inventory Manager | Phase 2 / WP-2124 |
| `INV-TRANSFER-LIST` `/operations/inventory/transfers` | transfer ref、source / destination Site / Location、state、items、shipped / received / discrepancy、owner / dates | ref / item；state、source、destination、date、discrepancy | create、approve、dispatch、receive、report discrepancy、cancel remaining by policy | Inventory / Store Managers | Phase 2 / WP-2125 |
| `INV-TRANSFER-DETAIL` `/operations/inventory/transfers/:id` | immutable request / revision、lines / lots、dispatch / receipt events、in-transit quantity、discrepancies、timeline | — | revise before dispatch、dispatch、partial receive、exception / close | scoped source + destination permission | Phase 2 / WP-2125 |
| `INV-LOT-EXPIRY` `/operations/inventory/lots` | item、lot、expiry / received、location、on-hand / reserved、status / hold、supplier / receipt trace | lot / item / barcode；expiry window、location、hold、supplier、FEFO exception | open trace、quarantine through Compliance / Inventory command、start waste / transfer / count | Inventory / Food Safety | Phase 2 / WP-2126 |
| `INV-REPLENISHMENT` `/app/supply/replenishment` | need ref、item / scope、available、threshold / forecast input、suggested quantity、preferred supplier summary、status | item / code；Store、status、urgency、supplier / unmapped | acknowledge、create Requisition draft、dismiss only with reason；never auto-issue PO | Inventory / Buyer | Phase 3 / WP-2130 |
| `SUP-SUPPLIER-LIST` `/app/supply/suppliers` | name、code、status、type、qualification status / expiry、Offering / open PO count、performance summary | name / code / approved contact ref；status、type、qualification、performance flag、has open PO | create、view、suspend / reactivate、archive forbidden physical delete | Procurement Manager / Compliance | Phase 3 / WP-2131 |
| `SUP-SUPPLIER-DETAIL` `/app/supply/suppliers/:id` | identity、contacts field-masked、addresses、qualifications / evidence、Offerings、POs、performance、history / audit | — | edit、manage qualification、suspend、open Offering / PO / discrepancy | Procurement roles | Phase 3 / WP-2131 |
| `SUP-OFFERING-LIST` `/app/supply/offerings` | Supplier、Inventory Item、supplier item code、pack / purchase unit、lead time / MOQ / multiple、price / currency / effective、status | supplier / item / code；status、currency、Store coverage、expiring price / qualification | create、edit version、publish、suspend、compare、set preferred through policy | Buyer / Procurement Manager | Phase 3 / WP-2132 |
| `SUP-OFFERING-EDITOR` `/app/supply/offerings/:id` | stable mapping、versioned purchasing config、unit conversion、terms、price records、qualification refs、history | Supplier / Item picker | save draft、validate conversion / price resolution、submit / approve、publish | Buyer / Approver | Phase 3 / WP-2132 |
| `PROC-REQUISITION-LIST` `/app/supply/requisitions` | ref、requesting Store / entity、status、urgency、lines / amount estimate、requester / approver、allocation | ref / item；status、Store、requester、urgency、unallocated、date | create、view、submit / approve / reject、allocate approved lines to PO drafts | Requester / Buyer / Approver | Phase 3 / WP-2133 |
| `PROC-REQUISITION-DETAIL` `/app/supply/requisitions/:id` | need sources、lines / requested quantities、candidate suppliers、approval、PO allocations、timeline | — | edit draft、submit、approve / reject、split / allocate、cancel remaining with reason | procurement segregation | Phase 3 / WP-2133 |
| `PROC-PO-LIST` `/app/supply/purchase-orders` | PO ref、Supplier、Buyer Entity、Ship-to、currency、workflow / fulfillment / closure states、ordered / received / open amount、dates | ref / supplier / item；state dimensions、Store、buyer、date、overdue / discrepancy | create from approved need、view、approve、issue、record acknowledgement、cancel eligible remainder | Buyer / Approver / Receiving read | Phase 3 / WP-2134 |
| `PROC-PO-EDITOR` `/app/supply/purchase-orders/:id/edit` | Supplier / Buyer / Ship-to / currency、Offering-based lines、quantity / unit / price resolution、terms、tolerance、totals、source allocations | approved Offering / Requisition picker | save draft、validate、submit / approve、issue；post-issue changes create Revision | Buyer / Approver; cannot arbitrary-price line | Phase 3 / WP-2134 |
| `PROC-PO-DETAIL` `/app/supply/purchase-orders/:id` | issued snapshots、states separated、acknowledgement、revisions、receipts / discrepancies、line completion、performance timeline | — | acknowledge / decline record、create Revision、cancel remaining、close only when invariant | Procurement roles / Auditor | Phase 3 / WP-2134 |
| `INV-GOODS-RECEIPT` `/operations/receiving/new` | PO / line snapshot、actual item / lot / expiry、quantity / unit、location、quality / temperature evidence、variance / tolerance | PO / supplier / item / barcode | receive partial / final、quarantine、record discrepancy、submit immutable receipt / movements | Receiver; cannot edit PO received quantity | Phase 3 / WP-2135 |
| `PROC-DISCREPANCY` `/app/supply/discrepancies` | PO / receipt / line、short / over / damaged / quality type、tolerance、owner、status、supplier contact outcome | PO / receipt / supplier；type、status、Store、owner、overdue | acknowledge、assign、accept within policy、request correction / replacement、waive remainder with approval、close | Procurement Manager / Receiving / Compliance | Phase 3 / WP-2136 |
| `SUP-PERFORMANCE` `/app/supply/performance` | on-time、fill rate、quality / discrepancy、ack response、decline / cancel、period / source coverage | supplier / item category；period、Store / Brand、metric threshold | drill to facts、export authorized、open review task；never directly overwrite score | Procurement Manager / Analyst | Phase 3 / WP-2137 |

Inventory quantity pages require exactly one explicit Stock Scope before quantity sort、filter or export. Balance is always a projection of the immutable Ledger. Procurement never directly writes received quantity；Goods Receipt Events drive PO fulfillment projection. Cost and supplier contact fields use separate permissions from operational quantity fields.

#### 88.12.1 Existing Inventory Auxiliary Screen ID Closure

These rows close historic IDs from Section 72。They are either exact contextual placements or superseded aliases, not additional unspecified pages。All are Phase 2 and inherit the named parent / package；Screen Registry records use `kind=embedded` / `action` or `alias_of` rather than inventing a second canonical Route。

| Screen IDs | Decided function | Canonical placement / ownership |
| --- | --- | --- |
| `INV-ITEM-DUPLICATE`、`INV-ITEM-ARCHIVE`、`INV-ITEM-RESTORE` | clone without identity / balance；usage / stock / supplier impact；restore master data without recreating historical quantity | contextual actions / `IMPACT-DIALOG` from `INV-ITEM-LIST` or `INV-ITEM-DETAIL`；Phase 2 / WP-2120 |
| `INV-ITEM-HISTORY`、`INV-ITEM-AUDIT`、`INV-ITEM-COMPARE` | unit / tracking / reorder / relationship revision timeline、masked Audit and structured comparison | history route `/app/supply/items/:id/history`；Audit embedded；compare route `/app/supply/items/:id/compare`；Phase 2 / WP-2120 |
| `INV-ITEM-IMPORT`、`INV-ITEM-EXPORT`、`INV-ITEM-PICKER` | master-data-only import（no opening balance）、scoped export、eligible item lookup | import route `/app/supply/items/import`；export action / Job；picker embedded；Phase 2 / WP-2120 |
| `INV-ITEM-POLICY-REVIEW`、`INV-ITEM-REORDER`、`INV-ITEM-SUPPLIER-MAPPING` | high-risk unit / tracking revision、Store-scoped reorder policy、Procurement-owned Offering relation | embedded tabs / panels under `INV-ITEM-DETAIL` / Edit；Phase 2 / WP-2120 with Procurement contract from WP-2132 |
| `INV-ITEM-STOCK-HISTORY` | item-scoped immutable Movement Explorer with explicit Stock Scope | route `/app/supply/items/:id/movements` backed by `INV-MOVEMENT-LIST` contract；Phase 2 / WP-2120–2121 |
| `INV-STOCK-COUNT`、`INV-STOCK-ADJUSTMENT`、`INV-STOCK-TRANSFER`、`INV-WASTE-RECORD` | historic umbrella IDs | aliases respectively of `INV-COUNT-LIST` / Workbench、`INV-ADJUSTMENT-WIZARD`、`INV-TRANSFER-LIST` / Detail and `INV-WASTE-WIZARD`；no second route；Phase 2 / WP-2122–2125 |

### 88.13 Supply Field-group Closure

| Object | Mandatory field groups | Key filters | High-risk / immutable rule |
| --- | --- | --- | --- |
| Stock Count | scope、snapshot / freeze policy、assignee、lines、count / recount、variance、approval | status、scope、assignee、variance、overdue | posting creates movements once；approved count cannot be edited |
| Adjustment / Waste | scope、item / lot / location、delta、unit conversion、reason、evidence、approval | type、reason、Actor、date、value threshold | no direct balance edit；correction is compensating movement |
| Transfer | source / destination、lines / lots、requested / dispatched / received、state、discrepancy | state、sites、item、date、exception | dispatch and receipt append facts；in-transit never disappears by edit |
| Supplier | Brand、identity、contacts、addresses、type、status、qualification | status、type、qualification / expiry、performance flag | no physical delete；suspension leaves historical POs unchanged |
| Offering / Price | Supplier + Item、supplier code、pack / units、MOQ、multiple、lead time、price / currency / period、qualification | Supplier、Item、status、currency、expiry | PO line uses approved Offering / Price snapshot；no arbitrary price override |
| Requisition | requester / scope、need source、lines、urgency、approval、allocation | status、Store、requester、unallocated | approval is not external commitment |
| Purchase Order | Supplier、Buyer Entity、Ship-to、currency、lines、terms、tolerance、workflow / fulfillment / closure | separate state dimensions、Supplier、Store、overdue / discrepancy | only Issue creates commitment；post-issue change is Revision |
| Goods Receipt | PO refs、actual quantities / units、lot / expiry、location、quality / temperature、evidence、discrepancy | Supplier、PO、Store、date、exception | Inventory owns receipt fact；Procurement consumes event |

### 88.14 Customer、Loyalty and Communication Page Registry

| Screen ID / Route | Views / Fields | Search / Filters | Actions | Access | Phase / Package |
| --- | --- | --- | --- | --- | --- |
| `CRM-CUSTOMER-LIST` `/app/customers` | Customer ref、display name / masked contact、profile / loyalty status、tier、last interaction、consent summary、open case flag | exact authorized contact、name token；status、program / tier、consent、last interaction、open case | create only from valid purpose、view、start merge review / privacy request | Customer Service / Loyalty Manager; purpose logged | Phase 3 / WP-2140 |
| `CRM-CUSTOMER-DETAIL` `/app/customers/:id` | profile、verified contacts、Brand relationship、Orders / reservations refs、Loyalty accounts、consents、communications、privacy / case summary、audit | — | update allowed profile、verify contact、link eligible Guest transaction with proof、manage consent、open privacy case | field / purpose permissions | Phase 3 / WP-2140 |
| `CRM-MERGE-REVIEW` contextual | candidate identity / evidence、conflicting fields、linked accounts / transactions、consents、impact / rollback reference | candidate exact contact / ref only | compare、approve merge / reject；never automatic broad fuzzy merge | Privacy-authorized Manager + approval | Phase 3 / WP-2141 |
| `LOY-PROGRAM-LIST` `/app/customers/loyalty-programs` | name、status、scope、current version、member count、earn / redeem summary、effective dates | name / code；status、Store scope、scheduled | create、duplicate、edit draft、simulate、publish / schedule、suspend | Loyalty Manager / Approver | Phase 3 / WP-2142 |
| `LOY-PROGRAM-EDITOR` `/app/customers/loyalty-programs/:id` | eligibility、earn / activation、redemption、expiry、tier、reward / entitlement、refund reversal、effective period、customer copy | Reward / Product / Category picker | save、validate points conservation / conflicts、simulate lifecycle、review / publish | Loyalty Editor / Approver | Phase 3 / WP-2142 |
| `LOY-ACCOUNT-DETAIL` `/app/customers/loyalty-accounts/:id` | account state、program / tier、available / reserved / pending / expiring、ledger、rewards、reservations、linked allocations | ledger date / type / Order ref | suspend / reactivate、authorized correction via linked transaction、release invalid reservation、close | Loyalty Support; no direct balance edit | Phase 3 / WP-2143 |
| `LOY-POINTS-REVIEW` `/app/customers/loyalty-exceptions` | duplicate / failed earn、refund reversal、expired reservation、negative / mismatch exception、owner / SLA | account / Order ref；type、status、program、owner、overdue | acknowledge、recalculate from source、append authorized correction、resolve | Loyalty Manager / Support | Phase 3 / WP-2143 |
| `CONSENT-PREFERENCE` `/app/customers/consents/:customerId` | purpose、channel、status、source / proof、effective / withdrawn time、policy version | purpose / channel / state | record verified choice、withdraw、export proof | Privacy / Customer Service | Phase 3 / WP-2144 |
| `COMMS-HISTORY` `/app/customers/communications` | operational / marketing classification、recipient masked、template version、provider state、suppression、source / time | source ref / recipient exact with permission；type、channel、state、date、suppressed | view evidence、resend only eligible operational notification、suppress / unsuppress by verified process | Support / Marketing permission separated | Phase 1–3 / WP-1720–1724、2145 |
| `COMMS-TEMPLATE-LIST`、`COMMS-TEMPLATE-EDITOR` `/app/customers/templates/...` | purpose、locale、channel、version、status、required variables、preview fixtures、tracking prohibition | name / key；purpose、locale、channel、status | create draft、preview escaped fixture、send test to approved sink、review / publish / archive | Notification Admin / Approver | Phase 1–3 / WP-1721、2145 |
| `PRIVACY-REQUEST` `/app/compliance/privacy-requests` | requester / verification、rights type、scope、due date、holds / exceptions、export / correction / deletion workflow、audit | case ref / verified contact；type、status、owner、due / overdue、Brand | intake、verify、assign、collect scoped data、review、fulfill / deny with approved reason、close | Privacy Officer / Authorized Support | Phase 3 / WP-2146、2051 |

Guest ordering does not silently create a durable Customer Profile. Linking requires an authenticated / verified Customer action or authorized Staff process with matching evidence. Loyalty points are a ledger value, never an editable balance or Payment tender in the accepted baseline.

### 88.15 Reporting and Business Intelligence Page Registry

| Screen ID / Route | Views / Fields | Search / Filters | Actions | Access | Phase / Package |
| --- | --- | --- | --- | --- | --- |
| `RPT-OPS-DASHBOARD` `/app/reports/operations` | Sales / Order / payment / Kitchen / fulfillment KPIs、scope / time、freshness / completeness、exceptions | Store / Brand、Business Date / time、channel / order type；authorized dimensions only | change scope、drill to fact page、save view、export / schedule | Manager / Analyst | Phase 1 / WP-1900–1905、2160 |
| `RPT-REPORT-CATALOG` `/app/reports` | report name、domain、certification、owner、scope、last run、schedule / status | name / description；domain、certified、owner、scheduled | view / run、duplicate definition、create draft、archive | Analyst / Report Admin | Phase 2–3 / WP-2161 |
| `RPT-REPORT-BUILDER` `/app/reports/:id/edit` | approved Dataset / Metric、dimensions、filters、sort、visual / table、row limit、scope policy、schedule / delivery | metric / dimension registry | validate lineage / permissions、preview sampled result、save draft、certify workflow、publish / schedule | Analyst / Metric Approver | Phase 3 / WP-2161 |
| `RPT-RUN-HISTORY` `/app/reports/runs` | run ref、definition / version、scope / parameters、status、row count、freshness、duration、artifact / expiry、error | ref / report；status、date、requester、scheduled / manual | rerun same version / params、cancel、download / revoke artifact、open error | report permissions | Phase 2–3 / WP-2162 |
| `BI-METRIC-CATALOG` `/app/reports/metrics` | metric ID / name、definition、grain、owner、status / certification、version、lineage、SLO | name / ID；domain、status、owner、certified | create draft、compare、validate、submit / certify / deprecate | BI Owner / Approver | Phase 3 / WP-2163 |
| `BI-METRIC-DETAIL` `/app/reports/metrics/:id` | formula / semantic contract、dimensions、exclusions、time / currency rules、examples、lineage、quality checks、history | — | open source / dependent reports、create revision、run validation | Analyst / Auditor | Phase 3 / WP-2163 |
| `BI-DATA-QUALITY` `/app/reports/data-quality` | check、dataset、severity、status、last / first failure、affected period / scope、owner、reconciliation link | check / dataset；status、severity、domain、owner、date | acknowledge、assign、run check / backfill request、open incident | Data / Domain Owner | Phase 3 / WP-2164 |
| `BI-RECONCILIATION` `/app/reports/reconciliation` | control（Order-Payment、Payment-Settlement、PO-Receipt、Loyalty、Archive）、period、differences、status、owner | control、period、Store / Brand、status、difference | run、drill、create exception、record resolution without altering source facts | Finance / Data / Auditor | Phase 3 / WP-2164 |
| `BI-PIPELINE-RUN` `/app/reports/pipelines` | pipeline / version、run、watermark、status、late / rejected records、duration、lineage | pipeline / run；status、environment、date | retry idempotent stage、backfill request / approval、open incident | Data Operations | Phase 3 / WP-2165 |

Every KPI shows Metric Version、Business Date / timezone、currency、scope、last refreshed、completeness / late-data note and drill-down lineage. Dashboards never become alternate transaction editors.

### 88.16 Compliance、Food Safety、Traceability and Recall Page Registry

| Screen ID / Route | Views / Fields | Search / Filters | Actions | Access | Phase / Package |
| --- | --- | --- | --- | --- | --- |
| `CMP-DASHBOARD` `/app/compliance` | open cases by severity / due、expiring permits / qualifications、temperature / cleaning exceptions、allergen / recall blocks、evidence completeness | Store / scope、case type、severity、due / overdue | open owning case / record、acknowledge navigation alert | Compliance / Store Manager | Phase 2 / WP-2170 |
| `CMP-CASE-LIST` `/app/compliance/cases` | case ref、type、scope、severity、status、owner、deadline、containment / notification、open actions | ref / related object；type、status、severity、Store、owner、deadline、regulator | create、view、assign、merge / split review | Compliance roles | Phase 2 / WP-2171 |
| `CMP-CASE-DETAIL` `/app/compliance/cases/:id` | policy / requirement、related objects、findings、evidence、containment、corrective / preventive actions、verification、notifications、timeline / legal hold | — | acknowledge、contain through owning-domain command、add finding / evidence ref、create action、request / record verification、close when gates pass | Compliance / authorized operational owners | Phase 2 / WP-2171 |
| `CMP-INSPECTION` `/app/compliance/inspections` | inspection ref、authority / type、scope、scheduled / actual、inspector ref、status、findings、evidence | ref；type、Store、status、date、finding severity | schedule / record、add finding、submit / finalize immutable record、create actions | Compliance / Store Manager | Phase 2 / WP-2172 |
| `CMP-CORRECTIVE-ACTION` `/app/compliance/actions` | action、case / finding、owner、due、status、evidence、verification independence | ref；status、owner、due / overdue、severity、Store | assign、start、submit evidence、request verification、verify / reject、close | Action Owner / independent Verifier | Phase 2 / WP-2172 |
| `CMP-TEMP-LOG` `/operations/compliance/temperature` | equipment / location / food scope、reading / unit、method / source、time、range / policy version、Actor / device、excursion | scope / device；date、in / out of range、source、unverified | record manual controlled reading、acknowledge excursion、open incident / corrective action | trained Staff / Manager | Phase 2 / WP-2173 |
| `CMP-CLEANING` `/operations/compliance/cleaning` | schedule / task、area / equipment、procedure version、assignee、due / completion、verification / missed | area / task；status、due、assignee、missed | complete with evidence、report cannot-complete、verify、escalate missed | trained Staff / Manager | Phase 2 / WP-2173 |
| `CMP-QUALIFICATION` `/app/compliance/qualifications` | employee / supplier / device / permit scope、type、issuer、effective / expiry、status、evidence ref、requirement | subject / type；status、expiry window、Store、requirement | add verified record、review、suspend eligibility through owning policy、renewal task | Compliance / Access / Procurement as scoped | Phase 2–3 / WP-2174 |
| `CMP-ALLERGEN-REVIEW` `/app/compliance/allergens` | Ingredient / Recipe / Sellable path、Contains / Cross-contact / Unverified、supplier evidence、reviewer / version、publication block | Product / Ingredient / allergen；status、Store、unverified / conflicting、evidence expiry | review evidence、approve exact path、invalidate on source change、open incident | Food Safety Reviewer | Phase 1–2 / WP-1028、2027、2175 |
| `CMP-INCIDENT` `/app/compliance/incidents/:id` | severity、affected Store / Product / Order、structured exposure / safety facts、containment、contacts / notifications、evidence、root cause / CAPA | incident ref；type、severity、status、Store、date | trigger Kill Switch / quarantine via domain command、assign、notify decision record、link cases、close after verification | Food Safety / Incident roles; Restricted fields | Phase 1–2 / WP-2027、2175 |
| `TRACE-EXPLORER` `/app/compliance/traceability` | graph / timeline Supplier / PO → Receipt / Lot → Movement → Recipe / batch → Order Item → Customer / Fulfillment | lot / batch / PO / item / Order exact；date / Store | forward / backward trace、pin evidence set、export restricted case artifact、open recall | Compliance / Food Safety | Phase 3 / WP-2176 |
| `RECALL-CASE` `/app/compliance/recalls/:id` | source / notice、affected item / lots / periods、trace coverage、stock / Menu containment、customer / fulfillment scope counts、notifications、disposition、verification | — | calculate affected scope、block availability / quarantine、create tasks、approve notices、record disposition、verify closure | Recall Lead + approvers | Phase 3 / WP-2177 |
| `CMP-POLICY-LIST`、`CMP-POLICY-EDITOR` `/app/compliance/policies/...` | policy / regulatory requirement、jurisdiction、scope、version、effective period、evidence / control mapping、status | name / requirement；jurisdiction、type、status、effective / expiring | create revision、map control、review / approve / publish、retire prospectively | Compliance Admin / Counsel reviewer | Phase 2 / WP-2178 |

Compliance pages never directly rewrite Product、Recipe、Supplier、Inventory、Kitchen、Device or Order facts. Containment invokes the owning Domain Kill Switch / quarantine / availability Command and records the linked outcome. Restricted allergy / incident data is excluded from receipts、email、analytics、ordinary search and logs.

### 88.17 Device、Output and Integration Page Registry

| Screen ID / Route | Views / Fields | Search / Filters | Actions | Access | Phase / Package |
| --- | --- | --- | --- | --- | --- |
| `DEV-DEVICE-LIST` `/app/integrations/devices` | device ref / label、type、Store / station、assignment、status / health、software / profile version、last seen、open incident | label / safe serial suffix；type、Store、status、station、offline / outdated | register by approved flow、view、assign / unassign、disable、open incident | Device Admin / Store Manager | Phase 1–3 / WP-1408、1808、2180 |
| `DEV-DEVICE-DETAIL` `/app/integrations/devices/:id` | identity / ownership、assignment、capability、health timeline、configuration source、named operator / session summary、jobs / incidents、audit | — | change assignment、rotate approved credential / registration、quarantine、retire | Device Admin; secrets never displayed | Phase 1–3 / WP-1408、1808、2180 |
| `DEV-KDS-PROFILE` `/app/integrations/kds-profiles` | browser / resolution、station、wake / lock / handover、notification、network / replacement procedure、UAT status | Store / station；status、UAT due | create / assign profile、run UAT checklist、publish / revoke | Store / Device Admin | Phase 1 / WP-1808、2181 |
| `OUT-JOB-LIST` `/app/integrations/output-jobs` | job ref、purpose、target route / device、template version、state、attempts、created / due、source、error | job / Order ref；state、purpose、device、Store、date、failed / retrying | view、retry idempotently、reroute by policy、cancel pending、open incident | Operations / Device Support | Future Trigger for physical output / WP-1501–1506 |
| `OUT-TEMPLATE` `/app/integrations/output-templates` | purpose、locale、device class、version、status、sample fixture、required fields | name / purpose；locale、status、device | create draft、preview fixture、validate、approve / publish / retire | Output Admin / Approver | Future Trigger / WP-1502 |
| `INT-PROVIDER-LIST` `/app/integrations/providers` | provider / adapter、capability、environment、Store scope、status、last success / error、credential expiry metadata | provider / capability；status、environment、Store、degraded | view、enable only through accepted IDR / evidence、disable / Kill Switch、test approved sandbox | Integration Admin / Security | Phase-specific / WP-2003、2045、2182 |
| `INT-PROVIDER-DETAIL` `/app/integrations/providers/:id` | contract / version、regional capability、mapping、webhook / endpoint health、rate / quota、error / retry / DLQ summary、evidence refs | — | sandbox test、rotate secret via secret manager workflow、replay eligible Inbox Event、open incident | Integration Admin; no raw secret | Phase-specific / WP-2003、2182 |
| `INT-WEBHOOK-INBOX` `/platform/integrations/webhooks` | provider、event safe ref / type、received / processed、signature status、attempt / error、correlation | safe ref；provider、type、status、date、failed | retry processing from durable Inbox、quarantine、open incident；never alter accepted payload | Platform Support / Security | Phase 1 / WP-0032–0033、1303–1304 |
| `INT-DEAD-LETTER` `/platform/jobs/dead-letter` | job / event type、source、attempts、last error safe code、next / dead time、correlation / owner | ref；type、domain、status、date、owner | assign、retry with same idempotency、discard only by approved terminal policy、open case | Platform / Domain Support | Phase 0+ / WP-0033、0045 |
| `INT-API-CLIENT` `/app/integrations/api-clients` | client name、owner、scope / grants、environment、status、credential age metadata、last use | name；status、scope、environment、unused | request / approve、rotate / revoke credential through secure flow、view audit | Integration / Security Admin | Phase 3 / WP-2183 |

The first Pilot uses managed browser KDS and Stripe Terminal only. Generic Store Gateway、printer adapters、offline application command queues and physical legal receipt output remain disabled until IDR-0039 is revised with real evidence.

### 88.18 Platform Operations Page Registry

Platform pages are not Merchant super-admin pages. Access requires named Platform Actor、support purpose / case、recent MFA where required and full audit; Tenant impersonation and unrestricted database browsing are prohibited.

| Screen ID / Route | Views / Fields | Search / Filters | Actions | Access | Phase / Package |
| --- | --- | --- | --- | --- | --- |
| `PLT-TENANT-LIST` `/platform/tenants` | Tenant ref / display name、region、status、plan / capability metadata、Store count、health / open incident | exact Tenant ref / approved name；status、region、health | create through approved onboarding、view、suspend service with impact / approval | Platform Admin / Support split | Phase 3 / WP-2197 |
| `PLT-TENANT-DETAIL` `/platform/tenants/:id` | non-sensitive configuration、regions / environments、capabilities、Store / provider health、support cases、data / retention policy refs、audit | — | open scoped diagnostic、manage platform-level capability through approval、start export / restore workflow | purpose-bound Platform roles | Phase 3 / WP-2197 |
| `PLT-LIVE-GATE` `/platform/live-gates` | Tenant / Store、gate ID、blocking evidence category、owner、status、expiry、approval history | gate / Store / Tenant；status、category、owner、expiry | request review、approve / reject platform controls、reopen on evidence expiry | Release / Compliance roles | Phase 1 / WP-2194 |
| `PLT-SERVICE-HEALTH` `/platform/health` | service / region、SLO / error / latency / saturation、deployment、dependency、active incident | service、region、environment、severity、time | acknowledge alert、open runbook / incident、change no business state | On-call / SRE | Phase 0+ / WP-0040–0045、2065 |
| `PLT-JOB-OPERATIONS` `/platform/jobs` | job type / ref、Tenant-safe scope、state、attempt / schedule、lag、error code、worker / version | ref；type、domain、state、Tenant、age / overdue | retry / cancel only per job contract、pause consumer / Kill Switch、open incident | Platform Operations | Phase 0+ / WP-0031–0033 |
| `PLT-DEPLOYMENT` `/platform/deployments` | environment、signed digest、change set、migration compatibility、status、approvals、health / rollback | digest / change ref；environment、status、date | approve promotion、start / abort、rollback compatible release、open incident | Release Engineer / Approver | Phase 0+ / WP-2060–2066 |
| `PLT-SECURITY-FINDINGS` `/platform/security/findings` | finding、severity、asset / package、source tool、status、owner、SLA / exception expiry、evidence | ref / package；severity、status、environment、owner、expiry | assign、link remediation、risk acceptance approval / expiry、close with evidence | Security / Engineering Owner | Phase 0+ / WP-2043、2047、2054、2061 |
| `PLT-INCIDENT-LIST`、`PLT-INCIDENT-DETAIL` `/platform/incidents/...` | severity、service / Tenant impact、timeline、commander、containment、evidence / communication / regulator decision、postmortem actions | ref；severity、status、service、region、Tenant、date | declare、assign roles、record decision / timeline、contain through runbook、resolve / postmortem | Incident roles | Phase 0+ / WP-0045、2051 |
| `PLT-AUDIT-VERIFY` `/platform/audit-verification` | partition / date、sequence range、hash / signature / archive verification、gaps、status、last run、incident | partition / date；status、environment | run verifier、freeze risky export、open incident、verify after restore | Security / Auditor | Phase 0+ / WP-0042、2052 |
| `PLT-RECORDS-ARCHIVE` `/platform/records` | manifest、Business Date / fiscal range、object count / hash、retention / legal hold、restore sample、verification | manifest / Tenant / date；status、hold、verification | verify、request scoped restore / search sample、apply / release legal hold by approval | Finance / Compliance / Records | Phase 1+ / WP-2052、2055 |
| `PLT-SUPPORT-CASE` `/platform/support-cases` | case、Tenant / Store、purpose、requester verification、assigned role、access expiry、actions / evidence、status | case / Tenant / safe ref；type、status、owner、due | create / assign、grant time-bound diagnostic purpose、record action、close / revoke | Authorized Support / Approver | Phase 1+ / WP-2198 |

### 88.19 Audit、History、Notification and Cross-object Utility Screens

`AUDIT-EXPLORER`、`APPROVAL-INBOX` and `ALERT-CENTER` are standalone Merchant pages。The remaining IDs are embedded / contextual utilities whose parent Screen supplies Route、Surface、Phase and Work Package；they are not hidden standalone pages。

| Screen ID / Route mode | Mandatory views / fields | Search / Filters | Actions | Access / ownership | Phase / Package |
| --- | --- | --- | --- | --- | --- |
| `AUDIT-EXPLORER` `/app/audit` | object / Actor safe ref、action、time、correlation、reason / purpose、field-change summary、integrity / archive status | authorized exact ref；Domain / object type、Actor、action、time、correlation、integrity；no unrestricted free-text | open authorized source / linked correction、create scoped expiring Export Job、open integrity incident | Auditor / Owner / Compliance with object-specific audit + field permission | Phase 1+ / WP-0042、0046、2052 |
| `HISTORY-TIMELINE` `Embedded` | factual Event / version refs、correction links、Actor / source、timezone display with UTC source | type / date only when parent volume requires | open authorized version / correction / source；no edit | inherits parent read / history permission and masking | inherited from first consuming WP |
| `VERSION-COMPARE` `Contextual` | two allowed versions、field-level change、source / inheritance、effective impact、masked restricted fields | explicit version picker only | change comparison pair、open source；no mutation | inherits parent history permission；keyboard-accessible | inherited from first consuming WP |
| `APPROVAL-INBOX` `/app/approvals` | request / source、submitter、scope、due / escalation、diff / impact、evidence、status、Expected Version | safe source ref；Domain / type、status、Store、submitter、approver、due / overdue | claim if policy allows、open source、approve / reject with reason through owning Domain command | eligible Approver only；submitter / approver segregation and source permission | Phase 1+ / WP-0125、1807 plus owning workflow WP |
| `ALERT-CENTER` `/app/alerts` | source severity、scope、status、owner、created / SLA、safe message、related Task / incident | safe source ref；severity、status、Store、Domain、owner、time / overdue | acknowledge、assign through Task when supported、open owning workbench / incident；never resolve source directly | Merchant Actor permission-trimmed；Platform-only alerts excluded | Phase 1 / WP-0045、1800 |
| `LOOKUP-PICKER` `Embedded` | exact scope、approved display fields、eligibility / disabled reason、selected snapshot | object-specific safe search / filters and bounded result | select / clear / open when authorized；no cross-module mutation | parent permission + referenced-object read / purpose | inherited from first consuming WP |
| `IMPACT-DIALOG` `Contextual` | affected counts / refs、blocking vs warning、reason、MFA / approval、Expected Version、idempotency | none；impact Query is fixed by pending action | cancel safely or confirm exactly the parent Command | parent action permission and high-risk control | inherited from first consuming WP |

Utilities do not bypass the parent page permission or create a generic API over private Domain tables。Embedded records in the machine Screen Registry require `parent_screen_ids` / allowed family, `route_mode=embedded|contextual` and inherited Phase / package resolution。

### 88.20 Capability-to-Page Coverage Matrix

| Level 2 Capability | Primary page families | Customer / operational counterpart | Coverage status |
| --- | --- | --- | --- |
| Identity and Authentication | IAM User、Role、Session、Approval、Support Case | Customer Guest Session remains journey-bound | Complete |
| Tenant / Entity / Brand / Store | Entity、Brand、Store、Setup、Hours / Service、Capability、Live Gate | Entry Context resolves published Store only | Complete |
| Workflow / Approval / Task / Notification | Approval Inbox、Task Inbox / Detail、Alert Center、Communication / Template | safe customer status / receipt notification | Complete |
| Media / Feature Control | Media Library、Feature Flag / Store Capability | public asset allowlist / Feature-unavailable recovery | Complete |
| Catalog / Menu / Availability | Product、SKU、Category、Option、Menu、Bundle、Availability、Import | Menu、Search、Sellable Detail / Configurator | Complete |
| Pricing / Tax / Promotion | Price Book、Tax Config、Promotion / Simulation | Cart Quote、Checkout、Receipt | Complete；live tax / legal output remains external-evidence gated |
| Recipe | Recipe List / Editor / Cost / Allergen views | structured allergen disclosure / assistance | Complete |
| Cart / Checkout / Ordering | Order Queue / Detail / Amendment / Exception | Cart、Dine-in Session、Checkout、Result、Status | Complete |
| Payment / Refund / Exception | Payment List / Detail、Refund、Reconciliation、Terminal | Payment、Result、Receipt / Support | Complete |
| Dining / Table | Floor Board、Table、Session、Start | Entry / Join、Dine-in Session、multi-Batch | Complete |
| Reservation / Waitlist | Calendar、List / Detail / Wizard、Wait Board、Capacity | Customer Reservation Search / Detail / Waitlist | Complete；public routes remain Phase 3 / evidence-gated |
| Kitchen / Production | Kitchen Queue、Work Item、Exception、Production Batch | customer-safe Order status only | Complete |
| Pickup / Delivery | Pickup Queue / Handoff、Fulfillment、Dispatch / Detail / Exception | Pickup Code、Delivery Status | Complete |
| Inventory / Stock | Stock Overview、Item、Movement、Count、Adjustment、Waste、Transfer、Lot / Expiry | none | Complete |
| Procurement / Supplier | Replenishment、Supplier、Offering、Requisition、PO、Goods Receipt、Discrepancy、Performance | none | Complete |
| Customer / Loyalty / Communication | Customer、Merge、Program、Account、Points、Consent、Communication、Privacy Request | Customer Loyalty / receipt resume | Complete |
| Reporting / BI | Ops Dashboard、Report Catalog / Builder / Runs、Metric、DQ、Reconciliation、Pipeline | none | Complete |
| Compliance / Food Safety / Recall | Dashboard、Case、Inspection、Action、Temp、Cleaning、Qualification、Allergen、Incident、Trace、Recall、Policy | allergen assistance / safe support | Complete |
| Device / Output / Integration | Device、KDS Profile、Output Job / Template、Provider、Webhook、DLQ、API Client | Provider component boundary only | Complete；physical output Future Trigger remains explicitly disabled |
| Platform Operations | Tenant、Live Gate、Health、Jobs、Deployment、Security、Incident、Audit / Records、Support | none | Complete and non-Merchant |

All committed Domain capabilities now have a decided Merchant / Operations page family and, where a Customer interaction exists, a decided Customer route family. Phase / Future Trigger controls implementation order only.

#### 88.20.1 Exact Level 2 Capability Traceability

| Canonical Level 2 Capability | Screen / Surface owner |
| --- | --- |
| Identity and Authentication | `IAM-USER-DETAIL`、`IAM-SESSION-LIST`、`CUST-ACCOUNT-AUTH` |
| Tenant and Operating Entity Management | `ORG-ENTITY-LIST` / Detail、`ORG-BRAND-LIST` / Detail、`PLT-TENANT-LIST` / Detail |
| Permission and Access Control | `IAM-ROLE-LIST`、`IAM-ROLE-EDITOR`、`APPROVAL-INBOX` |
| Workflow and Approval | `APPROVAL-INBOX`、`TASK-INBOX`、object-specific Review / Publish panels |
| Audit and Data Governance | `AUDIT-EXPLORER`、`HISTORY-TIMELINE`、`VERSION-COMPARE`、`PLT-AUDIT-VERIFY`、`PLT-RECORDS-ARCHIVE` |
| Notification and Task Management | `TASK-INBOX` / Detail、`ALERT-CENTER`、`COMMS-HISTORY`、Template screens |
| Configuration Publishing and Feature Control | `STORE-CAPABILITY`、`FEATURE-FLAG-LIST`、configuration Publish panels |
| Media Management | `MEDIA-LIBRARY` |
| Catalog Management | Product、SKU、Category、Option Set、Bundle and Import / Export screens |
| Menu Management | `CAT-MENU-LIST`、`CAT-MENU-BUILDER`、`CAT-MENU-PREVIEW`、`CAT-MENU-PUBLISH` |
| Pricing and Tax Management | `PRICE-BOOK-LIST` / Editor、`TAX-CONFIG` |
| Promotion Management | `PROMO-LIST`、`PROMO-EDITOR` |
| Recipe Management | `RECIPE-LIST`、`RECIPE-EDITOR`、Allergen Review |
| Availability Management | `CAT-AVAILABILITY`、Product / SKU availability panels |
| Cart and Checkout | `CUST-CART`、`CUST-CHECKOUT`、Dine-in Session |
| Ordering | `OPS-ORDER-QUEUE`、`OPS-ORDER-DETAIL`、`OPS-ORDER-AMEND`、`OPS-ORDER-ENTRY`、Customer Order Status |
| Payment Processing | Payment List / Detail / Terminal / Reconciliation、Customer Payment / Result |
| Refund and Payment Exception Management | `PAY-REFUND-WIZARD`、`PAY-RECONCILIATION`、`OPS-ORDER-EXCEPTION` |
| Kitchen Operations | `KIT-KITCHEN-QUEUE`、`KIT-WORK-ITEM`、`KIT-EXCEPTION`、Production Batch |
| Dining and Table Operations | `DIN-FLOOR-BOARD`、`DIN-TABLE-LIST`、Dining Session / Start |
| Reservation and Waitlist | Reservation Calendar / List / Detail / Wizard、Wait Board / Entry、Customer Reservation / Waitlist |
| Store Configuration | Store List / Detail / Setup / Hours / Service / Capability / Live Gate |
| Printing and Device Operations | Device List / Detail、KDS Profile、Output Job / Template Future Trigger |
| Inventory Management | Stock Overview、Inventory Item、Movement、Lot / Expiry |
| Stock Counting and Adjustment | Count List / Workbench、Adjustment Wizard |
| Transfer and Waste Management | Transfer List / Detail、Waste Wizard |
| Procurement and Supplier Management | Replenishment、Supplier、Offering、Requisition、PO、Receipt、Discrepancy、Performance |
| Customer Profile Management | Customer List / Detail、Merge Review、Customer Profile / Privacy Request |
| Loyalty and Membership | Loyalty Program / Account / Points Review、Customer Loyalty |
| Customer Communication | Communication History / Template、Consent / Preference、Receipt / Support |
| Pickup Operations | Pickup Queue / Handoff、Pickup Code、Fulfillment Detail |
| Delivery Planning and Execution | Delivery Dispatch / Detail / Customer Status / Provider boundary |
| Fulfillment Exception Management | Delivery Exception、Order Exception、Fulfillment corrective action |
| Operational Reporting | `RPT-OPS-DASHBOARD`、operational source drill-down |
| Business Intelligence and Metric Management | Report Catalog / Builder / Runs、Metric、DQ / Reconciliation、Pipeline |
| Compliance and Food Safety | Compliance Dashboard / Case / Inspection / Action / Temp / Cleaning / Qualification / Allergen / Incident / Policy |
| Product Traceability and Recall | `TRACE-EXPLORER`、`RECALL-CASE` |

### 88.21 Action-to-Command and Permission Contract

| UI intent family | Canonical server behavior | Required guard | Result behavior |
| --- | --- | --- | --- |
| Create / Save Draft | create Aggregate / editable Version or update expected draft Version | scope permission、field validation、Idempotency / Expected Version | return stable ID + new Version；duplicate submit returns same result |
| Validate / Simulate / Preview | pure or recorded Query using explicit scenario / versions | read permission + exact scope；no hidden current-time assumption | result lists blocking / warning issues and inputs used；no publish fact |
| Submit / Approve / Reject | append workflow decision | distinct permission、policy segregation、Expected Version、reason for reject | task / workflow state changes；does not itself Publish unless contract explicitly composes an atomic approved command |
| Publish / Schedule / Activate | create immutable effective Version / state transition | publish permission、all blocking validation、approval / external gate、effective-time conflict check | emits published / scheduled fact and projection-pending status |
| Suspend / Archive / Restore | explicit lifecycle transition | impact Query、reason、dependency / active-work check、MFA / approval when high-risk | history remains；Restore target follows object rule（often Draft） |
| Claim / Assign / Acknowledge | update work ownership / acknowledgement, not source business result | task / queue scope、Expected Version、SLA policy | visible ownership / ack fact；source remains open until domain resolution |
| Operational state action | call state-specific Domain Command（Accept、Start、Ready、Handoff etc.） | source state、permission、Store、named Actor、idempotency、fresh version | Pending until source confirms；conflict refreshes canonical Query |
| Adjust / Correct / Amend | append new compensating / amendment fact | eligibility、reason、evidence、approval、impact / reprice | original fact remains; new linked record displayed everywhere |
| Refund / Write-off / Compensation | create controlled financial operation | refundable / owed balance、original method、threshold approval、recent MFA、stable compensation key | Pending / Unknown retained until Provider / accounting finality |
| Import / Export | create asynchronous Job with frozen scope / mapping / filter | object + field permissions、classification、approval threshold、expiry | progress / row results / artifact; retry idempotent; full audit |
| Kill Switch / Quarantine | invoke owning Domain containment command | severity / purpose、scope impact、recent MFA / two-person rule when required | availability / provider / asset block fact + incident / audit link |

Buttons must be omitted when the Actor lacks permission and disabled with a specific reason when permission exists but current state / policy blocks the command. A disabled button must not be the only way to learn a blocking rule; the page also displays the relevant status / validation issue.

### 88.22 Projection and Query Ownership Registry

All list、dashboard and workbench pages use named read models. Detail pages may compose only authorized summaries through Application Query contracts; they never join another Module's private tables directly.

| Projection family | Consumers | Primary sources | Scope / freshness target | Rebuild / failure behavior |
| --- | --- | --- | --- | --- |
| `organization_*_v1` | Entity、Brand、Store、Live Gate、IAM summaries | Organization / Identity / Config events + approved evidence refs | Tenant / Brand / Store；config target 5s | source replay；restricted fields masked; partial relation labeled |
| `catalog_*_v1` | Product、SKU、Category、Option、Menu、Bundle、Availability、Picker | Catalog snapshots / publish / lifecycle events + authorized feeds | Brand / effective Store context；target 5s | full source rebuild; Menu publish blocked on unresolved mandatory feed |
| `pricing_*_v1` | Price / Tax / Promotion admin、Quote preview | Price / Tax / Promotion Versions | Brand + Store / channel / time / currency；target 5s | deterministic resolution replay; conflict fails closed |
| `recipe_*_v1` | Recipe、cost、allergen review | Recipe / Ingredient Usage Versions + Inventory / Supplier evidence feeds | Brand；target 30s, allergen invalidation urgent | rebuild graph; unknown evidence blocks publish |
| `merchant_order_*_v1` | Order Queue / Detail / Exception | Order / Payment / Kitchen / Fulfillment facts via authorized projection consumers | Store + Business Date；live target 2s / accepted SLO | replay facts; stale board read-only for mutation until source check |
| `payment_*_v1` | Payment / Refund / Reconciliation | Payment Aggregate、Inbox / Provider retrieval、settlement facts | Store / Finance scope；target 5s | Provider Unknown retained; reconciliation job heals / creates exception |
| `kitchen_*_v1` | Kitchen Board / Work Item / Exception | Kitchen Tickets / Items / state events + safety cues | Store / station；target 2s | replay; no client-derived completion |
| `dining_*_v1` / `reservation_*_v1` | Floor、Session、Calendar、Waitlist | Table / Dining / Reservation / Waitlist facts + Order summary | Store / service date；target 2s operational / 5s planning | duplicate seat / session invariant checked from source |
| `fulfillment_*_v1` | Pickup / Delivery / Fulfillment | Fulfillment / Delivery / Handoff facts + safe Order summary | Store / route scope；target 2s | proof restricted; rebuild excludes secret material |
| `inventory_*_v1` | Stock、Item、Movement、Count、Lot / Expiry、Replenishment | Inventory Item + immutable Ledger / reservations / receipts | one explicit Stock Scope；target 5s | full ledger replay / reconciliation; negative / gap alerts |
| `procurement_*_v1` | Supplier、Offering、Requisition、PO、Discrepancy、Performance | Procurement facts + Goods Receipt feed | Brand + Buyer Entity / Store；target 30s | receiving quantity rebuilt only from Inventory events |
| `customer_loyalty_*_v1` | Customer、Program、Account、Points、Consent | Profile / Program / Points ledger / consent facts + authorized transaction refs | Brand + purpose；target 30s | PII masked / excluded by purpose; balance ledger replay |
| `reporting_*_v1` / warehouse | dashboards、reports、metrics、DQ / reconciliation | operational projections / canonical analytical facts | permission scope + Business Date / currency；freshness displayed | batch / late-data / backfill tracked; dashboard never hides incompleteness |
| `compliance_*_v1` | cases、actions、logs、trace / recall | Compliance facts + immutable authorized evidence feeds | Tenant / Brand / Store / case purpose；urgent block target 2s | evidence remains referenced / classified; source facts not overwritten |
| `device_integration_*_v1` | Device、Provider、Jobs / DLQ | device health、adapter Inbox / Job / output facts | environment + Tenant / Store；health target per SLO | missing heartbeat = Unknown / Offline, never assumed healthy |
| `platform_*_v1` | Platform Operations | deployment / observability / security / audit / records facts | environment / region / purpose | independent source and audit; Tenant data field-minimized |

Every projection response includes `projectionVersion`、`asOfUtc`、scope、partial / stale indicator and canonical source reference where drill-down is permitted. Queue / board Mutation always revalidates source state and Expected Version.

### 88.23 Search、Filter、Sort and Export Closure

* Text search is object-specific：stable code / public reference exact or prefix、localized normalized name tokens、approved external reference. It is never a generic database `ILIKE` over every column.
* Email、phone、address、provider reference、supplier contact、customer contact and case evidence are exact / normalized only with explicit purpose permission; they do not appear in suggestions or global search.
* Default date semantics：transactions use Store Business Date plus exact UTC range; configuration uses effective period; audit uses occurrence UTC rendered in selected timezone.
* Default sort：operational boards by urgency / promised time + stable tie-breaker；master data by name / code；transactions newest first；compliance by severity / due；all include stable ID tie-breaker.
* Cursor pagination is default for large / mutable lists. Offset pagination is allowed only for small immutable registries and must not create duplicate / missing rows under concurrent updates.
* Filter URLs include only non-sensitive stable values. Saved Views store permission-trimmed filters and are revalidated on every load.
* Export freezes Query / filter / scope / columns / requester / permission decision / projection version、runs asynchronously for large data、uses expiring encrypted artifact and records download / revocation. A later permission loss blocks download.

### 88.24 Page State and Error Mapping

| Condition | Required UI | Prohibited behavior |
| --- | --- | --- |
| `401 / Session expired` | preserve only safe route intent、show sign-in / resume path、clear in-memory sensitive state | storing credential / form secrets in Web Storage or retry loop |
| `403` | permission-lost state and safe navigation | revealing object existence / fields through error detail |
| authorized `404` | not-found / unavailable within current scope | cross-Store / Tenant suggestion |
| `409 / Expected Version` | show source changed、refresh diff / recover compatible draft input | silent last-write-wins |
| `422` | field / rule-specific validation summary + inline association | generic toast only or client-only override |
| `429` | retry-after / progressive delay、preserve idempotency | generating a new logical operation automatically |
| Provider timeout / unknown | Pending / Unknown + background authoritative reconciliation | “Failed” or “Succeeded” guess |
| Projection stale / disconnected | stale timestamp、reconnecting、read-only where action safety requires、manual continuity | moving cards / completing facts locally |
| Partial cross-module summary | label missing source / freshness and keep primary object usable when safe | displaying zero / none as if authoritative |
| Feature disabled / future-trigger | explain unavailable capability to authorized Admin; hide normal nav | empty broken page or silent activation |

All errors use public / staff-safe Error Contracts with correlation reference. Raw stack、SQL、Provider payload、Token、PII or secret never enters the page.

### 88.25 Future Capability Work-package Registry

Existing Phase 0 / 1 Work Packages remain authoritative for the first executable loop. The following packages prevent later pages from becoming “design later” gaps. They enter execution only when their Roadmap Phase / Feature is committed; listing them here is design completion, not coding authorization.

Commerce expansion：

* `WP-2100` Bundle List / Editor、configuration simulation、publish and Menu integration
* `WP-2101` Availability Rule Workbench、effective-result simulation and Store / channel schedule
* `WP-2102` Price Book / Record Admin、coverage / conflict resolution and publish workflow
* `WP-2103` Tax Configuration Admin、approved fixture simulation and receipt preview
* `WP-2104` Promotion List / Editor、stacking / budget / basket simulation and approval
* `WP-2105` Recipe List / Editor、yield / cost / allergen graph、dual review and invalidation

Ordering / Dining expansion：

* `WP-2110` Order Amendment impact / repricing / approval workflow
* `WP-2111` Production Batch planning、yield / consumption and quality exception
* `WP-2112` Table Configuration、Floor Board、Dining Session start / move / closing
* `WP-2113` Reservation Calendar / List / Detail / Create / Revision / Deposit collaboration
* `WP-2114` Waitlist Board / Entry、ETA、Ready notification and Dining handoff
* `WP-2115` Reservation Capacity / closure / overbook / no-show policy configuration
* `WP-2116` Staff Counter / Table-side Order Entry、shared Cart / Quote / Allergen / Terminal contract and channel audit

Inventory expansion：

* `WP-2120` Inventory Item + Stock Overview and scoped quantity projection
* `WP-2121` Immutable Stock Movement Explorer / Detail / compensating correction
* `WP-2122` Count List / blind-count Workbench / variance approval / posting
* `WP-2123` Stock Adjustment Wizard and high-risk approval
* `WP-2124` Waste Record Wizard and Food Safety linkage
* `WP-2125` Transfer List / Detail、dispatch / receipt / discrepancy
* `WP-2126` Lot / Expiry / Hold Explorer and trace handoff

Procurement expansion：

* `WP-2130` Replenishment Need Workbench and Requisition draft handoff
* `WP-2131` Supplier List / Detail / qualification / lifecycle
* `WP-2132` Supplier Offering / Price version、unit conversion and approval
* `WP-2133` Requisition List / Detail、approval and PO allocation
* `WP-2134` Purchase Order List / Editor / Detail、issue / revision / acknowledgement
* `WP-2135` PO-linked Goods Receipt and immutable Inventory collaboration
* `WP-2136` Receiving / Supplier Discrepancy Workbench and resolution
* `WP-2137` Supplier Performance Projection / drill-down

Customer / Loyalty expansion：

* `WP-2140` Customer List / Detail、verified contacts and Guest-transaction link
* `WP-2141` Customer duplicate / merge evidence review
* `WP-2142` Loyalty Program Editor、version、tier / reward / expiry simulation and publish
* `WP-2143` Loyalty Account / Points Ledger / reservation / correction exception
* `WP-2144` Consent and Contact Preference evidence
* `WP-2145` Communication History / Template governance beyond Phase 1 receipt email
* `WP-2146` Privacy Rights Request intake、verification、fulfillment and closure

Delivery expansion：

* `WP-2150` Delivery Task queue / dispatch and assignment
* `WP-2151` Delivery Detail、address / promise snapshot and controlled revision
* `WP-2152` Courier / Provider adapter status and acceptance boundary
* `WP-2153` Delivery handoff / proof and Customer-safe tracking projection
* `WP-2154` Delivery Exception Workbench / reroute / cancellation / support
* `WP-2155` Delivery E2E、privacy、late / duplicate / Provider failure acceptance

Reporting / BI expansion：

* `WP-2160` Operational Dashboard scope / freshness / drill-down
* `WP-2161` Report Catalog / Builder / certification / scheduling
* `WP-2162` Report Run / artifact / expiry / rerun management
* `WP-2163` Metric Definition / Version / Lineage / Certification
* `WP-2164` Data Quality and cross-domain Reconciliation Workbench
* `WP-2165` Pipeline Run / watermark / late data / backfill approval

Compliance expansion：

* `WP-2170` Compliance Dashboard / due / severity / evidence coverage
* `WP-2171` Compliance Case List / Detail / containment / notification
* `WP-2172` Inspection / Finding / Corrective Action / independent Verification
* `WP-2173` Temperature / Excursion and Cleaning / Sanitation operational logs
* `WP-2174` Permit、employee / supplier / device Qualification and expiry
* `WP-2175` Allergen Review / Food Safety Incident / publish and payment block linkage
* `WP-2176` forward / backward Traceability Explorer and restricted evidence export
* `WP-2177` Recall Case、scope calculation、containment、notice and disposition
* `WP-2178` Compliance Policy / Regulatory Requirement version and control mapping

Device / Integration expansion：

* `WP-2180` Device List / Detail / health / assignment / lifecycle
* `WP-2181` Managed KDS Profile and Store UAT expansion
* `WP-2182` Provider Adapter Admin、webhook / retry / Kill Switch evidence
* `WP-2183` API Client / scope / credential lifecycle and Audit

Organization / Platform / shared services：

* `WP-2190` Operating Entity / Business Function / authority management
* `WP-2191` Brand configuration / Store membership / inheritance
* `WP-2192` Store List / Detail / Setup / Hours / Service configuration
* `WP-2193` Capability / Feature Flag dependency / effective-period admin
* `WP-2194` Store / Platform Live Gate evidence workflow
* `WP-2195` Role Editor / Compare / approval beyond minimum navigation
* `WP-2196` Export Job / artifact / expiry / revocation center
* `WP-2197` Platform Tenant / region / lifecycle operations
* `WP-2198` Purpose-bound Support Case and diagnostic access workflow

Every `WP-21xx` must inherit Sections 44–58 Definition of Ready / Done and add its Section 88 rows as Acceptance Criteria. A package is not `Ready` unless its required Projection、Command family、Permission、responsive states、accessibility scenarios and cross-domain feed contracts are named in its file-level specification.

### 88.26 Navigation and Cross-page Journey Closure

Canonical Merchant navigation：

* `Home` → Overview、Task Inbox、Approval Inbox、Alert Center
* `Operations` → Order Entry、Orders、Dining、Reservations、Waitlist、Kitchen、Pickup、Delivery、Payment Exceptions
* `Commerce` → Products、SKUs、Categories、Option Sets、Menus、Bundles、Availability、Pricing / Tax、Promotions、Recipes、Imports
* `Supply` → Stock、Items、Movements、Counts、Adjustments / Waste、Transfers、Lots、Replenishment、Suppliers、Offerings、Requisitions、Purchase Orders、Receiving
* `Customers` → Customers、Loyalty Programs / Accounts、Communications、Consent；Privacy Request also appears under Compliance for authorized roles
* `Reports` → Operational Dashboard、Report Catalog / Runs、Metrics、Data Quality / Reconciliation、Pipeline Operations
* `Compliance` → Dashboard、Cases、Inspections / Actions、Temperature、Cleaning、Qualifications、Allergen、Incidents、Traceability、Recall、Policies、Privacy Requests
* `Organization` → Entities、Brands、Stores、Users、Roles、Sessions、Live Gates、Features、Media、Audit Explorer
* `Integrations` → Devices、KDS Profiles、Providers、Output future-trigger、API Clients

Canonical cross-page journeys：

1. Product Draft → SKU / Option / Recipe / Price / Availability references → Menu placement → Validate → Preview exact Store scenario → Approve / Publish → Customer Menu.
2. Customer Context → Menu → Configurator / Allergen Assistance → Cart / Quote → Checkout / capacity → Payment → Order → Kitchen → Pickup / Delivery → Receipt / Support.
3. Staff Counter / Table-side Entry → fixed Store / Dining context → shared Menu / Configurator → staff Cart / Quote → Allergen review when required → Terminal → one Order / Batch with named Actor / channel.
4. Staff starts Dining Session → Customer joins → multiple Batches → Kitchen → payments / balance → Session Closing → unpaid exception if needed → authorized final close.
5. Reservation / Waitlist → capacity / notification → Check-in / Ready → Dining Session created once → source becomes Seated only from Dining event.
6. Reorder need → Requisition → Approval → PO → Issue → Inventory Goods Receipt → Ledger → PO fulfillment projection → discrepancy / supplier performance.
7. Supplier / Lot / Recipe / Production / Order trace → Incident / Recall → Domain containment → customer / regulator decision → Corrective Action → independent Verification.
8. Customer transaction → Loyalty earn / reservation / redeem → refund reversal → Points Ledger reconciliation; no balance edit.
9. Metric / Report definition → certified version → scoped run → freshness / quality → drill to authorized source projection → export artifact / expiry.

Every source Detail page must link to authorized related facts using stable references；related screens must preserve the originating scope / case where safe, and must not pass secrets or sensitive free text in URLs.

### 88.27 Canonical Page-family Composition

These compositions are the approved low-fidelity layout for every page row; a future visual file may refine spacing / imagery but cannot remove required regions or change commands.

| Family | Desktop / tablet composition | Mobile composition | Used by |
| --- | --- | --- | --- |
| Master List | scope / title + primary action；search / filter / saved view；summary chips；data grid；bulk bar；async job status | header + search；filter sheet；priority cards / safe horizontal table；sticky primary action when appropriate | Product、SKU、Item、Supplier、Customer、User、Device、Payment |
| Master Detail | identity / lifecycle header；summary rail；tabs（Overview、Configuration、Related、History、Audit）；context action rail | stacked summary；tab selector / sections；bottom action sheet | Product、Store、Order、Payment、Supplier、Customer、Device、Case |
| Create / Edit | breadcrumb / draft banner；section nav；form canvas；validation / impact rail；save / validate / submit footer | one section at a time；progress；inline validation；persistent safe Save | master data、Store setup、Price / Promotion / Recipe editors |
| Configuration Builder | tree / source palette；central editor；effective-result / validation rail；preview / diff | sequential tree → edit → preview steps with preserved draft | Menu、Option Set、Role、Loyalty、Report、Compliance Policy |
| Transaction Explorer | immutable summary grid；timeline / evidence / related tabs；corrective actions only | summary cards；filters sheet；detail timeline | Movement、Order、Payment、PO、Fulfillment、Communication |
| Live Workbench | fixed scope / live status；lane / grid board；detail drawer / full-screen ticket；SLA / alert rail | full-screen prioritized queue；large touch actions；detail replaces list with safe back | Order、Kitchen、Dining、Waitlist、Pickup、Delivery、Count |
| Exception / Case | queue + severity / SLA；case workspace；timeline / evidence；assignment / resolution rail | queue cards；case sections；action sheet with reason / approval | Order / Payment / Kitchen / Delivery exceptions、Compliance、DQ |
| Dashboard / Monitoring | scope / time / freshness bar；KPI row；charts / tables；alert / lineage rail | KPI stack；one chart / table per section；filters sheet | Home、Ops Reports、Compliance、Supplier Performance、Platform Health |
| Wizard | stepper；current form；context / validation rail；Back / Save / Continue / Commit | single step screen；resume state；review before final commit | Store Setup、Checkout、Refund、Reservation、Count、Receiving、Import |
| Customer Journey | brand header；content / product canvas；sticky Cart / next step；support / accessibility | mobile-first single column；bottom Cart / primary action；native-feeling sheets | Menu、Configurator、Cart、Checkout、Status、Receipt、Loyalty |

Route normalization：Section 88 canonical Merchant routes use `/app/{navigation-group}/...`; older `/catalog/...` or similar entries in Sections 60–72 are preserved as historical Route Intent only. Early umbrella IDs are normalized before implementation：`ORD-ORDER-LIST` → `OPS-ORDER-QUEUE`，`KIT-KITCHEN-BOARD` → `KIT-KITCHEN-QUEUE`，`STORE-PROFILE` → `STORE-DETAIL` + `STORE-SETUP`。Because no business code exists, no redirect / backward-compatibility obligation is created. Operations and Customer routes retain their dedicated namespaces.

### 88.28 Page-level Analytics、Accessibility and Privacy Contract

Allowed product analytics are event names with screen / action / outcome、coarse capability / device class、latency and non-sensitive error code. They exclude Product description、Cart content、barcode、free-text reason、contact、address、allergy / health fact、Payment / Provider identifier、proof、Token and unrestricted object ID.

Minimum event families：`screen_viewed`、`search_executed`（no raw sensitive term）、`filter_applied`（safe key only）、`command_started`、`command_succeeded`、`command_failed`、`validation_blocked`、`projection_stale`、`reconnect_started / recovered`、`wizard_abandoned`（step only）。Analytics loss never changes a business outcome.

Every page package must prove：

* semantic headings / landmarks、unique title、skip navigation、logical focus / reading order
* labels、descriptions、error association、summary focus after submit、live region only for meaningful updates
* complete keyboard alternative for drag / reorder / board action、no keyboard trap、modal focus restore
* non-color status / severity、contrast、text resize / reflow、reduced motion、touch target
* tables expose headers / sort state；virtualized grids preserve accessible row / cell context or provide an accessible alternative
* timers / expiry warn and allow extension only when business / security policy permits；security expiry is not silently extended
* KDS / operations sound is optional reinforcement with visual / textual cue and user / Store policy
* localized string expansion、date / time / number / currency formatting and `en-CA` baseline；no hard-coded concatenated legal copy
* field classification controls HTML autocomplete、clipboard / reveal behavior、logging、analytics、export and cache policy

### 88.29 Minimum Acceptance Journey Matrix

| Journey | Required proof before owning package is Done |
| --- | --- |
| Scope / permission | switch Brand / Store without stale selection；deep-link denial does not leak object；permission revoked while open closes action path；field masking consistent in screen / export / audit |
| Configuration publish | Draft survives navigation；concurrency conflict produces diff；invalid dependency blocks；approval segregation works；scheduled effective result matches preview exact scenario；rollback creates new version |
| Menu / Sellable | Store / channel / locale / time resolution deterministic；unpriced / unavailable / allergen-unverified path blocked；keyboard Menu Builder works；Customer sees pinned effective snapshot |
| Cart / Checkout | duplicated Add / Submit returns one logical outcome；price / capacity / item change forces explicit reconfirmation；allergen block cannot be bypassed；offline never replays mutation |
| Staff Order Entry | fixed Store / named Actor / channel；same Menu / Quote result as equivalent Customer path；no arbitrary price / tax / state；allergen and Terminal gates cannot be bypassed；duplicate submit returns one Order / Batch |
| Payment | duplicate callback / webhook / confirm yields one Payment / Order；Pending / Unknown accurate；Terminal Interac no separate capture；non-Interac watchdog；late success creates compensation / refund / exception |
| Dining | copied static Table QR rejected；Staff start and short-lived join valid；Guest Session survives multiple Batches；Closing locks add；unpaid Batch creates visible task；only invariant-satisfied close |
| Kitchen / Pickup | source-confirmed card transitions；stale / reconnect requery；item-level completion；allergen acknowledgement; proof bound to explicit Fulfillment；duplicate Handoff one fact |
| Reservation / Waitlist | capacity race one winner；hold expiry safe；revision preserves original if new slot fails；notification failure no state rollback；Dining creates one Session and is sole `Seated` source |
| Inventory | one Stock Scope；concurrent movement / count deterministic；unit / lot / expiry validation；adjustment / waste compensation not edit；transfer partial dispatch / receipt / discrepancy retained |
| Procurement | Requisition approval not PO Issue；Offering / Price snapshot pinned；post-Issue Revision; partial receipt from Inventory events；over / short tolerance creates proper task；no direct received override |
| Customer / Loyalty | Guest does not auto-profile；verified link only；consent purposes independent；points earn idempotent；reservation prevents double redeem；refund reverses through ledger; merge preserves evidence |
| Delivery | assignment race、Provider timeout / duplicate、address cutoff、proof privacy、late / failed handoff、reroute / cancellation and Customer-safe status |
| Reporting | timezone / Business Date / currency / Metric Version visible；late data / incompleteness visible；permission-trimmed drill / export；rebuild / backfill reconciles counts |
| Compliance / Recall | evidence classification、deadline escalation、independent verification、containment through owner Domain、forward / backward trace、restricted notification、closure blocked until verification |
| Device / Platform | named KDS handover / lock、device offline、Provider Kill Switch、DLQ idempotent retry、deployment drain / rollback、audit verifier / restore、support purpose expiry |
| Responsive / accessibility | 320px–1440px、200% zoom / reflow、keyboard / screen reader、reduced motion、non-color cues、long localization、touch operations and interrupted wizard |

### 88.30 Screen Definition of Ready and Done

A Screen Work Package is `Ready` only when its row has：

1. canonical Screen ID、Surface、Phase and either canonical Route or explicit `Embedded` / `Contextual` placement with parent Screen / family
2. owning Capability / Domain and object / workflow
3. Persona / permission / scope / field classification
4. mandatory views / fields and Field Registry references
5. Search / Filter / Sort / pagination / export behavior
6. Query / Projection name、freshness、partial / rebuild behavior
7. Actions mapped to Commands、guards、idempotency、audit and outcome
8. all normal / empty / error / stale / offline / conflict states
9. navigation / related-page / deep-link behavior
10. responsive / accessibility / localization behavior
11. analytics / privacy exclusions
12. acceptance journeys and test fixtures

It is `Done` only after later implementation supplies contract tests、permission tests、visual / accessibility regression、responsive evidence、E2E / failure injection、observability and updated generated API / event artifacts. Section 88 completes `Ready` at product-design level; it does not claim implementation evidence.

### 88.31 Page Registry Completeness Audit

| Audit dimension | Result | Evidence |
| --- | --- | --- |
| Customer ordering pages | PASS | Section 88.6 including future account / reservation channel |
| Merchant master / configuration pages | PASS | Sections 88.7–88.9 |
| Live operational pages | PASS | Sections 88.10–88.12 |
| Inventory / procurement pages | PASS | Sections 88.12–88.13 |
| Customer / loyalty / communication pages | PASS | Section 88.14 |
| Reporting / BI pages | PASS | Section 88.15 |
| Compliance / food safety / recall pages | PASS | Section 88.16 |
| Device / Integration / Platform pages | PASS | Sections 88.17–88.19 |
| Fields / views | PASS at pre-code contract level | per-screen mandatory groups + Sections 68、70–72、88.9、88.13 |
| Search / filter / sort / export | PASS | per-screen rows + Section 88.23 |
| Actions / Command / permission | PASS | per-screen rows + Section 88.21 |
| Projection / freshness / rebuild | PASS | Section 88.22 |
| State / error / responsive / accessibility | PASS | Sections 88.4、88.24、88.27–88.30 |
| Navigation / journey | PASS | Sections 88.3、88.26 |
| Work Package ownership | PASS | existing packages + Section 88.25 future package registry |
| Phase / optional restaurant profile | PASS | Sections 88.1–88.2 |

No page family remains marked “decide during coding.” File-local implementation details may choose component composition、query-hook names、CSS arrangement and test-file placement only when they preserve this contract.

### 88.32 Final Pre-code Page / Function Closure

Status：`Accepted and Closed`。

Final interpretation：

* 页面种类、页面功能、字段组、Search / Filter / Sort、Actions、Permission、States、Navigation、Responsive、Accessibility、Projection 和 Work Package ownership 已在写代码前完成。
* 不同餐饮业态 / 规模通过 Capability Profile 与配置组合适配；同一事实不分叉成行业专用数据模型。
* Phase / Future Trigger 只决定何时实现，不再决定“到时候再想页面是什么”。
* External Evidence、Provider availability、legal / tax copy、真实设备 / Store facts 继续按 Sections 80、86–87 Gate 获取；本 Section 不伪造这些证据。
* Coding remains unauthorized until the user explicitly starts an implementation Work Package.

## 89. Repository Agent Guidance、WSL2 Baseline and Final Conflict Audit（Accepted）

### 89.1 Reverse-audit Result and Scope

本节完成 Section 88 对 Sections 0–87、Roadmap、Capability / Object / Field / Projection Registries、Work Package、Route、Permission、Phase、Provider 与 Pilot Profile 的第二次反向交叉校验。审计只判断 pre-code specification 是否闭合；External Evidence、Future Trigger、Provider / legal / tax 专业验证与尚未执行的 test evidence 不计为缺陷。

确认并已直接修复的真实缺陷：

1. Café / QSR Profile 声明 Counter Ordering，但 Section 88 原先只有 Customer Checkout 和 Staff Order Queue，没有 Staff 创建订单的页面。已补 `OPS-ORDER-ENTRY`、`ordering.order.create_staff`、`WP-2116`、Navigation 与 Acceptance Journey，并强制复用同一 Menu / Cart / Quote / Allergen / Payment / Order truth model。
2. WP-0001 原 Windows-native / PowerShell bootstrap 与 Linux production container、Linux GitHub Actions、Docker / PostgreSQL、case-sensitive paths 和 Codex Linux sandbox 不一致。已由 WSL2 + Linux filesystem + Bash / Linux toolchain baseline 取代。
3. 交接包包含大量 durable rules，却未定义 Repository Agent 如何在新会话稳定加载这些规则。已将 root `AGENTS.md`、compact spec index、per-WP executable brief、nested guidance trigger 与 verification 纳入 WP-0001。
4. Shared Audit / Approval / Alert and contextual utility Screen IDs lacked exact standalone-vs-embedded placement；legacy Inventory auxiliary IDs also risked creating duplicate routes。已锁定三条 standalone Route、四类 inherited utility placement 和 Inventory `alias_of` / parent mapping。

确认的优化项：

* Section 88 保持 human-readable authority；新增 machine-checkable Screen Registry 设计，防止 ID、Route、Permission、Projection 与 WP mapping 漂移。
* 将完整 Library Handoff Package 与 Coding Agent 的日常上下文分离；Repository 只保存可审计 index 和当前 WP brief，避免把约 1 MB 文档复制进 `AGENTS.md` 或每次 prompt。
* 建立 intentional non-scope / Future Trigger register，避免以后把明确禁用能力误报为“漏页”。
* 将 Windows host、WSL distribution、Repository filesystem、Agent runtime、terminal 和 Docker integration 分开定义，消除“Windows 上开发”究竟指哪一层的歧义。

除以上四项外，没有发现需要新增用户选择的页面 / 功能缺口或互相矛盾的 accepted business decision。所有未实现状态仍是 Execution / Evidence 状态，不重新打开已确认内容。

### 89.2 Intentional Non-scope and Future-trigger Register

下列能力在当前 accepted Pilot / Roadmap 中明确禁用或不属于 BOP-RMS core scope，因此没有页面不构成遗漏。任何一项被业务 Owner 启用前，必须先创建 ADR / IDR、Capability、Domain ownership、Object / lifecycle、Permission、Screen Registry rows、Work Package、migration / privacy / security / accounting controls 和验收证据；不得直接加一个 UI 绕过建模。

| Capability | Current treatment | Trigger to reopen |
| --- | --- | --- |
| Cash、cash drawer、cash count / till reconciliation | Disabled；Pilot is cashless | selected Store accepts cash and finance / theft / offline controls are approved |
| Gift Card、stored value、house account、wallet、BNPL、loyalty as tender | Disabled；Loyalty points are not Payment tender | legal / accounting / unclaimed-property / refund / expiry design approved |
| Split tender / multi-method settlement | Not in accepted Pilot flow | concrete Store / Provider need plus allocation / refund / reconciliation contract |
| Alcohol、tobacco、cannabis or other age-restricted goods | Disabled | licensed market profile、age verification、delivery / handoff and audit controls approved |
| Workforce scheduling、time clock、payroll、tips distribution | External workforce / payroll system boundary | BOP-RMS is explicitly selected as System of Record |
| General ledger、AP / AR、banking、tax filing | Export / integration boundary, not accounting suite | finance architecture expands BOP-RMS ownership |
| Catering、banquet、event contracts / deposits | Not committed | catering business profile and long-lived quote / contract lifecycle accepted |
| Franchise royalty、territory / franchisee settlement | Not committed | franchise operating model accepted |
| Fleet route optimization / driver workforce management | Delivery Provider / later integration boundary | owned-fleet model accepted |
| Physical printer / cash drawer / label gateway and offline command queue | Output is explicit Future Trigger；KDS remains browser-first | approved device inventory and continuity / retry design |
| AI autonomous pricing、purchasing、staffing or compliance decisions | Prohibited in baseline | human-accountability、explainability、data and safety review accepted |

External Evidence such as real Store address、permit、corporation、tax treatment、Provider account / contract、device inventory、network measurement、professional approval and test result remains a Gate rather than a missing page or design defect。

### 89.3 Repository Specification Delivery Contract

Section 88 is the human-readable authority for page / function design。Repository implementation uses the following compact, traceable artifacts after coding is authorized：

| Artifact | Creation owner / timing | Contract |
| --- | --- | --- |
| `AGENTS.md` | WP-0001 | concise durable agent rules；target ≤ 8 KiB and always below the configured combined project-doc budget |
| `docs/spec/README.md` | WP-0001 | authoritative Library filename、document version / closed node、decision precedence、current WP link and refresh procedure；no credential / signed URL |
| `docs/spec/work-packages/WP-xxxx.md` | before each WP becomes Ready | task-local scope、inputs、accepted decisions、files、commands、acceptance、evidence、exclusions and unresolved External Evidence only |
| `docs/product/screen-registry.yaml` | WP-0004 / first UI-foundation WP, before page implementation | machine-checkable mirror of Section 88；generated or reviewed from the accepted registry, never an independent business authority |
| `docs/product/screen-registry.schema.json` | same package | validates required fields、enumerations and reference form |

Every Screen Registry record must include：`screen_id`、aliases / superseded IDs、`kind=page|embedded|contextual|alias`、surface、`route_mode`、canonical route or `parent_screen_ids` / allowed family、Level 1 / 2 navigation when standalone、Capability、owning Domain、object / workflow、phase / feature flag（resolved or inherited）、roles / permission、scope、mandatory field groups、search / filter / sort / export profile、Query / Projection / freshness、Commands / idempotency、states、responsive / accessibility profile、analytics / privacy exclusions、owning Work Package（resolved or inherited）and Handoff Section reference。

CI validation must reject duplicate Screen ID、duplicate standalone canonical Route、alias cycle、embedded / contextual record without a valid parent / family、unknown Permission / Projection / Work Package reference、broken navigation target、missing resolved Phase / Feature Gate、Merchant / Platform surface collision and a Screen whose required action lacks a Command / permission mapping。The YAML mirror may make formatting and implementation identifiers more precise but may not change Section 88 semantics；a semantic change requires the normal ADR / Handoff revision path first。

The Repository must not copy the complete Handoff Package into Git by default。`docs/spec/README.md` and the current WP brief are the bounded execution context；the full Library file remains the durable design authority。A WP handoff records the exact source document version used so stale briefs are detectable。

### 89.4 Root `AGENTS.md` Decision and Exact Baseline

Decision：`AGENTS.md` is required at Repository root when WP-0001 creates the actual Git Repository；it is not created in the current Library / scratch directory because that directory is not the application Repository。A root file is sufficient initially。Nested guidance is created only after the corresponding directory exists and has rules that genuinely differ from root：

* `apps/api/AGENTS.md` — transport boundary、authentication context、error / idempotency / OpenAPI verification
* `apps/worker/AGENTS.md` — Inbox / Outbox、retry、lease、idempotency、poison / DLQ and replay verification
* `apps/customer-pwa/AGENTS.md` — Guest Session、accessibility、offline read-only boundary、privacy / analytics exclusions
* `apps/merchant-web/AGENTS.md` — permission / scope switching、Section 88 Screen IDs、stale / conflict / responsive evidence
* `packages/contracts/AGENTS.md` — schema compatibility、generation、no Provider leakage and consumer tests
* `packages/database/AGENTS.md`（or the final accepted database package path）— migration immutability、RLS、tenant context、rollback / restore evidence
* `infra/AGENTS.md` — environment isolation、least privilege、OIDC、plan / diff / rollback and no long-lived credential

Closer guidance may add local constraints and overrides root only where explicitly stated；it may not weaken security、privacy、tenant isolation、money / time invariants or required verification。Committed `AGENTS.override.md` is prohibited unless a reviewed, time-bounded exception explains why ordinary nested guidance is insufficient；personal / temporary override is not team policy。Combined root-to-working-directory guidance must remain under the configured Codex `project_doc_max_bytes` budget（default 32 KiB unless execution evidence proves a different value）。

WP-0001 must materialize the following root baseline, replacing placeholders only with facts that exist in the Repository：

```markdown
# BOP-RMS Agent Guide

## Scope and authority
- Work only inside the assigned Work Package. Do not expand scope, reopen accepted decisions, or write unrelated business code.
- Read `docs/spec/README.md` and the current `docs/spec/work-packages/WP-xxxx.md` before editing.
- Decision precedence is the Handoff Package rule referenced by the spec index. Higher accepted Sections supersede conflicting older text.
- External Evidence and Future Triggers are gates, not defects. Never invent credentials, accounts, legal facts, Provider results, Store facts, test evidence, or approvals.

## Environment
- On Windows, run the agent and all repository tools in WSL2. Keep the checkout and worktrees in the WSL Linux filesystem, normally `~/src/bop-rms`; do not use `/mnt/c`, OneDrive, or a mixed Windows/Linux toolchain for this repository.
- Use the exact Node and pnpm pins in `.nvmrc` and `package.json`; use pnpm only and keep the lockfile frozen in CI.
- Repository text uses LF and case-sensitive path semantics. Never create files that differ only by case.

## Architecture invariants
- Each fact has one owning Domain. Cross-domain access uses public contracts, Commands, Events, or approved Projections; never query another Domain's private tables.
- Keep Tenant, Brand, Store, Actor, purpose, permission, expected version, idempotency, audit, and data classification explicit where the contract requires them.
- Money never uses binary floating point. Store UTC instants internally and resolve IANA time zone plus Business Date explicitly.
- Transaction, ledger, audit, event, and evidence history is append-only; correct through an approved compensating operation.
- Never place secrets, tokens, unrestricted object IDs, payment data, allergy/health facts, or unnecessary PII in logs, URLs, analytics, fixtures, screenshots, or error payloads.
- Section 88 Screen IDs, routes, permissions, states, responsive/accessibility rules, and Projection ownership are canonical for UI work.

## Change discipline
- Inspect repository status first and preserve unrelated user changes.
- One branch/worktree and one WP at a time. Avoid unrelated refactors, dependency upgrades, generated churn, or speculative abstractions.
- Add or update tests with behavior. Do not bypass type, lint, architecture, contract, migration, permission, accessibility, or security checks.
- Use only commands and scripts that exist in the current repository. If a required command is missing, treat that as a WP defect instead of inventing a successful result.

## Verification and handoff
- Run the current WP's required commands from the repository root unless the WP says otherwise. At minimum, use frozen install plus every existing affected format, lint, typecheck, test, integration, architecture, contract, migration, build, and security check.
- Review the final diff for scope, generated files, migrations, secrets, PII, permissions, tenant/store filters, error states, and documentation drift.
- Done means every acceptance criterion has evidence. Report skipped or blocked checks exactly; never claim an unrun check passed.
- Do not commit, push, merge, deploy, rotate credentials, alter external services, or perform destructive data/Git operations unless the assigned task explicitly authorizes that action.
```

The generated root file must be checked from Repository root and at least one nested directory with a prompt that reports active instructions。If instructions are truncated、stale or contradictory，the WP is not Done；shorten / split guidance and restart the Agent session rather than silently continuing。

### 89.5 Windows / WSL2 Execution Decision

Decision：For BOP-RMS, Windows is the supported host and WSL2 is the accepted development execution environment。This is a project-specific choice, not a claim that every Windows project requires WSL。

Rationale：accepted production / CI runtime is Linux；the stack uses Docker、PostgreSQL、Bash-oriented automation and case-sensitive paths；Codex in WSL2 uses its Linux sandbox。Keeping Repository bytes and all developer tools in one Linux filesystem removes the highest-risk path、line-ending、permission、file-watcher and duplicate toolchain inconsistencies。

Accepted topology：

| Layer | Accepted baseline | Prohibited ambiguity |
| --- | --- | --- |
| Windows host | supported Windows 11 Edition / build；Windows apps、browser、device management | unsupported Home / Pro build or assumed lifecycle |
| Linux environment | WSL2, one supported Ubuntu LTS distribution | WSL1 or multiple distributions editing the same checkout |
| Codex Agent | switch Windows app Agent to WSL and restart | Windows-native Agent mutating a WSL checkout |
| Terminal | WSL / Bash for all Repository commands；PowerShell may manage the host only | alternating PowerShell Node / Git and WSL Node / Git on one checkout |
| Repository / worktrees | `~/src/bop-rms` and sibling worktrees inside the WSL Linux filesystem | `/mnt/c`、drive-letter checkout、OneDrive / sync folder |
| Git / Node / Corepack / pnpm / Docker CLI | installed / resolved inside the same WSL distribution；exact project pins | duplicate Windows dependency install or lockfile generation |
| Containers | Docker Desktop WSL2 backend + integration only for selected distribution；Linux containers | mixed Windows containers or hard-coded WSL IP |
| Editor | WSL-aware remote mode against Linux path | editor task / extension invoking Windows binaries against Linux files |
| Codex sandbox | `bubblewrap` and required Ubuntu AppArmor support verified | disabling host security globally to suppress a warning |

Ubuntu `24.04 LTS` is the default distribution for the first bootstrap unless execution-time support evidence requires a newer supported Ubuntu LTS；that evidence is an IDR-0001 input, not a business redesign。Development services bind to documented localhost ports and clients use `localhost` / service DNS rather than a changing WSL IP。Secrets remain untracked with Linux permissions；Git remote is the source-history / collaboration backup。A WSL export may be a workstation recovery aid but is not source control。

A Dev Container is not required for WP-0001 because exact runtime pins、Docker Compose and WSL2 already bound the environment。Create one only if onboarding repeatability、native build dependencies or environment drift is observed；the trigger requires an IDR and may not introduce a second conflicting toolchain。

Windows lifecycle is execution evidence：before WP-0001, record Edition、`winver` / build and Microsoft support status。At the audit date，Windows 11 version 23H2 Home / Pro is already out of servicing；a machine on that combination must upgrade before bootstrap。Enterprise / Education has a different lifecycle and must be verified rather than guessed。

### 89.6 WSL2 Bootstrap Evidence Gate

No setup command is executed by this documentation-only work。Before WP-0001 may claim Execution Ready, its evidence bundle must record：

1. supported Windows Edition / build and pending reboot / update state
2. `wsl --version`、selected distribution name / version and WSL version `2`
3. Codex Agent mode changed to WSL and application restarted
4. `uname -a`、`/etc/os-release` and functioning `bubblewrap` / AppArmor profile where required
5. Repository real path under the WSL Linux filesystem and all worktree paths outside `/mnt/*`
6. `command -v` / version for Git、Node、npm、Corepack、pnpm、Docker and Compose, all resolving inside Linux
7. exact `.nvmrc` / `packageManager` pins、frozen install and lockfile reproducibility from a clean checkout
8. Docker WSL backend / selected-distribution integration、Linux container and localhost connectivity
9. Git case sensitivity、LF policy、executable-bit preservation and no case-colliding files
10. root `AGENTS.md` discovery、combined instruction size、nested precedence test and current WP / spec-index resolution

If any item fails, record it as environment evidence / IDR-0001 trigger。Do not fall back silently to native Windows、WSL1、`/mnt/c` or a second Package Manager。

### 89.7 Conflict and Optimization Closure Matrix

| Earlier text / risk | Final resolution | Status |
| --- | --- | --- |
| Native Windows / PowerShell package bootstrap | Section 77 / 89 WSL2 baseline supersedes it | Closed |
| Generic `<workspace-root>/bop-rms` / possible Windows drive | Windows host uses `~/src/bop-rms` in WSL Linux filesystem | Closed |
| Windows host vs Agent vs terminal meaning conflated | topology table separates all three；Repository commands remain WSL / Bash | Closed |
| Café / QSR Counter Ordering profile vs no Staff entry page | `OPS-ORDER-ENTRY` + permission + WP + journey added | Closed |
| Shared utility IDs had no standalone / embedded distinction | Audit、Approval、Alert receive canonical routes；History、Compare、Picker、Impact inherit parent；Inventory legacy IDs map to canonical parents / aliases | Closed |
| Large Handoff Package vs bounded Agent instruction context | concise root guidance + spec index + current WP brief；full file stays authority | Closed |
| No durable Agent instruction file | root `AGENTS.md` required in WP-0001；nested files only on actual directory-specific need | Closed |
| Human page tables can drift from implementation | schema-validated Screen Registry mirror + CI reference checks | Closed design；artifact awaits authorized UI foundation WP |
| Future-trigger / explicit non-scope repeatedly reported as missing pages | Section 89.2 register defines reopen trigger | Closed |
| Old Inventory “later screen design” wording | Sections 78 / 88 mark design complete；only implementation / evidence remains | Closed |
| Historical Route / Screen aliases conflict with Section 88 | Section 88 canonical routes / alias normalization wins | Closed |
| External legal / Provider / Store evidence interpreted as unfinished design | Sections 80、86–87 and 89.2 keep them as execution / live gates | Excluded from defects |

### 89.8 Source and Change-control Notes

Execution-time environment owners must re-check temporally changing support facts before bootstrap。Current design basis：

* OpenAI Codex `AGENTS.md` discovery / precedence / size guidance：https://learn.chatgpt.com/docs/agent-configuration/agents-md
* OpenAI Codex Windows app / WSL mode and WSL1 support boundary：https://learn.chatgpt.com/docs/windows/windows-app
* Microsoft WSL installation / environment setup：https://learn.microsoft.com/windows/wsl/install and https://learn.microsoft.com/windows/wsl/setup/environment
* Microsoft Node.js on WSL guidance：https://learn.microsoft.com/windows/dev-environment/javascript/nodejs-on-wsl
* Microsoft Windows lifecycle：https://learn.microsoft.com/lifecycle/products/windows-11-home-and-pro

These sources establish tool behavior and execution constraints；they do not replace ADR / IDR、professional advice or actual machine evidence。A future documentation update may refresh versions / URLs without reopening accepted business semantics, but a toolchain or topology change requires IDR-0001 Revision and parity evidence。

### 89.9 Final Pre-code Closure

Status：`Accepted and Closed`。

Final interpretation：

* Page / function coverage remains complete after reverse audit；the only missing business workflow page, Staff Order Entry, is now specified and owned；shared utility / Inventory alias metadata is also normalized so it cannot generate phantom pages or route collisions。
* Root `AGENTS.md` is required, precisely designed and assigned to WP-0001；it is intentionally not materialized before the actual Repository exists。
* Windows-hosted development uses WSL2、Linux filesystem and one Linux toolchain；native Windows remains host-management scope only。
* Intentional non-scope、Future Trigger and External Evidence are explicitly separated from defects。
* No business code、Repository scaffold、external account or environment mutation was performed。
* Coding remains unauthorized until the user explicitly starts an implementation Work Package。

## 90. Codex and Figma Implementation Operating Model（Accepted）

### 90.1 Status、Purpose and Scope

Status：`Accepted and Closed`。

Purpose：在不重开 Sections 80、86–89 已接受的产品、架构、页面和执行环境决策的前提下，锁定 BOP-RMS 使用 Codex、Figma Design、Figma Make、plugins 与 repository-scoped project skills 的实施方式，使后续 Agent 不需要自行选择工具权威、设计交付格式、外部写权限或重复工作流。

本节仅定义 implementation operating model。本次封版没有：

* 创建或修改 GitHub Repository、branch、commit、Pull Request 或 ruleset
* 创建或修改 Figma Design / Make file、Project、Library、Make Kit 或 published prototype
* 安装 package、plugin、MCP server、Node、pnpm、Docker 或其他 developer tool
* 写入任何 application、infrastructure、migration、test 或 business code
* 创建 cloud / Provider resource、credential、Store、Customer 或 production data

Section 90 对 Codex task operation、Figma Design / Make、plugin、project skill、design-to-code handoff 与 external-mutation authority 具有最终权威。它不取代 Section 88 的 Page / Function authority、Section 89 的 `AGENTS.md` / WSL2 authority，或 Domain / Security / Payment / Tax / Privacy ownership。

### 90.2 Authority and Artifact Model

| Artifact / Surface | Authoritative for | Never authoritative for |
| --- | --- | --- |
| Complete Handoff Package | business meaning、architecture、Domain ownership、Screen / Function、Permission、state、Phase、Work Package、accepted tool / Provider decisions | real environment result、actual code behavior、real account / legal fact |
| Section 88 + machine Screen Registry mirror | Screen ID、Route / placement、fields、Search / Filter、Action、Permission、Projection、state、responsive / accessibility and owning WP | pixel-level composition or executed test evidence |
| Figma Design Accepted Frame / Component / Variable | visual hierarchy、spacing、component composition、responsive layout、prototype annotation and approved asset treatment | business invariant、server validation、authorization、money / tax / lifecycle truth |
| Figma Make | disposable interaction exploration、scenario demonstration and usability feedback | accepted production code、Domain truth、security control、Provider behavior or final Figma component linkage |
| Repository source / generated contracts | implemented behavior and executable contract for the exact commit | permission to contradict accepted Handoff semantics |
| Tests / CI / screenshots / traces | evidence that a commit satisfies an accepted contract | a new product decision merely because a test currently encodes it |
| External Evidence | real GitHub / Figma plan、account、Store、Provider、legal、tax、device、network and execution facts | authorization to redesign the product silently |

Conflict resolution：

1. Figma / Make differs from Section 88 behavior、permission or state → Figma / Make is revised；the visual artifact does not override the Screen contract。
2. Code differs from the accepted Handoff / Registry → treat as an implementation defect unless an approved ADR / IDR / Handoff revision changes the contract first。
3. Make differs from Accepted Figma Design → Make is disposable；revise or discard it。
4. Accepted Figma may refine pixels、content hierarchy、illustration and component composition only within the Section 88 / 90 gate。
5. Figma comment、Make chat、PR comment or Agent suggestion is feedback, not a decision, until promoted through the applicable review / revision path。

### 90.3 Codex Execution Model

Codex is the selected implementation Agent for BOP-RMS。Every implementation task follows this operating baseline：

* Windows-hosted execution uses Section 89 WSL2、Linux filesystem、Bash / Linux toolchain and Codex WSL Agent mode。
* Open the actual Git Repository root, never the Library working directory, as the Codex project root。
* Start each new session by reading root `AGENTS.md`、`docs/spec/README.md`、the exact current `docs/spec/work-packages/WP-xxxx.md` and only the authoritative Handoff sections referenced by that brief。
* One active Work Package per Coding Task、branch and worktree；a task may read related contracts but may not implement a second WP silently。
* Perform read-only preflight before mutation：workspace root、Git ownership / status、branch / worktree、unrelated changes、active instruction files、tool versions、network / connector availability and required External Evidence。
* Preserve unrelated user work。A dirty worktree is not permission to reset、stash、overwrite or delete another change。
* Use a short plan for any multi-step WP and keep at most one step actively in progress。
* Implement the smallest change that satisfies the WP；no speculative framework、dependency、refactor、provider or future-page expansion。
* Validate proportionally to risk and record exact commands / results；an unrun check is never reported as passed。
* End with the Section 77.18 handoff format and identify every deviation、skipped check、external blocker and next allowed WP。

Chat memory and earlier conversation text may help locate context but are not durable Repository authority。If the current WP brief is stale against the Handoff document version recorded in `docs/spec/README.md`，stop and refresh the brief before implementation。

### 90.4 Authorization and External-mutation Matrix

Authorization is action-specific。Installing or connecting a plugin never grants permission to mutate its external service。

| Action class | Default authority | Required before action |
| --- | --- | --- |
| Read local Repository / approved Library or connected design context | allowed when relevant to the assigned task | correct target and least necessary scope |
| Read-only environment / Git / plan / connector preflight | allowed within an authorized preparation / implementation task | no secret exposure or unrelated account enumeration |
| Edit local files inside one authorized WP | prohibited until explicit coding authorization | WP ID、Repository root、scope and clean-change inspection |
| Write Figma Design / Make | prohibited by default | explicit design task、target file / Project and allowed artifact scope；load required Figma skill before the write tool |
| Create Repository、branch、worktree、commit、push or Pull Request | prohibited by default | explicit action authorization；Repository owner / URL and branch model evidence |
| Merge、release、deploy、publish Make prototype or Figma Library、change ruleset / environment | separately prohibited | explicit target-specific authorization and prerequisite evidence |
| Create / mutate AWS、Stripe、Cognito、SES、tax、domain、DNS or other Provider resource | separately prohibited | owning WP、environment、account、impact、rollback and credential / approval gate |
| Production data、credential rotation、destructive Git / database / Library action | prohibited unless unambiguously requested | exact target、backup / recovery、impact and explicit destructive-action approval |

The phrase “start coding” authorizes only the named WP's local implementation unless the same request explicitly includes external actions。Commit、push、PR、merge、deploy and Provider mutation are distinct permissions。A terminal condition such as “finish” does not broaden authority。

### 90.5 Per-Work-Package Codex Lifecycle

Every WP executes this sequence：

1. **Resolve** — verify current document version / node、WP brief、Repository / worktree and instruction chain。
2. **Preflight** — inspect Git / environment / External Evidence and report blockers without mutation。
3. **Plan** — map acceptance criteria to files、commands、tests and evidence；exclude non-goals。
4. **Implement** — edit only authorized files；keep contracts and generated artifacts synchronized。
5. **Verify** — run affected formatting、lint、type、unit、integration、architecture、contract、migration、security、accessibility、visual and build checks that exist at that stage。
6. **Review** — inspect final diff、dependencies、generated churn、secrets / PII、permissions、Tenant / Store scope、money / time and error / recovery behavior。
7. **Handoff** — report outcome、files、commands、acceptance、evidence、deviations and next allowed action。
8. **External action** — commit / push / PR / merge / deploy only when separately authorized。

A failed Gate is not bypassed through a broader prompt、another plugin or generated code。Resolve the evidence or revise the applicable ADR / IDR first。

### 90.6 Figma Project and File Topology

Figma is the selected visual-materialization workflow。When a Figma design task is explicitly authorized, create or use one Project named `BOP-RMS` with this target topology：

* `00 BOP Design System`
* `10 Customer PWA`
* `20 Merchant Web`
* `30 Operations & KDS`
* `40 Make Prototypes`
* `90 Archive`

`00 BOP Design System` is the preferred published Library when the real Figma plan / seat supports team Libraries。If entitlement does not support the split, use one file named `BOP-RMS UI Foundation` with the same numbered pages and preserve identical IDs / naming；plan entitlement is External Evidence and does not justify a second visual system。

Minimum Design System pages：

1. `00 Cover & Changelog`
2. `01 Foundations`
3. `02 Variables`
4. `03 Components`
5. `04 Screen Patterns`
6. `05 Templates`
7. `90 QA & Review`
8. `99 Deprecated`

Minimum screen-file pages：`00 Index`、Phase / flow pages、shared states、responsive variants、prototype flows and Archive。Do not mix current Accepted frames with abandoned exploration without an explicit Status section。

### 90.7 Figma Variables、Components and Assets

Figma Variables materialize Section 80.10 and `VIS-BOP-PILOT-001`；they do not invent a new theme。Preferred collections：

* `Primitive` — raw color / numeric scale used only through semantic aliases
* `Semantic` — Brand、Surface、Text、Border、Focus、Success、Warning、Danger、Info、spacing、radius、type and elevation roles
* `Surface` — Customer、Merchant and Kitchen / Pickup density or sizing differences that are genuine surface semantics
* `Component` — component-state aliases only where a semantic token is insufficient

Modes begin with `BOP Pilot Neutral` and the accepted Customer / Merchant / Kitchen contexts only。Dark Mode、new Brand mode or alternative visual direction is not added without a real product trigger and contrast / asset review。

Rules：

* Components bind Variables / styles；component-owned raw hex、unregistered font、arbitrary spacing and detached copies are prohibited in Accepted frames。
* Use Auto Layout、component properties and variants for reusable behavior；avoid absolute positioning except deliberate overlays / diagrams。
* Component names use the `BOP/` namespace and clear semantic purpose, not Provider or implementation-library names。
* Fonts、icons and assets match Section 86：self-hosted approved font families、one Lucide-aligned icon language and licensed / synthetic food imagery。
* No scraped、unlicensed or real merchant asset enters an acceptance artifact。
* Accessibility notes cover focus order、keyboard alternative、accessible name、error association、non-color state、touch target、zoom / reflow and reduced motion where applicable。
* Component variants do not encode unauthorized Domain state transitions；the owning Screen / Command contract remains explicit。

### 90.8 Screen、Frame and Prototype Traceability

All currently registered Screen IDs receive an inventory / placement record before the first feature UI implementation；not every Screen must be pixel-complete before WP-0001–0003。Standalone pages、embedded utilities、contextual dialogs and aliases retain Section 88 `kind` / `route_mode` semantics。

Frame naming：

`SCREEN-ID · State · Viewport`

Examples：

* `CUST-MENU · Default · Mobile 390`
* `OPS-ORDER-QUEUE · Stale · Desktop 1440`
* `KIT-WORK-ITEM · Allergen Block · KDS 1024×768`

Artifact status：`Draft` → `Review` → `Accepted` → `Deprecated`。Only `Accepted` frames are implementation targets。Every Accepted Frame records：Screen ID、Surface、Route / placement、Phase / feature gate、Viewport、state、owning WP、Figma file / node reference、source document version、review status and any approved deviation。

`docs/product/screen-registry.yaml` remains the machine-checkable Repository mirror。After the Repository exists, it records the accepted Figma node reference but never stores a credential、signed URL or access token。Figma、Frontend Route、API / Projection and test artifact use the same Screen ID。

### 90.9 Figma Make Contract

Figma Make is selected for high-interaction prototyping、flow rehearsal and feedback。It is explicitly not the production source tree or final design-system authority。

When the real Figma entitlement supports Make Kits, create `BOP-RMS Make Kit` from the published Design Library and later approved npm component package；otherwise use per-file style context and an equivalent `guidelines.md`。Make Kit / library entitlement is execution evidence, not a design blocker。

Mandatory Make guidelines：

* use BOP semantic tokens、components、Screen IDs and accepted content hierarchy
* preserve Section 88 actions、permissions、states、error / recovery semantics and responsive / accessibility intent
* use stable synthetic Restaurant、Menu、Order、Payment、Inventory and exception fixtures only
* never include credential、Token、real endpoint、real Customer / Employee / merchant PII、Payment data、allergy / health narrative or private Provider payload
* never hardcode tax、price、permission、lifecycle or success result as a substitute for server truth
* model backend interaction as labeled mock / simulated state；do not imply that a prototype proves idempotency、security or Provider behavior
* do not add analytics、external network、microphone、camera、upload or third-party script unless the explicit prototype task requires and reviews it
* exported Make code is disposable reference；it is not copied wholesale into the production Repository
* a preview copied into Figma Design must be rebuilt / normalized with real components and Variables before it can become `Accepted`

Publishing a Make prototype is an external action requiring explicit authorization。Because a published link may be publicly reachable，the publish Gate requires synthetic-data review、secret / metadata scan、content ownership、accessibility spot check、expiry / removal owner and a statement that it is a prototype。An unpublished local / team preview remains preferred for internal review。

### 90.10 Figma UI Readiness Gate

Figma is not a blocker for WP-0001–0003。Before WP-0004 writes shared UI components or any feature UI Work Package begins, the following Gate must pass：

1. target Figma Project / file and editor access are verified
2. Design System file / fallback pages、Variable collections and `VIS-BOP-PILOT-001` values exist
3. core primitives and the ten Section 88 Screen-family templates use Components / Variables rather than detached styling
4. all current Screen IDs have an inventory / placement record with standalone / embedded / contextual / alias semantics
5. these critical flows have Accepted responsive frames and prototype linkage：Customer Menu → Configure → Cart → Checkout → Payment → Status；Staff Order Entry → Queue → Detail / Exception；Kitchen Queue → Work Item → Pickup；Product / Menu Authoring → Preview → Publish；Store Setup → Live Gate
6. shared Loading、Empty、401 / 403 / 404、409、422、429、Offline、Stale、Provider Pending / Unknown and feature-disabled states are represented by template or explicit screen artifact
7. mobile、tablet、desktop and approved KDS viewport evidence covers Section 88 breakpoints / operational device profile
8. accessibility annotations、localization expansion and synthetic-data / asset provenance review pass
9. Accepted frame IDs / node references and source document version are recorded for the owning WP
10. no unresolved Figma / Make conflict with Section 88、no real data and no unapproved external publish

Code Connect is not a prerequisite for this Gate。It becomes useful only after stable production components exist and the actual Figma plan / seat supports it。

### 90.11 Core Plugin Baseline

Use the smallest plugin set that supplies required external context。A plugin is an execution aid, not a new source of product truth。

| Plugin / capability | Status / timing | Allowed use | Boundary |
| --- | --- | --- | --- |
| Figma | Required for authorized design / design-to-code tasks；not WP-0001 blocker | read Design / Make context、Variables、Components、screens；write only to explicit target | no Figma write / publish without task authority；Make not code truth |
| GitHub | Required for Repository / Issue / PR / CI tasks | inspect Repository / PR / checks；perform authorized branch / commit / PR actions | connection is not permission to create、push、merge or alter rules |
| OpenAI Library | Required while the Complete Handoff Package remains outside Git | resolve / read / replace the same authoritative file；support bounded spec index | no credential / signed URL in Repository；do not create duplicate authority |
| Product Design workflow skills | Approved for visual ideation / flow audit / design QA | explore within accepted brief、audit evidence、compare implementation to selected target | cannot reopen accepted business behavior silently |
| Browser / Playwright capability | Required by owning UI / E2E WP | inspect local / staged UI、responsive / interaction / accessibility and failure behavior | browser observation is not source truth；no production mutation |
| OpenAI Docs | Allowed for Codex / OpenAI setup questions only | verify current Codex behavior、skill / plugin / AGENTS guidance | not a BOP-RMS runtime dependency or product feature |

Connector authentication observed during planning is transient External Evidence。Every execution session re-verifies the exact account / installation and least privilege without writing identity、email、Token or plan secret into the Handoff / Repository。

### 90.12 Optional、Triggered and Non-default Plugins

| Capability | Decision |
| --- | --- |
| Linear | Not selected；GitHub Issues + stable WP IDs remain the planning source。Enable only through an IDR if GitHub planning becomes insufficient；never maintain two competing backlogs。 |
| Slack or Teams | Not selected。Enable exactly one only when a real team communication workflow exists and recipient / channel governance is defined。 |
| Data Analytics skills | Optional in Reporting / BI WPs for KPI definition、data quality and dashboard evidence；they cannot replace Domain metric definitions or certified source facts。 |
| React best-practice reviewer | May be used as a non-authoritative review skill after multi-component TSX work；it may not change the accepted Vite / React Router / AWS architecture or add Vercel deployment。 |
| Code Connect | Later trigger after production components are stable and eligible Figma plan / seat evidence exists；manual Screen ID / node mapping remains sufficient before then。 |
| Design token synchronization plugin | Not selected initially；native Figma Variables + Repository CSS custom properties / generated token artifacts are the baseline。Add only after measured drift that cannot be controlled by validation。 |
| External accessibility plugin | Optional convenience only；WCAG / AODA acceptance still requires code-level keyboard、screen reader、contrast、zoom / reflow and Playwright / manual evidence。 |

Default exclusions：

* no Anima、Locofy or second design-to-code generator alongside Figma Make + Codex
* no Render、Vercel、Wix or Figma Make production hosting for the accepted AWS application
* no Notion / Google Drive duplicate of the Handoff or Screen Registry authority
* no AWS / Stripe / Cognito / tax / DNS write connector during repository bootstrap
* no plugin that requires production credential merely to generate UI、fixtures or local code
* no broad mailbox、calendar、chat or document access unrelated to the active WP

If a plugin is unavailable, use a manual / CLI / file workflow that preserves the same contract and evidence。Do not install an alternative that expands authority or changes architecture merely to avoid an availability Gate。

### 90.13 `AGENTS.md`、Project Skill、Plugin、Hook and CI Separation

Use the smallest durable surface that matches the rule：

| Surface | BOP-RMS use |
| --- | --- |
| root / nested `AGENTS.md` | always-on Repository scope、commands、architecture invariants、security、Git and Done rules from Section 89 |
| `.agents/skills/<name>/SKILL.md` | reusable, explicitly triggered task workflow with references / deterministic helper scripts |
| Plugin / connector | authenticated external context or action such as Figma / GitHub / Library |
| Repository `.codex/config.toml` | trusted-repo Codex defaults / MCP enablement only when required and reviewed；never credentials |
| Hook / CI / lint rule | mechanically enforceable invariant such as generated drift、forbidden dependency、secret、route / Screen ID uniqueness、architecture boundary or test gate |
| Prompt / WP brief | one-off task scope、current acceptance criteria and temporary constraints |

Do not put a long workflow into `AGENTS.md`、a durable invariant only in a chat prompt、or an enforceable security rule only in an advisory skill。Skills guide execution；CI / tests prove and enforce it。

### 90.14 Accepted Repository-scoped Project Skills

WP-0007 materializes these five skills under `.agents/skills/` using the approved skill-creation workflow。Until WP-0007 is complete，root `AGENTS.md` + current WP brief is the authoritative fallback and absence of these skills does not block WP-0001–0006。

| Skill | Trigger | Required workflow / output | Explicit boundary |
| --- | --- | --- | --- |
| `bop-work-package` | every new WP planning / execution handoff | resolve document / brief versions、DoR、scope / non-goals、files、dependencies、commands、acceptance、evidence and next WP | no implementation outside named WP；no invented evidence |
| `bop-screen-contract` | Figma or code task affecting a Screen、Pattern、Route or component behavior | resolve Screen ID / kind / route、Figma node、fields、permissions、Projection、Commands、all states、responsive / accessibility、analytics / privacy and owning tests | no pixel artifact may weaken server / permission semantics；no generic UI redesign |
| `bop-domain-change` | Domain object、Command、Event、Projection、Repository or migration-affecting behavior | resolve fact owner、aggregate / lifecycle、public contract、idempotency、expected version、Tenant / Store、money / time、outbox / inbox、migration / replay and cross-domain tests | no private cross-domain table access、binary float money or history edit |
| `bop-security-privacy-review` | auth、permission、PII、Payment、Allergen / health、upload、export、logging、analytics、Provider or production-impacting change | threat / data-flow review、field classification、least privilege、redaction、retention、failure / abuse tests、finding severity and blocking disposition | no credential access / rotation or risk acceptance without explicit authority |
| `bop-verification` | before claiming any WP Done | select existing affected checks、run / record results、review diff / generated drift / secrets、map evidence to acceptance and disclose skips / blockers | no fabricated pass、disabled gate or unrelated test rewrite |

The skill names and purposes are stable。A future nested / specialized skill is created only after repeated workflow need or a registered Domain / tool trigger；it must not duplicate these five or root `AGENTS.md`。

### 90.15 Project Skill Creation and Governance

Every repository-scoped skill must：

1. be created / updated through the approved `skill-creator` workflow
2. live at `.agents/skills/<skill-name>/SKILL.md` with optional bounded `references/` and deterministic `scripts/`
3. have a precise name / description that triggers only on the intended task
4. reference `docs/spec/README.md` / current WP brief instead of embedding the full Handoff Package
5. avoid absolute workstation paths、account identity、credential、signed URL、production data and non-portable hidden state
6. state required inputs、ordered workflow、hard stops、output / evidence and destructive / external-action boundaries
7. be reviewed like code for prompt injection、over-broad authority、stale command、unsafe shell and conflicting guidance
8. include at least one positive and one boundary / failure smoke scenario before acceptance
9. remain versioned in Git and change only through the owning WP / reviewed PR
10. never auto-commit、push、merge、publish、deploy or mutate Provider state

Skill instructions cannot supersede the Handoff、root `AGENTS.md`、security policy or explicit user scope。When conflicts remain, the Agent stops and reports the exact files / rules rather than choosing the most permissive instruction。

### 90.16 Design-to-code Workflow

For a Figma-targeted implementation：

1. verify the owning WP、Screen ID、Accepted Figma file / node and source document version
2. load the required Figma read / design-generation skill before any Figma tool call；use read-only context first
3. inspect existing Code Connect map when present；otherwise inspect accepted Components、Variables、styles and neighboring Screen patterns before creating code
4. retrieve the specific Frame / node context and screenshot；do not implement from a whole-file guess or a Make URL alone
5. map Figma Components to BOP-owned React wrappers / semantic tokens；Radix remains a primitive layer and Tailwind / CSS custom properties remain the code token implementation
6. implement all required Section 88 states、permissions、responsive / accessibility and failure behavior, including behavior not visible in the default screenshot
7. use synthetic fixtures and provider adapters / mocks according to the WP；never call production services to make a screen look realistic
8. compare rendered UI to the Accepted Frame at required viewports and run code-level behavior / accessibility tests
9. record intentional visual deviations with reason / approval；update Figma or code so two accepted sources do not drift
10. add Code Connect only after the production component API is stable and entitlement evidence passes

Generated Figma / Make / MCP reference code is advisory input。It must be adapted to the accepted architecture、component wrappers、contracts、security and testing rules；it is never pasted as an unreviewed production module。

### 90.17 Canonical Implementation Start Sequence

The accepted sequence is：

1. Section 90 documentation closure（this revision）
2. separately authorized WP-0001 Repository Bootstrap
3. WP-0002 Workspace directory baseline
4. WP-0003 TypeScript、lint、format and unit-test foundation
5. Figma UI Readiness materialization may run as a separately authorized design task and must finish before WP-0004 writes shared UI components / feature UI
6. WP-0004 API、Worker、Merchant Web and Customer PWA skeleton
7. WP-0005 local PostgreSQL / Docker Compose
8. WP-0006 root scripts / environment validation
9. WP-0007 ADR、Module documentation、setup templates and the five project skills
10. first approved business vertical-slice WP

No Agent may interpret this sequence as authorization to execute all steps in one task。Each WP / design task receives its own scope、preflight、worktree / branch and external-action authority。

### 90.18 Exact WP-0001 Start Authorization Template

Section 90 closure does not authorize coding。The user may start WP-0001 with an instruction equivalent to：

```text
I explicitly authorize BOP-RMS WP-0001.

GitHub owner: <verified personal account or organization>
Repository: private bop-rms

Authorized:
- read-only WSL2, Git, Node, pnpm, Docker and GitHub preflight
- create or connect the named private Repository if explicitly possible
- create one auditable seed main when required
- create the WP-0001 feature branch / worktree
- implement only WP-0001
- commit, push and open a Pull Request only if listed here

Not authorized:
- merge, deploy or publish
- cloud / Provider resource mutation
- credential or production-data access
- application, infrastructure or business code outside WP-0001

Stop on a real blocker. Do not bypass or expand scope.
Run every available WP-0001 verification and provide the Section 77.18 handoff.
```

The actual instruction must replace the owner placeholder and explicitly retain or remove commit / push / PR permission。Repository creation、seed、push and PR are external writes and cannot be inferred from general coding authorization。

### 90.19 Final Readiness Ledger

| Area | Status after this revision | Next Gate |
| --- | --- | --- |
| Product / Architecture / Domain / Page / Function decisions | `PASS / Decision Complete` | ADR / IDR only on registered trigger |
| Codex implementation operating model | `PASS / Accepted` | execution evidence per WP |
| Figma Design / Make operating model | `PASS / Accepted` | explicit target / access + Section 90.10 materialization |
| Core plugin selection | `PASS / Accepted` | per-session auth / plan / least-privilege evidence |
| Project skill design | `PASS / Accepted` | WP-0007 creates / tests repository files |
| WP-0001 Specification / Decision | `PASS` | explicit authorization + real Repository / WSL / Git / tool evidence |
| WP-0001 Execution Ready | `PENDING` | same external evidence；no missing design choice |
| Figma UI Readiness | `PENDING Materialization` | Section 90.10 before UI component / feature implementation |
| Implementation | `Not Started / 0%` | separately authorized WP-0001 |

Figma materialization、plugin authentication、GitHub owner / URL、environment commands and real test results are Execution Evidence。They are not reopened pre-code design defects。

### 90.20 Official Behavior Sources and Temporal Evidence

Current operating-model sources：

* OpenAI Codex skills / plugins：https://learn.chatgpt.com/docs/skills-and-plugins.md
* OpenAI Codex `AGENTS.md` discovery / precedence：https://learn.chatgpt.com/docs/agent-configuration/agents-md
* OpenAI Codex Windows / WSL Agent mode：https://learn.chatgpt.com/docs/windows/windows-app
* Figma Make behavior / sharing / Design-layer copy：https://help.figma.com/hc/en-us/articles/31722591905559-Figma-Make-FAQs
* Figma Make Kits / guidelines：https://help.figma.com/hc/en-us/articles/39241689698839-Get-started-with-Make-kits
* Figma MCP server：https://help.figma.com/hc/en-us/articles/32132100833559-Guide-to-the-Figma-MCP-server
* Figma Variables / Libraries：https://help.figma.com/hc/en-us/articles/15339657135383-Guide-to-variables-in-Figma and https://help.figma.com/hc/en-us/articles/360041051154-Guide-to-libraries-in-Figma
* Figma Code Connect：https://help.figma.com/hc/en-us/articles/23920389749655-Code-Connect

Plan、seat、feature availability、plugin authentication、tool schema、rate limit and public-sharing behavior may change。The owning task rechecks current official behavior and actual account evidence before use。A source refresh that does not change semantics may update documentation；a changed authority、security、hosting or design-to-code workflow requires the appropriate IDR / Section revision。

### 90.21 Final Pre-implementation Seal

Status：`Accepted、Decision Complete and Closed`。

---

### 90.21.1 WP-0024 accepted detail adopted by Section 97

#### Authority、supersession and complete decision

Status：`Accepted and Closed`。The Owner accepted this decision on `2026-07-21` from exact fresh `origin/main@f404d3cdc6f6ec099046e329cd10d348c55a783b`。This Section is `ADR-0034 — Test Fixture and Isolated Database Ownership Boundary` and `IDR-0047 — Parallel Resource Lifecycle、Diagnostics and Cleanup`。

Section 97 accepts the complete exact decision set and implementation allowlist recorded in `docs/spec/work-packages/WP-0024.md` on the authorized `codex/wp-0024-specification-readiness` branch。It supplements Sections 50、54.4 F00.3、87 and 92–96 and supersedes older ad hoc isolated-harness mechanics only where the accepted WP-0024 framework replaces them。WP-0020 remains the sole migration catalog / runner authority；WP-0021 and WP-0022 retain their schema / helper semantics；WP-0023 retains its optimistic-concurrency evidence。

### 90.21.2 ADR-0034 — unique owner、API、bootstrap and fixture boundary

`packages/database/test-support/isolated-database.mjs` is the sole reusable test-database lifecycle owner。It exports only `withIsolatedDatabase(options, testBody)` and test-only result fields `clientConfig`、`databaseName`、`fixtureRoot` and `runId`；fixture callbacks execute only inside the owned database。

The framework copies no migration-runner logic。It reads the root migration catalog and invokes the accepted WP-0020 runner to apply all accepted WP-0020–0022 migrations。WP-0021–0023 focused assertions become consumers without changing migration syntax、history、checksum、transaction、advisory-lock、diagnostic or recovery semantics。

Fixtures insert only explicitly supplied synthetic values into test-owned objects or accepted production-schema objects。There is no implicit global seed and no default Tenant、Brand or Store row。Business seed data、Tenant / Brand / Store bootstrap facts、production accounts、Provider data、ORM / Repository / Domain objects and application runtime persistence are excluded。

### 90.21.3 IDR-0047 — names、ports、processes、locks and parallelism

Each database name is lowercase `bop_rms_test_<run_id>_<case_id>`。Generated / normalized `run_id` and `case_id` use a closed ASCII grammar and an exact bound below PostgreSQL's identifier limit。Create and drop reject every name that is malformed or absent from the current owner's registry。

Each framework run owns one Compose project `bop-rms-test-<run_id>`。Framework labels carry the owner and run ID；projects、containers、networks、volumes、databases and temporary roots are never shared or fixed across parallel runs。

PostgreSQL binds only to loopback。A unique host port is allocated through an atomic cross-process lease, never a fixed default or probe-then-use race；the lease is released only after Compose teardown。The lease directory is under an owner-only operating-system temporary root。Database creation uses the dedicated run administrator connection。The WP-0020 migration advisory lock remains unchanged and is never reused as a host-resource lock。

### 90.21.4 Synthetic data、secret and logging security

Each run generates an ephemeral synthetic password stored only in a current-owner-only `0600` file。The framework accepts no DSN / password argument and does not inherit `DATABASE_URL` or `PGPASSWORD` as authority。It rejects non-loopback host、non-test environment and unsafe SSL downgrade。

Fixtures、diagnostics、stdout、stderr、PostgreSQL logs and artifacts contain no real Store identifier、PII、Payment、allergy / health、credential or Provider data。Output is limited to stable run / phase / diagnostic identities；password、DSN、environment values、SQL bodies and bind values are redacted。PostgreSQL logs are inspected for the synthetic password and removed with the run root。

### 90.21.5 Deterministic lifecycle and cleanup

One idempotent cleanup owner tracks the exact created clients、databases、Compose project / containers / networks / volumes、port lease and temporary root。Cleanup closes clients，force-drops only registered and grammar-valid databases，inspects redacted logs，runs Compose down with volumes and orphans，releases the lease and removes the temporary root。

Normal success and thrown failure clean up through `finally`。`SIGINT` exits `130` and `SIGTERM` exits `143` only after bounded cleanup。Framework timeout aborts work、performs bounded cleanup and preserves the original timeout diagnostic unless cleanup also fails。Cleanup failure is reported separately and never turns the original failure into success。

### 90.21.6 Diagnostics、exits、failure injection and residue

The closed codes are：

* `ISOLATED_DB_USAGE`
* `ISOLATED_DB_UNSAFE_ENVIRONMENT`
* `ISOLATED_DB_LEASE_FAILED`
* `ISOLATED_DB_START_FAILED`
* `ISOLATED_DB_BOOTSTRAP_FAILED`
* `ISOLATED_DB_FIXTURE_FAILED`
* `ISOLATED_DB_TIMEOUT`
* `ISOLATED_DB_CLEANUP_FAILED`
* `ISOLATED_DB_RESIDUE`
* `ISOLATED_DB_INTERNAL`

The API throws a typed error。The acceptance wrapper exits `0` for pass、`1` for an observed contract / test failure、`2` for usage or internal setup failure，and `128 + signal` for handled signals。

Acceptance-only failure hooks cover before Compose start、after start、after database create、during migration、during fixture、during test body and every cleanup phase。They are not application-runtime APIs and cannot bypass identifier、environment、redaction or owned-target validation。

Before and after each acceptance run, residue detection enumerates only resources bearing the exact framework owner / run labels and registered database-name grammar。Any owned residue is `ISOLATED_DB_RESIDUE`。Unrelated resources are never deleted and are reported only by bounded safe identity or count。

### 90.21.7 Exact implementation allowlist、acceptance and non-goals

The exact accepted implementation allowlist is：

* `packages/database/test-support/isolated-database.mjs`
* `packages/database/test-support/isolated-database.test.mjs`
* `packages/database/test/isolated-database-acceptance.mjs`
* `packages/database/test/integration.mjs`
* `packages/database/package.json`
* `package.json`
* `.github/workflows/bootstrap.yml`
* `docs/spec/work-packages/WP-0024.md`
* `docs/spec/README.md`

No dependency or lockfile change is accepted。A required file outside this list stops implementation until the Owner accepts a refreshed authority and allowlist。

Acceptance observes one lifecycle API；parallel unique project / port / database / volume / root allocation；unchanged WP-0020 runner reuse and repeat no-op；synthetic-only values；zero owned residue after success、each injected failure、SIGINT、SIGTERM and timeout；stable diagnostics / exits and redaction；frozen install；all existing affected root / database / architecture / migration / build checks；owning CI；and final security / scope review。

This WP creates no business seed、Tenant / Brand / Store fact、production / staging account or connection、Provider fixture or mutation、migration、role、login、grant、backup / restore tooling、deployment、dependency upgrade、generic Docker orchestrator or authority to remove an unowned resource。

External Evidence remains gated and unclaimed：PostgreSQL 18.4 / Amazon RDS behavior outside local tests、Docker availability on every developer / CI host、production roles / grants、backup / restore、staging、real Tenant / Brand / Store facts、Provider data and deployment approval。

Status：`Accepted、Decision Complete and Closed`。

---

### 90.22 WP-0022 Database Helper Accepted Decision Detail

#### 90.22.1 Authority、scope and ownership

Status：`Accepted and Closed`。The Owner accepted this decision on `2026-07-21` from exact fresh `origin/main@ea274863cc10018b96034a98b91f589c9e8a9f91`。This Section is `ADR-0033 — Database Helper Type and Tenant Context Boundary` and `IDR-0046 — Helper DDL, ACL and Verification`。It supplements Sections 50、87 and 92–95 and supersedes any older implication that WP-0022 owns business calculation、Business Date policy or table-specific RLS。

WP-0022 creates one migration-owner-owned technical schema，`platform_helpers`，and no table、sequence、business fact、role、login、extension、seed or application code。Its objects are a public database contract only after a later owning WP explicitly grants the minimum required schema / type / function privilege。`PUBLIC` and all runtimes receive no WP-0022 grant。

#### 90.22.2 Exact object contract

| Object | Contract |
| --- | --- |
| `platform_helpers.is_uuid_v7(uuid)` | immutable、strict、parallel-safe、`SECURITY INVOKER` boolean validator；never generates an ID |
| `platform_helpers.uuid_v7` | domain over `uuid` requiring `is_uuid_v7(VALUE)` |
| `platform_helpers.amount_minor` | domain over `bigint`；full signed bigint storage range；business bounds remain owning-field constraints |
| `platform_helpers.currency_code` | domain over `char(3)` requiring exact uppercase ASCII `[A-Z]{3}` shape；ISO 4217 membership / lifecycle remains owning reference evidence |
| `platform_helpers.is_iana_time_zone(text)` | stable、strict、parallel-safe、`SECURITY INVOKER` validator against PostgreSQL `pg_timezone_names` |
| `platform_helpers.iana_time_zone` | domain over `text` requiring `is_iana_time_zone(VALUE)` |
| `platform_helpers.local_date` | domain over `date`；does not infer Business Date |
| `platform_helpers.local_time` | domain over `time without time zone` |
| `platform_helpers.current_brand_id()` | stable、`SECURITY INVOKER` reader of transaction-local `bop.brand_id`；missing is `NULL`，malformed input errors closed |
| `platform_helpers.current_store_id()` | stable、`SECURITY INVOKER` reader of transaction-local `bop.store_id`；missing is `NULL`，malformed input errors closed |

All functions have fixed `pg_catalog`-only resolution and no dynamic SQL。Function `EXECUTE` and schema / type privileges are revoked from `PUBLIC`。No `SECURITY DEFINER` object exists。The migration role owns schema and objects；actual role names and memberships remain External Evidence。

UUID generation remains application-owned through accepted `uuid 14.0.1`。PostgreSQL 18 built-in `uuidv7()` may be used directly only by an explicitly reviewed migration / repair path；WP-0022 creates no wrapper、default or UUID extension。Money uses `amount_minor + currency_code` and never PostgreSQL `money` or float。Rates、percentages、quantities、rounding and allocation remainder rules remain exact owning Domain contracts and are not generalized by this WP。UTC instants continue to use native `timestamptz`；Business Date resolution、versioned Business Day Start and DST gap / overlap rules remain WP-1223。

Tenant readers do not authorize a request、verify Brand–Store membership or create a policy。The API / Worker sets validated values with `SET LOCAL` inside each transaction；persistent pool-level `SET` is prohibited。Actual tables own their required scope columns、FK / compatibility、Tenant-leading indexes、unique constraints、`ENABLE/FORCE ROW LEVEL SECURITY` policies and least-privilege grants under Section 87.7.5。Cross-domain private-table access remains prohibited。

#### 90.22.3 Migration、verification and recovery

The exact ordered migrations are：

1. `migrations/0000-platform/0000_006_create_platform_helpers.sql` — schema、owner-context ACL and safe default privileges only。
2. `migrations/0000-platform/0000_007_create_uuid_money_helpers.sql` — UUID validator / domain and Money domains only。
3. `migrations/0000-platform/0000_008_create_time_helpers.sql` — IANA validator and time domains only。
4. `migrations/0000-platform/0000_009_create_tenant_scope_helpers.sql` — transaction-local Tenant readers only。

Each file obeys Section 94 headers、global order、one-schema ownership、fully qualified SQL、byte-exact SHA-256、one transaction and immutable history。Failure rolls back the current migration and history insert。Recovery is reviewed forward-fix or independently approved restore；never down、repair、baseline、force、mark-applied、checksum bypass or applied-byte mutation。

The independent read-only verifier checks exact schema / object identities、types、volatility、strictness、parallel safety、invoker security、fixed configuration、owner、PUBLIC denial、dangerous default privileges、absence of extra objects / grants and representative pure behavior。Diagnostics are `helpers:<object> [<CODE>] <message>` sorted by object、code、message；exit `0` is compliant / help，`1` is contract drift，`2` is usage / unsafe config / connection / catalog / internal failure。It performs no DDL、repair、grant、adoption or baseline。

Synthetic tests cover valid / invalid UUIDv7、currency shape、bigint boundaries、known / unknown IANA zones、local date / time values、missing / valid / malformed transaction-local Tenant settings、PUBLIC denial、no runtime grant、wrong owner / signature / volatility / security / search-path drift、unexpected objects、repeat apply、rollback、WP-0013 ownership and unchanged WP-0020 / WP-0021 behavior。Runtime tests use unique WP-0022 isolated local databases and synthetic identifiers only；WP-0024 remains owner of the reusable fixture framework。

#### 90.22.4 Non-goals、dependencies and gates

WP-0020 owns catalog / runner；WP-0021 owns prior foundation schemas；WP-0023 owns optimistic concurrency integration；WP-0024 owns reusable seed / fixture / parallel isolated database infrastructure。Future business-table WPs own actual constraints、indexes、RLS and grants。WP-0022 creates no Business Date resolver、rounding engine、currency master、Tenant / Brand / Store table、business FK、Outbox、Inbox、Audit、Job、Projection、ORM、Repository、API or UI。

External Evidence remains unclaimed：PostgreSQL 18.4 / RDS behavior and `uuidv7()` compatibility、actual migration / runtime roles and memberships、IANA tzdata lifecycle、ISO 4217 update source、production ACL / RLS matrix、query plans、backup / restore、staging result and production approval。No staging / production connection or Provider action is authorized。

Status：`Accepted、Decision Complete and Closed`。

---

### 90.23 WP-0022 Canonical Adoption Record

#### 90.23.1 Authority、supersession and complete decision

Status：`Accepted and Closed`。The Owner accepted this decision on `2026-07-21` from exact fresh `origin/main@ea274863cc10018b96034a98b91f589c9e8a9f91`。This Section is `ADR-0033 — Database Helper Type and Tenant Context Boundary` and `IDR-0046 — Helper DDL, ACL and Verification`。

Section 96 adopts the complete exact object、schema、owner、ACL、runtime grant、migration、verifier、test、recovery、dependency、non-goal and External Evidence contract recorded in Section 90.22，and makes that accepted detail authoritative for WP-0022。It supplements Sections 50、87 and 92–95 and supersedes older implications that WP-0022 owns business calculation、Business Date policy、table-specific constraint / index / RLS or advance runtime authority。

The executable boundary is closed：one default-denied migration-owner-owned `platform_helpers` technical schema；the exact UUID validation、Money storage-domain、IANA / local-time-domain and transaction-local Tenant Context reader objects enumerated in Section 90.22；four exact ordered `0000_006` through `0000_009` migrations；invoker rights、fixed safe resolution、no PUBLIC or advance runtime grant；independent read-only verification and synthetic / isolated evidence。No business table、fact、role、login、extension、seed、UUID generator / default、rounding、Business Date resolver、authorization or table-specific RLS is included。

Status：`Accepted、Decision Complete and Closed`。

Final interpretation：

* This document is the final pre-implementation decision baseline for starting WP-0001 with Codex。
* All user-delegable product、architecture、page / function、execution-environment、Codex、Figma、plugin and project-skill decisions are closed。
* Figma Design is the accepted visual materialization / handoff authority within Section 88 semantics；Figma Make is a disposable interaction-prototype surface and never production code authority。
* The core external plugin set is deliberately minimal：Figma、GitHub and OpenAI Library；other plugins are trigger-based and cannot create competing sources of truth。
* Root `AGENTS.md` is created in WP-0001；the five repository-scoped project skills are created / tested in WP-0007；their absence does not block WP-0001–0006。
* WP-0001 remains `Execution Ready = PENDING` only for explicit authorization and real GitHub / WSL / Git / tool evidence。
* The user's instruction for this revision authorizes documentation editing only。No Repository、Figma artifact、plugin installation、business code or external service mutation has been performed。
* The next allowed implementation action is a separately authorized WP-0001 preflight and execution exactly within Section 77 / 90 scope。

---

## 91. GitHub Free Solo Development Governance and WP-0001 Execution Baseline（Accepted）

### 91.1 Authority、Decision and Scope

Status：`Accepted and Closed`。

用户于 `2026-07-16` 明确决定：保持 private GitHub Repository 与 GitHub Free，按单人开发模式继续，不为当前阶段购买 GitHub Pro；并授权正式修订 Handoff Package 与 WP-0001 governance baseline。

本节因此建立 `IDR-0012 Revision 1`，并在以下范围内覆盖 Sections 56.25、77、80、86.4、89、90 中与 GitHub Pro、private-Repository Branch Protection、Rulesets、Stage 2 activation 或 WP-0001 status 冲突的旧文字：

* 当前只有一个 authorized human Owner / Developer
* Repository 保持 private
* 当前环境为 development / pre-production
* 不启用 production deployment、production Customer / Employee PII、live Payment 或 Provider production credential
* GitHub Free 对该 private personal Repository 的 Branch Protection 与 Repository Rulesets API 返回 capability-unavailable evidence

Section 90 的 external-mutation authority、merge / deploy prohibition、每 Work Package 单独授权和其他安全边界继续有效。本节不授权 merge、WP-0002、deployment、Provider mutation 或 production enablement。

### 91.2 IDR-0012 Revision 1 — GitHub Free Solo Governance

| Field | Accepted Value |
| --- | --- |
| Status | `Accepted` |
| Supersedes | `IDR-0012 v0.1` only for solo private GitHub Free pre-production governance |
| Repository | private GitHub Repository `bop-rms` |
| CI | GitHub Actions；each available owning check must pass |
| Current enforcement | auditable process control；server-side Branch Protection / Rulesets unavailable on the verified plan |
| Owner / Review | one authorized human Owner performs explicit self-review；no independent approval is claimed |
| Merge model | short-lived WP branch、Pull Request、successful CI、explicit merge authorization、squash / linear result |
| Residual risk | Repository administrator can technically bypass the process；this is visible accepted pre-production risk, not misrepresented enforcement |
| Production / team trigger | Section 91.4 mandatory upgrade and protection activation |
| Rollback | revert this revision through a reviewed IDR revision；do not make the Repository public merely to obtain free protection |

This revision changes repository governance only。It does not change product Architecture、Domain ownership、Security / Privacy controls、Provider decisions、Figma authority or Work Package scope。

### 91.3 Mandatory Solo Development Control Contract

While the Section 91.1 scope remains true：

1. every Work Package uses one short-lived branch and one WSL Linux-filesystem worktree
2. every change reaches `main` through a Pull Request even though GitHub cannot enforce that rule server-side
3. every available owning GitHub Actions check must exist and pass before merge；a missing、pending、skipped or failed required-by-spec check blocks merge
4. the Owner performs and records an explicit self-review covering scope、diff、tests、generated files、secrets / PII、permissions、Tenant / Store scope、money / time and error / recovery behavior as applicable
5. ordinary direct push to `main`、force push and branch deletion remain prohibited by project policy；the audited Stage 0 seed is the existing one-time exception
6. any future break-glass action requires exact actor、timestamp、reason、scope、commit / diff、recovery and follow-up review evidence
7. Draft PR is used while implementation or evidence is incomplete；Ready status means the owning WP acceptance evidence is complete, not that independent review occurred
8. commit、push、PR update、Ready transition and merge remain separate external actions under Section 90；merge always requires explicit authorization
9. the Repository stays private；making it public solely to obtain no-cost Branch Protection is prohibited
10. documentation and handoff must state `Process-enforced / GitHub Free` and must never label `main` as protected or independently reviewed

These controls are auditable but not equivalent to server-side prevention。The Owner accepts that distinction for pre-production solo development only。

### 91.4 Mandatory Upgrade and Enforcement Trigger

The GitHub Free solo exception ends before the earliest of：

* a second Developer receives write access
* a second authorized human Reviewer becomes part of the delivery process
* any staging / production environment receives real Customer、Employee、merchant or Payment data
* any production deployment、live Payment、production Provider credential or public launch is enabled
* a direct-push、force-push、branch-deletion or unreviewed-merge process breach occurs
* a customer、investor、insurer、auditor or contract requires mechanically enforced controls

Before crossing that trigger，the Repository must move to GitHub Pro for the private personal model or GitHub Team / Enterprise for an organization model, or to another reviewed host with equivalent controls。Then the owner must：

1. enable Pull Request enforcement、required owning checks、conversation resolution、linear history、no force push and no deletion on `main`
2. add one independent approval、stale-approval dismissal and CODEOWNERS review for Architecture、Security、Payment、Tax、Privacy、Migration and Infrastructure paths when the second authorized Reviewer exists
3. disable administrator bypass where supported and document any unavoidable break-glass path
4. verify the rules through positive and negative evidence before production enablement

Production Gate remains unchanged：independent human review and mechanically enforced controls are mandatory before production PII / Payment / deployment enablement。

### 91.5 WP-0001 Governance Mapping

Section 77 is revised as follows：

| Section 77 item | Revision 1 interpretation |
| --- | --- |
| 77.6 item 10 | GitHub plan capability and Reviewer availability must be recorded；verified GitHub Free capability does not block solo pre-production WP-0001 under Section 91 |
| 77.10 item 9 | after `bootstrap / verify` passes，attempt / inspect protection capability；if unavailable, record exact evidence and activate the Section 91 process-control contract |
| 77.10 item 10 | no independent approval is configured or claimed while no second Reviewer exists |
| 77.12 item 12 | required-check server enforcement is `Not Available on verified plan / accepted solo exception`；successful check evidence plus explicit self-review is the current acceptance requirement |
| 77.13 | Handoff records plan / API evidence、solo status、successful workflow、self-review and absence of server-side enforcement |
| 77.19 | Specification `Complete`；Execution Definition of Ready `PASS`；Implementation `In Progress` until the authorized WP-0001 PR is integrated |

This mapping does not waive any code、security、test、WSL、lockfile、CI or evidence criterion in WP-0001。

### 91.6 Current WP-0001 Execution Evidence

Verified current state at this revision：

* private Repository created with one audited seed `main` commit containing no business code or Secret
* WP-0001 implemented on the accepted short-lived branch and WSL Linux-filesystem worktree
* exact Node、Corepack、pnpm and Turborepo pins、frozen install、lockfile reproducibility、empty task graph、JSON / YAML、LF / case、secret、source、license and vulnerability checks passed
* root and nested Agent-instruction discovery was verified；one incorrect inferred nested path was rejected and rechecked with exact read-only path evidence
* Draft Pull Request exists and its unique `bootstrap / verify` check completed successfully with read-only permissions
* Branch Protection and Repository Rulesets are unavailable on the verified GitHub Free private personal plan；no rule is falsely reported as active
* one authorized human Owner is the only collaborator；no independent approval is claimed
* no merge、WP-0002、deployment or Provider mutation has occurred

Current status：

| Dimension | Result |
| --- | --- |
| WP-0001 Specification Readiness | `PASS` |
| WP-0001 Execution Readiness | `PASS` under Section 91 solo pre-production scope |
| WP-0001 Implementation | `In Progress` — implementation and CI complete；PR integration separately unauthorized |
| GitHub server-side main protection | `Not Available / Accepted Solo Exception` |
| Independent review | `Not Available / Not Claimed` |
| Production readiness | `BLOCKED` by Section 91.4 until plan upgrade、mechanical enforcement and independent review |

### 91.7 Next Allowed Actions

After this revision is synchronized to the WP-0001 PR：

1. the Owner may separately authorize Draft → Ready transition and / or merge after reviewing the recorded evidence
2. WP-0002 remains a separate Work Package and requires separate authorization、branch / worktree、scope and verification
3. Figma UI Readiness materialization remains separately authorized and must complete before WP-0004 shared UI / feature UI implementation
4. no production / Provider action is allowed under the GitHub Free solo exception

Status：`Accepted、Decision Complete and Closed`。

---

## 92. Database Ownership Evidence Contract and WP-0013 Authority（Accepted）

### 92.1 Authority、Decision and Scope

Status：`Accepted and Closed`。

The BOP-RMS Owner accepted this decision on `2026-07-17` to remove the WP-0013 ambiguity without creating a business Module、database object、migration、ORM model、Repository、connection or seed。

This Section is `ADR-0029 — Database Ownership Evidence and Shared Infrastructure Authority` for Architecture ownership semantics and `IDR-0042 — Database Ownership Evidence Format and Staged Enforcement` for repository implementation mechanics。It supplements Sections 46.11、48.1–48.2、50.1–50.3、50.20、50.22–50.23、50.33–50.34、54.4 F00.2、56.4–56.5、56.8–56.14 and 58.1–58.5 without weakening their boundaries。

### 92.2 ADR-0029 — Business Ownership and Table Governance

Status：`Accepted`。

1. Module identity、Layer、package identity and directory are the WP-0010 / WP-0011 identity；no database tool defines a second identity。
2. `module.manifest.ts` `ownedDatabase.schema` and `ownedDatabase.tables` are the sole business schema / table ownership source。
3. Tables are unqualified lower snake_case names；the canonical target is `<schema>.<table>`。
4. Exact case is authoritative；case-fold collisions、duplicate schema owners and duplicate fully qualified table owners are invalid。
5. `schema = null` requires no tables、table governance or access evidence。
6. Business Modules cannot claim `platform_*` or `public`；an unowned business target fails closed。
7. Evidence describes but never creates、transfers or overrides Manifest ownership。

Each owned business table has exactly one governance record containing table、classification、writeOwner、allowedReadPatterns、retentionCategory and piiClassification。

Closed classifications：`aggregate-root | aggregate-child-entity | immutable-snapshot | append-only-record | configuration-version | relationship-assignment | projection-read-model | integration-record | technical-control-record`。

Closed retention categories：`operational | transactional | financial-compliance | audit-security | privacy-governance | ephemeral-technical`。

Table PII classification reuses the WP-0010 vocabulary exactly。A source business table writeOwner is the exact owning Module package。A Projection table may use a unique named Projection Builder writeOwner but that builder cannot write a source Aggregate table。

### 92.3 Shared Infrastructure Registry

Shared technical schemas are declared only in `tooling/database-ownership/platform-database.manifest.ts`：

| Schema | Technical owner | Allowed write authority |
| --- | --- | --- |
| `platform_core` | `shared-infrastructure/platform-core` | `migration-runner` |
| `platform_eventing` | `shared-infrastructure/eventing` | `eventing-infrastructure` |
| `platform_audit` | `shared-infrastructure/audit` | `audit-infrastructure` |
| `platform_jobs` | `shared-infrastructure/jobs` | `job-infrastructure` |
| `platform_projection` | `shared-infrastructure/projection` | an explicitly named `projection-builder` |
| `public` | no business table owner | WP-0020 approved extension / bootstrap DDL only |

`packages/database/*` owns common adapters and technical definitions only；it never owns a business fact。Shared schemas are not a write escape。Any `public.<table>` read or write is invalid。

### 92.4 Read and Write Invariants

* an owning Module may read and write its own table through its Repository
* `public-query-contract` is an Application call and never grants direct foreign-table access
* `owner-read-view` is owned、versioned and field-bounded by its source Module
* `approved-source-view` permits only a named Projection Builder or Reconciliation Job to read
* an `event-projection` reads an Event Feed and writes only its own Projection
* a Reconciliation Job reads approved fields and writes only its own result table
* non-owner `write` or `ddl` against a business table is invalid
* a Trigger cannot modify another Module business state
* schema、table、principal and read pattern must be literal；computed targets fail closed

### 92.5 IDR-0042 — Module Database Access Evidence

Status：`Accepted`。

A Module with database ownership or access evidence uses exactly `src/infrastructure/persistence/database-access.manifest.ts`。The file is pure literal and side-effect-free：

* `version`：constant `1`
* `module`：`moduleName`、`packageName`、`layer`
* `tables[]`：`table`、`classification`、`writeOwner { kind, id }`、`allowedReadPatterns[]`、`retentionCategory`、`piiClassification[]`
* `accesses[]`：`id`、`operation`、`mechanism`、`target { schema, table }`、`principal { kind, id }`、`readPattern`、repository-relative `source`

Closed operations：`read | write | ddl`。
Closed mechanisms：`repository | drizzle | raw-sql | migration | projection`。
Closed principal kinds：`module | projection-builder | reconciliation-job | shared-infrastructure`。
Closed read patterns：`owner-repository | public-query-contract | owner-read-view | event-projection | approved-source-view`。

Every table record matches one owning Manifest table；evidence cannot add ownership。`write` and `ddl` use `readPattern = null`。A direct database read uses a database read pattern；`public-query-contract` carries no foreign-table target。Unknown fields、non-literal expressions and duplicate set values are invalid。`source` is exact-case、Module-local and repository-relative；absolute、`..` escape or symlink resolution is invalid。

### 92.6 WP-0013 Staged Scan Boundary

WP-0013 scans only canonical Module roots、WP-0010 Manifest、package identity、access evidence、the platform registry and temporary synthetic fixtures。It does not connect to PostgreSQL or interpret real Drizzle data flow、arbitrary SQL or migration execution。

Until WP-0020 or the first authorized Persistence WP extends this contract, a real Module persistence implementation、Drizzle / `pg` use、raw SQL、migration SQL、Repository implementation、schema / model、connection or seed is `UNSUPPORTED_DATABASE_ASSET` and fails closed。Declaration validation is not runtime database-permission proof；real persistence cannot enter before its owning later gate。

WP-0014 owns Domain Layer ORM / Infrastructure dependency enforcement。WP-0020 owns Migration Runner、namespace and real migration syntax。WP-0021+ owns real schemas and tables。A business vertical slice owns real Module persistence only after those gates。

### 92.7 Deterministic Diagnostics and Exit Contract

Format：`<path>:<line> [<CODE>] <message>`。Ordering：normalized repository-relative path、line、code、message。

Required codes：`MODULE_IDENTITY_MISMATCH`、`DUPLICATE_SCHEMA_OWNER`、`DUPLICATE_TABLE_OWNER`、`RESERVED_SCHEMA_CLAIM`、`TABLE_METADATA_MISSING`、`DATABASE_TARGET_UNDECLARED`、`CROSS_MODULE_WRITE`、`UNDECLARED_OWNER_WRITE`、`INVALID_READ_PATTERN`、`DYNAMIC_DATABASE_TARGET`、`CASE_CONFLICT`、`PATH_ESCAPE`、`SYMLINK_PATH`、`UNSUPPORTED_DATABASE_ASSET`。

Exit codes：`0` no violation；`1` architecture violation；`2` usage、unreadable root or internal failure。Repeated runs over identical bytes produce identical output and exit behavior。

### 92.8 Governance、Rollback and Next Action

This decision introduces no Store、Provider、legal、production、Tenant、Payment、PII record or external validation fact。Actor、Permission、Tenant / Store scope、money、time、idempotency、Audit、Outbox、Inbox、migration、replay and runtime permission remain mandatory in their owning real persistence WPs。

Rollback requires a reviewed ADR / Handoff revision and IDR supersession；a WP brief cannot weaken this contract。The next allowed implementation action is WP-0013。After verified integration, the next allowed WP is WP-0014；WP-0020 and real persistence remain separately authorized。

Status：`Accepted、Decision Complete and Closed`。

---

## 93. Domain Layer Technology Dependency Boundary and WP-0014 Authority（Accepted）

### 93.1 Authority、Decision and Scope

Status：`Accepted and Closed`。

The BOP-RMS Owner accepted this decision on `2026-07-17` to close the executable static-enforcement contract for `WP-0014 — Domain Layer ORM / Infrastructure Test` without creating a real business Module、Domain object、Command、Event、Projection、Repository、ORM model、database asset、Provider adapter、API、UI or deployment artifact。

This Section is `ADR-0030 — Domain Layer Technology Dependency Boundary` for Architecture semantics and `IDR-0043 — Domain Dependency Evidence, Resolution and Diagnostics` for repository implementation mechanics。It supplements Sections 44.5.1、46.9–46.11、48.1–48.2、54.4 F00.2、56.4–56.6、56.8–56.14、56.20、56.39–56.40 and Sections 89–92 without weakening their boundaries。

WP-0014 owns only a deterministic static Architecture Test、its pure-literal dependency-classification evidence、synthetic temporary fixtures、focused tests and the separately authorized root / sole-workflow integration。It does not authorize a second Module identity、Layer、layout or export authority；a real Module or Domain behavior；persistence、migration or database work；a Provider integration；production、deployment or Figma work；or any later Work Package。

### 93.2 Canonical Module and Domain Scan Boundary

Module discovery、logical Module Name、Package Name、Layer、directory identity、Manifest dependency and public-export semantics are exactly the integrated WP-0010 / WP-0011 / WP-0012 contracts。WP-0014 must call or minimally refactor those contracts；it may not copy their regexes、rebuild discovery or establish a second package / layout authority。

For every discovered Canonical Module at `packages/bop/<moduleName>` or `packages/rms/<moduleName>`，the only Domain root is `<moduleRoot>/src/domain`。A missing Domain root is legal and contributes no source edge。A present Domain root must be a real exact-case directory beneath the Module root；a symlink、case conflict、path escape or unreadable directory fails closed。

The scan includes these file extensions exactly：`.ts`、`.tsx`、`.mts`、`.cts`、`.js`、`.jsx`、`.mjs` and `.cjs`。A declaration file such as `.d.ts` is included because its final extension is `.ts`。Dependency、cache、coverage and build-output directories excluded by the integrated WP-0012 scanner remain excluded；no new ignore authority is introduced。

Every included Domain file is parsed with the integrated TypeScript-aware WP-0012 source-reference parser。The edge set is closed to：

* static `import`
* `export ... from` and `export * from`
* `import type`
* TypeScript `import("specifier")` type expressions
* external `import = require("specifier")`
* one-string-literal dynamic `import("specifier")`
* one-string-literal `require("specifier")`

Type-only、declaration-only and re-export edges obey exactly the same Layer and technology boundary as runtime imports。A type reference does not make Infrastructure、ORM、HTTP、runtime I/O or Provider SDK safe for Domain code。

### 93.3 Domain-local and Layer Dependency Rules

A relative Domain reference is legal only when exact resolution remains inside the same Module's `src/domain/**`。The checker uses the owning Module's accepted TypeScript / NodeNext configuration and the filesystem bytes to resolve the literal target；the result must be exact-case、non-symlinked and contained by the Domain root。

Resolved same-Module targets are classified as follows：

* `src/application/**` → `DOMAIN_TO_APPLICATION`
* `src/infrastructure/**` → `DOMAIN_TO_INFRASTRUCTURE`
* `src/interfaces/**` → `DOMAIN_TO_INTERFACE`
* another same-Module path outside `src/domain/**` without explicit Domain-safe package evidence → `DOMAIN_UNCLASSIFIED_DEPENDENCY`

A relative reference into another Module is never converted into a Domain-safe dependency；WP-0012's cross-Module relative-import violation remains applicable。Absolute paths、parent escapes and any resolved target outside the owning Module fail closed。

A Canonical workspace package reference must first pass WP-0012 exact Module identity、Layer direction、`allowedSynchronousDependencies` and matching Manifest / `package.json.exports` public-subpath checks。Passing WP-0012 is necessary but not sufficient：the exact package and subpath must also be classified `domain-safe` by Section 93.4。No private Module path becomes legal through a Domain classification record。

### 93.4 ADR-0030 — Domain-safe Dependency Classification

Status：`Accepted`。

Domain code may depend on：

1. another file within the same exact `src/domain/**` root；or
2. an exact public package / subpath that has explicit `domain-safe` classification evidence and, for a Canonical Module, also passes every WP-0012 boundary。

WP-0014 materializes one pure-literal、side-effect-free registry at `tooling/domain-layer-boundary/domain-dependencies.manifest.ts`。The registry classifies technology safety only。It cannot create or change Module identity、Layer、Manifest dependencies、package dependencies、export maps、business ownership or public contracts。

Registry version `1` contains deterministic unique records with exactly：

* `packageName` — exact-case npm or workspace package identity
* `classification` — one closed value below
* `allowedSubpaths` — a deterministic set of exact package export subpaths；required and non-empty only for `domain-safe`

Closed classifications：

* `domain-safe`
* `orm-database`
* `http-transport`
* `provider-sdk`
* `runtime-io`

For `domain-safe`，only listed exact subpaths are allowed；`.` represents the package root。Wildcards、prefix grants、case folding and implicit transitive approval are prohibited。For a prohibited classification，the classification applies to the package root and all subpaths；`allowedSubpaths` must be empty。Duplicate、case-conflicting、unknown-field、non-literal or conflicting records are invalid。

Every non-Canonical bare package referenced from Domain must have exactly one registry classification。An unknown or unclassified package fails closed as `DOMAIN_UNCLASSIFIED_DEPENDENCY`；the checker never guesses safety from a package name、type-only usage、installed files or current transitive behavior。

Node `24.18.0` built-in modules are intrinsically `runtime-io` for this boundary。Both `node:<builtin>` and the exact bare built-in / built-in subpath names reported by the pinned Node runtime map to `DOMAIN_RUNTIME_IO_DEPENDENCY` and require no registry record。This rule intentionally forbids Domain coupling to process、filesystem、network、crypto、timers、workers and other Node runtime facilities；Domain-safe time、ID、Money and similar abstractions come through accepted pure contracts such as the future Common Kernel rather than direct runtime I/O。

Classification mapping is exact：

| Classification | Diagnostic |
| --- | --- |
| `domain-safe` exact allowed subpath | no WP-0014 violation |
| `orm-database` | `DOMAIN_ORM_DATABASE_DEPENDENCY` |
| `http-transport` | `DOMAIN_HTTP_DEPENDENCY` |
| `provider-sdk` | `DOMAIN_PROVIDER_SDK_DEPENDENCY` |
| `runtime-io` | `DOMAIN_RUNTIME_IO_DEPENDENCY` |
| missing classification or unlisted `domain-safe` subpath | `DOMAIN_UNCLASSIFIED_DEPENDENCY` |

### 93.5 IDR-0043 — Literal Resolution and Fail-closed Mechanics

Status：`Accepted`。

Each dependency edge must have one string-literal target。A computed、template、concatenated、identifier or otherwise non-literal dynamic `import()` / `require()` target produces `DOMAIN_DYNAMIC_REFERENCE`。The checker does not evaluate code or execute a Module to discover a target。

Resolution order is deterministic：

1. reject non-literal dynamic targets；
2. validate exact case、containment and symlink safety；
3. resolve relative / absolute form；
4. resolve an exact Module-local alias；
5. apply WP-0012 Canonical workspace-package resolution；
6. recognize the pinned Node built-in set；
7. apply the Section 93.4 classification registry to other bare packages。

Module-local aliases are supported only through these accepted, finite forms：

* `package.json#imports`：an exact non-pattern `#name` key whose value is one repository-relative string target；wildcard keys、condition objects、arrays、`null` and external / escaping targets fail resolution。
* TypeScript `compilerOptions.paths`：an exact non-pattern key with exactly one string target, resolved from the effective `baseUrl` in the owning Module's accepted `tsconfig.json` chain；wildcards、multiple candidates and escaping targets fail resolution。

After alias resolution, the final target is evaluated by the same Domain-local、Layer、workspace-package and technology-classification rules；an alias never hides a private path or changes its classification。Package export resolution uses only the exact WP-0012 Manifest / `package.json.exports` agreement。An unresolved literal、unsupported alias form、missing target or ambiguous result produces `DOMAIN_UNRESOLVED_REFERENCE`。

Path checks precede semantic classification。A literal or resolved target that escapes its allowed root produces `PATH_ESCAPE`；a symbolic component produces `SYMLINK_PATH`；an exact-case mismatch or case-fold collision produces `CASE_CONFLICT`。For one reference, the earliest applicable WP-0014 resolution / classification rule emits one primary WP-0014 diagnostic；reused WP-0012 discovery diagnostics may also be present for their independently owned invariant。

### 93.6 Closed Diagnostics and Exit Contract

WP-0014 diagnostic format is exactly：

`<path>:<line> [<CODE>] <message>`

`<path>` is normalized repository-relative POSIX form。Diagnostics are sorted by path、numeric line、code and message using deterministic English / byte-stable comparison。Identical repository and fixture bytes under the pinned runtime produce byte-identical diagnostics and stable stdout、stderr and exit behavior。

Closed WP-0014 codes：

* `DOMAIN_TO_APPLICATION`
* `DOMAIN_TO_INFRASTRUCTURE`
* `DOMAIN_TO_INTERFACE`
* `DOMAIN_ORM_DATABASE_DEPENDENCY`
* `DOMAIN_HTTP_DEPENDENCY`
* `DOMAIN_PROVIDER_SDK_DEPENDENCY`
* `DOMAIN_RUNTIME_IO_DEPENDENCY`
* `DOMAIN_UNCLASSIFIED_DEPENDENCY`
* `DOMAIN_DYNAMIC_REFERENCE`
* `DOMAIN_UNRESOLVED_REFERENCE`
* `CASE_CONFLICT`
* `PATH_ESCAPE`
* `SYMLINK_PATH`
* `UNREADABLE_DOMAIN_SOURCE`

Exit contract：

* `0` — scan completed with no violation；help also exits `0`
* `1` — an Architecture、classification、resolution、case、path or symlink violation exists
* `2` — invalid CLI usage、missing / unreadable repository root、an unreadable Domain root / source file or internal failure

An unreadable Domain root or source file emits the formatted `UNREADABLE_DOMAIN_SOURCE` diagnostic at line `1` when a repository-relative path can be established and exits `2`。Usage、missing repository root or an internal failure without a safe repository-relative source path uses the stable CLI prefix `Domain Layer Boundary error: <message>` and exits `2`。A successful repository scan writes one stable success line to stdout；violations write sorted diagnostics to stderr and no success line。

### 93.7 WP-0013 Coexistence and Security Boundary

Section 92 remains authoritative and independently enforced。WP-0014 does not weaken or replace `UNSUPPORTED_DATABASE_ASSET`：until WP-0020 or the first authorized Persistence WP extends the contract, real persistence、Drizzle / `pg`、raw SQL、migration、Repository、schema / model、connection and seed assets remain prohibited even when a dependency is classified。

A `domain-safe` record is not Provider approval、license approval、security review、data-classification evidence or permission to add a dependency。Adding or changing an actual package remains owned by its separately authorized WP and lockfile review。The registry must contain no credential、Token、endpoint、account、Store、Customer、Employee、payment、allergy / health or other real PII fact。

This decision changes no Actor、Permission、Tenant / Brand / Store scope、money、time、idempotency、Audit、Outbox、Inbox、transaction、retention、migration、replay or runtime permission behavior。Those remain mandatory in the first real owning Domain / persistence WP。

### 93.8 Synthetic Acceptance and Evidence Map

WP-0014 tests use only synthetic Modules and files under operating-system temporary roots。Every test records its root, remains within that root, rejects escape / symlink attempts without following them, and removes all created files and directories after success or failure。Committed fixtures contain no real business Module、Provider identifier、endpoint、credential、Store or PII。

The later WP-0014 brief must map at least these observed cases：

1. canonical identity / discovery / public-export reuse；
2. legal same-Domain relative imports across all supported file types；
3. legal `domain-safe` exact public package / subpath；
4. legal exact `package.json#imports` and TypeScript path aliases resolving back into Domain-safe targets；
5. all seven closed source-reference forms, including type-only and declaration-file cases；
6. Domain → Application、Infrastructure and Interface；
7. ORM / database、HTTP / transport、Provider SDK、Node runtime / I/O and unclassified dependencies；
8. private / unexported / undeclared workspace package edges；
9. computed dynamic targets and unresolved / ambiguous aliases；
10. exact-case conflict、path escape and symlink source / target；
11. unreadable root / Domain source、CLI help / invalid usage and `0 | 1 | 2` behavior；
12. repeated byte-identical diagnostics、stable sorting and complete temporary cleanup；
13. unchanged WP-0010–0013 checks、root verification and sole `bootstrap / verify` integration；
14. diff / security / scope review proving no real Module、business Domain、database、Provider、API、UI、deployment or later-WP artifact。

The minimum focused suite is five positive scenarios and twenty-five negative / boundary scenarios, with parameterized syntax cases counted by independently asserted input and expected result。Exact final counts and every command result are implementation evidence, not facts created by this documentation decision。

### 93.9 Governance、Rollback and Next Action

Changing Domain dependency semantics、the closed classification vocabulary、allowed alias forms、diagnostic codes or exit behavior requires an accepted Handoff / ADR / IDR revision；a WP brief or checker code cannot weaken this Section。A normal reviewed Git revert may remove a future checker implementation, but rollback of this Architecture decision requires an accepted ADR-0030 / IDR-0043 supersession。

This documentation closure does not authorize a WP-0014 brief、spec-index activation、branch、worktree、checker、package script、workflow change、dependency、lockfile change、commit、push、Pull Request or merge。The next allowed action is a separately authorized WP-0014 bounded brief and implementation preflight from an exact fresh baseline。

Status：`Accepted、Decision Complete and Closed`。
---

## 94. Migration Runner、Namespace Rules and WP-0020 Authority（Accepted）

### 94.1 Authority、Decision and Scope

Status：`Accepted and Closed`。

The BOP-RMS Owner accepted this decision on `2026-07-17` to authorize the bounded `WP-0020 — Migration Runner and Namespace Rules` implementation from exact baseline `da3f911bfa81f468308d7e4404f7642b3c2abb6a`。This Section is `ADR-0031 — Migration Catalog、Namespace and Bootstrap Ownership` for Architecture and data-ownership semantics and `IDR-0044 — Migration Execution、Integrity and Diagnostics` for implementation mechanics。

Section 94 supplements Sections 46.3、46.13–46.15、48.1–48.2、50.1–50.4、50.27–50.34、54.4 F00.3、56.4–56.5、56.10、56.13–56.20、56.32–56.40、58.1–58.5、87.7、89–93。Where migration bootstrap、real migration syntax or the WP-0013 staged boundary conflicts with older text，this higher accepted Section controls。

WP-0020 owns only the common Migration Runner、the root migration catalog and namespace registry、real migration-file syntax、integrity / ordering / lock / transaction / diagnostic enforcement、a minimal migration-history control plane、focused synthetic and isolated-database tests、and the authorized root / CI / guidance integration。It owns no business fact、Module persistence、Repository、ORM model、seed framework、application startup migration、production deployment or WP-0021 foundation data model。

### 94.2 ADR-0031 — Catalog、Namespace and Ownership

Status：`Accepted`。

`packages/database` owns common connection and migration infrastructure only；it never owns a business table or Domain fact。The only executable migration catalog is the repository-root `migrations/` directory。Module-local `migrations/` directories and migration SQL outside the root catalog are invalid。

The closed namespace directories are：

| Namespace | Directory |
| --- | --- |
| `0000` | `0000-platform` |
| `0100` | `0100-bop-common` |
| `0200` | `0200-bop-identity-tenancy` |
| `0300` | `0300-bop-governance` |
| `0400` | `0400-bop-operations` |
| `1000` | `1000-rms-store` |
| `1100` | `1100-rms-catalog` |
| `1200` | `1200-rms-pricing` |
| `1300` | `1300-rms-ordering` |
| `1400` | `1400-rms-payment` |
| `1500` | `1500-rms-kitchen` |
| `1600` | `1600-rms-device` |
| `1700` | `1700-rms-fulfillment` |
| `1800` | `1800-rms-reporting` |

`migrations/namespaces.json` materializes this exact version-`1` execution registry。It is not an ownership source。A platform migration owner must match the Section 92 shared-infrastructure registry；a business migration owner and schema / table must match the exact owning Module Manifest and its database evidence。Namespace placement cannot create、transfer or broaden ownership。

Migration names are `<namespace>_<sequence>_<action>_<object>.sql`。Namespace is the exact four-digit directory prefix；sequence is `001` through `999`；action is one closed token `create | alter | backfill | contract | index | constraint | seed`；object is lowercase snake_case。The global order is numeric `(namespace, sequence)`。Duplicate order、case-fold collision、symlink、path escape、directory / filename mismatch and a new pending migration below the applied high-water mark fail closed。

Each migration changes one owning schema and declares a strict ordered header：

```sql
-- bop-rms-migration: 1
-- owner: <exact platform technical owner or Module package>
-- schema: <exact owning schema>
-- phase: expand|migrate|contract
-- risk: low|medium|high
-- transaction: required
-- lock-timeout-ms: <positive bounded integer>
-- statement-timeout-ms: <positive bounded integer>
-- recovery: forward-fix|restore
```

SQL is UTF-8 without BOM、LF-only、final-newline terminated and fully schema-qualified。No template substitution、secret、connection value、psql meta-command、transaction command、`SET ROLE`、uncontrolled `search_path` or cross-owner DDL is allowed。

### 94.3 Minimal Bootstrap and WP-0021 Boundary

The target PostgreSQL database、database owner、dedicated migration role and production backup / recovery evidence are created outside the runner。The runner never creates or drops a database、login、role、runtime user or extension。

The first migration is exactly `migrations/0000-platform/0000_001_create_migration_history.sql`。It may create only the `platform_core` shell schema and `platform_core.migration_history`，then the runner records that same migration in the same transaction。This is the sole WP-0020 schema / table exception under Section 92 `migration-runner` authority。

The history table contains exact migration ID、namespace、sequence、relative path、owner、schema、lowercase SHA-256、runner contract version and PostgreSQL `timestamptz` applied instant，with primary / unique ordering constraints。It is append-only by contract；the runner exposes no history update、delete、repair、baseline or mark-applied path。

WP-0021 retains exclusive ownership of all remaining `platform_core` functional objects and the `platform_eventing`、`platform_audit`、`platform_jobs` and related Core / Eventing / Audit / Job schemas and tables。WP-0020 creates no Outbox、Inbox、Audit、Job、Projection、Tenant、Store or business object。

An empty target contains only PostgreSQL system schemas and an object-free `public` schema。A user schema、reserved BOP / RMS schema or partial / malformed history without a valid managed history contract is `MIGRATION_UNMANAGED_DATABASE`。The runner never adopts、baselines、repairs or force-marks an existing unmanaged database。

### 94.4 IDR-0044 — Integrity、Immutability and Drift

Status：`Accepted`。

The migration ID is the filename stem。SHA-256 is calculated over every exact file byte，including the header。The runner performs no newline、encoding or metadata normalization before hashing。Applied migration files are immutable：editing、renaming、deleting、reordering or changing metadata is drift。

Applying an existing ID with the same path、metadata and checksum is a successful no-op。A checksum mismatch、history row with no catalog file、catalog identity / path mismatch、duplicate order、applied sequence gap or pending migration below the applied high-water mark fails before new SQL executes。There is no `force`、`repair`、`baseline`、`mark-applied`、`ignore-checksum` or automatic retry option。

### 94.5 Advisory Lock、Transaction and Concurrent Runner Contract

All commands use one dedicated `pg` Client and the fixed two-integer advisory key `(1112494162, 1296648018)`，the ASCII values `BOPR` / `MIGR`。`apply` obtains `pg_try_advisory_lock` exclusively；`status` and `verify` obtain `pg_try_advisory_lock_shared`。Lock acquisition is fail-fast。The lock is explicitly released in `finally` and connection close remains the fail-safe release。

Each migration runs in its own transaction on that same Client。The runner starts `BEGIN`，sets transaction-local trusted `search_path` and finite `lock_timeout`、`statement_timeout` and `idle_in_transaction_session_timeout`，executes the exact SQL bytes，inserts the history row and commits。Any SQL or history failure rolls back both。A lost connection with uncertain commit state is never retried automatically and exits operationally；a later `verify` resolves the observed state。

Version `1` accepts transaction-safe migrations only。`CREATE INDEX CONCURRENTLY`、`REINDEX CONCURRENTLY` and any other command prohibited in a transaction block are `MIGRATION_TRANSACTION_UNSUPPORTED`。A real future need requires accepted IDR-0044 revision before syntax or transaction behavior changes。

### 94.6 CLI、Forward-fix and Exit Contract

The root CLI is：

```text
pnpm db:migrate -- status --env-file <path> [--json]
pnpm db:migrate -- verify --env-file <path> [--json]
pnpm db:migrate -- apply --env-file <path> --confirm-target <environment>:<database> [--json]
pnpm db:migrate -- --help
```

`status` is observational and returns success for a safely observed `uninitialized` or `pending` state。`verify` succeeds only when catalog and history are fully applied and drift-free。`apply` is the only mutation command。There is no down / rollback command。An unapplied failed migration rolls back its transaction；an applied production change is corrected by a new reviewed forward migration，or by an independently approved restore / compensation procedure with its own evidence。

Exit codes are closed：`0` success / help、`1` deterministic catalog / ownership / state / lock / migration violation、`2` invalid usage、unreadable root / environment、unsafe connection configuration、connect / authentication / TLS failure、uncertain lost connection or internal failure。

Diagnostics are repository-relative and deterministic：`<path>:<line>:<column> [<CODE>] <message>` for attributable catalog errors、`migration:<id> [<CODE>] <message>` for execution state and `Migration Runner error: [<CODE>] <message>` otherwise。Ordering is path、numeric line、numeric column、code、message。JSON uses the same order and stable keys。

Closed codes：`MIGRATION_NAMESPACE_UNKNOWN`、`MIGRATION_FILENAME_INVALID`、`MIGRATION_METADATA_INVALID`、`MIGRATION_DUPLICATE_ORDER`、`MIGRATION_OWNER_MISMATCH`、`MIGRATION_SCHEMA_MISMATCH`、`CASE_CONFLICT`、`PATH_ESCAPE`、`SYMLINK_PATH`、`UNREADABLE_MIGRATION`、`MIGRATION_BOOTSTRAP_MISSING`、`MIGRATION_UNMANAGED_DATABASE`、`MIGRATION_CHECKSUM_MISMATCH`、`MIGRATION_HISTORY_ORPHANED`、`MIGRATION_OUT_OF_ORDER`、`MIGRATION_PENDING`、`MIGRATION_LOCK_BUSY`、`MIGRATION_TRANSACTION_UNSUPPORTED`、`MIGRATION_APPLY_FAILED`、`MIGRATION_USAGE`、`MIGRATION_ROOT_UNREADABLE`、`MIGRATION_CONFIG_UNSAFE`、`MIGRATION_CONNECTION_FAILED`、`MIGRATION_CONNECTION_LOST`、`MIGRATION_INTERNAL`。

### 94.7 Environment、Connection and Logging Security

WP-0020 extends the existing non-secret environment contract with explicit environment、PostgreSQL host、`disable | verify-full` SSL mode and CA-file reference。Password material remains in a real、non-symlink、current-user-owned `0600` file under the accepted secret boundary。The CLI rejects a password / DSN argument and does not inherit `DATABASE_URL` or `PGPASSWORD` as an alternative authority。

SSL disable is legal only for loopback local / test connections。A non-loopback、staging or production connection requires CA and hostname verification。`apply` requires the exact non-secret target confirmation and verifies database、configured role and server properties before DDL。Application processes never call the runner on startup；runtime roles cannot create schema、extension or table。

Runner output and errors contain only safe migration identity、diagnostic code、SQLSTATE class、duration / run identifier and bounded state。They never contain password、DSN、connection string、SQL body、bind value、full sensitive server detail、Store、Customer、Employee、payment、allergy / health or other PII fact。

### 94.8 WP-0013 Staged Coexistence

WP-0020 extends Section 92 rather than removing it。The exact accepted exceptions are the root catalog syntax、the first runner-owned bootstrap migration and `packages/database` use of the accepted `pg` driver。A Module-local migration、Module persistence / Repository / schema / model、Module `pg` / Drizzle / raw-SQL connection or seed remains `UNSUPPORTED_DATABASE_ASSET` until its owning later Persistence WP adds both accepted ownership evidence and runtime permission tests。

The namespace registry、migration header and SQL directory never become a second Module、schema、table or write-owner authority。Existing WP-0010–0014 identity、import、database-ownership and Domain-dependency checks remain independently enforced。

### 94.9 Synthetic、Isolated Acceptance and Security Evidence

Static catalog / path / metadata tests use only synthetic operating-system temporary roots and completely remove them after success or failure。Runtime integration tests use unique WP-0020-owned temporary PostgreSQL databases，never a shared fixed database or real business fixture。The focused harness may create and drop only its exact generated test database names；it is not the reusable seed / parallel fixture framework owned by WP-0024。

Observed evidence must cover empty bootstrap、repeat no-op、byte mutation、rename / deletion / orphan / out-of-order、transaction rollback without history、exclusive / shared lock contention、status / verify / apply exits、unsafe target / TLS / secret configuration、redacted errors、unmanaged-database refusal、WP-0013 exact exceptions and continued Module fail-closed behavior。No real Tenant、Brand、Store、Provider、Customer、Employee、payment、allergy / health、credential or production fact is used。

### 94.10 Governance、Rollback and Next Action

Changing namespace values、ownership source、bootstrap objects、checksum bytes、history mutability、advisory key、transaction policy、CLI commands、diagnostics or exits requires accepted ADR-0031 / IDR-0044 / Handoff supersession。A normal reviewed Git revert may remove an unintegrated WP-0020 implementation；an integrated database change follows forward-fix or approved restore rather than history rewrite。

The Owner separately authorized the bounded WP-0020 branch、brief、implementation、accepted `pg` dependency / lockfile change、local isolated PostgreSQL verification and root / sole-workflow integration on `2026-07-17`。Commit、push、Pull Request、Ready、merge、deployment、production connection and Provider mutation remain unauthorized until separately granted。

After verified WP-0020 integration，the next allowed database Work Package is separately authorized WP-0021 Core / Eventing / Audit / Job foundation schemas。This Section does not activate WP-0021。

Status：`Accepted、Decision Complete and Closed`。
---

## 95. Core / Eventing / Audit / Job Foundation Schema Authority and WP-0021（Accepted）

### 95.1 Authority、scope and supersession

Status：`Accepted and Closed`。

The BOP-RMS Owner accepted this documentation decision on `2026-07-20` from exact baseline `main@44b79f4385eb2f16ac9c697ec33291a60b3bdb66`。This Section is `ADR-0032 — Platform Foundation Schema and Runtime Privilege Boundary` for long-lived ownership / privilege semantics and `IDR-0045 — Foundation Schema Bootstrap, ACL and Verification` for implementation mechanics。

Section 95 supplements Sections 46、48、50、54.4 F00.3–F00.5、56、58、80、87 and 92–94。Where older text suggests WP-0021 creates functional Core / Eventing / Audit / Job tables，this higher accepted Section narrows WP-0021 to schema-only foundation work。Section 92 remains the ownership authority；Section 93 remains the Domain dependency authority；Section 94 remains the migration catalog、immutability、runner and staged-enforcement authority。

WP-0021 may only harden the existing `platform_core` schema ACL and create empty `platform_eventing`、`platform_audit` and `platform_jobs` schemas with their owner、default-deny ACL、verification and isolated tests。It creates zero new functional tables。`platform_core.migration_history` remains the sole existing table and is not altered except for schema-level ACL hardening that preserves WP-0020 operation。

### 95.2 Exact decision matrix

| Decision | Accepted position | Explicit non-goal / future owner |
| --- | --- | --- |
| WP shape | schema-only foundation | no Eventing、Audit、Job or idempotency runtime |
| Existing Core | harden schema ACL；preserve `migration_history` | no new `platform_core` table |
| New schemas | create empty `platform_eventing`、`platform_audit`、`platform_jobs` | no object inside them |
| Projection | absent | `platform_projection` awaits an explicitly authorized Projection WP |
| Roles | use the externally established dedicated migration role as owner | no role、login、membership or credential creation |
| Public access | revoke `USAGE` and `CREATE` on all four schemas；remove dangerous default privileges | no PUBLIC grant |
| Runtime access | none granted in advance | each later owning WP grants only required object privileges |
| Tenant isolation | all future Brand / Store tables require RLS defense in depth | no RLS policy because WP-0021 creates no tenant-owned table |
| Runner | unchanged `status | verify | apply`、checksum、transaction、lock、diagnostic and exit contract | no runner extension or startup migration |
| Verifier | independent read-only inspection only | no DDL、repair、adopt、baseline or mutation |
| Recovery | new forward-fix migration or independently approved restore | no down、force、repair、mark-applied or applied-file edit |

### 95.3 Schema and object ownership matrix

| Schema / object | Technical owner | WP-0021 action | Allowed future write authority |
| --- | --- | --- | --- |
| `platform_core` | `shared-infrastructure/platform-core` | alter schema ACL only | migration role until a later object-owning WP grants narrower authority |
| `platform_core.migration_history` | WP-0020 migration control plane | preserve exact table、owner、shape and append-only contract | WP-0020 Migration Runner only |
| `platform_eventing` | `shared-infrastructure/eventing` | create empty schema | later Eventing infrastructure objects only |
| `platform_audit` | `shared-infrastructure/audit` | create empty schema | later Audit infrastructure objects only |
| `platform_jobs` | `shared-infrastructure/jobs` | create empty schema | later Job infrastructure objects only |
| `platform_projection` | `shared-infrastructure/projection` registry reservation | no schema、object or grant | future explicitly authorized Projection WP |

Future object ownership is exact：Outbox is WP-0030；Inbox / Consumer Idempotency is WP-0032；Job / Retry / Dead-letter is WP-0033；Audit Record is WP-0042；Audit integrity / archive is WP-0046；Projection persistence belongs to a future explicitly authorized Projection WP。`platform_core.idempotency_record` is not created；it is a Future Trigger that must close before the first API Command Idempotency implementation。

### 95.4 PostgreSQL permission matrix

| Principal | Four foundation schemas | Existing / future objects | Default privileges |
| --- | --- | --- | --- |
| dedicated migration role / schema owner | owns schemas；may perform only reviewed migration DDL | retains required ownership of `migration_history` and future migration-created objects | owner defaults are explicitly hardened |
| `PUBLIC` | no `USAGE`；no `CREATE` | no table、sequence、function or type privilege | revoke dangerous table、sequence、function and type defaults |
| application runtime | no WP-0021 grant | none | none |
| worker runtime | no WP-0021 grant | none | none |
| reporting / projection runtime | no WP-0021 grant | none | none |
| later object-owning runtime | absent until its owning WP | least-privilege per object after accepted ownership / permission evidence | no broad schema-wide future grant |

The migration role is configured and authenticated outside the migration catalog。WP-0021 does not create PostgreSQL roles、logins or memberships and never embeds a role name in SQL as an invented production fact；the migration executes as the owner and verifies `current_user` through the accepted Section 94 connection contract。

### 95.5 Migration file and order contract

| Global order | Required future file | Owner | Schema | Permitted effect |
| --- | --- | --- | --- | --- |
| existing | `0000_001_create_migration_history.sql` | `shared-infrastructure/platform-core` | `platform_core` | unchanged WP-0020 bootstrap |
| next | `0000_002_alter_platform_core.sql` | `shared-infrastructure/platform-core` | `platform_core` | schema ACL / default privilege hardening only |
| next | `0000_003_create_platform_eventing.sql` | `shared-infrastructure/eventing` | `platform_eventing` | empty schema、owner and ACL only |
| next | `0000_004_create_platform_audit.sql` | `shared-infrastructure/audit` | `platform_audit` | empty schema、owner and ACL only |
| next | `0000_005_create_platform_jobs.sql` | `shared-infrastructure/jobs` | `platform_jobs` | empty schema、owner and ACL only |

These names and order are the implementation-round contract，not files created by this documentation closure。Each future file obeys Section 94 headers、one-schema ownership、exact bytes、full qualification、per-migration transaction and immutable history。No file creates a table、view、materialized view、sequence、function、trigger、extension、role、login、policy or seed。

### 95.6 IDR-0045 — Foundation Schema Bootstrap, ACL and Verification

Status：`Accepted`。

The implementation round may retain a separate `foundation` verifier only as a read-only tool。It uses the Section 94 environment、password-file、TLS、target-identity and redaction rules but does not become a fourth Migration Runner command and does not modify `status | verify | apply`。

The verifier checks the exact expected schema set、schema owner equal to the configured dedicated migration role、PUBLIC schema privileges、owner default privileges、the exact permitted `platform_core.migration_history` object and the absence of every other user object in the four schemas。It also reports a present `platform_projection` or other unexpected `platform_*` schema as unexpected。It performs catalog reads only and executes no DDL、grant、revoke、repair、adopt、baseline or mark-applied action。

Diagnostic format：

`foundation:<schema-or-object> [<CODE>] <message>`

Sort by normalized schema / object identity、code、message。Closed codes：

* `FOUNDATION_SCHEMA_MISSING`
* `FOUNDATION_SCHEMA_UNEXPECTED`
* `FOUNDATION_SCHEMA_OWNER_MISMATCH`
* `FOUNDATION_SCHEMA_PUBLIC_PRIVILEGE`
* `FOUNDATION_OBJECT_UNEXPECTED`
* `FOUNDATION_CORE_HISTORY_MISSING`
* `FOUNDATION_CORE_OBJECT_UNEXPECTED`
* `FOUNDATION_CONFIG_UNSAFE`
* `FOUNDATION_CONNECTION_FAILED`
* `FOUNDATION_INTERNAL`

Exit `0` means compliant state or help；`1` means schema、owner、ACL or unexpected-object violation；`2` means usage、configuration、TLS、connection、catalog-read or internal failure。Successful output contains only bounded non-secret identities；errors never expose password、DSN、SQL body、bind value、unrestricted server detail or business / PII data。

### 95.7 Transaction、concurrency、failure and environment boundary

Each migration remains a separate Section 94 transaction under the same exclusive advisory lock。A failed schema or ACL statement rolls back that migration and its history insert。Concurrent apply、shared status / verify behavior、uncertain connection loss and no-automatic-retry semantics remain unchanged。The foundation verifier is observational and uses the shared lock / connection discipline selected during implementation without blocking or bypassing the runner contract。

Local / test may disable TLS only on loopback。Non-loopback、staging and production require `verify-full` with a safe CA reference。Secrets remain in the accepted current-user-owned `0600` non-symlink password file；no password / DSN argument、`DATABASE_URL` or `PGPASSWORD` authority is added。No staging / production connection is authorized by this documentation closure。

An empty managed target is first bootstrapped by WP-0020 and then receives the four ordered WP-0021 migrations。An unmanaged database、partial or malformed history、pre-existing unexpected foundation schema / object、wrong owner or unsafe ACL fails closed；WP-0021 never adopts or repairs it。An existing expected schema is not silently accepted as an idempotent shortcut unless its applied immutable migration history proves the exact state。

Recovery is a new reviewed forward-fix migration or an independently approved restore from known evidence。Applied migration bytes and history are never edited or deleted；down、repair、baseline、mark-applied、force and checksum bypass remain prohibited。

### 95.8 Synthetic and isolated PostgreSQL evidence

Static fixtures use only operating-system temporary roots and clean up after success and failure。Runtime evidence uses unique WP-0021-owned isolated PostgreSQL databases created by the focused harness under separately authorized local-test authority；it never uses a shared developer database、real Store / Tenant data or staging / production。

The implementation acceptance suite must observe：empty WP-0020 bootstrap followed by exact four-schema state；zero new functional tables；exact owner and default-deny ACL；PUBLIC denial；no runtime grants；absence of `platform_projection`；repeat no-op；transaction rollback；unexpected schema / object、wrong owner and unsafe privilege diagnostics；deterministic sorting and `0 | 1 | 2` exits；continued WP-0013 staged fail-closed behavior；and complete cleanup。RLS is asserted as a future owning-table requirement，not fabricated as a WP-0021 policy test。

### 95.9 Acceptance and evidence map

1. **Authority / baseline** — exact fresh baseline、Canonical 0.5.7、Section 95、ADR-0032 and IDR-0045 are recorded。
2. **Schema boundary** — only four expected schemas exist；three are empty and `platform_core` contains only exact `migration_history`。
3. **Ownership / ACL** — exact owners、PUBLIC denial and dangerous default-privilege removal are catalog-observed。
4. **Zero functional objects** — no Outbox、Inbox、Dead Letter、Audit Record、Job、Lease、Execution、Idempotency Record、Projection or other object exists。
5. **Runner compatibility** — Section 94 catalog、checksum、transaction、lock、diagnostics、commands and exits remain unchanged。
6. **Verifier behavior** — read-only queries、closed diagnostics、deterministic order、redaction and exits `0 | 1 | 2` are tested。
7. **Failure / recovery** — rollback、unmanaged refusal、forward-fix and separately approved restore boundaries are proven without history mutation。
8. **Isolation / security** — synthetic fixtures、unique local databases、TLS / secret rules、no runtime grants and cleanup are observed。
9. **Staged enforcement** — exact root platform migrations pass while Module persistence remains fail-closed under WP-0013。
10. **Scope** — final diff contains only authorized foundation implementation / tests / documentation and no later-WP、Provider、production、API / UI or dependency churn unless separately authorized。

### 95.10 External Evidence、Future Triggers and implementation authorization

External Evidence remains：actual production database and dedicated migration role、role membership review、TLS certificate / CA、RDS compatibility、backup / restore drill、staging migration result、production change approval and real runtime-role design。None is claimed by documentation or synthetic tests。

Future Triggers：first API Command Idempotency implementation must first close owner、schema/table、retention、expiry、concurrency、permission and runtime grants for `platform_core.idempotency_record`；each WP-0030–0033、WP-0042、WP-0046 and Projection persistence implementation must separately close its object DDL、classification、RLS where tenant-owned、runtime role、grant、retention、append-only / replay and integration evidence。WP-0022 owns UUID、Money、Time and Tenant Scope database helpers and does not inherit permission to add them here。

The implementation round requires exact Owner authorization for：baseline SHA and fresh origin；one WP / branch or worktree；the four named migration files；any independent read-only verifier and its repository integration；local isolated PostgreSQL database create / drop scope；affected documentation / tests；whether dependencies or lockfile may change（default no）；and external actions including commit、push、PR、Ready、merge、deploy、staging / production connection（default all prohibited）。Without that checklist，only documentation review is allowed。

This documentation closure authorizes no branch、worktree、migration file、database mutation、verifier implementation、dependency、lockfile、workflow、commit、push、PR、Ready、merge、deploy or external connection。

Status：`Accepted、Decision Complete and Closed`。

---

## 96. UUID / Money / Time / Tenant Scope Database Helper Authority and WP-0022（Accepted）

### 96.1 Authority、supersession and complete decision

Status：`Accepted and Closed`。The Owner accepted this decision on `2026-07-21` from exact fresh `origin/main@ea274863cc10018b96034a98b91f589c9e8a9f91`。This Section is `ADR-0033 — Database Helper Type and Tenant Context Boundary` and `IDR-0046 — Helper DDL, ACL and Verification`。

Section 96 adopts the complete exact object、schema、owner、ACL、runtime grant、migration、verifier、test、recovery、dependency、non-goal and External Evidence contract recorded in Sections 90.22–90.23，and makes that accepted detail authoritative for WP-0022。It supplements Sections 50、87 and 92–95 and supersedes older implications that WP-0022 owns business calculation、Business Date policy、table-specific constraint / index / RLS or advance runtime authority。

The executable boundary is closed：one default-denied migration-owner-owned `platform_helpers` technical schema；the exact UUID validation、Money storage-domain、IANA / local-time-domain and transaction-local Tenant Context reader objects enumerated in Section 90.22；four exact ordered `0000_006` through `0000_009` migrations；invoker rights、fixed safe resolution、no PUBLIC or advance runtime grant；independent read-only verification and synthetic / isolated evidence。No business table、fact、role、login、extension、seed、UUID generator / default、rounding、Business Date resolver、authorization or table-specific RLS is included。

Status：`Accepted、Decision Complete and Closed`。

---

## 97. Seed、Fixture and Isolated Test Database Framework Authority and WP-0024（Accepted）

### 97.1 Authority、supersession and complete decision

Status：`Accepted and Closed`。The Owner accepted this decision on `2026-07-21` from exact fresh `origin/main@f404d3cdc6f6ec099046e329cd10d348c55a783b`。This Section is `ADR-0034 — Test Fixture and Isolated Database Ownership Boundary` and `IDR-0047 — Parallel Resource Lifecycle、Diagnostics and Cleanup`。

Section 97 adopts the complete exact owner、API、bootstrap、fixture、name、port、process、lease、parallelism、secret、logging、cleanup、signal、timeout、diagnostic、exit、failure-injection、residue、allowlist、acceptance、rollback、External Evidence and non-goal contract recorded in Sections 90.21.1–90.21.7 and makes that accepted detail authoritative for WP-0024。It supplements Sections 50、54.4 F00.3、87 and 92–96。Where an older focused WP-0020–0023 test harness conflicts with the reusable lifecycle mechanics，this higher accepted Section controls without changing the evidence or production contracts owned by those WPs。

The executable boundary is closed：one test-only lifecycle owner and API；unchanged WP-0020 migration-runner reuse；explicit synthetic-only fixture values；unique parallel-safe Compose、database、port、lease and temporary-root ownership；bounded and idempotent success、failure、SIGINT、SIGTERM and timeout cleanup；closed diagnostics and exits；acceptance-only failure injection；redacted logs；exact owned-resource residue detection；the exact Section 90.21.7 implementation allowlist；and no dependency / lockfile change。

No business seed、Tenant / Brand / Store fact、production / staging account or connection、Provider data or mutation、migration、role、login、grant、application persistence abstraction、backup / restore tooling、deployment、dependency upgrade、generic Docker orchestration or unowned-resource cleanup is included。

Status：`Accepted、Decision Complete and Closed`。
