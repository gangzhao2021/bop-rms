export interface TaskInboxFilters {
  readonly status: "Assigned" | "Claimed" | null;
  readonly taskType: string | null;
  readonly severityCode: string | null;
  readonly exactReference: string | null;
  readonly ownerStatus: "Unclaimed" | "ClaimedByYou" | "ClaimedByStaff" | null;
  readonly overdue: boolean | null;
}
const fail = (): never => {
  throw new Error("TASK_INBOX_UNAVAILABLE");
};
const code = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){0,7}$/u;
const reference = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
/** Browser contract carries no scope or actor identity. Server authorizes and
 * resolves masked ownership independently; local validation grants no authority. */
export function parseTaskInboxFilters(value: unknown = undefined): TaskInboxFilters {
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
      "ownerStatus",
      "overdue",
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
    const status = input.status ?? null,
      ownerStatus = input.ownerStatus ?? null,
      overdue = input.overdue ?? null;
    if (status !== null && status !== "Assigned" && status !== "Claimed") return fail();
    if (
      ownerStatus !== null &&
      ownerStatus !== "Unclaimed" &&
      ownerStatus !== "ClaimedByYou" &&
      ownerStatus !== "ClaimedByStaff"
    )
      return fail();
    if (overdue !== null && typeof overdue !== "boolean") return fail();
    function exactCode(value: unknown): string | null {
      if (value == null) return null;
      if (typeof value !== "string" || value.length > 96 || !code.test(value)) return fail();
      return value;
    }
    const exactReference = input.exactReference ?? null;
    if (
      exactReference !== null &&
      (typeof exactReference !== "string" || !reference.test(exactReference))
    )
      return fail();
    return Object.freeze({
      status,
      taskType: exactCode(input.taskType),
      severityCode: exactCode(input.severityCode),
      exactReference,
      ownerStatus,
      overdue,
    });
  } catch {
    return fail();
  }
}
/** Recheck presented facts only. Exact source reference matching is enforced by
 * Task's owner query; the public Inbox intentionally omits that private ID. */
export function matchesTaskInboxFilters(
  item: {
    status: string;
    taskType: string;
    severity: string;
    taskReference: string;
    ownerStatus: string;
    dueAt: string;
  },
  filters: TaskInboxFilters,
  observedAt: string,
): boolean {
  return (
    (filters.status === null || item.status === filters.status) &&
    (filters.taskType === null || item.taskType === filters.taskType) &&
    (filters.severityCode === null || item.severity === filters.severityCode) &&
    (filters.ownerStatus === null || item.ownerStatus === filters.ownerStatus) &&
    (filters.overdue === null || item.dueAt < observedAt === filters.overdue)
  );
}
