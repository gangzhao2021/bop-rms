import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  validateAuditRecord,
} from "@bop/audit";
import { BrowserSessionError, readClosedRecord } from "@bop/identity";
import {
  createPostgresTransactionCurrentPermissionPolicySource,
  parsePolicyReference,
  parsePolicyVersion,
} from "@bop/permission";
import {
  BrandStoreTopologyError,
  createPostgresBrandStoreTopologyDraftStore,
  brandStoreTopologyDraftRequiredFields,
  parseBrandStoreTopologySave,
  parseBrandStoreTopologyResolve,
  parseBrandStoreTopologyCurrent,
  parseBrandStoreTopologyDraftRevision,
  parseBrandStoreTopologyOperationReceipt,
  parsePlatformTenantReference,
  parseBrandReference,
  parseStoreReference,
  parseCanonicalInstant,
  createPostgresTenantStoreReferenceSource,
  parseTenantStoreReferenceRequest,
  parseTenantStoreLabelReferenceSnapshot,
  type BrandStoreTopologyActorScope,
  type BrandStoreTopologyDraftStoreOptions,
  type BrandStoreTopologyCurrent,
  type BrandStoreTopologyDraftRevision,
  type TenantStoreLabelReferenceSnapshot,
  type TenantStoreReferenceSnapshot,
  type TenantStoreReferenceTransaction,
  type TenantStoreReferenceRequest,
} from "@bop/tenant";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import {
  createMerchantBrandStoreTopologyCapability,
  merchantBrandStoreTopologyCapabilityRequiredFields,
} from "./merchant-brand-store-topology-capability.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

export interface BrandStoreTopologyWorkbench {
  readonly profile: "BrandStoreTopologyWorkbenchV1";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly current: BrandStoreTopologyCurrent;
  readonly history: readonly BrandStoreTopologyDraftRevision[];
  readonly stores: TenantStoreLabelReferenceSnapshot;
  readonly observedAt: string;
  readonly validUntil: string;
  readonly status: "DraftOnly";
}
/** Structural transport admission is not authorization or effective topology. */
export function parseBrandStoreTopologyWorkbench(
  value: unknown,
  actualObservedAt: unknown,
): BrandStoreTopologyWorkbench {
  try {
    const r = readClosedRecord(value, [
      "profile",
      "tenantReference",
      "brandReference",
      "actorReference",
      "current",
      "history",
      "stores",
      "observedAt",
      "validUntil",
      "status",
    ]);
    if (r.profile !== "BrandStoreTopologyWorkbenchV1" || r.status !== "DraftOnly") return fail();
    const bound = scope({
      tenantReference: r.tenantReference,
      brandReference: r.brandReference,
      actorReference: r.actorReference,
    });
    const observedAt = String(parseCanonicalInstant(r.observedAt)),
      validUntil = String(parseCanonicalInstant(r.validUntil)),
      now = String(parseCanonicalInstant(actualObservedAt));
    if (
      now < observedAt ||
      now >= validUntil ||
      validUntil <= observedAt ||
      Date.parse(validUntil) - Date.parse(observedAt) > 5000
    )
      return fail();
    const current = parseBrandStoreTopologyCurrent(r.current, now),
      stores = parseTenantStoreLabelReferenceSnapshot(r.stores);
    if (
      !same(
        {
          tenantReference: current.tenantReference,
          brandReference: current.brandReference,
          actorReference: current.actorReference,
        },
        bound,
      ) ||
      current.observedAt > observedAt ||
      current.validUntil < validUntil ||
      stores.brandReference !== bound.brandReference ||
      stores.observedAt > observedAt
    )
      return fail();
    if (
      !Array.isArray(r.history) ||
      Object.getPrototypeOf(r.history) !== Array.prototype ||
      r.history.length > 1000
    )
      return fail();
    const descriptors = Object.getOwnPropertyDescriptors(r.history);
    if (Reflect.ownKeys(r.history).length !== r.history.length + 1) return fail();
    const history: BrandStoreTopologyDraftRevision[] = [];
    for (let i = 0; i < r.history.length; i++) {
      const item = descriptors[String(i)];
      if (!item || !("value" in item) || !item.enumerable) return fail();
      const row = parseBrandStoreTopologyDraftRevision(item.value);
      if (
        row.tenantReference !== bound.tenantReference ||
        row.brandReference !== bound.brandReference ||
        row.updatedAt > observedAt ||
        row.revision !== i + 1 ||
        (i > 0 &&
          (row.content.draftReference !== history[0]?.content.draftReference ||
            row.createdAt !== history[0]?.createdAt ||
            row.updatedAt < (history[i - 1]?.updatedAt ?? observedAt)))
      )
        return fail();
      history.push(row);
    }
    if (
      (history.length === 0) !== (current.current === null) ||
      (current.current && !same(current.current, history[history.length - 1]))
    )
      return fail();
    return Object.freeze({
      profile: "BrandStoreTopologyWorkbenchV1",
      ...bound,
      current,
      history: Object.freeze(history),
      stores,
      observedAt,
      validUntil,
      status: "DraftOnly",
    });
  } catch {
    return fail();
  }
}
export interface MerchantBrandStoreTopologyDraftOptions {
  readonly persistence: PersistentMerchantBffOptions;
  readonly authentication: Pick<MerchantBffService, "authorize">;
  readonly nextReference: () => string;
}
export interface MerchantBrandStoreTopologyWorkspaceInput {
  readonly sessionCookie: unknown;
  readonly csrf: unknown;
  readonly expectedBrandReference: unknown;
  readonly expectedScope?: unknown;
}
export interface MerchantBrandStoreTopologyWriteInput {
  readonly sessionCookie: unknown;
  readonly csrf: unknown;
  readonly expectedScope: unknown;
  readonly command: unknown;
}
const fail = (
  code: BrandStoreTopologyError["code"] = "BRAND_STORE_TOPOLOGY_DEPENDENCY_UNAVAILABLE",
): never => {
  throw new BrandStoreTopologyError(code);
};
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const same = (a: unknown, b: unknown) => canonicalizeRfc8785(a) === canonicalizeRfc8785(b);
function scope(value: unknown): BrandStoreTopologyActorScope {
  try {
    const r = readClosedRecord(value, ["tenantReference", "brandReference", "actorReference"]);
    return Object.freeze({
      tenantReference: parsePlatformTenantReference(r.tenantReference),
      brandReference: parseBrandReference(r.brandReference),
      actorReference: parseBrandReference(r.actorReference),
    });
  } catch {
    return fail("BRAND_STORE_TOPOLOGY_INPUT_INVALID");
  }
}
function bounded(error: unknown): never {
  if (error instanceof BrandStoreTopologyError) throw error;
  if (
    error instanceof BrowserSessionError ||
    (error instanceof Error &&
      ["BRAND_SERVICE_PERMISSION_DENIED", "STORE_SERVICE_PERMISSION_DENIED"].includes(
        error.message,
      ))
  )
    return fail("BRAND_STORE_TOPOLOGY_PERMISSION_DENIED");
  return fail();
}
/** Ordinary Brand Draft management. Registered Store labels are identity facts,
 * never effective Region/Group membership, Store operation or approval. */
export function createMerchantBrandStoreTopologyDraft(
  options: MerchantBrandStoreTopologyDraftOptions,
) {
  const persistence = options.persistence,
    authentication = options.authentication,
    runner = persistence.transactions,
    run = runner.run,
    now = persistence.now,
    auth = authentication.authorize,
    next = options.nextReference,
    identity = persistence.identity,
    hasher = identity.hasher,
    actor = persistence.currentActor,
    association = persistence.validateAssociation;
  if ([run, now, auth, next, actor, association].some((port) => typeof port !== "function"))
    return fail();
  const host = createMerchantCategoryTransactions(runner);
  function capture() {
    if (
      options.persistence !== persistence ||
      options.authentication !== authentication ||
      options.nextReference !== next ||
      persistence.transactions !== runner ||
      runner.run !== run ||
      persistence.now !== now ||
      authentication.authorize !== auth ||
      persistence.identity !== identity ||
      identity.hasher !== hasher ||
      persistence.currentActor !== actor ||
      persistence.validateAssociation !== association
    )
      return fail();
  }
  async function perform(
    mode: "Workspace" | "Save" | "Resolve",
    input: MerchantBrandStoreTopologyWorkspaceInput | MerchantBrandStoreTopologyWriteInput,
  ) {
    let callbackError: BrandStoreTopologyError | undefined;
    const retain = (error: unknown) => {
      if (
        error instanceof BrandStoreTopologyError &&
        error.code !== "BRAND_STORE_TOPOLOGY_INPUT_INVALID" &&
        !callbackError
      )
        callbackError = error;
    };
    try {
      capture();
      const origin = String(parseCanonicalInstant(now.call(persistence))),
        originalUntil = new Date(Date.parse(origin) + 5000).toISOString();
      let latest = origin,
        deadline = originalUntil,
        failed = false;
      function check() {
        capture();
        const at = String(parseCanonicalInstant(now.call(persistence)));
        if (failed || at < latest || at >= deadline) return fail();
        latest = at;
        return at;
      }
      function tighten(value: unknown) {
        const until = String(parseCanonicalInstant(value));
        if (until < deadline) deadline = until;
        check();
      }
      let expected: BrandStoreTopologyActorScope | undefined,
        expectedBrand: string,
        command:
          | ReturnType<typeof parseBrandStoreTopologySave>
          | ReturnType<typeof parseBrandStoreTopologyResolve>
          | null;
      try {
        const r = readClosedRecord(
          input,
          mode === "Workspace"
            ? [
                "sessionCookie",
                "csrf",
                "expectedBrandReference",
                ...(Object.hasOwn(input, "expectedScope") ? ["expectedScope"] : []),
              ]
            : ["sessionCookie", "csrf", "expectedScope", "command"],
        );
        expected = r.expectedScope === undefined ? undefined : scope(r.expectedScope);
        if (mode === "Workspace") {
          expectedBrand = parseBrandReference(r.expectedBrandReference);
          command = null;
        } else {
          if (!expected) return fail("BRAND_STORE_TOPOLOGY_INPUT_INVALID");
          expectedBrand = expected.brandReference;
          command =
            mode === "Save"
              ? parseBrandStoreTopologySave(r.command)
              : parseBrandStoreTopologyResolve(r.command);
        }
      } catch (error) {
        if (error instanceof BrandStoreTopologyError) throw error;
        return fail("BRAND_STORE_TOPOLOGY_INPUT_INVALID");
      }
      const authenticated = await auth.call(authentication, {
        sessionCookie: input.sessionCookie,
        csrf: input.csrf,
      });
      check();
      const session = parseBrandReference(authenticated.sessionReference);
      let finalized: (() => void) | undefined;
      const result = await host.transactions.run(async (tx) => {
        const query = tx.query,
          policy = createPostgresTransactionCurrentPermissionPolicySource(tx),
          resolveBrand = createMerchantBrandScope(persistence, policy);
        const brand = await resolveBrand(tx, input.sessionCookie, session);
        check();
        const fixed = Object.freeze({
          tenantReference: parsePlatformTenantReference(brand.tenantReference),
          brandReference: parseBrandReference(brand.context.brand.brandReference),
          actorReference: parseBrandReference(String(brand.actorReference)),
        });
        if (
          fixed.brandReference !== expectedBrand ||
          (expected && !same(expected, fixed)) ||
          (command &&
            (command.tenantReference !== fixed.tenantReference ||
              command.brandReference !== fixed.brandReference ||
              command.actorReference !== fixed.actorReference))
        )
          return fail("BRAND_STORE_TOPOLOGY_PERMISSION_DENIED");
        const batch = brand.authorizeActionsWithValidity,
          selectedStoreReference = parseStoreReference(brand.selectedStoreReference),
          resolveStore = createMerchantStoreScope(persistence, policy);
        function checkTx() {
          check();
          if (
            tx.query !== query ||
            brand.authorizeActionsWithValidity !== batch ||
            brand.tenantReference !== fixed.tenantReference ||
            String(brand.context.brand.brandReference) !== fixed.brandReference ||
            String(brand.actorReference) !== fixed.actorReference ||
            brand.selectedStoreReference !== selectedStoreReference
          )
            return fail();
        }
        async function bareFresh() {
          checkTx();
          const decisions = await batch.call(brand, ["organization.manage"]);
          checkTx();
          if (!decisions || decisions.decisions.length !== 1) return fail();
          const decision = decisions.decisions[0];
          const packet = readClosedRecord(decision, [
              "effect",
              "reason",
              "source",
              "action",
              "scopeKind",
              "policySnapshotReference",
              "policyVersion",
              "audit",
            ]),
            audit = readClosedRecord(packet.audit, ["effect", "reason", "source"]);
          parsePolicyReference(packet.policySnapshotReference);
          parsePolicyVersion(packet.policyVersion);
          if (
            packet.effect !== "Allow" ||
            packet.scopeKind !== "Brand" ||
            packet.action !== "organization.manage" ||
            !(
              (packet.reason === "ROLE_PERMISSION" && packet.source === "RolePermission") ||
              (packet.reason === "EXPLICIT_ALLOW" && packet.source === "ExplicitAllow")
            ) ||
            audit.effect !== packet.effect ||
            audit.reason !== packet.reason ||
            audit.source !== packet.source
          )
            return fail("BRAND_STORE_TOPOLOGY_PERMISSION_DENIED");
          if (decisions.validUntil !== null) tighten(decisions.validUntil);
          checkTx();
          if (!decision) return fail();
          return decision;
        }
        async function fresh() {
          await bareFresh();
          if (capability) {
            await capability.holdUntilCommit();
            tighten(capability.leaseDeadline());
          }
          checkTx();
        }
        await bareFresh();
        const intentDigest = command
          ? command.profile === "BrandStoreTopologySaveV1"
            ? hash(command)
            : command.intentDigest
          : hash({ profile: "BrandStoreTopologyWorkbenchRequestV1", ...fixed });
        const storeSource = createPostgresTenantStoreReferenceSource({
          brandReference: fixed.brandReference,
          transactions: {
            async run<T>(work: (actual: TenantStoreReferenceTransaction) => Promise<T>) {
              checkTx();
              const result = await work(tx);
              checkTx();
              return result;
            },
          },
          authority: {
            async withCurrentBrandReferenceRead<T>(
              request: TenantStoreReferenceRequest,
              work: () => Promise<T>,
            ) {
              try {
                validateRequest(request);
                await fresh();
                const result = await work();
                await fresh();
                checkTx();
                return result;
              } catch (error) {
                retain(error);
                failed = true;
                throw error;
              }
            },
            async isCurrent(actual, request) {
              try {
                if (actual !== tx) return fail();
                validateRequest(request);
                await fresh();
                // Current Store capability admission leaves selected Store RLS.
                // Restore the actual Brand-only context required by the owning
                // complete Tenant roster before its next projection read.
                await tx.query(
                  "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
                  [fixed.brandReference],
                );
                checkTx();
                return true;
              } catch (error) {
                retain(error);
                failed = true;
                throw error;
              }
            },
          },
        });
        function validateRequest(value: unknown) {
          const request = parseTenantStoreReferenceRequest(value);
          if (
            request.brandReference !== fixed.brandReference ||
            request.actorReference !== fixed.actorReference ||
            request.purposeCode !== "BRAND_STORE_TOPOLOGY_DRAFT" ||
            request.originalIntentDigest !== intentDigest ||
            request.observedAt < origin ||
            request.observedAt > check()
          )
            return fail();
          checkTx();
          return request;
        }
        const request = (observedAt: string) =>
          parseTenantStoreReferenceRequest({
            brandReference: fixed.brandReference,
            actorReference: fixed.actorReference,
            purposeCode: "BRAND_STORE_TOPOLOGY_DRAFT",
            originalIntentDigest: intentDigest,
            observedAt,
          });
        const baselineState: { value?: BrandStoreTopologyWorkbench } = {};
        let parentDone = false,
          finalDone = false;
        // Register before child owner/source use. Its Checks rereads do not create children.
        await host.registerBeforeCommit(
          tx,
          async () => {
            try {
              await fresh();
              if (baselineState.value) {
                const current = await owner.readCurrent(),
                  history = await owner.readHistory(),
                  stores = await labels();
                if (
                  !same(current.current, baselineState.value.current.current) ||
                  !same(history, baselineState.value.history) ||
                  !same(labelFacts(stores), labelFacts(baselineState.value.stores))
                )
                  return fail("BRAND_STORE_TOPOLOGY_VERSION_CONFLICT");
              }
              checkTx();
              parentDone = true;
            } catch (error) {
              retain(error);
              failed = true;
              throw error;
            }
          },
          () => {
            if (!parentDone || finalDone) return fail();
            checkTx();
            finalDone = true;
          },
        );
        const capability = createMerchantBrandStoreTopologyCapability({
          transaction: tx,
          scope: fixed,
          selectedStoreReference,
          clock: { now: check },
          originalObservedAt: origin,
          originalValidUntil: deadline,
          registerBeforeCommit: host.registerBeforeCommit,
          async holdCurrentBrandAuthority(actual, packet) {
            readClosedRecord(packet, [
              "scope",
              "selectedStoreReference",
              "permission",
              "purposeCode",
              "requiredFields",
              "observedAt",
              "validUntil",
            ]);
            if (
              actual !== tx ||
              !same(packet.scope, fixed) ||
              packet.selectedStoreReference !== selectedStoreReference ||
              packet.permission !== "organization.manage" ||
              packet.purposeCode !== "STORE_CAPABILITY_EVALUATION" ||
              !same(packet.requiredFields, merchantBrandStoreTopologyCapabilityRequiredFields) ||
              packet.observedAt < origin ||
              packet.observedAt > check() ||
              packet.validUntil > originalUntil
            )
              return fail();
            tighten(packet.validUntil);
            const permission = await bareFresh();
            const selected = await resolveStore(
              tx,
              input.sessionCookie,
              "merchant.access",
              session,
            );
            if (
              !(await selected.allowed()) ||
              selected.selected.tenantReference !== fixed.tenantReference ||
              String(selected.context.brand.brandReference) !== fixed.brandReference ||
              String(selected.actorReference) !== fixed.actorReference ||
              String(selected.store.storeReference) !== selectedStoreReference
            )
              return fail("BRAND_STORE_TOPOLOGY_PERMISSION_DENIED");
            const until = selected.authorizationValidUntil();
            if (until !== null) tighten(until);
            checkTx();
            return Object.freeze({
              scope: fixed,
              selectedStoreReference,
              tenantContext: selected.context,
              permission,
              validUntil: deadline,
            });
          },
        });
        await fresh();
        const ownerOptions: BrandStoreTopologyDraftStoreOptions = {
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
            hashIntent: (text) => "sha256:" + sha256Hex(text),
            nextReference: () => {
              checkTx();
              const ref = parseBrandReference(next.call(options));
              checkTx();
              return ref;
            },
          },
          authority: {
            async holdUntilTransactionCompletes(actual, packet) {
              readClosedRecord(packet, [
                "tenantReference",
                "brandReference",
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
                packet.tenantReference !== fixed.tenantReference ||
                packet.brandReference !== fixed.brandReference ||
                packet.actorReference !== fixed.actorReference ||
                packet.permission !== "organization.manage" ||
                packet.purposeCode !== "BRAND_STORE_TOPOLOGY_DRAFT" ||
                packet.mode !== (mode === "Workspace" ? "Read" : mode) ||
                !same(packet.requiredFields, brandStoreTopologyDraftRequiredFields) ||
                !same(packet.command, command) ||
                packet.observedAt < origin ||
                packet.observedAt > check() ||
                packet.validUntil > originalUntil
              )
                return fail();
              tighten(packet.validUntil);
              await fresh();
              return Object.freeze({ validUntil: deadline });
            },
          },
          async appendAudit(actual, packet) {
            readClosedRecord(packet, [
              "tenantReference",
              "brandReference",
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
              !command ||
              packet.tenantReference !== fixed.tenantReference ||
              packet.brandReference !== fixed.brandReference ||
              packet.actorReference !== fixed.actorReference ||
              packet.operationReference !== command.operationReference ||
              packet.intentDigest !== intentDigest ||
              packet.purposeCode !== "BRAND_STORE_TOPOLOGY_DRAFT" ||
              packet.mode !== (mode === "Save" ? "Save" : "Abandon") ||
              packet.occurredAt < origin ||
              packet.occurredAt > check()
            )
              return fail();
            await fresh();
            const audit = validateAuditRecord(
              {
                auditId: packet.auditReference,
                brandId: fixed.brandReference,
                actor: { type: "User", reference: fixed.actorReference },
                actionCode:
                  packet.mode === "Save"
                    ? "BRAND_STORE_TOPOLOGY_DRAFT_SAVED"
                    : "BRAND_STORE_TOPOLOGY_ORIGINAL_ABANDONED",
                targetType: "BrandStoreTopologyDraft",
                targetId: packet.operationReference,
                afterSummary: { intentDigest },
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
            // Brand-scoped Audit must run after restoring Brand RLS; genuine
            // Feature admission above uses the actual selected Store context.
            await tx.query(
              "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
              [fixed.brandReference],
            );
            checkTx();
            await appendAuditRecordInTransaction(tx, audit);
            checkTx();
          },
          async withCurrentStoreReferences<T>(
            actual: Parameters<
              BrandStoreTopologyDraftStoreOptions["withCurrentStoreReferences"]
            >[0],
            packet: Parameters<
              BrandStoreTopologyDraftStoreOptions["withCurrentStoreReferences"]
            >[1],
            work: (snapshot: TenantStoreReferenceSnapshot) => Promise<T>,
          ) {
            readClosedRecord(packet, [
              "tenantReference",
              "brandReference",
              "actorReference",
              "observedAt",
              "validUntil",
            ]);
            if (
              actual !== tx ||
              packet.tenantReference !== fixed.tenantReference ||
              packet.brandReference !== fixed.brandReference ||
              packet.actorReference !== fixed.actorReference ||
              packet.observedAt < origin ||
              packet.observedAt > check() ||
              packet.validUntil > originalUntil
            )
              return fail();
            tighten(packet.validUntil);
            await fresh();
            return storeSource.withCurrentSnapshot(request(packet.observedAt), work);
          },
        };
        const owner = createPostgresBrandStoreTopologyDraftStore(ownerOptions);
        function labelFacts(value: TenantStoreLabelReferenceSnapshot) {
          const { observedAt, originalIntentDigest, ...facts } = value;
          void observedAt;
          void originalIntentDigest;
          return facts;
        }
        async function labels() {
          let calls = 0;
          const completion: { value?: { result: TenantStoreLabelReferenceSnapshot } } = {};
          const result = await storeSource.withCurrentLabelSnapshot(
            request(check()),
            async (value) => {
              if (++calls !== 1) return fail();
              const parsed = parseTenantStoreLabelReferenceSnapshot(value);
              if (
                parsed.brandReference !== fixed.brandReference ||
                parsed.originalIntentDigest !== intentDigest ||
                parsed.observedAt > check()
              )
                return fail();
              const answer = { result: parsed };
              completion.value = answer;
              return answer;
            },
          );
          if (calls !== 1 || !completion.value || result !== completion.value) return fail();
          checkTx();
          return completion.value.result;
        }
        finalized = () => {
          if (!parentDone || !finalDone) return fail();
          tighten(owner.assertFinalized(tx));
          if (!capability) return fail();
          capability.assertFinalized();
          tighten(capability.leaseDeadline());
          checkTx();
        };
        if (mode === "Save") return owner.save(command);
        if (mode === "Resolve") return owner.resolve(command);
        const current = await owner.readCurrent(),
          history = await owner.readHistory(),
          stores = await labels(),
          observedAt = check();
        const baseline: BrandStoreTopologyWorkbench = Object.freeze({
          profile: "BrandStoreTopologyWorkbenchV1",
          ...fixed,
          current,
          history: Object.freeze(history.map(parseBrandStoreTopologyDraftRevision)),
          stores,
          observedAt,
          validUntil: deadline,
          status: "DraftOnly",
        });
        baselineState.value = baseline;
        return baseline;
      });
      if (!finalized) return fail();
      finalized();
      if ("status" in result)
        return parseBrandStoreTopologyWorkbench(
          {
            ...result,
            current: parseBrandStoreTopologyCurrent(
              { ...result.current, validUntil: deadline },
              check(),
            ),
            validUntil: deadline,
          },
          check(),
        );
      return parseBrandStoreTopologyOperationReceipt(result);
    } catch (error) {
      return bounded(callbackError ?? error);
    }
  }
  return Object.freeze({
    workspace: async (
      input: MerchantBrandStoreTopologyWorkspaceInput,
    ): Promise<BrandStoreTopologyWorkbench> => {
      const result = await perform("Workspace", input);
      if (!("status" in result)) return fail();
      return result;
    },
    save: async (input: MerchantBrandStoreTopologyWriteInput) => {
      const result = await perform("Save", input);
      if ("status" in result) return fail();
      return result;
    },
    resolve: async (input: MerchantBrandStoreTopologyWriteInput) => {
      const result = await perform("Resolve", input);
      if ("status" in result) return fail();
      return result;
    },
  });
}
