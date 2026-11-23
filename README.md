# Clue Case Notes

A Clue / Cluedo solver built for your phone. You log turns as the game happens, and it tells you:

- **the exact probability** of every card being in every player's hand or in the envelope
- **when to accuse**: it marks the case solved when the answer is certain, and flags a strong lead above a threshold you set (80% by default)
- **what to suggest next**: suggestions ranked by how much they are expected to narrow down the envelope, filtered to the room you're in
- **which card to show** when you have to refute (prefers a card that player has already seen)
- **mis-taps**: if an entry contradicts earlier ones, it names that entry so you can fix it

**Want to play fair?** `notepad.html` is a separate plain notepad: the paper detective sheet on your phone. It does no math, shows no odds, and gives no advice; every mark is one you make yourself. It has ×, ✓, ? and numbered-tag pens, undo, cross-off/circle on card names, a turn log that never marks the sheet for you, scratch notes, and a Hide button that covers the screen when the phone is on the table.

Each app is one self-contained HTML file (`index.html` is the solver). There's no server and no install, and it keeps working offline once loaded. Your game autosaves on the device.

## Using it during a game

1. **Setup**: pick the edition (classic, 2016+ with Dr. Orchid, UK Cluedo, Master Detective, or your own card names), list the players clockwise in seating order, mark yourself, and tap your cards. Hand sizes fill in automatically; adjust them if some players got an extra card, or switch on the face-up-leftovers rule.
2. **Log turn**: for each suggestion, tap who suggested, the three cards, and who showed a card (or "No one"). Everyone between the suggester and the person who showed is recorded as having passed. If you made the suggestion, tap the card you were shown. The next suggester is pre-selected.
3. **Notes**: the full detective-notes grid with ✓, ×, and a % chance in every cell. Tap a card for details.
4. **Advice**: the accusation verdict, the envelope odds by category, the most likely combinations, and the best next suggestions.
5. **History**: edit or delete any entry. The solver recomputes from scratch every time.

Accusations (a wrong one rules out that exact triple) and things you saw outside a normal turn ("Saw a card") can be logged too.

## How it works, and how it compares to other solvers

Before building it I looked at how existing solvers work:

| Approach | Examples | Limitation |
|---|---|---|
| Notepad / elimination | most detective-notepad apps | misses indirect deductions |
| Logic / SAT solving | [PHochmann/Cluedo](https://github.com/PHochmann/Cluedo) (CDCL SAT solver), rsbowman/clue_sat | gives only certain facts, no odds |
| Sampled probabilities | Neller & Luo, *Mixed Logical and Probabilistic Reasoning in the Game of Clue* (ICGA Journal, 2019) | WalkSAT sampling adds error and bias |
| Suggestion advice | PHochmann's recommender (checks 5 random candidates); Iepsma (2012) information-gain player | heuristic, partial search |

This app counts exactly instead:

- **Model.** The deal is uniformly random: one card per category goes into the envelope, and the rest are dealt with known hand sizes. Each log entry is a hard constraint. A pass means the player holds none of the three cards. Showing a card means the player holds at least one of them (exactly that one, if you saw it). A wrong accusation rules out that triple.
- **Exact posterior.** Under that model, P(X | log) = (number of consistent deals where X holds) / (number of consistent deals). The engine counts consistent deals exactly with a dynamic program over players. The state is the set of cards placed so far. The last player and the envelope are resolved in closed form, and a backward pass gives every player-card probability. Opponents with no constraints yet are merged and counted with a multinomial coefficient. The player order is picked to minimize the work.
- **Logical certainty for free.** A count of zero is exact, so ✓ and × marks are proven facts. That includes deductions a paper notepad misses, such as hand-size squeezes and chains of "showed one of these three".
- **Suggestion ranking.** The engine draws thousands of *exact* uniform samples from the counting tables. For every legal suggestion it simulates who would show what and computes the expected information gain about the envelope (in bits, summed over the three categories). All 324 suggestions are scored, not a handful.
- **Large decks.** If exact counting would be too slow (e.g. Master Detective with 4+ players early on), it falls back to MCMC sampling over consistent deals and says so on screen. ✓/× marks stay exact in that mode because they come from logical propagation.

**Assumptions.** Players never make mistakes when showing or passing. When someone holds several of the suggested cards, which one they show carries no extra information. Bluffing in suggestions isn't modeled.

**Speed** (desktop Chromium, classic deck): game start is about 1 ms. A typical mid-game recompute takes 5–50 ms, and the worst cases seen in testing (early in a 5–6 player game) take about 0.2 s. The solver runs in a Web Worker, so the UI never freezes.

## Verification

- `npm test` runs the engine tests. The main check compares the exact solver with an independent **brute-force enumeration of every possible deal** on 275 random small games (2–6 players, face-up cards, accusations, noted cards). Deal counts, every probability, every certainty mark, and every triple probability must match. Other tests check that samples follow the exact posterior, that the MCMC fallback agrees with exact answers, that contradictions are pinned to the right entry, and that real deck sizes stay fast and keep the true deal possible.
- `npm run test:ui` builds both pages and drives them in headless Chromium at iPhone size, in light and dark mode: setup, logging, all tabs, conflict detection and undo, reload persistence, and the demo game. For the notepad it checks that no percentages appear and that the turn log never marks the sheet.

## Development

```
src/engine.js      solver (works in browser, Web Worker, and Node)
src/app.html       solver UI (vanilla JS, no dependencies)
src/notepad.html   plain notepad (no solver code at all)
tools/build.js     inlines the engine → index.html; copies the notepad → notepad.html (+ dist/ artifact versions)
test/              engine tests (node:test) and UI smoke tests for both apps (Playwright)
```

Run `npm run build` after editing anything in `src/`.
