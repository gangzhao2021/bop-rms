import { readClosedRecord } from "@bop/identity";
import {
  createPostgresDiningQrJoinStore,
  parseDiningReference,
  type DiningCredentialPort,
} from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";

/**
 * WP-2423 item 8 ⑤ DEC-DINING-QR-JOIN decisions 2 and 3: on the table page staff see the phones
 * at the table (numbered in join order), pause or resume joining by QR, and take a phone off the
 * table. Every change is recorded with the staff member and time.
 */
export type MerchantDiningQrJoinCommand =
  | { readonly action: "State"; readonly diningSessionReference: string }
  | {
      readonly action: "Pause" | "Resume";
      readonly diningSessionReference: string;
      readonly operationReference: string;
    }
  | {
      readonly action: "Remove";
      readonly diningSessionReference: string;
      readonly participantReference: string;
      readonly operationReference: string;
    };

export function parseMerchantDiningQrJoinCommand(value: unknown): MerchantDiningQrJoinCommand {
  const action =
    value !== null && typeof value === "object"
      ? Object.getOwnPropertyDescriptor(value, "action")?.value
      : undefined;
  if (action === "State") {
    const raw = readClosedRecord(value, ["action", "diningSessionReference"]);
    return Object.freeze({
      action,
      diningSessionReference: String(parseDiningReference(raw.diningSessionReference)),
    });
  }
  if (action === "Pause" || action === "Resume") {
    const raw = readClosedRecord(value, ["action", "diningSessionReference", "operationReference"]);
    return Object.freeze({
      action,
      diningSessionReference: String(parseDiningReference(raw.diningSessionReference)),
      operationReference: String(parseDiningReference(raw.operationReference)),
    });
  }
  if (action === "Remove") {
    const raw = readClosedRecord(value, [
      "action",
      "diningSessionReference",
      "participantReference",
      "operationReference",
    ]);
    return Object.freeze({
      action,
      diningSessionReference: String(parseDiningReference(raw.diningSessionReference)),
      participantReference: String(parseDiningReference(raw.participantReference)),
      operationReference: String(parseDiningReference(raw.operationReference)),
    });
  }
  throw new Error("DINING_QR_JOIN_INPUT_INVALID");
}

export function createMerchantDiningQrJoin(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  credentials: DiningCredentialPort;
  retentionPolicyCode: string;
  retentionPolicyVersion: number;
  nextReference(): string;
  now(): string;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; command: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const command = parseMerchantDiningQrJoinCommand(input.command);
    return options.persistence.transactions.run(async (tx) => {
      const current = await resolve(
        tx,
        input.sessionCookie,
        "dining.operate",
        authenticated.sessionReference,
      );
      if ((await current.allowed()) !== true) throw new Error("DINING_QR_JOIN_DENIED");
      const actorReference = String(current.actorReference);
      const scope = {
        tenantReference: current.selected.tenantReference,
        brandReference: current.context.brand.brandReference,
        storeReference: current.store.storeReference,
      };
      const store = createPostgresDiningQrJoinStore(
        { run: (work) => work(tx) },
        {
          scope,
          credentials: options.credentials,
          pepperVersion: 1,
          now: options.now,
          authorize: async () => (await current.allowed()) === true,
          audit: (record) => ({
            auditId: options.nextReference(),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "User", reference: actorReference },
            actionCode:
              record.action === "Pause"
                ? "DINING_QR_JOIN_PAUSE"
                : record.action === "Resume"
                  ? "DINING_QR_JOIN_RESUME"
                  : "DINING_PARTICIPANT_REMOVE",
            targetType: "DiningTable",
            targetId: record.tableReference,
            reasonCode: "STAFF_TABLE_CONTROL",
            correlationId: record.operationReference,
            occurredAt: record.observedAt,
            sourceChannel: "API",
            dataClassification: "Internal",
            retentionPolicyCode: options.retentionPolicyCode,
            retentionPolicyVersion: options.retentionPolicyVersion,
          }),
        },
      );
      const observedAt = options.now();
      if (command.action === "Pause" || command.action === "Resume") {
        await store.setPaused({
          operationReference: command.operationReference,
          diningSessionReference: command.diningSessionReference,
          paused: command.action === "Pause",
          actorReference,
          observedAt,
        });
      } else if (command.action === "Remove") {
        await store.remove({
          operationReference: command.operationReference,
          diningSessionReference: command.diningSessionReference,
          participantReference: command.participantReference,
          actorReference,
          observedAt,
        });
      }
      return store.state(command.diningSessionReference);
    });
  };
}
