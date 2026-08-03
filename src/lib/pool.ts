import { eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { Rarity } from "./gacha.js";

const TTL_MS = 5 * 60 * 1000;

let cache: { at: number; rarities: Rarity[] } | null = null;

/**
 * Rarities that currently have at least one rollable card. Cached because it
 * gates every roll but only changes when someone re-runs an ingest.
 */
export async function availableRarities(force = false): Promise<Rarity[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.rarities;

  const rows = await db
    .selectDistinct({ rarity: schema.cards.rarity })
    .from(schema.cards)
    .where(eq(schema.cards.rollable, true));

  cache = { at: Date.now(), rarities: rows.map((r) => r.rarity as Rarity) };
  return cache.rarities;
}
