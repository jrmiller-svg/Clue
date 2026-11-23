'use strict';
// Verifies the exact solver against an independent brute-force enumeration of
// every possible deal on small decks, plus sanity / performance checks on the
// real Clue deck sizes.
const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/engine.js');

// ------------------------------------------------------------ helpers
function rngFrom(seed) { return E._makeRng(seed); }
function shuffle(a, r) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

function makeCats(sizes) {
  return sizes.map((n, ci) => ({ name: 'C' + ci, cards: Array.from({ length: n }, (_, j) => 'c' + ci + '_' + j) }));
}

// Deal a random true game: returns { game (without events), owner[] }
function randomGame(sizes, nPlayers, r, opts = {}) {
  const categories = makeCats(sizes);
  const ix = E.cardIndex({ categories });
  const N = ix.N, ENV = nPlayers;
  const owner = new Array(N).fill(-1);
  ix.catCards.forEach((list) => { owner[list[Math.floor(r() * list.length)]] = ENV; });
  let rest = shuffle([...Array(N).keys()].filter((c) => owner[c] !== ENV), r);
  const faceUpN = opts.faceUp ? (rest.length % nPlayers) : 0;
  const faceUp = rest.slice(0, faceUpN);
  faceUp.forEach((c) => { owner[c] = -2; });
  rest = rest.slice(faceUpN);
  const hands = Array.from({ length: nPlayers }, () => 0);
  const start = Math.floor(r() * nPlayers);
  rest.forEach((c, i) => { const p = (start + i) % nPlayers; owner[c] = p; hands[p]++; });
  const me = Math.floor(r() * nPlayers);
  const players = hands.map((h, p) => ({ name: 'P' + p, hand: h }));
  const myCards = [...Array(N).keys()].filter((c) => owner[c] === me);
  return { game: { categories, players, me, myCards, faceUp, events: [] }, owner, ix };
}

// Generate a random but truthful log of suggestions/accusations/facts.
function randomEvents(G, nEvents, r) {
  const { game, owner, ix } = G;
  const P = game.players.length, ENV = P;
  const events = [];
  for (let t = 0; t < nEvents; t++) {
    const roll = r();
    if (roll < 0.08) {
      // wrong accusation by someone
      const cards = ix.catCards.map((l) => l[Math.floor(r() * l.length)]);
      const correct = cards.every((c) => owner[c] === ENV);
      if (!correct) events.push({ type: 'accuse', accuser: Math.floor(r() * P), cards, correct: false });
      continue;
    }
    if (roll < 0.12) {
      const c = Math.floor(r() * ix.N);
      if (owner[c] === -2) continue;
      const o = Math.floor(r() * (P + 1));
      events.push({ type: 'fact', owner: o, card: c, has: owner[c] === o });
      continue;
    }
    const suggester = Math.floor(r() * P);
    const cards = ix.catCards.map((l) => l[Math.floor(r() * l.length)]);
    const passers = [];
    let refuter = -1, shown = -1;
    for (let i = 1; i < P; i++) {
      const q = (suggester + i) % P;
      const held = cards.filter((c) => owner[c] === q);
      if (held.length) {
        refuter = q;
        if (suggester === game.me || q === game.me) shown = held[Math.floor(r() * held.length)];
        // sometimes the user forgets to note the card
        if (suggester === game.me && r() < 0.1) shown = -1;
        if (q === game.me && r() < 0.5) shown = -1;
        break;
      }
      passers.push(q);
    }
    events.push({ type: 'suggest', suggester, cards, refuter, shown, passers });
  }
  return events;
}

// Independent brute force: enumerate every deal and test every constraint.
function bruteForce(game) {
  const ix = E.cardIndex(game);
  const N = ix.N, P = game.players.length, ENV = P;
  const pub = new Set(game.faceUp || []);
  const mine = new Set(game.myCards || []);
  const owner = new Array(N).fill(-1);
  for (const c of pub) owner[c] = -2;
  const counts = Array.from({ length: P + 1 }, () => new Float64Array(N));
  const triples = new Map();
  let total = 0;
  function consistent() {
    for (const ev of game.events) {
      if (ev.type === 'suggest') {
        for (const p of ev.passers || []) if (ev.cards.some((c) => owner[c] === p)) return false;
        if (ev.refuter >= 0) {
          if (!ev.cards.some((c) => owner[c] === ev.refuter)) return false;
          if (ev.shown >= 0 && owner[ev.shown] !== ev.refuter) return false;
        }
      } else if (ev.type === 'accuse') {
        const isEnv = ev.cards.every((c) => owner[c] === ENV);
        if (ev.correct !== isEnv) return false;
      } else if (ev.type === 'fact') {
        if ((owner[ev.card] === ev.owner) !== ev.has) return false;
      }
    }
    return true;
  }
  const envCombos = [[]];
  for (const list of ix.catCards) {
    const nx = [];
    for (const pre of envCombos) for (const c of list) nx.push(pre.concat([c]));
    envCombos.length = 0; envCombos.push(...nx);
  }
  for (const env of envCombos) {
    if (env.some((c) => pub.has(c) || mine.has(c))) continue;
    env.forEach((c) => { owner[c] = ENV; });
    for (const c of mine) owner[c] = game.me;
    const free = [];
    for (let c = 0; c < N; c++) if (owner[c] === -1) free.push(c);
    const capLeft = game.players.map((p, i) => (i === game.me ? 0 : p.hand));
    (function rec(i) {
      if (i === free.length) {
        if (capLeft.every((x) => x === 0) && consistent()) {
          total++;
          for (let c = 0; c < N; c++) if (owner[c] >= 0) counts[owner[c]][c]++;
          const key = env.join(',');
          triples.set(key, (triples.get(key) || 0) + 1);
        }
        return;
      }
      for (let p = 0; p < P; p++) {
        if (capLeft[p] === 0) continue;
        capLeft[p]--; owner[free[i]] = p;
        rec(i + 1);
        capLeft[p]++; owner[free[i]] = -1;
      }
    })(0);
    for (let c = 0; c < N; c++) if (owner[c] === ENV || owner[c] === game.me) owner[c] = -1;
  }
  return { total, counts, triples };
}

function close(a, b, tol = 1e-9) { return Math.abs(a - b) <= tol; }

// ------------------------------------------------------------- tests
test('exact solver matches brute force on random small games', () => {
  const r = rngFrom(12345);
  const configs = [
    { sizes: [3, 3, 3], P: 3 }, { sizes: [3, 3, 4], P: 3 }, { sizes: [2, 3, 4], P: 3 },
    { sizes: [3, 3, 4], P: 4 }, { sizes: [4, 4, 4], P: 3 }, { sizes: [3, 4, 4], P: 4, faceUp: true },
    { sizes: [3, 3, 3], P: 2 }, { sizes: [3, 3, 5], P: 5 },
    { sizes: [4, 4, 5], P: 4 }, { sizes: [3, 4, 5], P: 5 }, { sizes: [4, 4, 4], P: 6 },
  ];
  let checked = 0, contradictions = 0;
  for (const cfg of configs) {
    for (let trial = 0; trial < 25; trial++) {
      const G = randomGame(cfg.sizes, cfg.P, r, { faceUp: cfg.faceUp });
      G.game.events = randomEvents(G, Math.floor(r() * 12), r);
      const bf = bruteForce(G.game);
      const res = E.analyze(G.game, { samples: 0, topTriples: 1e9 });
      assert.ok(bf.total > 0, 'truthful log must be consistent');
      assert.strictEqual(res.ok, true, 'solver reported contradiction on a truthful log');
      assert.strictEqual(res.method, 'exact');
      assert.strictEqual(res.deals, bf.total, 'deal count');
      const N = res.N, P = res.P;
      for (let o = 0; o <= P; o++) for (let c = 0; c < N; c++) {
        if (G.game.faceUp.includes(c)) continue;
        const want = bf.counts[o][c] / bf.total;
        assert.ok(close(res.prob[o * N + c], want), `prob owner ${o} card ${c}: ${res.prob[o * N + c]} vs ${want}`);
        // certainty flags must agree with brute force
        if (res.known[o * N + c] === E.YES) assert.ok(close(want, 1));
        if (res.known[o * N + c] === E.NO) assert.ok(close(want, 0));
        if (close(want, 0)) assert.strictEqual(res.known[o * N + c], E.NO);
        if (close(want, 1)) assert.strictEqual(res.known[o * N + c], E.YES);
      }
      assert.strictEqual(res.nSolutions, bf.triples.size);
      for (const t of res.triples) {
        const want = (bf.triples.get(t.cards.join(',')) || 0) / bf.total;
        assert.ok(close(t.p, want), 'triple prob');
      }
      checked++;
    }
  }
  assert.ok(checked >= 250, 'ran enough trials: ' + checked + ' contradictions ' + contradictions);
});

test('detects contradictions and pinpoints the offending event', () => {
  const r = rngFrom(99);
  const G = randomGame([3, 3, 4], 3, r);
  G.game.events = randomEvents(G, 6, r);
  const before = G.game.events.length;
  // Find a card held by a non-me player and log that the player passed on it.
  const victim = G.owner.findIndex((o) => o >= 0 && o < 3 && o !== G.game.me);
  const ix = G.ix;
  const cards = ix.catCards.map((l) => l[0]);
  cards[ix.cardCat[victim]] = victim;
  G.game.events.push({ type: 'suggest', suggester: G.game.me, cards, refuter: -1, shown: -1, passers: [0, 1, 2].filter((p) => p !== G.game.me) });
  G.game.events.push({ type: 'suggest', suggester: G.game.me, cards, refuter: -1, shown: -1, passers: [] });
  const res = E.analyze(G.game, { samples: 0 });
  assert.strictEqual(res.ok, false);
  assert.ok(res.contradiction);
  assert.strictEqual(E.findContradiction(G.game), before);
});

test('wrong accusation removes exactly that triple', () => {
  const r = rngFrom(7);
  const G = randomGame([3, 3, 3], 3, r);
  const base = E.analyze(G.game, { samples: 0, topTriples: 1e9 });
  const t = base.triples[0].cards;
  G.game.events.push({ type: 'accuse', accuser: 0, cards: t, correct: false });
  const after = E.analyze(G.game, { samples: 0, topTriples: 1e9 });
  assert.strictEqual(after.nSolutions, base.nSolutions - 1);
  assert.ok(!after.triples.some((x) => x.cards.join() === t.join()));
});

test('exact samples follow the exact posterior', () => {
  const r = rngFrom(2024);
  const G = randomGame([6, 6, 9], 4, r);
  G.game.events = randomEvents(G, 10, r);
  const res = E.analyze(G.game, { samples: 6000, seed: 5 });
  assert.strictEqual(res.method, 'exact');
  const N = res.N, P = res.P;
  const freq = new Float64Array((P + 1) * N);
  for (let k = 0; k < res.nSamples; k++) for (let c = 0; c < N; c++) { const o = res.samples[k * N + c]; if (o >= 0) freq[o * N + c]++; }
  let maxDiff = 0;
  for (let i = 0; i < freq.length; i++) maxDiff = Math.max(maxDiff, Math.abs(freq[i] / res.nSamples - res.prob[i]));
  assert.ok(maxDiff < 0.03, 'sample frequencies deviate by ' + maxDiff);
  // every sample must itself satisfy the log
  const ENV = P;
  for (let k = 0; k < 200; k++) {
    const own = Array.from(res.samples.subarray(k * N, k * N + N));
    for (const ev of G.game.events) {
      if (ev.type !== 'suggest') continue;
      for (const p of ev.passers) assert.ok(!ev.cards.some((c) => own[c] === p));
      if (ev.refuter >= 0) assert.ok(ev.cards.some((c) => own[c] === ev.refuter));
    }
    G.ix.catCards.forEach((l) => assert.strictEqual(l.filter((c) => own[c] === ENV).length, 1));
  }
});

test('real deck sizes: fast, consistent, and the truth stays possible', () => {
  const r = rngFrom(31337);
  const timings = {};
  for (const P of [3, 4, 5, 6]) {
    for (let trial = 0; trial < 6; trial++) {
      const G = randomGame([6, 6, 9], P, r);
      for (const nEv of [0, 4, 10, 25]) {
        G.game.events = randomEvents(G, nEv, r);
        const res = E.analyze(G.game, { samples: 2000 });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.method, 'exact', `P=${P} events=${nEv}`);
        const N = res.N, ENV = P;
        // probabilities of each card sum to 1 across owners
        for (let c = 0; c < N; c++) {
          let s = 0;
          for (let o = 0; o <= P; o++) s += res.prob[o * N + c];
          assert.ok(close(s, 1, 1e-9), 'card prob sums to 1');
          assert.ok(res.prob[G.owner[c] * N + c] > 0, 'true owner must stay possible');
        }
        // expected hand sizes match
        for (let p = 0; p < P; p++) {
          let s = 0;
          for (let c = 0; c < N; c++) s += res.prob[p * N + c];
          assert.ok(close(s, G.game.players[p].hand, 1e-6));
        }
        const truth = G.ix.catCards.map((l) => l.find((c) => G.owner[c] === ENV)).join(',');
        assert.ok(res.triples.some((t) => t.cards.join(',') === truth) || res.nSolutions > res.triples.length);
        const key = 'P' + P + ' ev' + nEv;
        timings[key] = Math.max(timings[key] || 0, res.ms);
      }
    }
  }
  console.log('max ms per analysis (classic deck):', JSON.stringify(timings));
  for (const k in timings) assert.ok(timings[k] < 5000, k + ' too slow: ' + timings[k]);
});

test('Master Detective deck (30 cards) is handled', () => {
  const r = rngFrom(4242);
  for (const P of [3, 4, 6]) {
    const G = randomGame([10, 8, 12], P, r);
    G.game.events = randomEvents(G, 8, r);
    const res = E.analyze(G.game, { samples: 1500 });
    assert.strictEqual(res.ok, true, 'P=' + P);
    assert.ok(res.method === 'exact' || res.method === 'sampled');
    const N = res.N;
    for (let c = 0; c < N; c++) assert.ok(res.prob[G.owner[c] * N + c] > 0 || res.method === 'sampled');
    console.log(`Master Detective P=${P}: ${res.method} in ${res.ms.toFixed(0)} ms`);
  }
});

test('MCMC fallback agrees with the exact answer', () => {
  const r = rngFrom(77);
  const G = randomGame([6, 6, 9], 4, r);
  G.game.events = randomEvents(G, 12, r);
  const exact = E.analyze(G.game, { samples: 0 });
  const mc = E.analyze(G.game, { forceSampling: true, samples: 8000, seed: 3 });
  assert.strictEqual(mc.method, 'sampled');
  let maxDiff = 0;
  for (let i = 0; i < exact.prob.length; i++) maxDiff = Math.max(maxDiff, Math.abs(exact.prob[i] - mc.prob[i]));
  assert.ok(maxDiff < 0.06, 'MCMC deviates by ' + maxDiff);
});

test('suggestion ranking prefers informative suggestions', () => {
  const r = rngFrom(11);
  const G = randomGame([6, 6, 9], 3, r);
  G.game.events = randomEvents(G, 6, r);
  const res = E.analyze(G.game, { samples: 3000 });
  const rank = E.rankSuggestions(G.game, res, {});
  assert.ok(rank && rank.list.length === 6 * 6 * 9);
  const best = rank.list[0], worst = rank.list[rank.list.length - 1];
  assert.ok(best.eig >= worst.eig);
  assert.ok(best.eig > 0);
  // a suggestion made entirely of my own cards teaches nothing
  const mine = G.game.myCards;
  const ix = G.ix;
  const own = ix.catCards.map((l) => l.find((c) => mine.includes(c)));
  if (own.every((c) => c !== undefined)) {
    const it = rank.list.find((x) => x.cards.join() === own.join());
    assert.ok(it.eig < 1e-9 && Math.abs(it.pNone - 1) < 1e-9);
  }
  // room filter
  const room = ix.catCards[2][0];
  const one = E.rankSuggestions(G.game, res, { rooms: [room] });
  assert.strictEqual(one.list.length, 36);
});
