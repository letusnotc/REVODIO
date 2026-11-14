// Server self-check: rooms, relaying, message validation and abuse limits.
process.env.PORT = 0;
const assert = require('assert');
const server = require('./server');
const { io } = require('socket.io-client');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (s, ev, ...args) => new Promise((r) => s.emit(ev, ...args, r));

server.once('listening', async () => {
  const url = `http://localhost:${server.address().port}`;
  const open = [];
  const connect = () => { const s = io(url, { reconnection: false }); open.push(s); return s; };

  // Two players join a room and get roles.
  const a = connect(), b = connect();
  const code = await ask(a, 'create');
  assert.match(code, /^[A-Z]{4}$/);
  const roleA = new Promise((r) => a.once('start', r));
  const roleB = new Promise((r) => b.once('start', r));
  assert.ok((await ask(b, 'join', code.toLowerCase())).ok);
  assert.equal(await roleA, 'recorder');
  assert.equal(await roleB, 'guesser');

  const got = [];
  b.on('relay', (m) => got.push(m));

  // A full 6s clip gets through, with extra fields stripped.
  const samples = new Float32Array(48000 * 6).fill(0.5);
  a.emit('relay', { type: 'original', audio: samples.buffer, rate: 48000, category: 'Food', sneaky: 'x' });
  await wait(200);
  assert.equal(got.length, 1);
  assert.equal(got[0].category, 'Food');
  assert.equal(got[0].sneaky, undefined);
  assert.equal(new Float32Array(new Uint8Array(got[0].audio).buffer).length, samples.length);

  // Malformed messages are dropped (fix #2: a fake "clip" can no longer freeze the other tab).
  a.emit('relay', { type: 'original', audio: 1e9, rate: 48000, category: 'Food' });
  a.emit('relay', { type: 'original', audio: new ArrayBuffer(8), rate: 1e12, category: 'Food' });
  a.emit('relay', { type: 'result', audio: new ArrayBuffer(8), rate: 48000, guess: 'x'.repeat(5000) });
  a.emit('relay', { type: 'verdict', correct: 'yes', word: 'cat' });
  a.emit('relay', { type: 'evil' });
  a.emit('relay', 'not an object');
  a.emit('relay', { type: 'next' });
  await wait(200);
  assert.deepEqual(got.slice(1).map((m) => m.type), ['next']);

  // Floods are capped (fix #3): 30 messages per 10s per player. 8 were sent above (1 of them a 'next'),
  // so 22 of these 40 get through: 23 'next' messages in total.
  for (let i = 0; i < 40; i++) a.emit('relay', { type: 'next' });
  await wait(300);
  const nexts = got.filter((m) => m.type === 'next').length;
  assert.equal(nexts, 23, `expected 23 'next' messages through, got ${nexts}`);

  // A third player is refused, unknown codes fail.
  assert.ok((await ask(connect(), 'join', code)).error);
  assert.ok((await ask(connect(), 'join', 'ZZZZ')).error);

  // Code guessing is rate limited per IP (fix #1): 10 join attempts a minute, 3 used so far.
  const guesser = connect();
  const answers = [];
  for (let i = 0; i < 8; i++) answers.push((await ask(guesser, 'join', 'ZZZZ')).error);
  assert.match(answers.at(-1), /Too many tries/);
  assert.ok(!answers.slice(0, 7).some((e) => /Too many/.test(e)));

  // Connections per IP are capped at 10 (fix #3). 5 are open now.
  await wait(100);
  const extra = [];
  for (let i = 0; i < 6; i++) extra.push(connect());
  const results = await Promise.all(extra.map((s) => new Promise((r) => {
    s.once('connect', () => r('ok'));
    s.once('connect_error', (e) => r(e.message));
  })));
  assert.deepEqual(results.slice(0, 5), ['ok', 'ok', 'ok', 'ok', 'ok']);
  assert.match(results[5], /Too many open games/);

  // Leaving tells the other player.
  const left = new Promise((r) => b.once('left', r));
  a.disconnect();
  await left;

  open.forEach((s) => s.disconnect());
  console.log('All tests passed');
  process.exit(0);
});
setTimeout(() => { console.error('Timed out'); process.exit(1); }, 8000);
