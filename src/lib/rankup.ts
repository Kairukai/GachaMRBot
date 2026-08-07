/**
 * Card ranking and the burn that pays for it.
 *
 * The hard part is not the arithmetic — it is that the confirmation prompt is
 * stale by the time the button is clicked. Rolls refresh hourly and cards move
 * constantly through trades, gifts and sells, so any fodder list built when the
 * prompt rendered may reference cards the user no longer owns.
 *
 * Nothing here trusts that snapshot. Everything runs in one transaction, every
 * write is scoped to the current owner, and the result is derived from rows
 * actually affected — the same discipline as `executeSwap` and `sellCards`.
 * If anything moved underneath us the whole thing rolls back and reports why,
 * rather than destroying cards for a rank-up that didn't happen.
 */
import {
  EmbedBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  MessageFlags,
  type ButtonInteraction,
} from "discord.js";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { RARITY_META, type Rarity } from "./gacha.js";
import { MAX_RANK } from "./battle.js";

/**
 * What each rarity is worth as fodder.
 *
 * Points rather than fixed counts, because ownership is exclusive: there are
 * no duplicates to feed, so every fodder card is a distinct hero someone won a
 * claim race for. "Burn three copies" is impossible here; "burn three cards
 * worth this much" is the only workable shape.
 */
export const FODDER_VALUE: Record<Rarity, number> = {
  default: 1,
  rare: 1,
  epic: 4,
  legendary: 15,
  mythic: 25,
};

export interface RankCost {
  points: number;
  /** Legendary fodder cards required, on top of the points. */
  legendaries: number;
  shards: number;
}

/**
 * Cost to reach each rank, indexed by the rank being reached.
 *
 * Legendaries gate the top half only. Requiring one at every step would put
 * rank 2 three days away — a Legendary is ~143 rolls, about 7 hours at the
 * 20/hour cap and realistically one every 2.5-3.5 days — and a new player would
 * see no progression at all in their first week. Volume carries ranks 2-4;
 * Legendaries make ranks 5+ the commitment.
 *
 * The shard column is deliberately heavy. Shards had no sink but `/buy` and
 * simply accumulated; 18k for a maxed card drains that properly.
 */
export const RANK_COST: Record<number, RankCost> = {
  2: { points: 8, legendaries: 0, shards: 200 },
  3: { points: 12, legendaries: 0, shards: 400 },
  4: { points: 18, legendaries: 0, shards: 700 },
  5: { points: 25, legendaries: 1, shards: 1_100 },
  6: { points: 35, legendaries: 1, shards: 1_600 },
  7: { points: 45, legendaries: 1, shards: 2_200 },
  8: { points: 60, legendaries: 2, shards: 3_000 },
  9: { points: 80, legendaries: 2, shards: 4_000 },
  10: { points: 100, legendaries: 2, shards: 5_000 },
};

/** Only these can hold a rank above 1. */
const RANKABLE: ReadonlySet<Rarity> = new Set<Rarity>(["epic", "legendary"]);

export const RANKUP_PREFIX = "rankup:";

/** Cards eligible to be ranked up, for `/rankup` autocomplete. */
export async function rankableOwned(guildId: string, userId: string, query: string) {
  const rows = await db
    .select({
      id: schema.cards.id,
      name: schema.cards.name,
      rarity: schema.cards.rarity,
      hero: schema.heroes.name,
      rank: schema.claims.rank,
    })
    .from(schema.claims)
    .innerJoin(schema.cards, eq(schema.claims.cardId, schema.cards.id))
    .innerJoin(schema.heroes, eq(schema.cards.heroId, schema.heroes.id))
    .where(
      and(
        eq(schema.claims.guildId, guildId),
        eq(schema.claims.userId, userId),
        inArray(schema.cards.rarity, ["epic", "legendary"]),
        sql`${schema.claims.rank} < ${MAX_RANK}`,
        query
          ? sql`(${schema.heroes.name} || ' ' || ${schema.cards.name}) ILIKE ${"%" + query + "%"}`
          : sql`true`,
      ),
    )
    .limit(25);

  return rows.map((r) => ({
    name: `R${r.rank}→${r.rank + 1} · ${r.hero} — ${r.name}`.slice(0, 100),
    value: r.id,
  }));
}

export interface FodderPick {
  cardId: string;
  name: string;
  hero: string;
  rarity: Rarity;
}

export type FodderPlan =
  | { ok: true; cards: FodderPick[]; points: number; legendaries: number }
  | { ok: false; havePoints: number; needPoints: number; haveLegendaries: number; needLegendaries: number };

/**
 * Chooses what to burn, cheapest first.
 *
 * Exclusive ownership means there are no duplicate cards to feed, so a rank-up
 * can need twenty distinct cards — far too many to pick by hand through
 * Discord's UI. This picks them: Legendaries only up to the number the gate
 * demands, then Rares, then Epics, so the cheapest possible set is spent.
 *
 * Ranked cards are never eligible, matching the refusal in `rankUp`.
 *
 * Deliberately re-run at confirm time rather than encoded in the button id —
 * card ids don't fit in a 100-character custom id, and the same recompute-don't-
 * snapshot rule that `/sellall` follows applies here.
 */
export async function planFodder(
  guildId: string,
  userId: string,
  targetCardId: string,
  cost: RankCost,
): Promise<FodderPlan> {
  const owned = await db
    .select({
      cardId: schema.claims.cardId,
      name: schema.cards.name,
      hero: schema.heroes.name,
      rarity: schema.cards.rarity,
    })
    .from(schema.claims)
    .innerJoin(schema.cards, eq(schema.claims.cardId, schema.cards.id))
    .innerJoin(schema.heroes, eq(schema.cards.heroId, schema.heroes.id))
    .where(
      and(
        eq(schema.claims.guildId, guildId),
        eq(schema.claims.userId, userId),
        eq(schema.claims.rank, 1),
        sql`${schema.claims.cardId} <> ${targetCardId}`,
      ),
    )
    .orderBy(asc(schema.cards.id));

  const byRarity = (r: Rarity) => owned.filter((c) => (c.rarity as Rarity) === r);
  const legendaries = byRarity("legendary");
  const rares = byRarity("rare");
  const epics = byRarity("epic");

  const picked: FodderPick[] = [];
  const take = (row: (typeof owned)[number]) =>
    picked.push({
      cardId: row.cardId,
      name: row.name,
      hero: row.hero,
      rarity: row.rarity as Rarity,
    });

  // The Legendary gate first — those cards are required, not merely valuable.
  for (const l of legendaries.slice(0, cost.legendaries)) take(l);

  let points = picked.reduce((n, c) => n + FODDER_VALUE[c.rarity], 0);
  // Then cheapest-first to cover the remaining points.
  for (const c of [...rares, ...epics, ...legendaries.slice(cost.legendaries)]) {
    if (points >= cost.points) break;
    take(c);
    points += FODDER_VALUE[c.rarity as Rarity];
  }

  const haveLegendaries = picked.filter((c) => c.rarity === "legendary").length;
  if (points < cost.points || haveLegendaries < cost.legendaries) {
    const totalPoints = owned.reduce((n, c) => n + FODDER_VALUE[c.rarity as Rarity], 0);
    return {
      ok: false,
      havePoints: totalPoints,
      needPoints: cost.points,
      haveLegendaries: legendaries.length,
      needLegendaries: cost.legendaries,
    };
  }

  return { ok: true, cards: picked, points, legendaries: haveLegendaries };
}

/** Current rank and rarity of a card the user owns, or null. */
export async function rankState(guildId: string, userId: string, cardId: string) {
  const [row] = await db
    .select({
      rank: schema.claims.rank,
      rarity: schema.cards.rarity,
      name: schema.cards.name,
      hero: schema.heroes.name,
      image: schema.cards.imageUrl,
    })
    .from(schema.claims)
    .innerJoin(schema.cards, eq(schema.claims.cardId, schema.cards.id))
    .innerJoin(schema.heroes, eq(schema.cards.heroId, schema.heroes.id))
    .where(
      and(
        eq(schema.claims.guildId, guildId),
        eq(schema.claims.userId, userId),
        eq(schema.claims.cardId, cardId),
      ),
    );
  return row ?? null;
}

export type RankUpFailure =
  | { code: "target_not_owned" }
  | { code: "target_not_rankable"; rarity: Rarity }
  | { code: "already_max" }
  | { code: "target_in_fodder" }
  | { code: "duplicate_fodder" }
  | { code: "no_fodder" }
  | { code: "fodder_missing"; expected: number; found: number }
  | { code: "fodder_ranked"; cardIds: string[] }
  | { code: "insufficient_points"; need: number; have: number }
  | { code: "insufficient_legendaries"; need: number; have: number }
  | { code: "insufficient_shards"; need: number };

export type RankUpResult =
  | {
      ok: true;
      fromRank: number;
      toRank: number;
      burned: number;
      points: number;
      shardsSpent: number;
      shardBalance: number;
    }
  | { ok: false; failure: RankUpFailure };

/**
 * Thrown to abort a burn. This has to be an exception, not a return value:
 * returning from inside `db.transaction` COMMITS. Every failure below the
 * shard deduction would otherwise charge the user, delete their fodder, and
 * then report that nothing happened — the exact class of bug this whole module
 * exists to prevent. Throwing is the only thing that rolls back.
 */
class BurnAbort extends Error {
  constructor(readonly failure: RankUpFailure) {
    super(`burn aborted: ${failure.code}`);
  }
}

/**
 * Ranks up one card by burning fodder and shards.
 *
 * Ordering inside the transaction is deliberate: the single `users` row first,
 * then claims. Every burn touching a given user takes the same locks in the
 * same order, and because ownership is exclusive per guild, two players can
 * never have overlapping fodder — so concurrent burns by different users touch
 * disjoint rows entirely. The only real contention is a trade landing on the
 * same claim mid-burn, which rolls back cleanly and can be retried.
 */
export async function rankUp(
  guildId: string,
  userId: string,
  targetCardId: string,
  fodderCardIds: readonly string[],
): Promise<RankUpResult> {
  // Annotated on the variable, not just the arrow: TypeScript only narrows
  // control flow through a never-returning call when the binding itself is
  // explicitly typed.
  const abort: (failure: RankUpFailure) => never = (failure) => {
    throw new BurnAbort(failure);
  };
  const fail = (failure: RankUpFailure): RankUpResult => ({
    ok: false,
    failure,
  });

  // Cheap structural checks first — no point opening a transaction to discover
  // the user listed the same card twice.
  if (fodderCardIds.length === 0) return fail({ code: "no_fodder" });
  if (fodderCardIds.includes(targetCardId))
    return fail({ code: "target_in_fodder" });
  if (new Set(fodderCardIds).size !== fodderCardIds.length) {
    return fail({ code: "duplicate_fodder" });
  }

  try {
    return await db.transaction(async (tx): Promise<RankUpResult> => {
      const [target] = await tx
        .select({ rank: schema.claims.rank, rarity: schema.cards.rarity })
        .from(schema.claims)
        .innerJoin(schema.cards, eq(schema.cards.id, schema.claims.cardId))
        .where(
          and(
            eq(schema.claims.guildId, guildId),
            eq(schema.claims.userId, userId),
            eq(schema.claims.cardId, targetCardId),
          ),
        );

      if (!target) abort({ code: "target_not_owned" });
      const rarity = target.rarity as Rarity;
      if (!RANKABLE.has(rarity)) abort({ code: "target_not_rankable", rarity });
      if (target.rank >= MAX_RANK) abort({ code: "already_max" });

      const nextRank = target.rank + 1;
      const cost = RANK_COST[nextRank]!;

      /**
       * Price the fodder from the rows the user still owns, not from the ids
       * they submitted. A card traded away since the prompt rendered simply is
       * not in this result, and the count check below catches it.
       */
      const owned = await tx
        .select({
          cardId: schema.claims.cardId,
          rank: schema.claims.rank,
          rarity: schema.cards.rarity,
        })
        .from(schema.claims)
        .innerJoin(schema.cards, eq(schema.cards.id, schema.claims.cardId))
        .where(
          and(
            eq(schema.claims.guildId, guildId),
            eq(schema.claims.userId, userId),
            inArray(schema.claims.cardId, [...fodderCardIds]),
          ),
        );

      if (owned.length !== fodderCardIds.length) {
        abort({
          code: "fodder_missing",
          expected: fodderCardIds.length,
          found: owned.length,
        });
      }

      /**
       * Ranked cards are never valid fodder. Feeding a rank-8 Legendary into a
       * rank-up destroys weeks of claim quota for a fraction of its worth, and
       * there is no legitimate reason to want it — so this is a refusal rather
       * than a confirmation prompt.
       */
      const ranked = owned.filter((c) => c.rank > 1).map((c) => c.cardId);
      if (ranked.length) abort({ code: "fodder_ranked", cardIds: ranked });

      const points = owned.reduce(
        (sum, c) => sum + FODDER_VALUE[c.rarity as Rarity],
        0,
      );
      if (points < cost.points) {
        abort({ code: "insufficient_points", need: cost.points, have: points });
      }

      const legendaries = owned.filter((c) => c.rarity === "legendary").length;
      if (legendaries < cost.legendaries) {
        abort({
          code: "insufficient_legendaries",
          need: cost.legendaries,
          have: legendaries,
        });
      }

      /**
       * Conditional UPDATE, and inside this transaction rather than through
       * `spendShards` — that helper runs on `db`, so calling it here would commit
       * the charge independently and leave the user paying for a burn that rolled
       * back.
       */
      const paid = await tx
        .update(schema.users)
        .set({ shards: sql`${schema.users.shards} - ${cost.shards}` })
        .where(
          and(
            eq(schema.users.id, userId),
            sql`${schema.users.shards} >= ${cost.shards}`,
          ),
        )
        .returning({ shards: schema.users.shards });

      if (paid.length === 0)
        abort({ code: "insufficient_shards", need: cost.shards });

      /**
       * The load-bearing statement. Scoped to this owner in this guild, so it can
       * only delete cards still held right now, and the count check turns any
       * discrepancy into a rollback. This alone defeats stale prompts, a card
       * listed twice, and a double-clicked Confirm button — the second click
       * deletes zero rows and aborts, leaving the first burn intact.
       */
      const removed = await tx
        .delete(schema.claims)
        .where(
          and(
            eq(schema.claims.guildId, guildId),
            eq(schema.claims.userId, userId),
            inArray(schema.claims.cardId, [...fodderCardIds]),
          ),
        )
        .returning({ cardId: schema.claims.cardId });

      if (removed.length !== fodderCardIds.length) {
        abort({
          code: "fodder_missing",
          expected: fodderCardIds.length,
          found: removed.length,
        });
      }

      /**
       * Scoped to the rank we read at the top, so two burns racing on the same
       * target cannot both apply. The loser matches zero rows and rolls back
       * rather than spending a second set of fodder for one rank.
       */
      const bumped = await tx
        .update(schema.claims)
        .set({ rank: nextRank })
        .where(
          and(
            eq(schema.claims.guildId, guildId),
            eq(schema.claims.userId, userId),
            eq(schema.claims.cardId, targetCardId),
            eq(schema.claims.rank, target.rank),
          ),
        )
        .returning({ rank: schema.claims.rank });

      if (bumped.length === 0) abort({ code: "target_not_owned" });

      await tx.insert(schema.burns).values({
        guildId,
        userId,
        targetCardId,
        fromRank: target.rank,
        toRank: nextRank,
        fodderCardIds: [...fodderCardIds],
        fodderPoints: points,
        shardsSpent: cost.shards,
      });

      return {
        ok: true,
        fromRank: target.rank,
        toRank: nextRank,
        burned: removed.length,
        points,
        shardsSpent: cost.shards,
        shardBalance: paid[0]!.shards,
      };
    });
  } catch (err) {
    if (err instanceof BurnAbort) return fail(err.failure);
    throw err;
  }
}

/* ----------------------------------------------------------- interaction */

export function rankUpConfirmRow(cardId: string, label: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RANKUP_PREFIX}go:${cardId}`)
      .setLabel(label)
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${RANKUP_PREFIX}cancel`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}

function settledRow(label: string) {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${RANKUP_PREFIX}settled`)
      .setLabel(label)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
  );
}

/** Player-facing text for each way a burn can be refused. */
export function explainFailure(f: RankUpFailure): string {
  switch (f.code) {
    case "target_not_owned":
      return "You no longer own that card — it changed hands before you confirmed. Nothing was burned.";
    case "target_not_rankable":
      return `${f.rarity === "rare" ? "Rares" : "Those"} can't be ranked up. Only Epics and Legendaries can.`;
    case "already_max":
      return `That card is already Rank ${MAX_RANK}.`;
    case "target_in_fodder":
      return "A card can't be burned into itself.";
    case "duplicate_fodder":
      return "The same card was listed twice as fodder.";
    case "no_fodder":
      return "You have nothing to burn.";
    case "fodder_missing":
      return (
        `Your collection changed while you were deciding — ${f.expected - f.found} of the ` +
        "cards to burn are no longer yours. Nothing was burned; run the command again."
      );
    case "fodder_ranked":
      return "Ranked cards can never be used as fodder. Nothing was burned.";
    case "insufficient_points":
      return `Not enough fodder: ${f.have}/${f.need} points.`;
    case "insufficient_legendaries":
      return `This rank needs ${f.need} Legendary fodder card(s); you have ${f.have}.`;
    case "insufficient_shards":
      return `You need 💠 ${f.need} shards for this rank.`;
  }
}

export async function handleRankUpButton(interaction: ButtonInteraction) {
  const rest = interaction.customId.slice(RANKUP_PREFIX.length);
  const [action, ...idParts] = rest.split(":");
  // Card ids contain a colon (heroSlug:costumeId), so rejoin what split broke.
  const cardId = idParts.join(":");

  if (action === "cancel" || action === "settled") {
    return interaction.update({ components: [settledRow("Cancelled")] });
  }
  if (action !== "go" || !cardId) return;

  const guildId = interaction.guildId!;
  const userId = interaction.user.id;

  const state = await rankState(guildId, userId, cardId);
  if (!state) {
    await interaction.update({ components: [settledRow("No longer valid")] }).catch(() => {});
    return interaction.followUp({
      content: explainFailure({ code: "target_not_owned" }),
      flags: MessageFlags.Ephemeral,
    });
  }

  const cost = RANK_COST[state.rank + 1];
  if (!cost) {
    await interaction.update({ components: [settledRow("Maxed")] }).catch(() => {});
    return;
  }

  /**
   * Re-planned here rather than replayed from the prompt. The set can differ
   * from what was shown if the collection changed in between — which is the
   * honest behaviour, since the alternative is burning cards that are no longer
   * the cheapest, or failing outright on a set that is merely stale.
   */
  const plan = await planFodder(guildId, userId, cardId, cost);
  if (!plan.ok) {
    await interaction.update({ components: [settledRow("Not enough fodder")] }).catch(() => {});
    return interaction.followUp({
      content: explainFailure({
        code: "insufficient_points",
        need: plan.needPoints,
        have: plan.havePoints,
      }),
      flags: MessageFlags.Ephemeral,
    });
  }

  const result = await rankUp(
    guildId,
    userId,
    cardId,
    plan.cards.map((c) => c.cardId),
  );

  if (!result.ok) {
    await interaction.update({ components: [settledRow("Failed")] }).catch(() => {});
    return interaction.followUp({
      content: explainFailure(result.failure),
      flags: MessageFlags.Ephemeral,
    });
  }

  const embed = new EmbedBuilder()
    .setTitle(`Rank ${result.fromRank} → ${result.toRank}`)
    .setColor(RARITY_META[state.rarity as Rarity].color)
    .setDescription(
      `## ${RARITY_META[state.rarity as Rarity].emoji} ${state.hero} — ${state.name}\n` +
        `Now **Rank ${result.toRank}**.`,
    )
    .addFields(
      { name: "Burned", value: `${result.burned} card(s)`, inline: true },
      { name: "Shards", value: `💠 ${result.shardsSpent}`, inline: true },
      { name: "Balance", value: `💠 ${result.shardBalance}`, inline: true },
    )
    .setFooter({ text: "Burned cards return to the pool for anyone to claim." });

  if (state.image) embed.setThumbnail(state.image);

  await interaction.update({ embeds: [embed], components: [settledRow("Ranked up")] });
}
