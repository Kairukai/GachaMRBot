import "dotenv/config";
import { Client, GatewayIntentBits, Events, MessageFlags } from "discord.js";
import { commands } from "./commands/index.js";
import { handleClaim, CLAIM_PREFIX } from "./lib/claim.js";
import { handleTradeButton, TRADE_PREFIX } from "./lib/trade.js";

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
    const isClaim = interaction.customId.startsWith(CLAIM_PREFIX);
    const isTrade = interaction.customId.startsWith(TRADE_PREFIX);
    if (!isClaim && !isTrade) return;
    try {
      await (isClaim ? handleClaim(interaction) : handleTradeButton(interaction));
    } catch (err) {
      console.error("button failed:", err);
      await interaction
        .reply({ content: "Couldn't process that.", flags: MessageFlags.Ephemeral })
        .catch(() => {});
    }
    return;
  }

  if (interaction.isAutocomplete()) {
    const command = commands.get(interaction.commandName);
    try {
      await command?.autocomplete?.(interaction);
    } catch (err) {
      console.error(`autocomplete for /${interaction.commandName} failed:`, err);
      await interaction.respond([]).catch(() => {});
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
