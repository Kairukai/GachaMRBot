# CLAUDE.md

Mudae-style Marvel Rivals gacha bot for Discord. Public bot (many servers),
competitive claims.

## Commands

```bash
npm run dev              # single-process bot, watch mode (src/bot.ts)
npm run deploy-commands  # register slash commands (guild-scoped if DEV_GUILD_ID set)
npm run ingest           # wiki ingest — PRIMARY card data path, no API key
npm run ingest -- --dry --limit 60   # inspect without writing
npm run ingest:api       # alternative source, needs MARVEL_RIVALS_API_KEY
npm run db:generate      # generate migration from schema changes
npm run db:migrate       # apply migrations
npm run typecheck
docker compose up -d     # Postgres 16 on :5432
```

`npm start` runs `dist/index.js`, a `ShardingManager`. `src/bot.ts` is the
single-process dev entrypoint — don't confuse the two.

## Core design decisions

**Cards are costumes, not heroes.** 52 heroes would be a trivial pool; every
hero × skin gives ~498 cards with rarity tiers that come from real game data.

**Ownership is per-guild and exclusive.** Within a server a card has exactly one
owner. This is the whole reason racing for the Claim button matters. Changing
this guts the core mechanic.

**Claim races are settled by Postgres, not JavaScript.** The unique index
`claims_guild_card_uniq` on `(guild_id, card_id)` means simultaneous clicks
can't both win — the loser catches a constraint violation and gets an ephemeral
"too slow". Never replace this with a read-then-write check; that reintroduces
the race.

**Rarity weights are renormalised over rarities that actually have cards**
(`src/lib/pool.ts` → `availableRarities()`, 5-min cache). The live pool has no
Default or Mythic costumes, so hardcoding the full ladder would send ~55% of
rolls at an empty bucket. If Mythics appear in a later ingest they enter the
table automatically. `/rates` reports pool-derived odds, so it can't drift from
what the bot actually does.

**Trades use optimistic concurrency, not locking.** A card may sit in several
pending offers at once. `executeSwap` re-checks ownership inside its
transaction by scoping both UPDATEs to the current owner — if either matches
zero rows the whole thing rolls back, so a stale offer fails cleanly instead of
duplicating or half-moving a card. Don't add card locking; it deadlocks and
isn't needed.

**The ladder is Rare / Epic / Legendary only.** The wiki has no articles for
base skins or Mythic costumes, so those tiers would be invented rather than
sourced — both are pinned to weight 0 in `BASE_WEIGHTS`. Don't add synthesised
Default cards back; this was tried and deliberately reverted.

Weights sum to 100 and read as percentages. Epic (52.5%) intentionally sits
above Rare (47%) because it matches supply. Legendary is 0.5%, so pity does most
of the work and the hard cap at 90 is reached routinely.

**Rolls are cheap, claims are scarce.** Rolls are rate-limited per hour
(default 20); claims default to 1/hour. That split is the engagement mechanic —
tune claims, not rolls, to change how competitive a server feels.

## Data source gotchas

Primary source is the Marvel Rivals Fandom wiki via MediaWiki API
(`scripts/ingest-wiki.ts`). No key, no rate-limit tier.
`marvelrivalsapi.com` returned 502 repeatedly during development — hence the
demotion to fallback.

**The two ingest paths use different hero id schemes** (wiki slugs vs upstream
ids). Pick one and stay on it, or you'll duplicate every card.

Landmines already hit and handled — don't "simplify" these away:

- **Costume ids are not unique.** The wiki reuses one id across heroes for
  cross-hero bundles (`1048501` is both Psylocke's and Magik's Retro X-Uniform).
  Card ids are therefore `heroSlug:costumeId`. Keying on the bare id silently
  drops cards.
- **Role fields contain markup.** `[[File:Icon.png|20px]]Strategist` must be
  stripped to `Strategist`; `cleanRole()` handles this.
- **Deadpool genuinely has three roles** (`Vanguard / Duelist / Strategist`).
  Not a parse bug. Role *categories* on the wiki double-list heroes, which is
  why roles come from the `{{Infobox Character}}` `role` field instead.
- Batch MediaWiki requests at 50 titles; back off on 429/5xx.

## Schema notes

`src/db/schema.ts`. Per-user-per-guild counters live in `member_state`, not
`users` — the economy is scoped to a server. `users` holds only cross-guild
things (currency, shards).

`rarity` is a Postgres enum; ordering it requires `array_position(...)`, see
`RARITY_RANK` in `src/commands/collection.ts`.

## Current state

Live and working: `/roll` (with claim race), `/collection`, `/rates`,
`/commands`, `/trade`, shard consolation for rolling an owned card.
498 cards across 52 heroes.

`/commands` builds its list from the registry via a call-time `import()` —
`commands/index.ts` imports it, so a top-level import would be circular. The
explicit return type and cast on `execute` are what stop TypeScript chasing that
cycle; don't remove them.

**Shards have no sink.** They accumulate and display but nothing spends them.
The intended sink is a targeted pull (spend shards to roll a specific hero).

Not built: wishlist DM pings (table exists, unused), admin config commands
(`guild_settings` is tunable only via raw SQL right now), multi-card trades
(current flow is strictly one-for-one).

## Testing

`npm test` → `tests/concurrency.test.ts`, run with node:test via tsx. These are
integration tests against a real Postgres; they need `docker compose up -d` and
a populated card pool, and they clean up their own rows.

Node 20's test runner only discovers `.js` files, so the script names the test
file explicitly — **add new test files to the `test` script** or they won't run.

**Do not use root-level `before` hooks here.** node:test did not reliably await
one before the first test started, so cleanup DELETEs raced the tests' own
INSERTs and produced a spurious foreign-key failure that looked like a
production bug. Setup is an awaited module-level promise (`const ready =
reset()`) that each test awaits.

## Conventions

- ESM, `.js` extensions in relative imports (required by `moduleResolution: bundler` + ES2022 output).
- Slash commands only; no Message Content intent, so no privileged-intent review.
- Ephemeral replies via `flags: MessageFlags.Ephemeral`, not the deprecated `ephemeral: true`.
- Comments explain *why*, especially where a constraint or ordering is load-bearing.

## Legal

Marvel Rivals assets are NetEase/Marvel property; the wiki and
marvelrivalsapi.com are unofficial. Card images are referenced by URL, never
rehosted. Worth real scrutiny before wide distribution or monetisation.
