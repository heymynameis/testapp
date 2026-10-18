'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
// const Datastore = require('@seald-io/nedb');
const Database = require('better-sqlite3');
// const os = require('os');
const Az = require('az');
// const { JaroWinklerDistance } = require('natural');
const { internalIpV4 } = require('internal-ip');
const { parseDocx } = require('./docx-parser');

/* ===================== Хранилища ===================== */
const DATA_DIR = process.env.DATA_DIR || 'data';
const PORT = Number(process.env.PORT) || 3000;

fs.mkdirSync(DATA_DIR, { recursive: true });

const MEDIA_DIR = path.join(DATA_DIR, 'media');
const IMG_DIR = path.join(MEDIA_DIR, 'question-imgs');
fs.mkdirSync(IMG_DIR, { recursive: true });


const sql = new Database(path.join(DATA_DIR, 'results.sqlite'));
sql.pragma('journal_mode = WAL');
sql.pragma('synchronous = NORMAL');

/** Мини-обёртка с тем же API, что использовался у nedb. Документ хранится как JSON. */
const FIELD_RE = /^[A-Za-z_]\w*$/;
class Collection {
  constructor(name) {
    this.t = name;
    sql.exec(`CREATE TABLE IF NOT EXISTS ${name} (_id TEXT PRIMARY KEY, doc TEXT NOT NULL)`);
  }
  index(field, unique = false) {
    sql.exec(`CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ix_${this.t}_${field}
              ON ${this.t}(json_extract(doc, '$.${field}'))`);
  }
  _where(q = {}) {
    const parts = [], args = [];
    for (const [k, v] of Object.entries(q)) {
      if (!FIELD_RE.test(k)) throw new Error('Недопустимое поле: ' + k);
      const col = k === '_id' ? '_id' : `json_extract(doc, '$.${k}')`;
      if (v && typeof v === 'object' && '$in' in v) {
        if (!v.$in.length) { parts.push('0'); continue; }
        parts.push(`${col} IN (${v.$in.map(() => '?').join(',')})`);
        args.push(...v.$in);
      } else {
        parts.push(`${col} = ?`);
        args.push(v);
      }
    }
    return { where: parts.length ? 'WHERE ' + parts.join(' AND ') : '', args };
  }
  async findAsync(q) {
    const { where, args } = this._where(q);
    return sql.prepare(`SELECT doc FROM ${this.t} ${where}`).all(...args).map(r => JSON.parse(r.doc));
  }
  async findOneAsync(q) {
    const { where, args } = this._where(q);
    const r = sql.prepare(`SELECT doc FROM ${this.t} ${where} LIMIT 1`).get(...args);
    return r ? JSON.parse(r.doc) : null;
  }
  async insertAsync(d) {
    const doc = { ...d, _id: d._id || crypto.randomUUID() };
    sql.prepare(`INSERT INTO ${this.t} (_id, doc) VALUES (?, ?)`).run(doc._id, JSON.stringify(doc));
    return doc;
  }
  async updateAsync(q, ops) {
    const { where, args } = this._where(q);
    const rows = sql.prepare(`SELECT doc FROM ${this.t} ${where}`).all(...args);
    const upd = sql.prepare(`UPDATE ${this.t} SET doc = ? WHERE _id = ?`);
    sql.transaction(() => {
      for (const r of rows) {
        const doc = JSON.parse(r.doc);
        if (ops.$set) Object.assign(doc, ops.$set);
        if (ops.$unset) for (const k of Object.keys(ops.$unset)) delete doc[k];
        upd.run(JSON.stringify(doc), doc._id);
      }
    })();
    return rows.length;
  }
  async removeAsync(q, { multi = false } = {}) {
    const { where, args } = this._where(q);
    const sqlText = multi
      ? `DELETE FROM ${this.t} ${where}`
      : `DELETE FROM ${this.t} WHERE _id IN (SELECT _id FROM ${this.t} ${where} LIMIT 1)`;
    return sql.prepare(sqlText).run(...args).changes;
  }
}

const db = {};
for (const n of ['disciplines', 'topics', 'questions', 'tests', 'users', 'answers']) db[n] = new Collection(n);

// индексы под реальные запросы сервера
db.users.index('username', true);
db.topics.index('disciplineId');
db.questions.index('topicId');
db.questions.index('disciplineId');
db.questions.index('userId');

sql.exec(`CREATE TABLE IF NOT EXISTS attempts (
  id          TEXT PRIMARY KEY,
  test_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  grp         TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  deadline    INTEGER,
  finished_at INTEGER,
  score       REAL,
  max_score   REAL NOT NULL,
  answers_id  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_attempts_test ON attempts(test_id);
CREATE INDEX IF NOT EXISTS ix_attempts_name ON attempts(name);`);

/* ===================== Утилиты ===================== */
/* ===================== Утилиты ===================== */
const DEFAULT_WEIGHTS = { single: 1, multiple: 3, fill: 5, text: 10, match: 4, order: 4, justify: 8 };

sql.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

function loadWeights() {
  try {
    const row = sql.prepare(`SELECT value FROM settings WHERE key = 'weights'`).get();
    // поверх значений по умолчанию: новые типы вопросов, которых нет в сохранённом, получат дефолт
    return row ? { ...DEFAULT_WEIGHTS, ...JSON.parse(row.value) } : { ...DEFAULT_WEIGHTS };
  } catch (e) {
    console.error('Не удалось прочитать веса, используются значения по умолчанию:', e.message);
    return { ...DEFAULT_WEIGHTS };
  }
}

function saveWeights(w) {
  sql.prepare(`INSERT INTO settings (key, value) VALUES ('weights', ?)
               ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(w));
}

let WEIGHTS = loadWeights();

const getSetting = k => { const r = sql.prepare('SELECT value FROM settings WHERE key = ?').get(k); return r ? r.value : null; };
const setSetting = (k, v) => sql.prepare(`INSERT INTO settings (key, value) VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, String(v));
const delSetting = k => sql.prepare('DELETE FROM settings WHERE key = ?').run(k);
const usersCount = () => sql.prepare('SELECT COUNT(*) AS c FROM users').get().c;
// если пользователей нет (например, удалили единственный аккаунт), регистрацию не прячем, чтобы не заблокировать вход
const registrationDisabled = () => getSetting('registrationDisabled') === '1' && usersCount() > 0;

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg, status = 400) => { throw new HttpError(status, msg); };
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const uuid = () => crypto.randomUUID();
const isStr = s => typeof s === 'string' && s.trim().length > 0;

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ----- пароли ----- */
const hashPassword = (p, salt = crypto.randomBytes(16).toString('hex')) =>
  salt + ':' + crypto.scryptSync(p, salt, 64).toString('hex');
const checkPassword = (p, stored) => {
  const [salt, h] = stored.split(':');
  const x = hashPassword(p, salt).split(':')[1];
  return crypto.timingSafeEqual(Buffer.from(x, 'hex'), Buffer.from(h, 'hex'));
};

/* ----- шифрование верных ответов (AES-256-GCM) -----
   Ключ = sha256(хеш пароля автора). Так сервер может проверять ответы,
   когда автор не в сети, а при смене/удалении пароля ключ меняется/исчезает.
   При удалении пользователя его вопросы перешифровываются серверным ключом. */
const keyOf = s => crypto.createHash('sha256').update(s).digest();
const SERVER_KEY = keyOf(process.env.SERVER_SECRET || 'change-me');

function encrypt(text, key) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}
function decrypt(b64, key) {
  const b = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
async function questionKey(q) {
  if (q.enc === 'server') return SERVER_KEY;
  const u = await db.users.findOneAsync({ _id: q.userId });
  if (!u) bad('Автор вопроса не найден, ответ не расшифровать', 500);
  return keyOf(u.passwordHash);
}

/* ----- сессии: только в памяти => слетают при закрытии приложения ----- */
const sessions = new Map(); // token -> userId
const auth = (req, res, next) => {
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const uid = sessions.get(token);
  if (!uid) return next(new HttpError(401, 'Требуется авторизация'));
  req.userId = uid;
  next();
};

/* ===================== Вопросы: валидация, проверка, выдача ===================== */
function validateQuestion(b) {
  const { type } = b;
  if (!WEIGHTS[type]) bad('Неизвестный type. Допустимо: ' + Object.keys(WEIGHTS).join(', '));
  if (!isStr(b.text)) bad('Нужен text');
  const strArr = (a, min = 1) => Array.isArray(a) && a.length >= min && a.every(isStr);
  const inRange = (i, n) => Number.isInteger(i) && i >= 0 && i < n;
  const q = { type, text: b.text };
  // b.img === '' | null означает «убрать изображение» (используется в PUT)
  if (b.img) {
    if (typeof b.img !== 'string' || !/^\/media\/question-imgs\/[\w.-]+$/.test(b.img))
      bad('img: путь вида /media/question-imgs/<имя>');
    q.img = b.img;
  }
  let correct;

  switch (type) {
    case 'single':
      if (!strArr(b.options, 2)) bad('options: массив минимум из 2 строк');
      if (!inRange(b.correct, b.options.length)) bad('correct: индекс верного варианта');
      q.options = b.options; correct = b.correct; break;

    case 'multiple':
      if (!strArr(b.options, 2)) bad('options: массив минимум из 2 строк');
      if (!Array.isArray(b.correct) || !b.correct.length ||
        new Set(b.correct).size !== b.correct.length ||
        !b.correct.every(i => inRange(i, b.options.length))) bad('correct: массив уникальных индексов верных вариантов');
      q.options = b.options; correct = b.correct; break;

    case 'fill':
    case 'text': {
      const arr = [].concat(b.correct);
      if (!arr.length || !arr.every(isStr)) bad('correct: строка или массив допустимых строк');
      if (type === 'fill' && arr.some(s => /\s/.test(s.trim()))) bad('Для fill ответ — одно слово');
      correct = arr; break;
    }
    case 'match': {
      if (!strArr(b.left) || !strArr(b.right)) bad('left и right: массивы строк');
      const c = b.correct;
      if (!c || typeof c !== 'object' || Array.isArray(c) || Object.keys(c).length !== b.left.length ||
        !b.left.every((_, i) => inRange(c[i], b.right.length))) bad('correct: объект {"0":1,"1":0,...} — для каждого элемента left индекс из right');
      q.left = b.left; q.right = b.right; correct = c; break;
    }
    case 'order': {
      if (!strArr(b.items, 2)) bad('items: массив минимум из 2 строк');
      const c = b.correct;
      if (!Array.isArray(c) || c.length !== b.items.length ||
        [...c].sort((x, y) => x - y).some((v, i) => v !== i)) bad('correct: перестановка индексов items, напр. [1,3,0,2]');
      q.items = b.items; correct = c; break;
    }
    case 'justify': {
      if (!strArr(b.options, 2)) bad('options: массив минимум из 2 строк');
      if (!Array.isArray(b.correct) || !b.correct.length ||
        new Set(b.correct).size !== b.correct.length ||
        !b.correct.every(i => inRange(i, b.options.length)))
        bad('correct: массив уникальных индексов верных вариантов');
      const just = [].concat(b.justification);
      if (!just.length || !just.every(isStr))
        bad('justification: строка или массив допустимых строк');
      q.options = b.options;
      q.justifySingle = b.correct.length === 1;   // ← новое
      correct = { indices: b.correct, texts: just };
      break;
    }
  }
  return { q, correct };
}

const norm = s => String(s).toLowerCase().replace(/ё/g, 'е')
  .replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();

const words = s => norm(s).split(' ').filter(Boolean);

// Дамерау-Левенштейн
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

const ratio = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length, 1);


// слово целиком или префикс слова студента (эталон-основа)
const wordSim = (ref, w) =>
  Math.max(ratio(ref, w), ratio(ref, w.slice(0, ref.length)));

function coverage(refWords, ansWords) {
  if (!refWords.length) return 0;
  const pairs = [];
  refWords.forEach((r, i) => ansWords.forEach((w, j) => pairs.push([wordSim(r, w), i, j])));
  pairs.sort((x, y) => y[0] - x[0]);
  const usedR = new Set(), usedA = new Set();
  let sum = 0;
  for (const [s, i, j] of pairs) {
    if (usedR.has(i) || usedA.has(j)) continue;
    usedR.add(i); usedA.add(j);
    sum += s;
  }
  return sum / refWords.length;
}

/* Возвращает набранные баллы за вопрос */
function grade(type, correct, answer) {
  let frac = 0;
  switch (type) {
    case 'single':
      frac = Number(answer) === correct ? 1 : 0; break;
    case 'multiple': {
      if (!Array.isArray(answer)) break;
      const sel = [...new Set(answer.map(Number))];
      const hit = sel.filter(x => correct.includes(x)).length;
      const wrong = sel.length - hit;
      frac = Math.max(0, hit - wrong) / correct.length; // штраф за неверно выбранные
      break;
    }
    case 'fill': {
      if (typeof answer !== 'string') break;
      frac = Math.max(...correct.map(c => ratio(norm(answer), norm(c))));
      break;
    }
    case 'text': {
      if (typeof answer !== 'string') break;
      const a = words(answer);
      frac = Math.max(...correct.map(c => coverage(words(c), a)));
      break;
    }
    case 'match':
      frac = answer && typeof answer === 'object' &&
        Object.keys(correct).every(k => Number(answer[k]) === correct[k]) ? 1 : 0; break;
    case 'order':
      frac = Array.isArray(answer) && answer.length === correct.length &&
        answer.every((v, i) => Number(v) === correct[i]) ? 1 : 0; break;
    case 'justify': {
      if (!answer || typeof answer !== 'object') break;
      const sel = Array.isArray(answer.options) ? [...new Set(answer.options.map(Number))] : [];
      const hit = sel.filter(x => correct.indices.includes(x)).length;
      const wrong = sel.length - hit;
      const optFrac = Math.max(0, hit - wrong) / correct.indices.length;
      const a = typeof answer.text === 'string' ? words(answer.text) : [];
      const txtFrac = correct.texts.length
        ? Math.max(...correct.texts.map(t => coverage(words(t), a))) : 0;
      frac = 0.5 * optFrac + 0.5 * txtFrac;
      break;
    }
  }
  return WEIGHTS[type] * frac;
}

/** Вид вопроса для студента: без верного ответа, id = исходный индекс */
function publicQuestion(q, shuffleAnswers) {
  const wrapList = arr => {
    const l = arr.map((text, id) => ({ id, text }));
    return shuffleAnswers ? shuffle(l) : l;
  };
  const out = { id: q._id, type: q.type, text: q.text };
  if (q.img) out.img = q.img;
  if (q.justifySingle !== undefined) out.justifySingle = !!q.justifySingle; // ← новое
  if (q.options) out.options = wrapList(q.options);
  if (q.left) { out.left = wrapList(q.left); out.right = wrapList(q.right); }
  if (q.items) out.items = wrapList(q.items);
  return out;
}

/* ===================== Приложение ===================== */
const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));  // фронтенд
app.use('/media', express.static(MEDIA_DIR));

/* ----- 4.1 / 4.2 регистрация и авторизация ----- */
app.post('/auth/register', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (!isStr(username) || !isStr(password)) bad('Нужны username и password');
  if (await db.users.findOneAsync({ username })) bad('Имя занято', 409);
    const first = usersCount() === 0;
  const u = await db.users.insertAsync({ _id: uuid(), username, passwordHash: hashPassword(password) });
  if (first) {
    setSetting('adminUserId', u._id);   // первый пользователь становится администратором
    setSetting('registrationDisabled', '1');   // после первого пользователя регистрация отключается
  }
  res.status(201).json({ id: u._id, username });
}));

app.post('/auth/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const u = isStr(username) && isStr(password) && await db.users.findOneAsync({ username });
  if (!u || !checkPassword(password, u.passwordHash)) bad('Неверное имя или пароль', 401);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, u._id);
  res.json({ token, userId: u._id });
}));

app.post('/auth/logout', auth, (req, res) => {
  sessions.delete((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  res.json({ ok: true });
});

/* ----- 4.3 дисциплины, темы, вопросы ----- */
app.post('/disciplines', auth, wrap(async (req, res) => {
  if (!isStr(req.body.name)) bad('Нужен name');
  const d = await db.disciplines.insertAsync({ _id: uuid(), name: req.body.name, userId: req.userId });
  res.status(201).json(d);
}));
app.get('/disciplines', auth, wrap(async (req, res) => res.json(await db.disciplines.findAsync({}))));

app.post('/topics', auth, wrap(async (req, res) => {
  const { disciplineId, name } = req.body;
  if (!isStr(name)) bad('Нужен name');
  if (!await db.disciplines.findOneAsync({ _id: disciplineId })) bad('Дисциплина не найдена', 404);
  const t = await db.topics.insertAsync({ _id: uuid(), disciplineId, name, userId: req.userId });
  res.status(201).json(t);
}));
app.get('/topics', auth, wrap(async (req, res) =>
  res.json(await db.topics.findAsync(req.query.disciplineId ? { disciplineId: req.query.disciplineId } : {}))));

app.post('/questions', auth, wrap(async (req, res) => {
  const { disciplineId, topicId } = req.body;
  const topic = await db.topics.findOneAsync({ _id: topicId });
  if (!topic || topic.disciplineId !== disciplineId) bad('Тема не найдена в этой дисциплине', 404);
  const { q, correct } = validateQuestion(req.body);
  const user = await db.users.findOneAsync({ _id: req.userId });
  const doc = await db.questions.insertAsync({
    _id: uuid(), ...q, disciplineId, topicId, userId: req.userId, enc: 'user',
    correct: encrypt(JSON.stringify(correct), keyOf(user.passwordHash)),
  });
  const { correct: _omit, ...safe } = doc;
  res.status(201).json(safe);
}));
app.get('/questions', auth, wrap(async (req, res) => {
  const f = {};
  if (req.query.topicId) f.topicId = req.query.topicId;
  if (req.query.disciplineId) f.disciplineId = req.query.disciplineId;
  const list = await db.questions.findAsync(f);
  res.json(list.map(({ correct, ...rest }) => rest)); // верный ответ не отдаём
}));

/* ----- настройка весов вопросов ----- */
app.get('/weights', (req, res) => res.json(WEIGHTS));

app.put('/weights', auth, express.json(), (req, res) => {
  const next = { ...WEIGHTS };
  for (const k of Object.keys(WEIGHTS)) {
    if (req.body[k] === undefined) continue;
    const v = Number(req.body[k]);
    if (!Number.isFinite(v) || v < 0 || v > 1000)
      return res.status(400).json({ error: `Некорректный вес для «${k}»` });
    next[k] = v;
  }
  saveWeights(next);
  WEIGHTS = next;
  res.json(WEIGHTS);
});

/* ----- настройки доступа ----- */
app.get('/settings/public', (req, res) => res.json({ registrationDisabled: registrationDisabled() }));

const settingsPayload = userId => {
  const adminId = getSetting('adminUserId');
  return { registrationDisabled: getSetting('registrationDisabled') === '1', adminMode: !!adminId, isAdmin: adminId === userId };
};

app.get('/settings', auth, (req, res) => res.json(settingsPayload(req.userId)));

app.put('/settings', auth, (req, res) => {
  const b = req.body || {};
  if ('registrationDisabled' in b) setSetting('registrationDisabled', b.registrationDisabled ? '1' : '0');
  if ('adminMode' in b) {
    const adminId = getSetting('adminUserId');
    if (adminId && adminId !== req.userId) bad('Режим администратора включён другим пользователем', 403);
    b.adminMode ? setSetting('adminUserId', req.userId) : delSetting('adminUserId');
  }
  res.json(settingsPayload(req.userId));
});

/* ----- редактирование вопроса (только владелец) ----- */
app.get('/questions/:id', auth, wrap(async (req, res) => {
  const q = await db.questions.findOneAsync({ _id: req.params.id });
  if (!q) bad('Не найдено', 404);
  if (q.userId !== req.userId) bad('Нет доступа', 403);
  const correct = JSON.parse(decrypt(q.correct, await questionKey(q)));
  const { correct: _c, ...rest } = q;
  res.json({ ...rest, correct });
}));

app.put('/questions/:id', auth, wrap(async (req, res) => {
  const q = await db.questions.findOneAsync({ _id: req.params.id });
  if (!q) bad('Не найдено', 404);
  if (q.userId !== req.userId) bad('Нет доступа', 403);
  const { disciplineId, topicId } = req.body;
  const topic = await db.topics.findOneAsync({ _id: topicId });
  if (!topic || topic.disciplineId !== disciplineId) bad('Тема не найдена в этой дисциплине', 404);
  const { q: newQ, correct } = validateQuestion(req.body);
  const user = await db.users.findOneAsync({ _id: req.userId });
  const upd = {
    ...newQ, disciplineId, topicId, enc: 'user',
    correct: encrypt(JSON.stringify(correct), keyOf(user.passwordHash))
  };
  const ops = { $set: upd };
  // если картинку явно убрали (img: '' | null), удаляем поле
  if ('img' in req.body && !req.body.img) { delete upd.img; ops.$unset = { img: 1 }; }
  const oldImg = q.img;
  await db.questions.updateAsync({ _id: req.params.id }, ops);
  if (oldImg) await deleteQuestionImage(oldImg);
  res.json({ ok: true });
}));

const IMG_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' };

/* Удаляет файл картинки, если на неё больше не ссылается ни один вопрос. */
async function deleteQuestionImage(imgPath) {
  if (typeof imgPath !== 'string') return;
  const m = imgPath.match(/^\/media\/question-imgs\/([\w.-]+)$/);
  if (!m) return;
  if (await db.questions.findOneAsync({ img: imgPath })) return; // ещё используется
  await fs.promises.unlink(path.join(IMG_DIR, m[1])).catch(() => { });
}

app.post('/upload/question-img', auth, express.raw({ type: 'image/*', limit: '10mb' }), wrap(async (req, res) => {
  const ext = IMG_EXT[(req.get('content-type') || '').split(';')[0].trim().toLowerCase()];
  if (!ext || !Buffer.isBuffer(req.body) || !req.body.length)
    bad('Ожидается изображение (jpeg, png, gif, webp) в теле запроса', 415);
  let t = Date.now(), name;
  for (; ;) {
    name = `${t}.${ext}`;
    try { await fs.promises.writeFile(path.join(IMG_DIR, name), req.body, { flag: 'wx' }); break; }
    catch (e) { if (e.code !== 'EEXIST') throw e; t++; }
  }
  res.status(201).json({ path: '/media/question-imgs/' + name });
}));

/* ----- 4.4 тесты ----- */
app.post('/tests', auth, wrap(async (req, res) => {
  const b = req.body;
  if (!isStr(b.name)) bad('Нужен name');
  if (!Array.isArray(b.topics) || !b.topics.length) bad('topics: [{topicId, count, questionIds?}]');
  const topics = [];
  for (const t of b.topics) {
    if (!await db.topics.findOneAsync({ _id: t.topicId })) bad('Тема не найдена: ' + t.topicId, 404);
    let ids = t.questionIds;
    if (ids === undefined) ids = (await db.questions.findAsync({ topicId: t.topicId })).map(q => q._id);
    if (!Array.isArray(ids) || !ids.length) bad('В теме нет вопросов: ' + t.topicId);
    const found = await db.questions.findAsync({ _id: { $in: ids }, topicId: t.topicId });
    if (found.length !== new Set(ids).size) bad('Часть questionIds не найдена в теме ' + t.topicId, 404);
    const count = t.count === undefined ? ids.length : t.count;
    if (!Number.isInteger(count) || count < 1 || count > ids.length) bad('count: от 1 до ' + ids.length);
    topics.push({ topicId: t.topicId, questionIds: [...new Set(ids)], count });
  }
  const test = await db.tests.insertAsync({
    _id: uuid(), name: b.name, userId: req.userId, topics,
    shuffleQuestions: !!b.shuffleQuestions,
    shuffleAnswers: !!b.shuffleAnswers,
    timeLimitSec: Number.isFinite(b.timeLimitSec) && b.timeLimitSec > 0 ? b.timeLimitSec : null,
    description: isStr(b.description) ? b.description : '',
  });
  res.status(201).json(test);
}));
app.get('/tests', wrap(async (req, res) => {
  const list = await db.tests.findAsync({});
  res.json(list.map(t => ({ id: t._id, name: t.name, description: t.description || '', timeLimitSec: t.timeLimitSec })));
}));

/* ----- импорт ФОС из Word (.docx) ----- */
const DOCX_TYPES = ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream'];

// 1) разбор файла: ничего не сохраняет, возвращает найденные дисциплины и вопросы
app.post('/import/docx/analyze', auth, express.raw({ type: DOCX_TYPES, limit: '50mb' }), wrap(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) bad('Ожидается файл .docx в теле запроса', 415);
  try { res.json(await parseDocx(req.body, { clean: req.query.clean !== '0' })); }
  catch (e) { if (e.userError) bad(e.message); throw e; }
}));

// 2) пакетная запись вопросов одной дисциплины (дисциплина и темы создаются по имени, если их ещё нет)
const nameKey = s => String(s).toLowerCase().replace(/ё/g, 'е').replace(/[.\s]+/g, ' ').trim();

/** Элементы order приходят в верном порядке — перемешиваем и считаем correct так же, как это делает интерфейс */
function orderToStored(items) {
  let idx = items.map((_, i) => i);
  for (let n = 0; n < 20 && idx.every((v, i) => v === i); n++) idx = shuffle(idx);
  return { items: idx.map(i => items[i]), correct: items.map((_, p) => idx.indexOf(p)) };
}

app.post('/import/questions', auth, wrap(async (req, res) => {
  const { disciplineName, questions } = req.body || {};
  if (!isStr(disciplineName)) bad('Нужен disciplineName');
  if (!Array.isArray(questions) || !questions.length || questions.length > 200) bad('questions: массив от 1 до 200 вопросов');

  const user = await db.users.findOneAsync({ _id: req.userId });
  const key = keyOf(user.passwordHash);

  const dname = disciplineName.trim();
  let disc = (await db.disciplines.findAsync({})).find(d => nameKey(d.name) === nameKey(dname));
  if (!disc) disc = await db.disciplines.insertAsync({ _id: uuid(), name: dname, userId: req.userId });
  const topics = new Map((await db.topics.findAsync({ disciplineId: disc._id })).map(t => [nameKey(t.name), t]));

  let added = 0;
  const failed = [];
  for (const [index, item] of questions.entries()) {
    try {
      const { topic, ...b } = item || {};
      if (b.type === 'order' && Array.isArray(b.items) && b.items.every(isStr)) Object.assign(b, orderToStored(b.items));
      const { q, correct } = validateQuestion(b);
      const tname = isStr(topic) ? topic.trim() : 'Без темы';
      let t = topics.get(nameKey(tname));
      if (!t) {
        t = await db.topics.insertAsync({ _id: uuid(), disciplineId: disc._id, name: tname, userId: req.userId });
        topics.set(nameKey(tname), t);
      }
      await db.questions.insertAsync({
        _id: uuid(), ...q, disciplineId: disc._id, topicId: t._id, userId: req.userId, enc: 'user',
        correct: encrypt(JSON.stringify(correct), key),
      });
      added++;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      failed.push({ index, error: e.message });
    }
  }
  res.status(201).json({ disciplineId: disc._id, disciplineName: disc.name, added, failed });
}));

/* ----- 4.5 удаление ----- */
app.delete('/users/:id', wrap(async (req, res) => {
  const u = await db.users.findOneAsync({ _id: req.params.id });
  const pwd = req.body && req.body.password;
  if (!u || !isStr(pwd) || !checkPassword(pwd, u.passwordHash)) bad('Неверный пользователь или пароль', 403);
  // вопросы остаются: перешифровываем их серверным ключом, т.к. хеш пароля исчезнет
  const mine = await db.questions.findAsync({ userId: u._id, enc: 'user' });
  for (const q of mine) {
    const plain = decrypt(q.correct, keyOf(u.passwordHash));
    await db.questions.updateAsync({ _id: q._id }, { $set: { enc: 'server', correct: encrypt(plain, SERVER_KEY) } });
  }
  if (getSetting('adminUserId') === u._id) delSetting('adminUserId');   // иначе у всех навсегда останется только «Результаты»
  delSetting('registrationDisabled');   // при удалении любого пользователя регистрация снова включается
  await db.users.removeAsync({ _id: u._id }, {});
  for (const [t, id] of sessions) if (id === u._id) sessions.delete(t);
  res.json({ ok: true, reencryptedQuestions: mine.length });
}));

app.delete('/questions/:id', auth, wrap(async (req, res) => {
  const q = await db.questions.findOneAsync({ _id: req.params.id });
  if (!q) bad('Не найдено', 404);
  await db.questions.removeAsync({ _id: req.params.id }, {});
  if (q.img) await deleteQuestionImage(q.img);
  res.json({ ok: true });
}));
app.delete('/topics/:id', auth, wrap(async (req, res) => {
  const n = await db.topics.removeAsync({ _id: req.params.id }, {});
  if (!n) bad('Не найдено', 404);
  const qs = await db.questions.findAsync({ topicId: req.params.id });
  await db.questions.removeAsync({ topicId: req.params.id }, { multi: true });
  for (const q of qs) if (q.img) await deleteQuestionImage(q.img);
  res.json({ ok: true });
}));
app.delete('/disciplines/:id', auth, wrap(async (req, res) => {
  const n = await db.disciplines.removeAsync({ _id: req.params.id }, {});
  if (!n) bad('Не найдено', 404);
  await db.topics.removeAsync({ disciplineId: req.params.id }, { multi: true });
  const qs = await db.questions.findAsync({ disciplineId: req.params.id });
  await db.questions.removeAsync({ disciplineId: req.params.id }, { multi: true });
  for (const q of qs) if (q.img) await deleteQuestionImage(q.img);
  res.json({ ok: true });
}));
app.delete('/tests/:id', auth, wrap(async (req, res) => {
  const n = await db.tests.removeAsync({ _id: req.params.id }, {});
  if (!n) bad('Не найдено', 404);
  res.json({ ok: true });
}));

/* ===================== Прохождение теста ===================== */
const getAttempt = id => sql.prepare('SELECT * FROM attempts WHERE id = ?').get(id);
const resultOf = a => ({
  score: a.score,
  maxScore: a.max_score,
  timeSpentSec: Math.round((a.finished_at - a.started_at) / 1000),
});
const timeLeft = a => (a.deadline ? Math.max(0, Math.round((a.deadline - Date.now()) / 1000)) : null);

async function loadAttempt(id) {
  const att = getAttempt(id);
  if (!att) bad('Прохождение не найдено', 404);
  const ans = await db.answers.findOneAsync({ _id: att.answers_id });
  return { att, ans };
}

async function finish(att, ans, at = Date.now()) {
  const score = Object.values(ans.scores).reduce((s, x) => s + x, 0);
  sql.prepare('UPDATE attempts SET finished_at = ?, score = ? WHERE id = ?').run(at, score, att.id);
  return resultOf({ ...att, finished_at: at, score });
}

/** Следующий неотвеченный вопрос; удалённые из базы вопросы пропускаются с нулём */
async function nextQuestion(ans) {
  for (; ;) {
    const idx = Object.keys(ans.answers).length;
    if (idx >= ans.questionIds.length) return null;
    const qid = ans.questionIds[idx];
    const q = await db.questions.findOneAsync({ _id: qid });
    if (q) return { q, index: idx };
    ans.answers[qid] = null; ans.scores[qid] = 0;
    await db.answers.updateAsync({ _id: ans._id }, { $set: { answers: ans.answers, scores: ans.scores } });
  }
}

const stepPayload = (att, ans, n) => ({
  question: { index: n.index + 1, total: ans.questionIds.length, ...publicQuestion(n.q, ans.shuffleAnswers) },
  timeLeftSec: timeLeft(att),
});

/* 4.6 + 4.8: сборка теста и старт (без авторизации, name и group обязательны) */
app.post('/tests/:id/start', wrap(async (req, res) => {
  const name = String(req.query.name || '').trim();
  const group = String(req.query.group || '').trim();
  if (!name || !group) bad('Нужны непустые query-параметры name и group');
  const test = await db.tests.findOneAsync({ _id: req.params.id });
  if (!test) bad('Тест не найден', 404);

  let ids = [];
  for (const t of test.topics) {
    const existing = await db.questions.findAsync({ _id: { $in: t.questionIds } });
    ids.push(...shuffle(existing.map(q => q._id)).slice(0, t.count));
  }
  if (!ids.length) bad('В тесте не осталось вопросов', 409);
  if (test.shuffleQuestions) ids = shuffle(ids);

  const qs = await db.questions.findAsync({ _id: { $in: ids } });
  const maxScore = qs.reduce((s, q) => s + WEIGHTS[q.type], 0);

  const attemptId = uuid();
  const ans = await db.answers.insertAsync({
    studentId: attemptId, testId: test._id, questionIds: ids,
    shuffleAnswers: test.shuffleAnswers, answers: {}, scores: {},
  });
  const now = Date.now();
  const deadline = test.timeLimitSec ? now + test.timeLimitSec * 1000 : null;
  sql.prepare(`INSERT INTO attempts (id, test_id, name, grp, started_at, deadline, max_score, answers_id)
               VALUES (?,?,?,?,?,?,?,?)`).run(attemptId, test._id, name, group, now, deadline, maxScore, ans._id);

  const att = getAttempt(attemptId);
  const n = await nextQuestion(ans);
  res.status(201).json({ attemptId, testName: test.name, description: test.description || '', ...stepPayload(att, ans, n) });
}));

/* текущий вопрос (на случай потери ответа) */
app.get('/attempts/:id/current', wrap(async (req, res) => {
  const { att, ans } = await loadAttempt(req.params.id);
  if (att.finished_at) return res.json({ finished: true, result: resultOf(att) });
  if (att.deadline && Date.now() > att.deadline) { await finish(att, ans, att.deadline); bad('Время вышло', 410); }
  const n = await nextQuestion(ans);
  if (!n) return res.json({ finished: true, result: await finish(att, ans) });
  res.json(stepPayload(att, ans, n));
}));

/* 4.7: ответ в теле запроса -> следующий вопрос / результат / ошибка по времени */
app.post('/attempts/:id/answer', wrap(async (req, res) => {
  const { att, ans } = await loadAttempt(req.params.id);
  if (att.finished_at) return res.json({ finished: true, result: resultOf(att) });
  if (att.deadline && Date.now() > att.deadline) { await finish(att, ans, att.deadline); bad('Время вышло', 410); }
  if (!req.body || !('answer' in req.body)) bad('Нужно поле answer');

  const cur = await nextQuestion(ans);
  if (!cur) return res.json({ finished: true, result: await finish(att, ans) });

  const correct = JSON.parse(decrypt(cur.q.correct, await questionKey(cur.q)));
  ans.answers[cur.q._id] = req.body.answer;
  ans.scores[cur.q._id] = grade(cur.q.type, correct, req.body.answer);
  await db.answers.updateAsync({ _id: ans._id }, { $set: { answers: ans.answers, scores: ans.scores } });

  const next = await nextQuestion(ans);
  if (!next) return res.json({ finished: true, result: await finish(att, ans) });
  res.json(stepPayload(att, ans, next));
}));

/* 4.9: ответы конкретного студента (по id прохождения) */
app.get('/attempts/:id/answers', auth, wrap(async (req, res) => {
  const { att, ans } = await loadAttempt(req.params.id);
  res.json({
    attemptId: att.id, name: att.name, group: att.grp, startedAt: att.started_at,
    finishedAt: att.finished_at, score: att.score, maxScore: att.max_score,
    studentId: ans.studentId, questionIds: ans.questionIds, answers: ans.answers, scores: ans.scores,
  });
}));


const normName = s => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

/* поиск id прохождений по ФИО / группе / тесту */
app.get('/attempts', auth, (req, res) => {
  const { group, testId } = req.query;
  const q = normName(req.query.name);
  if (q && q.length < 2) return res.status(400).json({ error: 'Для поиска по ФИО введите не менее 2 букв' });

  let rows = sql.prepare(`SELECT * FROM attempts
    WHERE (? IS NULL OR grp = ?) AND (? IS NULL OR test_id = ?)
    ORDER BY started_at DESC`).all(group ?? null, group ?? null, testId ?? null, testId ?? null);

  if (q) rows = rows.filter(r => normName(r.name).includes(q));

  res.json(rows.map(r => ({
    id: r.id, testId: r.test_id, name: r.name, group: r.grp, startedAt: r.started_at,
    finishedAt: r.finished_at, score: r.score, maxScore: r.max_score,
  })));
});

/* 4.10: полная очистка баз (после авторизации) */
app.delete('/db', auth, wrap(async (req, res) => {
  sql.transaction(() => {
    for (const n of Object.keys(db)) sql.exec(`DELETE FROM ${db[n].t}`);
    sql.exec('DELETE FROM attempts');
    sql.exec(`DELETE FROM settings`);
    WEIGHTS = { ...DEFAULT_WEIGHTS };
  })();
  sql.exec('VACUUM'); // вернуть место файлу
  sessions.clear();

  // удаляем все файлы изображений вопросов
  const files = await fs.promises.readdir(IMG_DIR).catch(() => []);
  await Promise.all(files.map(f =>
    fs.promises.unlink(path.join(IMG_DIR, f)).catch(() => { })
  ));
  res.json({ ok: true });
}));

app.get('/ip-port', async (req, res) => {
  try {
    const activeIp = await Promise.race([
      internalIpV4(),
      new Promise(r => setTimeout(() => r(null), 2000))
    ]);
    const remote = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    const local = remote === '127.0.0.1' || remote === '::1' || (!!activeIp && remote === activeIp);
    res.json({ ip: activeIp || '', port: Number(PORT), local });
  } catch (error) {
    res.status(500).json({ error: 'Не удалось определить IP' });
  }
});

/* ===================== Ошибки ===================== */
app.use((req, res) => res.status(404).json({ error: 'Маршрут не найден' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некорректный JSON' });
  if (!(err instanceof HttpError)) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Внутренняя ошибка' });
});

Az.Morph.init(() => {
  app.listen(PORT, '0.0.0.0', () => console.log('Сервер на http://xx.xx.xx.xx:' + PORT));
});