// Автотест: запускає сервер і проходить повну гру (викладач + учні) через WebSocket.
// Запуск: npm test
const { spawn } = require('child_process');
const assert = require('assert');
const WebSocket = require('ws');

const PORT = 3456;
const srv = spawn('node', ['server.js'], { env: { ...process.env, PORT }, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

function client() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}`);
    const c = { ws, log: [], cursor: 0, check: null };
    ws.on('message', d => { c.log.push(JSON.parse(d)); c.check && c.check(); });
    c.send = m => ws.send(JSON.stringify(m));
    // чекає перше (ще не спожите) повідомлення, що підходить під умову
    c.next = (pred, ms = 8000) => new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('Таймаут очікування повідомлення')), ms);
      c.check = () => {
        for (let i = c.cursor; i < c.log.length; i++) {
          if (pred(c.log[i])) { c.cursor = i + 1; clearTimeout(t); c.check = null; return res(c.log[i]); }
        }
      };
      c.check();
    });
    ws.on('open', () => resolve(c));
    ws.on('error', reject);
  });
}
async function connectWithRetry() {
  for (let i = 0; i < 30; i++) { try { return await client(); } catch { await sleep(200); } }
  throw new Error('Сервер не запустився');
}
const state = phase => m => m.t === 'state' && m.phase === phase;

const QUIZ = {
  title: 'Тест',
  questions: [
    { text: 'СЕКРЕТНЕ ПИТАННЯ ОДИН', answers: ['a', 'b', 'c'], correct: 1, time: 10 },
    { text: 'СЕКРЕТНЕ ПИТАННЯ ДВА', answers: ['a', 'b'], correct: 0, time: 10 },
    { text: 'СЕКРЕТНЕ ПИТАННЯ ТРИ', answers: ['a', 'b', 'c', 'd'], correct: 3, time: 5 }
  ]
};

(async () => {
  try {
    const teacher = await connectWithRetry();
    // без коду вчителя створити гру не можна
    teacher.send({ t: 'create', quiz: QUIZ });
    await teacher.next(m => m.t === 'authFail');
    teacher.send({ t: 'auth', code: 'WRONG1' });
    await teacher.next(m => m.t === 'authFail');
    teacher.send({ t: 'auth', code: 'mrb211' }); // регістр не важливий
    await teacher.next(m => m.t === 'authOk');
    console.log('✓ Без коду гру створити не можна; код MRB211 приймається');
    teacher.send({ t: 'create', quiz: QUIZ });
    const created = await teacher.next(m => m.t === 'created');
    assert.match(created.pin, /^\d{6}$/);
    console.log('✓ Гру створено, PIN', created.pin);

    // неправильний PIN
    const stray = await connectWithRetry();
    stray.send({ t: 'join', pin: '000000', name: 'X' });
    await stray.next(m => m.t === 'joinError');
    console.log('✓ Неправильний PIN відхилено');

    // учні приєднуються (двоє з однаковим ім'ям)
    const alice = await connectWithRetry(), bob = await connectWithRetry(), bob2 = await connectWithRetry();
    alice.send({ t: 'join', name: 'Аліса' }); // без PIN і без коду: гра зараз одна
    bob.send({ t: 'join', pin: created.pin, name: 'Богдан' });
    bob2.send({ t: 'join', pin: created.pin, name: 'богдан' });
    const aJoined = await alice.next(m => m.t === 'joined');
    assert.strictEqual(aJoined.pin, created.pin);
    console.log('✓ Учень зайшов без коду й без PIN (гра одна)');
    const bJoined = await bob.next(m => m.t === 'joined');
    const b2Joined = await bob2.next(m => m.t === 'joined');
    assert.notStrictEqual(b2Joined.name.toLowerCase(), bJoined.name.toLowerCase());
    console.log('✓ Учні приєдналися, дубль імені розв\'язано:', b2Joined.name);
    await teacher.next(m => m.t === 'players' && m.players.length === 3);

    // старт
    teacher.send({ t: 'next' });
    const tq = await teacher.next(state('question'));
    assert.strictEqual(tq.question.text, 'СЕКРЕТНЕ ПИТАННЯ ОДИН');
    const aq = await alice.next(state('question'));
    await bob.next(state('question')); await bob2.next(state('question'));

    // учні НЕ бачать питання й правильну відповідь
    const raw = JSON.stringify(aq);
    assert(!raw.includes('СЕКРЕТНЕ'), 'учень отримав текст питання!');
    assert(!('text' in aq.question) && !('correct' in aq.question) && !('correctIndex' in aq.question));
    assert(!('answers' in aq.question), 'учень отримав текст відповідей!');
    assert.strictEqual(aq.question.count, 3);
    assert.deepStrictEqual(tq.question.answers, ['a', 'b', 'c']); // а головний екран — отримує все
    console.log('✓ Учень отримує лише кількість символів; питання й варіанти — тільки головний екран');

    // відповіді: Аліса правильно, Богдан неправильно, Богдан-2 теж правильно
    alice.send({ t: 'answer', choice: 1 });
    await alice.next(m => m.t === 'answerAck');
    alice.send({ t: 'answer', choice: 0 }); // повторна відповідь ігнорується
    bob.send({ t: 'answer', choice: 0 });
    await sleep(300);
    bob2.send({ t: 'answer', choice: 1 });

    const rev1 = await teacher.next(state('reveal'));
    assert.deepStrictEqual(rev1.reveal.counts, [1, 2, 0]);
    const aRes = (await alice.next(state('reveal'))).result;
    const bRes = (await bob.next(state('reveal'))).result;
    assert(aRes.correct && aRes.gain > 500 && aRes.score === aRes.gain);
    assert(!bRes.correct && bRes.gain === 0 && bRes.score === 0);
    assert.strictEqual(aRes.correctIndex, 1);
    console.log(`✓ Питання завершилось, коли всі відповіли. Бали Аліси: ${aRes.score}, Богдана: ${bRes.score}`);

    // оновлення сторінки учнем у фазі результатів
    bob.ws.close();
    const bobBack = await connectWithRetry();
    bobBack.send({ t: 'join', pin: created.pin, token: bJoined.token });
    const bs = await bobBack.next(state('reveal'));
    assert.strictEqual(bs.name, 'Богдан');
    console.log('✓ Учень повернувся в гру після перепідключення');

    // нового учня після старту не пускають
    const late = await connectWithRetry();
    late.send({ t: 'join', pin: created.pin, name: 'Пізній' });
    await late.next(m => m.t === 'joinError');
    console.log('✓ Після старту нові гравці не приєднуються');

    // питання 2
    teacher.send({ t: 'next' });
    await teacher.next(state('question'));
    await alice.next(state('question'));
    alice.send({ t: 'answer', choice: 0 });
    bobBack.send({ t: 'answer', choice: 0 });
    bob2.send({ t: 'answer', choice: 1 });
    const rev2 = await teacher.next(state('reveal'));
    assert.deepStrictEqual(rev2.reveal.counts, [2, 1]);
    const a2 = (await alice.next(state('reveal'))).result;
    assert(a2.score > aRes.score, 'бали мають накопичуватись');
    console.log('✓ Бали накопичуються, серія правильних відповідей дає бонус');

    // питання 3: ніхто не відповідає — спрацьовує таймер
    teacher.send({ t: 'next' });
    await teacher.next(state('question'));
    const t0 = Date.now();
    const rev3 = await teacher.next(state('reveal'), 9000);
    const dt = Date.now() - t0;
    assert(dt >= 4500 && dt < 7500, 'таймер: ' + dt);
    assert(rev3.reveal.last === true);
    const noAns = (await alice.next(state('reveal'))).result;
    assert.strictEqual(noAns.choice, null);
    console.log(`✓ Таймер завершив питання сам (~${(dt / 1000).toFixed(1)} с), останнє питання визначено`);

    // фінал
    teacher.send({ t: 'next' });
    const fin = await teacher.next(state('finished'));
    assert.strictEqual(fin.leaderboard[0].name, 'Аліса');
    assert.strictEqual(fin.leaderboard.length, 3);
    const af = (await alice.next(state('finished'))).final;
    assert.strictEqual(af.rank, 1);
    console.log('✓ Фінал: переможець —', fin.leaderboard[0].name, fin.leaderboard[0].score);

    // повернення викладача після оновлення сторінки
    teacher.ws.close();
    const t2 = await connectWithRetry();
    t2.send({ t: 'resume', pin: created.pin, token: created.token });
    await t2.next(state('finished'));
    console.log('✓ Викладач повернувся у гру після перепідключення');

    // захист від підбору коду: після 5 помилок — блокування
    const brute = await connectWithRetry();
    for (let i = 0; i < 5; i++) { brute.send({ t: 'auth', code: 'BAD' + i }); await brute.next(m => m.t === 'authFail'); }
    brute.send({ t: 'auth', code: 'MRB211' });
    await brute.next(m => m.t === 'authBlocked');
    console.log('✓ Підбір коду блокується після 5 помилок');

    console.log('\nУСІ ПЕРЕВІРКИ ПРОЙДЕНО');
    srv.kill(); process.exit(0);
  } catch (e) {
    console.error('\n✗ ПОМИЛКА:', e.message);
    srv.kill(); process.exit(1);
  }
})();
