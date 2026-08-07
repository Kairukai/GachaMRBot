import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { ensureGuild, ensureUser } from "../lib/state.js";
import { resolveTeam } from "../lib/team.js";
import { battleRecord, consumeBattle, runChallenge, teamPower } from "../lib/challenge.js";
import { TEAM_SIZE, type Role, type RoundLog } from "../lib/battle.js";

export const data = new SlashCommandBuilder()
  .setName("challenge")
  .setDescription("Fight another player's saved 6v6 line-up.")
  .setDMPermission(false)
  .addUserOption((o) =>
    o.setName("player").setDescription("Who to challenge").setRequired(true),
  );

const ULT_NAMES: Record<Role, string> = {
  duelist: "Focus Fire",
  vanguard: "Bulwark",
  strategist: "Rally",
};

function ultLine(fired: Record<Role, number>): string {
  const parts = (Object.keys(ULT_NAMES) as Role[])
    .filter((r) => fired[r] > 0)
    .map((r) => `${ULT_NAMES[r]}${fired[r] > 1 ? ` ×${fired[r]}` : ""}`);
  return parts.join(", ");
}

function roundLine(r: RoundLog, challenger: string, defender: string): string {
  const ults: string[] = [];
  const a = ultLine(r.aUlts);
  const b = ultLine(r.bUlts);
  if (a) ults.push(`💥 ${challenger}: ${a}`);
  if (b) ults.push(`💥 ${defender}: ${b}`);
  const hp = `${Math.max(0, Math.round(r.aHp))} ⚔ ${Math.max(0, Math.round(r.bHp))}`;
  return [`\`R${r.round}\` ${hp}`, ...ults].join(" · ");
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId!;
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
  const won = outcome.winnerId === challenger.id;

  const myPower = teamPower(outcome.challenger.units);
  const theirPower = teamPower(outcome.defender.units);

  const log = outcome.result.rounds
    .map((r) => roundLine(r, challenger.username, target.username))
    .join("\n");

  const mvpCard =
    [...outcome.challenger.slots, ...outcome.defender.slots].find(
      (s) => s.card?.cardId === outcome.result.mvp?.cardId,
    )?.card ?? null;

  const embed = new EmbedBuilder()
    .setTitle(`${challenger.username} ⚔ ${target.username}`)
    .setColor(won ? 0x22c55e : 0xef4444)
    .setDescription(
      `**${won ? challenger.username : target.username} wins** in ` +
        `${outcome.result.rounds.length} round(s).\n\n${log}`,
    )
    .addFields(
      {
        name: challenger.username,
        value: `Power ${myPower} · ${outcome.challenger.owned}/${TEAM_SIZE} slots`,
        inline: true,
      },
      {
        name: target.username,
        value: `Power ${theirPower} · ${outcome.defender.owned}/${TEAM_SIZE} slots`,
        inline: true,
      },
    );

  if (mvpCard) {
    embed.addFields({
      name: "MVP",
      value: `${mvpCard.hero} — ${mvpCard.name}${mvpCard.rank > 1 ? ` (R${mvpCard.rank})` : ""}`,
      inline: true,
    });
  }

  const record = await battleRecord(guildId, challenger.id);
  embed.setFooter({
    text:
      `${challenger.username}: ${record.wins}W ${record.losses}L · match #${outcome.matchId} · ` +
      `defender holds a home advantage`,
  });

  return interaction.editReply({ embeds: [embed] });
}
