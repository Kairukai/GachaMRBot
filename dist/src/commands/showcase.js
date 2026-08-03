import { SlashCommandBuilder, EmbedBuilder, MessageFlags, } from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { RARITY_META, SELL_VALUE } from "../lib/gacha.js";
import { ownedCards } from "../lib/trade.js";
export const data = new SlashCommandBuilder()
    .setName("showcase")
    .setDescription("Show off a card from your collection.")
    .setDMPermission(false)
    .addStringOption((o) => o
    .setName("card")
    .setDescription("Which card to show")
    .setRequired(true)
    .setAutocomplete(true));
export async function autocomplete(interaction) {
    const guildId = interaction.guildId;
    if (!guildId)
        return interaction.respond([]);
    const choices = await ownedCards(guildId, interaction.user.id, interaction.options.getFocused());
    return interaction.respond(choices.length ? choices : [{ name: "You own no matching cards", value: "none" }]);
}
export async function execute(interaction) {
    const guildId = interaction.guildId;
    const cardId = interaction.options.getString("card", true);
    if (cardId === "none") {
        return interaction.reply({
            content: "Pick a card from the autocomplete list.",
            flags: MessageFlags.Ephemeral,
        });
    }
    // Public on purpose, so defer publicly. Autocomplete only offers cards you
    // own, which makes the not-owned path a rare edge case.
    await interaction.deferReply();
    const [card] = await db
        .select({
        name: schema.cards.name,
        rarity: schema.cards.rarity,
        image: schema.cards.imageUrl,
        hero: schema.heroes.name,
        role: schema.heroes.role,
        claimedAt: schema.claims.claimedAt,
    })
        .from(schema.claims)
        .innerJoin(schema.cards, eq(schema.claims.cardId, schema.cards.id))
        .innerJoin(schema.heroes, eq(schema.cards.heroId, schema.heroes.id))
        .where(and(eq(schema.claims.guildId, guildId), eq(schema.claims.userId, interaction.user.id), eq(schema.claims.cardId, cardId)));
    if (!card) {
        return interaction.editReply({
            content: "You don't own that card in this server.",
        });
    }
    const rarity = card.rarity;
    const meta = RARITY_META[rarity];
    // How many others in this server hold a card of the same rarity — cheap way
    // to give the showcase some bragging context.
    const [{ owners = 0 } = {}] = await db
        .select({ owners: sql `COUNT(*)` })
        .from(schema.claims)
        .innerJoin(schema.cards, eq(schema.claims.cardId, schema.cards.id))
        .where(and(eq(schema.claims.guildId, guildId), eq(schema.cards.rarity, rarity)));
    const embed = new EmbedBuilder()
        .setTitle(`${meta.emoji} ${card.hero} — ${card.name}`)
        .setColor(meta.color)
        .setDescription(`Owned by <@${interaction.user.id}>`)
        .addFields({ name: "Rarity", value: meta.label, inline: true }, { name: "Role", value: card.role ?? "—", inline: true }, { name: "Value", value: `💠 ${SELL_VALUE[rarity]}`, inline: true }, {
        name: "Claimed",
        value: `<t:${Math.floor(card.claimedAt.getTime() / 1000)}:R>`,
        inline: true,
    }, {
        name: `${meta.label}s in this server`,
        value: `${Number(owners)}`,
        inline: true,
    });
    if (card.image)
        embed.setImage(card.image);
    return interaction.editReply({ embeds: [embed] });
}
//# sourceMappingURL=showcase.js.map