import type {
  KitchenRealtimeHint,
  KitchenRealtimeMetric,
} from "../../contracts/kitchen-realtime.js";

export interface KitchenRealtimePorts {
  readonly references: {
    nextReference(input: { readonly purpose: "KitchenRealtimeMessage" }): unknown;
  };
  readonly publisher: {
    publish(message: KitchenRealtimeHint): unknown | Promise<unknown>;
  };
  readonly metrics?: {
    record(metric: KitchenRealtimeMetric): void;
  };
}
