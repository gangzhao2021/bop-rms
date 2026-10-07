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
  createPostgresStoreSetupDraftStore,
  createPostgresStoreConfigurationAuthoringSource,
  parseStoreAdministrationReference,
  parseStoreSetupCurrent,
  parseStoreSetupDraftContent,
  storeSetupDraftOperationFields,
  StoreSetupOperationError,
  type StoreSetupDraftStoreOptions,
} from "@rms/store";
import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import {
  createMerchantStoreFeeContextClassifications,
  merchantStoreFeeContextChoicesIntent,
} from "./merchant-store-fee-context-classifications.js";
import { parseTaxConfigClassificationChoices } from "./merchant-tax-config-workbench-values.js";
import { bindMerchantStoreSetupCommand } from "./merchant-store-setup-command.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/** Ordinary partial Setup; complete configuration and publication remain separate owning workflows. */
export function createMerchantStoreSetup(options: {
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
    code: StoreSetupOperationError["code"] = "STORE_SETUP_OPERATION_DEPENDENCY_UNAVAILABLE",
  ): never => {
    throw new StoreSetupOperationError(code);
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
    },
    write: boolean,
    classifications = false,
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
          actorReference: parseStoreAdministrationReference(scope.actorReference),
        });
        const action =
          input.command && typeof input.command === "object"
            ? Object.getOwnPropertyDescriptor(input.command, "command")
            : undefined;
        if (!action?.enumerable || !("value" in action))
          return fail("STORE_SETUP_OPERATION_INPUT_INVALID");
        const body = readClosedRecord(input.command, [
          "command",
          "operationReference",
          "expectedSetupReference",
          "expectedRevision",
          action.value === "SaveDraft" ? "content" : "intentDigest",
        ]);
        originalBody = Object.freeze({
          ...body,
          ...(action.value === "SaveDraft"
            ? { content: parseStoreSetupDraftContent(body.content) }
            : {}),
        });
      } catch {
        return fail("STORE_SETUP_OPERATION_INPUT_INVALID");
      }
    }
    const expectedStore = (() => {
      if (write) return undefined;
      try {
        return parseStoreReference(input.expectedStoreReference);
      } catch {
        return fail("STORE_SETUP_OPERATION_INPUT_INVALID");
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
              return fail("STORE_SETUP_OPERATION_PERMISSION_DENIED");
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
          return fail("STORE_SETUP_OPERATION_PERMISSION_DENIED");
        throw error;
      };
      const scope = await resolveScope(
        tx,
        sessionCookie,
        "organization.manage",
        authenticated?.sessionReference,
      ).catch(deniedScope);
      check();
      const fixed = Object.freeze({
        tenantReference: scope.selected.tenantReference,
        brandReference: scope.context.brand.brandReference,
        storeReference: scope.store.storeReference,
        actorReference: String(scope.actorReference),
      });
      if (
        write &&
        (!expectedScope ||
          Object.entries(fixed).some(
            ([key, value]) => Object.getOwnPropertyDescriptor(expectedScope, key)?.value !== value,
          ))
      )
        return fail("STORE_SETUP_OPERATION_PERMISSION_DENIED");
      if (expectedStore !== undefined && expectedStore !== fixed.storeReference)
        fail("STORE_SETUP_OPERATION_PERMISSION_DENIED");
      const allowedPort = scope.allowed,
        leasePort = scope.authorizationValidUntil;
      const selectedStore = scope.store,
        sessionReference = scope.sessionReference;
      const bound = write ? bindMerchantStoreSetupCommand(originalBody, fixed) : undefined;
      const command = bound?.command ?? null;
      const fresh = async () => {
        check();
        if (
          tx.query !== query ||
          scope.allowed !== allowedPort ||
          scope.authorizationValidUntil !== leasePort ||
          scope.store !== selectedStore ||
          scope.sessionReference !== sessionReference ||
          scope.selected.tenantReference !== fixed.tenantReference ||
          scope.context.brand.brandReference !== fixed.brandReference ||
          String(scope.actorReference) !== fixed.actorReference ||
          scope.store.storeReference !== fixed.storeReference ||
          !(await allowedPort.call(scope).catch(deniedScope))
        )
          fail("STORE_SETUP_OPERATION_PERMISSION_DENIED");
        if (
          scope.allowed !== allowedPort ||
          scope.authorizationValidUntil !== leasePort ||
          tx.query !== query
        )
          return fail();
        const until = leasePort.call(scope);
        if (until === null) return fail();
        if (until !== null && until < deadline) deadline = parseCanonicalInstant(until);
        check();
      };
      await fresh();
      let registry: ReturnType<typeof createMerchantStoreFeeContextClassifications> | undefined;
      const registrySource = () => {
        if (registry) return registry;
        registry = createMerchantStoreFeeContextClassifications({
          persistence,
          transaction: tx,
          sessionCookie,
          sessionReference,
          scope: fixed,
          originalObservedAt: origin,
          check,
          deadline: () => deadline,
          tighten: (until) => {
            const parsed = parseCanonicalInstant(until);
            if (parsed < deadline) deadline = parsed;
            check();
          },
          fresh,
          registerBeforeCommit: async (actual, guard, final) => {
            if (actual !== tx) return fail();
            await host.registerBeforeCommit(tx, guard, final);
          },
        });
        return registry;
      };
      if (classifications) {
        const source = registrySource();
        finalized = () => {
          const until = source.assertFinalized();
          check();
          return until < deadline ? until : deadline;
        };
        return source.read(merchantStoreFeeContextChoicesIntent(fixed));
      }
      const storeOptions: StoreSetupDraftStoreOptions = {
        ...fixed,
        transaction: tx,
        clock: { now: check },
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
            const value = parseStoreAdministrationReference(nextPort.call(options));
            check();
            return value;
          },
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
              packet.permission !== "organization.manage" ||
              packet.purposeCode !== "STORE_SETUP_DRAFT" ||
              packet.mode !== (bound ? (bound.method === "save" ? "Save" : "Resolve") : "Read") ||
              canonicalizeRfc8785(packet.requiredFields) !==
                canonicalizeRfc8785(storeSetupDraftOperationFields) ||
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
            packet.purposeCode !== "STORE_SETUP_DRAFT" ||
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
                  ? "STORE_SETUP_DRAFT_SAVED"
                  : "STORE_SETUP_ORIGINAL_ABANDONED",
              targetType: "StoreSetupDraft",
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
        async withCurrentSaveScope(actual, packet, work) {
          readClosedRecord(packet, [
            "tenantReference",
            "brandReference",
            "storeReference",
            "actorReference",
            "observedAt",
            "validUntil",
          ]);
          if (
            actual !== tx ||
            packet.observedAt < origin ||
            packet.observedAt > check() ||
            packet.validUntil > deadline ||
            !bound ||
            bound.method !== "save" ||
            Object.entries(fixed).some(
              ([key, value]) => Object.getOwnPropertyDescriptor(packet, key)?.value !== value,
            )
          )
            return fail();
          await fresh();
          const feeContexts = bound.command.content.feeContexts;
          if (feeContexts?.state === "Configured") {
            const enabled = feeContexts.value.filter((entry) => entry.state === "Enabled");
            if (enabled.length) {
              const choices = await registrySource().read(
                "sha256:" + sha256Hex(canonicalizeRfc8785(bound.command)),
              );
              for (const entry of enabled) {
                if (
                  entry.state === "Enabled" &&
                  !choices.choices.some(
                    (choice) =>
                      choice.classificationReference === entry.taxClassificationReference &&
                      choice.lifecycle === "Active",
                  )
                )
                  return fail("STORE_SETUP_OPERATION_INPUT_INVALID");
              }
            }
          }
          const readBase = createPostgresStoreConfigurationAuthoringSource({
            brandReference: fixed.brandReference,
            storeReference: fixed.storeReference,
            authorize: async (actualTx) => {
              if (actualTx !== tx) return fail();
              await fresh();
              return true;
            },
          });
          const base = await readBase(tx, check());
          const baseReference = base?.configurationReference ?? null;
          let guarded = false;
          await host.registerBeforeCommit(
            tx,
            async () => {
              if (guarded) return fail();
              const current = await readBase(tx, check());
              if ((current?.configurationReference ?? null) !== baseReference)
                return fail("STORE_SETUP_OPERATION_VERSION_CONFLICT");
              guarded = true;
            },
            () => {
              if (!guarded) return fail();
              check();
            },
          );
          const value = await work(
            Object.freeze({
              ...fixed,
              defaultLocale: scope.store.locale,
              currencyCode: scope.store.currencyCode,
              baseConfigurationReference: baseReference,
            }),
          );
          check();
          return value;
        },
      };
      const owner = createPostgresStoreSetupDraftStore(storeOptions);
      finalized = () => {
        const until = owner.assertFinalized(tx);
        registry?.assertFinalized();
        check();
        return until < deadline ? until : deadline;
      };
      if (bound)
        return bound.method === "save" ? owner.save(bound.command) : owner.resolve(bound.command);
      const setup = await owner.readCurrent();
      return Object.freeze({
        profile: "StoreSetupWorkspaceV1" as const,
        scope: fixed,
        store: Object.freeze({
          storeReference: scope.store.storeReference,
          code: scope.store.code,
          displayName: scope.store.displayName,
          locale: scope.store.locale,
          currencyCode: scope.store.currencyCode,
          timeZone: scope.store.timeZone,
          version: scope.store.version,
        }),
        setup,
      });
    });
    if (!finalized) return fail();
    const until = finalized();
    if (result.profile === "TaxConfigClassificationChoicesV1")
      return parseTaxConfigClassificationChoices({ ...result, validUntil: until });
    if ("setup" in result)
      return Object.freeze({
        ...result,
        setup: parseStoreSetupCurrent({ ...result.setup, validUntil: until }),
      });
    return result;
  }
  return Object.freeze({
    async classifications(input: { sessionCookie: unknown; expectedStoreReference: unknown }) {
      const value = await execute(input, false, true);
      if (value.profile !== "TaxConfigClassificationChoicesV1") return fail();
      return value;
    },
    async read(input: { sessionCookie: unknown; expectedStoreReference: unknown }) {
      const value = await execute(input, false);
      if (!("setup" in value)) return fail();
      return value;
    },
    async write(input: {
      sessionCookie: unknown;
      csrf: unknown;
      command: unknown;
      expectedScope: unknown;
    }) {
      const value = await execute(input, true);
      if ("setup" in value || value.profile === "TaxConfigClassificationChoicesV1") return fail();
      return value;
    },
  });
}
