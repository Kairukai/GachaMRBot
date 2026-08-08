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
import { and, eq, desc, sql, count } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { RARITY_META, type Rarity } from "../lib/gacha.js";
import { getShards } from "../lib/state.js";
import { rankPrefix } from "../lib/badges.js";

const PAGE_SIZE = 10;

export const data = new SlashCommandBuilder()
  .setName("collection")
  .setDescription("Show the cards you've claimed in this server.")
  .addUserOption((o) =>
    o.setName("user").setDescription("Whose collection to view").setRequired(false),
  )
  .setDMPermission(false);

/** Rarity is a Postgres enum, so ordering is by declaration order — highest last. */
const RARITY_RANK = sql`array_position(
  ARRAY['default','rare','epic','legendary','mythic']::rarity[],
  ${schema.cards.rarity}
)`;

export async function execute(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId!;
  const target = interaction.options.getUser("user") ?? interaction.user;

  const [{ total } = { total: 0 }] = await db
    .select({ total: count() })
    .from(schema.claims)
    .where(and(eq(schema.claims.guildId, guildId), eq(schema.claims.userId, target.id)));

  if (total === 0) {
    return interaction.reply({
      content:
        target.id === interaction.user.id
          ? "You haven't claimed anything here yet. Try `/roll`."
          : `${target.username} hasn't claimed anything in this server.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // The empty case answers ephemerally above; everything below is public.
  await interaction.deferReply();

  const pages = Math.ceil(total / PAGE_SIZE);
  let page = 0;

  const render = async () => {
    const rows = await db
      .select({
        name: schema.cards.name,
        rarity: schema.cards.rarity,
        heroName: schema.heroes.name,
        claimedAt: schema.claims.claimedAt,
        rank: schema.claims.rank,
      })
      .from(schema.claims)
      .innerJoin(schema.cards, eq(schema.claims.cardId, schema.cards.id))
      .innerJoin(schema.heroes, eq(schema.cards.heroId, schema.heroes.id))
      .where(and(eq(schema.claims.guildId, guildId), eq(schema.claims.userId, target.id)))
      .orderBy(desc(RARITY_RANK), desc(schema.claims.rank), desc(schema.claims.claimedAt))
      .limit(PAGE_SIZE)
      .offset(page * PAGE_SIZE);

    const body = rows
      .map((r) => {
        const m = RARITY_META[r.rarity as Rarity];
        // Rank is shown here because it is the only place a player reviews the
        // whole collection before deciding what to sell, trade or burn.
        return `${m.emoji} ${rankPrefix(r.rank)}**${r.heroName}** — ${r.name}`;
      })
      .join("\n");

    const shards = await getShards(target.id);
    return new EmbedBuilder()
      .setTitle(`${target.username}'s collection`)
      .setDescription(body)
      .setColor(0x5865f2)
      .setFooter({ text: `Page ${page + 1}/${pages} · ${total} cards · 💠 ${shards} shards` });
  };

  const nav = (disabled = false) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("prev")
        .setLabel("◀")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || page === 0),
      new ButtonBuilder()
        .setCustomId("next")
        .setLabel("▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || page >= pages - 1),
    );

  await interaction.editReply({
    embeds: [await render()],
    components: pages > 1 ? [nav()] : [],
  });

  if (pages <= 1) return;

  const message = await interaction.fetchReply();
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    time: 120_000,
    // Only the person who ran the command drives the pager.
    filter: (i) => i.user.id === interaction.user.id,
  });

  collector.on("collect", async (i) => {
    page += i.customId === "next" ? 1 : -1;
    page = Math.max(0, Math.min(page, pages - 1));
    await i.update({ embeds: [await render()], components: [nav()] });
  });

  collector.on("end", async () => {
    await message.edit({ components: [nav(true)] }).catch(() => {});
  });
}
