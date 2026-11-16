# Crossword Slots: notes for whoever works on this next

Static site, no build step. `npm test` runs the rule tests. `npm start` serves it at http://localhost:5173.
Before every release run `node tools/stamp.mjs` (version-stamps file references so phones never mix old and new files), then commit and push to `main`; GitHub Pages serves it.

## Words
- A **game** is the whole sitting, from creating the room to settle-up (`session` in code).
- A **round** is one deal of the deck (`session.game` in code).
- **The Pocket** is the Carryover hand.

## Rules to keep
- **Sound and vibration go through `fx(name)` in `js/app.js`.** Any new game event (a new mode, a new button with a consequence, a new kind of result) gets an entry in `FX` and a trigger in `diffFx()`. Nothing new should be silent while the rest of the game makes noise.
- **Nothing advances on a timer.** Every reveal and every payout is a tap by whoever runs the round.
- **Long-term stats only count rounds between two or more people.** CPU rounds never count.
- **Balances start at $0 and show plus or minus.** There are no buy-ins or stacks.
- The host's phone runs everything. No server, no accounts, nothing that costs money.
- All money is integer cents.

## Temporary
- The five looks in `style.css` and the Look picker in the settings sheet (`THEMES` in `js/app.js`) are a tryout. Once one is chosen, delete the others and hard-code the winner.
