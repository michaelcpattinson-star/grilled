# Grilled 🔥

Live party quizzes about the guest of honour, built from stories their mates secretly submit. Hen dos, stag dos, big birthdays, leaving dos. No accounts, no AI APIs, free to run.

How it works: create an event → share the secret submission link in the group chat → friends anonymously spill the dirt → the template engine turns it into a pub-quiz (Whose Story Is This?, Three Truths and a Lie, Finish the Sentence, How Well Do You Know Them?) → you approve/edit/bin every question → on the night, the host screen goes on the TV and everyone plays from their phones with a 4-letter code.

## Run it

Requires Node 20+.

```
npm install
npm start          # → http://localhost:3000
npm test           # 47 tests: engine, API, game (incl. multi-client socket game)
```

Try it instantly: open the site and hit **Try the demo** — a pre-seeded event for a fictional guest ("Gary") that's ready to moderate and play. To feel the real thing, open the host link on a laptop and join from a couple of phones on the same network using the game code.

## Deploy free (when ready)

Any free Node host with websockets and a disk works. On Render: New → Web Service → connect the repo, build `npm install`, start `npm start`, add a persistent disk and set `DB_PATH` to a file on it (e.g. `/data/grilled.db`). Free instances sleep when idle and take ~30–60s to wake — open the dashboard before the guests arrive. `PORT` is respected automatically.

## The company docs

The `docs/` folder is the paper trail of the multi-agent build: `VISION.md` (CEO), `SPEC.md` (CPO), `ARCHITECTURE.md` (Head of Eng), `CONTRACTS.md` (interface contracts the parallel engineers built against), `TASKS.md` (PM), `TEST_REPORT.md` (QA — verdict, issue tracker, all findings fixed).

## Notes

- Auth is capability URLs: the organiser link *is* the account. Bookmark it; it can't be recovered.
- Events auto-delete 30 days after creation.
- Everything renders user content via `textContent` — never `innerHTML`. Keep it that way; submissions are written by drunk mates and should be treated as hostile input with a sense of humour.
