# DEC-COGNITO-STORE-STAFF — 门店员工用 Cognito 账号登录、应用内邀请与重新登录加验

状态：**Accepted（协调人按商用原则决定，2026-10-20，Owner"先把接口都做好"）**。执行工作包：[WP-2423](../work-packages/WP-2423.md)。
上位依据：IDR-0025 Rev.1（Amazon Cognito + 同源 BFF、OIDC/PKCE、仅邀请制员工池、TOTP MFA、`admin_only` 恢复、无默认密码与后门）、
[DEC-STAFF-SESSION-CONTINUITY](./staff-session-continuity.md)、[DEC-REFUND-ESCALATION-PILOT](./refund-escalation-pilot.md) 第 2 项、
[DEC-PERM-CATALOG](./permission-catalog-and-store-roles.md)（员工姓名必填，Owner 2026-10-18"必填（推荐）"）。

## 决定

1. **配置切换**：试点运行目录的 `staff-sign-in.json` 选择登录方式。没有该文件（或 `"mode":"internal-test"`）时保持 TEST-ONLY 登录页与
   TEST-ONLY 验证器，行为不变；`"mode":"cognito"` 时：`/internal-test/staff` 不再提供，登录入口为应用内 `/operations/sign-in`
   （"Sign in"、"Start kitchen display"、"Switch staff with a PIN"），`/merchant/login` 走 Cognito 托管登录（授权码 + PKCE、`prompt=login`、
   `max_age=0`、每次都要验证器），回调 `/merchant/callback`。客户端密钥、PIN pepper、平板密钥、锁屏选择密钥各自读自运行目录中仅属主可读的
   文件，缺失或格式不对即拒绝启动，绝不进日志。会话规则不变：`WorkforceStandard`（空闲 30 分钟滑动、绝对 12 小时）、厨房屏
   `NamedKdsOperator`（`/operations/kitchen/start` 登录即开始具名班次）、PIN 快速切换、会话结束覆盖层与超时提醒。会话只在本人仍是本店在职
   成员（Membership 与门店分配均 Active）时选中本店。退出时撤销本会话并吊销 Cognito 刷新令牌；因每次登录都 `prompt=login`，共享设备上
   托管登录的残留不会让下一人免密进入。登录被拒（无邀请、邀请过期、已离职）回到登录页并以员工能读懂的话说明。
2. **账号绑定（Identity 所有，迁移 `2000_092`）**：`store_staff_invitation`（邀请：只存邮箱的带密钥摘要与掩码提示，如 `m•••@example.com`；
   Pending/Accepted/Revoked，最后一次发送起 7 天到期，触发器只允许发送记录、重发、接受、撤销，结束后不可改）与 `store_staff_account`
   （本人首次登录时绑定的 Cognito 账号，只存 subject 的带密钥摘要，只追加）。首次登录：已签名的 `cognito:username`（`bop_<人员引用>`）
   指向待接受的邀请，且 Cognito 管理接口当时确认该账号属于这份邀请（同一邀请意图摘要与邮箱、已启用、已设密码）且 subject 一致，才绑定；
   同一事务内邀请转 Accepted、Membership 由 PendingActivation 转 Active（以邀请为工作关系证据）、记录验证器已设置（`TotpVerified`）。
   绑定本身不授予任何权限：角色仍须另一位管理员批准（`identity.role.approve`），且只能在本人加入后批准。
   与品牌管理首位账号（WP-2421 `workforce_account_binding`，平台双人签名）分开：门店员工的双人控制在角色授予处。
3. **应用内邀请**（Section 88 `IAM-USER-LIST` 的 Invite / Resend Invite，`organization.staff.manage`）：姓名（必填）、工作邮箱、角色。
   同一事务写入待激活 Membership、门店分配、姓名、邀请与角色申请；事务外由 Cognito 创建账号并发邮件（Cognito 自己的邮件，含临时密码，
   不经 `@bop/notification`）；再记录"已发出/未确认"。重发：仍在等首次登录的账号由 Cognito 重新发送新的临时密码；Cognito 从未建成账号时
   要求重新输入同一邮箱（摘要一致）后再建。撤销：邀请 Revoked、Membership 与门店分配 Ended、未决角色申请关闭，并删除仍未使用的 Cognito
   账号，使同一邮箱可重新邀请。同一邮箱同时只能有一份待接受邀请。全部写审计，审计不含姓名、邮箱或 subject。
4. **首位店主与切换**（运营执行，`tooling/environment/store-staff-sign-in.mjs`）：`invite-first-owner` 只用于尚无在职店主的门店，建立邀请
   与由运营人员发起的店主角色申请；店主首次登录后，店主角色仍走既有平台签名批准（`store-role-provisioning prepare-assignment →
sign-assignment → apply-assignment`，批准人 ≠ 申请人）。`link-existing-member` 让从 TEST-ONLY 登录切换过来的在职成员（保留角色与历史）
   获得本人的 Cognito 登录；已有登录者拒绝。
5. **加验（MFA step-up）**：Cognito 模式下"Verify it's you"打开一个窗口重新登录（同一账号、密码 + 验证器，`prompt=login`），回调
   `/merchant/identity/step-up/callback` 确认是本会话本人后，在原加验记录 `workforce_mfa_step_up` 写入方法 `CognitoReauthentication`
   （单次使用步号为 Cognito 认证时间秒数，5 分钟内有效；重放、他人登录、会话已结束一律不记录），退款审批与 PIN 会话提权读取同一时效。
   完整登录本身也记为本会话的加验（`IDENTITY_SIGN_IN`），刚登录即可审批，不再二次弹出。TEST-ONLY 验证器只在 internal-test 模式提供。
6. **能力缺口**：`StaffLogin` 只在 `staff-sign-in.json` 选择 Cognito 且全部密钥文件存在、格式正确、未指向本地替身时关闭（`pilot-supervisor`
   启动检查）。`Secrets`（会话信封与选择器密钥仍来自内部测试密钥文件）与 `Tls`（服务仍只在 `https://127.0.0.1:4443`）照旧。
7. **本地替身**：`tooling/environment/cognito-test-provider.mjs`（TEST-ONLY，生产进程拒绝启动）实现 JWKS、托管登录页、令牌、吊销、退出与
   AdminCreateUser/AdminGetUser/AdminDeleteUser，并可注入故障（500、挂起、丢失应答、令牌声明变化）。`staff-sign-in.json` 的 `testProvider`
   只在 InternalTest 接受。

## 运行连续性

- Cognito 或网络不可用：已登录的人照常工作（会话在本系统，不依赖 Cognito）；新登录与加验失败。共享平板上已设 PIN 的员工仍可用 PIN 切换
  （PIN 校验只需本系统）；需要加验的操作（退款审批等）等待恢复或由已加验的人处理。断网按 Q9 手册走纸单。
- 忘记密码或丢失验证器：池为 `admin_only` 恢复，员工找店主/店长，店主联系 BOP 支持在 Cognito 中重置（运行手册）；期间可用 PIN 做非敏感操作。
- 邀请邮件未到：员工页显示"未确认"并可重发；7 天后过期须重发。

## 待真实账户验证（不能在仓库内证明）

- Cognito 令牌是否带 `acr`/`amr`：现有协议（品牌管理已用）要求 ID/访问令牌 `acr=urn:cognito:loa:4`、`amr` 含 pwd/otp/mfa；若真实池不签发
  这些声明，需按实测调整协议的强认证判定（例如依赖池 MFA=ON 与 `auth_time` 新鲜度），属 IDR-0025 的实施细节，届时记录。
- `prompt=login`/`max_age=0` 在托管登录上确实强制重新输入；首次登录的改密与验证器绑定流程；邀请邮件模板与发件身份。

## 检查

单元（Identity 协议门店档案、门店提供方、邀请适配器重发/删除/回环端点、API 邀请命令解析、工具链配置读取与能力缺口、组合）；隔离
PostgreSQL 受限 NOBYPASSRLS 角色 + 渲染的试点授权 `cognito-store-staff`（邀请/必填姓名/重复邮箱/无权限、首次登录绑定与激活、再次登录、
厨房屏、伪造用户名/挂起/令牌失败/过期拒绝、重发与补邮箱、撤销与重邀、加验记录/重放/他人/取消、运营首位店主与已有成员、HTTP 路由）；
商户生产浏览器 `staff-cognito-sign-in`。结果记录在 WP-2423。
