const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('./logic.js');

const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime(); // ноябрь 2026, локальное время
const fresh = (now, over = {}) =>
  L.newState({ interval: 60, baseline: 20, price: 200, ...over }, now);

test('день считается по календарю, с полуночи', () => {
  assert.equal(L.dayKey(at(12, 23, 59)), '2026-11-12');
  assert.equal(L.dayKey(at(13, 0, 0)), '2026-11-13');
});

test('окно сна: лёг после полуночи — обе точки сегодня', () => {
  assert.deepEqual(L.sleepWindow(at(13, 10), '00:30', '08:00'), { bed: at(13, 0, 30), wake: at(13, 8) });
});

test('окно сна: лёг до полуночи — отбой вчера', () => {
  assert.deepEqual(L.sleepWindow(at(13, 10), '23:15', '07:00'), { bed: at(12, 23, 15), wake: at(13, 7) });
});

test('окно сна: подъём в будущем не принимается', () => {
  assert.equal(L.sleepWindow(at(13, 10), '00:30', '11:00'), null);
});

test('окно сна: пустое время не принимается', () => {
  assert.equal(L.sleepWindow(at(13, 10), '', '08:00'), null);
});

test('сон вычитается из секундомера', () => {
  let s = L.smoke(fresh(at(12, 23)), at(12, 23, 50));
  s = L.setSleep(s, at(13, 8, 5), at(13, 0), at(13, 8));
  assert.equal(L.status(s, at(13, 8, 5)).elapsedMs, 15 * 60000);
  assert.deepEqual(L.getSleep(s, at(13, 8, 5)), { bed: at(13, 0), wake: at(13, 8) });
});

test('без указанного сна ночь считается целиком', () => {
  const s = L.smoke(fresh(at(12, 23)), at(12, 23, 50));
  assert.equal(L.status(s, at(13, 8, 5)).elapsedMs, (8 * 60 + 15) * 60000);
  assert.equal(L.getSleep(s, at(13, 8, 5)), null);
});

test('сигареты после полуночи, но до отбоя, переносятся во вчера', () => {
  let s = L.smoke(fresh(at(12, 22)), at(12, 22));
  s = L.smoke(s, at(13, 0, 20));
  s = L.setSleep(s, at(13, 9), at(13, 1), at(13, 8));
  assert.equal(s.days['2026-11-12'].s.length, 2);
  assert.equal(s.days['2026-11-13'].s.length, 0);
  assert.equal(L.stats(s, at(13, 9)).yesterday, 2);
});

test('первая сигарета после сна — срыв, если бодрствования меньше интервала', () => {
  let s = L.smoke(fresh(at(12, 23)), at(12, 23, 50));
  s = L.setSleep(s, at(13, 8, 5), at(13, 0), at(13, 8));
  s = L.smoke(s, at(13, 8, 10));
  assert.equal(s.days['2026-11-13'].s[0][1], 1);
});

test('сон, указанный после утренней сигареты, пересчитывает срыв', () => {
  let s = L.smoke(fresh(at(12, 23)), at(12, 23, 50));
  s = L.smoke(s, at(13, 8, 10));
  assert.equal(s.days['2026-11-13'].s[0][1], 0);
  s = L.setSleep(s, at(13, 9), at(13, 0), at(13, 8));
  assert.equal(s.days['2026-11-13'].s[0][1], 1);
});

test('сон с подъёмом раньше отбоя не сохраняется', () => {
  const s = L.setSleep(fresh(at(13, 9)), at(13, 9), at(13, 8), at(13, 1));
  assert.equal(L.getSleep(s, at(13, 9)), null);
});

test('убранный сон снова считается в секундомере', () => {
  let s = L.smoke(fresh(at(12, 23)), at(12, 23, 50));
  s = L.setSleep(s, at(13, 8, 5), at(13, 0), at(13, 8));
  s = L.clearSleep(s, at(13, 8, 5));
  assert.equal(L.status(s, at(13, 8, 5)).elapsedMs, (8 * 60 + 15) * 60000);
});

test('первая сигарета не считается срывом', () => {
  const s = L.smoke(fresh(at(13, 9)), at(13, 9));
  assert.deepEqual(s.days['2026-11-13'].s, [[at(13, 9) / 1000, 0]]);
});

test('сигарета раньше интервала помечается срывом', () => {
  let s = L.smoke(fresh(at(13, 9)), at(13, 9));
  s = L.smoke(s, at(13, 9, 59));
  assert.equal(s.days['2026-11-13'].s[1][1], 1);
});

test('сигарета ровно через интервал — не срыв', () => {
  let s = L.smoke(fresh(at(13, 9)), at(13, 9));
  s = L.smoke(s, at(13, 10));
  assert.equal(s.days['2026-11-13'].s[1][1], 0);
});

test('новый день сам интервал не меняет', () => {
  let s = L.smoke(fresh(at(13, 9)), at(13, 9));
  s = L.smoke(s, at(13, 11));
  s = L.rollover(s, at(14, 8));
  assert.equal(s.interval, 60);
  assert.equal(s.day, '2026-11-14');
});

test('внутри одного дня rollover ничего не меняет', () => {
  let s = L.smoke(fresh(at(13, 9)), at(13, 9));
  s = L.rollover(s, at(13, 23));
  assert.equal(s.interval, 60);
});

test('ручная смена интервала действует сразу и попадает в запись дня', () => {
  let s = L.smoke(fresh(at(13, 9)), at(13, 9));
  s = L.setTarget(s, 90);
  s = L.smoke(s, at(13, 10));
  assert.equal(s.interval, 90);
  assert.equal(s.days['2026-11-13'].i, 90);
  assert.equal(s.days['2026-11-13'].s[1][1], 1);
});

test('интервал нельзя выставить меньше 1 минуты и больше суток', () => {
  assert.equal(L.setTarget(fresh(at(13, 9)), -10).interval, 1);
  assert.equal(L.setTarget(fresh(at(13, 9)), 5000).interval, 1440);
});

test('статистика: срывы за сегодня', () => {
  let s = L.smoke(fresh(at(13, 9)), at(13, 9));
  s = L.smoke(s, at(13, 9, 20));
  assert.equal(L.stats(s, at(13, 10)).earlyToday, 1);
});

test('отмена убирает последнюю сигарету сегодня', () => {
  let s = L.smoke(fresh(at(13, 9)), at(13, 9));
  s = L.smoke(s, at(13, 9, 10));
  s = L.undo(s);
  assert.equal(s.days['2026-11-13'].s.length, 1);
  assert.equal(L.lastSmoke(s), at(13, 9));
});

test('статус: до интервала показывает остаток и прогресс', () => {
  const s = L.smoke(fresh(at(13, 9)), at(13, 9));
  const st = L.status(s, at(13, 9, 15));
  assert.equal(st.elapsedMs, 15 * 60000);
  assert.equal(st.remainingMs, 45 * 60000);
  assert.equal(st.progress, 0.25);
  assert.equal(st.ready, false);
});

test('статус: после интервала готов, прогресс не больше 1', () => {
  const s = L.smoke(fresh(at(13, 9)), at(13, 9));
  const st = L.status(s, at(13, 11));
  assert.equal(st.ready, true);
  assert.equal(st.progress, 1);
  assert.equal(st.remainingMs, 0);
});

test('статус без сигарет: таймер не идёт', () => {
  const st = L.status(fresh(at(13, 9)), at(13, 10));
  assert.equal(st.elapsedMs, null);
  assert.equal(st.ready, true);
});

test('статистика: счётчики за сегодня и вчера', () => {
  let s = L.smoke(fresh(at(13, 9)), at(13, 9));
  s = L.smoke(s, at(13, 12));
  s = L.smoke(s, at(14, 9));
  const st = L.stats(s, at(14, 10));
  assert.equal(st.today, 1);
  assert.equal(st.yesterday, 2);
});

test('статистика: средний промежуток считается только внутри дня', () => {
  let s = L.smoke(fresh(at(13, 22)), at(13, 22));
  s = L.smoke(s, at(14, 9));
  s = L.smoke(s, at(14, 10));
  s = L.smoke(s, at(14, 12));
  assert.equal(L.stats(s, at(14, 13)).avgGapMin, 90);
});

test('статистика: средний промежуток пуст при одной сигарете', () => {
  const s = L.smoke(fresh(at(13, 9)), at(13, 9));
  assert.equal(L.stats(s, at(13, 10)).avgGapMin, null);
});

test('статистика: экономия считается по завершённым дням относительно нормы', () => {
  // норма 20 в день, пачка 200 → 10 за сигарету; вчера 2 сигареты → сэкономлено 180
  let s = L.smoke(fresh(at(13, 9)), at(13, 9));
  s = L.smoke(s, at(13, 12));
  s = L.smoke(s, at(14, 9));
  assert.equal(L.stats(s, at(14, 10)).saved, 180);
});

test('оценка сигарет в день при 16 часах бодрствования', () => {
  assert.equal(L.perDay(60), 16);
  assert.equal(L.perDay(480), 2);
});

// ---------- отчёт за период ----------
const on = (y, m, d, h = 12, mi = 0) => new Date(y, m - 1, d, h, mi).getTime();

test('отчёт: до 31 дня — по дням, пустые дни без значений', () => {
  let s = L.smoke(fresh(at(12, 9)), at(12, 9));
  s = L.smoke(s, at(12, 11));
  const r = L.report(s, '2026-11-11', '2026-11-13');
  assert.equal(r.unit, 'day');
  assert.equal(r.buckets.length, 3);
  assert.equal(r.buckets[0].perDay, null);
  assert.equal(r.buckets[1].perDay, 2);
  assert.equal(r.buckets[1].from, '2026-11-12');
});

test('отчёт: реальный интервал — среднее между сигаретами, рядом заданный', () => {
  let s = L.smoke(fresh(at(12, 9)), at(12, 9));
  s = L.smoke(s, at(12, 10));
  s = L.smoke(s, at(12, 11, 30));
  const b = L.report(s, '2026-11-12', '2026-11-12').buckets[0];
  assert.equal(b.actual, 75);
  assert.equal(b.target, 60);
  assert.equal(b.gaps, 2);
  assert.equal(b.onTime, 2);
});

test('отчёт: сигарета раньше времени не считается выдержанной', () => {
  let s = L.smoke(fresh(at(12, 9)), at(12, 9));
  s = L.smoke(s, at(12, 9, 30));
  s = L.smoke(s, at(12, 11));
  const b = L.report(s, '2026-11-12', '2026-11-12').buckets[0];
  assert.equal(b.gaps, 2);
  assert.equal(b.onTime, 1);
  assert.equal(b.actual, 60);
});

test('отчёт: ночной промежуток без указанного сна в интервалы не идёт', () => {
  let s = L.smoke(fresh(at(12, 23)), at(12, 23));
  s = L.smoke(s, at(13, 9));
  s = L.smoke(s, at(13, 10));
  const b = L.report(s, '2026-11-13', '2026-11-13').buckets[0];
  assert.equal(b.gaps, 1);
  assert.equal(b.actual, 60);
});

test('отчёт: с указанным сном первый интервал дня считается по бодрствованию', () => {
  let s = L.smoke(fresh(at(12, 23)), at(12, 23));
  s = L.smoke(s, at(13, 9));
  s = L.setSleep(s, at(13, 9, 30), at(13, 0), at(13, 8));
  const b = L.report(s, '2026-11-13', '2026-11-13').buckets[0];
  assert.equal(b.gaps, 1);
  assert.equal(b.actual, 120);
});

test('отчёт: от 32 дней — по неделям, последняя неделя заканчивается концом периода', () => {
  const s = fresh(on(2026, 9, 1));
  const r = L.report(s, '2026-10-01', '2026-11-13');
  assert.equal(r.unit, 'week');
  const last = r.buckets[r.buckets.length - 1];
  assert.equal(last.from, '2026-11-07');
  assert.equal(last.to, '2026-11-13');
  assert.equal(r.buckets[0].from, '2026-10-01');
});

test('отчёт: больше полугода — по календарным месяцам', () => {
  const s = fresh(on(2026, 1, 1));
  const r = L.report(s, '2026-01-15', '2026-11-13');
  assert.equal(r.unit, 'month');
  assert.equal(r.buckets.length, 11);
  assert.equal(r.buckets[0].from, '2026-01-15');
  assert.equal(r.buckets[1].from, '2026-02-01');
  assert.equal(r.buckets[1].to, '2026-02-28');
});

test('отчёт: недельный столбик усредняет сигареты по дням с записями', () => {
  let s = fresh(on(2026, 10, 1));
  for (const h of [9, 11, 13]) s = L.smoke(s, at(10, h));
  s = L.smoke(s, at(12, 9));
  const r = L.report(s, '2026-10-01', '2026-11-13');
  const last = r.buckets[r.buckets.length - 1];
  assert.equal(last.days, 2);
  assert.equal(last.total, 4);
  assert.equal(last.perDay, 2);
});

test('отчёт: сводка за период', () => {
  let s = L.smoke(fresh(at(11, 9)), at(11, 9));
  s = L.smoke(s, at(11, 9, 30));
  s = L.smoke(s, at(12, 9));
  s = L.smoke(s, at(12, 12));
  const sum = L.report(s, '2026-11-10', '2026-11-13').summary;
  assert.equal(sum.days, 2);
  assert.equal(sum.total, 4);
  assert.equal(sum.perDay, 2);
  assert.equal(sum.gaps, 2);
  assert.equal(sum.onTime, 1);
  assert.equal(sum.actual, 105);
  assert.equal(sum.longest, 180);
  assert.equal(sum.target, 60);
});

test('отчёт: перепутанные даты периода меняются местами', () => {
  const r = L.report(fresh(at(13, 9)), '2026-11-13', '2026-11-11');
  assert.equal(r.buckets.length, 3);
});

test('первый день с записями', () => {
  assert.equal(L.firstDay(fresh(at(13, 9))), null);
  let s = L.smoke(fresh(at(11, 9)), at(11, 9));
  s = L.smoke(s, at(13, 9));
  assert.equal(L.firstDay(s), '2026-11-11');
});

test('отчёт: интервал через пропущенный день не считается, даже если сон указан', () => {
  let s = L.smoke(fresh(at(10, 22)), at(10, 22));
  s = L.smoke(s, at(12, 9));
  s = L.setSleep(s, at(12, 9, 30), at(12, 0), at(12, 8));
  s = L.smoke(s, at(12, 11));
  const b = L.report(s, '2026-11-12', '2026-11-12').buckets[0];
  assert.equal(b.gaps, 1);
  assert.equal(b.actual, 120);
});
