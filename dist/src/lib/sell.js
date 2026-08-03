import { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, } from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { RARITY_META, SELL_VALUE } from "./gacha.js";
export const SELL_PREFIX = "sell:";
export function confirmRow(token, label, danger = false) {
    return new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(`${SELL_PREFIX}${token}`)
        .setLabel(label)
        .setStyle(danger ? ButtonStyle.Danger : ButtonStyle.Success), new ButtonBuilder()
        .setCustomId(`${SELL_PREFIX}cancel`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary));
}
function settledRow(label) {
    return new ActionRowBuilder().addComponents(new ButtonBuilder()
        .setCustomId(`${SELL_PREFIX}settled`)
        .setLabel(label)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true));
}
/** Cards the user owns in this guild at a given rarity, for previews. */
export async function ownedAtRarity(guildId, userId, rarity) {
    return db
        .select({
        id: schema.cards.id,
        name: schema.cards.name,
        hero: schema.heroes.name,
    })
        .from(schema.claims)
        .innerJoin(schema.cards, eq(schema.claims.cardId, schema.cards.id))
        .innerJoin(schema.heroes, eq(schema.cards.heroId, schema.heroes.id))
        .where(and(eq(schema.claims.guildId, guildId), eq(schema.claims.userId, userId), eq(schema.cards.rarity, rarity)))
        .orderBy(schema.heroes.name);
}
/**
 * Sells one card. The DELETE is scoped to the current owner, so if the card was
 * traded away between the confirmation prompt and the click, it removes nothing
 * and pays nothing rather than crediting a card the user no longer has.
 */
export async function sellOne(guildId, userId, cardId) {
    return db.transaction(async (tx) => {
        const [card] = await tx
            .select({ rarity: schema.cards.rarity })
            .from(schema.cards)
            .where(eq(schema.cards.id, cardId));
        if (!card)
            return { sold: 0, shards: 0, balance: 0 };
        const removed = await tx
            .delete(schema.claims)
            .where(and(eq(schema.claims.guildId, guildId), eq(schema.claims.userId, userId), eq(schema.claims.cardId, cardId)))
            .returning({ id: schema.claims.id });
        if (removed.length === 0)
            return { sold: 0, shards: 0, balance: 0 };
        const payout = SELL_VALUE[card.rarity];
        const [row] = await tx
            .update(schema.users)
            .set({ shards: sql `${schema.users.shards} + ${payout}` })
            .where(eq(schema.users.id, userId))
            .returning({ shards: schema.users.shards });
        return { sold: 1, shards: payout, balance: row?.shards ?? 0 };
    });
}
/**
 * Bulk sell every card of one rarity. Payout is derived from the rows actually
 * deleted, not from a count taken when the prompt was built — otherwise a trade
 * completing in between would pay for cards the user no longer owns.
 */
export async function sellAll(guildId, userId, rarity) {
    return db.transaction(async (tx) => {
        const removed = await tx
            .delete(schema.claims)
            .where(and(eq(schema.claims.guildId, guildId), eq(schema.claims.userId, userId), sql `${schema.claims.cardId} IN (SELECT id FROM cards WHERE rarity = ${rarity})`))
            .returning({ id: schema.claims.id });
        if (removed.length === 0)
            return { sold: 0, shards: 0, balance: 0 };
        const payout = removed.length * SELL_VALUE[rarity];
        const [row] = await tx
            .update(schema.users)
            .set({ shards: sql `${schema.users.shards} + ${payout}` })
            .where(eq(schema.users.id, userId))
            .returning({ shards: schema.users.shards });
        return { sold: removed.length, shards: payout, balance: row?.shards ?? 0 };
    });
}
export async function handleSellButton(interaction) {
    const token = interaction.customId.slice(SELL_PREFIX.length);
    const guildId = interaction.guildId;
    if (!guildId)
        return;
    if (token === "cancel" || token === "settled") {
        await interaction.update({
            content: "Cancelled. Nothing was sold.",
            embeds: [],
            components: [],
        });
        return;
    }
    // Prompts are ephemeral, so only the person who ran the command can click.
    const [kind, value] = [token.slice(0, token.indexOf(":")), token.slice(token.indexOf(":") + 1)];
    let result;
    let what;
    if (kind === "one") {
        result = await sellOne(guildId, interaction.user.id, value);
        what = "card";
    }
    else if (kind === "all") {
        result = await sellAll(guildId, interaction.user.id, value);
        what = `${RARITY_META[value].label} cards`;
    }
    else {
        return;
    }
    if (result.sold === 0) {
        await interaction.update({
            content: "Nothing was sold — you no longer own that card. It may have been traded since the prompt appeared.",
            embeds: [],
            components: [settledRow("Nothing sold")],
        });
        return;
    }
    const embed = new EmbedBuilder()
        .setTitle("Sold")
        .setColor(0x22c55e)
        .setDescription(`Sold **${result.sold}** ${what} for **💠 ${result.shards}** shards.\n` +
        `Balance: **💠 ${result.balance}**`)
        .setFooter({
        text: result.sold === 1
            ? "The card is back in the pool — anyone can claim it now."
            : "Those cards are back in the pool for anyone to claim.",
    });
    await interaction.update({ content: "", embeds: [embed], components: [] });
}
//# sourceMappingURL=sell.js.map