import {
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  MessageFlags,
  type ButtonInteraction,
} from "discord.js";
import { db, schema } from "../db/index.js";
import { and, eq } from "drizzle-orm";
import { ensureGuild, ensureMember, consumeClaim, refundClaim } from "./state.js";

export const CLAIM_PREFIX = "claim:";

/** Card ids contain a colon (`heroSlug:costumeId`), so only split on the first. */
export function cardIdFromCustomId(customId: string): string {
  return customId.slice(CLAIM_PREFIX.length);
}

export function claimButton(cardId: string) {
  return new ButtonBuilder()
    .setCustomId(`${CLAIM_PREFIX}${cardId}`)
    .setLabel("Claim")
    .setEmoji("💠")
    .setStyle(ButtonStyle.Success);
}

function settledRow(label: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId("claim:settled")
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );
}

function relative(d: Date) {
  return `<t:${Math.floor(d.getTime() / 1000)}:R>`;
}

/**
 * Authoritative claim handler, registered globally rather than on a per-message
 * collector.
 *
 * Collectors live in process memory: a restart mid-window used to leave a
 * button that looked live but had no listener, so clicking it failed and it was
 * never disabled. Expiry is therefore derived from the message's own timestamp,
 * which survives restarts and works across shards.
 */
export async function handleClaim(interaction: ButtonInteraction) {
  const cardId = cardIdFromCustomId(interaction.customId);
  if (!cardId || cardId === "settled") {
    return interaction.reply({
      content: "That drop is already settled.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const guildId = interaction.guildId;
  if (!guildId) return;

  const settings = await ensureGuild(guildId);
  const age = Date.now() - interaction.message.createdTimestamp;

  if (age > settings.claimWindowSec * 1000) {
    await interaction.update({ components: [settledRow("Expired")] }).catch(() => {});
    return;
  }

  const [existing] = await db
    .select({ userId: schema.claims.userId })
    .from(schema.claims)
    .where(and(eq(schema.claims.guildId, guildId), eq(schema.claims.cardId, cardId)));

  if (existing) {
    return interaction.reply({
      content: `Too slow — <@${existing.userId}> claimed it first.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  await ensureMember(interaction.user.id, guildId);
  const quota = await consumeClaim(interaction.user.id, guildId, settings.claimsPerHour);
  if (!quota.ok) {
    return interaction.reply({
      content: `You've used your claims. Next one ${relative(quota.retryAt)}.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  try {
    await db
      .insert(schema.claims)
      .values({ guildId, userId: interaction.user.id, cardId });
  } catch {
    // Unique index on (guild_id, card_id) settles simultaneous clicks in the
    // database. The loser gets their claim allowance back — losing a race
    // shouldn't cost the hour's claim.
    await refundClaim(interaction.user.id, guildId);
    return interaction.reply({
      content: "Too slow — someone claimed it first.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const base = interaction.message.embeds[0];
  const embed = base
    ? EmbedBuilder.from(base).addFields({
        name: "Claimed by",
        value: `<@${interaction.user.id}>`,
        inline: true,
      })
    : new EmbedBuilder().setDescription(`Claimed by <@${interaction.user.id}>`);

  await interaction.update({ embeds: [embed], components: [settledRow("Claimed")] });
}
