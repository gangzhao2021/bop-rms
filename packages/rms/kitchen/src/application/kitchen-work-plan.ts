import {
  type ConfirmedOrderIntakeReceipt,
  type KitchenPlanningSource,
  type KitchenPlanningSourceItem,
  type KitchenReference,
  type KitchenWorkPlan,
  createKitchenWorkPlanDigestBinding,
  parseKitchenPlanningSource,
  parseKitchenTicketDigest,
  parseKitchenTicketReference,
  parseKitchenWorkPlan,
} from "../domain/kitchen-ticket.js";
import {
  type KitchenPreparationEvidenceItem,
  type KitchenPreparationEvidenceSet,
  type KitchenStationRoutingCandidate,
  createKitchenPreparationEvidenceSetDigestBinding,
  createKitchenRoutingRuleDigestBinding,
  createKitchenStationRoutingCandidateSetDigestBinding,
  parseKitchenPreparationEvidenceSet,
  parseKitchenStationRoutingCandidateSetEvidence,
} from "../domain/station-routing.js";
import { parseConfirmedOrderIntakeReceipt } from "./confirmed-order-intake.js";
import type {
  KitchenWorkPlanPorts,
  ResolveKitchenStationRoutingEvidenceInput,
  ResolveRecipePreparationEvidenceInput,
} from "./ports/kitchen-work-plan-ports.js";

const placeholderDigest = `sha256:${"0".repeat(64)}`;
const dependencyUnavailableMessage = "kitchen work plan is unavailable";

function dependencyUnavailable(): never {
  throw new Error(dependencyUnavailableMessage);
}

function exactInput(value: unknown): Readonly<Record<"receipt" | "source", unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new TypeError("kitchen work plan input is invalid");
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.length !== 2 ||
    !keys.includes("receipt") ||
    !keys.includes("source") ||
    keys.some((key) => key !== "receipt" && key !== "source")
  )
    throw new TypeError("kitchen work plan input is invalid");
  const receipt = descriptors.receipt;
  const source = descriptors.source;
  if (
    receipt === undefined ||
    source === undefined ||
    !("value" in receipt) ||
    !("value" in source) ||
    receipt.get !== undefined ||
    receipt.set !== undefined ||
    source.get !== undefined ||
    source.set !== undefined ||
    !receipt.enumerable ||
    !source.enumerable
  )
    throw new TypeError("kitchen work plan input is invalid");
  return Object.freeze({ receipt: receipt.value, source: source.value });
}

function sourceMatchesReceipt(
  receipt: ConfirmedOrderIntakeReceipt,
  source: KitchenPlanningSource,
): boolean {
  return (
    receipt.brandReference === source.brandReference &&
    receipt.storeReference === source.storeReference &&
    receipt.orderReference === source.orderReference &&
    receipt.orderBatchReference === source.orderBatchReference &&
    receipt.confirmationReference === source.confirmationReference
  );
}

function stationRequest(
  receipt: ConfirmedOrderIntakeReceipt,
): ResolveKitchenStationRoutingEvidenceInput {
  return Object.freeze({
    actorType: "System",
    actorReference: null,
    action: "ResolveKitchenStationRoutingEvidence",
    purpose: "CreateKitchenWork",
    brandReference: receipt.brandReference,
    storeReference: receipt.storeReference,
    effectiveAt: receipt.confirmedAt,
  });
}

function preparationRequest(
  receipt: ConfirmedOrderIntakeReceipt,
  source: KitchenPlanningSource,
): ResolveRecipePreparationEvidenceInput {
  return Object.freeze({
    actorType: "System",
    actorReference: null,
    action: "ResolveRecipePreparationEvidence",
    purpose: "CreateKitchenWork",
    brandReference: receipt.brandReference,
    storeReference: receipt.storeReference,
    effectiveAt: receipt.confirmedAt,
    sourceEvidenceReference: source.sourceEvidenceReference,
    sourceEvidenceVersion: source.sourceEvidenceVersion,
    sourceEvidenceDigest: source.sourceEvidenceDigest,
    items: source.items,
  });
}

function hash(ports: KitchenWorkPlanPorts, binding: string): string | null {
  let value: string;
  try {
    value = ports.digests.sha256(binding);
  } catch {
    return dependencyUnavailable();
  }
  try {
    return parseKitchenTicketDigest(value);
  } catch {
    return null;
  }
}

function sameOptions(
  left: KitchenPreparationEvidenceItem["selectedOptions"],
  right: KitchenPlanningSourceItem["selectedOptions"],
): boolean {
  const normalizedLeft = [...left].sort((first, second) =>
    first.optionReference < second.optionReference
      ? -1
      : first.optionReference > second.optionReference
        ? 1
        : 0,
  );
  const normalizedRight = [...right].sort((first, second) =>
    first.optionReference < second.optionReference
      ? -1
      : first.optionReference > second.optionReference
        ? 1
        : 0,
  );
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every(
      (option, index) =>
        option.optionReference === normalizedRight[index]?.optionReference &&
        option.quantity === normalizedRight[index]?.quantity,
    )
  );
}

function preparationMatchesSource(
  preparation: KitchenPreparationEvidenceItem,
  source: KitchenPlanningSourceItem,
): boolean {
  return (
    preparation.orderItemReference === source.orderItemReference &&
    preparation.ordinal === source.ordinal &&
    preparation.quantity === source.quantity &&
    preparation.productReference === source.productReference &&
    preparation.productVersionReference === source.productVersionReference &&
    preparation.skuReference === source.skuReference &&
    preparation.menuVersionReference === source.menuVersionReference &&
    preparation.sourceLineDigest === source.sourceLineDigest &&
    sameOptions(preparation.selectedOptions, source.selectedOptions)
  );
}

function verifyPreparations(
  ports: KitchenWorkPlanPorts,
  receipt: ConfirmedOrderIntakeReceipt,
  source: KitchenPlanningSource,
  evidence: KitchenPreparationEvidenceSet,
): ReadonlyMap<string, KitchenPreparationEvidenceItem> | null {
  if (
    evidence.brandReference !== receipt.brandReference ||
    evidence.storeReference !== receipt.storeReference ||
    evidence.effectiveAt !== receipt.confirmedAt ||
    evidence.items.length !== source.items.length
  )
    return null;
  const expectedDigest = hash(ports, createKitchenPreparationEvidenceSetDigestBinding(evidence));
  if (expectedDigest === null || expectedDigest !== evidence.evidenceDigest) return null;
  const items = new Map(evidence.items.map((item) => [String(item.orderItemReference), item]));
  for (const sourceItem of source.items) {
    const preparation = items.get(sourceItem.orderItemReference);
    if (preparation === undefined || !preparationMatchesSource(preparation, sourceItem))
      return null;
  }
  return items;
}

function verifyCandidate(
  ports: KitchenWorkPlanPorts,
  receipt: ConfirmedOrderIntakeReceipt,
  value: unknown,
): Readonly<{
  evidence: ReturnType<typeof parseKitchenStationRoutingCandidateSetEvidence>;
  candidate: KitchenStationRoutingCandidate;
}> | null {
  let evidence;
  try {
    evidence = parseKitchenStationRoutingCandidateSetEvidence(value);
  } catch {
    return null;
  }
  if (
    evidence.brandReference !== receipt.brandReference ||
    evidence.storeReference !== receipt.storeReference ||
    evidence.effectiveAt !== receipt.confirmedAt ||
    evidence.candidates.length !== 1
  )
    return null;
  const setDigest = hash(ports, createKitchenStationRoutingCandidateSetDigestBinding(evidence));
  if (setDigest === null || setDigest !== evidence.evidenceDigest) return null;
  const candidate = evidence.candidates[0];
  if (
    candidate === undefined ||
    candidate.stationStatus !== "Active" ||
    candidate.routingRuleStatus !== "Active" ||
    candidate.selector.kind !== "AllPreparedItems" ||
    candidate.targetStationReference !== candidate.stationReference
  )
    return null;
  const ruleDigest = hash(
    ports,
    createKitchenRoutingRuleDigestBinding({
      brandReference: evidence.brandReference,
      storeReference: evidence.storeReference,
      effectiveAt: evidence.effectiveAt,
      candidate,
    }),
  );
  if (ruleDigest === null || ruleDigest !== candidate.routingRuleDigest) return null;
  return Object.freeze({ evidence, candidate });
}

function capabilitiesCover(
  candidate: KitchenStationRoutingCandidate,
  preparations: ReadonlyMap<string, KitchenPreparationEvidenceItem>,
): boolean {
  const available = new Set(candidate.stationCapabilityReferences);
  for (const preparation of preparations.values()) {
    if (
      preparation.requiredStationCapabilityReferences.some(
        (capability) => !available.has(capability),
      )
    )
      return false;
  }
  return true;
}

function observedReferences(input: {
  readonly receipt: ConfirmedOrderIntakeReceipt;
  readonly source: KitchenPlanningSource;
  readonly stationEvidence: ReturnType<typeof parseKitchenStationRoutingCandidateSetEvidence>;
  readonly preparationEvidence: KitchenPreparationEvidenceSet;
}): ReadonlySet<string> {
  const references = new Set<string>([
    input.receipt.sourceEventReference,
    input.receipt.brandReference,
    input.receipt.storeReference,
    input.receipt.orderReference,
    input.receipt.orderBatchReference,
    input.receipt.confirmationReference,
    input.receipt.correlationReference,
    input.source.sourceEvidenceReference,
    input.stationEvidence.evidenceReference,
    input.preparationEvidence.evidenceReference,
  ]);
  for (const item of input.source.items) {
    references.add(item.orderItemReference);
    references.add(item.productReference);
    references.add(item.productVersionReference);
    references.add(item.skuReference);
    references.add(item.menuVersionReference);
    for (const option of item.selectedOptions) references.add(option.optionReference);
  }
  for (const item of input.preparationEvidence.items) {
    references.add(item.preparationReference);
    for (const capability of item.requiredStationCapabilityReferences) references.add(capability);
  }
  for (const candidate of input.stationEvidence.candidates) {
    references.add(candidate.stationReference);
    references.add(candidate.routingRuleReference);
    references.add(candidate.targetStationReference);
    for (const capability of candidate.stationCapabilityReferences) references.add(capability);
  }
  return references;
}

export function createKitchenWorkPlanReferenceBinding(input: {
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly orderReference: KitchenReference;
  readonly orderBatchReference: KitchenReference;
  readonly confirmationReference: KitchenReference;
}): string {
  return JSON.stringify({
    brandReference: input.brandReference,
    storeReference: input.storeReference,
    orderReference: input.orderReference,
    orderBatchReference: input.orderBatchReference,
    confirmationReference: input.confirmationReference,
  });
}

export function createKitchenWorkPlanService(ports: KitchenWorkPlanPorts) {
  return Object.freeze({
    async resolve(value: unknown): Promise<KitchenWorkPlan | null> {
      let receipt: ConfirmedOrderIntakeReceipt;
      let source: KitchenPlanningSource;
      try {
        const raw = exactInput(value);
        receipt = parseConfirmedOrderIntakeReceipt(raw.receipt);
        source = parseKitchenPlanningSource(raw.source);
      } catch {
        return null;
      }
      if (!sourceMatchesReceipt(receipt, source)) return null;

      let stationValue: unknown | null;
      try {
        stationValue = await ports.stationRouting.resolve(stationRequest(receipt));
      } catch {
        return dependencyUnavailable();
      }
      if (stationValue === null) return null;
      const routing = verifyCandidate(ports, receipt, stationValue);
      if (routing === null) return null;
      const { candidate, evidence: stationEvidence } = routing;

      let preparationValue: unknown | null;
      try {
        preparationValue = await ports.preparations.resolve(preparationRequest(receipt, source));
      } catch {
        return dependencyUnavailable();
      }
      if (preparationValue === null) return null;
      let preparationEvidence: KitchenPreparationEvidenceSet;
      try {
        preparationEvidence = parseKitchenPreparationEvidenceSet(preparationValue);
      } catch {
        return null;
      }
      const preparations = verifyPreparations(ports, receipt, source, preparationEvidence);
      if (preparations === null || !capabilitiesCover(candidate, preparations)) return null;

      let derivedReference: string;
      try {
        derivedReference = ports.references.derive(
          "KitchenWorkPlan",
          createKitchenWorkPlanReferenceBinding(receipt),
        );
      } catch {
        return dependencyUnavailable();
      }
      let planReference: KitchenReference;
      try {
        planReference = parseKitchenTicketReference(derivedReference);
      } catch {
        return null;
      }
      if (
        observedReferences({ receipt, source, stationEvidence, preparationEvidence }).has(
          planReference,
        )
      )
        return null;

      const items: KitchenWorkPlan["items"][number][] = [];
      for (const sourceItem of source.items) {
        const preparation = preparations.get(sourceItem.orderItemReference);
        if (preparation === undefined) return null;
        items.push({
          orderItemReference: sourceItem.orderItemReference,
          splitOrdinal: 1,
          stationRouting: {
            stationReference: candidate.stationReference,
            routingRuleReference: candidate.routingRuleReference,
            routingRuleVersion: candidate.routingRuleVersion,
            routingRuleDigest: candidate.routingRuleDigest,
          },
          preparation: {
            preparationReference: preparation.preparationReference,
            preparationVersion: preparation.preparationVersion,
            preparationDigest: preparation.preparationDigest,
            instructions: preparation.instructions,
          },
        });
      }

      let draft: KitchenWorkPlan;
      try {
        draft = parseKitchenWorkPlan({
          planReference,
          brandReference: receipt.brandReference,
          storeReference: receipt.storeReference,
          orderReference: receipt.orderReference,
          orderBatchReference: receipt.orderBatchReference,
          confirmationReference: receipt.confirmationReference,
          sourceEvidenceDigest: source.sourceEvidenceDigest,
          planVersion: 1,
          generatedAt: receipt.confirmedAt,
          items,
          planDigest: placeholderDigest,
        });
      } catch {
        return null;
      }
      const planDigest = hash(ports, createKitchenWorkPlanDigestBinding(draft));
      if (planDigest === null) return null;
      try {
        return parseKitchenWorkPlan({ ...draft, planDigest });
      } catch {
        return null;
      }
    },
  });
}
