export type Rarity = "default" | "rare" | "epic" | "legendary" | "mythic";

/**
 * Weights sum to 100, so they read directly as percentages.
 *
 * The ladder is Rare / Epic / Legendary only — the wiki documents no base-skin
 * or Mythic costumes, and a tier with no articles behind it would be invented
 * rather than sourced. Both are pinned to 0 so that if such cards ever appear
 * they don't silently start dropping.
 *
 * Epic sits above Rare here, which inverts the usual ladder but matches supply:
 * Epic is roughly half the pool (246 of 498), Rare about a quarter.
 */
const BASE_WEIGHTS: Record<Rarity, number> = {
  default: 0,
  rare: 47,
  epic: 52.5,
  legendary: 0.5,
  mythic: 0,
};

export const RARITY_META: Record<Rarity, { label: string; color: number; emoji: string }> = {
  default: { label: "Default", color: 0x9aa0a6, emoji: "⚪" },
  rare: { label: "Rare", color: 0x3b82f6, emoji: "🔵" },
  epic: { label: "Epic", color: 0xa855f7, emoji: "🟣" },
  legendary: { label: "Legendary", color: 0xf59e0b, emoji: "🟡" },
  mythic: { label: "Mythic", color: 0xef4444, emoji: "🔴" },
};

/** Shards awarded when you claim a card someone in the server already owns. */
export const DUPLICATE_SHARDS: Record<Rarity, number> = {
  default: 1,
  rare: 3,
  epic: 10,
  legendary: 40,
  mythic: 150,
};

const SOFT_PITY_START = 50;
const HARD_PITY = 90;

/**
 * Weight multiplier applied to legendary/mythic as pity climbs. Flat until
 * SOFT_PITY_START, then ramps hard — the shape players read as "I'm due".
 */
function pityMultiplier(pity: number): number {
  if (pity < SOFT_PITY_START) return 1;
  return 1 + (pity - SOFT_PITY_START) * 0.6;
}

export function isHighTier(r: Rarity): boolean {
  return r === "legendary" || r === "mythic";
}

/**
 * Picks a rarity given the user's current pity counter.
 * At HARD_PITY a high tier is guaranteed.
 */
/**
 * Weights restricted to rarities that actually have cards, then renormalised.
 * The live pool is sourced from a wiki and currently has no Default or Mythic
 * costumes at all — hardcoding the full ladder would send ~55% of rolls at an
 * empty bucket. Passing the available set keeps the odds honest as the pool
 * changes underneath us.
 */
function weightsFor(pity: number, available?: readonly Rarity[]): (readonly [Rarity, number])[] {
  const mult = pityMultiplier(pity);
  const allowed = available?.length ? new Set(available) : null;
  const weights = (Object.keys(BASE_WEIGHTS) as Rarity[])
    .filter((r) => !allowed || allowed.has(r))
    .map((r) => [r, isHighTier(r) ? BASE_WEIGHTS[r] * mult : BASE_WEIGHTS[r]] as const);

  // Every configured rarity missing from the pool — caller has bigger problems,
  // but don't divide by zero.
  return weights.length ? weights : [["default", 1] as const];
}

export function rollRarity(
  pity: number,
  available?: readonly Rarity[],
  rng: () => number = Math.random,
): Rarity {
  const weights = weightsFor(pity, available);

  if (pity >= HARD_PITY) {
    const high = weights.filter(([r]) => isHighTier(r));
    if (high.length) {
      const total = high.reduce((s, [, w]) => s + w, 0);
      let roll = rng() * total;
      for (const [r, w] of high) {
        roll -= w;
        if (roll <= 0) return r;
      }
      return high[high.length - 1]![0];
    }
    // No high tier in the pool — fall through to the normal draw.
  }

  const total = weights.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [rar, w] of weights) {
    roll -= w;
    if (roll <= 0) return rar;
  }
  return weights[weights.length - 1]![0];
}

/** Human-readable odds for a `/rates` command, so the economy stays honest. */
export function ratesAt(
  pity: number,
  available?: readonly Rarity[],
): Partial<Record<Rarity, string>> {
  const weights = weightsFor(pity, available);
  const total = weights.reduce((sum, [, w]) => sum + w, 0);
  return Object.fromEntries(
    weights.map(([r, w]) => [r, `${((w / total) * 100).toFixed(2)}%`]),
  ) as Partial<Record<Rarity, string>>;
}

export { SOFT_PITY_START, HARD_PITY };
