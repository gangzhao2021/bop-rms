# 单店试点多批次阶段提案（DEC-PILOT-BATCH-PHASE-01）

状态：Owner 已于 2026-09-13 确认，作为单店试点 scoped addendum 接受。实施及验收尚未完成，不自动启用运行配置。

## 问题与来源

本地 Handoff Section 6.12、24.4、24.6：堂食加菜属于同一 Order 下的新 Batch。
Section 24.3：付款状态与整体阶段分开；工作流由 Brand 发布并允许受控 Store 覆盖。
Section 24.8：已接受/制作中的订单不能按未接单规则直接取消。
Section 24.11：整体阶段根据各 Batch/Item 的总体情况推进。

当前 customer-payment-workflow-action.ts 解析首次 OrderCreationRecord 并只取
batches[0]，不能直接用于追加付款。当前追加状态来源也只接受 Submitted 前态。
不能用首批状态代替整体状态，或因新批次 Submitted 而把旧批次制作进度清零。
上述来源没有给出混合批次的完整阶段归并表，需补充业务解释后实施。

## 建议的试点规则

保留同一个 Order、原订单号、原创建时间。各 Batch/Item 独立保留不可变
提交、付款、接单、厨房、履约和终止事实；整体阶段仅由 Ordering 根据这些
权威事实归并，不改变事实归属，也不修改历史。

1. 有未终结商品时，已取消/拒绝的商品不参与剩余出餐进度计算，但保留历史。
2. 所有剩余商品均已履约完成，整体为 Fulfilled；关单仍需满足余额、退款、
   异常和会话规则，不能仅凭阶段自动关闭。
3. 所有剩余商品均已完成制作，且至少一个尚未交付，整体为 Ready。
4. 只要有商品开始制作或已完成制作/交付，同时还有其他未完成商品，整体为
   In Progress。例如旧批次 Ready 后加新批次，整体回到 In Progress，
   旧批次仍显示 Ready，可继续交付。
5. 尚无制作进度但至少一个剩余批次已接受，整体为 Accepted。
6. 尚无接受或制作进度的剩余批次，整体为 Submitted。
7. 全部商品已终止时，仅在从未接受且全部被拒绝时显示 Rejected；存在取消
   或曾接受的历史则显示 Cancelled。保留每项原始拒绝/取消原因。
8. 整体阶段变动不能抹掉“曾接受/曾开始制作”的约束。订单级顾客直接取消仅在
   所有目标商品都未被接受、未制作并满足现有规则时允许；混合状态按受控取消
   请求处理，不能通过加菜获得整单直接取消权限。
9. 单笔追加付款只结算本批次冻结金额与本次小费。付款资格绑定本批次，
   同时携带当前 Order 版本；不能要求整体 Order 必须 Submitted 才允许
   新批次付款。Brand/Store 必须有对应整体阶段的已发布付款动作及权限；
   缺少发布配置时拒绝，不以代码默认放行。
10. 已 Closed 的 Order、Closing/Closed 的 Dining Session 仍按现有规则拒绝
    新增批次。本提案不放宽这些门槛。

## 可审阅场景

| 现有批次                         | 新批次            | 整体阶段    | 保留的行为                                |
| -------------------------------- | ----------------- | ----------- | ----------------------------------------- |
| Submitted                        | Submitted         | Submitted   | 各批次付款独立                            |
| Accepted，未制作                 | Submitted，未付款 | Accepted    | 新批次按已发布动作付款，旧批次不回退      |
| In Progress                      | Submitted，未付款 | In Progress | 旧批次继续制作                            |
| Ready                            | Submitted，未付款 | In Progress | 旧批次仍可交付                            |
| Fulfilled + Open，Session Active | Submitted         | In Progress | 仍需当前加菜资格检查，不重开 Closed Order |
| 一批 Fulfilled，一批 Ready       | 无                | Ready       | 剩余批次交付后才整体 Fulfilled            |
| 所有剩余商品 Fulfilled           | 无                | Fulfilled   | 关闭与退款状态另行判断                    |
| 曾接受的商品取消，其余拒绝       | 无                | Cancelled   | 不抹掉已接受历史                          |

## 实施与验收范围

Owner 确认后，在 WP-2402 内补 Ordering 的批次/商品状态归并与锁内当前状态查询，
再接库存付款工作流；更新顾客/商家摘要与取消/关单门槛的相关消费者。
保留原批次历史、已付款金额与 Kitchen Ticket，不重分配订单号。
用上述混合场景验证支付、厨房继续执行、重复事件、并发追加/取消和不可重复付款。
真实 PostgreSQL/浏览器验收及实际 Store/Provider 发布条件保持独立，不能用单元
测试替代。Owner 确认前不将提案规则写入业务实现或标记为 Accepted。

批准证据：当前任务用户明确回复“确认多批次提案”（2026-09-13）。
决策：DEC-PILOT-BATCH-PHASE-01 已接受；实施和验收继续归属 WP-2402。
