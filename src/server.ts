import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";
import { createDatabase } from "./db/client.js";
import { loggingTransport, startPublisher } from "./core/events/publisher.js";

const env = loadEnv();
const { sql, db } = createDatabase(env);
const app = await buildApp({ env, db });

const publisher = startPublisher({
  db,
  transport: loggingTransport((msg) => app.log.info({ component: "outbox" }, msg)),
  batchSize: env.outboxBatchSize,
  pollIntervalMs: env.outboxPollIntervalMs,
  onError: (error) => app.log.error({ err: error, component: "outbox" }, "publish batch failed"),
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  publisher.stop();
  await app.close();
  await sql.end({ timeout: 5 });
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: env.port, host: env.host });
