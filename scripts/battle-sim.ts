/**
 * Balance harness for the 6v6 simulator.
 *
 * Runs every archetype against every other over many seeds and prints a
 * win-rate matrix, so the constants in TUNING get fitted against measured
 * outcomes instead of intuition. Pure — no database, no network.
 *
 *   npm run sim
 *   npm run sim -- --seeds 20000
 *
 * Defender advantage is forced to 0 here: the matrix is only meaningful if
 * both sides are treated identically.
 *
 * Target (row's win rate vs column):
 *   mono-comps form a triangle — burst beats sustain, wall beats burst,
 *   sustain grinds the wall — and balanced sits at 55-60% against all of them.
 */
import {
  simulate,
  seededRng,
  validateTeam,
  teamStats,
  TUNING,
  type Role,
  type Tuning,
  type Unit,
} from "../src/lib/battle.js";

const SEEDS = (() => {
  const i = process.argv.indexOf("--seeds");
  return i >= 0 ? Number(process.argv[i + 1]) : 5000;
})();

const FIT = (() => {
  const i = process.argv.indexOf("--fit");
  if (i < 0) return 0;
  const n = Number(process.argv[i + 1]);
  return Number.isFinite(n) ? n : 800;
})();

type Tier = "rare" | "epic" | "legendary" | "recruit";

let uid = 0;
function unit(rarity: Tier, role: Role | null): Unit {
  uid++;
  return {
    cardId: `${rarity}:${role ?? "none"}:${uid}`,
    heroId: rarity === "recruit" ? "" : `hero${uid}`,
    rarity,
    role: rarity === "recruit" ? null : role,
  };
}

/** Best legal single-role team: the caps allow only 1 Legendary + 2 Epics. */
function mono(role: Role): Unit[] {
  return [
    unit("legendary", role),
    unit("epic", role),
    unit("epic", role),
    unit("rare", role),
    unit("rare", role),
    unit("rare", role),
  ];
}

/** Ceiling team: 3 Legendaries is only reachable with all three roles. */
function balanced(): Unit[] {
  return [
    unit("legendary", "vanguard"),
    unit("legendary", "duelist"),
    unit("legendary", "strategist"),
    unit("epic", "vanguard"),
    unit("epic", "duelist"),
    unit("rare", "strategist"),
  ];
}

/** What most players will actually field: no Legendaries, 2-2-2. */
function budget(): Unit[] {
  return [
    unit("rare", "vanguard"),
    unit("rare", "vanguard"),
    unit("rare", "duelist"),
    unit("rare", "duelist"),
    unit("rare", "strategist"),
    unit("rare", "strategist"),
  ];
}

/** Four owned cards plus filler — the realistic new-player team. */
function short(): Unit[] {
  return [
    unit("rare", "vanguard"),
    unit("rare", "duelist"),
    unit("rare", "duelist"),
    unit("rare", "strategist"),
    unit("recruit", null),
    unit("recruit", null),
  ];
}

/** Six Rares of one role — identical investment, different shape. */
function rareMono(role: Role): Unit[] {
  return Array.from({ length: 6 }, () => unit("rare", role));
}

type Archetype = { name: string; build: () => Unit[] };

/**
 * Equal investment, different shape. This is where composition balance is
 * actually measured: every team here is six Rares, so any win-rate difference
 * is the sim's doing and not the collection's. The triangle target lives here.
 */
const SHAPES: Archetype[] = [
  { name: "rare Duelist", build: () => rareMono("duelist") },
  { name: "rare Vanguard", build: () => rareMono("vanguard") },
  { name: "rare Strategist", build: () => rareMono("strategist") },
  { name: "rare 2-2-2", build: budget },
];

/**
 * Different investment. These are NOT expected to be even — the roster rules
 * cap a mono-role team at 1 Legendary + 2 Epics while a three-role team can
 * field 3 Legendaries, so a ceiling team should beat a mono one. What matters
 * is that the gap stays a gradient rather than a wall, and that a short roster
 * is still playable rather than hopeless.
 */
const PROGRESSION: Archetype[] = [
  { name: "ceiling 2-2-2", build: balanced },
  { name: "best mono Duel", build: () => mono("duelist") },
  { name: "best mono Vang", build: () => mono("vanguard") },
  { name: "best mono Strat", build: () => mono("strategist") },
  { name: "rare 2-2-2", build: budget },
  { name: "short + filler", build: short },
];

const ARCHETYPES = [...SHAPES, ...PROGRESSION];

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/* ------------------------------------------------------------------- fit */

/**
 * Target win rates for the equal-investment matrix, as percentages.
 *
 * The triangle: burst beats sustain, wall beats burst, sustain grinds down the
 * wall. Balanced sits a little above everything without dominating. Only the
 * SHAPE group is fitted — the PROGRESSION group is *expected* to be lopsided,
 * because that gap is the reward for collecting.
 */
const TARGET: Record<string, Record<string, number>> = {
  "rare Duelist": { "rare Vanguard": 35, "rare Strategist": 65, "rare 2-2-2": 45 },
  "rare Vanguard": { "rare Duelist": 65, "rare Strategist": 40, "rare 2-2-2": 45 },
  "rare Strategist": { "rare Duelist": 35, "rare Vanguard": 60, "rare 2-2-2": 42 },
  "rare 2-2-2": { "rare Duelist": 55, "rare Vanguard": 55, "rare Strategist": 58 },
};

/**
 * Progression targets — a better collection must clearly win without being a
 * coin-flip-free wall. Fitted alongside the shape matrix because the rarity
 * power values and the ultimate constants trade directly against each other:
 * value paid out in stats compounds, value paid out in abilities doesn't.
 */
const PROGRESSION_TARGET: { a: string; b: string; want: number }[] = [
  { a: "ceiling 2-2-2", b: "rare 2-2-2", want: 82 },
  { a: "ceiling 2-2-2", b: "best mono Duel", want: 68 },
  { a: "best mono Duel", b: "rare 2-2-2", want: 72 },
  { a: "rare 2-2-2", b: "short + filler", want: 78 },
];

const BUILDS = new Map<string, () => Unit[]>(ARCHETYPES.map((x) => [x.name, x.build]));

type Cell = { a: () => Unit[]; b: () => Unit[]; want: number };

const FIT_CELLS: Cell[] = [
  ...Object.entries(TARGET).flatMap(([rowName, cols]) =>
    Object.entries(cols).map(([colName, want]) => ({
      a: BUILDS.get(rowName)!,
      b: BUILDS.get(colName)!,
      want,
    })),
  ),
  ...PROGRESSION_TARGET.map(({ a, b, want }) => ({
    a: BUILDS.get(a)!,
    b: BUILDS.get(b)!,
    want,
  })),
];

type Knob = { get: (t: Tuning) => number; set: (t: Tuning, v: number) => void; lo: number; hi: number };

const KNOBS: Record<string, Knob> = {
  "vanguard.hp": { get: (t) => t.roles.vanguard.hp, set: (t, v) => (t.roles.vanguard.hp = v), lo: 0.8, hi: 3 },
  "vanguard.dmg": { get: (t) => t.roles.vanguard.dmg, set: (t, v) => (t.roles.vanguard.dmg = v), lo: 0.1, hi: 0.9 },
  "vanguard.mit": { get: (t) => t.roles.vanguard.mit, set: (t, v) => (t.roles.vanguard.mit = v), lo: 0.3, hi: 2 },
  "duelist.hp": { get: (t) => t.roles.duelist.hp, set: (t, v) => (t.roles.duelist.hp = v), lo: 0.4, hi: 1.6 },
  "duelist.dmg": { get: (t) => t.roles.duelist.dmg, set: (t, v) => (t.roles.duelist.dmg = v), lo: 0.6, hi: 1.8 },
  "duelist.mit": { get: (t) => t.roles.duelist.mit, set: (t, v) => (t.roles.duelist.mit = v), lo: 0, hi: 0.6 },
  "strategist.hp": { get: (t) => t.roles.strategist.hp, set: (t, v) => (t.roles.strategist.hp = v), lo: 0.4, hi: 1.8 },
  "strategist.dmg": { get: (t) => t.roles.strategist.dmg, set: (t, v) => (t.roles.strategist.dmg = v), lo: 0.1, hi: 1 },
  "strategist.heal": { get: (t) => t.roles.strategist.heal, set: (t, v) => (t.roles.strategist.heal = v), lo: 0.1, hi: 1.2 },
  "strategist.mit": { get: (t) => t.roles.strategist.mit, set: (t, v) => (t.roles.strategist.mit = v), lo: 0, hi: 0.6 },
  mitigationK: { get: (t) => t.mitigationK, set: (t, v) => (t.mitigationK = v), lo: 15, hi: 150 },
  mitigationDecay: { get: (t) => t.mitigationDecay, set: (t, v) => (t.mitigationDecay = v), lo: 0.6, hi: 1 },
  // Capped well below the fitter's preference: left free it pins at 1.4 and
  // fights end in under three rounds, which makes for a dull battle log.
  escalation: { get: (t) => t.escalation, set: (t, v) => (t.escalation = v), lo: 1.0, hi: 1.2 },
  hpScale: { get: (t) => t.hpScale, set: (t, v) => (t.hpScale = v), lo: 0.5, hi: 5 },
  focusBonus: { get: (t) => t.focusBonus, set: (t, v) => (t.focusBonus = v), lo: 0, hi: 2 },
  // Must be fitted alongside the rest: match length and decisiveness are
  // coupled, because a longer fight compounds a small per-round edge into a
  // certainty. Variance is the only knob that buys closeness back.
  // Deliberately capped low. Left free the fitter pins this at its ceiling,
  // but a random damage multiplier reads as a coin flip in the battle log,
  // whereas an ultimate landing early reads as a turning point. Randomness is
  // meant to live in ult.chargeJitter instead.
  variance: { get: (t) => t.variance, set: (t, v) => (t.variance = v), lo: 0.05, hi: 0.35 },
  // Rare stays pinned at 10 as the unit of account; the other two are fitted
  // against the progression targets rather than guessed.
  "power.epic": { get: (t) => t.power.epic, set: (t, v) => (t.power.epic = v), lo: 11, hi: 30 },
  "power.legendary": { get: (t) => t.power.legendary, set: (t, v) => (t.power.legendary = v), lo: 12, hi: 45 },
  "ult.chargeBase": { get: (t) => t.ult.chargeBase, set: (t, v) => (t.ult.chargeBase = v), lo: 0.08, hi: 0.6 },
  "ult.chargeJitter": { get: (t) => t.ult.chargeJitter, set: (t, v) => (t.ult.chargeJitter = v), lo: 0, hi: 0.9 },
  "ult.chargeFromDamage": { get: (t) => t.ult.chargeFromDamage, set: (t, v) => (t.ult.chargeFromDamage = v), lo: 0, hi: 2.5 },
  "ult.duelist": { get: (t) => t.ult.duelist.damageMultiplier, set: (t, v) => (t.ult.duelist.damageMultiplier = v), lo: 1.2, hi: 4 },
  "ult.vanguard": { get: (t) => t.ult.vanguard.incomingMultiplier, set: (t, v) => (t.ult.vanguard.incomingMultiplier = v), lo: 0.05, hi: 0.9 },
  "ult.strategist": { get: (t) => t.ult.strategist.healFraction, set: (t, v) => (t.ult.strategist.healFraction = v), lo: 0.05, hi: 0.7 },
  powerExponent: { get: (t) => t.powerExponent, set: (t, v) => (t.powerExponent = v), lo: 0.25, hi: 1 },
};

/** Fights outside this many rounds read badly in Discord — too short to have a
 *  story, or too long to fit in a message. */
const ROUNDS_BAND = { min: 4, max: 8 };

/** Share of matches in which a Legendary-holding side must land an ultimate. */
const ULT_FIRE_TARGET = 0.92;

function evaluate(t: Tuning, seeds: number): { cost: number; stalemates: number } {
  let cost = 0;
  let stalemates = 0;
  let rounds = 0;
  let matches = 0;
  // Matches where a side holding Legendaries actually got to use one.
  let ultEligible = 0;
  let ultSeen = 0;

  for (const cell of FIT_CELLS) {
    const teamA = cell.a();
    const teamB = cell.b();
    const aHasLegendary = teamA.some((u) => u.rarity === "legendary");
    let wins = 0;
    for (let seed = 1; seed <= seeds; seed++) {
      const r = simulate(teamA, teamB, seed, { tuning: t, defenderAdvantage: 0 });
      if (r.winner === "a") wins++;
      if (r.rounds.length >= t.maxRounds) stalemates++;
      rounds += r.rounds.length;
      matches++;
      if (aHasLegendary) {
        ultEligible++;
        const fired = r.rounds.some(
          (x) => x.aUlts.vanguard + x.aUlts.duelist + x.aUlts.strategist > 0,
        );
        if (fired) ultSeen++;
      }
    }
    cost += ((wins / seeds) * 100 - cell.want) ** 2;
  }

  const avg = rounds / matches;
  const overshoot = Math.max(0, ROUNDS_BAND.min - avg, avg - ROUNDS_BAND.max);

  // A Legendary weaker on paper than an Epic is a legitimate way to hit the
  // progression targets and an illegible one for players. Forbid it.
  if (t.power.legendary < t.power.epic) cost += 2000;

  /**
   * Ultimates must actually happen. Left to itself the fitter slows charge
   * until they almost never fire — that costs it nothing in win rates, but it
   * deletes the feature: a Legendary's whole point is the ability, and a
   * player who never sees one has just bought a slightly bigger stat stick.
   */
  const fireRate = ultEligible ? ultSeen / ultEligible : 1;
  cost += Math.max(0, ULT_FIRE_TARGET - fireRate) ** 2 * 6000;

  // A stalemate means the escalation valve failed; never trade balance for it.
  return { cost: cost + (stalemates / seeds) * 5000 + overshoot ** 2 * 400, stalemates };
}

/** Gaussian via Box-Muller, seeded so a fit run is reproducible. */
function gaussian(roll: () => number): number {
  const u = Math.max(1e-9, roll());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * roll());
}

function fit(iterations: number, seeds: number): Tuning {
  const roll = seededRng(20260804);
  let best = structuredClone(TUNING) as Tuning;
  const names = Object.keys(KNOBS);

  // Clamp the starting point into the knob bounds first. Without this, a
  // baseline sitting outside a newly tightened bound competes against
  // proposals that are all clamped inside it — so nothing is ever accepted and
  // the "fit" silently returns its input unchanged.
  for (const name of names) {
    const k = KNOBS[name]!;
    k.set(best, Math.min(k.hi, Math.max(k.lo, k.get(best))));
  }
  let bestCost = evaluate(best, seeds).cost;

  for (let i = 0; i < iterations; i++) {
    // Anneal: broad exploration early, fine adjustment late.
    const sigma = 0.18 * (1 - i / iterations) + 0.02;
    const candidate = structuredClone(best) as Tuning;
    for (const name of names) {
      const k = KNOBS[name]!;
      const scaled = k.get(best) * Math.exp(gaussian(roll) * sigma);
      k.set(candidate, Math.min(k.hi, Math.max(k.lo, scaled)));
    }
    const { cost } = evaluate(candidate, seeds);
    if (cost < bestCost) {
      bestCost = cost;
      best = candidate;
      if (i % 25 === 0) console.log(`  iter ${i}: cost ${cost.toFixed(1)}`);
    }
  }
  console.log(`\nBest cost: ${bestCost.toFixed(1)} (0 = every target hit exactly)\n`);
  return best;
}

function pad(s: string, w: number): string {
  return s.padEnd(w);
}

console.log(`Running ${SEEDS} seeds per matchup.\n`);

// Every archetype must be a legal roster, or the matrix is measuring builds
// nobody could field.
for (const a of ARCHETYPES) {
  const violations = validateTeam(a.build());
  if (violations.length) {
    console.error(`ILLEGAL archetype "${a.name}":`, violations);
    process.exit(1);
  }
}

let active: Tuning = TUNING;
if (FIT > 0) {
  console.log(`Fitting ${Object.keys(KNOBS).length} constants over ${FIT} iterations…\n`);
  active = fit(FIT, 400);
  console.log("Fitted values — paste into TUNING in src/lib/battle.ts:\n");
  for (const [name, k] of Object.entries(KNOBS)) {
    console.log(`  ${pad(name, 18)} ${k.get(TUNING).toFixed(3)}  ->  ${k.get(active).toFixed(3)}`);
  }
}

console.log("\nTeam power (sum of HP/dmg/heal/mit inputs):\n");
console.log(`  ${pad("archetype", 16)} ${pad("hp", 9)} ${pad("dmg", 8)} ${pad("heal", 8)} mit`);
for (const a of ARCHETYPES) {
  const s = teamStats(a.build(), active);
  console.log(
    `  ${pad(a.name, 16)} ${pad(s.hp.toFixed(0), 9)} ${pad(s.dmg.toFixed(1), 8)} ` +
      `${pad(s.heal.toFixed(1), 8)} ${s.mit.toFixed(1)}`,
  );
}

let totalRounds = 0;
let matches = 0;
let hitCap = 0;

function matrix(title: string, group: typeof ARCHETYPES): void {
  const width = 17;
  console.log(`\n${title}\n`);
  console.log(`  ${pad("", width)}${group.map((a) => pad(a.name, width)).join("")}`);
  for (const row of group) {
    const cells: string[] = [];
    for (const col of group) {
      let wins = 0;
      for (let seed = 1; seed <= SEEDS; seed++) {
        const r = simulate(row.build(), col.build(), seed, {
          tuning: active,
          defenderAdvantage: 0,
        });
        if (r.winner === "a") wins++;
        totalRounds += r.rounds.length;
        matches++;
        if (r.rounds.length >= active.maxRounds) hitCap++;
      }
      cells.push(pad(pct(wins / SEEDS), width));
    }
    console.log(`  ${pad(row.name, width)}${cells.join("")}`);
  }
}

matrix("SHAPE — equal investment (all six Rares), row vs column:", SHAPES);
matrix("PROGRESSION — unequal investment, row vs column:", PROGRESSION);

console.log(`\nAverage match length: ${(totalRounds / matches).toFixed(1)} rounds`);
console.log(
  `Hit the ${active.maxRounds}-round cap: ${hitCap}/${matches}` +
    (hitCap === 0 ? "  (no stalemates)" : "  <-- escalation is not ending fights"),
);
