import { createHash } from "node:crypto";
import { readClosedRecord } from "@bop/identity";
import {
  createDiningSessionService,
  parseDiningReference,
  createPostgresDiningTableStore,
  createPostgresDiningSessionStartStore,
  createPostgresDiningJoinRegenerationStore,
  createPostgresDiningMovedJoinStore,
  type DiningCredentialPort,
} from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { withMerchantTransactionAuthorization } from "./merchant-transaction-authorization.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
const hashes = {
  hashIntent: (v: string) => "sha256:" + createHash("sha256").update(v).digest("hex"),
  equals: (a: string, b: string) => a === b,
};
const unavailable = (): never => {
  throw new Error("DINING_JOIN_REGENERATE_UNAVAILABLE");
};

/**
 * A new join code for the table's party, in the caller's transaction, by the staff member whose
 * `dining.operate` was decided for this run (`guard` re-checks it before the write). After the
 * party moved table (WP-2423 item 8 ⑧) the code is reissued for the table it sits at now, linked
 * to the move, so guests scan that table's code to join it.
 */
export async function regenerateDiningJoin(
  tx: unknown,
  input: {
    readonly scope: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
    };
    readonly tenantContext: unknown;
    readonly permission: unknown;
    readonly actorReference: string;
    readonly guard: () => Promise<boolean>;
    readonly credentials: DiningCredentialPort;
    readonly pepperVersion: number;
    newReference(): string;
    readonly retentionPolicyCode: string;
    readonly retentionPolicyVersion: number;
    readonly command: Readonly<Record<string, unknown>>;
    readonly requestedAt: string;
  },
) {
  const scope = input.scope;
  const runner = { run: <T>(work: (transaction: never) => Promise<T>) => work(tx as never) };
  const tables = createPostgresDiningTableStore(runner as never, scope as never, hashes);
  const start = createPostgresDiningSessionStartStore(
    runner as never,
    scope as never,
    input.credentials,
  );
  const regeneration = createPostgresDiningJoinRegenerationStore(
    runner as never,
    scope as never,
    input.credentials,
  );
  const moved = createPostgresDiningMovedJoinStore(
    runner as never,
    scope as never,
    input.credentials,
    hashes,
  );
  const service = createDiningSessionService({
    credentials: input.credentials,
    pepperVersion: input.pepperVersion,
    guests: { resolve: async () => null },
    abuse: { admit: async () => "Cooldown" },
    // WP-2423 item 8 ⑧: a party moved table gets its code reissued for the table it sits at now.
    movedJoin: {
      references: hashes,
      resolveMovedJoinState: moved.resolveMovedJoinState,
      reissueAfterMove: moved.reissueAfterMove,
    },
    store: {
      ...start,
      resolveJoinState: async () => null,
      resolveJoinOperation: async () => null,
      join: async () => unavailable(),
      ...regeneration,
    },
    staff: {
      authorize: async (request) => {
        if (request.operation !== "RegenerateJoinCredential") return null;
        // The permission decided for this run at its start (re-checked before the commit).
        if (!(await input.guard())) return null;
        const table = await tables.loadTable(request.tableReference);
        if (!table) return null;
        const active =
          table.activeDiningSessionReference === null
            ? null
            : await start.loadSession(table.activeDiningSessionReference);
        if (table.activeDiningSessionReference !== null && !active) return null;
        return {
          tenantContext: input.tenantContext as never,
          permission: input.permission as never,
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
            auditId: input.newReference(),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "User", reference: input.actorReference },
            actionCode: "DINING_JOIN_CREDENTIAL_REGENERATE",
            targetType: "DiningTable",
            targetId: table.tableReference,
            reasonCode: "STAFF_JOIN_CREDENTIAL_REGENERATE",
            correlationId: request.operationReference,
            occurredAt: request.observedAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Restricted",
            retentionPolicyCode: input.retentionPolicyCode,
            retentionPolicyVersion: input.retentionPolicyVersion,
          },
        };
      },
    },
  });
  return service.regenerate({ ...input.command, requestedAt: input.requestedAt } as never);
}

export function createMerchantDiningJoinRegenerate(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  credentials: DiningCredentialPort;
  pepperVersion: number;
  newReference(): string;
  retentionPolicyCode: string;
  retentionPolicyVersion: number;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const command = readClosedRecord(input.command, [
      "diningSessionReference",
      "tableReference",
      "expectedAssignmentVersion",
      "expectedSessionVersion",
      "expectedCapabilityVersion",
      "expectedGeneration",
      "operationReference",
    ]);
    // WP-2423: one authorized run. The caller and its `dining.operate` permission are resolved in
    // full once at the start and once more before the commit (inside this transaction, so a
    // withdrawn permission or ended Session never commits); the Dining staff callback in between,
    // which runs inside the Dining write, takes the run's no-query guard.
    return options.persistence.transactions.run((tx) =>
      withMerchantTransactionAuthorization(
        {
          transaction: tx,
          resolve: async () => {
            const current = await resolve(
              tx,
              input.sessionCookie,
              "dining.operate",
              authenticated.sessionReference,
            );
            const permission = await current.authorizeAction("dining.operate");
            if (permission?.effect !== "Allow") return unavailable();
            return { current, permission };
          },
          recheck: async ({ current }) => (await current.allowed()) === true,
          denied: unavailable,
        },
        async (authority) => {
          const { current, permission } = authority.scope;
          const result = await regenerateDiningJoin(tx, {
            scope: {
              tenantReference: String(current.selected.tenantReference),
              brandReference: String(current.context.brand.brandReference),
              storeReference: String(current.store.storeReference),
            },
            tenantContext: current.context,
            permission,
            actorReference: String(current.actorReference),
            guard: () => authority.guard(),
            credentials: options.credentials,
            pepperVersion: options.pepperVersion,
            newReference: options.newReference,
            retentionPolicyCode: options.retentionPolicyCode,
            retentionPolicyVersion: options.retentionPolicyVersion,
            command,
            requestedAt: String(current.context.resolvedAt),
          });
          return Object.freeze({
            status: result.status,
            generation: result.capability.generation,
            capabilityVersion: result.capability.version,
            joinKind: result.capability.kind,
            ...(result.status === "Issued" ? { joinCredential: result.joinCredential } : {}),
          });
        },
      ),
    );
  };
}
