import { appendPlatformAuditRecordInTransaction, canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPostgresPlatformPermissionSource,
  parsePlatformPermissionScope,
  type PlatformPermissionAction,
  type PlatformPermissionSourceOptions,
} from "@bop/permission";
import {
  createPostgresPlatformBrandTemplateStore,
  type PlatformBrandTemplateRevision,
} from "@bop/tenant";
import {
  parseStoredPlatformPublishingReceipt,
  parseStoredPlatformPublishingHead,
  type StoredPlatformPublishingHead as Head,
} from "./platform-publishing-read-kernel.js";
import {
  PublishingContractError,
  parsePublishingReference,
  parsePublishingInstant,
  parsePublishingVersion,
  parseReleaseSequence,
} from "../../contracts/publishing.js";
import {
  parsePlatformPublishingLifecycleRecord,
  parsePlatformPublishingValidationEvidence,
  parsePlatformPublishingApprovalEvidence,
  parsePlatformPublishingReleaseRecord,
  validatePlatformPublishingTransition,
  type PlatformPublishingCommand,
} from "../../contracts/platform-publishing.js";
import {
  parsePlatformPublishingSourceScope,
  parsePlatformPublishingRequest,
  parsePlatformPublishingOriginal,
  platformPublishingIntentDigest,
  parsePlatformPublishingResolve,
  parsePlatformPublishingReceipt,
  buildPlatformPublishingSource,
  parsePlatformPublishingCurrent,
  parsePlatformPublishingExact,
  parsePlatformPublishingHistory,
  type PlatformPublishingRequest,
  type PlatformPublishingReceipt,
  type PlatformPublishingSource,
  type PlatformPublishingSourceScope,
} from "../../contracts/platform-publishing-source.js";
export interface PlatformPublishingTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface PlatformPublishingStoreOptions {
  readonly transaction: PlatformPublishingTransaction;
  readonly scope: PlatformPublishingSourceScope;
  readonly clock: { now(): string };
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly currentIdentity: PlatformPermissionSourceOptions["currentIdentity"];
  readonly nextReference: (
    kind: "Record" | "Lifecycle" | "Validation" | "Approval" | "Release" | "Audit",
  ) => string;
  readonly registerBeforeCommit: (
    tx: PlatformPublishingTransaction,
    guard: () => Promise<void>,
    final: () => void,
  ) => Promise<void>;
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return invalid();
  const d = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).length !== keys.length ||
    keys.some((k) => {
      const descriptor = d[k];
      return !descriptor || !descriptor.enumerable || !("value" in descriptor);
    })
  )
    return invalid();
  return Object.fromEntries(keys.map((k) => [k, d[k]?.value]));
}
function invalid(): never {
  throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
}
function rows(value: unknown, max = 21): readonly Record<string, unknown>[] {
  const d =
    value && typeof value === "object" ? Object.getOwnPropertyDescriptor(value, "rows") : undefined;
  if (
    !d ||
    !("value" in d) ||
    !Array.isArray(d.value) ||
    Object.getPrototypeOf(d.value) !== Array.prototype ||
    d.value.length > max ||
    Reflect.ownKeys(d.value).length !== d.value.length + 1
  )
    return invalid();
  const result: Record<string, unknown>[] = [];
  for (let i = 0; i < d.value.length; i++) {
    const item = Object.getOwnPropertyDescriptor(d.value, String(i));
    if (!item?.enumerable || !("value" in item)) return invalid();
    result.push(item.value as Record<string, unknown>);
  }
  return result;
}
const originalSql =
  "SELECT receipt_text,receipt_digest FROM bop_publishing.platform_template_publishing_operation WHERE actor_id=$1 AND operation_id=$2";
const headSql = `SELECT h.sequence,h.release_active,s.receipt_text AS selected_receipt_text,s.receipt_digest AS selected_receipt_digest,r.receipt_text AS release_receipt_text,r.receipt_digest AS release_receipt_digest FROM bop_publishing.platform_template_publishing_head h JOIN bop_publishing.platform_template_publishing_operation s ON s.record_id=h.selected_record_id LEFT JOIN bop_publishing.platform_template_publishing_operation r ON r.record_id=h.release_record_id WHERE h.family_id=$1`;
const actions: Record<PlatformPublishingRequest["operation"], PlatformPermissionAction> = {
  CreateDraft: "platform.brand-template.manage",
  SubmitReview: "platform.brand-template.submit",
  Approve: "platform.brand-template.approve",
  Publish: "platform.brand-template.publish",
  Archive: "platform.brand-template.archive",
};
/** Genuine owner composition; caller owns Session/CSRF and actual COMMIT. */
export function createPostgresPlatformPublishingStore(options: PlatformPublishingStoreOptions) {
  const scope = parsePlatformPublishingSourceScope(options.scope),
    tx = options.transaction,
    port = tx.query,
    clock = options.clock,
    now = clock.now,
    identity = options.currentIdentity,
    next = options.nextReference,
    register = options.registerBeforeCommit,
    origin = parsePublishingInstant(options.originalObservedAt),
    until = parsePublishingInstant(options.originalValidUntil);
  if (
    origin >= until ||
    Date.parse(until) > Date.parse(origin) + 5000 ||
    [port, now, identity, next, register].some((p) => typeof p !== "function")
  )
    return invalid();
  let latest = origin,
    deadline = until,
    businessDeadline: string | null = null,
    phase: "Work" | "Checks" | "Final" | "Poison" = "Work",
    busy = false,
    registered = false,
    guardCalls = 0,
    finalCalls = 0,
    guardDone = false;
  const childGuards: (() => Promise<void>)[] = [],
    childFinals: (() => void)[] = [],
    heldOriginals = new Map<string, string>(),
    heldReads = new Map<string, { read: () => Promise<unknown>; bytes: string }>();
  const fail = (): never => {
    phase = "Poison";
    return invalid();
  };
  const check = () => {
    const at = parsePublishingInstant(now.call(clock));
    if (
      phase === "Poison" ||
      phase === "Final" ||
      options.transaction !== tx ||
      tx.query !== port ||
      options.clock !== clock ||
      clock.now !== now ||
      options.currentIdentity !== identity ||
      options.nextReference !== next ||
      options.registerBeforeCommit !== register ||
      options.originalObservedAt !== origin ||
      options.originalValidUntil !== until ||
      canonicalizeRfc8785(parsePlatformPublishingSourceScope(options.scope)) !==
        canonicalizeRfc8785(scope) ||
      at < latest ||
      at >= deadline ||
      (businessDeadline !== null && at >= businessDeadline)
    )
      return fail();
    latest = at;
    return at;
  };
  const query = async (sql: string, values: readonly unknown[]) => {
    check();
    try {
      const result = await port.call(tx, sql, values);
      check();
      return result;
    } catch {
      return fail();
    }
  };
  const childRegister = async (
    actual: PlatformPublishingTransaction,
    guard: () => Promise<void>,
    final: () => void,
  ) => {
    check();
    if (
      actual !== tx ||
      phase !== "Work" ||
      typeof guard !== "function" ||
      typeof final !== "function"
    )
      return fail();
    childGuards.push(guard);
    childFinals.push(final);
  };
  const permission = createPostgresPlatformPermissionSource({
    transaction: tx,
    scope: parsePlatformPermissionScope({
      kind: "Platform",
      actorReference: String(scope.actorReference),
      purposeCode: scope.purposeCode,
    }),
    clock,
    originalObservedAt: origin,
    originalValidUntil: until,
    currentIdentity: async (actual) => {
      check();
      if (actual !== tx) return fail();
      const result = await identity(actual);
      check();
      return result;
    },
    registerBeforeCommit: childRegister,
  });
  const authorize = async (action: PlatformPermissionAction) => {
    const auth = await permission.authorize({ action });
    check();
    deadline = [deadline, parsePublishingInstant(auth.validUntil)].sort()[0] ?? deadline;
    check();
    await query(
      "SELECT set_config('bop.platform_actor_id',$1,true),set_config('bop.platform_purpose',$2,true)",
      [scope.actorReference, scope.purposeCode],
    );
  };
  const templates = createPostgresPlatformBrandTemplateStore({
    kind: "Platform",
    actorReference: String(scope.actorReference),
    purposeCode: scope.purposeCode,
    transaction: tx,
    clock,
    originalObservedAt: origin,
    originalValidUntil: until,
    references: {
      canonicalize: canonicalizeRfc8785,
      hashIntent: (text) => `sha256:${sha256Hex(text)}`,
      nextReference: () => fail(),
    },
    authority: {
      async holdUntilTransactionCompletes(actual, input) {
        check();
        if (
          actual !== tx ||
          input.mode !== "Read" ||
          input.permission !== "platform.brand-template.read" ||
          input.actorReference !== String(scope.actorReference) ||
          input.purposeCode !== scope.purposeCode
        )
          return fail();
        await authorize("platform.brand-template.read");
        return { validUntil: deadline };
      },
    },
    appendAudit: async () => fail(),
    registerBeforeCommit: childRegister,
  });
  const digest = (v: unknown) => `sha256:${sha256Hex(canonicalizeRfc8785(v))}`;
  const storedReceipt = (row: Record<string, unknown>): PlatformPublishingReceipt => {
    return parseStoredPlatformPublishingReceipt(row, check());
  };
  const original = async (op: string) => {
    const list = rows(await query(originalSql, [scope.actorReference, op]), 1);
    if (!list.length) return null;
    const row = list[0];
    if (!row) return fail();
    const found = storedReceipt(row);
    if (
      found.actorReference !== scope.actorReference ||
      found.operationReference !== op ||
      found.purposeCode !== scope.purposeCode
    )
      return fail();
    return found;
  };
  const head = async (family: string): Promise<Head | null> => {
    const list = rows(await query(headSql, [family]), 1);
    if (!list.length) return null;
    return parseStoredPlatformPublishingHead(list[0], family, check());
  };
  const lifecycle = async (family: string, id: string) => {
    const list = rows(
      await query(
        "SELECT receipt_text,receipt_digest FROM bop_publishing.platform_template_publishing_operation WHERE family_id=$1 AND lifecycle_id=$2 AND outcome='Committed' ORDER BY sequence DESC LIMIT 1",
        [family, id],
      ),
      1,
    );
    if (!list.length) return null;
    const row = list[0];
    if (!row) return fail();
    const receipt = storedReceipt(row);
    if (
      receipt.outcome !== "Committed" ||
      receipt.source.command.next.familyReference !== family ||
      receipt.source.command.next.lifecycleId !== id
    )
      return fail();
    return receipt.source;
  };
  const pin = (source: PlatformPublishingSource | null) =>
    source === null
      ? null
      : {
          lifecycleReference: source.command.next.lifecycleId,
          version: source.command.next.version,
          sourceDigest: source.sourceDigest,
        };
  const exactTemplate = async (
    request: {
      templateReference: string;
      templateVersionReference: string;
      contentDigest: string;
      templateSourceDigest: string;
    },
    requireLatest: boolean,
  ): Promise<PlatformBrandTemplateRevision> => {
    const packet = await templates.exact({
      templateVersionReference: request.templateVersionReference,
    });
    check();
    const value = packet.snapshot;
    if (
      !value ||
      value.templateReference !== request.templateReference ||
      value.templateVersionReference !== request.templateVersionReference ||
      value.contentDigest !== request.contentDigest ||
      value.sourceDigest !== request.templateSourceDigest
    )
      return fail();
    if (requireLatest) {
      const current = await templates.current({ templateReference: request.templateReference });
      check();
      if (
        !current.current ||
        current.current.sourceDigest !== value.sourceDigest ||
        current.current.templateVersionReference !== value.templateVersionReference
      )
        return fail();
    }
    deadline = [deadline, parsePublishingInstant(packet.validUntil)].sort()[0] ?? deadline;
    check();
    return value;
  };
  const sourceTemplate = async (source: PlatformPublishingSource) => {
    const material = await exactTemplate(source.originalCommand.request, false);
    if (
      material.authoredByReference !== String(source.command.next.authoredActorReference) ||
      material.recordedAt > String(source.command.occurredAt) ||
      (source.command.validationEvidence &&
        material.recordedAt > String(source.command.validationEvidence.checkedAt))
    )
      return fail();
    return material;
  };
  const familyAdmission = async (family: string, write: boolean) => {
    await query("SELECT bop_publishing.platform_template_publishing_family_admit($1,$2,$3)", [
      scope.actorReference,
      family,
      write,
    ]);
  };
  const operationAdmission = async (op: string) => {
    await query("SELECT bop_publishing.platform_template_publishing_operation_admit($1,$2)", [
      scope.actorReference,
      op,
    ]);
  };
  async function seal() {
    if (registered) return;
    registered = true;
    if (
      (await register(
        tx,
        async () => {
          if (busy || phase !== "Work" || ++guardCalls !== 1) return fail();
          busy = true;
          phase = "Checks";
          try {
            for (const guard of childGuards) {
              if ((await guard()) !== undefined) return fail();
              check();
            }
            for (const [op, bytes] of heldOriginals)
              if (canonicalizeRfc8785(await original(op)) !== bytes) return fail();
            for (const held of heldReads.values())
              if (canonicalizeRfc8785(await held.read()) !== held.bytes) return fail();
            await query("SET CONSTRAINTS ALL IMMEDIATE", []);
            check();
            guardDone = true;
          } catch {
            return fail();
          } finally {
            busy = false;
          }
        },
        () => {
          if (busy || phase !== "Checks" || !guardDone || guardCalls !== 1 || ++finalCalls !== 1)
            return fail();
          check();
          for (const final of childFinals) if (final() !== undefined) return fail();
          check();
          phase = "Final";
        },
      )) !== undefined
    )
      return fail();
    check();
  }
  async function protect<T>(work: () => Promise<T>): Promise<T> {
    try {
      if (busy || phase !== "Work") return fail();
      busy = true;
      await seal();
      check();
      const result = await work();
      check();
      await seal();
      return result;
    } catch (error) {
      phase = "Poison";
      throw error;
    } finally {
      busy = false;
    }
  }
  function allocate(kind: Parameters<typeof next>[0]) {
    const ref = parsePublishingReference(next(kind));
    check();
    return ref;
  }
  async function persist(
    receipt: PlatformPublishingReceipt,
    recordReference: string,
    reason: string,
  ) {
    const source = receipt.source;
    const result = rows(
      await query(
        `INSERT INTO bop_publishing.platform_template_publishing_operation(record_id,actor_id,operation_id,intent_digest,outcome,family_id,sequence,lifecycle_id,lifecycle_version,operation_code,source_digest,audit_id,occurred_at,reason_code,receipt_digest,receipt_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING record_id::text AS record_reference`,
        [
          recordReference,
          receipt.actorReference,
          receipt.operationReference,
          receipt.intentDigest,
          receipt.outcome,
          source?.command.next.familyReference ?? null,
          source?.sequence ?? null,
          source?.command.next.lifecycleId ?? null,
          source?.command.next.version ?? null,
          source?.command.operation ?? null,
          source?.sourceDigest ?? null,
          receipt.auditReference,
          receipt.occurredAt,
          reason,
          digest(receipt),
          canonicalizeRfc8785(receipt),
        ],
      ),
      1,
    );
    if (
      result.length !== 1 ||
      closed(result[0], ["record_reference"]).record_reference !== recordReference
    )
      return fail();
    await appendPlatformAuditRecordInTransaction(tx, {
      auditReference: String(receipt.auditReference),
      actorReference: String(scope.actorReference),
      purposeCode: scope.purposeCode,
      actionCode: "PLATFORM_TEMPLATE_PUBLISHING_RECORDED",
      targetType: "PlatformTemplatePublishingOperation",
      targetReference: String(recordReference),
      operationReference: String(receipt.operationReference),
      intentDigest: String(receipt.intentDigest),
      occurredAt: String(receipt.occurredAt),
      reasonCode: reason,
      retentionPolicyCode: "CONFIGURATION_AUDIT",
      retentionPolicyVersion: 1,
    });
    check();
    heldOriginals.set(String(receipt.operationReference), canonicalizeRfc8785(receipt));
  }
  return Object.freeze({
    async execute(value: unknown): Promise<PlatformPublishingReceipt> {
      return protect(async () => {
        const request = parsePlatformPublishingRequest(value),
          originalCommand = parsePlatformPublishingOriginal({
            profile: "PlatformPublishingOriginalV1",
            scope,
            request,
          }),
          intent = platformPublishingIntentDigest(originalCommand);
        await authorize(actions[request.operation]);
        await operationAdmission(String(request.operationReference));
        const found = await original(String(request.operationReference));
        if (found) {
          if (found.intentDigest !== intent || found.outcome === "Abandoned") return fail();
          heldOriginals.set(String(request.operationReference), canonicalizeRfc8785(found));
          return found;
        }
        const material = await exactTemplate(
          request,
          request.operation === "CreateDraft" || request.operation === "SubmitReview",
        );
        await familyAdmission(String(request.templateReference), true);
        if (await original(String(request.operationReference))) return fail();
        const beforeHead = await head(String(request.templateReference)),
          selected = beforeHead?.selected ?? null,
          before =
            request.operation === "CreateDraft"
              ? selected
              : await lifecycle(
                  String(request.templateReference),
                  String(request.expectedLifecycle?.lifecycleReference ?? fail()),
                );
        if (canonicalizeRfc8785(pin(before)) !== canonicalizeRfc8785(request.expectedLifecycle))
          return fail();
        if (
          request.operation !== "CreateDraft" &&
          (!before ||
            before.command.next.snapshotReference !== request.templateVersionReference ||
            before.command.next.snapshotDigest !== request.contentDigest ||
            before.templateSourceDigest !== request.templateSourceDigest)
        )
          return fail();
        if (
          before &&
          request.operation !== "CreateDraft" &&
          (material.authoredByReference !== String(before.command.next.authoredActorReference) ||
            material.recordedAt > String(before.command.occurredAt) ||
            (before.command.validationEvidence &&
              material.recordedAt > String(before.command.validationEvidence.checkedAt)))
        )
          return fail();
        const newCycle =
            request.operation === "CreateDraft" &&
            (!before || before.command.next.state !== "Draft"),
          current = newCycle ? null : (before?.command.next ?? null);
        if (
          request.operation === "CreateDraft" &&
          material.authoredByReference !== String(scope.actorReference)
        )
          return fail();
        if (
          request.operation === "Approve" &&
          before &&
          (String(scope.actorReference) === String(before.command.next.authoredActorReference) ||
            String(scope.actorReference) === String(before.command.next.submittedActorReference))
        )
          return fail();
        const at = check(),
          reviewUntil =
            request.operation === "SubmitReview"
              ? request.reviewValidUntil
              : (current?.reviewValidUntil ?? null);
        if (request.operation !== "CreateDraft" && request.operation !== "Archive") {
          if (
            reviewUntil === null ||
            reviewUntil <= at ||
            (material.content.effectiveUntil !== null &&
              reviewUntil > material.content.effectiveUntil)
          )
            return fail();
          businessDeadline =
            businessDeadline === null
              ? reviewUntil
              : ([businessDeadline, reviewUntil].sort()[0] ?? reviewUntil);
          check();
        }
        const sequence = (beforeHead?.sequence ?? 0) + 1;
        if (sequence > 2147483647) return fail();
        const recordReference = allocate("Record"),
          auditReference = allocate("Audit");
        let validation = before?.command.validationEvidence ?? null,
          approval = before?.command.approvalEvidence ?? null;
        if (request.operation === "SubmitReview")
          validation = parsePlatformPublishingValidationEvidence({
            evidenceReference: allocate("Validation"),
            snapshotReference: request.templateVersionReference,
            snapshotDigest: request.contentDigest,
            scope: { kind: "Platform", brandReference: null, storeReference: null },
            result: "Pass",
            checkedAt: at,
            validUntil: reviewUntil,
            checkCodes: ["PLATFORM_TEMPLATE_IMMUTABLE_CONTENT", "PLATFORM_TEMPLATE_CURRENT_SOURCE"],
          });
        if (request.operation === "Approve") {
          if (!current || !validation) return fail();
          approval = parsePlatformPublishingApprovalEvidence({
            evidenceReference: allocate("Approval"),
            reviewLifecycleId: current.lifecycleId,
            reviewVersion: current.version,
            snapshotReference: current.snapshotReference,
            snapshotDigest: current.snapshotDigest,
            scope: current.scope,
            decision: "Accepted",
            approvedActorReference: scope.actorReference,
            approvedAt: at,
            validUntil: current.reviewValidUntil,
            authoredActorReference: current.authoredActorReference,
            submittedActorReference: current.submittedActorReference,
          });
        }
        const nextLifecycle = parsePlatformPublishingLifecycleRecord({
          lifecycleId: current?.lifecycleId ?? allocate("Lifecycle"),
          familyReference: request.templateReference,
          configurationType: scope.purposeCode,
          purposeCode: scope.purposeCode,
          snapshotReference: request.templateVersionReference,
          snapshotDigest: request.contentDigest,
          scope: { kind: "Platform", brandReference: null, storeReference: null },
          version: parsePublishingVersion(current ? current.version + 1 : 1),
          state:
            request.operation === "CreateDraft"
              ? "Draft"
              : request.operation === "SubmitReview"
                ? "InReview"
                : request.operation === "Approve"
                  ? "Approved"
                  : request.operation === "Publish"
                    ? "Published"
                    : "Archived",
          validationEvidenceReference:
            request.operation === "CreateDraft" ? null : (validation?.evidenceReference ?? null),
          approvalEvidenceReference:
            request.operation === "CreateDraft" || request.operation === "SubmitReview"
              ? null
              : (approval?.evidenceReference ?? null),
          createdAt: current?.createdAt ?? at,
          changedAt: at,
          authoredActorReference:
            request.operation === "CreateDraft"
              ? scope.actorReference
              : current?.authoredActorReference,
          submittedActorReference:
            request.operation === "CreateDraft"
              ? null
              : request.operation === "SubmitReview"
                ? scope.actorReference
                : current?.submittedActorReference,
          reviewValidUntil: request.operation === "CreateDraft" ? null : reviewUntil,
        });
        const previousRelease = beforeHead?.release?.command.release ?? null,
          release =
            request.operation === "Publish"
              ? parsePlatformPublishingReleaseRecord({
                  releaseId: allocate("Release"),
                  familyReference: request.templateReference,
                  configurationType: scope.purposeCode,
                  purposeCode: scope.purposeCode,
                  snapshotReference: request.templateVersionReference,
                  snapshotDigest: request.contentDigest,
                  scope: nextLifecycle.scope,
                  sequence: parseReleaseSequence((previousRelease?.sequence ?? 0) + 1),
                  sourceLifecycleId: nextLifecycle.lifecycleId,
                  kind: "Publish",
                  previousReleaseId: previousRelease?.releaseId ?? null,
                  createdAt: at,
                })
              : null;
        const command: PlatformPublishingCommand = validatePlatformPublishingTransition({
            profile: "PlatformPublishingCommandV1",
            operation: request.operation,
            operationReference: request.operationReference,
            currentActorReference: scope.actorReference,
            expectedVersion: current?.version ?? parsePublishingVersion(1),
            current,
            next: nextLifecycle,
            validationEvidence: request.operation === "CreateDraft" ? null : validation,
            approvalEvidence:
              request.operation === "CreateDraft" || request.operation === "SubmitReview"
                ? null
                : approval,
            release,
            previousRelease: request.operation === "Publish" ? previousRelease : null,
            rollbackTarget: null,
            occurredAt: at,
          }),
          source = buildPlatformPublishingSource({
            profile: "PlatformPublishingSourceV1",
            sequence,
            templateSourceDigest: request.templateSourceDigest,
            originalCommand,
            intentDigest: intent,
            command,
            auditReference,
          }),
          receipt = parsePlatformPublishingReceipt({
            profile: "PlatformPublishingReceiptV1",
            ...scope,
            operationReference: request.operationReference,
            intentDigest: intent,
            outcome: "Committed",
            originalCommand,
            source,
            auditReference,
            occurredAt: at,
          });
        await persist(receipt, String(recordReference), String(request.reasonCode));
        const selectNew =
            request.operation === "CreateDraft" ||
            selected?.command.next.lifecycleId === nextLifecycle.lifecycleId,
          releaseActive =
            request.operation === "Publish"
              ? true
              : request.operation === "Archive" &&
                  beforeHead?.release?.command.next.lifecycleId === nextLifecycle.lifecycleId
                ? false
                : (beforeHead?.releaseActive ?? false);
        const advanced = rows(
          await query(
            "SELECT bop_publishing.platform_template_publishing_head_advance($1,$2,$3,$4,$5,$6,$7) AS advanced",
            [
              scope.actorReference,
              request.templateReference,
              recordReference,
              beforeHead?.sequence ?? 0,
              selectNew,
              request.operation === "Publish",
              releaseActive,
            ],
          ),
          1,
        );
        if (advanced.length !== 1 || closed(advanced[0], ["advanced"]).advanced !== true)
          return fail();
        heldReads.set("head:" + request.templateReference, {
          read: () => head(String(request.templateReference)),
          bytes: canonicalizeRfc8785(await head(String(request.templateReference))),
        });
        return receipt;
      });
    },
    async resolve(value: unknown): Promise<PlatformPublishingReceipt> {
      return protect(async () => {
        const request = parsePlatformPublishingResolve(value);
        await authorize("platform.brand-template.read");
        await operationAdmission(String(request.operationReference));
        const found = await original(String(request.operationReference));
        if (found) {
          if (found.intentDigest !== request.intentDigest) return fail();
          heldOriginals.set(String(request.operationReference), canonicalizeRfc8785(found));
          return found;
        }
        const record = allocate("Record"),
          audit = allocate("Audit"),
          receipt = parsePlatformPublishingReceipt({
            profile: "PlatformPublishingReceiptV1",
            ...scope,
            operationReference: request.operationReference,
            intentDigest: request.intentDigest,
            outcome: "Abandoned",
            originalCommand: null,
            source: null,
            auditReference: audit,
            occurredAt: check(),
          });
        await persist(receipt, String(record), "ORIGINAL_RESOLUTION_ABANDONED");
        return receipt;
      });
    },
    async current(value: unknown) {
      return protect(async () => {
        const r = closed(value, ["templateReference", "lifecycleReference"]),
          family = String(parsePublishingReference(r.templateReference)),
          life =
            r.lifecycleReference === null
              ? null
              : String(parsePublishingReference(r.lifecycleReference));
        await authorize("platform.brand-template.read");
        const preliminary = await head(family),
          chosen = life === null ? (preliminary?.selected ?? null) : await lifecycle(family, life);
        if (chosen) await sourceTemplate(chosen);
        else await templates.current({ templateReference: family });
        if (preliminary?.releaseActive && preliminary.release)
          await sourceTemplate(preliminary.release);
        await familyAdmission(family, false);
        const actual = await head(family),
          selected = life === null ? (actual?.selected ?? null) : await lifecycle(family, life);
        if (
          canonicalizeRfc8785(preliminary) !== canonicalizeRfc8785(actual) ||
          canonicalizeRfc8785(chosen) !== canonicalizeRfc8785(selected)
        )
          return fail();
        heldReads.set("head:" + family, {
          read: () => head(family),
          bytes: canonicalizeRfc8785(actual),
        });
        if (life)
          heldReads.set("life:" + family + ":" + life, {
            read: () => lifecycle(family, life),
            bytes: canonicalizeRfc8785(selected),
          });
        return parsePlatformPublishingCurrent(
          {
            profile: "PlatformPublishingCurrentV1",
            scope,
            templateReference: family,
            lifecycleReference: life,
            current: selected,
            currentRelease: actual?.releaseActive ? actual.release : null,
            observedAt: check(),
            validUntil: deadline,
          },
          scope,
          check(),
        );
      });
    },
    async exact(value: unknown) {
      return protect(async () => {
        const r = closed(value, ["templateReference", "sequence"]),
          family = String(parsePublishingReference(r.templateReference)),
          n = r.sequence;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 2147483647) return fail();
        await authorize("platform.brand-template.read");
        const read = async () => {
            const result = rows(
              await query(
                "SELECT receipt_text,receipt_digest FROM bop_publishing.platform_template_publishing_operation WHERE family_id=$1 AND sequence=$2 AND outcome='Committed'",
                [family, n],
              ),
              1,
            );
            if (!result.length) return null;
            const row = result[0];
            if (!row) return fail();
            const receipt = storedReceipt(row);
            if (
              receipt.outcome !== "Committed" ||
              receipt.source.sequence !== n ||
              receipt.source.command.next.familyReference !== family
            )
              return fail();
            return receipt.source;
          },
          source = await read();
        if (source) await sourceTemplate(source);
        else await templates.current({ templateReference: family });
        await familyAdmission(family, false);
        if (canonicalizeRfc8785(await read()) !== canonicalizeRfc8785(source)) return fail();
        heldReads.set("exact:" + family + ":" + n, { read, bytes: canonicalizeRfc8785(source) });
        return parsePlatformPublishingExact(
          {
            profile: "PlatformPublishingExactV1",
            scope,
            templateReference: family,
            sequence: n,
            source,
            observedAt: check(),
            validUntil: deadline,
          },
          scope,
          check(),
        );
      });
    },
    async history(value: unknown) {
      return protect(async () => {
        const r = closed(value, ["templateReference", "beforeSequence"]),
          family = String(parsePublishingReference(r.templateReference)),
          before = r.beforeSequence;
        if (
          before !== null &&
          (typeof before !== "number" ||
            !Number.isInteger(before) ||
            before < 1 ||
            before > 2147483647)
        )
          return fail();
        await authorize("platform.brand-template.read");
        const read = async () =>
            rows(
              await query(
                "SELECT receipt_text,receipt_digest FROM bop_publishing.platform_template_publishing_operation WHERE family_id=$1 AND outcome='Committed' AND ($2::integer IS NULL OR sequence<$2) ORDER BY sequence DESC LIMIT 21",
                [family, before],
              ),
            ).map((row) => {
              const receipt = storedReceipt(row);
              if (
                receipt.outcome !== "Committed" ||
                receipt.source.command.next.familyReference !== family
              )
                return fail();
              return receipt.source;
            }),
          all = await read(),
          items = all.slice(0, 20);
        if (items.length) for (const source of items) await sourceTemplate(source);
        else await templates.current({ templateReference: family });
        await familyAdmission(family, false);
        if (canonicalizeRfc8785(await read()) !== canonicalizeRfc8785(all)) return fail();
        heldReads.set("history:" + family + ":" + before, {
          read,
          bytes: canonicalizeRfc8785(all),
        });
        return parsePlatformPublishingHistory(
          {
            profile: "PlatformPublishingHistoryV1",
            scope,
            templateReference: family,
            beforeSequence: before,
            items,
            hasMore: all.length > 20,
            nextBeforeSequence: all.length > 20 ? items.at(-1)?.sequence : null,
            observedAt: check(),
            validUntil: deadline,
          },
          scope,
          check(),
        );
      });
    },
    assertFinalized(): void {
      if (phase !== "Final" || busy || guardCalls !== 1 || finalCalls !== 1 || !guardDone)
        return invalid();
      permission.assertFinalized();
      if (childGuards.length > 1) templates.assertFinalized();
    },
  });
}
