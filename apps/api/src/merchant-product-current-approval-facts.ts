import { readClosedRecord } from "@bop/identity";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  bindCatalogProductValidationToPolicy,
  copyCategoryPersistenceValue,
  createPostgresProductPublicationSourceStore,
  parseCatalogInstant,
  parseProductPublicationCommand,
  parseProductPublicationVersion,
  parseProductPublicationValidation,
  productApprovalSourceFields,
  type ProductPublicationStoreOptions,
} from "@rms/catalog";
import {
  createCurrentProductPublicationPolicySource,
  currentProductPolicyFields,
} from "./current-product-publication-policy.js";
import { createCurrentProductApprovalSource } from "./current-product-approval.js";

type ApprovalOptions = Parameters<typeof createPostgresProductPublicationSourceStore>[0];
type PolicyOptions = Parameters<typeof createCurrentProductPublicationPolicySource>[0];
type FactsPort = ProductPublicationStoreOptions["sources"]["withHeldCurrentFacts"];
export interface MerchantProductCurrentApprovalConfiguration {
  readonly approvalAuthority: NonNullable<ApprovalOptions["approvalAuthority"]>;
  readonly policyAuthority: PolicyOptions["authority"];
}
export function captureMerchantProductCurrentApprovalConfiguration(
  value: MerchantProductCurrentApprovalConfiguration,
): MerchantProductCurrentApprovalConfiguration {
  if (
    typeof value?.approvalAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof value?.policyAuthority?.holdUntilTransactionCompletes !== "function"
  )
    return fail();
  return Object.freeze({
    approvalAuthority: Object.freeze({
      holdUntilTransactionCompletes: value.approvalAuthority.holdUntilTransactionCompletes.bind(
        value.approvalAuthority,
      ),
    }),
    policyAuthority: Object.freeze({
      holdUntilTransactionCompletes: value.policyAuthority.holdUntilTransactionCompletes.bind(
        value.policyAuthority,
      ),
    }),
  });
}
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
/** Owning original approval/current policy only; remaining validation, topology,
 * references and full field/Phase/write authority remain independently mandatory. */
export function createMerchantProductCurrentApprovalFacts(options: {
  readonly configuration: MerchantProductCurrentApprovalConfiguration;
  readonly sources: ProductPublicationStoreOptions["sources"];
  readonly transaction: Parameters<FactsPort>[0];
  readonly command: Parameters<FactsPort>[1]["command"];
  readonly clock: { now(): string };
  readonly assertAdmission: (approvalReadRequired: boolean) => Promise<void>;
}) {
  const configuration = captureMerchantProductCurrentApprovalConfiguration(options.configuration);
  if (
    typeof options.sources?.withHeldCurrentFacts !== "function" ||
    typeof options.transaction?.query !== "function" ||
    typeof options.clock?.now !== "function" ||
    typeof options.assertAdmission !== "function"
  )
    return fail();
  const tx = options.transaction,
    query = tx.query,
    command = parseProductPublicationCommand(copyCategoryPersistenceValue(options.command)),
    now = options.clock.now.bind(options.clock),
    admission = options.assertAdmission,
    remaining = options.sources.withHeldCurrentFacts.bind(options.sources),
    observedAt = parseCatalogInstant(now()),
    validUntil = new Date(Date.parse(observedAt) + 5000).toISOString();
  if (
    command.actorKind !== "User" ||
    !["Publish", "SchedulePublish", "ReschedulePublish"].includes(command.action)
  )
    return fail();
  let failed = false,
    active = false,
    latest = observedAt,
    approvalRequired = false;
  let sourceValidUntil: string | undefined,
    heldApproval:
      | Parameters<
          NonNullable<ApprovalOptions["approvalAuthority"]>["holdUntilTransactionCompletes"]
        >[1]
      | undefined,
    heldPolicy:
      Parameters<PolicyOptions["authority"]["holdUntilTransactionCompletes"]>[1] | undefined;
  const check = () => {
    const at = parseCatalogInstant(now());
    if (
      failed ||
      tx.query !== query ||
      at < latest ||
      at >= validUntil ||
      (sourceValidUntil !== undefined && at >= sourceValidUntil)
    )
      return fail();
    latest = at;
    return at;
  };
  const assertNative = async () => {
    try {
      check();
      await admission(approvalRequired);
      check();
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError) throw error;
      return fail();
    }
  };
  const assertCurrent = async () => {
    try {
      await assertNative();
      if (
        heldApproval &&
        (await configuration.approvalAuthority.holdUntilTransactionCompletes(tx, {
          ...heldApproval,
          observedAt: check(),
        })) !== undefined
      )
        return fail();
      await assertNative();
      if (
        heldPolicy &&
        (await configuration.policyAuthority.holdUntilTransactionCompletes(tx, {
          ...heldPolicy,
          observedAt: check(),
        })) !== undefined
      )
        return fail();
      await assertNative();
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError) throw error;
      return fail();
    }
  };
  const approvalSource = createPostgresProductPublicationSourceStore({
    tenantReference: command.tenantReference,
    brandReference: command.brandReference,
    actorReference: command.actorReference,
    actorKind: "User",
    clock: { now: check },
    transactions: { run: (work) => work(tx) },
    authority: {
      async holdUntilTransactionCompletes() {
        return fail();
      },
    },
    approvalAuthority: {
      async holdUntilTransactionCompletes(actual, input) {
        if (
          actual !== tx ||
          input.tenantReference !== command.tenantReference ||
          input.brandReference !== command.brandReference ||
          input.actorReference !== command.actorReference ||
          input.productReference !== command.productReference ||
          input.actorKind !== "User" ||
          input.purposeCode !== "CATALOG_PRODUCT_APPROVAL_SOURCE" ||
          input.permission !== "catalog.manage" ||
          input.owningAction !== "catalog.product.approval.read" ||
          JSON.stringify(input.requiredFields) !== JSON.stringify(productApprovalSourceFields)
        )
          return fail();
        approvalRequired = true;
        await assertNative();
        const captured = Object.freeze({ ...input, requiredFields: productApprovalSourceFields });
        if (
          (await configuration.approvalAuthority.holdUntilTransactionCompletes(tx, input)) !==
          undefined
        )
          return fail();
        heldApproval = captured;
        await assertNative();
      },
    },
  });
  const owningPolicySource = createCurrentProductPublicationPolicySource({
    tenantReference: command.tenantReference,
    brandReference: command.brandReference,
    actorReference: command.actorReference,
    actorKind: "User",
    clock: { now: check },
    authority: {
      async holdUntilTransactionCompletes(actual, input) {
        if (
          actual !== tx ||
          input.tenantReference !== command.tenantReference ||
          input.brandReference !== command.brandReference ||
          input.actorReference !== command.actorReference ||
          input.actorKind !== "User" ||
          input.purposeCode !== "CATALOG_PRODUCT_VERSION_PUBLICATION" ||
          JSON.stringify(input.requiredFields) !== JSON.stringify(currentProductPolicyFields)
        )
          return fail();
        await assertNative();
        const captured = Object.freeze({ ...input, requiredFields: currentProductPolicyFields });
        if (
          (await configuration.policyAuthority.holdUntilTransactionCompletes(tx, input)) !==
          undefined
        )
          return fail();
        heldPolicy = captured;
        await assertNative();
      },
    },
  });
  let heldValidation: unknown;
  let policyChecks = 0;
  const withCurrentPolicy: typeof owningPolicySource.withCurrentPolicy = async (
    actual,
    input,
    work,
  ) =>
    owningPolicySource.withCurrentPolicy(actual, input, async (proof) => {
      if (actual !== tx || heldValidation === undefined || ++policyChecks !== 1) return fail();
      bindCatalogProductValidationToPolicy(heldValidation, proof.content, {
        tenantReference: command.tenantReference,
        brandReference: command.brandReference,
      });
      return work(proof);
    });
  const policySource = Object.freeze({ ...owningPolicySource, withCurrentPolicy });
  const approval = createCurrentProductApprovalSource({
    approvalSource,
    policySource,
    clock: { now: check },
  });
  const withHeldCurrentFacts: FactsPort = async (actual, input, work) => {
    try {
      if (actual !== tx || active || canonicalCommand(input.command) !== canonicalCommand(command))
        return fail();
      active = true;
      await assertNative();
      let calls = 0,
        completed: { value: Awaited<ReturnType<typeof work>> } | undefined,
        conflict: CatalogError | undefined;
      const result = await remaining(tx, input, async (value) => {
        if (++calls !== 1) return fail();
        const facts = readClosedRecord(copyCategoryPersistenceValue(value), [
          "now",
          "productAggregateVersion",
          "contentDigest",
          "configurationDigest",
          "scopeDigest",
          "periodDigest",
          "validation",
          "approval",
          "reviewReference",
          "replacement",
        ]);
        if (facts.approval !== null) return fail();
        const validation = parseProductPublicationValidation(facts.validation);
        heldValidation = validation;
        policyChecks = 0;
        const run = async (originalApproval: unknown) => {
          if (policyChecks !== 1) return fail();
          await assertNative();
          try {
            completed = {
              value: await work({ ...facts, validation, approval: originalApproval } as Parameters<
                typeof work
              >[0]),
            };
          } catch (error) {
            if (!(error instanceof CatalogError) || error.code !== "CATALOG_LIFECYCLE_CONFLICT")
              throw error;
            conflict = error;
            completed = { value: undefined as never };
          }
          await assertNative();
          return completed;
        };
        let sourceCalls = 0,
          inner;
        if (validation.approvalPolicy === "Required") {
          approvalRequired = true;
          await assertNative();
          inner = await approval.withCurrentApproval(
            tx,
            {
              productReference: command.productReference,
              versionReference: command.versionReference,
              expectedAggregateVersion: command.expectedProductAggregateVersion,
              expectedPublicationVersion: command.expectedPublicationVersion,
              contentDigest: command.contentDigest,
              configurationDigest: command.configurationDigest,
              scopeDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(command.scopeSet)),
              periodDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(command.effectivePeriod)),
              policyReference: validation.policyReference,
              policyVersion: validation.policyVersion,
              originalIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(command)),
              observedAt,
              validUntil,
            },
            async (proof) => {
              if (++sourceCalls !== 1) return fail();
              sourceValidUntil = parseCatalogInstant(proof.validUntil);
              return run(proof.receipt.approval);
            },
          );
        } else {
          inner = await policySource.withCurrentPolicy(
            tx,
            {
              policyReference: validation.policyReference,
              policyVersion: validation.policyVersion,
              observedAt,
            },
            async (proof) => {
              if (++sourceCalls !== 1 || proof.content.approvalPolicy !== "NotRequired")
                return fail();
              sourceValidUntil = parseCatalogInstant(proof.validUntil);
              return run(null);
            },
          );
        }
        if (sourceCalls !== 1 || !completed || inner !== completed) return fail();
        return completed;
      });
      await assertCurrent();
      if (calls !== 1 || !completed || result !== completed) return fail();
      if (conflict) throw conflict;
      return completed.value;
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError) throw error;
      return fail();
    } finally {
      active = false;
    }
  };
  return Object.freeze({
    sources: Object.freeze({
      withHeldCurrentFacts,
      ...(options.sources.withHeldScopePolicy === undefined
        ? {}
        : { withHeldScopePolicy: options.sources.withHeldScopePolicy.bind(options.sources) }),
    }),
    assertCurrent,
    async assertReceiptAdmission(value: unknown) {
      try {
        const receipt = parseProductPublicationVersion(copyCategoryPersistenceValue(value));
        if (
          receipt.tenantReference !== command.tenantReference ||
          receipt.brandReference !== command.brandReference ||
          receipt.actorReference !== command.actorReference ||
          receipt.actorKind !== "User" ||
          receipt.productReference !== command.productReference ||
          receipt.versionReference !== command.versionReference ||
          receipt.operationReference !== command.operationReference
        )
          return fail();
        if (receipt.approvalPolicy === "Required") approvalRequired = true;
        else if (approvalRequired) return fail();
        await assertCurrent();
      } catch (error) {
        failed = true;
        if (error instanceof CatalogError) throw error;
        return fail();
      }
    },
  });
}
function canonicalCommand(value: unknown) {
  return canonicalizeRfc8785(parseProductPublicationCommand(copyCategoryPersistenceValue(value)));
}
