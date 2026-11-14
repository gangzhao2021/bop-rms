import { createHash } from "node:crypto";
import { createMerchantStoreScope } from "../../apps/api/dist/merchant-store-scope.js";
import {
  createDiningSessionService,
  createPostgresDiningTableStore,
  createPostgresDiningSessionStartStore,
  createPostgresDiningJoinRegenerationStore,
  createPostgresDiningSessionJoinStore,
} from "../../packages/rms/dining/src/index.ts";
export async function createInternalDiningSession(resources, merchant, { loadCredentials }) {
  const credentials = await loadCredentials(resources),
    scope = {
      tenantReference: resources.publicProfile.binding.tenantReference,
      ...resources.scope,
    };
  const refs = {
    hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
    equals: (a, b) => a === b,
  };

  const audit = (action, target, at, actor, operation) => ({
    auditId: resources.credentials.reference(),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor,
    actionCode: action,
    targetType: actor.type === "System" ? "DiningSession" : "DiningTable",
    targetId: target,
    reasonCode: actor.type === "System" ? "AUTHORIZED_DINING_JOIN" : "INTERNAL_TEST_DINING",
    correlationId: operation ?? resources.credentials.reference(),
    occurredAt: at,
    sourceChannel: actor.type === "System" ? "CUSTOMER_PWA" : "API",
    dataClassification: actor.type === "System" ? "Restricted" : "Internal",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const stores = (runner) => ({
    table: createPostgresDiningTableStore(runner, scope, refs),
    start: createPostgresDiningSessionStartStore(runner, scope, credentials),
    regeneration: createPostgresDiningJoinRegenerationStore(runner, scope, credentials),
    join: createPostgresDiningSessionJoinStore(runner, scope, credentials, (descriptor) =>
      audit("DINING_SESSION_JOIN", descriptor.diningSessionReference, descriptor.occurredAt, {
        type: "System",
      }),
    ),
  });
  async function staffCommand(kind, input) {
    const authenticated = await merchant.authentication.authorize({
      sessionCookie: input.sessionCookie,
      csrf: input.csrf,
    });
    const at = resources.now();
    const resolveScope = createMerchantStoreScope({ ...merchant.persistence, now: () => at });
    return resources.transactions.run(async (tx) => {
      const runner = { run: async (work) => work(tx) },
        owner = stores(runner);
      const service = createDiningSessionService({
        pepperVersion: 1,
        credentials,
        guests: { resolve: async () => null },
        abuse: { admit: async () => "Cooldown" },
        store: { ...owner.start, ...owner.regeneration, ...owner.join },
        staff: {
          authorize: async (request) => {
            if (resources.now() >= resources.publicProfile.binding.validUntil) return null;
            const resolved = await resolveScope(
              tx,
              input.sessionCookie,
              "dining.operate",
              authenticated.sessionReference,
            );
            const permission = await resolved.authorizeAction("dining.operate");
            if (
              permission?.effect !== "Allow" ||
              resolved.selected.tenantReference !== scope.tenantReference ||
              resolved.store.storeReference !== scope.storeReference ||
              resolved.context.brand.brandReference !== scope.brandReference
            )
              return null;
            const table = await owner.table.loadTable(request.tableReference);
            if (!table) return null;
            const active =
              table.activeDiningSessionReference === null
                ? null
                : await owner.start.loadSession(table.activeDiningSessionReference);
            if (!(await resolved.allowed())) return null;
            return {
              tenantContext: resolved.context,
              permission,
              table: {
                brandReference: scope.brandReference,
                storeReference: scope.storeReference,
                tableReference: table.tableReference,
                assignmentVersion: active?.tableAssignmentVersion ?? table.aggregateVersion,
                tableState:
                  table.lifecycle === "Published" && table.operationalState === "Available"
                    ? "Eligible"
                    : "Unavailable",
                activeDiningSessionReference: table.activeDiningSessionReference,
                observedAt: request.observedAt,
              },
              audit: audit(
                request.operation === "StartSession"
                  ? "DINING_SESSION_START"
                  : "DINING_JOIN_CREDENTIAL_REGENERATE",
                request.tableReference,
                request.observedAt,
                { type: "User", reference: resolved.actorReference },
                request.operationReference,
              ),
            };
          },
        },
      });
      return service[kind]({ ...input.command, requestedAt: at });
    });
  }
  return {
    credentials,
    scope,
    stores: stores(resources.transactions),
    start: (input) => staffCommand("start", input),
    regenerate: (input) => staffCommand("regenerate", input),
  };
}
