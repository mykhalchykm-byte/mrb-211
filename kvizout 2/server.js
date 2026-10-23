// Квізоут — сервер. Node.js + WebSocket (пакет "ws").
// Запуск: npm install && npm start
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
// Код доступу для вчителя. Можна змінити: TEACHER_CODE=ABC123 npm start
const TEACHER_CODE = (process.env.TEACHER_CODE || 'MRB211').toUpperCase();

/* ---------- Статичні файли (лише дозволений список) ---------- */
const ROUTES = {
  '/': 'index.html',          // вибір: учень чи вчитель
  '/student': 'student.html', // сторінка учня
  '/teacher': 'teacher.html', // сторінка вчителя
  '/style.css': 'style.css'
};

/* ---------- Перевірка коду вчителя (на сервері) ---------- */
const failures = new Map(); // ip -> { n, until }
function checkCode(ip, code) {
  const f = failures.get(ip) || { n: 0, until: 0 };
  if (Date.now() < f.until) return 'blocked';
  const a = Buffer.from(String(code || '').trim().toUpperCase());
  const b = Buffer.from(TEACHER_CODE);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) { failures.delete(ip); return 'ok'; }
  f.n++;
  if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; } // 5 помилок — пауза 1 хв
  failures.set(ip, f);
  return 'bad';
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = ROUTES[url];
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(path.join(PUBLIC, file), (err, data) => {
    if (err) { res.writeHead(500); return res.end('Server error'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] });
    res.end(data);
  });
});

/* ---------- Ігрові кімнати ---------- */
const games = new Map(); // pin -> game
const MAX_PLAYERS = 200;
const GRACE_MS = 400;    // запас часу на мережеву затримку

const rid = () => crypto.randomBytes(8).toString('hex');
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

function newPin() {
  let pin;
  do { pin = String(Math.floor(100000 + Math.random() * 900000)); } while (games.has(pin));
  return pin;
}

function lanUrls() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) out.push(`http://${i.address}:${PORT}`);
    }
  }
  return out;
}

/* Перевірка вікторини, яку надіслав викладач */
function cleanQuiz(q) {
  if (!q || typeof q !== 'object' || !Array.isArray(q.questions)) return null;
  if (q.questions.length < 1 || q.questions.length > 100) return null;
  const questions = [];
  for (const x of q.questions) {
    if (!x || typeof x.text !== 'string' || !Array.isArray(x.answers)) return null;
    const answers = x.answers.map(a => String(a).trim().slice(0, 120));
    if (answers.length < 2 || answers.length > 4 || answers.some(a => !a)) return null;
    const correct = Number(x.correct);
    if (!Number.isInteger(correct) || correct < 0 || correct >= answers.length) return null;
    const time = Math.min(120, Math.max(5, Number(x.time) || 20));
    questions.push({ text: x.text.trim().slice(0, 300), answers, correct, time });
  }
  return { title: String(q.title || 'Вікторина').slice(0, 80), questions };
}

function leaderboard(game) {
  return [...game.players.values()]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ id: p.id, name: p.name, score: p.score, gain: p.gain, rank: i + 1 }));
}

function playerList(game) {
  return [...game.players.values()].map(p => ({ id: p.id, name: p.name, online: !!p.ws }));
}

function sendToPlayers(game, fn) {
  for (const p of game.players.values()) if (p.ws) send(p.ws, fn(p));
}

/* Поточний стан для вчителя / учня (використовується при (пере)підключенні) */
function teacherState(game) {
  const base = { t: 'state', pin: game.pin, phase: game.phase, title: game.quiz.title,
                 players: playerList(game), total: game.quiz.questions.length };
  if (game.phase === 'question') {
    const q = game.quiz.questions[game.qi];
    base.question = { index: game.qi, text: q.text, answers: q.answers, time: q.time,
                      left: Math.max(0, game.endsAt - Date.now()) };
    base.answered = answerProgress(game);
  }
  if (game.phase === 'reveal') base.reveal = revealData(game);
  if (game.phase === 'finished') base.leaderboard = leaderboard(game);
  return base;
}

function questionForPlayer(game) {
  const q = game.quiz.questions[game.qi];
  // Учні НЕ отримують ні тексту питання, ні тексту відповідей, ні правильної відповіді —
  // лише кількість варіантів (на телефоні це символи ▲ ◆ ● ■).
  return {
    index: game.qi, total: game.quiz.questions.length, count: q.answers.length, time: q.time,
    left: Math.max(0, game.endsAt - Date.now()) // скільки мс залишилось (годинники пристроїв можуть розходитись)
  };
}

function playerResult(game, p) {
  const q = game.quiz.questions[game.qi];
  const lb = leaderboard(game);
  const me = lb.find(x => x.id === p.id);
  return { choice: p.choice, correct: p.choice === q.correct, correctIndex: q.correct,
           gain: p.gain, score: p.score, rank: me.rank, of: lb.length };
}

function playerState(game, p) {
  const base = { t: 'state', phase: game.phase, name: p.name, score: p.score };
  if (game.phase === 'question') {
    base.question = questionForPlayer(game);
    base.answered = p.choice !== null;
    base.choice = p.choice;
  }
  if (game.phase === 'reveal') base.result = playerResult(game, p);
  if (game.phase === 'finished') {
    const me = leaderboard(game).find(x => x.id === p.id);
    base.final = { rank: me.rank, of: game.players.size, score: p.score };
  }
  return base;
}

// «Активні» гравці: ті, хто зараз онлайн, або вже встиг відповісти.
function answerProgress(game) {
  let count = 0, total = 0;
  for (const p of game.players.values()) {
    if (p.choice !== null) { count++; total++; }
    else if (p.ws) total++;
  }
  return { count, total };
}

// Якщо всі активні гравці вже відповіли — завершуємо питання раніше.
function maybeEnd(game) {
  if (game.phase !== 'question') return;
  const { count, total } = answerProgress(game);
  if (total > 0 && count >= total) endQuestion(game);
}

function revealData(game) {
  const q = game.quiz.questions[game.qi];
  const counts = q.answers.map(() => 0);
  for (const p of game.players.values()) if (p.choice !== null) counts[p.choice]++;
  return { index: game.qi, text: q.text, correct: q.correct, counts, answers: q.answers,
           leaderboard: leaderboard(game).slice(0, 5), last: game.qi === game.quiz.questions.length - 1 };
}

/* ---------- Хід гри ---------- */
function startQuestion(game) {
  const q = game.quiz.questions[game.qi];
  game.phase = 'question';
  game.startedAt = Date.now();
  game.endsAt = game.startedAt + q.time * 1000;
  for (const p of game.players.values()) { p.choice = null; p.gain = 0; p.answerAt = 0; }
  clearTimeout(game.timer);
  game.timer = setTimeout(() => endQuestion(game), q.time * 1000 + GRACE_MS);
  send(game.teacher, teacherState(game));
  sendToPlayers(game, p => playerState(game, p));
}

function endQuestion(game) {
  if (game.phase !== 'question') return;
  clearTimeout(game.timer);
  const q = game.quiz.questions[game.qi];
  const totalMs = q.time * 1000;
  for (const p of game.players.values()) {
    if (p.choice === q.correct) {
      p.streak++;
      const ratio = Math.min(1, (p.answerAt - game.startedAt) / totalMs);
      p.gain = Math.round(1000 * (1 - ratio / 2)) + Math.min(p.streak - 1, 5) * 100;
      p.score += p.gain;
    } else {
      p.streak = 0;
      p.gain = 0;
    }
  }
  game.phase = 'reveal';
  send(game.teacher, teacherState(game));
  sendToPlayers(game, p => playerState(game, p));
}

function nextStep(game) {
  if (game.phase === 'lobby') {
    if (game.players.size === 0) return send(game.teacher, { t: 'error', msg: 'Ще ніхто не приєднався.' });
    game.qi = 0;
    return startQuestion(game);
  }
  if (game.phase === 'reveal') {
    if (game.qi >= game.quiz.questions.length - 1) {
      game.phase = 'finished';
      send(game.teacher, teacherState(game));
      sendToPlayers(game, p => playerState(game, p));
    } else {
      game.qi++;
      startQuestion(game);
    }
  }
}

function closeGame(game, reason) {
  game.phase = 'closed';
  clearTimeout(game.timer);
  clearTimeout(game.teacherGone);
  sendToPlayers(game, () => ({ t: 'closed', msg: reason }));
  for (const p of game.players.values()) if (p.ws) p.ws.close();
  games.delete(game.pin);
}

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server, maxPayload: 256 * 1024 });

wss.on('connection', (ws, req) => {
  ws.alive = true;
  ws.ip = req.socket.remoteAddress || 'unknown';
  ws.authed = false; // true після введення коду вчителя
  ws.on('pong', () => { ws.alive = true; });
  ws.ctx = null; // { role:'teacher', game } або { role:'player', game, player }

  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    try { handle(ws, m); } catch (e) { console.error('Помилка обробки повідомлення:', e); }
  });

  ws.on('close', () => {
    const c = ws.ctx;
    if (!c) return;
    if (c.role === 'teacher' && c.game.teacher === ws) {
      c.game.teacher = null;
      // даємо викладачу 2 хвилини, щоб оновити сторінку й повернутися
      c.game.teacherGone = setTimeout(() => closeGame(c.game, 'Викладач вийшов — гру завершено.'), 120000);
    }
    if (c.role === 'player' && c.player.ws === ws) {
      const { game, player: p } = c;
      p.ws = null;
      if (game.phase === 'lobby') {
        // у лобі прибираємо гравця, якщо він не повернувся за 15 с (оновлення сторінки не рахується)
        clearTimeout(p.dropTimer);
        p.dropTimer = setTimeout(() => {
          if (!p.ws && game.phase === 'lobby' && game.players.get(p.id) === p) {
            game.players.delete(p.id);
            send(game.teacher, { t: 'players', players: playerList(game) });
          }
        }, 15000);
      }
      send(game.teacher, { t: 'players', players: playerList(game) });
      maybeEnd(game);
    }
  });
});

function handle(ws, m) {
  /* --- Вчитель --- */
  if (m.t === 'auth') {
    const r = checkCode(ws.ip, m.code);
    ws.authed = r === 'ok';
    return send(ws, { t: r === 'ok' ? 'authOk' : r === 'blocked' ? 'authBlocked' : 'authFail' });
  }

  if (m.t === 'create') {
    if (!ws.authed) return send(ws, { t: 'authFail' });
    const quiz = cleanQuiz(m.quiz);
    if (!quiz) return send(ws, { t: 'error', msg: 'Некоректна вікторина.' });
    if (ws.ctx && ws.ctx.role === 'teacher') closeGame(ws.ctx.game, 'Вчитель запустив нову гру.');
    const game = {
      pin: newPin(), quiz, phase: 'lobby', qi: 0,
      teacher: ws, teacherToken: rid(), players: new Map(), timer: null, teacherGone: null,
      startedAt: 0, endsAt: 0
    };
    games.set(game.pin, game);
    ws.ctx = { role: 'teacher', game };
    return send(ws, { t: 'created', pin: game.pin, token: game.teacherToken, urls: lanUrls() });
  }

  if (m.t === 'resume') {
    const game = games.get(String(m.pin));
    if (!game || game.teacherToken !== m.token) return send(ws, { t: 'resumeFailed' });
    clearTimeout(game.teacherGone);
    if (game.teacher && game.teacher !== ws) game.teacher.close();
    game.teacher = ws;
    ws.ctx = { role: 'teacher', game };
    send(ws, { t: 'created', pin: game.pin, token: game.teacherToken, urls: lanUrls() });
    return send(ws, teacherState(game));
  }

  const c = ws.ctx;

  if (c && c.role === 'teacher') {
    const game = c.game;
    if (m.t === 'next') return nextStep(game);
    if (m.t === 'endQuestion') return endQuestion(game);
    if (m.t === 'kick') {
      const p = game.players.get(m.id);
      if (p) {
        send(p.ws, { t: 'closed', msg: 'Викладач видалив вас з гри.' });
        if (p.ws) p.ws.close();
        game.players.delete(p.id);
        send(game.teacher, { t: 'players', players: playerList(game) });
      }
      return;
    }
    if (m.t === 'close') return closeGame(game, 'Гру завершено.');
    return;
  }

  /* --- Учень --- */
  if (m.t === 'join') {
    // Код вчителя учням не потрібен. PIN необов'язковий, якщо зараз відкрита лише одна гра.
    const pinIn = String(m.pin || '').trim();
    let game;
    if (pinIn) {
      game = games.get(pinIn);
      if (!game) return send(ws, { t: 'joinError', msg: 'Гру з таким PIN не знайдено.' });
    } else {
      const open = [...games.values()].filter(g => g.phase === 'lobby');
      if (open.length !== 1) {
        return send(ws, { t: 'joinError', msg: open.length
          ? 'Зараз відкрито кілька ігор — введіть PIN, який показано на екрані вчителя.'
          : 'Зараз немає відкритої гри. Зачекайте, поки вчитель її запустить.' });
      }
      game = open[0];
    }

    // повернення після оновлення сторінки
    if (m.token) {
      for (const p of game.players.values()) {
        if (p.token === m.token) {
          clearTimeout(p.dropTimer);
          if (p.ws && p.ws !== ws) p.ws.close();
          p.ws = ws;
          ws.ctx = { role: 'player', game, player: p };
          send(ws, { t: 'joined', token: p.token, name: p.name, pin: game.pin });
          send(ws, playerState(game, p));
          return send(game.teacher, { t: 'players', players: playerList(game) });
        }
      }
    }

    if (game.phase !== 'lobby') return send(ws, { t: 'joinError', msg: 'Гра вже почалася.' });
    if (game.players.size >= MAX_PLAYERS) return send(ws, { t: 'joinError', msg: 'Кімната заповнена.' });

    let name = String(m.name || '').trim().replace(/\s+/g, ' ').slice(0, 16);
    if (!name) return send(ws, { t: 'joinError', msg: 'Введіть ім\'я.' });
    const taken = new Set([...game.players.values()].map(p => p.name.toLowerCase()));
    if (taken.has(name.toLowerCase())) {
      let n = 2;
      while (taken.has((name + ' ' + n).toLowerCase())) n++;
      name = name + ' ' + n;
    }
    const p = { id: rid(), token: rid(), name, ws, score: 0, streak: 0, choice: null, gain: 0, answerAt: 0 };
    game.players.set(p.id, p);
    ws.ctx = { role: 'player', game, player: p };
    send(ws, { t: 'joined', token: p.token, name: p.name, pin: game.pin });
    send(ws, playerState(game, p));
    return send(game.teacher, { t: 'players', players: playerList(game) });
  }

  if (c && c.role === 'player' && m.t === 'answer') {
    const { game, player: p } = c;
    if (game.phase !== 'question' || p.choice !== null) return;
    const now = Date.now();
    if (now > game.endsAt + GRACE_MS) return;
    const q = game.quiz.questions[game.qi];
    const choice = Number(m.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.answers.length) return;
    p.choice = choice;
    p.answerAt = Math.min(now, game.endsAt);
    send(ws, { t: 'answerAck', choice });
    send(game.teacher, { t: 'answered', ...answerProgress(game) });
    maybeEnd(game);
  }
}

/* Перевірка «живих» з'єднань */
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, () => {
  console.log('Квізоут запущено!');
  const urls = lanUrls();
  console.log('  Одне посилання для всіх (учень / вчитель обирають роль на сторінці):');
  console.log('    ' + (urls.length ? urls.join('  або  ') : `http://localhost:${PORT}`));
  console.log(`  Код вчителя: ${TEACHER_CODE}`);
});
