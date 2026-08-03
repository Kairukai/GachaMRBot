# CLAUDE.md

Mudae-style Marvel Rivals gacha bot for Discord. Public bot (many servers),
competitive claims.

## Commands

```bash
docker compose --profile prod up -d --build   # LIVE bot + db in containers
docker compose up -d                          # db only
npm run dev              # DEV bot, watch mode — uses .env.dev, not .env
npm run dev:deploy       # register commands to the dev guild (instant)
npm run dev:migrate / dev:ingest              # against gacha_dev
npm run deploy-commands  # LIVE bot — global, up to 1h to propagate
npm run ingest           # wiki ingest — PRIMARY card data path, no API key
npm run ingest -- --dry --limit 60   # inspect without writing
npm run ingest:api       # alternative source, needs MARVEL_RIVALS_API_KEY
npm run db:generate      # generate migration from schema changes
npm run db:migrate       # apply migrations
npm run typecheck
docker compose up -d     # Postgres 16 on :5432
```

`npm start` runs `dist/src/index.js`, a `ShardingManager`. `src/bot.ts` is the
single-process dev entrypoint — don't confuse the two.

**tsc emits to `dist/src/`, not `dist/`** (rootDir is `.` so `scripts/` builds
too). Anything referencing a built file must account for that — `src/index.ts`
resolves the shard path via `import.meta.url` rather than hardcoding it, because
the hardcoded version was wrong and only failed on deploy, never under `tsx`.

Production migrations use `src/migrate.ts` (drizzle-orm's programmatic migrator),
not the drizzle-kit CLI, which is a devDependency absent from the image. It
resolves `drizzle/` from `process.cwd()` — correct in both the repo root and
`/app`, unlike a module-relative path.

The `bot` compose service sits behind a `prod` profile specifically so plain
`docker compose up -d` still starts only Postgres for local dev.

**Two bot applications.** The live bot uses `.env` and registers commands
globally (up to 1h propagation). Development uses a *separate* Discord
application via `.env.dev`, selected with `DOTENV_CONFIG_PATH` — that's what the
`dev:*` scripts set. `DEV_GUILD_ID` must stay **blank in `.env`** and **set in
`.env.dev`**; a value in `.env` silently scopes the live bot's commands to one
server, which is exactly how it once looked broken in every other guild.

**The dev bot has its own database (`gacha_dev`) and its own server**
(`MR Gacha Bot Dev`). Keep the databases separate regardless — if the dev bot is
ever invited alongside the live one, `guild_id` collides and test rolls would
create real claims, locking cards away from real players.

Never run the live bot in Docker and `npm run live:dev` at the same time: two
gateway sessions on one token means every interaction is handled twice.

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
(`src/lib/pool.ts` → `availableRarities()`, 60s cache). The live pool has no
Default or Mythic costumes, so hardcoding the full ladder would send rolls at an
empty bucket. If Mythics appear in a later ingest they enter the
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

Weights sum to 100 and read as percentages: Rare 72 / Epic 27.3 / Legendary 0.7.
Strictly descending — this deliberately runs against supply (Epic is ~half the
pool but 27.3% of drops), because rarity should describe difficulty of
acquisition, not inventory size. An earlier version had Epic above Rare to match
supply; it was rejected as confusing. Legendary is a flat 0.7% — roughly one per
~143 rolls, with a long tail (about half of players go 100 rolls without one).

**The shard economy is intentionally loss-making.** A roll's expected sell value
is ~💠17.8; a bought roll costs 💠200 and a bought claim 💠1000. Keep
`ROLL_PRICE_SHARDS` above expected sell value or players can farm infinite rolls
by cycling their collection. All the numbers live in `src/lib/gacha.ts`
(`SELL_VALUE`, `DUPLICATE_SHARDS`, `ROLL_PRICE_SHARDS`, `CLAIM_PRICE_SHARDS`).

**`/buy` is the only shard sink.** `/roll` and `/roll5` used to take a
`shards:True` option at a much lower price; that was removed when `/buy` landed,
because two prices for the same thing meant everyone used the cheap one.

**Purchased credits live in `member_state.bonus_rolls` / `bonus_claims`.**
`consumeRoll`/`consumeClaim` spend the free hourly allowance first and only fall
back to the bank, all inside the same atomic UPDATE. Bonuses deliberately
survive the hourly window reset — they were paid for.

**`/give` is one-way and uses the same ownership-scoped UPDATE as trades** — a
card sold or traded between prompt and confirm moves nothing rather than
transferring something the giver no longer holds. Gifts don't consume a claim,
same as trades.

**Sell payouts are derived from rows actually deleted**, never from a count
taken when the confirmation prompt was built — otherwise a trade completing in
between pays for cards the user no longer owns. Same reasoning as the trade
swap. Selling deletes the claim, so the card returns to the pool.

**Quota SQL uses `clock_timestamp()`, not `now()`.** `now()` is the transaction
start time, so a statement that waited on another's row lock compares against
its own stale timestamp and can reject a legitimate roll as "on cooldown". This
showed up as a flaky test before it ever showed up in production.

**`/roll5` uses Components V2**, so each card is its own `Container` with its
own Claim button nested inside it. Classic embeds can't do that — buttons may
only appear in action rows *after* every embed, which is why the first version
had all five buttons stranded at the bottom.

V2 messages carry no `content` and no `embeds`; everything is components, and
the message needs `flags: MessageFlags.IsComponentsV2`. `lib/claim.ts` branches
on that flag: V2 messages are edited via `editV2Components`, which walks the raw
component JSON rather than using nested builder `.from()` helpers, whose support
varies across discord.js releases. `/roll` (single) still uses a classic embed
so it keeps the large image.

**There is no pity system.** Every roll is independent; `rollRarity(pool)` takes
no counter and the `pity` column was dropped. Don't reintroduce one without
saying so — `/rates` advertises these as the true per-roll odds.

`consumeRoll(..., count)` is all-or-nothing — a partial batch is refused rather
than clipped.

**Rolls are cheap, claims are scarce.** Rolls are rate-limited per hour
(default 20); claims default to 2/hour. That split is the engagement mechanic —
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
`/roll5`, `/cdcheck`, `/showcase`, `/commands`, `/trade`, `/give`, `/buy`, `/sell`, `/sellall`, `/flexers`,
shard consolation for rolling an owned card, and shards spendable via `/buy`.

`/flexers` derives collection value from `SELL_VALUE` in SQL (`lib/leaderboard.ts`)
so the leaderboard can't disagree with sell payouts. Aggregate columns come back
as strings from Postgres — they're `Number()`-cast in the mapper; don't drop that.
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
