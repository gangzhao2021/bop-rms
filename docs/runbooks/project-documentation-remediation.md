# 全项目文档整改记录 — 2026-09-29

本次按 Owner“按你建议做”落实[全项目审查](../spec/history/project-document-review-2026-09-29.md)。范围包括整个项目的索引、业务场景、模块、ADR、安全、运维与候选集成记录；WP-2402 仅是主工作区的执行归属。保留主仓库原有未提交业务修改和历史证据，不合并并行候选，不改变业务生命周期或已应用迁移，不操作外部服务。

主源码身份：`codex/wp-2402-pilot-submission`，HEAD `03ad510c9b694a4bf994efb6703e11afa53e2fb7`，加保留的未提交候选。原审查统计 542 份 Markdown、33 个模块、210 个 Screen、407 份 WP brief 和 15 个 managed 候选，是整改前快照，不是整改后的完成度。

## 当前阅读顺序

1. [规格权威与项目入口](../spec/README.md)：accepted baseline、阶段、当前执行归属。
2. [全产品场景覆盖](../spec/design/business-scenario-coverage.md#current-scenario-evidence-view)：既有证据与每个业务阶段的剩余条件。
3. [候选登记](project-candidate-register.md)：15 个候选、18 个新增 WP 编号、重复身份、迁移和共享文件冲突。
4. [待决输入](../spec/design/project-delivery-decision-inputs.md)：操作日、兼容、隐私、性能测量和 Later 阶段承诺。
5. [证据 intake](pilot-integration-readiness-inventory.md#evidence-intake-navigation)：发布、云控制、恢复和轮换。

## 22 项审查处分

| 项                      | 处分                           | 当前结果与剩余条件                                                                                                                                |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 两个 WP-2403          | 身份已登记；正式编号同步待合流 | 强制区分 Catalog/Task 候选、分支、指纹；没有把别名当成已重编号。候选 owning WP 必须保留历史映射并同步源 brief。                                   |
| 2 Product 迁移冲突      | 冲突与具体推荐已记录，未执行   | 推荐以 WP-2407→2420 为基底，比较保留/替代旧搜索能力；Catalog/Database owners 需处分实际迁移状态及升级路径。不能直接叠加或改写 applied migration。 |
| 3 accepted/Pending 矛盾 | 已改                           | 退款 RF-D01–06、Dining 等接受处分与原始提案/历史实现状态分开；不重新请求既有审批。                                                                |
| 4 模块数据库说明        | 已改                           | Inventory、Dining、Feature Control 的当前 ownership 与旧组件非目标分开。                                                                          |
| 5 Kitchen 发布事件      | 已改并验证                     | manifest 补齐已有五个 ProductionBatch producer 声明；未改变事件 payload、handler 或 transport。                                                   |
| 6 CI 缺失门禁           | 已改，本地入口验证通过         | bootstrap 加 database-permission/OpenAPI；并不宣称远程 CI 已跑或与完整根 verify 完全等价。                                                        |
| 7 OIDC 例外             | 已改并验证                     | 区分秘密材料、协议参数、受限加密 ALB 七天日志和立即 clean redirect。                                                                              |
| 8 根入口过期            | 已改                           | README 指向项目级状态；bootstrap 的运行含义保留，旧 roadmap 明确为历史。                                                                          |
| 9 主机/revision 混用    | 已改                           | Mac 源码、WSL v14 历史运行与候选指纹分开，旧通过记录未升级成新结果。                                                                              |
| 10 ADR-0034             | 已补并验证                     | materialize 已接受 Section 97/IDR-0047，索引和 validator 同步至 34 份 ADR。                                                                       |
| 11 Workflow README      | 已补                           | 说明 facts、私有表、Store override、Publishing 和 RMS 动作边界。                                                                                  |
| 12 候选合流入口         | 已补，合流未执行               | 全候选登记、共享文件协调责任、检查复用条件和最终组装/CI 里程碑明确。                                                                              |
| 13 映射/机器交接        | 已改                           | Approval Inbox 增 WP-1807；机器交接作为日期快照，转向后续 crosswalk。没有新访问远程 Make。                                                        |
| 14 全业务阶段闭合       | 覆盖表已统一，实现待 owning WP | BC-01–27 全项目状态集中维护；Later/Future 交付承诺、正常入口、持久化和恢复条件不能由文档虚构完成。                                                |
| 15 操作日未决           | 决策输入包已补，未接受新规则   | AOD-D01–03 的角色、输入/退出、手工/软件与升级要求完整列出；保留 accepted assisted InternalTest。                                                  |
| 16 兼容/隐私/性能       | 已修正旧结论并补输入包         | Handoff 80.8 已有性能、负载、浏览器目标；剩余为组件组合、测量窗口/分母、环境资源及真实容量证据。SC-D01–06 不被自动标 Accepted。                   |
| 17 收货事件 follow-up   | 后续责任已登记                 | 保留 WP-2135 transport/persistence 非目标；producer/consumer/schema/Inbox/Outbox/replay 待有界 owning WP。                                        |
| 18 发布/云证据 intake   | 已补并对齐 policy              | 安全空模板、来源/绑定/失败交接、root/Identity Center 控制和实际 gate 入口明确；无真实账号/镜像验收。                                              |
| 19 DR/rotation 指南     | 已补                           | 分阶段预检、fence、恢复覆盖、原键对账、失败保持、双读单写/verify overlap 与受限模板齐全；未演练、轮换或删除密钥。                                 |
| 20 break-glass/角色代码 | 已改并验证                     | 明确 Approver 2 适用性与 operator 分离；告警角色采用已有 underscore registry；未宣称真实投递。                                                    |
| 21 重复当前摘要         | 已归档并统一指针               | 主索引旧即时/运行叙述和旧场景证据归档，保留原记录；WP 顶部给当前范围/验收/check inventory。没有删除 append-only 历史或 Future Trigger。           |
| 22 证据链接             | 已修                           | 修正四个锚点、六个本机绝对截图引用；三张缺失 Supplier 图明确不可从当前树复审，保留原运行叙述。                                                    |

## 验证选择与结果

选择在 [WP-2402 顶部](../spec/work-packages/WP-2402.md#whole-project-documentation-remediation--2026-09-29) 先记录。使用已有 Node `24.18.0` / pnpm `11.13.0` 与匹配 lockfile 的安装，没有重新安装。

| 检查                           | 本次结果                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------- |
| repository-guidance            | 通过：34 ADR、5 skills、模板及内置边界场景                                        |
| module-manifest                | 通过：合法 fixtures 与 15 个拒绝边界                                              |
| import-boundary                | 22 项通过，实际导入扫描通过                                                       |
| event-catalog                  | 生成漂移、内置 parser、AsyncAPI 验证通过；存在既有非阻断版本提示，无 schema 错误  |
| database-permission            | 23 项通过，实际 catalog 扫描通过                                                  |
| openapi                        | 生成漂移、schema/reference 验证通过                                               |
| Kitchen typecheck              | 正确包 `@rms/kitchen` 通过；首次误用 `@bop/kitchen` 无匹配，未记作通过            |
| 相关安全测试                   | authentication、break-glass、AWS organization、cloud operations：4 文件/13 项通过 |
| 变更工具与 manifest ESLint     | 通过                                                                              |
| 文档格式、路径、锚点与范围复核 | 最终检查结果见本页追加记录                                                        |

额外选择：空 release 模板必须被已有 gate 拒绝，确保它不能冒充真实发布结果；仅运行既有本地字段校验，不调用外部服务。文档最终修改后复查受影响格式和链接，无需重复已通过且输入未变化的业务/工具检查。

未运行完整业务回归、应用构建、数据库 journey、远程 exact-head CI、Make 复审或真实 Store/Provider/device/UAT/DR/rotation。没有 commit、push、merge、deploy。项目仍有已明确的候选合流、业务实现/接受处分与外部证据门禁；本页不是全项目完成声明。

## 最终文档检查追加

变更文件 Prettier 写入后检查通过；1,824 个本地路径和 197 个锚点扫描均无缺失，包含新建文档及四个修复锚点。`git diff --check` 通过。空 release 模板运行既有 gate 返回 1，按预期拒绝 null 信任、镜像、工具、工件与签名等字段；这是负向本地校验通过，不是发布通过。人工比较本次编辑前保留副本与当前文件，检查了范围、历史证据、迁移不可改写、安全/权限措辞及 CI 入口；原有应用候选保留。

检查绑定 HEAD `03ad510c9b694a4bf994efb6703e11afa53e2fb7` 加本次保留/修改文件。选中的业务运行与持久化输入未改变；测试不会延伸为另一个 worktree 或实时环境的结果。关键检查输入 SHA-256 如下，用于辨认本次未提交输入：

| 输入                                                           | SHA-256                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/rms/kitchen/src/module.manifest.ts`                  | `faacb5b84a19d60e0483ae44b2af70746ab2b8f66a14e74f0e82e0ce2ae1c443` |
| `tooling/repository-guidance/validate.mjs`                     | `7e9e254908c3ead8bf3dd0741924a4c2256e0b63441ff6234aaf491a5d906695` |
| `docs/security/aws-organization-baseline.json`                 | `080fd5b0b7681975fb4c5a84b61581b458aa09f5345c151e35c81f004a3f7035` |
| `docs/security/cloud-operations-evidence-baseline.json`        | `fe72269441f98c4bc812f332eed9858e6a4c93a435f4de581209facaa54263c5` |
| `tooling/security/aws-organization-baseline.test.mjs`          | `9fc231e42b49d7649aa8cee5a61991fa1722fb0933ab6e01e231170bac629706` |
| `tooling/security/cloud-operations-evidence-baseline.test.mjs` | `da27c8b310e956e5cc6dc8ea22e5a12a445fcc7b95fa45d3cca4abbc90ec8a72` |
