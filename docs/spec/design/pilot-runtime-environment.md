# DEC-PILOT-RUNTIME-ENVIRONMENT — Pilot 门店进程：守卫清点、接口收尾与 Pilot 模式冒烟

状态：**Accepted（协调人按商用原则决定，2026-10-20；Owner 可推翻）**。执行工作包：[WP-2423](../work-packages/WP-2423.md)。
Owner 指示（2026-10-20）："先把接口都做好"。上位：AGENTS.md"商用保真""不可达的桩""运营连续性"；
[DEC-STRIPE-PILOT-WIRING](stripe-pilot-wiring.md)"仍需"末项、[托管接口](pilot-hosting-integrations.md)、
[DEC-COGNITO-STORE-STAFF](cognito-store-staff.md)、[DEC-PILOT-NOTIFICATIONS](pilot-notifications.md)、
`tooling/environment/pilot-environment.mjs`（两个环境与能力缺口）。切换步骤见
[单店试点运行手册"切换到 Pilot 门店"](../../runbooks/single-store-pilot.md#switching-a-store-to-pilot-dec-pilot-runtime-environment)。

## 问题

付款（Stripe live）、员工登录（Cognito）、受管密钥与证书都已能按配置关闭缺口，但 Pilot 门店进程（`NODE_ENV=production`、
`BOP_PILOT_ENVIRONMENT=Pilot`）仍会在主线路径上被只认 development/InternalTest 的守卫挡住：顾客 HTTPS 入口与顾客服务器、
业务 worker 事件授权、日结、已保存的工作流/库存/任务队列文件只接受 `environment: "InternalTest"`；顾客端堂食员工命令始终用 DEMO
员工名单会话（Cognito 模式下也是）；Pilot 门店没有本地入口证书的签发方式，也没有 DEMO 启动器以外的取餐入口。

## 决定

1. **三种守卫，按含义选用**（不新增环境）：试点进程本身 → `isPilotRuntime()`（InternalTest 或 Pilot 门店，其余一律拒绝）；
   配置/运行文件 → `matchesPilotEnvironment(file.environment)`（文件必须声明本进程的环境，两个环境的文件永不混用）；
   模拟、DEMO、测试密钥 → `isInternalTest()`/`NODE_ENV=development`（Pilot 中拒绝）。
2. **清点结果**（`git grep` NODE_ENV/InternalTest/环境函数，非测试文件 307 处；导入行与已是通用守卫的从略）：

   | 类                    | 位置                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 处理                                                                                                        |
   | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
   | b 改为试点进程        | `pilot-https-entry` 入口、`pilot-customer-server` 启动、`pilot-worker` 事件授权 `authorizeScope`、`pilot-daily-settlement-execution` 的 `active`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `isPilotRuntime()`（+ 档案环境一致）                                                                        |
   | b 文件按环境          | `pilot-payment-intent`/`pilot-additional-payment`（已保存 Pickup/DineIn 工作流）、`pilot-items`（库存）、`pilot-merchant`（任务队列）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `matchesPilotEnvironment`                                                                                   |
   | b 本地入口证书        | `pilot-provision-tls`（`issue`/`renew`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Pilot 门店也签发/续期 127.0.0.1 本地入口证书（`front` 以它为唯一信任根再加密转发；公网证书归 hosting.json） |
   | b 员工会话            | 顾客端堂食员工命令（开台、加入码）一直用 DEMO 名单会话                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 与商户 BFF 共用 `staff-sign-in.json` 选出的会话（`pilot-staff-session.mjs`，同进程同一实例、同一池检查）    |
   | b 顾客取餐入口        | `/bff/internal-test/pickup-entry` 只在 `https://127.0.0.1:4443`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 见第 3 项                                                                                                   |
   | a 保持仅 InternalTest | 模拟服务商及其收款日志/结算/退款（`pilot-payment-provider`、`pilot-capture-journal`、`pilot-settlement-provider`、`pilot-refund-provider`）；DEMO 名单会话与登录页（`pilot-merchant-session`、`pilot-staff-login`）；TEST-ONLY 验证器（`pilot-staff-totp`）；DEMO 桌台启动器与固定桌码（`pilot-dining-launcher`、`pilot-qr` `loadInternalDiningQr`）；测试密钥生成（`pilot-credentials` 生成、`pilot-provision-credentials`、`provisionInternalQr`、堂食密钥生成）；内部测试续期（`pilot-internal-test-renew` 与 packages 的 internal-test 有效期仓）；合成定价/税务（`pilot-pricing-policy`，即缺口 `PricingCurrencyMetadata`）；本地替身（`cognito-test-provider`、`pilot-stripe-fake`、`testApiBaseUrl`、`staff-sign-in.json` `testProvider`）；旧 `InternalTestBatchCancellation` 工作流；本地顾客实验室（`apps/api` local-customer-runtime、customer-pwa lab）；v14/v15 一次性工具（`pilot-recovery*`、`pilot-installation-backup`、`applyStandardRefundRoleMapping`） | 不变；Pilot 冒烟逐项确认拒绝                                                                                |
   | 非守卫                | `InternalTestOnlineCardAutomatic`（异常覆盖的组合标签，Stripe live 同为线上卡自动扣款）、日志环境、`transaction-runner`（生产不拒并发查询）、`Dockerfile.pilot` 默认 `NODE_ENV=development`（compose 覆盖为 production）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 不改                                                                                                        |

3. **门店地址即取餐入口**：顾客服务器在两个环境都提供 `GET /bff/customer/pickup-entry`（同源、无参数、no-store，返回本店取餐码），
   顾客端在根地址 `/`（无 hash/查询）用它进入取餐点单，不再限定 `127.0.0.1:4443`。取餐海报的二维码就是顾客域名本身：密钥轮换或
   绑定续期都不用重印。旧路径 `/bff/internal-test/pickup-entry` 只在 InternalTest 保留（兼容已缓存的旧版页面）；`#internal-dining=`
   桌台启动器仍只在本地入口。Pilot 门店的 `customer-runtime.json` 必须 `diningTableFiles: []`（InternalTest 仍须 ≥1），堂食只认
   DIN-TABLE-LIST 打印的桌码。运行时配置字段名 `internalTestEntry` 保留（已安装页面兼容），含义为"门店地址可直接点单"。
4. **测试替身只能经代码进入**：Pilot 模式冒烟需要把 api.stripe.com、Cognito 两个主机与公共信任库换成本地替身。做法是函数参数
   `harness`（`createPilotPaymentProvider` 的 `fetch`、`createInternalMerchantCognitoSession` 的 `http`/`providerEndpoint`）与
   `checkPilotStartReadiness` 的 `checkCapabilities`；没有任何配置文件字段、环境变量或请求能设置它们，运行时入口也从不传入
   （`pilot-harness-seams.test.mjs` 静态检查非测试模块）。`testApiBaseUrl`、`testProvider` 维持仅 InternalTest。
   `PricingCurrencyMetadata` 不设任何覆盖（冒烟不走报价，见验证）。
5. **按环境签发的数据**：所有运行文件（档案、菜单、库存、名单/任务队列、各 worker 配置、工作流绑定、日结覆盖）必须声明进程环境，
   由安装/发布工具为 Pilot 门店重新签发，绝不把 InternalTest 文件改名或改标签。现有工具中：取消工作流
   `workflow-release-install --runtime-environment Pilot`、受管密钥 `pilot-secrets generate`、本地入口证书
   `pilot-provision-tls issue`、首位店主/成员 `store-staff-sign-in`、Stripe `pilot-stripe-operations` 已支持 Pilot。
6. **启动检查可调用**：监督进程的启动检查抽为 `checkPilotStartReadiness`（行为不变：Pilot 门店先查受管密钥与证书并逐条
   `PILOT_NOT_READY`，再查付款与员工登录，余下缺口即 `PILOT_CAPABILITY_MISSING:<codes>`）。

## 运营连续性

本决定不改变各流程的故障处置（付款、登录、托管各自的决定与运行手册照旧）。新增的门店地址入口与 API 同进程：入口或主机不可用时
`front` 返回维护页（"在柜台点单"），与原有一致。

## 验证

单元：`pilot-customer-server`（Pilot 档案/进程不一致拒绝；Pilot 门店提供 `/bff/customer/pickup-entry`，旧路径与桌台启动器的请求
落到 API（无此路由，404），DEMO 登录页不存在；测试用替身 API 端口，不连 4300）、`pilot-worker`（Pilot 门店派发本店事件、未声明 Pilot 的 production 不派发）、
`pilot-installation`（Pilot 文件、`diningTableFiles: []`、InternalTest 工作流在 Pilot 拒绝）、`pilot-provision-tls`（Pilot 签发
CA:FALSE 本地入口证书、环境不一致拒绝）、`pilot-staff-session`、`pilot-supervisor-readiness`、`pilot-harness-seams`、customer-pwa
`internal-entry`。

隔离 PostgreSQL 受限 NOBYPASSRLS + 渲染试点授权 `pilot-runtime-environment`（`NODE_ENV=production`、`BOP_PILOT_ENVIRONMENT=Pilot`）：0. 临时运行目录（hosting.json 测试域名与 `front` 测试证书、`pilot-secrets generate` 生成的受管密钥、payment.json live、
staff-sign-in.json Cognito）→ 启动检查只剩 `PricingCurrencyMetadata`；去掉测试根证书则 `Tls: certificate-not-trusted`；模拟服务商、
`testApiBaseUrl`、test 模式、`testProvider`、DEMO 名单会话、DEMO 启动器与登录页、合成定价、Cognito 替身启动一律拒绝。

1. 员工：`pilot-staff-session` 选出 Cognito 会话（受管客户端密钥与信封密钥，`key_reference` 为 `pilot-merchant-v1`），运营
   `link-existing-member` 后店主首次登录绑定账号并记 `IDENTITY_SIGN_IN`；顾客端组合取得同一会话。
2. 付款：payment.json → Stripe live（环境 `Live`）；Stripe 签名的 live Webhook 记 Live 终态事实与 `PaymentSucceeded`。
3. 退款加验：再次在 Cognito 登录记 `PAYMENT_REFUND_APPROVAL`；退款经同一服务商发往 Stripe live；Test 环境请求被拒。
4. 日结：Payment 的 Live 收款窗口与 Stripe live 余额交易同窗一致，退款 500 分计入。

**未覆盖（如实）**：购物车、报价与结账（需要已审查的税务配置，即剩余缺口；没有覆盖值）、接单/厨房/交付（领域流程与环境无关，
守卫为 `isPilotRuntime()`，InternalTest 下各自验收覆盖）、监督进程拉起子进程（依赖 Linux `/proc`，在试点镜像内跑单元）、浏览器。
订单与付款由种子写入（同 `stripe-pilot`），不是从购物车生成。

## 仍阻止真实 Pilot 启动

1. `PricingCurrencyMetadata`：真实门店的币种与税务配置及专业审查（外部 + P5），不可伪造。
2. ~~Pilot 安装签发~~、3. ~~Pilot 续期~~：已由 [DEC-PILOT-INSTALLATION](pilot-installation.md)（2026-10-20）完成——`pilot-installation-issue`
   从数据库已发布事实签发运行目录（prepare/sign/apply，审计、可重放），`workflow-release-install` 发布取餐/堂食/加单工作流并写绑定文件，
   Pilot 续期需 Owner 批准原话与平台签名并提前 14 天告警；启动检查新增 `Installation` 缺口。品牌/门店初始化（B2）仍属外部。
3. 外部：Stripe live、Cognito 池、托管主机/域名/证书/受管密钥/S3、通知账户与实测（各决定已列）。
