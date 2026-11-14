# DEC-MERCHANT-LOCK-SCOPE — 一个商家的写只挡它自己的读

来源：WP-2423 publishing-contention（v15 实测：一家商家按“上架”，别家员工登录、下单、客人菜单报 503）。Owner：按建议改，不用问。是 [DEC-MULTI-MERCHANT-ONE-INSTALLATION](./multi-merchant-one-installation.md) 的前提：同一数据库里，锁的范围必须和数据一样按商家分开。

## 原因

- 当前事实的读写用整张表的锁，而表是所有商家共用的。每条语句都按租户和品牌过滤（RLS 也强制），但表锁不认商家：一家商家的写挡住所有商家的读。`lock_timeout` 是 2 秒，读等不到就失败（55P03）。
- 上架的 Submit 在写锁里把整个菜单又审了两遍（其中一遍是缓存键依赖字段顺序的意外），一次上架共审 5 遍。
- 审核是 CPU，和所有客人、员工的请求在同一个进程里。
- 排队放大：一个等着的写会挡住后面所有新来的读；员工登录在整个工作台读取期间持有会话表锁，一个卡住的登录挡住所有商家的登录。

## 决定

原则：**锁的范围就是它保护的事实。** 一个商家的锁碰不到另一个商家；同一商家里，读某一类事实只会碰到写同一类事实的人。已接受的保证不变：读到当前事实的人一直持有它到 COMMIT。只是范围缩小。

1. **发布记录：** 每个 family 一把 advisory 锁 `PublishingFamily:<租户>:<品牌>:<门店|Brand>:<family>`，读共享、写独占；守卫触发器也取同一把，任何写路径都绕不过。原来的 SHARE ROW EXCLUSIVE 改为目标 family 的独占。没有设品牌级的锁：审查没有发现跨 family 的读需要它，加了反而会和 family 锁形成相反的加锁顺序。
2. **Submit 只审一次：** 同一事务刚准备并记录的审核就是当前的，不在写锁里重审。重试的 Submit、Approve、Publish 照常重审（已接受的审核规则）。缓存键按值比较。一次上架共审 3 遍。
3. **少用 CPU，不改结果：** 校验器自己产生并冻结的值原样返回（只认它冻结的输出，原始输入改过会重新校验），摘要逐字节不变，进行中的审核仍然有效；审核循环每 15 ms 让一次路给其他请求。
4. **其他表锁同一规则：** 写由每张表的 BEFORE 行触发器按这一行自己的品牌、门店取独占（触发器名以 `a0_` 开头，排在其它行触发器前面；删除时用旧行并返回旧行），读改成共享。已有引用锁的地方（配方、库存、定价、税）不另加锁，读改为共享地取已有的键。
5. **登录：** Workforce 会话按人一把锁 `WorkforceSessions:<人>`：开新会话、轮换、升级、“在所有设备上退出”都先取它。会话上限不变，“全部退出”会等在途的登录完成再一并结束它。只有平台目录仍取整张会话表。同一人第二台设备登录，只在上限要结束的那个会话上等。
6. **上架对客人是一步：** 客人菜单在 Publish 事务里重建：COMMIT 前客人看到完整的旧菜单，之后看到完整的新菜单，中间不会出现“菜单不可用”。每一步遇到冲突自动重试，操作号不变。
7. **客人购物车跨过上架：** 报价时每一行按当前菜单版本重新确认并换上新证据；已下架的菜仍提示不能点；结账或下单时发现菜单变了，客人页面重新报价、说明原因，客人再按一次；店员轮次请店员再发一次。中间不下单、不收钱。
8. **防止回来：** `database-ownership` 的 `RUNTIME_TABLE_LOCK` 规则拒绝运行时代码里的 `LOCK TABLE`，也拒绝新迁移函数体里的 `LOCK TABLE`（已应用的历史文件按名字列为例外；迁移顶层在计划窗口内加锁仍允许）。测试用的角色已经去掉 MAINTAIN，残留的表锁在本地就会失败。

## 锁的键与读写对照

“新增冲突”指以前的表锁下不冲突、现在合并到同一个键后会冲突的读写组合。

| 键（范围）                                     | 表                                                                                                    | 读（共享）                                         | 写（独占）                         | 新增冲突                                                                                                              |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `CatalogOptionContentFence`（品牌）            | option_set、option_set_version、option、option_conflict                                               | 保存菜品时的选项检查、菜单审核、选项组列表         | 选项组保存与发布                   | 无。客人报价、加购物车读选项时不取这把锁（以前也不锁表），所以保存选项组不挡客人                                      |
| `CatalogProductBindingFence`（品牌）           | sku、product_version、product_option_binding 及其 option、sku_scope、channel                          | 菜单审核、选项组列表                               | 保存菜品、规格、绑定               | 选项组列表以前只锁 product_option_binding，现在也碰到写 sku、product_version 和三张绑定子表的保存（同一品牌、员工页） |
| `CatalogAllergenRegistryFence`（品牌）         | allergen_registry_version、allergen_registry_entry                                                    | 审核过敏原、配方过敏原覆盖、菜品编辑页             | 过敏原清单                         | 无                                                                                                                    |
| `CatalogAllergenEvidenceFence`（品牌）         | allergen_source_evidence、allergen_source_assertion                                                   | 审核过敏原、配方过敏原覆盖                         | 过敏原声明                         | 无                                                                                                                    |
| `StoreAuthoringFence`（门店）                  | store_configuration_authoring_operation                                                               | 营业日来源                                         | 门店设置的编辑                     | 无                                                                                                                    |
| `StoreConfigurationFence`（门店）              | store_configuration_version、publication_content、weekly_service_period、service_exception 及其两张表 | 营业日、发布内容、每周时段、例外日（客人进店会读） | 门店设置发布                       | 无：这些行只由发布一次写齐，每个读以前都锁 store_configuration_version                                                |
| `StoreServicePauseFence`（门店）               | store_configuration_operation、pause_content、resume_content                                          | 暂停记录                                           | 暂停、恢复营业                     | 无                                                                                                                    |
| `StoreReviewSnapshotFence`（门店）             | store_configuration_review_snapshot                                                                   | 审核快照                                           | 审核快照                           | 无（单独的键，客人进店不碰它）                                                                                        |
| `StorePublicProfileFence`、`…TimingFence`      | public_store_profile_version；public_store_profile_timing                                             | 公开资料                                           | 公开资料                           | 无                                                                                                                    |
| `WorkflowDefinitionFence`（租户、品牌）        | workflow_definition_version                                                                           | 每张单的流程读取                                   | 流程安装                           | 无                                                                                                                    |
| `LiveGateFence`（门店）                        | live_gate_version、live_gate_requirement                                                              | 上线关口                                           | 上线关口                           | 无                                                                                                                    |
| `PermissionPolicyFence`（品牌）                | policy_state、role、role_assignment、permission_grant、permission_override                            | 当前权限                                           | 角色、分配、授权                   | 无（以前读写都锁同一组表）。permission_definition 只由计划窗口内的目录安装写，不设锁                                  |
| `MembershipFence`（品牌）                      | membership、store_assignment                                                                          | 当前成员身份                                       | 成员、门店分配                     | 只锁 membership 的读，现在也碰到只写 store_assignment 的门店分配（同一品牌、人工操作）                                |
| `MembershipActorFence`（人）                   | membership                                                                                            | 这个人的品牌查找（登录时）                         | 这个人的成员身份                   | 无：查找以前锁了所有商家的成员表                                                                                      |
| `RecipeCatalogReferenceV1`（品牌，已有）       | recipe、recipe_version、scope_binding、modifier_version、ingredient_requirement、measurement_content  | 下单与出票、审核、覆盖检查                         | 配方保存、发布、归档（等待有上限） | 配方版本、配料、计量内容的写以前不碰读；它们和配方头在同一事务里写，实际冲突集合不变                                  |
| `RecipePreparationContentFence`（品牌）        | recipe_preparation_content                                                                            | 覆盖检查                                           | 做法内容发布                       | 无                                                                                                                    |
| 库存、定价、税的已有引用锁                     | inventory_item 等；option_price_rule 等；tax_configuration 等                                         | 原有的共享读                                       | 原有的 AFTER 触发器                | 无（读改成共享地取已有的键）                                                                                          |
| `PublishingFamily`（租户、品牌、门店、family） | publishing_mutation_record                                                                            | 当前发布事实                                       | 发布写入与守卫触发器               | 无：以前的表锁跨所有商家、所有 family                                                                                 |
| `WorkforceSessions`（人）                      | authentication_session                                                                                | —                                                  | 这个人的登录、轮换、升级、全部退出 | 无                                                                                                                    |

键的列表只在一处（`packages/database/test-support/merchant-fences.mjs`），迁移、读者和验收矩阵都对照它检查：新表漏了触发器、键拼错一个字段，测试都会失败。

## 规则

- **加锁顺序：** 一条路径先在某把锁下读、再写同一把锁的表时，一开始就取独占，触发器只是兜底。否则两个这样的事务会在“共享升独占”上死锁（例：两个归档配方、两个做法发布，已有验收）。
- **品牌内的写串行：** 以前同表的 ROW EXCLUSIVE 写可以并行，现在同一品牌的同类写排队。1–3 家店的商家，配置都是人工操作，事务在第 2、3 条之后很短，路由遇到冲突会重试。这是接受的代价。
- **配方的写等待有上限：** 客人下单和后厨出票也共享配方锁，一个等着的写会挡住它后面所有新的读。所以配方写只等 300 ms（a0_ 触发器和归档在写第一行之前取锁时都一样），等不到就让路，由路由的重试再试：商家自己的客人不会排在自己经理后面。选项组、定价、库存的写不需要上限：客人读这些事实时不取它们的锁。暂停、恢复营业不设上限：急着暂停必须赢。

## 仍然成立的事

- 一家店的老板发布这家店自己的门店设置时，这家店的客人进店仍要等这一次 COMMIT。
- 保存菜品、选项组要等同一品牌正在进行的审核结束。“约 1 秒”只是测试库里奶茶菜单的数字；第一家商家 37 道菜的菜单上线前一次审核要 16.9 秒，改后的实际时长要在 v15 实测里量，不当作通用数字。
- 客人看到的价格比菜单先生效：价格本和加价先各自发布，菜单在三步审核之后才换（最多可能需要一分钟）；上架中途停下时，新价格已经生效而菜单还是原来的。上架页的进行中提示和中途停止提示都照实说明，并请店主继续上架；客人一直可以点单。这与设计说明里“一步上线”的承诺不符，是已知差距（价格和菜单放进同一步需要跨领域改动，留作单独一项）。
- 一份菜单一次审核最多检查 10000 种选项组合（全菜单、所有门店和渠道合计）。超过的菜单仍然上不了架：现在在任何价格生效前就拒绝，说出是哪道菜、怎么改（去掉一个选项或拆成两道菜）。按选项而不是按组合审核是单独的 WP-2423 条目。
- 日志里 04:25:45 UTC 那次死锁（dining_table FOR UPDATE 与一个 advisory 锁之间，没有发布语句）早于本次改动，与本决定无关，另行处理。

## 部署

- 先迁移、后代码：旧代码在新触发器下照常工作（它的表锁照旧有效），新代码在 MAINTAIN 撤销之前也照常工作。
- 迁移 `2000_160`–`2000_167` 在计划窗口内执行。每个迁移开头先按运行时的顺序一次锁住它的所有表，再建触发器。遇到 55P03（锁等待超过 5 秒）时整个迁移回滚、什么都没改，等客流更少时重跑；不加长锁等待。
- 一个出错的触发器会让所有商家对那张表的写都失败，所以风险定为 medium，验收矩阵逐表试过插入、修改和删除；窗口内先走一次实测旅程再放开。

## 以后的窗口：撤销线上 MAINTAIN

- 现在只改代码和测试角色，线上 API 角色的 34 项 MAINTAIN 不动：回滚到旧镜像仍然可用（旧代码的表锁需要它）。
- 实测旅程通过、观察期内没有锁超时之后，单独一个窗口：在 `docs/spec/pilot-acl-additions.json` 给这 34 项标 `revoke: true`（Owner 2026-10-14 常设批准，WP-2423），应用并读回授权。
- 那之前先在运行手册的回滚一行写明：撤销之后，早于本修订的镜像不能再运行；需要回滚时先重新授予 MAINTAIN。部署技能和运行手册记下这个最低修订。
- 撤销只是最小权限清理，不是防线：API 在其中好几张表上还有 UPDATE 或 DELETE，PostgreSQL 仍允许它加表锁。防线是 `RUNTIME_TABLE_LOCK` 规则。

## 没有测到的

- 高峰负载：30 位客人、员工屏幕按实际间隔刷新时，旁边一家在上架、自己在上架、两家同时上架，各轮的耗时（v15 演练项）。
- 一家店的门店设置发布时，这家店客人同时进店。
- 实测要加一个等待者采样（`pg_locks` 中未授予的锁及其阻塞者，按商家的键归属），因为改后表锁采样按构造永远是空的。
