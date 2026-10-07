import { parseCanonicalInstant } from "@bop/tenant";
import { createPostgresStoreConfigurationAdministration } from "./persistence/configuration-authoring-store.js";
import { createPostgresStorePublicationMaterializer } from "./persistence/publication-materializer.js";
import {
  createPostgresStoreApprovalAuthorization,
  createPostgresStoreV2ApprovalAuthorization,
  createPostgresStorePublicationAuthorization,
} from "./current-publication-proof.js";

type RepositoryOptions = Parameters<typeof createPostgresStoreConfigurationAdministration>[0];
type AuthorityOptions = Parameters<typeof createPostgresStorePublicationAuthorization>[0];
type MaterializerOptions = Parameters<typeof createPostgresStorePublicationMaterializer>[0];
type Transaction = Parameters<RepositoryOptions["ports"]>[0];
type Ports = ReturnType<RepositoryOptions["ports"]>;

/** Production composition: publishing and Live Gate are actual public-owner readers.
 * Policy, reference and approval sources must fence their authority in the supplied
 * transaction. now is a trusted server clock; it is never browser command time.
 */
export function createPersistentStoreConfigurationAdministration(
  options: Omit<RepositoryOptions, "ports" | "materializePublication"> & {
    ports(tx: Transaction): Omit<Ports, "approval" | "publishing" | "liveGate">;
    /** V1-only trusted persisted review snapshot. V2 uses actual Core independent history. */
    approvalSnapshot?(
      tx: Transaction,
      configuration: Parameters<Ports["approval"]["validate"]>[0],
      observedAt: string,
    ): Promise<{
      reviewedPublication: Parameters<Ports["approval"]["validate"]>[0];
      lifecycleReference: string;
    } | null>;
    now(): string;
    publication: Pick<
      AuthorityOptions,
      | "tenantReference"
      | "publishingFamilyReference"
      | "configurationType"
      | "purposeCode"
      | "requiredLiveGateRequirementCodes"
      | "requiredValidationCheckCodes"
      | "setupSnapshotReferences"
      | "hashContent"
      | "authorize"
    >;
    businessDayStartSource: MaterializerOptions["businessDayStartSource"];
    nextReference: MaterializerOptions["nextReference"];
  },
) {
  type Method = keyof ReturnType<typeof createPostgresStoreConfigurationAdministration>;
  const execute = (method: Method, raw: unknown) =>
    options.run(async (tx) => {
      const at = parseCanonicalInstant(options.now());
      const authority = createPostgresStorePublicationAuthorization({
        ...options.publication,
        brandReference: options.brandReference,
        storeReference: options.storeReference,
      });
      const approvalAuthority = createPostgresStoreApprovalAuthorization({
        ...options.publication,
        brandReference: options.brandReference,
        storeReference: options.storeReference,
      });
      const v2ApprovalAuthority = createPostgresStoreV2ApprovalAuthorization({
        ...options.publication,
        brandReference: options.brandReference,
        storeReference: options.storeReference,
      });
      let verified: Parameters<Ports["publishing"]["validate"]>[0] | null = null;
      const verify: Ports["publishing"]["validate"] = async (configuration) => {
        try {
          await authority(tx, configuration, at);
          verified = configuration;
          return true;
        } catch {
          verified = null;
          return false;
        }
      };
      const materialize = createPostgresStorePublicationMaterializer({
        ...options.publication,
        brandReference: options.brandReference,
        storeReference: options.storeReference,
        businessDayStartSource: options.businessDayStartSource,
        nextReference: options.nextReference,
        authorize: async (_transaction, input) => {
          await authority(tx, input.operation.configuration, at);
          return true;
        },
      });
      const repository = createPostgresStoreConfigurationAdministration({
        ...options,
        run: async (work) => work(tx),
        ports: (transaction) => {
          const ports = options.ports(transaction);
          return {
            ...ports,
            authorization: {
              authorize: (input) => ports.authorization.authorize({ ...input, observedAt: at }),
            },
            approval: {
              validate: async (configuration) => {
                try {
                  if (configuration.setupBasis !== undefined) {
                    await v2ApprovalAuthority(transaction, configuration, at);
                    return true;
                  }
                  if (options.approvalSnapshot === undefined) return false;
                  const snapshot = await options.approvalSnapshot(transaction, configuration, at);
                  if (snapshot === null) return false;
                  await approvalAuthority(transaction, { ...snapshot, configuration }, at);
                  return true;
                } catch {
                  return false;
                }
              },
            },
            publishing: { validate: verify },
            // Combined authority is fenced for this exact candidate in this transaction.
            liveGate: { validate: async (configuration) => verified === configuration },
          };
        },
        materializePublication: materialize,
      });
      return repository[method](raw);
    });
  return Object.freeze({
    saveDraft: (raw: unknown) => execute("saveDraft", raw),
    validate: (raw: unknown) => execute("validate", raw),
    submit: (raw: unknown) => execute("submit", raw),
    approve: (raw: unknown) => execute("approve", raw),
    publish: (raw: unknown) => execute("publish", raw),
  });
}
