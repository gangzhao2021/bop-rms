import { validateAuditRecord, type AppendAuditRecordInput } from "@bop/audit";
import { revalidateTenantContext } from "@bop/permission";
import {
  createTaxConfigurationSnapshot,
  validateTaxConfigurationCoverage,
  type TaxConfigurationSnapshot,
} from "../domain/tax-configuration.js";
import {
  parsePricingDigest,
  parsePricingReference,
  type PricingReference,
} from "../domain/money-tax-contract.js";
import type {
  TaxConfigAction,
  TaxConfigEvent,
  TaxConfigOperationRecord,
  TaxConfigPorts,
} from "./ports/tax-config-ports.js";

export type TaxConfigWorkflowErrorCode =
  | "TAX_CONFIG_INPUT_INVALID"
  | "TAX_CONFIG_PERMISSION_DENIED"
  | "TAX_CONFIG_APPROVAL_REQUIRED"
  | "TAX_CONFIG_VERSION_CONFLICT"
  | "TAX_CONFIG_IDEMPOTENCY_CONFLICT"
  | "TAX_CONFIG_LIFECYCLE_CONFLICT"
  | "TAX_CONFIG_FIXTURE_INVALID"
  | "TAX_CONFIG_DEPENDENCY_UNAVAILABLE";

export class TaxConfigWorkflowError extends Error {
  constructor(readonly code: TaxConfigWorkflowErrorCode) {
    super("Tax Configuration operation is unavailable");
    this.name = "TaxConfigWorkflowError";
  }
}

const invalid = (): never => {
  throw new TaxConfigWorkflowError("TAX_CONFIG_INPUT_INVALID");
};

function exact(value: unknown, keys: readonly string[]): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    invalid();
  const own = Reflect.ownKeys(value as object);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key))
  )
    invalid();
}

function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return invalid();
  return value;
}

function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}

function dependency(error: unknown): never {
  if (
    error instanceof TaxConfigWorkflowError &&
    ["TAX_CONFIG_VERSION_CONFLICT", "TAX_CONFIG_IDEMPOTENCY_CONFLICT"].includes(error.code)
  )
    throw error;
  throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
}

function makeEvent(
  action: TaxConfigAction,
  aggregate: TaxConfigurationSnapshot,
  at: string,
): TaxConfigEvent {
  const types: Record<TaxConfigAction, TaxConfigEvent["eventType"]> = {
    CreateDraft: "TaxConfigDraftCreated",
    ReplaceDraft: "TaxConfigDraftReplaced",
    Publish: "TaxConfigPublished",
  };
  return Object.freeze({
    eventType: types[action],
    configurationReference: aggregate.configurationReference,
    versionReference: aggregate.versionReference,
    brandReference: aggregate.brandReference,
    storeReference: aggregate.storeReference,
    aggregateVersion: aggregate.aggregateVersion,
    lifecycle: aggregate.lifecycle,
    jurisdictionCode: aggregate.jurisdictionCode,
    snapshotDigest: aggregate.snapshotDigest,
    occurredAt: at,
  });
}

async function authorize(
  ports: TaxConfigPorts,
  action: TaxConfigAction,
  operationReference: PricingReference,
  configurationReference: PricingReference,
  at: string,
): Promise<{
  actor: PricingReference;
  brand: PricingReference;
  store: PricingReference;
  audit: AppendAuditRecordInput;
  approval: boolean;
  author: PricingReference | null;
}> {
  const evidence = await ports.authorization
    .authorize({ action, operationReference, configurationReference, observedAt: at })
    .catch(dependency);
  if (evidence === null) throw new TaxConfigWorkflowError("TAX_CONFIG_PERMISSION_DENIED");
  try {
    const context = revalidateTenantContext(evidence.tenantContext);
    const audit = validateAuditRecord(evidence.audit, Date.parse(at));
    const actor = context.actor.actorReference;
    const store = context.store?.storeReference;
    if (
      context.scopeKind !== "Store" ||
      actor === null ||
      store === undefined ||
      evidence.permission.effect !== "Allow" ||
      evidence.permission.action !== "pricing.tax-config.manage" ||
      evidence.permission.scopeKind !== "Store" ||
      audit.actor.type === "System" ||
      audit.actor.reference !== actor ||
      audit.brandId !== context.brand.brandReference ||
      audit.storeId !== store ||
      audit.actionCode !== `PRICING_TAX_CONFIG_${action.toUpperCase()}` ||
      audit.targetType !== "PricingTaxConfiguration" ||
      audit.targetId !== configurationReference ||
      audit.occurredAt !== at
    )
      throw new Error("denied");
    return {
      actor: parsePricingReference(actor),
      brand: parsePricingReference(context.brand.brandReference),
      store: parsePricingReference(store),
      audit,
      approval:
        evidence.approvalPermission?.effect === "Allow" &&
        evidence.approvalPermission.action === "pricing.tax-config.approve" &&
        evidence.approvalPermission.scopeKind === "Store",
      author:
        evidence.draftAuthorActorReference === null
          ? null
          : parsePricingReference(evidence.draftAuthorActorReference),
    };
  } catch {
    throw new TaxConfigWorkflowError("TAX_CONFIG_PERMISSION_DENIED");
  }
}

export interface ExecuteTaxConfigInput {
  readonly action: TaxConfigAction;
  readonly operationReference: PricingReference;
  readonly expectedAggregateVersion: number | null;
  readonly candidate: TaxConfigurationSnapshot;
  readonly occurredAt: string;
}

export function createTaxConfigService(ports: TaxConfigPorts) {
  return Object.freeze({
    async execute(input: ExecuteTaxConfigInput) {
      exact(input, [
        "action",
        "operationReference",
        "expectedAggregateVersion",
        "candidate",
        "occurredAt",
      ]);
      if (!["CreateDraft", "ReplaceDraft", "Publish"].includes(input.action)) invalid();
      const at = instant(input.occurredAt);
      const operationReference = parsePricingReference(input.operationReference);
      const candidate = createTaxConfigurationSnapshot(input.candidate);
      const intent = parsePricingDigest(
        ports.references.hashIntent(
          JSON.stringify({ ...input, candidate: { ...candidate, rules: candidate.rules } }),
        ),
      );
      const prior = await ports.repository.resolveOperation(operationReference).catch(dependency);
      if (prior !== null) {
        if (!ports.references.equals(prior.operationIntentHash, intent))
          throw new TaxConfigWorkflowError("TAX_CONFIG_IDEMPOTENCY_CONFLICT");
        return Object.freeze({
          status: "AlreadyApplied" as const,
          aggregate: createTaxConfigurationSnapshot(prior.aggregate),
        });
      }
      const auth = await authorize(
        ports,
        input.action,
        operationReference,
        candidate.configurationReference,
        at,
      );
      if (candidate.brandReference !== auth.brand || candidate.storeReference !== auth.store)
        throw new TaxConfigWorkflowError("TAX_CONFIG_PERMISSION_DENIED");
      const current = await ports.repository
        .load(candidate.configurationReference)
        .catch(dependency);
      if (input.action === "CreateDraft") {
        if (
          input.expectedAggregateVersion !== null ||
          current !== null ||
          candidate.lifecycle !== "Draft" ||
          candidate.aggregateVersion !== 1
        )
          throw new TaxConfigWorkflowError("TAX_CONFIG_LIFECYCLE_CONFLICT");
      } else {
        const expected = positive(input.expectedAggregateVersion);
        if (current === null || current.aggregateVersion !== expected)
          throw new TaxConfigWorkflowError("TAX_CONFIG_VERSION_CONFLICT");
        if (
          candidate.aggregateVersion !== expected + 1 ||
          candidate.versionNumber !== current.versionNumber + 1 ||
          candidate.createdAt !== at
        )
          invalid();
        if (
          current.lifecycle !== "Draft" ||
          candidate.lifecycle !== (input.action === "Publish" ? "Published" : "Draft")
        )
          throw new TaxConfigWorkflowError("TAX_CONFIG_LIFECYCLE_CONFLICT");
      }
      if (!(await ports.facts.validate(candidate).catch(dependency)))
        throw new TaxConfigWorkflowError("TAX_CONFIG_FIXTURE_INVALID");
      if (input.action === "Publish") {
        if (!auth.approval || auth.author === null || auth.author === auth.actor)
          throw new TaxConfigWorkflowError("TAX_CONFIG_APPROVAL_REQUIRED");
        const coverage = await ports.facts.requiredCoverage(candidate).catch(dependency);
        validateTaxConfigurationCoverage(candidate, coverage);
        if (!(await ports.facts.validateApprovedFixtures(candidate).catch(dependency)))
          throw new TaxConfigWorkflowError("TAX_CONFIG_FIXTURE_INVALID");
      }
      const record: TaxConfigOperationRecord = Object.freeze({
        action: input.action,
        operationReference,
        operationIntentHash: intent,
        aggregate: candidate,
        event: makeEvent(input.action, candidate, at),
      });
      const saved =
        input.action === "CreateDraft"
          ? await ports.repository.create({ record, audit: auth.audit }).catch(dependency)
          : await ports.repository
              .commit({
                record,
                expectedAggregateVersion: positive(input.expectedAggregateVersion),
                audit: auth.audit,
              })
              .catch(dependency);
      const savedAggregate = createTaxConfigurationSnapshot(saved.aggregate);
      if (
        saved.action !== record.action ||
        saved.operationReference !== record.operationReference ||
        !ports.references.equals(saved.operationIntentHash, record.operationIntentHash) ||
        savedAggregate.configurationReference !== candidate.configurationReference ||
        savedAggregate.aggregateVersion !== candidate.aggregateVersion ||
        JSON.stringify(saved.event) !== JSON.stringify(record.event)
      )
        throw new TaxConfigWorkflowError("TAX_CONFIG_DEPENDENCY_UNAVAILABLE");
      return Object.freeze({ status: "Applied" as const, aggregate: savedAggregate });
    },
  });
}
