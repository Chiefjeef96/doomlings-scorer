/*
 * scoring.test.js  —  runnable with `node tests/scoring.test.js`
 *
 * Validates the scoring engine against cases worked out by hand from the real
 * base-game cards. No test framework needed — just Node.
 */
const fs = require("fs");
const path = require("path");
const { scoreGame } = require("../js/scoring.js");

const data = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "base-game.json"), "utf8")
);
const CARDS = Object.fromEntries(data.traits.map((c) => [c.name, c]));
const CATA = Object.fromEntries(data.catastrophes.map((c) => [c.name, c]));

// Build a player pile from card names (cards come straight from the data file).
function card(name) {
  if (!CARDS[name]) throw new Error("unknown card: " + name);
  return JSON.parse(JSON.stringify(CARDS[name]));
}
function player(id, name, order, pileNames, extra = {}) {
  return { id, name, order, pile: pileNames.map(card), ...extra };
}

let passed = 0, failed = 0;
function eq(label, got, want) {
  const ok = got === want;
  console.log(`${ok ? "  ok  " : " FAIL "} ${label}  (got ${got}${ok ? "" : ", want " + want})`);
  ok ? passed++ : failed++;
}
function scoreOf(res, id) {
  return res.players.find((p) => p.id === id).total;
}

// -- 1: face values + Egg Clusters "+1 per blue" ---------------------------
{
  const res = scoreGame({
    players: [player("a", "A", 0, ["EGG CLUSTERS", "BLUBBER", "MIGRATORY"])],
    catastrophe: CATA["ICE AGE"], // -1 per red; player has none -> 0
    choices: {},
  });
  eq("Egg Clusters: (-1+4+2) + 3 blue", scoreOf(res, "a"), 8);
}

// -- 2: Tiny "-1 per trait (excl dominants)" -------------------------------
{
  const res = scoreGame({
    players: [player("a", "A", 0, ["TINY", "BLUBBER", "MIGRATORY"])],
    catastrophe: CATA["ICE AGE"],
    choices: {},
  });
  // Tiny is itself a Dominant, so "excluding dominants" counts only 2 traits.
  eq("Tiny: (17+4+2) - 2 non-dominant traits", scoreOf(res, "a"), 21);
}

// -- 3: Ice Age -1 per red vs Heat Vision +1 per red -----------------------
{
  const res = scoreGame({
    players: [player("a", "A", 0, ["QUICK", "STONE SKIN", "HEAT VISION"])],
    catastrophe: CATA["ICE AGE"],
    choices: {},
  });
  // face 2+2-1=3; HeatVision +3; IceAge -3  => 3
  eq("Ice Age vs Heat Vision", scoreOf(res, "a"), 3);
}

// -- 4: Faith recolors BEFORE catastrophe (turn-order matters) -------------
{
  const res = scoreGame({
    players: [player("a", "A", 0, ["FAITH", "QUICK", "STONE SKIN"])],
    catastrophe: CATA["ICE AGE"],
    choices: { faith: { a: { from: "red", to: "blue" } } },
  });
  // recolor reds->blue, Ice Age now 0; face 4+2+2 = 8
  eq("Faith dodges Ice Age", scoreOf(res, "a"), 8);
}

// -- 5: Hyper-Intelligence removes an opponent's trait, in turn order ------
{
  const res = scoreGame({
    players: [
      player("a", "A", 0, ["HYPER-INTELLIGENCE"]),
      player("b", "B", 1, ["ADORABLE", "FINE MOTOR SKILLS"]),
    ],
    catastrophe: CATA["GLACIAL MELTDOWN"], // discard 1 blue; nobody has blue -> no-op
    choices: {
      hyperIntelligence: { a: [{ opponentId: "b", color: "purple", discardTraitName: "ADORABLE" }] },
    },
  });
  eq("HI: A keeps 4", scoreOf(res, "a"), 4);
  eq("HI: B loses Adorable, keeps 2", scoreOf(res, "b"), 2);
}

// -- 6: Swarm counts across ALL piles --------------------------------------
{
  const res = scoreGame({
    players: [
      player("a", "A", 0, ["SWARM (2)", "SWARM (3)"]),
      player("b", "B", 1, ["SWARM (4)"]),
    ],
    catastrophe: CATA["ICE AGE"],
    choices: {},
  });
  // 3 swarms total; A has 2 cards each +3 = 6; B 1 card +3 = 3
  eq("Swarm across piles: A", scoreOf(res, "a"), 6);
  eq("Swarm across piles: B", scoreOf(res, "b"), 3);
}

// -- 7: Deus Ex Machina drawn face value, capped at +7 ---------------------
{
  const res = scoreGame({
    players: [player("a", "A", 0, ["ADORABLE"])],
    catastrophe: CATA["DEUS EX MACHINA"],
    choices: { deusExMachina: { a: 9 } }, // capped to 7
  });
  eq("Deus Ex Machina cap", scoreOf(res, "a"), 11);
}

// -- 8: Overpopulation +5 to the fewest-traits player ----------------------
{
  const res = scoreGame({
    players: [
      player("a", "A", 0, ["ADORABLE"]),                    // 1 trait
      player("b", "B", 1, ["QUICK", "STONE SKIN", "BLUBBER"]), // 3 traits
    ],
    catastrophe: CATA["OVERPOPULATION"],
    choices: {},
  });
  eq("Overpopulation +5 to fewest (A)", scoreOf(res, "a"), 4 + 5);
  eq("Overpopulation none to most (B)", scoreOf(res, "b"), 2 + 2 + 4);
}

// -- 9: Apex Predator (+2 most, +2 per fewer opponent) ---------------------
{
  const res = scoreGame({
    players: [
      player("a", "A", 0, ["APEX PREDATOR", "QUICK", "STONE SKIN"]), // 3 traits
      player("b", "B", 1, ["ADORABLE"]),                             // 1
      player("c", "C", 2, ["BLUBBER", "MIGRATORY"]),                 // 2
    ],
    catastrophe: CATA["ICE AGE"], // A has 2 red (Quick, Stone Skin) -> -2
    choices: {},
  });
  // face 2+2+2=6; apex +2 (most) +2*2 (two fewer) = +6; Apex/Quick/Stone are all
  // red so Ice Age is -3  => 9
  eq("Apex Predator", scoreOf(res, "a"), 9);
}

// -- 10: Viral penalizes opponents -----------------------------------------
{
  const res = scoreGame({
    players: [
      player("a", "A", 0, ["VIRAL"]),
      player("b", "B", 1, ["ADORABLE", "FINE MOTOR SKILLS", "QUICK"]), // purple x2 most common
    ],
    catastrophe: CATA["GLACIAL MELTDOWN"],
    choices: {},
  });
  // B most-common color purple count 2 -> Viral -2; face 4+2+2=8 -> 6
  eq("Viral on B", scoreOf(res, "b"), 6);
  eq("Viral: A unaffected", scoreOf(res, "a"), 2);
}

// -- 11: Boredom "+2 per colorless card in hand" ---------------------------
{
  const res = scoreGame({
    players: [player("a", "A", 0, ["BOREDOM"], { handColorless: 0 })],
    catastrophe: CATA["ICE AGE"],
    choices: { boredom: { a: 3 } },
  });
  eq("Boredom +2 per colorless in hand", scoreOf(res, "a"), 6);
}

// -- 12: The Four Horsemen forces discard of a >=4 face trait --------------
{
  const res = scoreGame({
    players: [player("a", "A", 0, ["ADORABLE", "QUICK"])], // Adorable=4, Quick=2
    catastrophe: CATA["THE FOUR HORSEMEN"],
    choices: {}, // default: discard lowest-face trait at/above 4 => Adorable
  });
  eq("Four Horsemen discards Adorable", scoreOf(res, "a"), 2);
}

// -- 13: tie detection + rulebook draw tiebreak ----------------------------
{
  const tie = scoreGame({
    players: [
      player("a", "A", 0, ["ADORABLE"]),
      player("b", "B", 1, ["ADORABLE"]),
    ],
    catastrophe: CATA["ICE AGE"],
    choices: {},
  });
  eq("tie flagged", tie.needsTieBreak, true);
  const broken = scoreGame({
    players: [
      player("a", "A", 0, ["ADORABLE"]),
      player("b", "B", 1, ["ADORABLE"]),
    ],
    catastrophe: CATA["ICE AGE"],
    choices: { tieBreak: { a: 5, b: 3 } },
  });
  eq("tiebreak resolves to A", broken.winnerIds.join(","), "a");
}

// -- 14: data integrity ----------------------------------------------------
eq("no needs-review cards", data.needsReview.length, 0);
eq("15 catastrophes parsed", data.catastrophes.length, 15);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
