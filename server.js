const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
// A 6-second clip is ~1.2 MB of raw samples, so allow 3 MB per message.
const io = new Server(server, { maxHttpBufferSize: 3e6 });

const rooms = new Map(); // room code -> [socket ids]
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newCode() {
  let code;
  do code = Array.from({ length: 4 }, () => LETTERS[(Math.random() * LETTERS.length) | 0]).join('');
  while (rooms.has(code));
  return code;
}

// --- Abuse limits ---
// shortcut: limits live in this one process's memory; move them to a shared store if you ever run several instances.
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, h] of hits) if (h.reset < now) hits.delete(k); }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    let h = hits.get(key);
    if (!h || h.reset < now) hits.set(key, (h = { n: 0, reset: now + windowMs }));
    return ++h.n <= max;
  };
}
const joinLimit = limiter(10, 60_000); // per IP: makes guessing room codes impractical
const relayLimit = limiter(30, 10_000); // per player: a round needs about 4 messages
const MAX_CONNECTIONS_PER_IP = 10;
const connections = new Map(); // ip -> open sockets
// Render sits behind Cloudflare, which sets cf-connecting-ip to the real client address.
const ipOf = (socket) => socket.handshake.headers['cf-connecting-ip'] || socket.handshake.address;

io.use((socket, next) => {
  const ip = ipOf(socket);
  const open = connections.get(ip) || 0;
  if (open >= MAX_CONNECTIONS_PER_IP) return next(new Error('Too many open games from your network.'));
  connections.set(ip, open + 1);
  socket.on('disconnect', () => {
    const left = connections.get(ip) - 1;
    left > 0 ? connections.set(ip, left) : connections.delete(ip);
  });
  next();
});

// --- Message validation: only pass on known message types with sane fields ---
const isText = (s, max) => typeof s === 'string' && s.length <= max;
const isClip = (m) => Buffer.isBuffer(m.audio) && m.audio.length > 0 && m.audio.length % 4 === 0
  && Number.isInteger(m.rate) && m.rate >= 8000 && m.rate <= 192000;
function clean(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.type === 'original' && isClip(m) && isText(m.category, 30)) return { type: m.type, audio: m.audio, rate: m.rate, category: m.category };
  if (m.type === 'result' && isClip(m) && isText(m.guess, 100)) return { type: m.type, audio: m.audio, rate: m.rate, guess: m.guess };
  if (m.type === 'verdict' && typeof m.correct === 'boolean' && isText(m.word, 100)) return { type: m.type, correct: m.correct, word: m.word };
  if (m.type === 'next') return { type: 'next' };
  return null;
}

io.on('connection', (socket) => {
  let room = null;

  socket.on('create', (ack) => {
    if (typeof ack !== 'function' || room) return;
    room = newCode();
    rooms.set(room, [socket.id]);
    socket.join(room);
    ack(room);
  });

  socket.on('join', (code, ack) => {
    if (typeof ack !== 'function' || room) return;
    if (!joinLimit(ipOf(socket))) return ack({ error: 'Too many tries. Wait a minute and try again.' });
    code = String(code || '').trim().toUpperCase();
    const players = rooms.get(code);
    if (!players) return ack({ error: 'No room with that code.' });
    if (players.length !== 1) return ack({ error: 'That room is full.' });
    room = code;
    players.push(socket.id);
    socket.join(room);
    ack({ ok: true });
    io.to(players[0]).emit('start', 'recorder');
    socket.emit('start', 'guesser');
  });

  // Pass game messages to the other player, dropping floods and malformed messages.
  socket.on('relay', (msg) => {
    if (!room || !relayLimit(socket.id)) return;
    const safe = clean(msg);
    if (safe) socket.to(room).emit('relay', safe);
  });

  socket.on('disconnect', () => {
    if (!room) return;
    socket.to(room).emit('left');
    rooms.delete(room);
  });
});

server.listen(process.env.PORT || 3000, () => console.log(`Listening on http://localhost:${server.address().port}`));
module.exports = server;
