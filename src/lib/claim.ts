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

/** Fresh mutable copy of the message's component tree. */
function rawComponents(interaction: ButtonInteraction): any[] {
  return interaction.message.components.map((c) => c.toJSON()) as any[];
}

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

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Components V2 messages (used by /roll5) nest each card in its own Container
 * with its own button, so there are no embeds to rewrite and no flat button row
 * to rebuild. Editing the raw component JSON is version-proof — the nested
 * builder `.from()` helpers vary between discord.js releases.
 *
 * Returns null when nothing matched, so the caller can fall back.
 */
export function editV2Components(
  raw: any[],
  opts: { customId?: string; claimedBy?: string; disableAll?: boolean; label: string },
): any[] | null {
  let touched = false;

  const walk = (container: any) => {
    if (!Array.isArray(container?.components)) return;
    for (const child of container.components) {
      if (child?.type !== 1 || !Array.isArray(child.components)) continue;
      for (const btn of child.components) {
        if (btn?.type !== 2) continue;
        const match = opts.disableAll || btn.custom_id === opts.customId;
        if (!match || btn.disabled) continue;

        btn.disabled = true;
        btn.style = 2; // secondary — visually retired
        btn.label = opts.label;
        touched = true;

        if (opts.claimedBy) {
          container.components.push({
            type: 10,
            content: `**Claimed by <@${opts.claimedBy}>**`,
          });
          container.accent_color = 0x22c55e;
        }
      }
    }
  };

  for (const top of raw) walk(top);
  return touched ? raw : null;
}

/**
 * A classic embed drop carries one button per embed in matching order. Rebuilds
 * the row with only the clicked button retired so the others stay claimable,
 * and reports which slot was taken.
 */
function retireButton(interaction: ButtonInteraction, label: string) {
  const rows = interaction.message.components.map(
    (r) => ActionRowBuilder.from(r as never) as ActionRowBuilder<ButtonBuilder>,
  );

  let index = -1;
  for (const row of rows) {
    row.components.forEach((c, i) => {
      const btn = c as ButtonBuilder;
      if ((btn.data as { custom_id?: string }).custom_id === interaction.customId) {
        index = i;
        btn.setDisabled(true).setLabel(label).setStyle(ButtonStyle.Secondary);
      }
    });
  }

  return { rows, index: index === -1 ? 0 : index };
}

/** Disables every claim button on the message, for expiry. */
function retireAll(interaction: ButtonInteraction, label: string) {
  const rows = interaction.message.components.map(
    (r) => ActionRowBuilder.from(r as never) as ActionRowBuilder<ButtonBuilder>,
  );
  for (const row of rows) {
    for (const c of row.components) {
      (c as ButtonBuilder).setDisabled(true).setStyle(ButtonStyle.Secondary);
    }
  }
  if (rows.length === 0) return [settledRow(label)];
  return rows;
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

  const isV2 = interaction.message.flags.has(MessageFlags.IsComponentsV2);

  if (age > settings.claimWindowSec * 1000) {
    if (isV2) {
      const edited = editV2Components(rawComponents(interaction), {
        disableAll: true,
        label: "Expired",
      });
      if (edited) await interaction.update({ components: edited }).catch(() => {});
      return;
    }
    await interaction.update({ components: retireAll(interaction, "Expired") }).catch(() => {});
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

  if (isV2) {
    const edited = editV2Components(rawComponents(interaction), {
      customId: interaction.customId,
      claimedBy: interaction.user.id,
      label: "Claimed",
    });
    await interaction.update({ components: edited ?? rawComponents(interaction) });
    return;
  }

  const { rows, index } = retireButton(interaction, "Claimed");

  // Rebuild every embed, marking only the one matching the clicked button.
  const embeds = interaction.message.embeds.map((e, i) =>
    i === index
      ? EmbedBuilder.from(e).addFields({
          name: "Claimed by",
          value: `<@${interaction.user.id}>`,
          inline: true,
        })
      : EmbedBuilder.from(e),
  );

  await interaction.update({
    embeds: embeds.length ? embeds : [new EmbedBuilder().setDescription(`Claimed by <@${interaction.user.id}>`)],
    components: rows,
  });
}
