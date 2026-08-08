export const ROLES = ["vanguard", "duelist", "strategist"];
export const TEAM_SIZE = 6;
export const MAX_EPICS = 2;
export const MAX_LEGENDARY_PER_ROLE = 1;
export const MAX_RANK = 10;
/** Rares are never rankable, so this is the set that can exceed rank 1. */
const RANKABLE = new Set(["epic", "legendary"]);
function clampRank(rank) {
    if (!rank || rank < 1)
        return 1;
    return rank > MAX_RANK ? MAX_RANK : rank;
}
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
        epic: 11.078,
        legendary: 12.0,
        mythic: 34,
        recruit: 8,
    },
    /**
     * How each role converts its power into the four team stats.
     *
     * Fitted by `npm run sim -- --fit`, not chosen by hand — every hand-picked
     * set produced either a 100% matchup or a stalemate. Re-fit after changing
     * anything here rather than nudging one number.
     */
    roles: {
        vanguard: { hp: 1.052, dmg: 0.618, heal: 0, mit: 0.75 },
        duelist: { hp: 0.638, dmg: 0.995, heal: 0, mit: 0.256 },
        strategist: { hp: 0.955, dmg: 0.625, heal: 0.243, mit: 0.165 },
        recruit: { hp: 0.55, dmg: 0.45, heal: 0, mit: 0 },
    },
    /**
     * Diminishing returns on mitigation: mit/(mit+K), the same shape as MOBA
     * armour. Linear mitigation would let six Vanguards reach 100% reduction and
     * become literally unkillable.
     */
    mitigationK: 30.663,
    /**
     * Mitigation multiplier per round elapsed — armour breaking down as a fight
     * drags on.
     *
     * Currently 1.0, i.e. OFF. It was introduced to build the rock-paper-scissors
     * triangle back when a wall beat both burst and sustain, and it did that job.
     * Once healing became regeneration and focus bonuses and ultimates arrived,
     * the fitter pushed it to 1.0 every run: those mechanics now carry the
     * triangle on their own. Kept because Bulwark still refreshes armour and the
     * knob is one re-fit away from mattering again — but don't cite it as load
     * bearing, because at this value it does nothing.
     */
    mitigationDecay: 1.0,
    /**
     * Damage multiplier per round elapsed. Guarantees every match terminates in
     * a kill, which avoids having to pick a tiebreak rule — HP-remaining favours
     * turtles and damage-dealt favours racers, and neither is neutral.
     */
    escalation: 1.2,
    /** Per-round damage jitter, ±this fraction. The upset knob. */
    variance: 0.35,
    /** Backstop only. With escalation on, real matches end long before this. */
    maxRounds: 15,
    /** Scales HP against damage, i.e. how many rounds a typical fight lasts. */
    hpScale: 3.731,
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
    powerExponent: 0.295,
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
    focusBonus: 0.197,
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
        chargeBase: 0.245,
        /** Random bonus as a fraction of base, ± per round. Bounded on purpose. */
        chargeJitter: 0.308,
        /** Extra charge per 1.0 of max HP lost in the previous round. */
        chargeFromDamage: 0.36,
        /** Focus Fire — burst that ignores armour entirely. */
        duelist: { damageMultiplier: 1.802 },
        /** Bulwark — near-immunity for a round, and armour decay resets. */
        vanguard: { incomingMultiplier: 0.494 },
        /** Rally — immediate heal for a fraction of max HP. */
        strategist: { healFraction: 0.152 },
    },
    /**
     * Ranking, 1..10, Epics and Legendaries only.
     *
     * `statBonus` is applied AFTER powerExponent, straight to the stat. Applying
     * it to power instead would be crushed by the 0.302 exponent — x1.25 power
     * is only +7% stats — so the number shown to a player would bear no relation
     * to the effect. Post-exponent, +12% means +12%.
     *
     * The real payload is `chargeBonus`. A lone Legendary lands its ultimate in
     * only ~46% of matches at rank 1; scaling charge rate turns investment into
     * reliability, which is a progression curve players can feel without
     * touching the stat maths that took so long to balance.
     */
    rank: {
        /** Extra stat fraction at rank 10, ramped linearly from rank 1. */
        statBonus: 0.08,
        /** Extra ultimate charge rate at rank 10, ramped linearly. */
        chargeBonus: 0.517,
        /**
         * Epics unlock a weakened ultimate at this rank. Without it an Epic is a
         * Rare with 3% more stats and no reason to exist — this makes the middle
         * tier the accessible progression track, reachable with no Legendary
         * fodder at all.
         */
        epicUltRank: 5,
        /** Potency of an Epic's ultimate relative to a Legendary's. */
        epicPotency: 0.354,
    },
};
/** Applied after powerExponent, so the bonus a player is shown is the real one. */
function rankStatMult(u, t) {
    if (!RANKABLE.has(u.rarity))
        return 1;
    return 1 + (t.rank.statBonus * (clampRank(u.rank) - 1)) / (MAX_RANK - 1);
}
export function teamStats(team, t = TUNING) {
    let hp = 0;
    let dmg = 0;
    let heal = 0;
    let mit = 0;
    for (const u of team) {
        const p = (t.power[u.rarity] ?? 0) ** t.powerExponent * rankStatMult(u, t);
        const w = t.roles[u.role ?? "recruit"];
        hp += p * w.hp;
        dmg += p * w.dmg;
        heal += p * w.heal;
        mit += p * w.mit;
    }
    // Focus: count each role and amplify its signature stat. Recruits are
    // role-less and so never contribute to a stack.
    const counts = { vanguard: 0, duelist: 0, strategist: 0 };
    for (const u of team)
        if (u.role)
            counts[u.role]++;
    const focus = (n) => 1 + t.focusBonus * (Math.max(0, n - 1) / (TEAM_SIZE - 1));
    return {
        hp: hp * t.hpScale,
        dmg: dmg * focus(counts.duelist),
        heal: heal * focus(counts.strategist),
        mit: mit * focus(counts.vanguard),
    };
}
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
export function validateTeam(team) {
    const out = [];
    if (team.length > TEAM_SIZE)
        out.push({ code: "size", have: team.length });
    const real = team.filter((u) => u.rarity !== "recruit");
    const heroCount = new Map();
    for (const u of real)
        heroCount.set(u.heroId, (heroCount.get(u.heroId) ?? 0) + 1);
    for (const [heroId, n] of heroCount) {
        if (n > 1)
            out.push({ code: "duplicate_hero", heroId });
    }
    const epics = real.filter((u) => u.rarity === "epic").length;
    if (epics > MAX_EPICS)
        out.push({ code: "epic_cap", have: epics });
    for (const role of ROLES) {
        const n = real.filter((u) => u.rarity === "legendary" && u.role === role).length;
        if (n > MAX_LEGENDARY_PER_ROLE) {
            out.push({ code: "legendary_role_cap", role, have: n });
        }
    }
    // Rank is a data invariant rather than a roster choice, but it is checked
    // here too: a ranked Rare means a burn wrote somewhere it shouldn't have,
    // and silently clamping it would hide the bug behind a working battle.
    for (const u of real) {
        if (u.rank === undefined)
            continue;
        if (!Number.isInteger(u.rank) || u.rank < 1 || u.rank > MAX_RANK) {
            out.push({ code: "rank_out_of_range", cardId: u.cardId, rank: u.rank });
        }
        else if (u.rank > 1 && !RANKABLE.has(u.rarity)) {
            out.push({ code: "rank_not_rankable", cardId: u.cardId, rarity: u.rarity });
        }
    }
    return out;
}
/* -------------------------------------------------------------------- rng */
/**
 * mulberry32. Seeded so a match can be replayed from its stored seed — which
 * is what makes results auditable and tests non-flaky.
 */
export function seededRng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
function strike(att, def, round, 
/** Rounds since armour was last refreshed — Bulwark resets this to 1. */
armourRound, mods, roll, t) {
    const armour = def.mit * t.mitigationDecay ** (armourRound - 1);
    const mitigation = mods.pierce ? 0 : armour / (armour + t.mitigationK);
    const output = att.dmg * mods.damageMultiplier;
    const prevented = output * mitigation;
    const jitter = 1 + (roll() * 2 - 1) * t.variance;
    const net = Math.max(0, (output - prevented) * t.escalation ** (round - 1) * jitter * mods.incomingMultiplier);
    return { net, prevented };
}
/**
 * Builds the ultimate meters for a team.
 *
 * Legendaries always have one. Epics get a weakened version once ranked to
 * `epicUltRank`. Rares never do — which is what keeps the roster caps
 * meaningful, since only five of six slots can ever hold an ability.
 */
function ultsFor(team, t) {
    const out = [];
    for (const u of team) {
        if (!u.role)
            continue;
        const rank = clampRank(u.rank);
        let potency;
        if (u.rarity === "legendary")
            potency = 1;
        else if (u.rarity === "epic" && rank >= t.rank.epicUltRank)
            potency = t.rank.epicPotency;
        else
            continue;
        const rate = t.ult.chargeBase * (1 + (t.rank.chargeBonus * (rank - 1)) / (MAX_RANK - 1));
        out.push({ role: u.role, charge: 0, rate, potency });
    }
    return out;
}
/**
 * Advances every meter and returns what fired. Charge carries the remainder
 * rather than resetting to zero, so a long match gets a steady cadence of
 * ultimates instead of drifting out of sync with the round counter.
 */
function advanceUlts(ults, hpLostFraction, roll, t) {
    const fired = [];
    for (const u of ults) {
        const jitter = 1 + (roll() * 2 - 1) * t.ult.chargeJitter;
        u.charge += u.rate * jitter + hpLostFraction * t.ult.chargeFromDamage;
        if (u.charge >= 1) {
            u.charge -= 1;
            fired.push({ role: u.role, potency: u.potency });
        }
    }
    return fired;
}
function countByRole(fired) {
    const out = { vanguard: 0, duelist: 0, strategist: 0 };
    for (const f of fired)
        out[f.role]++;
    return out;
}
/** Focus Fire damage, scaled by potency and stacking across multiple Duelists. */
function focusFireMultiplier(fired, t) {
    let mult = 1;
    for (const f of fired) {
        if (f.role === "duelist")
            mult += (t.ult.duelist.damageMultiplier - 1) * f.potency;
    }
    return mult;
}
/**
 * Armour-piercing is the Legendary half of Focus Fire. A ranked Epic gets the
 * damage spike but not the pierce, so the full-strength version stays
 * distinctly better rather than merely larger.
 */
function piercesArmour(fired) {
    return fired.some((f) => f.role === "duelist" && f.potency >= 1);
}
/** Bulwark, compounding if more than one Vanguard pops in the same round. */
function bulwarkMultiplier(fired, t) {
    let mult = 1;
    for (const f of fired) {
        if (f.role === "vanguard")
            mult *= 1 - (1 - t.ult.vanguard.incomingMultiplier) * f.potency;
    }
    return mult;
}
/** Rally, as a fraction of max HP. */
function rallyFraction(fired, t) {
    let total = 0;
    for (const f of fired) {
        if (f.role === "strategist")
            total += t.ult.strategist.healFraction * f.potency;
    }
    return total;
}
/**
 * Resolves a match. `b` is the defender and receives `defenderAdvantage`.
 *
 * Both sides strike simultaneously each round, so there is no first-mover
 * advantage; a double knockout is settled on the less negative HP fraction.
 */
export function simulate(a, b, seed, opts = {}) {
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
    const rounds = [];
    const repA = { dealt: 0, prevented: 0, healed: 0 };
    const repB = { dealt: 0, prevented: 0, healed: 0 };
    let winner = null;
    const ultsA = ultsFor(a, t);
    const ultsB = ultsFor(b, t);
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
        const rallyA = rallyFraction(firedA, t);
        const rallyB = rallyFraction(firedB, t);
        if (rallyA > 0)
            hpA = Math.min(maxA, hpA + maxA * rallyA);
        if (rallyB > 0)
            hpB = Math.min(maxB, hpB + maxB * rallyB);
        if (firedA.some((f) => f.role === "vanguard"))
            armourRoundA = 1;
        if (firedB.some((f) => f.role === "vanguard"))
            armourRoundB = 1;
        const modsA = {
            damageMultiplier: focusFireMultiplier(firedA, t),
            pierce: piercesArmour(firedA),
            incomingMultiplier: bulwarkMultiplier(firedB, t),
        };
        const modsB = {
            damageMultiplier: focusFireMultiplier(firedB, t),
            pierce: piercesArmour(firedB),
            incomingMultiplier: bulwarkMultiplier(firedA, t),
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
            aUlts: countByRole(firedA),
            bUlts: countByRole(firedB),
        });
        if (hpA <= 0 || hpB <= 0) {
            if (hpA > 0)
                winner = "a";
            else if (hpB > 0)
                winner = "b";
            // Double KO: whoever is less dead. Exact ties go to the defender.
            else
                winner = hpA / maxA > hpB / maxB ? "a" : "b";
            break;
        }
    }
    // Only reachable if neither side can deal damage at all — escalation ends
    // every other fight well inside maxRounds.
    if (!winner)
        winner = hpA / maxA > hpB / maxB ? "a" : "b";
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
function pickMvp(team, report, side, t) {
    const stats = teamStats(team, t);
    let best = null;
    for (const u of team) {
        const p = (t.power[u.rarity] ?? 0) ** t.powerExponent;
        const w = t.roles[u.role ?? "recruit"];
        const score = (stats.dmg > 0 ? ((p * w.dmg) / stats.dmg) * report.dealt : 0) +
            (stats.mit > 0 ? ((p * w.mit) / stats.mit) * report.prevented : 0) +
            (stats.heal > 0 ? ((p * w.heal) / stats.heal) * report.healed : 0);
        if (!best || score > best.score)
            best = { cardId: u.cardId, score };
    }
    return best ? { side, cardId: best.cardId } : null;
}
//# sourceMappingURL=battle.js.map