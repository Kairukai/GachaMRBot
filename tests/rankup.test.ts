/**
 * Burn / rank-up integration tests. These hit a real Postgres, because every
 * bug they cover lives at the database boundary — a stale prompt, a
 * double-clicked button, a trade landing mid-burn. Requires
 * `docker compose up -d` and a populated card pool.
 *
 *   npm test
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import { ensureGuild, ensureUser } from "../src/lib/state.js";
import { rankUp, RANK_COST, FODDER_VALUE } from "../src/lib/rankup.js";
import { sellAll } from "../src/lib/sell.js";
import { leaderboardTop, categoryStanding } from "../src/lib/leaderboard.js";
import type { Rarity } from "../src/lib/gacha.js";

const G = "test-guild-rankup";
const U = "test-user-burn-1";
const V = "test-user-burn-2";

async function reset() {
  await db.delete(schema.burns).where(eq(schema.burns.guildId, G));
  await db.delete(schema.claims).where(eq(schema.claims.guildId, G));
  await db.delete(schema.memberState).where(eq(schema.memberState.guildId, G));
  await db.delete(schema.guildSettings).where(eq(schema.guildSettings.id, G));
  await db.delete(schema.users).where(sql`${schema.users.id} LIKE 'test-user-burn-%'`);
}

/** Same reasoning as concurrency.test.ts: a root `before` hook raced the tests. */
const ready = (async () => {
  await reset();
  await ensureGuild(G);
  await ensureUser(U);
  await ensureUser(V);
})();

after(async () => {
  await reset();
  process.exit(0);
});

/** Real card ids from the pool, so foreign keys hold. */
async function cardsOf(rarity: Rarity, n: number, skip = 0): Promise<string[]> {
  const rows = await db
    .select({ id: schema.cards.id })
    .from(schema.cards)
    .where(eq(schema.cards.rarity, rarity))
    .orderBy(asc(schema.cards.id))
    .limit(n + skip);
  const ids = rows.slice(skip).map((r) => r.id);
  assert.ok(ids.length === n, `pool has too few ${rarity} cards — run npm run ingest`);
  return ids;
}

async function give(userId: string, cardIds: string[], rank = 1) {
  if (!cardIds.length) return;
  await db
    .insert(schema.claims)
    .values(cardIds.map((cardId) => ({ guildId: G, userId, cardId, rank })));
}

async function setShards(userId: string, shards: number) {
  await db.update(schema.users).set({ shards }).where(eq(schema.users.id, userId));
}

async function shardsOf(userId: string): Promise<number> {
  const [row] = await db
    .select({ shards: schema.users.shards })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  return row?.shards ?? 0;
}

async function rankOf(cardId: string): Promise<number | null> {
  const [row] = await db
    .select({ rank: schema.claims.rank })
    .from(schema.claims)
    .where(and(eq(schema.claims.guildId, G), eq(schema.claims.cardId, cardId)));
  return row?.rank ?? null;
}

async function ownedCount(userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.claims)
    .where(and(eq(schema.claims.guildId, G), eq(schema.claims.userId, userId)));
  return row?.n ?? 0;
}

/** Enough Rares to cover a rank-2 burn, with room to spare. */
async function fodderForRank2(skip = 0): Promise<string[]> {
  return cardsOf("rare", RANK_COST[2]!.points / FODDER_VALUE.rare, skip);
}

test("a valid burn ranks the card up and consumes exactly the fodder", async () => {
  await ready;
  await reset();
  await ensureGuild(G);
  await ensureUser(U);

  const [target] = await cardsOf("epic", 1);
  const fodder = await fodderForRank2();
  await give(U, [target!]);
  await give(U, fodder);
  await setShards(U, 10_000);

  const res = await rankUp(G, U, target!, fodder);
  assert.ok(res.ok, `expected success, got ${JSON.stringify(res)}`);
  assert.equal(res.fromRank, 1);
  assert.equal(res.toRank, 2);
  assert.equal(res.burned, fodder.length);
  assert.equal(res.shardsSpent, RANK_COST[2]!.shards);

  assert.equal(await rankOf(target!), 2);
  // Only the target survives; fodder is gone and therefore back in the pool.
  assert.equal(await ownedCount(U), 1);
  assert.equal(await shardsOf(U), 10_000 - RANK_COST[2]!.shards);

  const ledger = await db.select().from(schema.burns).where(eq(schema.burns.guildId, G));
  assert.equal(ledger.length, 1);
  assert.deepEqual(ledger[0]!.fodderCardIds, fodder);
});

test("fodder traded away between prompt and confirm aborts the whole burn", async () => {
  await ready;
  await reset();
  await ensureGuild(G);
  await ensureUser(U);
  await ensureUser(V);

  const [target] = await cardsOf("epic", 1);
  const fodder = await fodderForRank2();
  await give(U, [target!]);
  await give(U, fodder);
  await setShards(U, 10_000);

  // The prompt was built with all of it; one card moves on before Confirm.
  await db
    .update(schema.claims)
    .set({ userId: V })
    .where(and(eq(schema.claims.guildId, G), eq(schema.claims.cardId, fodder[0]!)));

  const res = await rankUp(G, U, target!, fodder);
  assert.ok(!res.ok);
  assert.equal(res.failure.code, "fodder_missing");

  // Nothing may have been consumed — not the rank, not the shards, not a card.
  assert.equal(await rankOf(target!), 1);
  assert.equal(await shardsOf(U), 10_000);
  assert.equal(await ownedCount(U), fodder.length); // target + rest, minus the traded one
});

test("a second click burns nothing (the DELETE count is the idempotency guard)", async () => {
  await ready;
  await reset();
  await ensureGuild(G);
  await ensureUser(U);

  const [target] = await cardsOf("epic", 1);
  const fodder = await fodderForRank2();
  await give(U, [target!]);
  await give(U, fodder);
  await setShards(U, 10_000);

  const first = await rankUp(G, U, target!, fodder);
  assert.ok(first.ok);

  const second = await rankUp(G, U, target!, fodder);
  assert.ok(!second.ok);
  assert.equal(second.failure.code, "fodder_missing");

  assert.equal(await rankOf(target!), 2, "double click applied two ranks");
  assert.equal(await shardsOf(U), 10_000 - RANK_COST[2]!.shards, "charged twice");
});

test("concurrent burns on the same target settle to exactly one rank", async () => {
  await ready;
  await reset();
  await ensureGuild(G);
  await ensureUser(U);

  const [target] = await cardsOf("epic", 1);
  const setA = await fodderForRank2(0);
  const setB = await fodderForRank2(setA.length);
  await give(U, [target!]);
  await give(U, [...setA, ...setB]);
  await setShards(U, 10_000);

  // Disjoint fodder, same target: the rank-scoped UPDATE must let only one win.
  const [a, b] = await Promise.all([
    rankUp(G, U, target!, setA),
    rankUp(G, U, target!, setB),
  ]);

  const wins = [a, b].filter((r) => r.ok).length;
  assert.equal(wins, 1, `expected exactly one winner, got ${wins}`);
  assert.equal(await rankOf(target!), 2);
  assert.equal(await shardsOf(U), 10_000 - RANK_COST[2]!.shards);
  // The loser's fodder must survive intact.
  assert.equal(await ownedCount(U), 1 + setA.length);
});

test("insufficient shards leaves the cards untouched", async () => {
  await ready;
  await reset();
  await ensureGuild(G);
  await ensureUser(U);

  const [target] = await cardsOf("epic", 1);
  const fodder = await fodderForRank2();
  await give(U, [target!]);
  await give(U, fodder);
  await setShards(U, RANK_COST[2]!.shards - 1);

  const res = await rankUp(G, U, target!, fodder);
  assert.ok(!res.ok);
  assert.equal(res.failure.code, "insufficient_shards");
  assert.equal(await ownedCount(U), 1 + fodder.length, "fodder was destroyed anyway");
  assert.equal(await shardsOf(U), RANK_COST[2]!.shards - 1);
});

test("too few points is refused before anything is spent", async () => {
  await ready;
  await reset();
  await ensureGuild(G);
  await ensureUser(U);

  const [target] = await cardsOf("epic", 1);
  const fodder = await cardsOf("rare", 2);
  await give(U, [target!]);
  await give(U, fodder);
  await setShards(U, 10_000);

  const res = await rankUp(G, U, target!, fodder);
  assert.ok(!res.ok);
  assert.equal(res.failure.code, "insufficient_points");
  assert.equal(await shardsOf(U), 10_000);
  assert.equal(await ownedCount(U), 1 + fodder.length);
});

test("a ranked card cannot be used as fodder", async () => {
  await ready;
  await reset();
  await ensureGuild(G);
  await ensureUser(U);

  const [target, invested] = await cardsOf("epic", 2);
  const fodder = await fodderForRank2();
  await give(U, [target!]);
  await give(U, [invested!], 6); // weeks of work — must not be burnable
  await give(U, fodder);
  await setShards(U, 10_000);

  const res = await rankUp(G, U, target!, [...fodder, invested!]);
  assert.ok(!res.ok);
  assert.equal(res.failure.code, "fodder_ranked");
  assert.equal(await rankOf(invested!), 6);
});

test("a Rare target is refused, and the target can't be its own fodder", async () => {
  await ready;
  await reset();
  await ensureGuild(G);
  await ensureUser(U);

  const rares = await cardsOf("rare", 9);
  const target = rares[0]!;
  await give(U, rares);
  await setShards(U, 10_000);

  const notRankable = await rankUp(G, U, target, rares.slice(1));
  assert.ok(!notRankable.ok);
  assert.equal(notRankable.failure.code, "target_not_rankable");

  const selfFeed = await rankUp(G, U, target, rares);
  assert.ok(!selfFeed.ok);
  assert.equal(selfFeed.failure.code, "target_in_fodder");
});

test("ranking past 5 requires Legendary fodder", async () => {
  await ready;
  await reset();
  await ensureGuild(G);
  await ensureUser(U);

  const [target] = await cardsOf("epic", 1);
  await give(U, [target!], 4); // one step below the first Legendary gate
  await setShards(U, 20_000);

  const plenty = await cardsOf("rare", RANK_COST[5]!.points);
  await give(U, plenty);

  const noLegendary = await rankUp(G, U, target!, plenty);
  assert.ok(!noLegendary.ok);
  assert.equal(noLegendary.failure.code, "insufficient_legendaries");
  assert.equal(await rankOf(target!), 4);

  const [legendary] = await cardsOf("legendary", 1);
  await give(U, [legendary!]);
  const withLegendary = await rankUp(G, U, target!, [...plenty, legendary!]);
  assert.ok(withLegendary.ok, JSON.stringify(withLegendary));
  assert.equal(await rankOf(target!), 5);
});

test("rank survives a trade and dies on a sell", async () => {
  await ready;
  await reset();
  await ensureGuild(G);
  await ensureUser(U);
  await ensureUser(V);

  const [card] = await cardsOf("legendary", 1);
  await give(U, [card!], 7);

  // A trade moves ownership with an UPDATE, so the row — and its rank — persist.
  await db
    .update(schema.claims)
    .set({ userId: V })
    .where(and(eq(schema.claims.guildId, G), eq(schema.claims.cardId, card!)));
  assert.equal(await rankOf(card!), 7, "rank did not survive a trade");

  // Selling deletes the row, so the card returns to the pool unranked.
  await db
    .delete(schema.claims)
    .where(and(eq(schema.claims.guildId, G), eq(schema.claims.cardId, card!)));
  assert.equal(await rankOf(card!), null);

  await give(V, [card!]);
  assert.equal(await rankOf(card!), 1, "re-claimed card kept an old rank");
});

test("bulk sell never destroys a ranked card", async () => {
  await ready;
  await reset();
  await ensureGuild(G);
  await ensureUser(U);

  const epics = await cardsOf("epic", 3);
  const [invested, ...spares] = epics;
  await give(U, [invested!], 8);
  await give(U, spares);
  await setShards(U, 0);

  const res = await sellAll(G, U, "epic");
  assert.equal(res.sold, spares.length, "sold the wrong number of cards");
  assert.equal(await rankOf(invested!), 8, "a ranked card was bulk-sold");
  for (const id of spares) assert.equal(await rankOf(id), null);
});

test("leaderboard categories read the rank and burn data", async () => {
  await ready;
  await reset();
  await ensureGuild(G);
  await ensureUser(U);
  await ensureUser(V);

  const [target] = await cardsOf("epic", 1);
  const fodder = await fodderForRank2();
  await give(U, [target!]);
  await give(U, fodder);
  await setShards(U, 10_000);
  assert.ok((await rankUp(G, U, target!, fodder)).ok);

  // A second collector with cards but no ranks, to prove filtering works.
  await give(V, await cardsOf("rare", 3, fodder.length));

  const byRank = await leaderboardTop(G, "rank");
  assert.equal(byRank.length, 1, "only ranked collections should appear");
  assert.equal(byRank[0]!.userId, U);
  assert.equal(byRank[0]!.score, 2);

  const byBurned = await leaderboardTop(G, "burned");
  assert.equal(byBurned[0]!.userId, U);
  assert.equal(byBurned[0]!.score, fodder.length);

  const byCards = await leaderboardTop(G, "cards");
  assert.equal(byCards.length, 2);

  // Aggregates arrive as strings from Postgres; a missed cast shows up here.
  for (const row of [...byRank, ...byBurned, ...byCards]) {
    assert.equal(typeof row.score, "number", `${row.userId} score was not a number`);
  }

  const standing = await categoryStanding(G, "rank", U);
  assert.deepEqual(standing, { rank: 1, score: 2 });
  assert.equal(await categoryStanding(G, "rank", V), null);
});

test("the database refuses a rank outside the ladder", async () => {
  await ready;
  await reset();
  await ensureGuild(G);
  await ensureUser(U);

  const [card] = await cardsOf("legendary", 1);
  await give(U, [card!]);
  /**
   * The constraint name is on the driver error, which drizzle wraps — its own
   * message is only the failed query text. Walk the cause chain rather than
   * matching on a message that doesn't contain the constraint at all.
   */
  const constraintOf = (err: unknown): string | undefined => {
    for (let e = err; e; e = (e as { cause?: unknown }).cause) {
      const name = (e as { constraint_name?: string }).constraint_name;
      if (name) return name;
    }
    return undefined;
  };

  await assert.rejects(
    () =>
      db
        .update(schema.claims)
        .set({ rank: 11 })
        .where(and(eq(schema.claims.guildId, G), eq(schema.claims.cardId, card!))),
    (err: unknown) => constraintOf(err) === "claims_rank_range",
    "the CHECK constraint is not enforcing the ladder",
  );
});
