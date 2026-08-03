import {
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  type ButtonInteraction,
} from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { ROLL_PRICE_SHARDS, CLAIM_PRICE_SHARDS } from "./gacha.js";
import { ensureMember } from "./state.js";

export const BUY_PREFIX = "buy:";

export type Item = "roll" | "claim";

export const PRICE: Record<Item, number> = {
  roll: ROLL_PRICE_SHARDS,
  claim: CLAIM_PRICE_SHARDS,
};

export const LABEL: Record<Item, string> = { roll: "roll", claim: "claim" };

export function buyConfirmRow(item: Item, qty: number, total: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${BUY_PREFIX}${item}:${qty}`)
      .setLabel(`Buy for 💠 ${total}`)
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${BUY_PREFIX}cancel`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}

export type BuyResult =
  | { ok: true; spent: number; balance: number; rolls: number; claims: number }
  | { ok: false; balance: number };

/**
 * Debits shards and credits the purchase in one transaction. The shard debit is
 * conditional on the balance covering it, so two concurrent buys can't both
 * succeed against the same shards.
 */
export async function purchase(
  guildId: string,
  userId: string,
  item: Item,
  qty: number,
): Promise<BuyResult> {
  await ensureMember(userId, guildId);
  const total = PRICE[item] * qty;

  return db.transaction(async (tx) => {
    const debited = await tx.execute(sql`
      UPDATE users SET shards = shards - ${total}::int
      WHERE id = ${userId} AND shards >= ${total}::int
      RETURNING shards
    `);

    if (debited.length === 0) {
      const [u] = await tx
        .select({ shards: schema.users.shards })
        .from(schema.users)
        .where(eq(schema.users.id, userId));
      return { ok: false, balance: u?.shards ?? 0 };
    }

    const [row] = await tx
      .update(schema.memberState)
      .set(
        item === "roll"
          ? { bonusRolls: sql`${schema.memberState.bonusRolls} + ${qty}` }
          : { bonusClaims: sql`${schema.memberState.bonusClaims} + ${qty}` },
      )
      .where(
        and(
          eq(schema.memberState.userId, userId),
          eq(schema.memberState.guildId, guildId),
        ),
      )
      .returning({
        rolls: schema.memberState.bonusRolls,
        claims: schema.memberState.bonusClaims,
      });

    return {
      ok: true,
      spent: total,
      balance: Number((debited[0] as { shards: number }).shards),
      rolls: row?.rolls ?? 0,
      claims: row?.claims ?? 0,
    };
  });
}

export async function handleBuyButton(interaction: ButtonInteraction) {
  const token = interaction.customId.slice(BUY_PREFIX.length);
  const guildId = interaction.guildId;
  if (!guildId) return;

  if (token === "cancel") {
    return interaction.update({
      content: "Cancelled. No shards spent.",
      embeds: [],
      components: [],
    });
  }

  const [item, rawQty] = token.split(":") as [Item, string];
  const qty = Number(rawQty);
  if ((item !== "roll" && item !== "claim") || !Number.isFinite(qty) || qty < 1) return;

  const result = await purchase(guildId, interaction.user.id, item, qty);

  if (!result.ok) {
    return interaction.update({
      content:
        `Not enough shards — you have 💠 ${result.balance}, this costs ` +
        `💠 ${PRICE[item] * qty}. Sell cards with \`/sell\` or \`/sellall\`.`,
      embeds: [],
      components: [],
    });
  }

  const embed = new EmbedBuilder()
    .setTitle("Purchase complete")
    .setColor(0x22c55e)
    .setDescription(
      `Bought **${qty} ${LABEL[item]}${qty === 1 ? "" : "s"}** for 💠 ${result.spent}.\n` +
        `Balance: **💠 ${result.balance}**`,
    )
    .addFields(
      { name: "Banked rolls", value: `${result.rolls}`, inline: true },
      { name: "Banked claims", value: `${result.claims}`, inline: true },
    )
    .setFooter({
      text: "Banked credits are used only after your hourly allowance runs out, and never expire.",
    });

  return interaction.update({ content: "", embeds: [embed], components: [] });
}
