/*
 * Clue Solver engine
 * -------------------
 * Exact Bayesian inference for Clue / Cluedo.
 *
 * Model: the deal is uniformly random (one card of each category goes in the
 * envelope, the rest are shuffled and dealt with known hand sizes). Every
 * logged event is a hard constraint on the deal:
 *   - a player who passes holds none of the three suggested cards
 *   - a player who refutes holds at least one of them (exactly the card, if
 *     you saw it)
 *   - a wrong accusation means that exact triple is not the solution
 *   - your own hand and any face-up cards are known
 * Under a uniform prior, P(anything | log) = (# consistent deals where it is
 * true) / (# consistent deals). This engine counts consistent deals EXACTLY
 * with a dynamic program over players, so the probabilities are exact (no
 * sampling error). For very large decks it falls back to MCMC sampling.
 *
 * Works in browsers (window / Web Worker) and Node (module.exports).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ClueEngine = api;
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var UNKNOWN = -1, NO = 0, YES = 1;
  var PUBLIC = -2; // owner code for face-up cards in samples

  // ---------------------------------------------------------------- utils
  function popcount(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
  }
  function bitList(x) {
    var out = [];
    while (x) { var b = x & -x; out.push(31 - Math.clz32(b)); x ^= b; }
    return out;
  }
  function binom(n, k) {
    if (k < 0 || k > n) return 0;
    if (k > n - k) k = n - k;
    var r = 1;
    for (var i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
    return Math.round(r);
  }
  function now() {
    return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
  }
  function makeRng(seed) {
    var a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hashString(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // Enumerate k-subsets of the bit positions in `pos`; write masks that hit
  // every clause mask into buf starting at offset n. Returns new count.
  var SCR_IDX = new Int32Array(32), SCR_PREF = new Int32Array(33);
  function combosInto(pos, k, clauses, buf, n) {
    var len = pos.length;
    if (k > len) return n;
    var nc = clauses.length;
    if (k === 0) {
      if (nc === 0) buf[n++] = 0;
      return n;
    }
    var idx = SCR_IDX, pref = SCR_PREF;
    var i, j;
    for (i = 0; i < k; i++) { idx[i] = i; pref[i + 1] = pref[i] | (1 << pos[i]); }
    for (;;) {
      var H = pref[k];
      var ok = true;
      for (j = 0; j < nc; j++) if ((H & clauses[j]) === 0) { ok = false; break; }
      if (ok) buf[n++] = H;
      i = k - 1;
      while (i >= 0 && idx[i] === len - k + i) i--;
      if (i < 0) return n;
      idx[i]++;
      pref[i + 1] = pref[i] | (1 << pos[idx[i]]);
      for (j = i + 1; j < k; j++) { idx[j] = idx[j - 1] + 1; pref[j + 1] = pref[j] | (1 << pos[idx[j]]); }
    }
  }
  // positions of set bits, into a reusable array
  var SCR_POS = new Int32Array(32);
  function bitsInto(x, arr) {
    var n = 0;
    while (x) { var b = x & -x; arr[n++] = 31 - Math.clz32(b); x ^= b; }
    return arr.subarray(0, n);
  }

  // Open-addressing hash table: int mask -> forward count f (and backward b).
  function LevelTable(expected) {
    var cap = 16;
    while (cap < expected * 2) cap <<= 1;
    this.alloc(cap);
  }
  LevelTable.prototype.alloc = function (cap) {
    this.cap = cap;
    this.m = cap - 1;
    this.shift = 32 - Math.round(Math.log2(cap));
    this.keys = new Int32Array(cap).fill(-1);
    this.f = new Float64Array(cap);
    this.size = 0;
  };
  LevelTable.prototype.add = function (key, val) {
    var keys = this.keys, m = this.m;
    var h = Math.imul(key, -1640531535) >>> this.shift;
    for (;;) {
      var k = keys[h];
      if (k === key) { this.f[h] += val; return; }
      if (k === -1) {
        keys[h] = key; this.f[h] = val;
        if (++this.size * 2 > this.cap) this.grow();
        return;
      }
      h = (h + 1) & m;
    }
  };
  LevelTable.prototype.find = function (key) {
    var keys = this.keys, m = this.m;
    var h = Math.imul(key, -1640531535) >>> this.shift;
    for (;;) {
      var k = keys[h];
      if (k === key) return h;
      if (k === -1) return -1;
      h = (h + 1) & m;
    }
  };
  LevelTable.prototype.grow = function () {
    var oldK = this.keys, oldF = this.f, oldCap = this.cap;
    this.alloc(oldCap * 2);
    for (var i = 0; i < oldCap; i++) if (oldK[i] !== -1) this.add(oldK[i], oldF[i]);
  };

  // Same interface as LevelTable, but masks index a shared direct-address
  // array (used when the number of unknown cards is small enough).
  function DenseLevel(slotOf, expected) {
    var cap = 16;
    while (cap < expected) cap <<= 1;
    this.slotOf = slotOf;
    this.keys = new Int32Array(cap);
    this.f = new Float64Array(cap);
    this.size = 0;
    this.cap = 0;
  }
  DenseLevel.prototype.add = function (key, val) {
    var s = this.slotOf[key];
    if (s >= 0 && s < this.size && this.keys[s] === key) { this.f[s] += val; return; }
    if (this.size === this.keys.length) {
      var nk = new Int32Array(this.size * 2), nf = new Float64Array(this.size * 2);
      nk.set(this.keys); nf.set(this.f); this.keys = nk; this.f = nf;
    }
    s = this.size++;
    this.keys[s] = key; this.f[s] = val; this.slotOf[key] = s; this.cap = this.size;
  };
  DenseLevel.prototype.find = function (key) {
    var s = this.slotOf[key];
    return s >= 0 && s < this.size && this.keys[s] === key ? s : -1;
  };

  // ------------------------------------------------------------ compile
  function cardIndex(game) {
    var cats = game.categories, cardCat = [], catCards = [], names = [];
    var N = 0;
    for (var ci = 0; ci < cats.length; ci++) {
      var list = [];
      for (var j = 0; j < cats[ci].cards.length; j++) {
        cardCat.push(ci); list.push(N); names.push(cats[ci].cards[j]); N++;
      }
      catCards.push(list);
    }
    return { N: N, cardCat: cardCat, catCards: catCards, names: names, nCat: cats.length };
  }

  function validateSetup(game) {
    var ix = cardIndex(game);
    var P = game.players.length;
    if (P < 2) return 'Need at least 2 players.';
    for (var ci = 0; ci < ix.nCat; ci++) if (ix.catCards[ci].length < 1) return 'Every category needs at least one card.';
    var faceUp = game.faceUp || [];
    var dealt = 0;
    for (var p = 0; p < P; p++) {
      var h = game.players[p].hand;
      if (!(h >= 0)) return 'Invalid hand size for ' + game.players[p].name + '.';
      dealt += h;
    }
    if (dealt + faceUp.length + ix.nCat !== ix.N) {
      return 'Hand sizes (' + dealt + ') + face-up cards (' + faceUp.length + ') + envelope (' + ix.nCat +
        ') must equal the deck size (' + ix.N + ').';
    }
    if (game.me != null && game.me >= 0) {
      var mine = game.myCards || [];
      if (mine.length !== game.players[game.me].hand) return 'Select exactly ' + game.players[game.me].hand + ' cards for your hand.';
    }
    return null;
  }

  function compile(game, upto) {
    var ix = cardIndex(game);
    var N = ix.N, P = game.players.length, ENV = P, O = P + 1;
    var pr = {
      N: N, P: P, ENV: ENV, O: O, nCat: ix.nCat, cardCat: ix.cardCat, catCards: ix.catCards,
      K: new Int8Array(O * N).fill(UNKNOWN), cap: new Int32Array(P), pub: new Uint8Array(N),
      clauses: [], excluded: [], me: game.me == null ? -1 : game.me, contradiction: null
    };
    var c, o, p;
    for (p = 0; p < P; p++) pr.cap[p] = game.players[p].hand;
    (game.faceUp || []).forEach(function (cc) { pr.pub[cc] = 1; });
    for (c = 0; c < N; c++) if (pr.pub[c]) for (o = 0; o < O; o++) pr.K[o * N + c] = NO;

    function set(o, c, v, ev) {
      if (c == null || c < 0 || c >= N || o == null || o < 0 || o >= O) return;
      var i = o * N + c;
      if (pr.K[i] === UNKNOWN) pr.K[i] = v;
      else if (pr.K[i] !== v && !pr.contradiction) pr.contradiction = { event: ev, reason: 'direct' };
    }
    if (pr.me >= 0) {
      var mine = new Uint8Array(N);
      (game.myCards || []).forEach(function (cc) { mine[cc] = 1; });
      for (c = 0; c < N; c++) if (!pr.pub[c]) set(pr.me, c, mine[c] ? YES : NO, -1);
      else if (mine[c]) pr.contradiction = { event: -1, reason: 'A face-up card is also marked as in your hand.' };
    }
    var events = game.events || [];
    var lim = upto == null ? events.length : Math.min(upto, events.length);
    for (var e = 0; e < lim; e++) {
      var ev = events[e];
      if (!ev || ev.deleted) continue;
      if (ev.type === 'suggest') {
        var cards = ev.cards;
        (ev.passers || []).forEach(function (pp) { cards.forEach(function (cc) { set(pp, cc, NO, e); }); });
        if (ev.refuter != null && ev.refuter >= 0) {
          if (ev.shown != null && ev.shown >= 0) set(ev.refuter, ev.shown, YES, e);
          pr.clauses.push({ p: ev.refuter, cards: cards.slice(), ev: e });
        }
      } else if (ev.type === 'accuse') {
        if (ev.correct) ev.cards.forEach(function (cc) { set(ENV, cc, YES, e); });
        else pr.excluded.push({ cards: ev.cards.slice(), ev: e });
      } else if (ev.type === 'fact') {
        set(ev.owner, ev.card, ev.has ? YES : NO, e);
      }
    }
    return pr;
  }

  // ---------------------------------------------------------- propagate
  // Unit propagation to a fixpoint. Sound (never wrong); not complete — the
  // exact counter finds every remaining deduction.
  function propagate(pr) {
    var N = pr.N, P = pr.P, O = pr.O, ENV = pr.ENV, K = pr.K;
    var changed = true;
    function contra(why) { if (!pr.contradiction) pr.contradiction = { event: null, reason: why }; }
    function set(o, c, v) {
      var i = o * N + c;
      if (K[i] === UNKNOWN) { K[i] = v; changed = true; }
      else if (K[i] !== v) contra('conflict');
    }
    var c, o, p, i, yes, unk, last, ci, list;
    while (changed && !pr.contradiction) {
      changed = false;
      // each card has exactly one owner
      for (c = 0; c < N; c++) {
        if (pr.pub[c]) continue;
        yes = 0; unk = 0; last = -1;
        for (o = 0; o < O; o++) {
          var v = K[o * N + c];
          if (v === YES) yes++; else if (v === UNKNOWN) { unk++; last = o; }
        }
        if (yes > 1) contra('A card cannot be in two places.');
        else if (yes === 1) { if (unk) for (o = 0; o < O; o++) if (K[o * N + c] === UNKNOWN) set(o, c, NO); }
        else if (unk === 0) contra('A card has nowhere left to be.');
        else if (unk === 1) set(last, c, YES);
      }
      // hand sizes
      for (p = 0; p < P; p++) {
        yes = 0; unk = 0;
        for (c = 0; c < N; c++) { var w = K[p * N + c]; if (w === YES) yes++; else if (w === UNKNOWN) unk++; }
        if (yes > pr.cap[p] || yes + unk < pr.cap[p]) contra('Hand size of a player is violated.');
        else if (unk) {
          if (yes === pr.cap[p]) { for (c = 0; c < N; c++) if (K[p * N + c] === UNKNOWN) set(p, c, NO); }
          else if (yes + unk === pr.cap[p]) { for (c = 0; c < N; c++) if (K[p * N + c] === UNKNOWN) set(p, c, YES); }
        }
      }
      // envelope: exactly one per category
      for (ci = 0; ci < pr.nCat; ci++) {
        list = pr.catCards[ci]; yes = 0; unk = 0; last = -1;
        for (i = 0; i < list.length; i++) {
          var x = K[ENV * N + list[i]];
          if (x === YES) yes++; else if (x === UNKNOWN) { unk++; last = list[i]; }
        }
        if (yes > 1) contra('Envelope holds one card per category.');
        else if (yes === 1) { if (unk) for (i = 0; i < list.length; i++) if (K[ENV * N + list[i]] === UNKNOWN) set(ENV, list[i], NO); }
        else if (unk === 0) contra('Every card of a category is accounted for — none left for the envelope.');
        else if (unk === 1) set(ENV, last, YES);
      }
      // refutation clauses: player holds at least one
      for (i = 0; i < pr.clauses.length; i++) {
        var cl = pr.clauses[i];
        var sat = false, cnt = 0, lastC = -1;
        for (var j = 0; j < cl.cards.length; j++) {
          var y = K[cl.p * N + cl.cards[j]];
          if (y === YES) { sat = true; break; }
          if (y === UNKNOWN) { cnt++; lastC = cl.cards[j]; }
        }
        if (sat) continue;
        if (cnt === 0) contra('A player showed a card but cannot hold any of the suggested cards.');
        else if (cnt === 1) set(cl.p, lastC, YES);
      }
      // wrong accusations
      for (i = 0; i < pr.excluded.length; i++) {
        var ex = pr.excluded[i].cards, ny = 0, nn = 0, unkC = -1;
        for (var k = 0; k < ex.length; k++) {
          var z = K[ENV * N + ex[k]];
          if (z === YES) ny++; else if (z === NO) nn++; else unkC = ex[k];
        }
        if (nn) continue;
        if (ny === ex.length) contra('The envelope matches an accusation that was wrong.');
        else if (ny === ex.length - 1 && unkC >= 0) set(ENV, unkC, NO);
      }
    }
    return !pr.contradiction;
  }

  // ------------------------------------------------------------- reduce
  // Build the residual problem over cards whose location is still unknown.
  function reduce(pr) {
    var N = pr.N, P = pr.P, ENV = pr.ENV, K = pr.K;
    var bitOf = new Int32Array(N).fill(-1), cardOfBit = [];
    var c, o, p;
    for (c = 0; c < N; c++) {
      if (pr.pub[c]) continue;
      var known = false;
      for (o = 0; o <= P; o++) if (K[o * N + c] === YES) { known = true; break; }
      if (!known) { bitOf[c] = cardOfBit.length; cardOfBit.push(c); }
    }
    var u = cardOfBit.length;
    var red = { u: u, bitOf: bitOf, cardOfBit: cardOfBit, players: [], envCats: [], envKnown: [], excluded: null, full: 0, tooBig: u > 30 };
    if (red.tooBig) return red;
    red.full = u === 0 ? 0 : (u === 30 ? 0x3fffffff : (1 << u) - 1);
    for (p = 0; p < P; p++) {
      var yes = 0;
      for (c = 0; c < N; c++) if (K[p * N + c] === YES) yes++;
      var need = pr.cap[p] - yes;
      if (need <= 0) continue;
      var F = 0;
      for (var b = 0; b < u; b++) if (K[p * N + cardOfBit[b]] === NO) F |= 1 << b;
      var cls = [];
      pr.clauses.forEach(function (cl) {
        if (cl.p !== p) return;
        var m = 0, sat = false;
        cl.cards.forEach(function (cc) {
          var v = K[p * N + cc];
          if (v === YES) sat = true;
          else if (v === UNKNOWN && bitOf[cc] >= 0) m |= 1 << bitOf[cc];
        });
        if (!sat) cls.push(m);
      });
      // drop duplicate / superset clauses
      cls.sort(function (a, b2) { return popcount(a) - popcount(b2); });
      var kept = [];
      cls.forEach(function (m) {
        for (var q = 0; q < kept.length; q++) if ((kept[q] & m) === kept[q]) return;
        kept.push(m);
      });
      red.players.push({ p: p, need: need, F: F, allowed: red.full & ~F, clauses: kept });
    }
    for (var ci = 0; ci < pr.nCat; ci++) {
      var knownCard = -1, cand = 0;
      pr.catCards[ci].forEach(function (cc) {
        var v = K[ENV * N + cc];
        if (v === YES) knownCard = cc;
        else if (v === UNKNOWN && bitOf[cc] >= 0) cand |= 1 << bitOf[cc];
      });
      red.envKnown.push(knownCard);
      if (knownCard < 0) red.envCats.push({ ci: ci, cand: cand });
    }
    // excluded triples still possible
    var exSet = new Set();
    pr.excluded.forEach(function (ex) {
      var dead = ex.cards.some(function (cc) { return K[ENV * N + cc] === NO; });
      if (!dead) exSet.add(tripleKey(ex.cards, pr));
    });
    red.excluded = exSet;
    return red;
  }

  // key for an envelope combo given cards (any order, one per category)
  function tripleKey(cards, pr) {
    var byCat = new Array(pr.nCat);
    cards.forEach(function (c) { byCat[pr.cardCat[c]] = c; });
    var k = 0;
    for (var i = 0; i < pr.nCat; i++) k = k * pr.N + byCat[i];
    return k;
  }
  function keyToCards(k, pr) {
    var out = new Array(pr.nCat);
    for (var i = pr.nCat - 1; i >= 0; i--) { out[i] = k % pr.N; k = Math.floor(k / pr.N); }
    return out;
  }

  // ------------------------------------------------------- exact solver
  function exactSolve(pr, red, opts) {
    if (opts.debug) opts.debug.t0 = now();
    var budget = opts.budget || 1.2e8;
    var maxStates = opts.maxStates || 5e6;
    var u = red.u, full = red.full;
    // Players with no refutation clauses and identical forbidden cards are
    // interchangeable: merge them into one group and count the ways to split
    // the group's cards with a multinomial coefficient.
    var groups = {}, players = [], multiplier = 1;
    red.players.forEach(function (pl) {
      if (pl.clauses.length) {
        players.push({ p: pl.p, need: pl.need, F: pl.F, allowed: pl.allowed, clauses: pl.clauses });
        return;
      }
      var key = 'F' + pl.F;
      if (!groups[key]) { groups[key] = { p: -1, members: [], need: 0, F: pl.F, allowed: pl.allowed, clauses: [] }; players.push(groups[key]); }
      groups[key].members.push({ p: pl.p, need: pl.need });
      groups[key].need += pl.need;
    });
    players.forEach(function (pl) {
      if (pl.members && pl.members.length === 1) { pl.p = pl.members[0].p; pl.members = null; }
      else if (pl.members) {
        var left = pl.need;
        pl.members.forEach(function (mb) { multiplier *= binom(left, mb.need); left -= mb.need; });
      }
      pl.pos = bitList(pl.allowed);
      pl.nComb = binom(pl.pos.length, pl.need);
    });
    // valid-hand lists (subsets of allowed cards that satisfy every clause)
    players.forEach(function (pl) {
      if (pl.nComb <= 2.5e6) {
        var bf = new Int32Array(pl.nComb);
        var n = combosInto(pl.pos, pl.need, pl.clauses, bf, 0);
        pl.list = bf.subarray(0, n);
        pl.nValid = n;
      } else { pl.list = null; pl.nValid = pl.nComb; }
    });
    var fwd = players, last = null;
    if (opts.debug) opts.debug.tLists = now();
    // choose the player order (and which player goes last) that minimises
    // the estimated work of the DP
    function estimate(order, lastPl) {
      var envB = 1;
      red.envCats.forEach(function (ec) { envB *= Math.max(1, popcount(ec.cand)); });
      var st = 1, ss = 0, cst = 0, mx = 1;
      for (var a = 0; a < order.length; a++) {
        var q = order[a];
        var comb = binom(u - ss, q.need);
        cst += st * Math.min(q.nValid, comb);
        st = Math.min(st * q.nValid, binom(u, ss + q.need));
        ss += q.need;
        if (st > mx) mx = st;
      }
      cst += st * envB * (lastPl ? 1 + lastPl.clauses.length * 0.1 : 1);
      return { cost: cst, maxStates: mx };
    }
    var all = players.slice();
    var best = null;
    function consider(order, lastPl) {
      var est = estimate(order, lastPl);
      if (!best || est.cost < best.cost) best = { cost: est.cost, maxStates: est.maxStates, order: order.slice(), last: lastPl };
    }
    if (all.length <= 7) {
      var used = new Array(all.length).fill(false), cur = [];
      (function permute() {
        if (cur.length === all.length - 1) {
          for (var z = 0; z < all.length; z++) if (!used[z]) { consider(cur, all[z]); break; }
          return;
        }
        for (var z2 = 0; z2 < all.length; z2++) {
          if (used[z2]) continue;
          used[z2] = true; cur.push(all[z2]);
          permute();
          cur.pop(); used[z2] = false;
        }
      })();
      if (!all.length) consider([], null);
    } else {
      // many players: largest hand last, most constrained first
      var srt = all.slice().sort(function (a, b) { return a.need - b.need || a.nValid - b.nValid; });
      var lp = srt.pop();
      consider(srt.sort(function (a, b) { return a.nValid - b.nValid; }), lp);
    }
    fwd = best.order; last = best.last;
    if (opts.debug) opts.debug.tOrder = now();
    var s = 0, i;
    for (i = 0; i < fwd.length; i++) {
      var pl = fwd[i];
      pl.useList = !!pl.list && pl.nValid <= 1.5 * binom(u - s, pl.need);
      s += pl.need;
    }
    if (best.cost > budget * 2 || best.maxStates > maxStates) return null;

    // ---- forward pass
    var slotOf = u <= 21 ? new Int32Array(1 << u).fill(-1) : null;
    function newLevel(expected) { return slotOf ? new DenseLevel(slotOf, expected) : new LevelTable(expected); }
    var tables = [newLevel(1)];
    tables[0].add(0, 1);
    s = 0;
    var bufSize = 1;
    fwd.forEach(function (pl, idx) {
      var est = pl.useList ? pl.nValid : binom(u - s, pl.need);
      s += pl.need;
      if (est > bufSize) bufSize = est;
    });
    var buf = new Int32Array(Math.max(1, bufSize));
    var work = 0;
    s = 0;
    for (i = 0; i < fwd.length; i++) {
      var plf = fwd[i], prev = tables[i];
      var next = newLevel(Math.min(1 << 17, binom(u, s + plf.need), Math.max(16, prev.size * plf.nValid)));
      for (var slot = 0; slot < prev.cap; slot++) {
        var M = prev.keys[slot];
        if (M === -1) continue;
        var v = prev.f[slot];
        var n = enumHands(plf, M, full, buf);
        work += n;
        if (opts.debug) { opts.debug.scan = (opts.debug.scan || 0) + (plf.useList ? plf.list.length : n); }
        for (var h = 0; h < n; h++) next.add(M | buf[h], v);
        if (next.size > maxStates || work > budget) return null;
      }
      tables.push(next);
      s += plf.need;
    }

    // ---- final step: last player + envelope from the leftover cards
    var T = tables[tables.length - 1];
    if (opts.debug) {
      opts.debug.levels = tables.map(function (t) { return t.size; });
      opts.debug.order = fwd.map(function (q) { return { need: q.need, nValid: q.nValid, useList: q.useList, group: !!q.members }; });
      opts.debug.last = last && { need: last.need, group: !!last.members, clauses: last.clauses.length };
      opts.debug.tFwd = now();
    }
    T.b = new Float64Array(T.cap);
    var nCat = pr.nCat, N = pr.N;
    var keySpace = Math.pow(N, nCat);
    var tripleW = keySpace <= 4e6 ? new Float64Array(keySpace) : null;
    var tripleMap = tripleW ? null : new Map();
    var margLast = new Float64Array(u), margEnv = new Float64Array(u);
    var envLocal = new Float64Array(u);
    var envCats = red.envCats, nEC = envCats.length;
    var baseCards = red.envKnown.slice();
    var lastF = last ? last.F : 0, lastCl = last ? last.clauses : [];
    var total = 0;
    var choice = new Int32Array(nEC);
    var touched = [];
    for (var sl = 0; sl < T.cap; sl++) {
      var MM = T.keys[sl];
      if (MM === -1) continue;
      var f = T.f[sl];
      var R = full & ~MM;
      var cnt = 0;
      touched.length = 0;
      // iterate envelope choices (cartesian product over needed categories)
      var cands = [];
      var okc = true;
      for (var e = 0; e < nEC; e++) { var cb = bitList(R & envCats[e].cand); if (!cb.length) { okc = false; break; } cands.push(cb); }
      if (okc) {
        var ci2 = new Int32Array(nEC);
        for (;;) {
          var E = 0;
          for (e = 0; e < nEC; e++) { choice[e] = cands[e][ci2[e]]; E |= 1 << choice[e]; }
          var rest = R & ~E;
          var valid = (rest & lastF) === 0;
          if (valid) for (var q = 0; q < lastCl.length; q++) if ((rest & lastCl[q]) === 0) { valid = false; break; }
          if (valid && (last || rest === 0)) {
            for (e = 0; e < nEC; e++) baseCards[envCats[e].ci] = red.cardOfBit[choice[e]];
            var key = 0;
            for (var z = 0; z < nCat; z++) key = key * N + baseCards[z];
            if (!red.excluded.has(key)) {
              cnt++;
              if (tripleW) tripleW[key] += f; else tripleMap.set(key, (tripleMap.get(key) || 0) + f);
              for (e = 0; e < nEC; e++) { if (envLocal[choice[e]] === 0) touched.push(choice[e]); envLocal[choice[e]] += 1; }
            }
          }
          // advance odometer
          e = nEC - 1;
          while (e >= 0) { ci2[e]++; if (ci2[e] < cands[e].length) break; ci2[e] = 0; e--; }
          if (e < 0) break;
        }
      }
      T.b[sl] = cnt;
      if (cnt) {
        total += f * cnt;
        if (last) { var xb = R; while (xb) { var bb = xb & -xb, bi = 31 - Math.clz32(bb); margLast[bi] += f * (cnt - envLocal[bi]); xb ^= bb; } }
        for (var t2 = 0; t2 < touched.length; t2++) { margEnv[touched[t2]] += f * envLocal[touched[t2]]; envLocal[touched[t2]] = 0; }
      } else {
        for (var t3 = 0; t3 < touched.length; t3++) envLocal[touched[t3]] = 0;
      }
    }

    if (opts.debug) opts.debug.tFinal = now();
    // ---- backward pass (marginals for the forward players)
    for (i = fwd.length; i >= 1; i--) {
      var plb = fwd[i - 1], pv = tables[i - 1], cur = tables[i];
      pv.b = new Float64Array(pv.cap);
      var marg = new Float64Array(u);
      for (var s2 = 0; s2 < pv.cap; s2++) {
        var M2 = pv.keys[s2];
        if (M2 === -1) continue;
        var f2 = pv.f[s2];
        var n2 = enumHands(plb, M2, full, buf);
        var bsum = 0;
        for (var h2 = 0; h2 < n2; h2++) {
          var H2 = buf[h2];
          var vb = cur.b[cur.find(M2 | H2)];
          if (vb) {
            bsum += vb;
            var w2 = f2 * vb, x2 = H2;
            while (x2) { var b2 = x2 & -x2; marg[31 - Math.clz32(b2)] += w2; x2 ^= b2; }
          }
        }
        pv.b[s2] = bsum;
      }
      plb.marg = marg;
    }
    if (last) last.marg = margLast;
    if (opts.debug) opts.debug.tBack = now();

    return {
      total: total, multiplier: multiplier, tables: tables, fwd: fwd, last: last, tripleW: tripleW, tripleMap: tripleMap,
      margEnv: margEnv, buf: buf, work: work
    };
  }

  function enumHands(pl, M, full, buf) {
    var n = 0;
    if (pl.useList) {
      var L = pl.list, len = L.length;
      for (var i = 0; i < len; i++) { var H = L[i]; if ((H & M) === 0) buf[n++] = H; }
      return n;
    }
    return combosInto(bitsInto(full & ~M & pl.allowed, SCR_POS), pl.need, pl.clauses, buf, 0);
  }

  // write a hand into a sample row; a merged group's cards are dealt to its
  // members uniformly at random (every split is equally consistent)
  function assignHand(row, pl, H, red, rand) {
    var bits = bitList(H), i;
    if (!pl.members) { for (i = 0; i < bits.length; i++) row[red.cardOfBit[bits[i]]] = pl.p; return; }
    for (i = bits.length - 1; i > 0; i--) { var j = Math.floor(rand() * (i + 1)), t = bits[i]; bits[i] = bits[j]; bits[j] = t; }
    var k = 0;
    pl.members.forEach(function (mb) { for (var q = 0; q < mb.need; q++) row[red.cardOfBit[bits[k++]]] = mb.p; });
  }

  // draw exact uniform samples of consistent deals from the DP tables
  function sampleExact(pr, red, ex, nSamples, rand) {
    var N = pr.N, P = pr.P, ENV = pr.ENV, K = pr.K;
    var base = new Int8Array(N);
    var c, o;
    for (c = 0; c < N; c++) {
      if (pr.pub[c]) { base[c] = PUBLIC; continue; }
      base[c] = -1;
      for (o = 0; o <= P; o++) if (K[o * N + c] === YES) { base[c] = o; break; }
    }
    var out = new Int8Array(nSamples * N);
    var T = ex.tables[ex.tables.length - 1];
    var slots = [], cum = [], acc = 0;
    for (var s = 0; s < T.cap; s++) {
      if (T.keys[s] === -1 || !T.b[s]) continue;
      acc += T.f[s] * T.b[s];
      slots.push(s); cum.push(acc);
    }
    if (!acc) return { samples: out, n: 0 };
    var full = red.full, envCats = red.envCats, nEC = envCats.length, last = ex.last;
    var lastF = last ? last.F : 0, lastCl = last ? last.clauses : [];
    var baseCards = red.envKnown.slice();
    for (var k = 0; k < nSamples; k++) {
      var row = out.subarray(k * N, k * N + N);
      row.set(base);
      // pick final state
      var r = rand() * acc, lo = 0, hi = cum.length - 1;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (cum[mid] > r) hi = mid; else lo = mid + 1; }
      var M = T.keys[slots[lo]];
      var R = full & ~M;
      // pick envelope completion uniformly
      var comps = [];
      var cands = [], okc = true, e;
      for (e = 0; e < nEC; e++) { var cb = bitList(R & envCats[e].cand); if (!cb.length) { okc = false; break; } cands.push(cb); }
      if (okc) {
        var ci2 = new Int32Array(nEC);
        for (;;) {
          var E = 0;
          for (e = 0; e < nEC; e++) { var bit = cands[e][ci2[e]]; E |= 1 << bit; baseCards[envCats[e].ci] = red.cardOfBit[bit]; }
          var rest = R & ~E, valid = (rest & lastF) === 0;
          if (valid) for (var q = 0; q < lastCl.length; q++) if ((rest & lastCl[q]) === 0) { valid = false; break; }
          if (valid && (last || rest === 0)) {
            var key = 0;
            for (var z = 0; z < pr.nCat; z++) key = key * N + baseCards[z];
            if (!red.excluded.has(key)) comps.push(E);
          }
          e = nEC - 1;
          while (e >= 0) { ci2[e]++; if (ci2[e] < cands[e].length) break; ci2[e] = 0; e--; }
          if (e < 0) break;
        }
      }
      var Ech = comps[Math.floor(rand() * comps.length)];
      var x = Ech; while (x) { var b = x & -x; row[red.cardOfBit[31 - Math.clz32(b)]] = ENV; x ^= b; }
      if (last) assignHand(row, last, R & ~Ech, red, rand);
      // walk back through forward players
      for (var i = ex.fwd.length; i >= 1; i--) {
        var pl = ex.fwd[i - 1], prevT = ex.tables[i - 1];
        var pos = bitList(M & pl.allowed);
        var need = binom(pos.length, pl.need);
        var buf = need <= ex.buf.length ? ex.buf : (ex.buf = new Int32Array(need));
        var n = combosInto(pos, pl.need, pl.clauses, buf, 0);
        var tot = 0, wts = new Float64Array(n);
        for (var h = 0; h < n; h++) {
          var sl = prevT.find(M & ~buf[h]);
          wts[h] = sl >= 0 ? prevT.f[sl] : 0;
          tot += wts[h];
        }
        var rr = rand() * tot, pick = 0;
        for (h = 0; h < n; h++) { rr -= wts[h]; if (rr < 0) { pick = h; break; } pick = h; }
        while (wts[pick] === 0 && pick > 0) pick--;
        var H = buf[pick];
        assignHand(row, pl, H, red, rand);
        M &= ~H;
      }
    }
    return { samples: out, n: nSamples };
  }

  // ---------------------------------------------------------- MCMC fallback
  function mcmcSolve(pr, red, opts, rand) {
    var nSamples = opts.samples || 3000;
    var full = red.full, u = red.u;
    var owners = red.players.map(function (pl) { return { p: pl.p, need: pl.need, F: pl.F, clauses: pl.clauses, env: false }; });
    if (red.envCats.length) owners.push({ p: pr.ENV, need: red.envCats.length, env: true });
    var nO = owners.length;
    var envAll = 0;
    red.envCats.forEach(function (ec) { envAll |= ec.cand; });
    var baseCards = red.envKnown.slice();
    function validEnv(S) {
      if (S & ~envAll) return false;
      for (var e = 0; e < red.envCats.length; e++) {
        var x = S & red.envCats[e].cand;
        if (!x || (x & (x - 1))) return false;
        baseCards[red.envCats[e].ci] = red.cardOfBit[31 - Math.clz32(x)];
      }
      var key = 0;
      for (var z = 0; z < pr.nCat; z++) key = key * pr.N + baseCards[z];
      return !red.excluded.has(key);
    }
    function valid(o, S) {
      if (o.env) return validEnv(S);
      if (S & o.F) return false;
      for (var q = 0; q < o.clauses.length; q++) if ((S & o.clauses[q]) === 0) return false;
      return true;
    }
    function randBit(x) { var l = bitList(x); return l.length ? 1 << l[Math.floor(rand() * l.length)] : 0; }
    function init() {
      var order = owners.slice().sort(function (a, b) {
        if (a.env !== b.env) return a.env ? -1 : 1;
        return popcount(full & ~(a.F || 0)) - popcount(full & ~(b.F || 0));
      });
      for (var attempt = 0; attempt < 4000; attempt++) {
        var rem = full, hands = new Array(nO), ok = true;
        for (var oi = 0; oi < order.length && ok; oi++) {
          var o = order[oi], S = 0, idx = owners.indexOf(o);
          if (oi === order.length - 1) S = rem;
          else if (o.env) {
            for (var e = 0; e < red.envCats.length; e++) {
              var bt = randBit(rem & red.envCats[e].cand);
              if (!bt) { ok = false; break; }
              S |= bt;
            }
          } else {
            var avail = rem & ~o.F;
            var cl = o.clauses.slice().sort(function () { return rand() - 0.5; });
            for (var q = 0; q < cl.length; q++) {
              if (S & cl[q]) continue;
              var b2 = randBit(cl[q] & avail & ~S);
              if (!b2) { ok = false; break; }
              S |= b2;
            }
            while (ok && popcount(S) < o.need) {
              var b3 = randBit(avail & ~S);
              if (!b3) { ok = false; break; }
              S |= b3;
            }
            if (popcount(S) > o.need) ok = false;
          }
          if (!ok) break;
          if (!valid(o, S) || popcount(S) !== o.need) { ok = false; break; }
          hands[idx] = S; rem &= ~S;
        }
        if (ok && rem === 0) return hands;
      }
      return null;
    }
    var chains = 4, perChain = Math.ceil(nSamples / chains);
    var N = pr.N, P = pr.P;
    var base = new Int8Array(N);
    for (var c = 0; c < N; c++) {
      if (pr.pub[c]) { base[c] = PUBLIC; continue; }
      base[c] = -1;
      for (var o2 = 0; o2 <= P; o2++) if (pr.K[o2 * N + c] === YES) { base[c] = o2; break; }
    }
    var out = new Int8Array(chains * perChain * N), got = 0;
    var thin = Math.max(2, nO), burn = 400 * nO;
    var splitBuf = new Int32Array(4000);
    for (var ch = 0; ch < chains; ch++) {
      var hands = init();
      if (!hands) continue;
      var moves = burn + perChain * thin;
      for (var mv = 0; mv < moves; mv++) {
        if (nO >= 2) {
          var a = Math.floor(rand() * nO), bI = Math.floor(rand() * (nO - 1));
          if (bI >= a) bI++;
          var A = owners[a], B = owners[bI];
          var pool = hands[a] | hands[bI], pc = popcount(pool);
          if (binom(pc, A.need) <= 4000) {
            var n = combosInto(bitList(pool), A.need, [], splitBuf, 0);
            var chosen = -1, seen = 0;
            for (var h = 0; h < n; h++) {
              var SA = splitBuf[h], SB = pool & ~SA;
              if (valid(A, SA) && valid(B, SB)) { seen++; if (rand() * seen < 1) chosen = SA; }
            }
            if (chosen !== -1) { hands[a] = chosen; hands[bI] = pool & ~chosen; }
          } else {
            var xa = randBit(hands[a]), xb = randBit(hands[bI]);
            if (rand() < 0.5) { xa |= randBit(hands[a] & ~xa); xb |= randBit(hands[bI] & ~xb); }
            if (popcount(xa) === popcount(xb)) {
              var NA = (hands[a] & ~xa) | xb, NB = (hands[bI] & ~xb) | xa;
              if (valid(A, NA) && valid(B, NB)) { hands[a] = NA; hands[bI] = NB; }
            }
          }
        }
        if (mv >= burn && (mv - burn) % thin === 0 && got < chains * perChain) {
          var row = out.subarray(got * N, got * N + N);
          row.set(base);
          for (var oi = 0; oi < nO; oi++) {
            var x = hands[oi];
            while (x) { var b = x & -x; row[red.cardOfBit[31 - Math.clz32(b)]] = owners[oi].p; x ^= b; }
          }
          got++;
        }
      }
    }
    if (!got) return null;
    return { samples: out.subarray(0, got * N), n: got };
  }

  // ------------------------------------------------------------ analyze
  function blankResult(pr) {
    return {
      ok: true, contradiction: null, method: 'logic', N: pr.N, P: pr.P, ENV: pr.ENV,
      prob: new Float64Array(pr.O * pr.N), known: new Int8Array(pr.K), triples: [], nSolutions: 0,
      deals: 0, samples: new Int8Array(0), nSamples: 0, ms: 0
    };
  }

  function fillFromKnown(res, pr) {
    var N = pr.N;
    for (var o = 0; o < pr.O; o++) for (var c = 0; c < N; c++) {
      var v = res.known[o * N + c];
      if (v === YES) res.prob[o * N + c] = 1;
      else if (v === NO) res.prob[o * N + c] = 0;
    }
  }

  function analyze(game, opts) {
    var t0 = now();
    opts = opts || {};
    var err = validateSetup(game);
    if (err) return { ok: false, configError: err };
    var pr = compile(game, opts.upto);
    if (!pr.contradiction) propagate(pr);
    var res = blankResult(pr);
    if (pr.contradiction) {
      res.ok = false; res.contradiction = pr.contradiction; res.ms = now() - t0;
      return res;
    }
    res.known = new Int8Array(pr.K);
    var red = reduce(pr);
    var N = pr.N, P = pr.P, ENV = pr.ENV;
    var seed = opts.seed != null ? opts.seed : hashString(JSON.stringify(game.events || []) + '|' + (game.myCards || []).join(','));
    var rand = makeRng(seed);
    var nSamples = opts.samples == null ? 3000 : opts.samples;
    var ex = (!red.tooBig && !opts.forceSampling) ? exactSolve(pr, red, opts) : null;
    var c, o, b;
    if (ex) {
      if (ex.total === 0) {
        res.ok = false; res.contradiction = { event: null, reason: 'No deal of the cards is consistent with everything logged.' };
        res.ms = now() - t0;
        return res;
      }
      res.method = 'exact';
      res.deals = ex.total * ex.multiplier;
      var tot = ex.total;
      fillFromKnown(res, pr);
      var margBy = {};
      ex.fwd.concat(ex.last ? [ex.last] : []).forEach(function (pl) {
        if (!pl.members) { margBy[pl.p] = pl.marg; return; }
        pl.members.forEach(function (mb) {
          var mm = new Float64Array(pl.marg.length);
          for (var q = 0; q < mm.length; q++) mm[q] = (pl.marg[q] * mb.need) / pl.need;
          margBy[mb.p] = mm;
        });
      });
      for (b = 0; b < red.u; b++) {
        c = red.cardOfBit[b];
        for (o = 0; o < P; o++) res.prob[o * N + c] = margBy[o] ? margBy[o][b] / tot : 0;
        res.prob[ENV * N + c] = ex.margEnv[b] / tot;
        // exact zero counts give logical certainty
        var nz = 0, who = -1;
        for (o = 0; o <= P; o++) {
          var cnt = o === ENV ? ex.margEnv[b] : (margBy[o] ? margBy[o][b] : 0);
          if (cnt > 0) { nz++; who = o; } else res.known[o * N + c] = NO;
        }
        if (nz === 1) { res.known[who * N + c] = YES; for (o = 0; o <= P; o++) res.prob[o * N + c] = o === who ? 1 : 0; }
      }
      var trip = [];
      if (ex.tripleW) {
        for (var k = 0; k < ex.tripleW.length; k++) if (ex.tripleW[k] > 0) trip.push({ key: k, w: ex.tripleW[k] });
      } else ex.tripleMap.forEach(function (w, k2) { if (w > 0) trip.push({ key: k2, w: w }); });
      trip.sort(function (a, b2) { return b2.w - a.w; });
      res.nSolutions = trip.length;
      res.triples = trip.slice(0, opts.topTriples || 60).map(function (t) { return { cards: keyToCards(t.key, pr), p: t.w / tot }; });
      if (nSamples > 0) {
        var sm = sampleExact(pr, red, ex, nSamples, rand);
        res.samples = sm.samples; res.nSamples = sm.n;
      }
      res.work = ex.work;
    } else {
      // sampling fallback
      var mc = red.tooBig ? null : mcmcSolve(pr, red, { samples: Math.max(nSamples, 4000) }, rand);
      fillFromKnown(res, pr);
      if (mc && mc.n) {
        res.method = 'sampled';
        var S = mc.samples, n = mc.n;
        var counts = new Float64Array(pr.O * N), tmap = new Map();
        for (var i = 0; i < n; i++) {
          var tk = 0, env = new Array(pr.nCat);
          for (c = 0; c < N; c++) {
            var ow = S[i * N + c];
            if (ow >= 0) counts[ow * N + c]++;
            if (ow === ENV) env[pr.cardCat[c]] = c;
          }
          for (var z = 0; z < pr.nCat; z++) tk = tk * N + env[z];
          tmap.set(tk, (tmap.get(tk) || 0) + 1);
        }
        for (c = 0; c < N; c++) {
          if (pr.pub[c]) continue;
          var isKnown = false;
          for (o = 0; o <= P; o++) if (res.known[o * N + c] === YES) isKnown = true;
          if (isKnown) continue;
          for (o = 0; o <= P; o++) res.prob[o * N + c] = res.known[o * N + c] === NO ? 0 : counts[o * N + c] / n;
        }
        var tl = [];
        tmap.forEach(function (w, k3) { tl.push({ key: k3, w: w }); });
        tl.sort(function (a, b3) { return b3.w - a.w; });
        res.nSolutions = tl.length;
        res.triples = tl.slice(0, opts.topTriples || 60).map(function (t) { return { cards: keyToCards(t.key, pr), p: t.w / n }; });
        res.samples = S; res.nSamples = n;
        res.deals = NaN;
      } else {
        res.method = 'logic';
      }
    }
    res.ms = now() - t0;
    return res;
  }

  // Find the first event that makes the log inconsistent (-1 = setup itself).
  function findContradiction(game, opts) {
    opts = Object.assign({ samples: 0 }, opts || {});
    var events = game.events || [];
    function bad(n) { var r = analyze(game, Object.assign({}, opts, { upto: n })); return r.ok === false && !!r.contradiction; }
    if (bad(0)) return -1;
    if (!bad(events.length)) return null;
    // constraints only accumulate, so inconsistency is monotone: binary search
    var lo = 1, hi = events.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (bad(mid)) hi = mid; else lo = mid + 1; }
    return lo - 1;
  }

  // -------------------------------------------------- suggestion ranking
  // Expected information gain (bits) about the envelope from making a
  // suggestion yourself, estimated over exact posterior samples. Refuters
  // holding several of the cards are assumed to pick one uniformly.
  function rankSuggestions(game, res, opts) {
    opts = opts || {};
    if (!res || !res.nSamples) return null;
    var ix = cardIndex(game);
    var N = ix.N, P = game.players.length, ENV = P, nCat = ix.nCat;
    var me = opts.suggester != null ? opts.suggester : game.me;
    var S = res.samples, nS = res.nSamples;
    var order = [];
    for (var i = 1; i < P; i++) order.push((me + i) % P);
    var envCard = new Int16Array(nS * nCat);
    for (var k = 0; k < nS; k++) for (var c = 0; c < N; c++) if (S[k * N + c] === ENV) envCard[k * nCat + ix.cardCat[c]] = c;
    function entropyOf(row, off, total) {
      var H = 0;
      for (var ci = 0; ci < nCat; ci++) {
        var cl = ix.catCards[ci];
        for (var j = 0; j < cl.length; j++) {
          var w = row[off + cl[j]];
          if (w > 0) { var p = w / total; H -= p * Math.log2(p); }
        }
      }
      return H;
    }
    var prior = new Float64Array(N);
    for (k = 0; k < nS; k++) for (var z = 0; z < nCat; z++) prior[envCard[k * nCat + z]]++;
    var Hprior = entropyOf(prior, 0, nS);
    var cats = ix.catCards;
    var lists = [opts.suspects || cats[0], opts.weapons || cats[1], opts.rooms || cats[2]];
    var nOut = 1 + order.length * 3;
    var hist = new Float64Array(nOut * N), outW = new Float64Array(nOut);
    var results = [];
    for (var a = 0; a < lists[0].length; a++) for (var b = 0; b < lists[1].length; b++) for (var r = 0; r < lists[2].length; r++) {
      var X0 = lists[0][a], X1 = lists[1][b], X2 = lists[2][r];
      hist.fill(0); outW.fill(0);
      for (k = 0; k < nS; k++) {
        var base = k * N, o0 = S[base + X0], o1 = S[base + X1], o2 = S[base + X2];
        var eo = k * nCat, oc = -1;
        for (var t = 0; t < order.length; t++) {
          var q = order[t];
          var m0 = o0 === q ? 1 : 0, m1 = o1 === q ? 1 : 0, m2 = o2 === q ? 1 : 0;
          var cnt = m0 + m1 + m2;
          if (cnt) {
            var wt = 1 / cnt, ob = 1 + t * 3;
            if (m0) { outW[ob] += wt; for (z = 0; z < nCat; z++) hist[ob * N + envCard[eo + z]] += wt; }
            if (m1) { outW[ob + 1] += wt; for (z = 0; z < nCat; z++) hist[(ob + 1) * N + envCard[eo + z]] += wt; }
            if (m2) { outW[ob + 2] += wt; for (z = 0; z < nCat; z++) hist[(ob + 2) * N + envCard[eo + z]] += wt; }
            oc = t;
            break;
          }
        }
        if (oc < 0) { outW[0] += 1; for (z = 0; z < nCat; z++) hist[envCard[eo + z]] += 1; }
      }
      var Hpost = 0;
      for (var o = 0; o < nOut; o++) if (outW[o] > 0) Hpost += (outW[o] / nS) * entropyOf(hist, o * N, outW[o]);
      var byPlayer = [];
      for (t = 0; t < order.length; t++) {
        var pw = outW[1 + t * 3] + outW[2 + t * 3] + outW[3 + t * 3];
        if (pw > 0) byPlayer.push({ player: order[t], p: pw / nS });
      }
      results.push({ cards: [X0, X1, X2], eig: Math.max(0, Hprior - Hpost), pNone: outW[0] / nS, byPlayer: byPlayer });
    }
    results.sort(function (x, y) { return y.eig - x.eig || y.pNone - x.pNone; });
    return { prior: Hprior, list: results };
  }

  return {
    UNKNOWN: UNKNOWN, NO: NO, YES: YES, PUBLIC: PUBLIC,
    analyze: analyze, findContradiction: findContradiction, rankSuggestions: rankSuggestions,
    validateSetup: validateSetup, cardIndex: cardIndex,
    // exposed for tests
    _compile: compile, _propagate: propagate, _reduce: reduce, _popcount: popcount, _binom: binom, _makeRng: makeRng
  };
});
