import { SlashCommandBuilder, EmbedBuilder, MessageFlags, } from "discord.js";
export const data = new SlashCommandBuilder()
    .setName("commands")
    .setDescription("List everything this bot can do.")
    .setDMPermission(false);
/** Extra context per command, keyed by name. Anything unlisted still shows. */
const NOTES = {
    roll: "First person to hit **Claim** keeps the card. One owner per server.",
    roll5: "Costs 5 rolls. Each card gets its own Claim button — grab any that are free.",
    collection: "Pass a user to view someone else's. Shows your shard balance.",
    cdcheck: "Your roll cooldown, rolls and claims left this hour, and shard balance.",
    showcase: "Posts one of your cards publicly, with its value and claim date.",
    rates: "True odds on every roll — no pity, read from the live card pool.",
    trade: "One-for-one swap. Only the recipient can accept; offers expire in 5 minutes.",
    sell: "Rare 💠10 · Epic 💠35 · Legendary 💠150. Always asks you to confirm first.",
    sellall: "Sells **every** card of one rarity. Shows the full list before you confirm.",
    give: "One-way gift — no exchange. Asks you to confirm, then announces it publicly.",
    buy: "Rolls 💠200, claims 💠1000. Banked credits kick in after your hourly allowance.",
    flexers: "Ranked by total collection value, using the same numbers `/sell` pays.",
    leaderboard: "Top ten by collection value, cards owned, highest rank, or cards burned.",
    rankup: "Burn spare cards and shards to rank an Epic or Legendary 1→10. Ranked cards can never be fodder, and burned cards return to the pool.",
    team: "Six slots, six different heroes. Max one Legendary per role and two Epics; Rares unlimited. Empty slots use weak recruits.",
    challenge: "Fights their **saved** line-up, online or not — so scout with `/team view` first. 10 per hour. Add `wager_shards`, or `stake_card` + `their_card`, to play for something; wagered fights have to be accepted first.",
    commands: "This list.",
};
export async function execute(interaction) {
    // Deferred immediately: every path here queries Postgres, and a cold or
    // distant database can exceed Discord's 3-second interaction deadline.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // Imported at call time: commands/index.ts imports this module to build the
    // registry, so a top-level import would be circular. The cast keeps TypeScript
    // from chasing that cycle back into its own inference.
    const { commands } = (await import("./index.js"));
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
    return interaction.editReply({ embeds: [embed] });
}
//# sourceMappingURL=help.js.map