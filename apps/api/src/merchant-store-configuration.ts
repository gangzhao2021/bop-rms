import { parseBusinessAction } from "@bop/permission";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPersistentStoreConfigurationAdministration,
  createPersistentStoreConfigurationReview,
  createPersistentStoreApprovalPreparation,
  createPersistentStoreConfigurationPublication,
  createPostgresStoreConfigurationAuthoringSource,
  createStoreConfigurationVersion,
  createStoreConfigurationPublicationHash,
  StoreConfigurationAdministrationServiceError,
} from "@rms/store";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import { bindMerchantStoreConfigurationCommand } from "./merchant-store-configuration-command.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

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
};
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
    // WP-2423: one authorized run. The caller, the command's permission and the Publishing
    // decisions the command may need are resolved in full once at the start (one permission
    // packet) and re-checked in full once more inside the transaction before it commits; owner
    // callbacks in between take the run's guard instead of re-resolving the caller (~30
    // statements each).
    const usedPublishing = new Set<string>();
    return source.transactions.run((tx) =>
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
            const bound = bindMerchantStoreConfigurationCommand(input.command, {
              brandReference: scope.context.brand.brandReference,
              storeReference: scope.store.storeReference,
              actorReference: scope.actorReference,
              observedAt: source.now(),
            });
            const action = actions[bound.method];
            // WP-2423 Q4: a configuration from Store setup is changed only through the hours draft
            // (an hours-only Store setup revision), never as a whole configuration from the browser.
            if (bound.method === "saveDraft" && bound.input.configuration.setupBasis !== undefined)
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
          const configured = options.configure(tx, scope, {
            authorize: (request) => publishingDecision(request.action, publishing),
            observedAt: bound.input.occurredAt,
          });
          const administrationOptions = storeConfigurationAdministrationOptions({
            configured,
            scope,
            transaction: tx,
            now: source.now,
            guard,
          });
          let result;
          if (
            bound.input.configuration.setupBasis !== undefined &&
            ["submit", "approve", "publish"].includes(bound.method)
          ) {
            // V2's fresh-only owning preparation performs real Core transitions after
            // original lookup/CAS. Legacy approval-time Submit is not a V2 path.
            result = await createPersistentStoreConfigurationAdministration(administrationOptions)[
              bound.method
            ](bound.input);
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
              String(bound.input.configuration.approvedByReference) !== String(scope.actorReference)
            )
              return denied();
            const review = options.review;
            const publishingAuthorization: ReviewOptions["publishingAuthorization"] = () => ({
              authorize: (request) => publishingDecision(request.action, approvalPublishingActions),
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
            const prepared = await prepare(
              tx,
              bound.input.configuration,
              scope.context,
              source.now(),
            );
            const storeCommand = { ...bound.input, configuration: prepared.configuration };
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
            result = await createPersistentStoreConfigurationAdministration(administrationOptions)[
              bound.method
            ](bound.input);
          }
          return Object.freeze({
            status: result.status,
            resultingVersion: result.operation.resultingVersion,
          });
        },
      ),
    );
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
          const observedAt = source.now();
          const latest = await createPostgresStoreConfigurationAuthoringSource({
            brandReference: scope.context.brand.brandReference,
            storeReference: scope.store.storeReference,
            authorize: () => authority.guard(),
          })(tx, observedAt);
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
          return Object.freeze({
            screenId: "STORE-HOURS-SERVICE" as const,
            storeReference: scope.store.storeReference,
            current,
            latest,
            expectedVersion: latest?.configurationVersion ?? current?.configurationVersion ?? 0,
            observedAt,
          });
        },
      ),
    );
  return Object.assign(write, { read });
}
