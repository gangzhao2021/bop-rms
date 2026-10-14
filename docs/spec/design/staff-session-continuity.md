# DEC-STAFF-SESSION-CONTINUITY — 店员会话保持、超时提醒与共享平板换人

状态：**Proposed（实现决定按商用原则作出，2026-10-14）**；第 5 节"PIN 快速切换"为评估，**需要 Owner 决定**后才实现。
执行工作包：[WP-2423](../work-packages/WP-2423.md)（Q18）。上位依据：Handoff §86（会话策略 WorkforceStandard / NamedKdsOperator）、
§87.11.1 IDR-0039（具名 KDS 操作员）、WP-2423 试点规则"超时前提醒""不得有可达的死链接"。

## 问题（按源码核对）

1. 试点店员会话用 `WorkforceStandard`（空闲 30 分钟、绝对 12 小时；厨房屏 `NamedKdsOperator` 空闲 60 分钟）
   （`packages/bop/identity/src/contracts/authentication-session.ts`、`tooling/environment/pilot-merchant-session.mjs`）。
   空闲期限只在创建时写一次，之后没有任何请求延长它：订单页整天开着、每 10 秒刷新，30 分钟后照样失效。Q18 记作"15 分钟"，实际是 30 分钟；
   问题相同。
2. 失效后订单页只显示"could not be refreshed / Permission denied"，首页显示"Sign in required"并链接 `/merchant/login`；试点没有 Cognito
   （外部关口），该链接是死链接。店员不知道发生了什么，也回不去。
3. 店员端没有任何"退出/换人"入口；共享平板上下一位店员只能用上一位的会话，或等它过期。

## 决定

### 1. 空闲期限随真实活动滑动（Identity 所有）

- 契约：`idleExpiresAt = min(lastSeenAt + 空闲时长, absoluteExpiresAt)`（`slidingIdleExpiry`）。绝对期限在创建时固定，任何活动都不延长；
  到 12 小时必须重新登录。数据库原有约束（`last_seen_at < idle_expires_at <= absolute_expires_at`）不变，无迁移。
- 写入有界：`recordSessionActivity` 在距上次记录不足 60 秒时不写（`sessionActivityWriteIntervalSeconds`）；一个会话每分钟最多写一次，
  多个标签页同时上报时行锁串行化，只有第一个写。
- 只延长可用会话：存储层 `recordActivity` 先 `FOR UPDATE` 读出该行并重新读取 Actor，再按契约判断可用；更新语句带 `status='Active'`、
  原 `version`、原 `last_seen_at`/`idle_expires_at` 与两个期限都未过的条件。已撤销、空闲过期、绝对过期的会话永不复活；并发撤销优先。
- 审计语义：活动不是生命周期变化——不增 `version`、不改状态、不写审计记录（否则一个开着的屏每分钟一条审计，淹没真正的登录/退出/撤销）。
  活动的事实就是会话行的 `last_seen_at`。不增版本也保证"退出""撤销"的期望版本检查不会因活动而冲突、静默失败。
- 只对普通 Workforce 存储开放；平台与强认证（`Privileged`，15 分钟）会话不滑动（`recordActivity` 拒绝），保持原策略。
- 授权：试点 `api` 角色已有 `bop_identity.authentication_session` 的 SELECT/INSERT/UPDATE（`docs/spec/pilot-acl-matrix.json`），
  **无新增授权、无迁移**。

### 2. 什么算"真实活动"（浏览器规则）

- 只有可见的页面上报（`document.visibilityState === "visible"`）。后台标签页、锁屏的平板永不上报，所以不能无限保活。
- 上报条件（每分钟最多一次）：自上次上报后店员有输入（点按、触摸、按键），或者当前是**营业中盯屏的页面**：订单（`/operations/orders`）、
  厨房（`/operations/kitchen…`）、取餐（`/operations/pickup`）、桌台（`/operations/dining`）。这些页面开着即视为在用，
  只受 12 小时绝对期限约束。设置、菜单等其他页面无人操作 30 分钟后照常退出。
- 打开页面、页面从后台回到前台视为一次活动。
- 上报走 `POST /merchant/session/activity`（同源 + CSRF），返回期限与服务器时间；只读 `GET /merchant/session/expiry` 用于提醒前复核
  （另一个标签页可能已延长）。两者都不返回会话引用或任何凭据。服务器时间用于纠正平板时钟偏差。

### 3. 超时前提醒（试点规则）

- 空闲退出前 2 分钟：页面底部提示"Still there? This screen signs out at HH:MM (in m:ss) because it hasn’t been used."，按钮
  "Stay signed in"（只延长空闲期限）。
- 绝对期限前 10 分钟：提示"Sign in again at HH:MM. A sign-in lasts at most 12 hours … staying active does not extend it."，
  不提供"保持登录"，提供"Switch staff"（立即退出并去登录）。时间按门店时区显示。
- 到期：整屏覆盖"You’ve been signed out"并说明原因（空闲 30 分钟 / 12 小时上限 / 在本屏或其他屏已退出），给出能用的"Sign in again"。
  覆盖层不透明，退出后的屏幕不再显示订单与取餐联系方式。网络不通时按时钟判断到期，网络恢复后照常登录。

### 4. 失效后的登录入口（不再有死链接）

- 服务器告诉页面在哪里登录：`GET /merchant/sign-in-entry` 返回 `{path, testOnly}`。生产默认 `/merchant/login?returnTo=/app`（Cognito）；
  InternalTest 试点组合传入 `/internal-test/staff`，`testOnly: true`，页面标注"**TEST-ONLY** internal pilot sign-in. A live store signs in
  with each staff member’s own account."。只接受同源路径。
- 首页"Sign in required"、店员页（`/operations/*`、`/app/operations/*`）无会话时、到期覆盖层、厨房屏换班后的"已退出"面板都用这个入口。

### 5. 共享平板换人：本次实现与 PIN 评估

**本次实现（不改身份模型、不降低安全）：**"Switch staff"——侧栏与 12 小时提醒里的按钮：撤销当前会话（`POST /merchant/logout`，
本地撤销即生效），然后打开登录入口，让下一位店员以自己的身份登录。试点登录页本身就是一键选择已配置的测试店员，因此试点换人已是两步。
生产中下一位店员需要完整 Cognito 登录（账号 + 密码，必要时 MFA），在柜台高峰期偏慢。

**PIN 快速切换的评估（需要 Owner 决定，未实现）：** 真正的 PIN 是新的身份凭据，不能只是界面功能：

| 方案                               | 做法                                                                                                                                                                                             | 安全要点                                                                                                                                                                                    | 工作量                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| A. 设备绑定的 6 位员工 PIN（推荐） | 门店平板先由店长完整登录并登记为门店设备（Identity 设备凭据，只存哈希）；每位员工在自己完整登录后设置 6 位 PIN；在已登记设备上输入 PIN 签发该员工的普通 `WorkforceStandard` 会话，旧会话同时撤销 | PIN 用 Argon2id 加盐哈希；只在已登记、未撤销的本店设备上有效；每员工 5 次失败锁 15 分钟、每设备限速；店长可重置；退款、改价等敏感操作仍要求完整登录/MFA（Q5）；PIN 设置、使用、锁定全部审计 | Identity 新凭据类型与设备登记契约、2 张表（迁移）与授权、锁定与限速、PIN 设置/重置/登记界面、数字键盘解锁屏、隐私与威胁模型更新；约为 Q5 规模 |
| B. 记住账号的快速 Cognito 登录     | 设备记住最近几位员工的用户名，换人只输密码                                                                                                                                                       | 不引入新凭据；依赖 Cognito（外部关口）                                                                                                                                                      | 小；但仍需输入完整密码，柜台高峰期改善有限                                                                                                    |
| C. 工牌/NFC                        | 刷卡签发会话                                                                                                                                                                                     | 需要硬件与卡片管理                                                                                                                                                                          | 大，且依赖门店硬件采购                                                                                                                        |

建议采用 A（真实门店多人共用一台平板、每班多次换人时唯一实用的方式），作为单独的安全设计与工作包实施。需要 Owner 决定：是否采用 A；
PIN 位数（建议 6 位）与锁定阈值；哪些操作在 PIN 会话下仍需完整登录。决定前试点用"Switch staff"。

## 修正（2026-10-14，v15 实测）：活动上报与业务读取冲突导致误退出

现象：店长与 Mia 打开报表（`/app/reports/operations`）或日结（`/app/operations/payment-reconciliation`）即被整屏"You’ve been signed out"
覆盖，会话行实际仍为 Active。根因：业务事务（门店范围、报表、日结）开始时对会话行加 `FOR SHARE` 并持有到事务结束；活动上报用
`FOR UPDATE` 等待该行，超过试点事务 `lock_timeout`（2 秒）后失败，存储把一切失败归为"拒绝"，路由返回 403，浏览器把任何 401/403 当作会话结束。

决定：

1. 活动是建议性的：先以 `FOR NO KEY UPDATE SKIP LOCKED` 取行锁，行被业务读取占用时**跳过本次写入**（不等待、不失败），返回当前期限；
   下次上报再写。读取期限（`extend: false`）只用 `FOR SHARE`，与业务读取兼容。
2. 只有真正结束的会话（已撤销、已过期、不存在、无 Cookie）返回 `401 {"error":"session_ended"}`；CSRF 不符为 403；数据库或来源暂时失败为
   `503 session_check_unavailable`（`Retry-After: 30`）。新增 `BROWSER_SESSION_ENDED`/`BROWSER_SESSION_UNAVAILABLE` 区分。
3. 浏览器只在明确的 `session_ended` 时才考虑退出，并且先用一次新的期限读取确认后才覆盖；403/5xx/断网一律静默稍后重试（15 秒后），
   本地时钟到期而服务器无法确认时只显示"Your sign-in may have ended"提示条，不覆盖页面。
4. 覆盖层增加"Check again"：重新读取期限，若会话仍有效即移除覆盖并恢复上报，页面保持可用。

## 其他影响

- 厨房屏换班（IDR-0039）：开始班次时记录的 `session_valid_until` 是开始时刻的期限；未"Release"就离开的操作员，其班次结束时间按
  `loadSessionEnds` 读取会话当前的（已滑动的）期限，因此交接时间仍正确。
- 断网（Q9）：断网期间无法上报活动，盯屏页面 30 分钟后服务器端会话到期；恢复后店员按到期覆盖层重新登录（试点登录页一键）。
  这是保守选择：离线的平板不能自行延长会话。

## 检查

单元（Identity 契约与服务、API 路由、商户端规则与客户端）；隔离 PostgreSQL 受限 NOBYPASSRLS 角色 + 渲染的试点授权
`staff-session-continuity`（滑动、一分钟内不写、并发只写一次、不超过绝对期限、撤销/空闲过期不复活、无 UPDATE 授权的角色被拒、KDS 策略）；
商户生产浏览器 `staff-session-continuity`（空闲提醒与"Stay signed in"、到期覆盖与可用登录入口、盯屏页保活与后台标签不保活、12 小时提醒与
Switch staff、无会话页面的登录入口；1440/390 截图、无横向溢出）。结果记录在 WP-2423。
