import { Buffer } from "node:buffer";
import { createServer as createHttpServer } from "node:http";
import { isIP, createServer as createNetServer } from "node:net";
import { Duplex } from "node:stream";
import { createSecureContext, TLSSocket } from "node:tls";

/**
 * WP-2423 (v15 rush 2026-11-02): how a guest's own address reaches the entry limit. Only hops we run
 * can state it, never a guest: `front` (the one that owns the public port) opens each connection to
 * the HTTPS entry with a PROXY protocol v1 line naming the peer it accepted, when hosting.json says
 * that peer is the guest (`clientAddress: "connection"`). The entry reads that line from loopback
 * only, then sets the one header the API believes, replacing whatever the request carried. Without
 * it (the local install, where Docker's port forward hides the guest) no address is claimed.
 */
export const pilotClientAddressHeader = "x-bop-client-address";

const plain = (address) =>
  typeof address === "string" && address.startsWith("::ffff:") ? address.slice(7) : address;

/** The line `front` writes first on a connection to the entry, or null when it has no address. */
export function pilotProxyLine(socket) {
  const source = plain(socket.remoteAddress);
  const target = plain(socket.localAddress);
  const family = isIP(source);
  if (family === 0 || isIP(target) !== family) return null;
  return `PROXY TCP${family} ${source} ${target} ${socket.remotePort} ${socket.localPort}\r\n`;
}

const lineLimit = 108; // The protocol's own limit for v1.
function parseProxyLine(line) {
  const parts = line.split(" ");
  if (parts.length !== 6 || parts[0] !== "PROXY" || !["TCP4", "TCP6"].includes(parts[1]))
    return null;
  return isIP(parts[2]) === (parts[1] === "TCP4" ? 4 : 6) ? parts[2] : null;
}

const isLoopback = (address) => {
  const value = plain(address);
  return value === "::1" || (typeof value === "string" && value.startsWith("127."));
};

/** A connection's bytes after the line, as a stream TLS can read (Node's TLS skips bytes it can't). */
function afterLine(socket, first) {
  const rest = new Duplex({
    read() {
      socket.resume();
    },
    write(chunk, encoding, done) {
      socket.write(chunk, encoding, done);
    },
    final(done) {
      socket.end(done);
    },
    destroy(error, done) {
      socket.destroy();
      done(error);
    },
  });
  socket.on("data", (chunk) => {
    if (!rest.push(chunk)) socket.pause();
  });
  socket.on("end", () => rest.push(null));
  socket.on("close", () => rest.destroy());
  socket.on("error", (error) => rest.destroy(error));
  if (first.length > 0) rest.push(first);
  return rest;
}

/**
 * The listening side of the HTTPS entry when `front` states addresses: takes the line from a loopback
 * peer, remembers the address for the connection, and serves the rest as HTTPS. Used only then: an
 * installation without it listens as plain HTTPS, exactly as before.
 */
/**
 * The entry keeps an idle connection for 75 s (as common web servers do), so the pages' own
 * refreshes (every few seconds) keep their connections instead of opening new ones.
 * Note (2026-11-12, docs/spec/design/pickup-capacity-and-retry.md §4): the staff reloads failing
 * with net::ERR_TOO_MANY_RETRIES were not caused by keep-alive. They come from a browser that only
 * clicked through the self-signed InternalTest certificate (see pilot-tls-trust.mjs); with the
 * certificate trusted they do not occur.
 */
export const pilotEntryKeepAliveMs = 75_000;
export function configurePilotEntryConnections(server) {
  server.keepAliveTimeout = pilotEntryKeepAliveMs;
  // A request's headers still have to arrive promptly; only idle time between requests grows.
  server.headersTimeout = 20_000;
  return server;
}

export function createPilotEntryListener({ key, cert, app }) {
  const context = createSecureContext({ key, cert, minVersion: "TLSv1.2" });
  const http = configurePilotEntryConnections(createHttpServer(app));
  const addresses = new WeakMap();
  const serve = (socket, first, address) => {
    const secure = new TLSSocket(afterLine(socket, first), {
      isServer: true,
      secureContext: context,
      ALPNProtocols: ["http/1.1"],
    });
    if (address !== null) addresses.set(secure, address);
    secure.on("error", () => secure.destroy());
    secure.once("secure", () => http.emit("connection", secure));
  };
  const server = createNetServer({ pauseOnConnect: true }, (socket) => {
    socket.on("error", () => socket.destroy());
    let buffered = Buffer.alloc(0);
    const read = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      const head = buffered.subarray(0, 6).toString("latin1");
      const named = "PROXY ".startsWith(head) && isLoopback(socket.remoteAddress);
      if (!named) {
        socket.removeListener("data", read);
        serve(socket, buffered, null);
        return;
      }
      if (buffered.length < 6) return;
      const end = buffered.indexOf("\r\n");
      if (end === -1 ? buffered.length > lineLimit : end > lineLimit) {
        socket.destroy();
        return;
      }
      if (end === -1) return;
      socket.removeListener("data", read);
      serve(
        socket,
        buffered.subarray(end + 2),
        parseProxyLine(buffered.subarray(0, end).toString("latin1")),
      );
    };
    socket.on("data", read);
    socket.resume();
  });
  return Object.freeze({
    server,
    /** The guest's address for this request's connection, or null. */
    clientAddress: (request) => addresses.get(request.socket) ?? null,
  });
}

/** The headers the entry sends the API: a guest's own copy of the header never survives. */
export function withClientAddress(headers, address) {
  const next = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name !== pilotClientAddressHeader),
  );
  return address === null ? next : { ...next, [pilotClientAddressHeader]: address };
}
