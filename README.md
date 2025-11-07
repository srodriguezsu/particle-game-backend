# particle-game-backend

Node.js + Express + Socket.IO backend for a turn-based, PSO-like particle game.

This repository implements a multiplayer game server where players join rooms and each turn submit choices (alpha/beta) that influence particle velocities and positions. The server runs the PSO-like update logic in memory and broadcasts room and game state via Socket.IO.

## Features

- Socket.IO-based real-time protocol for rooms and game turns.
- In-memory room management (no persistent storage).
- Simple PSO-like update: players have positions, velocities, personal bests (pbest), and a global best (gbest).
- Minimal REST endpoints for health and room listing.
- Dockerfile included for containerized runs.

## Quick facts (from the code)

- Entry point: `server.js`
- Main dependencies: `express`, `socket.io`, `cors` (listed in `package.json`)
- Dev dependency: `nodemon` (for development)
- Default port: `process.env.PORT || 3000`
- Room storage: in-memory `Map` (no DB)
- Max players per room: 30 (configurable in code)

## Socket events

The server exposes the following Socket.IO events (client -> server):

- `create_room` (payload: { name, emoji, color, role })
  - Ack: `{ ok: true, roomCode, room }` or `{ ok: false, err }`

- `join_room` (payload: { roomCode, name, emoji, color, role })
  - Ack: `{ ok: true, room }` or `{ ok: false, err }`

- `start_game` (creator only)
  - Ack: `{ ok: true }` or `{ ok: false, err }`

- `submit_choice` (payload: { roomCode, alpha, beta })
  - Ack: `{ ok: true }` or `{ ok: false, err }`

- `advance_turn` (creator only)
  - Ack: `{ ok: true }` or `{ ok: false, err }`

- `leave_room`
  - Ack: `{ ok: true }` or `{ ok: false, err }`

Server -> client emitted events:

- `room_update` — emitted when room state changes (join, leave, gbest change, etc). Payload: serialized room state.
- `game_started` — emitted when the creator starts the game. Payload: serialized room state.
- `turn_advanced` — emitted after the server advances a turn. Payload: serialized room state.

Serialized room state structure (high level):

```
{
  id: string,
  code: string,
  creatorId: string,
  started: boolean,
  turn: number,
  gbest: { x, y, score, playerId } | null,
  players: [ { id, name, emoji, color, role, pos, vel, pbest }, ... ]
}
```

Acknowledgement responses follow the shape `{ ok: true, ... }` on success or `{ ok: false, err: 'ERROR_CODE' }` on failure.

## REST API

- `GET /` — basic health and number of rooms: `{ ok: true, rooms: <number> }`
- `GET /rooms` — lists rooms with minimal metadata: `[ { code, id, createdAt, players, started }, ... ]`

## Installation (local)

Requirements:

- Node.js 18+ recommended
- npm

From the project root:

```powershell
# install dependencies
npm install

# run in production mode
npm start

# run in development with automatic reload (requires dev dependencies)
npm run dev
```

The server listens on the port set in the `PORT` environment variable or `3000` by default.

## Running with Docker

A `Dockerfile` is provided. Note: the Dockerfile `EXPOSE`s port 8080, while the server defaults to `PORT=3000`. You can either run the container while mapping the host port to the container's default (3000) or set `PORT=8080` inside the container.

Build and run examples (PowerShell):

```powershell
# Build the image
docker build -t particle-game-backend .

# Option A: run container using the server default port (3000)
docker run -p 3000:3000 particle-game-backend

# Option B: align with Dockerfile EXPOSE (8080) by setting PORT inside the container
docker run -p 8080:8080 -e PORT=8080 particle-game-backend
```

Recommendation: either update the Dockerfile to EXPOSE 3000 or pass `-e PORT=8080` at runtime to avoid confusion.

## Environment

- PORT (optional) — TCP port the server listens on (default: 3000)

## Notes from code review / caveats

- Rooms and game state are stored in memory — if the server restarts, all rooms and state will be lost.
- CORS is set to allow all origins (`cors({ origin: '*' })`) — tighten this for production.
- `package.json` lists some dependencies (`mysql2`, `uuid`) that are not used in `server.js` as-is. Consider removing unused deps or integrating database functionality if persistent storage is desired.
- Dockerfile installs only production dependencies. For development you may want a separate Dockerfile or build step.
- Input validation is basic; production should validate all client inputs and enforce authorization.

## Suggested improvements / next steps

- Add authentication (JWT or session) so players have stable identities.
- Persist rooms and game history to a database (MySQL, Postgres, etc.). `mysql2` is already listed but not used.
- Add unit and integration tests for the game logic (e.g., advanceTurn behavior).
- Make PSO parameters (w, c1, c2) configurable per-room.
- Add logging and monitoring.

## File overview

- `server.js` — main server and game logic (Socket.IO handlers, room manager, PSO updates).
- `package.json` — npm metadata and scripts (`start`, `dev`).
- `Dockerfile` — container image build.

## Contributing

Small projects: open an issue or a PR. For larger changes (DB integration, auth), please open an issue to discuss the design.

## License

This project currently lists `ISC` in `package.json`. Confirm license choice and add a `LICENSE` file if needed.


---

If you'd like, I can:

- Update the `Dockerfile` to expose port 3000 (or make it configurable),
- Add a tiny example client (Node.js or browser) showing how to connect and use the socket events,
- Add a few tests for `advanceTurn` and `evaluatePos`.

Tell me which follow-up you'd prefer and I'll implement it next.