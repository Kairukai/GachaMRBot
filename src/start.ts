/**
 * Single-file entrypoint for panel hosts (Wispbyte and similar) that run
 * `node <file>` and can't chain commands the way `npm run start:single` does.
 *
 * Applies migrations, then boots the bot in the same process. Both imports are
 * dynamic so the ordering is explicit: migrations must finish before the bot
 * touches a table that might not exist yet.
 *
 * Single process on purpose — no ShardingManager. Sharding only matters past
 * Discord's 2,500-guild threshold and would double memory on a small plan.
 */
export {}; // makes this a module, which top-level await requires

// The build emits .js.map files, but Node ignores them unless told otherwise.
// Turning them on makes production stack traces point at src/*.ts line numbers
// instead of compiled output — worth a lot when the only view of a panel host
// is its console.
process.setSourceMapsEnabled(true);

await import("./migrate.js");
await import("./bot.js");
