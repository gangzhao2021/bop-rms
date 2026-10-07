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
  createPostgresStoreSetupReferenceStore,
  parseStoreAdministrationReference,
  parseStoreSetupReferencesCurrent,
  parseStoreSetupReferenceContent,
  type StoreSetupReferenceKind,
  storeSetupReferenceOperationRequiredFields,
  StoreSetupReferenceError,
  type StoreSetupReferenceStoreOptions,
} from "@rms/store";
import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { bindMerchantStoreSetupReferenceCommand } from "./merchant-store-setup-reference-command.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/** Ordinary Store-owned address/contact configuration; complete Setup and publication remain separate. */
export function createMerchantStoreSetupReferences(options: {
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
    code: StoreSetupReferenceError["code"] = "STORE_SETUP_REFERENCE_DEPENDENCY_UNAVAILABLE",
  ): never => {
    throw new StoreSetupReferenceError(code);
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
      kind?: unknown;
    },
    write: boolean,
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
    let kind: StoreSetupReferenceKind | undefined;
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
        if (input.kind !== "Address" && input.kind !== "Contact")
          return fail("STORE_SETUP_REFERENCE_INPUT_INVALID");
        kind = input.kind;
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
          return fail("STORE_SETUP_REFERENCE_INPUT_INVALID");
        const body = readClosedRecord(input.command, [
          "command",
          "operationReference",
          "expectedReference",
          "expectedRevision",
          action.value === "SaveReference" ? "content" : "intentDigest",
        ]);
        originalBody = Object.freeze({
          ...body,
          ...(action.value === "SaveReference"
            ? { content: parseStoreSetupReferenceContent(kind, body.content) }
            : {}),
        });
      } catch {
        return fail("STORE_SETUP_REFERENCE_INPUT_INVALID");
      }
    }
    const expectedStore = (() => {
      if (write) return undefined;
      try {
        return parseStoreReference(input.expectedStoreReference);
      } catch {
        return fail("STORE_SETUP_REFERENCE_INPUT_INVALID");
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
              return fail("STORE_SETUP_REFERENCE_PERMISSION_DENIED");
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
          return fail("STORE_SETUP_REFERENCE_PERMISSION_DENIED");
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
        return fail("STORE_SETUP_REFERENCE_PERMISSION_DENIED");
      if (expectedStore !== undefined && expectedStore !== fixed.storeReference)
        fail("STORE_SETUP_REFERENCE_PERMISSION_DENIED");
      const allowedPort = scope.allowed,
        leasePort = scope.authorizationValidUntil;
      const selectedStore = scope.store,
        sessionReference = scope.sessionReference;
      const bound =
        write && kind
          ? bindMerchantStoreSetupReferenceCommand(originalBody, fixed, kind)
          : undefined;
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
          fail("STORE_SETUP_REFERENCE_PERMISSION_DENIED");
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
      const storeOptions: StoreSetupReferenceStoreOptions = {
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
              "kind",
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
              packet.purposeCode !== "STORE_SETUP_REFERENCE" ||
              packet.mode !==
                (bound ? (bound.method === "save" ? "Save" : "Resolve") : "ReadAll") ||
              packet.kind !== (bound?.command.kind ?? null) ||
              canonicalizeRfc8785(packet.requiredFields) !==
                canonicalizeRfc8785(storeSetupReferenceOperationRequiredFields) ||
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
            "kind",
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
            packet.kind !== bound.command.kind ||
            Object.entries(fixed).some(
              ([key, value]) => Object.getOwnPropertyDescriptor(packet, key)?.value !== value,
            ) ||
            packet.purposeCode !== "STORE_SETUP_REFERENCE" ||
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
                  ? "STORE_SETUP_REFERENCE_SAVED"
                  : "STORE_SETUP_REFERENCE_ORIGINAL_ABANDONED",
              targetType: "StoreSetupReference",
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
      const owner = createPostgresStoreSetupReferenceStore(storeOptions);
      finalized = () => {
        const until = owner.assertFinalized(tx);
        check();
        return until < deadline ? until : deadline;
      };
      if (bound)
        return bound.method === "save" ? owner.save(bound.command) : owner.resolve(bound.command);
      return owner.readCurrent();
    });
    if (!finalized) return fail();
    const until = finalized();
    if ("address" in result)
      return parseStoreSetupReferencesCurrent({ ...result, validUntil: until });
    return result;
  }
  return Object.freeze({
    async read(input: { sessionCookie: unknown; expectedStoreReference: unknown }) {
      const value = await execute(input, false);
      if (!("address" in value)) return fail();
      return value;
    },
    async write(input: {
      sessionCookie: unknown;
      csrf: unknown;
      command: unknown;
      expectedScope: unknown;
      kind: unknown;
    }) {
      const value = await execute(input, true);
      if ("address" in value) return fail();
      return value;
    },
  });
}
