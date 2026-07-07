/*
 * scoring.test.js  —  runnable with `node tests/scoring.test.js`
 *
 * Validates the scoring engine against cases worked out by hand from the real
 * base-game cards (the corrected xlsx data). No test framework needed.
 */
const fs = require("fs");
const path = require("path");
const { scoreGame } = require("../js/scoring.js");

const data = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "data", "base-game.json"), "utf8")
);
const CARDS = Object.fromEntries(data.traits.map((c) => [c.name, c]));
const CATA = Object.fromEntries(data.catastrophes.map((c) => [c.name, c]));

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
const scoreOf = (res, id) => res.players.find((p) => p.id === id).total;
const NEUTRAL = () => CATA["GLACIAL MELTDOWN"]; // discard 1 blue; a no-op if no blue

// 1: face values + Egg Clusters "+1 per blue"
{
  const res = scoreGame({
    players: [player("a", "A", 0, ["EGG CLUSTERS", "BLUBBER", "MIGRATORY"])],
    catastrophe: CATA["ICE AGE"], choices: {},
  });
  eq("Egg Clusters (-1+4+2)+3 blue", scoreOf(res, "a"), 8);
}

// 2: Tiny "-1 per non-dominant trait" (Tiny is itself Dominant)
{
  const res = scoreGame({
    players: [player("a", "A", 0, ["TINY", "BLUBBER", "MIGRATORY"])],
    catastrophe: CATA["ICE AGE"], choices: {},
  });
  eq("Tiny (17+4+2)-2 non-dominant", scoreOf(res, "a"), 21);
}

// 3: Ice Age -1/red vs Heat Vision +1/red
{
  const res = scoreGame({
    players: [player("a", "A", 0, ["QUICK", "STONE SKIN", "HEAT VISION"])],
    catastrophe: CATA["ICE AGE"], choices: {},
  });
  eq("Ice Age vs Heat Vision", scoreOf(res, "a"), 3);
}

// 4: Faith recolors BEFORE the catastrophe (turn order)
{
  const res = scoreGame({
    players: [player("a", "A", 0, ["FAITH", "QUICK", "STONE SKIN"])],
    catastrophe: CATA["ICE AGE"],
    choices: { faith: { a: { from: "red", to: "blue" } } },
  });
  eq("Faith dodges Ice Age", scoreOf(res, "a"), 8);
}

// 5: Hyper-Intelligence — one color, every opponent discards it
{
  const res = scoreGame({
    players: [
      player("a", "A", 0, ["HYPER-INTELLIGENCE"]),
      player("b", "B", 1, ["ADORABLE", "FINE MOTOR SKILLS"]),
    ],
    catastrophe: NEUTRAL(),
    choices: { hyperIntelligence: { a: { color: "purple", discards: { b: "ADORABLE" } } } },
  });
  eq("HI: A keeps 4", scoreOf(res, "a"), 4);
  eq("HI: B loses Adorable -> 2", scoreOf(res, "b"), 2);
}

// 6: Swarm counts across ALL piles (duplicates allowed)
{
  const res = scoreGame({
    players: [
      player("a", "A", 0, ["SWARM", "SWARM"]),
      player("b", "B", 1, ["SWARM"]),
    ],
    catastrophe: CATA["ICE AGE"], choices: {},
  });
  eq("Swarm across piles: A (2x +3)", scoreOf(res, "a"), 6);
  eq("Swarm across piles: B (1x +3)", scoreOf(res, "b"), 3);
}

// 7: Kidney counts duplicates in your own pile
{
  const res = scoreGame({
    players: [player("a", "A", 0, ["KIDNEY", "KIDNEY", "KIDNEY"])],
    catastrophe: NEUTRAL(), choices: {},
  });
  // 3 kidneys, each +3 -> 9; face 0
  eq("Kidney x3 -> +9", scoreOf(res, "a"), 9);
}

// 8: Deus Ex Machina now caps at +5
{
  const res = scoreGame({
    players: [player("a", "A", 0, ["ADORABLE"])],
    catastrophe: CATA["DEUS EX MACHINA"],
    choices: { deusExMachina: { a: 9 } },
  });
  eq("Deus Ex Machina cap +5", scoreOf(res, "a"), 9);
}

// 9: Overpopulation now +4 to fewest
{
  const res = scoreGame({
    players: [
      player("a", "A", 0, ["ADORABLE"]),
      player("b", "B", 1, ["QUICK", "STONE SKIN", "BLUBBER"]),
    ],
    catastrophe: CATA["OVERPOPULATION"], choices: {},
  });
  eq("Overpopulation +4 to fewest (A)", res.players.find(p=>p.id==="a").worldsEndPoints, 4);
}

// 10: Apex Predator now just +4 if strictly most traits
{
  const res = scoreGame({
    players: [
      player("a", "A", 0, ["APEX PREDATOR", "QUICK", "STONE SKIN"]),
      player("b", "B", 1, ["ADORABLE"]),
    ],
    catastrophe: NEUTRAL(), choices: {},
  });
  // face 4+2+2=8; +4 most traits => 12
  eq("Apex Predator +4 most traits", scoreOf(res, "a"), 12);
}

// 11: Sentience — choose a color, +1 per own trait of it
{
  const res = scoreGame({
    players: [player("a", "A", 0, ["SENTIENCE", "QUICK", "STONE SKIN"])],
    catastrophe: NEUTRAL(),
    choices: { sentience: { a: "red" } },
  });
  // face 2+2+2=6; +1 per red (3 reds) => 9
  eq("Sentience +1 per chosen color", scoreOf(res, "a"), 9);
}

// 12: Viral — choose a color, each opponent -1 per trait of it
{
  const res = scoreGame({
    players: [
      player("a", "A", 0, ["VIRAL"]),
      player("b", "B", 1, ["ADORABLE", "FINE MOTOR SKILLS", "QUICK"]),
    ],
    catastrophe: NEUTRAL(),
    choices: { viral: { a: "purple" } },
  });
  // B has 2 purple -> -2; face 4+2+2=8 => 6
  eq("Viral on B (-2)", scoreOf(res, "b"), 6);
  eq("Viral: A unaffected", scoreOf(res, "a"), 2);
}

// 13: The Big One — -2 per color MISSING from your pile
{
  const res = scoreGame({
    players: [player("a", "A", 0, ["QUICK"])], // only red present
    catastrophe: CATA["THE BIG ONE"], choices: {},
  });
  // missing blue/green/purple/colorless = 4 -> -8; face 2 => -6
  eq("The Big One -2 per missing color", scoreOf(res, "a"), -6);
}

// 14: "Value equals" cards
{
  const alt = scoreGame({
    players: [player("a", "A", 0, ["ALTRUISTIC"], { genePool: 6 })],
    catastrophe: NEUTRAL(), choices: {},
  });
  eq("Altruistic = gene pool (6)", scoreOf(alt, "a"), 6);

  const fort = scoreGame({
    players: [player("a", "A", 0, ["FORTUNATE"], { handCount: 3 })],
    catastrophe: NEUTRAL(), choices: {},
  });
  eq("Fortunate = hand count (3)", scoreOf(fort, "a"), 3);

  const grat = scoreGame({
    players: [player("a", "A", 0, ["GRATITUDE", "QUICK", "BLUBBER"])],
    catastrophe: CATA["PULSE EVENT"], choices: {}, // discards purple; none here -> no-op
  });
  // colors: colorless(gratitude)+red+blue = 3; face 0+2+4=6 => 9
  eq("Gratitude = distinct pile colors", scoreOf(grat, "a"), 9);

  const bore = scoreGame({
    players: [player("a", "A", 0, ["BOREDOM"], { handEffectCards: 4 })],
    catastrophe: NEUTRAL(), choices: {},
  });
  eq("Boredom = hand cards w/ effects (4)", scoreOf(bore, "a"), 4);
}

// 15: Branches — +1 per pair of green in EACH opponent's pile
{
  const res = scoreGame({
    players: [
      player("a", "A", 0, ["BRANCHES"]),
      player("b", "B", 1, ["APPEALING", "BARK", "LOW-HANGING", "LEAVES"]), // 4 green
    ],
    catastrophe: NEUTRAL(), choices: {},
  });
  // 4 green -> 2 pairs -> A +2
  eq("Branches +1 per opponent green pair", scoreOf(res, "a"), 2);
}

// 16: AI Takeover — colorless traits worth 2, colorless effects ignored
{
  const res = scoreGame({
    players: [player("a", "A", 0, ["FLATULENCE", "MINDFUL"])], // both colorless
    catastrophe: CATA["AI TAKEOVER"], choices: {},
  });
  // face overridden to 2 each = 4; Mindful's colorless effect ignored
  eq("AI Takeover colorless=2, effects ignored", scoreOf(res, "a"), 4);
}

// 17: The Four Horsemen forced discard of a >=4 face trait
{
  const res = scoreGame({
    players: [player("a", "A", 0, ["ADORABLE", "QUICK"])],
    catastrophe: CATA["THE FOUR HORSEMEN"], choices: {},
  });
  eq("Four Horsemen discards Adorable", scoreOf(res, "a"), 2);
}

// 18: tie detection + rulebook draw tiebreak
{
  const tie = scoreGame({
    players: [player("a", "A", 0, ["ADORABLE"]), player("b", "B", 1, ["ADORABLE"])],
    catastrophe: NEUTRAL(), choices: {},
  });
  eq("tie flagged", tie.needsTieBreak, true);
  const broken = scoreGame({
    players: [player("a", "A", 0, ["ADORABLE"]), player("b", "B", 1, ["ADORABLE"])],
    catastrophe: NEUTRAL(), choices: { tieBreak: { a: 5, b: 3 } },
  });
  eq("tiebreak resolves to A", broken.winnerIds.join(","), "a");
}

// 19: data integrity
eq("no needs-review cards", data.needsReview.length, 0);
eq("15 catastrophes parsed", data.catastrophes.length, 15);
eq("114 traits parsed", data.traits.length, 114);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
