import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { RARITY_META, ratesAt, HARD_PITY, SOFT_PITY_START, type Rarity } from "../lib/gacha.js";
import { ensureMember } from "../lib/state.js";
import { availableRarities } from "../lib/pool.js";

export const data = new SlashCommandBuilder()
  .setName("rates")
  .setDescription("Show current drop rates and your pity counter.")
  .setDMPermission(false);

export async function execute(interaction: ChatInputCommandInteraction) {
  const state = await ensureMember(interaction.user.id, interaction.guildId!);
  const pool = await availableRarities();
  const rates = ratesAt(state.pity, pool);

  const lines = (Object.keys(rates) as Rarity[])
    .map((r) => `${RARITY_META[r].emoji} **${RARITY_META[r].label}** — ${rates[r]}`)
    .join("\n");

  const embed = new EmbedBuilder()
    .setTitle("Drop rates")
    .setDescription(lines)
    .setColor(0x5865f2)
    .addFields({
      name: "Your pity",
      value:
        `${state.pity} rolls since your last Legendary+\n` +
        `Rates start climbing at ${SOFT_PITY_START} · guaranteed at ${HARD_PITY}`,
    });

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
