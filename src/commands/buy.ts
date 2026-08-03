import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { ensureMember, ensureGuild, getShards } from "../lib/state.js";
import { PRICE, LABEL, buyConfirmRow, type Item } from "../lib/shop.js";

export const data = new SlashCommandBuilder()
  .setName("buy")
  .setDescription("Spend shards on extra rolls or claims.")
  .setDMPermission(false)
  .addStringOption((o) =>
    o
      .setName("item")
      .setDescription("What to buy")
      .setRequired(true)
      .addChoices(
        { name: `Roll — 💠${PRICE.roll} each`, value: "roll" },
        { name: `Claim — 💠${PRICE.claim} each`, value: "claim" },
      ),
  )
  .addIntegerOption((o) =>
    o
      .setName("amount")
      .setDescription("How many (default 1)")
      .setRequired(false)
      .setMinValue(1)
      .setMaxValue(10),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  // Deferred immediately: every path here queries Postgres, and a cold or
  // distant database can exceed Discord's 3-second interaction deadline.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId!;
  const item = interaction.options.getString("item", true) as Item;
  const qty = interaction.options.getInteger("amount") ?? 1;

  const state = await ensureMember(interaction.user.id, guildId);
  const settings = await ensureGuild(guildId);
  const balance = await getShards(interaction.user.id);
  const total = PRICE[item] * qty;

  if (balance < total) {
    return interaction.editReply({
      content:
        `That costs 💠 ${total} — you have 💠 ${balance}, ` +
        `**${total - balance} short**.\nSell cards with \`/sell\` or \`/sellall\` to raise shards.`,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle("Confirm purchase")
    .setColor(0x5865f2)
    .setDescription(
      `**${qty} extra ${LABEL[item]}${qty === 1 ? "" : "s"}** for 💠 ${total}\n` +
        `(💠 ${PRICE[item]} each)`,
    )
    .addFields(
      { name: "Balance now", value: `💠 ${balance}`, inline: true },
      { name: "After", value: `💠 ${balance - total}`, inline: true },
      {
        name: "Banked",
        value: `${state.bonusRolls} roll(s) · ${state.bonusClaims} claim(s)`,
        inline: true,
      },
    )
    .setFooter({
      text:
        `Banked ${LABEL[item]}s are spent only after your hourly ` +
        `${item === "roll" ? settings.rollsPerHour + " rolls" : settings.claimsPerHour + " claims"} ` +
        "run out. They never expire.",
    });

  return interaction.editReply({
    embeds: [embed],
    components: [buyConfirmRow(item, qty, total)],
  });
}
