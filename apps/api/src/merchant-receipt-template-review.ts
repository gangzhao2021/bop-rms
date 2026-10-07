import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import { parseCanonicalInstant } from "@bop/tenant";
import {
  createPostgresDigitalReceiptTemplateDraftStore,
  digitalReceiptTemplateDraftRequiredFields,
  parseDeviceReference,
  parseDigitalReceiptTemplateReviewCurrent,
  DigitalReceiptTemplateError,
} from "@rms/printing-device";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantReceiptTemplateEditingReview } from "./merchant-receipt-template-editing-review.js";

/** Ordinary read of actual immutable Draft and its recorded submission/current lifecycle.
 * It does not renew historical validation or confer Submit/Approve/Publish authority. */
export function createMerchantReceiptTemplateReview(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
}) {
  const persistence = options.persistence,
    authentication = options.authentication,
    now = persistence.now,
    runner = persistence.transactions,
    run = runner.run,
    auth = authentication.authorize,
    identity = persistence.identity,
    hasher = identity.hasher,
    actor = persistence.currentActor,
    association = persistence.validateAssociation;
  const fail = (
    code: DigitalReceiptTemplateError["code"] = "RECEIPT_TEMPLATE_UNAVAILABLE",
  ): never => {
    throw new DigitalReceiptTemplateError(code);
  };
  if ([now, run, auth, actor, association].some((p) => typeof p !== "function")) fail();
  const capture = () => {
    if (
      options.persistence !== persistence ||
      options.authentication !== authentication ||
      persistence.now !== now ||
      persistence.transactions !== runner ||
      runner.run !== run ||
      authentication.authorize !== auth ||
      persistence.identity !== identity ||
      identity.hasher !== hasher ||
      persistence.currentActor !== actor ||
      persistence.validateAssociation !== association
    )
      fail();
  };
  const host = createMerchantCategoryTransactions(runner),
    resolveScope = createMerchantStoreScope(persistence);
  return Object.freeze({
    async read(input: {
      sessionCookie: unknown;
      templateReference: unknown;
      expectedStoreReference?: unknown;
      expectedScope?: unknown;
    }) {
      capture();
      const origin = parseCanonicalInstant(now.call(persistence));
      let deadline: string = new Date(Date.parse(origin) + 5000).toISOString(),
        last: string = origin;
      const check = () => {
        capture();
        const at = parseCanonicalInstant(now.call(persistence));
        if (at < last || at >= deadline) fail();
        last = at;
        return at;
      };
      let template: string,
        expectedStore: string | undefined,
        expectedScope: Readonly<Record<string, string>> | undefined;
      let rawInput: Record<string, unknown>;
      try {
        rawInput = readClosedRecord(input, [
          "sessionCookie",
          "templateReference",
          ...(Object.hasOwn(input, "expectedStoreReference") ? ["expectedStoreReference"] : []),
          ...(Object.hasOwn(input, "expectedScope") ? ["expectedScope"] : []),
        ]);
        template = parseDeviceReference(rawInput.templateReference);
        if (rawInput.expectedStoreReference !== undefined)
          expectedStore = parseDeviceReference(rawInput.expectedStoreReference);
        if (rawInput.expectedScope !== undefined) {
          const raw = readClosedRecord(rawInput.expectedScope, [
            "tenantReference",
            "brandReference",
            "storeReference",
            "actorReference",
          ]);
          expectedScope = Object.freeze({
            tenantReference: parseDeviceReference(raw.tenantReference),
            brandReference: parseDeviceReference(raw.brandReference),
            storeReference: parseDeviceReference(raw.storeReference),
            actorReference: parseDeviceReference(raw.actorReference),
          });
        }
      } catch {
        return fail("RECEIPT_TEMPLATE_INPUT_INVALID");
      }
      const cookie = rawInput.sessionCookie;
      let finalized: (() => string) | undefined;
      const result = await host.transactions.run(async (tx) => {
        const query = tx.query;
        const denied = (error: unknown): never => {
          if (
            (error instanceof Error && error.message === "STORE_SERVICE_PERMISSION_DENIED") ||
            (error instanceof BrowserSessionError &&
              (error.code === "BROWSER_SESSION_DENIED" ||
                (error.code === "BROWSER_SESSION_INPUT_INVALID" &&
                  (typeof cookie !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(cookie)))))
          )
            return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
          throw error;
        };
        const scope = await resolveScope(tx, cookie, "organization.manage").catch(denied);
        check();
        const fixed = Object.freeze({
          tenantReference: parseDeviceReference(scope.selected.tenantReference),
          brandReference: parseDeviceReference(scope.context.brand.brandReference),
          storeReference: parseDeviceReference(scope.store.storeReference),
          actorReference: parseDeviceReference(scope.actorReference),
        });
        if (
          (expectedStore !== undefined && expectedStore !== fixed.storeReference) ||
          (expectedScope &&
            Object.entries(fixed).some(([key, value]) => expectedScope[key] !== value))
        )
          return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
        const allowed = scope.allowed,
          lease = scope.authorizationValidUntil,
          store = scope.store,
          selected = scope.selected,
          context = scope.context,
          brand = context.brand,
          session = scope.sessionReference;
        const scopeIdentity = () => {
          if (
            tx.query !== query ||
            scope.allowed !== allowed ||
            scope.authorizationValidUntil !== lease
          )
            return fail();
          if (
            scope.store !== store ||
            scope.selected !== selected ||
            scope.context !== context ||
            context.brand !== brand ||
            scope.sessionReference !== session ||
            String(selected.tenantReference) !== fixed.tenantReference ||
            String(brand.brandReference) !== fixed.brandReference ||
            String(store.storeReference) !== fixed.storeReference ||
            String(scope.actorReference) !== fixed.actorReference
          )
            return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
        };
        const fresh = async () => {
          check();
          scopeIdentity();
          const permitted = await allowed.call(scope).catch(denied);
          scopeIdentity();
          if (!permitted) return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
          const until = lease.call(scope);
          scopeIdentity();
          if (until === null) return fail();
          if (until < deadline) deadline = parseCanonicalInstant(until);
          check();
          scopeIdentity();
        };
        await fresh();
        const draft = createPostgresDigitalReceiptTemplateDraftStore({
          ...fixed,
          transaction: tx,
          clock: { now: check },
          originalObservedAt: origin,
          originalValidUntil: deadline,
          registerBeforeCommit: (actual, guard, final) => {
            if (actual !== tx) return fail();
            return host.registerBeforeCommit(tx, guard, final);
          },
          references: {
            canonicalize: canonicalizeRfc8785,
            hashIntent: (value) => "sha256:" + sha256Hex(value),
            nextReference: () => fail(),
          },
          authority: {
            holdUntilTransactionCompletes: async (actual, packet) => {
              check();
              const p = readClosedRecord(packet, [
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
                actual !== tx ||
                p.tenantReference !== fixed.tenantReference ||
                p.brandReference !== fixed.brandReference ||
                p.storeReference !== fixed.storeReference ||
                p.actorReference !== fixed.actorReference ||
                p.permission !== "organization.manage" ||
                p.purposeCode !== "RECEIPT_TEMPLATE_AUTHORING" ||
                p.mode !== "ReadCurrent" ||
                p.templateReference !== template ||
                p.targetVersionReference !== null ||
                p.command !== null ||
                canonicalizeRfc8785(p.requiredFields) !==
                  canonicalizeRfc8785(digitalReceiptTemplateDraftRequiredFields) ||
                typeof p.observedAt !== "string" ||
                p.observedAt < origin ||
                p.observedAt > last ||
                typeof p.validUntil !== "string" ||
                p.validUntil > new Date(Date.parse(origin) + 5000).toISOString()
              )
                return fail();
              await fresh();
              return { validUntil: deadline };
            },
          },
          readEditingReview: async () => fail(),
          readPublicationSequence: async () => fail(),
          readArtifact: async () => fail(),
          appendAudit: async () => fail(),
        });
        const current = await draft.readCurrent({ templateReference: template });
        if (!current.snapshot) return fail("RECEIPT_TEMPLATE_CONFLICT");
        let editing: ReturnType<typeof createMerchantReceiptTemplateEditingReview> | undefined;
        let recorded:
          | Awaited<
              ReturnType<ReturnType<typeof createMerchantReceiptTemplateEditingReview>["read"]>
            >
          | undefined;
        if (current.snapshot) {
          const family = current.snapshot.familyReference;
          editing = createMerchantReceiptTemplateEditingReview({
            ...fixed,
            transaction: tx,
            clock: { now: check },
            originalObservedAt: origin,
            originalValidUntil: deadline,
            registerBeforeCommit: (actual, guard, final) => {
              if (actual !== tx) return fail();
              return host.registerBeforeCommit(tx, guard, final);
            },
            references: {
              canonicalize: canonicalizeRfc8785,
              hashIntent: (value) => "sha256:" + sha256Hex(value),
            },
            holdCurrentOrgAuthority: async (actual, packet) => {
              check();
              const p = readClosedRecord(packet, [
                "tenantReference",
                "brandReference",
                "storeReference",
                "actorReference",
                "templateReference",
                "familyReference",
                "observedAt",
                "validUntil",
              ]);
              if (
                actual !== tx ||
                p.tenantReference !== fixed.tenantReference ||
                p.brandReference !== fixed.brandReference ||
                p.storeReference !== fixed.storeReference ||
                p.actorReference !== fixed.actorReference ||
                p.templateReference !== template ||
                p.familyReference !== family ||
                typeof p.observedAt !== "string" ||
                p.observedAt < origin ||
                p.observedAt > last ||
                typeof p.validUntil !== "string" ||
                p.validUntil > new Date(Date.parse(origin) + 5000).toISOString()
              )
                return fail();
              await fresh();
              return { validUntil: deadline };
            },
          });
          recorded = await editing.read(tx, {
            templateReference: template,
            familyReference: family,
            observedAt: check(),
            validUntil: deadline,
          });
        }
        await fresh();
        finalized = () => {
          scopeIdentity();
          const d = draft.assertFinalized(tx);
          scopeIdentity();
          if (d < deadline) deadline = d;
          if (editing) {
            const e = editing.assertFinalized(tx);
            scopeIdentity();
            if (e < deadline) deadline = e;
          }
          check();
          scopeIdentity();
          return deadline;
        };
        const mutation = recorded?.mutation,
          submission = recorded?.submission ?? null;
        return parseDigitalReceiptTemplateReviewCurrent({
          profile: "DigitalReceiptTemplateReviewCurrentV1",
          ...fixed,
          templateReference: template,
          currentDraft: current.snapshot
            ? {
                versionReference: current.snapshot.content.versionReference,
                revision: current.snapshot.revision,
                contentDigest: current.snapshot.contentDigest,
              }
            : null,
          submission,
          lifecycle: mutation
            ? {
                lifecycleReference: String(mutation.next.lifecycleId),
                version: mutation.next.version,
                state: mutation.next.state,
                latestMutationOperationReference: String(mutation.idempotencyKey),
                changedAt: String(mutation.next.changedAt),
                validationEvidenceReference: mutation.next.validationEvidenceReference,
                approvalEvidenceReference: mutation.next.approvalEvidenceReference,
              }
            : null,
          observedAt: check(),
          validUntil: deadline,
          sourceQualification: "NotEvaluated",
        });
      });
      if (!finalized) return fail();
      const until = finalized();
      return parseDigitalReceiptTemplateReviewCurrent({ ...result, validUntil: until });
    },
  });
}
