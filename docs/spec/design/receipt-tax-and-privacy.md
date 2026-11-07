# DEC-RECEIPT-TAX-AND-PRIVACY：收据税务信息、隐私声明链接与顾客删除联系方式（WP-2423 Q15/Q16）

状态：协调人决定，Owner 可推翻（2026-10-14）。迁移与授权按 Owner standing approval 2026-10-14 (WP-2423 Q15/Q16)。

## 问题

- Q15：顾客电子收据只有一行"Tax"，没有 GST/HST 登记号与营业地址，不能作为加拿大的税务收据；"邮件收据"在发送接通前已于 Q10 隐藏（本次核对：结账与收据页均无该选项，`receipt-http` 规格断言收据页无"Request email receipt"）。
- Q16：没有隐私声明；取餐联系方式的 30 天保留期清除已在 Q10 R2 落实，但顾客没有自己删除的途径，也看不到门店的隐私声明。

## 决定

1. **所有者与事实来源（不编造法律/税务事实）**
   - 法定名称：沿用 Operating Entity 的 `legalName`（收据已有的 `operatingEntityDisplayName`）。
   - 营业地址：门店公开资料（Store 所有者，既有发布流程，Q10 "Contact the store"同一来源）的地址，**在开具时冻结**进收据。
   - 登记号与隐私声明链接：新 Store 所有者事实 `rms_store.store_receipt_profile`（迁移 `2000_048`，只追加版本、连续版本号、每版须有变化、触发器拒绝改写/删除/截断、RLS 按门店）。字段均可为空：GST/HST（CRA 格式 9 位 + RT + 4 位）、QST（10 位 + TQ + 4 位，仅魁北克）、PST（BC/SK/MB，按省颁发原样）、隐私声明 https 链接。系统只校验官方公布的格式，不校验号码真伪；未登记某税种就留空，收据不打印该行。参照常见 POS（按门店的收据设置），因为特许/多实体经营时每店的开票实体可能不同。
   - 只有 Owner（`organization.store.publish`）可改；能打开门店设置的员工（`organization.store.read`）可看。审计 `STORE_RECEIPT_PROFILE_CHANGED` 只记哪些字段有值，不记号码。无新权限、无目录变更。
2. **收据快照（只追加，不改写已开收据）**：`DigitalReceiptSnapshot` 新增可选 `taxDetails`：`businessAddress`、`taxRegistrations`、`taxLines`（按税种代码、税率、是否含在价内分组，**直接汇总订单项冻结的税务快照 `taxComponents`**，不重算；免税/零税率不出行；各行之和必须等于 `tax`）、`paymentMethod: "Card"`（数字收据只覆盖线上卡付款）。旧收据无此块，仍按"Tax"一行显示。退款版本复制上一版快照（含 `taxDetails`）；补加批次的新版本以开具时的当前事实生成新块；Owner 之后改号码不影响已开收据。税率以百分数字符串显示（"0.13"→"13"，按位移位，无浮点）。
3. **顾客端**：收据页显示法定名称、门店名、地址、"GST/HST registration no. …"（有才显示）、每税种一行（"HST 13%"）、"Card · Paid"（付款状态改用顾客语言）；Owner 填了隐私链接才显示"Privacy notice"（新标签页、`noopener noreferrer`），未填时不显示任何占位。结账联系信息说明改为"只用于联系您此订单；下单 30 天后删除，也可在订单页提前删除"，后接隐私链接（如有）。订单页"Your contact details"：仍存有联系方式时说明用途与保留期并提供"Remove my contact details"（二次确认说明删除后门店无法就此单联系，凭订单号取餐）；已删除时说明已删除。
4. **顾客删除联系方式**：`POST /api/v1/orders/{id}/contact-removal`（同源、Guest Cookie + CSRF；当前访问会话必须是下单会话）。复用 Q10 的一次性清除（守卫触发器不变），证据行 `policy_code='CUSTOMER_REQUEST'`、`retention_days` 为空（迁移 `2000_049` 放宽列与约束：保留期清除规则不变，顾客请求只要求不早于记录时间）。重复请求返回 `AlreadyRemoved` 不写入；审计 `CHECKOUT_CONTACT_REMOVED_ON_REQUEST`（System、`CUSTOMER_PWA`，不含原值）。会话已结束时顾客看到"请店员删除"。
5. **员工提示**：门店设置顶部"Receipts and privacy"区块与"Tax review"在缺登记号或缺隐私链接时显示"Receipts and privacy need the Owner's details"（"Add your privacy notice link before going live"），Tax review 链接到门店设置该区块。

## 营业连续性

登记号/链接读取失败不阻断开票：收据仍开具（缺失项不打印），员工页提示缺失。顾客无法在线删除（断网或会话结束）时，页面指引请店员处理；30 天保留期清除照常运行。

## 外部关口（Owner 录入，仓库不编造）

真实的 GST/HST（及适用时 QST/PST）登记号、门店公开资料中的真实营业地址、门店自己的隐私声明网址与正文（法律文本）。内部测试可录入明确标注 TEST-ONLY 的值；v15 当前未录入任何值，收据不显示登记号，员工页显示提示。
