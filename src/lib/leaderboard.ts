import { eq, sql, countDistinct } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { SELL_VALUE } from "./gacha.js";

export const PAGE_SIZE = 10;

/**
 * Collection value in SQL, built from the same SELL_VALUE table the sell
 * commands pay out from — the leaderboard can't disagree with what a collection
 * is actually worth. Summing here rather than in JS keeps ORDER BY and OFFSET
 * correct without loading every member's rows.
 */
const valueCase = sql`CASE
  WHEN ${schema.cards.rarity} = 'rare' THEN ${SELL_VALUE.rare}
  WHEN ${schema.cards.rarity} = 'epic' THEN ${SELL_VALUE.epic}
  WHEN ${schema.cards.rarity} = 'legendary' THEN ${SELL_VALUE.legendary}
  ELSE 0 END`;

const countOf = (r: "rare" | "epic" | "legendary") =>
  sql<number>`COUNT(*) FILTER (WHERE ${schema.cards.rarity} = ${r})`;

export interface LeaderRow {
  userId: string;
  total: number;
  rare: number;
  epic: number;
  legendary: number;
  value: number;
}

export async function collectorCount(guildId: string): Promise<number> {
  const [row] = await db
    .select({ members: countDistinct(schema.claims.userId) })
    .from(schema.claims)
    .where(eq(schema.claims.guildId, guildId));
  return row?.members ?? 0;
}

export async function leaderboardPage(
  guildId: string,
  offset: number,
): Promise<LeaderRow[]> {
  const rows = await db
    .select({
      userId: schema.claims.userId,
      total: sql<number>`COUNT(*)`,
      rare: countOf("rare"),
      epic: countOf("epic"),
      legendary: countOf("legendary"),
      value: sql<number>`SUM(${valueCase})`,
    })
    .from(schema.claims)
    .innerJoin(schema.cards, eq(schema.claims.cardId, schema.cards.id))
    .where(eq(schema.claims.guildId, guildId))
    .groupBy(schema.claims.userId)
    .orderBy(sql`SUM(${valueCase}) DESC, COUNT(*) DESC`)
    .limit(PAGE_SIZE)
    .offset(offset);

  // Postgres returns bigint aggregates as strings over the wire.
  return rows.map((r) => ({
    userId: r.userId,
    total: Number(r.total),
    rare: Number(r.rare),
    epic: Number(r.epic),
    legendary: Number(r.legendary),
    value: Number(r.value),
  }));
}

/** Where one member sits overall, so people off the visible page still know. */
export async function memberRank(guildId: string, userId: string) {
  const rows = await db.execute(sql`
    WITH totals AS (
      SELECT cl.user_id,
             SUM(CASE
               WHEN c.rarity = 'rare' THEN ${SELL_VALUE.rare}
               WHEN c.rarity = 'epic' THEN ${SELL_VALUE.epic}
               WHEN c.rarity = 'legendary' THEN ${SELL_VALUE.legendary}
               ELSE 0 END) AS value
      FROM claims cl
      JOIN cards c ON c.id = cl.card_id
      WHERE cl.guild_id = ${guildId}
      GROUP BY cl.user_id
    )
    SELECT rank, value FROM (
      SELECT user_id, value, RANK() OVER (ORDER BY value DESC) AS rank FROM totals
    ) ranked WHERE user_id = ${userId}
  `);
  const row = rows[0] as { rank: string | number; value: string | number } | undefined;
  return row ? { rank: Number(row.rank), value: Number(row.value) } : null;
}

/* ------------------------------------------------------- multi-category */

export type LeaderCategory = "value" | "cards" | "rank" | "burned";

export const CATEGORY_META: Record<
  LeaderCategory,
  { label: string; description: string; unit: string }
> = {
  value: { label: "Collection value", description: "Total sell value of everything owned", unit: "💠" },
  cards: { label: "Cards owned", description: "Raw collection size", unit: "cards" },
  rank: { label: "Highest rank", description: "Best single ranked card, then total ranks invested", unit: "" },
  burned: { label: "Cards burned", description: "Fodder fed into rank-ups", unit: "burned" },
};

export interface CategoryRow {
  userId: string;
  score: number;
  detail: string;
}

/**
 * Per-category aggregate, as a CTE producing (user_id, score, tiebreak, detail).
 *
 * Written as raw SQL rather than the query builder because `burned` reads from
 * a different table entirely, and because RANK() over the same expression is
 * what lets a member see their standing without paging to find themselves.
 *
 * `value` deliberately reuses the SELL_VALUE numbers, same as the paged
 * leaderboard above — three surfaces disagreeing about what a collection is
 * worth would be worse than having no leaderboard at all.
 */
function categorySource(guildId: string, category: LeaderCategory) {
  switch (category) {
    case "value":
      return sql`
        SELECT cl.user_id,
               SUM(CASE
                 WHEN c.rarity = 'rare' THEN ${SELL_VALUE.rare}
                 WHEN c.rarity = 'epic' THEN ${SELL_VALUE.epic}
                 WHEN c.rarity = 'legendary' THEN ${SELL_VALUE.legendary}
                 ELSE 0 END)::int AS score,
               COUNT(*)::int AS tiebreak,
               COUNT(*)::text || ' cards' AS detail
        FROM claims cl JOIN cards c ON c.id = cl.card_id
        WHERE cl.guild_id = ${guildId}
        GROUP BY cl.user_id`;
    case "cards":
      return sql`
        SELECT cl.user_id,
               COUNT(*)::int AS score,
               COUNT(*) FILTER (WHERE c.rarity = 'legendary')::int AS tiebreak,
               COUNT(*) FILTER (WHERE c.rarity = 'legendary')::text || ' Legendary, ' ||
               COUNT(*) FILTER (WHERE c.rarity = 'epic')::text || ' Epic' AS detail
        FROM claims cl JOIN cards c ON c.id = cl.card_id
        WHERE cl.guild_id = ${guildId}
        GROUP BY cl.user_id`;
    case "rank":
      // Only ranked cards count, so an untouched collection doesn't appear.
      return sql`
        SELECT cl.user_id,
               MAX(cl.rank)::int AS score,
               SUM(cl.rank - 1)::int AS tiebreak,
               SUM(cl.rank - 1)::text || ' ranks invested' AS detail
        FROM claims cl
        WHERE cl.guild_id = ${guildId}
        GROUP BY cl.user_id
        HAVING MAX(cl.rank) > 1`;
    case "burned":
      return sql`
        SELECT b.user_id,
               SUM(cardinality(b.fodder_card_ids))::int AS score,
               COUNT(*)::int AS tiebreak,
               COUNT(*)::text || ' rank-up(s)' AS detail
        FROM burns b
        WHERE b.guild_id = ${guildId}
        GROUP BY b.user_id`;
  }
}

export async function leaderboardTop(
  guildId: string,
  category: LeaderCategory,
  limit = PAGE_SIZE,
): Promise<CategoryRow[]> {
  const rows = await db.execute(sql`
    WITH totals AS (${categorySource(guildId, category)})
    SELECT user_id, score, detail FROM totals
    ORDER BY score DESC, tiebreak DESC
    LIMIT ${limit}
  `);
  // Aggregates come back as strings over the wire even when cast to int.
  return (rows as unknown as { user_id: string; score: string | number; detail: string }[]).map(
    (r) => ({ userId: r.user_id, score: Number(r.score), detail: r.detail }),
  );
}

/** Where one member sits in a category, so people off the top ten still know. */
export async function categoryStanding(
  guildId: string,
  category: LeaderCategory,
  userId: string,
): Promise<{ rank: number; score: number } | null> {
  const rows = await db.execute(sql`
    WITH totals AS (${categorySource(guildId, category)})
    SELECT rank, score FROM (
      SELECT user_id, score, RANK() OVER (ORDER BY score DESC, tiebreak DESC) AS rank
      FROM totals
    ) ranked WHERE user_id = ${userId}
  `);
  const row = rows[0] as { rank: string | number; score: string | number } | undefined;
  return row ? { rank: Number(row.rank), score: Number(row.score) } : null;
}
