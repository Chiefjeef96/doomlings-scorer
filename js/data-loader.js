/*
 * data-loader.js  —  loads card sets at runtime.
 *
 * How expansions work with ZERO app-code changes:
 *   1. Run  tools/parse_csv.py  on the new set's CSV -> data/<id>.json
 *   2. Add one line to data/sets.json listing { id, name, file }.
 *   That's it. This loader merges every listed set into one pool of traits,
 *   ages and catastrophes. The rest of the app never hard-codes a card.
 */
(function (root) {
  "use strict";

  async function loadAllSets() {
    const index = await fetchJSON("data/sets.json");
    const sets = [];
    for (const s of index.sets) {
      try {
        const set = await fetchJSON(s.file);
        sets.push(set);
      } catch (err) {
        console.error("Failed to load set", s.id, err);
      }
    }

    // Merge into one pool. Later sets can add cards; names stay unique per set.
    const traits = [];
    const catastrophes = [];
    const ages = [];
    const needsReview = [];
    for (const set of sets) {
      for (const t of set.traits) traits.push({ ...t, setId: set.setId });
      for (const c of set.catastrophes) catastrophes.push({ ...c, setId: set.setId });
      for (const a of set.ages || []) ages.push({ ...a, setId: set.setId });
      for (const r of set.needsReview || []) needsReview.push({ ...r, setId: set.setId });
    }

    traits.sort((a, b) => a.name.localeCompare(b.name));
    catastrophes.sort((a, b) => a.name.localeCompare(b.name));

    return {
      sets: index.sets,
      traits,
      catastrophes,
      ages,
      needsReview,
      traitByName: Object.fromEntries(traits.map((t) => [t.name, t])),
      cataByName: Object.fromEntries(catastrophes.map((c) => [c.name, c])),
    };
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res.json();
  }

  root.DoomlingsData = { loadAllSets };
})(window);
