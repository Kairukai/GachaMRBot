import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from "discord.js";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { RARITY_META, SELL_VALUE, ROLL_COST_SHARDS, type Rarity } from "../lib/gacha.js";
import { getShards } from "../lib/state.js";
import { ownedCards } from "../lib/trade.js";
import { confirmRow } from "../lib/sell.js";

export const data = new SlashCommandBuilder()
  .setName("sell")
  .setDescription("Sell one of your cards for shards.")
  .setDMPermission(false)
  .addStringOption((o) =>
    o
      .setName("card")
      .setDescription("The card to sell")
      .setRequired(true)
      .setAutocomplete(true),
  );

export async function autocomplete(interaction: AutocompleteInteraction) {
  const guildId = interaction.guildId;
  if (!guildId) return interaction.respond([]);
  const focused = interaction.options.getFocused();
  const choices = await ownedCards(guildId, interaction.user.id, focused);
  return interaction.respond(
    choices.length ? choices : [{ name: "You own no matching cards", value: "none" }],
  );
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId!;
  const cardId = interaction.options.getString("card", true);

  if (cardId === "none") {
    return interaction.reply({
      content: "Pick a card from the autocomplete list.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const [owned] = await db
    .select({
      name: schema.cards.name,
      rarity: schema.cards.rarity,
      hero: schema.heroes.name,
      image: schema.cards.imageUrl,
    })
    .from(schema.claims)
    .innerJoin(schema.cards, eq(schema.claims.cardId, schema.cards.id))
    .innerJoin(schema.heroes, eq(schema.cards.heroId, schema.heroes.id))
    .where(
      and(
        eq(schema.claims.guildId, guildId),
        eq(schema.claims.userId, interaction.user.id),
        eq(schema.claims.cardId, cardId),
      ),
    );

  if (!owned) {
    return interaction.reply({
      content: "You don't own that card in this server.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const rarity = owned.rarity as Rarity;
  const meta = RARITY_META[rarity];
  const payout = SELL_VALUE[rarity];
  const balance = await getShards(interaction.user.id);

  const embed = new EmbedBuilder()
    .setTitle("⚠️ Confirm sale")
    .setColor(meta.color)
    .setDescription(
      `You are about to sell:\n\n` +
        `## ${meta.emoji} ${owned.hero} — ${owned.name}\n` +
        `**${meta.label}** · worth **💠 ${payout}** shards`,
    )
    .addFields(
      { name: "Balance after", value: `💠 ${balance + payout}`, inline: true },
      {
        name: "That buys",
        value: `${Math.floor((balance + payout) / ROLL_COST_SHARDS)} roll(s)`,
        inline: true,
      },
    )
    .setFooter({
      text: "This cannot be undone. The card returns to the pool for anyone to claim.",
    });

  if (owned.image) embed.setThumbnail(owned.image);

  return interaction.reply({
    embeds: [embed],
    components: [confirmRow(`one:${cardId}`, `Sell for 💠 ${payout}`, rarity === "legendary")],
    flags: MessageFlags.Ephemeral,
  });
}
