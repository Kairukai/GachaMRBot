/**
 * Integration tests — these hit a real Postgres, because the bugs they cover
 * only exist at the database boundary. Requires `docker compose up -d`.
 *
 *   npm test
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import {
  ensureMember,
  consumeRoll,
  consumeClaim,
  refundClaim,
} from "../src/lib/state.js";
import { rollRarity, isHighTier, HARD_PITY, type Rarity } from "../src/lib/gacha.js";

const G = "test-guild-concurrency";
const U = "test-user-1";

async function reset() {
  await db.delete(schema.claims).where(eq(schema.claims.guildId, G));
  await db.delete(schema.memberState).where(eq(schema.memberState.guildId, G));
  await db.delete(schema.guildSettings).where(eq(schema.guildSettings.id, G));
  await db.delete(schema.users).where(sql`${schema.users.id} LIKE 'test-user-%'`);
}

/**
 * Setup is an awaited module-level promise rather than a `before` hook.
 * node:test did not reliably finish a root-level `before` before the first test
 * started, so the cleanup DELETEs raced the test's own INSERTs and produced a
 * spurious foreign-key failure. Awaiting an explicit promise makes the ordering
 * unambiguous.
 */
const ready = reset();

after(async () => {
  await reset();
  process.exit(0);
});

test("concurrent rolls cannot exceed the hourly quota", async () => {
  await ready;
  await ensureMember(U, G);
  const LIMIT = 5;

  // cooldown 0 so only the quota gates us
  const results = await Promise.all(
    Array.from({ length: 40 }, () => consumeRoll(U, G, 0, LIMIT)),
  );

  const granted = results.filter((r) => r.ok).length;
  assert.equal(granted, LIMIT, `expected exactly ${LIMIT} rolls granted, got ${granted}`);

  const [state] = await db
    .select()
    .from(schema.memberState)
    .where(and(eq(schema.memberState.userId, U), eq(schema.memberState.guildId, G)));
  assert.equal(state!.rollsUsed, LIMIT);
});

test("roll cooldown is enforced", async () => {
  await ready;
  const u = "test-user-cooldown";
  await ensureMember(u, G);

  const first = await consumeRoll(u, G, 3600, 100);
  assert.equal(first.ok, true);

  const second = await consumeRoll(u, G, 3600, 100);
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.reason, "cooldown");
});

test("concurrent claims cannot exceed the claim quota", async () => {
  await ready;
  const u = "test-user-claims";
  await ensureMember(u, G);

  const results = await Promise.all(
    Array.from({ length: 20 }, () => consumeClaim(u, G, 1)),
  );
  assert.equal(results.filter((r) => r.ok).length, 1);
});

test("only one user can own a card per guild, and losers are refunded", async () => {
  await ready;
  const [card] = await db.select({ id: schema.cards.id }).from(schema.cards).limit(1);
  assert.ok(card, "card pool is empty — run `npm run ingest` first");

  const users = ["test-user-a", "test-user-b", "test-user-c", "test-user-d"];
  for (const u of users) await ensureMember(u, G);

  // Everyone spends a claim, then races to insert.
  const outcomes = await Promise.all(
    users.map(async (u) => {
      const quota = await consumeClaim(u, G, 1);
      if (!quota.ok) return "no-quota";
      try {
        await db.insert(schema.claims).values({ guildId: G, userId: u, cardId: card!.id });
        return "won";
      } catch {
        await refundClaim(u, G);
        return "lost";
      }
    }),
  );

  assert.equal(outcomes.filter((o) => o === "won").length, 1, "exactly one winner");

  const rows = await db
    .select()
    .from(schema.claims)
    .where(and(eq(schema.claims.guildId, G), eq(schema.claims.cardId, card!.id)));
  assert.equal(rows.length, 1);

  // Losers got their claim back, so a lost race costs nothing.
  for (const [i, o] of outcomes.entries()) {
    if (o !== "lost") continue;
    const [st] = await db
      .select()
      .from(schema.memberState)
      .where(
        and(
          eq(schema.memberState.userId, users[i]!),
          eq(schema.memberState.guildId, G),
        ),
      );
    assert.equal(st!.claimsUsed, 0, `${users[i]} should have been refunded`);
  }
});

test("pity never exceeds the hard cap", () => {
  const pool: Rarity[] = ["rare", "epic", "legendary"];
  let pity = 0;
  let worst = 0;
  for (let i = 0; i < 200_000; i++) {
    const r = rollRarity(pity, pool);
    if (isHighTier(r)) {
      worst = Math.max(worst, pity);
      pity = 0;
    } else pity++;
  }
  assert.ok(worst <= HARD_PITY, `worst streak ${worst} exceeded hard pity ${HARD_PITY}`);
});

test("rollRarity only returns rarities that are actually available", () => {
  const pool: Rarity[] = ["rare", "legendary"];
  const seen = new Set<Rarity>();
  for (let i = 0; i < 20_000; i++) seen.add(rollRarity(i % 120, pool));
  for (const r of seen) assert.ok(pool.includes(r), `rolled unavailable rarity ${r}`);
});
