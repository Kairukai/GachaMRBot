import {
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  MessageFlags,
  type ButtonInteraction,
} from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { RARITY_META, type Rarity } from "./gacha.js";

export const TRADE_PREFIX = "trade:";

/** Offers go stale rather than lingering forever. */
export const TRADE_TTL_MS = 5 * 60 * 1000;

export function tradeButtons(tradeId: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TRADE_PREFIX}accept:${tradeId}`)
      .setLabel("Accept")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${TRADE_PREFIX}decline:${tradeId}`)
      .setLabel("Decline")
      .setStyle(ButtonStyle.Danger),
  );
}

function settledRow(label: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${TRADE_PREFIX}settled`)
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );
}

export type SwapResult = "ok" | "ownership-changed" | "not-pending";

/**
 * Swaps ownership of two cards atomically.
 *
 * Both UPDATEs are scoped by current owner, so if either card changed hands
 * since the offer was made the statement matches zero rows and the whole
 * transaction rolls back. That's cheaper and less deadlock-prone than locking
 * cards for the life of an offer, and it means a card can appear in several
 * pending trades without any of them corrupting the others.
 */
export async function executeSwap(tradeId: number): Promise<SwapResult> {
  return db.transaction(async (tx) => {
    const [trade] = await tx
      .select()
      .from(schema.trades)
      .where(and(eq(schema.trades.id, tradeId), eq(schema.trades.status, "pending")))
      .for("update");

    if (!trade) return "not-pending";

    const give = await tx
      .update(schema.claims)
      .set({ userId: trade.receiverId })
      .where(
        and(
          eq(schema.claims.guildId, trade.guildId),
          eq(schema.claims.cardId, trade.offerCardId),
          eq(schema.claims.userId, trade.proposerId),
        ),
      )
      .returning({ id: schema.claims.id });

    const take = await tx
      .update(schema.claims)
      .set({ userId: trade.proposerId })
      .where(
        and(
          eq(schema.claims.guildId, trade.guildId),
          eq(schema.claims.cardId, trade.wantCardId),
          eq(schema.claims.userId, trade.receiverId),
        ),
      )
      .returning({ id: schema.claims.id });

    if (give.length !== 1 || take.length !== 1) {
      tx.rollback(); // throws; caller sees it as a failed swap
    }

    await tx
      .update(schema.trades)
      .set({ status: "accepted" })
      .where(eq(schema.trades.id, tradeId));

    return "ok";
  }).catch((): SwapResult => "ownership-changed");
}

/**
 * Human label for a card. Pass `guildId` to include its rank.
 *
 * Rank is per-guild because it lives on the claim, so it can only be resolved
 * with a guild in hand. Any surface where cards change owner MUST pass it: a
 * one-for-one swap that hides rank lets someone trade a rank-9 for a rank-1 of
 * the same rarity and see nothing wrong.
 */
export async function cardLabel(cardId: string, guildId?: string): Promise<string> {
  const [c] = await db
    .select({
      name: schema.cards.name,
      rarity: schema.cards.rarity,
      hero: schema.heroes.name,
    })
    .from(schema.cards)
    .innerJoin(schema.heroes, eq(schema.cards.heroId, schema.heroes.id))
    .where(eq(schema.cards.id, cardId));
  if (!c) return cardId;

  let rankSuffix = "";
  if (guildId) {
    const [claim] = await db
      .select({ rank: schema.claims.rank })
      .from(schema.claims)
      .where(and(eq(schema.claims.guildId, guildId), eq(schema.claims.cardId, cardId)));
    if (claim && claim.rank > 1) rankSuffix = ` · **R${claim.rank}**`;
  }

  return `${RARITY_META[c.rarity as Rarity].emoji} ${c.hero} — ${c.name}${rankSuffix}`;
}

export async function handleTradeButton(interaction: ButtonInteraction) {
  const rest = interaction.customId.slice(TRADE_PREFIX.length);
  const [action, rawId] = rest.split(":");
  const tradeId = Number(rawId);

  if (action === "settled" || !Number.isFinite(tradeId)) {
    return interaction.reply({
      content: "That trade is already settled.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const [trade] = await db
    .select()
    .from(schema.trades)
    .where(eq(schema.trades.id, tradeId));

  if (!trade || trade.status !== "pending") {
    await interaction.update({ components: [settledRow("Closed")] }).catch(() => {});
    return;
  }

  // Only the person being asked can answer; the proposer may withdraw.
  const isReceiver = interaction.user.id === trade.receiverId;
  const isProposer = interaction.user.id === trade.proposerId;
  if (!isReceiver && !isProposer) {
    return interaction.reply({
      content: "This trade isn't yours to answer.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (Date.now() - trade.createdAt.getTime() > TRADE_TTL_MS) {
    await db
      .update(schema.trades)
      .set({ status: "cancelled" })
      .where(eq(schema.trades.id, tradeId));
    await interaction.update({ components: [settledRow("Expired")] }).catch(() => {});
    return;
  }

  if (action === "decline" || (isProposer && action === "accept")) {
    // A proposer pressing Accept is withdrawing, not self-approving.
    await db
      .update(schema.trades)
      .set({ status: isProposer ? "cancelled" : "declined" })
      .where(eq(schema.trades.id, tradeId));
    await interaction.update({
      components: [settledRow(isProposer ? "Withdrawn" : "Declined")],
    });
    return;
  }

  const result = await executeSwap(tradeId);

  if (result !== "ok") {
    await db
      .update(schema.trades)
      .set({ status: "cancelled" })
      .where(and(eq(schema.trades.id, tradeId), eq(schema.trades.status, "pending")));
    await interaction.update({ components: [settledRow("No longer valid")] }).catch(() => {});
    await interaction.followUp({
      content:
        "That trade couldn't complete — one of the cards changed hands since the offer was made.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("Trade complete")
    .setColor(0x22c55e)
    .setDescription(
      `<@${trade.proposerId}> ⇄ <@${trade.receiverId}>\n\n` +
        `<@${trade.receiverId}> received **${await cardLabel(trade.offerCardId, trade.guildId)}**\n` +
        `<@${trade.proposerId}> received **${await cardLabel(trade.wantCardId, trade.guildId)}**`,
    );

  await interaction.update({ embeds: [embed], components: [settledRow("Traded")] });
}

/** Cards a user currently owns in a guild, for autocomplete. */
export async function ownedCards(guildId: string, userId: string, query: string) {
  const rows = await db
    .select({
      id: schema.cards.id,
      name: schema.cards.name,
      rarity: schema.cards.rarity,
      hero: schema.heroes.name,
      rank: schema.claims.rank,
    })
    .from(schema.claims)
    .innerJoin(schema.cards, eq(schema.claims.cardId, schema.cards.id))
    .innerJoin(schema.heroes, eq(schema.cards.heroId, schema.heroes.id))
    .where(
      and(
        eq(schema.claims.guildId, guildId),
        eq(schema.claims.userId, userId),
        query
          ? sql`(${schema.heroes.name} || ' ' || ${schema.cards.name}) ILIKE ${"%" + query + "%"}`
          : sql`true`,
      ),
    )
    .limit(25);

  return rows.map((r) => ({
    // Discord caps choice names at 100 characters.
    // Rank goes in the autocomplete label as well: it is the last thing a user
    // sees before picking a card to trade, give or sell.
    name: `${RARITY_META[r.rarity as Rarity].label}${r.rank > 1 ? ` R${r.rank}` : ""} · ${r.hero} — ${r.name}`.slice(
      0,
      100,
    ),
    value: r.id,
  }));
}
