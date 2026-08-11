import { isProxy } from "node:util/types";

import {
  kitchenRealtimeReferencePurpose,
  type KitchenRealtimeMetric,
  type KitchenRealtimePublishResult,
} from "../contracts/kitchen-realtime.js";
import {
  createKitchenRealtimeHint,
  createKitchenRealtimePublishResult,
} from "../domain/kitchen-realtime.js";
import { parseKitchenQueueGeneration } from "../domain/kitchen-queue-projection.js";
import type { KitchenRealtimePorts } from "./ports/kitchen-realtime-ports.js";

function result(outcome: "Unavailable" | "Rejected"): KitchenRealtimePublishResult {
  return createKitchenRealtimePublishResult(outcome, null);
}

export function createKitchenRealtimeService(ports: KitchenRealtimePorts) {
  function metric(value: KitchenRealtimeMetric): void {
    try {
      ports.metrics?.record(value);
    } catch {
      // Low-cardinality observability cannot alter lossy realtime behavior.
    }
  }

  async function publishCommittedQueueActivation(
    value: unknown,
  ): Promise<KitchenRealtimePublishResult> {
    let generation: ReturnType<typeof parseKitchenQueueGeneration>;
    try {
      if (typeof value === "object" && value !== null && isProxy(value))
        throw new Error("proxy input");
      generation = parseKitchenQueueGeneration(value);
      if (generation.generationStatus !== "Active") throw new Error("not active");
    } catch {
      metric({ operation: "publish", result: "rejected" });
      return result("Rejected");
    }

    let message;
    try {
      message = createKitchenRealtimeHint({
        generation,
        messageReference: ports.references.nextReference({
          purpose: kitchenRealtimeReferencePurpose,
        }),
      });
    } catch {
      metric({ operation: "publish", result: "unavailable" });
      return result("Unavailable");
    }

    let delivered: unknown;
    try {
      delivered = await ports.publisher.publish(message);
    } catch {
      metric({ operation: "publish", result: "unavailable" });
      return result("Unavailable");
    }
    if (!Number.isSafeInteger(delivered) || Number(delivered) < 0) {
      metric({ operation: "publish", result: "unavailable" });
      return result("Unavailable");
    }
    const outcome = Number(delivered) === 0 ? "NoSubscribers" : "Delivered";
    metric({
      operation: "publish",
      result: outcome === "Delivered" ? "delivered" : "no_subscribers",
    });
    return createKitchenRealtimePublishResult(outcome, message);
  }

  return Object.freeze({ publishCommittedQueueActivation });
}
