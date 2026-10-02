import { TaskInboxClientError } from "./task-inbox-client.js";
import {
  parseTaskInboxFilters,
  matchesTaskInboxFilters,
  type TaskInboxFilters,
} from "./task-inbox-filters.js";
export interface TaskInboxItem {
  readonly taskReference: string;
  readonly version: number;
  readonly taskType: string;
  readonly severity: string;
  readonly priority: string;
  readonly status: "Assigned" | "Claimed";
  readonly ownerStatus: "Unclaimed" | "ClaimedByYou" | "ClaimedByStaff";
  readonly dueAt: string;
  readonly sourceType: string;
  readonly canClaim: boolean;
}
export interface TaskInboxView {
  readonly screenId: "TASK-INBOX";
  readonly storeLabel: string;
  readonly observedAt: string;
  readonly items: readonly TaskInboxItem[];
  readonly nextAfterTaskReference: string | null;
}
const fail = (): never => {
  throw new Error("TASK_INBOX_INVALID");
};
function exact(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const data: Record<string, unknown> = {};
  for (const key of keys) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field || !("value" in field) || !field.enumerable) return fail();
    data[key] = field.value;
  }
  return data;
}
function reference(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  )
    return fail();
  return value;
}
function instant(value: unknown) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return fail();
  return value;
}
function code(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 96 ||
    !/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+){0,7}$/u.test(value)
  )
    return fail();
  return value;
}
export function parseTaskInboxView(value: unknown): TaskInboxView {
  const raw = exact(value, [
    "screenId",
    "storeLabel",
    "observedAt",
    "items",
    "nextAfterTaskReference",
  ]);
  if (
    raw.screenId !== "TASK-INBOX" ||
    typeof raw.storeLabel !== "string" ||
    !/^[^\p{Cc}\p{Cf}]{1,100}$/u.test(raw.storeLabel) ||
    !Array.isArray(raw.items) ||
    raw.items.length > 50
  )
    return fail();
  let previous: string | null = null;
  const items = raw.items.map((value): TaskInboxItem => {
    const item = exact(value, [
        "taskReference",
        "version",
        "taskType",
        "severity",
        "priority",
        "status",
        "ownerStatus",
        "dueAt",
        "sourceType",
        "canClaim",
      ]),
      taskReference = reference(item.taskReference);
    if (
      !Number.isSafeInteger(item.version) ||
      (item.version as number) < 1 ||
      typeof item.canClaim !== "boolean" ||
      (item.status !== "Assigned" && item.status !== "Claimed") ||
      (previous !== null && taskReference <= previous) ||
      (item.status === "Assigned"
        ? item.ownerStatus !== "Unclaimed"
        : !["ClaimedByYou", "ClaimedByStaff"].includes(String(item.ownerStatus))) ||
      (item.status === "Claimed" && item.canClaim)
    )
      return fail();
    previous = taskReference;
    return Object.freeze({
      taskReference,
      version: item.version as number,
      taskType: code(item.taskType),
      severity: code(item.severity),
      priority: code(item.priority),
      status: item.status,
      ownerStatus: item.ownerStatus as TaskInboxItem["ownerStatus"],
      dueAt: instant(item.dueAt),
      sourceType: code(item.sourceType),
      canClaim: item.canClaim,
    });
  });
  const nextAfterTaskReference =
    raw.nextAfterTaskReference === null ? null : reference(raw.nextAfterTaskReference);
  const lastVisibleTaskReference = items.at(-1)?.taskReference ?? null;
  if (
    nextAfterTaskReference !== null &&
    lastVisibleTaskReference !== null &&
    nextAfterTaskReference < lastVisibleTaskReference
  )
    return fail();
  return Object.freeze({
    screenId: "TASK-INBOX",
    storeLabel: raw.storeLabel,
    observedAt: instant(raw.observedAt),
    items: Object.freeze(items),
    nextAfterTaskReference,
  });
}
export interface TaskInboxClient {
  load(
    afterTaskReference?: string | null,
    signal?: AbortSignal,
    filters?: TaskInboxFilters,
  ): Promise<unknown>;
}
export type TaskInboxState =
  | Readonly<{
      kind:
        | "Idle"
        | "Loading"
        | "PermissionDenied"
        | "NotFound"
        | "FeatureDisabled"
        | "Unavailable"
        | "Disposed";
      view: null;
      readOnly: true;
    }>
  | Readonly<{ kind: "Ready"; view: TaskInboxView; readOnly: false }>
  | Readonly<{ kind: "Offline"; view: TaskInboxView | null; readOnly: true }>;
/** One selected Store/session context only, in memory. Every mutation must still
 * use its own server authorization/version; this controller only reads views. */
export function createTaskInboxController(initialClient: TaskInboxClient, initialContext: string) {
  let client = initialClient,
    context = initialContext,
    filters = parseTaskInboxFilters(),
    online = true,
    disposed = false,
    generation = 0,
    controller: AbortController | null = null,
    last: TaskInboxView | null = null;
  let state: TaskInboxState = Object.freeze({ kind: "Idle", view: null, readOnly: true });
  const listeners = new Set<() => void>();
  const publish = (next: TaskInboxState) => {
    state = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  const cancel = () => {
    generation++;
    controller?.abort();
    controller = null;
  };
  const load = async (afterTaskReference: string | null) => {
    if (disposed) return;
    cancel();
    if (!online) {
      publish({ kind: "Offline", view: last, readOnly: true });
      return;
    }
    const current = generation,
      abort = new AbortController();
    controller = abort;
    // Hide prior page during refresh; failures cannot leave actionable stale data.
    publish({ kind: "Loading", view: null, readOnly: true });
    try {
      const result = await client.load(afterTaskReference, abort.signal, filters);
      if (disposed || current !== generation || abort.signal.aborted) return;
      const view = parseTaskInboxView(result);
      if (view.items.some((item) => !matchesTaskInboxFilters(item, filters, view.observedAt)))
        return fail();
      if (
        afterTaskReference !== null &&
        ((view.nextAfterTaskReference !== null &&
          view.nextAfterTaskReference <= afterTaskReference) ||
          view.items.some((item) => item.taskReference <= afterTaskReference))
      )
        return fail();
      last = view;
      publish({ kind: "Ready", view, readOnly: false });
    } catch (error) {
      if (!disposed && current === generation) {
        last = null;
        publish({
          kind: error instanceof TaskInboxClientError ? error.code : "Unavailable",
          view: null,
          readOnly: true,
        });
      }
    }
  };
  return Object.freeze({
    getSnapshot: () => state,
    getFilters: () => filters,
    setFilters(value: unknown) {
      if (disposed) return;
      const next = parseTaskInboxFilters(value);
      if (JSON.stringify(next) === JSON.stringify(filters)) return;
      cancel();
      filters = next;
      last = null;
      publish({ kind: online ? "Idle" : "Offline", view: null, readOnly: true });
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh: () => load(null),
    next: () =>
      state.kind === "Ready" && state.view.nextAfterTaskReference !== null
        ? load(state.view.nextAfterTaskReference)
        : Promise.resolve(),
    setContext(nextContext: string, nextClient: TaskInboxClient = client) {
      if (disposed || (nextContext === context && nextClient === client)) return;
      cancel();
      context = nextContext;
      client = nextClient;
      filters = parseTaskInboxFilters();
      last = null;
      publish({ kind: online ? "Idle" : "Offline", view: null, readOnly: true });
    },
    setOnline(value: boolean) {
      if (disposed || online === value) return;
      cancel();
      online = value;
      publish(
        value
          ? { kind: "Idle", view: null, readOnly: true }
          : { kind: "Offline", view: last, readOnly: true },
      );
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      last = null;
      publish({ kind: "Disposed", view: null, readOnly: true });
      listeners.clear();
    },
  });
}
