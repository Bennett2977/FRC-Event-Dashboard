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

## Requirements

- [The Blue Alliance API key](https://www.thebluealliance.com/account) (free)
- Docker + Docker Compose

## Quick Start

1. Copy `.env.example` to `.env` and fill in your key:
   ```
   TBA_API_KEY=your_key_here
   ```

2. Run locally:
   ```bash
   docker compose up --build
   ```
   Open [http://localhost:8080](http://localhost:8080)

## Production Deployment

Uses `docker-compose.prod.yml`, which builds directly from the GitHub repo and connects to an external `robotics_apps` Docker network:

```bash
TBA_API_KEY=... docker compose -f docker-compose.prod.yml up -d
```

## How It Works

The app is a single `index.html` file served by nginx. API keys are injected at container startup via `docker-entrypoint.sh` into a `config.js` file that the page loads at runtime — no build step required.

## License

GNU General Public License v3.0 — see [LICENSE](LICENSE).
