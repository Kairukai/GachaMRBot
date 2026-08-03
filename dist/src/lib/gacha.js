/**
 * Weights sum to 100, so they read directly as percentages.
 *
 * The ladder is Rare / Epic / Legendary only — the wiki documents no base-skin
 * or Mythic costumes, and a tier with no articles behind it would be invented
 * rather than sourced. Both are pinned to 0 so that if such cards ever appear
 * they don't silently start dropping.
 *
 * Strictly descending: each tier is rarer than the one below it. Note this runs
 * against supply — Epic is about half the card pool but only 26% of drops —
 * which is intentional. Rarity should describe how hard a card is to get, not
 * how many of them exist.
 *
 * There is no pity system: every roll is independent and these are the true
 * odds. A flat 0.7% Legendary averages one per ~143 rolls, with a long tail —
 * about half of players will go 100 rolls without one, and a quarter will go
 * 200. That's the tradeoff for honest, explainable odds and genuinely rare
 * Legendaries.
 */
const BASE_WEIGHTS = {
    default: 0,
    rare: 72,
    epic: 27.3,
    legendary: 0.7,
    mythic: 0,
};
export const RARITY_META = {
    default: { label: "Default", color: 0x9aa0a6, emoji: "⚪" },
    rare: { label: "Rare", color: 0x3b82f6, emoji: "🔵" },
    epic: { label: "Epic", color: 0xa855f7, emoji: "🟣" },
    legendary: { label: "Legendary", color: 0xf59e0b, emoji: "🟡" },
    mythic: { label: "Mythic", color: 0xef4444, emoji: "🔴" },
};
/** Shards awarded when you roll a card someone in the server already owns. */
export const DUPLICATE_SHARDS = {
    default: 1,
    rare: 3,
    epic: 10,
    legendary: 40,
    mythic: 150,
};
/**
 * Shards paid out for selling a card you own. Higher than the duplicate
 * consolation because you're giving the card up, not just seeing it.
 */
export const SELL_VALUE = {
    default: 2,
    rare: 10,
    epic: 35,
    legendary: 150,
    mythic: 500,
};
/**
 * Shard prices for `/buy`.
 *
 * These must stay above a roll's expected sell value (~17.8 shards:
 * 0.72×10 + 0.273×35 + 0.007×150) or players could farm infinite rolls by
 * cycling their collection. At 200 the margin is enormous, so the economy
 * drains hard — a bought roll costs the equivalent of 20 sold Rares.
 *
 * Claims are priced as the genuinely scarce resource: 1000 shards is 100 sold
 * Rares, or about seven Legendaries.
 */
export const ROLL_PRICE_SHARDS = 200;
export const CLAIM_PRICE_SHARDS = 1000;
/**
 * Weights restricted to rarities that actually have cards, then renormalised.
 * The live pool is sourced from a wiki and has no Default or Mythic costumes at
 * all — hardcoding the full ladder would send rolls at an empty bucket. Passing
 * the available set keeps the odds honest as the pool changes underneath us.
 */
function weightsFor(available) {
    const allowed = available?.length ? new Set(available) : null;
    const weights = Object.keys(BASE_WEIGHTS)
        .filter((r) => (!allowed || allowed.has(r)) && BASE_WEIGHTS[r] > 0)
        .map((r) => [r, BASE_WEIGHTS[r]]);
    // Every configured rarity missing from the pool — the caller has bigger
    // problems, but don't divide by zero.
    return weights.length ? weights : [["default", 1]];
}
/** Picks a rarity. Every roll is independent — there is no pity. */
export function rollRarity(available, rng = Math.random) {
    const weights = weightsFor(available);
    const total = weights.reduce((sum, [, w]) => sum + w, 0);
    let roll = rng() * total;
    for (const [rar, w] of weights) {
        roll -= w;
        if (roll <= 0)
            return rar;
    }
    return weights[weights.length - 1][0];
}
/** Human-readable odds for `/rates`, so the advertised numbers can't drift. */
export function rates(available) {
    const weights = weightsFor(available);
    const total = weights.reduce((sum, [, w]) => sum + w, 0);
    return Object.fromEntries(weights.map(([r, w]) => [r, `${((w / total) * 100).toFixed(2)}%`]));
}
//# sourceMappingURL=gacha.js.map