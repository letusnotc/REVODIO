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

  // The server just passes game messages to the other player in the room.
  socket.on('relay', (msg) => {
    if (room) socket.to(room).emit('relay', msg);
  });

  socket.on('disconnect', () => {
    if (!room) return;
    socket.to(room).emit('left');
    rooms.delete(room);
  });
});

server.listen(process.env.PORT || 3000, () => console.log(`Listening on http://localhost:${server.address().port}`));
module.exports = server;
