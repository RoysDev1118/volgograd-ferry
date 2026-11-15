import fs from 'fs';
import crypto from 'crypto';
import * as cheerio from 'cheerio';
import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

const PORT_URL = 'https://ppv34.ru';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

const MONTHS = {
  'января': 0, 'февраля': 1, 'марта': 2, 'апреля': 3,
  'мая': 4, 'июня': 5, 'июля': 6, 'августа': 7,
  'сентября': 8, 'октября': 9, 'ноября': 10, 'декабря': 11
};

function getVolgogradNow() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 3 * 3600000);
}

function parsePeriodDates(text, refDate) {
  // 1. Сначала ищем словесный формат: "13 ноября"
  const wordRegex = /(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/gi;
  const wordMatches = [...text.matchAll(wordRegex)];
  
  const year = refDate.getFullYear();

  if (wordMatches.length > 0) {
    const first = wordMatches.at(0);
    const startDay = parseInt(first.at(1), 10);
    const startMonth = MONTHS[first.at(2).toLowerCase()];
    const startDate = new Date(year, startMonth, startDay, 0, 0, 0);

    let endDate = null;
    if (wordMatches.length >= 2) {
      const second = wordMatches.at(1);
      const endDay = parseInt(second.at(1), 10);
      const endMonth = MONTHS[second.at(2).toLowerCase()];
      const endYear = endMonth < startMonth ? year + 1 : year;
      endDate = new Date(endYear, endMonth, endDay, 23, 59, 59);
    }
    return {
      startDate,
      endDate,
      startFormatted: `${String(startDay).padStart(2, '0')}.${String(startMonth + 1).padStart(2, '0')}`
    };
  }

  // 2. Запасной вариант — цифровой формат: "13.11" или "13.11.2026"
  const numRegex = /(\d{1,2})\.(\d{2})(?:\.(\d{2,4}))?/g;
  const numMatches = [...text.matchAll(numRegex)];
  if (numMatches.length > 0) {
    const first = numMatches.at(0);
    const startDay = parseInt(first.at(1), 10);
    const startMonth = parseInt(first.at(2), 10) - 1;
    const startDate = new Date(year, startMonth, startDay, 0, 0, 0);

    let endDate = null;
    if (numMatches.length >= 2) {
      const second = numMatches.at(1);
      const endDay = parseInt(second.at(1), 10);
      const endMonth = parseInt(second.at(2), 10) - 1;
      const endYear = endMonth < startMonth ? year + 1 : year;
      endDate = new Date(endYear, endMonth, endDay, 23, 59, 59);
    }
    return {
      startDate,
      endDate,
      startFormatted: `${String(startDay).padStart(2, '0')}.${String(startMonth + 1).padStart(2, '0')}`
    };
  }

  return null;
}

async function run() {
  const vlgNow = getVolgogradNow();
  const currentHour = vlgNow.getHours();

  const res = await fetch(PORT_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VolgogradFerryBot/1.0)' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);

  // Удаляем все таблицы во временной копии, чтобы вытащить чистые текстовые блоки перед ними
  const parsedBlocks = [];

  $('table').each((tableIndex, table) => {
    const tableText = $(table).text();
    if (!tableText.includes('Культбаза')) return;

    // Ищем текст с периодом действия перед текущей таблицей в общем контейнере статьи
    let periodText = '';
    const bodyHtml = $('body').html() || '';
    const tableHtml = $.html(table);
    const pos = bodyHtml.indexOf(tableHtml);

    if (pos !== -1) {
      const beforeHtml = bodyHtml.slice(Math.max(0, pos - 600), pos);
      const beforeText = cheerio.load(beforeHtml).text().replace(/\s+/g, ' ').trim();
      // Отрезаем всё, что было до последнего упоминания Волгограда/Культбазы перед этой таблицей
      const routeStart = beforeText.search(/Волгоград\s*[-–—]\s*Культбаза/i);
      const relevantText = routeStart !== -1 ? beforeText.slice(routeStart) : beforeText;

      const periodMatch = relevantText.match(/(Волгоград\s*[-–—]\s*Культбаза[^:;\n]*)/i) ||
                          relevantText.match(/([сc]\s+\d{1,2}[\s.][а-я0-9.]+(?:\s+по\s+\d{1,2}[\s.][а-я0-9.]+)?(?:\s+\d{4}\s*г\.?)?)/i);
      if (periodMatch) {
        periodText = periodMatch.at(1).replace(/\s+/g, ' ').trim();
      }
    }

    let idxVolgograd = 1;
    let idxKultbaza = -1;
    const rows = [];

    $(table).find('tr').each((rowIdx, tr) => {
      const cells = $(tr).find('th, td').map((__, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
      if (cells.length === 0) return;

      // Проверяем объединённую строку внутри самой таблицы
      if (cells.length === 1 && /с\s+\d{1,2}\s+[а-я]+/i.test(cells.at(0))) {
        periodText = cells.at(0);
        return;
      }

      if (cells.length < 2) return;

      if (rowIdx === 0 || cells.some(c => c.includes('От Волгограда'))) {
        cells.forEach((c, idx) => {
          if (c.includes('Волгоград')) idxVolgograd = idx;
          if (c.includes('Культбаз')) idxKultbaza = idx;
        });
        return;
      }

      if (idxKultbaza === -1) idxKultbaza = cells.length - 1;

      const day = cells.at(0);
      const fromVlg = cells.at(idxVolgograd) || '—';
      const fromKult = cells.at(idxKultbaza) || '—';

      if (day && (fromVlg !== '—' || fromKult !== '—')) {
        rows.push({ day, fromVlg, fromKult });
      }
    });

    if (rows.length > 0) {
      const dates = parsePeriodDates(periodText, vlgNow);
      parsedBlocks.push({ periodText, dates, rows });
    }
  });

  let currentSchedule = null;
  let futureSchedule = null;

  for (const block of parsedBlocks) {
    if (!block.dates) {
      if (!currentSchedule) currentSchedule = block;
      continue;
    }
    const { startDate, endDate } = block.dates;
    if (vlgNow >= startDate && (!endDate || vlgNow <= endDate)) {
      currentSchedule = block;
    } else if (vlgNow < startDate) {
      if (!futureSchedule || startDate < futureSchedule.dates.startDate) {
        futureSchedule = block;
      }
    }
  }

  if (!currentSchedule && parsedBlocks.length > 0) {
    currentSchedule = parsedBlocks.at(0);
  }

  const output = {
    lastChecked: vlgNow.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
    current: currentSchedule ? {
      period: currentSchedule.periodText || 'Действующее расписание',
      rows: currentSchedule.rows
    } : null,
    future: futureSchedule ? {
      changeDate: futureSchedule.dates.startFormatted,
      period: futureSchedule.periodText,
      rows: futureSchedule.rows
    } : null
  };

  const dataHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ current: output.current, future: output.future }))
    .digest('hex');

  output.hash = dataHash;
  fs.writeFileSync('schedule.json', JSON.stringify(output, null, 2), 'utf-8');
  console.log('schedule.json обновлён. Период:', output.current?.period);

  if (SUPABASE_URL && SUPABASE_SERVICE_KEY && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails('mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: subs, error } = await supabase
      .from('push_subscriptions')
      .select('*')
      .eq('notify_hour', currentHour)
      .neq('last_notified_hash', dataHash);

    if (error) {
      console.error('Ошибка Supabase:', error);
      return;
    }

    const bodyText = output.future
      ? `С ${output.future.changeDate} изменится расписание Волгоград — Культбаза. Нажмите, чтобы посмотреть.`
      : `Обновилось расписание рейсов Волгоград — Культбаза (${output.current?.period || ''}).`;

    for (const row of subs || []) {
      try {
        await webpush.sendNotification(
          row.subscription,
          JSON.stringify({ title: 'Речпорт Волгоград', body: bodyText })
        );
        await supabase
          .from('push_subscriptions')
          .update({ last_notified_hash: dataHash, updated_at: new Date().toISOString() })
          .eq('endpoint', row.endpoint);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          await supabase.from('push_subscriptions').delete().eq('endpoint', row.endpoint);
        } else {
          console.error('Ошибка отправки пуша:', err.message);
        }
      }
    }
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
