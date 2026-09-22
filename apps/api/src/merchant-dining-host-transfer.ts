import { readClosedRecord } from "@bop/identity";
import { createPostgresDiningHostTransferStore, parseDiningHostTransferCommand } from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
const fail = (): never => {
  throw new Error("DINING_HOST_TRANSFER_UNAVAILABLE");
};
export function createMerchantDiningHostTransfer(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  newReference(): string;
  retentionPolicyCode: string;
  retentionPolicyVersion: number;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    try {
      const authenticated = await options.authentication.authorize(input);
      const requested = readClosedRecord(input.command, [
        "operationReference",
        "diningSessionReference",
        "expectedSessionVersion",
        "expectedHostParticipantReference",
        "targetParticipantReference",
      ]);
      return await options.persistence.transactions.run(async (tx) => {
        const current = await resolve(
          tx,
          input.sessionCookie,
          "dining.host.transfer",
          authenticated.sessionReference,
        );
        if (!(await current.allowed())) return fail();
        const scope = {
          tenantReference: String(current.selected.tenantReference),
          brandReference: String(current.context.brand.brandReference),
          storeReference: String(current.store.storeReference),
        };
        const command = parseDiningHostTransferCommand({
          ...requested,
          ...scope,
          actorType: "Staff",
          actorReference: String(current.actorReference),
          purposeCode: "TransferDiningHost",
          permissionCode: "dining.host.transfer",
          reasonCode: "STAFF_HOST_TRANSFER",
          observedAt: String(current.context.resolvedAt),
        });
        const runner = { run: <T>(work: (transaction: typeof tx) => Promise<T>) => work(tx) };
        const store = createPostgresDiningHostTransferStore(runner, {
          scope,
          now: options.persistence.now,
          authorize: async (transaction, candidate) =>
            transaction === tx &&
            candidate.actorType === "Staff" &&
            candidate.actorReference === command.actorReference &&
            candidate.tenantReference === scope.tenantReference &&
            candidate.brandReference === scope.brandReference &&
            candidate.storeReference === scope.storeReference &&
            candidate.diningSessionReference === command.diningSessionReference &&
            (await current.allowed()) === true,
          audit: (record) => ({
            auditId: options.newReference(),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "User", reference: command.actorReference },
            actionCode: "DINING_HOST_TRANSFERRED",
            targetType: "DiningSession",
            targetId: command.diningSessionReference,
            correlationId: command.operationReference,
            reasonCode: record.command.reasonCode,
            occurredAt: record.command.observedAt,
            sourceChannel: "MERCHANT_WEB",
            dataClassification: "Restricted",
            retentionPolicyCode: options.retentionPolicyCode,
            retentionPolicyVersion: options.retentionPolicyVersion,
          }),
        });
        const result = await store.transfer(command);
        if (!(await current.allowed())) return fail();
        return Object.freeze({
          status: result.status,
          operationReference: result.record.command.operationReference,
          diningSessionReference: result.record.session.diningSessionReference,
          previousHostParticipantReference: result.record.previousSession.hostParticipantReference,
          hostParticipantReference: result.record.session.hostParticipantReference,
          sessionVersion: result.record.session.version,
          transferredAt: result.record.command.observedAt,
        });
      });
    } catch {
      return fail();
    }
  };
}
