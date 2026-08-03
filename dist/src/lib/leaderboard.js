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
const valueCase = sql `CASE
  WHEN ${schema.cards.rarity} = 'rare' THEN ${SELL_VALUE.rare}
  WHEN ${schema.cards.rarity} = 'epic' THEN ${SELL_VALUE.epic}
  WHEN ${schema.cards.rarity} = 'legendary' THEN ${SELL_VALUE.legendary}
  ELSE 0 END`;
const countOf = (r) => sql `COUNT(*) FILTER (WHERE ${schema.cards.rarity} = ${r})`;
export async function collectorCount(guildId) {
    const [row] = await db
        .select({ members: countDistinct(schema.claims.userId) })
        .from(schema.claims)
        .where(eq(schema.claims.guildId, guildId));
    return row?.members ?? 0;
}
export async function leaderboardPage(guildId, offset) {
    const rows = await db
        .select({
        userId: schema.claims.userId,
        total: sql `COUNT(*)`,
        rare: countOf("rare"),
        epic: countOf("epic"),
        legendary: countOf("legendary"),
        value: sql `SUM(${valueCase})`,
    })
        .from(schema.claims)
        .innerJoin(schema.cards, eq(schema.claims.cardId, schema.cards.id))
        .where(eq(schema.claims.guildId, guildId))
        .groupBy(schema.claims.userId)
        .orderBy(sql `SUM(${valueCase}) DESC, COUNT(*) DESC`)
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
export async function memberRank(guildId, userId) {
    const rows = await db.execute(sql `
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
    const row = rows[0];
    return row ? { rank: Number(row.rank), value: Number(row.value) } : null;
}
//# sourceMappingURL=leaderboard.js.map