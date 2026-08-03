import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { RARITY_META, rates, type Rarity } from "../lib/gacha.js";
import { availableRarities } from "../lib/pool.js";

export const data = new SlashCommandBuilder()
  .setName("rates")
  .setDescription("Show the current drop rates.")
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  const pool = await availableRarities();
  const table = rates(pool);

  const lines = (Object.keys(table) as Rarity[])
    .map((r) => `${RARITY_META[r].emoji} **${RARITY_META[r].label}** — ${table[r]}`)
    .join("\n");

  const embed = new EmbedBuilder()
    .setTitle("Drop rates")
    .setDescription(lines)
    .setColor(0x5865f2)
    .setFooter({
      text:
        "Every roll is independent — there is no pity system, so these are the " +
        "true odds on every single roll. Read from the live card pool.",
    });

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
