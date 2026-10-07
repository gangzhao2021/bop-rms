import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  validateAuditRecord,
} from "@bop/audit";
import { BrowserSessionError, readClosedRecord, type AuthenticationSession } from "@bop/identity";
import {
  parseBrandReference,
  parseCanonicalInstant,
  type BrandConfigurationActorScope,
  parseBrandAdministrationContext,
} from "@bop/tenant";
import {
  CatalogError,
  brandCatalogSourceRequiredFields,
  createPostgresBrandAdministrationCatalogSourceStore,
  parseBrandCatalogSourceRegister,
  parseBrandCatalogSourceResolve,
  parseBrandCatalogSourceScope,
  parseCatalogReference,
  type BrandCatalogSourceCurrent,
  type BrandCatalogSourceExact,
  type BrandCatalogSourceReceipt,
} from "@rms/catalog";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import {
  createMerchantCurrentBrandAdministrationScope,
  type MerchantCurrentBrandAdministrationOptions,
} from "./merchant-current-brand-scope.js";
import {
  createMerchantCurrentBrandAdministrationCapability,
  merchantBrandAdministrationCapabilityRequiredFields,
} from "./merchant-brand-administration-capability.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

export interface MerchantBrandCatalogSourceOptions {
  readonly persistence: MerchantCurrentBrandAdministrationOptions &
    Pick<PersistentMerchantBffOptions, "transactions">;
  readonly authentication: {
    authorize(input: {
      readonly sessionCookie: unknown;
      readonly csrf: unknown;
    }): Promise<AuthenticationSession>;
  };
  readonly nextReference: (kind: "Source" | "Audit") => string;
}
const fail = (
  code: ConstructorParameters<typeof CatalogError>[0] = "CATALOG_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new CatalogError(code);
};
function sourceFailure(error: unknown): never {
  if (error instanceof CatalogError) throw error;
  if (
    error instanceof BrowserSessionError ||
    (error instanceof Error && error.message === "BRAND_SERVICE_PERMISSION_DENIED")
  )
    return fail("CATALOG_PERMISSION_DENIED");
  return fail();
}
function read(value: unknown, fields: readonly string[]) {
  try {
    return readClosedRecord(value, fields);
  } catch {
    return fail("CATALOG_INPUT_INVALID");
  }
}
const sameScope = (a: BrandConfigurationActorScope, b: BrandConfigurationActorScope) =>
  a.tenantReference === b.tenantReference &&
  a.brandReference === b.brandReference &&
  a.actorReference === b.actorReference;
type Owner = ReturnType<typeof createPostgresBrandAdministrationCatalogSourceStore>;
type Mode = "Current" | "Exact" | "Register" | "Resolve";

/** Ordinary noStore composition. A real Session, current Brand IAM and Feature
 * admit every operation; Catalog owns original arbitration, IDs and terminal history. */
export function createMerchantBrandCatalogSource(options: MerchantBrandCatalogSourceOptions) {
  const persistence = options.persistence,
    runner = persistence.transactions,
    runPort = runner.run,
    authentication = options.authentication,
    authorizePort = authentication.authorize,
    nowPort = persistence.now,
    actorPort = persistence.currentActor,
    identity = persistence.identity,
    hasher = identity.hasher,
    envelopes = identity.envelopes,
    configuration = identity.configuration,
    nextPort = options.nextReference;
  const host = createMerchantCategoryTransactions(runner),
    resolveScope = createMerchantCurrentBrandAdministrationScope(persistence);
  function capture() {
    if (
      options.persistence !== persistence ||
      persistence.transactions !== runner ||
      runner.run !== runPort ||
      options.authentication !== authentication ||
      authentication.authorize !== authorizePort ||
      persistence.now !== nowPort ||
      persistence.currentActor !== actorPort ||
      persistence.identity !== identity ||
      identity.hasher !== hasher ||
      identity.envelopes !== envelopes ||
      identity.configuration !== configuration ||
      options.nextReference !== nextPort
    )
      return fail();
  }
  async function perform<T>(
    mode: Mode,
    value: unknown,
    work: (
      owner: Owner,
      body: Record<string, unknown> | undefined,
      scope: BrandConfigurationActorScope,
      input: Record<string, unknown>,
    ) => Promise<T>,
  ): Promise<T> {
    capture();
    const input = read(value, [
      "sessionCookie",
      "csrf",
      "expectedBrandReference",
      ...(mode === "Exact"
        ? ["sourceReference"]
        : mode === "Register"
          ? ["command"]
          : mode === "Resolve"
            ? ["original"]
            : []),
    ]);
    const brand = (() => {
      try {
        return String(parseBrandReference(input.expectedBrandReference));
      } catch {
        return fail("CATALOG_INPUT_INVALID");
      }
    })();
    const body =
      mode === "Register"
        ? read(input.command, ["operationReference", "code", "label"])
        : mode === "Resolve"
          ? read(input.original, ["operationReference", "intentDigest"])
          : undefined;
    const observedAt = (() => {
      try {
        return parseCanonicalInstant(nowPort.call(persistence));
      } catch {
        return fail();
      }
    })();
    let latest = observedAt,
      deadline: string = new Date(Date.parse(observedAt) + 5000).toISOString(),
      failed = false;
    function check() {
      capture();
      const at = parseCanonicalInstant(nowPort.call(persistence));
      if (failed || at < latest || at >= deadline) return fail();
      latest = at;
      return at;
    }
    function tighten(value: string) {
      const until = parseCanonicalInstant(value);
      if (until < deadline) deadline = until;
      check();
    }
    let finalized: (() => void) | undefined;
    try {
      const session = await authorizePort.call(authentication, {
        sessionCookie: input.sessionCookie,
        csrf: input.csrf,
      });
      check();
      tighten(session.idleExpiresAt);
      tighten(session.absoluteExpiresAt);
      const result = await host.transactions.run(async (tx) => {
        const query = tx.query,
          current = await resolveScope(
            tx,
            input.sessionCookie,
            session.sessionReference,
            deadline,
          ).catch(sourceFailure),
          initialContext = parseBrandAdministrationContext(current.context),
          scope = Object.freeze({
            tenantReference: current.tenantReference,
            brandReference: String(initialContext.brand.brandReference),
            actorReference: String(current.actorReference),
          });
        if (
          scope.brandReference !== brand ||
          current.context.profile !== "BrandAdministrationContextV1" ||
          current.context.store !== null ||
          current.sessionReference !== session.sessionReference ||
          scope.actorReference !== session.actor.actorReference
        )
          return fail("CATALOG_PERMISSION_DENIED");
        const currentAuthorize = current.authorizeActionsWithValidity,
          currentAssert = current.assertCurrent;
        function assert() {
          check();
          if (
            tx.query !== query ||
            current.authorizeActionsWithValidity !== currentAuthorize ||
            current.assertCurrent !== currentAssert ||
            !sameScope(scope, {
              tenantReference: current.tenantReference,
              brandReference: String(current.context.brand.brandReference),
              actorReference: String(current.actorReference),
            })
          )
            return fail();
          try {
            currentAssert.call(current);
          } catch (error) {
            return sourceFailure(error);
          }
        }
        async function permissions(actions: readonly string[]) {
          assert();
          const packet = await currentAuthorize.call(current, actions).catch(sourceFailure);
          assert();
          const context = parseBrandAdministrationContext(packet.context);
          if (
            context.profile !== "BrandAdministrationContextV1" ||
            context.store !== null ||
            String(context.brand.brandReference) !== scope.brandReference ||
            String(context.actor.actorReference) !== scope.actorReference ||
            packet.decisions.length !== actions.length ||
            packet.decisions.some(
              (d, i) => d.action !== actions[i] || d.scopeKind !== "Brand" || d.effect !== "Allow",
            )
          )
            return fail("CATALOG_PERMISSION_DENIED");
          tighten(packet.validUntil);
          return { ...packet, context };
        }
        await permissions(["organization.manage"]);
        const capability = createMerchantCurrentBrandAdministrationCapability({
          transaction: tx,
          scope,
          clock: { now: check },
          originalObservedAt: observedAt,
          originalValidUntil: deadline,
          registerBeforeCommit: (actual, guard, final) => {
            if (actual !== tx) return fail();
            return host.registerBeforeCommit(tx, guard, final);
          },
          async holdCurrentBrandAdministrationAuthority(actual, request) {
            assert();
            if (
              actual !== tx ||
              !sameScope(request.scope, scope) ||
              request.permission !== "organization.manage" ||
              request.purposeCode !== "BRAND_ADMINISTRATION" ||
              canonicalizeRfc8785(request.requiredFields) !==
                canonicalizeRfc8785(merchantBrandAdministrationCapabilityRequiredFields) ||
              request.observedAt < observedAt ||
              request.observedAt > check() ||
              request.validUntil > deadline
            )
              return fail();
            const packet = await permissions(["organization.manage"]),
              permission = packet.decisions[0];
            if (!permission) return fail();
            return {
              scope,
              administrationContext: packet.context,
              permission,
              validUntil: deadline,
            };
          },
        });
        await capability.holdUntilCommit();
        tighten(capability.leaseDeadline());
        const owner = createPostgresBrandAdministrationCatalogSourceStore({
          ...parseBrandCatalogSourceScope(scope),
          transaction: tx,
          clock: { now: check },
          originalObservedAt: observedAt,
          originalValidUntil: deadline,
          registerBeforeCommit: (actual, guard, final) => {
            if (actual !== tx) return fail();
            return host.registerBeforeCommit(tx, guard, final);
          },
          nextReference: (kind) => {
            assert();
            const reference = nextPort.call(options, kind);
            assert();
            return reference;
          },
          authority: {
            async holdUntilTransactionCompletes(actual, request) {
              assert();
              if (
                actual !== tx ||
                !sameScope(request, scope) ||
                request.permission !== "organization.manage" ||
                request.purposeCode !== "BRAND_ADMINISTRATION" ||
                canonicalizeRfc8785(request.requiredFields) !==
                  canonicalizeRfc8785(brandCatalogSourceRequiredFields) ||
                request.observedAt < observedAt ||
                request.observedAt > check() ||
                request.validUntil > deadline
              )
                return fail();
              const packet = await permissions(["organization.manage"]);
              return { administrationContext: packet.context, validUntil: deadline };
            },
          },
          async appendAudit(actual, request) {
            assert();
            if (
              actual !== tx ||
              !sameScope(request, scope) ||
              request.purposeCode !== "BRAND_CATALOG_SOURCE"
            )
              return fail();
            const audit = validateAuditRecord(
              {
                auditId: request.auditReference,
                brandId: scope.brandReference,
                actor: { type: "User", reference: scope.actorReference },
                actionCode:
                  request.mode === "Abandon"
                    ? "BRAND_CATALOG_SOURCE_ABANDONED"
                    : "BRAND_CATALOG_SOURCE_REGISTERED",
                targetType: "BrandCatalogSourceOriginal",
                targetId: request.operationReference,
                correlationId: request.operationReference,
                reasonCode: "AUTHORIZED_OPERATION",
                occurredAt: request.occurredAt,
                afterSummary: {
                  intentDigest: request.intentDigest,
                  sourceReference: request.sourceReference,
                },
                sourceChannel: "API",
                dataClassification: "Internal",
                retentionPolicyCode: "OPERATIONAL",
                retentionPolicyVersion: 1,
              },
              Date.parse(check()),
            );
            await appendAuditRecordInTransaction(tx, audit);
            assert();
          },
        });
        const output = await work(owner, body, scope, input);
        assert();
        await host.registerBeforeCommit(
          tx,
          async () => {
            await permissions(["organization.manage"]);
          },
          assert,
        );
        finalized = () => {
          owner.assertFinalized();
          capability.assertFinalized();
        };
        return output;
      });
      if (!finalized) return fail();
      // The host already sealed the clock/authority before its true COMMIT.
      finalized();
      return result;
    } catch (error) {
      failed = true;
      return sourceFailure(error);
    }
  }
  return Object.freeze({
    current: (input: unknown): Promise<BrandCatalogSourceCurrent> =>
      perform("Current", input, (owner) => owner.current()),
    exact: (input: unknown): Promise<BrandCatalogSourceExact> =>
      perform("Exact", input, (owner, _body, _scope, raw) =>
        owner.exact(parseCatalogReference(raw.sourceReference)),
      ),
    register: (input: unknown): Promise<BrandCatalogSourceReceipt> =>
      perform("Register", input, (owner, body, scope) =>
        owner.register(
          parseBrandCatalogSourceRegister({
            ...body,
            ...scope,
            profile: "BrandCatalogSourceRegisterV1",
          }),
        ),
      ),
    resolve: (input: unknown): Promise<BrandCatalogSourceReceipt> =>
      perform("Resolve", input, (owner, body, scope) =>
        owner.resolve(
          parseBrandCatalogSourceResolve({
            ...body,
            ...scope,
            profile: "BrandCatalogSourceResolveV1",
          }),
        ),
      ),
  });
}
