// WP-2423 (DEC-PILOT-MAINTENANCE-PAGE): the small front that owns the published HTTPS port
// (compose service `front`, a separate container from `pilot`). While the pilot entry answers it
// relays every connection unchanged; while the entry is down (a deploy recreates the `pilot`
// container, a crash, a restart) it answers guests and staff with a plain "back in a minute" page
// (HTTP 503, Retry-After) instead of a connection reset. During a planned-update window
// (`pilot-ops.mjs maintenance start`) the page says the system is being updated.
//
//   node tooling/environment/pilot-front.mjs <runtime>      listens on 0.0.0.0:14443 (in the
//                                                           pilot network namespace) → 127.0.0.1:4443
//
// TLS: by default (no hosting.json, or `tls.mode: proxy`) the front relays TLS bytes untouched,
// so browsers keep talking to the pilot entry's own certificate exactly as before; the page is
// served with that same certificate. With `tls.mode: front` the front terminates TLS with the
// hosting's public certificate and re-encrypts to the local entry. Certificates are re-read when
// their files change (renewals need no restart). Nothing of a request is logged.
import { Buffer } from "node:buffer";
import console from "node:console";
import fs from "node:fs/promises";
import { clearInterval, clearTimeout, setInterval, setTimeout } from "node:timers";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL, URL } from "node:url";
import { loadPilotHosting } from "./pilot-hosting.mjs";
import { activePlannedMaintenance, readPlannedMaintenance } from "./pilot-ops-maintenance.mjs";

export const FRONT_PORT = 14443;
export const UPSTREAM_PORT = 4443;
const MAX_HEAD = 16 * 1024;
const RUNTIME = /^\.local\/[a-z0-9][a-z0-9_-]{0,63}$/u;

const COPY = {
  en: {
    updating: {
      title: "We're updating",
      lead: "Ordering is being updated and will be back in a minute or two.",
    },
    paused: {
      title: "Ordering is paused for a moment",
      lead: "We can't open the ordering page right now. It should be back shortly.",
    },
    retry: "This page will try again by itself. Orders already placed are not lost.",
    guest: "At a table? A staff member can take your order in the meantime.",
    staff:
      "Staff: keep taking orders at the counter or on paper (outage sheet) until this page comes back.",
    again: "Try again",
  },
  fr: {
    updating: {
      title: "Mise à jour en cours",
      lead: "La commande en ligne est en cours de mise à jour et revient dans une minute ou deux.",
    },
    paused: {
      title: "Commande en pause pour un instant",
      lead: "Nous ne pouvons pas ouvrir la page de commande pour le moment. Elle revient bientôt.",
    },
    retry: "Cette page réessaiera d'elle-même. Les commandes déjà passées ne sont pas perdues.",
    guest: "À une table? Un membre du personnel peut prendre votre commande en attendant.",
    staff:
      "Personnel : continuez de prendre les commandes au comptoir ou sur papier (fiche de panne) jusqu'au retour de cette page.",
    again: "Réessayer",
  },
};

/** The 503 answer for one request head (`null` when it is not an HTTP/1 request). */
export function renderUnavailable(head, { updating }) {
  const text = head.toString("latin1");
  const line = /^([A-Z]{3,10}) (\S{1,8192}) HTTP\/1\.[01]\r\n/u.exec(text);
  if (line === null) return null;
  const header = (name) =>
    new RegExp(`\\r\\n${name}:[ \\t]*([^\\r\\n]*)`, "iu").exec(text)?.[1]?.trim() ?? "";
  const [method, target] = [line[1], line[2]];
  const pathname = target.split(/[?#]/u)[0];
  const staff = /^\/(?:app|operations)(?:\/|$)/u.test(pathname);
  // Data requests of the pages (customer API, staff BFF, photos) get a short JSON answer.
  const api = /^\/(?:api|bff|media|merchant)(?:\/|$)/u.test(pathname);
  const wantsHtml = !api && /text\/html|\*\/\*/u.test(header("accept") || "text/html");
  const common = [
    "HTTP/1.1 503 Service Unavailable",
    "Retry-After: 30",
    "Cache-Control: no-store",
    "Connection: close",
    "X-Content-Type-Options: nosniff",
    "Referrer-Policy: no-referrer",
  ];
  let type, body;
  if (wantsHtml) {
    const lang = /^\s*fr\b/iu.test(header("accept-language")) ? "fr" : "en";
    const copy = COPY[lang],
      state = updating ? copy.updating : copy.paused;
    type = "text/html; charset=utf-8";
    common.push(
      "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    body = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="20"><title>${state.title}</title><style>body{margin:0;font:17px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#111;background:#fff}main{max-width:32rem;margin:0 auto;padding:18vh 1.5rem 2rem}h1{font-size:1.6rem;font-weight:600;margin:0 0 .75rem}p{margin:0 0 .9rem;color:#333}a{display:inline-block;margin-top:.75rem;padding:.7rem 1.4rem;border:1px solid #111;color:#111;text-decoration:none}</style></head><body><main><h1>${state.title}</h1><p>${state.lead}</p><p>${copy.retry}</p><p>${staff ? copy.staff : copy.guest}</p><a href="">${copy.again}</a></main></body></html>`;
  } else {
    type = "application/json";
    body = JSON.stringify({
      code: updating ? "SERVICE_UPDATING" : "SERVICE_UNAVAILABLE",
      retryable: true,
    });
  }
  const bytes = Buffer.from(body, "utf8");
  common.push(`Content-Type: ${type}`, `Content-Length: ${bytes.length}`);
  return Buffer.concat([
    Buffer.from(common.join("\r\n") + "\r\n\r\n", "latin1"),
    method === "HEAD" ? Buffer.alloc(0) : bytes,
  ]);
}

/** Reads one request head from a (decrypted) stream and answers it with the 503 page. */
function answerUnavailable(stream, isUpdating) {
  let head = Buffer.alloc(0);
  const timer = setTimeout(() => stream.destroy(), 10_000);
  const done = () => {
    clearTimeout(timer);
    stream.removeAllListeners("data");
  };
  stream.on("error", () => {
    done();
    stream.destroy();
  });
  stream.on("data", async (chunk) => {
    head = Buffer.concat([head, chunk]);
    if (head.indexOf("\r\n\r\n") === -1) {
      if (head.length > MAX_HEAD) {
        done();
        stream.destroy();
      }
      return;
    }
    done();
    const response = renderUnavailable(head, { updating: await isUpdating() });
    if (response === null) stream.destroy();
    else stream.end(response);
  });
}

async function fileStamp(file) {
  try {
    const stat = await fs.stat(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

/**
 * Starts the front. `hosting` is the parsed hosting.json; files are absolute paths. Returns the
 * listening server (tests close it).
 */
export async function startPilotFront({
  runtimeDirectory,
  hosting,
  listenHost = "0.0.0.0",
  listenPort = FRONT_PORT,
  upstreamHost = "127.0.0.1",
  upstreamPort = UPSTREAM_PORT,
  connectTimeoutMs = 3000,
  reloadEveryMs = 60_000,
  now = Date.now,
  log = (line) => console.log(line),
}) {
  const terminate = hosting.tls.mode === "front";
  const files = terminate
    ? { cert: hosting.tls.certificateFile, key: hosting.tls.keyFile }
    : {
        cert: path.join(runtimeDirectory, "customer-tls-cert.pem"),
        key: path.join(runtimeDirectory, "customer-tls-key.pem"),
      };
  const upstreamCa = path.join(runtimeDirectory, "customer-tls-cert.pem");
  const load = async () => ({
    context: tls.createSecureContext({
      cert: await fs.readFile(files.cert),
      key: await fs.readFile(files.key),
      minVersion: "TLSv1.2",
    }),
    upstreamCa: terminate ? await fs.readFile(upstreamCa).catch(() => null) : null,
    stamp: (await fileStamp(files.cert)) + "|" + (await fileStamp(files.key)),
  });
  let current = await load();
  const isUpdating = async () => {
    try {
      const marker = await readPlannedMaintenance(runtimeDirectory);
      return (
        typeof marker === "object" &&
        marker !== null &&
        activePlannedMaintenance(marker, now()) !== null
      );
    } catch {
      return false;
    }
  };
  let upstreamDown = false;
  const noteUpstream = (down) => {
    if (down === upstreamDown) return;
    upstreamDown = down;
    log(down ? "PILOT_FRONT_ENTRY_DOWN (serving the update page)" : "PILOT_FRONT_ENTRY_BACK");
  };
  const relay = (a, b) => {
    a.pipe(b).on("error", () => a.destroy());
    b.pipe(a).on("error", () => b.destroy());
    a.on("error", () => b.destroy());
    b.on("error", () => a.destroy());
    a.on("close", () => b.destroy());
    b.on("close", () => a.destroy());
  };
  let server;
  if (terminate) {
    server = tls.createServer({
      SNICallback: (_name, callback) => callback(null, current.context),
      ALPNProtocols: ["http/1.1"],
      minVersion: "TLSv1.2",
    });
    server.on("secureConnection", (clear) => {
      clear.pause();
      const upstream = tls.connect({
        host: upstreamHost,
        port: upstreamPort,
        ...(current.upstreamCa ? { ca: current.upstreamCa } : {}),
        ALPNProtocols: ["http/1.1"],
        timeout: connectTimeoutMs,
      });
      upstream.once("secureConnect", () => {
        upstream.setTimeout(0);
        noteUpstream(false);
        relay(clear, upstream);
        clear.resume();
      });
      const fallback = () => {
        upstream.destroy();
        noteUpstream(true);
        answerUnavailable(clear, isUpdating);
        clear.resume();
      };
      upstream.once("timeout", fallback);
      upstream.once("error", fallback);
    });
    server.on("tlsClientError", () => undefined);
  } else {
    server = net.createServer({ pauseOnConnect: true }, (socket) => {
      socket.on("error", () => socket.destroy());
      const upstream = net.connect({ host: upstreamHost, port: upstreamPort });
      const timer = setTimeout(() => upstream.destroy(Error("timeout")), connectTimeoutMs);
      upstream.once("connect", () => {
        clearTimeout(timer);
        noteUpstream(false);
        relay(socket, upstream);
        socket.resume();
      });
      upstream.once("error", () => {
        clearTimeout(timer);
        upstream.destroy();
        noteUpstream(true);
        const secure = new tls.TLSSocket(socket, {
          isServer: true,
          secureContext: current.context,
          ALPNProtocols: ["http/1.1"],
        });
        secure.on("error", () => socket.destroy());
        answerUnavailable(secure, isUpdating);
        socket.resume();
      });
    });
  }
  // Renewed certificate files take effect without a restart; a broken renewal keeps the old pair.
  const reload = setInterval(async () => {
    const stamp = (await fileStamp(files.cert)) + "|" + (await fileStamp(files.key));
    if (stamp === current.stamp) return;
    try {
      current = await load();
      log("PILOT_FRONT_CERTIFICATE_RELOADED");
    } catch {
      log("PILOT_FRONT_CERTIFICATE_UNREADABLE (keeping the previous certificate)");
    }
  }, reloadEveryMs);
  reload.unref();
  server.on("close", () => clearInterval(reload));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, listenHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  log(
    `PILOT_FRONT_LISTENING ${listenHost}:${server.address().port} → ${upstreamHost}:${upstreamPort} (${terminate ? "public certificate" : "relay"})`,
  );
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [runtime, ...rest] = process.argv.slice(2);
    if (rest.length !== 0 || typeof runtime !== "string" || !RUNTIME.test(runtime))
      throw Error("PILOT_FRONT_ARGUMENT_INVALID");
    const runtimeDirectory = path.join(fileURLToPath(new URL("../../", import.meta.url)), runtime);
    const hosting = await loadPilotHosting(runtimeDirectory, { test: false, unset: "development" });
    const server = await startPilotFront({ runtimeDirectory, hosting });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.once(signal, () => server.close(() => process.exit(0)));
  } catch (error) {
    console.error(
      /^PILOT_[A-Z_]+$/u.test(error?.message ?? "")
        ? error.message + (error.reason ? ` (${error.reason})` : "")
        : "PILOT_FRONT_START_UNAVAILABLE",
    );
    process.exitCode = 1;
  }
}
