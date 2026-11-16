# Crossword Slots

Quintuple Pineapple Omaha Crossword 2-Card Carryover Slots Poker. A play-money bomb-pot poker game for friends on their phones. No install, no accounts.

## How it works

- Plain static site (HTML, CSS, JavaScript modules). No build step. Hosts free on GitHub Pages.
- The host's phone runs the game. Phones connect to each other directly through [PeerJS](https://peerjs.com) (free public service, no account). Each phone is only sent its own hole cards.
- The host must keep the page open. If the host's phone sleeps, everyone reconnects automatically when it wakes, and the session picks up where it was.

## Run it on this computer

```bash
npm start
```

Then open http://localhost:5173. Create a room and add CPU players to play solo.

## Tests

```bash
npm test
```

Covers hand rankings, Hold'em and Omaha rules, deck limits, splits, carryovers, balances and hole-card privacy.

## Files

- `js/engine.js`: cards, hand ranking, deck limits, pots, payouts, settle-up
- `js/session.js`: the session state machine (rules lock, dealing, discards, carryover, balances)
- `js/app.js`: phone UI and real-time sync
- `tests/engine.test.js`: rule tests

## House rulings (where the spec left the choice open)

- Money is counted in cents. Extra cents go to the lowest-numbered boards, and on a tied board to tied players in seat order, Carryover hand last.
- The Carryover hand and CPU players discard at the same moment as everyone else, using only the cards visible then.
- If the session ends with a carryover pot unclaimed, it is split evenly between the players of the last game.
- Slots lets the host pick 1 to 5 boards; the deck may drop it lower.
