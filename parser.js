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

// Текущее время в Волгограде (UTC+3)
function getVolgogradNow() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utc + 3 * 3600000);
}

// Извлекаем даты начала и конца действия из заголовка
function parsePeriodDates(text, refDate) {
  const regex = /(\d{1,2})\s+(января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)/gi;
  const matches = [...text.matchAll(regex)];
  if (matches.length === 0) return null;

  const year = refDate.getFullYear();
  const startDay = parseInt(matches[0][1], 10);
  const startMonth = MONTHS[matches[0][2].toLowerCase()];
  const startDate = new Date(year, startMonth, startDay, 0, 0, 0);

  let endDate = null;
  if (matches.length >= 2) {
    const endDay = parseInt(matches[1][1], 10);
    const endMonth = MONTHS[matches[1][2].toLowerCase()];
    let endYear = year;
    if (endMonth < startMonth) endYear += 1; // переход через Новый год
    endDate = new Date(endYear, endMonth, endDay, 23, 59, 59);
  }

  return {
    startDate,
    endDate,
    startFormatted: `${String(startDay).padStart(2, '0')}.${String(startMonth + 1).padStart(2, '0')}`
  };
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

  const parsedBlocks = [];

  // Ищем все таблицы, относящиеся к Культбазе
  $('table').each((_, table) => {
    const tableText = $(table).text();
    if (!tableText.includes('Культбаза')) return;

    // Ищем заголовок перед таблицей (период действия)
    let periodText = '';
    let prev = $(table).prev();
    for (let i = 0; i < 4; i++) {
      if (!prev.length) break;
      const txt = prev.text().trim();
      if (txt.match(/действует|расписание|волгоград/i) && txt.length < 250) {
        periodText = txt + ' ' + periodText;
      }
      prev = prev.prev();
    }
    periodText = periodText.replace(/\s+/g, ' ').trim();

    // Определяем индексы нужных колонок (исключая Щучий проран)
    let idxVolgograd = 1;
    let idxKultbaza = -1;
    const rows = [];

    $(table).find('tr').each((rowIdx, tr) => {
      const cells = $(tr).find('th, td').map((__, td) => $(td).text().replace(/\s+/g, ' ').trim()).get();
      if (cells.length < 2) return;

      if (rowIdx === 0 || cells.some(c => c.includes('От Волгограда'))) {
        cells.forEach((c, idx) => {
          if (c.includes('Волгоград')) idxVolgograd = idx;
          if (c.includes('Культбаз')) idxKultbaza = idx;
        });
        return;
      }

      if (idxKultbaza === -1) idxKultbaza = cells.length - 1;

      const day = cells[0];
      const fromVlg = cells[idxVolgograd] || '—';
      const fromKult = cells[idxKultbaza] || '—';

      if (day && (fromVlg !== '—' || fromKult !== '—')) {
        rows.push({ day, fromVlg, fromKult });
      }
    });

    if (rows.length > 0) {
      const dates = parsePeriodDates(periodText, vlgNow);
      parsedBlocks.push({ periodText, dates, rows });
    }
  });

  // Выбираем актуальную таблицу на сегодня и таблицу на будущее
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

  // Если ни одна не попала в диапазон дат, берём первую найденную
  if (!currentSchedule && parsedBlocks.length > 0) {
    currentSchedule = parsedBlocks[0];
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

  // Считаем хэш только от полезных данных расписания (без времени проверки)
  const dataHash = crypto
    .createHash('sha256')
    .update(JSON.stringify({ current: output.current, future: output.future }))
    .digest('hex');

  output.hash = dataHash;
  fs.writeFileSync('schedule.json', JSON.stringify(output, null, 2), 'utf-8');
  console.log('schedule.json обновлён. Хэш:', dataHash);

  // Отправка Push-уведомлений через Supabase
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails('mailto:admin@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Ищем подписчиков, у которых выбран текущий час И хэш расписания изменился
    const { data: subs, error } = await supabase
      .from('push_subscriptions')
      .select('*')
      .eq('notify_hour', currentHour)
      .neq('last_notified_hash', dataHash);

    if (error) {
      console.error('Ошибка Supabase:', error);
      return;
    }

    console.log(`Найдено подписчиков для отправки в ${currentHour}:00 -> ${subs?.length || 0}`);

    const bodyText = output.future
      ? `С ${output.future.changeDate} изменится расписание Волгоград — Культбаза. Нажмите, чтобы посмотреть.`
      : `Обновилось расписание рейсов Волгоград — Культбаза (${output.current?.period || ''}).`;

    for (const row of subs || []) {
      try {
        await webpush.sendNotification(
          row.subscription,
          JSON.stringify({
            title: 'Речпорт Волгоград',
            body: bodyText
          })
        );
        await supabase
          .from('push_subscriptions')
          .update({ last_notified_hash: dataHash, updated_at: new Date().toISOString() })
          .eq('endpoint', row.endpoint);
      } catch (err) {
        // Если пользователь отозвал разрешение или удалил браузер (код 410/404) — чистим базу
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
