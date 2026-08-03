import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
const url = process.env.DATABASE_URL;
if (!url) {
    const envFile = process.env.DOTENV_CONFIG_PATH ?? ".env";
    throw new Error(`DATABASE_URL is not set in ${envFile}`);
}
/**
 * Managed Postgres (Neon, Supabase, Aiven) requires TLS and caps connections
 * hard on free tiers — often far below what a default pool would open. Both are
 * therefore configurable, and the pool defaults small enough to be safe on a
 * free tier rather than large enough to exhaust one.
 */
const poolMax = Number(process.env.DB_POOL_MAX ?? 5);
// postgres.js reads `?sslmode=` from the URL, but hosts differ on whether they
// include it. DB_SSL=true forces TLS without demanding a specific URL shape.
const forceSsl = /^(1|true|require)$/i.test(process.env.DB_SSL ?? "");
const client = postgres(url, {
    max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 5,
    ...(forceSsl ? { ssl: "require" } : {}),
});
export const db = drizzle(client, { schema });
export { schema };
//# sourceMappingURL=index.js.map