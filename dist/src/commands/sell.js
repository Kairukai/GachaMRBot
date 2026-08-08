import { SlashCommandBuilder, EmbedBuilder, MessageFlags, } from "discord.js";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { RARITY_META, SELL_VALUE, ROLL_PRICE_SHARDS } from "../lib/gacha.js";
import { getShards } from "../lib/state.js";
import { ownedCards } from "../lib/trade.js";
import { confirmRow } from "../lib/sell.js";
import { rankBadge } from "../lib/badges.js";
export const data = new SlashCommandBuilder()
    .setName("sell")
    .setDescription("Sell one of your cards for shards.")
    .setDMPermission(false)
    .addStringOption((o) => o
    .setName("card")
    .setDescription("The card to sell")
    .setRequired(true)
    .setAutocomplete(true));
export async function autocomplete(interaction) {
    const guildId = interaction.guildId;
    if (!guildId)
        return interaction.respond([]);
    const focused = interaction.options.getFocused();
    const choices = await ownedCards(guildId, interaction.user.id, focused);
    return interaction.respond(choices.length ? choices : [{ name: "You own no matching cards", value: "none" }]);
}
export async function execute(interaction) {
    // Deferred immediately: every path here queries Postgres, and a cold or
    // distant database can exceed Discord's 3-second interaction deadline.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId;
    const cardId = interaction.options.getString("card", true);
    if (cardId === "none") {
        return interaction.editReply({
            content: "Pick a card from the autocomplete list.",
        });
    }
    const [owned] = await db
        .select({
        name: schema.cards.name,
        rarity: schema.cards.rarity,
        hero: schema.heroes.name,
        image: schema.cards.imageUrl,
        rank: schema.claims.rank,
    })
        .from(schema.claims)
        .innerJoin(schema.cards, eq(schema.claims.cardId, schema.cards.id))
        .innerJoin(schema.heroes, eq(schema.cards.heroId, schema.heroes.id))
        .where(and(eq(schema.claims.guildId, guildId), eq(schema.claims.userId, interaction.user.id), eq(schema.claims.cardId, cardId)));
    if (!owned) {
        return interaction.editReply({
            content: "You don't own that card in this server.",
        });
    }
    const rarity = owned.rarity;
    const meta = RARITY_META[rarity];
    const payout = SELL_VALUE[rarity];
    const balance = await getShards(interaction.user.id);
    const embed = new EmbedBuilder()
        .setTitle("⚠️ Confirm sale")
        .setColor(meta.color)
        .setDescription(`You are about to sell:\n\n` +
        `## ${meta.emoji} ${owned.hero} — ${owned.name}\n` +
        `**${meta.label}**${owned.rank > 1 ? ` · ${rankBadge(owned.rank)} **Rank ${owned.rank}**` : ""} · worth **💠 ${payout}** shards`)
        .addFields({ name: "Balance after", value: `💠 ${balance + payout}`, inline: true }, {
        name: "That buys",
        value: `${Math.floor((balance + payout) / ROLL_PRICE_SHARDS)} roll(s)`,
        inline: true,
    })
        .setFooter({
        text: "This cannot be undone. The card returns to the pool for anyone to claim.",
    });
    /**
     * Rank pays nothing on a sale — sell value is rarity-only — so selling a
     * ranked card destroys every burn that went into it for the same shards an
     * unranked copy would fetch. Say so plainly rather than letting the number
     * look normal.
     */
    if (owned.rank > 1) {
        embed.addFields({
            name: `🛑 This card is Rank ${owned.rank}`,
            value: "Rank is worth nothing on a sale and cannot be recovered. The card " +
                "returns to the pool at Rank 1.",
        });
    }
    if (owned.image)
        embed.setThumbnail(owned.image);
    return interaction.editReply({
        embeds: [embed],
        components: [
            confirmRow(`one:${cardId}`, `Sell for 💠 ${payout}`, rarity === "legendary" || owned.rank > 1),
        ],
    });
}
//# sourceMappingURL=sell.js.map