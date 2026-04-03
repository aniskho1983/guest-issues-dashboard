// api/dashboard.js
// ─────────────────────────────────────────────────────────────────────────────
// Vercel Serverless Function — /api/dashboard
//
// Vercel automatically exposes any file inside the /api folder as an HTTP
// endpoint. This file handles GET /api/dashboard (and ?refresh=true to
// bypass the cache). It fetches all records from the Notion database, computes
// the dashboard metrics, and returns JSON to the React frontend.
//
// The module-level cache (below) persists as long as Vercel keeps this
// function "warm" — typically several minutes. Cold starts will re-fetch.
// ─────────────────────────────────────────────────────────────────────────────

require('dotenv').config(); // reads .env in local dev; Vercel uses its own env vars in production

const { Client } = require('@notionhq/client');

// ── Constants ─────────────────────────────────────────────────────────────────

// The Notion database that stores all guest issues
const DATABASE_ID = 'fe6160a3d0fd4c5e824af43c7338ba92';

// Cache TTL: re-fetch from Notion at most once every 10 minutes per warm instance
const CACHE_TTL_MS = 10 * 60 * 1000;

// F&B department names — used to split venue-specific metrics from the rest
const FNB_DEPTS = [
  'F&B - Peacock',
  'F&B - La Piscina',
  'F&B - IRD',
  'F&B - Peacock Lounge',
  'F&B - Quill',
  "F&B - Goldie's",
  'F&B - Kappo Kappo',
];

// ── In-memory cache ───────────────────────────────────────────────────────────
// Shared across requests within the same warm function instance.
// Avoids hammering Notion on every page load.
let cache = { data: null, timestamp: null };

// ── Notion helpers ────────────────────────────────────────────────────────────

// Returns an authenticated Notion client using the key from environment variables
function getClient() {
  const key = process.env.NOTION_API_KEY;
  if (!key) {
    throw new Error('NOTION_API_KEY is not set. Add it in Vercel → Project Settings → Environment Variables.');
  }
  return new Client({ auth: key });
}

// Fetches every page from the database (Notion paginates at 100 per request)
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

// Extracts the fields we care about from a raw Notion page object
function parseRecord(page) {
  const p = page.properties;
  return {
    id: page.id,
    issueTitle:      p['Issue Summary']?.title?.[0]?.plain_text || '(untitled)',
    issueCategories: p['Issue Category']?.multi_select?.map((s) => s.name) ?? [],
    department:      p['Department']?.select?.name ?? null,
    room:            p['Room']?.rich_text?.[0]?.plain_text?.trim() || null,
    status:          p['Status']?.status?.name ?? null,
    date:            p['Date']?.date?.start ?? null,
    source:          p['Source']?.select?.name ?? null,
  };
}

// ── Dashboard computation ─────────────────────────────────────────────────────
// Takes raw Notion records and returns the metrics the React frontend needs.

function computeDashboard(rawRecords) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const startOfYear   = new Date(now.getFullYear(), 0, 1);

  // Parse and drop records without a date (they can't be charted)
  const records = rawRecords.map(parseRecord).filter((r) => r.date);
  const last30   = records.filter((r) => new Date(r.date) >= thirtyDaysAgo);
  const ytd      = records.filter((r) => new Date(r.date) >= startOfYear);

  // ── 1. Top Urgent Issues ──────────────────────────────────────────────────
  // A category must appear 3+ times in the last 30 days to qualify.
  // Score = 60% frequency weight + 40% recency weight.
  const catMap = {};
  last30.forEach((r) => {
    r.issueCategories.forEach((cat) => {
      if (!catMap[cat]) catMap[cat] = { count: 0, lastDate: null, depts: new Set() };
      catMap[cat].count++;
      if (!catMap[cat].lastDate || r.date > catMap[cat].lastDate) catMap[cat].lastDate = r.date;
      if (r.department) catMap[cat].depts.add(r.department);
    });
  });

  const maxCatCount = Math.max(...Object.values(catMap).map((v) => v.count), 1);

  const urgentIssues = Object.entries(catMap)
    .filter(([, v]) => v.count >= 3)
    .map(([cat, v]) => {
      const daysSince   = (now - new Date(v.lastDate)) / (24 * 60 * 60 * 1000);
      const recencyScore = Math.max(0, 1 - daysSince / 30);
      const score        = (v.count / maxCatCount) * 0.6 + recencyScore * 0.4;
      return {
        category:      cat,
        count:         v.count,
        lastOccurrence: v.lastDate,
        departments:   [...v.depts],
        score:         Math.round(score * 100) / 100,
      };
    })
    .sort((a, b) => b.score - a.score || b.count - a.count)
    .slice(0, 10);

  // ── 2. Recurrent Patterns by Room ─────────────────────────────────────────
  const roomMap = {};
  last30.forEach((r) => {
    if (!r.room) return;
    if (!roomMap[r.room]) roomMap[r.room] = { count: 0, cats: new Set(), dates: [] };
    roomMap[r.room].count++;
    r.issueCategories.forEach((c) => roomMap[r.room].cats.add(c));
    roomMap[r.room].dates.push(r.date);
  });

  const roomPatterns = Object.entries(roomMap)
    .filter(([, v]) => v.count >= 2)
    .map(([room, v]) => ({
      room,
      count:      v.count,
      issueTypes: [...v.cats],
      lastDate:   [...v.dates].sort().pop(),
    }))
    .sort((a, b) => b.count - a.count);

  // ── 3. Recurrent Patterns by Department ──────────────────────────────────
  const deptMap = {};
  last30.forEach((r) => {
    if (!r.department) return;
    deptMap[r.department] = (deptMap[r.department] || 0) + 1;
  });

  const deptPatterns = Object.entries(deptMap)
    .map(([dept, count]) => ({ dept, count }))
    .sort((a, b) => b.count - a.count);

  // ── 4. F&B Venue Patterns (subset of departments) ─────────────────────────
  const venuePatterns = deptPatterns.filter((d) => FNB_DEPTS.includes(d.dept));

  // ── 5. Year-to-Date Summary ───────────────────────────────────────────────
  const ytdDeptMap = {};
  ytd.forEach((r) => {
    if (!r.department) return;
    ytdDeptMap[r.department] = (ytdDeptMap[r.department] || 0) + 1;
  });

  // Group by month for the trend chart
  const monthlyMap = {};
  ytd.forEach((r) => {
    const m = r.date.substring(0, 7); // "YYYY-MM"
    monthlyMap[m] = (monthlyMap[m] || 0) + 1;
  });

  const monthlyTrend = Object.entries(monthlyMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, count]) => ({
      month: new Date(month + '-15').toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
      count,
    }));

  return {
    urgentIssues,
    roomPatterns,
    deptPatterns,
    venuePatterns,
    ytd: {
      total:        ytd.length,
      byDepartment: Object.entries(ytdDeptMap)
        .map(([dept, count]) => ({ dept, count }))
        .sort((a, b) => b.count - a.count),
      byVenue: Object.entries(ytdDeptMap)
        .filter(([dept]) => FNB_DEPTS.includes(dept))
        .map(([dept, count]) => ({ dept, count }))
        .sort((a, b) => b.count - a.count),
      monthlyTrend,
    },
    lastUpdated:  now.toISOString(),
    totalRecords: records.length,
    last30Count:  last30.length,
    ytdCount:     ytd.length,
  };
}

// ── Request handler ───────────────────────────────────────────────────────────
// This is the function Vercel calls on every request to /api/dashboard.
// It checks the cache first, then fetches from Notion if needed.

module.exports = async function handler(req, res) {
  // Allow the React frontend (any origin) to call this API
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  // Only GET requests are supported
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // ?refresh=true forces a fresh fetch, bypassing the cache
    const bust       = req.query?.refresh === 'true';
    const cacheValid = !bust && cache.data && cache.timestamp && (Date.now() - cache.timestamp < CACHE_TTL_MS);

    if (cacheValid) {
      console.log('[cache] Serving cached dashboard data');
      return res.status(200).json(cache.data);
    }

    console.log('[notion] Fetching all records…');
    const notion     = getClient();
    const rawRecords = await fetchAllRecords(notion);
    console.log(`[notion] Fetched ${rawRecords.length} records`);

    const dashboard = computeDashboard(rawRecords);

    // Store in cache for subsequent warm requests
    cache = { data: dashboard, timestamp: Date.now() };

    return res.status(200).json(dashboard);
  } catch (err) {
    console.error('[error]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
