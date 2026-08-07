/**
 * 6v6 challenges.
 *
 * Asynchronous by design: a challenge resolves immediately against the
 * defender's SAVED line-up, whether or not they are online. A live handshake
 * would make the feature unusable in a server where people play at different
 * hours, and it would need a consent flow for something that costs the
 * defender nothing.
 *
 * The consequence is that rosters are public information and the attacker can
 * scout before picking a fight. That is intended — it turns the composition
 * triangle into a read rather than a coin flip — and `defenderAdvantage` in
 * TUNING exists to stop a soft counter being enough.
 */
import { EmbedBuilder } from "discord.js";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { ensureMember } from "./state.js";
import { resolveTeam, type ResolvedSlot } from "./team.js";
import {
  TEAM_SIZE,
  simulate,
  teamStats,
  type MatchResult,
  type Role,
  type RoundLog,
  type Unit,
} from "./battle.js";

export type BattleQuota = { ok: true } | { ok: false; retryAt: Date };

/**
 * Consumes one challenge from the hourly allowance.
 *
 * Same single-statement shape as `consumeRoll`: reading the counter, checking
 * it, then writing back leaves a window where two concurrent challenges both
 * pass. `clock_timestamp()` rather than `now()` for the same reason as the roll
 * quota — `now()` is transaction start time, so a statement that waited on a
 * lock compares against a stale clock.
 */
export async function consumeBattle(
  userId: string,
  guildId: string,
  battlesPerHour: number,
): Promise<BattleQuota> {
  await ensureMember(userId, guildId);

  const rows = await db.execute(sql`
    UPDATE member_state SET
      battles_used = CASE
        WHEN battles_reset_at IS NULL OR battles_reset_at <= clock_timestamp() THEN 1
        ELSE battles_used + 1 END,
      battles_reset_at = CASE
        WHEN battles_reset_at IS NULL OR battles_reset_at <= clock_timestamp()
          THEN clock_timestamp() + interval '1 hour'
        ELSE battles_reset_at END
    WHERE user_id = ${userId}
      AND guild_id = ${guildId}
      AND (
        battles_reset_at IS NULL
        OR battles_reset_at <= clock_timestamp()
        OR battles_used + 1 <= ${battlesPerHour}::int
      )
    RETURNING battles_used
  `);

  if (rows.length > 0) return { ok: true };

  const state = await ensureMember(userId, guildId);
  return {
    ok: false,
    retryAt: state.battlesResetAt ?? new Date(Date.now() + 60 * 60 * 1000),
  };
}

export interface ChallengeOutcome {
  result: MatchResult;
  challenger: { slots: ResolvedSlot[]; owned: number; units: Unit[] };
  defender: { slots: ResolvedSlot[]; owned: number; units: Unit[] };
  winnerId: string;
  matchId: number;
}

/**
 * Runs a challenge and records it.
 *
 * The seed is derived from the match row's own id, so it is stable, unique per
 * match, and reproducible without needing a clock — replaying a stored match
 * means feeding the same rosters and seed back into `simulate`.
 */
export async function runChallenge(
  guildId: string,
  challengerId: string,
  defenderId: string,
  /** Pass a transaction so a wagered fight and its payout commit together. */
  tx: Pick<typeof db, "insert" | "update"> = db,
): Promise<ChallengeOutcome> {
  const [challenger, defender] = await Promise.all([
    resolveTeam(guildId, challengerId),
    resolveTeam(guildId, defenderId),
  ]);

  const challengerUnits = challenger.slots.map((s) => s.unit);
  const defenderUnits = defender.slots.map((s) => s.unit);

  const challengerCards = challenger.slots.map((s) => s.card?.cardId ?? "recruit");
  const defenderCards = defender.slots.map((s) => s.card?.cardId ?? "recruit");

  // Insert first to get an id, then use it as the seed and write back the
  // outcome. One row, one seed, no clock involved.
  const [row] = await tx
    .insert(schema.matches)
    .values({
      guildId,
      challengerId,
      defenderId,
      challengerCards,
      defenderCards,
      seed: 0,
      winnerId: "",
      rounds: 0,
    })
    .returning({ id: schema.matches.id });

  const matchId = row!.id;
  // `b` is the defender inside the simulator, which is where the defender
  // advantage is applied.
  const result = simulate(challengerUnits, defenderUnits, matchId);
  const winnerId = result.winner === "a" ? challengerId : defenderId;

  await tx
    .update(schema.matches)
    .set({ seed: matchId, winnerId, rounds: result.rounds.length })
    .where(eq(schema.matches.id, matchId));

  return {
    result,
    challenger: { ...challenger, units: challengerUnits },
    defender: { ...defender, units: defenderUnits },
    winnerId,
    matchId,
  };
}

/**
 * Rough strength readout for a line-up, shown before a fight.
 *
 * Deliberately surfaced: unequal rosters resolve close to deterministically —
 * measured, a team at ~82% of another's stats still loses about 99% of the
 * time — so hiding the gap would just waste a challenge. Until matchmaking
 * exists, showing the numbers is what lets people pick fair fights.
 */
export function teamPower(units: readonly Unit[]): number {
  const s = teamStats(units);
  return Math.round(s.hp + s.dmg * 4 + s.mit * 2 + s.heal * 3);
}

export interface BattleRecord {
  wins: number;
  losses: number;
}

export async function battleRecord(guildId: string, userId: string): Promise<BattleRecord> {
  const [row] = await db
    .select({
      wins: sql<number>`COUNT(*) FILTER (WHERE ${schema.matches.winnerId} = ${userId})::int`,
      total: sql<number>`COUNT(*)::int`,
    })
    .from(schema.matches)
    .where(
      and(
        eq(schema.matches.guildId, guildId),
        sql`(${schema.matches.challengerId} = ${userId} OR ${schema.matches.defenderId} = ${userId})`,
      ),
    );
  const wins = Number(row?.wins ?? 0);
  const total = Number(row?.total ?? 0);
  return { wins, losses: total - wins };
}

/** Most recent matches in a guild, for a history view. */
export async function recentMatches(guildId: string, limit = 5) {
  return db
    .select({
      id: schema.matches.id,
      challengerId: schema.matches.challengerId,
      defenderId: schema.matches.defenderId,
      winnerId: schema.matches.winnerId,
      rounds: schema.matches.rounds,
      createdAt: schema.matches.createdAt,
    })
    .from(schema.matches)
    .where(eq(schema.matches.guildId, guildId))
    .orderBy(desc(schema.matches.createdAt))
    .limit(limit);
}

/* ------------------------------------------------------------ rendering */

const ULT_NAMES: Record<Role, string> = {
  duelist: "Focus Fire",
  vanguard: "Bulwark",
  strategist: "Rally",
};

function ultLine(fired: Record<Role, number>): string {
  return (Object.keys(ULT_NAMES) as Role[])
    .filter((r) => fired[r] > 0)
    .map((r) => ULT_NAMES[r] + (fired[r] > 1 ? " x" + fired[r] : ""))
    .join(", ");
}

function roundLine(r: RoundLog, challenger: string, defender: string): string {
  const parts = ["`R" + r.round + "` " + Math.max(0, Math.round(r.aHp)) + " vs " + Math.max(0, Math.round(r.bHp))];
  const a = ultLine(r.aUlts);
  const b = ultLine(r.bUlts);
  if (a) parts.push("**" + challenger + "**: " + a);
  if (b) parts.push("**" + defender + "**: " + b);
  return parts.join(" | ");
}

/**
 * The battle report. Shared by instant and wagered fights so the two can never
 * drift into describing the same simulation differently.
 */
export function renderMatchEmbed(
  outcome: ChallengeOutcome,
  challengerName: string,
  defenderName: string,
  stakeLine?: string,
): EmbedBuilder {
  // `a` is always the challenger inside the simulator.
  const challengerWon = outcome.result.winner === "a";
  const log = outcome.result.rounds
    .map((r) => roundLine(r, challengerName, defenderName))
    .join("\n");

  const mvpCard =
    [...outcome.challenger.slots, ...outcome.defender.slots].find(
      (s) => s.card?.cardId === outcome.result.mvp?.cardId,
    )?.card ?? null;

  const embed = new EmbedBuilder()
    .setTitle(challengerName + " vs " + defenderName)
    .setColor(challengerWon ? 0x22c55e : 0xef4444)
    .setDescription(
      "**" + (challengerWon ? challengerName : defenderName) + " wins** in " +
        outcome.result.rounds.length + " round(s).\n\n" + log,
    )
    .addFields(
      {
        name: challengerName,
        value: "Power " + teamPower(outcome.challenger.units) + " | " + outcome.challenger.owned + "/" + TEAM_SIZE + " slots",
        inline: true,
      },
      {
        name: defenderName,
        value: "Power " + teamPower(outcome.defender.units) + " | " + outcome.defender.owned + "/" + TEAM_SIZE + " slots",
        inline: true,
      },
    );

  if (mvpCard) {
    embed.addFields({
      name: "MVP",
      value: mvpCard.hero + " - " + mvpCard.name + (mvpCard.rank > 1 ? " (R" + mvpCard.rank + ")" : ""),
      inline: true,
    });
  }

  if (stakeLine) embed.addFields({ name: "Stake", value: stakeLine });

  return embed;
}
