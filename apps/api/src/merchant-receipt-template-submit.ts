import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
} from "@bop/audit";
import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import { parseCanonicalInstant } from "@bop/tenant";
import {
  DigitalReceiptTemplateError,
  parseDeviceReference,
  createPostgresDigitalReceiptTemplateSubmitStore,
  createPostgresDigitalReceiptTemplateSubmissionStore,
  createPostgresDigitalReceiptTemplateDraftStore,
  createPostgresDigitalReceiptTemplateArtifactStore,
  digitalReceiptTemplateSubmitRequiredFields,
  digitalReceiptTemplateSubmissionRequiredFields,
  digitalReceiptTemplateDraftRequiredFields,
  digitalReceiptTemplateArtifactRequiredFields,
  type DigitalReceiptTemplateSubmit,
  type DigitalReceiptTemplateDraftActorScope,
} from "@rms/printing-device";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { bindMerchantReceiptTemplateSubmitCommand } from "./merchant-receipt-template-submit-command.js";
import { createMerchantReceiptTemplateReviewSource } from "./merchant-receipt-template-review-source.js";
import { createMerchantReceiptTemplateSubmitKernel } from "./merchant-receipt-template-submit-kernel.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/** Configurable development assumption, not an Owner-confirmed business policy.
 * Every new Submit persists its actual deadline; recovery never renews it. */
export const receiptTemplateDevelopmentReviewValidityMs = 259_200_000;
export function createMerchantReceiptTemplateSubmit(options: {
  readonly persistence: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly nextReference: () => string;
  readonly reviewValidityMs?: number;
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
    configuredValidity = options.reviewValidityMs,
    validity = configuredValidity ?? receiptTemplateDevelopmentReviewValidityMs;
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
      options.reviewValidityMs !== configuredValidity
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
        const initial = bindMerchantReceiptTemplateSubmitCommand(input.command, expected);
        originalBody = Object.freeze({
          command: initial.method === "submit" ? "SubmitReview" : "ResolveOriginal",
          operationReference: initial.command.operationReference,
          templateReference: initial.command.templateReference,
          expectedVersionReference: initial.command.expectedVersionReference,
          expectedRevision: initial.command.expectedRevision,
          ...(initial.method === "resolve" ? { intentDigest: initial.command.intentDigest } : {}),
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
        const bound = bindMerchantReceiptTemplateSubmitCommand(originalBody, fixed),
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
        const requiredActions = new Set(["publishing.review.submit"]);
        const retain = () => {
          stable();
          const until = lease.call(scope);
          stable();
          if (until === null) return fail();
          if (until < deadline) deadline = parseCanonicalInstant(until);
          stable();
        };
        const fresh = async (action = "publishing.review.submit") => {
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
        const artifacts = new Map<
          string,
          ReturnType<typeof createPostgresDigitalReceiptTemplateArtifactStore>
        >();
        let draft: ReturnType<typeof createPostgresDigitalReceiptTemplateDraftStore> | undefined;
        let freshCommand: DigitalReceiptTemplateSubmit | undefined;
        const readCurrentDraft = async (
          actual: unknown,
          requested: DigitalReceiptTemplateSubmit,
        ) => {
          if (
            actual !== tx ||
            !freshCommand ||
            canonicalizeRfc8785(requested) !== canonicalizeRfc8785(freshCommand)
          )
            return fail();
          await fresh();
          if (!draft) {
            draft = createPostgresDigitalReceiptTemplateDraftStore({
              ...fixed,
              transaction: tx,
              clock: { now: stable },
              originalObservedAt: origin,
              originalValidUntil: deadline,
              registerBeforeCommit: register,
              references: { ...refs, nextReference: () => fail() },
              readEditingReview: async () => fail(),
              readArtifact: async () => fail(),
              readPublicationSequence: async () => fail(),
              appendAudit: async () => fail(),
              authority: {
                async holdUntilTransactionCompletes(actualTx, input) {
                  const r = packet(actualTx, input, [
                    "tenantReference",
                    "brandReference",
                    "storeReference",
                    "actorReference",
                    "permission",
                    "purposeCode",
                    "mode",
                    "templateReference",
                    "targetVersionReference",
                    "requiredFields",
                    "command",
                    "observedAt",
                    "validUntil",
                  ]);
                  if (
                    r.permission !== "organization.manage" ||
                    r.purposeCode !== "RECEIPT_TEMPLATE_AUTHORING" ||
                    r.mode !== "ReadCurrent" ||
                    r.templateReference !== requested.templateReference ||
                    r.targetVersionReference !== null ||
                    r.command !== null ||
                    canonicalizeRfc8785(r.requiredFields) !==
                      canonicalizeRfc8785(digitalReceiptTemplateDraftRequiredFields)
                  )
                    return fail();
                  await fresh();
                  return Object.freeze({ validUntil: deadline });
                },
              },
            });
            owners.push(draft);
          }
          const current = await draft.readCurrent({
            templateReference: requested.templateReference,
          });
          await fresh();
          return current.snapshot;
        };
        const readArtifact = async (
          actual: unknown,
          request: { kind: "Layout" | "Compliance"; reference: string },
        ) => {
          if (actual !== tx || !freshCommand) return fail();
          await fresh();
          const key = request.kind + ":" + request.reference;
          let owner = artifacts.get(key);
          if (!owner) {
            owner = createPostgresDigitalReceiptTemplateArtifactStore({
              ...fixed,
              transaction: tx,
              clock: { now: stable },
              originalObservedAt: origin,
              originalValidUntil: deadline,
              registerBeforeCommit: register,
              references: { ...refs, nextReference: () => fail() },
              appendAudit: async () => fail(),
              authority: {
                async holdUntilTransactionCompletes(actualTx, input) {
                  const r = packet(actualTx, input, [
                    "tenantReference",
                    "brandReference",
                    "storeReference",
                    "actorReference",
                    "permission",
                    "purposeCode",
                    "mode",
                    "artifactKind",
                    "targetArtifactReference",
                    "requiredFields",
                    "command",
                    "observedAt",
                    "validUntil",
                  ]);
                  if (
                    r.permission !== "organization.manage" ||
                    r.purposeCode !== "RECEIPT_TEMPLATE_ARTIFACT" ||
                    r.mode !== "ReadVersion" ||
                    r.artifactKind !== request.kind ||
                    r.targetArtifactReference !== request.reference ||
                    r.command !== null ||
                    canonicalizeRfc8785(r.requiredFields) !==
                      canonicalizeRfc8785(digitalReceiptTemplateArtifactRequiredFields)
                  )
                    return fail();
                  await fresh();
                  return Object.freeze({ validUntil: deadline });
                },
              },
            });
            artifacts.set(key, owner);
            owners.push(owner);
          }
          const artifact = await owner.readVersion({
            artifactKind: request.kind,
            artifactReference: request.reference,
          });
          await fresh();
          return artifact;
        };
        const original = createPostgresDigitalReceiptTemplateSubmitStore({
          ...fixed,
          transaction: tx,
          clock: { now: stable },
          originalObservedAt: origin,
          originalValidUntil: deadline,
          registerBeforeCommit: register,
          references: refs,
          authority: {
            async holdUntilTransactionCompletes(actual, input) {
              const r = packet(actual, input, [
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
                r.permission !== "publishing.review.submit" ||
                r.purposeCode !== "RECEIPT_TEMPLATE_REVIEW" ||
                r.mode !== (bound.method === "submit" ? "SubmitReview" : "ResolveOriginal") ||
                canonicalizeRfc8785(r.command) !== canonicalizeRfc8785(command) ||
                canonicalizeRfc8785(r.requiredFields) !==
                  canonicalizeRfc8785(digitalReceiptTemplateSubmitRequiredFields)
              )
                return fail();
              await fresh();
              return Object.freeze({ validUntil: deadline });
            },
          },
          async appendAbandonedIntent(actual, input) {
            readClosedRecord(input, ["command", "intentDigest", "occurredAt"]);
            if (
              actual !== tx ||
              bound.method !== "resolve" ||
              canonicalizeRfc8785(input.command) !== canonicalizeRfc8785(command) ||
              input.intentDigest !== bound.command.intentDigest ||
              input.occurredAt < origin ||
              input.occurredAt > check()
            )
              return fail();
            await fresh();
            const auditId = next();
            const audit = validateAuditRecord(
              {
                auditId,
                brandId: fixed.brandReference,
                storeId: fixed.storeReference,
                actor: { type: "User", reference: fixed.actorReference },
                actionCode: "RECEIPT_TEMPLATE_SUBMIT_ORIGINAL_ABANDONED",
                targetType: "DigitalReceiptTemplateSubmission",
                targetId: command.operationReference,
                afterSummary: { intentDigest: input.intentDigest },
                reasonCode: "AUTHORIZED_OPERATION",
                correlationId: command.operationReference,
                occurredAt: input.occurredAt,
                sourceChannel: "API",
                dataClassification: "Internal",
                retentionPolicyCode: "OPERATIONAL",
                retentionPolicyVersion: 1,
              },
              Date.parse(check()),
            );
            await appendAuditRecordInTransaction(tx, audit);
            check();
            return Object.freeze({ auditReference: auditId, occurredAt: input.occurredAt });
          },
          async submitReview(actual, requested) {
            if (
              actual !== tx ||
              bound.method !== "submit" ||
              canonicalizeRfc8785(requested) !== canonicalizeRfc8785(command)
            )
              return fail();
            freshCommand = requested;
            await fresh("publishing.draft.create");
            const checked = check();
            const reviewValidUntil = parseCanonicalInstant(
              new Date(Date.parse(checked) + validity).toISOString(),
            );
            if (reviewValidUntil <= checked) return fail();
            const kernel = createMerchantReceiptTemplateSubmitKernel({
              transaction: tx,
              currentTenantContext: context,
              scope: fixed,
              clock: { now: stable },
              originalObservedAt: origin,
              originalValidUntil: deadline,
              reviewValidUntil,
              nextReference: () => next(),
              readCurrentDraft,
              readArtifact,
              async authorizePublishing(request) {
                if (
                  canonicalizeRfc8785(request.tenantContext) !== canonicalizeRfc8785(context) ||
                  request.resourceScope.kind !== "Store" ||
                  String(request.resourceScope.brandReference) !== fixed.brandReference ||
                  String(request.resourceScope.storeReference) !== fixed.storeReference ||
                  request.purposeCode !== "RECEIPT_ISSUANCE" ||
                  (request.action !== "publishing.draft.create" &&
                    request.action !== "publishing.review.submit")
                )
                  return fail();
                return fresh(request.action);
              },
            });
            const submitted = await kernel.submit(tx, requested);
            check();
            if (submitted.submissionOperationReference !== requested.operationReference)
              return fail();
            const expectedSubmission = Object.freeze({
              templateReference: requested.templateReference,
              versionReference: requested.expectedVersionReference,
              expectedRevision: requested.expectedRevision,
              operationReference: requested.operationReference,
              reviewLifecycleReference: submitted.reviewLifecycleReference,
            });
            const reader = createMerchantReceiptTemplateReviewSource({
              scope: fixed,
              transaction: tx,
              clock: { now: stable },
              originalObservedAt: origin,
              originalValidUntil: deadline,
              async holdCurrentAuthority(actualTx, input) {
                readClosedRecord(input, [
                  "tenantReference",
                  "brandReference",
                  "storeReference",
                  "actorReference",
                  "familyReference",
                  "reviewLifecycleReference",
                  "operationReference",
                  "snapshotReference",
                  "snapshotDigest",
                  "observedAt",
                  "validUntil",
                  "permission",
                  "purposeCode",
                ]);
                if (
                  actualTx !== tx ||
                  Object.entries(fixed).some(
                    ([key, value]) => Object.getOwnPropertyDescriptor(input, key)?.value !== value,
                  ) ||
                  input.permission !== "publishing.review.submit" ||
                  input.purposeCode !== "RECEIPT_TEMPLATE_SUBMISSION" ||
                  input.operationReference !== requested.operationReference ||
                  input.reviewLifecycleReference !== submitted.reviewLifecycleReference ||
                  input.snapshotReference !== requested.expectedVersionReference ||
                  input.observedAt < origin ||
                  input.observedAt > check() ||
                  input.validUntil > deadline
                )
                  return fail();
                await fresh();
                return Object.freeze({
                  validUntil: input.validUntil < deadline ? input.validUntil : deadline,
                });
              },
            });
            const provenance = createPostgresDigitalReceiptTemplateSubmissionStore({
              ...fixed,
              transaction: tx,
              clock: { now: stable },
              originalObservedAt: origin,
              originalValidUntil: deadline,
              registerBeforeCommit: register,
              references: refs,
              readPublishingReview: reader,
              authority: {
                async holdUntilTransactionCompletes(actualTx, input) {
                  const r = packet(actualTx, input, [
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
                    r.permission !== "publishing.review.submit" ||
                    r.purposeCode !== "RECEIPT_TEMPLATE_SUBMISSION" ||
                    r.mode !== "Write" ||
                    r.templateReference !== expectedSubmission.templateReference ||
                    r.versionReference !== expectedSubmission.versionReference ||
                    canonicalizeRfc8785(r.command) !== canonicalizeRfc8785(expectedSubmission) ||
                    canonicalizeRfc8785(r.requiredFields) !==
                      canonicalizeRfc8785(digitalReceiptTemplateSubmissionRequiredFields)
                  )
                    return fail();
                  await fresh();
                  return Object.freeze({ validUntil: deadline });
                },
              },
            });
            owners.push(provenance);
            const result = await provenance.write(expectedSubmission);
            await fresh("publishing.draft.create");
            return result;
          },
        });
        finalized = () => {
          stable();
          original.assertFinalized(tx);
          stable();
          for (const owner of owners) {
            stable();
            owner.assertFinalized(tx);
            stable();
          }
          stable();
        };
        return bound.method === "submit"
          ? original.submit(bound.command)
          : original.resolve(bound.command);
      });
      if (!finalized) return fail();
      finalized();
      return result;
    },
  });
}
