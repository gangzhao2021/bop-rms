export const taskStatuses = [
  "Open",
  "Assigned",
  "Claimed",
  "Completed",
  "Failed",
  "Cancelled",
] as const;
export type TaskStatus = (typeof taskStatuses)[number];
export const taskTerminalKinds = ["Completed", "Failed", "Cancelled"] as const;
export type TaskTerminalKind = (typeof taskTerminalKinds)[number];

export interface TaskLifecycleState {
  readonly status: TaskStatus;
  readonly dueAt: string;
}

export const taskOperations = [
  "Create",
  "Assign",
  "Claim",
  "Complete",
  "Fail",
  "Cancel",
  "Escalate",
] as const;
export type TaskOperation = (typeof taskOperations)[number];

export type TaskTransitionDecision =
  | { readonly outcome: "Allowed"; readonly nextStatus: TaskStatus }
  | {
      readonly outcome: "Denied";
      readonly reason: "CURRENT_REQUIRED" | "CURRENT_FORBIDDEN" | "TERMINAL" | "STATUS_INVALID";
    };

const terminal = new Set<TaskStatus>(["Completed", "Failed", "Cancelled"]);

export function evaluateTaskTransition(
  operation: TaskOperation,
  current: TaskLifecycleState | null,
): TaskTransitionDecision {
  if (operation === "Create")
    return current === null
      ? Object.freeze({ outcome: "Allowed", nextStatus: "Open" })
      : Object.freeze({ outcome: "Denied", reason: "CURRENT_FORBIDDEN" });
  if (current === null) return Object.freeze({ outcome: "Denied", reason: "CURRENT_REQUIRED" });
  if (terminal.has(current.status)) return Object.freeze({ outcome: "Denied", reason: "TERMINAL" });
  if (operation === "Assign") return Object.freeze({ outcome: "Allowed", nextStatus: "Assigned" });
  if (operation === "Claim")
    return current.status === "Assigned"
      ? Object.freeze({ outcome: "Allowed", nextStatus: "Claimed" })
      : Object.freeze({ outcome: "Denied", reason: "STATUS_INVALID" });
  if (operation === "Complete" || operation === "Fail")
    return current.status === "Claimed"
      ? Object.freeze({
          outcome: "Allowed",
          nextStatus: (operation === "Complete" ? "Completed" : "Failed") as TaskTerminalKind,
        })
      : Object.freeze({ outcome: "Denied", reason: "STATUS_INVALID" });
  if (operation === "Cancel") return Object.freeze({ outcome: "Allowed", nextStatus: "Cancelled" });
  return Object.freeze({ outcome: "Allowed", nextStatus: current.status });
}

export function isTaskOverdue(task: TaskLifecycleState, evaluatedAt: string): boolean {
  return (
    !terminal.has(task.status) &&
    Number.isFinite(Date.parse(evaluatedAt)) &&
    Date.parse(evaluatedAt) > Date.parse(task.dueAt)
  );
}
