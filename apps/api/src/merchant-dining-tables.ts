import { createHash } from "node:crypto";
import { readClosedRecord } from "@bop/identity";
import {
  createPostgresDiningSessionReadStore,
  createPostgresDiningTableStore,
  parseDiningInstant,
  parseDiningReference,
} from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
export function createMerchantDiningTables(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  tableAvailabilityCommandEnabled?: boolean;
}) {
  const resolve = createMerchantStoreScope(options.persistence);
  return async (input: { sessionCookie: unknown; csrf: unknown; query: unknown }) => {
    const authenticated = await options.authentication.authorize(input);
    const raw = readClosedRecord(input.query, ["afterTableReference", "limit"]);
    const afterTableReference =
      raw.afterTableReference === null
        ? null
        : String(parseDiningReference(raw.afterTableReference));
    if (
      typeof raw.limit !== "number" ||
      !Number.isSafeInteger(raw.limit) ||
      raw.limit < 1 ||
      raw.limit > 100
    )
      throw new Error("DINING_TABLES_UNAVAILABLE");
    const limit = raw.limit;
    return options.persistence.transactions.run(async (tx) => {
      const current = await resolve(
        tx,
        input.sessionCookie,
        "dining.operate",
        authenticated.sessionReference,
      );
      const authorize = () => current.allowed();
      if (!(await authorize())) throw new Error("DINING_TABLES_PERMISSION_DENIED");
      const tableOperationPermission = await current.authorizeAction("dining.operate");
      const canOperateTables =
        options.tableAvailabilityCommandEnabled === true &&
        tableOperationPermission?.effect === "Allow";
      const store = createPostgresDiningTableStore(
        { run: (work) => work(tx) },
        {
          tenantReference: current.selected.tenantReference,
          brandReference: current.context.brand.brandReference,
          storeReference: current.store.storeReference,
        },
        {
          hashIntent: (v) => "sha256:" + createHash("sha256").update(v).digest("hex"),
          equals: (a, b) => a === b,
        },
      );
      const page = await store.listTables({ afterTableReference, limit, authorize });
      if (!(await authorize())) throw new Error("DINING_TABLES_PERMISSION_DENIED");
      const activeReferences = page.items.flatMap((table) =>
        table.activeDiningSessionReference === null ? [] : [table.activeDiningSessionReference],
      );
      const elapsedMinutes = new Map<string, number>();
      if (activeReferences.length > 0) {
        const observedAt = Date.parse(parseDiningInstant(options.persistence.now()));
        const sessions = await createPostgresDiningSessionReadStore(
          { run: (work) => work(tx) },
          {
            tenantReference: current.selected.tenantReference,
            brandReference: current.context.brand.brandReference,
            storeReference: current.store.storeReference,
          },
        ).loadSessions(activeReferences);
        if (sessions.length !== activeReferences.length)
          throw new Error("DINING_TABLES_UNAVAILABLE");
        for (const [index, session] of sessions.entries()) {
          if (
            !session ||
            (session.phase !== "Active" && session.phase !== "Closing") ||
            session.diningSessionReference !== activeReferences[index]
          )
            throw new Error("DINING_TABLES_UNAVAILABLE");
          const startedAt = Date.parse(session.startedAt);
          if (!Number.isFinite(observedAt) || startedAt > observedAt)
            throw new Error("DINING_TABLES_UNAVAILABLE");
          elapsedMinutes.set(
            session.diningSessionReference,
            Math.floor((observedAt - startedAt) / 60_000),
          );
        }
      }
      if (!(await authorize())) throw new Error("DINING_TABLES_PERMISSION_DENIED");
      return Object.freeze({
        canOperateTables,
        items: Object.freeze(
          page.items.map((table) =>
            Object.freeze({
              tableReference: table.tableReference,
              stableLabel: table.stableLabel,
              areaCode: table.areaCode,
              capacity: table.capacity,
              lifecycle: table.lifecycle,
              operationalState: table.operationalState,
              aggregateVersion: table.aggregateVersion,
              currentDiningSessionReference: table.activeDiningSessionReference,
              elapsedMinutes:
                table.activeDiningSessionReference === null
                  ? null
                  : (elapsedMinutes.get(table.activeDiningSessionReference) ?? null),
            }),
          ),
        ),
        nextAfterTableReference: page.nextAfterTableReference,
      });
    });
  };
}
