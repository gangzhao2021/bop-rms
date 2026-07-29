export interface DomainFeatureControlScope {
  readonly kind: "Brand" | "Store";
  readonly brandReference: string;
  readonly storeReference: string | null;
}

interface DomainFeatureControlBase {
  readonly controlId: string;
  readonly key: string;
  readonly version: number;
  readonly scope: DomainFeatureControlScope;
  readonly effectiveFrom: string;
  readonly effectiveUntil: string | null;
  readonly expiresAt: string | null;
}

export interface DomainReleaseFlagDefinition extends DomainFeatureControlBase {
  readonly kind: "ReleaseFlag";
  readonly defaultEnabled: boolean;
  readonly state: "Default" | "Enabled" | "Disabled";
  readonly rolloutBasisPoints: number;
}

export interface DomainKillSwitchDefinition extends DomainFeatureControlBase {
  readonly kind: "KillSwitch";
  readonly defaultActive: boolean;
  readonly mode: "BlockNew" | "SafePause" | "Terminate";
  readonly inFlightPolicy: "AllowToComplete" | "ReachSafeCheckpoint" | "CompensateAndStop";
  readonly state:
    | { readonly phase: "Default" | "Inactive" | "Active" }
    | { readonly phase: "Recovering"; readonly rolloutBasisPoints: number };
}

export type DomainFeatureControlDefinition =
  DomainReleaseFlagDefinition | DomainKillSwitchDefinition;

export type DomainFeatureControlReason =
  | "RELEASE_ENABLED"
  | "RELEASE_DISABLED"
  | "KILL_INACTIVE"
  | "KILL_ACTIVE"
  | "KILL_RECOVERY_ALLOWED"
  | "KILL_RECOVERY_BLOCKED"
  | "CONTROL_UNAVAILABLE";

export interface EvaluateDomainFeatureControlInput {
  readonly brandReference: string;
  readonly storeReference: string | null;
  readonly key: string;
  readonly definitions: readonly DomainFeatureControlDefinition[];
  readonly rolloutBucket: number;
  readonly evaluatedAt: string;
}

export interface DomainFeatureControlEvaluation {
  readonly definition: DomainFeatureControlDefinition | null;
  readonly backendExecution: "Allow" | "Deny";
  readonly reason: DomainFeatureControlReason;
}

function unavailable(): DomainFeatureControlEvaluation {
  return Object.freeze({
    definition: null,
    backendExecution: "Deny",
    reason: "CONTROL_UNAVAILABLE",
  });
}

function applicable(
  definition: DomainFeatureControlDefinition,
  input: EvaluateDomainFeatureControlInput,
): boolean {
  return (
    definition.scope.brandReference === input.brandReference &&
    (definition.scope.kind === "Brand" ||
      (input.storeReference !== null && definition.scope.storeReference === input.storeReference))
  );
}

function effective(definition: DomainFeatureControlDefinition, evaluatedAt: number): boolean {
  return (
    Date.parse(definition.effectiveFrom) <= evaluatedAt &&
    (definition.effectiveUntil === null || evaluatedAt < Date.parse(definition.effectiveUntil)) &&
    (definition.expiresAt === null || evaluatedAt < Date.parse(definition.expiresAt))
  );
}

function select(
  definitions: readonly DomainFeatureControlDefinition[],
  preferStore: boolean,
): DomainFeatureControlDefinition | null {
  const atScope = definitions.filter((item) => (item.scope.kind === "Store") === preferStore);
  if (atScope.length === 0) return null;
  const byControl = new Map<string, DomainFeatureControlDefinition[]>();
  for (const item of atScope) {
    const existing = byControl.get(item.controlId) ?? [];
    existing.push(item);
    byControl.set(item.controlId, existing);
  }
  if (byControl.size !== 1) return null;
  const lineage = byControl.values().next().value;
  if (lineage === undefined) return null;
  const highestVersion = Math.max(...lineage.map((item) => item.version));
  const winners = lineage.filter((item) => item.version === highestVersion);
  return winners.length === 1 ? (winners.at(0) ?? null) : null;
}

export function evaluateDomainFeatureControl(
  input: EvaluateDomainFeatureControlInput,
): DomainFeatureControlEvaluation {
  const evaluatedAt = Date.parse(input.evaluatedAt);
  const candidates = input.definitions.filter(
    (definition) =>
      definition.key === input.key &&
      applicable(definition, input) &&
      effective(definition, evaluatedAt),
  );
  const storeCandidates = candidates.some((item) => item.scope.kind === "Store");
  const definition = select(candidates, storeCandidates);
  if (definition === null) return unavailable();

  if (definition.kind === "ReleaseFlag") {
    const configured =
      definition.state === "Default" ? definition.defaultEnabled : definition.state === "Enabled";
    const enabled = configured && input.rolloutBucket < definition.rolloutBasisPoints;
    return Object.freeze({
      definition,
      backendExecution: enabled ? "Allow" : "Deny",
      reason: enabled ? "RELEASE_ENABLED" : "RELEASE_DISABLED",
    });
  }

  if (definition.state.phase === "Default") {
    return Object.freeze({
      definition,
      backendExecution: definition.defaultActive ? "Deny" : "Allow",
      reason: definition.defaultActive ? "KILL_ACTIVE" : "KILL_INACTIVE",
    });
  }
  if (definition.state.phase === "Inactive") {
    return Object.freeze({
      definition,
      backendExecution: "Allow",
      reason: "KILL_INACTIVE",
    });
  }
  if (definition.state.phase === "Active") {
    return Object.freeze({
      definition,
      backendExecution: "Deny",
      reason: "KILL_ACTIVE",
    });
  }
  if (!("rolloutBasisPoints" in definition.state)) return unavailable();
  const allowed = input.rolloutBucket < definition.state.rolloutBasisPoints;
  return Object.freeze({
    definition,
    backendExecution: allowed ? "Allow" : "Deny",
    reason: allowed ? "KILL_RECOVERY_ALLOWED" : "KILL_RECOVERY_BLOCKED",
  });
}
