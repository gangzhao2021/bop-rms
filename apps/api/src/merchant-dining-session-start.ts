import { createHash } from "node:crypto";
import { readClosedRecord } from "@bop/identity";
import {
  createDiningSessionService,
  parseDiningReference,
  createPostgresDiningTableStore,
  createPostgresDiningSessionStartStore,
  type DiningCredentialPort,
} from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
export function createMerchantDiningSessionStart(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  credentials: DiningCredentialPort;
  pepperVersion: number;
  newReference(): string;
  retentionPolicyCode: string;
  retentionPolicyVersion: number;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  const unavailable = (): never => {
    throw new Error("DINING_SESSION_START_UNAVAILABLE");
  };
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const command = readClosedRecord(input.command, [
      "tableReference",
      "expectedAssignmentVersion",
      "operationReference",
      "joinKind",
    ]);
    return options.persistence.transactions.run(async (tx) => {
      const current = await resolve(
        tx,
        input.sessionCookie,
        "dining.operate",
        authenticated.sessionReference,
      );
      if (!(await current.allowed())) return unavailable();
      const scope = {
          tenantReference: current.selected.tenantReference,
          brandReference: current.context.brand.brandReference,
          storeReference: current.store.storeReference,
        },
        runner = { run: <T>(work: (transaction: typeof tx) => Promise<T>) => work(tx) };
      const tables = createPostgresDiningTableStore(runner, scope, {
        hashIntent: (v) => "sha256:" + createHash("sha256").update(v).digest("hex"),
        equals: (a, b) => a === b,
      });
      const start = createPostgresDiningSessionStartStore(runner, scope, options.credentials);
      const service = createDiningSessionService({
        credentials: options.credentials,
        pepperVersion: options.pepperVersion,
        guests: { resolve: async () => null },
        abuse: { admit: async () => "Cooldown" },
        store: {
          ...start,
          resolveJoinState: async () => null,
          resolveActiveJoin: async () => null,
          resolveJoinOperation: async () => null,
          resolveRegenerationOperation: async () => null,
          join: async () => unavailable(),
          regenerate: async () => unavailable(),
        },
        staff: {
          authorize: async (request) => {
            if (request.operation !== "StartSession") return null;
            const permission = await current.authorizeAction("dining.operate");
            if (permission?.effect !== "Allow") return null;
            const table = await tables.loadTable(request.tableReference);
            if (!table) return null;
            const active =
              table.activeDiningSessionReference === null
                ? null
                : await start.loadSession(table.activeDiningSessionReference);
            if (table.activeDiningSessionReference !== null && !active) return null;
            if (!(await current.allowed())) return null;
            return {
              tenantContext: current.context,
              permission,
              table: {
                brandReference: parseDiningReference(scope.brandReference),
                storeReference: parseDiningReference(scope.storeReference),
                tableReference: table.tableReference,
                assignmentVersion: active?.tableAssignmentVersion ?? table.aggregateVersion,
                tableState:
                  table.lifecycle === "Published" && table.operationalState === "Available"
                    ? "Eligible"
                    : "Unavailable",
                activeDiningSessionReference: table.activeDiningSessionReference,
                observedAt: request.observedAt,
              },
              audit: {
                auditId: options.newReference(),
                brandId: scope.brandReference,
                storeId: scope.storeReference,
                actor: { type: "User", reference: current.actorReference },
                actionCode: "DINING_SESSION_START",
                targetType: "DiningTable",
                targetId: table.tableReference,
                reasonCode: "STAFF_SESSION_START",
                correlationId: request.operationReference,
                occurredAt: request.observedAt,
                sourceChannel: "MERCHANT_WEB",
                dataClassification: "Restricted",
                retentionPolicyCode: options.retentionPolicyCode,
                retentionPolicyVersion: options.retentionPolicyVersion,
              },
            };
          },
        },
      });
      const result = await service.start({ ...command, requestedAt: current.context.resolvedAt });
      if (!(await current.allowed())) return unavailable();
      return Object.freeze({
        status: result.status,
        diningSessionReference: result.session.diningSessionReference,
        sessionVersion: result.session.version,
        tableReference: result.session.tableReference,
        tableAssignmentVersion: result.session.tableAssignmentVersion,
        joinKind: result.capability.kind,
        ...(result.status === "Issued" ? { joinCredential: result.joinCredential } : {}),
      });
    });
  };
}
