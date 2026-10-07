import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import { parseCanonicalInstant } from "@bop/tenant";
import {
  createPostgresDigitalReceiptTemplateStore,
  createPostgresDigitalReceiptTemplateSubmissionStore,
  digitalReceiptTemplateSubmissionRequiredFields,
  createPostgresReceiptTemplateContentPublicationProof,
  resolveDigitalReceiptTemplate,
  type DigitalReceiptTemplateVersion,
  type DigitalReceiptTemplateAuthoredContent,
  parseDeviceReference,
  parseDigitalReceiptTemplatePublishedCurrent,
  DigitalReceiptTemplateError,
} from "@rms/printing-device";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import {
  createPostgresPublishingMutationStore,
  createPublishingScope,
  parsePublishingReference,
} from "@bop/publishing";

/** Actual current release plus immutable V2 authored content.
 * Published software content is not professional/legal approval or Store readiness. */
export function createMerchantReceiptTemplatePublished(options: {
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
      expectedScope: unknown;
      locale: unknown;
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
      let locale: string;
      let template: string,
        expectedStore: string | undefined,
        expectedScope: Readonly<Record<string, string>> | undefined;
      let rawInput: Record<string, unknown>;
      try {
        rawInput = readClosedRecord(input, [
          "sessionCookie",
          "templateReference",
          "locale",
          ...(Object.hasOwn(input, "expectedStoreReference") ? ["expectedStoreReference"] : []),
          "expectedScope",
        ]);
        template = parseDeviceReference(rawInput.templateReference);
        if (
          typeof rawInput.locale !== "string" ||
          !/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(rawInput.locale)
        )
          return fail("RECEIPT_TEMPLATE_INPUT_INVALID");
        locale = rawInput.locale;
        if (rawInput.expectedStoreReference !== undefined)
          expectedStore = parseDeviceReference(rawInput.expectedStoreReference);
        if (rawInput.expectedScope === undefined) return fail("RECEIPT_TEMPLATE_INPUT_INVALID");
        {
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
        let authorityFailure: DigitalReceiptTemplateError | undefined;
        const fresh = async () => {
          try {
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
          } catch (error) {
            if (
              error instanceof DigitalReceiptTemplateError &&
              error.code === "RECEIPT_TEMPLATE_PERMISSION_DENIED"
            )
              authorityFailure = error;
            throw error;
          }
        };
        await fresh();
        if (locale !== store.locale) return fail("RECEIPT_TEMPLATE_INPUT_INVALID");
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
        const owners: ReturnType<typeof createPostgresDigitalReceiptTemplateSubmissionStore>[] = [];
        const authored = new Map<string, DigitalReceiptTemplateAuthoredContent>();
        const proofs = new Map<
          string,
          ReturnType<typeof createPostgresReceiptTemplateContentPublicationProof>
        >();
        let phase: "Work" | "Checking" | "Final" = "Work",
          poisoned = false,
          finalDone = false;
        let sourceFailure = false;
        const currentScope = () => {
          check();
          scopeIdentity();
          if (poisoned || locale !== store.locale) return fail();
        };
        const acquire = async (version: DigitalReceiptTemplateVersion) => {
          currentScope();
          const ref = String(version.versionReference),
            old = authored.get(ref);
          if (old) return old;
          if (phase !== "Work") return fail();
          const owner = createPostgresDigitalReceiptTemplateSubmissionStore({
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
            readPublishingReview: async () => fail(),
            authority: {
              async holdUntilTransactionCompletes(actual, value) {
                check();
                scopeIdentity();
                const p = readClosedRecord(value, [
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
                  actual !== tx ||
                  Object.entries(fixed).some(([k, v]) => p[k] !== v) ||
                  p.permission !== "organization.manage" ||
                  p.purposeCode !== "RECEIPT_TEMPLATE_SUBMISSION" ||
                  p.mode !== "ReadAuthoredContent" ||
                  p.command !== null ||
                  p.templateReference !== template ||
                  p.versionReference !== ref ||
                  canonicalizeRfc8785(p.requiredFields) !==
                    canonicalizeRfc8785(digitalReceiptTemplateSubmissionRequiredFields) ||
                  typeof p.observedAt !== "string" ||
                  p.observedAt < origin ||
                  p.observedAt > last ||
                  typeof p.validUntil !== "string" ||
                  p.validUntil > deadline
                )
                  return fail();
                await fresh();
                return Object.freeze({ validUntil: deadline });
              },
            },
          });
          owners.push(owner);
          const content = await owner.readAuthoredContent({
            templateReference: template,
            versionReference: ref,
          });
          currentScope();
          // Legacy publication without immutable V2 author provenance cannot be upgraded into qualification.
          if (!content) return fail();
          authored.set(ref, content);
          return content;
        };
        const qualified: DigitalReceiptTemplateVersion[] = [];
        const writer = createPostgresDigitalReceiptTemplateStore({
          brandReference: fixed.brandReference,
          storeReference: fixed.storeReference,
          async authorize(actual, p) {
            try {
              currentScope();
              if (
                actual !== tx ||
                p.action !== "Read" ||
                p.brandReference !== fixed.brandReference ||
                p.storeReference !== fixed.storeReference ||
                p.templateReference !== template
              )
                return fail();
              await fresh();
              currentScope();
              return true;
            } catch (error) {
              sourceFailure = true;
              throw error;
            }
          },
          validatePublication: async () => fail(),
          async isCurrentPublication(actual, version, at) {
            try {
              currentScope();
              if (
                actual !== tx ||
                version.templateReference !== template ||
                at < origin ||
                at > last
              )
                return fail();
              await fresh();
              const content = await acquire(version);
              const current = await pubOwner.resolveCurrentRelease({
                familyReference: content.familyReference,
                configurationType: "RECEIPT_TEMPLATE",
                purposeCode: "RECEIPT_ISSUANCE",
                observedAt: at,
              });
              currentScope();
              if (String(current.release.releaseId) !== String(version.publicationReference))
                return false;
              let proof = proofs.get(String(version.versionReference));
              if (!proof) {
                if (phase !== "Work") return fail();
                proof = createPostgresReceiptTemplateContentPublicationProof({
                  tenantReference: fixed.tenantReference,
                  brandReference: fixed.brandReference,
                  storeReference: fixed.storeReference,
                  familyReference: content.familyReference,
                  configurationType: "RECEIPT_TEMPLATE",
                  purposeCode: "RECEIPT_ISSUANCE",
                  async authorize(actual, observedAt) {
                    currentScope();
                    if (actual !== tx || observedAt < origin || observedAt > last) return fail();
                    await fresh();
                    currentScope();
                    return true;
                  },
                  async readAuthoredContent(actual, p) {
                    currentScope();
                    if (
                      actual !== tx ||
                      p.tenantReference !== fixed.tenantReference ||
                      p.brandReference !== fixed.brandReference ||
                      p.storeReference !== fixed.storeReference ||
                      p.templateReference !== template ||
                      p.versionReference !== String(version.versionReference)
                    )
                      return fail();
                    return content;
                  },
                });
                proofs.set(String(version.versionReference), proof);
              }
              const packet = await proof(tx, version, at);
              currentScope();
              if (!packet) return fail();
              qualified.push(version);
              return true;
            } catch (error) {
              sourceFailure = true;
              throw error;
            }
          },
        });
        const read = async () => {
          currentScope();
          qualified.length = 0;
          sourceFailure = false;
          const at = check();
          try {
            return await writer.resolve(tx, {
              templateReference: template,
              locale,
              observedAt: at,
            });
          } catch (error) {
            poisoned = true;
            if (authorityFailure) throw authorityFailure;
            // Only completed actual qualification followed by the owning pure time/locale
            // selection's unavailable outcome is a known current-selection conflict.
            if (
              error instanceof DigitalReceiptTemplateError &&
              error.code === "RECEIPT_TEMPLATE_UNAVAILABLE" &&
              !sourceFailure &&
              qualified.length
            ) {
              try {
                resolveDigitalReceiptTemplate({
                  brandReference: fixed.brandReference,
                  storeReference: fixed.storeReference,
                  templateReference: template,
                  locale,
                  observedAt: at,
                  versions: qualified,
                });
              } catch (selection) {
                if (
                  selection instanceof DigitalReceiptTemplateError &&
                  selection.code === "RECEIPT_TEMPLATE_UNAVAILABLE"
                )
                  return fail("RECEIPT_TEMPLATE_CONFLICT");
              }
            }
            throw error;
          }
        };
        // Register before child provenance readers. Final async rereads use only immutable
        // packets whose own independent source guards have already been registered.
        host.registerBeforeCommit(
          tx,
          async () => {
            try {
              phase = "Checking";
              await fresh();
              const v = await read();
              currentScope();
              if (!baseline || canonicalizeRfc8785(v) !== canonicalizeRfc8785(baseline))
                return fail("RECEIPT_TEMPLATE_CONFLICT");
              await fresh();
              currentScope();
            } catch (error) {
              poisoned = true;
              throw error;
            }
          },
          () => {
            currentScope();
            if (phase !== "Checking" || !baseline) return fail();
            phase = "Final";
            finalDone = true;
            currentScope();
          },
        );
        const baseline = await read();
        await fresh();
        currentScope();
        finalized = () => {
          currentScope();
          if (!finalDone || phase !== "Final") return fail();
          for (const owner of owners) {
            const d = owner.assertFinalized(tx);
            currentScope();
            if (d < deadline) deadline = d;
          }
          currentScope();
          return deadline;
        };
        return parseDigitalReceiptTemplatePublishedCurrent({
          profile: "DigitalReceiptTemplatePublishedCurrentV1",
          ...fixed,
          templateReference: template,
          locale,
          currentVersion: baseline,
          observedAt: check(),
          validUntil: deadline,
          professionalReviewStatus: "NotEvaluated",
          legalConclusion: "NotEvaluated",
        });
      });
      if (!finalized) return fail();
      const until = finalized();
      return parseDigitalReceiptTemplatePublishedCurrent({ ...result, validUntil: until });
    },
  });
}
