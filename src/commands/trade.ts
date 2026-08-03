import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from "discord.js";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { ensureMember } from "../lib/state.js";
import {
  ownedCards,
  cardLabel,
  tradeButtons,
  TRADE_TTL_MS,
} from "../lib/trade.js";

export const data = new SlashCommandBuilder()
  .setName("trade")
  .setDescription("Offer one of your cards for one of someone else's.")
  .setDMPermission(false)
  .addUserOption((o) =>
    o.setName("user").setDescription("Who you're trading with").setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName("offer")
      .setDescription("The card you're giving up")
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption((o) =>
    o
      .setName("want")
      .setDescription("The card you want from them")
      .setRequired(true)
      .setAutocomplete(true),
  );

/** Autocomplete reads the sibling `user` option to know whose cards to list. */
export async function autocomplete(interaction: AutocompleteInteraction) {
  const focused = interaction.options.getFocused(true);
  const guildId = interaction.guildId;
  if (!guildId) return interaction.respond([]);

  const target =
    focused.name === "offer"
      ? interaction.user.id
      : (interaction.options.get("user")?.value as string | undefined);

  if (!target) {
    return interaction.respond([
      { name: "Pick the user first", value: "none" },
    ]);
  }

  const choices = await ownedCards(guildId, target, focused.value);
  return interaction.respond(
    choices.length ? choices : [{ name: "No matching cards", value: "none" }],
  );
}

export async function execute(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId!;
  const receiver = interaction.options.getUser("user", true);
  const offerCardId = interaction.options.getString("offer", true);
  const wantCardId = interaction.options.getString("want", true);

  if (receiver.id === interaction.user.id) {
    return interaction.reply({
      content: "You can't trade with yourself.",
      flags: MessageFlags.Ephemeral,
    });
  }
  if (receiver.bot) {
    return interaction.reply({
      content: "Bots don't collect cards.",
      flags: MessageFlags.Ephemeral,
    });
  }
  if (offerCardId === "none" || wantCardId === "none") {
    return interaction.reply({
      content: "Pick both cards from the autocomplete list.",
      flags: MessageFlags.Ephemeral,
    });
  }

  await ensureMember(interaction.user.id, guildId);
  await ensureMember(receiver.id, guildId);

  // Re-check ownership at propose time so obviously dead offers never post.
  // It's checked again inside the swap, which is what actually guarantees it.
  const [mine] = await db
    .select({ id: schema.claims.id })
    .from(schema.claims)
    .where(
      and(
        eq(schema.claims.guildId, guildId),
        eq(schema.claims.cardId, offerCardId),
        eq(schema.claims.userId, interaction.user.id),
      ),
    );
  if (!mine) {
    return interaction.reply({
      content: "You don't own that card in this server.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const [theirs] = await db
    .select({ id: schema.claims.id })
    .from(schema.claims)
    .where(
      and(
        eq(schema.claims.guildId, guildId),
        eq(schema.claims.cardId, wantCardId),
        eq(schema.claims.userId, receiver.id),
      ),
    );
  if (!theirs) {
    return interaction.reply({
      content: `${receiver.username} doesn't own that card in this server.`,
      flags: MessageFlags.Ephemeral,
    });
  }

  const [trade] = await db
    .insert(schema.trades)
    .values({
      guildId,
      proposerId: interaction.user.id,
      receiverId: receiver.id,
      offerCardId,
      wantCardId,
    })
    .returning({ id: schema.trades.id });

  const expiresAt = Math.floor((Date.now() + TRADE_TTL_MS) / 1000);
  const embed = new EmbedBuilder()
    .setTitle("Trade offer")
    .setColor(0xf59e0b)
    .setDescription(
      `<@${interaction.user.id}> wants to trade with <@${receiver.id}>.\n\n` +
        `**Giving:** ${await cardLabel(offerCardId)}\n` +
        `**Wants:** ${await cardLabel(wantCardId)}`,
    )
    .setFooter({ text: "Only the recipient can accept. The proposer can withdraw." })
    .addFields({ name: "Expires", value: `<t:${expiresAt}:R>`, inline: true });

  await interaction.reply({
    content: `<@${receiver.id}>`,
    embeds: [embed],
    components: [tradeButtons(trade!.id)],
  });
}
