/*
 * scoring.js  —  The Doomlings scoring engine.
 *
 * One pure entry point: scoreGame(setup) -> result.
 * It resolves "The End of the World" in the RULEBOOK order:
 *
 *   1. In TURN ORDER, apply each player's "At World's End" trait choices that
 *      mutate piles  (Faith recolor -> Cherished return -> Hyper-Intelligence
 *      discards on opponents). Order matters: an earlier player's Hyper-
 *      Intelligence can remove a trait a later player would have scored.
 *   2. Apply the final catastrophe's World's End effect to every player
 *      (forced discards, AI Takeover, and point swings like Ice Age).
 *   3. Score each player:  catastrophe points + trait face values + drop-of-life
 *      bonuses  (+ opponent-facing effects like Viral).
 *   4. Determine the winner; flag a tie for the rulebook tiebreaker.
 *
 * `setup` is fully resolved input — every interactive choice from the
 * walkthrough is already recorded in setup.choices. That keeps this engine
 * deterministic and unit-testable with no UI.
 */
(function (root, factory) {
  const eff = typeof module !== "undefined" && module.exports
    ? require("./effects.js")
    : root.DoomlingsEffects;
  const api = factory(eff);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DoomlingsScoring = api;
})(typeof self !== "undefined" ? self : this, function (E) {
  "use strict";

  const clone = (x) => JSON.parse(JSON.stringify(x));

  /**
   * @param {object} setup
   *   players: [{ id, name, order, pile:[card], handCount, handColorless,
   *               handColors, handDominants, genePool }]
   *   catastrophe: { name, worldsEnd:{kind,...} }
   *   choices: {
   *     faith:            { [pid]: {from, to} },
   *     cherished:        { [pid]: traitName },          // returned to hand
   *     hyperIntelligence:{ [pid]: [{opponentId, color, discardTraitName}] },
   *     boredom:          { [pid]: colorlessInHandCount },
   *     catastropheDiscard:{ [pid]: traitName },          // forced discard pick
   *     deusExMachina:    { [pid]: drawnFaceValue },
   *     tieBreak:         { [pid]: drawnFaceValue },
   *   }
   */
  function scoreGame(setup) {
    const choices = setup.choices || {};
    // Work on a copy sorted by turn order so mutations propagate correctly.
    const players = clone(setup.players).sort((a, b) => a.order - b.order);
    const byId = Object.fromEntries(players.map((p) => [p.id, p]));
    const log = []; // human-readable resolution log for the walkthrough UI

    // ---- STEP 1: At-World's-End trait choices, in turn order --------------
    for (const p of players) {
      // Faith: recolor one color group in your own pile.
      const faith = choices.faith && choices.faith[p.id];
      if (faith && faith.from && faith.to) {
        let n = 0;
        for (const c of p.pile) {
          if (c.color === faith.from) { c.color = faith.to; n++; }
        }
        if (n) log.push(`${p.name} — Faith: recolored ${n} ${faith.from} trait(s) to ${faith.to}.`);
      }

      // Cherished: return one trait from your pile to your hand (removes it).
      const cher = choices.cherished && choices.cherished[p.id];
      if (cher) {
        removeTraitByName(p.pile, cher);
        log.push(`${p.name} — Cherished: returned ${cher} to hand.`);
      }

      // Hyper-Intelligence: choose ONE color; every opponent discards a trait of
      // that color (at random — the walkthrough lets you name which one).
      const hi = choices.hyperIntelligence && choices.hyperIntelligence[p.id];
      if (hi && hi.color) {
        for (const opp of players) {
          if (opp.id === p.id) continue;
          const pick = hi.discards && hi.discards[opp.id];
          const removed = pick
            ? removeTraitByName(opp.pile, pick)
            : removeFirstOfColor(opp.pile, hi.color);
          if (removed) log.push(
            `${p.name} — Hyper-Intelligence: ${opp.name} discarded ${removed.name} (${hi.color}).`
          );
        }
      }
    }

    // ---- STEP 2: final catastrophe pile mutations ------------------------
    const cata = setup.catastrophe;
    const we = (cata && cata.worldsEnd) || { kind: "none" };
    const aiTakeover = we.kind === "aiTakeover";

    if (we.kind === "discardColorTrait") {
      for (const p of players) {
        const pick = choices.catastropheDiscard && choices.catastropheDiscard[p.id];
        const removed = pick ? removeTraitByName(p.pile, pick) : removeLowestOfColor(p.pile, we.color);
        if (removed) log.push(`${cata.name}: ${p.name} discarded ${removed.name} (${we.color}).`);
      }
    } else if (we.kind === "discardHighFaceTrait") {
      for (const p of players) {
        const pick = choices.catastropheDiscard && choices.catastropheDiscard[p.id];
        const removed = pick
          ? removeTraitByName(p.pile, pick)
          : removeLowestAtOrAbove(p.pile, we.minValue);
        if (removed) log.push(`${cata.name}: ${p.name} discarded ${removed.name} (face ${removed.faceValue}).`);
      }
    }

    // ---- STEP 3: score each player ---------------------------------------
    const allPiles = players.map((p) => ({ playerId: p.id, pile: p.pile }));
    const results = {};
    for (const p of players) {
      const ctx = { pile: p.pile, allPiles, owner: p, players, aiTakeover };

      // (a) trait face values (compass/0 = 0; AI Takeover overrides colorless)
      let faceValue = 0;
      for (const c of p.pile) faceValue += E.effectiveFace(c, aiTakeover);

      // (b) drop-of-life bonuses from this player's own traits
      const bonusBreakdown = [];
      for (const c of p.pile) {
        // AI Takeover: ignore colorless (non-dominant) effects
        if (aiTakeover && c.color === "colorless" && !c.isDominant) continue;
        for (const e of c.scoringEffects || []) {
          const pts = E.evalEffect(e, ctx);
          if (pts !== 0) bonusBreakdown.push({ source: c.name, amount: pts });
        }
      }

      results[p.id] = {
        id: p.id, name: p.name,
        faceValue,
        bonusBreakdown,
        worldsEndBreakdown: [],
        pileAfter: p.pile.map((c) => c.name),
      };
    }

    // (c) chosen-color World's End traits (resolved in turn order above; scored here)
    for (const p of players) {
      const hasTrait = (name) => p.pile.some((c) => c.name === name);

      // Sentience: choose a color -> +1 for each of YOUR traits of that color.
      const sColor = choices.sentience && choices.sentience[p.id];
      if (sColor && hasTrait("SENTIENCE")) {
        const pts = E.countColor(p.pile, sColor);
        if (pts) results[p.id].bonusBreakdown.push({ source: `Sentience (${sColor})`, amount: pts });
      }

      // Viral: choose a color -> each OPPONENT gets -1 per trait of that color.
      const vColor = choices.viral && choices.viral[p.id];
      if (vColor && hasTrait("VIRAL")) {
        for (const opp of players) {
          if (opp.id === p.id) continue;
          const pts = -1 * E.countColor(opp.pile, vColor);
          if (pts) results[opp.id].bonusBreakdown.push({ source: `Viral ${vColor} (from ${p.name})`, amount: pts });
        }
      }
    }

    // (d) catastrophe World's End POINT effects
    applyCatastrophePoints(we, players, results, choices, cata && cata.name);

    // ---- totals ----------------------------------------------------------
    for (const p of players) {
      const r = results[p.id];
      r.bonuses = sum(r.bonusBreakdown.map((b) => b.amount));
      r.worldsEndPoints = sum(r.worldsEndBreakdown.map((b) => b.amount));
      r.total = r.faceValue + r.bonuses + r.worldsEndPoints;
    }

    // ---- winner + tiebreak ----------------------------------------------
    const ordered = players.map((p) => results[p.id]);
    const best = Math.max(...ordered.map((r) => r.total));
    let winners = ordered.filter((r) => r.total === best);
    let needsTieBreak = winners.length > 1;

    if (needsTieBreak && choices.tieBreak) {
      // Rulebook tiebreak: draw a card, highest face value wins.
      const tied = winners.map((r) => ({ r, draw: choices.tieBreak[r.id] }));
      if (tied.every((t) => t.draw != null)) {
        const bestDraw = Math.max(...tied.map((t) => t.draw));
        winners = tied.filter((t) => t.draw === bestDraw).map((t) => t.r);
        needsTieBreak = winners.length > 1;
      }
    }

    return {
      players: ordered,
      winnerIds: winners.map((r) => r.id),
      needsTieBreak,
      log,
      catastrophe: cata ? cata.name : null,
    };
  }

  // ---- catastrophe point effects ---------------------------------------
  function applyCatastrophePoints(we, players, results, choices, cataName) {
    const push = (pid, amount, text) => {
      if (amount !== 0) results[pid].worldsEndBreakdown.push({ source: cataName || "Catastrophe", amount, text });
    };

    switch (we.kind) {
      case "perColorTraitPoints": // Ice Age, Retrovirus, Solar Flare, Super Volcano
        for (const p of players) push(p.id, we.amount * E.countColor(p.pile, we.color), we.text);
        break;

      case "perMissingColorPoints": { // The Big One: -2 per color missing from pile
        const all = E.COLORS;
        for (const p of players) {
          const present = new Set(p.pile.map((c) => c.color));
          const missing = all.filter((c) => !present.has(c)).length;
          push(p.id, we.amount * missing, we.text);
        }
        break;
      }

      case "pointsToFewestTraits": { // Overpopulation
        const min = Math.min(...players.map((p) => p.pile.length));
        for (const p of players) if (p.pile.length === min) push(p.id, we.amount, we.text);
        break;
      }
      case "pointsToMostTraits": { // Grey Goo
        const max = Math.max(...players.map((p) => p.pile.length));
        for (const p of players) if (p.pile.length === max) push(p.id, we.amount, we.text);
        break;
      }
      case "deusExMachina": // per-player drawn face value (max 7)
        for (const p of players) {
          const drawn = (choices.deusExMachina && choices.deusExMachina[p.id]) || 0;
          push(p.id, Math.min(drawn, we.max || 7), we.text);
        }
        break;

      // discardColorTrait / discardHighFaceTrait / aiTakeover: no direct points
      default:
        break;
    }
  }

  // ---- pile mutation helpers -------------------------------------------
  function removeTraitByName(pile, name) {
    const i = pile.findIndex((c) => c.name === name);
    return i >= 0 ? pile.splice(i, 1)[0] : null;
  }
  function removeFirstOfColor(pile, color) {
    const i = pile.findIndex((c) => c.color === color);
    return i >= 0 ? pile.splice(i, 1)[0] : null;
  }
  function removeLowestOfColor(pile, color) {
    let idx = -1, lo = Infinity;
    pile.forEach((c, i) => {
      if (c.color === color && (c.faceValue || 0) < lo) { lo = c.faceValue || 0; idx = i; }
    });
    return idx >= 0 ? pile.splice(idx, 1)[0] : null;
  }
  function removeLowestAtOrAbove(pile, minValue) {
    let idx = -1, lo = Infinity;
    pile.forEach((c, i) => {
      const f = c.faceValue || 0;
      if (f >= minValue && f < lo) { lo = f; idx = i; }
    });
    return idx >= 0 ? pile.splice(idx, 1)[0] : null;
  }
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);

  return { scoreGame };
});
