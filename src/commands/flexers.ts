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
import { RARITY_META } from "../lib/gacha.js";
import {
  PAGE_SIZE,
  collectorCount,
  leaderboardPage,
  memberRank,
} from "../lib/leaderboard.js";

export const data = new SlashCommandBuilder()
  .setName("flexers")
  .setDescription("Collection leaderboard for this server.")
  .setDMPermission(false);

const MEDALS = ["🥇", "🥈", "🥉"];

export async function execute(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId!;
  const members = await collectorCount(guildId);

  if (members === 0) {
    return interaction.reply({
      content: "Nobody has claimed a card in this server yet. Be the first — `/roll`.",
      flags: MessageFlags.Ephemeral,
    });
  }

  // The empty case answers ephemerally above; the board itself is public.
  await interaction.deferReply();

  const pages = Math.ceil(members / PAGE_SIZE);
  const me = await memberRank(guildId, interaction.user.id);
  let current = 0;

  const render = async () => {
    const rows = await leaderboardPage(guildId, current * PAGE_SIZE);

    const lines = rows.map((r, i) => {
      const place = current * PAGE_SIZE + i + 1;
      const badge = place <= 3 ? MEDALS[place - 1] : `**${place}.**`;
      const breakdown = [
        `${RARITY_META.legendary.emoji} ${r.legendary}`,
        `${RARITY_META.epic.emoji} ${r.epic}`,
        `${RARITY_META.rare.emoji} ${r.rare}`,
      ].join(" · ");
      // Mentions render as display names inside embeds and never notify.
      return (
        `${badge} <@${r.userId}> — ${r.total} card${r.total === 1 ? "" : "s"}\n` +
        ` ${breakdown} · **💠 ${r.value.toLocaleString()}**`
      );
    });

    return new EmbedBuilder()
      .setTitle("🏆 Flexers")
      .setDescription(lines.join("\n"))
      .setColor(0xf59e0b)
      .setFooter({
        text:
          `Page ${current + 1}/${pages} · ${members} collector${members === 1 ? "" : "s"}` +
          (me ? ` · you're #${me.rank} with ${me.value.toLocaleString()} shards' worth` : ""),
      });
  };

  const nav = (disabled = false) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("prev")
        .setLabel("◀")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || current === 0),
      new ButtonBuilder()
        .setCustomId("next")
        .setLabel("▶")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled || current >= pages - 1),
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
    filter: (i) => i.user.id === interaction.user.id,
  });

  collector.on("collect", async (i) => {
    current += i.customId === "next" ? 1 : -1;
    current = Math.max(0, Math.min(current, pages - 1));
    await i.update({ embeds: [await render()], components: [nav()] });
  });

  collector.on("end", async () => {
    await message.edit({ components: [nav(true)] }).catch(() => {});
  });
}
