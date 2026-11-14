import {
  parseInventoryInstant,
  parseInventoryReference,
  InventoryItemError,
} from "../../domain/inventory-item.js";
import {
  parseInventoryOptionPublicationOriginalClock,
  type InventoryOptionPublicationOriginalClock,
  parseInventoryConfigurationReferenceRequest,
} from "../../contracts/configuration-reference-source.js";
import {
  assessInventoryOptionConsumptionUnits,
  parseInventoryOptionConsumptionPins,
  inventoryOptionConsumptionUnitFields,
  unitList,
  unitRecord,
} from "../../contracts/option-consumption-unit-source.js";
import {
  createPostgresInventoryConfigurationReferenceSourceStore,
  type InventoryConfigurationReferenceOptions,
  type InventoryConfigurationReferenceTransaction,
} from "./configuration-reference-source-store.js";
type Request = ReturnType<typeof parseInventoryConfigurationReferenceRequest>;
type Tx = InventoryConfigurationReferenceTransaction;
export interface InventoryOptionConsumptionUnitOptions extends InventoryConfigurationReferenceOptions {
  readonly originalPublicationClock?: InventoryOptionPublicationOriginalClock;
  readonly unitAuthority: {
    holdUntilTransactionCompletes(
      tx: Tx,
      input: {
        readonly request: Request;
        readonly requiredFields: typeof inventoryOptionConsumptionUnitFields;
        readonly requiredPermissions: readonly [
          "inventory.item.read",
          "inventory.item.history.read",
        ];
        readonly requiredScope: "FullBrandScope";
        readonly itemReferences: readonly string[];
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}
const fail = (): never => {
  throw new InventoryItemError("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
};
/** Owning minimal unit fields under the existing complete configuration holder.
 * Caller must roll back its UoW on any refusal. No Inventory mutations in callback. */
export function createPostgresInventoryOptionConsumptionUnitSource(
  options: InventoryOptionConsumptionUnitOptions,
) {
  const now = options.clock.now.bind(options.clock),
    hold = options.unitAuthority.holdUntilTransactionCompletes.bind(options.unitAuthority),
    run = options.transactions.run.bind(options.transactions),
    metadataHold = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    tenantReference = parseInventoryReference(options.tenantReference),
    brandReference = parseInventoryReference(options.brandReference),
    actorReference = parseInventoryReference(options.actorReference),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  const originalClockDescriptor = Object.getOwnPropertyDescriptor(
    options,
    "originalPublicationClock",
  );
  if (
    originalClockDescriptor &&
    (!("value" in originalClockDescriptor) || !originalClockDescriptor.enumerable)
  )
    return fail();
  const originalClockValue = originalClockDescriptor?.value;
  const originalClockRecord =
    originalClockValue === undefined
      ? undefined
      : unitRecord(originalClockValue, [
          "profile",
          "operationReference",
          "catalogIntentDigest",
          "observedAt",
          "validUntil",
        ]);
  const originalClock =
    originalClockRecord === undefined
      ? undefined
      : parseInventoryOptionPublicationOriginalClock(
          originalClockValue,
          {
            operationReference: parseInventoryReference(originalClockRecord.operationReference),
            catalogIntentDigest:
              typeof originalClockRecord.catalogIntentDigest === "string"
                ? originalClockRecord.catalogIntentDigest
                : fail(),
          },
          now(),
        );
  return Object.freeze({
    async withCurrentUnits<T>(
      input: Request,
      value: unknown,
      activationInput: string,
      work: (
        v: ReturnType<typeof assessInventoryOptionConsumptionUnits> & {
          readonly validUntil: string;
        },
      ) => Promise<T>,
    ): Promise<T> {
      let ownedTx: Tx | undefined,
        enteredTx = false;
      try {
        const request = parseInventoryConfigurationReferenceRequest(input),
          pins = parseInventoryOptionConsumptionPins(value),
          activationAt = parseInventoryInstant(activationInput);
        if (typeof work !== "function") return fail();
        if (originalClock) {
          parseInventoryOptionPublicationOriginalClock(originalClock, request, now());
          if (activationAt < originalClock.observedAt) return fail();
        }
        let tx: Tx | undefined,
          query: Tx["query"] | undefined,
          until: string | undefined,
          latest = parseInventoryInstant(now()),
          entered = 0,
          completed = false,
          answer: T | undefined;
        const check = () => {
          const at = parseInventoryInstant(now());
          if (originalClock)
            parseInventoryOptionPublicationOriginalClock(originalClock, request, at);
          if (
            (tx && failed.has(tx)) ||
            at < latest ||
            (until && at >= until) ||
            (tx && tx.query !== query)
          )
            return fail();
          latest = at;
          return at;
        };
        const source = createPostgresInventoryConfigurationReferenceSourceStore({
          tenantReference,
          brandReference,
          actorReference,
          authority: { holdUntilTransactionCompletes: metadataHold },
          clock: { now: check },
          transactions: {
            run: async (action) =>
              run(async (actual) => {
                if (++entered !== 1 || active.has(actual) || failed.has(actual)) {
                  failed.add(actual);
                  return fail();
                }
                ownedTx = actual;
                active.add(actual);
                enteredTx = true;
                tx = actual;
                query = actual.query;
                return action(actual);
              }),
          },
        });
        const result = await source.withCurrentSnapshot(request, async (metadata) => {
          if (!tx || !query) return fail();
          const actual = tx,
            sql = query.bind(actual);
          until = new Date(Date.parse(metadata.observedAt) + 5000).toISOString();
          if (originalClock && originalClock.validUntil < until) until = originalClock.validUntil;
          check();
          const itemReferences = Object.freeze([...new Set(pins.map((p) => p.reference))].sort());
          const authorize = async () => {
            const at = check();
            await hold(
              actual,
              Object.freeze({
                request,
                requiredFields: inventoryOptionConsumptionUnitFields,
                requiredPermissions: Object.freeze([
                  "inventory.item.read",
                  "inventory.item.history.read",
                ] as const),
                requiredScope: "FullBrandScope" as const,
                itemReferences,
                observedAt: at,
              }),
            );
            check();
          };
          await authorize();
          const read = async () => {
            check();
            const response = await sql(
              `SELECT jsonb_build_object('items',COALESCE(jsonb_agg(jsonb_build_object(
'itemReference',v.item_id,'itemVersion',v.version::text,'operationReference',o.operation_id,
'recordedAt',to_char(v.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
'baseUnit',v.snapshot_json->'baseUnit','unitConversions',v.snapshot_json->'unitConversions',
'precise',v.snapshot_json->>'aggregateVersion'=v.version::text AND v.snapshot_json->>'itemReference'=v.item_id::text
AND v.snapshot_json->>'tenantReference'=v.tenant_id::text AND v.snapshot_json->>'brandReference'=v.brand_id::text
AND v.snapshot_json->>'updatedAt'=to_char(v.recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
AND date_trunc('milliseconds',v.recorded_at)=v.recorded_at AND v.recorded_at<=statement_timestamp()
) ORDER BY v.item_id),'[]'::jsonb)) AS units
FROM rms_inventory.inventory_item_version v JOIN rms_inventory.inventory_item_operation o
ON o.tenant_id=v.tenant_id AND o.brand_id=v.brand_id AND o.item_id=v.item_id AND o.version=v.version
WHERE v.tenant_id=$1 AND v.brand_id=$2 AND v.item_id=ANY($3::uuid[]) AND o.operation_id=ANY($4::uuid[])`,
              [
                request.tenantReference,
                request.brandReference,
                itemReferences,
                [...new Set(pins.map((p) => p.versionReference))],
              ],
            );
            const rows = unitList(response.rows);
            if (rows.length !== 1) return fail();
            const raw = unitRecord(rows[0], ["units"]),
              body = unitRecord(raw.units, ["items"]);
            return assessInventoryOptionConsumptionUnits(
              pins,
              body.items,
              metadata,
              request,
              check(),
              activationAt,
              originalClock,
            );
          };
          const assessed = await read();
          await authorize();
          answer = await work(Object.freeze({ ...assessed, validUntil: until }));
          completed = true;
          check();
          await authorize();
          const current = await read();
          if (
            current.unitSourceDigest !== assessed.unitSourceDigest ||
            current.ownerSourceDigest !== assessed.ownerSourceDigest ||
            (originalClock !== undefined &&
              (JSON.stringify(current.matches) !== JSON.stringify(assessed.matches) ||
                current.unitArithmetic !== assessed.unitArithmetic))
          )
            return fail();
          check();
          return answer;
        });
        if (entered !== 1 || !completed || !Object.is(result, answer)) return fail();
        check();
        return result;
      } catch {
        if (ownedTx) failed.add(ownedTx);
        return fail();
      } finally {
        if (enteredTx && ownedTx) active.delete(ownedTx);
      }
    },
  });
}
