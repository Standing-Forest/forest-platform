export type AuthMode = "dev-headers";

export interface Env {
  nodeEnv: string;
  /**
   * How principals are authenticated. No authentication contract exists in
   * Release 0, so this must be chosen explicitly — an unset value is a startup
   * failure rather than a silent default. See core/auth/principal.ts.
   */
  authMode: AuthMode;
  databaseUrl: string;
  port: number;
  host: string;
  /** Identity of this deployment; stamped onto every domain event. */
  instanceId: string;
  serviceName: string;
  logLevel: string;
  outboxPollIntervalMs: number;
  outboxBatchSize: number;
  /** Requests allowed per window, per client, before 429. */
  rateLimitMax: number;
  rateLimitWindowMs: number;
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, received '${raw}'`);
  }
  return parsed;
}

function loadAuthMode(nodeEnv: string): AuthMode {
  const mode = process.env.AUTH_MODE;
  if (mode === "dev-headers") {
    if (nodeEnv === "production") {
      throw new Error(
        "AUTH_MODE=dev-headers is refused when NODE_ENV=production. The development header " +
          "shim is not a security mechanism, and Release 0 defines no authentication contract " +
          "to replace it with. Wire a real PrincipalResolver before deploying.",
      );
    }
    return mode;
  }
  throw new Error(
    `AUTH_MODE must be set explicitly (received '${mode ?? "unset"}'). ` +
      "The only implementation available is 'dev-headers', which is development-only.",
  );
}

export function loadEnv(): Env {
  const nodeEnv = process.env.NODE_ENV ?? "development";
  return {
    nodeEnv,
    authMode: loadAuthMode(nodeEnv),
    databaseUrl: required(
      "DATABASE_URL",
      "postgres://postgres:postgres@localhost:5432/forest_platform",
    ),
    port: integer("PORT", 3000),
    host: required("HOST", "0.0.0.0"),
    instanceId: required("INSTANCE_ID", "00000000-0000-7000-8000-000000000001"),
    serviceName: required("SERVICE_NAME", "forest-platform-api"),
    logLevel: required("LOG_LEVEL", "info"),
    outboxPollIntervalMs: integer("OUTBOX_POLL_INTERVAL_MS", 1000),
    outboxBatchSize: integer("OUTBOX_BATCH_SIZE", 100),
    rateLimitMax: integer("RATE_LIMIT_MAX", 100),
    rateLimitWindowMs: integer("RATE_LIMIT_WINDOW_MS", 60_000),
  };
}
