# Doomlings Scorer

A mobile-friendly **Progressive Web App** that calculates final scores for the
card game *Doomlings*. Tap/search to pick each player's traits, walk through
"The End of the World" in the correct rulebook order, and get a per-player
breakdown with a winner. Installs to your iPhone home screen and runs **fully
offline** — no wifi needed at the table.

---

## Run it locally

You need a tiny web server (opening `index.html` directly won't work — browsers
block the app from loading its JSON card files over `file://`).

```bash
cd doomlings-scorer
python -m http.server 8124
```

Then open **http://localhost:8124** in your browser. On a phone, use your
computer's LAN IP (e.g. `http://192.168.1.20:8124`) while both are on the same
network, then **Share → Add to Home Screen** in Safari. After it loads once, it
works offline forever (until you clear the site data).

## Run the tests

Pure scoring logic is unit-tested with plain Node (no framework):

```bash
node tests/scoring.test.js
```

## Rebuild the card data (only if the workbook changes / new expansion)

The source of truth is the Excel workbook `doomlings_base_game_cards.xlsx`
(three sheets: Traits, Ages, Catastrophes). To regenerate `data/base-game.json`:

```bash
python tools/parse_xlsx.py               # uses the base-game workbook by default
# or, for another set:
python tools/parse_xlsx.py my-set.xlsx my-set "My Set"
```

Requires `openpyxl` (`pip install openpyxl`).

---

## What each file does

| File | Role |
|---|---|
| `index.html` | The page shell. Loads the four scripts in order and shows the app. |
| `css/styles.css` | All styling. Mobile-first, dark, Doomlings colors. |
| `tools/parse_xlsx.py` | **Build tool.** Turns the Excel workbook into clean `data/base-game.json`, parsing each trait's text into structured, reusable effect objects. Flags anything it can't confidently parse into a `needsReview` list (currently empty). |
| `doomlings_base_game_cards.xlsx` | The source workbook you edit when a card is wrong. Re-run the build tool after changing it. |
| `data/base-game.json` | The card database the app actually reads. Traits, ages, catastrophes — data only, no logic. |
| `data/sets.json` | Lists which card sets to load. **Add an expansion here** (one line) and the app picks it up with zero code changes. |
| `js/data-loader.js` | Loads every set in `sets.json` and merges them into one card pool. |
| `js/effects.js` | **Scoring vocabulary.** One evaluator per "drop of life" effect type (e.g. `perColorTrait`, `apexPredator`). Cards just reference these by name. |
| `js/scoring.js` | **The engine.** Pure function `scoreGame(setup)`. Resolves World's End in rulebook order (trait choices in turn order → catastrophe → tally) and returns each player's breakdown + winner. |
| `js/app.js` | The UI controller and the guided walkthrough. Gathers input, calls the engine, renders. Saves progress to `localStorage` so a locked phone never loses a game. |
| `tests/scoring.test.js` | 20 checks against hand-computed cases using the real cards. |
| `manifest.webmanifest` | PWA metadata (name, icons, standalone display). |
| `service-worker.js` | Caches everything for offline use. Bump `CACHE_VERSION` when you change app files. |
| `icons/` | App icons for the home screen. |

---

## The scoring order (from the rulebook)

1. **In turn order**, each player resolves their traits' *At World's End* choices
   that change piles — Faith (recolor), Cherished (return a trait), Hyper-
   Intelligence (each opponent discards a color). Order matters: an early
   player's Hyper-Intelligence can remove a trait a later player would score.
2. Apply the **final catastrophe's** World's End effect (forced discards, AI
   Takeover, point swings like Ice Age's −1 per red trait).
3. **Score** = catastrophe points + trait face values + drop-of-life bonuses
   (plus opponent-facing effects like Viral).
4. Highest total wins. On a tie, the rulebook tiebreaker (draw a card, highest
   face value) is offered on the results screen.

## Adding an expansion later

1. `python tools/parse_csv.py my-expansion.csv my-expansion "My Expansion"`
2. Add `{ "id": "my-expansion", "name": "My Expansion", "file": "data/my-expansion.json" }`
   to `data/sets.json`.
3. Bump `CACHE_VERSION` in `service-worker.js` so phones fetch the new file.

If a new card uses a scoring pattern the parser doesn't recognize, it lands in
that set's `needsReview` list instead of being guessed — add a matching pattern
in `parse_csv.py` and an evaluator in `effects.js`.
