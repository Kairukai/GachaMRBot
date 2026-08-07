# GachaMRBot

A Mudae-style Marvel Rivals gacha bot for Discord. Players roll for character
cards, race each other to claim them, and build a collection that's unique to
their server.

- **498 cards** across **52 heroes**, every one with official art
- Competitive claims — first to click wins, and a card has **one owner per server**
- Rarity tiers taken from the real in-game costume system
- No API key needed; card data comes from the community wiki

---

## Table of contents

- [How it plays](#how-it-plays)
- [Quick start](#quick-start)
- [Discord commands](#discord-commands)
- [npm scripts](#npm-scripts)
- [Development setup](#development-setup)
- [Configuration](#configuration)
- [Card data and ingestion](#card-data-and-ingestion)
- [Drop rates](#drop-rates)
- [Shards and the economy](#shards-and-the-economy)
- [Database schema](#database-schema)
- [Project structure](#project-structure)
- [Why it's built this way](#why-its-built-this-way)
- [Troubleshooting](#troubleshooting)
- [Roadmap](#roadmap)
- [Legal](#legal)

---

## How it plays

Someone runs `/roll`. The bot drops a random card into the channel — hero name,
costume name, rarity, role, and the actual skin art — with a green **Claim**
button that stays live for 30 seconds.

Anyone in the channel can click it. First click wins. Within that server, that
card now has exactly one owner, permanently.

If the card is already owned, there's no button. You see who has it, and you get
**shards** as a consolation prize instead.

The design has one deliberate asymmetry: **rolling is cheap, claiming is
scarce.** You get 20 rolls an hour but only 2 claims. That's what makes people
watch the channel instead of spamming rolls — you have to decide whether the
card in front of you is worth one of them.

---

## Quick start

### What you need first

| Requirement | Notes |
|---|---|
| **Node.js 20+** | Uses native `fetch` and ESM |
| **Docker** | For Postgres; or bring your own Postgres 16 |
| **A Discord bot token** | See step 1 |
| **A test server** | One where you have Manage Server |

No Marvel Rivals API key is required.

### 1. Create the Discord bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**
2. **Bot** tab → **Reset Token** → copy it. This is your `DISCORD_TOKEN`.
3. **General Information** tab → copy the **Application ID**. This is your `DISCORD_CLIENT_ID`.

You do **not** need to enable any Privileged Gateway Intents. The bot uses only
slash commands and buttons, so it never reads message content. Discord still
requires bot verification once you pass 100 servers, but you skip the extra
burden of justifying privileged intent access — which is the part that gets
rejected.

### 2. Invite the bot

Replace `YOUR_CLIENT_ID` and open in a browser:

```
https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=84992&scope=bot%20applications.commands
```

`permissions=84992` grants exactly four things:

| Permission | Why |
|---|---|
| View Channel | See the channel it's rolling in |
| Send Messages | Post the card drop |
| **Embed Links** | Render the card embed and art |
| Read Message History | Edit its own drop when claimed or expired |

> **Embed Links is the one that matters.** Without it Discord silently strips
> the embed and every card drop renders as a blank message — no error, just
> nothing. It's the most common setup mistake.

### 3. Configure

```bash
cp .env.example .env
```

Fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `DEV_GUILD_ID` (your test
server's ID — right-click the server → Copy Server ID, with **Developer Mode**
enabled in User Settings → Advanced).

### 4. Install and start the database

```bash
npm install
docker compose up -d
npm run db:migrate
```

### 5. Load the cards

```bash
npm run ingest
```

Takes a couple of minutes. You should see `52 heroes, 498 cards`.

### 6. Register commands and run

```bash
npm run deploy-commands
npm run dev
```

Console prints `Logged in as YourBot#1234 (1 guilds)`. Run `/roll` in Discord.

---

## Discord commands

| Command | Who | What it does |
|---|---|---|
| `/roll` | Anyone | Drops a random card with a 30-second Claim button. |
| `/roll5` | Anyone | Rolls 5 cards in one message. Each card is its own panel with its own Claim button attached. Costs 5 rolls. |
| `/cdcheck` | Anyone | Your roll cooldown, rolls and claims left this hour, and shard balance. Ephemeral. |
| `/showcase` | Anyone | Posts one of your cards publicly with its art, value and claim date. Autocompletes from your collection. |
| `/sell` | Anyone | Sell one card for shards. Autocompletes from your inventory and always asks you to confirm. |
| `/sellall` | Anyone | Sell **every** card of one rarity. Lists what's going before you confirm. |
| `/collection [user]` | Anyone | Paginated list of cards claimed in this server, 10 per page, sorted by rarity. Omit `user` for your own. Footer shows your shard balance. |
| `/rates` | Anyone | Current drop odds, read from the live pool. Ephemeral — only you see it. |
| `/buy` | Anyone | Spend shards on extra rolls (💠200) or claims (💠1000). Confirms first. Banked credits never expire. |
| `/give` | Anyone | Hand a card to someone for nothing in return. Confirms first, then announces it publicly. |
| `/trade` | Anyone | Offer one of your cards for one of theirs. Both card fields autocomplete from real inventories. Only the recipient can accept; the proposer can withdraw. Offers expire after 5 minutes. |
| `/flexers` | Anyone | Server leaderboard, ranked by total collection value with a per-rarity breakdown. Paginated 10 at a time; the footer shows your own rank even if you're off-page. |
| `/leaderboard [category]` | Anyone | Top ten by collection value, cards owned, highest rank, or cards burned. Shows your own standing if you're off the board. |
| `/rankup <card>` | Anyone | Burn spare cards and shards to rank an Epic or Legendary from 1 to 10. Picks the cheapest eligible fodder for you and lists it before you confirm. Ranked cards can never be fodder. |
| `/team set` | Anyone | Save your 6v6 line-up. Six slots, six **different heroes** — costume doesn't matter. Max one Legendary per role and two Epics; Rares unlimited. Empty slots are filled by weak recruits. |
| `/team view [user]` | Anyone | Show a line-up with its composition and power. Rosters are public so opponents can be scouted. |
| `/team clear` | Anyone | Delete your saved line-up. |
| `/challenge <player>` | Anyone | Fight another player's **saved** line-up, online or not. Round-by-round log with ultimates. 10 per hour. |
| `/challenge <player> wager_shards:<n>` | Anyone | Same fight with both sides staking shards; the winner takes the pot. Becomes an offer the other player must accept. |
| `/challenge <player> stake_card:<yours> their_card:<theirs>` | Anyone | Play a card of yours against one of theirs. The winner takes the loser's card, rank included. Also requires acceptance. |
| `/commands` | Anyone | Lists every command. Built from the live registry, so it can't fall out of date. Ephemeral. |

Rates shown by `/rates` are calculated from the live card pool, so they always
reflect what the bot will actually do rather than a static table that can drift.

---

## npm scripts

### Running the bot

| Script | What it does |
|---|---|
| `npm run dev` | Dev bot with hot reload, using `.env.dev`. **Use this for development.** |
| `npm run dev:deploy` | Register commands to the dev bot's test server. Instant. |
| `npm run dev:migrate` | Apply migrations to the dev database |
| `npm run dev:ingest` | Load cards into the dev database |
| `npm run live:dev` | Run the **live** bot locally from `.env`. Rarely needed. |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Production entrypoint — runs `dist/src/index.js`, a sharding manager. Requires `npm run build` first. |
| `npm run migrate` | Apply migrations without the drizzle-kit CLI. This is what the container runs on boot. |
| `npm run start:single` | Migrate, then run **one** process without sharding. Use this on low-RAM hosts. |

See [Development setup](#development-setup) for what `.env.dev` is and why the
dev bot needs its own database.

> `src/bot.ts` (dev) and `src/index.ts` (production) are different entrypoints.
> `index.ts` spawns shards; `bot.ts` is one plain process. Don't mix them up.

### Card data

| Script | What it does |
|---|---|
| `npm run ingest` | Load heroes and costumes from the Fandom wiki. **Primary path, no key needed.** |
| `npm run ingest -- --dry` | Print what would be imported, write nothing |
| `npm run ingest -- --limit 60` | Only process the first 60 pages — good for a fast test |
| `npm run ingest:api` | Alternative source via marvelrivalsapi.com. Needs `MARVEL_RIVALS_API_KEY`. |

Flags combine: `npm run ingest -- --dry --limit 60`.

### Database

| Script | What it does |
|---|---|
| `npm run db:generate` | Generate a migration after editing `src/db/schema.ts` |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:studio` | Open Drizzle Studio, a browser GUI for the database |

### Commands and checks

| Script | What it does |
|---|---|
| `npm run deploy-commands` | Register slash commands with Discord |
| `npm test` | Run the test suite |
| `npm run typecheck` | Type-check without emitting |

Tests are integration tests — they need `docker compose up -d` and a populated
card pool, because the bugs they cover (quota races, claim races, sell payouts)
only exist at the database boundary. They clean up after themselves.

Two gotchas if you add tests:

- Node 20's runner only discovers `.js` files, so the `test` script names the
  file explicitly. **New test files must be added to it** or they silently
  won't run.
- **Don't use root-level `before` hooks.** node:test didn't reliably finish one
  before the first test started, so cleanup `DELETE`s raced the tests' own
  `INSERT`s and produced a foreign-key failure that looked like a production
  bug. Setup is an awaited module-level promise instead.

Re-run `deploy-commands` whenever you add a command or change its name,
description, or options. You don't need it for changes to command *logic*.

---

## Development setup

The live bot registers commands **globally**, which takes up to an hour to
propagate. That's fine for shipping and painful for iterating, so development
uses a second, separate Discord application.

Note the split:

- **Behaviour changes** (rates, wording, bug fixes) need no registration at all
  — edit code, `npm run dev`, done.
- **Command definition changes** (new command, renamed option) need a deploy,
  and that's the only thing the hour applies to.

### Setting it up

1. Create a **second application** in the
   [Developer Portal](https://discord.com/developers/applications) — e.g.
   "MR Gacha Bot Dev". Grab its token and Application ID.
2. Invite it to your test server with the same four permissions.
3. `cp .env.dev.example .env.dev` and fill in the token and client id.
4. `npm run dev:migrate && npm run dev:ingest`
5. `npm run dev:deploy && npm run dev`

You'll then have two bots in the member list: the live one, and a dev one you
can break freely.

### Why the dev bot needs its own database

The dev bot usually sits in the *same* Discord server as the live one, so
`guild_id` is identical. Sharing a database would mean test rolls creating real
claims — locking cards away from real players. `.env.dev` therefore points at a
separate `gacha_dev` database on the same Postgres container.

Create it once with:

```bash
docker compose exec db psql -U gacha -d postgres -c "CREATE DATABASE gacha_dev OWNER gacha;"
```

> **Don't run two bots on one token.** The live bot runs in Docker; if you also
> run `npm run live:dev`, both connect as the same user and every interaction is
> handled twice. Stop the container first, or just use the dev bot.

## Configuration

### Environment variables (`.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `DISCORD_TOKEN` | Yes | — | Bot token from the Bot tab |
| `DISCORD_CLIENT_ID` | Yes | — | Application ID from General Information |
| `DEV_GUILD_ID` | No | — | Register commands to this one server, instantly. Leave blank in production for global registration. |
| `DATABASE_URL` | Yes | `postgres://gacha:gacha@localhost:5432/gacha` | Postgres connection string |
| `MARVEL_RIVALS_API_KEY` | No | — | Only for `npm run ingest:api` |

> **On `DEV_GUILD_ID`:** guild-scoped commands appear instantly. Global commands
> take up to an hour to propagate. Develop with it set; unset it for production.

### Per-server settings

Every server gets a row in `guild_settings`, created on first use:

| Setting | Default | What it controls |
|---|---|---|
| `roll_cooldown_sec` | 8 | Seconds between one user's rolls |
| `rolls_per_hour` | 20 | Rolls per user per rolling hour |
| `claims_per_hour` | 2 | **The main dial.** Claims per user per hour. |
| `claim_window_sec` | 30 | How long the Claim button stays live |
| `roll_channel_id` | `null` | If set, `/roll` only works in that channel |

There's no admin command for these yet, so changing them means SQL:

```sql
UPDATE guild_settings SET claims_per_hour = 3 WHERE id = 'YOUR_GUILD_ID';
```

> **Tune claims, not rolls.** Claims-per-hour decides whether a server feels
> competitive or hopeless. Raising rolls just adds noise.

### Tunable constants in code

| Constant | File | Default |
|---|---|---|
| `BASE_WEIGHTS` | `src/lib/gacha.ts` | Rarity weights |
| `SOFT_PITY_START` | `src/lib/gacha.ts` | 50 |
| `HARD_PITY` | `src/lib/gacha.ts` | 90 |
| `DUPLICATE_SHARDS` | `src/lib/gacha.ts` | Shard payout per rarity |
| `PAGE_SIZE` | `src/commands/collection.ts` | 10 |
| `TTL_MS` | `src/lib/pool.ts` | 5 min pool cache |

---

## Card data and ingestion

### Why costumes, not heroes

52 heroes would be a boring pool — you'd have them all in a day. So **one card =
one costume.** Every hero × every skin gives ~498 cards, and each skin already
carries an official rarity, so the gacha ladder comes from real game data
instead of invented numbers.

### Where the data comes from

The primary source is the **Marvel Rivals Fandom wiki** via the MediaWiki API.
Each costume page has a structured infobox:

```
|rarity = Epic
|hero   = Jeff the Land Shark
|id     = 1047800
|name   = 8-Bit Bash
|icon   = CosInfo - Jeff 8-Bit Bash Icon.png
```

No API key, no rate-limit tier, and hero roles and portraits come from each
hero page's `{{Infobox Character}}`.

`scripts/ingest.ts` is an alternative path against
[marvelrivalsapi.com](https://marvelrivalsapi.com). It's a fallback because that
host returned 502 repeatedly during development.

> **Pick one source and stay on it.** The two paths use different hero id
> schemes, so alternating them will duplicate every card.

The bot **never** calls an external API at roll time — rolls hit Postgres only.
An upstream outage can't affect gameplay. Re-run the ingest weekly; the roster
grows every season.

### Keeping the pool up to date

Marvel Rivals adds heroes and costumes every season. The bot **never calls the
wiki** — it only reads Postgres — so the pool stays exactly as ingested until an
ingest runs again.

[`.github/workflows/ingest.yml`](.github/workflows/ingest.yml) runs it **every
Monday 03:00 UTC** against production, and can be triggered by hand from the
Actions tab. It posts a summary table of the resulting pool, so a new season
shows up as a jump in the card count.

**Setup — one repo secret:**

*Settings → Secrets and variables → Actions → New repository secret*

```
Name:   DATABASE_URL
Value:  postgresql://...neon.tech/neondb?sslmode=require
```

This is separate from Render's copy of the same variable. Render's is for the
bot; this one is for the scheduled job.

**Why GitHub Actions rather than Render:** Render's Cron Jobs are a paid
feature, and running the ingest inside the bot would spend memory and CPU on a
small instance whose restarts make timer scheduling unreliable. A short-lived CI
job is free, isolated, and can't take the bot down if the wiki misbehaves.

**Why it's safe to run unattended:** the ingest **upserts and never deletes**.
New cards are added, changed ones updated, nothing removed — so a card someone
owns can never vanish from under them. Verified against live production with
122 active claims: cards and heroes updated, claims and shards untouched.

The trade-off: if the wiki *removes* a costume, it stays in the pool and remains
rollable. Better a stale card than a broken claim.

To run it manually against any database:

```bash
DATABASE_URL='postgresql://...' DB_SSL=true npm run ingest
```

### Known data quirks

These are handled, and worth knowing before you touch the ingest:

- **Costume ids aren't unique.** The wiki reuses one id across heroes for
  cross-hero bundles — `1048501` is both Psylocke's *and* Magik's Retro
  X-Uniform. Card ids are therefore `heroSlug:costumeId`. Keying on the bare id
  silently drops cards.
- **Role fields contain markup.** `[[File:Icon.png|20px]]Strategist` has to be
  cleaned to `Strategist`.
- **Deadpool really does have three roles.** `Vanguard / Duelist / Strategist`
  is correct data, not a parse bug.
- **Role categories are unreliable** — they double-list heroes, which is why
  roles come from the infobox field instead.
- **Default skins have no wiki pages, and are deliberately not cards.** Every
  hero has a base look, but it isn't a "costume" so it gets no article. The pool
  is exactly what the wiki documents. Mythic costumes don't exist yet either.

---

## Drop rates

Weights are **renormalised over rarities that actually have cards**. Since the
pool has no Default or Mythic costumes, those tiers are skipped and the rest
rescale:

| Rarity | Base rate | Cards in pool |
|---|---|---|
| 🔵 Rare | 72.0% | 132 |
| 🟣 Epic | 27.3% | 246 |
| 🟡 Legendary | 0.7% | 120 |

The ladder is Rare / Epic / Legendary only. The wiki has no articles for base
skins or Mythic costumes, so those tiers would have to be invented rather than
sourced — both are pinned to weight 0 so they can't start dropping unnoticed if
such cards ever appear.

Drop rate runs deliberately against pool size: Epic is about half the card pool
but only 27.3% of drops. Rarity describes how hard a card is to get, not how
many exist — so expect Rare cards to repeat often, since 132 cards absorb 72% of
all rolls.

If Mythic costumes appear in a future ingest, they enter the table
automatically with no code change.

### No pity system

Every roll is independent. There is no pity counter, no soft ramp, and no
guarantee — the numbers above are the true odds on every single roll, which is
what `/rates` reports.

That means Legendaries follow a plain geometric distribution: one per ~143
rolls on average, with a long tail. About half of players will go 100 rolls
without one and a quarter will go 200. That's the honest cost of simple,
explainable odds over a system that quietly owes you a win — and it makes a
Legendary genuinely rare rather than a matter of time.

---

## Shards and the economy

Shards are the currency. You earn them two ways and spend them on rolls.

### Earning

| Rarity | Rolled a card someone owns | Sold a card you own |
|---|---|---|
| 🔵 Rare | 💠 3 | 💠 10 |
| 🟣 Epic | 💠 10 | 💠 35 |
| 🟡 Legendary | 💠 40 | 💠 150 |

Selling pays more than the duplicate consolation because you're giving the card
up, not just seeing it.

### Spending

`/buy` is the only place shards are spent:

| Item | Price | What it does |
|---|---|---|
| Roll | 💠 200 | Banks one extra roll |
| Claim | 💠 1,000 | Banks one extra claim |

Banked credits are used **only after your hourly allowance runs out**, and they
never expire — you paid for them, so an hourly reset doesn't wipe them.

### Why these numbers

A roll's expected sell value is about **💠 17.8** (`0.72×10 + 0.273×35 +
0.007×150`), and a bought roll costs 💠 200. **The economy is deliberately,
heavily loss-making** — you cannot dump your collection to farm rolls.

In concrete terms:

- One bought roll = **20 Rares sold**, or ~6 Epics, or 1.3 Legendaries
- One bought claim = **100 Rares sold**, or ~7 Legendaries

That makes purchases a rare luxury rather than a routine top-up. Claims are
priced hardest because they're the genuinely scarce resource — buying past the
hourly limit should hurt.

Rares are the intended fuel. They're 72% of drops against a 132-card pool, so
they repeat constantly once your collection fills out — `/sellall rare` is the
natural way to convert clutter into shards.

### Collection value

`/flexers` ranks the server by total collection value, computed from the same
`SELL_VALUE` table `/sell` pays out from — so the leaderboard can never claim a
collection is worth something different from what it would actually sell for.
That also means **selling drops your rank**, which is the intended tension.

### Selling returns cards to the pool

A sold card becomes unowned, so anyone in the server can claim it again. Selling
isn't destruction; it's putting a card back on the market.

### Confirmation

Both `/sell` and `/sellall` are two-step. The prompt is ephemeral and names the
card — or lists up to 20 of them for bulk sales — with the payout, your
resulting balance, and how many rolls that buys. Nothing is sold until you press
the button, and the payout is calculated from the rows actually deleted, so a
card traded away between prompt and confirm pays nothing rather than crediting
something you no longer own.

---

## Database schema

Seven tables, defined in `src/db/schema.ts`.

| Table | Holds |
|---|---|
| `heroes` | 52 heroes — name, role, portrait |
| `cards` | 498 costumes — hero, rarity, art URL, `rollable` flag. Base skins are not cards. |
| `users` | Cross-server per-player data: currency, shards |
| `guild_settings` | Per-server tuning (see [Configuration](#configuration)) |
| `member_state` | Per-user-per-server counters: rolls, claims, cooldowns |
| `claims` | Who owns what, scoped to a server |
| `trades` | One-for-one swap offers and their status |
| `wishlist` | Wished-for cards *(table exists, feature not built)* |

Two things worth knowing:

**Player state is split deliberately.** `users` holds only cross-server data;
everything rate-limited or competitive lives in `member_state`, because the
economy is scoped per-server.

**`claims` has a unique index on `(guild_id, card_id)`.** That single constraint
is what enforces one-owner-per-server and settles claim races. Don't remove it.

To set a card aside without deleting claim history, set `cards.rollable = false`
— it leaves the roll pool but existing owners keep it.

---

## Project structure

Commands hold presentation and validation; `lib/` holds the logic they call,
which is what the tests exercise directly.

```
index.js               One-line launcher for length-limited panel hosts
src/
  bot.ts                 Client setup — logs in, routes commands/buttons/autocomplete
  index.ts               Sharded entrypoint — ShardingManager
  start.ts               Single-process entrypoint — migrations, then the bot
  migrate.ts             Applies migrations on boot
  deploy-commands.ts     Registers slash commands with Discord
  commands/
    index.ts             Command registry (also drives /commands)
    roll.ts              Card drop, shard-paid rolls, duplicate consolation
    roll5.ts             Batch of 5 — one message, one button per card
    cdcheck.ts           Cooldown and quota status
    showcase.ts          Public single-card display
    collection.ts        Paginated collection view
    rates.ts             Drop odds
    trade.ts             /trade — offer builder with inventory autocomplete
    sell.ts              /sell — single card, with confirmation
    sellall.ts           /sellall — bulk by rarity, with confirmation
    give.ts              /give — one-way card gift
    buy.ts               /buy — shard shop
    flexers.ts           /flexers — leaderboard rendering
    help.ts              /commands — built from the registry
  db/
    schema.ts            Drizzle table definitions
    index.ts             Database connection
  lib/
    gacha.ts             Rarity weights, shard and sell values
    pool.ts              Which rarities have cards (cached) + random card pick
    state.ts             Quotas, cooldowns, shard balance
    claim.ts             Persistent claim-button handler
    trade.ts             Atomic swap + trade button handler
    sell.ts              Sell/bulk-sell execution + confirmation handler
    give.ts              One-way transfer + confirmation handler
    shop.ts              Purchase execution + confirmation handler
    leaderboard.ts       Collection-value queries
    shop.ts              /buy purchases + confirmation handler
    health.ts            HTTP health endpoint (only when PORT is set)
    rarity.ts            Rarity normalisation shared by both ingest paths
scripts/
  ingest-wiki.ts         Fandom wiki ingest (primary)
  ingest.ts              marvelrivalsapi.com ingest (fallback)
tests/
  concurrency.test.ts    Integration tests — races, economy, leaderboard
drizzle/                 Generated SQL migrations
Dockerfile               Multi-stage production image
docker-compose.yml       Postgres, plus the bot behind a `prod` profile
```

---

## Why it's built this way

**Every command defers its reply.** Discord drops an interaction that isn't
answered in 3 seconds. Commands here make several sequential database round
trips, so a distant or cold-started database could blow that budget and show
"The application did not respond". Deferring converts the deadline to 15 minutes
and shows a "thinking…" state instead. Mixed-visibility commands defer only
after their gate checks, so failures like "you're out of rolls" stay private.

**Claim races are settled by Postgres, not JavaScript.** When two people click
Claim at the same instant, both handlers try to insert. The unique index means
one succeeds and the other gets a constraint violation and an ephemeral "too
slow." Checking "is it claimed?" then inserting would leave a window where both
succeed. Keep the race in the database.

**Ownership is per-server.** A card can be owned by different people in
different servers. This is Mudae's model, and it's what makes competing
meaningful — if ownership were global, latecomers could never get anything good.

**Rates are derived from the pool, not hardcoded.** An early version had
Default at 55% weight while the pool contained zero Default cards, which would
have made ~55% of rolls fail with "no cards in the pool." Deriving from live
data means the bot can't advertise odds it can't honour.

**Claim buttons are handled globally, not by message collectors.** Collectors
live in process memory, so a restart mid-window used to leave a button that
looked live but had no listener — clicking it failed, and it was never greyed
out. Expiry is now derived from the message's own timestamp, which survives
restarts and works across shards. The timer in `roll.ts` only greys the button
out cosmetically; `lib/claim.ts` is what actually enforces the window.

**Quota checks are single statements.** Reading a counter, checking it, then
writing it back lets two concurrent rolls both read the same value and both
pass. `consumeRoll` and `consumeClaim` do the check inside the `UPDATE ... WHERE`
so the database arbitrates. Losing a claim race refunds the claim, so a miss
costs nothing.

**Sharding-ready from day one.** Discord requires sharding past 2,500 guilds.
`src/index.ts` already runs a `ShardingManager`, so crossing that line is a
config change rather than a rewrite.

---

## Deployment

Production runs as a **Render Web Service** with **Neon** (managed Postgres) in
the same region. The bot process is stateless — all state lives in Postgres — so
it can be moved between hosts freely.

### Render (current setup)

| Setting | Value |
|---|---|
| Runtime | Node |
| Build Command | `npm ci && npm run build` |
| Start Command | `npm run start:single` |
| Health Check Path | `/healthz` |
| Region | Frankfurt — same as the database |
| Auto-Deploy | On Commit |

Environment variables:

```
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DATABASE_URL=postgresql://...neon.tech/neondb?sslmode=require
DB_SSL=true
DB_POOL_MAX=3
```

`DEV_GUILD_ID` must stay unset in production, or commands register to one guild
only and every other server sees nothing.

**Put the database in the same region as the bot.** A roll makes several
sequential queries; cross-continent latency multiplies across all of them and
can exceed Discord's 3-second interaction deadline. Your own location is
irrelevant — you never talk to the database, only the bot does.

### The free-tier catch

Render's free tier only covers **Web Services**, which sleep after ~15 minutes
without HTTP traffic. A sleeping bot is an offline bot. Background Workers — the
correct service type — are paid.

The workaround has two parts:

1. **The bot binds an HTTP port.** `src/lib/health.ts` starts a tiny server when
   `PORT` is set, which Render requires or it marks the deploy failed. It
   returns **503 until the gateway is actually connected**, so a half-started
   bot can't be reported healthy. On hosts that don't set `PORT` (Docker, panel
   hosts) nothing is started.
2. **An external pinger keeps it awake.** Point UptimeRobot or similar at
   `https://<service>.onrender.com/healthz` every 5–10 minutes.

Expect free-tier CPU throttling — health checks have been observed taking
several seconds. Commands still work because every one of them defers, but it's
the reason a `$4–6/mo` VPS is worth considering if the bot matters.

### Monitoring and keepalive

Live service: `https://gachamrbot.onrender.com`

The health endpoint is the single source of truth for "is the bot actually
working":

| Response | Meaning |
|---|---|
| `200 {"status":"ok"}` | Gateway connected and serving |
| `503 {"status":"starting"}` | Process up, Discord **not** connected |
| No response | Service asleep, crashed, or redeploying |

It answers on any path, so `/healthz` and `/` both work.

**Set up an external pinger — this is not optional on Render's free tier.**
Without traffic the service sleeps after ~15 minutes and the bot goes offline
until something wakes it.

1. [uptimerobot.com](https://uptimerobot.com) → **New monitor**
2. Type **HTTP(s)**, URL `https://gachamrbot.onrender.com/healthz`
3. Interval **5 minutes** (comfortably under the ~15-minute idle timeout)

Because the endpoint reports 503 until the gateway connects, a "down" alert
means the bot is genuinely broken — not merely that a web server stopped. That
makes it a real monitor rather than just a keepalive.

Don't ping more often than needed: Render's free tier allows 750 instance-hours
per month, which one continuously-running service (~730 h) just fits, leaving no
room for a second free service.

### Docker (local and VPS)

> **Don't start this while Render is serving production.** The `bot` service
> uses the live `DISCORD_TOKEN` from `.env` but the *local* Postgres — so you'd
> get two bots on one token answering every command twice, writing to two
> databases that never reconcile. Use `npm run dev` (separate bot and database)
> for local work, or stop the Render service first.

```bash
docker compose --profile prod up -d --build
```

Builds the image, waits for Postgres to be healthy, applies migrations, then
starts the bot. Plain `docker compose up -d` still starts **only** Postgres, so
local development is unaffected — the bot sits behind a `prod` profile.

- Multi-stage build, production dependencies only, ~245 MB, runs as non-root
- **tini as PID 1** — `ShardingManager` spawns children, so without signal
  forwarding a stopped container leaves orphaned shards
- `restart: unless-stopped`, verified: killing the process inside the container
  brings it back. Note `docker compose kill` counts as a *manual* stop and
  deliberately does not restart.

### Migrating off Render (self-hosting)

Render is production today. The bot is stateless — everything lives in Postgres
— so moving it is mostly a matter of *not* running two copies at once.

The `bot` compose service exists for exactly this. Its container is deleted on
the current machine (to remove the temptation to start it), but the service
definition and image build remain; `--profile prod` recreates it.

**The one rule: never two bots on one token.** Discord delivers every
interaction to both, so users see doubled replies — and if they point at
different databases, the data forks with no way to merge it back.

#### Moving to a VPS or your own machine

1. **Keep the database where it is.** Neon works from anywhere; leaving it
   alone means zero data migration and no downtime window. Only move it if you
   want to (see below).
2. Copy `.env` to the new host with the live values:
   ```
   DISCORD_TOKEN=<live token>
   DISCORD_CLIENT_ID=<app id>
   DEV_GUILD_ID=            # must stay blank
   DATABASE_URL=postgresql://...neon.tech/neondb?sslmode=require
   DB_SSL=true
   DB_POOL_MAX=5
   ```
3. **Suspend or delete the Render service first.** This is the step that
   matters — do it before starting anything else.
4. Start it:
   ```bash
   docker compose --profile prod up -d --build
   ```
   Migrations run on boot. Watch `docker compose logs -f bot` for
   `Logged in as ...`.
5. Delete the UptimeRobot monitor, or repoint it — a self-hosted bot doesn't
   sleep, so the keepalive is no longer needed. Keeping it as a *health* check
   is still useful if you expose the port.

#### Also moving the database off Neon

Only if you want everything local. With the bot stopped:

```bash
# dump from Neon (player data only — cards/heroes are re-ingestable)
docker compose exec -T db pg_dump "postgresql://...neon.tech/neondb?sslmode=require"   --data-only --no-owner --no-privileges   -t users -t guild_settings -t member_state -t claims -t trades -t wishlist > sync.sql

# prepare the target
docker compose up -d
npm run db:migrate
npm run ingest          # loads the 498 cards

# restore
docker compose exec -T db psql -U gacha -d gacha -v ON_ERROR_STOP=1 < sync.sql
```

Then point `DATABASE_URL` at the local database and start the bot.

**Dump while the bot is stopped.** A dump taken from a live bot misses
everything written afterwards — that happened during the original move to Neon,
and 21 claims plus 150 shards had to be re-synced. Verify counts on both sides
before switching over, and check for orphaned rows:

```sql
SELECT count(*) FROM claims cl LEFT JOIN cards c ON c.id = cl.card_id
WHERE c.id IS NULL;   -- must be 0
```

#### Coming back to Render

Reverse it: `docker compose --profile prod stop bot`, point Render's
`DATABASE_URL` at whichever database is current, resume the service, and
re-enable the pinger.

### Entrypoints

There are three, for different hosts:

| Entry | Used by | Behaviour |
|---|---|---|
| `dist/src/index.js` | `npm start`, Docker | ShardingManager — spawns a shard child |
| `dist/src/start.js` | `npm run start:single` | Migrations, then one process |
| `index.js` | length-limited panel fields | One-line launcher importing `start.js` |

**Prefer `start:single` on any host under ~512 MB.** Sharding only matters past
Discord's 2,500-guild threshold and doubles memory for no benefit below it.

`index.js` exists because some panels cap the "main file" field at 16
characters, and `dist/src/start.js` is 17.

### Memory

Measured **~75 MB RSS** connected, with a 21 MB heap. discord.js caches are
trimmed in `src/bot.ts` to what the bot actually reads — message, member,
presence, reaction and thread caches are all disabled, since interactions carry
the user and guild on the payload. That fits 512 MB comfortably; 128 MB is too
tight in practice.

### What won't work

- **Serverless** (Vercel, Netlify, Lambda, Cloudflare Workers) — a gateway bot
  holds a persistent WebSocket
- **GitHub** — Pages is static, Codespaces idles out, Actions caps jobs at 6
  hours and forbids CI-as-hosting
- **MySQL-only hosts** — `RETURNING`, `clock_timestamp()`, `COUNT(*) FILTER`,
  `array_position` and the `rarity` enum are Postgres-only, and they sit on the
  atomic paths that keep claims and purchases correct

Panel hosts (Pterodactyl-based, e.g. Wispbyte) can work, but expect friction:
tight disk quotas that `npm install`'s cache will exhaust, "main file" fields
that only accept a path, and eggs whose start scripts contain bugs. Shipping a
zip with `node_modules` pre-installed avoids the install step entirely — build
it with a POSIX-safe tool, since PowerShell's `Compress-Archive` writes
backslash separators that Linux extracts as literal filenames.

### Before going live

Unset `DEV_GUILD_ID` and run `npm run deploy-commands` once. Global registration
takes up to an hour to propagate.

## Troubleshooting

**Slash commands don't appear**
Run `npm run deploy-commands`. If `DEV_GUILD_ID` is blank, commands register
globally and take up to an hour. Set it to your server for instant registration.

**Card drops as a blank message, no art**
The bot lacks **Embed Links** in that channel. Check channel-level permission
overwrites — they override server-level grants, and this fails silently.

**`/roll` says "No cards in the pool yet"**
The `cards` table is empty. Run `npm run ingest`.

**Bot is offline and commands don't respond at all**
On Render's free tier the service sleeps after ~15 minutes without HTTP traffic.
Check `https://gachamrbot.onrender.com/healthz` — if it hangs then eventually
answers, it was asleep and has just woken. Fix: confirm the UptimeRobot monitor
is active and hitting it every 5 minutes.

**`/healthz` returns 503**
The process is running but the Discord gateway isn't connected. Almost always a
bad or reset `DISCORD_TOKEN`. Check Render's logs for a login error.

**Commands are slow (several seconds)**
Free-tier CPU throttling. Every command defers, so this shows as a "thinking…"
pause rather than a failure. No code change fixes it — it needs a paid instance
or a VPS.

**Bot joined a new server but shows no commands**
Almost always `DEV_GUILD_ID` being set when the live commands were registered —
guild-scoped commands exist *only* in that one guild, so every other server sees
nothing. Blank it in `.env`, run `npm run deploy-commands`, and allow up to an
hour for global propagation. Verify what's actually registered with:

```bash
npx tsx -e "import 'dotenv/config';import {REST,Routes} from 'discord.js';const r=new REST().setToken(process.env.DISCORD_TOKEN);console.log((await r.get(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID))).map(c=>c.name))"
```

**Every command appears twice**
Both a global and a guild-scoped registration exist. Clear the guild copy by
PUTting an empty array to `applicationGuildCommands`, keeping the global set.

**Commands still missing after an hour**
Try Ctrl+R in Discord first. There are two caches — Discord's propagation *and*
your local client's copy of the command list. If one person sees the commands
and another doesn't in the same server, it's the client cache, not registration.

**Bot responds to everything twice**
Two instances are running on the same token. Find and kill the extras:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*src/bot.ts*' }
```

Note that one logical bot shows as ~3 processes (npx → tsx → node). Six means
two instances.

**`DATABASE_URL is not set`**
No `.env` file. `cp .env.example .env` and fill it in.

**Ingest reports skipped rarities**
The wiki introduced a rarity value we don't recognise. Add it to
`normaliseRarity()` in `src/lib/rarity.ts`.

**Ingest crashes on a unique violation**
Two pages produced the same card id. Card ids are `heroSlug:costumeId`, so this
means a genuine within-hero duplicate — inspect the pages before de-duping, since
the last occurrence turned out to be real distinct cards.

---

## Roadmap

Built and working:

- [x] Card ingestion from the wiki, with an API fallback
- [x] `/roll` with competitive claim races
- [x] `/collection` with pagination
- [x] `/rates` with live pool-derived odds
- [x] Shard consolation for duplicates
- [x] Trading — one-for-one swaps with autocomplete and atomic execution
- [x] Sell economy — `/sell`, `/sellall`, and `/buy` for rolls and claims
- [x] `/flexers` leaderboard
- [x] `/give` — one-way card gifts
- [x] `/roll5` batch rolls with per-card claim buttons (Components V2)
- [x] `/cdcheck` and `/showcase`
- [x] Production Docker image with migrations on boot and verified crash recovery
- [x] Separate dev bot and dev database for iterating without touching live
- [x] Deployed to Render with Neon Postgres, health endpoint and migrations on boot

Not built yet:

- [ ] **Admin config commands** — `guild_settings` is tunable only via raw SQL, which doesn't scale past your own server.
- [ ] **Targeted pull** — spend a larger shard sum to roll a chosen hero.
- [ ] **Multi-card trades** — the current flow is strictly one card for one card.
- [ ] **Wishlist DM pings** — table exists, unused. Strongest retention feature; needs care around DM rate limits and users with DMs closed.
- [ ] **Paid hosting** — running on Render's free tier, which needs an external pinger and throttles CPU. A small VPS or a Background Worker would remove both.

---

## Legal

Marvel Rivals characters and artwork are the property of NetEase Games and
Marvel Entertainment. The Fandom wiki and marvelrivalsapi.com are unofficial
community resources, endorsed by neither.

Card art is referenced by URL rather than rehosted, which helps, but this is
worth genuine scrutiny before distributing widely or monetising.
