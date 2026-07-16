import { createServer } from "node:http";
import pino from "pino";
import { createApp } from "./app.js";

const logger = pino({ base: { service: "bop-rms-api" } });
const port = Number.parseInt(process.env.PORT ?? "3000", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT must be an integer from 1 to 65535");
const server = createServer(createApp());
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;
let closing = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (closing) return;
  closing = true;
  logger.info({ event: "shutdown_started", signal });
  server.close((error) => {
    if (error) {
      logger.error({ event: "shutdown_failed", error: error.message });
      process.exitCode = 1;
    } else logger.info({ event: "shutdown_complete" });
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
server.listen(port, "127.0.0.1", () => logger.info({ event: "listening", port }));
