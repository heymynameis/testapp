'use strict';
const JSZip = require('jszip');
const { xml2js } = require('xml-js');

/* ===================== низкоуровневые хелперы по XML ===================== */
const kids = el => (el && el.elements) || [];
const named = (el, n) => kids(el).filter(c => c.type === 'element' && c.name === n);

/** Обходит содержимое абзаца в порядке документа. */
function walkPara(el, out) {
  for (const c of kids(el)) {
    if (c.type !== 'element') continue;
    switch (c.name) {
      case 'w:t': for (const t of kids(c)) if (t.type === 'text') out.buf += t.text; break;
      case 'w:tab': out.buf += ' '; break;
      case 'w:br': case 'w:cr':
        if (!(c.attributes && c.attributes['w:type'] === 'page')) out.buf += '\n'; break;
      case 'w:drawing': case 'w:pict': case 'w:object': out.img = true; break;
      case 'w:pPr': case 'w:rPr': case 'w:del': case 'mc:Fallback': break;
      default: walkPara(c, out);
    }
  }
}
const clean = s => s.replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/[ \t]+/g, ' ').trim();

/** Абзац -> { lines: [непустые строки], img } (w:br делит на строки) */
function paraInfo(p) {
  const out = { buf: '', img: false };
  walkPara(p, out);
  return { lines: out.buf.split('\n').map(clean).filter(Boolean), img: out.img };
}

/** Содержимое ячейки -> массив блоков { t:'p', lines } | { t:'tbl', rows:[[текст]] } */
function cellBlocks(tc) {
  const blocks = [];
  let img = false;
  for (const c of kids(tc)) {
    if (c.type !== 'element') continue;
    if (c.name === 'w:p') {
      const pi = paraInfo(c);
      img = img || pi.img;
      if (pi.lines.length) blocks.push({ t: 'p', lines: pi.lines });
    } else if (c.name === 'w:tbl') {
      const rows = named(c, 'w:tr').map(tr => named(tr, 'w:tc').map(cell => {
        const parts = [];
        for (const p of named(cell, 'w:p')) { const pi = paraInfo(p); img = img || pi.img; parts.push(...pi.lines); }
        return parts.join(' ');
      }));
      blocks.push({ t: 'tbl', rows });
    }
  }
  return { blocks, img };
}
const cellText = tc => cellBlocks(tc).blocks.map(b => b.t === 'p' ? b.lines.join(' ') : '').filter(Boolean).join(' ');


/* ===================== распознавание структуры ===================== */
// Допустимые буквы-метки вариантов:
//   кириллица А..К (без Ё)   +   латиница A..K
const LET_UP = 'А-ЕЖЗИКA-K';        // для регулярки (uppercase)
const LET_LO = 'а-ежзикa-k';        // для регулярки (lowercase)
// Для justify по ТЗ: «первые буквы алфавита» — до И (кир.) и до L (лат.)
const JUST_LET_UP = 'А-ЗA-K';        // без И и без K,L,M.. ; верхний регистр

const HEADING_RE = /^\s*([A-Za-zА-Яа-яЁё0-9]+(?:\.[A-Za-zА-Яа-яЁё0-9()]+)+(?:\s*\([^)]+\))?)\.?\s+(\S.*)$/;
const MARK_RE = new RegExp('^\\s*(?:(\\d{1,2})[).](?=\\s|$)|([' + LET_UP + '])[).])\\s*(.*)$');
const INSTR_RE = /^(?:ответ\s+)?(?:запишите|впишите|введите)(?![А-Яа-яЁё])/i;
const TRAILING_INSTR_RE = /^(?:Поясните|Объясните|Обоснуйте|Опишите|Назовите|Приведите|Укажите|Сформулируйте|Перечислите|Сравните|Проанализируйте|Охарактеризуйте|Аргументируйте|Оцените|Докажите|Дайте|Запишите|Впишите|Вставьте|Дополните)(?![А-Яа-яЁё])/i;
const BOILER_RE = /^Прочитайте\s+(?:текст\s+)?(?:вопроса?\s*)?[^.:]*[.:]\s*/i;
const MATCH_BOILER_RE = /^К\s+каждой\s+позиции[^.]*\.\s*/i;
const COUNT_RE = /([2-9]|\d{2,}|дв[ае]|три|четыре|пят[ьи])\s+правильн/i;

const RE_MATCH = /установите\s+(?:правильное\s+)?соответствие|сопоставьте|соответствие\s+между/i;
const RE_ORDER = /расположите|(?:установите|определите|укажите)\s+(?:правильную\s+)?(?:\S+\s+)?последовательност|хронологическ[а-яё]*\s+последовательност|в\s+правильной\s+последовательности/i;
const RE_MULTI = /(?:\d+|дв[ае]|три|четыре|пят[ьи]|все)\s+(?:верн|правильн)|несколько\s+правильн/i;
const RE_FILL = /дополните|впишите|вставьте\s+пропущен|_{3,}/i;

const kindOf = m => (m[1] !== undefined ? 'd' : 'l');
const markVal = m => (m[1] !== undefined ? m[1] : m[2]);
const trimItem = s => s.replace(/[;,\s]+$/, '').trim();

/** Находит столбцы теста по заголовку первой строки таблицы */
function detectColumns(tbl) {
  const first = named(tbl, 'w:tr')[0];
  if (!first) return null;
  const heads = named(first, 'w:tc').map(tc => cellText(tc).toLowerCase().replace(/\s+/g, ''));
  const text = heads.findIndex(h => h.includes('содержан'));
  const key = heads.findIndex(h => h.includes('ключ'));
  const topic = heads.findIndex(h => h.includes('тем'));
  if (text < 0 || key < 0) return null;
  return { text, key, topic, width: heads.length };
}

/** Подтаблица-«бланк ответа»: после первой строки все ячейки пусты */
const isBlankGrid = rows => rows.length > 0 && rows.slice(1).every(r => r.every(c => !c.trim()));

/** Ключ -> строка для парсинга без лишнего */
const keyString = lines => lines.join(' ').replace(/[→\u2192]/g, ' ').replace(/\s+/g, ' ').trim();

function splitKeyTokens(str, kind, expected) {
  const s = str.trim();
  if (kind === 'l') {
    // только буквы (кир. А..К + лат. A..K), пробелы и пунктуация-разделители
    if (!new RegExp('^[\\s,;.\\-–—' + LET_UP + LET_LO + ']+$').test(s)) return null;
    return [...s.toUpperCase().matchAll(new RegExp('[' + LET_UP + ']', 'g'))].map(m => m[0]);
  }
  if (!/^[\s,;.\-–—\d]+$/.test(s)) return null;
  if (/[^\d]/.test(s.replace(/\s/g, ''))) return s.split(/[^\d]+/).filter(Boolean);
  const compact = s.replace(/\s/g, '');
  if (expected && compact.length !== expected && /^\d+$/.test(compact) && expected > 9) return null;
  return compact.split('');
}

const JUSTIFY_LETTER_RE = new RegExp('^[' + JUST_LET_UP + ']');
const JUSTIFY_ENTRY_RE = new RegExp('^([' + JUST_LET_UP + '])\\s*\\.?\\s*(.*)$');
const JUSTIFY_INLINE_RE = new RegExp(
  '^([' + JUST_LET_UP + '](?:[.,;]?[' + JUST_LET_UP + '])*)\\s*\\.?\\s+(\\S.*)$'
);
const MULTI_LET_RE = new RegExp('^[' + JUST_LET_UP + '\\s,;]+$');

/** True, если строка — это ТОЛЬКО буквы-метки (А, АБ, А,Б, А. и т.п.), без «настоящего» текста */
const isMarkerOnly = s => {
  const t = (s || '').trim();
  if (!t) return false;
  return MULTI_LET_RE.test(t)
    || new RegExp('^[' + JUST_LET_UP + '][\\s.,;)]*$').test(t);
};

function looksLikeJustifyKey(keyLines) {
  if (!keyLines.length) return false;
  const first = keyLines[0];
  if (!JUSTIFY_LETTER_RE.test(first)) return false;

  // вариант «АБ Пояснение…» / «А Пояснение…» — метка и текст в одной строке
  const inline = JUSTIFY_INLINE_RE.exec(first);
  if (inline) {
    const letters = inline[1].toUpperCase().match(new RegExp('[' + JUST_LET_UP + ']', 'g')) || [];
    const rest = (inline[2] || '').trim();
    if (letters.length && rest && !isMarkerOnly(rest)) return true;
  }

  // вариант «А. текст…»
  if (new RegExp('^[' + JUST_LET_UP + ']\\s*\\.').test(first)) {
    const rest = first.replace(new RegExp('^[' + JUST_LET_UP + ']\\s*\\.\\s*'), '').trim();
    // если после точки — не пустой список букв-меток => justify
    if (!rest) return false;
    if (new RegExp('^[' + JUST_LET_UP + '][\\s,.;:]*$').test(rest)) return false;
    return true;
  }
  // вариант «А\nтекст…»: буква одна на строке, следующая строка — не метка
  if (new RegExp('^[' + JUST_LET_UP + ']\\s*$').test(first)) {
    const next = (keyLines[1] || '').trim();
    return !!next && !isMarkerOnly(next);
  }
  // вариант «АБ\nобщее обоснование» (слипшиеся буквы верных ответов)
  if (MULTI_LET_RE.test(first) && first.replace(/[\s,;]/g, '').length >= 2) {
    const next = (keyLines[1] || '').trim();
    return !!next && !isMarkerOnly(next);
  }
  return false;
}

function parseJustifyEntries(keyLines) {
  const out = [];
  for (let i = 0; i < keyLines.length; i++) {
    const line = keyLines[i];
    if (!line) continue;
    // «АБ» + следующая строка = общее обоснование для обеих букв
    if (MULTI_LET_RE.test(line) && line.replace(/[\s,;]/g, '').length >= 2) {
      const letters = line.toUpperCase().match(new RegExp('[' + JUST_LET_UP + ']', 'g')) || [];
      const nextLine = (keyLines[i + 1] || '').trim();
      if (!nextLine || isMarkerOnly(nextLine)) return null;
      for (const L of letters) out.push({ letter: L, text: nextLine });
      i++;
      continue;
    }

    // «АБ Пояснение…» / «А,Б Пояснение…» / «А Пояснение…» в одной строке
    const inline = JUSTIFY_INLINE_RE.exec(line);
    if (inline) {
      const letters = inline[1].toUpperCase().match(new RegExp('[' + JUST_LET_UP + ']', 'g')) || [];
      const text = (inline[2] || '').trim();
      if (!letters.length || !text || isMarkerOnly(text)) return null;
      for (const L of letters) out.push({ letter: L, text });
      continue;
    }
    const m = JUSTIFY_ENTRY_RE.exec(line);
    if (!m) return null;
    let text = (m[2] || '').trim();
    if (!text && i + 1 < keyLines.length) {
      const next = keyLines[i + 1];
      if (next && !isMarkerOnly(next)) { text = next.trim(); i++; }   // фикс ложных срабатываний на «Данный…», «Сертификация…»
    }
    if (!text) return null;
    out.push({ letter: m[1], text });
  }
  return out.length ? out : null;
}

/* ===================== разбор одной строки таблицы ===================== */
function parseRow(cells, cols, opts) {
  const content = cellBlocks(cells[cols.text]);
  const key = cellBlocks(cells[cols.key]);
  const topicRaw = cols.topic >= 0 && cells[cols.topic] ? cellText(cells[cols.topic]) : '';

  /* --- 1. content -> последовательность «сегментов» --- */
  const stemLines = [];      // текст до первого маркера (и не заголовки)
  const instr = [];
  const trailing = [];
  const items = [];          // { kind, val, text }
  let seenMarker = false;
  const warns = [];
  const ABC_CYR = 'АБВГДЕЖЗИК';
  const ABC_LAT = 'ABCDEFGHIJK';
  const pushSeg = (text, fromLine, paraStart) => {
    const m = MARK_RE.exec(text);
    if (m) { seenMarker = true; items.push({ kind: kindOf(m), val: markVal(m), text: trimItem(m[3] || '') }); return true; }
    if (!fromLine) return false;                       // ячейки-заголовки подтаблиц пропускаем
    if (INSTR_RE.test(text)) { instr.push(text); return false; }
    if (!seenMarker) { stemLines.push(text); return false; }
    if (/:$/.test(text)) return false;                 // «Событие:» — подзаголовок
    if (TRAILING_INSTR_RE.test(text)) { trailing.push(text); return false; }
    if (items.length) {
      const last = items[items.length - 1];
      const base = ABC_LAT.includes(last.val) ? ABC_LAT : ABC_CYR;
      const next = last.kind === 'l'
        ? base[base.indexOf(last.val) + 1]
        : String(+last.val + 1);
      if (paraStart && next && fromLine) {
        items.push({ kind: last.kind, val: next, text: trimItem(text) });
        warns.push(`у варианта «${trimItem(text).slice(0, 40)}» не было буквы/цифры — присвоено «${next}»`);
      } else last.text = trimItem(last.text + ' ' + text);
    }
    return false;
  };
  for (const b of content.blocks) {
    if (b.t === 'p') {
      for (const [li, line] of b.lines.entries()) {
        if (line.includes('|')) {
          const parts = line.split('|').map(clean).filter(Boolean);
          const any = parts.some(p => MARK_RE.test(p));
          if (any) parts.forEach(p => pushSeg(p, false)); // «А. G | 1. Масштабирование»
          // иначе: строка-заголовок «Клавиша | Действие» — пропускаем
        } else pushSeg(line, true, li === 0);
      }
    } else {
      if (isBlankGrid(b.rows)) continue;                 // бланк «запишите буквы под цифрами»
      for (const r of b.rows) for (const c of r) if (c.trim()) pushSeg(clean(c), false);
    }
  }
  const probe = stemLines.join(' ');
  const allText = [probe, instr.join(' '), trailing.join(' ')].filter(Boolean).join(' ');

  /* --- 2. ключ --- */
  const keyLines = key.blocks.filter(b => b.t === 'p').flatMap(b => b.lines);
  const keyGrid = key.blocks.find(b => b.t === 'tbl' && b.rows.length >= 2 &&
    b.rows[0].some(c => c.trim()) &&
    b.rows[1].some(c => c.trim()));
  const keyStr = keyString(keyLines);
  if (!keyLines.length && !keyGrid) return { skip: 'не заполнен ключ к ответу' };

  const justifyEntries = looksLikeJustifyKey(keyLines) ? parseJustifyEntries(keyLines) : null;

  /* --- 3. тип --- */
  const dItems = items.filter(i => i.kind === 'd'), lItems = items.filter(i => i.kind === 'l');
  let type;
  if (RE_MATCH.test(probe)) type = 'match';
  else if (justifyEntries && items.length >= 2) type = 'justify';
  else if (RE_ORDER.test(probe) && items.length >= 2) type = 'order';
  else if (items.length >= 2) type = 'single';
  else type = RE_FILL.test(allText) ? 'fill' : 'text';

  /* --- 4. сбор вопроса --- */
  let stem = probe;
  if (type === 'match') {
    const i = stemLines.findIndex(l => /:$/.test(l));
    stem = (i >= 0 ? stemLines.slice(0, i + 1) : stemLines).join(' ');
  }
  let countHint = '';
  const stripped = (() => {
    if (!opts.clean) return stem;
    let s = stem;
    const m = BOILER_RE.exec(s);
    if (m) {
      s = s.slice(m[0].length);
      const c = COUNT_RE.exec(m[0]);   // «выберите два правильных ответа» — число оставляем, оно важно студенту
      if (c && !/выберите\s+([2-9]|\d{2,}|дв[ае]|три|четыре|пят[ьи])/i.test(s)) countHint = c[1];
    }
    if (type === 'match') s = s.replace(MATCH_BOILER_RE, '');
    return s.trim() || stem;
  })();
  if (!stripped) return { skip: 'пустой текст вопроса' };
  const q = { type, text: stripped, topic: '' };
  if (trailing.length) q.text = (q.text + ' ' + trailing.join(' ')).trim();

  switch (type) {
    case 'match': {
      let leftKind, pairs = [];
      if (keyGrid) {
        const [a, b] = keyGrid.rows;
        const m0 = MARK_RE.exec((a.find(c => c.trim()) || '') + '.');
        leftKind = m0 ? kindOf(m0) : 'd';
        a.forEach((x, i) => { if (x.trim() && (b[i] || '').trim()) pairs.push([x.trim().toUpperCase(), b[i].trim().toUpperCase()]); });
      } else {
        // чистим ключ: оставляем буквы (кир./лат.), цифры, пробелы и запятые
        const keyClean = keyStr
          .replace(/[^\p{L}\p{N}\s,]/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        const first = (keyClean.match(new RegExp('[' + LET_UP + LET_LO + '\\d]')) || [''])[0];
        if (!first) return { skip: 'ключ сопоставления не распознан' };
        leftKind = /\d/.test(first) ? 'd' : 'l';

        const re = leftKind === 'l'
          ? new RegExp('([' + LET_UP + LET_LO + '])\\s*,?\\s*(\\d{1,2})', 'g')
          : new RegExp('(\\d{1,2})\\s*,?\\s*([' + LET_UP + LET_LO + '])', 'g');

        for (const m of keyClean.matchAll(re)) pairs.push([m[1].toUpperCase(), m[2].toUpperCase()]);

        // fallback: ключ — просто список букв (без цифр), например «A, B, C»
        // тогда считаем, что это правые метки по порядку слева-направо (1→A, 2→B, ...)
        if (!pairs.length && leftKind === 'd') {
          const letters = [...keyClean.toUpperCase().matchAll(new RegExp('[' + LET_UP + ']', 'g'))].map(m => m[0]);
          if (letters.length >= 2) {
            for (let i = 0; i < letters.length; i++) pairs.push([String(i + 1), letters[i]]);
          }
        }
      }
      if (!pairs.length) return { skip: 'ключ сопоставления не распознан' };
      const left = (leftKind === 'd' ? dItems : lItems), right = (leftKind === 'd' ? lItems : dItems);
      if (left.length < 2 || right.length < 2) return { skip: 'не удалось выделить левый и правый столбцы' };
      const map = {};
      for (const [a, b] of pairs) {
        const li = left.findIndex(x => x.val === a), ri = right.findIndex(x => x.val === b);
        if (li < 0 || ri < 0) return { skip: `в ключе «${a}–${b}» нет соответствующего элемента в тексте` };
        map[li] = ri;
      }
      if (Object.keys(map).length !== left.length) return { skip: 'ключ не покрывает все элементы левого столбца' };
      q.left = left.map(x => x.text); q.right = right.map(x => x.text);
      if ([...q.left, ...q.right].some(s => !s)) return { skip: 'пустой элемент в столбцах сопоставления' };
      q.correct = map;
      break;
    }
    case 'justify': {
      const kind = lItems.length >= dItems.length ? 'l' : 'd';
      const its = kind === 'l' ? lItems : dItems;
      if (its.length < 2 || its.some(x => !x.text)) return { skip: 'не удалось выделить варианты ответов' };

      const indices = [], texts = [];
      for (const e of justifyEntries) {
        const idx = its.findIndex(x => x.val === e.letter);
        if (idx < 0) return { skip: `в ключе указана буква «${e.letter}», которой нет среди вариантов` };
        indices.push(idx);
        texts.push(e.text);
      }
      if (new Set(indices).size !== indices.length) return { skip: 'в ключе повторяются буквы вариантов' };

      // сохраняем позиционное соответствие «индекс -> текст»
      const order = indices.map((idx, i) => i).sort((a, b) => indices[a] - indices[b]);
      q.options = its.map(x => x.text);
      q.correct = order.map(i => indices[i]);
      q.justification = order.map(i => texts[i]);
      break;
    }
    case 'order': {
      const kind = lItems.length >= dItems.length ? 'l' : 'd';
      const its = kind === 'l' ? lItems : dItems;
      const toks = splitKeyTokens(keyStr, kind, its.length);
      if (!toks) return { skip: 'ключ порядка не распознан' };
      const idx = toks.map(t => its.findIndex(x => x.val === t));
      if (idx.some(i => i < 0) || new Set(idx).size !== its.length || idx.length !== its.length)
        return { skip: 'ключ порядка не соответствует списку элементов' };
      q.items = idx.map(i => its[i].text);
      if (q.items.some(s => !s)) return { skip: 'пустой элемент списка' };
      break;
    }
    case 'single': {
      const kind = lItems.length >= dItems.length ? 'l' : 'd';
      const its = kind === 'l' ? lItems : dItems;
      const toks = splitKeyTokens(keyStr, kind, its.length);
      if (!toks || !toks.length) return { skip: 'ключ не распознан (ожидались буквы/цифры вариантов)' };
      const idx = [...new Set(toks.map(t => its.findIndex(x => x.val === t)))];
      if (idx.some(i => i < 0)) return { skip: 'в ключе указан вариант, которого нет в вопросе' };
      if (its.length < 2 || its.some(x => !x.text)) return { skip: 'не удалось выделить варианты ответов' };
      q.options = its.map(x => x.text);
      if (countHint && !/выберите\s+([2-9]|\d{2,}|дв[ае]|три|четыре|пят[ьи])/i.test(q.text)) q.text = /:$/.test(q.text) ? q.text.replace(/:$/, ` (верных ответов: ${countHint}):`) : q.text + ` (верных ответов: ${countHint})`;
      if (idx.length > 1 || COUNT_RE.test(allText) || RE_MULTI.test(allText)) {
        q.type = 'multiple'; q.correct = idx.sort((a, b) => a - b);
      } else q.correct = idx[0];
      break;
    }
    default: { // fill / text
      let alts = keyLines.map(l => l.replace(/^\/+\s*/, '').trim()).filter(Boolean);
      if (!alts.length) return { skip: 'не заполнен ключ к ответу' };
      if (type === 'text' && !keyLines.some(l => l.startsWith('/'))) alts = [alts.join(' ')];
      alts = [...new Set(alts)];
      if (type === 'fill' && alts.some(a => /\s/.test(a))) q.type = 'text'; // сервер: fill — ровно одно слово
      q.correct = alts;
    }
  }
  q.topic = normTopic(topicRaw);
  q._img = content.img;
  return { q, warns };
}

/** «Тема 1», «Тема 1.2», «Тема 1.2.3», «Тема: 3.1», «Тема 4-2» */
const TOPIC_MARK_RE = /(?<![\p{L}\d])Тема(?![\p{L}])[\s:]*\d+(?:[.\-]\d+)*/iu;

function normTopic(s) {
  let t = clean(s || '');

  /* правило разбора «Тема x.x» */
  const m = TOPIC_MARK_RE.exec(t);
  if (m) {
    if (m.index === 0) {
      // 3) строка начинается с «Тема x.x» / «Тема x»
      //    если после маркера остался текст — берём его,
      //    иначе (в ячейке только «Тема X») — оставляем сам маркер как тему
      const rest = t.slice(m[0].length)
        .replace(/^[\s.,:;\-–—]+/, '')
        .replace(/[\s.,:;\-–—]+$/, '')
        .trim();
      t = rest || m[0].replace(/[\s:]+/g, ' ').trim();   // ← ключевая строка
    } else {
      // 1) есть текст до маркера — берём только его
      t = t.slice(0, m.index);
    }
    // убираем «повисшую» пунктуацию после/перед вырезанным маркером
    t = t.replace(/^[\s.,:;\-–—]+/, '').replace(/[\s.,:;\-–—]+$/, '').trim();
  }
  // 2) маркера нет — оставляем как есть (t не менялся)

  /* прежняя пост-обработка */
  if (/»$/.test(t) && !t.includes('«')) t = t.slice(0, -1).trim();
  if (/\.$/.test(t) && !/(?:^|\s)\p{L}{1,3}\.$/u.test(t)) t = t.replace(/\.+$/, '').trim();
  return t || 'Без темы';
}
const topicKey = t => t.toLowerCase().replace(/ё/g, 'е').replace(/[.\s]+/g, ' ').trim();

/* ===================== главный разбор ===================== */
async function parseDocx(buffer, opts = {}) {
  opts = { clean: opts.clean !== false };
  let zip;
  try { zip = await JSZip.loadAsync(buffer); }
  catch { throw userErr('Файл не является документом Word (.docx)'); }
  const f = zip.file('word/document.xml');
  if (!f) throw userErr('В файле нет word/document.xml — нужен формат .docx, а не .doc');
  const doc = xml2js(await f.async('string'), { compact: false });
  const body = named(named({ elements: doc.elements }, 'w:document')[0], 'w:body')[0];
  if (!body) throw userErr('Не удалось прочитать тело документа');

  const result = [];
  const byKey = new Map();
  let heading = '', tableNo = 0, testTables = 0;

  for (const el of kids(body)) {
    if (el.type !== 'element') continue;
    if (el.name === 'w:p') {
      const t = paraInfo(el).lines.join(' ');
      if (t) heading = t;
      continue;
    }
    if (el.name !== 'w:tbl') continue;
    tableNo++;
    const hd = heading; heading = '';
    const cols = detectColumns(el);
    if (!cols) continue;
    testTables++;

    const hm = HEADING_RE.exec(hd);
    let info;
    if (hm) {
      info = { code: hm[1], name: clean(hm[2]) };
    } else if (hd) {
      // запасной путь: используем текст абзаца, стоящего прямо перед таблицей
      const name = clean(hd).replace(/\.+$/, '');   // убираем «повисшую» точку
      info = { code: '', name };
    } else {
      info = { code: '', name: 'Безымянная' };
    }
    const gk = hm ? info.code + '|' + info.name : null;
    let disc = gk && byKey.get(gk);
    if (!disc) {
      disc = { name: info.name, code: info.code, source: `таблица ${testTables}`, questions: [], skipped: [], warnings: [] };
      result.push(disc);
      if (gk) byKey.set(gk, disc);
    }

    const rows = named(el, 'w:tr').slice(1);
    let seq = 0;
    for (const tr of rows) {
      const cells = named(tr, 'w:tc');
      if (cells.length <= Math.max(cols.text, cols.key)) continue;   // строка-заголовок компетенции
      const txt = cellText(cells[cols.text]);
      if (!txt || /содержание\s+задания/i.test(txt)) continue;
      seq++;
      const numRaw = cellText(cells[0]).replace(/[.\s]+$/, '');
      const num = numRaw || String(seq);
      const r = parseRow(cells, cols, opts);
      if (r.skip) { disc.skipped.push({ num, reason: r.skip, text: txt.slice(0, 90) }); continue; }
      if (r.q._img) disc.warnings.push(`Вопрос № ${num}: в ячейке есть изображение — оно не перенесено`);
      delete r.q._img;
      for (const w of r.warns || []) disc.warnings.push(`Вопрос № ${num}: ${w}`);
      disc.questions.push(r.q);
    }
  }

  for (const d of result) {
    const seen = new Map();            // «Введение в философию.» и «Введение в философию» — одна тема
    for (const q of d.questions) {
      const k = topicKey(q.topic);
      if (!seen.has(k)) seen.set(k, q.topic); else q.topic = seen.get(k);
    }
    d.types = {};
    for (const q of d.questions) d.types[q.type] = (d.types[q.type] || 0) + 1;
  }
  return { disciplines: result, stats: { tables: tableNo, testTables } };
}

function userErr(msg) { const e = new Error(msg); e.userError = true; return e; }

module.exports = { parseDocx };
