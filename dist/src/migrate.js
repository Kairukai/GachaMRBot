import "dotenv/config";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
/**
 * Applies migrations using drizzle-orm's programmatic migrator rather than the
 * drizzle-kit CLI, which is a devDependency and isn't present in the production
 * image. Runs on container start, before the bot connects.
 *
 * The folder is resolved from the working directory, which is the project root
 * in development and /app in the container — unlike a module-relative path,
 * which would differ between src/ and dist/src/.
 */
const url = process.env.DATABASE_URL;
if (!url)
    throw new Error("DATABASE_URL is not set");
/**
 * DB_SSL is honoured here for the same reason src/db/index.ts honours it:
 * managed Postgres requires TLS but hosts differ on whether the URL carries
 * `?sslmode=`. Without this the bot would connect happily while migrations
 * failed against the very same database — a confusing way to find out.
 */
const forceSsl = /^(1|true|require)$/i.test(process.env.DB_SSL ?? "");
const client = postgres(url, { max: 1, ...(forceSsl ? { ssl: "require" } : {}) });
try {
    await migrate(drizzle(client), {
        migrationsFolder: path.resolve(process.cwd(), "drizzle"),
    });
    console.log("migrations up to date");
}
finally {
    await client.end();
}
//# sourceMappingURL=migrate.js.map