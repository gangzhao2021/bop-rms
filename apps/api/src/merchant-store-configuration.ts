import { listStoreRoleAssignments, parseBusinessAction } from "@bop/permission";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPersistentStoreConfigurationAdministration,
  createPersistentStoreConfigurationReview,
  createPersistentStoreApprovalPreparation,
  createPersistentStoreConfigurationPublication,
  createPostgresStoreConfigurationAuthoringSource,
  createStoreConfigurationVersion,
  createStoreConfigurationPublicationHash,
  readStoreConfigurationWithdrawal,
  readStoreConfigurationSubmitter,
  recordStoreConfigurationSoleOperatorApproval,
  StoreConfigurationAdministrationServiceError,
} from "@rms/store";
import { loadStoreMember, MemberDirectoryError } from "@bop/membership";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { bindMerchantStoreConfigurationCommand } from "./merchant-store-configuration-command.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
import {
  merchantStoreSoleOperatorGate,
  MerchantSoleOperatorBasisError,
  MerchantSoleOperatorGateError,
  requireMerchantStoreConfigurationSoleOperatorBasis,
  requireMerchantStoreSoleOperator,
  type ResolveContext,
} from "./merchant-sole-operator.js";
import { storeConfigurationDeclineReasonOf } from "./merchant-store-configuration-withdrawal.js";

type AdministrationOptions = Parameters<typeof createPersistentStoreConfigurationAdministration>[0];
type Tx = Parameters<AdministrationOptions["ports"]>[0];
type Scope = Awaited<ReturnType<ReturnType<typeof createMerchantStoreScope>>>;
type Method = ReturnType<typeof bindMerchantStoreConfigurationCommand>["method"];
type ReviewOptions = Parameters<typeof createPersistentStoreConfigurationReview>[0];
type Decision = Awaited<ReturnType<Scope["authorizeAction"]>>;
/**
 * WP-2423 Q4: the Publishing decisions of this run, for a configuration that came from Store setup
 * (its Submit, Approve and Publish are Publishing review steps). Only the decisions resolved at the
 * start of the run for the command's own step are answered; any other request is refused.
 */
export type StoreConfigurationPublishingAccess = ReturnType<
  ReviewOptions["publishingAuthorization"]
> & {
  /** When this run bound its command (its Publishing steps are recorded at this instant). */
  readonly observedAt: string;
  /**
   * WP-2423 DEC-SOLE-OPERATOR-APPROVAL: present only when the Owner explicitly approves their own
   * hours change from Store setup alone; the V2 preparation takes it as its sole-operator check.
   */
  readonly soleOperatorApproval?: (
    tx: Tx,
    input: { readonly occurredAt: string },
  ) => Promise<{ readonly actorMfaAt: string }>;
};
/**
 * WP-2423 (2026-10-16 v15): an hours save identical to what the Store already has saved (its open
 * change, or the published configuration when there is none or the latest was withdrawn or
 * declined) is refused and writes nothing: no configuration version, no Store setup revision.
 */
export class MerchantStoreHoursNoChangeError extends Error {
  readonly code = "NoChange" as const;
  constructor() {
    super("Nothing changed");
    this.name = "MerchantStoreHoursNoChangeError";
  }
}
type StoreConfigurationValue = ReturnType<typeof createStoreConfigurationVersion>;
/** Identity, lifecycle, provenance and approval fields: never what a person changes. */
const changeMetadata: ReadonlySet<string> = new Set([
  "setupBasis",
  "configurationReference",
  "configurationVersion",
  "lifecycle",
  "effectiveFrom",
  "supersedesConfigurationReference",
  "reasonCode",
  "authoredByReference",
  "approvedByReference",
  "approvalEvidenceReference",
  "publicationReference",
  "liveGateEvidenceReference",
  "createdAt",
  "updatedAt",
]);
const changeContent = (value: StoreConfigurationValue) =>
  canonicalizeRfc8785(
    Object.fromEntries(
      Object.entries(value).filter(([key, item]) => !changeMetadata.has(key) && item !== undefined),
    ),
  );
/** Whether `next` changes nothing a person edits (hours, closures, end date, services...). */
export function storeConfigurationChangesNothing(
  base: StoreConfigurationValue,
  next: StoreConfigurationValue,
): boolean {
  return changeContent(base) === changeContent(next);
}
/**
 * The configuration an hours change is compared with: the Store's latest recorded one, or the
 * published one when the latest is an open change that was withdrawn or declined (it decides
 * nothing) or nothing was recorded since publication.
 */
export async function storeHoursChangeBase(
  tx: Parameters<typeof readStoreConfigurationWithdrawal>[0],
  input: {
    readonly brandReference: string;
    readonly storeReference: string;
    readonly published: StoreConfigurationValue | null;
    readonly recorded: StoreConfigurationValue | null;
  },
): Promise<StoreConfigurationValue | null> {
  const { published, recorded } = input;
  if (recorded === null) return published;
  const open =
    published !== null &&
    recorded.configurationReference !== published.configurationReference &&
    (recorded.lifecycle === "Draft" ||
      recorded.lifecycle === "PendingApproval" ||
      recorded.lifecycle === "Approved");
  if (
    open &&
    (await readStoreConfigurationWithdrawal(tx, {
      brandReference: input.brandReference,
      storeReference: input.storeReference,
      configurationReference: recorded.configurationReference,
    })) !== null
  )
    return published;
  return recorded;
}
/** The permission whose holders decide whether sole operator is in effect at the Store. */
const soleOperatorPermission = "store.service.approve";
/** WP-2423: the optional "approve alone as sole operator" request beside a configuration command. */
function splitApprovalMode(raw: unknown): {
  readonly command: unknown;
  readonly approvalMode: "SoleOperator" | undefined;
} {
  if (
    raw === null ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.getPrototypeOf(raw) !== Object.prototype ||
    !Object.hasOwn(raw, "approvalMode")
  )
    return { command: raw, approvalMode: undefined };
  const descriptor = Object.getOwnPropertyDescriptor(raw, "approvalMode");
  if (!descriptor || !("value" in descriptor) || descriptor.value !== "SoleOperator")
    throw new StoreConfigurationAdministrationServiceError("STORE_CONFIGURATION_COMMAND_INVALID");
  const command: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  Reflect.deleteProperty(command, "approvalMode");
  return { command, approvalMode: "SoleOperator" };
}
/** The Publishing decisions each step of a setup-based configuration needs (WP-2423 Q4). */
export const setupBasedPublishingActions: Readonly<Record<Method, readonly string[]>> =
  Object.freeze({
    saveDraft: [],
    validate: [],
    submit: ["publishing.draft.create", "publishing.review.submit"],
    approve: ["publishing.review.approve"],
    publish: ["publishing.release.publish"],
  });
export type MerchantStoreConfigurationOptions = Parameters<
  typeof createMerchantStoreConfiguration
>[0];
type Configured = ReturnType<MerchantStoreConfigurationOptions["configure"]>;
/**
 * The Store administration options of one authorized run: owner configuration with this run's
 * guard on every authority callback (WP-2423: no caller re-resolution inside the run).
 */
export function storeConfigurationAdministrationOptions(input: {
  readonly configured: Configured;
  readonly scope: Scope;
  readonly transaction: Tx;
  readonly now: () => string;
  readonly guard: () => Promise<boolean>;
}): AdministrationOptions {
  const { configured, scope, transaction: tx, guard } = input;
  const setupSnapshotReferences = {
    canonicalize: canonicalizeRfc8785,
    hashIntent: (canonical: string) => "sha256:" + sha256Hex(canonical),
  };
  const v2PublicationHash = createStoreConfigurationPublicationHash(setupSnapshotReferences);
  return {
    ...configured,
    brandReference: scope.context.brand.brandReference,
    storeReference: scope.store.storeReference,
    run: async (work) => work(tx),
    now: input.now,
    publication: {
      ...configured.publication,
      tenantReference: scope.selected.tenantReference,
      setupSnapshotReferences,
      // The materializer also digests interval content, which is not a configuration:
      // only a configuration carrying a Setup basis uses the V2 publication hash
      // (WP-2423 Q4).
      hashContent: (value) =>
        isSetupBasedConfiguration(value)
          ? v2PublicationHash(value)
          : configured.publication.hashContent(value),
      authorize: async (transaction, at) =>
        (await guard()) && (await configured.publication.authorize(transaction, at)),
    },
    ports: (transaction) => {
      const ports = configured.ports(transaction);
      return {
        ...ports,
        authorization: {
          authorize: async (command) =>
            String(command.actorReference) === String(scope.actorReference) &&
            (await guard()) &&
            (await ports.authorization.authorize(command)),
        },
      };
    },
  };
}
const denied = (): never => {
  throw new Error("STORE_CONFIGURATION_PERMISSION_DENIED");
};
const approvalPublishingActions = [
  "publishing.draft.create",
  "publishing.review.submit",
  "publishing.review.approve",
] as const;
/** Runtime dependencies are owner sources, never supplied by the browser. */
/** WP-2423 Q4: true only for a Store configuration that carries a Setup basis. */
export function isSetupBasedConfiguration(value: unknown): boolean {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.hasOwn(value, "configurationReference")
  )
    return false;
  return createStoreConfigurationVersion(value).setupBasis !== undefined;
}

export function createMerchantStoreConfiguration(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  actionPermissions: Readonly<Record<Method, string>>;
  review?: {
    validate(
      tx: Tx,
      scope: Scope,
      configuration: Parameters<
        Parameters<typeof createPersistentStoreApprovalPreparation>[0]["validate"]
      >[1],
      at: string,
    ): ReturnType<Parameters<typeof createPersistentStoreApprovalPreparation>[0]["validate"]>;
    snapshotAudit: ReviewOptions["snapshotAudit"];
  };
  /**
   * WP-2423 DEC-SOLE-OPERATOR-APPROVAL (Owner decision 2026-10-16): the run's workforce context
   * for evaluating who else at the Store holds Store configuration approval. Absent: an Owner never
   * approves their own hours change.
   */
  soleOperator?: {
    resolveContext(tx: Tx, scope: Scope): ResolveContext;
  };
  /**
   * `publishing` answers the Publishing decisions this run resolved for its command (WP-2423 Q4:
   * Submit, Approve and Publish of a configuration from Store setup); it refuses anything else.
   */
  configure(
    tx: Tx,
    scope: Scope,
    publishing: StoreConfigurationPublishingAccess,
  ): Omit<AdministrationOptions, "brandReference" | "storeReference" | "run" | "now">;
}) {
  const source = options.persistence;
  const resolveScope = createMerchantStoreScope(source);
  const actions = { ...options.actionPermissions };
  for (const method of ["saveDraft", "validate", "submit", "approve", "publish"] as const)
    if (!parseBusinessAction(actions[method]).startsWith("store.service."))
      throw new Error("STORE_CONFIGURATION_PERMISSION_CONFIGURATION_INVALID");
  /**
   * WP-2423: the scope handed to owner configuration for this run. Its `allowed` is the run's
   * guard (no query): true only while the run is in progress. The caller and permission were
   * resolved in full at the start and are re-checked in full before the reply or commit.
   */
  const runScope = (scope: Scope, guard: () => Promise<boolean>): Scope =>
    Object.freeze({ ...scope, allowed: guard });
  const write = async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const session = await options.authentication.authorize(input);
    // WP-2423 DEC-SOLE-OPERATOR-APPROVAL: an explicit request to approve one's own change alone.
    const { command: rawCommand, approvalMode } = splitApprovalMode(input.command);
    const sole = approvalMode === "SoleOperator";
    let soleRefusal: MerchantSoleOperatorGateError | undefined;
    let basisRefusal: MerchantSoleOperatorBasisError | undefined;
    let noChange: MerchantStoreHoursNoChangeError | undefined;
    // WP-2423: one authorized run. The caller, the command's permission and the Publishing
    // decisions the command may need are resolved in full once at the start (one permission
    // packet) and re-checked in full once more inside the transaction before it commits; owner
    // callbacks in between take the run's guard instead of re-resolving the caller (~30
    // statements each).
    const usedPublishing = new Set<string>();
    return source.transactions
      .run((tx) =>
        withMerchantTransactionAuthorization(
          {
            transaction: tx,
            resolve: async () => {
              // Identity first; the specific action is decided before any owner dependency runs.
              const scope = await resolveScope(
                tx,
                input.sessionCookie,
                "store.service.read",
                session.sessionReference,
              );
              const bound = bindMerchantStoreConfigurationCommand(rawCommand, {
                brandReference: scope.context.brand.brandReference,
                storeReference: scope.store.storeReference,
                actorReference: scope.actorReference,
                observedAt: source.now(),
              });
              const action = actions[bound.method];
              if (sole && (bound.method !== "approve" || options.soleOperator === undefined))
                throw new StoreConfigurationAdministrationServiceError(
                  "STORE_CONFIGURATION_COMMAND_INVALID",
                );
              // WP-2423 Q4: a configuration from Store setup is changed only through the hours draft
              // (an hours-only Store setup revision), never as a whole configuration from the browser.
              if (
                bound.method === "saveDraft" &&
                bound.input.configuration.setupBasis !== undefined
              )
                throw new StoreConfigurationAdministrationServiceError(
                  "STORE_CONFIGURATION_COMMAND_INVALID",
                );
              const publishing: readonly string[] =
                bound.input.configuration.setupBasis !== undefined
                  ? setupBasedPublishingActions[bound.method]
                  : !options.review
                    ? []
                    : bound.method === "publish"
                      ? ["publishing.release.publish"]
                      : bound.method === "approve"
                        ? approvalPublishingActions
                        : [];
              const decisions = await scope.authorizeActions([action, ...publishing]);
              if (
                (bound.input.configuration.setupBasis !== undefined &&
                  bound.input.configuration.setupBasis.tenantReference !==
                    scope.selected.tenantReference) ||
                scope.context.brand.brandReference !== bound.input.configuration.brandReference ||
                scope.store.storeReference !== bound.input.configuration.storeReference ||
                String(scope.actorReference) !== String(bound.input.actorReference) ||
                decisions.get(action)?.effect !== "Allow"
              )
                return denied();
              return { scope, bound, action, decisions, publishing };
            },
            recheck: async ({ scope, action, decisions }) => {
              const rechecked = [action, ...usedPublishing];
              const current = await scope.authorizeActions(rechecked);
              return (
                current.get(action)?.effect === "Allow" &&
                [...usedPublishing].every(
                  (item) =>
                    current.get(item)?.effect !== undefined &&
                    current.get(item)?.effect === decisions.get(item)?.effect,
                )
              );
            },
            denied,
          },
          async (authority) => {
            const { scope: resolved, bound, decisions, publishing } = authority.scope;
            const guard = () => authority.guard();
            const scope = runScope(resolved, guard);
            /** A Publishing decision taken at the start of this run (no query). */
            const publishingDecision = async (
              action: string,
              permitted: readonly string[],
            ): Promise<NonNullable<Decision>> => {
              if (!permitted.includes(action) || !(await guard())) return denied();
              const decision = decisions.get(action);
              if (decision === null || decision === undefined) return denied();
              usedPublishing.add(action);
              return decision;
            };
            // WP-2423 DEC-SOLE-OPERATOR-APPROVAL: the person who made or sent a change approves it
            // only when they ask to approve it alone as sole operator; nobody else uses that path.
            if (bound.method === "approve") {
              const target = bound.input.configuration,
                actor = String(scope.actorReference);
              if (!(await guard())) return denied();
              // Since only the author sends a change for approval, the sender is read only when
              // the Owner asks to approve alone a change someone else made.
              const self =
                String(target.authoredByReference) === actor ||
                (sole &&
                  (await readStoreConfigurationSubmitter(tx, {
                    brandReference: scope.context.brand.brandReference,
                    storeReference: scope.store.storeReference,
                    configurationReference: target.configurationReference,
                  })) === actor);
              if (self !== sole)
                throw new StoreConfigurationAdministrationServiceError(
                  sole
                    ? "STORE_CONFIGURATION_COMMAND_INVALID"
                    : "STORE_CONFIGURATION_SELF_APPROVAL",
                );
            }
            // WP-2423 (v15 2026-10-16): a configuration approved alone is published only if sole
            // operator was On when that approval was given.
            // Checked once the caller may publish (an unauthorized publish is refused as before).
            if (
              bound.method === "publish" &&
              publishing.every((item) => decisions.get(item)?.effect === "Allow")
            ) {
              if (!(await guard())) return denied();
              try {
                await requireMerchantStoreConfigurationSoleOperatorBasis(tx as never, {
                  tenantReference: scope.selected.tenantReference,
                  brandReference: scope.context.brand.brandReference,
                  storeReference: scope.store.storeReference,
                  configurationReference: bound.input.configuration.configurationReference,
                  allowed: guard,
                });
              } catch (error) {
                if (error instanceof MerchantSoleOperatorBasisError) basisRefusal = error;
                throw error;
              }
            }
            const soleOperator = options.soleOperator;
            /** Sole operator in effect for the caller now, with a second factor ≤ 15 minutes old. */
            const soleCheck = async (observedAt: string) => {
              if (!sole || soleOperator === undefined || !(await guard())) return denied();
              try {
                return await requireMerchantStoreSoleOperator(tx as never, {
                  tenantReference: scope.selected.tenantReference,
                  brandReference: scope.context.brand.brandReference,
                  storeReference: scope.store.storeReference,
                  actorReference: String(scope.actorReference),
                  permissionCode: soleOperatorPermission,
                  observedAt,
                  resolveContext: soleOperator.resolveContext(tx, scope),
                  allowed: guard,
                });
              } catch (error) {
                if (error instanceof MerchantSoleOperatorGateError) soleRefusal = error;
                throw error;
              }
            };
            const configured = options.configure(tx, scope, {
              authorize: (request) => publishingDecision(request.action, publishing),
              observedAt: bound.input.occurredAt,
              ...(sole
                ? {
                    soleOperatorApproval: async (
                      actual: Tx,
                      packet: { readonly occurredAt: string },
                    ) => (actual === tx ? soleCheck(String(packet.occurredAt)) : denied()),
                  }
                : {}),
            });
            // WP-2423 v15 (`8bd902e3` D2): the PUBLISHED configuration decides the kind of hours
            // change; an ordinary change never follows a published configuration from Store setup
            // (whatever the latest, possibly withdrawn, change is).
            if (bound.method === "saveDraft") {
              const publishedValue = await configured.publishedBaseline(tx);
              const published =
                publishedValue === null ? null : createStoreConfigurationVersion(publishedValue);
              if (published?.setupBasis !== undefined)
                throw new StoreConfigurationAdministrationServiceError(
                  "STORE_CONFIGURATION_LIFECYCLE_CONFLICT",
                );
              // WP-2423 (2026-10-16 v15): saving the hours already saved writes nothing. A retry
              // of a change already recorded (same configuration) still returns its result.
              const candidate = bound.input.configuration;
              const recorded =
                (await createPostgresStoreConfigurationAuthoringSource({
                  brandReference: scope.context.brand.brandReference,
                  storeReference: scope.store.storeReference,
                  mode: "Write",
                  authorize: async (actual) => actual === tx && (await guard()),
                })(tx, () => source.now())) ?? null;
              if (recorded?.configurationReference !== candidate.configurationReference) {
                const base = await storeHoursChangeBase(tx, {
                  brandReference: scope.context.brand.brandReference,
                  storeReference: scope.store.storeReference,
                  published,
                  recorded,
                });
                if (base !== null && storeConfigurationChangesNothing(base, candidate)) {
                  noChange = new MerchantStoreHoursNoChangeError();
                  throw noChange;
                }
              }
            }
            // An approval or publication of an hours change takes the Store configuration head
            // lock first (as every configuration writer does) and acts only on the head it was
            // asked about. A second person approving or publishing the same change at the same
            // moment then waits and is told it changed (409), instead of the two deadlocking on
            // the review snapshot (503).
            if (
              (bound.method === "approve" || bound.method === "publish") &&
              bound.input.configuration.setupBasis === undefined &&
              options.review
            ) {
              const head = await createPostgresStoreConfigurationAuthoringSource({
                brandReference: scope.context.brand.brandReference,
                storeReference: scope.store.storeReference,
                mode: "Write",
                authorize: async (actual) => actual === tx && (await guard()),
              })(tx, () => source.now());
              // The head may already be the result of this command (a retry is answered as before).
              const states =
                bound.method === "approve"
                  ? ["PendingApproval", "Approved"]
                  : ["Approved", "Published"];
              if (
                head === null ||
                head.configurationReference !== bound.input.configuration.configurationReference ||
                head.configurationVersion !== bound.input.expectedVersion ||
                !states.includes(head.lifecycle)
              )
                throw new StoreConfigurationAdministrationServiceError(
                  "STORE_CONFIGURATION_VERSION_CONFLICT",
                );
            }
            const baseOptions = storeConfigurationAdministrationOptions({
              configured,
              scope,
              transaction: tx,
              now: source.now,
              guard,
            });
            // WP-2423: the approval given alone says so on its audit record.
            const administrationOptions: AdministrationOptions = sole
              ? {
                  ...baseOptions,
                  appendAudit: async (actual, packet) => {
                    const marked =
                      packet.operation.command === "Approve"
                        ? Object.freeze({ ...packet, approvalMode: "SoleOperator" as const })
                        : packet;
                    return baseOptions.appendAudit(actual, marked);
                  },
                }
              : baseOptions;
            let result;
            if (
              bound.input.configuration.setupBasis !== undefined &&
              ["submit", "approve", "publish"].includes(bound.method)
            ) {
              // V2's fresh-only owning preparation performs real Core transitions after
              // original lookup/CAS. Legacy approval-time Submit is not a V2 path.
              result = await createPersistentStoreConfigurationAdministration(
                administrationOptions,
              )[bound.method](bound.input);
            } else if (bound.method === "publish" && options.review) {
              result = await createPersistentStoreConfigurationPublication({
                administration: administrationOptions,
                snapshotAudit: options.review.snapshotAudit,
                publishingAuthorization: () => ({
                  authorize: (request) =>
                    publishingDecision(request.action, ["publishing.release.publish"]),
                }),
              })(bound.input, scope.context);
            } else if (bound.method === "approve" && options.review) {
              if (
                String(bound.input.configuration.approvedByReference) !==
                String(scope.actorReference)
              )
                return denied();
              const review = options.review;
              const publishingAuthorization: ReviewOptions["publishingAuthorization"] = () => ({
                authorize: (request) =>
                  publishingDecision(request.action, approvalPublishingActions),
              });
              const prepare = createPersistentStoreApprovalPreparation({
                ...administrationOptions.publication,
                brandReference: scope.context.brand.brandReference,
                storeReference: scope.store.storeReference,
                nextReference: administrationOptions.nextReference,
                appendAudit: review.snapshotAudit,
                publishingAuthorization,
                validate: async (transaction, configuration, at) => {
                  const references = configured.ports(transaction).references;
                  if (
                    !(await references.validateControlledReferences(configuration)) ||
                    !(await references.validateBrandBaseCompatibility(configuration))
                  )
                    throw new Error("STORE_CONFIGURATION_REFERENCE_INVALID");
                  return review.validate(transaction, scope, configuration, at);
                },
              });
              // WP-2423: decided before anything is written; recorded with the approval below.
              const soleGate = sole ? await soleCheck(bound.input.occurredAt) : undefined;
              const prepared = await prepare(
                tx,
                bound.input.configuration,
                scope.context,
                source.now(),
              );
              const storeCommand = { ...bound.input, configuration: prepared.configuration };
              // The sole-operator mark precedes the approval it marks (the database checks both).
              if (soleGate !== undefined && prepared.kind === "Approve")
                await recordStoreConfigurationSoleOperatorApproval(tx, {
                  brandReference: scope.context.brand.brandReference,
                  storeReference: scope.store.storeReference,
                  configurationReference: prepared.configuration.configurationReference,
                  operationReference: bound.input.operationReference,
                  approvalEvidenceReference: String(
                    prepared.configuration.approvalEvidenceReference,
                  ),
                  actorReference: String(scope.actorReference),
                  actorMfaAt: soleGate.actorMfaAt,
                  approvedAt: bound.input.occurredAt,
                  auditReference: bound.input.auditReference,
                });
              if (prepared.kind === "Replay") {
                result =
                  await createPersistentStoreConfigurationAdministration(
                    administrationOptions,
                  ).approve(storeCommand);
              } else {
                const approve = createPersistentStoreConfigurationReview({
                  administration: administrationOptions,
                  snapshotAudit: options.review.snapshotAudit,
                  publishingAuthorization,
                });
                result = await approve({
                  storeCommand,
                  snapshot: prepared.snapshot,
                  publishingApproval: {
                    ...prepared.publishingApproval,
                    tenantContext: scope.context,
                  },
                });
              }
            } else {
              result = await createPersistentStoreConfigurationAdministration(
                administrationOptions,
              )[bound.method](bound.input);
            }
            return Object.freeze({
              status: result.status,
              resultingVersion: result.operation.resultingVersion,
            });
          },
        ),
      )
      .catch((error: unknown) => {
        // The transaction host reports owner failures generically; the sole-operator refusal of
        // this run says why (turned off, someone else also approves, verify again).
        if (soleRefusal !== undefined) throw soleRefusal;
        if (basisRefusal !== undefined) throw basisRefusal;
        if (noChange !== undefined) throw noChange;
        throw error;
      });
  };
  /** Reads never take a Publishing decision. */
  const refusePublishing = (): StoreConfigurationPublishingAccess => ({
    authorize: async () => denied(),
    observedAt: source.now(),
  });
  const read = async (sessionCookie: unknown) =>
    source.transactions.run((tx) =>
      withMerchantTransactionAuthorization(
        {
          transaction: tx,
          resolve: async () => {
            const scope = await resolveScope(tx, sessionCookie, "store.service.read");
            if (!(await scope.allowed())) return denied();
            return scope;
          },
          recheck: async (scope) => (await scope.allowed()) === true,
          denied,
        },
        async (authority) => {
          const scope = runScope(authority.scope, () => authority.guard());
          // The head is read under its lock at the time it is read, and this read is observed
          // after it, so a change committed while the read waited is shown, not an outage.
          const latest = await createPostgresStoreConfigurationAuthoringSource({
            brandReference: scope.context.brand.brandReference,
            storeReference: scope.store.storeReference,
            authorize: () => authority.guard(),
          })(tx, () => source.now());
          const observedAt = source.now();
          const configured = options.configure(tx, scope, refusePublishing());
          const baseline = await configured.publishedBaseline(tx);
          const current = baseline === null ? null : createStoreConfigurationVersion(baseline);
          if (
            current !== null &&
            (current.lifecycle !== "Published" ||
              current.brandReference !== scope.context.brand.brandReference ||
              current.storeReference !== scope.store.storeReference)
          )
            throw new Error("STORE_CONFIGURATION_READ_UNAVAILABLE");
          if (
            (latest?.setupBasis !== undefined &&
              latest.setupBasis.tenantReference !== scope.selected.tenantReference) ||
            (current?.setupBasis !== undefined &&
              current.setupBasis.tenantReference !== scope.selected.tenantReference)
          )
            throw new Error("STORE_CONFIGURATION_READ_UNAVAILABLE");
          // WP-2423 (v15 D2/D3): staff see whose change is open and whether it was withdrawn or
          // declined, so no one replaces another person's open change without knowing it.
          const withdrawal =
            latest !== null &&
            (latest.lifecycle === "Draft" ||
              latest.lifecycle === "PendingApproval" ||
              latest.lifecycle === "Approved")
              ? await readStoreConfigurationWithdrawal(tx, {
                  brandReference: scope.context.brand.brandReference,
                  storeReference: scope.store.storeReference,
                  configurationReference: latest.configurationReference,
                })
              : null;
          const open =
            latest !== null &&
            withdrawal === null &&
            (latest.lifecycle === "Draft" ||
              latest.lifecycle === "PendingApproval" ||
              latest.lifecycle === "Approved");
          const viewer = String(scope.actorReference),
            brandReference = scope.context.brand.brandReference,
            storeReference = scope.store.storeReference;
          // WP-2423 (v15): staff see who made a change that is still open (by the name the Store
          // keeps; none when they are no longer a member). v15 `8bd902e3` D3: a member the Store
          // keeps no name for is described by their Store (or Brand) role ("the Owner"); the
          // product holds no other workforce name, and a reference is never shown.
          let latestAuthorName: string | null = null;
          let viewerMayDecline = false;
          if (open && String(latest.authoredByReference) !== viewer) {
            const author = String(latest.authoredByReference);
            latestAuthorName = await loadStoreMember(
              tx as never,
              { brandReference, storeReference },
              author,
            ).then(
              (member) => member.displayName ?? null,
              // Not a member any more: no name. A database failure is not swallowed (the transaction
              // would be unusable for the reads that follow).
              (error: unknown) => {
                if (error instanceof MemberDirectoryError) return null;
                throw error;
              },
            );
            if (latestAuthorName === null)
              for (const roleScope of [storeReference, null]) {
                const named = (
                  await listStoreRoleAssignments(
                    tx as never,
                    { brandReference, storeReference: roleScope },
                    observedAt,
                  )
                ).assignments.find(
                  (item) =>
                    item.actorReference === author &&
                    item.roleName !== item.roleCode &&
                    item.roleName.length > 0 &&
                    item.roleName.length <= 60,
                );
                if (named !== undefined) {
                  latestAuthorName = "the " + named.roleName;
                  break;
                }
              }
            // v15 `8bd902e3` D9: only people who may decline (Store configuration approval) are
            // offered "Decline this change".
            viewerMayDecline =
              (await scope.authorizeActions(["store.service.approve"])).get("store.service.approve")
                ?.effect === "Allow";
          }
          // WP-2423 (v15 2026-10-16): whether the viewer may approve an open change at all, so a
          // Store Manager who sent one reads that an Owner approves it (not sole-operator advice).
          const viewerMayApprove =
            open &&
            (await scope.authorizeActions(["store.service.approve"])).get("store.service.approve")
              ?.effect === "Allow";
          // WP-2423 DEC-SOLE-OPERATOR-APPROVAL: the Owner who made or sent the change awaiting
          // approval sees whether they may approve it alone, and why not.
          let soleOperator: Awaited<ReturnType<typeof merchantStoreSoleOperatorGate>> | null = null;
          if (
            open &&
            options.soleOperator !== undefined &&
            latest.lifecycle === "PendingApproval" &&
            (String(latest.authoredByReference) === viewer ||
              (await readStoreConfigurationSubmitter(tx, {
                brandReference,
                storeReference,
                configurationReference: latest.configurationReference,
              })) === viewer)
          )
            soleOperator = await merchantStoreSoleOperatorGate(tx as never, {
              tenantReference: scope.selected.tenantReference,
              brandReference,
              storeReference,
              actorReference: viewer,
              permissionCode: soleOperatorPermission,
              observedAt,
              resolveContext: options.soleOperator.resolveContext(tx, scope),
              allowed: () => authority.guard(),
            });
          return Object.freeze({
            screenId: "STORE-HOURS-SERVICE" as const,
            storeReference: scope.store.storeReference,
            viewerActorReference: String(scope.actorReference),
            latestWithdrawal:
              withdrawal === null
                ? null
                : Object.freeze({
                    kind: withdrawal.kind,
                    withdrawnAt: withdrawal.withdrawnAt,
                    byYou: withdrawal.actorReference === String(scope.actorReference),
                    // WP-2423 (v15): the decliner's reason, when they gave one.
                    reason: storeConfigurationDeclineReasonOf(withdrawal.reasonCode),
                  }),
            current,
            latest,
            expectedVersion: latest?.configurationVersion ?? current?.configurationVersion ?? 0,
            observedAt,
            latestAuthorName,
            viewerMayDecline,
            viewerMayApprove,
            soleOperator:
              soleOperator === null
                ? null
                : Object.freeze({
                    status: soleOperator.status,
                    otherApprovers: soleOperator.otherApprovers,
                    verifiedUntil: soleOperator.verifiedUntil,
                  }),
          });
        },
      ),
    );
  return Object.assign(write, { read });
}
