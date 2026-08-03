import "dotenv/config";
import { fileURLToPath } from "node:url";
import { ShardingManager } from "discord.js";
/**
 * Production entrypoint. Discord requires sharding past 2,500 guilds; starting
 * here means that threshold is a config change, not a rewrite.
 * For local development run `npm run dev`, which starts src/bot.ts directly.
 *
 * The shard path is resolved relative to this module rather than the working
 * directory — tsc emits to dist/src/, so a hardcoded "./dist/bot.js" is wrong
 * and only fails once you actually deploy.
 */
const shardFile = fileURLToPath(new URL("./bot.js", import.meta.url));
const manager = new ShardingManager(shardFile, {
    token: process.env.DISCORD_TOKEN,
    totalShards: "auto",
});
manager.on("shardCreate", (shard) => console.log(`Launched shard ${shard.id}`));
manager.spawn();
//# sourceMappingURL=index.js.map