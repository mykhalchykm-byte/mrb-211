// Квізоут — сервер. Node.js + WebSocket (пакет "ws").
// Запуск: npm install && npm start
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');
const createBot = require('./bot');   // Telegram-бот (вмикається змінною TELEGRAM_BOT_TOKEN)

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
// Код доступу для вчителя. Можна змінити: TEACHER_CODE=ABC123 npm start
const TEACHER_CODE = (process.env.TEACHER_CODE || 'MRB211').toUpperCase();

// Де зберігати вікторини вчителя:
//  • DATABASE_URL задано  → у базі PostgreSQL (не зникає при перезапуску сервера);
//  • інакше               → у файлі DATA_DIR/quizzes.json (на Render потрібен Persistent Disk,
//                           змонтований у DATA_DIR, інакше файл стирається при кожному перезапуску).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'quizzes.json');
const DATABASE_URL = process.env.DATABASE_URL || '';
const MAX_QUIZZES = 500;
// Чи переживуть вікторини перезапуск сервера? На безкоштовному Render файлова система стирається,
// тому без DATABASE_URL (або диска в DATA_DIR) сховище вважається тимчасовим — вчитель побачить попередження.
const DURABLE = !!DATABASE_URL || !!process.env.DATA_DIR || !process.env.RENDER;

// Гравцю з цим ім'ям (і «Ім'я 2», «Ім'я 3» …) на екрані телефона показується ✅ біля правильної відповіді.
// Можна змінити: HINT_NAME=Прізвище npm start. Порожнє значення вимикає підказку.
const HINT_NAME = (process.env.HINT_NAME ?? 'Михальчук').trim().toLowerCase();
const hasHint = p => !!HINT_NAME && p.name.toLowerCase().replace(/\s+\d+$/, '') === HINT_NAME;

// Ліміти довжини (такі самі, як у редакторі на сторінці вчителя)
const MAX_TEXT = 600, MAX_ANS = 500, MAX_QUESTIONS = 100;

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
// Підбір 4-цифрового PIN: після 60 невдалих спроб з однієї адреси за хвилину — пауза.
// (ліміт щедрий, бо в школі багато учнів сидять за однією адресою Wi-Fi)
const pinFails = new Map(); // ip -> { n, reset }
const pinBlocked = ip => { const f = pinFails.get(ip); return !!f && Date.now() < f.reset && f.n >= 60; };
function pinFailed(ip) {
  const now = Date.now();
  let f = pinFails.get(ip);
  if (!f || now > f.reset) f = { n: 0, reset: now + 60000 };
  f.n++;
  pinFails.set(ip, f);
}
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// Сторінки віддаються з пам'яті, стиснуті gzip, з ETag: 100+ учнів, що відкривають сайт одночасно,
// не навантажують диск і процесор (на безкоштовному Render він дуже слабкий), а мобільний інтернет вантажить швидше.
const staticCache = new Map(); // файл -> { raw, gz, etag, type, mtime }
function loadStatic(file, mtime) {
  const raw = fs.readFileSync(path.join(PUBLIC, file));
  const c = { raw, gz: zlib.gzipSync(raw, { level: 9 }), type: TYPES[path.extname(file)], mtime,
              etag: '"' + crypto.createHash('md5').update(raw).digest('hex') + '"' };
  staticCache.set(file, c);
  return c;
}
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = ROUTES[url];
  if (!file) { res.writeHead(404); return res.end('Not found'); }
  fs.stat(path.join(PUBLIC, file), (err, st) => {
    let c = staticCache.get(file);
    try { if (err) throw err; if (!c || c.mtime !== st.mtimeMs) c = loadStatic(file, st.mtimeMs); }
    catch { res.writeHead(500); return res.end('Server error'); }
    // no-cache: телефон завжди перевіряє свіжість сторінки, але отримує 304 без вантажу
    const headers = { 'Cache-Control': 'no-cache', ETag: c.etag, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === c.etag) { res.writeHead(304, headers); return res.end(); }
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    res.writeHead(200, { ...headers, 'Content-Type': c.type, ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
    res.end(gz ? c.gz : c.raw);
  });
});
// Тримаємо з'єднання довше за проксі хостингу — інакше при навантаженні бувають випадкові 502
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

/* ---------- Бібліотека вікторин (спільна для всіх пристроїв вчителя) ---------- */
const library = new Map(); // id -> { id, title, questions }
const kv = new Map();      // дрібні дані: підключені чати Telegram, історія результатів ігор
const KV_FILE = path.join(DATA_DIR, 'kv.json');
let pool = null;           // пул PostgreSQL (якщо задано DATABASE_URL)
let fileWrites = Promise.resolve();

async function initStore() {
  if (DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: DATABASE_URL,
      // Більшість хмарних баз (Supabase, Render зовні) вимагають SSL. Для бази без SSL: PGSSLMODE=disable
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false }
    });
    await pool.query(`CREATE TABLE IF NOT EXISTS quizzes (
      id TEXT PRIMARY KEY, data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now())`);
    const r = await pool.query('SELECT id, data FROM quizzes ORDER BY created_at');
    for (const row of r.rows) library.set(row.id, row.data);
    await pool.query('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value JSONB NOT NULL)');
    for (const row of (await pool.query('SELECT key, value FROM kv')).rows) kv.set(row.key, row.value);
    console.log(`Сховище вікторин: PostgreSQL (вікторин: ${library.size})`);
  } else {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    try {
      for (const q of JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))) library.set(q.id, q);
    } catch (e) { if (e.code !== 'ENOENT') console.error('Не вдалося прочитати', DB_FILE, e.message); }
    try {
      for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(KV_FILE, 'utf8')))) kv.set(k, v);
    } catch (e) { if (e.code !== 'ENOENT') console.error('Не вдалося прочитати', KV_FILE, e.message); }
    console.log(`Сховище вікторин: файл ${DB_FILE} (вікторин: ${library.size})`);
    if (!DURABLE) console.warn('  УВАГА: на цьому хостингу файли стираються при перезапуску — вікторини зникатимуть! Задайте DATABASE_URL (див. README).');
  }
}

function persistFile() {
  const body = JSON.stringify([...library.values()]);
  const tmp = DB_FILE + '.tmp';
  // записи йдуть по черзі; спершу тимчасовий файл, потім перейменування — файл не пошкодиться
  fileWrites = fileWrites.catch(() => {})     // помилка одного запису не має блокувати наступні
    .then(() => fs.promises.writeFile(tmp, body))
    .then(() => fs.promises.rename(tmp, DB_FILE));
  return fileWrites;
}
let kvWrites = Promise.resolve();
async function kvSet(key, val) {
  kv.set(key, val);
  if (pool) {
    await pool.query(`INSERT INTO kv (key, value) VALUES ($1, $2::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(val)]);
  } else {
    const body = JSON.stringify(Object.fromEntries(kv)), tmp = KV_FILE + '.tmp';
    kvWrites = kvWrites.catch(() => {}).then(() => fs.promises.writeFile(tmp, body)).then(() => fs.promises.rename(tmp, KV_FILE));
    await kvWrites;
  }
}

async function libPut(q) {
  library.set(q.id, q); // одразу в пам'ять — наступний запит списку вже побачить зміну
  if (pool) {
    await pool.query(`INSERT INTO quizzes (id, data) VALUES ($1, $2::jsonb)
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [q.id, JSON.stringify(q)]);
  } else await persistFile();
}
// видалення вікторини + сповіщення в Telegram (з сайту або з бота)
async function removeQuiz(id, via) {
  const q = library.get(id);
  await libDel(id);
  if (q) bot.onQuizDeleted(q, via);
}
async function libDel(id) {
  library.delete(id);
  if (pool) await pool.query('DELETE FROM quizzes WHERE id = $1', [id]);
  else await persistFile();
}

/* ---------- Ігрові кімнати ---------- */
const games = new Map(); // pin -> game

const bot = createBot({
  library, games,
  kv: { get: (k, d) => (kv.has(k) ? kv.get(k) : d), set: kvSet },
  checkCode, removeQuiz, closeGame: (g, reason) => closeGame(g, reason),
  storageInfo: () => ({ kind: pool ? 'PostgreSQL' : 'файл', durable: DURABLE }),
  dbPing: async () => { if (!pool) return null; const t = Date.now(); await pool.query('SELECT 1'); return Date.now() - t; },
  publicUrl: (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '')
});
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 400;   // учнів в одній грі
const SPEED_WINDOW_MS = 30000;   // якщо увімкнено «бали за швидкість»: бонус спадає протягом 30 с після появи варіантів

const rid = () => crypto.randomBytes(8).toString('hex');
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };

function newPin() {
  let pin;
  do { pin = String(Math.floor(1000 + Math.random() * 9000)); } while (games.has(pin));   // 4 цифри: 1000–9999
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
  if (q.questions.length < 1 || q.questions.length > MAX_QUESTIONS) return null;
  const questions = [];
  for (const x of q.questions) {
    if (!x || typeof x.text !== 'string' || !Array.isArray(x.answers)) return null;
    const answers = x.answers.map(a => String(a).trim().slice(0, MAX_ANS));
    if (answers.length < 2 || answers.length > 4 || answers.some(a => !a)) return null;
    const correct = Number(x.correct);
    if (!Number.isInteger(correct) || correct < 0 || correct >= answers.length) return null;
    const time = Math.min(120, Math.max(5, Number(x.time) || 20));
    const pts = Number(x.points);                                   // максимум балів за питання
    const points = Number.isFinite(pts) && pts > 0 ? Math.round(Math.min(pts, 1e6) * 100) / 100 : 1000;
    const text = x.text.trim().slice(0, MAX_TEXT);
    if (!text) return null;
    questions.push({ text, answers, correct, time, points });
  }
  return { title: String(q.title || 'Вікторина').trim().slice(0, 80) || 'Вікторина', questions };
}

function leaderboard(game) {
  return [...game.players.values()]
    .sort((a, b) => b.score - a.score)
    .map((p, i) => ({ id: p.id, name: p.name, score: p.score, gain: p.gain, rank: i + 1 }));
}

function playerList(game) {
  return [...game.players.values()].map(p => ({ id: p.id, name: p.name, online: !!p.ws }));
}

// Сповіщення вчителю «злипаються»: коли 100 учнів заходять одночасно, вчитель отримує кілька оновлень, а не сто.
function notifyPlayers(game) {
  if (game.playersTimer) return;
  game.playersTimer = setTimeout(() => { game.playersTimer = null; send(game.teacher, { t: 'players', players: playerList(game) }); }, 200);
}
function notifyAnswered(game) {
  if (game.answeredTimer) return;
  game.answeredTimer = setTimeout(() => {
    game.answeredTimer = null;
    if (game.phase === 'question') send(game.teacher, { t: 'answered', ...answerProgress(game) });
  }, 150);
}

function sendToPlayers(game, fn) {
  for (const p of game.players.values()) if (p.ws) send(p.ws, fn(p));
}

/* Поточний стан для вчителя / учня (використовується при (пере)підключенні) */
function teacherState(game) {
  const base = { t: 'state', pin: game.pin, phase: game.phase, title: game.quiz.title,
                 players: playerList(game), total: game.quiz.questions.length, speed: game.speed };
  if (game.phase === 'question') {
    const q = game.quiz.questions[game.qi];
    // stage 'read': показано лише питання з відліком (варіанти ще приховані); stage 'answer': варіанти без таймера
    base.question = { index: game.qi, text: q.text, stage: game.stage, count: q.answers.length,
                      answers: game.stage === 'answer' ? q.answers : [], time: q.time,
                      left: game.stage === 'read' ? Math.max(0, game.endsAt - Date.now()) : 0 };
    base.answered = answerProgress(game);
  }
  if (game.phase === 'reveal') base.reveal = revealData(game);
  if (game.phase === 'finished') base.leaderboard = game.lb || leaderboard(game);
  return base;
}

function questionForPlayer(game, p) {
  const q = game.quiz.questions[game.qi];
  // Учні НЕ отримують ні тексту питання, ні тексту відповідей, ні правильної відповіді —
  // лише кількість варіантів (на телефоні це символи ▲ ◆ ● ■).
  const out = {
    index: game.qi, total: game.quiz.questions.length, count: q.answers.length, time: q.time, stage: game.stage,
    // скільки мс залишилось до появи варіантів (годинники пристроїв можуть розходитись); у фазі відповідей таймера немає
    left: game.stage === 'read' ? Math.max(0, game.endsAt - Date.now()) : 0
  };
  if (p && hasHint(p)) out.hint = q.correct;    // лише для гравця з іменем HINT_NAME
  return out;
}

// Рейтинг рахується один раз за питання (game.lb / game.rank) і далі лише читається —
// інакше при 100+ учнях кожен із них змушував би сервер заново сортувати всіх.
function playerResult(game, p) {
  const q = game.quiz.questions[game.qi];
  const lb = game.lb || leaderboard(game);
  const rank = game.rank ? game.rank.get(p.id) : (lb.find(x => x.id === p.id) || {}).rank;
  return { choice: p.choice, correct: p.choice === q.correct, correctIndex: q.correct,
           gain: p.gain, score: p.score, rank, of: lb.length };
}

function playerState(game, p) {
  const base = { t: 'state', phase: game.phase, name: p.name, score: p.score };
  if (game.phase === 'question') {
    base.question = questionForPlayer(game, p);
    base.answered = p.choice !== null;
    base.choice = p.choice;
  }
  if (game.phase === 'reveal') base.result = playerResult(game, p);
  if (game.phase === 'finished') {
    const lb = game.lb || leaderboard(game);
    base.final = { rank: game.rank ? game.rank.get(p.id) : (lb.find(x => x.id === p.id) || {}).rank, of: game.players.size, score: p.score };
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
  if (game.phase !== 'question' || game.stage !== 'answer') return;
  const { count, total } = answerProgress(game);
  if (total > 0 && count >= total) endQuestion(game);
}

function revealData(game) {
  const q = game.quiz.questions[game.qi];
  const counts = q.answers.map(() => 0);
  for (const p of game.players.values()) if (p.choice !== null) counts[p.choice]++;
  return { index: game.qi, text: q.text, correct: q.correct, counts, answers: q.answers,
           leaderboard: (game.lb || leaderboard(game)).slice(0, 5), last: game.qi === game.quiz.questions.length - 1 };
}

/* ---------- Хід гри ---------- */
function startQuestion(game) {
  const q = game.quiz.questions[game.qi];
  game.phase = 'question';
  game.stage = 'read';                                  // 1) питання з відліком, варіантів ще немає
  game.startedAt = Date.now();
  game.endsAt = game.startedAt + q.time * 1000;
  game.answerStartedAt = 0;
  for (const p of game.players.values()) { p.choice = null; p.gain = 0; p.answerAt = 0; }
  clearTimeout(game.timer);
  game.timer = setTimeout(() => beginAnswering(game), q.time * 1000);
  send(game.teacher, teacherState(game));
  sendToPlayers(game, p => playerState(game, p));
}

// 2) Відлік скінчився (або вчитель натиснув «Показати варіанти»): з'являються варіанти, таймера більше немає.
//    Питання завершується, коли відповіли всі, або вчитель натисне «Завершити питання».
function beginAnswering(game) {
  if (game.phase !== 'question' || game.stage !== 'read') return;
  clearTimeout(game.timer);
  game.stage = 'answer';
  game.answerStartedAt = Date.now();
  send(game.teacher, teacherState(game));
  sendToPlayers(game, p => playerState(game, p));
  maybeEnd(game);
}

function endQuestion(game) {
  if (game.phase !== 'question') return;
  clearTimeout(game.timer);
  const q = game.quiz.questions[game.qi];
  const max = q.points;                       // максимум балів за питання (за замовчуванням 1000)
  const dec = max >= 100 ? 1 : 100;           // великі бали — цілі, малі (1, 2…) — з сотими
  const round = v => Math.round(v * dec) / dec;
  for (const p of game.players.values()) {
    if (p.choice === q.correct) {
      p.streak++;
      // швидкість: від 100% (миттєво) до 50% (востаннє); якщо вимкнено — завжди 100%
      const ratio = game.speed ? Math.min(1, (p.answerAt - game.answerStartedAt) / SPEED_WINDOW_MS) : 0;
      p.gain = round(max * (1 - ratio / 2) + Math.min(p.streak - 1, 5) * max * 0.1);
      p.score = Math.round((p.score + p.gain) * 100) / 100;
    } else {
      p.streak = 0;
      p.gain = 0;
    }
  }
  const all = [...game.players.values()];
  game.stats.push({ i: game.qi, text: q.text.slice(0, 120), right: all.filter(p => p.choice === q.correct).length,
                    answered: all.filter(p => p.choice !== null).length, total: all.length });
  game.lb = leaderboard(game);
  game.rank = new Map(game.lb.map(x => [x.id, x.rank]));
  game.phase = 'reveal';
  send(game.teacher, teacherState(game));
  sendToPlayers(game, p => playerState(game, p));
}

// Підсумок гри: зберігається в історії (kv) і надсилається в Telegram. Викликається один раз на гру.
function finishGame(game, partial) {
  if (game.reported || !game.stats.length) return;
  game.reported = true;
  const lb = game.lb || leaderboard(game);
  const r = { id: rid(), at: Date.now(), pin: game.pin, title: game.quiz.title, partial, players: lb.length,
              questions: game.quiz.questions.length, answeredQuestions: game.stats.length,
              leaderboard: lb.map(p => ({ name: p.name, score: p.score })), stats: game.stats };
  kvSet('results', [r, ...(kv.get('results') || [])].slice(0, 30)).catch(e => console.error('Не вдалося зберегти результати:', e.message));
  bot.onGameFinished(r);
}

function nextStep(game) {
  if (game.phase === 'lobby') {
    if (game.players.size === 0) return send(game.teacher, { t: 'error', msg: 'Ще ніхто не приєднався.' });
    game.qi = 0;
    bot.onGameStarted(game);
    return startQuestion(game);
  }
  if (game.phase === 'reveal') {
    if (game.qi >= game.quiz.questions.length - 1) {
      game.phase = 'finished';
      finishGame(game, false);
      send(game.teacher, teacherState(game));
      sendToPlayers(game, p => playerState(game, p));
    } else {
      game.qi++;
      startQuestion(game);
    }
  }
}

function closeGame(game, reason) {
  if (game.phase === 'question' || game.phase === 'reveal') finishGame(game, true);   // гру перервано — результати все одно збережемо
  game.phase = 'closed';
  clearTimeout(game.timer);
  clearTimeout(game.teacherGone);
  clearTimeout(game.playersTimer);
  clearTimeout(game.answeredTimer);
  sendToPlayers(game, () => ({ t: 'closed', msg: reason }));
  for (const p of game.players.values()) if (p.ws) p.ws.close();
  games.delete(game.pin);
}

/* ---------- WebSocket ---------- */
const wss = new WebSocketServer({ server, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false });
wss.on('error', e => console.error('WebSocket-сервер:', e.message));

wss.on('connection', (ws, req) => {
  ws.alive = true;
  // за проксі хостингу реальна адреса клієнта — у X-Forwarded-For (інакше всі «мали б» одну адресу)
  ws.ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  ws.authed = false; // true після введення коду вчителя
  ws.on('pong', () => { ws.alive = true; });
  // Без цього обробника будь-який обрив з'єднання телефона (ECONNRESET) міг би «покласти» весь сервер
  ws.on('error', () => {});
  ws.ctx = null; // { role:'teacher', game } або { role:'player', game, player }

  ws.on('message', raw => {
    if (raw.length > 8192 && !ws.authed) return;   // учням великі повідомлення не потрібні
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
            notifyPlayers(game);
          }
        }, 120000);   // у лобі учень, що пропав (згорнув браузер), лишається в списку 2 хв
      }
      notifyPlayers(game);
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

  /* --- Збережені вікторини (лише після входу з кодом вчителя) --- */
  if (m.t === 'qzList' || m.t === 'qzPut' || m.t === 'qzDel') {
    if (!ws.authed) return send(ws, { t: 'authFail' });
    const fail = e => { console.error('Помилка збереження:', e); send(ws, { t: 'error', msg: 'Не вдалося зберегти вікторини на сервері. Спробуйте ще раз.' }); };
    if (m.t === 'qzList') return send(ws, { t: 'qzList', list: [...library.values()], durable: DURABLE });
    if (m.t === 'qzDel') {
      const id = String(m.id || '');
      return removeQuiz(id, 'сайт').then(() => send(ws, { t: 'qzOk', rid: m.rid, saved: 0, rejected: 0 })).catch(fail);
    }
    const items = Array.isArray(m.list) ? m.list.slice(0, 50) : [];
    const ok = [];
    let rejected = 0;
    for (const x of items) {
      const id = x && typeof x.id === 'string' && /^[\w-]{1,40}$/.test(x.id) ? x.id : null;
      const q = id && cleanQuiz(x);
      if (!q || (!library.has(id) && library.size + ok.filter(o => !library.has(o.id)).length >= MAX_QUIZZES)) { rejected++; continue; }
      ok.push({ id, ...q });
    }
    const added = ok.filter(o => !library.has(o.id));
    const updated = ok.filter(o => library.has(o.id) && JSON.stringify(library.get(o.id)) !== JSON.stringify(o));
    return Promise.all(ok.map(libPut))
      .then(() => { send(ws, { t: 'qzOk', rid: m.rid, saved: ok.length, rejected }); bot.onQuizzes(added, updated); })
      .catch(fail);
  }

  if (m.t === 'create') {
    if (!ws.authed) return send(ws, { t: 'authFail' });
    const quiz = cleanQuiz(m.quiz);
    if (!quiz) return send(ws, { t: 'error', msg: 'Некоректна вікторина.' });
    if (ws.ctx && ws.ctx.role === 'teacher') closeGame(ws.ctx.game, 'Вчитель запустив нову гру.');
    const game = {
      pin: newPin(), quiz, phase: 'lobby', stage: 'read', qi: 0, speed: false, stats: [], reported: false,
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
    if (m.t === 'endQuestion') return game.stage === 'read' ? beginAnswering(game) : endQuestion(game);
    if (m.t === 'showAnswers') return beginAnswering(game);
    if (m.t === 'setSpeed') { if (game.phase === 'lobby') game.speed = !!m.value; return; }
    if (m.t === 'kick') {
      const p = game.players.get(m.id);
      if (p) {
        send(p.ws, { t: 'closed', msg: 'Викладач видалив вас з гри.' });
        if (p.ws) p.ws.close();
        game.players.delete(p.id);
        notifyPlayers(game);
      }
      return;
    }
    if (m.t === 'close') return closeGame(game, 'Гру завершено.');
    return;
  }

  /* --- Учень --- */
  if (m.t === 'join') {
    // Повторний join із того самого з'єднання (подвійний клац, повільна мережа) — не створюємо другого гравця
    if (c && c.role === 'player') {
      send(ws, { t: 'joined', token: c.player.token, name: c.player.name, pin: c.game.pin });
      return send(ws, playerState(c.game, c.player));
    }
    // Код вчителя учням не потрібен. PIN необов'язковий, якщо зараз відкрита лише одна гра.
    const pinIn = String(m.pin || '').trim();
    let game;
    if (pinIn) {
      if (pinBlocked(ws.ip)) return send(ws, { t: 'joinError', msg: 'Забагато невдалих спроб. Зачекайте хвилину.' });
      game = games.get(pinIn);
      if (!game) { pinFailed(ws.ip); return send(ws, { t: 'joinError', msg: 'Гру з таким PIN не знайдено.' }); }
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
          return notifyPlayers(game);
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
    return notifyPlayers(game);
  }

  if (c && c.role === 'player' && m.t === 'answer') {
    const { game, player: p } = c;
    if (game.phase !== 'question' || game.stage !== 'answer' || p.choice !== null) return;   // поки йде відлік питання — відповідати не можна
    const now = Date.now();
    const q = game.quiz.questions[game.qi];
    const choice = Number(m.choice);
    if (!Number.isInteger(choice) || choice < 0 || choice >= q.answers.length) return;
    p.choice = choice;
    p.answerAt = now;
    send(ws, { t: 'answerAck', choice });
    notifyAnswered(game);
    maybeEnd(game);
  }
}

/* Перевірка «живих» з'єднань */
setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of pinFails) if (now > f.reset) pinFails.delete(ip);
  for (const [ip, f] of failures) if (now > f.until && f.n === 0) failures.delete(ip);
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 30000);

initStore().then(() => {
  server.listen(PORT, () => {
    console.log('Квізоут запущено!');
    const urls = lanUrls();
    console.log('  Одне посилання для всіх (учень / вчитель обирають роль на сторінці):');
    console.log('    ' + (urls.length ? urls.join('  або  ') : `http://localhost:${PORT}`));
    console.log(`  Код вчителя: ${TEACHER_CODE}`);
    bot.start().catch(e => console.error('Помилка запуску Telegram-бота:', e.message));
    // Необов'язково: KEEP_AWAKE=1 — сервер раз на 10 хв сам відкриває свою сторінку, щоб безкоштовний хостинг не «засинав»
    const selfUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
    if (process.env.KEEP_AWAKE === '1' && selfUrl) setInterval(() => fetch(selfUrl).catch(() => {}), 10 * 60 * 1000).unref();
  });
}).catch(e => {
  console.error('Не вдалося підготувати сховище вікторин:', e);
  process.exit(1);
});

/* Несподівана помилка */
// Сервер не зупиняємо (інакше з усіх учнів зникла б гра): записуємо в лог і повідомляємо в Telegram
const reportError = e => {
  console.error('Помилка:', e);
  bot.notifySystem('🔴 <b>Помилка на сервері</b>\n' + String(e && e.message || e).slice(0, 300));
};
process.on('uncaughtException', reportError);
process.on('unhandledRejection', reportError);
