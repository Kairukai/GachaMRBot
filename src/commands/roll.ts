import {
  SlashCommandBuilder,
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ComponentType,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import {
  rollRarity,
  isHighTier,
  RARITY_META,
  DUPLICATE_SHARDS,
  type Rarity,
} from "../lib/gacha.js";
import { ensureMember, consumeRoll, consumeClaim, bumpPity } from "../lib/state.js";
import { availableRarities } from "../lib/pool.js";

export const data = new SlashCommandBuilder()
  .setName("roll")
  .setDescription("Drop a Marvel Rivals card. First to hit Claim keeps it.")
  .setDMPermission(false);

function relative(d: Date) {
  return `<t:${Math.floor(d.getTime() / 1000)}:R>`;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  const state = await ensureMember(userId, guildId);
  const [settings] = await db
    .select()
    .from(schema.guildSettings)
    .where(eq(schema.guildSettings.id, guildId));

  if (settings!.rollChannelId && settings!.rollChannelId !== interaction.channelId) {
    return interaction.reply({
      content: `Rolls are restricted to <#${settings!.rollChannelId}>.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const gate = await consumeRoll(
    userId,
    guildId,
    settings!.rollCooldownSec,
    settings!.rollsPerHour,
  );
  if (!gate.ok) {
    const msg =
      gate.reason === "cooldown"
        ? `Slow down — you can roll again ${relative(gate.retryAt)}.`
        : `You're out of rolls. Refills ${relative(gate.retryAt)}.`;
    return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
  }

  const pool = await availableRarities();
  if (pool.length === 0) {
    return interaction.reply({
      content: "No cards in the pool yet — an admin needs to run `npm run ingest`.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const picked = rollRarity(state.pity, pool);
  const [card] = await db
    .select({
      id: schema.cards.id,
      name: schema.cards.name,
      rarity: schema.cards.rarity,
      imageUrl: schema.cards.imageUrl,
      heroName: schema.heroes.name,
      heroRole: schema.heroes.role,
    })
    .from(schema.cards)
    .innerJoin(schema.heroes, eq(schema.cards.heroId, schema.heroes.id))
    .where(and(eq(schema.cards.rarity, picked), eq(schema.cards.rollable, true)))
    .orderBy(sql`random()`)
    .limit(1);

  if (!card) {
    return interaction.reply({
      content: "No cards in the pool yet — an admin needs to run `npm run ingest`.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await bumpPity(userId, guildId, isHighTier(card.rarity as Rarity));

  const [existing] = await db
    .select({ userId: schema.claims.userId })
    .from(schema.claims)
    .where(and(eq(schema.claims.guildId, guildId), eq(schema.claims.cardId, card.id)));

  const meta = RARITY_META[card.rarity as Rarity];
  const embed = new EmbedBuilder()
    .setTitle(`${meta.emoji} ${card.heroName} — ${card.name}`)
    .setColor(meta.color)
    .addFields(
      { name: "Rarity", value: meta.label, inline: true },
      { name: "Role", value: card.heroRole ?? "—", inline: true },
    )
    .setFooter({ text: `Rolled by ${interaction.user.username}` });

  if (card.imageUrl) embed.setImage(card.imageUrl);

  if (existing) {
    // Already owned in this server. Showing it anyway is the point — scarcity
    // only feels real when you can see who beat you to it.
    embed.addFields({ name: "Owner", value: `<@${existing.userId}>`, inline: true });
    return interaction.reply({ embeds: [embed] });
  }

  const claimId = `claim:${card.id}:${interaction.id}`;
  const button = new ButtonBuilder()
    .setCustomId(claimId)
    .setLabel("Claim")
    .setEmoji("💠")
    .setStyle(ButtonStyle.Success);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

  await interaction.reply({ embeds: [embed], components: [row] });
  const message = await interaction.fetchReply();

  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: settings!.claimWindowSec * 1000,
    // Anyone in the channel can race for it — that's the whole mechanic.
    filter: (i) => i.customId === claimId,
  });

  let claimed = false;

  collector.on("collect", async (i) => {
    const quota = await consumeClaim(i.user.id, guildId, settings!.claimsPerHour);
    if (!quota.ok) {
      return i.reply({
        content: `You've used your claims. Next one ${relative(quota.retryAt)}.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    try {
      await db.insert(schema.claims).values({ guildId, userId: i.user.id, cardId: card.id });
    } catch {
      // Unique index on (guild_id, card_id) settles simultaneous clicks in the
      // database rather than in JS, so there is no window where two people win.
      return i.reply({
        content: "Too slow — someone claimed it first.",
        flags: MessageFlags.Ephemeral,
      });
    }

    claimed = true;
    collector.stop("claimed");

    embed.addFields({ name: "Claimed by", value: `<@${i.user.id}>`, inline: true });
    await i.update({
      embeds: [embed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          button.setDisabled(true).setLabel("Claimed").setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
  });

  collector.on("end", async () => {
    if (claimed) return;
    await message
      .edit({
        components: [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            button.setDisabled(true).setLabel("Expired").setStyle(ButtonStyle.Secondary),
          ),
        ],
      })
      .catch(() => {}); // message may have been deleted
  });
}

export { DUPLICATE_SHARDS };
