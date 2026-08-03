import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";

const HOUR_MS = 60 * 60 * 1000;

export async function ensureUser(userId: string) {
  await db.insert(schema.users).values({ id: userId }).onConflictDoNothing();
}

export async function ensureGuild(guildId: string) {
  const [row] = await db
    .insert(schema.guildSettings)
    .values({ id: guildId })
    .onConflictDoUpdate({
      target: schema.guildSettings.id,
      // No-op update so we always get the row back in one round trip.
      set: { id: guildId },
    })
    .returning();
  return row!;
}

export async function ensureMember(userId: string, guildId: string) {
  await ensureUser(userId);
  await ensureGuild(guildId);
  const [row] = await db
    .insert(schema.memberState)
    .values({ userId, guildId })
    .onConflictDoUpdate({
      target: [schema.memberState.userId, schema.memberState.guildId],
      set: { userId },
    })
    .returning();
  return row!;
}

export type QuotaResult =
  | { ok: true }
  | { ok: false; reason: "cooldown" | "quota"; retryAt: Date };

/**
 * Consumes one roll if the user has budget. Window is a rolling hour that
 * starts on the first roll, so quotas refill predictably rather than on a
 * global clock everyone races.
 */
export async function consumeRoll(
  userId: string,
  guildId: string,
  cooldownSec: number,
  rollsPerHour: number,
): Promise<QuotaResult> {
  const state = await ensureMember(userId, guildId);
  const now = new Date();

  if (state.lastRollAt) {
    const ready = new Date(state.lastRollAt.getTime() + cooldownSec * 1000);
    if (ready > now) return { ok: false, reason: "cooldown", retryAt: ready };
  }

  const windowExpired = !state.rollsResetAt || state.rollsResetAt <= now;
  const used = windowExpired ? 0 : state.rollsUsed;
  const resetAt = windowExpired ? new Date(now.getTime() + HOUR_MS) : state.rollsResetAt!;

  if (used >= rollsPerHour) return { ok: false, reason: "quota", retryAt: resetAt };

  await db
    .update(schema.memberState)
    .set({ rollsUsed: used + 1, rollsResetAt: resetAt, lastRollAt: now })
    .where(
      and(
        eq(schema.memberState.userId, userId),
        eq(schema.memberState.guildId, guildId),
      ),
    );

  return { ok: true };
}

/** Checked at button-press time, not roll time — you can roll freely, claiming is the scarce act. */
export async function consumeClaim(
  userId: string,
  guildId: string,
  claimsPerHour: number,
): Promise<QuotaResult> {
  const state = await ensureMember(userId, guildId);
  const now = new Date();

  const windowExpired = !state.claimsResetAt || state.claimsResetAt <= now;
  const used = windowExpired ? 0 : state.claimsUsed;
  const resetAt = windowExpired ? new Date(now.getTime() + HOUR_MS) : state.claimsResetAt!;

  if (used >= claimsPerHour) return { ok: false, reason: "quota", retryAt: resetAt };

  await db
    .update(schema.memberState)
    .set({ claimsUsed: used + 1, claimsResetAt: resetAt })
    .where(
      and(
        eq(schema.memberState.userId, userId),
        eq(schema.memberState.guildId, guildId),
      ),
    );

  return { ok: true };
}

export async function bumpPity(userId: string, guildId: string, reset: boolean) {
  await db
    .update(schema.memberState)
    .set({ pity: reset ? 0 : sql`${schema.memberState.pity} + 1` })
    .where(
      and(
        eq(schema.memberState.userId, userId),
        eq(schema.memberState.guildId, guildId),
      ),
    );
}
