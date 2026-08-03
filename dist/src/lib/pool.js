import { and, eq, count } from "drizzle-orm";
import { db, schema } from "../db/index.js";
/**
 * Short TTL rather than explicit invalidation: the ingest runs as a separate
 * process, so it can't clear this bot's memory. A minute of staleness after an
 * ingest is the tradeoff for not querying on every roll.
 */
const TTL_MS = 60 * 1000;
let cache = null;
async function load() {
    const rows = await db
        .select({ rarity: schema.cards.rarity, n: count() })
        .from(schema.cards)
        .where(eq(schema.cards.rollable, true))
        .groupBy(schema.cards.rarity);
    return new Map(rows.filter((r) => r.n > 0).map((r) => [r.rarity, r.n]));
}
async function counts(force = false) {
    if (!force && cache && Date.now() - cache.at < TTL_MS)
        return cache.counts;
    cache = { at: Date.now(), counts: await load() };
    return cache.counts;
}
/** Rarities that currently have at least one rollable card. */
export async function availableRarities(force = false) {
    return [...(await counts(force)).keys()];
}
/** Drops the cache — useful in tests and after an in-process ingest. */
export function invalidatePool() {
    cache = null;
}
/**
 * Picks a random card of the given rarity.
 *
 * Uses a random OFFSET over the (rarity, rollable) index rather than
 * `ORDER BY random()`, which sorts the entire matching set on every roll. At a
 * few hundred cards the difference is academic; it stops being academic as the
 * pool grows each season.
 */
export async function randomCard(rarity) {
    const n = (await counts()).get(rarity) ?? 0;
    if (n === 0)
        return null;
    const offset = Math.floor(Math.random() * n);
    const [card] = await db
        .select({
        id: schema.cards.id,
        name: schema.cards.name,
        rarity: schema.cards.rarity,
        imageUrl: schema.cards.imageUrl,
        heroName: schema.heroes.name,
        heroRole: schema.heroes.role,
    })
        .from(schema.cards)
        .innerJoin(schema.heroes, eq(schema.cards.heroId, schema.heroes.id))
        .where(and(eq(schema.cards.rarity, rarity), eq(schema.cards.rollable, true)))
        .orderBy(schema.cards.id)
        .limit(1)
        .offset(offset);
    // Cache can lag a shrinking pool; fall back to the first row rather than
    // failing the roll outright.
    if (card)
        return card;
    invalidatePool();
    const [fallback] = await db
        .select({
        id: schema.cards.id,
        name: schema.cards.name,
        rarity: schema.cards.rarity,
        imageUrl: schema.cards.imageUrl,
        heroName: schema.heroes.name,
        heroRole: schema.heroes.role,
    })
        .from(schema.cards)
        .innerJoin(schema.heroes, eq(schema.cards.heroId, schema.heroes.id))
        .where(and(eq(schema.cards.rarity, rarity), eq(schema.cards.rollable, true)))
        .limit(1);
    return fallback ?? null;
}
//# sourceMappingURL=pool.js.map