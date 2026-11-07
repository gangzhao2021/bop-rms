import { parseTaskQueueFilters, type TaskQueueFilters } from "@bop/task";
export type MerchantTaskInboxFilters = Omit<TaskQueueFilters, "owner"> &
  Readonly<{
    ownerStatus: "Unclaimed" | "ClaimedByYou" | "ClaimedByStaff" | null;
  }>;
const fail = (): never => {
  throw new Error("MERCHANT_TASK_INBOX_UNAVAILABLE");
};
/** Public request contains relationship labels only; actor/scope remain server-owned. */
export function parseMerchantTaskInboxFilters(
  value: unknown = undefined,
): MerchantTaskInboxFilters {
  try {
    const raw = value === undefined ? {} : value;
    if (!raw || typeof raw !== "object" || Object.getPrototypeOf(raw) !== Object.prototype)
      return fail();
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    const allowed = [
      "status",
      "taskType",
      "severityCode",
      "exactReference",
      "overdue",
      "ownerStatus",
    ];
    if (
      Reflect.ownKeys(raw).some((key) => {
        if (typeof key !== "string" || !allowed.includes(key)) return true;
        const d = descriptors[key];
        return d === undefined || !d.enumerable || !("value" in d);
      })
    )
      return fail();
    const input = Object.fromEntries(Object.entries(descriptors).map(([key, d]) => [key, d.value]));
    const ownerStatus = input.ownerStatus ?? null;
    if (
      ownerStatus !== null &&
      !["Unclaimed", "ClaimedByYou", "ClaimedByStaff"].includes(ownerStatus as string)
    )
      return fail();
    const base = parseTaskQueueFilters(
      Object.fromEntries(Object.entries(input).filter(([key]) => key !== "ownerStatus")),
    );
    return Object.freeze({
      status: base.status,
      taskType: base.taskType,
      severityCode: base.severityCode,
      exactReference: base.exactReference,
      overdue: base.overdue,
      ownerStatus: ownerStatus as MerchantTaskInboxFilters["ownerStatus"],
    });
  } catch {
    return fail();
  }
}
export function resolveMerchantTaskOwnerFilters(
  filters: MerchantTaskInboxFilters,
  actorReference: string,
): TaskQueueFilters {
  return parseTaskQueueFilters({
    status: filters.status,
    taskType: filters.taskType,
    severityCode: filters.severityCode,
    exactReference: filters.exactReference,
    overdue: filters.overdue,
    owner:
      filters.ownerStatus === null
        ? null
        : filters.ownerStatus === "Unclaimed"
          ? { kind: "Unclaimed" }
          : {
              kind: filters.ownerStatus === "ClaimedByYou" ? "ByActor" : "ByOtherActor",
              actorReference,
            },
  });
}
