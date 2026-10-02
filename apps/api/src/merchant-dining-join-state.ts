import { readClosedRecord } from "@bop/identity";
import {
  createPostgresDiningClosingFence,
  createPostgresDiningJoinRegenerationStore,
  parseDiningReference,
  type DiningCredentialPort,
} from "@rms/dining";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantBffService } from "./merchant-bff.js";
export function createMerchantDiningJoinState(options: {
  persistence: PersistentMerchantBffOptions;
  authentication: Pick<MerchantBffService, "authorize">;
  credentials: DiningCredentialPort;
}) {
  const resolve = createMerchantStoreScope(options.persistence),
    fail = (): never => {
      throw new Error("DINING_JOIN_STATE_UNAVAILABLE");
    };
  return async (input: { sessionCookie: unknown; csrf: unknown; query: unknown }) => {
    const authenticated = await options.authentication.authorize(input),
      raw = readClosedRecord(input.query, ["diningSessionReference"]),
      reference = parseDiningReference(raw.diningSessionReference);
    return options.persistence.transactions.run(async (tx) => {
      const current = await resolve(
          tx,
          input.sessionCookie,
          "dining.operate",
          authenticated.sessionReference,
        ),
        authorize = () => current.allowed();
      if (!(await authorize())) return fail();
      const scope = {
        tenantReference: current.selected.tenantReference,
        brandReference: current.context.brand.brandReference,
        storeReference: current.store.storeReference,
      };
      const session = await createPostgresDiningClosingFence({ scope, authorize })(tx, {
        diningSessionReference: reference,
        observedAt: current.context.resolvedAt,
      });
      if (session.phase !== "Active") return fail();
      const owner = createPostgresDiningJoinRegenerationStore(
          { run: (work) => work(tx) },
          scope,
          options.credentials,
        ),
        state = await owner.resolveActiveJoin(reference);
      if (
        !state ||
        state.session.diningSessionReference !== reference ||
        state.session.version !== session.version ||
        state.session.tableReference !== session.tableReference ||
        state.session.tableAssignmentVersion !== session.tableAssignmentVersion ||
        !(await authorize())
      )
        return fail();
      return Object.freeze({
        diningSessionReference: reference,
        tableReference: session.tableReference,
        sessionVersion: session.version,
        tableAssignmentVersion: session.tableAssignmentVersion,
        capabilityVersion: state.capability.version,
        generation: state.capability.generation,
        joinKind: state.capability.kind,
      });
    });
  };
}
