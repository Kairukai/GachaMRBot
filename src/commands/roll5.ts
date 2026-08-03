import {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import {
  rollRarity,
  RARITY_META,
  DUPLICATE_SHARDS,
  type Rarity,
} from "../lib/gacha.js";
import {
  ensureMember,
  consumeRoll,
  awardShards,
} from "../lib/state.js";
import { availableRarities, randomCard } from "../lib/pool.js";
import { claimButton, editV2Components } from "../lib/claim.js";

const BATCH = 5;

export const data = new SlashCommandBuilder()
  .setName("roll5")
  .setDescription(`Roll ${BATCH} cards at once.`)
  .setDMPermission(false)
  .setDMPermission(false);

function relative(d: Date) {
  return `<t:${Math.floor(d.getTime() / 1000)}:R>`;
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  await ensureMember(userId, guildId);
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
    BATCH,
  );

  if (!gate.ok) {
    const msg =
      gate.reason === "cooldown"
        ? `Slow down — you can roll again ${relative(gate.retryAt)}.`
        : `You need ${BATCH} rolls available. Refills ${relative(gate.retryAt)}, ` +
          "or buy more with `/buy`.";
    return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
  }


  const pool = await availableRarities();
  if (pool.length === 0) {
    return interaction.reply({
      content: "No cards in the pool yet — an admin needs to run `npm run ingest`.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const cards: NonNullable<Awaited<ReturnType<typeof randomCard>>>[] = [];
  for (let i = 0; i < BATCH; i++) {
    const card = await randomCard(rollRarity(pool));
    if (card) cards.push(card);
  }

  if (cards.length === 0) {
    return interaction.reply({
      content: "No cards in the pool yet — an admin needs to run `npm run ingest`.",
      flags: MessageFlags.Ephemeral,
    });
  }

  // One query for every card in the batch rather than one per card.
  const ids = cards.map((c) => c.id);
  const claimed = await db
    .select({ cardId: schema.claims.cardId, userId: schema.claims.userId })
    .from(schema.claims)
    .where(and(eq(schema.claims.guildId, guildId), inArray(schema.claims.cardId, ids)));
  const owners = new Map(claimed.map((c) => [c.cardId, c.userId]));

  // The same card can legitimately appear twice in one batch; only the first
  // copy is claimable, the rest pay the duplicate consolation.
  const seen = new Set<string>();
  let shardsEarned = 0;

  // Components V2: each card is its own Container holding its art, text and —
  // crucially — its own Claim button. Classic embeds can't do this, because
  // buttons may only appear in rows after every embed.
  const containers: ContainerBuilder[] = [];
  let claimable = 0;

  for (const card of cards) {
    const rarity = card.rarity as Rarity;
    const meta = RARITY_META[rarity];
    const owner = owners.get(card.id);
    const dupeInBatch = seen.has(card.id);
    seen.add(card.id);
    const taken = Boolean(owner) || dupeInBatch;

    const lines = [
      `### ${meta.emoji} ${card.heroName} — ${card.name}`,
      `**${meta.label}** · ${card.heroRole ?? "—"}`,
    ];
    if (owner) lines.push(`Owned by <@${owner}>`);
    else if (dupeInBatch) lines.push("_Duplicate — already shown above_");

    const section = new SectionBuilder().addTextDisplayComponents(
      new TextDisplayBuilder().setContent(lines.join("\n")),
    );
    // A Section takes exactly one accessory, so art and button can't share one;
    // the button goes in its own row directly beneath.
    if (card.imageUrl) {
      section.setThumbnailAccessory(new ThumbnailBuilder().setURL(card.imageUrl));
    } else {
      section.setButtonAccessory(
        new ButtonBuilder()
          .setCustomId("claim:settled")
          .setLabel("No art")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true),
      );
    }

    const container = new ContainerBuilder()
      .setAccentColor(taken ? 0x4b5563 : meta.color)
      .addSectionComponents(section);

    if (taken) {
      shardsEarned += DUPLICATE_SHARDS[rarity];
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`💠 +${DUPLICATE_SHARDS[rarity]} shards`),
      );
    } else {
      claimable++;
      container.addActionRowComponents(
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          claimButton(card.id).setLabel(`Claim ${meta.label}`),
        ),
      );
    }

    containers.push(container);
  }

  let balance: number | null = null;
  if (shardsEarned > 0) balance = await awardShards(userId, shardsEarned);

  const footer = [
    `Rolled by ${interaction.user.username}`,
    shardsEarned > 0 ? `+💠 ${shardsEarned} from duplicates` : null,
    balance !== null ? `balance 💠 ${balance}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  await interaction.reply({
    // V2 messages carry no content or embeds — everything is components.
    flags: MessageFlags.IsComponentsV2,
    components: [
      ...containers,
      new TextDisplayBuilder().setContent(`-# ${footer}`),
    ],
  });

  if (claimable === 0) return;

  // Cosmetic only — lib/claim.ts enforces the window from the message timestamp,
  // so a late click is still rejected even if this process dies first.
  const message = await interaction.fetchReply();
  setTimeout(() => {
    void (async () => {
      const fresh = await message.fetch().catch(() => null);
      if (!fresh) return;
      const edited = editV2Components(
        fresh.components.map((c) => c.toJSON()) as never[],
        { disableAll: true, label: "Expired" },
      );
      if (edited) await message.edit({ components: edited }).catch(() => {});
    })();
  }, settings!.claimWindowSec * 1000).unref?.();
}
