import {
  createCustomerSessionPaymentIntent,
  type CustomerSessionPaymentIntentOptions,
} from "./customer-session-payment-intent.js";
import { CustomerPaymentIntentHandler } from "./customer-payment-intent.js";

export interface CustomerPaymentIntentRuntimeOptions extends CustomerSessionPaymentIntentOptions {
  readonly allowedOrigin: string;
}

/** Assemble actual owner ports; Provider credentials and policy have no defaults. */
export function createCustomerPaymentIntentHandler(options: CustomerPaymentIntentRuntimeOptions) {
  return new CustomerPaymentIntentHandler({
    allowedOrigin: options.allowedOrigin,
    port: createCustomerSessionPaymentIntent(options),
  });
}
