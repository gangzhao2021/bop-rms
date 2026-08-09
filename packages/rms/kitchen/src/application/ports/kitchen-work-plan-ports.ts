import type {
  KitchenDigest,
  KitchenInstant,
  KitchenPlanningSourceItem,
  KitchenReference,
} from "../../domain/kitchen-ticket.js";

export interface ResolveKitchenStationRoutingEvidenceInput {
  readonly actorType: "System";
  readonly actorReference: null;
  readonly action: "ResolveKitchenStationRoutingEvidence";
  readonly purpose: "CreateKitchenWork";
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly effectiveAt: KitchenInstant;
}

export interface ResolveRecipePreparationEvidenceInput {
  readonly actorType: "System";
  readonly actorReference: null;
  readonly action: "ResolveRecipePreparationEvidence";
  readonly purpose: "CreateKitchenWork";
  readonly brandReference: KitchenReference;
  readonly storeReference: KitchenReference;
  readonly effectiveAt: KitchenInstant;
  readonly sourceEvidenceReference: KitchenReference;
  readonly sourceEvidenceVersion: number;
  readonly sourceEvidenceDigest: KitchenDigest;
  readonly items: readonly KitchenPlanningSourceItem[];
}

export interface KitchenWorkPlanPorts {
  readonly stationRouting: {
    resolve(input: ResolveKitchenStationRoutingEvidenceInput): Promise<unknown | null>;
  };
  readonly preparations: {
    resolve(input: ResolveRecipePreparationEvidenceInput): Promise<unknown | null>;
  };
  readonly references: {
    derive(purpose: "KitchenWorkPlan", canonicalIdentity: string): string;
  };
  readonly digests: {
    sha256(canonicalValue: string): string;
  };
}
