import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { readClosedRecord } from "@bop/identity";
import { PublishingContractError } from "../../contracts/publishing.js";
import {
  parsePlatformPublishingReceipt,
  type PlatformPublishingSource,
} from "../../contracts/platform-publishing-source.js";

const invalid = (): never => {
  throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
};
function closed(value: unknown, keys: readonly string[]) {
  try {
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
      return invalid();
    return readClosedRecord(value, keys);
  } catch {
    return invalid();
  }
}
/** Shared immutable owner decoding only; this does not confer read authority. */
export function parseStoredPlatformPublishingReceipt(value: unknown, observedAt: string) {
  const r = closed(value, ["receipt_text", "receipt_digest"]);
  if (typeof r.receipt_text !== "string" || r.receipt_text.length > 65536) return invalid();
  const receipt = parsePlatformPublishingReceipt(JSON.parse(r.receipt_text));
  if (
    canonicalizeRfc8785(receipt) !== r.receipt_text ||
    `sha256:${sha256Hex(r.receipt_text)}` !== r.receipt_digest ||
    receipt.occurredAt > observedAt
  )
    return invalid();
  return receipt;
}
export interface StoredPlatformPublishingHead {
  readonly sequence: number;
  readonly selected: PlatformPublishingSource;
  readonly release: PlatformPublishingSource | null;
  readonly releaseActive: boolean;
}
export function parseStoredPlatformPublishingHead(
  value: unknown,
  family: string,
  observedAt: string,
): StoredPlatformPublishingHead {
  const r = closed(value, [
    "sequence",
    "release_active",
    "selected_receipt_text",
    "selected_receipt_digest",
    "release_receipt_text",
    "release_receipt_digest",
  ]);
  if (
    typeof r.sequence !== "number" ||
    !Number.isInteger(r.sequence) ||
    r.sequence < 1 ||
    r.sequence > 2147483647 ||
    typeof r.release_active !== "boolean"
  )
    return invalid();
  const source = (text: unknown, digest: unknown) => {
    const receipt = parseStoredPlatformPublishingReceipt(
      { receipt_text: text, receipt_digest: digest },
      observedAt,
    );
    if (receipt.outcome !== "Committed") return invalid();
    return receipt.source;
  };
  const selected = source(r.selected_receipt_text, r.selected_receipt_digest);
  const release =
    r.release_receipt_text === null
      ? null
      : source(r.release_receipt_text, r.release_receipt_digest);
  if (
    selected.command.next.familyReference !== family ||
    selected.sequence > r.sequence ||
    (release &&
      (release.command.next.familyReference !== family ||
        release.sequence > r.sequence ||
        release.command.operation !== "Publish" ||
        release.command.release === null)) ||
    (r.release_active && release === null)
  )
    return invalid();
  return Object.freeze({
    sequence: r.sequence,
    selected,
    release,
    releaseActive: r.release_active,
  });
}
