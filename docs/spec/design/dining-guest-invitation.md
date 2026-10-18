# DEC-DINING-GUEST-INVITATION — 同桌客人互相邀请（堂食入桌）

状态：**协调人按已接受规则决定（2026-10-17），不修订规范，Owner 可推翻**。执行工作包：[WP-2423](../work-packages/WP-2423.md)。
依据：Handoff §6.11（订单负责人可"邀请参与者"）、§25.5（参与点餐需本 Session 的临时短码或邀请链接）、§87.4.1（加入凭据：
128 位邀请链接或 6 位短码，绑定 Store、Table、Session，15 分钟，加入成功、重新生成、Session 结束或换桌即作废；短码尝试按更严预算）、
§87.4.2（加入失败 5 次 / 10 分钟 / Session）、§87.11.2（首个试点为店员开台，固定桌码不能自行入桌）；
[DEC-DINING-ANY-PARTICIPANT-SUBMIT](dining-any-participant-submit.md) 第 3 条（桌主其他权限不变）。

## 问题

每位客人入桌都要店员在 Tables 页发一次性桌码；一桌 4–6 人时店员要跑多趟，客人要等。

## 决定（2026-10-17）

1. **谁能邀请**：只有本桌**桌主**（第一个入桌的客人，或店员转移后的桌主），且其仍在座、本桌会话为 Active。§6.11 把"邀请参与者"列为桌主
   权限，其他参与者"默认只管理自己添加的商品"，DEC-DINING-ANY-PARTICIPANT-SUBMIT 也保留桌主其他权限不变，所以**不扩展到其他参与者**；
   他们看不到入口，请桌主或店员发码。
2. **邀请就是本桌的下一个一次性桌码**：桌主手机"本桌"页的"Invite someone at your table → Make a code"生成本 Session 的下一代加入凭据
   （与店员发码同一能力：6 位短码，绑定 Store、Table、Session，15 分钟有效，加入成功即作废）。每桌任一时刻**只有一个有效码**：
   新码（不论桌主还是店员发的）使之前未用的码立即作废——即 §87.4.1 的"重新生成作废"，也比"多码并存"更严。会话结束（开始结单即不可加入）
   或换桌后旧码作废；换桌后桌主需请店员为新桌发码（店员的换桌重签会核对已提交的换桌记录）。
3. **只发 6 位短码，不发二维码**：被邀请人本来就在同一张桌，先扫桌上的二维码（固定码只给桌台上下文，§87.11.2），再输入短码。
   不另做"桌码 + 邀请"合一的二维码，避免新增一种公开凭据形态。
4. **频率限制**：每个 Session 在任意 10 分钟内最多由客人生成 10 个码（`dining_guest_invitation_operation` 近 10 分钟记录计数，
   在桌台/会话锁内判断，数据库触发器再核一次）；超出时告诉客人几点后可再生成或请店员发码。店员发码不计入、不受限。
   加入失败预算（5 次 / 10 分钟 / Session，20 次 / 10 分钟 / IP·设备）不变。§87.4.2 表未列"发码"类，未改
   `docs/security/rate-limit-abuse-baseline.json`。
5. **客人文字**：码分两组大字显示（读屏逐位朗读），"Show this code to the person joining you. It works once and for 15 minutes
   (until HH:MM)."，"For someone else after them, make a new code. A new code replaces this one."；过期、已用、非桌主、换桌、
   超限、离线各有说明，不出现内部代码或编号。码只在内存中，不进地址栏、存储、日志或审计；同一请求重放不再返回码（"Make a new one"）。码显示期间桌主手机每几秒（及页面重新可见时）按本机发码请求号查询该码是否仍有效、已被使用或已被替换/作废（回答不含码，只查本人记录），已用时显示"Someone joined with this code."并给"Make another code"，被替换时显示"This code was replaced. Make a new one."（v15 `42e95248` 实测，2026-10-17）。
   加入页与"已用/无效"提示改为"Ask staff, or the person who invited you, for a new one."。
6. **记录与审计**：迁移 `2000_082_create_dining_guest_invitation_operation`（`@rms/dining`，只追加、门店 RLS、禁止改删，触发器核对
   发码人是当前桌主且在座、能力行与记录一致、10 分钟预算）：操作号、Session、桌主参与者、新能力快照（只有选择器哈希，没有码）。
   审计 `DINING_JOIN_INVITATION_ISSUE`（System 操作者、`CUSTOMER_PWA`、目标为桌台、原因 `HOST_INVITED_GUEST`，变更摘要为空，无个人信息）。
7. **店员不受影响**：店员仍可随时换发/作废（Tables 页、店员录入一轮），会使桌主未用的码作废；店员页面在换发前读当前状态，不会因客人发过码而失败。

## 营业连续性

- 断网或服务器不可用：桌主不能生成码，与其他在线流程相同；店员按既有流程发码或柜台/纸单点单（运维手册断网流程）。
- 桌主手机没电或离桌：店员在 Tables 页发码，或转移桌主后由新桌主发码。
- 码被拍走或误发：再点一次"Make a new code"（旧码立即作废）或请店员换发。

## 授权与上线

- api：`SELECT, INSERT ON rms_dining.dining_guest_invitation_operation`（`pilot-acl-additions.json`，Owner standing approval 2026-10-14）。
  其余（桌台、会话、参与者、加入能力 UPDATE、审计）沿用已批准授权。不新增权限目录项。
- 已知限制：试点 api 没有换桌授权（`dining_session_move_operation`），换桌后作废由领域与数据库验收证明，待换桌上线时生效。
