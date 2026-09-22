export class DiningProgressError extends Error {
  constructor(readonly code: "PermissionDenied" | "Unavailable") {
    super("Dining progress unavailable");
  }
}
const fail = (): never => {
  throw new DiningProgressError("Unavailable");
};
const ref = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const phases = [
  "Submitted",
  "Accepted",
  "InProgress",
  "Ready",
  "Fulfilled",
  "Rejected",
  "Cancelled",
];
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max)
    return fail();
  return value;
}
function reference(value: unknown) {
  if (typeof value !== "string" || !ref.test(value)) return fail();
  return value;
}
function phase(value: unknown) {
  if (typeof value !== "string" || !phases.includes(value)) return fail();
  return value;
}
export function parseDiningProgress(value: unknown, expectedOrder: string) {
  const data = record(value);
  if (
    typeof data.tableLabel !== "string" ||
    !data.tableLabel.trim() ||
    data.tableLabel.length > 120 ||
    Array.from(data.tableLabel).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return fail();
  if (reference(data.orderReference) !== expectedOrder) return fail();
  if (
    typeof data.observedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.observedAt) ||
    !Number.isFinite(Date.parse(data.observedAt))
  )
    return fail();
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 10000)
    return fail();
  const seen = new Set<string>();
  const items = data.items.map((value) => {
    const item = record(value),
      id = reference(item.orderItemReference);
    if (seen.has(id)) return fail();
    seen.add(id);
    if (
      typeof item.displayName !== "string" ||
      !item.displayName.trim() ||
      item.displayName.length > 240 ||
      Array.from(item.displayName).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      return fail();
    const orderedQuantity = integer(item.orderedQuantity, 1, 999),
      deliveredQuantity = integer(item.deliveredQuantity, 0, orderedQuantity),
      remainingQuantity = integer(item.remainingQuantity, 0, orderedQuantity),
      currentPhase = phase(item.phase);
    if (
      deliveredQuantity + remainingQuantity !== orderedQuantity ||
      (currentPhase === "Fulfilled" && remainingQuantity !== 0) ||
      (remainingQuantity === 0 && currentPhase !== "Fulfilled")
    )
      return fail();
    return Object.freeze({
      orderItemReference: id,
      displayName: item.displayName,
      batchSequence: integer(item.batchSequence, 1, 2147483647),
      itemOrdinal: integer(item.itemOrdinal, 1, 100),
      orderBatchReference: reference(item.orderBatchReference),
      phase: currentPhase,
      orderedQuantity,
      deliveredQuantity,
      remainingQuantity,
      itemServiceVersion: integer(item.itemServiceVersion, 0, 2147483647),
    });
  });
  if (data.closureStatus !== "Open" && data.closureStatus !== "Closed") return fail();
  if (!["Active", "Closing", "Closed"].includes(String(data.sessionPhase))) return fail();
  const diningSessionReference = reference(data.diningSessionReference);
  const sessionPhase = data.sessionPhase as "Active" | "Closing" | "Closed";
  const closureVersion = integer(data.closureVersion, 0, 2147483647);
  if (data.closureStatus === "Closed" && closureVersion === 0) return fail();
  return Object.freeze({
    diningSessionReference,
    sessionPhase,
    closureStatus: data.closureStatus,
    closureVersion,
    currentOrderVersion: integer(data.currentOrderVersion, 1, 2147483647),
    orderReference: expectedOrder,
    tableLabel: data.tableLabel,
    orderVersion: integer(data.orderVersion, 1, 2147483647),
    sessionVersion: integer(data.sessionVersion, 1, 2147483646),
    tableAssignmentVersion: integer(data.tableAssignmentVersion, 1, 2147483646),
    phase: phase(data.phase),
    observedAt: data.observedAt,
    items: Object.freeze(items),
  });
}
export type DiningProgress = ReturnType<typeof parseDiningProgress>;
export function createDiningProgressClient(fetcher: typeof fetch = fetch) {
  return {
    async load(orderReference: string, csrf: string, signal?: AbortSignal) {
      reference(orderReference);
      if (!/^[A-Za-z0-9_-]{43}$/.test(csrf) || signal?.aborted) return fail();
      const controller = new AbortController(),
        abort = () => controller.abort();
      signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(abort, 15000);
      try {
        const response = await fetcher("/merchant/dining/order-progress", {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-BOP-CSRF": csrf,
          },
          body: JSON.stringify({ orderReference }),
        });
        if (response.status === 401 || response.status === 403)
          throw new DiningProgressError("PermissionDenied");
        if (
          !response.ok ||
          response.headers.get("cache-control") !== "no-store" ||
          !response.headers.get("content-type")?.startsWith("application/json")
        )
          return fail();
        const text = await response.text();
        if (text.length > 2000000 || controller.signal.aborted) return fail();
        return parseDiningProgress(JSON.parse(text), orderReference);
      } catch (error) {
        if (error instanceof DiningProgressError) throw error;
        return fail();
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      }
    },
  };
}
