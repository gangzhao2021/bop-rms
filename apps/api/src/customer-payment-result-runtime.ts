import {
  createCustomerSessionPaymentResult,
  type CustomerSessionPaymentResultOptions,
} from "./customer-session-payment-result.js";
import { CustomerPaymentResultHandler } from "./customer-payment-result.js";
export interface CustomerPaymentResultRuntimeOptions extends CustomerSessionPaymentResultOptions {
  readonly allowedOrigin: string;
}
export function createCustomerPaymentResultHandler(options: CustomerPaymentResultRuntimeOptions) {
  return new CustomerPaymentResultHandler({
    allowedOrigin: options.allowedOrigin,
    port: createCustomerSessionPaymentResult(options),
  });
}
