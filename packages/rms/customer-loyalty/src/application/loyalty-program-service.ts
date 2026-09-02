import type {
  LoyaltyProgramCommand,
  LoyaltyProgramProjection,
  LoyaltyProgramQuery,
} from "../contracts/loyalty-program.js";
import { customerReference, CustomerProfileError } from "../domain/customer-profile.js";
import {
  appendLoyaltyProgramVersion,
  createLoyaltyProgram,
  publishLoyaltyProgramVersion,
  validateLoyaltyProgramVersion,
  type LoyaltyProgram,
} from "../domain/loyalty-program.js";
import type { LoyaltyProgramPorts } from "./ports/loyalty-program-ports.js";
const fail = (
  code: ConstructorParameters<typeof CustomerProfileError>[0] = "CUSTOMER_PROFILE_INVALID",
): never => {
  throw new CustomerProfileError(code);
};
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, entry]) => [key, canonical(entry)]),
        )
      : value;
const expected = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) > 0 ? (value as number) : fail();
export async function executeLoyaltyProgram(
  command: LoyaltyProgramCommand,
  ports: LoyaltyProgramPorts,
) {
  if (
    command.purpose !== "LoyaltyProgramAdministration" ||
    (command.action === "Publish" || command.action === "Schedule"
      ? command.permission !== "loyalty.program.approve"
      : command.permission !== "loyalty.program.edit")
  )
    fail("CUSTOMER_PROFILE_PERMISSION_DENIED");
  const access = await ports.authorization.authorize(command);
  if (
    !access?.authorized ||
    (command.action === "Publish" || command.action === "Schedule"
      ? !access.mayApprove
      : !access.mayEdit)
  )
    fail("CUSTOMER_PROFILE_PERMISSION_DENIED");
  const intentHash = ports.references.hashIntent(JSON.stringify(canonical(command)));
  const replay = await ports.repository.resolveOperation(command.operationReference);
  if (replay) {
    if (!ports.references.equals(replay.intentHash, intentHash))
      fail("CUSTOMER_PROFILE_IDEMPOTENCY_CONFLICT");
    return Object.freeze({ ...replay, outcome: "AlreadyApplied" as const });
  }
  let before: LoyaltyProgram | null = null;
  let after: LoyaltyProgram;
  let simulation = null;
  if (command.action === "Create")
    after = createLoyaltyProgram({
      ...command.payload,
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      actorReference: command.actorReference,
      occurredAt: command.occurredAt,
    } as Parameters<typeof createLoyaltyProgram>[0]);
  else {
    const programReference = customerReference(command.payload.programReference);
    before = await ports.repository.load({
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      programReference,
    });
    if (
      !before ||
      before.tenantReference !== command.tenantReference ||
      before.brandReference !== command.brandReference
    )
      fail("CUSTOMER_PROFILE_STATE_CONFLICT");
    const existing = before as LoyaltyProgram;
    if (command.action === "AppendVersion")
      after = appendLoyaltyProgramVersion(existing, {
        ...command.payload,
        actorReference: command.actorReference,
        occurredAt: command.occurredAt,
      } as unknown as Parameters<typeof appendLoyaltyProgramVersion>[1]);
    else if (command.action === "Validate") {
      const result = await ports.validation.validate({ command, program: existing });
      if (
        !result.valid ||
        result.pricingCalculatedMoney ||
        result.pointsUsedAsTender ||
        result.effectiveVersionConflict ||
        !result.simulation.pointsConserved
      )
        fail("CUSTOMER_PROFILE_PROOF_REQUIRED");
      simulation = result.simulation;
      after = validateLoyaltyProgramVersion(existing, {
        expectedVersion: expected(command.payload.expectedVersion),
        evidenceReference: result.evidenceReference,
        actorReference: command.actorReference,
        occurredAt: command.occurredAt,
      });
    } else {
      const approval = await ports.approval.validate({ command, program: existing });
      if (!approval.approved || approval.approverReference !== command.actorReference)
        fail("CUSTOMER_PROFILE_PROOF_REQUIRED");
      after = publishLoyaltyProgramVersion(existing, {
        expectedVersion: expected(command.payload.expectedVersion),
        approvalReference: approval.approvalReference,
        approverReference: approval.approverReference,
        occurredAt: command.occurredAt,
        schedule: command.action === "Schedule",
      });
    }
  }
  return ports.repository.commit(
    Object.freeze({
      operationReference: command.operationReference,
      intentHash,
      command,
      before,
      after,
      simulation,
      audit: await ports.audit.create({ command, before, after }),
      outcome: "Applied" as const,
    }),
  );
}
export async function queryLoyaltyPrograms(
  query: LoyaltyProgramQuery,
  ports: LoyaltyProgramPorts,
): Promise<LoyaltyProgramProjection> {
  const access = await ports.authorization.authorize(query);
  if (!access?.authorized) fail("CUSTOMER_PROFILE_PERMISSION_DENIED");
  const result = await ports.projection.query(query);
  if (
    result.projectionName !== "loyalty_program_v1" ||
    result.projectionVersion !== 1 ||
    result.tenantReference !== query.tenantReference ||
    result.brandReference !== query.brandReference ||
    (query.programReference !== null && result.detail?.programReference !== query.programReference)
  )
    fail();
  const granted = access as NonNullable<typeof access>;
  const permissions = Object.freeze({
    mayViewRules: granted.mayViewRules === true,
    mayEdit: granted.mayEdit === true,
    mayApprove: granted.mayApprove === true,
  });
  const rows = Object.freeze(
    result.rows.map((row) =>
      Object.freeze({
        ...row,
        earnSummary: permissions.mayViewRules ? row.earnSummary : null,
        redeemSummary: permissions.mayViewRules ? row.redeemSummary : null,
      }),
    ),
  );
  const detail =
    result.detail === null || !permissions.mayViewRules
      ? null
      : Object.freeze({ ...result.detail });
  return Object.freeze({ ...result, permissions, rows, detail });
}
