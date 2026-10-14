# DEC-TABLE-QR-ISSUANCE — 试点桌码签发、打印导出与单桌作废

状态：**Proposed（实现决定按商用原则作出，2026-10-14）**；标"待 Owner 确认"的项需要 Owner 确认；迁移、授权与权限目录 v9 标
"PENDING OWNER APPROVAL (WP-2423 Q11)"，Owner 批准前不在 v15 应用。执行工作包：[WP-2423](../work-packages/WP-2423.md)（Q11）。
上位依据：Handoff §88.11 `DIN-TABLE-LIST`（"issue / revoke QR capability"，Store Manager）、Dining QR 契约（ES256 签名载荷、
`revocationVersion`、最长 180 天）、[DEC-PERM-CATALOG](permission-catalog-and-store-roles.md)。

## 调查结论（为什么只能在 InternalTest 用）

1. 桌码不是门店签发的：每张桌的二维码载荷来自安装目录里的 DEMO 文件（`internal-test-dining-table*.json`），`pilot-qr.mjs`
   在请求时用本地生成的 TEST-ONLY 私钥现签；文件写死 `qrVersion: 1`、签发时间取安装资料创建时间、有效期取安装资料 `validUntil`
   （v15 为 2026-10-20，到期后所有桌码同时失效，店员没有任何提示）。
2. 顾客不是扫桌上的码进入：只能经 `/internal-test/dining` 选桌（DEMO 启动页）。门店没有可打印的码。
3. Dining 领域已具备正确的作废模型：桌台有 `qrStatus`（Inactive/Active/Revoked）与 `qrVersion`，`IssueQr`/`RevokeQr`
   命令带审计与事件；顾客进入与会话校验都要求载荷的 `revocationVersion` 等于桌台当前 `qrVersion`。缺的是：商户命令与页面、
   已签发码的存储、打印导出、顾客端"已更换"的说明。
4. 整个试点进程因 `pilotCapabilityGaps`（含 "Secrets"：会话、QR、游标密钥的托管来源）只能以 InternalTest 运行。本次不解除该关口，
   而是让真实门店的签发/打印/作废流程在产品里完整可用，签名密钥仍取当前 TEST-ONLY 来源，并写清托管密钥到位后改什么。

## 决定

1. **谁可以操作**：新权限 `dining.table.qr.manage`（"Issue, print, replace and turn off table QR codes"，Medium），权限目录 v9。
   店主与店长模板自动包含（店长按 `dining.` 前缀），前台不含——前台在桌台页看到提示后找经理。页面、列表、命令、打印每一步在同一事务内
   按该权限重新授权；页面在导航中只对持有者显示（`DIN-TABLE-LIST`，`/app/operations/tables`，"Table QR codes"）。
2. **码里有什么**：只有签名的桌台入口——`schemaVersion、qrReference（每张码新的）、publicStoreReference、publicTableReference
（每张桌固定，替换后不变）、channel=DineIn、locale、issuedAt、expiresAt、revocationVersion=桌台 qrVersion`，ES256 签名。
   不含任何密钥、内部桌台/门店编号或个人信息。码印成 `https://<顾客域名>/#qr=<签名令牌>`：令牌在片段里，不随 HTTP 请求发送、
   不进服务器日志；顾客端读入内存后立即清掉地址栏片段（已有行为）。
3. **存储**：迁移 `2000_042_create_dining_table_qr_issue`（`@rms/dining`）：每次签发一行，与使提升 `qrVersion` 的 `IssueQr` 桌台操作
   同一事务写入（触发器核对操作、版本、时间一致；同店内公共桌台编号与桌台一一对应）；保存签名后的码原文（公开数据），使损坏的贴纸能
   **原样重印**而无需重新签名；只追加（禁止 UPDATE/DELETE），RLS 按品牌/门店。
4. **三种操作，对应门店真实场景**：
   - **打印/重印**（贴纸脏了、掉了）：码不变，下载打印页再印；可单桌、可"Print all codes"。
   - **更换**（码丢失、被拍走、被复制）：`IssueQr` 提升版本并签发新码；旧码**立即**不能进入；只影响这一桌，其他桌不用重印。
   - **停用**（桌台撤出使用）：`RevokeQr`；扫旧码的顾客被请去找店员；之后可再"Create code"。
     每个命令带幂等操作号与期望版本；结果未知时页面只提供"用同一请求重试"，不会重复签发；版本冲突返回 409 并刷新列表。
5. **打印导出**：服务器端生成可打印的 HTML（A4，2 列，每张码 6 cm，桌号、"Scan to order and pay from your phone"、三步说明：用相机扫、
   向服务员要本桌加入码、手机点单付款无需应用或账号；小字"Code works until <门店日期>"）。不含内部代码或编号；不需要脚本或外部资源，
   可离线打开、在任何电脑打印或存为 PDF。二维码编码器在服务器端实现（纠错级别 M，ISO/IEC 18004），已用 macOS CoreImage 回读验证
   版本 1–40 与浏览器中实际渲染的打印页。每次导出写审计 `DINING_TABLE_QR_PRINTED`（谁、哪些桌）。
6. **已入座的客人（决定，待 Owner 知悉）**：更换或停用后，**旧码进入的手机会话立即失效**（Dining 契约既有规则：顾客会话的
   `qrRevocationVersion` 必须等于桌台当前版本；码被复制时这正是要切断的访问）。**桌台会话、已下的订单与账单不受影响**；客人扫新码并
   再输入本桌加入码即回到同一桌。页面在该桌有客人时先说明这一点并要求勾选确认；平时应在桌台空闲时更换。不采用"旧码会话保留到用完"，
   因为那会让被复制的码在整个用餐期间继续有效，并需改动已接受的 Guest/Dining 契约。
7. **到期前提醒（"Warn before timeouts"）**：码的有效期取契约上限 180 天。Table QR codes 页在任何码 30 天内到期时显示"Codes stop working
   soon … Replace and print before then"；前台使用的桌台页（`DIN-FLOOR-BOARD`）在该桌显示"Table QR code stops working in N days. Ask a
   manager to print a new one."，没有可用码的桌显示"No table QR code. Ask a manager to print one."。
8. **顾客端说明**：扫到已更换的码显示"This table code was replaced. Please ask a staff member."；已停用的码显示"This table code is no
   longer in use. Please ask a staff member."。只有码与本店存储的某张已签发码完全一致时才这样说（其他无效码仍是通用的"无法使用"，
   不提供探测）；不签发会话、不设 Cookie（HTTP 410 `entry_qr_retired`）。
9. **审计**：签发 `DINING_TABLE_ISSUEQR`（原因 `TABLE_QR_ISSUED` / `TABLE_QR_REPLACED`）、停用 `DINING_TABLE_REVOKEQR`
   （`TABLE_QR_TURNED_OFF`）、打印 `DINING_TABLE_QR_PRINTED`，均记录具名员工，与桌台变更同一事务。
10. **DEMO 启动页**：`/internal-test/dining`（仅 InternalTest）改为打开各 DEMO 桌当前已签发的码；未签发时返回不可用。顾客进入只认
    已签发的码，DEMO 文件不再提供桌码。

## 签名密钥与顾客域名（TEST-ONLY 与托管后的变化）

- **当前（TEST-ONLY）**：签名用安装目录的本地 `internal-test-qr-key.pem`（`kid=internal-test-v1`，权限 0600，仅在 InternalTest 加载，
  私钥不离开进程、不记录）。打印的地址是本地 `https://127.0.0.1:4443`——**手机扫不到**，只能在本机测试（打印页中的码也是可点的链接）。
  真实门店贴纸须等域名与公网证书（关口 "Tls"）。
- **托管密钥到位后（关口 "Secrets"）**：只替换签名端口（`DiningTableQrSigner`）与验证用的公钥集合来源；新 kid 以 `Current` 加入，
  旧 kid 以 `Overlap` 保留到其码全部重印；已存储的码与流程不变。若旧 TEST-ONLY 密钥被视为泄露，应在切换时标记 `compromisedAt`，
  所有旧码立即失效，门店一次性"Print all codes"（先在页面替换全部）。真实门店上线前应全部换为托管密钥签发的码。
- **顾客域名到位后**：`customerOrigin` 改为正式顾客域名；之前打印的 127.0.0.1 码须全部更换并重印。

## 营业连续性

- **网络或服务器不可用**：扫码无法点单（与其他在线流程相同）；店员改用柜台点单/纸质记单并在恢复后补录（[DEC-COUNTER-PAYMENT-RECORD](counter-payment-record.md)，
  Q7/Q9）。已贴好的码不受影响，恢复后照常可用。
- **打印机不可用**：打印页是可离线的文件，可在任何电脑或手机打印、或存为 PDF 送打印店；码不会因下载而改变。
- **码被复制但暂时无法打印新码**：仍应立即"Replace"——旧码立刻失效；在新贴纸放好前，该桌客人由店员柜台点单。
- **签发结果未知**（断网在提交时）：页面保留同一操作号，只提供"Try again"，服务器按操作号返回同一结果，不会多出第二张码。

## 迁移、授权与权限（PENDING OWNER APPROVAL (WP-2423 Q11)）

- 迁移 `2000_042_create_dining_table_qr_issue`（见决定 3）。
- 授权（`docs/spec/pilot-acl-additions.json`）：`api` 角色 `SELECT, INSERT ON rms_dining.dining_table_qr_issue`。其余沿用已批准权限
  （`dining_table`、`dining_table_operation`、审计追加）。
- 权限目录 v9（`dining.table.qr.manage`）：v15 须安装目录 v9 并按签名计划把门店系统角色从当前版本升级（与 v7/v8 相同流程）。
- **部署顺序**：先应用迁移 042 与授权、安装目录 v9 并升级门店角色，再部署代码。否则桌台页（读取桌码以提示到期）与堂食扫码进入会失败。
- **v15 现有 DEMO 桌**：桌台 `qrVersion` 为 1 但没有已签发码，Table QR codes 页显示"No printable code"，店长点"Create code"即签发版本 2；
  DEMO 文件中的旧码随即不能进入。

## 待 Owner 确认

1. 决定 6：更换/停用时已入座客人的手机需重新扫码并输入加入码（订单与账单不受影响）。
2. 上述迁移、授权与权限目录 v9（含门店角色升级的签名计划）。
3. 码有效期 180 天（契约上限）与 30 天提前提醒；如需更长须修订 Dining QR 契约。
4. 打印尺寸：令牌约 600 字符，码为版本 19 左右（约 89×89 模块），按 6 cm 打印手机可识读；不要缩小。缩短码需要另设短码中转，不在本次范围。

## 剩余工作

- 外部关口：托管 QR 密钥（"Secrets"）、正式顾客域名与证书（"Tls"）——之后按上文切换并全部重印。
- v15：Owner 批准后应用迁移/授权/目录 v9，签发并打印 DEMO 桌码，按 Q11 记录实测。
