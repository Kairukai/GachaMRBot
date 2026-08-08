import { SlashCommandBuilder, EmbedBuilder, MessageFlags, } from "discord.js";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { RARITY_META, SELL_VALUE } from "../lib/gacha.js";
import { ownedCards } from "../lib/trade.js";
import { giveConfirmRow } from "../lib/give.js";
import { ensureMember } from "../lib/state.js";
export const data = new SlashCommandBuilder()
    .setName("give")
    .setDescription("Give one of your cards to someone, for nothing in return.")
    .setDMPermission(false)
    .addUserOption((o) => o.setName("user").setDescription("Who receives the card").setRequired(true))
    .addStringOption((o) => o
    .setName("card")
    .setDescription("The card to give away")
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
    // Deferred immediately: every path here queries Postgres, and a cold or
    // distant database can exceed Discord's 3-second interaction deadline.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const guildId = interaction.guildId;
    const recipient = interaction.options.getUser("user", true);
    const cardId = interaction.options.getString("card", true);
    if (recipient.id === interaction.user.id) {
        return interaction.editReply({
            content: "You already own it.",
        });
    }
    if (recipient.bot) {
        return interaction.editReply({
            content: "Bots don't collect cards.",
        });
    }
    if (cardId === "none") {
        return interaction.editReply({
            content: "Pick a card from the autocomplete list.",
        });
    }
    const [owned] = await db
        .select({
        name: schema.cards.name,
        rarity: schema.cards.rarity,
        rank: schema.claims.rank,
        image: schema.cards.imageUrl,
        hero: schema.heroes.name,
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
    await ensureMember(recipient.id, guildId);
    const rarity = owned.rarity;
    const meta = RARITY_META[rarity];
    const embed = new EmbedBuilder()
        .setTitle("⚠️ Confirm gift")
        .setColor(meta.color)
        .setDescription(`You are about to give this card to <@${recipient.id}>:\n\n` +
        `## ${meta.emoji} ${owned.hero} — ${owned.name}\n` +
        `**${meta.label}**${owned.rank > 1 ? ` · **Rank ${owned.rank}**` : ""} · worth 💠 ${SELL_VALUE[rarity]}`)
        .setFooter({
        text: "You get nothing back. This cannot be undone — only they can give it " +
            "back. Use /trade if you want something in return.",
    });
    if (owned.image)
        embed.setThumbnail(owned.image);
    return interaction.editReply({
        embeds: [embed],
        components: [giveConfirmRow(recipient.id, cardId, rarity !== "rare")],
    });
}
//# sourceMappingURL=give.js.map