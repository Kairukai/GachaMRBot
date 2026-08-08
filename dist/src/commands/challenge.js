import { SlashCommandBuilder, EmbedBuilder, MessageFlags, } from "discord.js";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { ensureGuild, ensureUser } from "../lib/state.js";
import { resolveTeam } from "../lib/team.js";
import { battleRecord, consumeBattle, renderMatchEmbed, runChallenge, teamPower, } from "../lib/challenge.js";
import { ownedCards, cardLabel } from "../lib/trade.js";
import { CHALLENGE_TTL_MS, challengeButtons, createChallenge, } from "../lib/wager.js";
export const data = new SlashCommandBuilder()
    .setName("challenge")
    .setDescription("Fight another player's saved 6v6 line-up.")
    .setDMPermission(false)
    .addUserOption((o) => o.setName("player").setDescription("Who to challenge").setRequired(true))
    .addIntegerOption((o) => o
    .setName("wager_shards")
    .setDescription("Shards each side stakes; the winner takes the pot")
    .setMinValue(1)
    .setRequired(false))
    .addStringOption((o) => o
    .setName("stake_card")
    .setDescription("A card of yours to put on the line")
    .setRequired(false)
    .setAutocomplete(true))
    .addStringOption((o) => o
    .setName("their_card")
    .setDescription("The card of theirs you're playing for")
    .setRequired(false)
    .setAutocomplete(true));
/**
 * Autocomplete reads the sibling `player` option to know whose cards to list,
 * exactly as `/trade` does — `stake_card` is yours, `their_card` is theirs.
 */
export async function autocomplete(interaction) {
    const guildId = interaction.guildId;
    if (!guildId)
        return interaction.respond([]);
    const focused = interaction.options.getFocused(true);
    const owner = focused.name === "stake_card"
        ? interaction.user.id
        : interaction.options.get("player")?.value;
    if (!owner)
        return interaction.respond([{ name: "Pick the player first", value: "none" }]);
    const choices = await ownedCards(guildId, owner, focused.value);
    return interaction.respond(choices.length ? choices : [{ name: "No matching cards", value: "none" }]);
}
export async function execute(interaction) {
    const guildId = interaction.guildId;
    const challenger = interaction.user;
    const target = interaction.options.getUser("player", true);
    // Gate checks answer ephemerally; only a fight that will actually happen
    // gets broadcast to the channel.
    if (target.id === challenger.id) {
        return interaction.reply({
            content: "You can't challenge yourself.",
            flags: MessageFlags.Ephemeral,
        });
    }
    if (target.bot) {
        return interaction.reply({
            content: "Bots don't collect cards.",
            flags: MessageFlags.Ephemeral,
        });
    }
    const [mine, theirs] = await Promise.all([
        resolveTeam(guildId, challenger.id),
        resolveTeam(guildId, target.id),
    ]);
    if (mine.owned === 0) {
        return interaction.reply({
            content: "Set a line-up first with `/team set`.",
            flags: MessageFlags.Ephemeral,
        });
    }
    if (theirs.owned === 0) {
        return interaction.reply({
            content: `${target.username} hasn't set a line-up yet, so there's nothing to fight.`,
            flags: MessageFlags.Ephemeral,
        });
    }
    const [settings] = await db
        .select({ battlesPerHour: schema.guildSettings.battlesPerHour })
        .from(schema.guildSettings)
        .where(eq(schema.guildSettings.id, guildId));
    const perHour = settings?.battlesPerHour ?? 10;
    await ensureGuild(guildId);
    await ensureUser(challenger.id);
    await ensureUser(target.id);
    const wagerShards = interaction.options.getInteger("wager_shards");
    const stakeCard = interaction.options.getString("stake_card");
    const theirCard = interaction.options.getString("their_card");
    const wantsCardWager = Boolean(stakeCard || theirCard);
    if (wagerShards && wantsCardWager) {
        return interaction.reply({
            content: "Pick one kind of stake: shards or cards, not both.",
            flags: MessageFlags.Ephemeral,
        });
    }
    if (wantsCardWager && (!stakeCard || !theirCard || stakeCard === "none" || theirCard === "none")) {
        return interaction.reply({
            content: "A card wager needs both sides: `stake_card` (yours) and `their_card` (theirs).",
            flags: MessageFlags.Ephemeral,
        });
    }
    const stake = wagerShards
        ? { kind: "shards", amount: wagerShards }
        : wantsCardWager
            ? { kind: "card", challengerCardId: stakeCard, defenderCardId: theirCard }
            : { kind: "none" };
    /**
     * A friendly fight resolves now, because the defender risks nothing and so
     * has nothing to consent to. A wagered one becomes an offer — you cannot take
     * someone's card or shards without them agreeing.
     */
    if (stake.kind !== "none") {
        return offerWager(interaction, guildId, challenger, target, stake);
    }
    const quota = await consumeBattle(challenger.id, guildId, perHour);
    if (!quota.ok) {
        return interaction.reply({
            content: `You're out of challenges. More <t:${Math.floor(quota.retryAt.getTime() / 1000)}:R>.`,
            flags: MessageFlags.Ephemeral,
        });
    }
    // From here the outcome is certain to be public.
    await interaction.deferReply();
    const outcome = await runChallenge(guildId, challenger.id, target.id);
    const embed = renderMatchEmbed(outcome, challenger.username, target.username);
    const record = await battleRecord(guildId, challenger.id);
    embed.setFooter({
        text: `${challenger.username}: ${record.wins}W ${record.losses}L · match #${outcome.matchId} · ` +
            `defender holds a home advantage`,
    });
    return interaction.editReply({ embeds: [embed] });
}
/** Posts a wagered challenge for the defender to accept or decline. */
async function offerWager(interaction, guildId, challenger, target, stake) {
    await interaction.deferReply();
    const created = await createChallenge(guildId, challenger.id, target.id, stake);
    if (!created.ok) {
        const f = created.failure;
        const message = f.code === "already_pending"
            ? "You already have a challenge waiting on them."
            : f.code === "stake_too_low"
                ? "Stake at least 1 shard."
                : f.code === "stake_not_owned"
                    ? `The ${f.who}'s staked card isn't theirs any more.`
                    : `The ${f.who} doesn't have 💠 ${f.need}.`;
        return interaction.editReply({ content: message });
    }
    const myPower = teamPower((await resolveTeam(guildId, challenger.id)).slots.map((s) => s.unit));
    const theirPower = teamPower((await resolveTeam(guildId, target.id)).slots.map((s) => s.unit));
    const stakeText = stake.kind === "none"
        ? "No stake."
        : stake.kind === "shards"
            ? `Both stake **💠 ${stake.amount}**. Winner takes the pot.`
            : [
                `**${await cardLabel(stake.challengerCardId, guildId)}**`,
                "against",
                `**${await cardLabel(stake.defenderCardId, guildId)}**`,
                "Winner takes the loser's card — rank and all.",
            ].join("\n");
    const embed = new EmbedBuilder()
        .setTitle(`${challenger.username} challenges ${target.username}`)
        .setColor(0xf59e0b)
        .setDescription(`<@${target.id}>, a wager is on the table.

${stakeText}`)
        .addFields({ name: challenger.username, value: `Power ${myPower}`, inline: true }, { name: target.username, value: `Power ${theirPower}`, inline: true })
        .setFooter({
        text: "Only the challenged player can accept; the challenger can withdraw. " +
            `Expires in ${Math.round(CHALLENGE_TTL_MS / 60000)} minutes. Stakes are checked again when accepted.`,
    });
    return interaction.editReply({
        embeds: [embed],
        components: [challengeButtons(created.challengeId)],
    });
}
//# sourceMappingURL=challenge.js.map