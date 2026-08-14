import type {
  LoyaltyAccountProjection,
  LoyaltyAccountQuery,
  PointsCommand,
  PointsExceptionProjection,
  PointsExceptionQuery,
} from "../contracts/loyalty-account.js";
import { CustomerProfileError } from "../domain/customer-profile.js";
import { applyPointsOperation } from "../domain/loyalty-account.js";
import type { LoyaltyAccountPorts } from "./ports/loyalty-account-ports.js";
const fail = (
  code: ConstructorParameters<typeof CustomerProfileError>[0] = "CUSTOMER_PROFILE_INVALID",
): never => {
  throw new CustomerProfileError(code);
};
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.entries(v)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, e]) => [k, canonical(e)]),
        )
      : v;
export async function executePointsCommand(command: PointsCommand, ports: LoyaltyAccountPorts) {
  const correction = command.input.type === "Adjust" || command.input.type === "Reverse";
  if (
    command.purpose !== "LoyaltyAccountSupport" ||
    command.permission !== (correction ? "loyalty.points.correct" : "loyalty.points.operate")
  )
    fail("CUSTOMER_PROFILE_PERMISSION_DENIED");
  const access = await ports.authorization.authorize(command);
  if (!access?.authorized || (correction ? !access.mayCorrect : !access.mayOperate))
    fail("CUSTOMER_PROFILE_PERMISSION_DENIED");
  const intentHash = ports.references.hashIntent(JSON.stringify(canonical(command))),
    replay = await ports.repository.resolveOperation(command.operationReference);
  if (replay) {
    if (!ports.references.equals(replay.intentHash, intentHash))
      fail("CUSTOMER_PROFILE_IDEMPOTENCY_CONFLICT");
    return Object.freeze({ ...replay, outcome: "AlreadyApplied" as const });
  }
  const before = await ports.repository.load({
    tenantReference: command.tenantReference,
    brandReference: command.brandReference,
    accountReference: command.accountReference,
  });
  if (
    !before ||
    before.tenantReference !== command.tenantReference ||
    before.brandReference !== command.brandReference
  )
    fail("CUSTOMER_PROFILE_STATE_CONFLICT");
  const prior = before as NonNullable<typeof before>;
  const source = await ports.source.validate(command);
  if (
    !source.valid ||
    source.sourceFactsMutated ||
    source.points !== command.input.points ||
    source.sourceReference !== command.input.sourceReference ||
    source.programVersionReference !== prior.programVersionReference ||
    source.ruleVersionReference !== command.input.ruleVersionReference ||
    source.originalTransactionReference !== command.input.originalTransactionReference
  )
    fail("CUSTOMER_PROFILE_PROOF_REQUIRED");
  const result = applyPointsOperation(prior, {
    ...command.input,
    actorReference: command.actorReference,
    occurredAt: command.occurredAt,
  });
  return ports.repository.commit(
    Object.freeze({
      operationReference: command.operationReference,
      intentHash,
      command,
      before: prior,
      after: result.account,
      transaction: result.transaction,
      audit: await ports.audit.create({ command, before: prior, after: result.account }),
      outcome: "Applied" as const,
    }),
  );
}
export async function queryLoyaltyAccount(
  query: LoyaltyAccountQuery,
  ports: LoyaltyAccountPorts,
): Promise<LoyaltyAccountProjection> {
  const access = await ports.authorization.authorize(query);
  if (!access?.authorized) fail("CUSTOMER_PROFILE_PERMISSION_DENIED");
  const result = await ports.projections.account(query);
  if (
    result.projectionName !== "loyalty_account_v1" ||
    result.projectionVersion !== 1 ||
    result.tenantReference !== query.tenantReference ||
    result.brandReference !== query.brandReference ||
    (query.accountReference !== null && result.account?.accountReference !== query.accountReference)
  )
    fail();
  const granted = access as NonNullable<typeof access>,
    permissions = Object.freeze({
      mayViewLedger: granted.mayViewLedger,
      mayOperate: granted.mayOperate,
      mayCorrect: granted.mayCorrect,
    });
  return Object.freeze({
    ...result,
    permissions,
    account:
      result.account === null
        ? null
        : Object.freeze({
            ...result.account,
            ledger: permissions.mayViewLedger ? result.account.ledger : null,
          }),
  });
}
export async function queryPointsExceptions(
  query: PointsExceptionQuery,
  ports: LoyaltyAccountPorts,
): Promise<PointsExceptionProjection> {
  const access = await ports.authorization.authorize(query);
  if (!access?.authorized || !access.mayReview) fail("CUSTOMER_PROFILE_PERMISSION_DENIED");
  const granted = access as NonNullable<typeof access>;
  const result = await ports.projections.exceptions(query);
  if (
    result.projectionName !== "loyalty_points_exception_v1" ||
    result.projectionVersion !== 1 ||
    result.tenantReference !== query.tenantReference ||
    result.brandReference !== query.brandReference
  )
    fail();
  return Object.freeze({
    ...result,
    permissions: Object.freeze({ mayReview: true, mayCorrect: granted.mayCorrect }),
  });
}
