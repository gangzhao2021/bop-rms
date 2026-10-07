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
} from "@rms/store";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { bindMerchantStoreConfigurationCommand } from "./merchant-store-configuration-command.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

type AdministrationOptions = Parameters<typeof createPersistentStoreConfigurationAdministration>[0];
type Tx = Parameters<AdministrationOptions["ports"]>[0];
type Scope = Awaited<ReturnType<ReturnType<typeof createMerchantStoreScope>>>;
type Method = ReturnType<typeof bindMerchantStoreConfigurationCommand>["method"];
type ReviewOptions = Parameters<typeof createPersistentStoreConfigurationReview>[0];
/** Runtime dependencies are owner sources, never supplied by the browser. */
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
  configure(
    tx: Tx,
    scope: Scope,
  ): Omit<AdministrationOptions, "brandReference" | "storeReference" | "run" | "now">;
}) {
  const source = options.persistence;
  const resolveScope = createMerchantStoreScope(source);
  const actions = { ...options.actionPermissions };
  for (const method of ["saveDraft", "validate", "submit", "approve", "publish"] as const)
    if (!parseBusinessAction(actions[method]).startsWith("store.service."))
      throw new Error("STORE_CONFIGURATION_PERMISSION_CONFIGURATION_INVALID");
  const write = async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const session = await options.authentication.authorize(input);
    return source.transactions.run(async (tx) => {
      // Resolve identity first; specific action is enforced before invoking owner dependencies.
      const selected = await resolveScope(
        tx,
        input.sessionCookie,
        "store.service.read",
        session.sessionReference,
      );
      const bound = bindMerchantStoreConfigurationCommand(input.command, {
        brandReference: selected.context.brand.brandReference,
        storeReference: selected.store.storeReference,
        actorReference: selected.actorReference,
        observedAt: source.now(),
      });
      const scope = await resolveScope(
        tx,
        input.sessionCookie,
        actions[bound.method],
        session.sessionReference,
      );
      if (
        scope.selected.tenantReference !== selected.selected.tenantReference ||
        (bound.input.configuration.setupBasis !== undefined &&
          bound.input.configuration.setupBasis.tenantReference !==
            scope.selected.tenantReference) ||
        scope.context.brand.brandReference !== bound.input.configuration.brandReference ||
        scope.store.storeReference !== bound.input.configuration.storeReference ||
        String(scope.actorReference) !== String(bound.input.actorReference) ||
        !(await scope.allowed())
      )
        throw new Error("STORE_CONFIGURATION_PERMISSION_DENIED");
      const configured = options.configure(tx, scope);
      const setupSnapshotReferences = {
        canonicalize: canonicalizeRfc8785,
        hashIntent: (canonical: string) => "sha256:" + sha256Hex(canonical),
      };
      const v2PublicationHash = createStoreConfigurationPublicationHash(setupSnapshotReferences);
      const administrationOptions: AdministrationOptions = {
        ...configured,
        brandReference: scope.context.brand.brandReference,
        storeReference: scope.store.storeReference,
        run: async (work) => work(tx),
        now: source.now,
        publication: {
          ...configured.publication,
          tenantReference: scope.selected.tenantReference,
          setupSnapshotReferences,
          hashContent: (value) =>
            createStoreConfigurationVersion(value).setupBasis === undefined
              ? configured.publication.hashContent(value)
              : v2PublicationHash(value),
          authorize: async (transaction, at) =>
            (await scope.allowed()) && (await configured.publication.authorize(transaction, at)),
        },
        ports: (transaction) => {
          const ports = configured.ports(transaction);
          return {
            ...ports,
            authorization: {
              authorize: async (command) =>
                String(command.actorReference) === String(scope.actorReference) &&
                (await scope.allowed()) &&
                (await ports.authorization.authorize(command)),
            },
          };
        },
      };
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
            authorize: async (request) => {
              if (request.action !== "publishing.release.publish" || !(await scope.allowed()))
                throw new Error("STORE_CONFIGURATION_PERMISSION_DENIED");
              const decision = await scope.authorizeAction(request.action);
              if (decision === null) throw new Error("STORE_CONFIGURATION_PERMISSION_DENIED");
              return decision;
            },
          }),
        })(bound.input, scope.context);
      } else if (bound.method === "approve" && options.review) {
        if (String(bound.input.configuration.approvedByReference) !== String(scope.actorReference))
          throw new Error("STORE_CONFIGURATION_PERMISSION_DENIED");
        const review = options.review;
        const publishingAuthorization: ReviewOptions["publishingAuthorization"] = () => ({
          authorize: async (request) => {
            if (
              ![
                "publishing.draft.create",
                "publishing.review.submit",
                "publishing.review.approve",
              ].includes(request.action) ||
              !(await scope.allowed())
            )
              throw new Error("STORE_CONFIGURATION_PERMISSION_DENIED");
            const decision = await scope.authorizeAction(request.action);
            if (decision === null) throw new Error("STORE_CONFIGURATION_PERMISSION_DENIED");
            return decision;
          },
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
        const prepared = await prepare(tx, bound.input.configuration, scope.context, source.now());
        const storeCommand = { ...bound.input, configuration: prepared.configuration };
        if (prepared.kind === "Replay") {
          result =
            await createPersistentStoreConfigurationAdministration(administrationOptions).approve(
              storeCommand,
            );
        } else {
          const approve = createPersistentStoreConfigurationReview({
            administration: administrationOptions,
            snapshotAudit: options.review.snapshotAudit,
            publishingAuthorization,
          });
          result = await approve({
            storeCommand,
            snapshot: prepared.snapshot,
            publishingApproval: { ...prepared.publishingApproval, tenantContext: scope.context },
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
    });
  };
  const read = async (sessionCookie: unknown) =>
    source.transactions.run(async (tx) => {
      const scope = await resolveScope(tx, sessionCookie, "store.service.read");
      if (!(await scope.allowed())) throw new Error("STORE_CONFIGURATION_PERMISSION_DENIED");
      const observedAt = source.now();
      const latest = await createPostgresStoreConfigurationAuthoringSource({
        brandReference: scope.context.brand.brandReference,
        storeReference: scope.store.storeReference,
        authorize: scope.allowed,
      })(tx, observedAt);
      const configured = options.configure(tx, scope);
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
      if (!(await scope.allowed())) throw new Error("STORE_CONFIGURATION_PERMISSION_DENIED");
      return Object.freeze({
        screenId: "STORE-HOURS-SERVICE" as const,
        storeReference: scope.store.storeReference,
        current,
        latest,
        expectedVersion: latest?.configurationVersion ?? current?.configurationVersion ?? 0,
        observedAt,
      });
    });
  return Object.assign(write, { read });
}
