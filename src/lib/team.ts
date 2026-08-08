/**
 * Saved 6v6 line-ups.
 *
 * Two jobs, deliberately separated:
 *
 *   setTeam      — validates the four roster rules and persists the line-up
 *   resolveTeam  — turns a saved line-up into combat units AT BATTLE TIME
 *
 * The split matters because a team is stored once and fought many times. Cards
 * get sold, traded and burned in between, so the saved rows are a statement of
 * intent, not a guarantee of ownership. Nothing trusts them: `resolveTeam`
 * re-checks who owns what against `claims` and drops anything that moved.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { Rarity } from "./gacha.js";
import {
  TEAM_SIZE,
  validateTeam,
  type Role,
  type TeamViolation,
  type Unit,
} from "./battle.js";

export const ROLE_CHOICES: Role[] = ["vanguard", "duelist", "strategist"];

/**
 * Parses the wiki's role text into our enum.
 *
 * Returns every role the hero can fill — Deadpool is genuinely listed as
 * "Vanguard / Duelist / Strategist", which is why a slot stores a declared role
 * rather than deriving one.
 */
export function parseRoles(raw: string | null): Role[] {
  if (!raw) return [];
  const found = raw
    .split("/")
    .map((part) => part.trim().toLowerCase())
    .filter((part): part is Role => (ROLE_CHOICES as string[]).includes(part));
  return [...new Set(found)];
}

export interface SlotInput {
  cardId: string;
  /** Only needed for multi-role heroes; otherwise derived. */
  role?: Role;
}

export interface TeamCard {
  slot: number;
  cardId: string;
  role: Role;
  name: string;
  hero: string;
  heroId: string;
  rarity: Rarity;
  rank: number;
}

export type SetTeamResult =
  | { ok: true; team: TeamCard[] }
  | { ok: false; violations: TeamViolation[] }
  | { ok: false; notOwned: string[] }
  | { ok: false; needsRole: { cardId: string; hero: string; options: Role[] }[] };

/**
 * Validates and saves a line-up.
 *
 * Ownership is checked here too, but only as a courtesy — it is re-checked at
 * battle time because it can change at any moment. Saving a card you own now
 * and losing it later is legal and expected; it just costs you the slot.
 */
export async function setTeam(
  guildId: string,
  userId: string,
  slots: SlotInput[],
): Promise<SetTeamResult> {
  const cardIds = slots.map((s) => s.cardId);

  const owned = await db
    .select({
      cardId: schema.claims.cardId,
      rank: schema.claims.rank,
      rarity: schema.cards.rarity,
      name: schema.cards.name,
      hero: schema.heroes.name,
      heroId: schema.heroes.id,
      heroRole: schema.heroes.role,
    })
    .from(schema.claims)
    .innerJoin(schema.cards, eq(schema.claims.cardId, schema.cards.id))
    .innerJoin(schema.heroes, eq(schema.cards.heroId, schema.heroes.id))
    .where(
      and(
        eq(schema.claims.guildId, guildId),
        eq(schema.claims.userId, userId),
        inArray(schema.claims.cardId, cardIds),
      ),
    );

  const byCard = new Map(owned.map((o) => [o.cardId, o]));
  const notOwned = cardIds.filter((id) => !byCard.has(id));
  if (notOwned.length) return { ok: false, notOwned };

  // A hero with more than one possible role can't be placed without being told
  // which one it is filling — the Legendary-per-role cap depends on it.
  const needsRole: { cardId: string; hero: string; options: Role[] }[] = [];
  const resolved: TeamCard[] = [];

  for (const [i, input] of slots.entries()) {
    const row = byCard.get(input.cardId)!;
    const options = parseRoles(row.heroRole);

    /**
     * A hero with exactly one role has no choice to make, so a declared role is
     * simply irrelevant to it.
     *
     * This is load-bearing, not a nicety. `wildcard_role` is a SINGLE global
     * option on `/team set`, not one per card — so it arrives attached to every
     * slot. Letting a declaration override an unambiguous hero meant that
     * supplying it (which the bot demands the moment Deadpool is in the team)
     * rejected every other hero who didn't happen to play that role: Magik,
     * Luna Snow and the rest were reported as wildcards they aren't.
     *
     * Only a genuinely multi-role hero consults the declaration.
     */
    const role =
      options.length === 1
        ? options[0]
        : input.role && (options.length === 0 || options.includes(input.role))
          ? input.role
          : undefined;

    if (!role) {
      needsRole.push({ cardId: input.cardId, hero: row.hero, options });
      continue;
    }
    resolved.push({
      slot: i + 1,
      cardId: row.cardId,
      role,
      name: row.name,
      hero: row.hero,
      heroId: row.heroId,
      rarity: row.rarity as Rarity,
      rank: row.rank,
    });
  }

  if (needsRole.length) return { ok: false, needsRole };

  const violations = validateTeam(
    resolved.map<Unit>((c) => ({
      cardId: c.cardId,
      heroId: c.heroId,
      rarity: c.rarity,
      role: c.role,
      rank: c.rank,
    })),
  );
  if (violations.length) return { ok: false, violations };

  // Replace wholesale rather than upserting slot by slot: a partially-written
  // line-up would be a legal-looking team nobody chose.
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.teamSlots)
      .where(and(eq(schema.teamSlots.guildId, guildId), eq(schema.teamSlots.userId, userId)));
    await tx.insert(schema.teamSlots).values(
      resolved.map((c) => ({
        guildId,
        userId,
        slot: c.slot,
        cardId: c.cardId,
        role: c.role,
      })),
    );
  });

  return { ok: true, team: resolved };
}

export async function clearTeam(guildId: string, userId: string): Promise<number> {
  const removed = await db
    .delete(schema.teamSlots)
    .where(and(eq(schema.teamSlots.guildId, guildId), eq(schema.teamSlots.userId, userId)))
    .returning({ slot: schema.teamSlots.slot });
  return removed.length;
}

export interface ResolvedSlot {
  slot: number;
  unit: Unit;
  /** Null when the card was lost since the team was saved. */
  card: TeamCard | null;
}

/**
 * Builds the combat line-up, checking ownership right now.
 *
 * Cards no longer owned become recruits rather than errors: a team should not
 * stop working because you sold something. Recruits are role-less and weak, so
 * the cost of a missing card is real but not disqualifying — and short rosters
 * are filled the same way, which is what makes the command usable before anyone
 * owns six distinct heroes.
 */
export async function resolveTeam(
  guildId: string,
  userId: string,
): Promise<{ slots: ResolvedSlot[]; owned: number }> {
  const saved = await db
    .select({
      slot: schema.teamSlots.slot,
      cardId: schema.teamSlots.cardId,
      role: schema.teamSlots.role,
    })
    .from(schema.teamSlots)
    .where(and(eq(schema.teamSlots.guildId, guildId), eq(schema.teamSlots.userId, userId)))
    .orderBy(asc(schema.teamSlots.slot));

  const stillOwned = saved.length
    ? await db
        .select({
          cardId: schema.claims.cardId,
          rank: schema.claims.rank,
          rarity: schema.cards.rarity,
          name: schema.cards.name,
          hero: schema.heroes.name,
          heroId: schema.heroes.id,
        })
        .from(schema.claims)
        .innerJoin(schema.cards, eq(schema.claims.cardId, schema.cards.id))
        .innerJoin(schema.heroes, eq(schema.cards.heroId, schema.heroes.id))
        .where(
          and(
            eq(schema.claims.guildId, guildId),
            eq(schema.claims.userId, userId),
            inArray(
              schema.claims.cardId,
              saved.map((s) => s.cardId),
            ),
          ),
        )
    : [];

  const byCard = new Map(stillOwned.map((o) => [o.cardId, o]));
  const slots: ResolvedSlot[] = [];
  let owned = 0;

  for (let i = 1; i <= TEAM_SIZE; i++) {
    const row = saved.find((s) => s.slot === i);
    const card = row ? byCard.get(row.cardId) : undefined;

    if (!row || !card) {
      slots.push({
        slot: i,
        card: null,
        unit: { cardId: `recruit:${i}`, heroId: "", rarity: "recruit", role: null },
      });
      continue;
    }

    owned++;
    slots.push({
      slot: i,
      card: {
        slot: i,
        cardId: card.cardId,
        role: row.role as Role,
        name: card.name,
        hero: card.hero,
        heroId: card.heroId,
        rarity: card.rarity as Rarity,
        rank: card.rank,
      },
      unit: {
        cardId: card.cardId,
        heroId: card.heroId,
        rarity: card.rarity as Rarity,
        role: row.role as Role,
        rank: card.rank,
      },
    });
  }

  return { slots, owned };
}

/** Cards a user owns that are legal to place, for `/team set` autocomplete. */
export async function teamPickerOptions(guildId: string, userId: string, query: string) {
  const { ownedCards } = await import("./trade.js");
  return ownedCards(guildId, userId, query);
}
