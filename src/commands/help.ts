import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("commands")
  .setDescription("List everything this bot can do.")
  .setDMPermission(false);

/** Extra context per command, keyed by name. Anything unlisted still shows. */
const NOTES: Record<string, string> = {
  roll: "First person to hit **Claim** keeps the card. One owner per server.",
  roll5: "Costs 5 rolls. Each card gets its own Claim button — grab any that are free.",
  collection: "Pass a user to view someone else's. Shows your shard balance.",
  cdcheck: "Your roll cooldown, rolls and claims left this hour, and shard balance.",
  showcase: "Posts one of your cards publicly, with its value and claim date.",
  rates: "True odds on every roll — no pity, read from the live card pool.",
  trade: "One-for-one swap. Only the recipient can accept; offers expire in 5 minutes.",
  sell: "Rare 💠10 · Epic 💠35 · Legendary 💠150. Always asks you to confirm first.",
  sellall: "Sells **every** card of one rarity. Shows the full list before you confirm.",
  flexers: "Ranked by total collection value, using the same numbers `/sell` pays.",
  commands: "This list.",
};

/** Minimal shape we need from the registry — also breaks the type cycle below. */
type CommandMeta = { data: { name: string; description: string } };

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<unknown> {
  // Imported at call time: commands/index.ts imports this module to build the
  // registry, so a top-level import would be circular. The cast keeps TypeScript
  // from chasing that cycle back into its own inference.
  const { commands } = (await import("./index.js")) as unknown as {
    commands: Map<string, CommandMeta>;
  };

  const lines = [...commands.values()]
    .sort((a, b) => a.data.name.localeCompare(b.data.name))
    .map((c) => {
      const note = NOTES[c.data.name];
      return `**/${c.data.name}** — ${c.data.description}${note ? `\n> ${note}` : ""}`;
    });

  const embed = new EmbedBuilder()
    .setTitle("Commands")
    .setDescription(lines.join("\n\n"))
    .setColor(0x5865f2)
    .setFooter({ text: "Rolls are cheap, claims are scarce — spend them well." });

  return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
