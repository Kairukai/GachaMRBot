import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { RARITY_META, SELL_VALUE, ROLL_PRICE_SHARDS, type Rarity } from "../lib/gacha.js";
import { getShards } from "../lib/state.js";
import { confirmRow, ownedAtRarity, type SellRarity } from "../lib/sell.js";

export const data = new SlashCommandBuilder()
  .setName("sellall")
  .setDescription("Sell every card you own of one rarity.")
  .setDMPermission(false)
  .addStringOption((o) =>
    o
      .setName("rarity")
      .setDescription("Which rarity to sell")
      .setRequired(true)
      .addChoices(
        { name: "Rare", value: "rare" },
        { name: "Epic", value: "epic" },
        { name: "Legendary", value: "legendary" },
      ),
  );

export async function execute(interaction: ChatInputCommandInteraction) {
  // Deferred immediately: every path here queries Postgres, and a cold or
  // distant database can exceed Discord's 3-second interaction deadline.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId!;
  const rarity = interaction.options.getString("rarity", true) as SellRarity;
  const meta = RARITY_META[rarity as Rarity];

  const all = await ownedAtRarity(guildId, interaction.user.id, rarity);
  // Ranked cards are never included. Rank pays nothing on a sale — sell value
  // is rarity-only — so bulk-selling one destroys weeks of claim quota for
  // pocket change. `/sell` can still do it deliberately, one card at a time.
  const cards = all.filter((c) => c.rank === 1);
  const protectedCards = all.filter((c) => c.rank > 1);

  if (cards.length === 0) {
    return interaction.editReply({
      content: protectedCards.length
        ? `Your only ${meta.label} card(s) are ranked up, so /sellall skips them. ` +
          `Use /sell if you really mean to sell one.`
        : `You don't own any ${meta.label} cards in this server.`,
    });
  }

  const each = SELL_VALUE[rarity as Rarity];
  const total = cards.length * each;
  const balance = await getShards(interaction.user.id);

  // Name every card when the list is short enough; people should be able to see
  // exactly what they're about to destroy, not just a count.
  const listed = cards.slice(0, 20).map((c) => `• ${c.hero} — ${c.name}`).join("\n");
  const overflow = cards.length > 20 ? `\n…and ${cards.length - 20} more` : "";

  const embed = new EmbedBuilder()
    .setTitle(`⚠️ Confirm bulk sale — ${cards.length} ${meta.label} card(s)`)
    .setColor(meta.color)
    .setDescription(
      `You are about to sell **every ${meta.label} card you own** in this server.\n\n` +
        `${listed}${overflow}`,
    )
    .addFields(
      { name: "Cards", value: `${cards.length}`, inline: true },
      { name: "Payout", value: `💠 ${total} (${each} each)`, inline: true },
      {
        name: "That buys",
        value: `${Math.floor((balance + total) / ROLL_PRICE_SHARDS)} roll(s)`,
        inline: true,
      },
    )
    .setFooter({
      text: "This cannot be undone. Every card listed returns to the pool for anyone to claim.",
    });

  if (protectedCards.length) {
    embed.addFields({
      name: `🔒 Skipped ${protectedCards.length} ranked card(s)`,
      value: [
        ...protectedCards.slice(0, 8).map((c) => `• ${c.hero} — ${c.name} (R${c.rank})`),
        ...(protectedCards.length > 8 ? [`…and ${protectedCards.length - 8} more`] : []),
        "Ranked cards are never bulk-sold. Use /sell for those.",
      ].join("\n"),
    });
  }

  if (rarity === "legendary") {
    embed.addFields({
      name: "🛑 Read this",
      value:
        "Legendaries average about 60 rolls each to obtain. Selling them is a " +
        "heavy loss — one is worth only 6 bought rolls.",
    });
  }

  return interaction.editReply({
    embeds: [embed],
    components: [
      confirmRow(
        `all:${rarity}`,
        `Sell ${cards.length} for 💠 ${total}`,
        rarity !== "rare",
      ),
    ],
  });
}
