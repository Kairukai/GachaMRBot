import {
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  MessageFlags,
  type ButtonInteraction,
} from "discord.js";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { RARITY_META, type Rarity } from "./gacha.js";
import { ensureMember } from "./state.js";

export const GIVE_PREFIX = "give:";

export function giveConfirmRow(recipientId: string, cardId: string, danger: boolean) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      // cardId contains a colon (heroSlug:costumeId), so the recipient id goes
      // first and everything after the next colon is the card.
      .setCustomId(`${GIVE_PREFIX}${recipientId}:${cardId}`)
      .setLabel("Give it away")
      .setStyle(danger ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${GIVE_PREFIX}cancel`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}

export type GiveResult = "ok" | "not-owned";

/**
 * Hands a card to another member. The UPDATE is scoped to the current owner, so
 * a card traded or sold between the prompt and the click moves nothing rather
 * than transferring something the giver no longer has — same guarantee as
 * executeSwap and sellOne.
 */
export async function executeGive(
  guildId: string,
  fromId: string,
  toId: string,
  cardId: string,
): Promise<GiveResult> {
  await ensureMember(toId, guildId);

  const moved = await db
    .update(schema.claims)
    .set({ userId: toId, claimedAt: new Date() })
    .where(
      and(
        eq(schema.claims.guildId, guildId),
        eq(schema.claims.cardId, cardId),
        eq(schema.claims.userId, fromId),
      ),
    )
    .returning({ id: schema.claims.id });

  return moved.length === 1 ? "ok" : "not-owned";
}

export async function handleGiveButton(interaction: ButtonInteraction) {
  const token = interaction.customId.slice(GIVE_PREFIX.length);
  const guildId = interaction.guildId;
  if (!guildId) return;

  if (token === "cancel") {
    return interaction.update({
      content: "Cancelled. You kept the card.",
      embeds: [],
      components: [],
    });
  }

  const split = token.indexOf(":");
  const recipientId = token.slice(0, split);
  const cardId = token.slice(split + 1);
  if (!recipientId || !cardId) return;

  const result = await executeGive(guildId, interaction.user.id, recipientId, cardId);

  if (result !== "ok") {
    return interaction.update({
      content:
        "Nothing was given — you no longer own that card. It may have been traded or sold since the prompt appeared.",
      embeds: [],
      components: [],
    });
  }

  const [card] = await db
    .select({
      name: schema.cards.name,
      rarity: schema.cards.rarity,
      image: schema.cards.imageUrl,
      hero: schema.heroes.name,
    })
    .from(schema.cards)
    .innerJoin(schema.heroes, eq(schema.cards.heroId, schema.heroes.id))
    .where(eq(schema.cards.id, cardId));

  const meta = RARITY_META[(card?.rarity ?? "rare") as Rarity];

  await interaction.update({
    content: "Card given.",
    embeds: [],
    components: [],
  });

  // Announced publicly — a gift nobody sees is half a gift, and it keeps
  // ownership changes visible to the server.
  const embed = new EmbedBuilder()
    .setTitle("🎁 Card given")
    .setColor(meta.color)
    .setDescription(
      `<@${interaction.user.id}> gave **${meta.emoji} ${card?.hero} — ${card?.name}** ` +
        `to <@${recipientId}>`,
    );
  if (card?.image) embed.setThumbnail(card.image);

  await interaction.followUp({ content: `<@${recipientId}>`, embeds: [embed] }).catch(() => {});
}
