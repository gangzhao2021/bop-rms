// WP-2423 Q13 (DEC-PILOT-ALERTS-BACKUP): alert channels. Every channel has
// `{ id, kind, send(message) }`; `send` resolves on delivery and throws a fixed code otherwise.
// The local channels (alert board + log file) are always on. Email (SMTP over TLS) and webhooks
// (JSON, Slack, Pushover, Twilio SMS) exist only when the Owner configures real accounts.
// Messages are already redacted (catalog text only); channels never log addresses or secrets.
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import process from "node:process";
import tls from "node:tls";
import { Buffer } from "node:buffer";
import { clearTimeout, setTimeout } from "node:timers";
import { URL, URLSearchParams } from "node:url";
import { randomUUID } from "node:crypto";
import { readPilotSecret } from "./pilot-ops-config.mjs";

const failed = (code) => {
  throw Error(code);
};

/** Always-on JSON-lines log of every alert change and delivery result (catalog keys only). */
export function createAlertLog(file, { maxBytes = 5 * 1024 * 1024 } = {}) {
  return async (entry) => {
    try {
      const stat = await fs.stat(file).catch(() => null);
      if (stat && stat.size > maxBytes) await fs.rename(file, `${file}.1`);
      await fs.appendFile(
        file,
        JSON.stringify({ time: new Date().toISOString(), ...entry }) + "\n",
        {
          mode: 0o600,
        },
      );
    } catch {
      process.stderr.write("PILOT_ALERT_LOG_UNAVAILABLE\n");
    }
  };
}

// --- SMTP (RFC 5321) over implicit TLS or STARTTLS; plaintext is never allowed. ---
function createReplyReader(socket) {
  let buffer = "";
  const waiting = [];
  const replies = [];
  let error = null;
  const flush = () => {
    while (waiting.length > 0 && (replies.length > 0 || error)) {
      const next = waiting.shift();
      if (replies.length > 0) next.resolve(replies.shift());
      else next.reject(error);
    }
  };
  const onData = (chunk) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > 65536) {
      error = Error("PILOT_ALERT_EMAIL_PROTOCOL");
      flush();
      return;
    }
    let lines = [];
    let index;
    while ((index = buffer.indexOf("\r\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      lines.push(line);
      if (/^\d{3} /u.test(line) || /^\d{3}$/u.test(line)) {
        replies.push({ code: Number(line.slice(0, 3)), lines });
        lines = [];
      }
    }
    if (lines.length > 0) buffer = lines.map((line) => line + "\r\n").join("") + buffer;
    flush();
  };
  const onEnd = () => {
    error ??= Error("PILOT_ALERT_EMAIL_CONNECTION");
    flush();
  };
  socket.on("data", onData);
  socket.on("error", onEnd);
  socket.on("close", onEnd);
  return {
    next: () =>
      new Promise((resolve, reject) => {
        waiting.push({ resolve, reject });
        flush();
      }),
    detach: () => {
      socket.off("data", onData);
      socket.off("error", onEnd);
      socket.off("close", onEnd);
    },
  };
}
const header = (value) =>
  /^[\x20-\x7e]*$/u.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
/** One RFC 5322 message, base64 body, no user data other than catalog text. */
export function buildEmailMessage({ from, to, subject, text, now = new Date() }) {
  const body = Buffer.from(text.replace(/\r?\n/gu, "\r\n"), "utf8")
    .toString("base64")
    .replace(/.{1,76}/gu, "$&\r\n");
  return [
    `From: ${from}`,
    `To: ${to.join(", ")}`,
    `Subject: ${header(subject.replace(/[\r\n]/gu, " "))}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomUUID()}@${from.split("@")[1]}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "Auto-Submitted: auto-generated",
    "",
    body,
  ].join("\r\n");
}
/**
 * Sends one message. `connect` opens the transport (tests inject a local server); for STARTTLS,
 * `upgrade` wraps the socket in TLS after the server agrees. Server certificates are verified.
 */
export async function sendSmtpMail({
  config,
  password,
  message,
  connect = (options) =>
    config.security === "tls"
      ? tls.connect({ host: options.host, port: options.port, servername: options.host })
      : net.connect({ host: options.host, port: options.port }),
  upgrade = (socket, options) => tls.connect({ socket, servername: options.host }),
  timeoutMs = 20_000,
}) {
  let socket = connect({ host: config.host, port: config.port });
  const timer = setTimeout(() => socket.destroy(Error("PILOT_ALERT_EMAIL_TIMEOUT")), timeoutMs);
  let reader = createReplyReader(socket);
  const expect = async (codes) => {
    const reply = await reader.next();
    if (!codes.includes(reply.code)) failed("PILOT_ALERT_EMAIL_REJECTED");
    return reply;
  };
  const command = async (line, codes) => {
    socket.write(line + "\r\n");
    return expect(codes);
  };
  try {
    await expect([220]);
    const name = "bop-rms-pilot." + (os.hostname().replace(/[^A-Za-z0-9-]/gu, "") || "local");
    let hello = await command(`EHLO ${name}`, [250]);
    if (config.security === "starttls") {
      if (!hello.lines.some((line) => /^250[- ]STARTTLS\b/iu.test(line)))
        failed("PILOT_ALERT_EMAIL_NO_TLS");
      await command("STARTTLS", [220]);
      reader.detach();
      socket = upgrade(socket, { host: config.host });
      reader = createReplyReader(socket);
      hello = await command(`EHLO ${name}`, [250]);
    }
    if (config.username !== null)
      await command(
        `AUTH PLAIN ${Buffer.from(`\0${config.username}\0${password}`).toString("base64")}`,
        [235],
      );
    await command(`MAIL FROM:<${config.from}>`, [250]);
    for (const to of config.to) await command(`RCPT TO:<${to}>`, [250, 251]);
    await command("DATA", [354]);
    const data = message
      .split("\r\n")
      .map((line) => (line.startsWith(".") ? "." + line : line))
      .join("\r\n");
    await command(`${data}\r\n.`, [250]);
    socket.write("QUIT\r\n");
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- a fixed code only: the cause may hold a secret URL or an address
    throw Error(
      String(error?.message).startsWith("PILOT_ALERT_EMAIL_")
        ? error.message
        : "PILOT_ALERT_EMAIL_FAILED",
    );
  } finally {
    clearTimeout(timer);
    reader.detach();
    socket.end();
  }
}

// --- Webhooks ---
const json = (body) => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const form = (values) => ({
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(values).toString(),
});
/** The HTTP request for one message in each supported webhook format. */
export function buildWebhookRequest(hook, secrets, message) {
  switch (hook.format) {
    case "json":
      return {
        url: secrets.url,
        ...json({
          severity: message.severity,
          subject: message.subject,
          text: message.text,
        }),
      };
    case "slack":
      return { url: secrets.url, ...json({ text: `*${message.subject}*\n\n${message.text}` }) };
    case "pushover":
      return {
        url: "https://api.pushover.net/1/messages.json",
        ...form({
          token: secrets.token,
          user: secrets.userKey,
          title: message.subject.slice(0, 250),
          message: message.text.slice(0, 1024),
          priority: message.severity === "critical" ? "1" : "0",
        }),
      };
    case "twilio-sms": {
      const body = `${message.subject}\n${message.text}`.slice(0, 1200);
      return {
        url: `https://api.twilio.com/2010-04-01/Accounts/${hook.accountSid}/Messages.json`,
        auth: `Basic ${Buffer.from(`${hook.accountSid}:${secrets.authToken}`).toString("base64")}`,
        perRecipient: hook.to.map((to) => form({ To: to, From: hook.from, Body: body })),
      };
    }
    default:
      return failed("PILOT_ALERT_WEBHOOK_FORMAT");
  }
}
async function post(fetcher, url, request, auth) {
  const response = await fetcher(url, {
    method: "POST",
    redirect: "error",
    signal: globalThis.AbortSignal.timeout(15_000),
    headers: { ...request.headers, ...(auth ? { authorization: auth } : {}) },
    body: request.body,
  });
  // Drain without keeping the body: it may echo account details.
  await response.arrayBuffer().catch(() => undefined);
  if (!response.ok) failed("PILOT_ALERT_WEBHOOK_REJECTED");
}

/** Builds the configured outbound channels. Secrets are read at send time, never cached in logs. */
export function createOutboundChannels(
  config,
  runtimeDirectory,
  { fetcher = globalThis.fetch, smtp = sendSmtpMail, readSecret = readPilotSecret } = {},
) {
  const channels = [];
  if (config.email !== null)
    channels.push({
      id: "email",
      kind: "email",
      async send(message) {
        const password =
          config.email.passwordFile === null
            ? null
            : await readSecret(runtimeDirectory, config.email.passwordFile);
        await smtp({
          config: config.email,
          password,
          message: buildEmailMessage({
            from: config.email.from,
            to: config.email.to,
            subject: message.subject,
            text: message.text,
          }),
        });
      },
    });
  config.webhooks.forEach((hook, index) =>
    channels.push({
      id: `webhook-${index + 1}`,
      kind: "webhook",
      async send(message) {
        const secrets = {};
        try {
          if (hook.urlFile) secrets.url = await readSecret(runtimeDirectory, hook.urlFile);
          if (hook.tokenFile) secrets.token = await readSecret(runtimeDirectory, hook.tokenFile);
          if (hook.userKeyFile)
            secrets.userKey = await readSecret(runtimeDirectory, hook.userKeyFile);
          if (hook.authTokenFile)
            secrets.authToken = await readSecret(runtimeDirectory, hook.authTokenFile);
          if (secrets.url !== undefined && new URL(secrets.url).protocol !== "https:")
            failed("PILOT_ALERT_WEBHOOK_URL");
        } catch (error) {
          // eslint-disable-next-line preserve-caught-error -- a fixed code only: the cause may hold a secret URL or an address
          throw Error(
            error?.message === "PILOT_ALERT_WEBHOOK_URL"
              ? error.message
              : "PILOT_ALERT_WEBHOOK_SECRET",
          );
        }
        const request = buildWebhookRequest(hook, secrets, message);
        try {
          if (request.perRecipient)
            for (const one of request.perRecipient)
              await post(fetcher, request.url, one, request.auth);
          else await post(fetcher, request.url, request);
        } catch (error) {
          // eslint-disable-next-line preserve-caught-error -- a fixed code only: the cause may hold a secret URL or an address
          throw Error(
            error?.message === "PILOT_ALERT_WEBHOOK_REJECTED"
              ? error.message
              : "PILOT_ALERT_WEBHOOK_FAILED",
          );
        }
      },
    }),
  );
  return channels;
}

/**
 * Dead man's switch: a ping to an external uptime service (for example a healthchecks-style URL)
 * every few minutes while the monitor runs. When the whole host is off, no in-host alert can be
 * sent; the external service notices the missing pings and alerts the Owner instead.
 */
export function createHeartbeat(
  config,
  runtimeDirectory,
  { fetcher = globalThis.fetch, readSecret = readPilotSecret } = {},
) {
  if (config.heartbeat === null) return null;
  let last = 0;
  return {
    async beat(now) {
      if (now - last < config.heartbeat.everyMinutes * 60_000) return "Skipped";
      const url = await readSecret(runtimeDirectory, config.heartbeat.urlFile);
      if (new URL(url).protocol !== "https:") failed("PILOT_ALERT_HEARTBEAT_URL");
      const response = await fetcher(url, {
        method: "GET",
        redirect: "error",
        signal: globalThis.AbortSignal.timeout(10_000),
      });
      await response.arrayBuffer().catch(() => undefined);
      if (!response.ok) failed("PILOT_ALERT_HEARTBEAT_REJECTED");
      last = now;
      return "Sent";
    },
  };
}
