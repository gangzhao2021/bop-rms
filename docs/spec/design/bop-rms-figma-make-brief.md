# BOP-RMS · Figma Make 首轮设计简报

状态：私有 Draft，Make 当前 Version29；已有局部原型旅程，完整 Screen / 响应式 / 键盘验收仍未完成；未发布、未接入真实业务。
项目：[High-Fidelity Restaurant Order Prototype](https://www.figma.com/make/u5gjkcwfARvEqaiUKnCJnp/High-Fidelity-Restaurant-Order-Prototype)。
准备日期：2026-09-22。基于 WP-2402 v14 当前本地实现、Screen Registry 和已接受 Section 88 约束。
目标：先完成订单工作台的视觉与关键交互，再扩展同一设计语言到厨房、堂食、取餐和异常。此文件不代表完整试点改版完成。

## 复制以下内容到 Figma Make

2026-09-22 顾客端补充范围：Owner 明确指出扫码点餐主界面缺失。
在同一私有草稿增加独立顾客 shell：入口 `/`、菜单 `/menu`、搜索
`/menu/search`、详情 `/menu/items/:sellableId`（内嵌规格和过敏原协助）、
购物车 `/cart`。首屏是实际菜单体验，不是营销页；展示虚构门店与已确认的
桌号、营业状态、菜品图片、分类、价格及可用性。Guest/Store 上下文过期、
离线或无权限时禁止写入。金额用整数最小单位，购物车金额仅为估算，不能
伪装最终 Quote。结账、支付和订单状态下一步单独对齐并验收，不用假成功替代。
保留全部商家工作区及其恢复守卫。以 WP-2402 的逐项证据为准。

顾客后续结账契约（尚未制作，不表示已通过）：

- `CUST-CHECKOUT /checkout`：当前 Cart 版本和模拟 Quote 绑定，分项显示
  subtotal/discount/tax/fee/total、有效期和阻断理由；示例金额不是实际税务配置。
  购物车变更使旧 Quote 失效；涨价必须确认该次新 Quote；过期重新报价。
  堂食只展示该 Guest 当前授权的 Table/Session，不创建 Pickup slot。
- `CUST-PAYMENT /checkout/payment`：小费以整数分在创建时固定，保留同一操作
  的身份、原始时钟和金额；显示纯模拟支付，不收集卡号、凭据或个人资料。
  重复点击、离线、失效权限不得创建新意图；Pending/Unknown 不推断成功。
- `CUST-CHECKOUT-RESULT /checkout/result`：查询/恢复原操作，明确区分 Pending、
  Unknown、Succeeded、Failed；只有对应确认结果才能显示付款成功和订单链接。
  恢复上下文缺失时指引向门店核对，不诱导再次付款。
- `CUST-ORDER-STATUS /orders/:orderReference`：订单/批次、付款、厨房及服务状态
  分别展示，缺少来源显示不可用而不是推断；不编造 ETA。堂食追加批次需要
  当前 Session 和权限，不重写已付批次。30 分钟期限从原 Payment 操作时刻
  起算，限未付批次/付款承诺；不能关台或清除先前已付批次。
- 此段只定义后续私有草稿的模拟边界；不构成真实支付或上线授权。验收需覆盖
  正常链路、涨价/过期、Unknown 恢复不重复、离线/会话变化及旧响应丢弃。

核对来源：Screen Registry 的上述 Screen 条目；customer-pwa 的 CheckoutPage、
SessionPaymentPage、SessionPaymentResultPage 和 order-status/types；
[DEC-H03-DINING](./capacity-checkout-handoff.md#proposed-dine-in-interpretation-dec-h03-dining)。

后续范围与状态说明（2026-09-23）：Owner 要求核对实际 Make 项目中的 TBD。
本文件保留首轮 Orders 简报，不能把原型页面缺失等同于业务代码缺失。首次读取真实草稿时，
Kitchen、Dining、Pickup、Exceptions 导航均为 TBD；后续 Version29 预览已能打开这四个工作区，
因此原型已生成工作区的事实取代了“尚未生成”的旧状态，但不代表逐屏契约、响应式、键盘或业务状态验收完成。
后续逐项的原型观察、本地实现差异和未关闭条件统一记录在
[项目完成度核对](../../runbooks/project-completion-review.md#figma-make-reconciliation)
及 [Make 与仓库逐屏验收对照](../../runbooks/project-completion-review.md#make-to-repository-acceptance-crosswalk-2026-09-23)。

Make 访问状态与代码证据（2026-09-23）：早期访问曾显示注册门槛；之后一度可用
Code view 编辑私有 Version29 草稿。随后导出的最新已检查源码包 (4) SHA256 为
`233128ee046f10ab5ae655ba218ecdb28b61f451c7eafbda7e4523fed9deacc7`。在该隔离导出副本中，
客户转换使用显式 `nowMs`，支付提交的资格检查与不可变 intent 共用同一时钟，Dining 命名类型也存在；
`tsc --noEmit`、189 个逻辑测试和 Vite build 通过，build 仍有 525.97 kB chunk 警告；
`oxfmt --check` 仅对 `src/logic.test.mjs` 报格式问题。这些结果只适用于该 hash 的导出副本，
不证明 Make 当前线上源码与导出一致，也不证明完整原型验收。

最新重新打开的 Chrome 会话可读 Preview，但编辑面显示 “Sign up to use Figma Make”，
提示词、上下文、模式、模型、Send 与 Code 编辑不可用；没有提交注册信息、触发模拟业务动作、
发布或更改共享设置。因此以上导出检查是历史上的精确工件证据，不代表当前可编辑权限。
此前显示团队 AI credits 于 2026-09-30 重置的提示已被本次注册门槛观察取代，恢复编辑权限时需重新核验。
后续源码、测试来源和逐工作区观察见 WP-2402。原型行程的数据仍是虚构内存数据，不能证明服务端授权、
持久化或真实业务结果。
当前私有 Make 访问复核（2026-09-23）：该项目已重新可打开；Preview 和 Code view 可用，
Operations `/operations/dining` 路由可查看。Code 文件树显示 `src/components/DiningWorkspace.tsx`，
并能打开带 `settable` 的源码文本编辑器。没有修改源码，因此未验证手工编辑的持久化权限；
AI 提示框仍因团队额度耗尽禁用，界面显示 2026-09-30 刷新。与较早的注册门槛记录相比，当前访问已恢复，
但 AI 生成仍受额度阻挡。没有发布或改变分享状态。
已记录的局部原型旅程包括 Orders Unknown/冲突/只读拒绝、Kitchen 单个虚构票据处理、Pickup 模拟验货分支，
以及 Exceptions 的模拟确认/指派。它们只证明预览内存状态的可见行为，不证明服务端授权、持久化或真实业务结果。
以 [WP-2402 当前记录](../work-packages/WP-2402.md#full-project-continuation-review---2026-09-22)
区分原型观察、本地浏览器证据、待办和外部门槛；不得把本地实现测试写成 Make 验收，也不代表全项目完成。

当前会话复核（2026-09-26）：Chrome 重新打开该私有 Make 项目成功，Preview 可见虚构 The Elm / T-07 内容，
Code 视图可展开 `src` 文件树并打开 `src/App.tsx` 文本编辑区域；可访问性树将编辑区域标为 `settable`。
Figma 账户复核返回目标团队为 Full seat / admin。AI 提示、模型选择和 Send 按钮仍禁用，界面显示团队额度至
2026-09-30 刷新。此轮只读，没有修改源码、尝试保存、发布、共享或操作原型业务。手工编辑持久化仍未验证；
Review/Make 内容仍是虚构演示数据，完整 Screen、响应式及键盘验收仍未完成。

当前路由补查（2026-09-23）：通过 Preview route field 打开 `/operations/pickup` 与
`/operations/order-exceptions`。Pickup 显示六条活动记录和含一条 Completed 历史的七张卡片；本轮已在
Make 源码加入本地 Order number 搜索、结果计数和空状态。Exceptions 本轮已在 Make 源码加入 demo
type/severity/status/owner 筛选、计数和空状态。顶部明确标为 The Elm、Demo 和 fictional data。
只调用本地过滤/搜索控件，没有触发业务演示命令。改动和局部验证范围见 WP-2402；它们只覆盖虚构前端数据，
不证明业务权限、Provider 状态、持久化或完整 Registry/Make 验收。

Make 源码更新（2026-09-23）：Pickup 与 Exceptions 已直接编辑并在 Preview 验证本地过滤/搜索行为；
改动保留在私有 Version29 草稿。AI 生成仍受团队额度限制。之后通过 Preview options → Viewport → Custom
检查两页的 390×844 与 320×720 布局。Pickup 的 Prototype spec 悬浮入口已在不超过 640px 时隐藏，
320px 的 PU-007 Ready 状态和 390px 的七张卡片均不再被遮挡；1440px 桌面入口保留，说明文字已标明
确认/分配为模拟动作、来源解析受限。键盘验收目前只覆盖 Pickup 搜索/清除与 Exceptions 类型筛选/清除，
不代表完整页面验收。

请直接构建一个高保真、可操作、响应式的 BOP-RMS 单店餐饮订单工作台原型。使用下面的确切业务约束和全新虚构数据，不需要访问我的 localhost，也不要连接真实后端。

### 1. 产品与首轮范围

这是门店员工长时间使用的营业工作台。
首轮设计：

- OPS-ORDER-QUEUE，既有路径 /operations/orders。
- 从队列打开订单详情区域；保留 OPS-ORDER-DETAIL 的 /operations/orders/:id 路由语义。桌面可以在同一 shell 下呈现详情，移动端以完整详情视图和明确返回入口呈现。
- 一条关键交互：打开订单 → 查看初始/追加批次 → 对符合条件的批次接单 → 显示处理中 → 模拟服务器确认后更新。
- 同时设计成功、结果未知、冲突、无权限和过期只读分支。
- 本轮不要扩展成全功能 ERP，不要自行生成商品管理、采购、营销、会员或配送系统。

后续同一系统的五个实际工作区为：
Orders /operations/orders
Kitchen /operations/kitchen
Dining /operations/dining
Pickup /operations/pickup
Exceptions /operations/order-exceptions

可在导航中表达这五个工作区的结构，但本轮只把 Orders 做完整。其他项在设计演示中清楚标注未制作；不要假装它们已可操作，也不要把“未设计”解释成业务权限不足。

语言：遵循现有产品 en-CA 英文基线。可附一份中文排版示例用于评审，不能用中文替换英文基线。金额 CAD；日期和时间区分门店当地时间与 Business Date。原型采用明确标注的虚构门店和日期。

### 2. 视觉方向

参考 https://www.ssense.com 的严格网格、文字秩序和黑白表达；
参考 https://www.apple.com 的内容层级、留白和精细交互。
请把参考转成原创的门店工作界面。

具体提案：

- 白色画布 #FFFFFF，近黑正文 #171717，次级文字 #666666，轻分区 #F5F5F5，分隔线 #E5E5E5。
- 黑底白字的主操作；次要操作为文字或细描边。状态使用少量语义色，并始终伴随文字或图标。
- 不使用大面积渐变、毛玻璃、装饰性图表、夸张圆角、漂浮的多层卡片或营销式大标题。
- 优先用对齐、字重、行距和间距建立层级。正文 14–16px；标题 26–30px；辅助信息保持清晰可读。金额使用 tabular numerals。
- 使用系统字体栈：system-ui、-apple-system、Segoe UI；中文系统字体回退。不要导入远程字体。
- 4/8px 间距体系，控件小圆角约 4–6px；主内容边距约 24–32px；关键点击目标不小于 44px。
- 不要为了“高级感”压低文字对比度或把常用操作藏起来。

### 3. 布局

1440px 桌面：

- 窄而清晰的工作区导航。
- 固定范围栏：门店、Business Date、数据状态/最后核对时间。
- 主区标题 Orders，搜索/筛选工具区，下方清楚对齐的订单行或队列网格。
- 每行优先显示订单号、堂食/自取、来源渠道、当前阶段、提交时间和批次摘要。
- 已接单、待处理、取消、未知必须一眼可区分。
- 打开订单后显示上下文详情区：批次、支付/退款入口、堂食上菜进度入口、历史/技术详情。
- 原先大块铺开的版本号、完整 ISO 时间戳、技术 Screen ID 降低视觉权重；版本和准确时间仍能从详情取得。
- 显示“本页”的统计，不把分页数据当作全部订单数或全店营业指标。
- 没有来源的金额、支付状态、承诺时间、顾客信息不可编造为已知。使用明确的 Unavailable / Not loaded 文案。

1024px：

- 自适应窄导航；根据空间采用列表＋详情或替换式详情，不挤成三列小字。

390px，并检查 320px：

- 订单改为单列优先卡片。
- 详情替换列表，返回后保持原列表位置。
- 筛选进入 sheet；底部操作只有在不挡内容时才固定。
- 支持 200% 浏览器缩放、文本扩展与键盘访问。

### 4. 精确业务行为

订单队列已有字段：
orderNumber、orderType（DineIn/Pickup）、sourceChannel（Api/Pos/Qr/Web）、
submittedAt、currentPhase、currentVersion、observedAt、batches。
批次已有 sequence、acceptanceStatus、canRequestAcceptance。
分页已有第一页/下一页；不要设计精确总页数或全量计数。

当前阶段包括 Submitted、Accepted、InProgress、Ready、Rejected、Cancelled、Fulfilled；可能不可用。
批次接单状态必须区分 Accepted、Not accepted、Cancelled。
初始批次与追加批次必须分别展示。不能把追加批次取消画成整张订单取消。

只有 canRequestAcceptance 为 true 的批次才有接单操作。
接单处理中锁定重复提交。
Unknown 不是失败，更不是成功：显示“Acceptance could not be confirmed”，提供重试同一个操作的恢复路径。
冲突/明确拒绝时引导刷新当前事实与权限；不要乐观写成成功，不允许手工下拉修改订单状态。
Cancelled 订单保留支付/退款查询入口，但不给已取消堂食订单接单或上菜按钮。
Fulfilled 堂食订单仍可查看既有上菜历史。
订单履约完成、支付成功、退款完成是不同事实，不得相互推断。

搜索/筛选是 Section 88 的目标能力，但当前 pilot 队列尚未实现完整查询：

- 原型可以演示按订单号精确搜索及 type/channel/status 的“本页筛选”。
- 必须标注作用范围，不暗示对完整数据库检索。
- 保存视图、抢单、批量操作、导出、拒单等未核实能力不要变成可提交按钮。
- 顾客联系方式搜索不进入首轮原型。

当前数据核对时间不能被包装为实际实时订阅。
Live/连接恢复可作为单独的原型场景展示，明确是模拟。
Section 88 对订单投影的目标是约 2 秒或已接受 SLO；不能宣称现有系统已经达标。
Stale 或 Offline 时相关写操作只读，重新校验来源后才能恢复。
当前权限是 ordering.operate 与 Tenant/Brand/Store/Actor/purpose/字段权限交集；前端隐藏按钮不是授权机制。

### 5. 状态和原型演示

在独立于产品导航的 Prototype scenarios 面板中提供场景切换：

- 正常混合队列
- Loading / Refreshing
- Empty 与 No results 分开
- Partial / Unavailable
- Permission denied / Session expired
- Not found / Feature disabled
- Stale / Offline read-only
- Command pending / Command failed / Rate limited
- Conflict
- Acceptance outcome unknown

每个状态说明发生了什么、已有事实是什么、下一步能做什么。
未知/失败状态不能显示绿色成功反馈；刷新后保留合理焦点。
刷新或详情加载失败时不把旧结果当作新事实。
原型里模拟的成功只发生在明确的模拟确认之后。

### 6. 样例数据

全部新造，不复制真实订单、顾客、支付引用或历史运营快照。
用 DEMO-1001 等公开展示编号，不暴露内部 UUID、token 或 proof。

至少演示：
A. 自取订单 Submitted，初始批次 Not accepted，具备接单资格。
B. 堂食订单已有 Accepted 批次，另有 Not accepted 追加批次。
C. 堂食订单早先批次正常保留，追加批次 Cancelled。
D. 订单状态不可用，不展示接单资格。
E. Cancelled 堂食订单，可以查看支付与退款，不显示上菜操作。
F. Fulfilled 订单保留历史查看。

所有交易数据只用于内存中的原型演示。不保存到 localStorage，不连接支付服务，不向第三方遥测发送订单内容。
不生成健康/过敏事实、顾客联系人或可用取餐凭证。

### 7. 可访问性与交付

语义标题、可见焦点、键盘操作、表格表头、按钮名称、状态文字、错误关联、dialog 焦点管理都必须完整。
不用颜色单独表达状态；动画克制并响应 reduced motion。
若有金额，用 CAD 及统一两位小数显示；未知不能用 0 代替。

交付：

1. 完整可交互的 Orders 主页面与详情。
2. 1440 / 1024 / 390px 自适应展示。
3. 成功＋Unknown 恢复＋Conflict 刷新这三条可演示接单分支。
4. 上述状态面板。
5. 实际使用的颜色、字号、间距、组件规范。
6. 简短说明哪些是现有功能、哪些只是目标设计，列出缺失的后端能力。

请直接生成原型，而不是仅复述计划。保持草稿，不发布网站、不启用公开共享、不接入真实业务。

## 本地核对来源（供后续实现与评审，不必粘贴给 Make）

- docs/spec/README.md：接受基线、当前 WP 与本地 InternalTest 阶段。
- docs/spec/work-packages/WP-2402.md：v14 试点和已有证据。
- docs/runbooks/single-store-pilot.md：五工作区、真实本地入口和已有使用范围。
- docs/product/screen-registry.yaml：OPS-ORDER-QUEUE / OPS-ORDER-DETAIL 及相关工作区。
- BOP-RMS Complete Handoff Package.md：接受范围内的 Sections 88.4、88.10、88.22、88.23、88.27–88.30。
- apps/merchant-web/src/CurrentOrderQueuePage.tsx、current-order-queue-client.ts：实际字段、分页、批次与操作资格。
- apps/merchant-web/src/OrderAcceptanceAction.tsx、order-acceptance-client.ts：提交、未知重试、冲突/拒绝行为。
- apps/merchant-web/src/CurrentOrderQueuePage.test.tsx：取消批次、未知阶段、取消订单支付入口、履约历史的现有断言。
- apps/merchant-web/src/MerchantShell.tsx、App.tsx、styles.css：导航、范围、样式和当前路由。

差异与限制：

- 原始简报来自源代码和契约核对。后续任务“拉取最新代码覆盖本地项目”记录了
  1440/1024/390/320px、正常接单、Unknown 恢复、Conflict 刷新与部分键盘验收；
  这些是该任务的历史验收，完整无障碍验收仍未完成。本次仅重新读取草稿，未重跑这些检查。
- 完整搜索/筛选、全量汇总和实时订阅不能从当前队列代码推定已实现。
- 现有基线是 en-CA；中文是可选评审样例，不是已接受的生产语言切换。
- 设计方向是用户授权的草稿探索，不是 Accepted Figma 节点或实现许可完成凭据。
- 没有运行应用测试、构建、安装依赖；本轮没有修改仓库业务代码。
