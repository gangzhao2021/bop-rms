import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
} from "@bop/audit";
import { BrowserSessionError, readClosedRecord, type AuthenticationSession } from "@bop/identity";
import {
  createPostgresPlatformTemplateBrandReferenceSource,
  parsePublishingReference,
} from "@bop/publishing";
import {
  BrandConfigurationOperationError,
  brandConfigurationOperationRequiredFields,
  createPostgresBrandConfigurationAuthoringStore,
  parseBrandConfigurationCommand,
  parseBrandConfigurationResolve,
  parseBrandReference,
  parseCanonicalInstant,
  parseBrandConfigurationCurrent,
  type BrandAdministrationContext,
  type BrandConfigurationActorScope,
  type BrandConfigurationAuthoringTransaction,
} from "@bop/tenant";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import {
  createMerchantCurrentBrandAdministrationScope,
  type MerchantCurrentBrandAdministrationOptions,
} from "./merchant-current-brand-scope.js";
import {
  createMerchantCurrentBrandAdministrationCapability,
  merchantBrandAdministrationCapabilityRequiredFields,
} from "./merchant-brand-administration-capability.js";
import {
  createMerchantBrandAdministrationConfigurationPreparation,
  type MerchantBrandAdministrationConfigurationPreparationOptions,
} from "./merchant-brand-configuration-preparation.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import {
  parseMerchantBrandConfigurationCurrent,
  readMerchantBrandConfigurationRecordedReview,
} from "./merchant-brand-configuration-recorded-review.js";
import { projectMerchantBrandTemplateCandidates } from "./merchant-brand-template-candidates.js";

type Tx = BrandConfigurationAuthoringTransaction;
export interface MerchantBrandConfigurationOrdinarySourceHost {
  holdCurrentBrandAdministration(
    actual: Tx,
    request: {
      readonly scope: BrandConfigurationActorScope;
      readonly observedAt: string;
      readonly validUntil: string;
    },
  ): Promise<{
    readonly administrationContext: BrandAdministrationContext;
    readonly validUntil: string;
  }>;
  registerBeforeCommit(actual: Tx, guard: () => Promise<void>, final: () => void): Promise<void>;
  registerAfterCommit(actual: Tx, pureAssertFinalized: () => unknown): void;
}
export interface MerchantBrandConfigurationOrdinaryOptions {
  readonly persistence: MerchantCurrentBrandAdministrationOptions &
    Pick<PersistentMerchantBffOptions, "transactions">;
  readonly authentication: {
    authorize(input: {
      readonly sessionCookie: unknown;
      readonly csrf: unknown;
    }): Promise<AuthenticationSession>;
  };
  readonly nextReference: (
    kind:
      | "ConfigurationVersion"
      | "Lifecycle"
      | "Mutation"
      | "Validation"
      | "Approval"
      | "Release"
      | "Audit",
  ) => string;
  /** Called only by fresh owning preparation, after original arbitration/CAS.
   * The mandatory actual public reference holders retain their own final guards. */
  readonly configure: (
    actual: Tx,
    scope: BrandConfigurationActorScope,
    sourceHost: MerchantBrandConfigurationOrdinarySourceHost,
  ) => Pick<MerchantBrandAdministrationConfigurationPreparationOptions, "references">;
}
const fail = (
  code: BrandConfigurationOperationError["code"] = "BRAND_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new BrandConfigurationOperationError(code);
};
/** Normalize owning authorization refusals before the shared host handles unknown errors. */
function authorityFailure(error: unknown): never {
  if (error instanceof BrandConfigurationOperationError) throw error;
  if (
    error instanceof BrowserSessionError ||
    (error instanceof Error && error.message === "BRAND_SERVICE_PERMISSION_DENIED")
  )
    return fail("BRAND_CONFIGURATION_PERMISSION_DENIED");
  return fail();
}
const read = (value: unknown, keys: readonly string[]) => {
  try {
    return readClosedRecord(value, keys);
  } catch {
    return fail("BRAND_CONFIGURATION_INPUT_INVALID");
  }
};
/** Capture editable browser data before the first await without evaluating getters. */
function detach(value: Record<string, unknown>): Record<string, unknown> {
  let nodes = 0;
  const copy = (v: unknown, depth: number): unknown => {
    if (++nodes > 10000 || depth > 20) return fail("BRAND_CONFIGURATION_INPUT_INVALID");
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number")
      return Number.isFinite(v) ? v : fail("BRAND_CONFIGURATION_INPUT_INVALID");
    if (!v || typeof v !== "object") return fail("BRAND_CONFIGURATION_INPUT_INVALID");
    if (Array.isArray(v)) {
      if (
        Object.getPrototypeOf(v) !== Array.prototype ||
        Reflect.ownKeys(v).length !== v.length + 1
      )
        return fail("BRAND_CONFIGURATION_INPUT_INVALID");
      return Object.freeze(
        Array.from({ length: v.length }, (_, index) => {
          const d = Object.getOwnPropertyDescriptor(v, String(index));
          if (!d?.enumerable || !("value" in d)) return fail("BRAND_CONFIGURATION_INPUT_INVALID");
          return copy(d.value, depth + 1);
        }),
      );
    }
    if (Object.getPrototypeOf(v) !== Object.prototype)
      return fail("BRAND_CONFIGURATION_INPUT_INVALID");
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(v)) {
      if (typeof key !== "string" || key === "__proto__")
        return fail("BRAND_CONFIGURATION_INPUT_INVALID");
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (!d?.enumerable || !("value" in d)) return fail("BRAND_CONFIGURATION_INPUT_INVALID");
      result[key] = copy(d.value, depth + 1);
    }
    return Object.freeze(result);
  };
  const result = read(copy(value, 0), Object.keys(value));
  if (new TextEncoder().encode(JSON.stringify(result)).length > 131072)
    return fail("BRAND_CONFIGURATION_INPUT_INVALID");
  return result;
}
const refs = {
  canonicalize: canonicalizeRfc8785,
  hashIntent: (text: string) => "sha256:" + sha256Hex(text),
};
const equalScope = (a: BrandConfigurationActorScope, b: BrandConfigurationActorScope) =>
  a.tenantReference === b.tenantReference &&
  a.brandReference === b.brandReference &&
  a.actorReference === b.actorReference;

/** Actual administrative Brand lifecycle, no Store. Browser identities/qualification packets are
 * refused; current Session, selection, IAM and Feature sources admit each call.
 * Original replay/abandon never invokes fresh reference preparation. */
export function createMerchantBrandConfigurationOrdinary(
  options: MerchantBrandConfigurationOrdinaryOptions,
) {
  const persistence = options.persistence,
    authentication = options.authentication,
    runner = persistence.transactions,
    runPort = runner.run,
    nowPort = persistence.now,
    authorizePort = authentication.authorize,
    nextPort = options.nextReference,
    configurePort = options.configure,
    actorPort = persistence.currentActor,
    identity = persistence.identity,
    hasher = identity.hasher;
  const host = createMerchantCategoryTransactions(runner),
    resolveScope = createMerchantCurrentBrandAdministrationScope(persistence);
  function capture() {
    if (
      options.persistence !== persistence ||
      options.authentication !== authentication ||
      persistence.transactions !== runner ||
      runner.run !== runPort ||
      persistence.now !== nowPort ||
      persistence.currentActor !== actorPort ||
      persistence.identity !== identity ||
      identity.hasher !== hasher ||
      authentication.authorize !== authorizePort ||
      options.nextReference !== nextPort ||
      options.configure !== configurePort
    )
      return fail();
  }
  async function perform(
    mode: "Current" | "History" | "Execute" | "Resolve" | "Templates",
    raw: unknown,
  ) {
    capture();
    const input = read(raw, [
      "sessionCookie",
      "csrf",
      "expectedBrandReference",
      ...(mode === "Templates"
        ? ["afterTemplateReference"]
        : mode === "History"
          ? ["beforeRevision"]
          : mode === "Execute"
            ? ["command"]
            : mode === "Resolve"
              ? ["original"]
              : []),
    ]);
    let brand: string;
    try {
      brand = parseBrandReference(input.expectedBrandReference);
    } catch {
      return fail("BRAND_CONFIGURATION_INPUT_INVALID");
    }
    let afterTemplateReference: string | null = null;
    if (mode === "Templates" && input.afterTemplateReference !== null) {
      try {
        afterTemplateReference = String(parsePublishingReference(input.afterTemplateReference));
      } catch {
        return fail("BRAND_CONFIGURATION_INPUT_INVALID");
      }
    }
    const body =
      mode === "Execute"
        ? detach(
            read(input.command, [
              "command",
              "operationReference",
              "expectedBrandVersion",
              "expectedHead",
              "configuration",
              "reviewValidUntil",
            ]),
          )
        : mode === "Resolve"
          ? detach(
              read(input.original, [
                "command",
                "operationReference",
                "expectedBrandVersion",
                "expectedHead",
                "intentDigest",
              ]),
            )
          : undefined;
    const observedAt = parseCanonicalInstant(nowPort.call(persistence));
    let latest = observedAt,
      deadline: string = new Date(Date.parse(observedAt) + 5000).toISOString(),
      failed = false;
    const check = () => {
      capture();
      const at = parseCanonicalInstant(nowPort.call(persistence));
      if (failed || at < latest || at >= deadline) return fail();
      latest = at;
      return at;
    };
    const tighten = (value: string) => {
      const until = parseCanonicalInstant(value);
      if (until < deadline) deadline = until;
      check();
    };
    let finalized: (() => unknown) | undefined;
    const afterCommit: (() => unknown)[] = [];
    try {
      const session = await authorizePort.call(authentication, {
        sessionCookie: input.sessionCookie,
        csrf: input.csrf,
      });
      check();
      const result = await host.transactions.run(async (tx) => {
        const query = tx.query,
          current = await resolveScope(
            tx,
            input.sessionCookie,
            session.sessionReference,
            deadline,
          ).catch(authorityFailure),
          scope = Object.freeze({
            tenantReference: current.tenantReference,
            brandReference: String(current.context.brand.brandReference),
            actorReference: String(current.actorReference),
          });
        if (
          scope.brandReference !== brand ||
          current.context.profile !== "BrandAdministrationContextV1" ||
          current.context.store !== null
        )
          return fail("BRAND_CONFIGURATION_PERMISSION_DENIED");
        const currentAuthorize = current.authorizeActionsWithValidity,
          currentAssert = current.assertCurrent;
        const assert = () => {
          check();
          if (
            tx.query !== query ||
            current.authorizeActionsWithValidity !== currentAuthorize ||
            current.assertCurrent !== currentAssert ||
            !equalScope(scope, {
              tenantReference: current.tenantReference,
              brandReference: String(current.context.brand.brandReference),
              actorReference: String(current.actorReference),
            })
          )
            return fail();
          currentAssert.call(current);
        };
        async function permissions(actions: readonly string[]) {
          assert();
          const packet = await currentAuthorize.call(current, actions).catch(authorityFailure);
          assert();
          if (
            packet.context.profile !== "BrandAdministrationContextV1" ||
            packet.context.store !== null ||
            String(packet.context.brand.brandReference) !== scope.brandReference ||
            String(packet.context.actor.actorReference) !== scope.actorReference ||
            packet.decisions.length !== actions.length ||
            packet.decisions.some(
              (d, i) => d.action !== actions[i] || d.scopeKind !== "Brand" || d.effect !== "Allow",
            )
          )
            return fail("BRAND_CONFIGURATION_PERMISSION_DENIED");
          tighten(packet.validUntil);
          return packet;
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
            if (
              actual !== tx ||
              !equalScope(request.scope, scope) ||
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
        let sourceOpen = true,
          sourceAuthorityOpen = true,
          sourceFailed = false;
        const sourceProtocol = () => {
          if (sourceFailed || tx.query !== query) return fail();
        };
        const syncSourceAssertion = (work: () => unknown) => {
          sourceProtocol();
          const returned: unknown = work();
          if (returned !== undefined) {
            sourceFailed = true;
            if (returned instanceof Promise) void returned.catch(() => undefined);
            return fail();
          }
          sourceProtocol();
        };
        const sourceHost: MerchantBrandConfigurationOrdinarySourceHost = Object.freeze({
          async holdCurrentBrandAdministration(
            actual: Tx,
            request: {
              readonly scope: BrandConfigurationActorScope;
              readonly observedAt: string;
              readonly validUntil: string;
            },
          ) {
            try {
              assert();
              sourceProtocol();
              readClosedRecord(request, ["scope", "observedAt", "validUntil"]);
              readClosedRecord(request.scope, [
                "tenantReference",
                "brandReference",
                "actorReference",
              ]);
              if (
                !sourceAuthorityOpen ||
                actual !== tx ||
                !equalScope(request.scope, scope) ||
                parseCanonicalInstant(request.observedAt) < observedAt ||
                request.observedAt > check() ||
                parseCanonicalInstant(request.validUntil) > deadline ||
                request.validUntil <= request.observedAt
              )
                return fail();
              const packet = await permissions(["organization.manage"]);
              sourceProtocol();
              assert();
              if (check() >= request.validUntil) return fail();
              return Object.freeze({
                administrationContext: packet.context,
                validUntil: deadline < request.validUntil ? deadline : request.validUntil,
              });
            } catch (error) {
              sourceFailed = true;
              throw error;
            }
          },
          async registerBeforeCommit(actual: Tx, guard: () => Promise<void>, final: () => void) {
            assert();
            if (
              !sourceOpen ||
              actual !== tx ||
              typeof guard !== "function" ||
              typeof final !== "function"
            ) {
              sourceFailed = true;
              for (const invalid of [guard, final]) {
                const value: unknown = invalid;
                if (value instanceof Promise) void value.catch(() => undefined);
              }
              return fail();
            }
            await host.registerBeforeCommit(
              tx,
              async () => {
                assert();
                sourceProtocol();
                const returned: unknown = await guard();
                if (returned !== undefined) {
                  sourceFailed = true;
                  return fail();
                }
                sourceProtocol();
                assert();
              },
              () => {
                assert();
                syncSourceAssertion(final);
                assert();
              },
            );
          },
          registerAfterCommit(actual: Tx, pureAssertFinalized: () => unknown) {
            assert();
            if (
              !sourceOpen ||
              actual !== tx ||
              typeof pureAssertFinalized !== "function" ||
              afterCommit.length >= 128
            ) {
              sourceFailed = true;
              const invalid: unknown = pureAssertFinalized;
              if (invalid instanceof Promise) void invalid.catch(() => undefined);
              return fail();
            }
            afterCommit.push(() => syncSourceAssertion(pureAssertFinalized));
          },
        });
        async function closeSources(recheck?: () => Promise<void>) {
          await host.registerBeforeCommit(
            tx,
            async () => {
              sourceProtocol();
              await permissions(["organization.manage"]);
              await recheck?.();
              assert();
              sourceProtocol();
            },
            () => {
              assert();
              sourceProtocol();
              sourceAuthorityOpen = false;
            },
          );
          sourceOpen = false;
        }
        if (mode === "Templates") {
          const templates = createPostgresPlatformTemplateBrandReferenceSource({
            transaction: tx,
            scope,
            clock: { now: check },
            originalObservedAt: observedAt,
            originalValidUntil: deadline,
            registerBeforeCommit: sourceHost.registerBeforeCommit,
            authority: {
              async holdUntilTransactionCompletes(actual, request) {
                try {
                  assert();
                  if (
                    actual !== tx ||
                    !equalScope(request.scope, scope) ||
                    request.purposeCode !== "BRAND_ADMINISTRATION" ||
                    request.permission !== "organization.manage" ||
                    request.observedAt < observedAt ||
                    request.observedAt > check() ||
                    request.validUntil > deadline
                  )
                    return fail();
                  const packet = await sourceHost.holdCurrentBrandAdministration(actual, {
                    scope,
                    observedAt: request.observedAt,
                    validUntil: request.validUntil,
                  });
                  tighten(packet.validUntil);
                  return packet;
                } catch (error) {
                  sourceFailed = true;
                  throw error;
                }
              },
            },
          });
          sourceHost.registerAfterCommit(tx, () => templates.assertFinalized());
          const packet = await templates.list({ afterTemplateReference, limit: 20 });
          assert();
          tighten(packet.validUntil);
          const response = projectMerchantBrandTemplateCandidates(packet, afterTemplateReference);
          await closeSources();
          finalized = () => capability.assertFinalized();
          return response;
        }
        const owner = createPostgresBrandConfigurationAuthoringStore({
          ...scope,
          transaction: tx,
          clock: { now: check },
          originalObservedAt: observedAt,
          originalValidUntil: deadline,
          registerBeforeCommit: (actual, guard, final) => {
            if (actual !== tx) return fail();
            return host.registerBeforeCommit(tx, guard, final);
          },
          authority: {
            async holdUntilTransactionCompletes(actual, packet) {
              if (
                actual !== tx ||
                !equalScope(packet, scope) ||
                packet.permission !== "organization.manage" ||
                packet.purposeCode !== "BRAND_CONFIGURATION" ||
                canonicalizeRfc8785(packet.requiredFields) !==
                  canonicalizeRfc8785(brandConfigurationOperationRequiredFields) ||
                packet.observedAt < observedAt ||
                packet.observedAt > check() ||
                packet.validUntil > deadline
              )
                return fail();
              await permissions(["organization.manage"]);
              return { validUntil: deadline };
            },
          },
          references: {
            ...refs,
            nextReference: (kind) => {
              assert();
              const value = nextPort.call(options, kind);
              assert();
              return value;
            },
          },
          async appendAudit(actual, packet) {
            assert();
            if (
              actual !== tx ||
              !equalScope(packet, scope) ||
              packet.purposeCode !== "BRAND_CONFIGURATION"
            )
              return fail();
            const audit = validateAuditRecord(
              {
                auditId: packet.auditReference,
                brandId: scope.brandReference,
                actor: { type: "User", reference: scope.actorReference },
                actionCode:
                  packet.mode === "Abandon"
                    ? "BRAND_CONFIGURATION_ORIGINAL_ABANDONED"
                    : "BRAND_CONFIGURATION_RECORDED",
                targetType: "BrandConfigurationOriginal",
                targetId: packet.operationReference,
                afterSummary: {
                  intentDigest: packet.intentDigest,
                  configurationVersionReference: packet.configurationVersionReference,
                },
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
            assert();
          },
          async prepareFresh(actual, packet) {
            assert();
            if (actual !== tx || !equalScope(packet.command, scope)) return fail();
            const configured = configurePort.call(options, tx, scope, sourceHost);
            try {
              readClosedRecord(configured, ["references"]);
            } catch {
              return fail();
            }
            assert();
            const prepare = createMerchantBrandAdministrationConfigurationPreparation({
              ...scope,
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
                const value = nextPort.call(options, kind);
                assert();
                return value;
              },
              references: configured.references,
              authority: {
                async withCurrentContext(actualTx, request, work) {
                  if (actualTx !== tx || !equalScope(request.command, scope)) return fail();
                  const authorized = await permissions(["organization.manage"]);
                  const output = await work(authorized.context, tx);
                  await permissions(["organization.manage"]);
                  return output;
                },
                publishing: {
                  async authorize(request) {
                    assert();
                    if (
                      request.resourceScope.kind !== "Brand" ||
                      String(request.resourceScope.brandReference) !== scope.brandReference ||
                      request.resourceScope.storeReference !== null ||
                      String(request.familyReference) !== scope.brandReference ||
                      request.purposeCode !== "BRAND_CONFIGURATION" ||
                      request.administrationContext.store !== null ||
                      String(request.administrationContext.actor.actorReference) !==
                        scope.actorReference ||
                      String(request.administrationContext.brand.brandReference) !==
                        scope.brandReference
                    )
                      return fail("BRAND_CONFIGURATION_PERMISSION_DENIED");
                    const authorized = await permissions([request.action]),
                      decision = authorized.decisions[0];
                    if (!decision) return fail();
                    return decision;
                  },
                },
              },
            });
            const prepared = await prepare(tx, packet);
            assert();
            return prepared;
          },
        });
        const original = body
          ? { ...body, ...scope, purposeCode: "BRAND_CONFIGURATION" }
          : undefined;
        const output =
          mode === "Current"
            ? await owner.readCurrent()
            : mode === "History"
              ? await owner.readHistory({ beforeRevision: input.beforeRevision })
              : mode === "Execute"
                ? await owner.execute(
                    parseBrandConfigurationCommand({
                      ...original,
                      profile: "TenantBrandConfigurationCommandV1",
                    }),
                  )
                : await owner.resolve(
                    parseBrandConfigurationResolve({
                      ...original,
                      profile: "TenantBrandConfigurationResolveV1",
                    }),
                  );
        assert();
        const review =
          mode === "Current"
            ? await readMerchantBrandConfigurationRecordedReview({
                transaction: tx,
                scope,
                current: parseBrandConfigurationCurrent(output),
                readHistory: (request) => owner.readHistory(request),
                assertCurrent: assert,
                now: check,
              })
            : null;
        const response =
          mode === "Current"
            ? parseMerchantBrandConfigurationCurrent(
                { ...output, recordedReview: review?.recordedReview ?? null },
                scope,
                check(),
              )
            : output;
        await closeSources(review ? () => review.recheck() : undefined);
        finalized = () => {
          owner.assertFinalized();
          capability.assertFinalized();
        };
        return response;
      });
      if (!finalized) return fail();
      finalized();
      for (const final of afterCommit) final();
      return result;
    } catch (error) {
      failed = true;
      return authorityFailure(error);
    }
  }
  return Object.freeze({
    current: (input: unknown) => perform("Current", input),
    history: (input: unknown) => perform("History", input),
    execute: (input: unknown) => perform("Execute", input),
    resolve: (input: unknown) => perform("Resolve", input),
    templates: (input: unknown) => perform("Templates", input),
  });
}
