import "dotenv/config";
import { Client, GatewayIntentBits, Events, MessageFlags } from "discord.js";
import { commands } from "./commands/index.js";
import { handleClaim, CLAIM_PREFIX } from "./lib/claim.js";

const token = process.env.DISCORD_TOKEN;
if (!token) throw new Error("DISCORD_TOKEN is not set — copy .env.example to .env");

// Guilds is all we need: everything runs through slash commands and buttons,
// so no Message Content intent and no privileged-intent review.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) => {
  console.log(`Logged in as ${c.user.tag} (${c.guilds.cache.size} guilds)`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  // Claim buttons are handled here, not by a per-message collector, so they
  // keep working across restarts and shards. Other custom ids (pagination)
  // fall through to their own collectors.
  if (interaction.isButton()) {
    if (!interaction.customId.startsWith(CLAIM_PREFIX)) return;
    try {
      await handleClaim(interaction);
    } catch (err) {
      console.error("claim failed:", err);
      await interaction
        .reply({ content: "Couldn't process that claim.", flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`/${interaction.commandName} failed:`, err);
    const body = {
      content: "Something broke running that command.",
      flags: MessageFlags.Ephemeral as const,
    };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(body).catch(() => {});
    } else {
      await interaction.reply(body).catch(() => {});
    }
  }
});

client.login(token);
