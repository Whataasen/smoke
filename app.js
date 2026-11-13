(function () {
  'use strict';
  const L = window.Logic;
  const tg = window.Telegram && window.Telegram.WebApp;
  const $ = (id) => document.getElementById(id);

  const RING_LEN = 753.98;
  const UNDO_WINDOW_MS = 10 * 60000;

  // ---------- хранилище: Telegram CloudStorage, вне Telegram — localStorage ----------
  const inTelegram = !!(tg && tg.initData && tg.isVersionAtLeast && tg.isVersionAtLeast('6.9'));
  const call = (fn) => new Promise((res, rej) => fn((err, val) => (err ? rej(new Error(err)) : res(val))));
  const LS = 'smoke:';

  const store = inTelegram
    ? {
        keys: () => call((cb) => tg.CloudStorage.getKeys(cb)),
        async getMany(keys) {
          const out = {};
          for (let i = 0; i < keys.length; i += 50) {
            const chunk = keys.slice(i, i + 50);
            Object.assign(out, await call((cb) => tg.CloudStorage.getItems(chunk, cb)));
          }
          return out;
        },
        set: (k, v) => call((cb) => tg.CloudStorage.setItem(k, v, cb)),
        async removeMany(keys) {
          for (let i = 0; i < keys.length; i += 50) {
            const chunk = keys.slice(i, i + 50);
            await call((cb) => tg.CloudStorage.removeItems(chunk, cb));
          }
        },
      }
    : {
        async keys() {
          return Object.keys(localStorage).filter((k) => k.startsWith(LS)).map((k) => k.slice(LS.length));
        },
        async getMany(keys) {
          const out = {};
          for (const k of keys) out[k] = localStorage.getItem(LS + k);
          return out;
        },
        async set(k, v) {
          localStorage.setItem(LS + k, v);
        },
        async removeMany(keys) {
          for (const k of keys) localStorage.removeItem(LS + k);
        },
      };

  let state = null;
  let saveChain = Promise.resolve();

  async function load() {
    const keys = await store.keys();
    if (!keys.includes('meta')) return null;
    const items = await store.getMany(keys.filter((k) => k === 'meta' || k.startsWith('d:')));
    const s = JSON.parse(items.meta);
    s.days = {};
    for (const k of Object.keys(items)) {
      if (k.startsWith('d:') && items[k]) s.days[k.slice(2)] = JSON.parse(items[k]);
    }
    return s;
  }

  // Сохраняем мету и только изменившиеся дни; записи идут строго по очереди.
  function save(dayKeys) {
    const { days, ...meta } = state;
    const writes = [['meta', JSON.stringify(meta)]];
    for (const k of dayKeys || []) if (days[k]) writes.push(['d:' + k, JSON.stringify(days[k])]);
    saveChain = saveChain
      .then(async () => {
        for (const [k, v] of writes) await store.set(k, v);
      })
      .catch((e) => alertMsg('Не удалось сохранить: ' + e.message));
    return saveChain;
  }

  // ---------- форматирование ----------
  const plural = (n, forms) => {
    const a = Math.abs(n) % 100, b = a % 10;
    return forms[a > 10 && a < 20 ? 2 : b === 1 ? 0 : b >= 2 && b <= 4 ? 1 : 2];
  };
  const CIG = ['сигарета', 'сигареты', 'сигарет'];
  const pad = (n) => String(n).padStart(2, '0');

  function fmtClock(ms) {
    const t = Math.floor(ms / 1000);
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  function fmtMin(min) {
    const h = Math.floor(min / 60), m = min % 60;
    return h ? (m ? `${h} ч ${m} мин` : `${h} ч`) : `${m} мин`;
  }
  function fmtDay(key) {
    const [y, m, d] = key.split('-').map(Number);
    const opts = { day: 'numeric', month: 'long' };
    if (y !== new Date().getFullYear()) opts.year = 'numeric';
    return new Date(y, m - 1, d).toLocaleDateString('ru-RU', opts);
  }

  function alertMsg(text) {
    if (inTelegram && tg.showAlert) tg.showAlert(text);
    else alert(text);
  }
  function confirmMsg(text) {
    if (inTelegram && tg.showConfirm) return new Promise((res) => tg.showConfirm(text, res));
    return Promise.resolve(confirm(text));
  }
  function haptic(kind) {
    try {
      if (inTelegram && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred(kind);
    } catch (e) { /* не критично */ }
  }

  // ---------- экраны ----------
  function show(id) {
    for (const el of ['loading', 'fatal', 'onboard', 'main']) $(el).hidden = el !== id;
  }

  function tick() {
    if (!state) return;
    const now = Date.now();
    if (L.dayKey(now) !== state.day) {
      L.rollover(state, now);
      save();
      renderAll();
      return;
    }
    const st = L.status(state, now);
    $('clock').textContent = st.elapsedMs === null ? '0:00' : fmtClock(st.elapsedMs);
    $('prog').style.strokeDashoffset = String(RING_LEN * (1 - st.progress));
    $('ring').classList.toggle('ready', st.ready && st.elapsedMs !== null);
    $('target').textContent = 'интервал ' + fmtMin(state.interval);

    let line;
    if (st.elapsedMs === null) {
      line = 'Нажми кнопку, когда покуришь — отсчёт пойдёт с этого момента.';
    } else if (!st.ready) {
      line = `Ещё рано. Осталось <b>${fmtClock(st.remainingMs)}</b>`;
    } else {
      const over = Math.floor((st.elapsedMs - st.targetMs) / 60000);
      line = `<b class="ok">✓ Интервал выдержан</b>` + (over > 0 ? ` · сверху ${fmtMin(over)}` : '');
    }
    $('status').innerHTML = line;

    const last = L.lastSmoke(state);
    const rec = state.days[state.day];
    $('undo').hidden = !(rec && rec.s.length && last !== null && now - last < UNDO_WINDOW_MS);
  }

  // ---------- статистика за период ----------
  const MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const UNIT_SUFFIX = { day: '', week: ', по неделям', month: ', по месяцам' };
  let preset = '14'; // активная кнопка периода; null, если даты выбраны вручную
  let custom = null;

  function currentPeriod() {
    const today = L.dayKey(Date.now());
    if (custom) return custom;
    if (preset === 'all') return { from: L.firstDay(state) || today, to: today };
    return { from: L.shiftKey(today, -(Number(preset) - 1)), to: today };
  }

  const rangeLabel = (b) => (b.from === b.to ? fmtDay(b.from) : `${fmtDay(b.from)} – ${fmtDay(b.to)}`);
  function tickLabel(b, unit) {
    const [, m, d] = b.from.split('-').map(Number);
    return unit === 'day' ? String(d) : unit === 'week' ? `${d}.${pad(m)}` : MONTHS[m - 1];
  }

  // series: [{ cls, value(bucket) → число или null }]
  function drawChart(prefix, rep, series, maxLabel, describe) {
    const chart = $('chart-' + prefix), days = $('days-' + prefix), info = $('info-' + prefix);
    const max = Math.max(1, ...rep.buckets.flatMap((b) => series.map((s) => s.value(b) || 0)));
    chart.innerHTML = '';
    const maxEl = document.createElement('span');
    maxEl.className = 'max';
    maxEl.textContent = maxLabel(max);
    chart.appendChild(maxEl);
    days.innerHTML = '';
    const n = rep.buckets.length;
    const every = Math.ceil(n / 8);
    const today = L.dayKey(Date.now());
    rep.buckets.forEach((b, idx) => {
      const col = document.createElement('div');
      col.className = 'col';
      for (const s of series) {
        const v = s.value(b);
        const bar = document.createElement('div');
        if (v === null) bar.className = 'bar empty';
        else {
          bar.className = 'bar ' + s.cls;
          bar.style.height = Math.max(2, Math.round((v / max) * 88)) + 'px';
        }
        col.appendChild(bar);
      }
      const text = `${rangeLabel(b)}: ${describe(b)}`;
      col.title = text;
      col.addEventListener('click', () => {
        chart.querySelectorAll('.col.sel').forEach((c) => c.classList.remove('sel'));
        col.classList.add('sel');
        info.textContent = text;
      });
      chart.appendChild(col);

      const lab = document.createElement('span');
      if ((n - 1 - idx) % every === 0) lab.textContent = tickLabel(b, rep.unit);
      if (b.from <= today && today <= b.to) lab.className = 'today';
      days.appendChild(lab);
    });
    info.textContent = 'Нажми на столбик, чтобы увидеть подробности.';
  }

  function renderReport() {
    const period = currentPeriod();
    const today = L.dayKey(Date.now());
    $('p-from').value = period.from;
    $('p-to').value = period.to;
    $('p-from').max = today;
    $('p-to').max = today;
    document.querySelectorAll('#chips .chip').forEach((c) => c.classList.toggle('on', !custom && c.dataset.p === preset));

    const rep = L.report(state, period.from, period.to);
    const sum = rep.summary;
    $('p-perday').textContent = sum.perDay === null ? '—' : sum.perDay.toLocaleString('ru-RU');
    $('p-actual').textContent = sum.actual === null ? '—' : fmtMin(sum.actual);
    $('p-actual-l').textContent =
      'реальный интервал' + (sum.target === null ? '' : ` · заданный ${fmtMin(sum.target)}`);
    $('p-ontime').textContent = sum.gaps ? Math.round((sum.onTime / sum.gaps) * 100) + '%' : '—';
    $('p-ontime-l').textContent = 'выдержано вовремя' + (sum.gaps ? ` (${sum.onTime} из ${sum.gaps})` : '');
    $('p-longest').textContent = sum.gaps ? fmtMin(sum.longest) : '—';

    $('h-iv').textContent = 'Интервал: заданный и реальный' + UNIT_SUFFIX[rep.unit];
    drawChart(
      'iv',
      rep,
      [
        { cls: 's1', value: (b) => b.target },
        { cls: 's2', value: (b) => b.actual },
      ],
      (max) => fmtMin(max),
      (b) => {
        if (!b.days) return 'нет записей';
        let t = `заданный ${fmtMin(b.target)}, реальный ${b.actual === null ? 'нет данных' : fmtMin(b.actual)}`;
        if (b.gaps) t += `. Вовремя ${b.onTime} из ${b.gaps}`;
        return t;
      }
    );

    $('h-cig').textContent = 'Сигарет в день' + UNIT_SUFFIX[rep.unit];
    drawChart(
      'cig',
      rep,
      [{ cls: 'mono', value: (b) => b.perDay }],
      (max) => String(Math.ceil(max)),
      (b) => {
        if (!b.days) return 'нет записей';
        if (rep.unit === 'day') return `${b.total} ${plural(b.total, CIG)}`;
        return `в среднем ${b.perDay.toLocaleString('ru-RU')} в день (всего ${b.total} за ${b.days} дн. с записями)`;
      }
    );
  }

  function renderStats() {
    const st = L.stats(state, Date.now());
    $('s-today').textContent = st.today;
    $('s-yesterday').textContent = st.yesterday;
    $('s-gap').textContent = st.avgGapMin === null ? '—' : fmtMin(st.avgGapMin);
    $('s-saved').textContent = st.saved.toLocaleString('ru-RU') + ' ₽';

    renderReport();

    const est = L.perDay(state.interval);
    $('iv').textContent = fmtMin(state.interval);
    $('iv-est').textContent = `≈ ${est} ${plural(est, CIG)} в день`;
    $('minus').disabled = state.interval <= 1;
    $('plus').disabled = state.interval >= 1440;
  }

  const hm = (ms) => {
    const d = new Date(ms);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  function renderSleep(error) {
    const sl = L.getSleep(state, Date.now());
    const info = $('sl-info');
    info.classList.toggle('bad', !!error);
    if (sl) {
      $('sl-bed').value = hm(sl.bed);
      $('sl-wake').value = hm(sl.wake);
    }
    $('sl-clear').hidden = !sl;
    if (error) info.textContent = error;
    else if (sl) info.textContent = `Сон ${fmtMin(Math.round((sl.wake - sl.bed) / 60000))} не идёт в счёт интервала.`;
    else info.textContent = 'Не указан — ночь пока считается как время без сигарет.';
  }

  function renderAll() {
    renderStats();
    renderSleep();
    tick();
  }

  // ---------- действия ----------
  const num = (id) => {
    const v = Number($(id).value.trim().replace(',', '.'));
    return Number.isFinite(v) ? Math.round(v) : NaN;
  };
  function readCfg(prefix) {
    const cfg = {
      interval: num(prefix + '-interval'),
      baseline: num(prefix + '-baseline'),
      price: num(prefix + '-price'),
    };
    if (!(cfg.interval >= 1 && cfg.interval <= 1440)) return { err: 'Интервал — от 1 до 1440 минут.' };
    if (!(cfg.baseline >= 1 && cfg.baseline <= 200)) return { err: 'Сигарет в день — от 1 до 200.' };
    if (!(cfg.price >= 0)) return { err: 'Цена пачки не может быть отрицательной.' };
    return { cfg };
  }

  $('onboard').addEventListener('submit', (e) => {
    e.preventDefault();
    const { cfg, err } = readCfg('ob');
    $('ob-err').textContent = err || '';
    if (err) return;
    state = L.newState(cfg, Date.now());
    save();
    show('main');
    renderAll();
  });

  $('smoke').addEventListener('click', () => {
    const now = Date.now();
    const wasReady = L.status(state, now).ready;
    L.smoke(state, now);
    save([state.day]);
    haptic(wasReady ? 'success' : 'warning');
    renderAll();
  });

  $('chips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    preset = chip.dataset.p;
    custom = null;
    renderReport();
  });
  function onRangeChange() {
    const from = $('p-from').value, to = $('p-to').value;
    if (!from || !to) return;
    custom = from <= to ? { from, to } : { from: to, to: from };
    renderReport();
  }
  $('p-from').addEventListener('change', onRangeChange);
  $('p-to').addEventListener('change', onRangeChange);

  const STEP_MIN = 5;
  function bump(delta) {
    L.rollover(state, Date.now());
    L.setTarget(state, state.interval + delta);
    save([state.day]);
    renderAll();
  }
  $('minus').addEventListener('click', () => bump(-STEP_MIN));
  $('plus').addEventListener('click', () => bump(STEP_MIN));

  const sleepKeys = () => [state.day, L.shiftKey(state.day, -1)];
  $('sl-save').addEventListener('click', () => {
    const now = Date.now();
    const win = L.sleepWindow(now, $('sl-bed').value, $('sl-wake').value);
    if (!win) {
      renderSleep('Укажи оба времени. Время подъёма должно уже наступить.');
      return;
    }
    L.setSleep(state, now, win.bed, win.wake);
    save(sleepKeys());
    renderAll();
  });
  $('sl-clear').addEventListener('click', () => {
    L.clearSleep(state, Date.now());
    $('sl-bed').value = '';
    $('sl-wake').value = '';
    save(sleepKeys());
    renderAll();
  });

  $('undo').addEventListener('click', () => {
    L.undo(state);
    save([state.day]);
    renderAll();
  });

  $('open-settings').addEventListener('click', () => {
    $('st-interval').value = state.interval;
    $('st-baseline').value = state.cfg.baseline;
    $('st-price').value = state.cfg.price;
    $('st-err').textContent = '';
    $('settings').hidden = false;
  });
  $('close-settings').addEventListener('click', () => ($('settings').hidden = true));
  $('settings').addEventListener('click', (e) => {
    if (e.target === $('settings')) $('settings').hidden = true;
  });

  $('settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const { cfg, err } = readCfg('st');
    $('st-err').textContent = err || '';
    if (err) return;
    state.cfg = { baseline: cfg.baseline, price: cfg.price };
    L.setTarget(state, cfg.interval);
    save([state.day]);
    $('settings').hidden = true;
    renderAll();
  });

  $('reset').addEventListener('click', async () => {
    if (!(await confirmMsg('Стереть всю историю и настройки? Вернуть будет нельзя.'))) return;
    try {
      await saveChain;
      await store.removeMany(await store.keys());
    } catch (e) {
      alertMsg('Не удалось стереть: ' + e.message);
      return;
    }
    state = null;
    $('settings').hidden = true;
    show('onboard');
  });

  // ---------- старт ----------
  async function start() {
    if (tg) {
      try { tg.ready(); tg.expand(); } catch (e) { /* вне Telegram */ }
    }
    if (inTelegram) {
      const applyScheme = () => (document.documentElement.dataset.scheme = tg.colorScheme || 'light');
      applyScheme();
      tg.onEvent('themeChanged', applyScheme);
    }
    try {
      state = await load();
    } catch (e) {
      $('fatal-msg').textContent = e.message;
      show('fatal');
      return;
    }
    if (!state) {
      show('onboard');
    } else {
      const before = state.day;
      L.rollover(state, Date.now());
      if (state.day !== before) save();
      show('main');
      renderAll();
    }
    setInterval(tick, 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state) renderAll();
    });
  }

  start();
})();
