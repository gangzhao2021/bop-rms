import { type AppendAuditRecordInput } from "@bop/audit";
import {
  parseDiningHash,
  parseDiningInstant,
  parseDiningReference,
  type DiningReference,
  type DiningInstant,
} from "../domain/dining-session.js";
import {
  parseDiningCheckoutCommitment,
  assertDiningCheckoutPreparedForOrdering,
  assertDiningCheckoutCommitmentUsable,
  prepareDiningCheckoutCommitment,
  type DiningCheckoutCommitment,
} from "../domain/dining-checkout-commitment.js";
import { captureSessionData } from "./dining-session-snapshot.js";
import {
  createDiningGuestBindingQuery,
  type DiningGuestBindingOptions,
  type DiningGuestBindingReadSnapshot,
} from "./dining-guest-binding-query.js";

export class DiningCheckoutServiceError extends Error {
  constructor(
    readonly code:
      | "DINING_CHECKOUT_REQUEST_INVALID"
      | "DINING_CHECKOUT_PERMISSION_DENIED"
      | "DINING_CHECKOUT_INTENT_CONFLICT"
      | "DINING_CHECKOUT_SOURCE_EXPIRED"
      | "DINING_CHECKOUT_DEPENDENCY_UNAVAILABLE",
  ) {
    super("dining checkout preparation is unavailable");
    this.name = "DiningCheckoutServiceError";
  }
}
const refs = [
  "commitmentReference",
  "guestSessionReference",
  "diningSessionReference",
  "participantReference",
  "cartReference",
  "quoteReference",
  "submissionReference",
  "orderReference",
  "orderBatchReference",
  "paymentOperationReference",
] as const;
export type DiningCheckoutPrepareCommand = Readonly<
  Record<(typeof refs)[number], DiningReference> & {
    cartVersion: number;
    sourceValidUntil: DiningInstant;
  }
>;
export interface DiningCheckoutGuestAuthority {
  readonly guestSessionReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly diningSessionReference: string;
  readonly participantReference: string;
  readonly tableReference: string;
  readonly identityVersion: number;
  readonly expiresAt: string;
  readonly observedAt: string;
}
export interface DiningCheckoutServiceOptions {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly now: () => string;
  readonly hashIntent: (value: string) => string;
  readonly authorization: {
    /** Current Identity/CSRF plus exact bound participant; no authority inferred from command IDs. */
    authorize(input: {
      readonly action: "PrepareDiningCheckout" | "AuthorizeDiningCheckoutPayment";
      readonly command: DiningCheckoutPrepareCommand;
      readonly observedAt: DiningInstant;
    }): Promise<DiningCheckoutGuestAuthority | null>;
  };
  readonly current: DiningGuestBindingOptions["repository"];
  readonly repository: {
    load(reference: DiningReference): Promise<DiningCheckoutCommitment | null>;
    append(input: {
      readonly record: DiningCheckoutCommitment;
      readonly expectedVersion: 0;
      readonly audit: AppendAuditRecordInput;
    }): Promise<
      Readonly<{
        status: "Created" | "Existing";
        record: DiningCheckoutCommitment;
        version: number;
      }>
    >;
  };
  readonly audit: {
    create(input: {
      readonly record: DiningCheckoutCommitment;
      readonly observedAt: DiningInstant;
    }): Promise<AppendAuditRecordInput>;
  };
}
function fail(code: DiningCheckoutServiceError["code"]): never {
  throw new DiningCheckoutServiceError(code);
}
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail("DINING_CHECKOUT_REQUEST_INVALID");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== "string" || !fields.includes(k))
  )
    return fail("DINING_CHECKOUT_REQUEST_INVALID");
  const out: Record<string, unknown> = {};
  for (const key of fields) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail("DINING_CHECKOUT_REQUEST_INVALID");
    out[key] = d.value;
  }
  return out;
}
function command(value: unknown): DiningCheckoutPrepareCommand {
  try {
    const raw = closed(value, [...refs, "cartVersion", "sourceValidUntil"]);
    if (!Number.isSafeInteger(raw.cartVersion) || (raw.cartVersion as number) < 1)
      return fail("DINING_CHECKOUT_REQUEST_INVALID");
    return Object.freeze({
      ...(Object.fromEntries(refs.map((k) => [k, parseDiningReference(raw[k])])) as Record<
        (typeof refs)[number],
        DiningReference
      >),
      cartVersion: raw.cartVersion as number,
      sourceValidUntil: parseDiningInstant(raw.sourceValidUntil),
    });
  } catch {
    return fail("DINING_CHECKOUT_REQUEST_INVALID");
  }
}
const authorityKeys = [
  "guestSessionReference",
  "brandReference",
  "storeReference",
  "diningSessionReference",
  "participantReference",
  "tableReference",
  "identityVersion",
  "expiresAt",
  "observedAt",
] as const;

/** Owner application entry. Result is durable history; it cannot authorize Payment by itself. */
export function createDiningCheckoutService(options: DiningCheckoutServiceOptions) {
  const scope = closed(options.scope, ["brandReference", "storeReference"]);
  const brand = parseDiningReference(scope.brandReference),
    store = parseDiningReference(scope.storeReference);
  async function prepare(value: unknown, forOrdering: boolean, forPayment = false) {
    const input = command(value);
    let observedAt: DiningInstant | undefined;
    const now = () => {
      const at = parseDiningInstant(options.now());
      if (observedAt !== undefined && at < observedAt)
        return fail("DINING_CHECKOUT_DEPENDENCY_UNAVAILABLE");
      observedAt = at;
      return at;
    };
    try {
      const intentHash = parseDiningHash(
        options.hashIntent(
          "PrepareDiningCheckout:" +
            JSON.stringify({ brandReference: brand, storeReference: store, ...input }),
        ),
      );
      let originalAuthority: Omit<DiningCheckoutGuestAuthority, "observedAt"> | undefined;
      async function authorize() {
        const started = now();
        const supplied = await options.authorization.authorize({
          action: forPayment ? "AuthorizeDiningCheckoutPayment" : "PrepareDiningCheckout",
          command: input,
          observedAt: started,
        });
        const raw = supplied === null ? null : closed(captureSessionData(supplied), authorityKeys);
        const checked = now();
        if (raw === null) return fail("DINING_CHECKOUT_PERMISSION_DENIED");
        const authority = {
          guestSessionReference: parseDiningReference(raw.guestSessionReference),
          brandReference: parseDiningReference(raw.brandReference),
          storeReference: parseDiningReference(raw.storeReference),
          diningSessionReference: parseDiningReference(raw.diningSessionReference),
          participantReference: parseDiningReference(raw.participantReference),
          tableReference: parseDiningReference(raw.tableReference),
          identityVersion: raw.identityVersion as number,
          expiresAt: parseDiningInstant(raw.expiresAt),
        };
        if (
          raw.observedAt !== started ||
          !Number.isSafeInteger(authority.identityVersion) ||
          authority.identityVersion < 1 ||
          authority.expiresAt <= checked ||
          authority.brandReference !== brand ||
          authority.storeReference !== store ||
          authority.guestSessionReference !== input.guestSessionReference ||
          authority.diningSessionReference !== input.diningSessionReference ||
          authority.participantReference !== input.participantReference
        )
          return fail("DINING_CHECKOUT_PERMISSION_DENIED");
        if (
          originalAuthority !== undefined &&
          JSON.stringify(originalAuthority) !== JSON.stringify(authority)
        )
          return fail("DINING_CHECKOUT_PERMISSION_DENIED");
        originalAuthority = Object.freeze(authority);
        return authority;
      }
      async function current(
        authority: DiningCheckoutGuestAuthority | Omit<DiningCheckoutGuestAuthority, "observedAt">,
      ) {
        let snapshot: DiningGuestBindingReadSnapshot | undefined;
        const query = createDiningGuestBindingQuery({
          scope: { brandReference: brand, storeReference: store },
          now,
          repository: {
            readCurrent: async (request) => {
              const result = await options.current.readCurrent(request);
              if (result === null) return null;
              snapshot = captureSessionData(result);
              return snapshot;
            },
          },
        });
        const binding = await query.resolve({
          purpose: "GuestSessionBinding",
          diningSessionReference: input.diningSessionReference,
          participantReference: input.participantReference,
          tableReference: authority.tableReference,
        });
        if (binding === null || snapshot === undefined || authority.expiresAt <= now())
          return fail("DINING_CHECKOUT_PERMISSION_DENIED");
        return { binding, snapshot };
      }
      function original(value: unknown) {
        const record = parseDiningCheckoutCommitment(value);
        if (
          record.brandReference !== brand ||
          record.storeReference !== store ||
          record.intentHash !== intentHash ||
          record.cartVersion !== input.cartVersion ||
          record.preparationValidUntil !== input.sourceValidUntil ||
          refs.some((k) => record[k] !== input[k])
        )
          return fail("DINING_CHECKOUT_INTENT_CONFLICT");
        return record;
      }
      async function resultForPurpose(result: {
        readonly status: "Created" | "Existing";
        readonly record: DiningCheckoutCommitment;
      }) {
        if (!forOrdering && !forPayment) return Object.freeze(result);
        const authority = await authorize();
        const context = await current(authority);
        await authorize();
        (forPayment
          ? assertDiningCheckoutCommitmentUsable
          : assertDiningCheckoutPreparedForOrdering)(
          result.record,
          {
            session: context.snapshot.session,
            participant: context.snapshot.participant,
          },
          now(),
        );
        return Object.freeze(result);
      }
      await authorize();
      const loaded = await options.repository.load(input.commitmentReference);
      const prior = loaded === null ? null : original(captureSessionData(loaded));
      const authority = await authorize();
      const context = await current(authority);
      if (prior !== null) {
        await authorize();
        // A current bound participant can recover history during Closing; this grants no new Batch.
        return await resultForPurpose({ status: "Existing", record: prior });
      }
      if (forPayment) return fail("DINING_CHECKOUT_DEPENDENCY_UNAVAILABLE");
      if (context.binding.phase !== "Active") return fail("DINING_CHECKOUT_PERMISSION_DENIED");
      const preparedAt = now();
      if (preparedAt >= input.sourceValidUntil) return fail("DINING_CHECKOUT_SOURCE_EXPIRED");
      const record = prepareDiningCheckoutCommitment(
        {
          commitmentReference: input.commitmentReference,
          brandReference: brand,
          storeReference: store,
          diningSessionReference: input.diningSessionReference,
          sessionVersion: context.binding.diningSessionVersion,
          tableReference: context.binding.tableReference,
          tableAssignmentVersion: context.binding.tableAssignmentVersion,
          participantReference: input.participantReference,
          participantVersion: context.binding.participantVersion,
          guestSessionReference: input.guestSessionReference,
          cartReference: input.cartReference,
          cartVersion: input.cartVersion,
          quoteReference: input.quoteReference,
          submissionReference: input.submissionReference,
          orderReference: input.orderReference,
          orderBatchReference: input.orderBatchReference,
          paymentOperationReference: input.paymentOperationReference,
          intentHash,
          preparedAt,
          preparationValidUntil: input.sourceValidUntil,
        },
        { session: context.snapshot.session, participant: context.snapshot.participant },
      );
      const audit = captureSessionData(await options.audit.create({ record, observedAt: now() }));
      await authorize();
      if (now() >= input.sourceValidUntil) return fail("DINING_CHECKOUT_SOURCE_EXPIRED");
      const saved = closed(
        captureSessionData(await options.repository.append({ record, expectedVersion: 0, audit })),
        ["status", "record", "version"],
      );
      if ((saved.status !== "Created" && saved.status !== "Existing") || saved.version !== 1)
        return fail("DINING_CHECKOUT_DEPENDENCY_UNAVAILABLE");
      const result = original(saved.record);
      if (
        result.state !== "Prepared" ||
        (saved.status === "Created" && JSON.stringify(result) !== JSON.stringify(record))
      )
        return fail("DINING_CHECKOUT_DEPENDENCY_UNAVAILABLE");
      await authorize();
      return await resultForPurpose({ status: saved.status, record: result });
    } catch (error) {
      if (error instanceof DiningCheckoutServiceError) throw error;
      return fail("DINING_CHECKOUT_DEPENDENCY_UNAVAILABLE");
    }
  }
  return Object.freeze({
    prepare: (value: unknown) => prepare(value, false),
    prepareForOrdering: (value: unknown) => prepare(value, true),
    authorizePayment: (value: unknown) => prepare(value, false, true),
  });
}
