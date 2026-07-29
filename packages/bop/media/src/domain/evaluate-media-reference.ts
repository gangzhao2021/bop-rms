export type MediaReferenceEvaluationReason =
  "REFERENCE_ALLOWED" | "MEDIA_UNAVAILABLE" | "PINNED_REFERENCE_REQUIRED";

export interface MediaReferenceEvaluationInput {
  readonly reference: {
    readonly kind: "Dynamic" | "Pinned";
    readonly assetId: string;
    readonly assetVersionId: string | null;
  };
  readonly asset: {
    readonly assetId: string;
    readonly scope: {
      readonly kind: "Brand" | "Store";
      readonly brandReference: string;
      readonly storeReference: string | null;
    };
    readonly currentVersionReference: string | null;
  };
  readonly versions: readonly {
    readonly assetVersionId: string;
    readonly assetId: string;
    readonly checkState: "Quarantined" | "Clean" | "Rejected" | "ProcessingFailed";
    readonly readinessState: "Pending" | "Ready" | "Failed";
  }[];
  readonly context: {
    readonly kind: "Brand" | "Store";
    readonly brandReference: string;
    readonly storeReference: string | null;
  };
  readonly use: "Draft" | "Published" | "Transaction" | "Evidence" | "Compliance";
}

export interface MediaReferenceEvaluation {
  readonly allowed: boolean;
  readonly reason: MediaReferenceEvaluationReason;
  readonly assetVersionId: string | null;
}

function denied(reason: MediaReferenceEvaluationReason): MediaReferenceEvaluation {
  return Object.freeze({ allowed: false, reason, assetVersionId: null });
}

export function evaluateMediaReference(
  input: MediaReferenceEvaluationInput,
): MediaReferenceEvaluation {
  if (
    input.reference.assetId !== input.asset.assetId ||
    input.context.kind !== input.asset.scope.kind ||
    input.context.brandReference !== input.asset.scope.brandReference ||
    input.context.storeReference !== input.asset.scope.storeReference
  )
    return denied("MEDIA_UNAVAILABLE");
  if (input.use !== "Draft" && input.reference.kind !== "Pinned")
    return denied("PINNED_REFERENCE_REQUIRED");
  const selected =
    input.reference.kind === "Pinned"
      ? input.reference.assetVersionId
      : input.asset.currentVersionReference;
  if (selected === null) return denied("MEDIA_UNAVAILABLE");
  const matches = input.versions.filter(
    (version) => version.assetVersionId === selected && version.assetId === input.asset.assetId,
  );
  if (
    matches.length !== 1 ||
    matches[0]?.checkState !== "Clean" ||
    matches[0].readinessState !== "Ready"
  )
    return denied("MEDIA_UNAVAILABLE");
  return Object.freeze({ allowed: true, reason: "REFERENCE_ALLOWED", assetVersionId: selected });
}
