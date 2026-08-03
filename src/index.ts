import "dotenv/config";
import { ShardingManager } from "discord.js";

/**
 * Production entrypoint. Discord requires sharding past 2,500 guilds; starting
 * here means that threshold is a config change, not a rewrite.
 * For local development run `npm run dev`, which starts src/bot.ts directly.
 */
const manager = new ShardingManager("./dist/bot.js", {
  token: process.env.DISCORD_TOKEN!,
  totalShards: "auto",
});

manager.on("shardCreate", (shard) => console.log(`Launched shard ${shard.id}`));
manager.spawn();
