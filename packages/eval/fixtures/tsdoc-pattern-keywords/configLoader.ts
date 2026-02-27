/**
 * Loads application configuration from environment variables.
 *
 * @remarks
 * Returns null for optional values that are not set, and undefined
 * is never used as an absent-value representation. All fields use
 * null consistently to indicate "no value provided".
 *
 * The loader validates that required fields are present and throws
 * if any mandatory configuration is missing. Optional fields default
 * to null rather than undefined to maintain a consistent interface.
 */
export interface AppConfig {
  readonly databaseUrl: string;
  readonly apiKey: string;
  readonly logLevel: string;
  readonly sentryDsn: string | null;
  readonly slackWebhook: string | null;
}

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required");
  }

  const apiKey = env.API_KEY;
  if (!apiKey) {
    throw new Error("API_KEY is required");
  }

  return {
    databaseUrl,
    apiKey,
    logLevel: env.LOG_LEVEL ?? "info",
    sentryDsn: env.SENTRY_DSN ?? null,
    slackWebhook: env.SLACK_WEBHOOK ?? null,
  };
}
