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
if (!url) throw new Error("DATABASE_URL is not set");

const client = postgres(url, { max: 1 });

try {
  await migrate(drizzle(client), {
    migrationsFolder: path.resolve(process.cwd(), "drizzle"),
  });
  console.log("migrations up to date");
} finally {
  await client.end();
}
