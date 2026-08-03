/**
 * Pulls heroes + costumes from marvelrivalsapi.com into our own tables.
 *
 * Run this on a schedule (weekly is plenty — the roster moves per season).
 * The bot NEVER calls the upstream API at roll time; rolls hit Postgres only.
 *
 *   npm run ingest
 *   npm run ingest -- --dry    # print what would change, write nothing
 *
 * The upstream costume payload is not publicly documented, so `normaliseCostume`
 * is deliberately tolerant. If the shape drifts, this script prints a sample
 * object and exits instead of silently importing garbage.
 */
import "dotenv/config";
import { db, schema } from "../src/db/index.js";
import { sql } from "drizzle-orm";
const API_BASE = "https://marvelrivalsapi.com/api/v1";
const IMAGE_BASE = "https://marvelrivalsapi.com/rivals";
const KEY = process.env.MARVEL_RIVALS_API_KEY;
const DRY = process.argv.includes("--dry");
if (!KEY) {
    console.error("MARVEL_RIVALS_API_KEY is not set. Get one at https://marvelrivalsapi.com");
    process.exit(1);
}
async function api(path) {
    const res = await fetch(`${API_BASE}${path}`, {
        headers: { "x-api-key": KEY, accept: "application/json" },
    });
    if (res.status === 429) {
        const reset = res.headers.get("x-ratelimit-reset");
        throw new Error(`Rate limited on ${path}. Resets at ${reset ?? "unknown"}.`);
    }
    if (!res.ok)
        throw new Error(`${path} → HTTP ${res.status} ${res.statusText}`);
    return (await res.json());
}
/** The API returns partial image paths on the free tier; premium returns signed absolute URLs. */
function absoluteImage(path) {
    if (typeof path !== "string" || path.length === 0)
        return null;
    if (path.startsWith("http://") || path.startsWith("https://"))
        return path;
    return `${IMAGE_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
}
/**
 * In-game quality strings vary in casing and have historically appeared as
 * numeric tier codes. Anything unrecognised returns null and gets reported
 * rather than silently bucketed into `default`.
 */
function normaliseRarity(raw) {
    if (raw == null)
        return null;
    const v = String(raw).trim().toLowerCase();
    const byName = {
        default: "default",
        common: "default",
        standard: "default",
        rare: "rare",
        uncommon: "rare",
        epic: "epic",
        legendary: "legendary",
        mythic: "mythic",
    };
    if (byName[v])
        return byName[v];
    // Tier codes like "NO.1" / "1" have shown up in datamined payloads.
    const n = v.match(/(\d+)/)?.[1];
    const byCode = {
        "0": "default",
        "1": "rare",
        "2": "epic",
        "3": "legendary",
        "4": "mythic",
    };
    return n && byCode[n] ? byCode[n] : null;
}
function pick(obj, ...keys) {
    for (const k of keys)
        if (obj[k] != null)
            return obj[k];
    return undefined;
}
/** Unwraps the various envelope shapes the API uses ({heroes}, {costumes}, {data}, bare array). */
function unwrap(payload, ...keys) {
    if (Array.isArray(payload))
        return payload;
    if (payload && typeof payload === "object") {
        const o = payload;
        for (const k of [...keys, "data", "results", "items"]) {
            if (Array.isArray(o[k]))
                return o[k];
        }
    }
    return [];
}
async function main() {
    console.log("Fetching heroes…");
    const heroPayload = await api("/heroes");
    const rawHeroes = unwrap(heroPayload, "heroes");
    if (rawHeroes.length === 0) {
        console.error("No heroes in response. Sample payload:");
        console.dir(heroPayload, { depth: 3 });
        process.exit(1);
    }
    const heroRows = [];
    const heroIds = new Set();
    for (const h of rawHeroes) {
        const id = pick(h, "id", "hero_id", "_id");
        const name = pick(h, "name", "hero_name", "real_name");
        if (id == null || name == null)
            continue;
        heroRows.push({
            id: String(id),
            name: String(name),
            role: pick(h, "role", "hero_type") ? String(pick(h, "role", "hero_type")) : null,
            imageUrl: absoluteImage(pick(h, "imageUrl", "image_url", "image", "icon")),
        });
        heroIds.add(String(id));
    }
    console.log(`  → ${heroRows.length} heroes`);
    console.log("Fetching costumes…");
    const costumePayload = await api("/costumes");
    const rawCostumes = unwrap(costumePayload, "costumes", "skins");
    if (rawCostumes.length === 0) {
        console.error("No costumes in response. Sample payload:");
        console.dir(costumePayload, { depth: 3 });
        process.exit(1);
    }
    const cardRows = [];
    const unknownRarities = new Map();
    let orphaned = 0;
    for (const c of rawCostumes) {
        const id = pick(c, "id", "costume_id", "_id");
        const name = pick(c, "name", "costume_name", "title");
        const heroId = pick(c, "hero_id", "heroId", "hero");
        if (id == null || name == null || heroId == null)
            continue;
        if (!heroIds.has(String(heroId))) {
            orphaned++;
            continue; // FK would reject it anyway
        }
        const rawRarity = pick(c, "quality", "rarity", "tier", "quality_name");
        const r = normaliseRarity(rawRarity);
        if (!r) {
            const key = String(rawRarity ?? "<missing>");
            unknownRarities.set(key, (unknownRarities.get(key) ?? 0) + 1);
            continue;
        }
        cardRows.push({
            id: String(id),
            heroId: String(heroId),
            name: String(name),
            rarity: r,
            imageUrl: absoluteImage(pick(c, "icon", "imageUrl", "image_url", "image", "full_image")),
        });
    }
    console.log(`  → ${cardRows.length} costumes usable as cards`);
    if (orphaned)
        console.log(`  → ${orphaned} skipped (hero not in roster)`);
    if (unknownRarities.size) {
        console.warn("  → skipped, unrecognised rarity values:");
        for (const [k, n] of unknownRarities)
            console.warn(`     ${k} ×${n}`);
        console.warn("     Add these to normaliseRarity() in scripts/ingest.ts.");
    }
    const byRarity = cardRows.reduce((acc, c) => {
        acc[c.rarity] = (acc[c.rarity] ?? 0) + 1;
        return acc;
    }, {});
    console.log("  → pool by rarity:", byRarity);
    if (DRY) {
        console.log("\n--dry: nothing written.");
        process.exit(0);
    }
    await db.transaction(async (tx) => {
        await tx
            .insert(schema.heroes)
            .values(heroRows)
            .onConflictDoUpdate({
            target: schema.heroes.id,
            set: {
                name: sql `excluded.name`,
                role: sql `excluded.role`,
                imageUrl: sql `excluded.image_url`,
            },
        });
        // Chunked: a few thousand rows in one statement trips parameter limits.
        for (let i = 0; i < cardRows.length; i += 500) {
            await tx
                .insert(schema.cards)
                .values(cardRows.slice(i, i + 500))
                .onConflictDoUpdate({
                target: schema.cards.id,
                set: {
                    name: sql `excluded.name`,
                    rarity: sql `excluded.rarity`,
                    imageUrl: sql `excluded.image_url`,
                },
            });
        }
    });
    console.log("\nDone. Cards are live.");
    process.exit(0);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=ingest.js.map