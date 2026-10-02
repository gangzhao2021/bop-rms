# BOP-RMS 全项目文档审查

审查日期：2026-09-29。范围是整个 BOP-RMS，包括主仓库与可见并行候选工作区。WP-2402 只是当前主工作区的定位信息，不限制此次审查范围。

本页保留整改前的只读审查快照。当前处分见[整改记录](../../runbooks/project-documentation-remediation.md)。第16项原先将性能/负载/浏览器输入整体视为未定，范围过宽：Handoff 80.8已有接受目标，剩余测量与部署输入见[决策输入记录](../design/project-delivery-decision-inputs.md)。原审查没有运行业务测试。

## 结论

领域责任、交易状态、Money、时间、租户隔离、恢复和安全边界已经相当详尽，足以支撑许多有界实现。当前文档仍不足以作为一致、可执行的全项目交付依据：陈旧的“当前状态”、接受状态矛盾、候选之间的集成取舍，以及部分尚未接受的系统级选择需要处理。

文档完整、契约已实现、组件验收、正常入口组装、真实门店/Provider验收和正式上线是不同状态。没有依据给出全项目完成百分比。

## 审查范围与证据边界

- 主工作区：`codex/wp-2402-pilot-submission`，实际 HEAD `03ad510c9b694a4bf994efb6703e11afa53e2fb7`，审查时216个未提交路径。
- 对 `rg --files` 可发现的542份Markdown做结构/本地路径链接扫描；重点交叉阅读Handoff、索引、ADR、设计/场景、工作包、安全、运维及模块文档。没有逐行复审每份历史WP。
- 33个领域模块：17个BOP、16个RMS；33份`src/module.manifest.ts`均有Owner、公开出口、依赖及数据分类声明；32个有模块README，Workflow缺少README。
- Screen Registry有210个Screen：Merchant147、Operations28、Customer21、Platform14；主工作区有407份`WP-*.md` brief。Registry缺少的WP-1501–1506属于已有明示的输出/后续范围问题，不能据缺文件直接认定当前范围缺陷。
- 另审查15个managed worktree的新增brief、局部索引和集成记录；发现18个主工作区尚无的WP编号，其中WP-2403有两种不同任务标题。
- 链接扫描使用轻量Markdown解析，跳过代码段；检查1881个非代码本地路径链接，发现3个当前缺失的截图目标、6个依赖本机绝对路径的截图引用；另有4个已人工核对的不匹配锚点。没有检查远程Figma/GitHub链接的当前可访问性。
- 此次运行的是只读检索、源文件分析和统计；未运行格式、业务测试、数据库验收、CI或活跃v14读取。文档中的通过结果均保留原运行的适用范围。
- 未修改现有仓库文件，未合并候选或操作外部服务。本报告是独立审查产物。

## 优先处理的冲突

### 1. P1：两个不同任务使用同一个WP-2403编号

Product候选WP-2403 (`managed candidate catalog-product-list/bop-rms/docs/spec/work-packages/WP-2403.md`)与Task Inbox候选WP-2403 (`managed candidate task-inbox-query/bop-rms/docs/spec/work-packages/WP-2403.md`)不是同一任务。这会使“WP-2403通过/待集成”等引用无法唯一定位。

**查后改：**确定正式编号归属和另一个候选的唯一身份，保留历史引用映射；在现有项目入口登记工作包、worktree/branch、来源指纹、状态及集成目标。不能仅凭相同编号合并证据。

### 2. P1：两个Product候选存在迁移序号与重复建表冲突

旧候选的1100_003 (`managed candidate catalog-product-list/bop-rms/migrations/1100-rms-catalog/1100_003_create_product_search_projection.sql`)创建`product_search_generation`；新候选的1100_003 (`managed candidate catalog-product-list-0700/bop-rms/migrations/1100-rms-catalog/1100_003_create_product_source_commit.sql`)创建`product_source_head`，再用1100_004 (`managed candidate catalog-product-list-0700/bop-rms/migrations/1100-rms-catalog/1100_004_create_product_search_generation.sql`)创建不同结构的`product_search_generation`。两个候选不能直接叠加。

WP-2407的范围 (`managed candidate catalog-product-list-0700/bop-rms/docs/spec/work-packages/WP-2407.md`)要求保留其他候选，但未找到对旧Product WP-2403的明确替代或兼容取舍记录。

**查、增：**先记录采用哪个候选、另一个保留哪些能力/证据及迁移适用状态；制定合流顺序。已经应用的迁移保持不可改写，不能靠重命名历史迁移消除冲突。

### 3. P1：已接受决定仍被描述为Pending

[Customer/Order/Payment handoff](../design/customer-order-payment-handoffs.md)仍称DEC-H07及具体退款输入待定；[退款接受记录](../design/pilot-ordinary-refund-policy-proposal.md)已明确2026-09-13接受RF-D01–06。

[设计当前状态表](../design/README.md)仍将多项Dining、Payment和退款工作描述为待实施；[当前局部验收表](../../runbooks/single-store-pilot.md)已有Dining sale/refund/closure的具体证据。

**改：**把旧问题标为日期明确的历史记录，链接唯一accepted disposition；分别表达决定已接受、局部实现/验收及剩余全项目条件，不重新要求已给出的审批。

### 4. P1：模块README与已接受数据库所有权冲突

[Inventory README](../../../packages/rms/inventory/README.md)仍否认schema/migration；[ADR-0031 addendum](../../adr/ADR-0031-migration-catalog-namespace-bootstrap-ownership.md)已接受1900/rms_inventory。

[Dining README](../../../packages/rms/dining/README.md)仍要求先解决持久化归属，而[当前manifest](../../../packages/rms/dining/src/module.manifest.ts)已有owner tables。[Feature Control说明](../../../packages/bop/feature-control/README.md)与其[数据库声明](../../../packages/bop/feature-control/src/module.manifest.ts)也需要对齐。

**改：**保留原WP的局部非目标，增加当前所有权、持久化范围和owning WP指针。已有权限/所有权决定不重新审批。

### 5. P1：Kitchen发布事件声明不一致

[Kitchen README](../../../packages/rms/kitchen/README.md)声明发布五个ProductionBatch事件；[Event Catalog](../../events/event-catalog.md)将它们登记为Kitchen-owned。但[manifest的publishedEvents](../../../packages/rms/kitchen/src/module.manifest.ts)遗漏这五项，仅在consumedEvents列出。

**改：**对齐已接受的producer/consumer声明，核对生成源及消费者元数据。这是契约声明冲突，尚未认定运行故障。

### 6. P1：CI的verify与根pnpm verify覆盖不一致

[CI命令列表](../../../.github/workflows/bootstrap.yml)没有[根verify](../../../package.json)中的`database-permission:check`、`openapi:check`。

权限单元测试不替代[实际migration catalog扫描](../../../tooling/database-permission/validate.mjs)。OpenAPI单元测试已覆盖生成文件漂移，但实际schema/reference parser属于额外入口。

**查后改：**在owning WP中对齐现存必需门禁并记录CI对应关系；不能把名为`bootstrap/verify`的作业成功直接解释为完整根`pnpm verify`。本次没有运行CI。

### 7. P1：认证威胁模型与已接受OIDC例外规则不一致

[威胁模型](../../security/authentication-threat-model.md)使用authorization code/PKCE material不进入URL/日志的绝对表述；同文49行只给callback code/state一个URL例外。[已接受Section87.6](../../../BOP-RMS%20Complete%20Handoff%20Package.md)另明确callback query及受控ALB access log例外。

**改：**区分token/verifier/secret、authorize/callback协议参数与受控ALB日志；完整引用加密、Restricted、安全访问、既定保留和立即clean redirect要求。无需重新决定认证方案。

## 当前状态、权威与集成追踪

### 8. P2：根README与当前阶段不符

[README](../../../README.md)仍称唯一数据库对象是migration_history，124行仍称bootstrap阶段，roadmap到WP-0021。

**改、归档：**改为全项目入口，提供阅读顺序和当前状态指针；foundation `pnpm dev`仍是独立基础入口，不能因项目进展而随意改写其真实503行为。旧bootstrap说明应明确限定范围或归档。

### 9. P1/P2：主机、revision与候选状态混用

[spec index](../README.md)把当前Mac HEAD与current v14 runtime并列；[WP current handoff](../work-packages/WP-2402.md)仍列另一个HEAD。[runbook](../../runbooks/single-store-pilot.md)明确这里没有v14安装，212-path结果是2026-09-26快照，之后已有Customer源码变化。

**改：**每个当前状态绑定host、branch/revision、未提交候选指纹、运行日期与适用范围。旧测试结果不因更新文档或路径数量自动升级为新证据。

### 10. P2：ADR-0034缺少索引入口

[ADR register](../../adr/README.md)只列accepted到0033；[WP-0024](../work-packages/WP-0024.md)及accepted Section97已引用ADR-0034/IDR-0047。guidance validator目前按既有ADR集合固定数量。

**增、改：**先补accepted Section97的权威指针；若materialize ADR-0034，需在同一有界WP对齐既有validator，不重新审批已接受决定。

### 11. P2：Workflow缺少模块入口说明

Workflow是33模块中唯一无README者；[manifest](../../../packages/bop/workflow/src/module.manifest.ts)及公开出口已有definition、store、evaluation、publication契约。

**增：**补简短README说明拥有的事实、与RMS状态语义的分工、Store override、Publishing边界及现有权威来源。不要复制完整历史WP。

### 12. P2：全项目候选合流与active WP不够可发现

最新Catalog集成索引 (`managed candidate catalog-classification/bop-rms/docs/spec/README.md`)仍指向WP-2402；WP-2420 (`managed candidate catalog-classification/bop-rms/docs/spec/work-packages/WP-2420.md`)已明确当前分支和继承候选。

Catalog链已有精确指纹导入，这是可复用的良好记录；Task、Recipe等旁支又各自修改merchant runtime、database catalog及ownership工具，共享文件并未组成一个最终候选。

**增、查：**在现有全项目入口登记候选和集成目标；列出合流顺序、共享文件协调人和组合验收问题。局部通过不等于项目已组装。

### 13. P2：设计映射和机器交接入口过期

[业务覆盖表](../design/business-scenario-coverage.md)仍称Approval Inbox仅映射WP-0125，而Registry还有WP-1807；[机器交接说明](../../runbooks/development-machine-handoff.md)的Make继续入口也停在旧版本。

**改：**对齐现有Registry和最新已记录的Make状态。真正缺口是精确source adapter/权限/result契约，不能仅有页面ID便认定闭合；本次未访问远程Make验证。

## 需要增补或形成接受处分的全项目规格

### 14. P2：完整业务阶段与正常入口验收需要逐项闭合

[全产品场景表](../../runbooks/project-completion-review.md)已列Store setup、staff order、reservation、procurement、stock、food safety、loyalty、privacy、reporting等范围；[当前正常入口缺口](../../runbooks/project-completion-review.md)是部分例子，并非全部未完成页面数。

Reservation/Waiting、Procurement、Compliance、Customer/Loyalty、Privacy在主工作区仍有仅ports/后续持久化的明示范围。新worktree的局部实现不能自动替换主工作区状态。

**增、查：**扩充现有场景/阶段表，逐项绑定承诺阶段、Owner、公开契约、持久化/HTTP/正常入口、失效恢复、验收及owning WP。先确认哪些Later/Future能力属于交付承诺，避免无限扩展当前演示范围。

### 15. P2：操作日、审批与交接尚有明确未决输入

[AOD-D01–03](../design/approval-and-operating-day.md)仍需要source allowlist、业务审批结果/权限、替补与升级规则、软件/人工分工、Table readiness和未结事项交接。

**增：**形成接受处分，明确每一步负责人、输入/退出条件、软件动作、人工证据和失败升级。保留当前assisted InternalTest已经接受的范围，不把Owner已拒绝的independent takeover重新设为演示前置条件。

### 16. P2：兼容、隐私与性能提案尚未形成具体接受值

- [SC-D01/02](../design/system-completeness-contracts.md)：支持/退出的客户端集合、旧新PWA/API/Worker/数据库组合、contract观察与rollback兼容。
- [SC-D03/04](../design/system-completeness-contracts.md)：数据/副本Owner、各right适用性、hold、派生副本及restore/tombstone覆盖。
- [SC-D05/06](../design/system-completeness-contracts.md)：业务延迟/成功率/queue目标、窗口/分母、Store/session/负载规模、资源分配与过载优先级。

**增、查：**保留现有详细模型，补接受版本、具体输入与责任人，再建立有界实现/验收WP。没有目标时性能只能是Not evaluable；不能用DB连接预算或RPO/RTO替代业务SLO，也不能编造新数值。

### 17. P2：收货的跨域事件注册仍是后续范围

[WP-2135](../work-packages/WP-2135.md)规定GoodsReceiptPosted/Adjusted/Voided及Procurement幂等消费；Inventory/Procurement的manifest事件列表仍空，当前catalog未注册这些事件。原WP已明确留待后续transport/persistence，因此不是该WP验收失败。

**增：**在全项目后续范围中闭合producer/consumer身份、schema/version、scope、Inbox/Outbox、replay/retention与owning WP；已存在的收货产品规则不重新设计。

## 需要补齐的发布与运维操作文档

### 18. P2：发布证据和云控制需要人可执行的intake说明

[release gate说明](../../runbooks/single-store-pilot.md)正确区分validator测试与真实发布证据；实际bundle校验入口仍主要在工具源中。另[organization policy](../../security/aws-organization-baseline.json)未显式列完root/Identity Center控制，部分字段仅在[测试常量](../../../tooling/security/aws-organization-baseline.test.mjs)中。

**增、改：**补安全空模板、字段/来源、digest/候选绑定、受限证据保管、现有validator入口和失败交接；把已接受云控制移到可审查policy/schema。区分静态baseline测试、真实输入校验与外部服务核验。

### 19. P2：跨Region恢复和密钥轮换缺少同等程度的操作指南

[Staging恢复runbook](../../runbooks/database-backup-restore-staging.md)明确限定isolated Staging；[WP-2053](../work-packages/WP-2053.md)另有跨Region写入fencing、promotion、endpoint和Provider对账要求。[密钥policy](../../security/kms-audit-archive-evidence-policy.json)已有rotation/overlap规则，缺分阶段现场操作入口。

**增：**按已接受规则补目标/identity预检、依赖与读取校验、切换条件、失败保持隔离或原读取能力、回退/升级责任及安全演练模板。具体账号、命令、授权和实际演练结果须由适用环境提供；本次不执行真实操作。

### 20. P2：break-glass人数适用条件与告警角色名称需要对齐

[break-glass角色表](../../runbooks/break-glass-access.md)限定Approver2适用条件，但[证据模板](../../runbooks/break-glass-access-evidence-template.md)无条件要求；operator/approver与至少两个active Actors也不等价。

[云告警policy](../../security/cloud-operations-evidence-baseline.json)采用hyphen角色代码，而[runbook](../../runbooks/observability-alert-routing.md)及实现使用underscore。

**查后改：**先对照接受来源明确人数及可兼任关系，再同步模板；告警采用closed registry或给出显式映射。外部订阅/联系人留在受限系统，字符串存在不能算投递完成。

## 应删除重复或归档的内容

### 21. P2：缩减重复的当前摘要，保留原始历史证据

WP-2402本体已超过一万行；[current scope/acceptance入口](../work-packages/WP-2402.md)仅指向history，读者需翻找历史才能定位brief。重复标题、逐次路径数量更新和多处Current/Latest摘要增加漂移。

**删、改：**删除重复的即时状态描述，保留一个当前范围/验收/检查inventory/下一步入口；将逐次运行记录归档并保留稳定引用、日期和原结果。不要删除append-only evidence、accepted decisions或Future Triggers，也不要因此重跑未变化业务检查。

### 22. P2：修复证据引用的可追溯性

4个不匹配锚点包括[WP-2402的Checkout链接](../work-packages/WP-2402.md)、517行、11567行及[project review的Kitchen链接](../../runbooks/project-completion-review.md)。两个Checkout目标实际只是普通段落，没有对应标题锚点。

3个失效截图引用位于[Supplier证据](../work-packages/WP-2402-continuation-evidence-2026-09-24.md)。6个依赖Mac绝对路径的截图引用位于同文件187–189和5322–5324行，目前这台机器存在，但跨机无法据此定位。

**查、改：**修复标题/锚点对应，并使用受控稳定证据引用或可移植的工件定位；保留原“曾运行/曾检查”的历史表述。截图缺失不等于测试没运行，也不能假装现有链接仍可审查。

## 建议执行顺序

1. 先修编号、accepted/pending、主机/revision及契约声明冲突，明确两个Product候选取舍。
2. 统一现有项目索引、候选登记、场景状态和CI对应关系，保留局部证据的原适用范围。
3. 补Workflow/ADR入口、系统级接受处分及发布/DR/rotation指南。
4. 按已明确阶段逐个闭合Later模块和正常入口，安排最终组合候选的验收。
5. 归档重复进度并修证据链接；真实Store、Provider、设备、专业政策、运维演练和生产go/no-go继续按既有gate处理。

以上是整改建议，不构成新业务决定、外部行动授权或全项目完成声明。
