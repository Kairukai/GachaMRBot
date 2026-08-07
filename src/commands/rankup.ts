import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from "discord.js";
import { RARITY_META, type Rarity } from "../lib/gacha.js";
import { getShards } from "../lib/state.js";
import { MAX_RANK } from "../lib/battle.js";
import {
  RANK_COST,
  FODDER_VALUE,
  planFodder,
  rankState,
  rankableOwned,
  rankUpConfirmRow,
} from "../lib/rankup.js";

export const data = new SlashCommandBuilder()
  .setName("rankup")
  .setDescription("Burn cards and shards to rank up an Epic or Legendary.")
  .setDMPermission(false)
  .addStringOption((o) =>
    o
      .setName("card")
      .setDescription("The card to rank up")
      .setRequired(true)
      .setAutocomplete(true),
  );

export async function autocomplete(interaction: AutocompleteInteraction) {
  const guildId = interaction.guildId;
  if (!guildId) return interaction.respond([]);
  const choices = await rankableOwned(
    guildId,
    interaction.user.id,
    interaction.options.getFocused(),
  );
  return interaction.respond(
    choices.length
      ? choices
      : [{ name: "You own no Epics or Legendaries below max rank", value: "none" }],
  );
}

export async function execute(interaction: ChatInputCommandInteraction) {
  // Fully ephemeral, so defer at the top — every branch below hits Postgres.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId!;
  const cardId = interaction.options.getString("card", true);

  if (cardId === "none") {
    return interaction.editReply({ content: "Pick a card from the autocomplete list." });
  }

  const state = await rankState(guildId, interaction.user.id, cardId);
  if (!state) {
    return interaction.editReply({ content: "You don't own that card in this server." });
  }

  const rarity = state.rarity as Rarity;
  const meta = RARITY_META[rarity];

  if (rarity !== "epic" && rarity !== "legendary") {
    return interaction.editReply({
      content: `${meta.label} cards can't be ranked up — only Epics and Legendaries can.`,
    });
  }
  if (state.rank >= MAX_RANK) {
    return interaction.editReply({
      content: `${state.hero} — ${state.name} is already Rank ${MAX_RANK}.`,
    });
  }

  const nextRank = state.rank + 1;
  const cost = RANK_COST[nextRank]!;
  const balance = await getShards(interaction.user.id);
  const plan = await planFodder(guildId, interaction.user.id, cardId, cost);

  if (!plan.ok) {
    const lines = [
      `**${state.hero} — ${state.name}** · Rank ${state.rank} → ${nextRank}`,
      "",
      `Fodder points: **${plan.havePoints}/${plan.needPoints}**`,
    ];
    if (plan.needLegendaries) {
      lines.push(`Legendary fodder: **${plan.haveLegendaries}/${plan.needLegendaries}**`);
    }
    lines.push(
      "",
      `Fodder values — Rare ${FODDER_VALUE.rare}, Epic ${FODDER_VALUE.epic}, ` +
        `Legendary ${FODDER_VALUE.legendary} points. Ranked cards can't be burned.`,
    );
    return interaction.editReply({ content: lines.join("\n") });
  }

  if (balance < cost.shards) {
    return interaction.editReply({
      content:
        `Rank ${nextRank} costs 💠 ${cost.shards} and you have 💠 ${balance}. ` +
        `Sell some spares or keep rolling.`,
    });
  }

  const counts = plan.cards.reduce<Record<string, number>>((acc, c) => {
    acc[c.rarity] = (acc[c.rarity] ?? 0) + 1;
    return acc;
  }, {});
  const summary = (["rare", "epic", "legendary"] as const)
    .filter((r) => counts[r])
    .map((r) => `${counts[r]}× ${RARITY_META[r].label}`)
    .join(" · ");

  const listed = plan.cards
    .slice(0, 15)
    .map((c) => `• ${RARITY_META[c.rarity].emoji} ${c.hero} — ${c.name}`)
    .join("\n");
  const overflow = plan.cards.length > 15 ? `\n…and ${plan.cards.length - 15} more` : "";

  const embed = new EmbedBuilder()
    .setTitle(`⚠️ Confirm rank-up — Rank ${state.rank} → ${nextRank}`)
    .setColor(meta.color)
    .setDescription(
      `## ${meta.emoji} ${state.hero} — ${state.name}\n` +
        `Burning **${plan.cards.length} card(s)** (${summary}) and **💠 ${cost.shards}**.\n\n` +
        `${listed}${overflow}`,
    )
    .addFields(
      { name: "Points", value: `${plan.points}/${cost.points}`, inline: true },
      { name: "Shards after", value: `💠 ${balance - cost.shards}`, inline: true },
      {
        name: "Ultimate charge",
        value: nextRank === MAX_RANK ? "fully upgraded" : `+${nextRank - 1}/9 of the bonus`,
        inline: true,
      },
    )
    .setFooter({
      text:
        "This cannot be undone. Burned cards return to the pool for anyone to claim. " +
        "The cheapest eligible cards are chosen and re-checked when you confirm.",
    });

  if (state.image) embed.setThumbnail(state.image);

  return interaction.editReply({
    embeds: [embed],
    components: [rankUpConfirmRow(cardId, `Burn ${plan.cards.length} for Rank ${nextRank}`)],
  });
}
