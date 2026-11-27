import type { WorkerWorkload } from "./index.js";

export function createCompositeWorkerWorkload(
  workloads: readonly WorkerWorkload[],
): WorkerWorkload {
  if (workloads.length === 0 || new Set(workloads).size !== workloads.length)
    throw new Error("WORKER_WORKLOAD_GROUP_INVALID");
  const children = [...workloads];
  const started: WorkerWorkload[] = [];
  let state: "idle" | "starting" | "running" | "stopping" | "stopped" = "idle";
  let failed = false;
  let startup: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let finish!: (result: "stopped" | "failed") => void;
  const completion = new Promise<"stopped" | "failed">((resolve) => {
    finish = resolve;
  });
  const fail = () => {
    failed = true;
    finish("failed");
  };
  async function cleanup() {
    let cleanupFailed = false;
    // Attempt every drain even when another child rejects.
    await Promise.all(
      started
        .splice(0)
        .reverse()
        .map(async (child) => {
          try {
            await child.stop();
          } catch {
            cleanupFailed = true;
          }
        }),
    );
    state = "stopped";
    if (cleanupFailed) {
      fail();
      throw new Error("WORKER_WORKLOAD_GROUP_STOP_FAILED");
    }
    finish(failed ? "failed" : "stopped");
  }
  function stop(): Promise<void> {
    if (stopping) return stopping;
    state = "stopping";
    stopping = (async () => {
      await startup?.catch(() => undefined);
      await cleanup();
    })();
    return stopping;
  }
  function start(): Promise<void> {
    if (state !== "idle") return Promise.reject(new Error("WORKER_WORKLOAD_GROUP_START_INVALID"));
    state = "starting";
    startup = (async () => {
      try {
        for (const child of children) {
          if (state !== "starting" || failed) break;
          // Include the currently starting child: start may acquire resources before throwing.
          started.push(child);
          void child.completion?.then(() => {
            if (state === "starting" || state === "running") fail();
          }, fail);
          await child.start();
        }
        if (failed) throw new Error("WORKER_WORKLOAD_GROUP_CHILD_FAILED");
        if (state === "starting") state = "running";
      } catch {
        fail();
        // Runtime stop waits for startup; cleanup here must not wait on that same promise.
        state = "stopping";
        if (!stopping) await cleanup();
        throw new Error("WORKER_WORKLOAD_GROUP_START_FAILED");
      }
    })();
    return startup;
  }
  return { start, stop, completion };
}
