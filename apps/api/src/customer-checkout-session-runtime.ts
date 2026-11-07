import {
  createCustomerCheckoutSessionComposition,
  type CustomerCheckoutSessionOptions,
} from "./customer-checkout-session-composition.js";
import { createCustomerCheckoutSessionRead } from "./customer-checkout-session-read.js";
import {
  CustomerCheckoutSessionHandler,
  CustomerCheckoutSessionReadHandler,
} from "./customer-checkout-session.js";

export interface CustomerCheckoutSessionRuntimeOptions extends CustomerCheckoutSessionOptions {
  readonly allowedOrigin: string;
}
/** Explicit real owner ports are required; no fixture configuration or credentials are supplied. */
export function createCustomerCheckoutSessionHandlers(
  options: CustomerCheckoutSessionRuntimeOptions,
) {
  const writer = createCustomerCheckoutSessionComposition(options);
  const reader = createCustomerCheckoutSessionRead(options);
  return {
    customerCheckoutSession: new CustomerCheckoutSessionHandler({
      allowedOrigin: options.allowedOrigin,
      port: { quoteVersion: options.quoteVersion, create: writer.create },
    }),
    customerCheckoutSessionRead: new CustomerCheckoutSessionReadHandler({
      allowedOrigin: options.allowedOrigin,
      port: reader,
    }),
  };
}
