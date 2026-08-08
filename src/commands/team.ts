import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from "discord.js";
import { RARITY_META, type Rarity } from "../lib/gacha.js";
import { TEAM_SIZE, MAX_EPICS, type Role } from "../lib/battle.js";
import { ownedCards } from "../lib/trade.js";
import { clearTeam, resolveTeam, setTeam, type SlotInput } from "../lib/team.js";
import { teamPower } from "../lib/challenge.js";
import { rankPrefix } from "../lib/badges.js";

const SLOT_OPTIONS = [1, 2, 3, 4, 5, 6] as const;

export const data = new SlashCommandBuilder()
  .setName("team")
  .setDescription("Manage your 6v6 line-up.")
  .setDMPermission(false)
  .addSubcommand((sub) => {
    sub
      .setName("set")
      .setDescription("Save your line-up. Empty slots are filled by weak recruits.");
    for (const n of SLOT_OPTIONS) {
      sub.addStringOption((o) =>
        o
          .setName(`card${n}`)
          .setDescription(`Slot ${n}`)
          .setRequired(n === 1)
          .setAutocomplete(true),
      );
    }
    // Deadpool is the only hero the wiki lists as all three roles, so he can't
    // be placed without being told which one he's filling.
    return sub.addStringOption((o) =>
      o
        .setName("wildcard_role")
        .setDescription("Role for a hero that can play more than one (e.g. Deadpool)")
        .setRequired(false)
        .addChoices(
          { name: "Vanguard", value: "vanguard" },
          { name: "Duelist", value: "duelist" },
          { name: "Strategist", value: "strategist" },
        ),
    );
  })
  .addSubcommand((sub) =>
    sub
      .setName("view")
      .setDescription("Show a line-up.")
      .addUserOption((o) =>
        o.setName("user").setDescription("Whose team to view").setRequired(false),
      ),
  )
  .addSubcommand((sub) => sub.setName("clear").setDescription("Delete your saved line-up."));

export async function autocomplete(interaction: AutocompleteInteraction) {
  const guildId = interaction.guildId;
  if (!guildId) return interaction.respond([]);
  const choices = await ownedCards(
    guildId,
    interaction.user.id,
    interaction.options.getFocused(),
  );
  return interaction.respond(
    choices.length ? choices : [{ name: "You own no matching cards", value: "none" }],
  );
}

const RULES = [
  `**${TEAM_SIZE} slots**, and every hero must be different — costume doesn't matter, so two Black Panther skins can't both play.`,
  "**One Legendary per role** at most: a Legendary Vanguard, Duelist and Strategist is the ceiling.",
  `**${MAX_EPICS} Epics** per team at most.`,
  "**Rares are unlimited.**",
];

export async function execute(interaction: ChatInputCommandInteraction) {
  const sub = interaction.options.getSubcommand();
  if (sub === "set") return setCommand(interaction);
  if (sub === "clear") return clearCommand(interaction);
  return viewCommand(interaction);
}

async function setCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId!;
  const wildcard = interaction.options.getString("wildcard_role") as Role | null;

  const slots: SlotInput[] = [];
  for (const n of SLOT_OPTIONS) {
    const cardId = interaction.options.getString(`card${n}`);
    if (!cardId || cardId === "none") continue;
    slots.push({ cardId, ...(wildcard ? { role: wildcard } : {}) });
  }

  if (slots.length === 0) {
    return interaction.editReply({ content: "Pick at least one card from the autocomplete." });
  }

  const result = await setTeam(guildId, interaction.user.id, slots);

  if (!result.ok) {
    if ("notOwned" in result) {
      return interaction.editReply({
        content: `You don't own ${result.notOwned.length} of those cards in this server.`,
      });
    }
    if ("needsRole" in result) {
      const lines = result.needsRole.map((r) =>
        r.options.length > 1
          ? `• **${r.hero}** can play ${r.options.join(", ")} — pick one with \`wildcard_role\`.`
          : `• **${r.hero}** has no role on record, so pick one with \`wildcard_role\`.`,
      );
      return interaction.editReply({
        content: ["Some heroes need a role declared:", ...lines].join("\n"),
      });
    }
    const lines = result.violations.map((v) => {
      switch (v.code) {
        case "size":
          return `• Too many cards: ${v.have}, max ${TEAM_SIZE}.`;
        case "duplicate_hero":
          return `• Two costumes of the same hero — only one of each hero can play.`;
        case "epic_cap":
          return `• ${v.have} Epics, max ${MAX_EPICS}.`;
        case "legendary_role_cap":
          return `• ${v.have} Legendary ${v.role}s, max 1 per role.`;
        case "rank_out_of_range":
          return `• A card has an impossible rank (${v.rank}).`;
        case "rank_not_rankable":
          return `• A ${v.rarity} card is carrying a rank it shouldn't have.`;
      }
    });
    return interaction.editReply({
      content: ["That line-up isn't legal:", ...lines, "", ...RULES.map((r) => `— ${r}`)].join(
        "\n",
      ),
    });
  }

  return interaction.editReply({ embeds: [renderTeam(interaction.user.username, result.team)] });
}

async function clearCommand(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const removed = await clearTeam(interaction.guildId!, interaction.user.id);
  return interaction.editReply({
    content: removed
      ? `Cleared your line-up (${removed} slot(s)).`
      : "You didn't have a saved line-up.",
  });
}

async function viewCommand(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId!;
  const target = interaction.options.getUser("user") ?? interaction.user;

  const { slots, owned } = await resolveTeam(guildId, target.id);

  if (owned === 0) {
    // Nothing to show — keep it out of the channel.
    return interaction.reply({
      content:
        target.id === interaction.user.id
          ? ["You haven't set a line-up yet. Use `/team set`.", "", ...RULES.map((r) => `— ${r}`)].join("\n")
          : `${target.username} hasn't set a line-up.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  // Rosters are public on purpose: scouting before a challenge is the point.
  await interaction.deferReply();

  const body = slots
    .map((s) => {
      if (!s.card) return `\`${s.slot}\` ⬜ *Recruit* — empty slot`;
      const m = RARITY_META[s.card.rarity];
      return `\`${s.slot}\` ${m.emoji} ${rankPrefix(s.card.rank)}**${s.card.hero}** — ${s.card.name} · *${s.card.role}*`;
    })
    .join("\n");

  const counts = slots.reduce(
    (acc, s) => {
      if (s.card) acc[s.card.role]++;
      return acc;
    },
    { vanguard: 0, duelist: 0, strategist: 0 } as Record<Role, number>,
  );

  const embed = new EmbedBuilder()
    .setTitle(`${target.username}'s line-up`)
    .setDescription(body)
    .setColor(0x5865f2)
    .addFields(
      {
        name: "Composition",
        value: `${counts.vanguard}V / ${counts.duelist}D / ${counts.strategist}S`,
        inline: true,
      },
      { name: "Slots filled", value: `${owned}/${TEAM_SIZE}`, inline: true },
      { name: "Power", value: `${teamPower(slots.map((s) => s.unit))}`, inline: true },
    );

  if (owned < TEAM_SIZE) {
    embed.setFooter({
      text: "Empty slots are filled by recruits, which are far weaker than a real card.",
    });
  }

  return interaction.editReply({ embeds: [embed] });
}

function renderTeam(username: string, team: { slot: number; hero: string; name: string; rarity: Rarity; rank: number; role: Role }[]) {
  const body = team
    .map((c) => {
      const m = RARITY_META[c.rarity];
      return `\`${c.slot}\` ${m.emoji} ${rankPrefix(c.rank)}**${c.hero}** — ${c.name} · *${c.role}*`;
    })
    .join("\n");

  const embed = new EmbedBuilder()
    .setTitle(`${username}'s line-up saved`)
    .setDescription(body)
    .setColor(0x22c55e);

  if (team.length < TEAM_SIZE) {
    embed.setFooter({
      text: `${TEAM_SIZE - team.length} slot(s) will be filled by recruits — much weaker than a real card.`,
    });
  }
  return embed;
}
