import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
} from "@bop/audit";
import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import { parseCanonicalInstant } from "@bop/tenant";
import {
  createPostgresPublishingMutationStore,
  createPublishingScope,
  parsePublishingReference,
} from "@bop/publishing";
import {
  DigitalReceiptTemplateError,
  parseDeviceReference,
  createPostgresDigitalReceiptTemplateLifecycleStore,
  createPostgresDigitalReceiptTemplateStore,
  createPostgresReceiptTemplateContentPublicationProof,
  materializeDigitalReceiptTemplateContent,
  type DigitalReceiptTemplateAuthoredContent,
  type DigitalReceiptTemplateVersion,
  createPostgresDigitalReceiptTemplateSubmissionStore,
  digitalReceiptTemplateLifecycleActionRequiredFields,
  digitalReceiptTemplateSubmissionRequiredFields,
  type DigitalReceiptTemplateLifecycleAction,
  type DigitalReceiptTemplateDraftActorScope,
} from "@rms/printing-device";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { bindMerchantReceiptTemplateLifecycleCommand } from "./merchant-receipt-template-lifecycle-command.js";
import { createMerchantReceiptTemplateLifecycleKernel } from "./merchant-receipt-template-lifecycle-kernel.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/** Configurable development assumption, not an Owner-confirmed business policy.
 * New approval is clamped to the actual original validation deadline; recovery never renews it. */
export const receiptTemplateDevelopmentApprovalValidityMs = 86_400_000;
export function createMerchantReceiptTemplateLifecycle(options: {
  readonly persistence: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly nextReference: () => string;
  readonly approvalValidityMs?: number;
}) {
  const persistence = options.persistence,
    authentication = options.authentication,
    nowPort = persistence.now,
    runner = persistence.transactions,
    runPort = runner.run,
    authorizePort = authentication.authorize,
    nextPort = options.nextReference,
    identity = persistence.identity,
    hasher = identity.hasher,
    currentActor = persistence.currentActor,
    association = persistence.validateAssociation,
    configuredValidity = options.approvalValidityMs,
    validity = configuredValidity ?? receiptTemplateDevelopmentApprovalValidityMs;
  const fail = (
    code: DigitalReceiptTemplateError["code"] = "RECEIPT_TEMPLATE_UNAVAILABLE",
  ): never => {
    throw new DigitalReceiptTemplateError(code);
  };
  if (
    [nowPort, runPort, authorizePort, nextPort, currentActor, association].some(
      (p) => typeof p !== "function",
    ) ||
    !Number.isSafeInteger(validity) ||
    validity < 1
  )
    fail();
  const host = createMerchantCategoryTransactions(runner),
    resolveScope = createMerchantStoreScope(persistence);
  const capture = () => {
    if (
      options.persistence !== persistence ||
      options.authentication !== authentication ||
      persistence.now !== nowPort ||
      persistence.transactions !== runner ||
      runner.run !== runPort ||
      authentication.authorize !== authorizePort ||
      options.nextReference !== nextPort ||
      persistence.identity !== identity ||
      identity.hasher !== hasher ||
      persistence.currentActor !== currentActor ||
      persistence.validateAssociation !== association ||
      options.approvalValidityMs !== configuredValidity
    )
      fail();
  };
  return Object.freeze({
    async write(input: {
      sessionCookie: unknown;
      csrf: unknown;
      expectedScope: unknown;
      command: unknown;
    }) {
      capture();
      const origin = parseCanonicalInstant(nowPort.call(persistence));
      let latest: string = origin,
        deadline: string = new Date(Date.parse(origin) + 5000).toISOString();
      const check = () => {
        capture();
        const at = parseCanonicalInstant(nowPort.call(persistence));
        if (at < latest || at >= deadline) fail();
        latest = at;
        return at;
      };
      let expected: DigitalReceiptTemplateDraftActorScope;
      let originalBody: unknown;
      try {
        const raw = readClosedRecord(input.expectedScope, [
          "tenantReference",
          "brandReference",
          "storeReference",
          "actorReference",
        ]);
        expected = Object.freeze({
          tenantReference: parseDeviceReference(raw.tenantReference),
          brandReference: parseDeviceReference(raw.brandReference),
          storeReference: parseDeviceReference(raw.storeReference),
          actorReference: parseDeviceReference(raw.actorReference),
        });
        // Parse and detach before awaiting authentication; never retain mutable browser intent.
        const initial = bindMerchantReceiptTemplateLifecycleCommand(input.command, expected);
        originalBody = Object.freeze({
          command: initial.method === "execute" ? initial.command.action : "ResolveOriginal",
          operationReference: initial.command.operationReference,
          templateReference: initial.command.templateReference,
          expectedVersionReference: initial.command.expectedVersionReference,
          expectedRevision: initial.command.expectedRevision,
          reviewLifecycleReference: initial.command.reviewLifecycleReference,
          expectedReviewVersion: initial.command.expectedReviewVersion,
          expectedReviewOperationReference: initial.command.expectedReviewOperationReference,
          ...(initial.method === "resolve"
            ? { action: initial.command.action, intentDigest: initial.command.intentDigest }
            : {}),
        });
      } catch {
        return fail("RECEIPT_TEMPLATE_INPUT_INVALID");
      }
      const cookie = input.sessionCookie;
      const denied = (error: unknown): never => {
        if (
          (error instanceof Error && error.message === "STORE_SERVICE_PERMISSION_DENIED") ||
          (error instanceof BrowserSessionError &&
            (error.code === "BROWSER_SESSION_DENIED" ||
              (error.code === "BROWSER_SESSION_INPUT_INVALID" &&
                (typeof cookie !== "string" ||
                  !/^[A-Za-z0-9_-]{43}$/u.test(cookie) ||
                  typeof input.csrf !== "string" ||
                  !/^[A-Za-z0-9_-]{43}$/u.test(input.csrf)))))
        )
          return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
        if (error instanceof DigitalReceiptTemplateError) throw error;
        return fail();
      };
      const authenticated = await authorizePort
        .call(authentication, { sessionCookie: cookie, csrf: input.csrf })
        .catch(denied);
      check();
      let finalized: (() => void) | undefined;
      const result = await host.transactions.run(async (tx) => {
        const query = tx.query;
        const scope = await resolveScope(
          tx,
          cookie,
          "organization.manage",
          authenticated.sessionReference,
        ).catch(denied);
        check();
        const fixed = Object.freeze({
          tenantReference: parseDeviceReference(scope.selected.tenantReference),
          brandReference: parseDeviceReference(scope.context.brand.brandReference),
          storeReference: parseDeviceReference(scope.store.storeReference),
          actorReference: parseDeviceReference(scope.actorReference),
        });
        if (
          Object.entries(fixed).some(
            ([key, value]) => Object.getOwnPropertyDescriptor(expected, key)?.value !== value,
          )
        )
          return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
        const bound = bindMerchantReceiptTemplateLifecycleCommand(originalBody, fixed),
          command = bound.command;
        const allowed = scope.allowed,
          lease = scope.authorizationValidUntil,
          fineAction = scope.authorizeAction,
          selectedStore = scope.store,
          session = scope.sessionReference,
          context = scope.context,
          selection = scope.selected,
          brand = scope.context.brand;
        const stable = () => {
          const at = check();
          if (
            tx.query !== query ||
            scope.allowed !== allowed ||
            scope.authorizationValidUntil !== lease ||
            scope.authorizeAction !== fineAction ||
            scope.store !== selectedStore ||
            scope.sessionReference !== session ||
            scope.context !== context ||
            scope.selected !== selection ||
            context.brand !== brand ||
            String(scope.selected.tenantReference) !== fixed.tenantReference ||
            String(context.brand.brandReference) !== fixed.brandReference ||
            String(selectedStore.storeReference) !== fixed.storeReference ||
            String(scope.actorReference) !== fixed.actorReference
          )
            return fail();
          return at;
        };
        const permission =
          command.action === "Approve" ? "publishing.review.approve" : "publishing.release.publish";
        const requiredActions = new Set<string>([permission]);
        const retain = () => {
          stable();
          const until = lease.call(scope);
          stable();
          if (until === null) return fail();
          if (until < deadline) deadline = parseCanonicalInstant(until);
          stable();
        };
        const fresh = async (action: string = permission) => {
          requiredActions.add(action);
          stable();
          if (!(await allowed.call(scope).catch(denied)))
            return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
          retain();
          let requestedDecision;
          for (const required of requiredActions) {
            const decision = await fineAction.call(scope, required).catch(denied);
            stable();
            retain();
            if (decision?.effect !== "Allow") return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
            if (required === action) requestedDecision = decision;
          }
          if (!requestedDecision) return fail();
          return requestedDecision;
        };
        await fresh();
        const register = (actual: unknown, guard: () => Promise<void>, final: () => void) => {
          if (actual !== tx) return fail();
          return host.registerBeforeCommit(tx, guard, final);
        };
        const refs = {
          canonicalize: canonicalizeRfc8785,
          hashIntent: (text: string) => "sha256:" + sha256Hex(text),
        };
        const next = () => {
          check();
          const value = parseDeviceReference(nextPort.call(options));
          check();
          return value;
        };
        const packet = (actual: unknown, value: unknown, keys: readonly string[]) => {
          const raw = readClosedRecord(value, keys);
          stable();
          if (
            actual !== tx ||
            Object.entries(fixed).some(([key, value]) => raw[key] !== value) ||
            typeof raw.observedAt !== "string" ||
            raw.observedAt < origin ||
            raw.observedAt > check() ||
            typeof raw.validUntil !== "string" ||
            raw.validUntil > deadline
          )
            return fail();
          return raw;
        };
        const owners: { assertFinalized(actual: typeof tx): string }[] = [];
        let kernel: ReturnType<typeof createMerchantReceiptTemplateLifecycleKernel> | undefined;
        let activeCommand: DigitalReceiptTemplateLifecycleAction | undefined;
        let authored: DigitalReceiptTemplateAuthoredContent | undefined;
        let published: DigitalReceiptTemplateVersion | undefined;
        let publicationProof:
          ReturnType<typeof createPostgresReceiptTemplateContentPublicationProof> | undefined;
        const pubScope = createPublishingScope({
          kind: "Store",
          brandReference: parsePublishingReference(fixed.brandReference),
          storeReference: parsePublishingReference(fixed.storeReference),
        });
        const pubOwner = createPostgresPublishingMutationStore(
          { run: async (work) => work(tx) },
          parsePublishingReference(fixed.tenantReference),
          pubScope,
        );
        const source = (
          mode: "ReadSubmission" | "ReadAuthoredContent",
          requested: DigitalReceiptTemplateLifecycleAction,
        ) => {
          const owner = createPostgresDigitalReceiptTemplateSubmissionStore({
            ...fixed,
            transaction: tx,
            clock: { now: stable },
            originalObservedAt: origin,
            originalValidUntil: deadline,
            registerBeforeCommit: register,
            references: refs,
            readPublishingReview: async () => fail(),
            authority: {
              async holdUntilTransactionCompletes(actual, value) {
                const r = packet(actual, value, [
                  "tenantReference",
                  "brandReference",
                  "storeReference",
                  "actorReference",
                  "permission",
                  "purposeCode",
                  "mode",
                  "requiredFields",
                  "command",
                  "templateReference",
                  "versionReference",
                  "observedAt",
                  "validUntil",
                ]);
                if (
                  r.permission !== "organization.manage" ||
                  r.purposeCode !== "RECEIPT_TEMPLATE_SUBMISSION" ||
                  r.mode !== mode ||
                  r.command !== null ||
                  r.templateReference !== requested.templateReference ||
                  r.versionReference !== requested.expectedVersionReference ||
                  canonicalizeRfc8785(r.requiredFields) !==
                    canonicalizeRfc8785(digitalReceiptTemplateSubmissionRequiredFields)
                )
                  return fail();
                await fresh();
                return Object.freeze({ validUntil: deadline });
              },
            },
          });
          owners.push(owner);
          return owner;
        };
        const original = createPostgresDigitalReceiptTemplateLifecycleStore({
          ...fixed,
          transaction: tx,
          clock: { now: stable },
          originalObservedAt: origin,
          originalValidUntil: deadline,
          registerBeforeCommit: register,
          references: refs,
          authority: {
            async holdUntilTransactionCompletes(actual, value) {
              const r = packet(actual, value, [
                "tenantReference",
                "brandReference",
                "storeReference",
                "actorReference",
                "permission",
                "purposeCode",
                "mode",
                "requiredFields",
                "command",
                "observedAt",
                "validUntil",
              ]);
              if (
                r.permission !== permission ||
                r.purposeCode !== "RECEIPT_TEMPLATE_REVIEW" ||
                r.mode !== (bound.method === "execute" ? "Execute" : "ResolveOriginal") ||
                canonicalizeRfc8785(r.command) !== canonicalizeRfc8785(command) ||
                canonicalizeRfc8785(r.requiredFields) !==
                  canonicalizeRfc8785(digitalReceiptTemplateLifecycleActionRequiredFields)
              )
                return fail();
              await fresh();
              return Object.freeze({ validUntil: deadline });
            },
          },
          async appendAbandonedIntent(actual, value) {
            readClosedRecord(value, ["command", "intentDigest", "occurredAt"]);
            if (
              actual !== tx ||
              bound.method !== "resolve" ||
              canonicalizeRfc8785(value.command) !== canonicalizeRfc8785(command) ||
              value.intentDigest !== bound.command.intentDigest ||
              value.occurredAt < origin ||
              value.occurredAt > stable()
            )
              return fail();
            await fresh();
            const audit = validateAuditRecord(
              {
                auditId: next(),
                brandId: fixed.brandReference,
                storeId: fixed.storeReference,
                actor: { type: "User", reference: fixed.actorReference },
                actionCode: "RECEIPT_TEMPLATE_LIFECYCLE_ORIGINAL_ABANDONED",
                targetType: "DigitalReceiptTemplate",
                targetId: command.operationReference,
                afterSummary: { intentDigest: value.intentDigest },
                reasonCode: "AUTHORIZED_OPERATION",
                correlationId: command.operationReference,
                occurredAt: value.occurredAt,
                sourceChannel: "API",
                dataClassification: "Confidential",
                retentionPolicyCode: "OPERATIONAL",
                retentionPolicyVersion: 1,
              },
              Date.parse(stable()),
            );
            await appendAuditRecordInTransaction(tx, audit);
            stable();
            return Object.freeze({ auditReference: audit.auditId, occurredAt: audit.occurredAt });
          },
          async performAction(actual, requested) {
            if (
              actual !== tx ||
              bound.method !== "execute" ||
              kernel ||
              canonicalizeRfc8785(requested) !== canonicalizeRfc8785(command)
            )
              return fail();
            activeCommand = requested;
            // The inherited Device publication writer requires current Integration permission only for a fresh publication.
            if (requested.action === "Publish") await fresh("integration.manage");
            kernel = createMerchantReceiptTemplateLifecycleKernel({
              transaction: tx,
              currentTenantContext: context,
              scope: fixed,
              clock: { now: stable },
              originalObservedAt: origin,
              originalValidUntil: deadline,
              approvalValidityMs: validity,
              nextReference: () => next(),
              async authorizePublishing(request) {
                stable();
                if (
                  request.action !== permission ||
                  request.familyReference !== authored?.familyReference ||
                  canonicalizeRfc8785(request.tenantContext) !== canonicalizeRfc8785(context) ||
                  canonicalizeRfc8785(request.resourceScope) !== canonicalizeRfc8785(pubScope)
                )
                  return fail();
                return fresh(request.action);
              },
              async readReviewSources(actualTx, action) {
                if (
                  actualTx !== tx ||
                  canonicalizeRfc8785(action) !== canonicalizeRfc8785(requested)
                )
                  return fail();
                await fresh();
                const reader = source("ReadSubmission", requested),
                  contentReader = source("ReadAuthoredContent", requested);
                const pin = {
                  templateReference: requested.templateReference,
                  versionReference: requested.expectedVersionReference,
                };
                const submission = await reader.readSubmission(pin),
                  content = await contentReader.readAuthoredContent(pin);
                stable();
                if (!submission || !content) return fail("RECEIPT_TEMPLATE_CONFLICT");
                authored = content;
                const current = await pubOwner.resolveCurrentLifecycleMutation({
                  familyReference: submission.familyReference,
                  lifecycleReference: submission.reviewLifecycleReference,
                  configurationType: "RECEIPT_TEMPLATE",
                  purposeCode: "RECEIPT_ISSUANCE",
                  observedAt: stable(),
                });
                stable();
                if (!current) return fail("RECEIPT_TEMPLATE_CONFLICT");
                return Object.freeze({ submission, authoredContent: content, current });
              },
              async appendPublication(actualTx, input) {
                if (
                  actualTx !== tx ||
                  !authored ||
                  !activeCommand ||
                  activeCommand.action !== "Publish" ||
                  input.operationReference !== command.operationReference ||
                  canonicalizeRfc8785(input.content) !== canonicalizeRfc8785(authored.content)
                )
                  return fail();
                await fresh("integration.manage");
                const version = materializeDigitalReceiptTemplateContent({
                  content: input.content,
                  publicationReference: input.release.releaseId,
                  publishedAt: input.release.createdAt,
                });
                const contentDigest = refs.hashIntent(refs.canonicalize(input.content));
                publicationProof = createPostgresReceiptTemplateContentPublicationProof({
                  tenantReference: fixed.tenantReference,
                  brandReference: fixed.brandReference,
                  storeReference: fixed.storeReference,
                  familyReference: authored.familyReference,
                  configurationType: "RECEIPT_TEMPLATE",
                  purposeCode: "RECEIPT_ISSUANCE",
                  async authorize(actualTx, observedAt) {
                    if (actualTx !== tx || observedAt < origin || observedAt > stable())
                      return fail();
                    await fresh("integration.manage");
                    return true;
                  },
                  async readAuthoredContent(actualTx, pin) {
                    if (
                      actualTx !== tx ||
                      !authored ||
                      pin.tenantReference !== fixed.tenantReference ||
                      pin.brandReference !== fixed.brandReference ||
                      pin.storeReference !== fixed.storeReference ||
                      pin.templateReference !== command.templateReference ||
                      pin.versionReference !== command.expectedVersionReference
                    )
                      return fail();
                    stable();
                    return authored;
                  },
                });
                const proof = publicationProof;
                const writer = createPostgresDigitalReceiptTemplateStore({
                  brandReference: fixed.brandReference,
                  storeReference: fixed.storeReference,
                  async authorize(actualTx, value) {
                    if (
                      actualTx !== tx ||
                      value.brandReference !== fixed.brandReference ||
                      value.storeReference !== fixed.storeReference ||
                      value.templateReference !== command.templateReference
                    )
                      return fail();
                    await fresh("integration.manage");
                    return true;
                  },
                  async validatePublication(actualTx, v, digest) {
                    if (actualTx !== tx || digest !== contentDigest) return fail();
                    const p = await proof(tx, v, stable());
                    stable();
                    return p !== null && p.contentDigest === digest;
                  },
                  async isCurrentPublication(actualTx, v, at) {
                    if (actualTx !== tx) return fail();
                    await fresh("integration.manage");
                    const current = await pubOwner.resolveCurrentRelease({
                      familyReference: input.release.familyReference,
                      configurationType: "RECEIPT_TEMPLATE",
                      purposeCode: "RECEIPT_ISSUANCE",
                      observedAt: at,
                    });
                    stable();
                    return String(current.release.releaseId) === String(v.publicationReference);
                  },
                });
                const audit = validateAuditRecord(
                  {
                    auditId: next(),
                    brandId: fixed.brandReference,
                    storeId: fixed.storeReference,
                    actor: { type: "User", reference: fixed.actorReference },
                    actionCode: "RECEIPT_TEMPLATE_PUBLISH",
                    targetType: "DigitalReceiptTemplate",
                    targetId: version.versionReference,
                    reasonCode: "AUTHORIZED_OPERATION",
                    correlationId: command.operationReference,
                    occurredAt: version.publishedAt,
                    sourceChannel: "API",
                    dataClassification: "Confidential",
                    retentionPolicyCode: "OPERATIONAL",
                    retentionPolicyVersion: 1,
                  },
                  Date.parse(stable()),
                );
                const appended = await writer.appendPublishedInTransaction(tx, {
                  version,
                  operationReference: command.operationReference,
                  publicationDigest: contentDigest,
                  audit,
                });
                stable();
                published = appended.version;
                register(
                  tx,
                  async () => {
                    await fresh("integration.manage");
                    if (!published || !(await proof(tx, published, stable()))) return fail();
                    stable();
                  },
                  () => {
                    stable();
                  },
                );
                return appended.version;
              },
            });
            return kernel.execute(tx, requested);
          },
          async readActualAction(actual, requested) {
            if (
              actual !== tx ||
              !kernel ||
              !activeCommand ||
              canonicalizeRfc8785(requested) !== canonicalizeRfc8785(activeCommand)
            )
              return fail();
            return kernel.readActualAction(tx, requested);
          },
        });
        finalized = () => {
          stable();
          const until = original.assertFinalized(tx);
          stable();
          if (until < deadline) deadline = until;
          for (const owner of owners) {
            stable();
            const until = owner.assertFinalized(tx);
            stable();
            if (until < deadline) deadline = until;
          }
          stable();
        };
        return bound.method === "execute"
          ? original.execute(bound.command)
          : original.resolve(bound.command);
      });
      if (!finalized) return fail();
      finalized();
      return result;
    },
  });
}
