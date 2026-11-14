const socket = io();
const $ = (id) => document.getElementById(id);
const $$ = (sel) => document.querySelectorAll(sel);
const ICONS = { Animals: '🐾', Food: '🍔', Countries: '🌍', Sports: '⚽', Movies: '🎬', Jobs: '💼', Objects: '🧸', Places: '📍', Actions: '🏃', Nature: '🌿' };
const TINTS = ['green', 'yellow', 'blue', 'red'];
const TURN = { record: ['Your turn to record', 'green'], guess: ['Your turn to guess', 'blue'], judge: ['Your turn to judge', 'yellow'], wait: ["Friend's turn", 'grey'], reveal: ['Round over', 'yellow'] };
const clips = {}; // slot -> { samples: Float32Array, rate }
const score = { me: 0, friend: 0 }; // points for correct guesses
let role, roomCode = '', category = '', word = '', guess = '', ctx, recorder, playing, playingBtn;

const audioCtx = () => (ctx ||= new AudioContext());

function toast(msg) {
  $('toast').textContent = msg;
  $('toast').classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('toast').classList.remove('show'), 3000);
}

// step: which of the 4 round steps is current (0 hides the tracker). turn: key of TURN.
function show(id, step = 0, turn = '') {
  $$('main > section').forEach((s) => (s.hidden = s.id !== id));
  $('steps').hidden = !step;
  $$('#steps li').forEach((li, i) => (li.className = i + 1 < step || id === 'reveal' ? 'done' : i + 1 === step ? 'current' : ''));
  const [text, tone] = TURN[turn] || ['', ''];
  $('turn').textContent = text;
  $('turn').className = `chip ${tone}`;
  $$('.cat').forEach((e) => (e.textContent = category && `${ICONS[category]} ${category}`));
  $$('.wordShow').forEach((e) => (e.textContent = word));
  $$('.guessShow').forEach((e) => (e.textContent = guess));
  $$('.scoreMe').forEach((e) => (e.textContent = score.me));
  $$('.scoreFriend').forEach((e) => (e.textContent = score.friend));
  refresh();
  window.scrollTo(0, 0);
}

function wait(title, text, step) {
  $('waitTitle').textContent = title;
  $('waitText').textContent = text;
  show('waiting', step, 'wait');
}

function refresh() {
  $$('[data-play]').forEach((b) => (b.disabled = !clips[b.dataset.play]));
  $('sendOriginal').disabled = !clips.original;
  $('sendGuess').disabled = !clips.imitation;
  $('g2').classList.toggle('done', !!clips.imitation);
  $$('.studio').forEach((s) => {
    if (s.classList.contains('recording')) return;
    const clip = clips[s.querySelector('.recBtn').dataset.slot];
    const label = s.querySelector('.micLabel');
    s.classList.toggle('has-clip', !!clip);
    label.textContent = clip ? `Got it (${(clip.samples.length / clip.rate).toFixed(1)}s). Tap the mic to redo.` : label.dataset.idle;
  });
}

// --- Lobby ---
$('createBtn').onclick = () => socket.emit('create', (code) => {
  roomCode = code;
  $('codeTiles').replaceChildren(...[...code].map((c) => Object.assign(document.createElement('span'), { textContent: c })));
  show('waitRoom');
});

function join() {
  const code = $('codeIn').value;
  if (code.length !== 4) return toast('Room codes have 4 letters.');
  socket.emit('join', code, (res) => (res.error ? toast(res.error) : (roomCode = code)));
}
$('joinBtn').onclick = join;
$('codeIn').oninput = (e) => (e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''));
// Braces matter: an on-handler that returns false blocks the keystroke.
$('codeIn').onkeydown = (e) => { if (e.key === 'Enter') join(); };

// Invite links look like /?room=ABCD and join straight away.
const invited = (new URLSearchParams(location.search).get('room') || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
if (invited) { $('codeIn').value = invited; join(); }

async function copy(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); }
  catch { toast(`Couldn't copy. The code is ${roomCode}`); }
}
$('copyLink').onclick = () => copy(`${location.origin}/?room=${roomCode}`, 'Invite link copied!');
$('copyCode').onclick = () => copy(roomCode, 'Code copied!');

socket.on('start', (r) => {
  role = r;
  $('roomCode').textContent = roomCode;
  $('gameInfo').hidden = false;
  history.replaceState(null, '', '/');
  newRound();
});
socket.on('left', () => { toast('Your friend left the game.'); setTimeout(() => (location.href = '/'), 2500); });
$('leaveBtn').onclick = () => (location.href = '/');

function newRound() {
  for (const k in clips) delete clips[k];
  category = word = guess = $('guessIn').value = '';
  $$('.step-card').forEach((c) => c.classList.remove('done'));
  if (role === 'recorder') pickView();
  else wait('Your friend is picking a word', "You'll hear it backwards in a moment. Get ready to copy it!", 1);
}

// --- Picking a word ---
Object.keys(WORDS).forEach((c, i) => {
  const b = document.createElement('button');
  b.className = 'cat-card';
  b.innerHTML = `<span class="cat-icon ${TINTS[i % 4]}">${ICONS[c]}</span><span class="cat-name">${c}</span><span class="cat-count">${WORDS[c].length} words</span>`;
  b.onclick = () => pick(c);
  $('cats').append(b);
});

function pickView() {
  category = word = '';
  delete clips.original;
  $('pickView').hidden = false;
  $('sayView').hidden = true;
  show('recordStep', 1, 'record');
}
$('changeCat').onclick = pickView;

function pick(c) {
  const list = WORDS[c];
  let w;
  do w = list[(Math.random() * list.length) | 0];
  while (w === word && list.length > 1); // Skip never repeats the same word
  category = c;
  word = w;
  delete clips.original; // the old recording no longer matches the word
  $('wordOut').textContent = word;
  $('pickView').hidden = true;
  $('sayView').hidden = false;
  show('recordStep', 2, 'record');
}
$('skipBtn').onclick = () => pick(category);

// --- Messages from the other player ---
socket.on('relay', (msg) => {
  if (msg.type === 'original') {
    clips.original = { samples: new Float32Array(msg.audio), rate: msg.rate };
    category = msg.category; // the word itself is only sent with the verdict, so the guesser can't peek
    show('imitateStep', 3, 'guess');
  } else if (msg.type === 'result') {
    clips.imitation = { samples: new Float32Array(msg.audio), rate: msg.rate };
    guess = msg.guess;
    show('judgeStep', 4, 'judge');
  } else if (msg.type === 'verdict') {
    word = msg.word;
    reveal(msg.correct);
  } else if (msg.type === 'next') next();
});

// --- Recording ---
$$('.recBtn').forEach((btn) => (btn.onclick = async () => {
  if (recorder) return recorder.stop();
  audioCtx().resume();
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
  catch { return toast('Allow microphone access to play.'); }
  const studio = btn.closest('.studio');
  const chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.onstop = async () => {
    clearTimeout(timer);
    stream.getTracks().forEach((t) => t.stop());
    recorder = null;
    studio.classList.remove('recording');
    btn.setAttribute('aria-label', 'Record');
    // Decode here and send raw samples, so the other browser never has to decode our codec (Safari vs Chrome).
    try {
      const decoded = await audioCtx().decodeAudioData(await new Blob(chunks).arrayBuffer());
      clips[btn.dataset.slot] = { samples: decoded.getChannelData(0).slice(), rate: decoded.sampleRate };
    } catch {
      toast('That recording did not work. Please try again.');
    }
    refresh();
  };
  recorder.start();
  const timer = setTimeout(() => recorder && recorder.stop(), 6000);
  studio.classList.add('recording');
  studio.querySelector('.micLabel').textContent = 'Recording… tap to stop';
  btn.setAttribute('aria-label', 'Stop recording');
}));

// --- Playback (the reverse is just flipping the samples) ---
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-play]');
  if (!b || b.disabled) return;
  const clip = clips[b.dataset.play];
  const c = audioCtx();
  c.resume();
  const buf = c.createBuffer(1, clip.samples.length, clip.rate);
  buf.copyToChannel(b.hasAttribute('data-rev') ? clip.samples.slice().reverse() : clip.samples, 0);
  playing?.stop();
  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(c.destination);
  src.onended = () => b.classList.remove('playing');
  src.start();
  playing = src;
  playingBtn?.classList.remove('playing');
  playingBtn = b;
  b.classList.add('playing');
  b.closest('.step-card')?.classList.add('done');
});

// --- Sending ---
$('sendOriginal').onclick = () => {
  const { samples, rate } = clips.original;
  socket.emit('relay', { type: 'original', audio: samples.buffer, rate, category });
  wait('Sent! Your friend is on it', "They're listening to your word backwards and copying it.", 3);
};

function sendGuess() {
  if (!clips.imitation) return toast('Record your copy first (step 2).');
  guess = $('guessIn').value.trim();
  if (!guess) { $('guessIn').focus(); return toast('Type your guess first.'); }
  const { samples, rate } = clips.imitation;
  socket.emit('relay', { type: 'result', audio: samples.buffer, rate, guess });
  wait('Guess sent!', 'Your friend is checking if you got it.', 4);
}
$('sendGuess').onclick = sendGuess;
$('guessIn').onkeydown = (e) => { if (e.key === 'Enter') sendGuess(); };

// --- Judging (recorder) and reveal (both) ---
function judge(correct) {
  socket.emit('relay', { type: 'verdict', correct, word });
  reveal(correct);
}
$('rightBtn').onclick = () => judge(true);
$('wrongBtn').onclick = () => judge(false);

function reveal(correct) {
  const iGuessed = role === 'guesser';
  if (correct) iGuessed ? score.me++ : score.friend++;
  $('banner').className = `banner ${correct ? 'win' : 'lose'}`;
  $('bannerIcon').textContent = correct ? '✓' : '✕';
  $('verdict').textContent = correct ? (iGuessed ? 'You cracked it!' : 'They cracked it!') : (iGuessed ? 'Not quite!' : 'They missed it!');
  $('verdictSub').textContent = correct ? '+1 point to the guesser' : 'No point this round.';
  $('nextHint').textContent = `Next round you ${iGuessed ? 'record' : 'guess'}.`;
  show('reveal', 4, 'reveal');
}

$('nextBtn').onclick = () => { socket.emit('relay', { type: 'next' }); next(); };
function next() {
  if ($('reveal').hidden) return; // ignore if both players pressed Next at once
  role = role === 'recorder' ? 'guesser' : 'recorder';
  newRound();
}
