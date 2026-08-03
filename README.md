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
- [Configuration](#configuration)
- [Card data and ingestion](#card-data-and-ingestion)
- [Drop rates and pity](#drop-rates-and-pity)
- [Shards](#shards)
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
scarce.** You get 20 rolls an hour but only 1 claim. That's what makes people
watch the channel instead of spamming rolls — you have to decide whether the
card in front of you is worth your one claim.

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
| `/roll` | Anyone | Drops a random card with a 30-second Claim button |
| `/collection [user]` | Anyone | Paginated list of cards claimed in this server, 10 per page, sorted by rarity. Omit `user` for your own. Footer shows your shard balance. |
| `/rates` | Anyone | Current drop odds and your pity counter. Ephemeral — only you see it. |
| `/commands` | Anyone | Lists every command. Built from the live registry, so it can't fall out of date. Ephemeral. |

Rates shown by `/rates` are calculated from the live card pool, so they always
reflect what the bot will actually do rather than a static table that can drift.

---

## npm scripts

### Running the bot

| Script | What it does |
|---|---|
| `npm run dev` | Single-process bot with hot reload. **Use this for development.** |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Production entrypoint — runs `dist/index.js`, a sharding manager. Requires `npm run build` first. |

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
card pool, because the bugs they cover (quota races, claim races) only exist at
the database boundary. They clean up after themselves.

Re-run `deploy-commands` whenever you add a command or change its name,
description, or options. You don't need it for changes to command *logic*.

---

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
| `claims_per_hour` | 1 | **The main dial.** Claims per user per hour. |
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
- **No Default or Mythic costumes exist** on the wiki, so the live pool is
  rare/epic/legendary only. The bot handles this automatically (see below).

---

## Drop rates and pity

Weights are **renormalised over rarities that actually have cards**. Since the
pool has no Default or Mythic costumes, those tiers are skipped and the rest
rescale:

| Rarity | Base weight | Live rate | Cards in pool |
|---|---|---|---|
| ⚪ Default | 55 | — | 0 |
| 🔵 Rare | 28 | 62.9% | 132 |
| 🟣 Epic | 13 | 29.2% | 246 |
| 🟡 Legendary | 3.5 | 7.9% | 120 |
| 🔴 Mythic | 0.5 | — | 0 |

If Mythic costumes appear in a future ingest, they enter the table
automatically with no code change.

### Pity

Legendary and Mythic weight starts climbing at **50 rolls** without one, and is
**guaranteed at 90**.

Simulated over 300,000 rolls against the live pool:

```
epic       29.29%
rare       62.79%
legendary   7.91%
worst streak: 67 rolls (hard pity 90)
```

Soft pity does the real work — the hard cap is rarely reached.

---

## Shards

Rolling a card someone already owns pays out shards instead of nothing:

| Rarity | Shards |
|---|---|
| 🔵 Rare | 3 |
| 🟣 Epic | 10 |
| 🟡 Legendary | 40 |
| 🔴 Mythic | 150 |

Your balance shows in the drop embed and in `/collection`'s footer.

> **Shards currently have no sink.** They accumulate and display, but nothing
> spends them yet. The intended use is a targeted pull — spend shards to roll a
> specific hero. Until that's built they're a score, not a currency.

Shard payouts are rare early on: with only a handful of cards claimed, the odds
of rolling an owned one are under 1%. It becomes a real mechanic as a server's
collection fills out.

---

## Database schema

Seven tables, defined in `src/db/schema.ts`.

| Table | Holds |
|---|---|
| `heroes` | 52 heroes — name, role, portrait |
| `cards` | 498 costumes — hero, rarity, art URL, `rollable` flag |
| `users` | Cross-server per-player data: currency, shards |
| `guild_settings` | Per-server tuning (see [Configuration](#configuration)) |
| `member_state` | Per-user-per-server counters: rolls, claims, cooldowns, pity |
| `claims` | Who owns what, scoped to a server |
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

```
src/
  bot.ts                 Dev entrypoint — single process, logs in, routes interactions
  index.ts               Production entrypoint — ShardingManager
  deploy-commands.ts     Registers slash commands with Discord
  commands/
    index.ts             Command registry
    roll.ts              Card drop, claim race, shard consolation
    collection.ts        Paginated collection view
    rates.ts             Drop odds and pity counter
  db/
    schema.ts            Drizzle table definitions
    index.ts             Database connection
  lib/
    gacha.ts             Rarity weights, pity curve, shard payouts
    pool.ts              Which rarities have cards (cached)
    state.ts             Rate limits, quotas, pity, shard balance
    rarity.ts            Rarity normalisation shared by both ingest paths
scripts/
  ingest-wiki.ts         Fandom wiki ingest (primary)
  ingest.ts              marvelrivalsapi.com ingest (fallback)
drizzle/                 Generated SQL migrations
```

---

## Why it's built this way

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

## Troubleshooting

**Slash commands don't appear**
Run `npm run deploy-commands`. If `DEV_GUILD_ID` is blank, commands register
globally and take up to an hour. Set it to your server for instant registration.

**Card drops as a blank message, no art**
The bot lacks **Embed Links** in that channel. Check channel-level permission
overwrites — they override server-level grants, and this fails silently.

**`/roll` says "No cards in the pool yet"**
The `cards` table is empty. Run `npm run ingest`.

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
- [x] Pity system
- [x] Shard consolation for duplicates

Not built yet:

- [ ] **Shard sink** — spend shards on a targeted pull. Closes the loop; shards are currently unspendable.
- [ ] **Admin config commands** — `guild_settings` is tunable only via raw SQL, which doesn't scale past your own server.
- [ ] **Trading** — needs a `trades` table plus card locking so one card can't sit in two pending trades.
- [ ] **Wishlist DM pings** — table exists, unused. Strongest retention feature; needs care around DM rate limits and users with DMs closed.
- [ ] **Currency and shop** — a second sink alongside shards.
- [ ] **Deployment** — no Dockerfile for the bot itself yet; it currently runs as a local process.

---

## Legal

Marvel Rivals characters and artwork are the property of NetEase Games and
Marvel Entertainment. The Fandom wiki and marvelrivalsapi.com are unofficial
community resources, endorsed by neither.

Card art is referenced by URL rather than rehosted, which helps, but this is
worth genuine scrutiny before distributing widely or monetising.
