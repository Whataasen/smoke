// Чистая логика без DOM и хранилища: работает и в браузере (window.Logic), и в node (тесты).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Logic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const AWAKE_MIN = 16 * 60;
  const PACK = 20;
  const MAX_DAILY = 31; // до этого числа дней график по дням, дальше по неделям
  const MAX_WEEKLY = 182; // дальше по месяцам
  const MAX_RANGE = 3700;

  const pad = (n) => String(n).padStart(2, '0');
  const fmtKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  function dayKey(ms) {
    return fmtKey(new Date(ms));
  }

  function shiftKey(key, days) {
    const [y, m, d] = key.split('-').map(Number);
    return fmtKey(new Date(y, m - 1, d + days, 12));
  }

  function newState(cfg, now) {
    return {
      v: 1,
      cfg: { baseline: cfg.baseline, price: cfg.price },
      interval: cfg.interval,
      day: dayKey(now),
      days: {},
    };
  }

  // Переход на новый день. Интервал сам не меняется — его двигает только пользователь.
  function rollover(state, now) {
    state.day = dayKey(now);
    return state;
  }

  function setTarget(state, minutes) {
    state.interval = Math.min(1440, Math.max(1, Math.round(minutes)));
    const rec = state.days[state.day];
    if (rec) rec.i = state.interval;
    return state;
  }

  const ensureDay = (state, key) => state.days[key] || (state.days[key] = { i: state.interval, s: [] });

  // Время бодрствования между двумя моментами: всё указанное время сна вычитается.
  function awakeMs(state, from, to) {
    let total = to - from;
    for (const key of Object.keys(state.days)) {
      const sl = state.days[key].sl;
      if (!sl) continue;
      const overlap = Math.min(to, sl[1] * 1000) - Math.max(from, sl[0] * 1000);
      if (overlap > 0) total -= overlap;
    }
    return Math.max(0, total);
  }

  // Из «лёг HH:MM» и «встал HH:MM» собирает окно сна прошлой ночи; null, если времена не годятся.
  function sleepWindow(now, bedHM, wakeHM) {
    const parse = (hm) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(hm || '');
      return m && +m[1] < 24 && +m[2] < 60 ? [+m[1], +m[2]] : null;
    };
    const b = parse(bedHM), w = parse(wakeHM);
    if (!b || !w) return null;
    const d = new Date(now);
    const wake = new Date(d.getFullYear(), d.getMonth(), d.getDate(), w[0], w[1]).getTime();
    if (wake > now) return null;
    const bedToday = new Date(d.getFullYear(), d.getMonth(), d.getDate(), b[0], b[1]).getTime();
    const bed =
      bedToday < wake
        ? bedToday
        : new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, b[0], b[1]).getTime();
    return { bed, wake };
  }

  function getSleep(state, now) {
    const rec = state.days[dayKey(now)];
    return rec && rec.sl ? { bed: rec.sl[0] * 1000, wake: rec.sl[1] * 1000 } : null;
  }

  // Срывы за день пересчитываются, когда меняется сон: он влияет на время бодрствования.
  function reflag(state, key) {
    const all = Object.keys(state.days).sort().flatMap((k) => state.days[k].s);
    const rec = state.days[key];
    for (const entry of rec.s) {
      const prev = all[all.indexOf(entry) - 1];
      entry[1] = prev && awakeMs(state, prev[0] * 1000, entry[0] * 1000) < rec.i * 60000 ? 1 : 0;
    }
  }

  function setSleep(state, now, bedMs, wakeMs) {
    rollover(state, now);
    if (!(bedMs < wakeMs && wakeMs <= now && wakeMs - bedMs <= 24 * 3600e3)) return state;
    const rec = ensureDay(state, state.day);
    const bedSec = Math.floor(bedMs / 1000);
    rec.sl = [bedSec, Math.floor(wakeMs / 1000)];
    // Выкуренное после полуночи, но до отбоя, относится ко вчерашнему дню.
    const before = rec.s.filter((x) => x[0] < bedSec);
    if (before.length) {
      ensureDay(state, shiftKey(state.day, -1)).s.push(...before);
      rec.s = rec.s.filter((x) => x[0] >= bedSec);
    }
    reflag(state, state.day);
    return state;
  }

  function clearSleep(state, now) {
    rollover(state, now);
    const rec = state.days[state.day];
    if (rec && rec.sl) {
      delete rec.sl;
      reflag(state, state.day);
    }
    return state;
  }

  function lastSmoke(state) {
    const keys = Object.keys(state.days).filter((k) => state.days[k].s.length).sort();
    if (!keys.length) return null;
    const s = state.days[keys[keys.length - 1]].s;
    return s[s.length - 1][0] * 1000;
  }

  function smoke(state, now) {
    rollover(state, now);
    const last = lastSmoke(state);
    const early = last !== null && awakeMs(state, last, now) < state.interval * 60000 ? 1 : 0;
    const rec = ensureDay(state, state.day);
    rec.s.push([Math.floor(now / 1000), early]);
    return state;
  }

  function undo(state) {
    const rec = state.days[state.day];
    if (rec && rec.s.length) rec.s.pop();
    return state;
  }

  function status(state, now) {
    const last = lastSmoke(state);
    const targetMs = state.interval * 60000;
    if (last === null) return { elapsedMs: null, targetMs, remainingMs: 0, progress: 0, ready: true };
    const elapsedMs = awakeMs(state, last, now);
    return {
      elapsedMs,
      targetMs,
      remainingMs: Math.max(0, targetMs - elapsedMs),
      progress: Math.min(1, elapsedMs / targetMs),
      ready: elapsedMs >= targetMs,
    };
  }

  function stats(state, now) {
    const today = dayKey(now);
    const count = (key) => (state.days[key] ? state.days[key].s.length : 0);

    const ts = state.days[today] ? state.days[today].s.map((x) => x[0]) : [];
    const avgGapMin =
      ts.length < 2 ? null : Math.round((ts[ts.length - 1] - ts[0]) / (ts.length - 1) / 60);

    let saved = 0;
    for (const key of Object.keys(state.days)) {
      if (key < today && count(key) > 0) {
        saved += ((state.cfg.baseline - count(key)) * state.cfg.price) / PACK;
      }
    }

    return {
      today: count(today),
      yesterday: count(shiftKey(today, -1)),
      earlyToday: state.days[today] ? state.days[today].s.filter((x) => x[1]).length : 0,
      avgGapMin,
      saved: Math.round(saved),
    };
  }

  function firstDay(state) {
    const keys = Object.keys(state.days).filter((k) => state.days[k].s.length).sort();
    return keys.length ? keys[0] : null;
  }

  // Все реальные интервалы между сигаретами (время бодрствования).
  function allGaps(state) {
    const out = [];
    let prev = null, prevKey = null;
    for (const key of Object.keys(state.days).sort()) {
      const rec = state.days[key];
      if (!rec.s.length) continue;
      // между днями интервал честный, только если предыдущая сигарета была вчера и сон указан
      const overnightOk = rec.sl && prevKey === shiftKey(key, -1);
      rec.s.forEach((entry, idx) => {
        if (prev && (idx > 0 || overnightOk)) {
          const ms = awakeMs(state, prev[0] * 1000, entry[0] * 1000);
          out.push({ key, ms, ok: ms >= rec.i * 60000 });
        }
        prev = entry;
      });
      prevKey = key;
    }
    return out;
  }

  // Отчёт за период: столбики по дням, неделям или месяцам и общая сводка.
  function report(state, fromKey, toKey) {
    if (fromKey > toKey) [fromKey, toKey] = [toKey, fromKey];
    const keys = [];
    for (let k = fromKey; k <= toKey && keys.length < MAX_RANGE; k = shiftKey(k, 1)) keys.push(k);
    const unit = keys.length <= MAX_DAILY ? 'day' : keys.length <= MAX_WEEKLY ? 'week' : 'month';

    let groups;
    if (unit === 'day') {
      groups = keys.map((k) => [k]);
    } else if (unit === 'week') {
      groups = [];
      for (let end = keys.length; end > 0; end -= 7) groups.unshift(keys.slice(Math.max(0, end - 7), end));
    } else {
      const byMonth = new Map();
      for (const k of keys) {
        const m = k.slice(0, 7);
        if (!byMonth.has(m)) byMonth.set(m, []);
        byMonth.get(m).push(k);
      }
      groups = [...byMonth.values()];
    }

    const gapsByDay = {};
    for (const g of allGaps(state)) (gapsByDay[g.key] || (gapsByDay[g.key] = [])).push(g);

    const aggregate = (ks) => {
      let days = 0, total = 0, targetSum = 0, gapSum = 0, gaps = 0, onTime = 0, longest = 0;
      for (const k of ks) {
        const rec = state.days[k];
        if (rec && rec.s.length) {
          days++;
          total += rec.s.length;
          targetSum += rec.i;
        }
        for (const g of gapsByDay[k] || []) {
          gapSum += g.ms;
          gaps++;
          if (g.ok) onTime++;
          if (g.ms > longest) longest = g.ms;
        }
      }
      return {
        from: ks[0],
        to: ks[ks.length - 1],
        days,
        total,
        perDay: days ? Math.round((total / days) * 10) / 10 : null,
        target: days ? Math.round(targetSum / days) : null,
        actual: gaps ? Math.round(gapSum / gaps / 60000) : null,
        gaps,
        onTime,
        longest: Math.round(longest / 60000),
      };
    };

    return { unit, buckets: groups.map(aggregate), summary: aggregate(keys) };
  }

  function perDay(interval) {
    return Math.round(AWAKE_MIN / interval);
  }

  return { dayKey, shiftKey, newState, rollover, setTarget, sleepWindow, getSleep, setSleep, clearSleep, lastSmoke, smoke, undo, status, stats, firstDay, report, perDay };
});
