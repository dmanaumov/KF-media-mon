// Разовый сид реальными данными из архива борда "PR департамент" (b4h1ef6wwnfnjze9m6jghwfugzr).
// Источник: data/pr-department-board.jsonl (.boardarchive, выгружен пользователем 2026-09-08).
// В будущем эту же нормализацию использует живой поллинг-воркфлоу (см. §1 pr-monitoring-architecture.md).

const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

const BOARD_FILE = path.join(__dirname, '..', 'data', 'pr-department-board.jsonl');

// --- схема свойств борда "PR департамент" ---
const PROP = {
  PROJECT: 'acegagu8k8esh81kqqkxuh538hy',
  STATUS: 'a14qpgs76h6t7ffnatr14aib13c',
  SMI: 'a4zzjwmk3h7rj4gyts9ustoyapw',
  DEADLINE: 'adsfxso9tqyhgyjx97ikht789mr',
  PUB_URL: 'a6x1a1ime457e6ck949b68t547o',
  UVM: 'ac7c66pxsrebwqq6t86gc5rn8xe',
};

const PROJECT_OPTIONS = {
  '7n8pu3dqozzqito83tgrd6z1qyo': 'Сивух',
  'a5amd6469y96drojnrf3ymiacpe': 'ФЛГ',
  'a9cxxtoqstnrzqr5zuxmn4q5h4e': 'Лена',
  'acsecjdyxbjan6gxse1s7syryja': 'КонтентФерма',
  'ajpb1ske3finpsbftn6azxm6ace': 'АптекиСС',
  'ahpdc776sj3jgtkujoehz1jznuw': 'ИНСТ',
};

const STATUS_OPTIONS = {
  auqay9xpnnqgutyioojpapkr1xy: 'Идея',
  am9qc7dwznm419ne5uu1b66qwcr: 'Получили запрос',
  akuedoih65p1b8kwp8ghh67h9by: 'Собираем тезисы',
  a5y1io7furigwtxh96iw4k3p3pc: 'Черновик',
  atzewgwdnpnj37kryx3njix75ua: 'Корретировка',
  amo3nr9t7wxwmufmiztwfrpwzdc: 'Согласовываем со спикером',
  az6waynkb8uam9g9sd55h5q6n6c: 'Отдали в редакцию',
  ab7dr55131mxu5fxfi7aa55uhbc: 'Опубликован',
  apufz5rgahee5mhc4puy3u9twoc: 'Публикация отложена',
  aft1cr8btgaw6m95iuj7m37cgjc: 'Отказано',
  ast83xkkoxiruodf6bj4pnz7j5e: 'ТЗ для райтера',
  afo1adxq8kht86eifn4g66swkfc: 'Выполнено',
  aqf7y34sokdp7yuxqwmnrhsa5nr: 'В работе',
  asp43n4nuaph6mk5i7xg5fmokne: 'ОТЛОЖЕНО',
};

// "19.4К" / "414.7K" (кириллица и латиница вперемешку) -> число
function parseUvm(raw) {
  if (!raw) return null;
  const s = String(raw).trim().replace(',', '.');
  const m = s.match(/^([\d.]+)\s*([КкKk]?)(М?[Mm]?)$/);
  if (!m) {
    const n = Number(s.replace(/[^\d.]/g, ''));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  if (m[2]) n *= 1_000;
  if (m[3]) n *= 1_000_000;
  return Math.round(n);
}

// Нормализация свободного текста "СМИ/ресурс" в домен + отображаемое имя.
function normalizePlatform(raw) {
  if (!raw) return null;
  let s = raw.trim();
  if (!s || s === '-') return null;
  let domain = null;
  if (/^https?:\/\//i.test(s)) {
    try {
      domain = new URL(s).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      /* оставляем domain = null, уйдёт как бренд-имя */
    }
  } else if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s)) {
    domain = s.replace(/^www\./i, '').toLowerCase();
  }
  const displayName = domain || s;
  return { domain, displayName };
}

function getDateProp(card, propId) {
  const raw = card.fields?.properties?.[propId];
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (obj?.from) return new Date(obj.from).toISOString().slice(0, 10);
  } catch {
    /* ignore */
  }
  return null;
}

async function main() {
  const lines = fs.readFileSync(BOARD_FILE, 'utf8').split('\n').filter(Boolean);
  const blocks = lines.map((l) => JSON.parse(l).data).filter((d) => d && d.type !== undefined);
  const cards = blocks.filter((b) => b.type === 'card');

  console.log(`Прочитано карточек: ${cards.length}`);

  const clientIdByName = new Map();
  const platformIdByDomainOrName = new Map();

  let inserted = 0;
  let skippedNoLink = 0;

  for (const card of cards) {
    const props = card.fields?.properties || {};
    const projectId = props[PROP.PROJECT];
    const clientName = PROJECT_OPTIONS[projectId] || null;
    const pubUrl = props[PROP.PUB_URL] || null;
    const smiRaw = props[PROP.SMI] || null;
    const statusId = props[PROP.STATUS];
    const statusLabel = STATUS_OPTIONS[statusId] || null;
    const uvm = parseUvm(props[PROP.UVM]);
    const publishDate = getDateProp(card, PROP.DEADLINE);

    // Факт = карточка, у которой реально есть ссылка на публикацию (см. §1 архитектуры)
    if (!pubUrl) {
      skippedNoLink += 1;
      continue;
    }

    let clientId = null;
    if (clientName) {
      if (!clientIdByName.has(clientName)) {
        const { rows } = await pool.query(
          `INSERT INTO clients (name) VALUES ($1)
           ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
           RETURNING id`,
          [clientName]
        );
        clientIdByName.set(clientName, rows[0].id);
      }
      clientId = clientIdByName.get(clientName);
    }

    let platformId = null;
    const norm = normalizePlatform(smiRaw);
    if (norm) {
      const key = norm.domain || `brand:${norm.displayName.toLowerCase()}`;
      if (!platformIdByDomainOrName.has(key)) {
        const { rows } = await pool.query(
          `INSERT INTO platforms (domain, display_name)
           VALUES ($1, $2)
           ON CONFLICT (domain) DO UPDATE SET display_name = EXCLUDED.display_name
           RETURNING id`,
          [norm.domain, norm.displayName]
        );
        platformIdByDomainOrName.set(key, rows[0].id);
      }
      platformId = platformIdByDomainOrName.get(key);
    }

    await pool.query(
      `INSERT INTO facts (client_id, mm_card_id, title, source_media_raw, platform_id, status, publish_date, url, reach_estimate, reach_source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (mm_card_id) DO NOTHING`,
      [
        clientId,
        card.id,
        card.title || '(без заголовка)',
        smiRaw,
        platformId,
        statusLabel,
        publishDate,
        pubUrl,
        uvm,
        uvm ? 'uvm_manual' : null,
      ]
    );
    inserted += 1;
  }

  console.log(`Загружено фактов (с заполненной ссылкой): ${inserted}`);
  console.log(`Пропущено (нет ссылки на публикацию): ${skippedNoLink}`);
  console.log(`Клиентов: ${clientIdByName.size}, площадок: ${platformIdByDomainOrName.size}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
