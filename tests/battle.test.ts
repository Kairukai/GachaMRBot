/**
 * Battle simulator tests. Pure — no Postgres, unlike concurrency.test.ts, so
 * these run without `docker compose up -d`.
 *
 * These lock the invariants the model depends on, not the balance numbers:
 * win rates are fitted by `npm run sim -- --fit` and are expected to move.
 * What must never move is determinism, termination, and the roster rules.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  simulate,
  validateTeam,
  teamStats,
  seededRng,
  TUNING,
  TEAM_SIZE,
  type Role,
  type Unit,
} from "../src/lib/battle.js";

let uid = 0;
function card(rarity: Unit["rarity"], role: Role | null, heroId?: string): Unit {
  uid++;
  return {
    cardId: `card${uid}`,
    heroId: heroId ?? `hero${uid}`,
    rarity,
    role,
  };
}

function mono(role: Role): Unit[] {
  return Array.from({ length: TEAM_SIZE }, () => card("rare", role));
}

function balanced(): Unit[] {
  return [
    card("rare", "vanguard"),
    card("rare", "vanguard"),
    card("rare", "duelist"),
    card("rare", "duelist"),
    card("rare", "strategist"),
    card("rare", "strategist"),
  ];
}

/* ------------------------------------------------------------ determinism */

test("same seed produces an identical match", () => {
  const a = mono("duelist");
  const b = balanced();
  const first = simulate(a, b, 12345);
  const second = simulate(a, b, 12345);
  assert.deepEqual(first, second);
});

test("different seeds can produce different winners", () => {
  const a = mono("duelist");
  const b = balanced();
  const winners = new Set<string>();
  for (let seed = 1; seed <= 200; seed++) winners.add(simulate(a, b, seed).winner);
  assert.equal(winners.size, 2, "one side always wins — variance is doing nothing");
});

test("seededRng is stable and stays in [0, 1)", () => {
  const a = seededRng(7);
  const b = seededRng(7);
  for (let i = 0; i < 50; i++) {
    const v = a();
    assert.equal(v, b());
    assert.ok(v >= 0 && v < 1, `${v} out of range`);
  }
});

/* ------------------------------------------------------------ termination */

test("every archetype pairing ends in a kill, not the round cap", () => {
  const builds: (() => Unit[])[] = [
    () => mono("duelist"),
    () => mono("vanguard"),
    () => mono("strategist"),
    balanced,
  ];
  let capped = 0;
  let total = 0;
  for (const left of builds) {
    for (const right of builds) {
      for (let seed = 1; seed <= 300; seed++) {
        const r = simulate(left(), right(), seed);
        total++;
        if (r.rounds.length >= TUNING.maxRounds) capped++;
      }
    }
  }
  // The escalation ramp exists precisely so sustain can't stall a fight out.
  assert.equal(capped, 0, `${capped}/${total} matches hit the round cap`);
});

test("a pure healer stack still dies to burst", () => {
  const healers = mono("strategist");
  const burst = mono("duelist");
  let burstWins = 0;
  for (let seed = 1; seed <= 300; seed++) {
    const r = simulate(burst, healers, seed, { defenderAdvantage: 0 });
    if (r.winner === "a") burstWins++;
    assert.ok(r.rounds.length < TUNING.maxRounds, "healers stalled the fight out");
  }
  // Directional, not a balance lock: the exact rate is fitted and will move,
  // but burst must never stop beating sustain or the triangle has inverted.
  assert.ok(burstWins > 150, `burst won only ${burstWins}/300 against healers`);
});

/* ----------------------------------------------------------------- stats */

test("focus amplifies only the stacked role's signature stat", () => {
  const stacked = teamStats(mono("duelist"));
  const spread = teamStats(balanced());
  // Six Duelists get the full focus multiplier on damage; a 2-2-2 gets a
  // fraction of it on all three.
  assert.ok(stacked.dmg > spread.dmg);
  assert.equal(stacked.heal, 0);
  assert.ok(spread.mit > 0 && spread.heal > 0);
});

test("recruits contribute nothing to mitigation or healing", () => {
  const withRecruits = teamStats([
    card("rare", "vanguard"),
    card("recruit", null),
    card("recruit", null),
  ]);
  const soloVanguard = teamStats([card("rare", "vanguard")]);
  assert.equal(withRecruits.heal, 0);
  assert.equal(withRecruits.mit, soloVanguard.mit);
  assert.ok(withRecruits.hp > soloVanguard.hp, "recruits should still add HP");
});

/* ----------------------------------------------------------------- rules */

test("a legal team passes", () => {
  const team: Unit[] = [
    card("legendary", "vanguard"),
    card("legendary", "duelist"),
    card("legendary", "strategist"),
    card("epic", "vanguard"),
    card("epic", "duelist"),
    card("rare", "strategist"),
  ];
  assert.deepEqual(validateTeam(team), []);
});

test("the same hero twice is rejected regardless of costume", () => {
  const team: Unit[] = [
    { cardId: "mrfantastic:skin1", heroId: "mister-fantastic", rarity: "rare", role: "vanguard" },
    { cardId: "mrfantastic:skin2", heroId: "mister-fantastic", rarity: "epic", role: "vanguard" },
  ];
  const v = validateTeam(team);
  assert.equal(v.length, 1);
  assert.deepEqual(v[0], { code: "duplicate_hero", heroId: "mister-fantastic" });
});

test("two Legendaries of the same role are rejected, across roles allowed", () => {
  const sameRole = [card("legendary", "duelist"), card("legendary", "duelist")];
  assert.deepEqual(validateTeam(sameRole), [
    { code: "legendary_role_cap", role: "duelist", have: 2 },
  ]);

  const spread = [
    card("legendary", "duelist"),
    card("legendary", "vanguard"),
    card("legendary", "strategist"),
  ];
  assert.deepEqual(validateTeam(spread), []);
});

test("a third Epic is rejected", () => {
  const team = [card("epic", "duelist"), card("epic", "vanguard"), card("epic", "strategist")];
  assert.deepEqual(validateTeam(team), [{ code: "epic_cap", have: 3 }]);
});

test("Rares are unlimited", () => {
  assert.deepEqual(validateTeam(mono("duelist")), []);
});

test("recruits are exempt from every cap", () => {
  const team: Unit[] = [
    card("epic", "duelist"),
    card("epic", "vanguard"),
    card("recruit", null),
    card("recruit", null),
    card("recruit", null),
    card("recruit", null),
  ];
  assert.deepEqual(validateTeam(team), []);
});

test("a seventh slot is rejected", () => {
  const team = [...balanced(), card("rare", "duelist")];
  assert.ok(validateTeam(team).some((v) => v.code === "size"));
});

/* ------------------------------------------------------------- ultimates */

function ultCount(rounds: { aUlts: Record<string, number> }[]): number {
  return rounds.reduce((n, r) => n + r.aUlts.vanguard + r.aUlts.duelist + r.aUlts.strategist, 0);
}

test("only Legendaries have ultimates", () => {
  const rares = mono("duelist");
  const epics = [
    card("epic", "duelist"),
    card("epic", "vanguard"),
    ...Array.from({ length: 4 }, () => card("rare", "strategist")),
  ];
  for (let seed = 1; seed <= 40; seed++) {
    assert.equal(ultCount(simulate(rares, epics, seed).rounds), 0);
    assert.equal(ultCount(simulate(epics, rares, seed).rounds), 0);
  }
});

test("a full Legendary line-up always lands an ultimate", () => {
  const ceiling = [
    card("legendary", "vanguard"),
    card("legendary", "duelist"),
    card("legendary", "strategist"),
    card("epic", "vanguard"),
    card("epic", "duelist"),
    card("rare", "strategist"),
  ];
  for (let seed = 1; seed <= 200; seed++) {
    assert.ok(ultCount(simulate(ceiling, balanced(), seed).rounds) > 0, `seed ${seed}`);
  }
});

test("a single Legendary lands its ultimate about half the time", () => {
  /**
   * KNOWN GAP, not a settled design. Matches average ~3 rounds and a meter
   * needs ~4, so one Legendary gets its ultimate off in roughly 46% of fights
   * while a three-Legendary team gets one every time. The fitter's ult-presence
   * target averaged over all Legendary-holding teams, which the 100% cases
   * satisfied on their own — so the single-Legendary case was never pressured.
   *
   * The band below is deliberately wide: it exists to catch the feature
   * silently disappearing, not to freeze the rate. Decide whether one
   * Legendary should reliably ult, then re-fit with a per-team-type target.
   */
  const withLegendary = [
    card("legendary", "duelist"),
    ...Array.from({ length: 5 }, () => card("rare", "duelist")),
  ];
  let fired = 0;
  for (let seed = 1; seed <= 500; seed++) {
    if (ultCount(simulate(withLegendary, balanced(), seed).rounds) > 0) fired++;
  }
  const rate = fired / 500;
  assert.ok(rate > 0.25 && rate < 0.75, `single-Legendary ult rate is ${rate}`);
});

test("taking damage accelerates ultimate charge", () => {
  // Same Legendary, same seed; the only difference is how hard the opponent
  // hits. chargeFromDamage should make the punished side ult sooner.
  const team = [
    card("legendary", "vanguard"),
    ...Array.from({ length: 5 }, () => card("rare", "vanguard")),
  ];
  let earlierUnderPressure = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const vsBurst = simulate(team, mono("duelist"), seed, { defenderAdvantage: 0 });
    const vsChip = simulate(team, mono("strategist"), seed, { defenderAdvantage: 0 });
    const first = (r: typeof vsBurst) => r.rounds.findIndex((x) => x.aUlts.vanguard > 0);
    const burstIdx = first(vsBurst);
    const chipIdx = first(vsChip);
    if (burstIdx >= 0 && (chipIdx < 0 || burstIdx <= chipIdx)) earlierUnderPressure++;
  }
  assert.ok(
    earlierUnderPressure > 40,
    `charge-from-damage barely registers: ${earlierUnderPressure}/60`,
  );
});

/* ------------------------------------------------------------------- mvp */

test("MVP comes from the winning side and can be a support", () => {
  const healers = mono("strategist");
  const walls = mono("vanguard");
  let supportMvps = 0;
  for (let seed = 1; seed <= 50; seed++) {
    const r = simulate(healers, walls, seed);
    assert.ok(r.mvp, "every decided match should name an MVP");
    assert.equal(r.mvp!.side, r.winner);
    const team = r.winner === "a" ? healers : walls;
    if (team.some((u) => u.cardId === r.mvp!.cardId && u.role !== "duelist")) supportMvps++;
  }
  assert.ok(supportMvps > 0, "MVP is only ever going to damage dealers");
});
