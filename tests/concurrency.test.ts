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
import { rollRarity, rates, type Rarity } from "../src/lib/gacha.js";
import { executeSwap } from "../src/lib/trade.js";
import { sellOne, sellAll } from "../src/lib/sell.js";
import { SELL_VALUE } from "../src/lib/gacha.js";
import { getShards, spendShards } from "../src/lib/state.js";
import { collectorCount, leaderboardPage, memberRank } from "../src/lib/leaderboard.js";
import { editV2Components } from "../src/lib/claim.js";
import { executeGive } from "../src/lib/give.js";
import { purchase, PRICE } from "../src/lib/shop.js";
import {
  ContainerBuilder,
  SectionBuilder,
  TextDisplayBuilder,
  ThumbnailBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

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

test("leaderboard ranks by collection value with correct breakdowns", async () => {
  await ready;
  await db.delete(schema.claims).where(eq(schema.claims.guildId, G));

  const pick = async (r: "rare" | "epic" | "legendary", n: number) =>
    db
      .select({ id: schema.cards.id })
      .from(schema.cards)
      .where(eq(schema.cards.rarity, r))
      .limit(n);

  const [rares, epics, legs] = await Promise.all([pick("rare", 6), pick("epic", 3), pick("legendary", 2)]);

  const RICH = "test-user-l1"; // 2 legendary + 1 epic = 300 + 35 = 335
  const MID = "test-user-l2"; //  2 epic              = 70
  const POOR = "test-user-l3"; // 5 rare              = 50
  for (const u of [RICH, MID, POOR]) await ensureMember(u, G);

  await db.insert(schema.claims).values([
    ...legs.map((c) => ({ guildId: G, userId: RICH, cardId: c.id })),
    { guildId: G, userId: RICH, cardId: epics[0]!.id },
    { guildId: G, userId: MID, cardId: epics[1]!.id },
    { guildId: G, userId: MID, cardId: epics[2]!.id },
    ...rares.slice(0, 5).map((c) => ({ guildId: G, userId: POOR, cardId: c.id })),
  ]);

  assert.equal(await collectorCount(G), 3);

  const rows = await leaderboardPage(G, 0);
  assert.deepEqual(
    rows.map((r) => r.userId),
    [RICH, MID, POOR],
    "should be ordered by value descending",
  );

  const top = rows[0]!;
  assert.equal(top.legendary, 2);
  assert.equal(top.epic, 1);
  assert.equal(top.rare, 0);
  assert.equal(top.total, 3);
  assert.equal(top.value, 2 * SELL_VALUE.legendary + SELL_VALUE.epic);

  assert.equal(rows[1]!.value, 2 * SELL_VALUE.epic);
  assert.equal(rows[2]!.value, 5 * SELL_VALUE.rare);

  // Ranks must agree with the page ordering.
  assert.equal((await memberRank(G, RICH))?.rank, 1);
  assert.equal((await memberRank(G, POOR))?.rank, 3);
  assert.equal(await memberRank(G, "test-user-nobody"), null);
});

test("a batch roll consumes all 5 or none", async () => {
  await ready;
  const u = "test-user-b1";
  await ensureMember(u, G);

  // Limit 12: two batches of 5 fit, the third must be refused outright.
  assert.equal((await consumeRoll(u, G, 0, 12, 5)).ok, true);
  assert.equal((await consumeRoll(u, G, 0, 12, 5)).ok, true);
  const third = await consumeRoll(u, G, 0, 12, 5);
  assert.equal(third.ok, false, "a partial batch must be refused, not clipped");

  const [st] = await db
    .select()
    .from(schema.memberState)
    .where(and(eq(schema.memberState.userId, u), eq(schema.memberState.guildId, G)));
  assert.equal(st!.rollsUsed, 10, "refused batch must not consume anything");

  // Single rolls still fit in the remaining 2.
  assert.equal((await consumeRoll(u, G, 0, 12, 1)).ok, true);
  assert.equal((await consumeRoll(u, G, 0, 12, 1)).ok, true);
  assert.equal((await consumeRoll(u, G, 0, 12, 1)).ok, false);
});

test("concurrent batch rolls cannot overdraw the quota", async () => {
  await ready;
  const u = "test-user-b2";
  await ensureMember(u, G);

  // 10 concurrent batches of 5 against a limit of 20 — only 4 may land.
  const results = await Promise.all(
    Array.from({ length: 10 }, () => consumeRoll(u, G, 0, 20, 5)),
  );
  assert.equal(results.filter((r) => r.ok).length, 4);

  const [st] = await db
    .select()
    .from(schema.memberState)
    .where(and(eq(schema.memberState.userId, u), eq(schema.memberState.guildId, G)));
  assert.equal(st!.rollsUsed, 20, "must never exceed the limit");
});

test("a claim retires only its own card's button in a V2 batch", () => {
  // Mirrors what /roll5 builds: one Container per card, each with its own row.
  const build = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      new ContainerBuilder()
        .setAccentColor(0x3b82f6)
        .addSectionComponents(
          new SectionBuilder()
            .addTextDisplayComponents(new TextDisplayBuilder().setContent(`### card ${i}`))
            .setThumbnailAccessory(new ThumbnailBuilder().setURL("https://example.com/a.png")),
        )
        .addActionRowComponents(
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId(`claim:card-${i}`)
              .setLabel("Claim")
              .setStyle(ButtonStyle.Success),
          ),
        )
        .toJSON(),
    );

  const raw = build(5) as any[];
  const edited = editV2Components(raw, {
    customId: "claim:card-2",
    claimedBy: "user-9",
    label: "Claimed",
  });
  assert.ok(edited, "edit should match a button");

  const buttonsOf = (c: any) =>
    c.components.filter((x: any) => x.type === 1).flatMap((r: any) => r.components);

  edited!.forEach((container: any, i: number) => {
    const [btn] = buttonsOf(container);
    if (i === 2) {
      assert.equal(btn.disabled, true, "clicked button must be retired");
      assert.equal(btn.label, "Claimed");
      const texts = container.components.filter((x: any) => x.type === 10);
      assert.ok(
        texts.some((t: any) => t.content.includes("user-9")),
        "claimed card should name its owner",
      );
    } else {
      assert.notEqual(btn.disabled, true, `card ${i} must stay claimable`);
      const texts = container.components.filter((x: any) => x.type === 10);
      assert.ok(
        !texts.some((t: any) => t.content.includes("user-9")),
        `card ${i} must not be marked claimed`,
      );
    }
  });

  // Expiry retires everything that's still live.
  const expired = editV2Components(edited as any[], { disableAll: true, label: "Expired" });
  assert.ok(expired);
  for (const c of expired as any[]) {
    for (const b of buttonsOf(c)) assert.equal(b.disabled, true);
  }

  // Nothing left to retire — a second expiry pass must report no change.
  assert.equal(
    editV2Components(expired as any[], { disableAll: true, label: "Expired" }),
    null,
  );
});

test("rollRarity only returns rarities that are actually available", () => {
  const pool: Rarity[] = ["rare", "legendary"];
  const seen = new Set<Rarity>();
  for (let i = 0; i < 20_000; i++) seen.add(rollRarity(pool));
  for (const r of seen) assert.ok(pool.includes(r), `rolled unavailable rarity ${r}`);
});

test("drop rates match the configured weights and sum to 100%", async () => {
  const pool: Rarity[] = ["rare", "epic", "legendary"];
  const table = rates(pool);

  assert.equal(table.rare, "72.00%");
  assert.equal(table.epic, "27.30%");
  assert.equal(table.legendary, "0.70%");

  const total = Object.values(table).reduce((s, v) => s + parseFloat(v!), 0);
  assert.ok(Math.abs(total - 100) < 0.01, `rates should sum to 100, got ${total}`);
});

test("rolls are independent — no pity, and the observed rate matches the advertised one", () => {
  const pool: Rarity[] = ["rare", "epic", "legendary"];
  const N = 400_000;
  let legendary = 0;
  for (let i = 0; i < N; i++) if (rollRarity(pool) === "legendary") legendary++;

  const observed = (legendary / N) * 100;
  assert.ok(
    Math.abs(observed - 0.7) < 0.1,
    `expected ~0.7% legendary with no pity, observed ${observed.toFixed(3)}%`,
  );
});

test("giving a card transfers it and only once", async () => {
  await ready;
  const A = "test-user-g1";
  const B = "test-user-g2";
  await ensureMember(A, G);
  await ensureMember(B, G);
  await db.delete(schema.claims).where(eq(schema.claims.guildId, G));

  const [card] = await db.select({ id: schema.cards.id }).from(schema.cards).limit(1);
  await db.insert(schema.claims).values({ guildId: G, userId: A, cardId: card!.id });

  assert.equal(await executeGive(G, A, B, card!.id), "ok");
  assert.equal(await ownerOf(card!.id), B, "card should now belong to the recipient");

  // A no longer owns it, so a second click must move nothing.
  assert.equal(await executeGive(G, A, B, card!.id), "not-owned");
  assert.equal(await ownerOf(card!.id), B);
});

test("concurrent gives of the same card only transfer once", async () => {
  await ready;
  const A = "test-user-g3";
  const B = "test-user-g4";
  const C = "test-user-g5";
  for (const u of [A, B, C]) await ensureMember(u, G);
  await db.delete(schema.claims).where(eq(schema.claims.guildId, G));

  const [card] = await db.select({ id: schema.cards.id }).from(schema.cards).limit(1);
  await db.insert(schema.claims).values({ guildId: G, userId: A, cardId: card!.id });

  const results = await Promise.all([
    executeGive(G, A, B, card!.id),
    executeGive(G, A, C, card!.id),
  ]);
  assert.equal(results.filter((r) => r === "ok").length, 1, "only one give may apply");

  const owner = await ownerOf(card!.id);
  assert.ok(owner === B || owner === C, "card must belong to exactly one recipient");
  assert.notEqual(owner, A);
});

test("buying credits debits shards and banks the purchase", async () => {
  await ready;
  const u = "test-user-p1";
  await ensureMember(u, G);
  await db.update(schema.users).set({ shards: 1500 }).where(eq(schema.users.id, u));

  const r = await purchase(G, u, "roll", 2);
  assert.ok(r.ok);
  assert.equal(r.ok && r.spent, 2 * PRICE.roll);
  assert.equal(await getShards(u), 1500 - 2 * PRICE.roll);
  assert.equal(r.ok && r.rolls, 2);

  // Not enough left for a claim (1000 > 1100 - 400 = ... check explicitly)
  const balance = await getShards(u);
  const poor = await purchase(G, u, "claim", 2);
  assert.equal(poor.ok, false, "must refuse when short");
  assert.equal(await getShards(u), balance, "a refused purchase spends nothing");
});

test("concurrent purchases cannot overdraw shards", async () => {
  await ready;
  const u = "test-user-p2";
  await ensureMember(u, G);
  await db.update(schema.users).set({ shards: PRICE.roll * 3 }).where(eq(schema.users.id, u));

  const results = await Promise.all(
    Array.from({ length: 6 }, () => purchase(G, u, "roll", 1)),
  );
  assert.equal(results.filter((r) => r.ok).length, 3, "only 3 may succeed");
  assert.equal(await getShards(u), 0);
});

test("banked rolls are spent only after the hourly allowance runs out", async () => {
  await ready;
  const u = "test-user-p3";
  await ensureMember(u, G);
  await db
    .update(schema.memberState)
    .set({ bonusRolls: 2, rollsUsed: 0, rollsResetAt: null })
    .where(and(eq(schema.memberState.userId, u), eq(schema.memberState.guildId, G)));

  const LIMIT = 3;
  for (let i = 0; i < LIMIT; i++) {
    assert.equal((await consumeRoll(u, G, 0, LIMIT)).ok, true, `free roll ${i + 1}`);
  }

  const [mid] = await db
    .select()
    .from(schema.memberState)
    .where(and(eq(schema.memberState.userId, u), eq(schema.memberState.guildId, G)));
  assert.equal(mid!.bonusRolls, 2, "free allowance must not touch banked rolls");

  // Allowance gone — the next two come out of the bank, then nothing.
  assert.equal((await consumeRoll(u, G, 0, LIMIT)).ok, true);
  assert.equal((await consumeRoll(u, G, 0, LIMIT)).ok, true);
  assert.equal((await consumeRoll(u, G, 0, LIMIT)).ok, false, "bank exhausted");

  const [end] = await db
    .select()
    .from(schema.memberState)
    .where(and(eq(schema.memberState.userId, u), eq(schema.memberState.guildId, G)));
  assert.equal(end!.bonusRolls, 0);
  assert.equal(end!.rollsUsed, LIMIT, "banked rolls must not inflate rolls_used");
});

test("banked claims extend the claim quota", async () => {
  await ready;
  const u = "test-user-p4";
  await ensureMember(u, G);
  await db
    .update(schema.memberState)
    .set({ bonusClaims: 1, claimsUsed: 0, claimsResetAt: null })
    .where(and(eq(schema.memberState.userId, u), eq(schema.memberState.guildId, G)));

  assert.equal((await consumeClaim(u, G, 1)).ok, true, "free claim");
  assert.equal((await consumeClaim(u, G, 1)).ok, true, "banked claim");
  assert.equal((await consumeClaim(u, G, 1)).ok, false, "nothing left");

  const [st] = await db
    .select()
    .from(schema.memberState)
    .where(and(eq(schema.memberState.userId, u), eq(schema.memberState.guildId, G)));
  assert.equal(st!.bonusClaims, 0);
});
