# Exhausted Outbox recovery for the single-store pilot

WP-2402 implementation design, within the accepted WP-0033 manual recovery boundary.

## Problem and authority

Order2's retained version4 OrderConfirmed exhausted eight automatic delivery attempts.
Later aggregate versions remain blocked, including the paid third batch created after Cart
replacement. WP-0033 Dead-letter lifecycle permits an authorized retry to create a new
bounded schedule and requires append-only action evidence. Its Ordering and release rules
retain the same Event/Aggregate identity. Existing applyDeadLetterCommand instead rejects
Outbox rows at attempt_count8. The automatic eight-handoff policy remains unchanged.

This design supplies the missing manual recovery path; it does not authorize discard,
ordering release, count reset, business fact reconstruction or an arbitrary success flag.

## Bounded operation

A current operator with eventing.dead-letter.retry, RELIABILITY_RECOVERY purpose and a
DEPENDENCY_RECOVERED or TRANSIENT_RECOVERED reason requests one exact dead-letter version.
Brand/Store, Actor, event identity, registry revision and operation identity are server bound.
Only an open exhausted Outbox item with eight recorded automatic attempts, no publication,
no lease, no ordering release, and no unpublished earlier aggregate event is eligible.
Missing or inconsistent facts deny scheduling. Retryable transport failure is required;
invalid envelope, rejected transport and unknown commit are not this operation's inputs.

One accepted operation grants exactly one manual transport invocation, within a fixed
five-minute start window and a bounded lease/adapter timeout. It does not change automatic
claim predicates or reset any counter. A different operation requires a fresh operator
request and current expected version. The original action and all attempts remain retained.

## Persistence and execution requirements

An Eventing-owned forward migration must add immutable scoped recovery intent and attempt
records, plus mutable fenced execution state. Records contain technical references and safe
codes only. Forced Brand/Store RLS, uniqueness for operation identity and one active recovery
per event, and append-only protections are required. Intent includes expected dead-letter
version, registry revision, original attempt count, deadline and actor/purpose/reason.

Scheduling locks the exact dead-letter and Outbox row, checks earlier aggregate events and
current authorization, then appends intent/action atomically. It does not clear the old error.

Execution claims the intent under a unique lease and commits the start record before calling
the existing transport with the original Event identity and complete registered consumers.
Each consumer retains its original Inbox idempotency identity. No payload is copied into
recovery metadata. Claiming never increments or resets the old automatic budget.

Acknowledgement must cover every registered applicable consumer. Existing completed Inbox
results are valid duplicates; a validated non-applicable consumer completes its normal Inbox
record. A failed or unknown consumer cannot count as acknowledged. Consumer registry drift,
lease loss or deadline expiry denies completion until explicit reconciliation.

A fenced owner completion transaction records the actual outcome. Only a proven full
acknowledgement may publish the original event and resolve the dead-letter with append-only
action evidence. Failure retains the aggregate block. Crash/unknown outcome never grants
another invocation from the same operation; reconciliation inspects actual persisted consumer
outcomes before a separate authorized retry can be considered. This mechanism must not
claim atomic business rollback across independently committed consumers.

## Required acceptance

- Scope, permission, purpose, version, retry reason and registry binding rejection.
- Duplicate intent replay versus changed-intent conflict, including concurrent operators.
- One invocation per operation, timeout/crash recovery and stale lease denial.
- Full consumer acknowledgement, partial failure and committed duplicate handling.
- Immutable original Event, original eight attempts and append-only manual evidence.
- Real PostgreSQL rollback, tenant isolation and aggregate ordering before/after recovery.
- Actual Order2 version4 recovery followed by normal version5/6 processing, Kitchen work,
  Customer status, serving and corrected receipt; no downstream manual reconstruction.

Current delivery status: eligibility policy and forward schema are implemented; schema
constraints have rollback-only PostgreSQL evidence. The live runtime still has no recovery
tables. Atomic scheduling has rollback-only PostgreSQL evidence. Worker single-invocation orchestration has bounded timeout/late-result tests. Durable claim has rollback-only PostgreSQL evidence; the complete-consumer Inbox verifier is implemented. Fenced completion has rollback-only PostgreSQL evidence for complete receipt gating, publication, resolution and failure rollback. Operator composition, application-role/concurrent execution acceptance
and actual recovery remain incomplete and must precede enabling it.

## DEC-PILOT-EVENT-ROUTING — 品牌级事件发布与"本部署无订阅者"（WP-2423 5e，2026-10-15）

问题：v15 上 `AvailabilityRule*`（attempt_count 0）以及更早的商品/菜单/价目/配方编辑事件一直未发布。
根因：这些事件属于品牌（`store_id` 为空）；发件箱领取只在"当前无门店"的范围里领取品牌事件
（`dispatch-outbox.ts` 领取条件），而试点业务 worker 只按"本品牌 + 本门店"一个范围领取（`pilot-worker.mjs`），
所以品牌事件从未被领取。若只补上品牌范围，这些事件在试点中没有已部署的消费者，传输会拒绝
（`TRANSPORT_REJECTED`）并进入死信，同样不对。

决定：

1. 试点 worker 按"本门店"和"本品牌（无门店）"两个范围领取（`pilot-event-routing.mjs`），每个范围每轮最多 5 条，
   品牌编辑积压不会拖慢门店订单事件。授权仍只限绑定的品牌与门店。
2. 目录中登记、但试点有意不部署的消费者逐个列出并写明原因（`pilotUndeployedConsumers`）：试点直接读取
   所属领域的当前表（可售规则、商品、类目、选项、价目、税务配置、配方），菜单发布时在同一请求内投影顾客菜单
   （失败可用 Rebuild 重投影）。只有"该类型的全部目录消费者都在此列表中"的事件，传输才按"已发布、本部署无订阅者"
   确认（正常的 claim → published 状态转换，attempt_count 记 1）；其余没有已部署消费者的事件仍被拒绝，
   缺接线的消费者（如此前的 `PaymentRefunded`）照样可见。若将来部署了列表中的消费者，组合会直接失败，须先移出列表。
3. 不删除、不改写发件箱历史，不清零计数；已有的积压事件在 worker 重启后按正常领取与发布转换处理。
   测试：`outbox-dispatcher` 隔离 PostgreSQL 新增用例（受限角色，修复前品牌事件停在 attempt 0），
   `pilot-event-routing.test.mjs` 核对列表与事件目录一致。
