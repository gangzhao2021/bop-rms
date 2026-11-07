import type { ConsumerTransaction } from "@bop/eventing";
import { memberDisplayNames, type MemberDirectoryTransaction } from "@bop/membership";
import type { RoleAssignmentTransaction } from "@bop/permission";
import { createStaffLabels } from "./merchant-staff-labels.js";

/**
 * WP-2423 M61: who did what on one order — who accepted each round (or that it was sent
 * automatically), who handed it over, who took each payment, who cancelled, refunded or wrote it
 * off and who approved. Each fact is read from its owner's records; the people are named the way
 * staff screens name them ("You", the member's name, else their role), never by an identifier.
 * Only the one-order read builds it (never the polled list).
 */
export interface OrderRecordFacts {
  accepted: { round: number; actor: string | null; at: string }[];
  handedOver: { actor: string; at: string }[];
  payments: {
    method: "CardMachine" | "Cash" | "Online";
    /** A part of a split table bill (1-based), else null. */
    part: number | null;
    /** The batch a staff-entered round's card-machine payment paid, else null. */
    batch: string | null;
    /** Null for a guest's own online payment. */
    actor: string | null;
    at: string;
  }[];
  cancellations: { what: "Order" | "Round" | "Items"; actor: string; at: string }[];
  refunds: {
    method: "CardMachine" | "Cash" | "Online";
    amountMinor: string;
    actor: string;
    /** Who approved it, when an approval was required and recorded; else null. */
    approver: string | null;
    at: string;
  }[];
  writeOff: { amountMinor: string; actor: string; approver: string; at: string } | null;
}

export function emptyOrderRecordFacts(): OrderRecordFacts {
  return {
    accepted: [],
    handedOver: [],
    payments: [],
    cancellations: [],
    refunds: [],
    writeOff: null,
  };
}

export interface OrderRecordPerson {
  readonly name: string;
  readonly at: string;
}
export interface OrderRecord {
  readonly accepted: readonly {
    readonly round: number;
    /** Null: sent to the kitchen automatically when paid. */
    readonly by: string | null;
    readonly at: string;
  }[];
  readonly handedOver: readonly OrderRecordPerson[];
  readonly payments: readonly {
    readonly method: "CardMachine" | "Cash" | "Online";
    readonly part: number | null;
    readonly round: number | null;
    readonly by: string | null;
    readonly at: string;
  }[];
  readonly cancellations: readonly {
    readonly what: "Order" | "Round" | "Items";
    readonly by: string;
    readonly at: string;
  }[];
  readonly refunds: readonly {
    readonly method: "CardMachine" | "Cash" | "Online";
    readonly amountMinor: string;
    readonly by: string;
    readonly approvedBy: string | null;
    readonly at: string;
  }[];
  readonly writeOff: {
    readonly amountMinor: string;
    readonly by: string;
    readonly approvedBy: string;
    readonly at: string;
  } | null;
}

const byTime = <T extends { readonly at: string }>(items: readonly T[]): readonly Readonly<T>[] =>
  Object.freeze(
    [...items]
      .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
      .map((item) => Object.freeze(item)),
  );

/** Names every person in the facts at once, in the read's own transaction and Store scope. */
export async function nameOrderRecord(
  tx: ConsumerTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  input: {
    readonly viewer: string | null;
    readonly at: string;
    readonly facts: OrderRecordFacts;
    /** Each batch's round number (1-based, in submission order). */
    readonly rounds: ReadonlyMap<string, number>;
  },
): Promise<OrderRecord> {
  const { facts } = input;
  const actors = new Set<string>();
  const add = (actor: string | null) => {
    if (actor !== null) actors.add(actor);
  };
  facts.accepted.forEach((item) => add(item.actor));
  facts.handedOver.forEach((item) => add(item.actor));
  facts.payments.forEach((item) => add(item.actor));
  facts.cancellations.forEach((item) => add(item.actor));
  facts.refunds.forEach((item) => {
    add(item.actor);
    add(item.approver);
  });
  if (facts.writeOff !== null) {
    add(facts.writeOff.actor);
    add(facts.writeOff.approver);
  }
  const names =
    actors.size === 0
      ? new Map<string, string>()
      : await memberDisplayNames(tx as unknown as MemberDirectoryTransaction, scope, [...actors]);
  const label = await createStaffLabels(tx as unknown as RoleAssignmentTransaction, scope, {
    viewer: input.viewer,
    at: input.at,
    names,
  });
  const name = (actor: string | null) => (actor === null ? null : label(actor));
  return Object.freeze({
    accepted: byTime(
      facts.accepted.map((item) => ({ round: item.round, by: name(item.actor), at: item.at })),
    ),
    handedOver: byTime(facts.handedOver.map((item) => ({ name: label(item.actor), at: item.at }))),
    payments: byTime(
      facts.payments.map((item) => ({
        method: item.method,
        part: item.part,
        round: item.batch === null ? null : (input.rounds.get(item.batch) ?? null),
        by: item.method === "Online" ? null : name(item.actor),
        at: item.at,
      })),
    ),
    cancellations: byTime(
      facts.cancellations.map((item) => ({ what: item.what, by: label(item.actor), at: item.at })),
    ),
    refunds: byTime(
      facts.refunds.map((item) => ({
        method: item.method,
        amountMinor: item.amountMinor,
        by: label(item.actor),
        approvedBy: name(item.approver),
        at: item.at,
      })),
    ),
    writeOff:
      facts.writeOff === null
        ? null
        : Object.freeze({
            amountMinor: facts.writeOff.amountMinor,
            by: label(facts.writeOff.actor),
            approvedBy: label(facts.writeOff.approver),
            at: facts.writeOff.at,
          }),
  });
}
