import {
  parseTaskCode,
  parseTaskReference,
  TaskContractError,
  type TaskCode,
  type TaskReference,
  type TaskRecord,
} from "./task.js";

export type TaskQueueOwnerFilter =
  | Readonly<{ kind: "Unclaimed" }>
  | Readonly<{ kind: "ByActor" | "ByOtherActor"; actorReference: TaskReference }>;
export interface TaskQueueFilters {
  readonly status: "Assigned" | "Claimed" | null;
  readonly taskType: TaskCode | null;
  readonly severityCode: TaskCode | null;
  readonly exactReference: TaskReference | null;
  readonly owner: TaskQueueOwnerFilter | null;
  readonly overdue: boolean | null;
}
const invalid = (): never => {
  throw new TaskContractError("TASK_INPUT_INVALID");
};
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(value).some((key) => {
      if (typeof key !== "string" || !allowed.includes(key)) return true;
      const descriptor = descriptors[key];
      return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor);
    })
  )
    return invalid();
  return Object.fromEntries(Object.entries(descriptors).map(([key, d]) => [key, d.value]));
}
/** Closed owner contract. Omitted fields mean no filter. No scope, names, email,
 * unbounded keyword text or database identifiers can enter this query. */
function parseFilters(value: unknown): TaskQueueFilters {
  const input =
    value === undefined
      ? {}
      : fields(value, ["status", "taskType", "severityCode", "exactReference", "owner", "overdue"]);
  const status = input.status ?? null;
  if (status !== null && status !== "Assigned" && status !== "Claimed") return invalid();
  const overdue = input.overdue ?? null;
  if (overdue !== null && typeof overdue !== "boolean") return invalid();
  let owner: TaskQueueOwnerFilter | null = null;
  if (input.owner !== undefined && input.owner !== null) {
    const raw = fields(input.owner, ["kind", "actorReference"]);
    if (raw.kind === "Unclaimed" && Object.keys(raw).length === 1)
      owner = Object.freeze({ kind: "Unclaimed" });
    else if (
      (raw.kind === "ByActor" || raw.kind === "ByOtherActor") &&
      Object.keys(raw).length === 2
    )
      owner = Object.freeze({
        kind: raw.kind,
        actorReference: parseTaskReference(raw.actorReference),
      });
    else return invalid();
  }
  return Object.freeze({
    status,
    taskType: input.taskType == null ? null : parseTaskCode(input.taskType),
    severityCode: input.severityCode == null ? null : parseTaskCode(input.severityCode),
    exactReference: input.exactReference == null ? null : parseTaskReference(input.exactReference),
    owner,
    overdue,
  });
}
export function parseTaskQueueFilters(value: unknown = undefined): TaskQueueFilters {
  try {
    return parseFilters(value);
  } catch {
    return invalid();
  }
}
/** Recheck every database row, including the page lookahead, before returning it. */
export function matchesTaskQueueFilters(
  task: TaskRecord,
  filters: TaskQueueFilters,
  observedAt: string,
): boolean {
  const owner = filters.owner;
  return (
    (filters.status === null || task.status === filters.status) &&
    (filters.taskType === null || task.taskType === filters.taskType) &&
    (filters.severityCode === null || task.severityCode === filters.severityCode) &&
    (filters.exactReference === null ||
      task.taskReference === filters.exactReference ||
      task.source.sourceReference === filters.exactReference) &&
    (filters.overdue === null || task.dueAt < observedAt === filters.overdue) &&
    (owner === null ||
      (owner.kind === "Unclaimed"
        ? task.currentClaim === null
        : task.currentClaim !== null &&
          (owner.kind === "ByActor"
            ? String(task.currentClaim.actorReference) === owner.actorReference
            : String(task.currentClaim.actorReference) !== owner.actorReference)))
  );
}
