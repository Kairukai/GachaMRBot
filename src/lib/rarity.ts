import type { Rarity } from "./gacha.js";

/**
 * Shared by both ingest paths. In-game quality strings vary in casing across
 * sources and have appeared as numeric tier codes in datamined payloads.
 * Anything unrecognised returns null so the caller can report it rather than
 * silently bucketing an unknown skin into `default`.
 */
export function normaliseRarity(raw: unknown): Rarity | null {
  if (raw == null) return null;
  const v = String(raw).trim().toLowerCase();

  const byName: Record<string, Rarity> = {
    default: "default",
    common: "default",
    standard: "default",
    rare: "rare",
    uncommon: "rare",
    epic: "epic",
    legendary: "legendary",
    mythic: "mythic",
  };
  if (byName[v]) return byName[v];

  const n = v.match(/(\d+)/)?.[1];
  const byCode: Record<string, Rarity> = {
    "0": "default",
    "1": "rare",
    "2": "epic",
    "3": "legendary",
    "4": "mythic",
  };
  return n && byCode[n] ? byCode[n] : null;
}

/** Stable slug for hero ids when the source gives us a name rather than an id. */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
