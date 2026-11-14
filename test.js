// Server self-check: two players join a room, a clip passes between them, a third player is refused.
process.env.PORT = 0;
const assert = require('assert');
const server = require('./server');
const { io } = require('socket.io-client');

server.once('listening', async () => {
  const url = `http://localhost:${server.address().port}`;
  const a = io(url), b = io(url);
  const code = await new Promise((r) => a.emit('create', r));
  assert.match(code, /^[A-Z]{4}$/);

  const roleA = new Promise((r) => a.once('start', r));
  const roleB = new Promise((r) => b.once('start', r));
  assert.ok((await new Promise((r) => b.emit('join', code.toLowerCase(), r))).ok);
  assert.equal(await roleA, 'recorder');
  assert.equal(await roleB, 'guesser');

  const got = new Promise((r) => b.once('relay', r));
  const samples = new Float32Array(48000 * 6).fill(0.5); // a full 6s clip must fit
  a.emit('relay', { type: 'original', audio: samples.buffer, rate: 48000, answer: 'hi' });
  const msg = await got;
  assert.equal(msg.answer, 'hi');
  assert.equal(new Float32Array(new Uint8Array(msg.audio).buffer).length, samples.length);

  assert.ok((await new Promise((r) => io(url).emit('join', code, r))).error);
  assert.ok((await new Promise((r) => io(url).emit('join', 'ZZZZ', r))).error);

  const left = new Promise((r) => b.once('left', r));
  a.disconnect();
  await left;
  console.log('All tests passed');
  process.exit(0);
});
setTimeout(() => { console.error('Timed out'); process.exit(1); }, 5000);
