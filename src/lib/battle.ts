/**
 * 6v6 battle simulator — pure, deterministic, no database and no discord.js.
 *
 * Everything interesting about the mini-game lives here so it can be tuned
 * offline: `scripts/battle-sim.ts` runs thousands of matches per matchup and
 * prints a win-rate matrix, which is the only honest way to pick the constants
 * in TUNING. Commands and persistence sit on top of this later.
 *
 * The model is four team stats — HP, damage, healing, mitigation — with three
 * valves that each fix a specific failure mode. See TUNING.
 */
import type { Rarity } from "./gacha.js";

export type Role = "vanguard" | "duelist" | "strategist";
export const ROLES: readonly Role[] = ["vanguard", "duelist", "strategist"];

/**
 * One team slot. `role` is declared rather than read straight off the hero,
 * because the wiki lists Deadpool as "Vanguard / Duelist / Strategist" — the
 * player picks which role he fills, and that choice is what the Legendary cap
 * is checked against.
 *
 * A recruit is the filler for a slot the player can't field: role-less, cheap,
 * and deliberately unable to contribute mitigation or healing, so a short
 * roster can never buy a balanced composition for free.
 */
export interface Unit {
  cardId: string;
  /** Empty for recruits. Uniqueness is per hero, so costume never matters. */
  heroId: string;
  rarity: Rarity | "recruit";
  role: Role | null;
}

export const TEAM_SIZE = 6;
export const MAX_EPICS = 2;
export const MAX_LEGENDARY_PER_ROLE = 1;

export const TUNING = {
  /**
   * Power by rarity. This spread is the master dial for "does collection beat
   * composition": the roster rules cap a mono-role team at 1 Legendary + 2
   * Epics while a three-role team can field 3 Legendaries, so widening this
   * gap makes diverse teams strictly better and narrowing it makes mono-comps
   * viable. Default and Mythic are unreachable in the live pool but carry
   * sane values so a future ingest can't produce a zero-power card.
   */
  power: {
    default: 5,
    rare: 10,
    epic: 11.0,
    legendary: 15.898,
    mythic: 34,
    recruit: 3,
  } as Record<Rarity | "recruit", number>,

  /**
   * How each role converts its power into the four team stats.
   *
   * Fitted by `npm run sim -- --fit`, not chosen by hand — every hand-picked
   * set produced either a 100% matchup or a stalemate. Re-fit after changing
   * anything here rather than nudging one number.
   */
  roles: {
    vanguard: { hp: 1.052, dmg: 0.623, heal: 0, mit: 0.747 },
    duelist: { hp: 0.637, dmg: 1.001, heal: 0, mit: 0.21 },
    strategist: { hp: 0.948, dmg: 0.616, heal: 0.24, mit: 0.2 },
    recruit: { hp: 0.6, dmg: 0.15, heal: 0, mit: 0 },
  } as Record<Role | "recruit", { hp: number; dmg: number; heal: number; mit: number }>,

  /**
   * Diminishing returns on mitigation: mit/(mit+K), the same shape as MOBA
   * armour. Linear mitigation would let six Vanguards reach 100% reduction and
   * become literally unkillable.
   */
  mitigationK: 33.802,

  /**
   * Mitigation multiplier per round elapsed — armour breaks down as a fight
   * drags on. This is what creates the rock-paper-scissors triangle, and the
   * first version had no equivalent: without it a wall beats both burst AND
   * sustain, because sustain can never out-attrition raw effective HP. Decay
   * makes the wall a *short-game* answer, so burst loses to it and sustain
   * outlasts it.
   */
  mitigationDecay: 0.987,

  /**
   * Damage multiplier per round elapsed. Guarantees every match terminates in
   * a kill, which avoids having to pick a tiebreak rule — HP-remaining favours
   * turtles and damage-dealt favours racers, and neither is neutral.
   */
  escalation: 1.2,

  /** Per-round damage jitter, ±this fraction. The upset knob. */
  variance: 0.264,

  /** Backstop only. With escalation on, real matches end long before this. */
  maxRounds: 15,

  /** Scales HP against damage, i.e. how many rounds a typical fight lasts. */
  hpScale: 3.559,

  /**
   * Each card's power is raised to this exponent before becoming stats.
   *
   * Linear power (exponent 1) makes win rate scale as power *squared*, because
   * power buys HP and damage both — a team only 1.4x stronger wins 99% of the
   * time. That leaves no usable window between "collection is meaningless" and
   * "collection is everything": the fitter, given linear power, resorted to
   * making a Legendary statistically weaker than an Epic and still couldn't
   * hit the progression targets. Flattening the curve is what makes a
   * collection advantage tunable at all.
   */
  powerExponent: 0.302,

  /**
   * Stacking a role amplifies its signature stat — damage for Duelists,
   * mitigation for Vanguards, healing for Strategists — by up to this
   * fraction at six of a kind, scaling linearly from zero at one.
   *
   * Without it a mixed team is strictly better than a specialised one, since
   * having all three stats beats having one. The fitter demonstrated this: told
   * to make mono-comps competitive with no specialisation payoff available, it
   * converged on making the three roles nearly identical instead. Focus is
   * what buys a stacked team something a balanced team can't have.
   */
  focusBonus: 0.198,

  /**
   * Defender HP bonus. `/battle` resolves against a saved, visible roster, so
   * the attacker can scout and counterpick; this makes a soft counter
   * insufficient. Set to 0 when measuring symmetric matchups.
   */
  defenderAdvantage: 0.1,

  /**
   * Ultimates. Only Legendaries have one, and which one it is comes from the
   * declared role — this is the qualitative difference that stops a Legendary
   * from being "a Rare with bigger numbers", and it's why the rarity power
   * spread can stay narrow. A stat advantage compounds (power buys HP *and*
   * damage, so it squares); an ability is worth roughly a fixed amount, so
   * paying for rarity in abilities keeps the progression curve a gradient.
   *
   * Charge is where the match's randomness now lives. Every meter gains a base
   * amount per round plus a bounded random bonus, so two identical teams get
   * their windows at different times and the same matchup plays out
   * differently. `chargeFromDamage` adds charge for punishment taken, which is
   * both faithful to the source game and a deliberate rubber band: the side
   * being blown out reaches its ultimate sooner.
   */
  ult: {
    /** Meter gained per round before bonuses. 1.0 fires the ultimate. */
    chargeBase: 0.259,
    /** Random bonus as a fraction of base, ± per round. Bounded on purpose. */
    chargeJitter: 0.578,
    /** Extra charge per 1.0 of max HP lost in the previous round. */
    chargeFromDamage: 0.293,
    /** Focus Fire — burst that ignores armour entirely. */
    duelist: { damageMultiplier: 2.164 },
    /** Bulwark — near-immunity for a round, and armour decay resets. */
    vanguard: { incomingMultiplier: 0.388 },
    /** Rally — immediate heal for a fraction of max HP. */
    strategist: { healFraction: 0.229 },
  },
};

export type Tuning = typeof TUNING;

export interface TeamStats {
  hp: number;
  dmg: number;
  heal: number;
  mit: number;
}

export function teamStats(team: readonly Unit[], t: Tuning = TUNING): TeamStats {
  let hp = 0;
  let dmg = 0;
  let heal = 0;
  let mit = 0;
  for (const u of team) {
    const p = (t.power[u.rarity] ?? 0) ** t.powerExponent;
    const w = t.roles[u.role ?? "recruit"];
    hp += p * w.hp;
    dmg += p * w.dmg;
    heal += p * w.heal;
    mit += p * w.mit;
  }

  // Focus: count each role and amplify its signature stat. Recruits are
  // role-less and so never contribute to a stack.
  const counts = { vanguard: 0, duelist: 0, strategist: 0 };
  for (const u of team) if (u.role) counts[u.role]++;
  const focus = (n: number) =>
    1 + t.focusBonus * (Math.max(0, n - 1) / (TEAM_SIZE - 1));

  return {
    hp: hp * t.hpScale,
    dmg: dmg * focus(counts.duelist),
    heal: heal * focus(counts.strategist),
    mit: mit * focus(counts.vanguard),
  };
}

/* ------------------------------------------------------------------ rules */

export type TeamViolation =
  | { code: "size"; have: number }
  | { code: "duplicate_hero"; heroId: string }
  | { code: "epic_cap"; have: number }
  | { code: "legendary_role_cap"; role: Role; have: number };

/**
 * The four roster rules:
 *   1. six slots, six DISTINCT heroes (costume is irrelevant to uniqueness)
 *   2. at most one Legendary per role
 *   3. at most two Epics per team
 *   4. Rares unlimited
 *
 * Returns every violation rather than the first, so `/team set` can explain
 * the whole problem in one reply. Recruits are exempt from all of it.
 */
export function validateTeam(team: readonly Unit[]): TeamViolation[] {
  const out: TeamViolation[] = [];
  if (team.length > TEAM_SIZE) out.push({ code: "size", have: team.length });

  const real = team.filter((u) => u.rarity !== "recruit");

  const heroCount = new Map<string, number>();
  for (const u of real) heroCount.set(u.heroId, (heroCount.get(u.heroId) ?? 0) + 1);
  for (const [heroId, n] of heroCount) {
    if (n > 1) out.push({ code: "duplicate_hero", heroId });
  }

  const epics = real.filter((u) => u.rarity === "epic").length;
  if (epics > MAX_EPICS) out.push({ code: "epic_cap", have: epics });

  for (const role of ROLES) {
    const n = real.filter((u) => u.rarity === "legendary" && u.role === role).length;
    if (n > MAX_LEGENDARY_PER_ROLE) {
      out.push({ code: "legendary_role_cap", role, have: n });
    }
  }

  return out;
}

/* -------------------------------------------------------------------- rng */

/**
 * mulberry32. Seeded so a match can be replayed from its stored seed — which
 * is what makes results auditable and tests non-flaky.
 */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* -------------------------------------------------------------------- sim */

/** How many of each role's ultimate fired for one side in one round. */
export type UltsFired = Record<Role, number>;

export interface RoundLog {
  round: number;
  aDealt: number;
  bDealt: number;
  aHp: number;
  bHp: number;
  /** Drives the "Focus Fire!" beats in the battle log. */
  aUlts: UltsFired;
  bUlts: UltsFired;
}

export interface SideReport {
  dealt: number;
  /** Damage removed by mitigation. */
  prevented: number;
  healed: number;
}

export interface MatchResult {
  winner: "a" | "b";
  seed: number;
  rounds: RoundLog[];
  a: SideReport;
  b: SideReport;
  /** Highest combined contribution on the winning team. */
  mvp: { side: "a" | "b"; cardId: string } | null;
}

interface Strike {
  net: number;
  prevented: number;
}

interface StrikeMods {
  /** Attacker's Focus Fire multiplier, 1 when no Duelist ultimate fired. */
  damageMultiplier: number;
  /** Focus Fire ignores armour outright. */
  pierce: boolean;
  /** Defender's Bulwark multiplier, 1 when no Vanguard ultimate fired. */
  incomingMultiplier: number;
}

function strike(
  att: TeamStats,
  def: TeamStats,
  round: number,
  /** Rounds since armour was last refreshed — Bulwark resets this to 1. */
  armourRound: number,
  mods: StrikeMods,
  roll: () => number,
  t: Tuning,
): Strike {
  const armour = def.mit * t.mitigationDecay ** (armourRound - 1);
  const mitigation = mods.pierce ? 0 : armour / (armour + t.mitigationK);
  const output = att.dmg * mods.damageMultiplier;
  const prevented = output * mitigation;
  const jitter = 1 + (roll() * 2 - 1) * t.variance;
  const net = Math.max(
    0,
    (output - prevented) * t.escalation ** (round - 1) * jitter * mods.incomingMultiplier,
  );
  return { net, prevented };
}

interface UltState {
  role: Role;
  charge: number;
}

function ultsFor(team: readonly Unit[]): UltState[] {
  const out: UltState[] = [];
  for (const u of team) {
    if (u.rarity === "legendary" && u.role) out.push({ role: u.role, charge: 0 });
  }
  return out;
}

/**
 * Advances every meter and returns what fired. Charge carries the remainder
 * rather than resetting to zero, so a long match gets a steady cadence of
 * ultimates instead of drifting out of sync with the round counter.
 */
function advanceUlts(
  ults: UltState[],
  hpLostFraction: number,
  roll: () => number,
  t: Tuning,
): UltsFired {
  const fired: UltsFired = { vanguard: 0, duelist: 0, strategist: 0 };
  for (const u of ults) {
    const jitter = 1 + (roll() * 2 - 1) * t.ult.chargeJitter;
    u.charge += t.ult.chargeBase * jitter + hpLostFraction * t.ult.chargeFromDamage;
    if (u.charge >= 1) {
      u.charge -= 1;
      fired[u.role]++;
    }
  }
  return fired;
}

/**
 * Resolves a match. `b` is the defender and receives `defenderAdvantage`.
 *
 * Both sides strike simultaneously each round, so there is no first-mover
 * advantage; a double knockout is settled on the less negative HP fraction.
 */
export function simulate(
  a: readonly Unit[],
  b: readonly Unit[],
  seed: number,
  opts: { tuning?: Tuning; defenderAdvantage?: number } = {},
): MatchResult {
  const t = opts.tuning ?? TUNING;
  const bonus = opts.defenderAdvantage ?? t.defenderAdvantage;

  const statsA = teamStats(a, t);
  const statsB = teamStats(b, t);
  statsB.hp *= 1 + bonus;

  const maxA = statsA.hp;
  const maxB = statsB.hp;
  let hpA = statsA.hp;
  let hpB = statsB.hp;

  const roll = seededRng(seed);
  const rounds: RoundLog[] = [];
  const repA: SideReport = { dealt: 0, prevented: 0, healed: 0 };
  const repB: SideReport = { dealt: 0, prevented: 0, healed: 0 };

  let winner: "a" | "b" | null = null;

  const ultsA = ultsFor(a);
  const ultsB = ultsFor(b);
  // Rounds since each side's armour was last refreshed. Bulwark resets it.
  let armourRoundA = 1;
  let armourRoundB = 1;
  // Share of max HP each side lost last round, which feeds ultimate charge.
  let lostA = 0;
  let lostB = 0;

  for (let round = 1; round <= t.maxRounds; round++) {
    const firedA = advanceUlts(ultsA, lostA, roll, t);
    const firedB = advanceUlts(ultsB, lostB, roll, t);

    // Rally resolves before the exchange, so it can save a team that would
    // otherwise die this round.
    if (firedA.strategist > 0) {
      hpA = Math.min(maxA, hpA + maxA * t.ult.strategist.healFraction * firedA.strategist);
    }
    if (firedB.strategist > 0) {
      hpB = Math.min(maxB, hpB + maxB * t.ult.strategist.healFraction * firedB.strategist);
    }

    if (firedA.vanguard > 0) armourRoundA = 1;
    if (firedB.vanguard > 0) armourRoundB = 1;

    const modsA: StrikeMods = {
      damageMultiplier: 1 + firedA.duelist * (t.ult.duelist.damageMultiplier - 1),
      pierce: firedA.duelist > 0,
      incomingMultiplier: firedB.vanguard > 0 ? t.ult.vanguard.incomingMultiplier : 1,
    };
    const modsB: StrikeMods = {
      damageMultiplier: 1 + firedB.duelist * (t.ult.duelist.damageMultiplier - 1),
      pierce: firedB.duelist > 0,
      incomingMultiplier: firedA.vanguard > 0 ? t.ult.vanguard.incomingMultiplier : 1,
    };

    const fromA = strike(statsA, statsB, round, armourRoundB, modsA, roll, t);
    const fromB = strike(statsB, statsA, round, armourRoundA, modsB, roll, t);

    /**
     * Healing is REGENERATION applied after the hit and capped at full HP —
     * not a reduction of incoming damage.
     *
     * Two earlier versions treated it as mitigation and both failed. As a flat
     * fraction it was just a second armour stat, which made Strategists a
     * better wall than Vanguards. As an absolute subtraction it made a healer
     * stack unkillable, because six Strategists absorb more per round than any
     * team can output — Strategist beat everything 100%.
     *
     * As regen it adds to effective HP linearly instead, so escalating damage
     * always overtakes it: sustain buys rounds, never immunity.
     */
    const healedB = Math.max(0, Math.min(statsB.heal, maxB - (hpB - fromA.net)));
    const healedA = Math.max(0, Math.min(statsA.heal, maxA - (hpA - fromB.net)));
    hpB += healedB - fromA.net;
    hpA += healedA - fromB.net;

    repA.dealt += fromA.net;
    repA.prevented += fromB.prevented;
    repA.healed += healedA;
    repB.dealt += fromB.net;
    repB.prevented += fromA.prevented;
    repB.healed += healedB;

    lostA = Math.max(0, fromB.net / maxA);
    lostB = Math.max(0, fromA.net / maxB);
    armourRoundA++;
    armourRoundB++;

    rounds.push({
      round,
      aDealt: fromA.net,
      bDealt: fromB.net,
      aHp: hpA,
      bHp: hpB,
      aUlts: firedA,
      bUlts: firedB,
    });

    if (hpA <= 0 || hpB <= 0) {
      if (hpA > 0) winner = "a";
      else if (hpB > 0) winner = "b";
      // Double KO: whoever is less dead. Exact ties go to the defender.
      else winner = hpA / maxA > hpB / maxB ? "a" : "b";
      break;
    }
  }

  // Only reachable if neither side can deal damage at all — escalation ends
  // every other fight well inside maxRounds.
  if (!winner) winner = hpA / maxA > hpB / maxB ? "a" : "b";

  return {
    winner,
    seed,
    rounds,
    a: repA,
    b: repB,
    mvp: pickMvp(winner === "a" ? a : b, winner === "a" ? repA : repB, winner, t),
  };
}

/**
 * Credits damage, mitigation and healing by each unit's share of the team's
 * corresponding stat, so a Vanguard or Strategist can take MVP rather than it
 * always going to the biggest Duelist.
 */
function pickMvp(
  team: readonly Unit[],
  report: SideReport,
  side: "a" | "b",
  t: Tuning,
): { side: "a" | "b"; cardId: string } | null {
  const stats = teamStats(team, t);
  let best: { cardId: string; score: number } | null = null;
  for (const u of team) {
    const p = (t.power[u.rarity] ?? 0) ** t.powerExponent;
    const w = t.roles[u.role ?? "recruit"];
    const score =
      (stats.dmg > 0 ? ((p * w.dmg) / stats.dmg) * report.dealt : 0) +
      (stats.mit > 0 ? ((p * w.mit) / stats.mit) * report.prevented : 0) +
      (stats.heal > 0 ? ((p * w.heal) / stats.heal) * report.healed : 0);
    if (!best || score > best.score) best = { cardId: u.cardId, score };
  }
  return best ? { side, cardId: best.cardId } : null;
}
