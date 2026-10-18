import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildEmailMessage,
  buildWebhookRequest,
  createAlertLog,
  createHeartbeat,
  createOutboundChannels,
  sendSmtpMail,
} from "./pilot-alert-channels.mjs";
import { parsePilotOpsConfig, readPilotSecret } from "./pilot-ops-config.mjs";

const servers = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});
/** A scripted SMTP server; records every line the client sends. */
async function fakeSmtp({ rejectRcpt = false } = {}) {
  const lines = [];
  const server = net.createServer((socket) => {
    let data = false,
      buffer = "";
    socket.write("220 fake ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let index;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        lines.push(line);
        if (data) {
          if (line === ".") {
            data = false;
            socket.write("250 queued\r\n");
          }
          continue;
        }
        if (line.startsWith("EHLO")) socket.write("250-fake\r\n250-AUTH PLAIN\r\n250 8BITMIME\r\n");
        else if (line.startsWith("AUTH PLAIN")) socket.write("235 ok\r\n");
        else if (line.startsWith("MAIL FROM")) socket.write("250 ok\r\n");
        else if (line.startsWith("RCPT TO")) socket.write(rejectRcpt ? "550 no\r\n" : "250 ok\r\n");
        else if (line === "DATA") {
          data = true;
          socket.write("354 go\r\n");
        } else if (line === "QUIT") socket.end("221 bye\r\n");
      }
    });
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, lines };
}
const emailConfig = (port) => ({
  host: "127.0.0.1",
  port,
  security: "tls",
  from: "alerts@store.test",
  to: ["owner@store.test"],
  username: "alerts@store.test",
  passwordFile: "ops-smtp-password",
});

describe("WP-2423 Q13 email channel (SMTP)", () => {
  it("authenticates and sends one base64 message to each recipient", async () => {
    const smtp = await fakeSmtp();
    await sendSmtpMail({
      config: emailConfig(smtp.port),
      password: "app-password",
      message: buildEmailMessage({
        from: "alerts@store.test",
        to: ["owner@store.test"],
        subject: "Main St: URGENT - No recent backup",
        text: "line\n.starts with a dot",
      }),
      // Tests speak plain TCP; production connects with TLS (implicit or STARTTLS) only.
      connect: ({ port }) => net.connect({ host: "127.0.0.1", port }),
    });
    expect(smtp.lines.some((line) => line.startsWith("AUTH PLAIN "))).toBe(true);
    expect(smtp.lines).toContain("RCPT TO:<owner@store.test>");
    expect(smtp.lines).toContain("Subject: Main St: URGENT - No recent backup");
    expect(smtp.lines).toContain(".");
  });
  it("fails with a fixed code when the server refuses, and refuses STARTTLS servers without TLS", async () => {
    const smtp = await fakeSmtp({ rejectRcpt: true });
    const send = (config) =>
      sendSmtpMail({
        config,
        password: "app-password",
        message: "Subject: x\r\n\r\nbody",
        connect: ({ port }) => net.connect({ host: "127.0.0.1", port }),
      });
    await expect(send(emailConfig(smtp.port))).rejects.toThrow("PILOT_ALERT_EMAIL_REJECTED");
    const plain = await fakeSmtp();
    await expect(send({ ...emailConfig(plain.port), security: "starttls" })).rejects.toThrow(
      "PILOT_ALERT_EMAIL_NO_TLS",
    );
    expect(plain.lines.some((line) => line.startsWith("AUTH"))).toBe(false);
  });
  it("encodes a non-ASCII store name in the subject header", () => {
    expect(
      buildEmailMessage({
        from: "a@b.test",
        to: ["c@d.test"],
        subject: "Café: test alert",
        text: "x",
      }),
    ).toContain("Subject: =?UTF-8?B?");
  });
});

describe("WP-2423 Q13 webhook channels", () => {
  const message = {
    subject: "Main St: URGENT - No recent backup",
    text: "Problem (urgent): …",
    severity: "critical",
  };
  it("builds the JSON, Slack, Pushover and Twilio SMS requests", () => {
    expect(
      JSON.parse(
        buildWebhookRequest({ format: "json" }, { url: "https://hook.test/x" }, message).body,
      ),
    ).toEqual({
      severity: "critical",
      subject: message.subject,
      text: message.text,
    });
    expect(
      JSON.parse(
        buildWebhookRequest({ format: "slack" }, { url: "https://hook.test/x" }, message).body,
      ).text,
    ).toContain("*Main St: URGENT");
    const pushover = buildWebhookRequest(
      { format: "pushover" },
      { token: "t", userKey: "u" },
      message,
    );
    expect(new globalThis.URLSearchParams(pushover.body).get("priority")).toBe("1");
    const sid = "AC" + "0".repeat(32);
    const twilio = buildWebhookRequest(
      {
        format: "twilio-sms",
        accountSid: sid,
        from: "+14165550100",
        to: ["+14165550101", "+14165550102"],
      },
      { authToken: "secret" },
      message,
    );
    expect(twilio.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`);
    expect(twilio.perRecipient).toHaveLength(2);
  });
  it("reads secrets only from private files and never puts them in an error", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ops-channel-"));
    await fs.writeFile(path.join(dir, "hook-url"), "https://hooks.test/T000/secret-path\n", {
      mode: 0o600,
    });
    const config = parsePilotOpsConfig(
      { schemaVersion: 1, webhooks: [{ format: "slack", urlFile: "hook-url" }] },
      ".local/pilot-test",
    );
    const fetcher = vi.fn(async () => new globalThis.Response("no", { status: 500 }));
    const [channel] = createOutboundChannels(config, dir, { fetcher });
    const error = await channel.send(message).catch((e) => e);
    expect(error.message).toBe("PILOT_ALERT_WEBHOOK_REJECTED");
    expect(fetcher.mock.calls[0][1].redirect).toBe("error");
    await fs.chmod(path.join(dir, "hook-url"), 0o644);
    await expect(channel.send(message)).rejects.toThrow("PILOT_ALERT_WEBHOOK_SECRET");
    await expect(readPilotSecret(dir, "../etc/passwd")).rejects.toThrow();
    await fs.rm(dir, { recursive: true });
  });
  it("pings the heartbeat no more often than configured", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ops-beat-"));
    await fs.writeFile(path.join(dir, "beat-url"), "https://hc.test/ping/abc", { mode: 0o600 });
    const fetcher = vi.fn(async () => new globalThis.Response("ok"));
    const beat = createHeartbeat(
      parsePilotOpsConfig(
        { schemaVersion: 1, heartbeat: { urlFile: "beat-url", everyMinutes: 5 } },
        ".local/p",
      ),
      dir,
      { fetcher },
    );
    expect(await beat.beat(0 + 10 * 60_000)).toBe("Sent");
    expect(await beat.beat(12 * 60_000)).toBe("Skipped");
    expect(await beat.beat(16 * 60_000)).toBe("Sent");
    expect(fetcher).toHaveBeenCalledTimes(2);
    await fs.rm(dir, { recursive: true });
  });
  it("has no outbound channel and no heartbeat unless configured", () => {
    const config = parsePilotOpsConfig(null, ".local/pilot-v15");
    expect(createOutboundChannels(config, "/x")).toEqual([]);
    expect(createHeartbeat(config, "/x")).toBeNull();
  });
});

describe("WP-2423 Q13 alert log and configuration", () => {
  it("appends private JSON lines and rotates when large", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ops-log-"));
    const file = path.join(dir, "alerts.log");
    const log = createAlertLog(file, { maxBytes: 10 });
    await log({ event: "alert_raised", key: "backup.stale" });
    await log({ event: "alert_cleared", key: "backup.stale" });
    expect(((await fs.stat(file)).mode & 0o777).toString(8)).toBe("600");
    expect(JSON.parse(await fs.readFile(`${file}.1`, "utf8")).key).toBe("backup.stale");
    await fs.rm(dir, { recursive: true });
  });
  it("accepts a complete configuration and refuses plaintext, unknown keys and S3 (external gate)", () => {
    const valid = {
      schemaVersion: 1,
      siteLabel: "Main St",
      email: {
        host: "smtp.mail.test",
        port: 587,
        security: "starttls",
        from: "a@store.test",
        to: ["o@store.test"],
        username: "a@store.test",
        passwordFile: "ops-smtp-password",
      },
      backup: {
        role: "bop_rms_admin",
        passwordFile: "migration-admin-password",
        timeZone: "America/Toronto",
        localTime: "04:30",
        offsite: { kind: "directory", keyFile: "offsite-backup-key" },
      },
    };
    const config = parsePilotOpsConfig(valid, ".local/pilot-v15");
    expect(config.backup.directory).toBe(".local/pilot-v15-backups");
    expect(config.backup.offsite.path).toBe("/offsite");
    const bad = [
      { ...valid, email: { ...valid.email, security: "none" } },
      { ...valid, extra: true },
      { ...valid, runbookUrl: "http://plain.test" },
      { ...valid, backup: { ...valid.backup, offsite: { kind: "s3", keyFile: "k" } } },
      { ...valid, backup: { ...valid.backup, timeZone: "Mars/Base" } },
      { ...valid, webhooks: [{ format: "json", url: "https://inline-secret.test" }] },
    ];
    for (const value of bad)
      expect(() => parsePilotOpsConfig(value, ".local/pilot-v15")).toThrow(
        "PILOT_OPS_CONFIG_INVALID",
      );
  });
});
