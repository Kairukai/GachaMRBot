/**
 * Wagered challenges. Integration tests — every case here is about a stake
 * moving, or deliberately not moving, at the database boundary. Requires
 * `docker compose up -d`.
 *
 *   npm test
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import { ensureGuild, ensureUser } from "../src/lib/state.js";
import { setTeam } from "../src/lib/team.js";
import { createChallenge, settleChallenge, closeChallenge } from "../src/lib/wager.js";
import { TEAM_SIZE } from "../src/lib/battle.js";
import type { Rarity } from "../src/lib/gacha.js";

const G = "test-guild-wager";
const U = "test-user-wager-1";
const V = "test-user-wager-2";

async function reset() {
  await db.delete(schema.challenges).where(eq(schema.challenges.guildId, G));
  await db.delete(schema.matches).where(eq(schema.matches.guildId, G));
  await db.delete(schema.teamSlots).where(eq(schema.teamSlots.guildId, G));
  await db.delete(schema.claims).where(eq(schema.claims.guildId, G));
  await db.delete(schema.memberState).where(eq(schema.memberState.guildId, G));
  await db.delete(schema.guildSettings).where(eq(schema.guildSettings.id, G));
  await db.delete(schema.users).where(sql`${schema.users.id} LIKE 'test-user-wager-%'`);
}

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

/** One card per distinct single-role hero, so line-ups are legal. */
async function heroCards(rarity: Rarity, n: number, skip = 0): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (c.hero_id) c.id
    FROM cards c JOIN heroes h ON h.id = c.hero_id
    WHERE c.rarity = ${rarity} AND h.role NOT LIKE '%/%'
    ORDER BY c.hero_id, c.id
  `);
  const ids = (rows as unknown as { id: string }[]).map((r) => r.id).slice(skip, skip + n);
  assert.equal(ids.length, n, `pool has too few single-role ${rarity} heroes`);
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

async function totalShards(): Promise<number> {
  const rows = await db
    .select({ shards: schema.users.shards })
    .from(schema.users)
    .where(sql`${schema.users.id} IN (${U}, ${V})`);
  return rows.reduce((n, r) => n + r.shards, 0);
}

async function matchCount(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.matches)
    .where(eq(schema.matches.guildId, G));
  return Number(row?.n ?? 0);
}

/** Both players own a legal six-card line-up. */
async function bothTeamed() {
  await ready;
  await reset();
  await ensureGuild(G);
  await ensureUser(U);
  await ensureUser(V);

  const mine = await heroCards("rare", TEAM_SIZE);
  const theirs = await heroCards("rare", TEAM_SIZE, TEAM_SIZE);
  await give(U, mine);
  await give(V, theirs);
  assert.ok((await setTeam(G, U, mine.map((cardId) => ({ cardId })))).ok);
  assert.ok((await setTeam(G, V, theirs.map((cardId) => ({ cardId })))).ok);
}

test("a shard wager moves the stake and mints nothing", async () => {
  await bothTeamed();
  await setShards(U, 1000);
  await setShards(V, 1000);

  const created = await createChallenge(G, U, V, { kind: "shards", amount: 250 });
  assert.ok(created.ok);
  const settled = await settleChallenge(created.challengeId);
  assert.ok(settled.ok, JSON.stringify(settled));

  // Zero-sum: a wager must never inflate the economy.
  assert.equal(await totalShards(), 2000);

  const [winner] = await db
    .select({ shards: schema.users.shards })
    .from(schema.users)
    .where(eq(schema.users.id, settled.outcome.winnerId));
  assert.equal(winner!.shards, 1250);
});

test("a card wager transfers the prize with its rank intact", async () => {
  await bothTeamed();

  // Stakes sit outside both line-ups, and both carry a rank.
  const [myStake] = await heroCards("epic", 1);
  const [theirStake] = await heroCards("epic", 1, 1);
  await give(U, [myStake!], 4);
  await give(V, [theirStake!], 7);

  const created = await createChallenge(G, U, V, {
    kind: "card",
    challengerCardId: myStake!,
    defenderCardId: theirStake!,
  });
  assert.ok(created.ok);
  const settled = await settleChallenge(created.challengeId);
  assert.ok(settled.ok, JSON.stringify(settled));

  const prize = settled.prizeCardId!;
  const [claim] = await db
    .select({ userId: schema.claims.userId, rank: schema.claims.rank })
    .from(schema.claims)
    .where(and(eq(schema.claims.guildId, G), eq(schema.claims.cardId, prize)));

  assert.equal(claim!.userId, settled.outcome.winnerId, "prize did not move");
  // Rank rides along because the claim row is UPDATEd, never recreated.
  assert.equal(claim!.rank, prize === myStake ? 4 : 7);
});

test("a stake sold before acceptance aborts everything", async () => {
  await bothTeamed();
  const [myStake] = await heroCards("epic", 1);
  const [theirStake] = await heroCards("epic", 1, 1);
  await give(U, [myStake!]);
  await give(V, [theirStake!]);

  const created = await createChallenge(G, U, V, {
    kind: "card",
    challengerCardId: myStake!,
    defenderCardId: theirStake!,
  });
  assert.ok(created.ok);

  // Challenger sells the stake before the defender clicks Accept.
  await db
    .delete(schema.claims)
    .where(and(eq(schema.claims.guildId, G), eq(schema.claims.cardId, myStake!)));

  const settled = await settleChallenge(created.challengeId);
  assert.ok(!settled.ok);
  assert.equal(settled.failure.code, "stake_gone");

  // No fight recorded, and the surviving stake stayed put.
  assert.equal(await matchCount(), 0, "a match was recorded despite the abort");
  const [other] = await db
    .select({ userId: schema.claims.userId })
    .from(schema.claims)
    .where(and(eq(schema.claims.guildId, G), eq(schema.claims.cardId, theirStake!)));
  assert.equal(other!.userId, V);
});

test("shards spent before acceptance abort the wager", async () => {
  await bothTeamed();
  await setShards(U, 500);
  await setShards(V, 500);

  const created = await createChallenge(G, U, V, { kind: "shards", amount: 400 });
  assert.ok(created.ok);

  await setShards(V, 10);

  const settled = await settleChallenge(created.challengeId);
  assert.ok(!settled.ok);
  assert.equal(settled.failure.code, "shards_gone");
  assert.equal(await matchCount(), 0);
  assert.equal(await totalShards(), 510);
});

test("a double-clicked Accept settles exactly once", async () => {
  await bothTeamed();
  await setShards(U, 1000);
  await setShards(V, 1000);

  const created = await createChallenge(G, U, V, { kind: "shards", amount: 100 });
  assert.ok(created.ok);

  const [first, second] = await Promise.all([
    settleChallenge(created.challengeId),
    settleChallenge(created.challengeId),
  ]);

  assert.equal([first, second].filter((r) => r.ok).length, 1, "a wager settled twice");
  assert.equal(await totalShards(), 2000);
  assert.equal(await matchCount(), 1);
});

test("declining leaves both stakes untouched", async () => {
  await bothTeamed();
  await setShards(U, 800);
  await setShards(V, 800);

  const created = await createChallenge(G, U, V, { kind: "shards", amount: 300 });
  assert.ok(created.ok);
  await closeChallenge(created.challengeId, "declined");

  const settled = await settleChallenge(created.challengeId);
  assert.ok(!settled.ok);
  assert.equal(settled.failure.code, "not_pending");
  assert.equal(await totalShards(), 1600);
  assert.equal(await matchCount(), 0);
});

test("a second offer to the same player is refused while one is pending", async () => {
  await bothTeamed();
  await setShards(U, 1000);
  await setShards(V, 1000);

  assert.ok((await createChallenge(G, U, V, { kind: "shards", amount: 50 })).ok);
  const again = await createChallenge(G, U, V, { kind: "shards", amount: 50 });
  assert.ok(!again.ok);
  assert.equal(again.failure.code, "already_pending");
});

test("a wager nobody can cover is refused up front", async () => {
  await bothTeamed();
  await setShards(U, 10);
  await setShards(V, 1000);

  const created = await createChallenge(G, U, V, { kind: "shards", amount: 500 });
  assert.ok(!created.ok);
  assert.equal(created.failure.code, "insufficient_shards");

  const zero = await createChallenge(G, U, V, { kind: "shards", amount: 0 });
  assert.ok(!zero.ok);
  assert.equal(zero.failure.code, "stake_too_low");
});

test("staking a card you do not own is refused", async () => {
  await bothTeamed();
  const [notMine] = await heroCards("epic", 1);
  await give(V, [notMine!]);

  const created = await createChallenge(G, U, V, {
    kind: "card",
    challengerCardId: notMine!,
    defenderCardId: notMine!,
  });
  assert.ok(!created.ok);
  assert.equal(created.failure.code, "stake_not_owned");
});
