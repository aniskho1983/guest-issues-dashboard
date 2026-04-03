// api/dashboard.js
// ─────────────────────────────────────────────────────────────────────────────
// Vercel Serverless Function — GET /api/dashboard
//
// Returns all guest issue records in a compact format so the React frontend
// can filter and compute metrics client-side for any time period (7d, MTD,
// 30d, 90d, YTD) without making additional API calls.
//
// Response shape:
//   { records: [{date, cats, dept, room, title}], lastUpdated, totalRecords }
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config(); // reads .env locally; Vercel injects env vars in production

const { Client } = require('@notionhq/client');

// ── Constants ─────────────────────────────────────────────────────────────────

const DATABASE_ID  = 'fe6160a3d0fd4c5e824af43c7338ba92';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes — avoids hammering Notion on every load

// ── In-memory cache ───────────────────────────────────────────────────────────
// Persists across requests within the same warm Vercel function instance.
let cache = { data: null, timestamp: null };

// ── Notion helpers ────────────────────────────────────────────────────────────

function getClient() {
  const key = process.env.NOTION_API_KEY;
  if (!key) throw new Error('NOTION_API_KEY is not set. Add it in Vercel → Project Settings → Environment Variables.');
  return new Client({ auth: key });
}

// Fetches every page from the database (Notion paginates at 100 records/request)
async function fetchAllRecords(notion) {
  const records = [];
  let cursor;
  do {
    const res = await notion.databases.query({
      database_id: DATABASE_ID,
      start_cursor: cursor,
      page_size: 100,
      sorts: [{ property: 'Date', direction: 'descending' }],
    });
    records.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return records;
}

// Extracts only the fields the dashboard needs from a raw Notion page object.
// Returns a compact record to keep the payload small.
function parseRecord(page) {
  const p = page.properties;
  return {
    date:  p['Date']?.date?.start ?? null,
    cats:  p['Issue Category']?.multi_select?.map(s => s.name) ?? [],
    dept:  p['Department']?.select?.name ?? null,
    room:  p['Room']?.rich_text?.[0]?.plain_text?.trim() || null,
    title: p['Issue Summary']?.title?.[0]?.plain_text || '(untitled)',
  };
}

// ── Request handler ───────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // ?refresh=true bypasses the cache and forces a fresh Notion fetch
    const bust       = req.query?.refresh === 'true';
    const cacheValid = !bust && cache.data && cache.timestamp && (Date.now() - cache.timestamp < CACHE_TTL_MS);

    if (cacheValid) {
      console.log('[cache] Serving cached records');
      return res.status(200).json(cache.data);
    }

    console.log('[notion] Fetching all records…');
    const notion = getClient();
    const raw    = await fetchAllRecords(notion);
    console.log(`[notion] Fetched ${raw.length} records`);

    // Parse and drop records without a date (they can't be filtered by period)
    const records = raw.map(parseRecord).filter(r => r.date);

    const data = {
      records,
      lastUpdated:  new Date().toISOString(),
      totalRecords: records.length,
    };

    cache = { data, timestamp: Date.now() };
    return res.status(200).json(data);
  } catch (err) {
    console.error('[error]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
