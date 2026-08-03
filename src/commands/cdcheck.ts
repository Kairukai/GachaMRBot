import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";
import { ensureMember, ensureGuild, getShards } from "../lib/state.js";
import { ROLL_PRICE_SHARDS, CLAIM_PRICE_SHARDS } from "../lib/gacha.js";

export const data = new SlashCommandBuilder()
  .setName("cdcheck")
  .setDescription("Check your cooldowns, rolls and claims.")
  .setDMPermission(false);

const stamp = (d: Date) => `<t:${Math.floor(d.getTime() / 1000)}:R>`;

export async function execute(interaction: ChatInputCommandInteraction) {
  // Deferred immediately: every path here queries Postgres, and a cold or
  // distant database can exceed Discord's 3-second interaction deadline.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId!;
  const state = await ensureMember(interaction.user.id, guildId);
  const settings = await ensureGuild(guildId);
  const shards = await getShards(interaction.user.id);
  const now = new Date();

  // A lapsed window means the stored counter is stale — the next roll or claim
  // resets it, so report the refreshed figure rather than the old one.
  const rollWindowOver = !state.rollsResetAt || state.rollsResetAt <= now;
  const claimWindowOver = !state.claimsResetAt || state.claimsResetAt <= now;

  const rollsUsed = rollWindowOver ? 0 : state.rollsUsed;
  const claimsUsed = claimWindowOver ? 0 : state.claimsUsed;
  const rollsLeft = Math.max(0, settings.rollsPerHour - rollsUsed);
  const claimsLeft = Math.max(0, settings.claimsPerHour - claimsUsed);

  const readyAt = state.lastRollAt
    ? new Date(state.lastRollAt.getTime() + settings.rollCooldownSec * 1000)
    : null;
  const onCooldown = readyAt !== null && readyAt > now;

  const embed = new EmbedBuilder()
    .setTitle("⏱️ Cooldowns")
    .setColor(onCooldown || rollsLeft === 0 ? 0xf59e0b : 0x22c55e)
    .addFields(
      {
        name: "Roll cooldown",
        value: onCooldown ? `⏳ ready ${stamp(readyAt)}` : "✅ ready now",
        inline: false,
      },
      {
        name: "Rolls",
        value:
          `**${rollsLeft}** / ${settings.rollsPerHour} left` +
          (rollsLeft === 0 && !rollWindowOver
            ? `\nrefills ${stamp(state.rollsResetAt!)}`
            : rollWindowOver
              ? "\nwindow resets on your next roll"
              : `\nresets ${stamp(state.rollsResetAt!)}`),
        inline: true,
      },
      {
        name: "Claims",
        value:
          `**${claimsLeft}** / ${settings.claimsPerHour} left` +
          (claimsLeft === 0 && !claimWindowOver
            ? `\nrefills ${stamp(state.claimsResetAt!)}`
            : claimWindowOver
              ? "\nwindow resets on your next claim"
              : `\nresets ${stamp(state.claimsResetAt!)}`),
        inline: true,
      },
      {
        name: "Shards",
        value:
          `💠 ${shards}\n` +
          `buys ${Math.floor(shards / ROLL_PRICE_SHARDS)} roll(s) · ` +
          `${Math.floor(shards / CLAIM_PRICE_SHARDS)} claim(s)`,
        inline: true,
      },
      {
        name: "Banked (bought)",
        value: `${state.bonusRolls} roll(s) · ${state.bonusClaims} claim(s)`,
        inline: true,
      },
    )
    .setFooter({
      text: `Cooldown ${settings.rollCooldownSec}s · limits are per hour, per server`,
    });

  return interaction.editReply({ embeds: [embed] });
}
