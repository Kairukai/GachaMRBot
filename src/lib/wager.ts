/**
 * Wagered challenges.
 *
 * A friendly `/challenge` resolves instantly because the defender risks
 * nothing. A wagered one cannot: taking someone's card or shards without their
 * agreement isn't a mechanic, it's theft. So a stake turns the command into an
 * offer with the same accept/decline handshake as `/trade`.
 *
 * Stakes are deliberately NOT escrowed. Holding a card for the life of an offer
 * is exactly what `executeSwap` avoids — it deadlocks, and it stops a card
 * appearing in more than one offer at a time. Both stakes are re-validated
 * inside the settlement transaction instead, so an offer whose stake was spent
 * or traded away fails cleanly rather than moving something that isn't there.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type ButtonInteraction,
} from "discord.js";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import {
  consumeBattle,
  renderMatchEmbed,
  runChallenge,
  type ChallengeOutcome,
} from "./challenge.js";
import { cardLabel } from "./trade.js";

export const CHALLENGE_PREFIX = "chal:";

/** Offers go stale rather than lingering forever, same as trades. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type WagerKind = "none" | "shards" | "card";

export type StakeSpec =
  | { kind: "none" }
  | { kind: "shards"; amount: number }
  | { kind: "card"; challengerCardId: string; defenderCardId: string };

export type CreateFailure =
  | { code: "already_pending" }
  | { code: "stake_not_owned"; who: "challenger" | "defender" }
  | { code: "stake_too_low" }
  | { code: "insufficient_shards"; who: "challenger" | "defender"; need: number };

export type CreateResult =
  | { ok: true; challengeId: number }
  | { ok: false; failure: CreateFailure };

/**
 * Records a wagered challenge for the defender to answer.
 *
 * The stake checks here are advisory — everything is re-validated at
 * settlement, because a card can be traded away or shards spent while the offer
 * sits waiting. Checking now just avoids posting an offer that was never going
 * to work.
 */
export async function createChallenge(
  guildId: string,
  challengerId: string,
  defenderId: string,
  stake: StakeSpec,
): Promise<CreateResult> {
  const fail = (failure: CreateFailure): CreateResult => ({ ok: false, failure });

  const existing = await db
    .select({ id: schema.challenges.id })
    .from(schema.challenges)
    .where(
      and(
        eq(schema.challenges.guildId, guildId),
        eq(schema.challenges.challengerId, challengerId),
        eq(schema.challenges.defenderId, defenderId),
        eq(schema.challenges.status, "pending"),
      ),
    );
  if (existing.length) return fail({ code: "already_pending" });

  if (stake.kind === "shards") {
    if (stake.amount <= 0) return fail({ code: "stake_too_low" });
    for (const [who, id] of [
      ["challenger", challengerId],
      ["defender", defenderId],
    ] as const) {
      const [row] = await db
        .select({ shards: schema.users.shards })
        .from(schema.users)
        .where(eq(schema.users.id, id));
      if ((row?.shards ?? 0) < stake.amount) {
        return fail({ code: "insufficient_shards", who, need: stake.amount });
      }
    }
  }

  if (stake.kind === "card") {
    const pairs = [
      ["challenger", challengerId, stake.challengerCardId],
      ["defender", defenderId, stake.defenderCardId],
    ] as const;
    for (const [who, userId, cardId] of pairs) {
      const [owned] = await db
        .select({ cardId: schema.claims.cardId })
        .from(schema.claims)
        .where(
          and(
            eq(schema.claims.guildId, guildId),
            eq(schema.claims.userId, userId),
            eq(schema.claims.cardId, cardId),
          ),
        );
      if (!owned) return fail({ code: "stake_not_owned", who });
    }
  }

  const [row] = await db
    .insert(schema.challenges)
    .values({
      guildId,
      challengerId,
      defenderId,
      wager: stake.kind,
      stakeShards: stake.kind === "shards" ? stake.amount : 0,
      challengerCardId: stake.kind === "card" ? stake.challengerCardId : null,
      defenderCardId: stake.kind === "card" ? stake.defenderCardId : null,
    })
    .returning({ id: schema.challenges.id });

  return { ok: true, challengeId: row!.id };
}

export type SettleFailure =
  | { code: "not_pending" }
  | { code: "expired" }
  | { code: "stake_gone"; who: "challenger" | "defender" }
  | { code: "shards_gone"; who: "challenger" | "defender" };

export type SettleResult =
  | {
      ok: true;
      outcome: ChallengeOutcome;
      wager: WagerKind;
      stakeShards: number;
      prizeCardId: string | null;
    }
  | { ok: false; failure: SettleFailure };

/**
 * Thrown to roll a settlement back. Returning from inside `db.transaction`
 * COMMITS — here that would mean recording a fight without moving the stake, or
 * moving half of it. Same trap the burn transaction documents.
 */
class SettleAbort extends Error {
  constructor(readonly failure: SettleFailure) {
    super(`settle aborted: ${failure.code}`);
  }
}

/**
 * Fights a wagered challenge and moves the stakes, atomically.
 *
 * One transaction covers re-validation, the fight, the transfer and the record.
 * The simulator is pure, so running it inside a transaction costs nothing and
 * guarantees a result can never exist without its payout — or a payout without
 * its result.
 */
export async function settleChallenge(challengeId: number): Promise<SettleResult> {
  const abort: (failure: SettleFailure) => never = (failure) => {
    throw new SettleAbort(failure);
  };

  try {
    return await db.transaction(async (tx): Promise<SettleResult> => {
      const [offer] = await tx
        .select()
        .from(schema.challenges)
        .where(eq(schema.challenges.id, challengeId))
        .for("update");

      if (!offer || offer.status !== "pending") abort({ code: "not_pending" });
      if (Date.now() - offer.createdAt.getTime() > CHALLENGE_TTL_MS) abort({ code: "expired" });

      const { guildId, challengerId, defenderId } = offer;

      /**
       * Both stakes are validated BEFORE the fight. Discovering mid-payout that
       * the loser can't cover would leave a recorded match with no transfer.
       */
      if (offer.wager === "shards") {
        for (const [who, id] of [
          ["challenger", challengerId],
          ["defender", defenderId],
        ] as const) {
          const [row] = await tx
            .select({ shards: schema.users.shards })
            .from(schema.users)
            .where(eq(schema.users.id, id));
          if ((row?.shards ?? 0) < offer.stakeShards) abort({ code: "shards_gone", who });
        }
      }

      if (offer.wager === "card") {
        const pairs = [
          ["challenger", challengerId, offer.challengerCardId!],
          ["defender", defenderId, offer.defenderCardId!],
        ] as const;
        for (const [who, userId, cardId] of pairs) {
          const [owned] = await tx
            .select({ cardId: schema.claims.cardId })
            .from(schema.claims)
            .where(
              and(
                eq(schema.claims.guildId, guildId),
                eq(schema.claims.userId, userId),
                eq(schema.claims.cardId, cardId),
              ),
            );
          if (!owned) abort({ code: "stake_gone", who });
        }
      }

      const outcome = await runChallenge(guildId, challengerId, defenderId, tx);
      const winnerId = outcome.winnerId;
      const loserId = winnerId === challengerId ? defenderId : challengerId;
      const loserSide = loserId === challengerId ? "challenger" : "defender";

      let prizeCardId: string | null = null;

      if (offer.wager === "shards") {
        // Zero-sum between two players: nothing is minted, so wagering can't
        // inflate the economy the way a payout from the house would.
        const taken = await tx
          .update(schema.users)
          .set({ shards: sql`${schema.users.shards} - ${offer.stakeShards}` })
          .where(
            and(
              eq(schema.users.id, loserId),
              sql`${schema.users.shards} >= ${offer.stakeShards}`,
            ),
          )
          .returning({ shards: schema.users.shards });
        if (taken.length === 0) abort({ code: "shards_gone", who: loserSide });

        await tx
          .update(schema.users)
          .set({ shards: sql`${schema.users.shards} + ${offer.stakeShards}` })
          .where(eq(schema.users.id, winnerId));
      }

      if (offer.wager === "card") {
        prizeCardId = loserId === challengerId ? offer.challengerCardId! : offer.defenderCardId!;
        /**
         * Ownership-scoped UPDATE, exactly like a trade — which is also why the
         * card keeps its rank: the claim row moves rather than being recreated.
         * If it matches nothing the card left in the meantime, so roll back.
         */
        const moved = await tx
          .update(schema.claims)
          .set({ userId: winnerId })
          .where(
            and(
              eq(schema.claims.guildId, guildId),
              eq(schema.claims.cardId, prizeCardId),
              eq(schema.claims.userId, loserId),
            ),
          )
          .returning({ id: schema.claims.id });
        if (moved.length !== 1) abort({ code: "stake_gone", who: loserSide });
      }

      await tx
        .update(schema.challenges)
        .set({ status: "accepted", matchId: outcome.matchId })
        .where(eq(schema.challenges.id, challengeId));

      return {
        ok: true,
        outcome,
        wager: offer.wager,
        stakeShards: offer.stakeShards,
        prizeCardId,
      };
    });
  } catch (err) {
    if (err instanceof SettleAbort) return { ok: false, failure: err.failure };
    throw err;
  }
}

export async function closeChallenge(
  challengeId: number,
  status: "declined" | "cancelled",
): Promise<void> {
  await db
    .update(schema.challenges)
    .set({ status })
    .where(and(eq(schema.challenges.id, challengeId), eq(schema.challenges.status, "pending")));
}

export async function getChallenge(challengeId: number) {
  const [row] = await db
    .select()
    .from(schema.challenges)
    .where(eq(schema.challenges.id, challengeId));
  return row ?? null;
}

/* ---------------------------------------------------------- interaction */

export function challengeButtons(challengeId: number) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(CHALLENGE_PREFIX + "accept:" + challengeId)
      .setLabel("Accept")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(CHALLENGE_PREFIX + "decline:" + challengeId)
      .setLabel("Decline")
      .setStyle(ButtonStyle.Danger),
  );
}

function settledRow(label: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(CHALLENGE_PREFIX + "settled")
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );
}

function explainSettleFailure(f: SettleFailure): string {
  switch (f.code) {
    case "not_pending":
      return "That challenge is already settled.";
    case "expired":
      return "That challenge expired before it was answered.";
    case "stake_gone":
      return `The ${f.who}'s staked card changed hands before this was accepted — nothing was fought or moved.`;
    case "shards_gone":
      return `The ${f.who} can no longer cover the wager — nothing was fought or moved.`;
  }
}

export async function handleChallengeButton(interaction: ButtonInteraction) {
  const rest = interaction.customId.slice(CHALLENGE_PREFIX.length);
  const [action, rawId] = rest.split(":");
  const challengeId = Number(rawId);

  if (action === "settled" || !Number.isFinite(challengeId)) {
    return interaction.reply({
      content: "That challenge is already settled.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const offer = await getChallenge(challengeId);
  if (!offer || offer.status !== "pending") {
    await interaction.update({ components: [settledRow("Closed")] }).catch(() => {});
    return;
  }

  const isDefender = interaction.user.id === offer.defenderId;
  const isChallenger = interaction.user.id === offer.challengerId;
  if (!isDefender && !isChallenger) {
    return interaction.reply({
      content: "This challenge isn't yours to answer.",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (Date.now() - offer.createdAt.getTime() > CHALLENGE_TTL_MS) {
    await closeChallenge(challengeId, "cancelled");
    await interaction.update({ components: [settledRow("Expired")] }).catch(() => {});
    return;
  }

  // A challenger pressing Accept is withdrawing, not self-approving — same rule
  // as trades, and it matters more here because there is a stake on the table.
  if (action === "decline" || isChallenger) {
    await closeChallenge(challengeId, isChallenger ? "cancelled" : "declined");
    await interaction.update({
      components: [settledRow(isChallenger ? "Withdrawn" : "Declined")],
    });
    return;
  }

  const quota = await consumeBattle(offer.challengerId, offer.guildId, await battlesPerHour(offer.guildId));
  if (!quota.ok) {
    await interaction.update({ components: [settledRow("Challenger out of battles")] }).catch(() => {});
    return interaction.followUp({
      content: "The challenger has no battles left this hour, so this offer can't be fought.",
      flags: MessageFlags.Ephemeral,
    });
  }

  const settled = await settleChallenge(challengeId);
  if (!settled.ok) {
    await closeChallenge(challengeId, "cancelled");
    await interaction.update({ components: [settledRow("No longer valid")] }).catch(() => {});
    return interaction.followUp({
      content: explainSettleFailure(settled.failure),
      flags: MessageFlags.Ephemeral,
    });
  }

  const { outcome } = settled;
  const challengerUser = await interaction.client.users.fetch(offer.challengerId).catch(() => null);
  const challengerName = challengerUser?.username ?? "Challenger";
  const defenderName = interaction.user.username;

  let stakeLine: string;
  if (settled.wager === "shards") {
    stakeLine = `<@${outcome.winnerId}> takes 💠 ${settled.stakeShards}.`;
  } else if (settled.wager === "card" && settled.prizeCardId) {
    stakeLine = `<@${outcome.winnerId}> takes **${await cardLabel(settled.prizeCardId, offer.guildId)}**.`;
  } else {
    stakeLine = "No stake.";
  }

  const embed = renderMatchEmbed(outcome, challengerName, defenderName, stakeLine);
  await interaction.update({ embeds: [embed], components: [settledRow("Fought")] });
}

/** Guild battle allowance, defaulting when the guild row hasn't been created. */
async function battlesPerHour(guildId: string): Promise<number> {
  const [row] = await db
    .select({ n: schema.guildSettings.battlesPerHour })
    .from(schema.guildSettings)
    .where(eq(schema.guildSettings.id, guildId));
  return row?.n ?? 10;
}
