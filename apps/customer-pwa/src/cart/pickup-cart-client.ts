import { createBrowserCustomerCartClient, type CustomerCartClient } from "./cart-client.js";
import { createBrowserCartBindingClient } from "./cart-binding-client.js";
import { createPickupCartCreationCoordinator } from "./pickup-cart-creation.js";
import {
  captureCustomerCsrfContext,
  getCustomerCsrfCredential,
  setCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";

function uuidV7(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let timestamp = Date.now();
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp & 0xff;
    timestamp = Math.floor(timestamp / 256);
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Foreground Pickup composition; construction has no network or credential side effects. */
export function createBrowserPickupCartClient(): CustomerCartClient {
  const cart = createBrowserCustomerCartClient();
  const creation = createPickupCartCreationCoordinator({
    cart,
    binding: createBrowserCartBindingClient(),
    csrf: {
      get: getCustomerCsrfCredential,
      set: setCustomerCsrfCredential,
      capture: captureCustomerCsrfContext,
    },
    generatePreparationReference: uuidV7,
    online: () => typeof navigator === "undefined" || navigator.onLine !== false,
  });
  return Object.freeze({ ...cart, ...creation });
}
