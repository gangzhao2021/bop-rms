import { describe, expect, it, vi } from "vitest";
import {
  buildReceiptResumeFragmentLink,
  createResumeTokenService,
  ResumeTokenError,
  type ResumeTokenPorts,
  type ResumeTokenRecord,
} from "../index.js";

const id = (n: number) => `018f9a00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
const plaintext = "Z".repeat(43);
const refs = {
  order: id(1),
  brand: id(2),
  store: id(3),
  attempt1: id(4),
  attempt2: id(5),
  attempt3: id(6),
  record1: id(7),
  record2: id(8),
  grant: id(9),
};
const at = "2026-08-12T14:00:00.000Z";
const expires = "2026-08-12T14:30:00.000Z";

function harness() {
  const active: ResumeTokenRecord[] = [];
  const appended: ResumeTokenRecord[] = [];
  let nextRecord = refs.record1;
  const ports: ResumeTokenPorts = {
    tokens: {
      mint: vi.fn(async () => ({ plaintextToken: plaintext, tokenHashDigest: digest("a") })),
      hash: vi.fn(async () => digest("a")),
    },
    references: { generateTokenRecord: () => nextRecord },
    records: {
      listUnexpired: vi.fn(async () => active),
      append: vi.fn(async (record) => {
        appended.push(record);
        active.push(record);
        return record;
      }),
      consumeAndRevokeSiblings: vi.fn(async () => ({
        grantReference: refs.grant as never,
        orderReference: refs.order as never,
        brandReference: refs.brand as never,
        storeReference: refs.store as never,
        consumedTokenRecordReference: refs.record1 as never,
        revokedSiblingReferences: [refs.record2 as never],
      })),
    },
  };
  return {
    service: createResumeTokenService(ports),
    ports,
    active,
    appended,
    next(reference: string) {
      nextRecord = reference;
    },
  };
}

function input(attemptReference = refs.attempt1) {
  return {
    orderReference: refs.order,
    brandReference: refs.brand,
    storeReference: refs.store,
    attemptReference,
    mintedAt: at,
    expiresAt: expires,
  };
}

describe("notification resume token service", () => {
  it("returns plaintext only to worker memory and persists hash/reference only", async () => {
    const test = harness();
    const result = await test.service.mintForAttempt(input());
    expect(result.plaintextToken).toBe(plaintext);
    expect(JSON.stringify(test.appended)).not.toContain(plaintext);
    expect(result.record.tokenHashDigest).toBe(digest("a"));
  });

  it("allows a second sibling only after Unknown and denies a third", async () => {
    const test = harness();
    await test.service.mintForAttempt(input());
    const first = test.active[0];
    if (!first) throw new Error("missing synthetic token record");
    test.active[0] = { ...first, deliveryOutcome: "Unknown" };
    test.next(refs.record2);
    await expect(test.service.mintForAttempt(input(refs.attempt2))).resolves.toMatchObject({
      record: { attemptReference: refs.attempt2 },
    });
    await expect(test.service.mintForAttempt(input(refs.attempt3))).rejects.toEqual(
      new ResumeTokenError("RESUME_TOKEN_SIBLING_LIMIT"),
    );
  });

  it("denies a second sibling while the first Attempt is pending", async () => {
    const test = harness();
    await test.service.mintForAttempt(input());
    await expect(test.service.mintForAttempt(input(refs.attempt2))).rejects.toMatchObject({
      code: "RESUME_TOKEN_SIBLING_LIMIT",
    });
  });

  it("atomically consumes by hash and returns only an opaque scoped grant", async () => {
    const test = harness();
    await expect(
      test.service.consume({ plaintextToken: plaintext, observedAt: at }),
    ).resolves.toEqual({
      grantReference: refs.grant,
      orderReference: refs.order,
      brandReference: refs.brand,
      storeReference: refs.store,
    });
    expect(test.ports.records.consumeAndRevokeSiblings).toHaveBeenCalledOnce();
    expect(
      JSON.stringify(
        (test.ports.records.consumeAndRevokeSiblings as ReturnType<typeof vi.fn>).mock.calls,
      ),
    ).not.toContain(plaintext);
  });

  it("builds only a clean canonical fragment link", () => {
    expect(
      buildReceiptResumeFragmentLink({
        origin: "https://customer.example.test",
        orderReference: refs.order,
        plaintextToken: plaintext,
      }),
    ).toBe(`https://customer.example.test/orders/${refs.order}/receipt#resume=${plaintext}`);
    expect(() =>
      buildReceiptResumeFragmentLink({
        origin: "http://customer.example.test",
        orderReference: refs.order,
        plaintextToken: plaintext,
      }),
    ).toThrow(ResumeTokenError);
  });
});
