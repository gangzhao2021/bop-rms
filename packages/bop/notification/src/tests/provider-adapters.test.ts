import { generateKeyPairSync, createSign, X509Certificate } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createContactDigester,
  createSesEmailAdapter,
  createSnsSignatureVerifier,
  createSnsSmsAdapter,
  renderCustomerOrderEmailHtml,
  type SesV2SendPort,
  type SnsPort,
} from "../index.js";

const id = (n: number) => `0190aa20-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const sesConfig = {
  region: "ca-central-1" as const,
  fromAddress: "orders@mail.example.test",
  fromDisplayName: "DEMO Store",
  configurationSetName: "bop-transactional",
};
const email = (overrides: Record<string, unknown> = {}) => ({
  channel: "Email" as const,
  destination: "guest@example.test",
  subject: "DEMO Store: order 12 is ready",
  text: "DEMO Store: your order 12 is ready. <b>",
  idempotencyKey: id(9) as never,
  ...overrides,
});
const sms = (overrides: Record<string, unknown> = {}) => ({
  channel: "Sms" as const,
  destination: "+14165550123",
  subject: null,
  text: "DEMO Store: we have your order 12.",
  idempotencyKey: id(9) as never,
  ...overrides,
});
/** Local fake SDK error: the shape the AWS SDK v3 throws. */
const sdkError = (name: string, status: number | undefined) =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

describe("SES email adapter (local fake, fault injection)", () => {
  it("sends one recipient, plain text plus escaped HTML, configuration set and opaque tag", async () => {
    const sendEmail = vi.fn<SesV2SendPort["sendEmail"]>(async () => ({ MessageId: "ses-0001" }));
    const adapter = createSesEmailAdapter(sesConfig, { sendEmail });
    await expect(adapter.send(email())).resolves.toEqual({
      outcome: "Accepted",
      providerMessageReference: "ses-0001",
    });
    const input = sendEmail.mock.calls[0]?.[0];
    expect(input?.Destination).toEqual({ ToAddresses: ["guest@example.test"] });
    expect(input?.FromEmailAddress).toBe('"DEMO Store" <orders@mail.example.test>');
    expect(input?.ConfigurationSetName).toBe("bop-transactional");
    expect(input?.Content?.Simple?.Body?.Html?.Data).toContain("&lt;b&gt;");
    expect(input?.Content?.Simple?.Body?.Html?.Data).not.toMatch(/<img|<script|<b>/u);
    expect(input?.EmailTags).toEqual([
      { Name: "purpose", Value: "customer-order" },
      { Name: "notification", Value: id(9) },
    ]);
    expect(JSON.stringify(input?.EmailTags)).not.toContain("guest@");
  });

  it("maps an explicit SES refusal to Rejected", async () => {
    const adapter = createSesEmailAdapter(sesConfig, {
      sendEmail: async () => {
        throw sdkError("MessageRejected", 400);
      },
    });
    await expect(adapter.send(email())).resolves.toEqual({ outcome: "Rejected" });
  });

  it.each([
    ["timeout", sdkError("TimeoutError", undefined)],
    ["5xx", sdkError("InternalFailure", 500)],
    ["network", new Error("socket hang up")],
  ])("throws on an ambiguous %s so the attempt is Unknown", async (_label, error) => {
    const adapter = createSesEmailAdapter(sesConfig, {
      sendEmail: async () => {
        throw error;
      },
    });
    await expect(adapter.send(email())).rejects.toThrow("SES_SEND_OUTCOME_UNKNOWN");
  });

  it("throws (Unknown) when SES accepts without a usable message id", async () => {
    const adapter = createSesEmailAdapter(sesConfig, { sendEmail: async () => ({}) });
    await expect(adapter.send(email())).rejects.toThrow("SES_SEND_OUTCOME_UNKNOWN");
  });

  it.each([
    { destination: "a@example.test\r\nBcc: x@example.test" },
    { destination: "a@example.test, b@example.test" },
    { subject: "Order\r\nBcc: x@example.test" },
    { subject: null },
  ])("refuses header injection or malformed input before calling SES %#", async (override) => {
    const sendEmail = vi.fn(async () => ({ MessageId: "x" }));
    const adapter = createSesEmailAdapter(sesConfig, { sendEmail });
    await expect(adapter.send(email(override))).rejects.toThrow();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("refuses an unsafe sender configuration", () => {
    expect(() =>
      createSesEmailAdapter(
        { ...sesConfig, fromDisplayName: 'Bad" <x@y.z>' },
        {
          sendEmail: async () => ({}),
        },
      ),
    ).toThrow();
    expect(() =>
      createSesEmailAdapter(
        { ...sesConfig, region: "us-east-1" as never },
        {
          sendEmail: async () => ({}),
        },
      ),
    ).toThrow();
  });

  it("renders an accessible HTML alternative with a language and no remote content", () => {
    const html = renderCustomerOrderEmailHtml("A & B");
    expect(html).toContain('lang="en-CA"');
    expect(html).toContain("A &amp; B");
    expect(html).not.toMatch(/https?:\/\/(?!order)/u);
  });
});

describe("SNS SMS adapter (local fake, fault injection)", () => {
  const port = (publish: SnsPort["publish"]): SnsPort => ({
    publish,
    confirmSubscription: async () => ({}),
  });
  it("publishes a transactional text from the registered number", async () => {
    const publish = vi.fn<SnsPort["publish"]>(async () => ({ MessageId: "sns-1" }));
    const adapter = createSnsSmsAdapter(
      { region: "ca-central-1", originationNumber: "+18885550100" },
      port(publish),
    );
    await expect(adapter.send(sms())).resolves.toEqual({
      outcome: "Accepted",
      providerMessageReference: "sns-1",
    });
    expect(publish.mock.calls[0]?.[0]).toMatchObject({
      PhoneNumber: "+14165550123",
      MessageAttributes: {
        "AWS.SNS.SMS.SMSType": { StringValue: "Transactional" },
        "AWS.MM.SMS.OriginationNumber": { StringValue: "+18885550100" },
      },
    });
  });
  it("maps an opted-out number to Rejected and a timeout to Unknown", async () => {
    const config = { region: "ca-central-1" as const, originationNumber: "+18885550100" };
    await expect(
      createSnsSmsAdapter(
        config,
        port(async () => {
          throw sdkError("OptedOutException", 400);
        }),
      ).send(sms()),
    ).resolves.toEqual({ outcome: "Rejected" });
    await expect(
      createSnsSmsAdapter(
        config,
        port(async () => {
          throw sdkError("TimeoutError", undefined);
        }),
      ).send(sms()),
    ).rejects.toThrow("SNS_SMS_OUTCOME_UNKNOWN");
  });
  it("only texts North American numbers", async () => {
    const publish = vi.fn(async () => ({ MessageId: "x" }));
    const adapter = createSnsSmsAdapter(
      { region: "ca-central-1", originationNumber: "+18885550100" },
      port(publish),
    );
    await expect(adapter.send(sms({ destination: "+447700900123" }))).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
  });
});

describe("SNS signature version 2 verifier", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const url = `https://sns.ca-central-1.amazonaws.com/SimpleNotificationService-${"a".repeat(32)}.pem`;
  const fakeCertificate = (subject: string) =>
    ({
      subject,
      validFrom: "Jan  1 00:00:00 2026 GMT",
      validTo: "Jan  1 00:00:00 2027 GMT",
      publicKey,
    }) as unknown as X509Certificate;
  const sign = (text: string) => {
    const signer = createSign("RSA-SHA256");
    signer.update(text);
    return signer.sign(privateKey, "base64");
  };
  it("verifies RSA-SHA256 over the canonical text and refuses a forged one", async () => {
    const parse = vi.fn(() => fakeCertificate("CN=sns.amazonaws.com"));
    const fetchCertificate = vi.fn(async () => "PEM");
    const verifier = createSnsSignatureVerifier({
      fetchCertificate,
      clock: { now: () => "2026-10-20T12:00:00.000Z" },
      parseCertificate: parse,
    });
    const canonicalMessage = "Message\nhello\nType\nNotification\n";
    await expect(
      verifier.verifyVersion2({
        signingCertificateUrl: url,
        canonicalMessage,
        signature: sign(canonicalMessage),
      }),
    ).resolves.toBe(true);
    await expect(
      verifier.verifyVersion2({
        signingCertificateUrl: url,
        canonicalMessage: `${canonicalMessage}x`,
        signature: sign(canonicalMessage),
      }),
    ).resolves.toBe(false);
    expect(fetchCertificate).toHaveBeenCalledTimes(1);
  });
  it("refuses a certificate URL off the approved host and a wrong certificate subject", async () => {
    const fetchCertificate = vi.fn(async () => "PEM");
    const verifier = createSnsSignatureVerifier({
      fetchCertificate,
      clock: { now: () => "2026-10-20T12:00:00.000Z" },
      parseCertificate: () => fakeCertificate("CN=attacker.example"),
    });
    await expect(
      verifier.verifyVersion2({
        signingCertificateUrl: "https://attacker.example/cert.pem",
        canonicalMessage: "x",
        signature: "eA==",
      }),
    ).resolves.toBe(false);
    expect(fetchCertificate).not.toHaveBeenCalled();
    await expect(
      verifier.verifyVersion2({
        signingCertificateUrl: url,
        canonicalMessage: "x",
        signature: "eA==",
      }),
    ).rejects.toThrow("SNS_CERTIFICATE_INVALID");
  });
});

describe("contact digests for the suppression list", () => {
  it("are keyed, versioned, channel-separated and checked across key versions", () => {
    const old = { version: 1, key: new Uint8Array(32).fill(1) };
    const next = { version: 2, key: new Uint8Array(32).fill(2) };
    const before = createContactDigester([old]);
    const after = createContactDigester([old, next]);
    const value = before.current("Email", "Guest@Example.test");
    expect(value).toMatch(/^hmac-sha256:v1:[0-9a-f]{64}$/u);
    expect(value).toBe(before.current("Email", "guest@example.test "));
    expect(value).not.toContain("guest");
    expect(after.current("Email", "guest@example.test")).toMatch(/^hmac-sha256:v2:/u);
    expect(after.all("Email", "guest@example.test")).toContain(value);
    expect(before.current("Sms", "+14165550123")).not.toBe(before.current("Email", "+14165550123"));
    expect(() => createContactDigester([{ version: 1, key: new Uint8Array(8) }])).toThrow();
  });
});
