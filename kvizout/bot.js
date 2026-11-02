// Telegram-бот Квізоута: сповіщення, результати, статус сервера, керування.
// Працює через довге опитування Telegram (getUpdates) — без вебхуків і без додаткових бібліотек (потрібен Node 18+).
// Вмикається змінною TELEGRAM_BOT_TOKEN (токен від @BotFather). Інакше модуль нічого не робить.
'use strict';

const API = (process.env.TELEGRAM_API || 'https://api.telegram.org').replace(/\/$/, '');
const TZ = process.env.TZ_DISPLAY || 'Europe/Kyiv';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtDate = ts => new Date(ts).toLocaleString('uk-UA', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function fmtDur(ms) {
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return [d && d + ' д', (d || h) && h + ' год', m + ' хв'].filter(Boolean).join(' ');
}
const num = v => String(Math.round(v * 100) / 100);
const short = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const kb = rows => ({ reply_markup: { inline_keyboard: rows } });
const PHASES = { lobby: 'очікування учнів', question: 'питання', reveal: 'результат питання', finished: 'завершено' };
const CATS = { quizzes: '📚 Вікторини', games: '🎮 Ігри й результати', system: '🖥 Сервер' };

module.exports = function createBot(host) {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const enabled = !!token;
  const envAdmins = (process.env.TELEGRAM_CHAT_ID || '').split(/[,\s]+/).filter(Boolean).map(Number).filter(Number.isFinite);
  const startedAt = Date.now();
  let offset = 0, running = false, dbDown = false, botName = '';

  /* ---------- Telegram API ---------- */
  async function api(method, body, timeout = 15000) {
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: isForm ? undefined : { 'Content-Type': 'application/json' },
      body: isForm ? body : JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeout)
    });
    const j = await res.json().catch(() => ({ ok: false, description: 'bad response' }));
    if (!j.ok) { const e = new Error(j.description || 'HTTP ' + res.status); e.code = j.error_code; throw e; }
    return j.result;
  }
  const log = (...a) => console.error('[Telegram]', ...a);
  const send = (chat, text, extra) =>
    api('sendMessage', { chat_id: chat, text: short(text, 4000), parse_mode: 'HTML', disable_web_page_preview: true, ...extra })
      .catch(e => log('sendMessage:', e.message));

  /* ---------- Доступ і налаштування ---------- */
  const admins = () => [...new Set([...envAdmins, ...host.kv.get('tgAdmins', [])])];
  const isAdmin = id => admins().includes(id);
  const prefsOf = id => ({ quizzes: true, games: true, system: true, ...(host.kv.get('tgPrefs', {})[id] || {}) });
  async function setPref(id, cat, val) {
    const all = { ...host.kv.get('tgPrefs', {}) };
    all[id] = { ...prefsOf(id), [cat]: val };
    await host.kv.set('tgPrefs', all);
  }
  function broadcast(cat, text, extra) {
    for (const id of admins()) if (prefsOf(id)[cat]) send(id, text, extra);
  }

  /* ---------- Тексти ---------- */
  async function statusText() {
    const st = host.storageInfo();
    let db = '';
    try { const ms = await host.dbPing(); if (ms !== null) db = ` · відповідь ${ms} мс`; }
    catch (e) { db = ' · 🔴 недоступна: ' + esc(short(e.message, 100)); }
    let online = 0, active = 0;
    for (const g of host.games.values()) { if (g.phase !== 'closed') active++; for (const p of g.players.values()) if (p.ws) online++; }
    return [
      '🟢 <b>Квізоут — статус сервера</b>',
      `⏱ Працює: ${fmtDur(Date.now() - startedAt)} (запуск ${fmtDate(startedAt)})`,
      `💾 Сховище: ${esc(st.kind)} ${st.durable ? '✅ постійне' : '⚠️ тимчасове — дані зникнуть після перезапуску!'}${db}`,
      `📚 Вікторин: ${host.library.size}`,
      `🎮 Активних ігор: ${active} · учнів онлайн: ${online}`,
      `🧠 Пам'ять: ${Math.round(process.memoryUsage().rss / 1048576)} МБ · Node ${process.version}`,
      host.publicUrl ? `🌐 ${esc(host.publicUrl)}` : ''
    ].filter(Boolean).join('\n');
  }

  function resultText(r) {
    const lb = r.leaderboard || [];
    const medals = ['🥇', '🥈', '🥉'];
    const lines = [
      `${r.partial ? '⏹' : '🏁'} <b>Результати: ${esc(r.title)}</b>${r.partial ? ' (достроково)' : ''}`,
      `📅 ${fmtDate(r.at)} · PIN ${esc(r.pin)} · учнів: ${r.players} · питань: ${r.answeredQuestions}/${r.questions}`,
      ''
    ];
    lb.slice(0, 10).forEach((p, i) => lines.push(`${medals[i] || (i + 1) + '.'} ${esc(p.name)} — <b>${num(p.score)}</b>`));
    if (lb.length > 10) lines.push(`… і ще ${lb.length - 10}`);
    if (lb.length) lines.push('', `📊 Середній бал: ${num(lb.reduce((a, p) => a + p.score, 0) / lb.length)}`);
    const st = (r.stats || []).filter(s => s.answered > 0);
    if (st.length) {
      const right = st.reduce((a, s) => a + s.right, 0), all = st.reduce((a, s) => a + s.answered, 0);
      lines.push(`✅ Правильних відповідей: ${Math.round(100 * right / all)}% (${right} з ${all})`);
      const hard = [...st].sort((a, b) => a.right / a.answered - b.right / b.answered).filter(s => s.right < s.answered).slice(0, 3);
      if (hard.length) {
        lines.push('', '🔻 <b>Найскладніші питання:</b>');
        hard.forEach(s => lines.push(`• №${s.i + 1} «${esc(short(s.text, 70))}» — ${Math.round(100 * s.right / s.answered)}% (${s.right}/${s.answered})`));
      }
    }
    return lines.join('\n');
  }

  function resultCsv(r) {
    const q = v => `"${String(v).replace(/"/g, '""')}"`;
    const rows = [['Місце', "Ім'я", 'Бали'].map(q).join(';')];
    (r.leaderboard || []).forEach((p, i) => rows.push([i + 1, q(p.name), String(p.score).replace('.', ',')].join(';')));
    rows.push('', ['№ питання', 'Питання', 'Правильно', 'Відповіли'].map(q).join(';'));
    (r.stats || []).forEach(s => rows.push([s.i + 1, q(s.text), s.right, s.answered].join(';')));
    return '\uFEFF' + rows.join('\r\n');
  }

  const HELP = [
    '🎯 <b>Квізоут — бот керування</b>',
    '',
    '/status — стан сервера і сховища',
    '/quizzes — список вікторин',
    '/delete — видалити вікторину',
    '/games — активні ігри (можна завершити)',
    '/results — останні результати',
    '/csv — останні результати файлом для Excel',
    '/notify — які сповіщення отримувати',
    '/link — посилання на сайт',
    '/logout — відключити цей чат',
    '',
    'Бот сам повідомляє: про нові/змінені/видалені вікторини, початок і результати кожної гри, перезапуски сервера та проблеми з базою даних.'
  ].join('\n');

  /* ---------- Команди ---------- */
  const results = () => host.kv.get('results', []);

  async function sendCsv(chat, r) {
    const form = new FormData();
    form.append('chat_id', String(chat));
    form.append('caption', `📄 ${r.title} — ${fmtDate(r.at)}`);
    form.append('document', new Blob([resultCsv(r)], { type: 'text/csv' }), `results-${new Date(r.at).toISOString().slice(0, 10)}.csv`);
    await api('sendDocument', form, 30000).catch(e => send(chat, '⚠️ Не вдалося надіслати файл: ' + esc(e.message)));
  }

  async function command(chat, cmd, args) {
    if (cmd === '/start' || cmd === '/help') return send(chat, isAdmin(chat) ? HELP : '👋 Це бот керування Квізоутом.\nЩоб підключити цей чат, надішліть: <code>/login КОД_ВЧИТЕЛЯ</code>');
    if (cmd === '/login') {
      if (isAdmin(chat)) return send(chat, '✅ Цей чат уже підключено.');
      const r = host.checkCode('tg:' + chat, args);
      if (r === 'blocked') return send(chat, '⏳ Забагато спроб. Зачекайте хвилину.');
      if (r !== 'ok') return send(chat, '❌ Неправильний код.');
      await host.kv.set('tgAdmins', [...host.kv.get('tgAdmins', []), chat]);
      return send(chat, '✅ Чат підключено!\n\n' + HELP);
    }
    if (!isAdmin(chat)) return send(chat, '🔒 Спершу введіть: <code>/login КОД_ВЧИТЕЛЯ</code>');

    switch (cmd) {
      case '/status': return send(chat, await statusText());
      case '/link': {
        const u = host.publicUrl;
        return send(chat, u ? `🌐 Учні: ${esc(u)}/student\n👩‍🏫 Вчитель: ${esc(u)}/teacher` : 'Адреса сайту невідома (задайте змінну PUBLIC_URL).');
      }
      case '/quizzes': {
        const list = [...host.library.values()];
        if (!list.length) return send(chat, '📚 Вікторин ще немає.');
        return send(chat, `📚 <b>Вікторини (${list.length}):</b>\n` + list.map((q, i) => `${i + 1}. ${esc(q.title)} — ${q.questions.length} пит.`).join('\n'));
      }
      case '/delete': {
        const list = [...host.library.values()].slice(0, 40);
        if (!list.length) return send(chat, '📚 Немає що видаляти.');
        return send(chat, '🗑 Яку вікторину видалити?', kb(list.map(q => [{ text: `${short(q.title, 40)} (${q.questions.length})`, callback_data: 'del:' + q.id }])));
      }
      case '/games': {
        const list = [...host.games.values()].filter(g => g.phase !== 'closed');
        if (!list.length) return send(chat, '🎮 Зараз немає активних ігор.');
        const text = list.map(g => `• PIN <code>${esc(g.pin)}</code> · ${esc(g.quiz.title)} · ${PHASES[g.phase] || g.phase}`
          + (g.phase === 'question' || g.phase === 'reveal' ? ` (${g.qi + 1}/${g.quiz.questions.length})` : '') + ` · учнів: ${g.players.size}`).join('\n');
        return send(chat, '🎮 <b>Активні ігри:</b>\n' + text, kb(list.map(g => [{ text: `⏹ Завершити ${g.pin}`, callback_data: 'end:' + g.pin }])));
      }
      case '/results': {
        const list = results().slice(0, 8);
        if (!list.length) return send(chat, '📊 Результатів ще немає — проведіть першу гру.');
        return send(chat, '📊 <b>Останні ігри:</b>\n' + list.map((r, i) => `${i + 1}. ${esc(r.title)} — ${fmtDate(r.at)} · учнів: ${r.players}${r.partial ? ' · достроково' : ''}`).join('\n'),
          kb(list.map((r, i) => [{ text: `${i + 1}. ${short(r.title, 30)}`, callback_data: 'res:' + r.id }])));
      }
      case '/csv': {
        const r = results()[0];
        return r ? sendCsv(chat, r) : send(chat, '📊 Результатів ще немає.');
      }
      case '/notify': return send(chat, notifyText(chat), notifyKb(chat));
      case '/logout':
        await host.kv.set('tgAdmins', host.kv.get('tgAdmins', []).filter(x => x !== chat));
        return send(chat, '👋 Чат відключено. Щоб підключити знову: /login КОД');
      default: return send(chat, 'Невідома команда. Список: /help');
    }
  }

  const notifyText = chat => '🔔 <b>Сповіщення</b>\nНатисніть, щоб увімкнути або вимкнути:';
  const notifyKb = chat => {
    const p = prefsOf(chat);
    return kb(Object.entries(CATS).map(([k, label]) => [{ text: `${p[k] ? '🔔' : '🔕'} ${label}`, callback_data: 't:' + k }]));
  };

  async function callback(q) {
    const chat = q.message && q.message.chat.id, data = q.data || '';
    const answer = text => api('answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => {});
    if (!chat || !isAdmin(chat)) return answer('Немає доступу');
    const [kind, ...rest] = data.split(':'), arg = rest.join(':');

    if (kind === 't' && CATS[arg]) {
      await setPref(chat, arg, !prefsOf(chat)[arg]);
      await api('editMessageReplyMarkup', { chat_id: chat, message_id: q.message.message_id, ...notifyKb(chat) }).catch(() => {});
      return answer('Збережено');
    }
    if (kind === 'del') {
      const quiz = host.library.get(arg);
      if (!quiz) return answer('Вікторину вже видалено');
      await answer();
      return send(chat, `Видалити «${esc(quiz.title)}» (${quiz.questions.length} пит.)?\nЦе не можна скасувати.`,
        kb([[{ text: '🗑 Так, видалити', callback_data: 'delok:' + arg }, { text: 'Скасувати', callback_data: 'no' }]]));
    }
    if (kind === 'delok') {
      if (!host.library.has(arg)) return answer('Вже видалено');
      await host.removeQuiz(arg, 'Telegram').catch(e => send(chat, '⚠️ Не вдалося видалити: ' + esc(e.message)));
      return answer('Видалено');
    }
    if (kind === 'end') {
      const g = host.games.get(arg);
      if (!g) return answer('Гру вже завершено');
      host.closeGame(g, 'Гру завершено вчителем (через Telegram).');
      return answer('Гру завершено');
    }
    if (kind === 'res') {
      const r = results().find(x => x.id === arg);
      if (!r) return answer('Результат не знайдено');
      await answer();
      return send(chat, resultText(r), kb([[{ text: '📄 Файл для Excel', callback_data: 'csv:' + r.id }]]));
    }
    if (kind === 'csv') {
      const r = results().find(x => x.id === arg);
      await answer();
      return r ? sendCsv(chat, r) : undefined;
    }
    return answer();
  }

  async function handleUpdate(u) {
    if (u.callback_query) return callback(u.callback_query);
    const m = u.message;
    if (!m || typeof m.text !== 'string') return;
    const mt = /^(\/\w+)(?:@(\w+))?(?:\s+([\s\S]*))?$/.exec(m.text.trim());
    if (!mt) return isAdmin(m.chat.id) ? send(m.chat.id, 'Список команд: /help') : undefined;
    if (mt[2] && botName && mt[2].toLowerCase() !== botName.toLowerCase()) return;   // команда адресована іншому боту в групі
    return command(m.chat.id, mt[1].toLowerCase(), (mt[3] || '').trim());
  }

  /* ---------- Цикли: опитування Telegram та перевірка бази ---------- */
  async function poll() {
    while (running) {
      try {
        const ups = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 40000);
        for (const u of ups) {
          offset = u.update_id + 1;
          try { await handleUpdate(u); } catch (e) { log('Помилка обробки:', e.message); }
        }
      } catch (e) {
        if (e.code === 401) { log('Невірний токен бота — бот вимкнено.'); running = false; return; }
        if (e.code === 409) log('Бот уже запущений в іншому місці (конфлікт getUpdates). Повтор через 10 с.');
        await sleep(e.code === 409 ? 10000 : 5000);
      }
    }
  }

  async function healthCheck() {
    try {
      await host.dbPing();
      if (dbDown) { dbDown = false; broadcast('system', '🟢 <b>Зв\'язок із базою даних відновлено.</b>'); }
    } catch (e) {
      if (!dbDown) { dbDown = true; broadcast('system', `🔴 <b>База даних недоступна!</b>\n${esc(short(e.message, 200))}\nВікторини можуть не зберігатися.`); }
    }
  }

  async function start() {
    if (!enabled) return;
    try { const me = await api('getMe'); botName = me.username || ''; console.log(`  Telegram-бот: @${botName}${admins().length ? ` (підключених чатів: ${admins().length})` : ' — надішліть йому /login КОД'}`); }
    catch (e) { log('Не вдалося запустити бота:', e.message); return; }
    await api('setMyCommands', { commands: [
      { command: 'status', description: 'Стан сервера' }, { command: 'quizzes', description: 'Список вікторин' },
      { command: 'games', description: 'Активні ігри' }, { command: 'results', description: 'Останні результати' },
      { command: 'csv', description: 'Результати файлом' }, { command: 'delete', description: 'Видалити вікторину' },
      { command: 'notify', description: 'Налаштування сповіщень' }, { command: 'link', description: 'Посилання на сайт' },
      { command: 'help', description: 'Допомога' }
    ] }).catch(() => {});
    running = true;
    poll();
    setInterval(healthCheck, 60000).unref();
    const st = host.storageInfo();
    broadcast('system', `🟢 <b>Сервер запущено</b>\n💾 Сховище: ${esc(st.kind)} ${st.durable ? '✅' : '⚠️ тимчасове — вікторини зникнуть після перезапуску! Підключіть базу даних.'}\n📚 Вікторин: ${host.library.size}`);
  }

  /* ---------- Події сайту ---------- */
  const list = qs => qs.map(q => `• ${esc(q.title)} — ${q.questions.length} пит.`).join('\n');
  return {
    enabled, start,
    notifySystem(text) { if (enabled) broadcast('system', text); },
    onQuizzes(added, updated) {
      if (!enabled) return;
      if (added.length) broadcast('quizzes', `📚 <b>Додано вікторин: ${added.length}</b>\n${list(added.slice(0, 20))}${added.length > 20 ? '\n…' : ''}`);
      if (updated.length) broadcast('quizzes', `✏️ <b>Оновлено вікторин: ${updated.length}</b>\n${list(updated.slice(0, 20))}`);
    },
    onQuizDeleted(quiz, via) {
      if (enabled) broadcast('quizzes', `🗑 <b>Видалено вікторину:</b> ${esc(quiz.title)}${via ? ` (через ${esc(via)})` : ''}`);
    },
    onGameStarted(game) {
      if (enabled) broadcast('games', `▶️ <b>Гру розпочато:</b> ${esc(game.quiz.title)}\nPIN ${esc(game.pin)} · учнів: ${game.players.size} · питань: ${game.quiz.questions.length}`);
    },
    onGameFinished(r) {
      if (enabled) broadcast('games', resultText(r), kb([[{ text: '📄 Файл для Excel', callback_data: 'csv:' + r.id }]]));
    }
  };
};
