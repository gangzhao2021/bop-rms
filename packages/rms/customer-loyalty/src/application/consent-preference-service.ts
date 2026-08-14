import type {
  ConsentPreferenceCommand,
  ConsentPreferenceProjection,
  ConsentPreferenceQuery,
} from "../contracts/consent-preference.js";
import { recordConsentChoice, updateContactPreference } from "../domain/consent-preference.js";
import { CustomerProfileError } from "../domain/customer-profile.js";
import type { ConsentPreferencePorts } from "./ports/consent-preference-ports.js";
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
export async function executeConsentPreferenceCommand(
  command: ConsentPreferenceCommand,
  ports: ConsentPreferencePorts,
) {
  if (
    command.purpose !== "ConsentAdministration" ||
    command.permission !== "customer.consent.manage"
  )
    fail("CUSTOMER_PROFILE_PERMISSION_DENIED");
  const access = await ports.authorization.authorize(command);
  if (!access?.authorized || !access.mayManage) fail("CUSTOMER_PROFILE_PERMISSION_DENIED");
  const intentHash = ports.references.hashIntent(JSON.stringify(canonical(command))),
    replay = await ports.repository.resolveOperation(command.operationReference);
  if (replay) {
    if (!ports.references.equals(replay.intentHash, intentHash))
      fail("CUSTOMER_PROFILE_IDEMPOTENCY_CONFLICT");
    return Object.freeze({ ...replay, outcome: "AlreadyApplied" as const });
  }
  const before = await ports.repository.load(command);
  if (
    !before ||
    before.tenantReference !== command.tenantReference ||
    before.brandReference !== command.brandReference ||
    before.customerReference !== command.customerReference
  )
    fail("CUSTOMER_PROFILE_STATE_CONFLICT");
  const prior = before as NonNullable<typeof before>;
  const proof = await ports.evidence.verify(command),
    expectedEvidence = command.input.evidenceReference;
  if (
    !proof.verified ||
    proof.identityContactValueDisclosed ||
    !proof.policyApproved ||
    proof.customerReference !== command.customerReference ||
    proof.evidenceReference !== expectedEvidence
  )
    fail("CUSTOMER_PROFILE_PROOF_REQUIRED");
  const after =
    command.type === "RecordChoice"
      ? recordConsentChoice(prior, {
          expectedVersion: command.expectedVersion,
          consentReference: command.input.consentReference,
          purpose: command.input.consentPurpose,
          channel: command.input.channel,
          status: command.input.status,
          contactMethodReference: command.input.contactMethodReference,
          policyVersion: command.input.policyVersion,
          jurisdictionCode: command.input.jurisdictionCode,
          sourceCode: command.input.sourceCode,
          actorReference: command.actorReference,
          effectiveAt: command.input.effectiveAt,
          recordedAt: command.occurredAt,
          evidenceReference: command.input.evidenceReference,
        })
      : updateContactPreference(prior, {
          expectedVersion: command.expectedVersion,
          ...command.input,
          actorReference: command.actorReference,
          recordedAt: command.occurredAt,
        });
  const event =
    command.type === "RecordChoice"
      ? Object.freeze({
          eventName: "CustomerConsentChanged" as const,
          customerReference: command.customerReference,
          consentReference: command.input.consentReference,
          purpose: command.input.consentPurpose,
          channel: command.input.channel,
          status: command.input.status,
          occurredAt: command.occurredAt,
        })
      : null;
  return ports.repository.commit(
    Object.freeze({
      operationReference: command.operationReference,
      intentHash,
      command,
      before: prior,
      after,
      event,
      audit: await ports.audit.create({ command, before: prior, after }),
      outcome: "Applied" as const,
    }),
  );
}
export async function queryConsentPreference(
  query: ConsentPreferenceQuery,
  ports: ConsentPreferencePorts,
): Promise<ConsentPreferenceProjection> {
  const access = await ports.authorization.authorize(query);
  if (!access?.authorized) fail("CUSTOMER_PROFILE_PERMISSION_DENIED");
  const granted = access as NonNullable<typeof access>;
  const result = await ports.projections.load(query);
  if (
    result.projectionName !== "customer_consent_preference_v1" ||
    result.projectionVersion !== 1 ||
    result.tenantReference !== query.tenantReference ||
    result.brandReference !== query.brandReference ||
    result.customerReference !== query.customerReference
  )
    fail();
  return Object.freeze({
    ...result,
    permissions: Object.freeze({
      mayManage: granted.mayManage,
      mayExportProof: granted.mayExportProof,
      mayViewEvidence: granted.mayViewEvidence,
    }),
    choices: Object.freeze(
      result.choices.map((choice) =>
        granted.mayViewEvidence ? choice : Object.freeze({ ...choice, evidenceReference: null }),
      ),
    ) as ConsentPreferenceProjection["choices"],
  });
}
