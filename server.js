require('dotenv').config();
const express = require('express');
const { Client } = require('@notionhq/client');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Database ID from the Notion URL: fe6160a3-d0fd-4c5e-824a-f43c7338ba92
const DATABASE_ID = 'fe6160a3d0fd4c5e824af43c7338ba92';

const FNB_DEPTS = [
  'F&B - Peacock',
  'F&B - La Piscina',
  'F&B - IRD',
  'F&B - Peacock Lounge',
  'F&B - Quill',
  "F&B - Goldie's",
  'F&B - Kappo Kappo',
];

// ─── Simple in-memory cache ────────────────────────────────────────────────
let cache = { data: null, timestamp: null };
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ─── Notion helpers ────────────────────────────────────────────────────────
function getClient() {
  const key = process.env.NOTION_API_KEY;
  if (!key) throw new Error('NOTION_API_KEY is not set. Copy .env.example to .env and add your key.');
  return new Client({ auth: key });
}

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

function parseRecord(page) {
  const p = page.properties;
  return {
    id: page.id,
    issueTitle: p['Issue Summary']?.title?.[0]?.plain_text || '(untitled)',
    issueCategories: p['Issue Category']?.multi_select?.map((s) => s.name) ?? [],
    department: p['Department']?.select?.name ?? null,
    room: p['Room']?.rich_text?.[0]?.plain_text?.trim() || null,
    status: p['Status']?.status?.name ?? null,
    date: p['Date']?.date?.start ?? null,
    source: p['Source']?.select?.name ?? null,
  };
}

// ─── Dashboard computation ─────────────────────────────────────────────────
function computeDashboard(rawRecords) {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const startOfYear = new Date(now.getFullYear(), 0, 1);

  const records = rawRecords.map(parseRecord).filter((r) => r.date);
  const last30 = records.filter((r) => new Date(r.date) >= thirtyDaysAgo);
  const ytd = records.filter((r) => new Date(r.date) >= startOfYear);

  // ── 1. Top Urgent Issues ──────────────────────────────────────────────────
  // Priority threshold: a category must appear 3+ times in the last 30 days.
  // Score = frequency weight (60%) + recency weight (40%).
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
      const daysSince = (now - new Date(v.lastDate)) / (24 * 60 * 60 * 1000);
      const recencyScore = Math.max(0, 1 - daysSince / 30);
      const score = (v.count / maxCatCount) * 0.6 + recencyScore * 0.4;
      return {
        category: cat,
        count: v.count,
        lastOccurrence: v.lastDate,
        departments: [...v.depts],
        score: Math.round(score * 100) / 100,
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
      count: v.count,
      issueTypes: [...v.cats],
      lastDate: [...v.dates].sort().pop(),
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

  // ── 4. Recurrent Patterns by F&B Venue ───────────────────────────────────
  const venuePatterns = deptPatterns.filter((d) => FNB_DEPTS.includes(d.dept));

  // ── 5. YTD Summary ────────────────────────────────────────────────────────
  const ytdDeptMap = {};
  ytd.forEach((r) => {
    if (!r.department) return;
    ytdDeptMap[r.department] = (ytdDeptMap[r.department] || 0) + 1;
  });

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
      total: ytd.length,
      byDepartment: Object.entries(ytdDeptMap)
        .map(([dept, count]) => ({ dept, count }))
        .sort((a, b) => b.count - a.count),
      byVenue: Object.entries(ytdDeptMap)
        .filter(([dept]) => FNB_DEPTS.includes(dept))
        .map(([dept, count]) => ({ dept, count }))
        .sort((a, b) => b.count - a.count),
      monthlyTrend,
    },
    lastUpdated: now.toISOString(),
    totalRecords: records.length,
    last30Count: last30.length,
    ytdCount: ytd.length,
  };
}

// ─── API Routes ────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

app.get('/api/dashboard', async (req, res) => {
  try {
    const bust = req.query.refresh === 'true';
    const cacheValid =
      !bust && cache.data && cache.timestamp && Date.now() - cache.timestamp < CACHE_TTL_MS;

    if (cacheValid) {
      console.log('[cache] Serving cached dashboard data');
      return res.json(cache.data);
    }

    console.log('[notion] Fetching all records from database…');
    const notion = getClient();
    const rawRecords = await fetchAllRecords(notion);
    console.log(`[notion] Fetched ${rawRecords.length} records`);

    const dashboard = computeDashboard(rawRecords);
    cache = { data: dashboard, timestamp: Date.now() };

    res.json(dashboard);
  } catch (err) {
    console.error('[error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Static files in production ───────────────────────────────────────────
if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(__dirname, 'dist');
  app.use(express.static(distPath));
  app.get('*', (_req, res) => res.sendFile(path.join(distPath, 'index.html')));
}

app.listen(PORT, () => {
  console.log('\n────────────────────────────────────────────');
  console.log('  Austin Proper Hotel');
  console.log('  Guest Issues Weekly Briefing');
  console.log(`  http://localhost:${PORT}`);
  console.log('────────────────────────────────────────────');
  if (!process.env.NOTION_API_KEY) {
    console.warn('\n  ⚠  NOTION_API_KEY is not set!');
    console.warn('  Copy .env.example → .env and add your key.\n');
  }
});
