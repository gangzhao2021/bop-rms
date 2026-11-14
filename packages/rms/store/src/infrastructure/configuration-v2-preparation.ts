import {
  createPostgresPublishingMutationStore,
  executePublishingMutation,
  createPublishingScope,
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  createPublishingApprovalEvidence,
  createPublishingReleaseRecord,
  parsePublishingReference,
  parsePublishingCode,
  parsePublishingDigest,
  parsePublishingInstant,
  parsePublishingVersion,
  parseReleaseSequence,
  type ExecutePublishingMutationInput,
  type PublishingAuthorizationPort,
  type PublishingLifecycleRecord,
} from "@bop/publishing";
import { parseCanonicalInstant, createTenantContext } from "@bop/tenant";
import {
  createStoreConfigurationVersion,
  type StoreConfigurationVersion,
} from "../contracts/store-configuration-administration.js";
import { StoreConfigurationAdministrationServiceError } from "../application/store-configuration-administration-service.js";
import type {
  StoreConfigurationAdministrationPorts,
  StoreConfigurationFreshPreparationInput,
} from "../application/ports/store-configuration-administration-ports.js";

import {
  createStorePublicationSetupBasisVerifier,
  type StorePublicationSetupSnapshotReferences,
} from "./persistence/publication-setup-basis.js";
import {
  readStoreConfigurationSoleOperatorApproval,
  recordStoreConfigurationSoleOperatorApproval,
} from "./persistence/store-configuration-sole-operator-store.js";

type Transaction = Parameters<
  Parameters<Parameters<typeof createPostgresPublishingMutationStore>[0]["run"]>[0]
>[0];
type Context = ExecutePublishingMutationInput["tenantContext"];
export interface StoreConfigurationV2PreparationOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly publishingFamilyReference: string;
  readonly configurationType: string;
  readonly purposeCode: string;
  readonly originalObservedAt: string;
  readonly originalValidUntil: string;
  readonly requiredValidationCheckCodes: readonly string[];
  readonly clock: { now(): string };
  readonly setupSnapshotReferences: StorePublicationSetupSnapshotReferences;
  nextReference(): string;
  hashContent(configuration: StoreConfigurationVersion): string;
  /** Actual current held TenantContext for this writer, not browser actor metadata. */
  currentTenantContext(
    tx: Transaction,
    input: StoreConfigurationFreshPreparationInput,
  ): Promise<Context>;
  publishingAuthorization(tx: Transaction): PublishingAuthorizationPort;
  /** Must perform actual reference/configuration checks and retain their owner fences. */
  validateSubmit(
    tx: Transaction,
    configuration: StoreConfigurationVersion,
    observedAt: string,
  ): Promise<{ validUntil: string; checkCodes: readonly string[] }>;
  /** Explicit business approval deadline; never the five-second authorization lease. */
  approvalValidUntil(
    tx: Transaction,
    input: StoreConfigurationFreshPreparationInput,
  ): Promise<string>;
  /** Actual current Live Gate owner evidence retained in the same transaction. */
  liveGateEvidence(
    tx: Transaction,
    configuration: StoreConfigurationVersion,
    observedAt: string,
  ): Promise<string>;
  /**
   * WP-2423 DEC-SOLE-OPERATOR-APPROVAL (2026-10-16): present only when the approver explicitly
   * approves their own configuration (they created it or sent it for approval) as sole operator.
   * It must decide, in this transaction, that sole operator is in effect for them now and that
   * their second factor is at most 15 minutes old, and throw otherwise. Absent, an approver who
   * created or sent the configuration is refused; present, any other approval is refused.
   */
  soleOperatorApproval?(
    tx: Transaction,
    input: StoreConfigurationFreshPreparationInput,
  ): Promise<{ readonly actorMfaAt: string }>;
}
/** WP-2423: the recorded sole-operator approval an approval by its own author or sender relies on. */
export async function requireStoreConfigurationSoleOperatorApproval(
  tx: Transaction,
  input: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly configurationReference: string;
    readonly approverReference: string;
    readonly approvalEvidenceReference: string;
  },
): Promise<void> {
  const mark = await readStoreConfigurationSoleOperatorApproval(tx, input);
  if (
    mark === null ||
    mark.actorReference !== String(input.approverReference) ||
    mark.approvalEvidenceReference !== String(input.approvalEvidenceReference)
  )
    throw new StoreConfigurationAdministrationServiceError(
      "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    );
}
/** Fresh-only hook. Call it through the owning administration service so original
 * arbitration/CAS precede all Core writes. Every callback must retain its actual
 * source authority until the caller's outer COMMIT; this helper is not a host. */
export function createPersistentStoreConfigurationV2Preparation(
  options: StoreConfigurationV2PreparationOptions,
) {
  const optionFields = [
    "tenantReference",
    "brandReference",
    "storeReference",
    "publishingFamilyReference",
    "configurationType",
    "purposeCode",
    "originalObservedAt",
    "originalValidUntil",
    "requiredValidationCheckCodes",
    "clock",
    "setupSnapshotReferences",
    "nextReference",
    "hashContent",
    "currentTenantContext",
    "publishingAuthorization",
    "validateSubmit",
    "approvalValidUntil",
    "liveGateEvidence",
  ];
  const dataOptions = () =>
    optionFields.every((key) => {
      const d = Object.getOwnPropertyDescriptor(options, key);
      return d !== undefined && d.enumerable && "value" in d;
    });
  const soleDescriptor = Object.getOwnPropertyDescriptor(options, "soleOperatorApproval");
  if (
    !dataOptions() ||
    (soleDescriptor !== undefined &&
      (!soleDescriptor.enumerable ||
        !("value" in soleDescriptor) ||
        typeof soleDescriptor.value !== "function"))
  )
    throw new StoreConfigurationAdministrationServiceError(
      "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    );
  const sole: StoreConfigurationV2PreparationOptions["soleOperatorApproval"] =
    soleDescriptor?.value;
  const tenant = parsePublishingReference(options.tenantReference),
    brand = parsePublishingReference(options.brandReference),
    store = parsePublishingReference(options.storeReference),
    family = parsePublishingReference(options.publishingFamilyReference),
    configurationType = parsePublishingCode(options.configurationType),
    purposeCode = parsePublishingCode(options.purposeCode),
    origin = parseCanonicalInstant(options.originalObservedAt),
    until = parseCanonicalInstant(options.originalValidUntil),
    clock = options.clock,
    now = clock.now,
    ids = options.nextReference,
    hash = options.hashContent,
    context = options.currentTenantContext,
    authorize = options.publishingAuthorization,
    validate = options.validateSubmit,
    approvalUntil = options.approvalValidUntil,
    liveGate = options.liveGateEvidence;
  if (until <= origin || Date.parse(until) - Date.parse(origin) > 5000)
    throw new StoreConfigurationAdministrationServiceError(
      "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    );
  const parseCodes = (value: readonly string[]) => {
    if (
      !Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      throw new StoreConfigurationAdministrationServiceError(
        "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
      );
    return Object.freeze(
      Array.from({ length: value.length }, (_, i) => {
        const d = Object.getOwnPropertyDescriptor(value, String(i));
        if (!d?.enumerable || !("value" in d))
          throw new StoreConfigurationAdministrationServiceError(
            "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
          );
        return parsePublishingCode(d.value);
      }).sort(),
    );
  };
  const codes = parseCodes(options.requiredValidationCheckCodes),
    verifyBasis = createStorePublicationSetupBasisVerifier(options);
  if (codes.length < 1 || codes.length > 32 || new Set(codes).size !== codes.length)
    throw new StoreConfigurationAdministrationServiceError(
      "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
    );
  return Object.freeze({
    forTransaction(
      tx: Transaction,
    ): NonNullable<StoreConfigurationAdministrationPorts["prepareFresh"]> {
      const query = tx.query;
      let active = false,
        poisoned = false,
        last = origin;
      const fail = (): never => {
        poisoned = true;
        throw new StoreConfigurationAdministrationServiceError(
          "STORE_CONFIGURATION_DEPENDENCY_UNAVAILABLE",
        );
      };
      const check = () => {
        if (
          poisoned ||
          !dataOptions() ||
          tx.query !== query ||
          options.clock !== clock ||
          clock.now !== now ||
          options.nextReference !== ids ||
          options.hashContent !== hash ||
          options.currentTenantContext !== context ||
          options.publishingAuthorization !== authorize ||
          options.validateSubmit !== validate ||
          options.approvalValidUntil !== approvalUntil ||
          options.liveGateEvidence !== liveGate ||
          Object.getOwnPropertyDescriptor(options, "soleOperatorApproval")?.value !== sole ||
          options.tenantReference !== tenant ||
          options.brandReference !== brand ||
          options.storeReference !== store ||
          options.publishingFamilyReference !== family ||
          options.configurationType !== configurationType ||
          options.purposeCode !== purposeCode ||
          options.originalObservedAt !== origin ||
          options.originalValidUntil !== until ||
          JSON.stringify(parseCodes(options.requiredValidationCheckCodes)) !== JSON.stringify(codes)
        )
          return fail();
        const clockPort = Object.getOwnPropertyDescriptor(clock, "now");
        if (!clockPort || !("value" in clockPort) || clockPort.value !== now) return fail();
        const at = parseCanonicalInstant(now.call(clock));
        if (at < last || at >= until) return fail();
        last = at;
        return at;
      };
      const wait = async <T>(work: () => Promise<T>) => {
        check();
        const result = await work();
        check();
        return result;
      };
      return async (stage, input, current) => {
        if (active) return fail();
        active = true;
        try {
          check();
          const candidate = createStoreConfigurationVersion(input.configuration);
          if (candidate.setupBasis === undefined) return candidate;
          if (stage !== "Submit" && stage !== "Approve" && stage !== "Publish") return candidate;
          if (
            current === null ||
            String(candidate.setupBasis.tenantReference) !== String(tenant) ||
            String(candidate.brandReference) !== String(brand) ||
            String(candidate.storeReference) !== String(store) ||
            current.configurationReference !== candidate.configurationReference ||
            current.configurationVersion !== input.expectedVersion
          )
            return fail();
          const at = parsePublishingInstant(input.occurredAt);
          if (String(at) < String(origin) || String(at) > String(check())) return fail();
          const heldContext = await wait(() => context(tx, input)),
            actual = createTenantContext(
              heldContext.actor,
              heldContext.brand,
              heldContext.store,
              heldContext.resolvedAt,
            );
          if (
            String(actual.actor.actorReference) !== String(input.actorReference) ||
            String(actual.brand.brandReference) !== String(brand) ||
            String(actual.store?.storeReference) !== String(store) ||
            actual.scopeKind !== "Store"
          )
            return fail();
          await wait(() => verifyBasis(tx, candidate, String(at)));
          const scope = createPublishingScope({
              kind: "Store",
              brandReference: actual.brand.brandReference,
              storeReference: current.storeReference,
            }),
            owner = createPostgresPublishingMutationStore(
              { run: async (work) => work(tx) },
              tenant,
              scope,
            ),
            ports = { authorization: authorize(tx), unitOfWork: owner },
            digest = parsePublishingDigest(hash(candidate)),
            nextId = () => {
              check();
              return parsePublishingReference(ids());
            },
            queryHead = {
              familyReference: family,
              lifecycleReference: parsePublishingReference(candidate.configurationReference),
              configurationType,
              purposeCode,
              observedAt: at,
            };
          if (hash(current) !== digest) return fail();
          const envelope = (
            operation: ExecutePublishingMutationInput["operation"],
            prior: PublishingLifecycleRecord | null,
            next: PublishingLifecycleRecord,
          ) => ({
            tenantContext: actual,
            operation,
            current: prior,
            next,
            expectedVersion: parsePublishingVersion(prior?.version ?? 1),
            idempotencyKey:
              operation === "CreateDraft"
                ? nextId()
                : parsePublishingReference(input.operationReference),
            auditId: nextId(),
            correlationId: parsePublishingReference(input.operationReference),
            occurredAt: at,
            sourceChannel: parsePublishingCode("MERCHANT_WEB"),
          });
          if (stage === "Submit") {
            if (
              current.lifecycle !== "Draft" ||
              candidate.approvedByReference !== null ||
              candidate.approvalEvidenceReference !== null ||
              candidate.publicationReference !== null ||
              candidate.liveGateEvidenceReference !== null
            )
              return fail();
            const prior = await wait(() => owner.resolveCurrentLifecycleMutation(queryHead));
            if (prior !== null) return fail();
            const facts = await wait(() => validate(tx, candidate, String(at))),
              businessUntil = parsePublishingInstant(facts.validUntil),
              actualCodes = parseCodes(facts.checkCodes);
            if (
              String(businessUntil) <= String(check()) ||
              JSON.stringify(actualCodes) !== JSON.stringify(codes)
            )
              return fail();
            const draft = createPublishingLifecycleRecord({
              lifecycleId: queryHead.lifecycleReference,
              familyReference: family,
              configurationType,
              purposeCode,
              snapshotReference: parsePublishingReference(candidate.configurationReference),
              snapshotDigest: digest,
              scope,
              version: parsePublishingVersion(1),
              state: "Draft",
              validationEvidenceReference: null,
              approvalEvidenceReference: null,
              createdAt: at,
              changedAt: at,
            });
            await wait(() =>
              executePublishingMutation(envelope("CreateDraft", null, draft), ports),
            );
            const evidence = createPublishingValidationEvidence({
                evidenceReference: nextId(),
                snapshotReference: draft.snapshotReference,
                snapshotDigest: digest,
                scope,
                result: "Pass",
                checkedAt: at,
                validUntil: businessUntil,
                checkCodes: actualCodes,
              }),
              review = createPublishingLifecycleRecord({
                ...draft,
                version: parsePublishingVersion(2),
                state: "InReview",
                validationEvidenceReference: evidence.evidenceReference,
              });
            await wait(() =>
              executePublishingMutation(
                { ...envelope("SubmitReview", draft, review), validationEvidence: evidence },
                ports,
              ),
            );
            return createStoreConfigurationVersion({
              ...candidate,
              lifecycle: "PendingApproval",
              updatedAt: at,
            });
          }
          if (stage === "Approve") {
            if (current.lifecycle !== "PendingApproval") return fail();
            const recorded = await wait(() => owner.resolveCurrentLifecycleMutation(queryHead));
            if (
              recorded === null ||
              recorded.operation !== "SubmitReview" ||
              recorded.next.state !== "InReview" ||
              recorded.validationEvidence === null ||
              recorded.next.snapshotDigest !== digest ||
              String(recorded.next.snapshotReference) !==
                String(candidate.configurationReference) ||
              recorded.audit.actor.type !== "User"
            )
              return fail();
            // WP-2423 DEC-SOLE-OPERATOR-APPROVAL: another person approves what someone created or
            // sent, except that person alone as an in-effect, re-verified sole operator; the
            // sole-operator path is never used for someone else's configuration.
            const self =
              String(candidate.authoredByReference) === String(input.actorReference) ||
              String(recorded.audit.actor.reference) === String(input.actorReference);
            if (self !== (sole !== undefined)) return fail();
            const soleOperator =
              sole === undefined ? null : await wait(() => sole.call(options, tx, input));
            const businessUntil = parsePublishingInstant(
                await wait(() => approvalUntil(tx, input)),
              ),
              validation = recorded.validationEvidence;
            if (
              String(businessUntil) <= String(check()) ||
              businessUntil > validation.validUntil ||
              JSON.stringify([...validation.checkCodes].sort()) !== JSON.stringify(codes)
            )
              return fail();
            const evidence = createPublishingApprovalEvidence({
                evidenceReference: nextId(),
                reviewLifecycleId: recorded.next.lifecycleId,
                reviewVersion: recorded.next.version,
                snapshotReference: recorded.next.snapshotReference,
                snapshotDigest: digest,
                scope,
                decision: "Accepted",
                approvedActorReference: parsePublishingReference(input.actorReference),
                approvedAt: at,
                validUntil: businessUntil,
              }),
              approved = createPublishingLifecycleRecord({
                ...recorded.next,
                state: "Approved",
                version: parsePublishingVersion(recorded.next.version + 1),
                approvalEvidenceReference: evidence.evidenceReference,
                changedAt: at,
              });
            await wait(() =>
              executePublishingMutation(
                { ...envelope("Approve", recorded.next, approved), approvalEvidence: evidence },
                ports,
              ),
            );
            if (soleOperator === null)
              await wait(() =>
                owner.resolveCurrentIndependentApproval({
                  ...queryHead,
                  snapshotReference: candidate.configurationReference,
                  snapshotDigest: digest,
                  requiredCheckCodes: codes,
                }),
              );
            else {
              const recordedApproval = await wait(() =>
                owner.resolveCurrentRecordedApproval({
                  ...queryHead,
                  snapshotReference: candidate.configurationReference,
                  snapshotDigest: digest,
                  requiredCheckCodes: codes,
                }),
              );
              if (
                recordedApproval.profile !== "CurrentRecordedPublishingApprovalV1" ||
                String(recordedApproval.approvedByActorReference) !==
                  String(input.actorReference) ||
                recordedApproval.approvalEvidenceReference !== evidence.evidenceReference
              )
                return fail();
              await wait(() =>
                recordStoreConfigurationSoleOperatorApproval(tx, {
                  brandReference: brand,
                  storeReference: store,
                  configurationReference: candidate.configurationReference,
                  operationReference: input.operationReference,
                  approvalEvidenceReference: evidence.evidenceReference,
                  actorReference: input.actorReference,
                  actorMfaAt: soleOperator.actorMfaAt,
                  approvedAt: at,
                  auditReference: input.auditReference,
                }),
              );
            }
            return createStoreConfigurationVersion({
              ...candidate,
              lifecycle: "Approved",
              approvedByReference: input.actorReference,
              approvalEvidenceReference: evidence.evidenceReference,
              updatedAt: at,
            });
          }
          if (current.lifecycle !== "Approved") return fail();
          const approval = await wait(() => owner.resolvePublicationCandidate(queryHead));
          if (
            approval.lifecycle.snapshotDigest !== digest ||
            String(approval.lifecycle.snapshotReference) !==
              String(candidate.configurationReference) ||
            String(approval.approvalEvidence.evidenceReference) !==
              String(current.approvalEvidenceReference) ||
            String(approval.approvalEvidence.approvedActorReference) !==
              String(current.approvedByReference)
          )
            return fail();
          const recordedApproval = await wait(() =>
            owner.resolveCurrentRecordedApproval({
              ...queryHead,
              snapshotReference: candidate.configurationReference,
              snapshotDigest: digest,
              requiredCheckCodes: codes,
            }),
          );
          if (
            recordedApproval.profile !== "CurrentRecordedPublishingApprovalV1" ||
            String(recordedApproval.approvedByActorReference) !==
              String(current.approvedByReference) ||
            String(recordedApproval.approvalEvidenceReference) !==
              String(current.approvalEvidenceReference)
          )
            return fail();
          // WP-2423: approved by the person who created or sent it only with its recorded
          // sole-operator approval.
          if (
            recordedApproval.recordedIndependence !== "Verified" ||
            String(current.approvedByReference) === String(current.authoredByReference)
          )
            await wait(() =>
              requireStoreConfigurationSoleOperatorApproval(tx, {
                brandReference: brand,
                storeReference: store,
                configurationReference: candidate.configurationReference,
                approverReference: String(current.approvedByReference),
                approvalEvidenceReference: String(current.approvalEvidenceReference),
              }),
            );
          const release = createPublishingReleaseRecord({
            releaseId: nextId(),
            familyReference: family,
            configurationType,
            purposeCode,
            snapshotReference: approval.lifecycle.snapshotReference,
            snapshotDigest: digest,
            scope,
            sequence: parseReleaseSequence((approval.previousRelease?.sequence ?? 0) + 1),
            sourceLifecycleId: approval.lifecycle.lifecycleId,
            kind: "Publish",
            previousReleaseId: approval.previousRelease?.releaseId ?? null,
            createdAt: at,
          });
          await wait(() =>
            executePublishingMutation(
              {
                ...envelope(
                  "Publish",
                  approval.lifecycle,
                  createPublishingLifecycleRecord({
                    ...approval.lifecycle,
                    state: "Published",
                    version: parsePublishingVersion(approval.lifecycle.version + 1),
                    changedAt: at,
                  }),
                ),
                validationEvidence: approval.validationEvidence,
                approvalEvidence: approval.approvalEvidence,
                release,
                ...(approval.previousRelease ? { previousRelease: approval.previousRelease } : {}),
              },
              ports,
            ),
          );
          const projected = createStoreConfigurationVersion({
            ...candidate,
            lifecycle: "Published",
            publicationReference: release.releaseId,
            liveGateEvidenceReference: parsePublishingReference(
              await wait(() => liveGate(tx, candidate, String(at))),
            ),
            updatedAt: at,
          });
          if (hash(projected) !== digest) return fail();
          return projected;
        } catch (error) {
          poisoned = true;
          if (error instanceof StoreConfigurationAdministrationServiceError) throw error;
          return fail();
        } finally {
          active = false;
        }
      };
    },
  });
}
