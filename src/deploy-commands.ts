import "dotenv/config";
import { REST, Routes } from "discord.js";
import { commands } from "./commands/index.js";

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const devGuild = process.env.DEV_GUILD_ID;

if (!token || !clientId) {
  throw new Error("DISCORD_TOKEN and DISCORD_CLIENT_ID must both be set");
}

const body = [...commands.values()].map((c) => c.data.toJSON());
const rest = new REST().setToken(token);

// Guild commands register instantly; global commands take up to an hour to
// propagate, so develop against DEV_GUILD_ID and drop it for production.
const route = devGuild
  ? Routes.applicationGuildCommands(clientId, devGuild)
  : Routes.applicationCommands(clientId);

await rest.put(route, { body });
console.log(
  `Registered ${body.length} commands ${devGuild ? `to guild ${devGuild}` : "globally"}.`,
);
