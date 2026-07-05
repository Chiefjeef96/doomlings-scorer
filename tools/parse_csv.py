#!/usr/bin/env python3
"""
parse_csv.py  —  Doomlings card-set build tool.

Reads a raw card CSV (the format exported for the base game) and produces a
clean, app-ready JSON file:  data/<set-id>.json

The app NEVER reads the CSV at runtime. This script is the one place that knows
about the messy CSV shape. Everything downstream reads the tidy JSON.

What it does:
  * Splits the CSV into its three sections (Trait Cards / Ages / Catastrophes).
  * Normalizes colors (e.g. "Colorless (Gray)" -> "colorless").
  * Parses each trait's scoring text into STRUCTURED, REUSABLE effect objects
    (see effects.js for the matching evaluators). A card just references an
    effect type by `kind` plus params, so adding an expansion later is data-only.
  * Flags any card whose scoring text it could not confidently parse into a
    `needsReview` list, instead of silently guessing a score.

Run:   python tools/parse_csv.py "../.claude/Doomlings/doomlings_base_game_cards.csv" base-game "Base Game"
(paths are relative to this tools/ folder; see __main__ for defaults)
"""

import csv
import json
import re
import sys
from pathlib import Path

# --------------------------------------------------------------------------
# Color normalization
# --------------------------------------------------------------------------
COLOR_MAP = {
    "blue": "blue",
    "green": "green",
    "red": "red",
    "purple": "purple",
    "colorless (gray)": "colorless",
    "colorless": "colorless",
    "": "",
}


def norm_color(raw):
    return COLOR_MAP.get(raw.strip().lower(), raw.strip().lower())


def yn(v):
    return v.strip().lower() == "yes"


# --------------------------------------------------------------------------
# Effect parsing
# --------------------------------------------------------------------------
# Each recognized scoring pattern becomes a structured effect dict:
#   {"kind": "...", ...params, "text": "<original>"}
# The runtime (effects.js) has one evaluator per `kind`.
#
# Return value of parse_scoring_effects():
#   (effects_list, choice_or_None, needs_review_bool)
#
# `choice` describes an At-World's-End interaction the walkthrough must prompt
# for (Faith, Hyper-Intelligence, Prepper, etc.). It is NOT auto-scored.

COLOR_WORDS = "(blue|green|red|purple|colorless)"


def parse_scoring_effects(card):
    """Parse a single trait row's Effect/Description into structured effects."""
    name = card["name"]
    text = (card["effect"] or "").strip()
    color = card["color"]
    low = text.lower()
    effects = []
    review = False

    # ---- At World's End cards that require a player CHOICE (walkthrough) -----
    # These are handled interactively; they don't contribute a static score.
    choice = None
    if card["atWorldsEnd"]:
        if name == "FAITH":
            choice = {"type": "faith"}
        elif name == "HYPER-INTELLIGENCE":
            choice = {"type": "hyperIntelligence"}
        elif name == "PREPPER":
            choice = {"type": "prepper"}
        elif name == "BOREDOM":
            # Needs hand composition: colorless cards in hand.
            choice = {"type": "boredom"}
            effects.append({"kind": "perColorlessInHand", "amount": 2,
                            "text": text})
        elif name == "CHERISHED":
            choice = {"type": "cherished"}   # may return 1 trait to hand
        elif name == "ELOQUENCE":
            choice = {"type": "eloquence"}   # may play 1 more trait
        elif name == "SNEAKY":
            choice = {"type": "sneaky"}      # may play this now
        # Faith/HI/Prepper carry no static scoring effect themselves.

    # ---- Drop-of-life / static scoring patterns ------------------------------
    # Order matters: try the most specific patterns first.

    matched = False

    def add(e):
        nonlocal matched
        effects.append(dict(e, text=text))
        matched = True

    # "+N for every M <color> traits"  (PUFFY, DEEP ROOTS, NOCTURNAL, FIRE SKIN)
    m = re.search(r"([+-]?\d+)\s+for every\s+(\d+)\s+" + COLOR_WORDS + r"\s+traits", low)
    if m:
        add({"kind": "perNColorTrait", "color": m.group(3),
             "n": int(m.group(2)), "amount": int(m.group(1))})

    # "+N for every 2 traits of the same color"  (PACK BEHAVIOR)
    m = re.search(r"([+-]?\d+)\s+for every\s+(\d+)\s+traits of the same color", low)
    if m:
        add({"kind": "perSameColorGroup", "n": int(m.group(2)),
             "amount": int(m.group(1))})

    # "+N for each <color> trait"  (EGG CLUSTERS, OVERGROWTH, HEAT VISION, STICKY, MINDFUL)
    m = re.search(r"([+-]?\d+)\s+for each\s+" + COLOR_WORDS + r"\s+trait", low)
    if m:
        add({"kind": "perColorTrait", "color": m.group(2),
             "amount": int(m.group(1))})

    # "+N for each negative face value trait"  (IMMUNITY)
    m = re.search(r"([+-]?\d+)\s+for each negative face value trait", low)
    if m:
        add({"kind": "perNegativeTrait", "amount": int(m.group(1))})

    # "+N for each face value (V) trait"  (POLLINATION)
    m = re.search(r"([+-]?\d+)\s+for each face value\s*\((\d+)\)\s+trait", low)
    if m:
        add({"kind": "perFaceValueTrait", "value": int(m.group(2)),
             "amount": int(m.group(1))})

    # "-N for each trait in your trait pile"  (TINY)  (excluding dominants)
    m = re.search(r"([+-]?\d+)\s+for each trait in your trait pile", low)
    if m:
        add({"kind": "perTraitInPile", "amount": int(m.group(1)),
             "excludeDominants": "excluding dominant" in low})

    # "+N for each trait of the rarest color"  (SYMBIOSIS)
    m = re.search(r"([+-]?\d+)\s+for each trait of the rarest color", low)
    if m:
        add({"kind": "perRarestColorTrait", "amount": int(m.group(1)),
             "requiresMultiColor": True})

    # "+N for each trait of the most common color" (SENTIENCE)  self
    m = re.search(r"([+-]?\d+)\s+for each trait of the most common color in your", low)
    if m:
        add({"kind": "perMostCommonColorTrait", "amount": int(m.group(1))})

    # "opponents receive -N for each trait of the most common color" (VIRAL)
    m = re.search(r"opponents receive\s+([+-]?\d+)\s+for each trait of the most common color", low)
    if m:
        add({"kind": "opponentPerMostCommonColorTrait", "amount": int(m.group(1))})

    # "+N if <color> is the most common color"  (BRANCHES)  no ties
    m = re.search(r"([+-]?\d+)\s+if\s+" + COLOR_WORDS + r"\s+is the most common color", low)
    if m:
        add({"kind": "flatIfMostCommonColor", "color": m.group(2),
             "amount": int(m.group(1)), "noTies": "no ties" in low})

    # "+N for each <NamedTrait> in all trait piles"  (SWARM)
    m = re.search(r"([+-]?\d+)\s+for each\s+(\w+)\s+in all trait piles", low)
    if m:
        add({"kind": "perNamedTrait", "name": m.group(2).lower(),
             "scope": "all", "amount": int(m.group(1))})

    # "+N for each <NamedTrait> in your trait pile"  (KIDNEY)
    m = re.search(r"([+-]?\d+)\s+for each\s+(\w+)\s+in your trait pile", low)
    if m and not matched:  # avoid double-counting the color patterns above
        add({"kind": "perNamedTrait", "name": m.group(2).lower(),
             "scope": "self", "amount": int(m.group(1))})

    # "+N if <Trait> is in your trait pile"  (FANGS -> Vampirism)
    m = re.search(r"([+-]?\d+)\s+if\s+(\w[\w\s]*?)\s+is in your trait pile", low)
    if m:
        add({"kind": "flatIfTraitPresent", "name": m.group(2).strip(),
             "amount": int(m.group(1))})

    # Hand-based bonuses ------------------------------------------------------
    # "+N for each colorless card in your hand"  (handled above for BOREDOM;
    #  guard so we don't add twice)
    if "for each colorless card in your hand" in low and card["name"] != "BOREDOM":
        m = re.search(r"([+-]?\d+)\s+for each colorless card in your hand", low)
        add({"kind": "perColorlessInHand", "amount": int(m.group(1))})

    # "+N for each color in your hand (Max +M)"  (SAUDADE)
    m = re.search(r"([+-]?\d+)\s+for each color in your hand", low)
    if m:
        mx = re.search(r"max\s*\+?(\d+)", low)
        add({"kind": "perColorInHand", "amount": int(m.group(1)),
             "max": int(mx.group(1)) if mx else None})

    # "+N for each dominant card in your hand"  (BRAVE)
    m = re.search(r"([+-]?\d+)\s+for each dominant card in your hand", low)
    if m:
        add({"kind": "perDominantInHand", "amount": int(m.group(1))})

    # "+N for each card in your hand"  (FORTUNATE, CAMOUFLAGE)
    m = re.search(r"([+-]?\d+)\s+for each card in your hand", low)
    if m:
        add({"kind": "perCardInHand", "amount": int(m.group(1))})

    # APEX PREDATOR (special multi-part)
    if name == "APEX PREDATOR":
        add({"kind": "apexPredator", "flat": 2, "perFewerOpponent": 2})

    # ALTRUISTIC — add your Gene Pool to your score
    if "add your gene pool to your score" in low:
        add({"kind": "addGenePool"})

    # --- Determine "needs review" -------------------------------------------
    # A drop-of-life card (or an At-World's-End card) with scoring-flavored
    # words we didn't turn into an effect gets flagged for a human.
    scoring_words = re.search(r"[+-]\s*\d|gene pool|for each|for every|if you|most common|rarest", low)
    is_scoreish = card["dropOfLife"] or (card["atWorldsEnd"] and choice is None)
    if is_scoreish and scoring_words and not matched and choice is None:
        review = True

    return effects, choice, review


# --------------------------------------------------------------------------
# CSV -> card dicts
# --------------------------------------------------------------------------
def build(csv_path, set_id, set_name):
    rows = list(csv.reader(open(csv_path, encoding="utf-8-sig")))

    traits, ages, catastrophes = [], [], []
    needs_review = []
    section = None

    for row in rows:
        # pad short rows
        row = row + [""] * (12 - len(row))
        first = row[0].strip()
        if not first:
            continue
        up = first.upper()
        if up == "TRAIT CARDS":
            section = "trait"; continue
        if up == "AGES":
            section = "age"; continue
        if up == "NAME":  # header row
            continue
        if first.startswith(",") or up == "":
            continue
        # The catastrophe header row starts with an empty name but has the
        # stage labels; detect the transition when Category == Catastrophe.
        category = row[1].strip().lower()
        if category == "catastrophe":
            section = "catastrophe"

        name = first
        color = norm_color(row[2])
        face_raw = row[3].strip()
        face = int(face_raw) if re.fullmatch(r"-?\d+", face_raw) else None

        base = {
            "name": name,
            "color": color,
            "rarity": row[8].strip(),
            "isDominant": yn(row[7]),
            "isAction": yn(row[5]),
        }

        if section == "age" or category == "age":
            ages.append(dict(base, faceValue=None, effect=row[9].strip()))
            continue

        if section == "catastrophe" or category == "catastrophe":
            catastrophes.append({
                "name": name,
                "color": color,
                "genePoolEffect": row[9].strip(),
                "stage2Effect": row[10].strip(),
                "finalEffect": row[11].strip(),
                "worldsEnd": parse_catastrophe_final(name, row[11].strip()),
            })
            continue

        # --- trait ---
        card = dict(base,
                    faceValue=face if face is not None else 0,
                    atWorldsEnd=yn(row[4]),
                    dropOfLife=yn(row[6]),
                    effect=row[9].strip())
        effects, choice, review = parse_scoring_effects(card)
        card["scoringEffects"] = effects
        if choice:
            card["worldsEndChoice"] = choice
        traits.append(card)
        if review:
            needs_review.append({"name": name, "effect": card["effect"]})

    data = {
        "setId": set_id,
        "setName": set_name,
        "colors": ["blue", "green", "red", "purple", "colorless"],
        "traits": traits,
        "ages": ages,
        "catastrophes": catastrophes,
        "needsReview": needs_review,
    }
    return data


def parse_catastrophe_final(name, final_text):
    """Turn a catastrophe's Final Catastrophe text into a structured World's End
    effect used by the scoring engine."""
    low = final_text.lower()

    # "-N for each <color> trait in your trait pile"  (ICE AGE, RETROVIRUS, SOLAR FLARE, SUPER VOLCANO)
    m = re.search(r"([+-]?\d+)\s+for each\s+" + COLOR_WORDS + r"\s+trait", low)
    if m:
        return {"kind": "perColorTraitPoints", "color": m.group(2),
                "amount": int(m.group(1)), "text": final_text}

    # "-N if you have N or more traits of the same color"  (THE BIG ONE)
    m = re.search(r"([+-]?\d+)\s+if you have\s+(\d+)\s+or more traits of the same color", low)
    if m:
        return {"kind": "flatIfSameColorCount", "amount": int(m.group(1)),
                "threshold": int(m.group(2)), "text": final_text}

    # "+N points to the player(s) with the fewest traits"  (OVERPOPULATION)
    m = re.search(r"([+-]?\d+)\s+points to the player\(s\) with the fewest traits", low)
    if m:
        return {"kind": "pointsToFewestTraits", "amount": int(m.group(1)), "text": final_text}

    # "-N points to the player(s) with the most traits"  (GREY GOO)
    m = re.search(r"([+-]?\d+)\s+points to the player\(s\) with the most traits", low)
    if m:
        return {"kind": "pointsToMostTraits", "amount": int(m.group(1)), "text": final_text}

    # DEUS EX MACHINA — draw a card, add its face value (max +7)
    if "add its face value to your final score" in low:
        return {"kind": "deusExMachina", "max": 7, "text": final_text}

    # "Discard 1 <color> trait from your trait pile"  (GLACIAL MELTDOWN, MEGA TSUNAMI,
    #  PULSE EVENT, MASS EXTINCTION, NUCLEAR WINTER)
    m = re.search(r"discard 1\s+" + COLOR_WORDS + r"\s+trait from your trait pile", low)
    if m:
        return {"kind": "discardColorTrait", "color": m.group(1), "text": final_text}

    # "Discard 1 face value (N) trait or higher"  (THE FOUR HORSEMEN)
    m = re.search(r"discard 1 face value\s*\((\d+)\)\s+trait or higher", low)
    if m:
        return {"kind": "discardHighFaceTrait", "minValue": int(m.group(1)), "text": final_text}

    # AI TAKEOVER — set colorless face values to 2, ignore colorless effects
    if "set the face value of all colorless traits to 2" in low:
        return {"kind": "aiTakeover", "text": final_text}

    return {"kind": "unparsed", "text": final_text}


# --------------------------------------------------------------------------
if __name__ == "__main__":
    here = Path(__file__).resolve().parent
    default_csv = here.parent.parent / ".claude" / "Doomlings" / "doomlings_base_game_cards.csv"

    csv_path = Path(sys.argv[1]) if len(sys.argv) > 1 else default_csv
    set_id = sys.argv[2] if len(sys.argv) > 2 else "base-game"
    set_name = sys.argv[3] if len(sys.argv) > 3 else "Base Game"

    data = build(csv_path, set_id, set_name)

    out_dir = here.parent / "data"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / f"{set_id}.json"
    out_path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"Wrote {out_path}")
    print(f"  traits:       {len(data['traits'])}")
    print(f"  ages:         {len(data['ages'])}")
    print(f"  catastrophes: {len(data['catastrophes'])}")
    print(f"  needs review: {len(data['needsReview'])}")
    for r in data["needsReview"]:
        print(f"      - {r['name']}: {r['effect']}")
    # sanity: report any unparsed catastrophe finals
    for c in data["catastrophes"]:
        if c["worldsEnd"]["kind"] == "unparsed":
            print(f"  [catastrophe unparsed] {c['name']}: {c['finalEffect']}")
