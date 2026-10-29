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
  /** WP-2423 item 8 ⑦ (Owner decision 4): guests call staff; servers chase a dish. */
  readonly services: {
    readonly version: number;
    readonly staffCall: boolean;
    readonly chaseDish: boolean;
    /** Owner decision 2: staff record how many guests when opening a table. */
    readonly askPartySize: boolean;
    readonly changedAt: string | null;
  };
  /**
   * WP-2423 item 8 ⑦ (Owner decision 11): the three tip percentages guests and staff are
   * offered (with "no tip" and "other amount"), or tips off. Payment's own versioned setting.
   */
  readonly tips: {
    readonly version: number;
    readonly enabled: boolean;
    readonly tierPercents: readonly [number, number, number];
    readonly changedAt: string | null;
  };
}
/** Three whole percentages, each 1–50, from lowest to highest. */
export const validTipTiers = (tiers: readonly number[]): boolean =>
  tiers.length === 3 &&
  tiers.every((n) => Number.isSafeInteger(n) && n >= 1 && n <= 50) &&
  (tiers[0] as number) < (tiers[1] as number) &&
  (tiers[1] as number) < (tiers[2] as number);
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
  const services = raw?.services as Record<string, unknown> | null | undefined;
  const tips = raw?.tips as Record<string, unknown> | null | undefined;
  if (
    tips === null ||
    typeof tips !== "object" ||
    Object.keys(tips).sort().join(",") !== "changedAt,enabled,tierPercents,version" ||
    !Number.isSafeInteger(tips.version) ||
    Number(tips.version) < 0 ||
    typeof tips.enabled !== "boolean" ||
    !Array.isArray(tips.tierPercents) ||
    !validTipTiers(tips.tierPercents as number[]) ||
    (tips.changedAt !== null &&
      (typeof tips.changedAt !== "string" || !instant.test(tips.changedAt)))
  )
    return fail();
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
    Object.values(modules).some((entry) => typeof entry !== "boolean") ||
    services === null ||
    typeof services !== "object" ||
    Object.keys(services).sort().join(",") !==
      "askPartySize,changedAt,chaseDish,staffCall,version" ||
    typeof services.askPartySize !== "boolean" ||
    !Number.isSafeInteger(services.version) ||
    Number(services.version) < 0 ||
    typeof services.staffCall !== "boolean" ||
    typeof services.chaseDish !== "boolean" ||
    (services.changedAt !== null &&
      (typeof services.changedAt !== "string" || !instant.test(services.changedAt)))
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
    services: Object.freeze({
      version: Number(services.version),
      staffCall: services.staffCall,
      chaseDish: services.chaseDish,
      askPartySize: services.askPartySize,
      changedAt: services.changedAt as string | null,
    }),
    tips: Object.freeze({
      version: Number(tips.version),
      enabled: tips.enabled,
      tierPercents: Object.freeze([...(tips.tierPercents as number[])]) as unknown as readonly [
        number,
        number,
        number,
      ],
      changedAt: tips.changedAt as string | null,
    }),
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
    changeServices: (input: {
      operationReference: string;
      expectedVersion: number;
      staffCall: boolean;
      chaseDish: boolean;
      askPartySize: boolean;
    }) => send({ action: "ChangeServices", ...input }),
    changeTips: (input: {
      operationReference: string;
      expectedVersion: number;
      enabled: boolean;
      tierPercents: readonly number[];
    }) => send({ action: "ChangeTips", ...input }),
    applyFullService: (input: { operationReference: string; expectedVersion: number }) =>
      send({ action: "ApplyTemplate", template: "FullService", ...input }),
    change: (input: {
      operationReference: string;
      expectedVersion: number;
      modules: { counterOrder: boolean; pickup: boolean; inventory: boolean };
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
