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
import { executeSwap } from "../src/lib/trade.js";
import { sellOne, sellAll } from "../src/lib/sell.js";
import { SELL_VALUE } from "../src/lib/gacha.js";
import { getShards, spendShards } from "../src/lib/state.js";

const G = "test-guild-concurrency";
const U = "test-user-1";

async function reset() {
  await db.delete(schema.trades).where(eq(schema.trades.guildId, G));
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

/** Puts two cards in known hands and returns them with a pending trade. */
async function setupTrade(a: string, b: string) {
  const cards = await db.select({ id: schema.cards.id }).from(schema.cards).limit(2);
  const [c1, c2] = cards;
  await ensureMember(a, G);
  await ensureMember(b, G);
  await db.delete(schema.trades).where(eq(schema.trades.guildId, G));
  await db.delete(schema.claims).where(eq(schema.claims.guildId, G));
  await db.insert(schema.claims).values([
    { guildId: G, userId: a, cardId: c1!.id },
    { guildId: G, userId: b, cardId: c2!.id },
  ]);
  const [t] = await db
    .insert(schema.trades)
    .values({
      guildId: G,
      proposerId: a,
      receiverId: b,
      offerCardId: c1!.id,
      wantCardId: c2!.id,
    })
    .returning({ id: schema.trades.id });
  return { c1: c1!.id, c2: c2!.id, tradeId: t!.id };
}

async function ownerOf(cardId: string) {
  const [row] = await db
    .select({ userId: schema.claims.userId })
    .from(schema.claims)
    .where(and(eq(schema.claims.guildId, G), eq(schema.claims.cardId, cardId)));
  return row?.userId ?? null;
}

test("trade swaps ownership of both cards", async () => {
  await ready;
  const A = "test-user-t1";
  const B = "test-user-t2";
  const { c1, c2, tradeId } = await setupTrade(A, B);

  assert.equal(await executeSwap(tradeId), "ok");
  assert.equal(await ownerOf(c1), B, "offered card should move to the receiver");
  assert.equal(await ownerOf(c2), A, "wanted card should move to the proposer");
});

test("a stale trade fails without moving either card", async () => {
  await ready;
  const A = "test-user-t3";
  const B = "test-user-t4";
  const C = "test-user-t5";
  const { c1, c2, tradeId } = await setupTrade(A, B);

  // B gives the wanted card away before answering the offer.
  await ensureMember(C, G);
  await db
    .update(schema.claims)
    .set({ userId: C })
    .where(and(eq(schema.claims.guildId, G), eq(schema.claims.cardId, c2)));

  assert.equal(await executeSwap(tradeId), "ownership-changed");
  // The critical assertion: the proposer's card must NOT have moved.
  assert.equal(await ownerOf(c1), A, "offered card must stay put on failure");
  assert.equal(await ownerOf(c2), C);
});

test("a card in two trades can only be traded once", async () => {
  await ready;
  const A = "test-user-t6";
  const B = "test-user-t7";
  const { c1, c2, tradeId } = await setupTrade(A, B);

  // Second offer for the same pair — both are pending at once, which is allowed.
  const [t2] = await db
    .insert(schema.trades)
    .values({
      guildId: G,
      proposerId: A,
      receiverId: B,
      offerCardId: c1,
      wantCardId: c2,
    })
    .returning({ id: schema.trades.id });

  const results = await Promise.all([executeSwap(tradeId), executeSwap(t2!.id)]);
  assert.equal(results.filter((r) => r === "ok").length, 1, "exactly one swap applies");

  // Cards ended up swapped exactly once, not swapped back or duplicated.
  assert.equal(await ownerOf(c1), B);
  assert.equal(await ownerOf(c2), A);
});

test("selling a card pays out and releases it back to the pool", async () => {
  await ready;
  const U2 = "test-user-s1";
  await ensureMember(U2, G);
  await db.delete(schema.claims).where(eq(schema.claims.guildId, G));

  const [card] = await db
    .select({ id: schema.cards.id, rarity: schema.cards.rarity })
    .from(schema.cards)
    .where(eq(schema.cards.rarity, "epic"))
    .limit(1);
  await db.insert(schema.claims).values({ guildId: G, userId: U2, cardId: card!.id });

  const before = await getShards(U2);
  const res = await sellOne(G, U2, card!.id);

  assert.equal(res.sold, 1);
  assert.equal(res.shards, SELL_VALUE.epic);
  assert.equal(await getShards(U2), before + SELL_VALUE.epic);
  assert.equal(await ownerOf(card!.id), null, "card should be unowned again");
});

test("selling a card you no longer own pays nothing", async () => {
  await ready;
  const U2 = "test-user-s2";
  await ensureMember(U2, G);
  await db.delete(schema.claims).where(eq(schema.claims.guildId, G));

  const [card] = await db.select({ id: schema.cards.id }).from(schema.cards).limit(1);
  const before = await getShards(U2);

  // Never owned it.
  const res = await sellOne(G, U2, card!.id);
  assert.equal(res.sold, 0);
  assert.equal(await getShards(U2), before, "balance must not change");
});

test("double-clicking sell only pays once", async () => {
  await ready;
  const U2 = "test-user-s3";
  await ensureMember(U2, G);
  await db.delete(schema.claims).where(eq(schema.claims.guildId, G));

  const [card] = await db
    .select({ id: schema.cards.id })
    .from(schema.cards)
    .where(eq(schema.cards.rarity, "rare"))
    .limit(1);
  await db.insert(schema.claims).values({ guildId: G, userId: U2, cardId: card!.id });

  const before = await getShards(U2);
  const results = await Promise.all([
    sellOne(G, U2, card!.id),
    sellOne(G, U2, card!.id),
  ]);

  assert.equal(results.filter((r) => r.sold === 1).length, 1, "exactly one sale");
  assert.equal(await getShards(U2), before + SELL_VALUE.rare);
});

test("sellall pays for exactly the cards removed", async () => {
  await ready;
  const U2 = "test-user-s4";
  await ensureMember(U2, G);
  await db.delete(schema.claims).where(eq(schema.claims.guildId, G));

  const rares = await db
    .select({ id: schema.cards.id })
    .from(schema.cards)
    .where(eq(schema.cards.rarity, "rare"))
    .limit(5);
  const [epic] = await db
    .select({ id: schema.cards.id })
    .from(schema.cards)
    .where(eq(schema.cards.rarity, "epic"))
    .limit(1);

  await db.insert(schema.claims).values([
    ...rares.map((c) => ({ guildId: G, userId: U2, cardId: c.id })),
    { guildId: G, userId: U2, cardId: epic!.id },
  ]);

  const before = await getShards(U2);
  const res = await sellAll(G, U2, "rare");

  assert.equal(res.sold, rares.length);
  assert.equal(res.shards, rares.length * SELL_VALUE.rare);
  assert.equal(await getShards(U2), before + rares.length * SELL_VALUE.rare);
  // The epic must survive — sellall is scoped to one rarity.
  assert.equal(await ownerOf(epic!.id), U2, "other rarities must not be sold");
});

test("shards cannot be spent below zero", async () => {
  await ready;
  const U2 = "test-user-s5";
  await ensureMember(U2, G);
  await db.update(schema.users).set({ shards: 30 }).where(eq(schema.users.id, U2));

  // Two concurrent 25-shard rolls against a 30 balance: only one may succeed.
  const results = await Promise.all([spendShards(U2, 25), spendShards(U2, 25)]);
  assert.equal(results.filter(Boolean).length, 1, "only one spend may succeed");
  assert.equal(await getShards(U2), 5);
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
