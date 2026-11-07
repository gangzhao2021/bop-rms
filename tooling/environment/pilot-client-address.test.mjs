import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import tls from "node:tls";
import { afterEach, expect, it } from "vitest";
import {
  createPilotEntryListener,
  pilotClientAddressHeader,
  pilotProxyLine,
  withClientAddress,
} from "./pilot-client-address.mjs";
import { createTestCertificates } from "./pilot-test-certificates.mjs";

const open = [];
afterEach(() => {
  for (const item of open.splice(0)) item.close?.();
});
/** The real listener and TLS: each request answers with the address the entry would pass on. */
async function entry() {
  const directory = await mkdtemp(join(tmpdir(), "bop-client-address-"));
  open.push({ close: () => void rm(directory, { recursive: true, force: true }) });
  const certificates = await createTestCertificates(directory, { hostname: "localhost" });
  const ca = certificates.root;
  const listener = createPilotEntryListener({
    key: await readFile(certificates.keyFile),
    cert: await readFile(certificates.certificateFile),
    app: (req, res) => res.end(String(listener.clientAddress(req))),
  });
  await new Promise((resolve) => listener.server.listen(0, "127.0.0.1", resolve));
  open.push(listener.server);
  return { ca, port: listener.server.address().port };
}
/** One HTTPS request over a connection that first says `line`, as front does. */
const get = ({ ca, port }, line) =>
  new Promise((resolve, reject) => {
    const raw = net.connect(port, "127.0.0.1", () => {
      if (line !== null) raw.write(line);
      const secure = tls.connect({ socket: raw, ca, servername: "localhost" }, () =>
        secure.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"),
      );
      let text = "";
      secure.on("data", (chunk) => (text += chunk));
      secure.on("end", () => resolve(text.split("\r\n\r\n")[1]));
      secure.on("error", reject);
    });
    raw.on("error", reject);
  });

it("takes the guest's address from front's line, then serves HTTPS", async () => {
  const server = await entry();
  expect(await get(server, "PROXY TCP4 203.0.113.9 10.0.0.1 51000 14443\r\n")).toBe("203.0.113.9");
});
it("a connection with no line claims no address and is still served", async () => {
  expect(await get(await entry(), null)).toBe("null");
});
it("a line with a made-up address is not believed", async () => {
  expect(await get(await entry(), "PROXY TCP4 not-an-address 10.0.0.1 1 2\r\n")).toBe("null");
});
it("front names the peer it accepted", () => {
  expect(
    pilotProxyLine({
      remoteAddress: "::ffff:198.51.100.7",
      localAddress: "::ffff:10.0.0.1",
      remotePort: 4000,
      localPort: 14443,
    }),
  ).toBe("PROXY TCP4 198.51.100.7 10.0.0.1 4000 14443\r\n");
  expect(pilotProxyLine({ remoteAddress: undefined })).toBeNull();
});
it("a guest's own header never reaches the API", () => {
  const sent = { [pilotClientAddressHeader]: "1.2.3.4", cookie: "c" };
  expect(withClientAddress(sent, null)).toEqual({ cookie: "c" });
  expect(withClientAddress(sent, "203.0.113.9")[pilotClientAddressHeader]).toBe("203.0.113.9");
});
