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
- `js/odds.js`: live win percentages and expected winnings
- `js/session.js`: the session state machine (players and phones, rules lock, dealing, discards, carryover, balances, history)
- `js/app.js`: phone UI and real-time sync
- `tests/engine.test.js`: rule tests

## House rulings (where the spec left the choice open)

- Money is counted in cents. Extra cents go to the lowest-numbered boards, and on a tied board to tied players in seat order, Carryover hand last.
- The Carryover hand and CPU players discard at the same moment as everyone else, using only the cards visible then.
- If the session ends with a carryover pot unclaimed, it is split evenly between the players of the last game.
- Slots lets the host pick 1 to 5 boards; the deck may drop it lower.
- Win percentages are true odds worked out from every hand (the host's phone knows them). In Pineapple they stay hidden until everyone has discarded. They always show when the host is the only human.
- The Carryover hand is called the Pocket.
- 5-Card Any: keep all five hole cards and play 0, 1 or 2 of them on each board.
- Phones check in as a named player and can switch. A player's seat and balance belong to the name, not the phone. Past sessions are remembered on the host's phone only.
