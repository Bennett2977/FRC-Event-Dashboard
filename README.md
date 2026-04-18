# FRC Event Dashboard

A live leaderboard for tracking multiple FRC events simultaneously. Displays schedule adherence, cycle times, qualification progress, playoff status, and webcasts — all sourced from [The Blue Alliance](https://www.thebluealliance.com) API.

## Features

- Track any number of active FRC events side-by-side
- Live schedule delta (ahead/behind in minutes) for quals and playoffs
- Qual completion percentage with playoff transition detection
- Average actual vs. scheduled cycle times (breaks excluded)
- Event high score with alliance breakdown, linked to match on TBA
- Webcast and public agenda links per event
- Sort by schedule adherence, completion %, or high score
- ETag caching to minimize TBA API load
- Light/dark adaptive UI

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE).
