import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
} from "@bop/audit";
import {
  parseCanonicalInstant,
  parseStoreReference,
  parseBrandReference,
  parsePlatformTenantReference,
} from "@bop/tenant";
import {
  createPostgresDigitalReceiptTemplateDraftStore,
  createPostgresDigitalReceiptTemplateArtifactStore,
  createPostgresDigitalReceiptTemplateStore,
  parseDeviceReference,
  parseDigitalReceiptTemplateDraftCurrent,
  parseDigitalReceiptTemplateDraftRoster,
  parseDigitalReceiptTemplateDraftFields,
  type DigitalReceiptTemplateDraftStoreOptions,
  digitalReceiptTemplateArtifactRequiredFields,
  digitalReceiptTemplateDraftRequiredFields,
  DigitalReceiptTemplateError,
} from "@rms/printing-device";
import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { bindMerchantReceiptTemplateDraftCommand } from "./merchant-receipt-template-draft-command.js";
import { createMerchantReceiptTemplateEditingReview } from "./merchant-receipt-template-editing-review.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/** Ordinary Device-owned immutable template draft. Submission, professional review and publication remain separate. */
export function createMerchantReceiptTemplateDraft(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  nextReference(): string;
}) {
  const persistence = options.persistence,
    authentication = options.authentication;
  const nowPort = persistence.now,
    runner = persistence.transactions,
    runPort = runner.run;
  const authorizePort = authentication.authorize,
    nextPort = options.nextReference;
  const identity = persistence.identity,
    hasher = identity.hasher;
  const currentActor = persistence.currentActor,
    association = persistence.validateAssociation;
  const host = createMerchantCategoryTransactions(runner);
  const resolveScope = createMerchantStoreScope(persistence);
  const fail = (
    code: DigitalReceiptTemplateError["code"] = "RECEIPT_TEMPLATE_UNAVAILABLE",
  ): never => {
    throw new DigitalReceiptTemplateError(code);
  };
  if (
    [nowPort, runPort, authorizePort, nextPort, currentActor, association].some(
      (p) => typeof p !== "function",
    )
  )
    fail();
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
      persistence.validateAssociation !== association
    )
      fail();
  };
  async function execute(
    input: {
      sessionCookie: unknown;
      csrf?: unknown;
      command?: unknown;
      expectedStoreReference?: unknown;
      expectedScope?: unknown;
      templateReference?: unknown;
      afterTemplate?: unknown;
    },
    write: boolean,
    listing = false,
  ) {
    capture();
    const origin = parseCanonicalInstant(nowPort.call(persistence));
    let deadline: string = new Date(Date.parse(origin) + 5000).toISOString(),
      latest: string = origin;
    const check = () => {
      capture();
      const at = parseCanonicalInstant(nowPort.call(persistence));
      if (at < latest || at >= deadline) fail();
      latest = at;
      return at;
    };
    const sessionCookie = input.sessionCookie;
    let originalBody: unknown;
    let selectedTemplate: string | null = null;
    let afterTemplate: string | null = null;
    let expectedScope:
      | Readonly<{
          tenantReference: string;
          brandReference: string;
          storeReference: string;
          actorReference: string;
        }>
      | undefined;
    if (write) {
      try {
        const scope = readClosedRecord(input.expectedScope, [
          "tenantReference",
          "brandReference",
          "storeReference",
          "actorReference",
        ]);
        expectedScope = Object.freeze({
          tenantReference: parsePlatformTenantReference(scope.tenantReference),
          brandReference: parseBrandReference(scope.brandReference),
          storeReference: parseStoreReference(scope.storeReference),
          actorReference: parseDeviceReference(scope.actorReference),
        });
        const action =
          input.command && typeof input.command === "object"
            ? Object.getOwnPropertyDescriptor(input.command, "command")
            : undefined;
        if (!action?.enumerable || !("value" in action))
          return fail("RECEIPT_TEMPLATE_INPUT_INVALID");
        const body = readClosedRecord(input.command, [
          "command",
          "operationReference",
          "templateReference",
          "expectedVersionReference",
          "expectedRevision",
          action.value === "SaveDraft" ? "fields" : "intentDigest",
        ]);
        originalBody = Object.freeze({
          ...body,
          ...(action.value === "SaveDraft"
            ? { fields: parseDigitalReceiptTemplateDraftFields(body.fields) }
            : {}),
        });
      } catch {
        return fail("RECEIPT_TEMPLATE_INPUT_INVALID");
      }
    }
    const expectedStore = (() => {
      if (write) return undefined;
      try {
        const descriptor = Object.getOwnPropertyDescriptor(
          input,
          listing ? "afterTemplate" : "templateReference",
        );
        if (!descriptor?.enumerable || !("value" in descriptor))
          return fail("RECEIPT_TEMPLATE_INPUT_INVALID");
        const reference = descriptor.value === null ? null : parseDeviceReference(descriptor.value);
        if (listing) afterTemplate = reference;
        else selectedTemplate = reference;
        return parseStoreReference(input.expectedStoreReference);
      } catch {
        return fail("RECEIPT_TEMPLATE_INPUT_INVALID");
      }
    })();
    const authenticated = write
      ? await authorizePort
          .call(authentication, { sessionCookie, csrf: input.csrf })
          .catch((error: unknown): never => {
            if (
              error instanceof BrowserSessionError &&
              (error.code === "BROWSER_SESSION_DENIED" ||
                (error.code === "BROWSER_SESSION_INPUT_INVALID" &&
                  (typeof sessionCookie !== "string" ||
                    !/^[A-Za-z0-9_-]{43}$/u.test(sessionCookie) ||
                    typeof input.csrf !== "string" ||
                    !/^[A-Za-z0-9_-]{43}$/u.test(input.csrf))))
            )
              return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
            return fail();
          })
      : undefined;
    check();
    let finalized: (() => string) | undefined;
    const result = await host.transactions.run(async (tx) => {
      const query = tx.query;
      const deniedScope = (error: unknown): never => {
        if (
          (error instanceof Error && error.message === "STORE_SERVICE_PERMISSION_DENIED") ||
          (error instanceof BrowserSessionError &&
            (error.code === "BROWSER_SESSION_DENIED" ||
              (error.code === "BROWSER_SESSION_INPUT_INVALID" &&
                (typeof sessionCookie !== "string" ||
                  !/^[A-Za-z0-9_-]{43}$/u.test(sessionCookie)))))
        )
          return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
        throw error;
      };
      const scope = await resolveScope(
        tx,
        sessionCookie,
        "organization.manage",
        authenticated?.sessionReference,
      ).catch(deniedScope);
      check();
      const editingScope = write
        ? await resolveScope(tx, sessionCookie, "integration.manage", scope.sessionReference).catch(
            deniedScope,
          )
        : undefined;
      check();
      const editingAllowed = editingScope?.allowed,
        editingLease = editingScope?.authorizationValidUntil;
      const editingStore = editingScope?.store,
        editingSession = editingScope?.sessionReference,
        editingContext = editingScope?.context,
        editingSelection = editingScope?.selected,
        editingBrand = editingScope?.context.brand;
      const fixed = Object.freeze({
        tenantReference: parseDeviceReference(scope.selected.tenantReference),
        brandReference: parseDeviceReference(scope.context.brand.brandReference),
        storeReference: parseDeviceReference(scope.store.storeReference),
        actorReference: parseDeviceReference(scope.actorReference),
      });
      if (
        write &&
        (!expectedScope ||
          Object.entries(fixed).some(
            ([key, value]) => Object.getOwnPropertyDescriptor(expectedScope, key)?.value !== value,
          ))
      )
        return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
      if (expectedStore !== undefined && String(expectedStore) !== String(fixed.storeReference))
        fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
      const allowedPort = scope.allowed,
        leasePort = scope.authorizationValidUntil;
      const selectedStore = scope.store,
        sessionReference = scope.sessionReference,
        context = scope.context,
        selection = scope.selected,
        brand = scope.context.brand;
      const bound = write
        ? bindMerchantReceiptTemplateDraftCommand(originalBody, fixed)
        : undefined;
      const command = bound?.command ?? null;
      const stable = () => {
        const at = check();
        if (
          tx.query !== query ||
          scope.allowed !== allowedPort ||
          scope.authorizationValidUntil !== leasePort ||
          scope.store !== selectedStore ||
          scope.sessionReference !== sessionReference ||
          scope.context !== context ||
          scope.selected !== selection ||
          context.brand !== brand ||
          String(selection.tenantReference) !== String(fixed.tenantReference) ||
          String(brand.brandReference) !== String(fixed.brandReference) ||
          String(scope.actorReference) !== String(fixed.actorReference) ||
          String(selectedStore.storeReference) !== String(fixed.storeReference)
        )
          return fail();
        if (
          editingScope &&
          (editingScope.allowed !== editingAllowed ||
            editingScope.authorizationValidUntil !== editingLease ||
            editingScope.store !== editingStore ||
            editingScope.sessionReference !== editingSession ||
            editingScope.context !== editingContext ||
            editingScope.selected !== editingSelection ||
            editingScope.context.brand !== editingBrand ||
            editingSession !== sessionReference ||
            String(editingScope.selected.tenantReference) !== String(fixed.tenantReference) ||
            String(editingScope.context.brand.brandReference) !== String(fixed.brandReference) ||
            String(editingScope.store.storeReference) !== String(fixed.storeReference) ||
            String(editingScope.actorReference) !== String(fixed.actorReference))
        )
          return fail();
        return at;
      };
      const fresh = async () => {
        stable();
        if (editingScope) {
          if (!editingAllowed || !editingLease) return fail();
          if (!(await editingAllowed.call(editingScope).catch(deniedScope)))
            return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
          stable();
          const until = editingLease.call(editingScope);
          stable();
          if (until === null) return fail();
          if (until < deadline) deadline = parseCanonicalInstant(until);
          stable();
        }
        if (!(await allowedPort.call(scope).catch(deniedScope)))
          return fail("RECEIPT_TEMPLATE_PERMISSION_DENIED");
        stable();
        const until = leasePort.call(scope);
        stable();
        if (until === null) return fail();
        if (until < deadline) deadline = parseCanonicalInstant(until);
        stable();
      };
      await fresh();
      const artifactOwners = new Map<
        string,
        ReturnType<typeof createPostgresDigitalReceiptTemplateArtifactStore>
      >();
      let editingReview: ReturnType<typeof createMerchantReceiptTemplateEditingReview> | undefined;
      const storeOptions: DigitalReceiptTemplateDraftStoreOptions = {
        ...fixed,
        transaction: tx,
        clock: { now: stable },
        originalObservedAt: origin,
        originalValidUntil: deadline,
        registerBeforeCommit(actual, guard, final) {
          if (actual !== tx) return fail();
          return host.registerBeforeCommit(tx, guard, final);
        },
        references: {
          canonicalize: canonicalizeRfc8785,
          hashIntent: (value) => "sha256:" + sha256Hex(value),
          nextReference: () => {
            check();
            const value = parseDeviceReference(nextPort.call(options));
            check();
            return value;
          },
        },
        async readEditingReview(actual, request) {
          readClosedRecord(request, [
            "templateReference",
            "familyReference",
            "observedAt",
            "validUntil",
          ]);
          if (
            actual !== tx ||
            !bound ||
            bound.method !== "save" ||
            request.templateReference !== bound.command.templateReference ||
            request.observedAt < origin ||
            request.observedAt > check() ||
            request.validUntil > deadline
          )
            return fail();
          await fresh();
          if (!editingReview) {
            editingReview = createMerchantReceiptTemplateEditingReview({
              ...fixed,
              transaction: tx,
              clock: { now: stable },
              originalObservedAt: origin,
              originalValidUntil: deadline,
              references: {
                canonicalize: canonicalizeRfc8785,
                hashIntent: (value) => "sha256:" + sha256Hex(value),
              },
              registerBeforeCommit(actualTx, guard, final) {
                if (actualTx !== tx) return fail();
                return host.registerBeforeCommit(tx, guard, final);
              },
              async holdCurrentOrgAuthority(actualTx, packet) {
                readClosedRecord(packet, [
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
                  actualTx !== tx ||
                  Object.entries(fixed).some(
                    ([key, value]) => Object.getOwnPropertyDescriptor(packet, key)?.value !== value,
                  ) ||
                  packet.templateReference !== request.templateReference ||
                  packet.familyReference !== request.familyReference ||
                  packet.observedAt < origin ||
                  packet.observedAt > check() ||
                  packet.validUntil > deadline
                )
                  return fail();
                await fresh();
                return Object.freeze({
                  validUntil: packet.validUntil < deadline ? packet.validUntil : deadline,
                });
              },
            });
          }
          const result = await editingReview.read(tx, request);
          await fresh();
          return result;
        },
        async readPublicationSequence(actual, request) {
          if (
            actual !== tx ||
            request.observedAt < origin ||
            request.observedAt > check() ||
            request.validUntil > deadline
          )
            return fail();
          await fresh();
          const published = createPostgresDigitalReceiptTemplateStore({
            brandReference: fixed.brandReference,
            storeReference: fixed.storeReference,
            async authorize(actualTx, subject) {
              if (
                actualTx !== tx ||
                subject.action !== "Read" ||
                subject.brandReference !== fixed.brandReference ||
                subject.storeReference !== fixed.storeReference ||
                subject.templateReference !== request.templateReference
              )
                return fail();
              await fresh();
              return true;
            },
            validatePublication: async () => fail(),
            isCurrentPublication: async () => fail(),
          });
          const value = await published.readPublicationSequence(tx, {
            templateReference: request.templateReference,
          });
          await fresh();
          return value;
        },
        async readArtifact(actual, request) {
          if (
            actual !== tx ||
            request.observedAt < origin ||
            request.observedAt > check() ||
            request.validUntil > deadline
          )
            return fail();
          await fresh();
          const key = request.artifactKind + ":" + request.artifactReference;
          let artifact = artifactOwners.get(key);
          if (!artifact) {
            artifact = createPostgresDigitalReceiptTemplateArtifactStore({
              ...fixed,
              transaction: tx,
              clock: { now: stable },
              originalObservedAt: origin,
              originalValidUntil: deadline,
              registerBeforeCommit(actualTx, guard, final) {
                if (actualTx !== tx) return fail();
                return host.registerBeforeCommit(tx, guard, final);
              },
              references: {
                canonicalize: canonicalizeRfc8785,
                hashIntent: (value) => "sha256:" + sha256Hex(value),
                nextReference: () => fail(),
              },
              appendAudit: async () => fail(),
              authority: {
                async holdUntilTransactionCompletes(actualTx, packet) {
                  readClosedRecord(packet, [
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
                    actualTx !== tx ||
                    Object.entries(fixed).some(
                      ([key, value]) =>
                        Object.getOwnPropertyDescriptor(packet, key)?.value !== value,
                    ) ||
                    packet.permission !== "organization.manage" ||
                    packet.purposeCode !== "RECEIPT_TEMPLATE_ARTIFACT" ||
                    packet.mode !== "ReadVersion" ||
                    packet.artifactKind !== request.artifactKind ||
                    packet.targetArtifactReference !== request.artifactReference ||
                    packet.command !== null ||
                    canonicalizeRfc8785(packet.requiredFields) !==
                      canonicalizeRfc8785(digitalReceiptTemplateArtifactRequiredFields) ||
                    packet.observedAt < origin ||
                    packet.observedAt > check() ||
                    packet.validUntil > deadline
                  )
                    return fail();
                  await fresh();
                  return Object.freeze({ validUntil: deadline });
                },
              },
            });
            artifactOwners.set(key, artifact);
          }
          const value = await artifact.readVersion({
            artifactKind: request.artifactKind,
            artifactReference: request.artifactReference,
          });
          await fresh();
          return value;
        },
        authority: {
          async holdUntilTransactionCompletes(actual, packet) {
            readClosedRecord(packet, [
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
              Object.entries(fixed).some(
                ([key, value]) => Object.getOwnPropertyDescriptor(packet, key)?.value !== value,
              ) ||
              packet.permission !== (write ? "integration.manage" : "organization.manage") ||
              packet.purposeCode !== "RECEIPT_TEMPLATE_AUTHORING" ||
              packet.mode !==
                (bound
                  ? bound.method === "save"
                    ? "Save"
                    : "Resolve"
                  : listing
                    ? "ReadRoster"
                    : "ReadCurrent") ||
              packet.templateReference !==
                (bound ? bound.command.templateReference : selectedTemplate) ||
              packet.targetVersionReference !== null ||
              canonicalizeRfc8785(packet.requiredFields) !==
                canonicalizeRfc8785(digitalReceiptTemplateDraftRequiredFields) ||
              canonicalizeRfc8785(packet.command) !== canonicalizeRfc8785(command) ||
              packet.observedAt < origin ||
              packet.observedAt > check() ||
              packet.validUntil > deadline
            )
              return fail();
            await fresh();
            return Object.freeze({ validUntil: deadline });
          },
        },
        async appendAudit(actual, packet) {
          readClosedRecord(packet, [
            "tenantReference",
            "brandReference",
            "storeReference",
            "actorReference",
            "auditReference",
            "operationReference",
            "intentDigest",
            "purposeCode",
            "mode",
            "occurredAt",
          ]);
          if (
            actual !== tx ||
            !bound ||
            packet.intentDigest !==
              (bound.method === "save"
                ? "sha256:" + sha256Hex(canonicalizeRfc8785(bound.command))
                : bound.command.intentDigest) ||
            packet.operationReference !== bound.command.operationReference ||
            Object.entries(fixed).some(
              ([key, value]) => Object.getOwnPropertyDescriptor(packet, key)?.value !== value,
            ) ||
            packet.purposeCode !== "RECEIPT_TEMPLATE_AUTHORING" ||
            packet.mode !== (bound.method === "save" ? "Save" : "Abandon") ||
            packet.occurredAt < origin ||
            packet.occurredAt > check()
          )
            return fail();
          const audit = validateAuditRecord(
            {
              auditId: packet.auditReference,
              brandId: fixed.brandReference,
              storeId: fixed.storeReference,
              actor: { type: "User", reference: fixed.actorReference },
              actionCode:
                packet.mode === "Save"
                  ? "RECEIPT_TEMPLATE_DRAFT_SAVED"
                  : "RECEIPT_TEMPLATE_DRAFT_ORIGINAL_ABANDONED",
              targetType: "DigitalReceiptTemplateDraft",
              targetId: packet.operationReference,
              afterSummary: { intentDigest: packet.intentDigest },
              reasonCode: "AUTHORIZED_OPERATION",
              correlationId: packet.operationReference,
              occurredAt: packet.occurredAt,
              sourceChannel: "API",
              dataClassification: "Internal",
              retentionPolicyCode: "OPERATIONAL",
              retentionPolicyVersion: 1,
            },
            Date.parse(check()),
          );
          await appendAuditRecordInTransaction(tx, audit);
          check();
        },
      };
      const owner = createPostgresDigitalReceiptTemplateDraftStore(storeOptions);
      finalized = () => {
        stable();
        let until = owner.assertFinalized(tx);
        stable();
        for (const artifact of artifactOwners.values()) {
          stable();
          const held = artifact.assertFinalized(tx);
          stable();
          if (held < until) until = held;
        }
        if (editingReview) {
          stable();
          const held = editingReview.assertFinalized(tx);
          stable();
          if (held < until) until = held;
        }
        stable();
        return until < deadline ? until : deadline;
      };
      if (bound)
        return bound.method === "save" ? owner.save(bound.command) : owner.resolve(bound.command);
      return listing
        ? owner.readRoster({ afterTemplate })
        : owner.readCurrent({ templateReference: selectedTemplate });
    });
    if (!finalized) return fail();
    const until = finalized();
    if (result.profile === "DigitalReceiptTemplateDraftRosterV1")
      return parseDigitalReceiptTemplateDraftRoster({ ...result, validUntil: until });
    if (result.profile === "DigitalReceiptTemplateDraftCurrentV1")
      return parseDigitalReceiptTemplateDraftCurrent({ ...result, validUntil: until });
    return result;
  }
  return Object.freeze({
    async list(input: {
      sessionCookie: unknown;
      expectedStoreReference: unknown;
      afterTemplate: unknown;
    }) {
      const value = await execute(input, false, true);
      if (value.profile !== "DigitalReceiptTemplateDraftRosterV1") return fail();
      return value;
    },
    async read(input: {
      sessionCookie: unknown;
      expectedStoreReference: unknown;
      templateReference: unknown;
    }) {
      const value = await execute(input, false);
      if (value.profile !== "DigitalReceiptTemplateDraftCurrentV1") return fail();
      return value;
    },
    async write(input: {
      sessionCookie: unknown;
      csrf: unknown;
      command: unknown;
      expectedScope: unknown;
    }) {
      const value = await execute(input, true);
      if (
        value.profile === "DigitalReceiptTemplateDraftCurrentV1" ||
        value.profile === "DigitalReceiptTemplateDraftRosterV1"
      )
        return fail();
      return value;
    },
  });
}
