import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
export async function ensureUser(userId) {
    await db.insert(schema.users).values({ id: userId }).onConflictDoNothing();
}
/**
 * Read first, insert only if missing. An `onConflictDoUpdate` that sets the row
 * to itself still writes a new tuple on every call, which churns dead tuples on
 * a table touched by every roll.
 */
export async function ensureGuild(guildId) {
    const [found] = await db
        .select()
        .from(schema.guildSettings)
        .where(eq(schema.guildSettings.id, guildId));
    if (found)
        return found;
    await db.insert(schema.guildSettings).values({ id: guildId }).onConflictDoNothing();
    const [row] = await db
        .select()
        .from(schema.guildSettings)
        .where(eq(schema.guildSettings.id, guildId));
    return row;
}
export async function ensureMember(userId, guildId) {
    const where = and(eq(schema.memberState.userId, userId), eq(schema.memberState.guildId, guildId));
    const [found] = await db.select().from(schema.memberState).where(where);
    if (found)
        return found;
    await ensureUser(userId);
    await ensureGuild(guildId);
    await db.insert(schema.memberState).values({ userId, guildId }).onConflictDoNothing();
    const [row] = await db.select().from(schema.memberState).where(where);
    return row;
}
/**
 * Why this is one statement: reading the counter, checking it, then writing
 * back leaves a window where two concurrent rolls both read the same value and
 * both pass. The WHERE clause makes the check and the increment atomic — if it
 * matches no row, the caller was over quota or on cooldown, and we only then
 * pay for a second query to find out which.
 *
 * These statements use clock_timestamp(), not now(). now() is the *transaction
 * start* time, so a statement that waited on another's row lock still compares
 * against its own older timestamp and can read a just-committed last_roll_at as
 * being in the future — rejecting a legitimate roll as "on cooldown".
 * clock_timestamp() is real wall-clock time, which is what a cooldown means.
 */
async function explainRollBlock(userId, guildId, cooldownSec) {
    const state = await ensureMember(userId, guildId);
    const now = Date.now();
    const ready = state.lastRollAt
        ? new Date(state.lastRollAt.getTime() + cooldownSec * 1000)
        : null;
    if (ready && ready.getTime() > now) {
        return { ok: false, reason: "cooldown", retryAt: ready };
    }
    return {
        ok: false,
        reason: "quota",
        retryAt: state.rollsResetAt ?? new Date(now + 60 * 60 * 1000),
    };
}
/**
 * Consumes `count` rolls, all or nothing. A batch that only partly fits the
 * remaining quota is rejected rather than clipped — half a `/roll5` would be
 * worse than a clear "not enough rolls".
 */
export async function consumeRoll(userId, guildId, cooldownSec, rollsPerHour, count = 1) {
    await ensureMember(userId, guildId);
    // Free allowance first, purchased credits only once it's gone. Both branches
    // live in one statement so the check and the spend stay atomic.
    const rows = await db.execute(sql `
    UPDATE member_state SET
      rolls_used = CASE
        WHEN rolls_reset_at IS NULL OR rolls_reset_at <= clock_timestamp() THEN ${count}::int
        WHEN rolls_used + ${count}::int <= ${rollsPerHour}::int THEN rolls_used + ${count}::int
        ELSE rolls_used END,
      bonus_rolls = CASE
        WHEN rolls_reset_at IS NULL OR rolls_reset_at <= clock_timestamp() THEN bonus_rolls
        WHEN rolls_used + ${count}::int <= ${rollsPerHour}::int THEN bonus_rolls
        ELSE bonus_rolls - ${count}::int END,
      rolls_reset_at = CASE
        WHEN rolls_reset_at IS NULL OR rolls_reset_at <= clock_timestamp()
          THEN clock_timestamp() + interval '1 hour'
        ELSE rolls_reset_at END,
      last_roll_at = clock_timestamp()
    WHERE user_id = ${userId}
      AND guild_id = ${guildId}
      AND (
        last_roll_at IS NULL
        OR last_roll_at + (${cooldownSec}::int * interval '1 second') <= clock_timestamp()
      )
      AND (
        rolls_reset_at IS NULL
        OR rolls_reset_at <= clock_timestamp()
        OR rolls_used + ${count}::int <= ${rollsPerHour}::int
        OR bonus_rolls >= ${count}::int
      )
    RETURNING rolls_used
  `);
    if (rows.length > 0)
        return { ok: true };
    return explainRollBlock(userId, guildId, cooldownSec);
}
/** Same atomicity argument as consumeRoll; claims are the scarcer resource. */
export async function consumeClaim(userId, guildId, claimsPerHour) {
    await ensureMember(userId, guildId);
    const rows = await db.execute(sql `
    UPDATE member_state SET
      claims_used = CASE
        WHEN claims_reset_at IS NULL OR claims_reset_at <= clock_timestamp() THEN 1
        WHEN claims_used < ${claimsPerHour}::int THEN claims_used + 1
        ELSE claims_used END,
      bonus_claims = CASE
        WHEN claims_reset_at IS NULL OR claims_reset_at <= clock_timestamp() THEN bonus_claims
        WHEN claims_used < ${claimsPerHour}::int THEN bonus_claims
        ELSE bonus_claims - 1 END,
      claims_reset_at = CASE
        WHEN claims_reset_at IS NULL OR claims_reset_at <= clock_timestamp()
          THEN clock_timestamp() + interval '1 hour'
        ELSE claims_reset_at END
    WHERE user_id = ${userId}
      AND guild_id = ${guildId}
      AND (
        claims_reset_at IS NULL
        OR claims_reset_at <= clock_timestamp()
        OR claims_used < ${claimsPerHour}::int
        OR bonus_claims >= 1
      )
    RETURNING claims_used
  `);
    if (rows.length > 0)
        return { ok: true };
    const state = await ensureMember(userId, guildId);
    return {
        ok: false,
        reason: "quota",
        retryAt: state.claimsResetAt ?? new Date(Date.now() + 60 * 60 * 1000),
    };
}
/** Refunds a claim when the insert loses the race, so a miss costs nothing. */
export async function refundClaim(userId, guildId) {
    await db
        .update(schema.memberState)
        .set({ claimsUsed: sql `greatest(${schema.memberState.claimsUsed} - 1, 0)` })
        .where(and(eq(schema.memberState.userId, userId), eq(schema.memberState.guildId, guildId)));
}
/**
 * Consolation for rolling a card that's already spoken for. Returns the new
 * balance so the caller can show it without a second query.
 */
export async function awardShards(userId, amount) {
    const [row] = await db
        .update(schema.users)
        .set({ shards: sql `${schema.users.shards} + ${amount}` })
        .where(eq(schema.users.id, userId))
        .returning({ shards: schema.users.shards });
    return row?.shards ?? 0;
}
/**
 * Deducts shards only if the balance covers it. Conditional UPDATE for the same
 * reason the roll quota is one — read-then-write lets two concurrent spends
 * both pass and drive the balance negative.
 */
export async function spendShards(userId, amount) {
    const rows = await db.execute(sql `
    UPDATE users SET shards = shards - ${amount}::int
    WHERE id = ${userId} AND shards >= ${amount}::int
    RETURNING shards
  `);
    return rows.length > 0;
}
export async function getShards(userId) {
    const [row] = await db
        .select({ shards: schema.users.shards })
        .from(schema.users)
        .where(eq(schema.users.id, userId));
    return row?.shards ?? 0;
}
//# sourceMappingURL=state.js.map