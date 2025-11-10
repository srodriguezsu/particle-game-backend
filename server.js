// javascript
/**
 * server.js
 * - Express and Socket.IO server for turn-based PSO-like game
 * - Rooms in memory (no persistent history)
 *
 * Events (socket) RECEIVED from clients:
 *  - create_room { name, emoji, color, role } -> ack { ok, roomCode, room }
 *  {
 *     "name": "Tyler the creator",
 *     "emoji": "A",
 *     "color": "#FFFF",
 *     "role": "player"
 * }
 *  - join_room { roomCode, name, emoji, color, role } -> ack { ok, room }
 *  {
 *     "roomCode": "382718",
 *     "name": "Sebas",
 *     "emoji": ".",
 *     "color": "#FFFF",
 *     "role": "player"
 * }
 *  - start_game (creator only) -> ack { ok }
 *  - submit_choice { roomCode, c1(0-5), c2(0-5) } -> ack { ok }
 *  {
 *     "roomCode": "382718",
 *     "c1": 2,
 *     "c2": 3
 * }
 *  - advance_turn (creator only) -> ack { ok }
 *  - leave_room -> ack { ok }
 *
 * Emitted socket events (server -> clients):
 *  - room_update
 *      Descripción: Notifica cambios en la sala (nuevo jugador, salida, actualización de meta).
 *      Cuándo se emite: tras create_room, join_room, leave_room, disconnect, y cuando cambia el gbest.
 *      Payload: serializeRoomState(room)
 *          {
 *            id: string,
 *            code: string,
 *            creatorId: string,
 *            started: boolean,
 *            turn: number,
 *            gbest: { x: number, y: number, score: number, playerId: string } | null,
 *            players: [
 *              {
 *                id: string,
 *                name: string,
 *                emoji: string,
 *                color: string,
 *                role: 'player'|'spectator',
 *                pos: { x: number, y: number },
 *                vel: { x: number, y: number },
 *                pbest: { x: number, y: number, score: number }
 *              },
 *              ...
 *            ]
 *          }
 *
 *  - game_started
 *      Descripción: Indica que el creador ha iniciado la partida.
 *      Cuándo se emite: cuando el creador llama a start_game.
 *      Payload: serializeRoomState(room) (igual que arriba)
 *
 *  - turn_advanced
 *      Descripción: Estado resultante después de que el servidor avance un turno (posición/velocidades actualizadas).
 *      Cuándo se emite: tras advance_turn (solo por el creador).
 *      Payload: serializeRoomState(room) (igual que arriba)
 *
 * Acknowledgements (shape de las respuestas vía ack):
 *  - Respuesta genérica de éxito: { ok: true, ...payload }
 *  - Respuesta de error: { ok: false, err: 'ERROR_CODE' }
 *
 * REST endpoints (mínimos):
 *  - GET /       -> { ok: true, rooms: number }
 *  - GET /rooms  -> [ { code, id, createdAt, players, started }, ... ]
 *
 * Nota de seguridad:
 *  - Validar inputs en producción y restringir CORS según dominios permitidos.
 */

const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const { randomUUID } = require('crypto')

const cors = require('cors')

const app = express()
app.use(cors({origin: '*'}));
const server = http.createServer(app)
const io = new Server(server, {
    cors: { origin: '*' }
})

const PORT = process.env.PORT || 3001

/* ---------- Helper utilities ---------- */

function make6DigitCode() {
    // generate numeric 6-digit code not starting with 0
    return String(Math.floor(100000 + Math.random() * 900000))
}

function now() { return Date.now() }

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)) }

/* ---------- In-memory room manager ---------- */

const rooms = new Map() // map roomCode -> room object

function createRoom(creatorSocket, creatorInfo) {
    let code
    // ensure uniqueness simple loop
    do { code = make6DigitCode() } while (rooms.has(code))

    const room = {
        id: randomUUID(),
        code,
        creatorId: creatorSocket.id,
        createdAt: now(),
        started: false,
        turn: 0,
        maxPlayers: 30,
        players: new Map(), // socket.id -> playerObj (includes spectators)
        spectators: new Set(), // socket.id of spectators (redundant but handy)
        // global best:
        gbest: null // {x,y,score,playerId}
    }

    // create initial player entry for creator
    const p = makePlayerObject(creatorSocket.id, creatorInfo)
    room.players.set(creatorSocket.id, p)
    if (p.role === 'spectator') room.spectators.add(creatorSocket.id)

    rooms.set(code, room)
    return room
}

function makePlayerObject(socketId, info = {}) {
    // default random start pos in [-10,10]// default random start pos in [-100,100]
    const defaultPos = { x: (Math.random() * 200 - 100), y: (Math.random() * 200 - 100) }
    return {
        id: socketId,
        name: info.name || 'Anon',
        emoji: info.emoji || '🙂',
        color: info.color || '#'+Math.floor(Math.random()*16777215).toString(16).padStart(6,'0'),
        role: info.role === 'spectator' ? 'spectator' : 'player',
        pos: info.pos || defaultPos,
        vel: info.vel || { x: 0, y: 0 },
        pbest: { ... (info.pos || defaultPos), score: evaluatePos(info.pos || defaultPos) },
        pendingChoice: null, // { c1, c2, w }
        lastSeen: now()
    }
}

/* ---------- PSO / scoring function ---------- */

// Example objective function f(x,y) to minimize
// You can replace this for any multimodal function
function evaluatePos(pos) {
    // simple Rastrigin-like mixture (for demo)
    const x = pos.x, y = pos.y
    const A = 10
    return 2*A + (x*x - A * Math.cos(2*Math.PI*x)) + (y*y - A * Math.cos(2*Math.PI*y))
}

/* ---------- Core operations ---------- */

function joinRoom(socket, roomCode, joinInfo) {
    const room = rooms.get(roomCode)
    if (!room) return { ok: false, err: 'ROOM_NOT_FOUND' }
    if (room.players.size >= room.maxPlayers && joinInfo.role !== 'spectator') {
        return { ok: false, err: 'ROOM_FULL' }
    }

    // If socket already in room, update info
    const existing = room.players.get(socket.id)
    if (existing) {
        // update metadata
        existing.name = joinInfo.name || existing.name
        existing.emoji = joinInfo.emoji || existing.emoji
        existing.color = joinInfo.color || existing.color
        existing.role = room.started ? 'spectator' : 'player'
        if (existing.role === 'spectator') room.spectators.add(socket.id)
    } else {
        // new player
        const p = makePlayerObject(socket.id, joinInfo)
        room.players.set(socket.id, p)
        if (p.role === 'spectator') room.spectators.add(socket.id)
    }

    // update gbest if needed
    updateRoomGbest(room)

    return { ok: true, room }
}

function leaveRoom(socket, roomCode) {
    const room = rooms.get(roomCode)
    if (!room) return
    room.players.delete(socket.id)
    room.spectators.delete(socket.id)
    if (socket.id === room.creatorId) {
        // if creator leaves, choose a new creator (first player) or close room if empty
        const first = Array.from(room.players.keys())[0]
        if (first) room.creatorId = first
        else rooms.delete(roomCode)
    }
    if (room.players.size === 0) rooms.delete(roomCode)
    else updateRoomGbest(room)
}

function updateRoomGbest(room) {
    let best = null
    for (const [id, p] of room.players) {
        if (p.role === 'spectator') continue
        if (!best || p.pbest.score < best.score) {
            best = { x: p.pbest.x ?? p.pbest.pos?.x ?? p.pos.x, y: p.pbest.y ?? p.pbest.pos?.y ?? p.pos.y, score: p.pbest.score, playerId: id }
        }
    }
    room.gbest = best
}

/* ---------- Game step: advance turn ---------- */

function advanceTurn(roomCode) {
    const room = rooms.get(roomCode)
    if (!room) return { ok: false, err: 'ROOM_NOT_FOUND' }

    if (!room.started) return { ok: false, err: 'NOT_STARTED' }

    room.turn += 1
    const dt = 1.0
    for (const [id, p] of room.players) {
        if (p.role === 'spectator') continue
        const choice = p.pendingChoice || { w: 0.7, c1: 2, c2: 2 } // default if didn't send
        // translate c1/c2 (0..5) to c1/c2 numeric multipliers
        const c1 = clamp(choice.c1, 0, 2.5)
        const c2 = clamp(choice.c2, 0, 2.5)
        const w = clamp(choice.w, 0, 2.5)

        // internal pbest pos
        const pbestPos = { x: p.pbest.x ?? p.pos.x, y: p.pbest.y ?? p.pos.y }
        const gbestPos = room.gbest ? { x: room.gbest.x, y: room.gbest.y } : p.pos

        // velocity update (vector)
        const toPbest = { x: pbestPos.x - p.pos.x, y: pbestPos.y - p.pos.y }
        const toGbest = { x: gbestPos.x - p.pos.x, y: gbestPos.y - p.pos.y }

        const newVel = {
            x: w * p.vel.x + c1 * toPbest.x + c2 * toGbest.x,
            y: w * p.vel.y + c1 * toPbest.y + c2 * toGbest.y
        }

        // position update
        const newPos = {
            x: p.pos.x + newVel.x * dt,
            y: p.pos.y + newVel.y * dt
        }

        // keep inside [-100,100]
        newPos.x = clamp(newPos.x, -100, 100)
        newPos.y = clamp(newPos.y, -100, 100)

        // assign
        p.vel = newVel
        p.pos = newPos

        // evaluate and update pbest
        const score = evaluatePos(newPos)
        if (score < (p.pbest.score ?? Infinity)) {
            p.pbest = { x: newPos.x, y: newPos.y, score }
        }

        // clear pending choice for next round
        p.pendingChoice = null
        p.lastSeen = now()
    }

    // recalc gbest
    updateRoomGbest(room)

    // prepare broadcast state
    const broadcastState = serializeRoomState(room)
    return { ok: true, state: broadcastState }
}

function serializeRoomState(room) {
    // prepare a reduced view of room to send to clients
    const players = []
    for (const [id, p] of room.players) {
        players.push({
            id: p.id,
            name: p.name,
            emoji: p.emoji,
            color: p.color,
            role: p.role,
            pos: p.pos,
            vel: p.vel,
            pbest: { x: p.pbest.x, y: p.pbest.y, score: p.pbest.score },
            pendingChoice: p.pendingChoice
        })
    }
    return {
        id: room.id,
        code: room.code,
        creatorId: room.creatorId,
        started: room.started,
        turn: room.turn,
        gbest: room.gbest,
        players
    }
}

/* ---------- Socket.IO handlers ---------- */

io.on('connection', socket => {
    console.log('socket connected', socket.id)

    socket.on('create_room', (payload, ack) => {
        try {
            console.log('create_room', payload)
            const info = {
                name: payload?.name,
                emoji: payload?.emoji,
                color: payload?.color,
                role: payload?.role
            }
            const room = createRoom(socket, info)
            socket.join(room.code)
            // attach currentRoom on socket for convenience
            socket.data.roomCode = room.code
            socket.data.playerInfo = info
            // reply
            ack?.({ ok: true, roomCode: room.code, room: serializeRoomState(room) })
            // broadcast update to room (only creator now)
            io.to(room.code).emit('room_update', serializeRoomState(room))
        } catch (err) {
            console.error(err)
            ack?.({ ok: false, err: 'CREATE_FAILED' })
        }
    })

    socket.on('join_room', (payload, ack) => {
        try {
            console.log('join_room', payload)
            const { roomCode, name, emoji, color, role } = payload || {}
            const res = joinRoom(socket, roomCode, { name, emoji, color, role })
            if (!res.ok) return ack?.(res)
            socket.join(roomCode)
            socket.data.roomCode = roomCode
            socket.data.playerInfo = { name, emoji, color, role }
            const room = res.room
            // send the full state to the joiner
            ack?.({ ok: true, room: serializeRoomState(room) })
            // notify room
            io.to(roomCode).emit('room_update', serializeRoomState(room))
        } catch (err) {
            console.error(err)
            ack?.({ ok: false, err: 'JOIN_FAILED' })
        }
    })

    socket.on('start_game', (payload, ack) => {
        const roomCode = socket.data.roomCode
        const room = rooms.get(roomCode)
        if (!room) return ack?.({ ok: false, err: 'ROOM_NOT_FOUND' })
        if (socket.id !== room.creatorId) return ack?.({ ok: false, err: 'NOT_CREATOR' })
        room.started = true
        room.turn = 1
        // broadcast
        const state = serializeRoomState(room)
        console.log('game started', state)
        io.to(roomCode).emit('game_started', state)
        ack?.({ ok: true })
    })

    socket.on('submit_choice', (payload, ack) => {
        const roomCode = socket.data.roomCode
        const room = rooms.get(roomCode)
        if (!room) return ack?.({ ok: false, err: 'ROOM_NOT_FOUND' })
        const p = room.players.get(socket.id)
        if (!p) return ack?.({ ok: false, err: 'PLAYER_NOT_IN_ROOM' })
        if (p.role === 'spectator') return ack?.({ ok: false, err: 'SPECTATOR_CANNOT_PLAY' })

        const c1 = Number(payload?.c1)
        const c2 = Number(payload?.c2)
        const w = Number(payload?.w)
        if (Number.isNaN(c1) || Number.isNaN(c2)) return ack?.({ ok: false, err: 'BAD_INPUT' })
        // clamp to 0..5 and integer
        p.pendingChoice = {
            c1: clamp(c1, 0, 2.5),
            c2: clamp(c2, 0, 2.5),
            w: clamp(w, 0, 2.5),
        }
        io.to(roomCode).emit('room_update', serializeRoomState(room))
        ack?.({ ok: true })
    })

    socket.on('advance_turn', (payload, ack) => {
        const roomCode = socket.data.roomCode
        const room = rooms.get(roomCode)
        if (!room) return ack?.({ ok: false, err: 'ROOM_NOT_FOUND' })
        if (socket.id !== room.creatorId) return ack?.({ ok: false, err: 'NOT_CREATOR' })

        const res = advanceTurn(roomCode)
        if (!res.ok) return ack?.(res)
        // broadcast new state
        io.to(roomCode).emit('turn_advanced', res.state)
        ack?.({ ok: true })
    })

    socket.on('leave_room', (payload, ack) => {
        const roomCode = socket.data.roomCode
        if (roomCode) {
            leaveRoom(socket, roomCode)
            socket.leave(roomCode)
            delete socket.data.roomCode
            ack?.({ ok: true })
            // broadcast update if room still exists
            const room = rooms.get(roomCode)
            if (room) io.to(roomCode).emit('room_update', serializeRoomState(room))
        } else {
            ack?.({ ok: false, err: 'NOT_IN_ROOM' })
        }
    })

    socket.on('disconnect', reason => {
        // cleanup: if socket was in a room, remove
        const roomCode = socket.data.roomCode
        if (roomCode) {
            leaveRoom(socket, roomCode)
            const room = rooms.get(roomCode)
            if (room) io.to(roomCode).emit('room_update', serializeRoomState(room))
        }
        console.log('socket disconnected', socket.id, reason)
    })
})

/* ---------- Minimal REST endpoints for health / quick testing ---------- */

app.get('/', (req, res) => {
    res.send({ ok: true, rooms: rooms.size })
})

app.get('/rooms', (req, res) => {
    const list = Array.from(rooms.values()).map(r => ({ code: r.code, id: r.id, createdAt: r.createdAt, players: r.players.size, started: r.started }))
    res.send(list)
})

/* ---------- Start server ---------- */

server.listen(PORT, () => {
    console.log(`Server listening on :${PORT}`)
})
