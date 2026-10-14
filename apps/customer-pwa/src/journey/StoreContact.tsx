import { formatLocalityLine } from "./format.js";

/**
 * WP-2423 Q10: how a customer reaches the Store about an order — the Store's published business
 * phone and address. Shown on the order status page and the receipt.
 */
export interface StoreContactView {
  readonly phone: string | null;
  readonly addressLines: readonly string[];
  readonly locality: string;
  readonly regionCode: string;
  readonly postalCode: string;
}

const e164 = /^\+[1-9][0-9]{6,14}$/u;
const text = (value: unknown, max: number): string => {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    value !== value.normalize("NFC").trim() ||
    /[\p{Cc}\p{Cf}<>]/u.test(value)
  )
    throw new TypeError("invalid store contact");
  return value;
};

/** Strict parser: exactly the published fields, nothing else. */
export function parseStoreContact(value: unknown): StoreContactView {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("invalid store contact");
  const raw = value as Record<string, unknown>;
  const keys = ["phone", "addressLines", "locality", "regionCode", "postalCode"];
  if (Object.keys(raw).length !== keys.length || keys.some((key) => !Object.hasOwn(raw, key)))
    throw new TypeError("invalid store contact");
  if (raw.phone !== null && (typeof raw.phone !== "string" || !e164.test(raw.phone)))
    throw new TypeError("invalid store contact");
  if (
    !Array.isArray(raw.addressLines) ||
    raw.addressLines.length < 1 ||
    raw.addressLines.length > 3
  )
    throw new TypeError("invalid store contact");
  return Object.freeze({
    phone: raw.phone,
    addressLines: Object.freeze(raw.addressLines.map((line: unknown) => text(line, 160))),
    locality: text(raw.locality, 120),
    regionCode: text(raw.regionCode, 12),
    postalCode: text(raw.postalCode, 20),
  });
}

/** "+14165550123" → "(416) 555-0123"; other countries keep the international form. */
export function formatStorePhone(phone: string): string {
  const match = /^\+1([2-9][0-9]{2})([0-9]{3})([0-9]{4})$/u.exec(phone);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone;
}

export function StoreContactCard({
  contact,
  storeName,
}: {
  readonly contact: StoreContactView;
  readonly storeName?: string | undefined;
}) {
  return (
    <section className="store-contact" aria-labelledby="store-contact-heading">
      <h2 id="store-contact-heading">Contact the store</h2>
      <p>Questions about this order? The store can help.</p>
      {contact.phone ? (
        <p>
          <a className="store-contact__phone" href={`tel:${contact.phone}`}>
            Call {formatStorePhone(contact.phone)}
          </a>
        </p>
      ) : null}
      <address className="store-contact__address">
        {storeName ? (
          <>
            {storeName}
            <br />
          </>
        ) : null}
        {contact.addressLines.map((line) => (
          <span key={line}>
            {line}
            <br />
          </span>
        ))}
        {formatLocalityLine(contact)}
      </address>
    </section>
  );
}
