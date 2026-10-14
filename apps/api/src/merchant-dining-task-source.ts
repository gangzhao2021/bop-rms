import { createHash } from "node:crypto";
import { createTaskRecord } from "@bop/task";
import {
  createPostgresDiningClosingStore,
  parseDiningHash,
  parseDiningInstant,
  parseDiningReference,
  parseDiningSession,
} from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { createPersistentMerchantTaskInbox } from "./persistent-merchant-task-inbox.js";

type Authorize = Parameters<typeof createPersistentMerchantTaskInbox>[0]["authorizeSource"];
/** Read access to the close-session exception source, not evidence that its debt or
 * task is resolved. Public owner lookup enforces scope; current staff permission
 * fences stay in the enclosing transaction. Lifecycle changes do not remove access. */
export function createMerchantDiningTaskSource(source: PersistentMerchantBffOptions): Authorize {
  const resolve = createMerchantStoreScope(source);
  /**
   * dining.session.close, resolved in full once per authorized inbox transaction (not once per
   * Task) and re-checked in full with the inbox's scope before the reply.
   */
  const permitted = new WeakMap<object, Promise<boolean>>();
  return async (tx, scope, value, cookie, run) => {
    try {
      const task = createTaskRecord(value);
      if (
        task.source.sourceType !== "DINING_SESSION" ||
        task.taskType !== "DINING_UNPAID_BATCH_EXCEPTION" ||
        task.scope.kind !== "Store" ||
        String(task.scope.brandReference) !== scope.brandReference ||
        String(task.scope.storeReference) !== scope.storeReference ||
        !(await run.guard(tx))
      )
        return false;
      let allowed = permitted.get(run);
      if (allowed === undefined) {
        allowed = (async () => {
          const current = await resolve(tx, cookie, "dining.session.close");
          if (
            current.selected.tenantReference !== scope.tenantReference ||
            String(current.context.brand.brandReference) !== scope.brandReference ||
            String(current.store.storeReference) !== scope.storeReference ||
            String(current.actorReference) !== scope.actorReference ||
            (await current.allowed()) !== true
          )
            return false;
          run.recheckBeforeReply(async () => (await current.allowed()) === true);
          return true;
        })();
        permitted.set(run, allowed);
      }
      if (!(await allowed)) return false;
      const owner = createPostgresDiningClosingStore(
        { run: (work) => work(tx) },
        {
          tenantReference: scope.tenantReference,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
        },
        {
          hashIntent: (value) => parseDiningHash(createHash("sha256").update(value).digest("hex")),
          equals: (a, b) => a === b,
        },
      );
      const valueRead = await owner.load(parseDiningReference(task.source.sourceReference));
      if (valueRead === null) return false;
      const session = parseDiningSession(valueRead),
        at = parseDiningInstant(source.now());
      if (
        String(session.diningSessionReference) !== String(task.source.sourceReference) ||
        String(session.brandReference) !== scope.brandReference ||
        String(session.storeReference) !== scope.storeReference ||
        session.startedAt > at ||
        String(session.startedAt) > String(task.createdAt) ||
        String(task.updatedAt) > String(at)
      )
        throw new Error("Invalid source binding");
      return run.guard(tx);
    } catch {
      throw new Error("MERCHANT_TASK_SOURCE_UNAVAILABLE");
    }
  };
}
