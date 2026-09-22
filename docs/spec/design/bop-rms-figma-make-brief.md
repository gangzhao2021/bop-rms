# BOP-RMS · Figma Make 首轮设计简报

状态：Draft，供 Figma Make 生成和评审；尚未生成、发布或接入真实业务。
准备日期：2026-09-22。基于 WP-2402 v14 当前本地实现、Screen Registry 和已接受 Section 88 约束。
目标：先完成订单工作台的视觉与关键交互，再扩展同一设计语言到厨房、堂食、取餐和异常。此文件不代表完整试点改版完成。

## 复制以下内容到 Figma Make

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

- 这是源代码和契约核对，没有成功取得当前网页截图或运行浏览器验收。
- 完整搜索/筛选、全量汇总和实时订阅不能从当前队列代码推定已实现。
- 现有基线是 en-CA；中文是可选评审样例，不是已接受的生产语言切换。
- 设计方向是用户授权的草稿探索，不是 Accepted Figma 节点或实现许可完成凭据。
- 没有运行应用测试、构建、安装依赖；本轮没有修改仓库业务代码。
