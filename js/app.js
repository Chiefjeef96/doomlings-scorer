/*
 * app.js  —  UI controller + the "End of the World" walkthrough.
 *
 * Four screens driven by one state object G:
 *   setup    -> players, turn order, hand counts
 *   piles    -> tap/search to fill each player's trait pile
 *   worldsend-> pick final catastrophe, resolve At-World's-End choices IN ORDER
 *   results  -> per-player breakdown + winner (+ tiebreaker)
 *
 * Scoring itself lives in scoring.js/effects.js (pure, unit-tested). This file
 * only gathers input and renders. State is saved to localStorage so a refresh
 * (or the phone locking mid-game) never loses progress.
 */
(function () {
  "use strict";

  const COLORS = ["blue", "green", "red", "purple", "colorless"];
  const LS_KEY = "doomlings-scorer-state-v1";
  let DB = null; // loaded card database

  // ---- state ----
  const blankPlayer = (i) => ({
    id: "p" + i, name: "Player " + (i + 1), order: i,
    handCount: 0, handColors: 0, handDominants: 0, genePool: 5,
    pile: [], // array of card names
  });

  let G = load() || {
    screen: "setup",
    playerCount: 4,
    players: [0, 1, 2, 3].map(blankPlayer),
    activePlayer: 0,
    catastropheName: "",
    choices: {},
    result: null,
  };

  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(G)); } catch (e) {} }
  function load() { try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch (e) { return null; } }

  // ---- boot ----
  window.addEventListener("DOMContentLoaded", async () => {
    try {
      DB = await window.DoomlingsData.loadAllSets();
    } catch (e) {
      document.getElementById("app").innerHTML =
        `<div class="note">Could not load card data. If you opened the file directly,
         run a local server instead (see README).</div>`;
      return;
    }
    render();
    registerSW();
  });

  const $ = (sel, el = document) => el.querySelector(sel);

  // ---- helpers over the card DB ----
  const cardOf = (name) => DB.traitByName[name];
  const colorClass = (c) => "c-" + (c || "colorless");
  const txtClass = (c) => "txt-" + (c || "colorless");

  function playersInOrder() {
    return [...G.players].sort((a, b) => a.order - b.order);
  }

  // Which hand-composition fields does a player need, based on their pile?
  function handNeeds(p) {
    const kinds = new Set();
    for (const n of p.pile) for (const e of (cardOf(n).scoringEffects || [])) kinds.add(e.kind);
    return {
      colors: kinds.has("perColorInHand"),        // Saudade
      dominants: kinds.has("perDominantInHand"),   // Brave
      genePool: kinds.has("addGenePool"),          // Altruistic
    };
  }

  // ============================================================ RENDER ====
  function render() {
    save();
    const app = document.getElementById("app");
    app.innerHTML =
      screenHeader() +
      `<section class="screen active">${SCREENS[G.screen]()}</section>`;
    renderNav();
    bind();
  }

  const STEP_ORDER = ["setup", "piles", "worldsend", "results"];
  function screenHeader() {
    const idx = STEP_ORDER.indexOf(G.screen);
    const dots = STEP_ORDER.map((s, i) =>
      `<div class="dot ${i === idx ? "active" : i < idx ? "done" : ""}"></div>`).join("");
    return `<div class="steps">${dots}</div>`;
  }

  const SCREENS = {
    setup: renderSetup,
    piles: renderPiles,
    worldsend: renderWorldsEnd,
    results: renderResults,
  };

  // ---- Screen 1: setup ---------------------------------------------------
  function renderSetup() {
    const pc = G.playerCount;
    return `
      <h2 class="screen-title">Players</h2>
      <p class="hint">Pick how many are playing, then set names and the seating /
        turn order. Turn order matters — World's End effects resolve in this order.</p>

      <div class="card">
        <label>Number of players</label>
        <div class="counter">
          <button class="btn" data-act="pc-" ${pc <= 2 ? "disabled" : ""}>−</button>
          <div class="val">${pc}</div>
          <button class="btn" data-act="pc+" ${pc >= 6 ? "disabled" : ""}>+</button>
        </div>
      </div>

      <div class="card">
        <h3>Turn order &amp; names</h3>
        <p class="hint" style="margin:0 0 8px">Use ↑ / ↓ to set who goes first.</p>
        ${playersInOrder().map((p, i) => `
          <div class="row tight" data-pid="${p.id}" style="margin-bottom:8px">
            <div style="flex:0 0 26px" class="muted center">${i + 1}</div>
            <input data-act="name" data-pid="${p.id}" value="${escapeAttr(p.name)}" />
            <button class="btn small" data-act="up" data-pid="${p.id}" ${i === 0 ? "disabled" : ""}>↑</button>
            <button class="btn small" data-act="down" data-pid="${p.id}" ${i === pc - 1 ? "disabled" : ""}>↓</button>
          </div>`).join("")}
      </div>

      <div class="card">
        <h3>Cards in hand</h3>
        <p class="hint" style="margin:0 0 8px">Total cards each player is holding at the end.
          Some traits score off your hand.</p>
        ${playersInOrder().map((p) => `
          <div class="row" style="margin-bottom:8px">
            <div>${escapeHTML(p.name)}</div>
            <div class="counter" style="flex:0 0 auto">
              <button class="btn small" data-act="hand-" data-pid="${p.id}">−</button>
              <div class="val" style="min-width:30px">${p.handCount}</div>
              <button class="btn small" data-act="hand+" data-pid="${p.id}">+</button>
            </div>
          </div>`).join("")}
      </div>`;
  }

  // ---- Screen 2: piles ---------------------------------------------------
  function renderPiles() {
    const p = playersInOrder()[G.activePlayer] || playersInOrder()[0];
    const q = (G._search || "").toLowerCase();
    const results = q.length
      ? DB.traits.filter((t) =>
          t.name.toLowerCase().includes(q) && !p.pile.includes(t.name)).slice(0, 40)
      : [];
    const needs = handNeeds(p);

    return `
      <h2 class="screen-title">Trait piles</h2>
      <p class="hint">Add every trait in each player's pile. Tap a player, search, tap to add.</p>

      <div class="tabs">
        ${playersInOrder().map((pl, i) => `
          <div class="tab ${i === G.activePlayer ? "active" : ""}" data-act="tab" data-i="${i}">
            ${escapeHTML(pl.name)} <span class="muted">(${pl.pile.length})</span>
          </div>`).join("")}
      </div>

      <div class="card">
        <div class="search-wrap">
          <input id="search" placeholder="Search a trait…  e.g. Egg Clusters" value="${escapeAttr(G._search || "")}" autocomplete="off" />
          ${q.length ? `<div class="results">
            ${results.length ? results.map((t) => `
              <div class="item" data-act="add" data-name="${escapeAttr(t.name)}">
                <span><span class="dot-c ${colorClass(t.color)}"></span>${escapeHTML(t.name)}
                  ${t.atWorldsEnd ? '<span class="badge">WE</span>' : ""}</span>
                <span class="meta">${fmtFace(t.faceValue)} · ${escapeHTML(t.rarity)}</span>
              </div>`).join("") : `<div class="empty">No match.</div>`}
          </div>` : ""}
        </div>

        <div class="chips">
          ${p.pile.length ? p.pile.map((n) => {
            const c = cardOf(n);
            return `<span class="chip ${c.atWorldsEnd ? "wends" : ""}">
              <span class="dot-c ${colorClass(c.color)}"></span>${escapeHTML(n)}
              <span class="fv">${fmtFace(c.faceValue)}</span>
              <span class="x" data-act="rm" data-name="${escapeAttr(n)}">✕</span></span>`;
          }).join("") : `<span class="muted">No traits yet.</span>`}
        </div>
      </div>

      ${(needs.colors || needs.dominants || needs.genePool) ? `
      <div class="card">
        <h3>${escapeHTML(p.name)} — extra info needed</h3>
        <p class="hint" style="margin:0 0 8px">A trait in this pile scores off these.</p>
        ${needs.colors ? counterRow("Distinct colors in hand (Saudade)", "hc", p.handColors, 0, 5) : ""}
        ${needs.dominants ? counterRow("Dominant cards in hand (Brave)", "hd", p.handDominants, 0, 12) : ""}
        ${needs.genePool ? counterRow("Gene Pool (Altruistic adds it)", "gp", p.genePool, 0, 20) : ""}
      </div>` : ""}`;
  }

  function counterRow(label, act, val, min, max) {
    return `<div class="row" style="margin-bottom:6px">
      <div>${label}</div>
      <div class="counter" style="flex:0 0 auto">
        <button class="btn small" data-act="${act}-" ${val <= min ? "disabled" : ""}>−</button>
        <div class="val" style="min-width:30px">${val}</div>
        <button class="btn small" data-act="${act}+" ${val >= max ? "disabled" : ""}>+</button>
      </div></div>`;
  }

  // ---- Screen 3: World's End walkthrough --------------------------------
  function renderWorldsEnd() {
    const order = playersInOrder();
    const cata = G.catastropheName ? DB.cataByName[G.catastropheName] : null;
    const preppers = order.filter((p) => p.pile.includes("PREPPER"));

    return `
      <h2 class="screen-title">The End of the World</h2>
      <p class="hint">Resolve in turn order: trait effects first, then the final catastrophe.</p>

      <div class="card">
        <h3>1 · Final catastrophe</h3>
        <p class="hint" style="margin:0 0 6px">Its World's End effect applies to everyone.</p>
        <select data-act="cata">
          <option value="">— choose the catastrophe you ended on —</option>
          ${DB.catastrophes.map((c) => `
            <option value="${escapeAttr(c.name)}" ${c.name === G.catastropheName ? "selected" : ""}>
              ${escapeHTML(c.name)}</option>`).join("")}
        </select>
        ${cata ? `<div class="note" style="margin-top:10px"><b>${escapeHTML(cata.name)}</b> —
          ${escapeHTML(cata.finalEffect)}</div>` : ""}
        ${preppers.length ? `<div class="note">🧰 ${preppers.map((p) => escapeHTML(p.name)).join(", ")}
          hold <b>Prepper</b> — that player chooses which catastrophe everyone ends on. Set it above.</div>` : ""}
      </div>

      ${cata ? `
      <div class="card">
        <h3>2 · Player choices, in turn order</h3>
        ${order.map((p, i) => renderPlayerChoices(p, i, order, cata)).join("")}
      </div>` : ""}

      ${cata ? `<button class="btn primary" style="width:100%" data-act="calc">Calculate final scores →</button>` : ""}`;
  }

  function renderPlayerChoices(p, idx, order, cata) {
    const pile = p.pile.map(cardOf);
    const bits = [];

    // Faith — recolor a color group
    if (p.pile.includes("FAITH")) {
      const f = getChoice("faith", p.id) || {};
      const present = [...new Set(pile.map((c) => c.color))];
      bits.push(`
        <label>Faith — change one color…</label>
        <div class="row tight">
          <select data-act="faith-from" data-pid="${p.id}">
            <option value="">from…</option>
            ${present.map((c) => `<option value="${c}" ${f.from === c ? "selected" : ""}>${c}</option>`).join("")}
          </select>
          <select data-act="faith-to" data-pid="${p.id}">
            <option value="">to…</option>
            ${COLORS.map((c) => `<option value="${c}" ${f.to === c ? "selected" : ""}>${c}</option>`).join("")}
          </select>
        </div>`);
    }

    // Cherished — return a trait to hand (removes it from pile/score)
    if (p.pile.includes("CHERISHED")) {
      const cur = getChoice("cherished", p.id) || "";
      bits.push(`
        <label>Cherished — return a trait to hand (optional)</label>
        <select data-act="cherished" data-pid="${p.id}">
          <option value="">— keep everything —</option>
          ${p.pile.filter((n) => n !== "CHERISHED").map((n) =>
            `<option value="${escapeAttr(n)}" ${cur === n ? "selected" : ""}>${escapeHTML(n)} (${fmtFace(cardOf(n).faceValue)})</option>`).join("")}
        </select>`);
    }

    // Hyper-Intelligence — each opponent discards a chosen color
    if (p.pile.includes("HYPER-INTELLIGENCE")) {
      const list = getChoice("hyperIntelligence", p.id) || [];
      const opps = order.filter((o) => o.id !== p.id);
      bits.push(`<label>Hyper-Intelligence — pick a color each opponent discards</label>` +
        opps.map((o) => {
          const entry = list.find((x) => x.opponentId === o.id) || {};
          const matching = entry.color ? o.pile.filter((n) => cardOf(n).color === entry.color) : [];
          return `<div class="row tight" style="margin-bottom:6px">
            <div style="flex:0 0 32%">${escapeHTML(o.name)}</div>
            <select data-act="hi-color" data-pid="${p.id}" data-opp="${o.id}">
              <option value="">color…</option>
              ${COLORS.map((c) => `<option value="${c}" ${entry.color === c ? "selected" : ""}>${c}</option>`).join("")}
            </select>
            <select data-act="hi-trait" data-pid="${p.id}" data-opp="${o.id}" ${matching.length ? "" : "disabled"}>
              ${matching.length ? matching.map((n) =>
                `<option value="${escapeAttr(n)}" ${entry.discardTraitName === n ? "selected" : ""}>${escapeHTML(n)}</option>`).join("")
                : `<option>no ${entry.color || ""} trait</option>`}
            </select>
          </div>`;
        }).join(""));
    }

    // Boredom — colorless cards in hand after drawing 2
    if (p.pile.includes("BOREDOM")) {
      const v = (G.choices.boredom && G.choices.boredom[p.id]) || 0;
      bits.push(`
        <label>Boredom — draw 2, then how many <b>colorless</b> cards in hand?</label>
        <div class="counter">
          <button class="btn small" data-act="bore-" data-pid="${p.id}">−</button>
          <div class="val" style="min-width:30px">${v}</div>
          <button class="btn small" data-act="bore+" data-pid="${p.id}">+</button>
        </div>`);
    }

    // Deus Ex Machina (catastrophe): each player draws, adds face value (max 7)
    if (cata.worldsEnd.kind === "deusExMachina") {
      const v = (G.choices.deusExMachina && G.choices.deusExMachina[p.id]) || 0;
      bits.push(`
        <label>Deus Ex Machina — face value of your drawn card (max +7)</label>
        <div class="counter">
          <button class="btn small" data-act="deus-" data-pid="${p.id}">−</button>
          <div class="val" style="min-width:30px">${v}</div>
          <button class="btn small" data-act="deus+" data-pid="${p.id}">+</button>
        </div>`);
    }

    // Forced catastrophe discard — let the player pick which trait
    if (cata.worldsEnd.kind === "discardColorTrait" || cata.worldsEnd.kind === "discardHighFaceTrait") {
      const matching = p.pile.filter((n) => {
        const c = cardOf(n);
        return cata.worldsEnd.kind === "discardColorTrait"
          ? c.color === cata.worldsEnd.color
          : (c.faceValue || 0) >= cata.worldsEnd.minValue;
      });
      if (matching.length) {
        const cur = (G.choices.catastropheDiscard && G.choices.catastropheDiscard[p.id]) || matching[0];
        bits.push(`
          <label>${escapeHTML(cata.name)} — which trait to discard?</label>
          <select data-act="cdiscard" data-pid="${p.id}">
            ${matching.map((n) => `<option value="${escapeAttr(n)}" ${cur === n ? "selected" : ""}>
              ${escapeHTML(n)} (${fmtFace(cardOf(n).faceValue)})</option>`).join("")}
          </select>`);
      }
    }

    // Other At-World's-End cards we don't auto-resolve → manual note
    const known = ["FAITH", "CHERISHED", "HYPER-INTELLIGENCE", "BOREDOM", "PREPPER"];
    const manual = pile.filter((c) => c.atWorldsEnd && !known.includes(c.name));
    for (const c of manual) {
      bits.push(`<div class="note">↪ <b>${escapeHTML(c.name)}</b>: ${escapeHTML(c.effect)}
        Resolve at the table, then adjust this pile if it changes.</div>`);
    }

    if (!bits.length) bits.push(`<span class="muted">No World's End choices.</span>`);

    return `<div style="padding:10px 0; border-top:1px solid var(--line)">
      <div style="font-weight:700; margin-bottom:6px">${idx + 1}. ${escapeHTML(p.name)}</div>
      ${bits.join("")}
    </div>`;
  }

  // ---- Screen 4: results -------------------------------------------------
  function renderResults() {
    const res = G.result;
    if (!res) return `<p class="hint">No result yet.</p>`;
    const ranked = [...res.players].sort((a, b) => b.total - a.total);

    return `
      <h2 class="screen-title">Final scores</h2>
      <p class="hint">Ended on <b>${escapeHTML(res.catastrophe || "—")}</b>.</p>

      ${res.needsTieBreak ? `
        <div class="note">⚖️ Tie for the lead. Rulebook tiebreak: each tied player draws a
          card — highest face value wins. Enter the drawn values:
          ${res.winnerIds.map((id) => {
            const pl = res.players.find((p) => p.id === id);
            const v = (G.choices.tieBreak && G.choices.tieBreak[id]) || 0;
            return `<div class="row" style="margin-top:6px">
              <div>${escapeHTML(pl.name)}</div>
              <div class="counter" style="flex:0 0 auto">
                <button class="btn small" data-act="tie-" data-pid="${id}">−</button>
                <div class="val" style="min-width:30px">${v}</div>
                <button class="btn small" data-act="tie+" data-pid="${id}">+</button>
              </div></div>`;
          }).join("")}
          <button class="btn small primary" data-act="recalc" style="margin-top:8px">Resolve tie</button>
        </div>` : ""}

      ${ranked.map((r) => {
        const win = res.winnerIds.includes(r.id) && !res.needsTieBreak;
        return `<div class="card result-card ${win ? "winner" : ""}">
          <div class="row" style="align-items:center">
            <div>
              <div style="font-weight:700">${escapeHTML(r.name)} ${win ? '<span class="crown">👑 Winner</span>' : ""}</div>
              <div class="muted" style="font-size:12px">${r.pileAfter.length} trait(s) after resolution</div>
            </div>
            <div class="score-big" style="flex:0 0 auto">${r.total}</div>
          </div>
          <div class="breakdown">
            ${bLine("World's End", r.worldsEndPoints)}
            ${bLine("Face value", r.faceValue)}
            ${bLine("Drop-of-life bonuses", r.bonuses)}
            ${r.bonusBreakdown.map((b) => `<div class="line muted" style="font-size:12px">
              <span>· ${escapeHTML(b.source)}</span><span class="amt">${fmtFace(b.amount)}</span></div>`).join("")}
            ${r.worldsEndBreakdown.map((b) => `<div class="line muted" style="font-size:12px">
              <span>· ${escapeHTML(b.source)}</span><span class="amt">${fmtFace(b.amount)}</span></div>`).join("")}
          </div>
        </div>`;
      }).join("")}

      ${res.log && res.log.length ? `<div class="card"><h3>Resolution log</h3>
        <div class="log">${res.log.map((l) => `<div>${escapeHTML(l)}</div>`).join("")}</div></div>` : ""}`;
  }

  function bLine(label, amt) {
    return `<div class="line"><span>${label}</span>
      <span class="amt ${amt > 0 ? "pos" : amt < 0 ? "neg" : ""}">${fmtFace(amt)}</span></div>`;
  }

  // ---- bottom nav --------------------------------------------------------
  function renderNav() {
    let old = $(".navbar"); if (old) old.remove();
    const idx = STEP_ORDER.indexOf(G.screen);
    const backLabel = idx === 0 ? "Reset" : "← Back";
    const nextLabel = { setup: "Next: piles →", piles: "Next: World's End →", worldsend: "", results: "New game" }[G.screen];
    const nav = document.createElement("div");
    nav.className = "navbar";
    nav.innerHTML = `<div class="app-inner">
      <button class="btn ghost" data-act="back">${backLabel}</button>
      ${nextLabel ? `<button class="btn primary" data-act="next">${nextLabel}</button>` : ""}
    </div>`;
    document.body.appendChild(nav);
  }

  // ============================================================ EVENTS ====
  function bind() {
    const app = document.getElementById("app");
    app.onclick = onClick;
    app.oninput = onInput;
    const nav = $(".navbar"); if (nav) nav.onclick = onClick;

    const search = $("#search");
    if (search) {
      search.oninput = (e) => { G._search = e.target.value; softRerender(); };
      // keep focus after re-render
      if (G._focusSearch) { search.focus(); search.selectionStart = search.value.length; G._focusSearch = false; }
    }
  }

  // Re-render just the piles screen while typing (keeps keyboard up).
  function softRerender() { G._focusSearch = true; render(); }

  function onInput(e) {
    const act = e.target.dataset.act, pid = e.target.dataset.pid;
    if (act === "name") { player(pid).name = e.target.value; save(); }
  }

  function onClick(e) {
    const t = e.target.closest("[data-act]");
    if (!t) return;
    const act = t.dataset.act, pid = t.dataset.pid;

    switch (act) {
      // nav
      case "back": return goBack();
      case "next": return goNext();

      // setup
      case "pc+": return setPlayerCount(G.playerCount + 1);
      case "pc-": return setPlayerCount(G.playerCount - 1);
      case "up": return move(pid, -1);
      case "down": return move(pid, +1);
      case "hand+": player(pid).handCount++; return render();
      case "hand-": player(pid).handCount = Math.max(0, player(pid).handCount - 1); return render();

      // piles
      case "tab": G.activePlayer = +t.dataset.i; G._search = ""; return render();
      case "add": addTrait(t.dataset.name); return;
      case "rm": removeTrait(t.dataset.name); return render();
      case "hc+": curPile().handColors++; return render();
      case "hc-": { const p = curPile(); p.handColors = Math.max(0, p.handColors - 1); return render(); }
      case "hd+": curPile().handDominants++; return render();
      case "hd-": { const p = curPile(); p.handDominants = Math.max(0, p.handDominants - 1); return render(); }
      case "gp+": curPile().genePool++; return render();
      case "gp-": { const p = curPile(); p.genePool = Math.max(0, p.genePool - 1); return render(); }

      // walkthrough counters
      case "bore+": return bumpChoiceMap("boredom", pid, +1);
      case "bore-": return bumpChoiceMap("boredom", pid, -1);
      case "deus+": return bumpChoiceMap("deusExMachina", pid, +1, 7);
      case "deus-": return bumpChoiceMap("deusExMachina", pid, -1, 7);
      case "tie+": return bumpChoiceMap("tieBreak", pid, +1);
      case "tie-": return bumpChoiceMap("tieBreak", pid, -1);
      case "calc": return calculate();
      case "recalc": return calculate();
    }
  }

  function onChangeDelegate(e) {} // (selects handled via change listener below)

  // Select changes (bind once via event delegation on change)
  document.addEventListener("change", (e) => {
    const t = e.target.closest("[data-act]"); if (!t) return;
    const act = t.dataset.act, pid = t.dataset.pid, v = t.value;
    switch (act) {
      case "cata": G.catastropheName = v; G.choices = {}; return render();
      case "faith-from": setChoice("faith", pid, { ...(getChoice("faith", pid) || {}), from: v }); return render();
      case "faith-to": setChoice("faith", pid, { ...(getChoice("faith", pid) || {}), to: v }); return render();
      case "cherished": setChoice("cherished", pid, v || null); return;
      case "cdiscard": setChoice("catastropheDiscard", pid, v); return;
      case "hi-color": return setHI(pid, t.dataset.opp, { color: v, discardTraitName: null });
      case "hi-trait": return setHI(pid, t.dataset.opp, { discardTraitName: v });
    }
  });

  // ---- state ops ----
  function player(id) { return G.players.find((p) => p.id === id); }
  function curPile() { return playersInOrder()[G.activePlayer]; }

  function setPlayerCount(n) {
    n = Math.max(2, Math.min(6, n));
    if (n > G.players.length) {
      for (let i = G.players.length; i < n; i++) G.players.push(blankPlayer(i));
    } else {
      G.players = G.players.slice(0, n);
    }
    // re-normalize order
    playersInOrder().forEach((p, i) => (p.order = i));
    G.playerCount = n;
    render();
  }

  function move(pid, dir) {
    const ord = playersInOrder();
    const i = ord.findIndex((p) => p.id === pid);
    const j = i + dir;
    if (j < 0 || j >= ord.length) return;
    [ord[i].order, ord[j].order] = [ord[j].order, ord[i].order];
    render();
  }

  function addTrait(name) {
    const p = curPile();
    if (!p.pile.includes(name)) p.pile.push(name);
    G._search = ""; render();
  }
  function removeTrait(name) {
    const p = curPile();
    p.pile = p.pile.filter((n) => n !== name);
  }

  // choices helpers
  function getChoice(kind, pid) { return G.choices[kind] && G.choices[kind][pid]; }
  function setChoice(kind, pid, val) {
    G.choices[kind] = G.choices[kind] || {};
    if (val == null) delete G.choices[kind][pid]; else G.choices[kind][pid] = val;
    save();
  }
  function bumpChoiceMap(kind, pid, dir, max) {
    G.choices[kind] = G.choices[kind] || {};
    let v = (G.choices[kind][pid] || 0) + dir;
    v = Math.max(0, v); if (max != null) v = Math.min(max, v);
    G.choices[kind][pid] = v; render();
  }
  function setHI(pid, oppId, patch) {
    G.choices.hyperIntelligence = G.choices.hyperIntelligence || {};
    const list = G.choices.hyperIntelligence[pid] = G.choices.hyperIntelligence[pid] || [];
    let entry = list.find((x) => x.opponentId === oppId);
    if (!entry) { entry = { opponentId: oppId }; list.push(entry); }
    Object.assign(entry, patch);
    // default the discarded trait to the first matching if color set but no pick
    if (entry.color && !entry.discardTraitName) {
      const opp = player(oppId);
      const m = opp.pile.find((n) => cardOf(n).color === entry.color);
      entry.discardTraitName = m || null;
    }
    render();
  }

  // ---- navigation ----
  function goNext() {
    if (G.screen === "setup") { G.screen = "piles"; G.activePlayer = 0; }
    else if (G.screen === "piles") { G.screen = "worldsend"; }
    else if (G.screen === "results") { return newGame(); }
    window.scrollTo(0, 0); render();
  }
  function goBack() {
    if (G.screen === "setup") return newGame();
    if (G.screen === "piles") G.screen = "setup";
    else if (G.screen === "worldsend") G.screen = "piles";
    else if (G.screen === "results") G.screen = "worldsend";
    window.scrollTo(0, 0); render();
  }
  function newGame() {
    if (!confirm("Start a new game? This clears players and piles.")) return;
    localStorage.removeItem(LS_KEY);
    G = { screen: "setup", playerCount: 4, players: [0, 1, 2, 3].map(blankPlayer),
          activePlayer: 0, catastropheName: "", choices: {}, result: null };
    render();
  }

  // ---- compute ----
  function calculate() {
    const setup = {
      players: playersInOrder().map((p) => ({
        id: p.id, name: p.name, order: p.order,
        pile: p.pile.map((n) => JSON.parse(JSON.stringify(cardOf(n)))),
        handCount: p.handCount, handColors: p.handColors,
        handDominants: p.handDominants, genePool: p.genePool,
      })),
      catastrophe: DB.cataByName[G.catastropheName],
      choices: G.choices,
    };
    G.result = window.DoomlingsScoring.scoreGame(setup);
    G.screen = "results";
    window.scrollTo(0, 0); render();
  }

  // ---- utils ----
  function fmtFace(v) { if (v == null) return "★"; return v > 0 ? "+" + v : "" + v; }
  function escapeHTML(s) { return String(s).replace(/[&<>]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[m])); }
  function escapeAttr(s) { return String(s).replace(/"/g, "&quot;").replace(/</g, "&lt;"); }

  // ---- service worker ----
  function registerSW() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("service-worker.js").catch(() => {});
    }
  }
})();
