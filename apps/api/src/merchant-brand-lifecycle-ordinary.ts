import {
  BrowserSessionError,
  WorkforceBrowserSessionService,
  createPostgresWorkforceBrowserSessionStore,
  createPostgresCurrentWorkforceBrowserSessionSource,
  createPostgresBrowserBrandSessionSelectionStore,
  readClosedRecord,
  type AuthenticationSession,
} from "@bop/identity";
import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import {
  BrandAdministrationServiceError,
  BrandConfigurationOperationError,
  createBrand,
  createPostgresBrandLifecycleAdministrationStore,
  parseCanonicalInstant,
  transitionBrand,
  type Brand,
  type BrandLifecycleTransaction,
} from "@bop/tenant";
import { createPostgresCurrentBrandAdministrationPermissionPolicySource } from "@bop/permission";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { readMerchantCurrentBrandAdministrationAuthority } from "./merchant-current-brand-scope.js";
import {
  createMerchantCurrentBrandAdministrationCapability,
  merchantBrandAdministrationCapabilityRequiredFields,
} from "./merchant-brand-administration-capability.js";
import {
  executeBrandLifecycleAdministration,
  parseBrandLifecycleCommand,
  type MerchantBrandLifecycleReceipt,
} from "./brand-lifecycle-command.js";
import type { MerchantBrandDiscoveryPersistence } from "./merchant-brand-discovery.js";

export type { MerchantBrandLifecycleReceipt } from "./brand-lifecycle-command.js";
export interface MerchantBrandLifecycleOrdinaryOptions {
  readonly persistence: MerchantBrandDiscoveryPersistence;
  readonly authentication: {
    authorize(input: {
      readonly sessionCookie: unknown;
      readonly csrf: unknown;
    }): Promise<AuthenticationSession>;
  };
  readonly nextReference: (kind: "Audit") => string;
}
export class MerchantBrandLifecycleError extends BrandConfigurationOperationError {
  constructor(readonly reason: "Invalid" | "Denied" | "Conflict" | "Unavailable") {
    super(
      reason === "Invalid"
        ? "BRAND_CONFIGURATION_INPUT_INVALID"
        : reason === "Denied"
          ? "BRAND_CONFIGURATION_PERMISSION_DENIED"
          : reason === "Conflict"
            ? "BRAND_CONFIGURATION_VERSION_CONFLICT"
            : "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    );
    this.name = "MerchantBrandLifecycleError";
  }
}
const fail = (reason: MerchantBrandLifecycleError["reason"] = "Unavailable"): never => {
  throw new MerchantBrandLifecycleError(reason);
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Own lifecycle transition only: current authority may observe the exact
 * locked before/owner-planned after, then only the receipt-proven after. Normal
 * current-scope readers retain their immutable Brand pin unchanged. */
export function createMerchantBrandLifecycleOrdinary(
  options: MerchantBrandLifecycleOrdinaryOptions,
) {
  const persistence = options.persistence,
    runner = persistence.transactions,
    run = runner.run,
    identity = persistence.identity,
    configuration = identity.configuration,
    configBytes = JSON.stringify(configuration),
    currentActor = persistence.currentActor,
    now = persistence.now,
    authentication = options.authentication,
    authorize = authentication.authorize,
    nextReference = options.nextReference,
    host = createMerchantCategoryTransactions(runner),
    ports = [
      identity.provider,
      identity.hasher,
      identity.envelopes,
      identity.credentials,
      identity.pkce,
    ];
  const capture = () => {
    if (
      options.persistence !== persistence ||
      persistence.transactions !== runner ||
      runner.run !== run ||
      persistence.identity !== identity ||
      identity.configuration !== configuration ||
      JSON.stringify(configuration) !== configBytes ||
      persistence.currentActor !== currentActor ||
      persistence.now !== now ||
      options.authentication !== authentication ||
      authentication.authorize !== authorize ||
      options.nextReference !== nextReference ||
      [
        identity.provider,
        identity.hasher,
        identity.envelopes,
        identity.credentials,
        identity.pkce,
      ].some((port, i) => port !== ports[i])
    )
      return fail();
  };
  return Object.freeze({
    async execute(value: unknown): Promise<MerchantBrandLifecycleReceipt> {
      let raw: Record<string, unknown>, command: ReturnType<typeof parseBrandLifecycleCommand>;
      try {
        raw = readClosedRecord(value, ["sessionCookie", "csrf", "command"]);
        command = parseBrandLifecycleCommand(raw.command);
      } catch {
        return fail("Invalid");
      }
      capture();
      const observedAt = String(parseCanonicalInstant(now.call(persistence)));
      let latest = observedAt,
        deadline = new Date(Date.parse(observedAt) + 5000).toISOString(),
        failed = false,
        sealed = false,
        ready = false,
        working = false,
        transactionStarted = false;
      const check = () => {
        capture();
        const at = String(parseCanonicalInstant(now.call(persistence)));
        if (failed || at < latest || at >= deadline) {
          failed = true;
          return fail();
        }
        latest = at;
        return at;
      };
      const retain = (value: string) => {
        const until = String(parseCanonicalInstant(value));
        if (until < deadline) deadline = until;
        check();
      };
      let finalize: (() => unknown) | undefined;
      try {
        const expectedSession = await authorize.call(authentication, {
          sessionCookie: raw.sessionCookie,
          csrf: raw.csrf,
        });
        check();
        transactionStarted = true;
        const result = await host.transactions.run(async (tx) => {
          const query = tx.query;
          const assert = () => {
            check();
            if (tx.query !== query) {
              failed = true;
              return fail();
            }
          };
          try {
            await host.registerBeforeCommit(
              tx,
              async () => {
                try {
                  assert();
                  if (!ready || working) return fail();
                  await authority();
                  if (
                    recordedBytes !== undefined &&
                    !same(
                      await owner.resolveRecordedOperation(command.operationReference),
                      recordedBytes,
                    )
                  )
                    return fail();
                  assert();
                } catch (error) {
                  failed = true;
                  throw error;
                }
              },
              () => {
                assert();
                if (!ready || working) return fail();
                sealed = true;
              },
            );
            assert();
            const service = new WorkforceBrowserSessionService({
              ...identity,
              now: check,
              store: createPostgresWorkforceBrowserSessionStore({
                transactions: { run: (work) => work(tx) },
                now: check,
                currentActor: (...args) => currentActor.call(persistence, ...args),
                environment: configuration.environment,
                issuer: configuration.issuer,
                clientId: configuration.clientId,
                redirectUri: configuration.redirectUri,
                allowedPostLoginPaths: configuration.allowedPostLoginPaths,
                hasher: identity.hasher,
                envelopes: identity.envelopes,
              }),
            });
            const strong = createPostgresCurrentWorkforceBrowserSessionSource({
              hasher: identity.hasher,
              envelopes: identity.envelopes,
              configuration: {
                environment: configuration.environment,
                issuer: configuration.issuer,
                clientId: configuration.clientId,
              },
              now: check,
              currentActor: (...args) => currentActor.call(persistence, ...args),
            });
            const selection = createPostgresBrowserBrandSessionSelectionStore();
            let sessionPin: string | undefined;
            const session = async () => {
              assert();
              const authorized = await service.authorize({
                sessionCookie: raw.sessionCookie,
                csrf: raw.csrf,
              });
              assert();
              retain(authorized.validUntil);
              retain(authorized.recentMfa.validUntil);
              const actual = await strong(tx, raw.sessionCookie);
              assert();
              if (
                actual.sessionReference !== expectedSession.sessionReference ||
                actual.actor.actorReference !== expectedSession.actor.actorReference ||
                actual.authenticatedAt !== expectedSession.authenticatedAt ||
                actual.sessionReference !== authorized.session.sessionReference ||
                actual.actor.actorReference !== authorized.session.actor.actorReference ||
                actual.authenticatedAt !== authorized.session.authenticatedAt
              )
                return fail("Denied");
              const pin = JSON.stringify({ actual, mfa: authorized.recentMfa });
              if (sessionPin !== undefined && sessionPin !== pin) return fail("Denied");
              sessionPin = pin;
              retain(actual.idleExpiresAt);
              retain(actual.absoluteExpiresAt);
              const selected = await selection.read(tx, actual, check());
              assert();
              if (selected?.brandReference !== command.brandReference) return fail("Denied");
              return actual;
            };
            const firstSession = await session(),
              actorReference = String(firstSession.actor.actorReference),
              scope = Object.freeze({
                tenantReference: String(command.brandReference),
                brandReference: String(command.brandReference),
                actorReference,
              });
            let before: Brand | undefined,
              planned: Brand | undefined,
              committed: Brand | undefined,
              decisionPin: string | undefined,
              recordedBytes: unknown;
            async function authority() {
              assert();
              const packet = await readMerchantCurrentBrandAdministrationAuthority(
                tx,
                await session(),
                command.brandReference,
                check(),
                ["organization.manage"],
                // Each owning source pins one complete administrative context.
                // This command holds the exact before/after transition below;
                // never reuse a source across its own persisted Brand change.
                createPostgresCurrentBrandAdministrationPermissionPolicySource(tx),
              );
              assert();
              const actual = createBrand(packet.context.brand),
                permission = packet.decisions[0];
              if (
                String(actual.brandReference) !== scope.brandReference ||
                String(packet.context.actor.actorReference) !== actorReference ||
                packet.context.store !== null ||
                !permission ||
                permission.action !== "organization.manage" ||
                permission.scopeKind !== "Brand" ||
                permission.effect !== "Allow" ||
                packet.validUntil === null
              )
                return fail("Denied");
              retain(packet.validUntil);
              if (!before) before = actual;
              if (
                committed
                  ? !same(actual, committed)
                  : !same(actual, before) && (!planned || !same(actual, planned))
              )
                return fail();
              const decision = JSON.stringify(permission);
              if (decisionPin !== undefined && decisionPin !== decision) return fail();
              decisionPin = decision;
              return { packet, permission };
            }
            let capabilityReady = false;
            const allowed = async () => {
              await authority();
              if (!capabilityReady) {
                const capabilityDeadline = deadline;
                const capability = createMerchantCurrentBrandAdministrationCapability({
                  transaction: tx,
                  scope,
                  clock: { now: check },
                  originalObservedAt: observedAt,
                  originalValidUntil: capabilityDeadline,
                  registerBeforeCommit: (actual, guard, final) => {
                    if (actual !== tx) return fail();
                    return host.registerBeforeCommit(tx, guard, final);
                  },
                  async holdCurrentBrandAdministrationAuthority(actual, request) {
                    assert();
                    if (
                      actual !== tx ||
                      !same(request.scope, scope) ||
                      request.permission !== "organization.manage" ||
                      request.purposeCode !== "BRAND_ADMINISTRATION" ||
                      !same(
                        request.requiredFields,
                        merchantBrandAdministrationCapabilityRequiredFields,
                      ) ||
                      request.observedAt < observedAt ||
                      request.observedAt > check() ||
                      request.validUntil > capabilityDeadline
                    )
                      return fail();
                    const { packet, permission } = await authority();
                    return {
                      scope,
                      administrationContext: packet.context,
                      permission,
                      validUntil: deadline,
                    };
                  },
                });
                await capability.holdUntilCommit();
                retain(capability.leaseDeadline());
                capabilityReady = true;
                const heldCapability = capability;
                finalize = () => heldCapability.assertFinalized();
              }
              return true;
            };
            // The existing lifecycle owner requires a present rowCount property.
            // Adapt only that result shape; authority still uses the live host tx.
            const lifecycleTx: BrandLifecycleTransaction = Object.freeze({
              async query<Row = Record<string, unknown>>(sql: string, values: readonly unknown[]) {
                assert();
                const result = await query.call(tx, sql, values);
                assert();
                return { rows: result.rows as readonly Row[], rowCount: result.rowCount ?? null };
              },
            });
            const owner = createPostgresBrandLifecycleAdministrationStore({
              brandReference: command.brandReference,
              binding: { actorReference, purposeCode: "BRAND_ADMINISTRATION" },
              transactions: { run: (work) => work(lifecycleTx) },
              async authorize(actual, operation) {
                assert();
                if (
                  actual !== lifecycleTx ||
                  (operation !== null &&
                    (operation.brandReference !== command.brandReference ||
                      operation.operationReference !== command.operationReference))
                )
                  return fail();
                return allowed();
              },
              async appendAudit(actual, input) {
                assert();
                if (
                  actual !== lifecycleTx ||
                  !planned ||
                  input.operation.command !== command.action ||
                  input.operation.operationReference !== command.operationReference ||
                  input.operation.brandReference !== command.brandReference ||
                  input.audit.actorReference !== actorReference ||
                  input.audit.purposeCode !== "BRAND_ADMINISTRATION" ||
                  input.audit.occurredAt !== observedAt ||
                  input.expectedBrandVersion !== command.expectedBrandVersion ||
                  !same(createBrand(input.operation.artifact), planned)
                )
                  return fail();
                const audit = validateAuditRecord(
                  {
                    auditId: input.audit.auditReference,
                    brandId: command.brandReference,
                    actor: { type: "User", reference: actorReference },
                    actionCode:
                      command.action === "ActivateBrand" ? "BRAND_ACTIVATED" : "BRAND_ARCHIVED",
                    targetType: "Brand",
                    targetId: command.brandReference,
                    correlationId: command.operationReference,
                    reasonCode: "BRAND_ADMINISTRATION",
                    occurredAt: input.audit.occurredAt,
                    sourceChannel: "MERCHANT_WEB",
                    dataClassification: "Internal",
                    retentionPolicyCode: "CONFIGURATION_AUDIT",
                    retentionPolicyVersion: 1,
                  },
                  Date.parse(check()),
                );
                await appendAuditRecordInTransaction(tx, audit);
                assert();
              },
            });
            // The owning facade takes operation/Brand fences before its first
            // authorize callback. Do not acquire Brand SHARE authority earlier.
            working = true;
            try {
              const answer = await executeBrandLifecycleAdministration({
                store: owner,
                command,
                actorReference,
                occurredAt: observedAt,
                nextAuditReference() {
                  assert();
                  const value = nextReference.call(options, "Audit");
                  assert();
                  return value;
                },
                authorize: allowed,
                onPlanned(actualBefore, after) {
                  assert();
                  if (
                    !before ||
                    planned ||
                    !same(actualBefore, before) ||
                    !same(
                      after,
                      transitionBrand(
                        before,
                        before.version,
                        command.action === "ActivateBrand" ? "Active" : "Archived",
                        observedAt,
                      ),
                    )
                  )
                    return fail();
                  planned = after;
                },
                onRecorded(record) {
                  assert();
                  if (recordedBytes !== undefined) return fail();
                  recordedBytes = record;
                  if (planned) {
                    if (!same(createBrand(record.operation.artifact), planned)) return fail();
                    committed = planned;
                  }
                },
              });
              await authority();
              if (!capabilityReady || !before || (planned !== undefined && committed === undefined))
                return fail();
              assert();
              ready = true;
              return answer;
            } finally {
              working = false;
            }
          } catch (error) {
            failed = true;
            throw error;
          }
        });
        if (!sealed || failed || !finalize) return fail();
        finalize();
        // A proven absent-original CAS/lifecycle conflict is a read-only result,
        // surfaced only after the sanitized Identity runner actually committed.
        if ("conflict" in result) return fail("Conflict");
        return result;
      } catch (error) {
        failed = true;
        if (error instanceof MerchantBrandLifecycleError) throw error;
        if (
          !transactionStarted &&
          (error instanceof BrowserSessionError ||
            (error instanceof BrandAdministrationServiceError &&
              error.code === "BRAND_ADMIN_PERMISSION_DENIED"))
        )
          return fail("Denied");
        return fail();
      }
    },
  });
}
