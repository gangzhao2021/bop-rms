/**
 * WP-2423 item 8 ⑦ DEC-STORE-FEATURES: the modules the Store uses (Store features page). Read and
 * changed by the owner; a change takes effect at once and is the next recorded version.
 */
export interface StoreFeatures {
  readonly version: number;
  readonly templateCode: "FullService" | "Custom" | null;
  readonly modules: {
    readonly counterOrder: boolean;
    readonly pickup: boolean;
    readonly inventory: boolean;
  };
  readonly changedAt: string | null;
}
export class StoreFeaturesClientError extends Error {
  constructor(readonly code: "Denied" | "Changed" | "Unavailable") {
    super("store features " + code);
    this.name = "StoreFeaturesClientError";
  }
}
const fail = (code: StoreFeaturesClientError["code"] = "Unavailable"): never => {
  throw new StoreFeaturesClientError(code);
};
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function parseStoreFeatures(value: unknown): StoreFeatures {
  const raw = value as Record<string, unknown> | null;
  const modules = raw?.modules as Record<string, unknown> | null | undefined;
  if (
    raw === null ||
    typeof raw !== "object" ||
    !Number.isSafeInteger(raw.version) ||
    Number(raw.version) < 0 ||
    (raw.templateCode !== null &&
      raw.templateCode !== "FullService" &&
      raw.templateCode !== "Custom") ||
    (raw.changedAt !== null &&
      (typeof raw.changedAt !== "string" || !instant.test(raw.changedAt))) ||
    modules === null ||
    typeof modules !== "object" ||
    Object.keys(modules).sort().join(",") !== "counterOrder,inventory,pickup" ||
    Object.values(modules).some((entry) => typeof entry !== "boolean")
  )
    return fail();
  return Object.freeze({
    version: Number(raw.version),
    templateCode: raw.templateCode as StoreFeatures["templateCode"],
    modules: Object.freeze({
      counterOrder: modules.counterOrder === true,
      pickup: modules.pickup === true,
      inventory: modules.inventory === true,
    }),
    changedAt: raw.changedAt as string | null,
  });
}

export function createStoreFeaturesClient(csrf: string, fetcher: typeof fetch = fetch) {
  const send = async (command: unknown): Promise<StoreFeatures> => {
    let response: Response;
    try {
      response = await fetcher("/merchant/store/features", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json", "x-bop-csrf": csrf },
        body: JSON.stringify(command),
      });
    } catch {
      return fail();
    }
    if (response.status === 403) return fail("Denied");
    if (response.status === 409) return fail("Changed");
    if (!response.ok) return fail();
    return parseStoreFeatures(await response.json().catch(() => null));
  };
  return Object.freeze({
    read: () => send({ action: "Read" }),
    applyFullService: (input: { operationReference: string; expectedVersion: number }) =>
      send({ action: "ApplyTemplate", template: "FullService", ...input }),
    change: (input: {
      operationReference: string;
      expectedVersion: number;
      modules: { counterOrder: boolean; inventory: boolean };
    }) =>
      send({
        action: "Change",
        operationReference: input.operationReference,
        expectedVersion: input.expectedVersion,
        modules: input.modules,
      }),
  });
}
export type StoreFeaturesClient = ReturnType<typeof createStoreFeaturesClient>;
