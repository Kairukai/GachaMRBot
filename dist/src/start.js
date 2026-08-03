// The build emits .js.map files, but Node ignores them unless told otherwise.
// Turning them on makes production stack traces point at src/*.ts line numbers
// instead of compiled output — worth a lot when the only view of a panel host
// is its console.
process.setSourceMapsEnabled(true);
await import("./migrate.js");
await import("./bot.js");
export {};
//# sourceMappingURL=start.js.map