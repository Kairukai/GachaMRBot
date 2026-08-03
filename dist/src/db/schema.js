import { pgTable, pgEnum, text, integer, timestamp, serial, boolean, primaryKey, uniqueIndex, index, } from "drizzle-orm/pg-core";
/**
 * Rarity mirrors the in-game costume tiers so drop rates stay defensible:
 * a Legendary card is a Legendary skin, not a number we invented.
 */
export const rarity = pgEnum("rarity", [
    "default",
    "rare",
    "epic",
    "legendary",
    "mythic",
]);
export const heroes = pgTable("heroes", {
    id: text("id").primaryKey(), // upstream hero id
    name: text("name").notNull(),
    role: text("role"), // Vanguard | Duelist | Strategist
    imageUrl: text("image_url"),
});
/** One card == one costume. This is what makes the pool big enough to be a gacha. */
export const cards = pgTable("cards", {
    id: text("id").primaryKey(), // upstream costume id
    heroId: text("hero_id")
        .notNull()
        .references(() => heroes.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    rarity: rarity("rarity").notNull(),
    imageUrl: text("image_url"),
    /** Excluded from the roll pool when false — lets us retire cards without deleting claims. */
    rollable: boolean("rollable").notNull().default(true),
}, (t) => ({
    byRarity: index("cards_rarity_idx").on(t.rarity, t.rollable),
    byHero: index("cards_hero_idx").on(t.heroId),
}));
export const users = pgTable("users", {
    id: text("id").primaryKey(), // discord user id
    currency: integer("currency").notNull().default(0),
    /** Duplicate claims convert to shards instead of being a dead pull. */
    shards: integer("shards").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const guildSettings = pgTable("guild_settings", {
    id: text("id").primaryKey(), // discord guild id
    rollCooldownSec: integer("roll_cooldown_sec").notNull().default(8),
    rollsPerHour: integer("rolls_per_hour").notNull().default(20),
    claimsPerHour: integer("claims_per_hour").notNull().default(2),
    /** How long the Claim button stays live after a drop. */
    claimWindowSec: integer("claim_window_sec").notNull().default(30),
    /** When set, /roll only works in this channel. */
    rollChannelId: text("roll_channel_id"),
});
/**
 * Per-user, per-guild counters. Mudae-style bots scope the economy to a server,
 * so rate limits live here rather than on `users`.
 */
export const memberState = pgTable("member_state", {
    userId: text("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    guildId: text("guild_id")
        .notNull()
        .references(() => guildSettings.id, { onDelete: "cascade" }),
    rollsUsed: integer("rolls_used").notNull().default(0),
    rollsResetAt: timestamp("rolls_reset_at", { withTimezone: true }),
    claimsUsed: integer("claims_used").notNull().default(0),
    claimsResetAt: timestamp("claims_reset_at", { withTimezone: true }),
    lastRollAt: timestamp("last_roll_at", { withTimezone: true }),
    /**
     * Purchased with shards via /buy. Spent only once the hourly allowance is
     * exhausted, and deliberately NOT reset when the hourly window rolls over —
     * you paid for these, so they keep until used.
     */
    bonusRolls: integer("bonus_rolls").notNull().default(0),
    bonusClaims: integer("bonus_claims").notNull().default(0),
}, (t) => ({ pk: primaryKey({ columns: [t.userId, t.guildId] }) }));
/**
 * Ownership is per-guild and exclusive: within a server, a card has exactly one
 * owner. That scarcity is the whole reason racing for the Claim button matters.
 */
export const claims = pgTable("claims", {
    id: serial("id").primaryKey(),
    guildId: text("guild_id")
        .notNull()
        .references(() => guildSettings.id, { onDelete: "cascade" }),
    userId: text("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    cardId: text("card_id")
        .notNull()
        .references(() => cards.id, { onDelete: "cascade" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
    // The race is resolved by this constraint, not by application logic.
    oneOwnerPerGuild: uniqueIndex("claims_guild_card_uniq").on(t.guildId, t.cardId),
    byOwner: index("claims_owner_idx").on(t.guildId, t.userId),
}));
export const tradeStatus = pgEnum("trade_status", [
    "pending",
    "accepted",
    "declined",
    "cancelled",
]);
/**
 * One-for-one card swaps. Cards are deliberately NOT locked while a trade is
 * pending — a card can sit in several offers at once, and whichever accept
 * lands first wins. The swap re-checks ownership inside its transaction, so a
 * stale offer fails cleanly instead of duplicating a card.
 */
export const trades = pgTable("trades", {
    id: serial("id").primaryKey(),
    guildId: text("guild_id")
        .notNull()
        .references(() => guildSettings.id, { onDelete: "cascade" }),
    proposerId: text("proposer_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    receiverId: text("receiver_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    /** Card the proposer gives up. */
    offerCardId: text("offer_card_id")
        .notNull()
        .references(() => cards.id, { onDelete: "cascade" }),
    /** Card the proposer wants in return. */
    wantCardId: text("want_card_id")
        .notNull()
        .references(() => cards.id, { onDelete: "cascade" }),
    status: tradeStatus("status").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
    byReceiver: index("trades_receiver_idx").on(t.guildId, t.receiverId, t.status),
}));
export const wishlist = pgTable("wishlist", {
    userId: text("user_id")
        .notNull()
        .references(() => users.id, { onDelete: "cascade" }),
    cardId: text("card_id")
        .notNull()
        .references(() => cards.id, { onDelete: "cascade" }),
}, (t) => ({ pk: primaryKey({ columns: [t.userId, t.cardId] }) }));
//# sourceMappingURL=schema.js.map