import type {
  PrivacyCommand,
  PrivacyRequestProjection,
  PrivacyRequestQuery,
} from "../contracts/privacy-request.js";
import {
  addPrivacyOwnerWork,
  attachPrivacyExport,
  attachPrivacyHold,
  completePrivacyOwnerWork,
  PrivacyRequestError,
  transitionPrivacyRequest,
} from "../domain/privacy-request.js";
import type { PrivacyRequestPorts } from "./ports/privacy-request-ports.js";
const fail = (code: PrivacyRequestError["code"] = "INVALID"): never => {
  throw new PrivacyRequestError(code);
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
export async function executePrivacyCommand(command: PrivacyCommand, ports: PrivacyRequestPorts) {
  if (
    command.purpose !== "PrivacyRightsAdministration" ||
    command.permission !== "privacy.request.manage"
  )
    fail();
  const access = await ports.authorization.authorize(command);
  if (!access?.authorized || !access.mayManage) fail();
  const intentHash = ports.references.hashIntent(JSON.stringify(canonical(command))),
    replay = await ports.repository.resolveOperation(command.operationReference);
  if (replay) {
    if (!ports.references.equals(replay.intentHash, intentHash)) fail("CONFLICT");
    return Object.freeze({ ...replay, outcome: "AlreadyApplied" as const });
  }
  const before = await ports.repository.load(command);
  if (
    !before ||
    before.tenantReference !== command.tenantReference ||
    before.brandReference !== command.brandReference ||
    before.requestReference !== command.requestReference
  )
    fail("CONFLICT");
  const prior = before as NonNullable<typeof before>,
    proof = await ports.evidence.verify(command);
  if (!proof.valid || !proof.legalOrPolicyApproved || !proof.proportionalIdentityProof)
    fail("PROOF_REQUIRED");
  let after;
  const common = {
    expectedVersion: command.expectedVersion,
    actorReference: command.actorReference,
    evidenceReference: proof.evidenceReference,
    occurredAt: command.occurredAt,
  };
  switch (command.action) {
    case "Transition":
      after = transitionPrivacyRequest(prior, {
        ...common,
        ...(command.payload as Omit<
          Parameters<typeof transitionPrivacyRequest>[1],
          keyof typeof common
        >),
      });
      break;
    case "AddOwnerWork":
      after = addPrivacyOwnerWork(prior, {
        ...common,
        ...(command.payload as Omit<
          Parameters<typeof addPrivacyOwnerWork>[1],
          keyof typeof common
        >),
      });
      break;
    case "CompleteOwnerWork":
      after = completePrivacyOwnerWork(prior, {
        ...common,
        ...(command.payload as Omit<
          Parameters<typeof completePrivacyOwnerWork>[1],
          keyof typeof common
        >),
      });
      break;
    case "AttachHold":
      after = attachPrivacyHold(prior, {
        ...common,
        ...(command.payload as Omit<Parameters<typeof attachPrivacyHold>[1], keyof typeof common>),
      });
      break;
    case "AttachExport":
      after = attachPrivacyExport(prior, {
        ...common,
        ...(command.payload as Omit<
          Parameters<typeof attachPrivacyExport>[1],
          keyof typeof common
        >),
      });
      break;
    default:
      return fail();
  }
  return ports.repository.commit(
    Object.freeze({
      operationReference: command.operationReference,
      intentHash,
      command,
      before: prior,
      after,
      auditReference: await ports.audit.create(command, prior, after),
      outcome: "Applied" as const,
    }),
  );
}
export async function queryPrivacyRequests(
  query: PrivacyRequestQuery,
  ports: PrivacyRequestPorts,
): Promise<PrivacyRequestProjection> {
  const access = await ports.authorization.authorize(query);
  if (!access?.authorized) fail();
  const granted = access as NonNullable<typeof access>,
    result = await ports.projections.load(query);
  if (
    result.projectionName !== "privacy_request_v1" ||
    result.projectionVersion !== 1 ||
    result.tenantReference !== query.tenantReference ||
    result.brandReference !== query.brandReference
  )
    fail();
  return Object.freeze({
    ...result,
    permissions: Object.freeze({
      mayIntake: granted.mayIntake,
      mayVerify: granted.mayVerify,
      mayFulfill: granted.mayFulfill,
      mayViewVerification: granted.mayViewVerification,
    }),
    rows: Object.freeze(
      result.rows.map((row) =>
        granted.mayViewVerification ? row : Object.freeze({ ...row, verificationReference: null }),
      ),
    ),
  });
}
