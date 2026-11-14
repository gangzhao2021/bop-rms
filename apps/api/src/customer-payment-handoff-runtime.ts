import {
  createCustomerSessionPaymentHandoff,
  type CustomerSessionPaymentHandoffOptions,
} from "./customer-session-payment-handoff.js";
import { CustomerPaymentHandoffHandler } from "./customer-payment-handoff.js";

export interface CustomerPaymentHandoffRuntimeOptions extends CustomerSessionPaymentHandoffOptions {
  readonly allowedOrigin: string;
}
/** Requires explicit owner storage/admission and current confirmation policy. */
export function createCustomerPaymentHandoffHandler(options: CustomerPaymentHandoffRuntimeOptions) {
  return new CustomerPaymentHandoffHandler({
    allowedOrigin: options.allowedOrigin,
    port: createCustomerSessionPaymentHandoff(options),
  });
}
