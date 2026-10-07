import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import {
  parsePublishingOptionPriceReviewOperation,
  publishingOptionPriceReviewOperationDigest,
  type PublishingOptionPriceReviewOperation,
} from "../../contracts/option-price-review-operation.js";
import {
  PublishingContractError,
  parsePublishingReference,
  parsePublishingInstant,
  createPublishingScope,
} from "../../contracts/publishing.js";
import {
  createPostgresPublishingMutationStore,
  parseRecordedPublishingMutation,
  publishingRecordedMutationDigest,
  type PublishingTransaction,
} from "./publishing-mutation-store.js";
import type { CommitPublishingMutationInput } from "../../application/ports/publishing-ports.js";
const fail = (): never => {
  throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
};
/** The original belongs to another exact intent; no original details are exposed. */
export class OptionPriceReviewOriginalDeniedError extends Error {
  constructor() {
    super("original operation access denied");
    this.name = "OptionPriceReviewOriginalDeniedError";
  }
}
const digest = publishingRecordedMutationDigest;
export const optionPriceReviewOperationFields = Object.freeze([
  "originalCommand",
  "originalActor",
  "originalOccurredAt",
  "mutation",
  "originalIntentDigest",
  "auditReference",
] as const);
export interface OptionPriceReviewOperationStoreOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly selectedStoreReference: string;
  readonly actorReference: string;
  readonly clock: { now(): string };
  readonly originalValidUntil: string;
  readonly audit: {
    create(
      input: Readonly<{ command: PublishingOptionPriceReviewOperation; observedAt: string }>,
    ): AppendAuditRecordInput;
  };
  readonly registerBeforeCommit: (
    tx: PublishingTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => void | Promise<void>;
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: PublishingTransaction,
      input: Readonly<{
        command: PublishingOptionPriceReviewOperation;
        mode: "Write" | "Resolve" | "Read";
        permission: "pricing.price-book.manage";
        requiredPermissions: readonly string[];
        requiredFields: typeof optionPriceReviewOperationFields;
        purposeCode: "PRICING_OPTION_PRICE_REVIEW_OPERATION";
        actorKind: "User";
        observedAt: string;
        validUntil: string;
      }>,
    ): Promise<Readonly<{ validUntil: string }>>;
  };
}
export type OptionPriceReviewOriginalOperation =
  | Readonly<{
      outcome: "Absent";
      createDraft(
        input: CommitPublishingMutationInput,
      ): Promise<Readonly<{ auditReference: ReturnType<typeof parsePublishingReference> }>>;
      commit(
        input: CommitPublishingMutationInput,
      ): Promise<Readonly<{ auditReference: ReturnType<typeof parsePublishingReference> }>>;
    }>
  | Readonly<{
      outcome: "Committed";
      command: PublishingOptionPriceReviewOperation;
      originalOccurredAt: ReturnType<typeof parsePublishingInstant>;
      auditReference: ReturnType<typeof parsePublishingReference>;
      mutation: CommitPublishingMutationInput;
    }>
  | Readonly<{
      outcome: "Abandoned";
      command: PublishingOptionPriceReviewOperation;
      recordedAt: ReturnType<typeof parsePublishingInstant>;
      auditReference: ReturnType<typeof parsePublishingReference>;
    }>;
function rows(input: unknown): Record<string, unknown>[] {
  if (!input || typeof input !== "object") return fail();
  const d = Object.getOwnPropertyDescriptor(input, "rows");
  if (
    !d ||
    !("value" in d) ||
    !Array.isArray(d.value) ||
    d.value.length > 1 ||
    Reflect.ownKeys(d.value).length !== d.value.length + 1
  )
    return fail();
  const result: Record<string, unknown>[] = [];
  for (let i = 0; i < d.value.length; i++) {
    const rowDescriptor = Object.getOwnPropertyDescriptor(d.value, String(i));
    if (!rowDescriptor?.enumerable || !("value" in rowDescriptor)) return fail();
    const row = rowDescriptor.value;
    if (!row || typeof row !== "object" || Object.getPrototypeOf(row) !== Object.prototype)
      return fail();
    const copy: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(row)) {
      if (typeof key !== "string") return fail();
      const value = Object.getOwnPropertyDescriptor(row, key);
      if (!value?.enumerable || !("value" in value)) return fail();
      copy[key] = value.value;
    }
    result.push(copy);
  }
  return result;
}
/** Borrowed original host; returned results are tentative until its final COMMIT. */
export function createPostgresOptionPriceReviewOperationStore(
  options: OptionPriceReviewOperationStoreOptions,
) {
  const tenant = parsePublishingReference(options.tenantReference),
    brand = parsePublishingReference(options.brandReference),
    store = parsePublishingReference(options.selectedStoreReference),
    actor = parsePublishingReference(options.actorReference);
  const clock = options.clock,
    clockPort = clock.now,
    now = clockPort.bind(clock),
    authority = options.authority,
    holdPort = authority.holdUntilTransactionCompletes,
    hold = holdPort.bind(authority),
    register = options.registerBeforeCommit;
  const originalObservedAt = parsePublishingInstant(now()),
    initialDeadline = parsePublishingInstant(options.originalValidUntil);
  if (
    initialDeadline <= originalObservedAt ||
    Date.parse(initialDeadline) - Date.parse(originalObservedAt) > 5000
  )
    return fail();
  const auditPort = options.audit,
    createAudit = options.audit.create,
    auditFor = createAudit.bind(auditPort);
  const poisoned = new WeakSet<PublishingTransaction>(),
    bindings = new WeakMap<PublishingTransaction, string>(),
    inspectedAbsent = new WeakSet<PublishingTransaction>(),
    finalizers = new WeakMap<
      PublishingTransaction,
      (() => ReturnType<typeof parsePublishingInstant>)[]
    >();
  async function execute<T>(
    tx: PublishingTransaction,
    raw: unknown,
    mode: "Write" | "Resolve" | "Read",
    work: (host: {
      query: PublishingTransaction["query"];
      check(): ReturnType<typeof parsePublishingInstant>;
      inspect(): Promise<Exclude<OptionPriceReviewOriginalOperation, { outcome: "Absent" }> | null>;
      append(
        outcome: "Committed" | "Abandoned",
        audit: AppendAuditRecordInput,
        mutation: CommitPublishingMutationInput | null,
      ): Promise<void>;
      owner: ReturnType<typeof createPostgresPublishingMutationStore>;
    }) => Promise<T>,
  ) {
    const c = (() => {
        try {
          return parsePublishingOptionPriceReviewOperation(raw);
        } catch {
          poisoned.add(tx);
          return fail();
        }
      })(),
      hash = publishingOptionPriceReviewOperationDigest(c),
      queryPort = tx.query,
      query = queryPort.bind(tx);
    if (
      (mode === "Write" && !inspectedAbsent.has(tx)) ||
      c.tenantReference !== tenant ||
      c.brandReference !== brand ||
      c.selectedStoreReference !== store ||
      c.actorReference !== actor ||
      poisoned.has(tx) ||
      (bindings.has(tx) &&
        !(mode !== "Read" && inspectedAbsent.has(tx) && bindings.get(tx) === hash)) ||
      Object.getOwnPropertyDescriptor(tx, "query")?.value !== queryPort
    ) {
      poisoned.add(tx);
      return fail();
    }
    bindings.set(tx, hash);
    inspectedAbsent.delete(tx);
    let latest = originalObservedAt,
      deadline = initialDeadline,
      ready = false,
      calls = 0,
      complete = false,
      finals = 0,
      closed = false;
    const reject = (): never => {
      poisoned.add(tx);
      return fail();
    };
    const check = () => {
      const at = parsePublishingInstant(now());
      if (
        poisoned.has(tx) ||
        closed ||
        tx.query !== queryPort ||
        clock.now !== clockPort ||
        options.clock !== clock ||
        options.authority !== authority ||
        authority.holdUntilTransactionCompletes !== holdPort ||
        options.registerBeforeCommit !== register ||
        options.audit !== auditPort ||
        auditPort.create !== createAudit ||
        at < latest ||
        at >= deadline
      )
        return reject();
      latest = at;
      return at;
    };
    const checkedQuery: PublishingTransaction["query"] = async (sql, values) => {
      check();
      try {
        const result = await query(sql, values);
        check();
        return result;
      } catch {
        return reject();
      }
    };
    const authorize = async () => {
      const at = check(),
        result = await hold(tx, {
          command: c,
          mode,
          permission: "pricing.price-book.manage",
          requiredPermissions: Object.freeze(
            mode !== "Write"
              ? ["pricing.price-book.manage"]
              : [
                  "pricing.price-book.manage",
                  c.action === "SubmitReview"
                    ? "publishing.review.submit"
                    : "publishing.review.approve",
                  ...(c.action === "SubmitReview" && c.expectedLifecycle === null
                    ? ["publishing.draft.create"]
                    : []),
                ].sort(),
          ),
          requiredFields: optionPriceReviewOperationFields,
          purposeCode: "PRICING_OPTION_PRICE_REVIEW_OPERATION",
          actorKind: "User",
          observedAt: at,
          validUntil: deadline,
        });
      if (
        !result ||
        typeof result !== "object" ||
        Object.getPrototypeOf(result) !== Object.prototype ||
        Reflect.ownKeys(result).length !== 1
      )
        return reject();
      const lease = Object.getOwnPropertyDescriptor(result, "validUntil");
      if (!lease?.enumerable || !("value" in lease)) return reject();
      const until = parsePublishingInstant(lease.value);
      if (until <= at || until > deadline) return reject();
      deadline = until;
      check();
    };
    try {
      const registered = await register(
        tx,
        async () => {
          if (++calls !== 1 || !ready) return reject();
          await authorize();
          check();
          complete = true;
        },
        () => {
          if (++finals !== 1 || calls !== 1 || !complete || !ready) return reject();
          check();
          closed = true;
        },
      );
      if (registered !== undefined) return reject();
      const finalize = () => {
        const at = parsePublishingInstant(now());
        if (
          poisoned.has(tx) ||
          !closed ||
          !ready ||
          calls !== 1 ||
          !complete ||
          finals !== 1 ||
          tx.query !== queryPort ||
          clock.now !== clockPort ||
          options.clock !== clock ||
          options.authority !== authority ||
          authority.holdUntilTransactionCompletes !== holdPort ||
          options.registerBeforeCommit !== register ||
          options.audit !== auditPort ||
          auditPort.create !== createAudit ||
          at < latest ||
          at >= deadline
        )
          return reject();
        latest = at;
        return deadline;
      };
      finalizers.set(tx, [...(finalizers.get(tx) ?? []), finalize]);
      check();
      await authorize();
      await checkedQuery(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
        [tenant, brand, store],
      );
      const isolation = rows(
        await checkedQuery("SELECT current_setting('transaction_isolation') AS isolation", []),
      );
      if (isolation[0]?.isolation !== "read committed") return reject();
      await checkedQuery("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "PublishingOperation:" + tenant + ":" + brand + ":" + c.operationReference,
      ]);
      // Fixed owning write admission precedes every nested policy/candidate SHARE read.
      if (mode === "Write")
        await checkedQuery(
          "LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE ROW EXCLUSIVE MODE",
          [],
        );
      const wrapped = { query: checkedQuery },
        owner = createPostgresPublishingMutationStore(
          { run: (work) => work(wrapped) },
          tenant,
          createPublishingScope({ kind: "Brand", brandReference: brand, storeReference: null }),
        );
      const inspect = async () => {
        const found = rows(
          await checkedQuery(
            "SELECT outcome_code,command_json,command_digest,recorded_at,audit_id,mutation_json,mutation_digest FROM bop_publishing.option_price_review_operation WHERE tenant_id=$1 AND brand_id=$2 AND operation_id=$3",
            [tenant, brand, c.operationReference],
          ),
        );
        const row = found[0];
        if (!row) {
          const available = rows(
            await checkedQuery(
              "SELECT bop_publishing.option_price_review_operation_available($1) AS available",
              [c.operationReference],
            ),
          );
          if (available[0]?.available === false) {
            poisoned.add(tx);
            throw new OptionPriceReviewOriginalDeniedError();
          }
          if (available[0]?.available !== true) return reject();
          return null;
        }
        const command = parsePublishingOptionPriceReviewOperation(row.command_json);
        if (publishingOptionPriceReviewOperationDigest(command) !== row.command_digest)
          return reject();
        if (row.command_digest !== hash) {
          poisoned.add(tx);
          throw new OptionPriceReviewOriginalDeniedError();
        }
        const at = parsePublishingInstant(
            row.recorded_at instanceof Date ? row.recorded_at.toISOString() : row.recorded_at,
          ),
          auditReference = parsePublishingReference(row.audit_id);
        if (at > check()) return reject();
        if (row.outcome_code === "Abandoned") {
          if (row.mutation_json !== null || row.mutation_digest !== null) return reject();
          return Object.freeze({
            outcome: "Abandoned" as const,
            command,
            recordedAt: at,
            auditReference,
          });
        }
        if (row.outcome_code !== "Committed") return reject();
        const mutation = parseRecordedPublishingMutation(row.mutation_json);
        if (
          digest(mutation) !== row.mutation_digest ||
          mutation.idempotencyKey !== c.operationReference ||
          mutation.operation !== c.action ||
          mutation.audit.auditId !== auditReference ||
          mutation.audit.actor.type !== "User" ||
          mutation.audit.actor.reference !== actor ||
          mutation.audit.occurredAt !== at ||
          mutation.next.familyReference !== c.ruleReference ||
          mutation.next.configurationType !== "OPTION_PRICE_RULE" ||
          mutation.next.purposeCode !== "OPTION_PRICE_RULE_PUBLICATION" ||
          String(mutation.next.scope.brandReference) !== String(brand) ||
          mutation.next.scope.storeReference !== null
        )
          return reject();
        const original = await owner.resolveOperation({
          operationReference: c.operationReference,
          familyReference: c.ruleReference,
          lifecycleReference: mutation.next.lifecycleId,
          configurationType: "OPTION_PRICE_RULE",
          purposeCode: "OPTION_PRICE_RULE_PUBLICATION",
          observedAt: check(),
        });
        await checkedQuery(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [tenant, brand, store],
        );
        if (
          !original ||
          digest(original) !== digest(mutation) ||
          mutation.next.snapshotReference !== c.draftVersionReference ||
          mutation.next.snapshotDigest !== c.draftSnapshotDigest ||
          mutation.audit.reasonCode !==
            (c.action === "SubmitReview"
              ? "PUBLISHING_REVIEW_SUBMITTED"
              : "PUBLISHING_REVIEW_APPROVED") ||
          (c.action === "SubmitReview"
            ? mutation.validationEvidence?.validUntil !== c.validationValidUntil
            : mutation.approvalEvidence?.validUntil !== c.approvalValidUntil)
        )
          return reject();
        return Object.freeze({
          outcome: "Committed" as const,
          command,
          originalOccurredAt: at,
          auditReference,
          mutation,
        });
      };
      const append = async (
        outcome: "Committed" | "Abandoned",
        audit: AppendAuditRecordInput,
        mutation: CommitPublishingMutationInput | null,
      ) => {
        await checkedQuery(
          "INSERT INTO bop_publishing.option_price_review_operation(tenant_id,brand_id,selected_store_id,actor_id,operation_id,action_code,outcome_code,command_digest,command_json,recorded_at,audit_id,mutation_json,mutation_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb,$13)",
          [
            tenant,
            brand,
            store,
            actor,
            c.operationReference,
            c.action,
            outcome,
            hash,
            canonicalizeRfc8785(c),
            audit.occurredAt,
            audit.auditId,
            mutation === null ? null : canonicalizeRfc8785(mutation),
            mutation === null ? null : digest(mutation),
          ],
        );
      };
      const result = await work({ query: checkedQuery, check, inspect, append, owner });
      await authorize();
      ready = true;
      return result;
    } catch (error) {
      if (error instanceof OptionPriceReviewOriginalDeniedError) throw error;
      return reject();
    }
  }
  return Object.freeze({
    assertFinalized(tx: PublishingTransaction) {
      const checks = finalizers.get(tx);
      if (!checks?.length || poisoned.has(tx)) return fail();
      let deadline = initialDeadline;
      for (const checkFinal of checks) {
        const value = checkFinal();
        if (value < deadline) deadline = value;
      }
      return deadline;
    },
    inspectOriginalOperation(tx: PublishingTransaction, raw: unknown) {
      return execute(tx, raw, "Read", async (host) => {
        const original = await host.inspect();
        if (original) return original;
        inspectedAbsent.add(tx);
        return Object.freeze({ outcome: "Absent" as const });
      });
    },
    withOriginalOperation<T>(
      tx: PublishingTransaction,
      raw: unknown,
      work: (original: OptionPriceReviewOriginalOperation) => Promise<T>,
    ) {
      const c = (() => {
        try {
          return parsePublishingOptionPriceReviewOperation(raw);
        } catch {
          poisoned.add(tx);
          return fail();
        }
      })();
      const callerFailure: { captured: boolean; error: unknown } = {
        captured: false,
        error: undefined,
      };
      const invokeWork = async (original: OptionPriceReviewOriginalOperation) => {
        try {
          return await work(original);
        } catch (error) {
          callerFailure.captured = true;
          callerFailure.error = error;
          throw error;
        }
      };
      return execute(tx, c, "Write", async (host) => {
        const original = await host.inspect();
        if (original) return invokeWork(original);
        let used = false,
          committed = false,
          draftUsed = false,
          workActive = true;
        let createdDraft: CommitPublishingMutationInput["next"] | null = null;
        const result = await invokeWork(
          Object.freeze({
            outcome: "Absent" as const,
            commit: async (input: CommitPublishingMutationInput) => {
              if (used || !workActive) {
                poisoned.add(tx);
                return fail();
              }
              used = true;
              try {
                const m = parseRecordedPublishingMutation(input);
                if (
                  c.expectedLifecycle === null &&
                  (!draftUsed ||
                    !createdDraft ||
                    canonicalizeRfc8785(m.current) !== canonicalizeRfc8785(createdDraft))
                )
                  return fail();
                if (
                  m.operation !== c.action ||
                  m.idempotencyKey !== c.operationReference ||
                  m.next.familyReference !== c.ruleReference ||
                  m.next.configurationType !== "OPTION_PRICE_RULE" ||
                  m.next.purposeCode !== "OPTION_PRICE_RULE_PUBLICATION" ||
                  m.next.snapshotReference !== c.draftVersionReference ||
                  m.next.snapshotDigest !== c.draftSnapshotDigest ||
                  m.next.scope.kind !== "Brand" ||
                  String(m.next.scope.brandReference) !== String(brand) ||
                  m.next.scope.storeReference !== null ||
                  m.audit.brandId !== brand ||
                  m.audit.storeId !== undefined ||
                  m.audit.targetType !== "PublishingLifecycle" ||
                  m.audit.targetId !== m.next.lifecycleId ||
                  m.audit.dataClassification !== "Confidential" ||
                  m.audit.actor.type !== "User" ||
                  m.audit.actor.reference !== actor ||
                  m.audit.reasonCode !==
                    (c.action === "SubmitReview"
                      ? "PUBLISHING_REVIEW_SUBMITTED"
                      : "PUBLISHING_REVIEW_APPROVED") ||
                  m.audit.correlationId !== c.operationReference ||
                  m.audit.occurredAt < originalObservedAt ||
                  m.audit.occurredAt > host.check() ||
                  (c.expectedLifecycle !== null &&
                    (m.current?.lifecycleId !== c.expectedLifecycle.lifecycleReference ||
                      m.expectedVersion !== c.expectedLifecycle.version ||
                      m.current?.state !== c.expectedLifecycle.state))
                )
                  return fail();
                if (c.expectedLifecycle !== null) {
                  const latest = rows(
                    await host.query(
                      "SELECT operation_id FROM bop_publishing.publishing_mutation_record WHERE tenant_id=$1 AND brand_id=$2 AND store_id IS NULL AND lifecycle_id=$3 ORDER BY lifecycle_version DESC LIMIT 1",
                      [tenant, brand, c.expectedLifecycle.lifecycleReference],
                    ),
                  );
                  if (
                    latest[0]?.operation_id !== c.expectedLifecycle.latestMutationOperationReference
                  )
                    return fail();
                }
                if (c.action === "SubmitReview") {
                  if (
                    !m.validationEvidence ||
                    m.approvalEvidence !== null ||
                    m.validationEvidence.validUntil !== c.validationValidUntil ||
                    m.validationEvidence.snapshotReference !== c.draftVersionReference ||
                    m.validationEvidence.snapshotDigest !== c.draftSnapshotDigest ||
                    m.validationEvidence.validUntil <= m.audit.occurredAt
                  )
                    return fail();
                } else {
                  const recorded = await host.owner.withOptionPriceReview(
                    { familyReference: c.ruleReference, mode: "Write" },
                    (held) =>
                      held.readForDraft({
                        snapshotReference: c.draftVersionReference,
                        snapshotDigest: c.draftSnapshotDigest,
                        observedAt: host.check(),
                      }),
                  );
                  if (
                    recorded.outcome !== "Recorded" ||
                    !recorded.review?.validationEvidence ||
                    recorded.latest.next.lifecycleId !== c.expectedLifecycle?.lifecycleReference ||
                    recorded.latest.idempotencyKey !==
                      c.expectedLifecycle?.latestMutationOperationReference ||
                    recorded.latest.next.state !== "InReview" ||
                    recorded.review.validationEvidence.validUntil !== c.validationValidUntil ||
                    recorded.draft.audit.actor.type !== "User" ||
                    recorded.review.audit.actor.type !== "User" ||
                    actor === recorded.draft.audit.actor.reference ||
                    actor === recorded.review.audit.actor.reference ||
                    !m.approvalEvidence ||
                    m.validationEvidence !== null ||
                    m.approvalEvidence.validUntil !== c.approvalValidUntil ||
                    m.approvalEvidence.validUntil > c.validationValidUntil ||
                    m.approvalEvidence.approvedActorReference !== actor ||
                    m.approvalEvidence.snapshotReference !== c.draftVersionReference ||
                    m.approvalEvidence.snapshotDigest !== c.draftSnapshotDigest ||
                    m.approvalEvidence.validUntil <= m.audit.occurredAt
                  )
                    return fail();
                }
                const receipt = await host.owner.commit(m);
                await host.query(
                  "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
                  [tenant, brand, store],
                );
                const persisted = await host.owner.resolveOperation({
                  operationReference: c.operationReference,
                  familyReference: c.ruleReference,
                  lifecycleReference: m.next.lifecycleId,
                  configurationType: "OPTION_PRICE_RULE",
                  purposeCode: "OPTION_PRICE_RULE_PUBLICATION",
                  observedAt: host.check(),
                });
                if (
                  !persisted ||
                  digest(persisted) !== digest(m) ||
                  receipt.auditReference !== m.audit.auditId
                )
                  return fail();
                await host.query(
                  "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
                  [tenant, brand, store],
                );
                await host.append("Committed", m.audit, m);
                committed = true;
                return receipt;
              } catch {
                poisoned.add(tx);
                return fail();
              }
            },
            createDraft: async (input: CommitPublishingMutationInput) => {
              if (
                !workActive ||
                draftUsed ||
                used ||
                c.action !== "SubmitReview" ||
                c.expectedLifecycle !== null
              ) {
                poisoned.add(tx);
                return fail();
              }
              draftUsed = true;
              try {
                const m = parseRecordedPublishingMutation(input);
                if (
                  m.operation !== "CreateDraft" ||
                  m.idempotencyKey === c.operationReference ||
                  m.current !== null ||
                  m.next.familyReference !== c.ruleReference ||
                  m.next.configurationType !== "OPTION_PRICE_RULE" ||
                  m.next.purposeCode !== "OPTION_PRICE_RULE_PUBLICATION" ||
                  m.next.snapshotReference !== c.draftVersionReference ||
                  m.next.snapshotDigest !== c.draftSnapshotDigest ||
                  m.next.scope.kind !== "Brand" ||
                  String(m.next.scope.brandReference) !== String(brand) ||
                  m.next.scope.storeReference !== null ||
                  m.audit.brandId !== brand ||
                  m.audit.storeId !== undefined ||
                  m.audit.targetType !== "PublishingLifecycle" ||
                  m.audit.targetId !== m.next.lifecycleId ||
                  m.audit.dataClassification !== "Confidential" ||
                  m.audit.actor.type !== "User" ||
                  m.audit.actor.reference !== actor ||
                  m.audit.reasonCode !== "PUBLISHING_DRAFT_CREATED" ||
                  m.audit.occurredAt < originalObservedAt ||
                  m.audit.occurredAt > host.check()
                )
                  return fail();
                const existing = await host.owner.withOptionPriceReview(
                  { familyReference: c.ruleReference, mode: "Write" },
                  (held) =>
                    held.readForDraft({
                      snapshotReference: c.draftVersionReference,
                      snapshotDigest: c.draftSnapshotDigest,
                      observedAt: host.check(),
                    }),
                );
                if (existing.outcome !== "Absent") return fail();
                const receipt = await host.owner.commit(m);
                await host.query(
                  "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
                  [tenant, brand, store],
                );
                createdDraft = m.next;
                return receipt;
              } catch {
                poisoned.add(tx);
                return fail();
              }
            },
          }),
        );
        workActive = false;
        if (!used || !committed) {
          poisoned.add(tx);
          return fail();
        }
        return result;
      }).catch((error: unknown) => {
        // execute has already poisoned the transaction before caller errors escape.
        if (callerFailure.captured) throw callerFailure.error;
        throw error;
      });
    },
    resolveOperation(tx: PublishingTransaction, raw: unknown) {
      const c = (() => {
        try {
          return parsePublishingOptionPriceReviewOperation(raw);
        } catch {
          poisoned.add(tx);
          return fail();
        }
      })();
      return execute(tx, c, "Resolve", async (host) => {
        const original = await host.inspect();
        if (original) return original;
        await host.query(
          "LOCK TABLE bop_publishing.publishing_mutation_record IN SHARE ROW EXCLUSIVE MODE",
          [],
        );
        const reread = await host.inspect();
        if (reread) return reread;
        const at = host.check(),
          audit = validateAuditRecord(auditFor({ command: c, observedAt: at }), Date.parse(at));
        if (
          audit.actor.type !== "User" ||
          audit.actor.reference !== actor ||
          audit.brandId !== brand ||
          audit.storeId !== undefined ||
          audit.actionCode !== "PUBLISHING_OPTION_PRICE_REVIEW_ABANDONED" ||
          audit.targetType !== "PublishingOptionPriceReviewOperation" ||
          audit.targetId !== c.operationReference ||
          audit.correlationId !== c.operationReference ||
          audit.reasonCode !== c.reasonCode ||
          audit.occurredAt !== at ||
          audit.dataClassification !== "Confidential"
        )
          return fail();
        // Brand Audit has its own forced RLS scope; selected Store remains the
        // original operation anchor and is restored before terminal persistence.
        await host.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [tenant, brand, ""],
        );
        await appendAuditRecordInTransaction({ query: host.query }, audit);
        await host.query(
          "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
          [tenant, brand, store],
        );
        await host.append("Abandoned", audit, null);
        return Object.freeze({
          outcome: "Abandoned" as const,
          command: c,
          recordedAt: parsePublishingInstant(audit.occurredAt),
          auditReference: parsePublishingReference(audit.auditId),
        });
      });
    },
  });
}
