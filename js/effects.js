/*
 * effects.js  —  Reusable "drop of life" effect evaluators.
 *
 * The card data (data/base-game.json) never contains logic, only structured
 * effect references like { kind: "perColorTrait", color: "blue", amount: 1 }.
 * This file is the ONE place that knows how each `kind` turns into points.
 * Adding an expansion = new JSON that reuses these same kinds (or, if it needs a
 * genuinely new pattern, you add one evaluator here and nothing else changes).
 *
 * Every evaluator is a pure function of (effect, ctx) -> number of points for
 * the card's OWNER. Opponent-facing effects (e.g. Viral) are handled separately
 * in scoring.js because they touch other players' totals.
 *
 * Works in the browser (attaches to window.DoomlingsEffects) and in Node
 * (module.exports) so the same code is unit-tested and shipped.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.DoomlingsEffects = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- small counting helpers ------------------------------------------
  const COLORS = ["blue", "green", "red", "purple", "colorless"];

  /** Effective face value of a card, honoring AI Takeover. */
  function effectiveFace(card, aiTakeover) {
    if (aiTakeover && card.color === "colorless" && !card.isDominant) return 2;
    return card.faceValue || 0;
  }

  /** Count traits of a given color in a pile. */
  function countColor(pile, color) {
    return pile.filter((c) => c.color === color).length;
  }

  /** Map of color -> count for the colors actually present in the pile. */
  function colorCounts(pile) {
    const m = {};
    for (const c of pile) m[c.color] = (m[c.color] || 0) + 1;
    return m;
  }

  /** Highest single-color count in a pile (0 if empty). */
  function maxColorCount(pile) {
    const m = colorCounts(pile);
    return Object.values(m).reduce((a, b) => Math.max(a, b), 0);
  }

  /** Count of the most-common color, honoring "pick 1 on tie" (same value). */
  function mostCommonColorCount(pile) {
    return maxColorCount(pile);
  }

  /** Count of the rarest present color; requires >=2 distinct colors. */
  function rarestColorCount(pile) {
    const m = colorCounts(pile);
    const vals = Object.values(m);
    if (vals.length < 2) return 0;
    return Math.min(...vals);
  }

  /** Count instances of a named trait (e.g. "kidney") within one pile. */
  function countNamed(pile, name) {
    const n = name.toLowerCase();
    // "SWARM (2)" / "KIDNEY (1)" -> base name before the parenthetical.
    return pile.filter((c) => c.name.toLowerCase().replace(/\s*\(.*\)\s*$/, "") === n).length;
  }

  // ---- evaluator registry ----------------------------------------------
  // ctx = { pile, allPiles, owner, players, aiTakeover }
  const EVALUATORS = {
    // +A for each <color> trait in your pile
    perColorTrait: (e, ctx) => e.amount * countColor(ctx.pile, e.color),

    // +A for every N <color> traits
    perNColorTrait: (e, ctx) =>
      e.amount * Math.floor(countColor(ctx.pile, e.color) / e.n),

    // +A for every N traits of the same color (summed across colors)
    perSameColorGroup: (e, ctx) => {
      const m = colorCounts(ctx.pile);
      return Object.values(m).reduce(
        (sum, cnt) => sum + e.amount * Math.floor(cnt / e.n),
        0
      );
    },

    // -A for each trait in your pile (optionally excluding dominants)
    perTraitInPile: (e, ctx) => {
      const pile = e.excludeDominants ? ctx.pile.filter((c) => !c.isDominant) : ctx.pile;
      return e.amount * pile.length;
    },

    // +A for each negative-face-value trait
    perNegativeTrait: (e, ctx) =>
      e.amount * ctx.pile.filter((c) => (c.faceValue || 0) < 0).length,

    // +A for each face-value-(V) trait
    perFaceValueTrait: (e, ctx) =>
      e.amount * ctx.pile.filter((c) => (c.faceValue || 0) === e.value).length,

    // +A for each trait of the rarest color (needs >=2 colors)
    perRarestColorTrait: (e, ctx) => e.amount * rarestColorCount(ctx.pile),

    // +A for each trait of the most-common color (self)
    perMostCommonColorTrait: (e, ctx) => e.amount * mostCommonColorCount(ctx.pile),

    // +A if <color> is (strictly, if noTies) the most common color
    flatIfMostCommonColor: (e, ctx) => {
      const m = colorCounts(ctx.pile);
      const target = m[e.color] || 0;
      if (target === 0) return 0;
      const others = COLORS.filter((c) => c !== e.color).map((c) => m[c] || 0);
      const maxOther = others.reduce((a, b) => Math.max(a, b), 0);
      const ok = e.noTies ? target > maxOther : target >= maxOther;
      return ok ? e.amount : 0;
    },

    // +A for each <named> trait, scope "self" (this pile) or "all" (every pile)
    perNamedTrait: (e, ctx) => {
      if (e.scope === "all") {
        const total = ctx.allPiles.reduce((s, p) => s + countNamed(p.pile, e.name), 0);
        return e.amount * total;
      }
      return e.amount * countNamed(ctx.pile, e.name);
    },

    // +A if a specific trait is present in your pile (e.g. Fangs -> Vampirism)
    flatIfTraitPresent: (e, ctx) => {
      const want = e.name.toLowerCase();
      const has = ctx.pile.some((c) => c.name.toLowerCase() === want);
      return has ? e.amount : 0;
    },

    // Apex Predator: +flat if strictly most traits; +perFewerOpponent per opponent
    // with strictly fewer traits.
    apexPredator: (e, ctx) => {
      const mine = ctx.pile.length;
      const opp = ctx.players.filter((p) => p.id !== ctx.owner.id);
      const sizes = opp.map((p) => p.pile.length);
      let pts = 0;
      if (sizes.every((s) => mine > s) && opp.length > 0) pts += e.flat;
      pts += e.perFewerOpponent * sizes.filter((s) => s < mine).length;
      return pts;
    },

    // Add your Gene Pool to your score (Altruistic)
    addGenePool: (e, ctx) => ctx.owner.genePool || 0,

    // ---- hand-based ----
    perCardInHand: (e, ctx) => e.amount * (ctx.owner.handCount || 0),
    perColorlessInHand: (e, ctx) => e.amount * (ctx.owner.handColorless || 0),
    perDominantInHand: (e, ctx) => e.amount * (ctx.owner.handDominants || 0),
    perColorInHand: (e, ctx) => {
      const v = e.amount * (ctx.owner.handColors || 0);
      return e.max != null ? Math.min(v, e.max) : v;
    },

    // Opponent-facing effects are NOT scored here (returns 0 for owner);
    // scoring.js applies them to opponents.
    opponentPerMostCommonColorTrait: () => 0,
  };

  /** Evaluate one effect for the owner. Unknown kinds score 0 (and are logged). */
  function evalEffect(effect, ctx) {
    const fn = EVALUATORS[effect.kind];
    if (!fn) {
      if (typeof console !== "undefined") console.warn("No evaluator for", effect.kind);
      return 0;
    }
    return fn(effect, ctx) || 0;
  }

  return {
    COLORS,
    effectiveFace,
    countColor,
    colorCounts,
    mostCommonColorCount,
    rarestColorCount,
    countNamed,
    EVALUATORS,
    evalEffect,
  };
});
