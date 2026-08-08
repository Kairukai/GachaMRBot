import { MAX_RANK } from "./battle.js";
const badges = new Map();
/** Call once the client is ready. Failure is non-fatal by design. */
export async function loadRankBadges(client) {
    try {
        const emojis = await client.application?.emojis.fetch();
        if (!emojis)
            return;
        for (const emoji of emojis.values()) {
            const match = /^rank(\d+)$/.exec(emoji.name ?? "");
            if (!match)
                continue;
            const rank = Number(match[1]);
            if (rank >= 1 && rank <= MAX_RANK)
                badges.set(rank, emoji.toString());
        }
        console.log(`loaded ${badges.size} rank badges`);
    }
    catch (err) {
        console.error("rank badges unavailable, falling back to text:", err);
    }
}
/**
 * Badge for a rank, or empty string for rank 1 and below.
 *
 * Rank 1 is deliberately unmarked: it is the default state of every card, so
 * badging it would put an emoji on every row of every collection and mean
 * nothing.
 */
export function rankBadge(rank) {
    if (!rank || rank <= 1)
        return "";
    return badges.get(rank) ?? `\`R${rank}\``;
}
/** Badge plus a space, for prefixing a card name without a stray gap at rank 1. */
export function rankPrefix(rank) {
    const badge = rankBadge(rank);
    return badge ? `${badge} ` : "";
}
//# sourceMappingURL=badges.js.map