import {
  OperationalProjectionError,
  projectionDigest,
  projectionExact,
  projectionInstant,
  projectionOptionalReference,
  projectionReference,
  validateBusinessDate,
} from "./projection-contract.js";

export const rebuildableOperationalProjectionNames = [
  "merchant_order_queue_v1",
  "payment_operations_v1",
  "kitchen_operations_v1",
  "fulfillment_operations_v1",
] as const;

export type RebuildableOperationalProjectionName =
  (typeof rebuildableOperationalProjectionNames)[number];

export class ProjectionRebuildError extends Error {
  constructor(
    readonly code:
      | "COMMAND_INVALID"
      | "NOT_AUTHORIZED"
      | "ACTIVE_GENERATION_CONFLICT"
      | "SOURCE_CHECKPOINT_MISMATCH"
      | "SOURCE_PAGINATION_INVALID"
      | "SHADOW_VALIDATION_FAILED",
  ) {
    super("projection rebuild is unavailable");
    this.name = "ProjectionRebuildError";
  }
}

function rebuildFail(code: ProjectionRebuildError["code"]): never {
  throw new ProjectionRebuildError(code);
}

type Scope = Readonly<{
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  businessDate: string;
}>;

export interface ProjectionRebuildCommand extends Scope {
  readonly commandReference: string;
  readonly idempotencyKey: string;
  readonly permission: "projection.rebuild";
  readonly projectionName: RebuildableOperationalProjectionName;
  readonly targetProjectionVersion: 1;
  readonly expectedActiveGenerationReference: string | null;
  readonly sourceCheckpoint: string;
  readonly sourceCutoffAt: string;
  readonly requestedAt: string;
  readonly requestedByActorReference: string;
  readonly purpose: "Recovery" | "Repair" | "VersionUpgrade";
  readonly batchSize: number;
}

export interface ProjectionRebuildSourceBatch {
  readonly records: readonly unknown[];
  readonly nextCursor: string | null;
  readonly sourceCheckpoint: string;
}

export interface ProjectionRebuildResult extends Scope {
  readonly projectionName: RebuildableOperationalProjectionName;
  readonly projectionVersion: 1;
  readonly commandReference: string;
  readonly shadowGenerationReference: string;
  readonly replacedGenerationReference: string | null;
  readonly sourceCheckpoint: string;
  readonly sourceCutoffAt: string;
  readonly rowCount: number;
  readonly summaryDigest: string;
  readonly auditReference: string;
  readonly rebuiltAt: string;
  readonly status: "Completed";
}

export interface ProjectionRebuildPorts {
  authorize(command: ProjectionRebuildCommand): Promise<boolean>;
  findCompleted(command: ProjectionRebuildCommand): Promise<ProjectionRebuildResult | null>;
  openShadow(command: ProjectionRebuildCommand): Promise<string>;
  loadSourceBatch(input: {
    readonly command: ProjectionRebuildCommand;
    readonly afterCursor: string | null;
    readonly limit: number;
  }): Promise<ProjectionRebuildSourceBatch>;
  writeShadowBatch(input: {
    readonly command: ProjectionRebuildCommand;
    readonly shadowGenerationReference: string;
    readonly records: readonly unknown[];
  }): Promise<void>;
  validateShadow(input: {
    readonly command: ProjectionRebuildCommand;
    readonly shadowGenerationReference: string;
  }): Promise<{
    readonly rowCount: number;
    readonly summaryDigest: string;
    readonly sourceCheckpoint: string;
  }>;
  activateShadow(input: {
    readonly command: ProjectionRebuildCommand;
    readonly shadowGenerationReference: string;
    readonly rowCount: number;
    readonly summaryDigest: string;
  }): Promise<{
    readonly replacedGenerationReference: string | null;
    readonly rebuiltAt: string;
    readonly auditReference: string;
  }>;
  abandonShadow(input: {
    readonly command: ProjectionRebuildCommand;
    readonly shadowGenerationReference: string;
    readonly reason: ProjectionRebuildError["code"] | "PORT_FAILURE";
  }): Promise<void>;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u;

function parseProjectionRebuildCommandUnchecked(value: unknown): ProjectionRebuildCommand {
  const raw = projectionExact(value, [
    "commandReference",
    "idempotencyKey",
    "permission",
    "tenantReference",
    "brandReference",
    "storeReference",
    "businessDate",
    "projectionName",
    "targetProjectionVersion",
    "expectedActiveGenerationReference",
    "sourceCheckpoint",
    "sourceCutoffAt",
    "requestedAt",
    "requestedByActorReference",
    "purpose",
    "batchSize",
  ]);
  if (
    typeof raw.idempotencyKey !== "string" ||
    !IDEMPOTENCY_KEY.test(raw.idempotencyKey) ||
    raw.permission !== "projection.rebuild" ||
    !rebuildableOperationalProjectionNames.includes(
      raw.projectionName as RebuildableOperationalProjectionName,
    ) ||
    raw.targetProjectionVersion !== 1 ||
    !["Recovery", "Repair", "VersionUpgrade"].includes(String(raw.purpose)) ||
    !Number.isSafeInteger(raw.batchSize) ||
    Number(raw.batchSize) < 1 ||
    Number(raw.batchSize) > 500
  )
    return rebuildFail("COMMAND_INVALID");
  const sourceCutoffAt = projectionInstant(raw.sourceCutoffAt);
  const requestedAt = projectionInstant(raw.requestedAt);
  if (Date.parse(sourceCutoffAt) > Date.parse(requestedAt)) return rebuildFail("COMMAND_INVALID");
  return Object.freeze({
    commandReference: projectionReference(raw.commandReference),
    idempotencyKey: raw.idempotencyKey,
    permission: "projection.rebuild",
    tenantReference: projectionReference(raw.tenantReference),
    brandReference: projectionReference(raw.brandReference),
    storeReference: projectionReference(raw.storeReference),
    businessDate: validateBusinessDate(raw.businessDate),
    projectionName: raw.projectionName,
    targetProjectionVersion: 1,
    expectedActiveGenerationReference: projectionOptionalReference(
      raw.expectedActiveGenerationReference,
    ),
    sourceCheckpoint: projectionReference(raw.sourceCheckpoint),
    sourceCutoffAt,
    requestedAt,
    requestedByActorReference: projectionReference(raw.requestedByActorReference),
    purpose: raw.purpose,
    batchSize: Number(raw.batchSize),
  }) as ProjectionRebuildCommand;
}

export function parseProjectionRebuildCommand(value: unknown): ProjectionRebuildCommand {
  try {
    return parseProjectionRebuildCommandUnchecked(value);
  } catch (error) {
    if (error instanceof ProjectionRebuildError) throw error;
    if (error instanceof OperationalProjectionError) return rebuildFail("COMMAND_INVALID");
    throw error;
  }
}

function validateResult(
  command: ProjectionRebuildCommand,
  result: ProjectionRebuildResult,
): ProjectionRebuildResult {
  if (
    result.commandReference !== command.commandReference ||
    result.projectionName !== command.projectionName ||
    result.projectionVersion !== command.targetProjectionVersion ||
    result.tenantReference !== command.tenantReference ||
    result.brandReference !== command.brandReference ||
    result.storeReference !== command.storeReference ||
    result.businessDate !== command.businessDate ||
    result.sourceCheckpoint !== command.sourceCheckpoint ||
    result.sourceCutoffAt !== command.sourceCutoffAt ||
    result.status !== "Completed"
  )
    return rebuildFail("SHADOW_VALIDATION_FAILED");
  projectionReference(result.shadowGenerationReference);
  projectionOptionalReference(result.replacedGenerationReference);
  projectionDigest(result.summaryDigest);
  projectionReference(result.auditReference);
  projectionInstant(result.rebuiltAt);
  if (!Number.isSafeInteger(result.rowCount) || result.rowCount < 0)
    return rebuildFail("SHADOW_VALIDATION_FAILED");
  return Object.freeze(result);
}

export async function executeProjectionRebuild(
  value: unknown,
  ports: ProjectionRebuildPorts,
): Promise<ProjectionRebuildResult> {
  const command = parseProjectionRebuildCommand(value);
  if (!(await ports.authorize(command))) return rebuildFail("NOT_AUTHORIZED");
  const completed = await ports.findCompleted(command);
  if (completed !== null) return validateResult(command, completed);

  const shadowGenerationReference = projectionReference(await ports.openShadow(command));
  const seenCursors = new Set<string>();
  let afterCursor: string | null = null;
  try {
    for (;;) {
      const batch = await ports.loadSourceBatch({
        command,
        afterCursor,
        limit: command.batchSize,
      });
      if (!Array.isArray(batch.records) || batch.records.length > command.batchSize)
        rebuildFail("SOURCE_PAGINATION_INVALID");
      if (batch.sourceCheckpoint !== command.sourceCheckpoint)
        rebuildFail("SOURCE_CHECKPOINT_MISMATCH");
      await ports.writeShadowBatch({ command, shadowGenerationReference, records: batch.records });
      if (batch.nextCursor === null) break;
      const nextCursor = projectionReference(batch.nextCursor);
      if (batch.records.length === 0 || seenCursors.has(nextCursor))
        rebuildFail("SOURCE_PAGINATION_INVALID");
      seenCursors.add(nextCursor);
      afterCursor = nextCursor;
    }

    const validation = await ports.validateShadow({ command, shadowGenerationReference });
    if (
      validation.sourceCheckpoint !== command.sourceCheckpoint ||
      !Number.isSafeInteger(validation.rowCount) ||
      validation.rowCount < 0
    )
      rebuildFail("SHADOW_VALIDATION_FAILED");
    const summaryDigest = projectionDigest(validation.summaryDigest);
    const activated = await ports.activateShadow({
      command,
      shadowGenerationReference,
      rowCount: validation.rowCount,
      summaryDigest,
    });
    return validateResult(command, {
      projectionName: command.projectionName,
      projectionVersion: command.targetProjectionVersion,
      commandReference: command.commandReference,
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      storeReference: command.storeReference,
      businessDate: command.businessDate,
      shadowGenerationReference,
      replacedGenerationReference: activated.replacedGenerationReference,
      sourceCheckpoint: command.sourceCheckpoint,
      sourceCutoffAt: command.sourceCutoffAt,
      rowCount: validation.rowCount,
      summaryDigest,
      rebuiltAt: activated.rebuiltAt,
      auditReference: activated.auditReference,
      status: "Completed",
    });
  } catch (error) {
    const reason = error instanceof ProjectionRebuildError ? error.code : "PORT_FAILURE";
    await ports.abandonShadow({ command, shadowGenerationReference, reason });
    throw error;
  }
}
