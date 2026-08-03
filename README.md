# GachaMRBot

A Mudae-style Marvel Rivals gacha bot for Discord. Cards are **costumes**, not
heroes — 52 heroes would be a boring pool, but every hero × every skin gets you
into the many hundreds, and the in-game rarity tiers come along for free.

## How it plays

`/roll` drops a card into the channel. Anyone watching can race to hit **Claim**
within the claim window. Within a server a card has exactly one owner, so if
someone already holds it the drop shows their name instead of a button.

Rolls are cheap and rate-limited per hour; claims are the scarce resource
(1/hour by default). That split is what makes people hover over the channel.

## Setup

**1. Discord application**

Create an app at [discord.com/developers](https://discord.com/developers/applications),
add a bot, copy the token. No privileged intents are needed — everything runs on
slash commands and buttons. Invite it with the `bot` and `applications.commands`
scopes.

**2. Config**

```bash
cp .env.example .env
```

Fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and `DEV_GUILD_ID` (your test
server — makes commands register instantly instead of taking an hour).

**3. Database**

```bash
docker compose up -d
npm run db:migrate
```

**4. Card data**

```bash
npm run ingest -- --dry --limit 60   # inspect what would be imported
npm run ingest                       # write it
```

No key needed — this reads the Marvel Rivals Fandom wiki, whose
`{{Costume page}}` infobox carries hero, rarity, in-game id and icon as
structured fields. Re-run weekly; the roster grows every season.

`npm run ingest:api` is an alternative path against
[marvelrivalsapi.com](https://marvelrivalsapi.com) (needs `MARVEL_RIVALS_API_KEY`).
It's a fallback, not the default — that host returned 502 repeatedly during
development. **Pick one and stick with it:** the two sources use different hero
id schemes, so alternating them will duplicate cards.

Either way the bot never calls an external API at roll time; rolls hit Postgres
only, so an upstream outage can't affect gameplay.

**5. Run**

```bash
npm run deploy-commands
npm run dev
```

## Commands

| Command | What it does |
|---|---|
| `/roll` | Drop a card with a timed Claim button |
| `/collection [user]` | Paginated view of claimed cards |
| `/rates` | Current drop odds and your pity counter |

## Drop rates

Rarities mirror the in-game costume tiers, so the ladder is grounded in real
game data rather than invented numbers.

Weights are **renormalised over the rarities that actually have cards**. The
wiki has no Default or Mythic costume pages, so the live 498-card pool is
rare/epic/legendary only; if Mythics appear in a later ingest they enter the
table automatically with no code change.

| Rarity | Base weight | Live rate | Cards |
|---|---|---|---|
| ⚪ Default | 55 | — | 0 |
| 🔵 Rare | 28 | 62.9% | 132 |
| 🟣 Epic | 13 | 29.2% | 246 |
| 🟡 Legendary | 3.5 | 7.9% | 120 |
| 🔴 Mythic | 0.5 | — | 0 |

Pity ramps Legendary/Mythic weight from roll 50 and guarantees one at 90.
Simulated over 300k rolls against the live pool: 7.91% legendary, worst observed
streak 67 — soft pity means the hard cap is rarely reached.

Because rates are pool-derived, `/rates` always reports what the bot will
actually do rather than a static table that can drift from the data.

Tune per server in `guild_settings` — cooldown, rolls/hour, claims/hour, claim
window, and an optional channel lock.

## Architecture notes

- **Claim races are settled by Postgres**, not JavaScript. A unique index on
  `(guild_id, card_id)` means simultaneous clicks can't both win; the loser gets
  a constraint violation and an ephemeral "too slow".
- **Ownership is per-guild.** Mudae's model — your collection is scoped to the
  server, which is what makes competing for a card meaningful.
- **Sharding-ready.** `src/index.ts` runs a `ShardingManager`; Discord requires
  sharding past 2,500 guilds and this makes that a config change.
- `src/bot.ts` is the single-process dev entrypoint.

## Not built yet

Trading, currency/shop, duplicate→shard conversion (weights are defined in
`src/lib/gacha.ts`), wishlist notifications, and per-guild admin config
commands. The schema already has tables for shards and wishlists.

## Legal

Marvel Rivals characters and artwork are property of NetEase Games and Marvel.
[marvelrivalsapi.com](https://marvelrivalsapi.com) is an unofficial community
API, not endorsed by either. Card images are referenced by URL rather than
rehosted. Worth a hard look before distributing this widely or monetising it.
