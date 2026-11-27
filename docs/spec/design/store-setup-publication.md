# DEC-STORE-SETUP-PUBLICATION — 店主在产品内发布门店设置、营业时间沿用、品牌税务分类

状态：**协调人决定（2026-10-15），Owner 可推翻**。执行工作包：[WP-2423](../work-packages/WP-2423.md)（剩余工作 6）。
迁移/授权/权限目录/角色升级按 "Owner standing approval 2026-10-14 (WP-2423 store setup publication)"。

## 背景

v15 上 Store setup 第 8 步被隐藏：试点从未组合门店配置发布（V2，setupBasis）所需的校验与上线闸门证据；且营业时间编辑器
（Q4）遇到来自设置草稿的已发布配置会拒绝启动，发布一次后下次重启即坏。品牌税务分类无产品内录入路径，
`catalog.tax-classification.manage` 无人持有，第 5 步费用只能"未设置/关"。核查另发现：设置草稿无法在产品内补齐
税务配置、品牌设置、节假日与生效时间（完成度永远不足）；草稿一旦有新配置记录即永远无法再保存（基线不符被拒）；
发布后试点运行时读取 V2 配置用错摘要、缺检查清单，整店读取会失败。

## 决定

1. **发布路径**：Store setup 第 8 步走现有 V2 流程——由保存的设置创建配置 → 送审 → 另一位持有 Owner 权限的人批准 →
   发布；版本只追加，Publishing 审核记录与审计（`STORE_CONFIGURATION_CHANGED`，原因 `STORE_SETUP_PUBLICATION`）。
2. **产品内发布检查（全部阻断，逐项白话说明在哪里修）**：税务配置为本店当前生效的那一份且登记/专业审核证据未过期；
   品牌设置与在营配置相同；时区为门店自身时区；营业日开始时间不变（保证历史营业日与报表边界）；营业时间至少一个时段且
   只用本店提供的服务方式；立即生效且无结束日；开启的费用只用本店提供的服务方式；本店上线闸门（Live Gate）已批准。
   地址、联系方式、付款设置、收据模板在创建与送审时由各自所有者重新读取。检查清单随工作区返回，未全部通过时界面禁用
   送审/批准/发布，服务端送审时再查一次（失败答 409，不再是 503）。
3. **上线闸门证据**：沿用本店当前已批准的闸门决定（试点为 InternalTest 合成闸门 `SYNTHETIC_STORE_READY`，仅测试）；
   发布步在同一事务内按"发布它的那次 release"核对现行配置后取得。外部关口（真实税号、Provider 账户等）不在此阻断，
   按 internal-test-stage 以标注测试值继续。
4. **期限**：由设置创建的配置须在创建后 14 天内批准并发布，验证与批准有效期相同（批准不比所依据的检查更长）；过期则重新创建。
5. **两人规则与单人经营**：作者与批准人默认必须不同，且都须持有 Owner 权限（`organization.manage` 与门店配置批准）。
   ~~单人经营不扩展到门店配置，待 Owner 决定~~ → **Owner 2026-10-16 已决定扩展**（见 DEC-SOLE-OPERATOR-APPROVAL
   补充决定 2026-10-16）：单人经营生效时，店主可在第 8 步验证身份后单独批准自己创建或送审的配置并发布，记录为单人经营
   并留审计；未生效时界面说明原因（未开启单人经营，或列出同样持有 Owner 权限的人），仍须另一位 Owner 权限持有人批准。
6. **在营设置沿用**：Store setup 不编辑的税务配置、品牌设置、节假日（Hours & ordering 维护）与生效时间，在第 8 步
   "Settings from the live Store" 一键取自在营配置（生效时间取服务器时间、无结束日）；营业时间与在营不同时明示并可一键沿用。
7. **草稿基线**：设置草稿的下一版本以门店最新记录的配置为基线（rebase），新配置发布后草稿仍可继续保存；从未有编辑记录的
   安装配置作为基线（`currentConfiguration` 端口）。
8. **营业时间（Q4）沿用**：来自设置的配置下，店长的营业时间改动写成"只改营业时间"的设置草稿新版本（权限
   `store.service.save-draft`，只允许改每周时段、日期例外、生效窗口）并在同一事务生成 V2 草稿；店长送审，店主批准发布。
   设置草稿有未发布改动时拒绝（"Store setup has changes that are not published yet…"）。权限目录 v16：Store Manager 增
   `publishing.draft.create`、`publishing.review.submit`（无目录/价格权限，不能送审菜单与价目）。营业时间编辑器重启可读 V2。
9. **运行时**：试点所有门店配置证明读取改用发布摘要分派（V1 普通摘要、V2 语义摘要）并带检查清单与设置来源引用。
10. **品牌税务分类**：权限目录 v16 新增 `catalog.tax_classification.manage`（旧名 `catalog.tax-classification.manage`
    等价），Brand Owner 持有（门店 Owner 模板随"全部代码"持有）；**Menu Manager 不持有**（分类与税务审核中的税率配对，
    属税务事实；Menu Manager 只读税务配置，仍可给商品选已有分类）。新页面 "Tax classifications"
    （`/app/commerce/tax-classifications`）：新增、改名、设/清默认、停用（不可逆，确认时说明使用它的商品与费用须在下次发布前改用
    其他分类，已发布菜单照常）。分类是店主自己的标签，不含税率或税务结论；永久代码由名称生成，不对员工显示。每次改动为只追加
    的登记版本，带原因、审计与事件；第 5 步无分类时链接到该页。
11. **未发布改动的撤回、驳回与不可静默取代（2026-10-16，v15 实测 D2/D3，协调人决定、Owner 可推翻）**：门店最新一份
    未发布的配置（草稿/待批/已批未发布）可由作者"撤回"，或由持有门店配置批准权限的人"驳回"；只追加记录
    （`rms_store.store_configuration_withdrawal`，原因 `STORE_CONFIGURATION_WITHDRAWN`/`DECLINED`，审计），配置本身保留，
    被撤回者不能再检查、送审、批准、发布。任何人的新改动都不能静默取代他人仍未结的改动：须先批准发布、撤回或驳回
    （服务端 409"open_change_by_another"，数据库触发器同样拒绝）；本人未结改动可由本人新改动取代，界面先说明。营业时间
    页显示谁的改动未结；他人未结时不能保存并提示请 Owner 处理，本人未结时从本人改动继续并可撤回；撤回/驳回后下一次修改
    从已发布配置开始，不带入被撤回的内容。第 8 步：设置未填完、他人改动未结、设置保存后门店配置已变（需重新保存设置）
    时禁用创建并白话说明；服务端分别答 409 `store_setup_incomplete` / `open_change_by_another` / `store_setup_outdated`
    （此前设置未填完时答空 503、页面"结果未知"）。"Use the live Store's settings"同时沿用在营门店的时区、营业日开始、
    服务方式、营业时间与订单限额（设置中未设的项）；Review 对每项写明取自何处或在哪一步设置。
12. **版本排序修正**：多处读取以 `revision::text revision … ORDER BY revision` 取最新，PostgreSQL 按输出列（文本）排序，
    第 10 版起"最新"读成第 9 版、保存一律 409。已改为按表列排序：门店设置草稿与设置引用、门店付款配置、收据模板草稿/
    产物/版本、品牌配置作者修订与旧版本、品牌门店拓扑草稿、堂食结账承诺。
13. **v15 实测 `0833a52c` 后的修正（2026-10-16，协调人决定、Owner 可推翻）**：
    - **收据（第 5 步）**：沿用门店现用收据模板即算"已设置"——第 5 步提供"Keep the receipt template in use today"
      与下拉中的"Receipt template in use today"，"Use the live Store's settings"在设置未选时同样带入现用模板；
      安装器发布、无送审记录的现用模板经 Publishing 公开读取（按发布引用找发布系列）以 V1 发布证明读取，创建与送审时
      照常复核。原"Leave receipt template unconfigured"改为"Clear receipt template choice"并说明未选不能发布。
      新编写的收据模板的独营自批属于门店配置发布，纳入 Owner 2026-10-16 决定（见 DEC-SOLE-OPERATOR-APPROVAL
      补充决定 2026-10-16 之续），条件与记录同门店配置（独营开启、本店仅一位门店 Owner 权限持有人、15 分钟内二次验证、
      显式确认、只追加标记 `2000_063` 与审计、数据库仅在标记吻合时接受批准人=作者/送审人）。
    - **只改营业时间也可独营自批**：店主本人在营业时间页做的修改（安装配置上的 V1 修改，或设置来源配置上的只改营业时间
      修订）同样可在独营生效时单独批准（营业时间页显示独营状态，审计原因 `STORE_HOURS_CHANGE_SOLE_OPERATOR`）；
      `2000_064` 让独营标记也可标记非设置来源的配置，发布与运行时读取对"批准人=作者"一律要求对应标记。
      未请求独营时本人批准答 409"需要他人批准"，独营关闭答"sole operator is off"并说明到 Approvals 页开启。
    - **只有作者能检查与送审**：他人（如店长对店主的草稿）执行检查/送审一律拒绝（409 `not_your_change`，界面说明找
      作者或由 Owner 批准/驳回），数据库触发器同样拒绝（`2000_064`）；历史记录不变。
    - **"Use the live Store's settings"**同步写入第 2–4 步的输入（时区、营业日开始、服务方式、营业时间），此前只写了
      内容、Review 与保存仍读输入而显示"未设置"。安装时的地址、联系方式、付款设置不是 Store setup 记录，不能沿用：
      说明须在第 2/5/7 步录入、保存并"Use saved"。
    - **Review**：未设置计数与列表一致，每项写明在哪一步设置（收据为第 5 步，外送费与小费单列）；第 8 步不能创建时
      列出缺少的各项。
    - **其他**：第 8 步撤回/驳回的版本显示"Withdrawn/Declined"；营业时间页写明是谁的改动未结；驳回先确认并可选原因
      （固定列表：Something in it is not right / It is not needed / Talk to me before changing this，记在撤回记录与
      审计，作者可见）；Approvals 页独营说明含门店配置（设置、营业时间、收据模板）；批准被拒（403）后营业时间编辑器
      不再收起。

14. **出票跟随已发布门店配置的收据模板（2026-10-16，协调人决定、Owner 可推翻）**：试点出票（`pilot-receipt.mjs` →
    `published-receipt-template-source.ts`）不再使用运营文件中的模板/系列引用，而取门店当前已发布配置的
    `receiptReference`，逐个版本按其所有者证明：有送审记录（产品内编写、送审、他人批准或带独营标记的本人批准、发布）的
    版本用内容发布证明（系列取自送审记录），无送审记录的安装器模板（如 RECEIPT_V1）用其当前 Publishing release 的安装
    证明；被新版本取代（release 非当前）的版本不参与选择。无法证明时拒绝出票（`DIGITAL_RECEIPT_TEMPLATE_UNAVAILABLE`，
    不写收据、不回退到其他模板，消费者照常重试，修复后自动补出）。新收据快照记录所用模板版本代码（`templateVersion`）
    与确切版本引用（`templateVersionReference`，内部引用，不向顾客展示）；既有收据不变。运维监控每分钟只读检查"现在能否用
    已发布模板出票"，不能且持续 2 分钟时在 Home 与外发渠道告警"Receipts are not being issued"（紧急；说明原因与店员、
    店主的处理，runbook `alert-receipts-template`），检查本身失败报"Some checks could not run"。运营文件
    `internal-test-receipt-template.json` 仅保留环境闸门作用。

15. **小费不需要税务分类（2026-10-16，v15 D7，协调人决定、Owner 可推翻）**：加拿大顾客自愿给、归员工的小费一般不征
    GST/HST（强制收取的服务费征税），因此第 5 步小费开启时可不选税务分类（数据为 `taxClassificationReference: null`，
    键保留；仅 Tip 可为 null），服务费与外送费开启时仍须选仍在使用的分类；已选分类的小费照旧有效并照常复核。领域解析、
    BFF 保存（不为无分类的小费读取分类登记）、数据库草稿触发器（`2000_065`）与界面一致。报价与付款不读取门店费用设置的
    分类：小费由付款的小费选择单独计入、不计税，故不受影响。第 5 步进入即自动读取分类选项（显示读取中/失败与重试），
    选择不再等待手动刷新；保存时重新读取并拒绝已停用的分类。第 8 步的说明取自当前状态（最新配置是否由本次保存的设置
    创建、是否已撤回/驳回），不再沿用先前操作的结果文字。

16. **v15 实测 `8bd902e3` 后的修正（2026-10-16，协调人决定、Owner 可推翻）**：
    - **营业时间的修改类型由已发布配置决定（D2）**：已发布为安装配置（V1）时走普通营业时间修改，即使最新一份是已撤回/
      驳回的设置来源配置；已发布来自设置时走"只改营业时间"的设置修订。领域层不再因已撤回/驳回的设置来源最新配置拒绝普通
      修改（未撤回时仍拒绝）；服务端在已发布配置来自设置时拒绝普通修改（409）。设置来源已发布时，已撤回的最新改动只有在
      除营业时间外与已发布设置相同时才可接续（其营业时间被新改动替换），否则答"Store setup has changes that are not
      published yet"，不把被撤回的设置改动带入新改动。v15 部署后无需数据修复即恢复。
    - **税务设置按本店当前生效的税务配置记录（D1）**：门店报价使用 Pricing 的税务配置（试点为
      `0190fa24-…-00a`），安装配置记的是安装器引用（`0190ed19-…-008`，无 Pricing 记录）。发布检查"Tax"继续与本店
      当前生效的 Pricing 税务配置比较（同类比较）；工作区返回 `storeTaxConfigurationReference`（无/多份时为 null），
      "Use the live Store's settings"带入该引用（无时退回在营配置的引用），"Settings from the live Store"按其判断
      "same as the live Store"。v15 上店主在第 8 步再点一次"Use the live Store's settings"并保存即可通过。
    - **作者称呼（D3）**：门店未记员工名称时，以其门店（或品牌）角色的管理名称称呼（"the Owner"），产品中没有其他
      员工身份名称来源；从不显示引用。查找成员只吞"非成员"错误，数据库错误不再被吞（否则事务失效）。
    - **送审后说明（D4）**：店主送审后按独营状态说明——独营生效可自行批准；未开启时说明他人批准或到 Approvals 开启；
      店长送审说明由 Owner 批准。
    - **驳回按钮（D9）**：仅持有门店配置批准权限（`store.service.approve`）的人看到"Decline this change"（服务端在
      营业时间视图返回 `viewerMayDecline`）；店长看到"Ask an Owner to approve or decline it."。

## 已知遗留

- ~~试点报价仍由运营文件给出税务配置引用（与门店配置引用一致时无差异），列为既有缺口。~~ 已修正（2026-10-18）：
  取餐、堂食各轮、柜台与店员代点的报价（`pilot-configured-quote.mjs`）按报价时刻经 Store 公开读取
  `createPostgresStoreTaxConfigurationSource` 取当时已发布且生效的门店配置所记 `taxConfigurationReference`（经当前
  Publishing release 证明），再由 Pricing 在同一时刻读取该税务配置；已冻结的报价快照不变（退款、收据照旧）。运营文件只
  提供内部测试的登记/专业证据，两者不一致或门店配置读不到时不报价（失败即关闭，日志只记代码），运维监控每分钟检查，
  持续 2 分钟在 Home 与外发渠道紧急告警"Orders cannot be priced"（店员纸单+刷卡机，店主第 8 步"Use the live Store's
  settings"后送审发布，runbook `alert-pricing-tax-configuration`）；顾客结账与柜台的失败文字提示请店员/查看 Home。
- ~~试点运行时出票固定使用运营文件中的收据模板（仅 V1 发布证明），门店配置改用其他模板后不会出票~~ 已按决定 14 修正
  （2026-10-16）。
- ~~第 5 步"Saved templates"只列产品内编写的模板；门店改用自编模板后，安装器发布的原模板不再出现在下拉中（"Receipt
  template in use today"此时指自编模板），店主在界面上无法改回原安装模板（运行时与 BFF 均支持，验收经 BFF 改回）。
  列为既有缺口，待补"门店最初使用的收据模板"选项。~~ 已修正（2026-10-16）：第 5 步提供"Receipt template the Store
  started with"选项与"Use the receipt template the Store started with"按钮（仍在用时与"Receipt template in use
  today"合并为一项）；BFF 公开读取 `installed=true` 找出本店最早发布、无送审记录的安装器模板，并按其当前 Publishing
  release 以 V1 发布证明读取（与其他模板同一证明，不可用时说明可重试）。
- ~~单人经营扩展到门店配置待 Owner 决定（见决定 5）~~ 已由 Owner 2026-10-16 决定并实现（见决定 5）。
