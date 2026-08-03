import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import {
  rollRarity,
  isHighTier,
  RARITY_META,
  DUPLICATE_SHARDS,
  ROLL_COST_SHARDS,
  type Rarity,
} from "../lib/gacha.js";
import {
  ensureMember,
  consumeRoll,
  bumpPity,
  awardShards,
  spendShards,
  getShards,
} from "../lib/state.js";
import { availableRarities, randomCard } from "../lib/pool.js";
import { claimButton } from "../lib/claim.js";

export const data = new SlashCommandBuilder()
  .setName("roll")
  .setDescription("Drop a Marvel Rivals card. First to hit Claim keeps it.")
  .setDMPermission(false)
  .addBooleanOption((o) =>
    o
      .setName("shards")
      .setDescription(`Spend ${ROLL_COST_SHARDS} shards to roll past your hourly limit`)
      .setRequired(false),
  );

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

  const useShards = interaction.options.getBoolean("shards") ?? false;

  // Shards buy a roll past the hourly cap, but never past the cooldown — that
  // would let someone with a large balance spam the channel.
  const gate = await consumeRoll(
    userId,
    guildId,
    settings!.rollCooldownSec,
    useShards ? Number.MAX_SAFE_INTEGER : settings!.rollsPerHour,
  );

  if (!gate.ok) {
    const msg =
      gate.reason === "cooldown"
        ? `Slow down — you can roll again ${relative(gate.retryAt)}.`
        : `You're out of rolls. Refills ${relative(gate.retryAt)}, or use ` +
          `\`/roll shards:True\` to spend 💠 ${ROLL_COST_SHARDS}.`;
    return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
  }

  let shardBalance: number | null = null;
  if (useShards) {
    if (!(await spendShards(userId, ROLL_COST_SHARDS))) {
      const have = await getShards(userId);
      return interaction.reply({
        content:
          `You need 💠 ${ROLL_COST_SHARDS} to buy a roll — you have 💠 ${have}. ` +
          `Sell cards with \`/sell\` or \`/sellall\`.`,
        flags: MessageFlags.Ephemeral,
      });
    }
    shardBalance = await getShards(userId);
  }

  const pool = await availableRarities();
  if (pool.length === 0) {
    return interaction.reply({
      content: "No cards in the pool yet — an admin needs to run `npm run ingest`.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const card = await randomCard(rollRarity(state.pity, pool));
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
    .setFooter({
      text:
        `Rolled by ${interaction.user.username}` +
        (shardBalance !== null
          ? ` · paid 💠 ${ROLL_COST_SHARDS}, balance 💠 ${shardBalance}`
          : ""),
    });

  if (card.imageUrl) embed.setImage(card.imageUrl);

  if (existing) {
    // Already owned in this server. Showing it anyway is the point — scarcity
    // only feels real when you can see who beat you to it. Shards are the
    // consolation so a taken card isn't a wasted roll.
    const payout = DUPLICATE_SHARDS[card.rarity as Rarity];
    const balance = await awardShards(userId, payout);

    embed
      .addFields(
        { name: "Owner", value: `<@${existing.userId}>`, inline: true },
        { name: "Shards", value: `+${payout} (you have ${balance})`, inline: true },
      )
      .setColor(0x4b5563); // muted — this isn't a win
    return interaction.reply({ embeds: [embed] });
  }

  await interaction.reply({
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(claimButton(card.id))],
  });

  // Cosmetic only. The button is greyed out when the window passes, but the
  // handler in lib/claim.ts is what actually enforces expiry — if this process
  // dies first, a late click is still correctly rejected.
  const message = await interaction.fetchReply();
  setTimeout(() => {
    void (async () => {
      const fresh = await message.fetch().catch(() => null);
      if (!fresh || fresh.components.length === 0) return;
      const claimed = fresh.embeds[0]?.fields?.some((f) => f.name === "Claimed by");
      if (claimed) return;
      await message
        .edit({
          components: [
            new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder()
                .setCustomId("claim:settled")
                .setLabel("Expired")
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true),
            ),
          ],
        })
        .catch(() => {});
    })();
  }, settings!.claimWindowSec * 1000).unref?.();
}
