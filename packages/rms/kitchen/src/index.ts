export { moduleManifest } from "./module.manifest.js";
export {
  confirmedOrderConsumerName,
  confirmedOrderConsumerVersion,
  confirmedOrderIntakeErrorCodes,
  ConfirmedOrderIntakeError,
  type ConfirmedOrderIntakeErrorCode,
  type ConfirmedOrderIntakeReceipt,
  type ConfirmedOrderIntakeResult,
  type KitchenDigest,
  type KitchenInstant,
  type KitchenReference,
} from "./contracts/confirmed-order-intake.js";
export {
  createConfirmedOrderIntakeReceipt,
  createConfirmedOrderSemanticEventBinding,
  parseConfirmedOrderIntakeReceipt,
  parseConfirmedOrderSourceEvent,
  parseKitchenDigest,
  parseKitchenInstant,
  parseKitchenReference,
} from "./application/confirmed-order-intake.js";
export { createConfirmedOrderConsumerService } from "./application/confirmed-order-consumer-service.js";
export type {
  ConfirmedOrderConsumerPorts,
  ConfirmedOrderIntakeCommit,
  ConfirmedOrderIntakeResolution,
} from "./application/ports/confirmed-order-consumer-ports.js";
