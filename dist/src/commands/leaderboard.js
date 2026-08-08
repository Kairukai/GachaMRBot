import { SlashCommandBuilder, EmbedBuilder, MessageFlags, } from "discord.js";
import { CATEGORY_META, categoryStanding, leaderboardTop, } from "../lib/leaderboard.js";
/**
 * Quick top ten across several dimensions.
 *
 * `/flexers` remains the deep, paged view of collection value; this is the
 * broad one, and it's where the ranking and burning data surfaces — neither of
 * which collection value can show, since sell value ignores rank entirely.
 */
export const data = new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Top players in this server.")
    .setDMPermission(false)
    .addStringOption((o) => o
    .setName("category")
    .setDescription("What to rank by")
    .setRequired(false)
    .addChoices({ name: "Collection value", value: "value" }, { name: "Cards owned", value: "cards" }, { name: "Highest rank", value: "rank" }, { name: "Cards burned", value: "burned" }));
const MEDALS = ["🥇", "🥈", "🥉"];
function formatScore(category, score) {
    switch (category) {
        case "value":
            return `💠 ${score}`;
        case "cards":
            return `${score} card${score === 1 ? "" : "s"}`;
        case "rank":
            return `Rank ${score}`;
        case "burned":
            return `${score} burned`;
    }
}
export async function execute(interaction) {
    const guildId = interaction.guildId;
    const category = (interaction.options.getString("category") ?? "value");
    const meta = CATEGORY_META[category];
    const top = await leaderboardTop(guildId, category);
    if (top.length === 0) {
        // Nothing to broadcast — stays ephemeral rather than posting an empty board.
        return interaction.reply({
            content: category === "rank"
                ? "Nobody here has ranked up a card yet. Try `/rankup`."
                : category === "burned"
                    ? "Nobody here has burned anything yet. Try `/rankup`."
                    : "Nobody has claimed anything in this server yet. Try `/roll`.",
            flags: MessageFlags.Ephemeral,
        });
    }
    // Only public once there's actually a board to show.
    await interaction.deferReply();
    const body = top
        .map((row, i) => {
        const place = MEDALS[i] ?? `**${i + 1}.**`;
        return `${place} <@${row.userId}> — **${formatScore(category, row.score)}** · ${row.detail}`;
    })
        .join("\n");
    const embed = new EmbedBuilder()
        .setTitle(`🏆 ${meta.label}`)
        .setDescription(body)
        .setColor(0xf59e0b)
        .setFooter({ text: meta.description });
    const you = await categoryStanding(guildId, category, interaction.user.id);
    if (you && !top.some((r) => r.userId === interaction.user.id)) {
        embed.addFields({
            name: "Your standing",
            value: `#${you.rank} — ${formatScore(category, you.score)}`,
        });
    }
    return interaction.editReply({ embeds: [embed] });
}
//# sourceMappingURL=leaderboard.js.map