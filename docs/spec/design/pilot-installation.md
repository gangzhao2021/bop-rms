# DEC-PILOT-INSTALLATION — Pilot 门店安装签发、订单工作流发布与有效期续期

状态：**Accepted（协调人按商用原则决定，2026-10-20；Owner 可推翻）**。执行工作包：[WP-2423](../work-packages/WP-2423.md) 状态第 6 项。
Owner 指示（2026-10-20）："先把接口都做好"。上位：AGENTS.md"商用保真""运营连续性""超时前提醒"；
[DEC-PILOT-RUNTIME-ENVIRONMENT](pilot-runtime-environment.md)"仍阻止真实 Pilot 启动"第 2、3 项；
[DEC-PERM-CATALOG](permission-catalog-and-store-roles.md)（门店角色 prepare/sign/apply）；[DEC-ORDER-CANCELLATION-PILOT](order-cancellation-pilot.md)
（`workflow-release-install`）；[DEC-PILOT-ALERTS-BACKUP](pilot-alerts-backup.md)；[托管接口](pilot-hosting-integrations.md)（受管密钥）。
操作步骤：[单店试点运行手册"切换到 Pilot 门店"](../../runbooks/single-store-pilot.md#switching-a-store-to-pilot-dec-pilot-runtime-environment)。

## 问题

Pilot 门店进程的守卫已收尾，但 v15 的运行目录（档案与有效期、菜单、库存、任务队列、各 worker 配置、日结覆盖）和取餐/堂食/加单
工作流的发布与绑定文件都是 WP-2402 时期手工做的（生成脚本在已删除的 `.local/pilot-v7/`），仓库只有测试种子。真实门店不能靠手工文件开业：
文件引用必须是数据库里在用的已发布事实，签发要有审批、审计、可重放，续期要有 Owner 批准且到期前提醒。

## 决定

1. **签发工具 `tooling/environment/pilot-installation-issue.mjs`，沿用门店角色的两人流程**：`keygen`（审批人一次）→ `prepare`（运营）→
   `sign`（独立平台审批人，Ed25519，信任文件用途 `PILOT_INSTALLATION`，审批人不得是运营者，1–72 小时有效）→ `apply`。`apply` 默认是演练
   （读取并核对、回滚、不写文件）；只有 `--confirm-target <环境>:<数据库>` 与迁移授权文件一致才写入。计划含 Owner 的批准原话
   （`--owner-approved-by`/`--owner-approval`/`--reason`），计划摘要进入审批签名与平台审计（用途 `PILOT_INSTALLATION`，动作
   `PILOT_INSTALLATION_ISSUED`/`…_RENEWED`）。只在 Pilot 进程（`NODE_ENV=production`、`BOP_PILOT_ENVIRONMENT=Pilot`）运行；输出只有引用、
   摘要、文件名与数量，从不打印密码、密钥或个人信息。
2. **事实来自数据库，经各自的所有者读取**（`prepare` 一个回滚事务；`apply` 在写入事务内重读，必须与计划一致，否则 `facts-changed-since-prepare`）：
   门店角色已由 `store-role-provisioning` 为同一 Tenant 开通且有 Owner 模板；门店记录与 IANA 时区（Tenant 所有者源）；在用的已发布门店配置
   与其批准的上线关口（要求码即档案 `operating.liveGateRequirementCodes`，任何 `SYNTHETIC_` 码拒绝）；当前发布证明（发布、审批、摘要、关口）；
   顾客点单的唯一当前菜单（`CUSTOMER_PWA`/`PICKUP` 当前发布；多个时须 `--menu`）；门店唯一在用库存点（多个取默认，否则 `--stock-site`）；
   最近一个已结束营业日的结算窗口（与日结 worker 同一读取，逐版本验证）。没有已结束营业日即拒绝（`no-closed-business-day`）：
   门店设置须至少提前一个营业日发布。
3. **有效期窗口从第一个日结营业日开始**：`binding.validFrom` = 首个结算窗口起点（已结束的营业日），使日结 worker 能在绑定内读取该日；
   `validUntil` 由 Owner 批准，单次最长 92 天。`createdAt` 为签发时刻。
4. **没有所有者表的安装身份由操作引用派生**（UUIDv7，同计划重放完全一致）：公开门店引用与查找证据、Provider 账户引用、付款准入开关、
   购物车策略版本（空闲 1 小时、最长 1 天，同 v15）、店长任务队列与堂食异常策略（1 小时内处理，同 v15）、取餐柜台设备与位置、
   业务/厨房 worker 的系统参与者。续期从不改变它们。
5. **签发的文件**（均 `environment: "Pilot"`、0600，档案最后写）：`installation.json`、`internal-test-menu.json`、`internal-test-inventory.json`、
   `internal-test-task-queue.json`、`internal-test-receipt-template.json`（仅签发闸门；实际模板是已发布配置的 `receiptReference`）、
   `customer-runtime.json`（`diningTableFiles: []`）、`merchant-runtime.json`（标准退款角色映射）、三个 worker 文件、`daily-settlement-coverage.json`、
   `internal-test-profile.json`。从不签发：DEMO 名单、DEMO 桌台、本地密钥/QR 密钥/TOTP、模拟服务商库——目录里出现任何一个都拒绝（`internal-test-file-present`）。
   文件名保留 `internal-test-` 前缀（运行时加载器与备份清单不改）；已有不同内容的文件不覆盖（`installation-exists`，改用续期）。
6. **服务数据库角色由签发创建**：api/worker 为 `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION`；新角色生成随机密码，只写入
   `<runtime>/<service>-password`（0600），服务器只收到 SCRAM-SHA-256 校验值；已存在的角色只重新收紧（缺密码文件则拒绝）。同一事务应用渲染的
   试点 ACL（`pilot-acl-matrix.json` + `pilot-acl-additions.json`，计划含其摘要）。迁移授权须有 CREATEROLE。本决定无新授权、无迁移。
7. **订单工作流纳入平台发布**：`platform-workflows.mjs` 新增 `OrderFulfillmentPickup`、`OrderFulfillmentDineIn`（同一用途 `OrderFulfillment`，
   已付结果要求两者一致）与 `OrderFulfillmentAdditionalRound`（用途 `OrderFulfillmentAdditionalRound`，堂食；已在进行/待取的单在加单付款后保持阶段）。
   迁移自测试种子的转移：`SubmitOrder`（`order.submit`，预留库存）、各阶段 `CreatePaymentIntent`（`payment.intent.create`，阶段不变）、`Accept`
   （`order.accept`）、`ReleasePaidOrder`（`order.release`）、`FulfillOrder`（`order.fulfill`）。规则引用是仓库常量（规则语义由所有者组合执行，
   不是数据行）。`workflow-release-install --workflow <名> --runtime-environment Pilot --output <runtime>/internal-test-workflow-<Pickup|DineIn|AdditionalRelease>.json`
   发布（品牌范围、不过期、独立审批人、可重放）并写出绑定文件（已发布版本与转移引用，0600 原子替换）；目录已有档案时环境、数据库与门店
   必须一致（`WORKFLOW_RELEASE_PROFILE_MISMATCH`）。`new-operation` 打印新的操作引用。
8. **Pilot 续期**：`prepare-renewal` 只移动有效期（档案 `binding.validUntil`、任务队列及其异常策略的 `effectiveUntil`），新结束点必须晚于现结束点、
   最多比当前时刻晚 92 天；重读门店事实，关口要求码变化则拒绝（`launch-gate-changed`）。需 Owner 书面批准原话与平台签名；`apply` 校验两文件仍为
   准备时的内容，保留旧文件硬链接与 `record.json`，追加 `pilot-installation-log.jsonl`，写平台审计。InternalTest 续期工具保持仅 InternalTest。
9. **到期前提醒**：运维监视器新增告警 `installation.validity`——读档案 `binding.validUntil`（纯文件读取，不依赖数据库），剩余 14 天内"Today"、
   3 天内或已过期"Urgent"，首页"Store system"卡与外发通道显示："The store's ordering setup expires soon"。InternalTest 同样适用（v15 11-14 到期）。
10. **启动检查新增可满足缺口 `Installation`**：Pilot 门店启动时 `checkPilotInstallation` 用运行时加载器读全部文件、三个订单工作流与取消工作流绑定、
    两个服务密码文件，无 InternalTest 专用文件，且有效期在窗口内；否则逐条 `PILOT_NOT_READY Installation: …` 并保留缺口。缺口顺序：
    PaymentProvider、StaffLogin、Secrets、Tls、Installation、PricingCurrencyMetadata。
11. **修正（清点时发现）**：①Pilot 下订单找回链接的胡椒与限流密钥原先只从 InternalTest 密钥文件派生，任何组合订单消息的 Pilot 服务都会启动失败；
    改为受管密钥 `order-recovery-pepper-v<N>`（可轮换）与 `order-recovery-abuse-key`。②`pilot-supervisor-control` 主机启动自 `c5f7e437` 起失败
    （监督进程导入 TypeScript 包而子进程是无加载器的 node）；改为与容器入口相同的 `--import ./tooling/environment/register-workspace-typescript.mjs`，
    身份核对同步。

## 运营连续性

签发与续期都在计划内更新窗口离线完成，不改变各流程的故障处置。续期遗漏的后果（顾客无法点单、员工失去权限）由 14 天提醒与首页卡覆盖；
已过期时同一续期流程即可恢复（不需要重装），旧文件可从记录目录恢复。数据库或主机不可用时签发拒绝且不写任何文件；中断后重跑同一计划完成剩余部分。

## 验证

单元：`pilot-installation-issue`（参数、计划与文件、Pilot 进程中运行时加载器读取签发文件、启动检查、审批签名、续期、SCRAM）、
`workflow-release-install`（三个订单发布与绑定文件）、`pilot-supervisor-readiness`、`pilot-alerts`、`pilot-ops`、`pilot-secrets`、
`pilot-supervisor-control`（Linux 镜像）。

隔离 PostgreSQL（`TMPDIR=/private/tmp`、`lockf /tmp/bop-db-acceptance.lock`）新配置 `pilot-installation`：空库 → 迁移 → `permission-catalog-install`
→ `store-role-provisioning` keygen/prepare/sign/apply（首位 Owner）→ 门店配置/关口/菜单/库存点（仅测试种子，代表产品内 Owner 流程）→ 签发
prepare/sign/演练/apply/重跑 → 签发的 LOGIN NOBYPASSRLS api 角色用自己的密码文件登录，在行级安全与渲染 ACL 下读菜单与工作流 →
`workflow-release-install` 发布四个工作流（他店目录拒绝）→ 托管/受管密钥/Stripe live/Cognito 配置 → 启动检查只剩 `PricingCurrencyMetadata`
（删除一个绑定文件即 `Installation` 缺口）→ Pilot 续期 → InternalTest 续期工具拒绝 Pilot 目录、签发在 InternalTest 进程拒绝。
`workflow-release` 配置加验三个订单工作流在受限角色下按绑定求值；`pilot-runtime-environment` 与 `internal-test-renewal` 照常通过。

## 仍阻止真实 Pilot 启动

1. `PricingCurrencyMetadata`：真实门店的币种与税务配置及专业审查（外部 + P5），不可伪造，没有覆盖值。
2. 外部：品牌/门店初始化（B2）、Stripe live、Cognito 池、托管主机/域名/证书/受管密钥/S3、通知账户与实测、店员 UAT、Owner 上线批准。
