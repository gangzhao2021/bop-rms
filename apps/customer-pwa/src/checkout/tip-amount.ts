/** Convert explicit CAD input without rounding or binary floating-point arithmetic. */
export function parseTipAmount(value: string): string | null {
  if (!/^(0|[1-9][0-9]{0,16})(?:\.[0-9]{1,2})?$/u.test(value)) return null;
  const [major = "", minor = ""] = value.split(".");
  const amount = BigInt(major) * 100n + BigInt(minor.padEnd(2, "0"));
  return amount <= 9223372036854775807n ? amount.toString() : null;
}
