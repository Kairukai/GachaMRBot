/**
 * Team building and 6v6 challenges. Integration tests — the interesting cases
 * are all about ownership changing underneath a saved line-up, which only
 * exists at the database boundary. Requires `docker compose up -d`.
 *
 *   npm test
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import { ensureGuild, ensureUser } from "../src/lib/state.js";
import { setTeam, resolveTeam, clearTeam, parseRoles } from "../src/lib/team.js";
import { consumeBattle, runChallenge, battleRecord, teamPower } from "../src/lib/challenge.js";
import { TEAM_SIZE } from "../src/lib/battle.js";
import type { Rarity } from "../src/lib/gacha.js";

const G = "test-guild-team";
const U = "test-user-team-1";
const V = "test-user-team-2";

async function reset() {
  await db.delete(schema.matches).where(eq(schema.matches.guildId, G));
  await db.delete(schema.teamSlots).where(eq(schema.teamSlots.guildId, G));
  await db.delete(schema.claims).where(eq(schema.claims.guildId, G));
  await db.delete(schema.memberState).where(eq(schema.memberState.guildId, G));
  await db.delete(schema.guildSettings).where(eq(schema.guildSettings.id, G));
  await db.delete(schema.users).where(sql`${schema.users.id} LIKE 'test-user-team-%'`);
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

/**
 * Real cards of a rarity whose heroes have exactly one role, one card per
 * distinct hero — which is what a legal line-up needs.
 */
async function distinctHeroCards(rarity: Rarity, n: number, skip = 0): Promise<string[]> {
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

/** Two Legendaries from different heroes that share one role, for the cap. */
async function legendariesSharingRole(): Promise<string[]> {
  const rows = await db.execute(sql`
    WITH one_per_hero AS (
      SELECT DISTINCT ON (c.hero_id) c.id, h.role
      FROM cards c JOIN heroes h ON h.id = c.hero_id
      WHERE c.rarity = 'legendary' AND h.role NOT LIKE '%/%'
      ORDER BY c.hero_id, c.id
    )
    SELECT id FROM one_per_hero
    WHERE role = (SELECT role FROM one_per_hero GROUP BY role HAVING COUNT(*) >= 2 LIMIT 1)
    ORDER BY id LIMIT 2
  `);
  const ids = (rows as unknown as { id: string }[]).map((r) => r.id);
  assert.equal(ids.length, 2, "pool has no two Legendary heroes sharing a role");
  return ids;
}

/** Two costumes of the SAME hero, for the duplicate-hero rule. */
async function sameHeroPair(): Promise<string[]> {
  const rows = await db.execute(sql`
    SELECT c.id FROM cards c
    WHERE c.hero_id = (
      SELECT hero_id FROM cards GROUP BY hero_id HAVING COUNT(*) >= 2 ORDER BY hero_id LIMIT 1
    )
    ORDER BY c.id LIMIT 2
  `);
  return (rows as unknown as { id: string }[]).map((r) => r.id);
}

async function give(userId: string, cardIds: string[], rank = 1) {
  if (!cardIds.length) return;
  await db
    .insert(schema.claims)
    .values(cardIds.map((cardId) => ({ guildId: G, userId, cardId, rank })));
}

async function fresh() {
  await ready;
  await reset();
  await ensureGuild(G);
  await ensureUser(U);
  await ensureUser(V);
}

test("parseRoles handles single and multi-role heroes", () => {
  assert.deepEqual(parseRoles("Duelist"), ["duelist"]);
  assert.deepEqual(parseRoles("Vanguard / Duelist / Strategist"), [
    "vanguard",
    "duelist",
    "strategist",
  ]);
  assert.deepEqual(parseRoles(null), []);
});

test("a legal six-card line-up saves", async () => {
  await fresh();
  const cards = await distinctHeroCards("rare", TEAM_SIZE);
  await give(U, cards);

  const res = await setTeam(G, U, cards.map((cardId) => ({ cardId })));
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.team.length, TEAM_SIZE);

  const { slots, owned } = await resolveTeam(G, U);
  assert.equal(owned, TEAM_SIZE);
  assert.equal(slots.length, TEAM_SIZE);
});

test("two costumes of the same hero are rejected", async () => {
  await fresh();
  const pair = await sameHeroPair();
  await give(U, pair);

  const res = await setTeam(G, U, pair.map((cardId) => ({ cardId })));
  assert.ok(!res.ok);
  assert.ok("violations" in res);
  assert.equal(res.violations[0]!.code, "duplicate_hero");
});

test("a third Epic and a second same-role Legendary are rejected", async () => {
  await fresh();
  const epics = await distinctHeroCards("epic", 3);
  await give(U, epics);
  const tooManyEpics = await setTeam(G, U, epics.map((cardId) => ({ cardId })));
  assert.ok(!tooManyEpics.ok);
  assert.ok("violations" in tooManyEpics);
  assert.equal(tooManyEpics.violations[0]!.code, "epic_cap");

  await fresh();
  // Two DIFFERENT Legendary heroes that share a role — the role is derived, so
  // this is the cap tripping rather than a bad declaration.
  const legends = await legendariesSharingRole();
  await give(U, legends);
  const sameRole = await setTeam(G, U, legends.map((cardId) => ({ cardId })));
  assert.ok(!sameRole.ok);
  assert.ok("violations" in sameRole);
  assert.ok(sameRole.violations.some((v) => v.code === "legendary_role_cap"));
});

test("wildcard_role only applies to the hero that needs it", async () => {
  await fresh();

  // The reported bug: including Deadpool forces you to supply wildcard_role,
  // and that role was then applied to EVERY slot — so every hero who didn't
  // happen to play it was rejected as if it were a wildcard too.
  const rows = await db.execute(sql`
    SELECT DISTINCT ON (c.hero_id) c.id, h.name, h.role
    FROM cards c JOIN heroes h ON h.id = c.hero_id
    WHERE h.role LIKE '%/%'
    ORDER BY c.hero_id, c.id LIMIT 1
  `);
  const multi = (rows as unknown as { id: string; name: string }[])[0];
  assert.ok(multi, "pool has no multi-role hero to test with");

  const others = await distinctHeroCards("rare", TEAM_SIZE - 1);
  await give(U, [multi.id, ...others]);

  const res = await setTeam(
    G,
    U,
    [multi.id, ...others].map((cardId) => ({ cardId, role: "duelist" as const })),
  );
  assert.ok(res.ok, `single global wildcard broke the line-up: ${JSON.stringify(res)}`);

  // The multi-role hero takes the declared role; everyone else keeps their own.
  const wild = res.team.find((c) => c.cardId === multi.id)!;
  assert.equal(wild.role, "duelist");
  const roles = new Set(res.team.map((c) => c.role));
  assert.ok(roles.size > 1, "every card was flattened onto the declared role");
});

test("a declared role is ignored for a hero with only one", async () => {
  await fresh();
  const [card] = await distinctHeroCards("rare", 1);
  await give(U, [card!]);

  const [row] = await db.execute(sql`
    SELECT h.role FROM cards c JOIN heroes h ON h.id = c.hero_id WHERE c.id = ${card!}
  `) as unknown as { role: string }[];
  const actual = parseRoles(row!.role)[0]!;
  const wrong = (["vanguard", "duelist", "strategist"] as const).find((r) => r !== actual)!;

  // `wildcard_role` is a single global option, not a per-card one, so a
  // declaration that contradicts an unambiguous hero is the user answering a
  // different question — take the hero's real role rather than rejecting them.
  const res = await setTeam(G, U, [{ cardId: card!, role: wrong }]);
  assert.ok(res.ok, JSON.stringify(res));
  assert.equal(res.team[0]!.role, actual);
});

test("cards you don't own are refused", async () => {
  await fresh();
  const cards = await distinctHeroCards("rare", 2);
  await give(U, [cards[0]!]);
  const res = await setTeam(G, U, cards.map((cardId) => ({ cardId })));
  assert.ok(!res.ok);
  assert.ok("notOwned" in res);
  assert.deepEqual(res.notOwned, [cards[1]]);
});

test("a card sold after saving becomes a recruit, not an error", async () => {
  await fresh();
  const cards = await distinctHeroCards("rare", TEAM_SIZE);
  await give(U, cards);
  assert.ok((await setTeam(G, U, cards.map((cardId) => ({ cardId })))).ok);

  // Sell one — the claim row disappears, the team row stays.
  await db
    .delete(schema.claims)
    .where(and(eq(schema.claims.guildId, G), eq(schema.claims.cardId, cards[0]!)));

  const { slots, owned } = await resolveTeam(G, U);
  assert.equal(owned, TEAM_SIZE - 1);
  assert.equal(slots[0]!.card, null);
  assert.equal(slots[0]!.unit.rarity, "recruit");
  assert.equal(slots[0]!.unit.role, null, "a recruit must not inherit a role");
});

test("a card traded away stops fighting for its old owner", async () => {
  await fresh();
  const cards = await distinctHeroCards("rare", TEAM_SIZE);
  await give(U, cards);
  assert.ok((await setTeam(G, U, cards.map((cardId) => ({ cardId })))).ok);

  await db
    .update(schema.claims)
    .set({ userId: V })
    .where(and(eq(schema.claims.guildId, G), eq(schema.claims.cardId, cards[1]!)));

  const { owned } = await resolveTeam(G, U);
  assert.equal(owned, TEAM_SIZE - 1);
});

test("an empty roster resolves to six recruits", async () => {
  await fresh();
  const { slots, owned } = await resolveTeam(G, U);
  assert.equal(owned, 0);
  assert.equal(slots.length, TEAM_SIZE);
  assert.ok(slots.every((s) => s.unit.rarity === "recruit"));
});

test("clear removes the line-up", async () => {
  await fresh();
  const cards = await distinctHeroCards("rare", 3);
  await give(U, cards);
  assert.ok((await setTeam(G, U, cards.map((cardId) => ({ cardId })))).ok);
  assert.equal(await clearTeam(G, U), 3);
  assert.equal((await resolveTeam(G, U)).owned, 0);
});

test("saving twice replaces rather than merges", async () => {
  await fresh();
  const cards = await distinctHeroCards("rare", TEAM_SIZE);
  await give(U, cards);
  assert.ok((await setTeam(G, U, cards.map((cardId) => ({ cardId })))).ok);
  assert.ok((await setTeam(G, U, [{ cardId: cards[0]! }])).ok);

  const { owned } = await resolveTeam(G, U);
  assert.equal(owned, 1, "old slots survived a re-save");
});

test("a challenge resolves, records a winner, and is reproducible", async () => {
  await fresh();
  const mine = await distinctHeroCards("rare", TEAM_SIZE);
  const theirs = await distinctHeroCards("rare", TEAM_SIZE, TEAM_SIZE);
  await give(U, mine);
  await give(V, theirs);
  assert.ok((await setTeam(G, U, mine.map((cardId) => ({ cardId })))).ok);
  assert.ok((await setTeam(G, V, theirs.map((cardId) => ({ cardId })))).ok);

  const outcome = await runChallenge(G, U, V);
  assert.ok([U, V].includes(outcome.winnerId));
  assert.ok(outcome.result.rounds.length > 0);

  const [row] = await db
    .select()
    .from(schema.matches)
    .where(eq(schema.matches.id, outcome.matchId));
  assert.equal(row!.winnerId, outcome.winnerId);
  // Seed is the match id, so a stored match can be replayed exactly.
  assert.equal(row!.seed, outcome.matchId);
  assert.equal(row!.rounds, outcome.result.rounds.length);
  assert.equal(row!.challengerCards.length, TEAM_SIZE);

  const record = await battleRecord(G, U);
  assert.equal(record.wins + record.losses, 1);
});

test("battles are rate limited per hour", async () => {
  await fresh();
  const limit = 3;
  for (let i = 0; i < limit; i++) {
    const q = await consumeBattle(U, G, limit);
    assert.ok(q.ok, `challenge ${i + 1} should have been allowed`);
  }
  const blocked = await consumeBattle(U, G, limit);
  assert.ok(!blocked.ok);
  assert.ok(blocked.retryAt instanceof Date);
});

test("a full team out-powers a mostly-empty one", async () => {
  await fresh();
  const cards = await distinctHeroCards("rare", TEAM_SIZE);
  await give(U, cards);
  await give(V, [cards[0]!].slice(0, 0)); // V owns nothing
  assert.ok((await setTeam(G, U, cards.map((cardId) => ({ cardId })))).ok);

  const full = await resolveTeam(G, U);
  const empty = await resolveTeam(G, V);
  assert.ok(
    teamPower(full.slots.map((s) => s.unit)) > teamPower(empty.slots.map((s) => s.unit)),
    "recruits should never out-power real cards",
  );
});
