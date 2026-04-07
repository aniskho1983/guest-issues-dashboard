import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';

// ─── Constants ────────────────────────────────────────────────────────────────

// F&B department names used to separate venue metrics from other departments
const FNB_DEPTS = new Set([
  'F&B - Peacock',
  'F&B - La Piscina',
  'F&B - IRD',
  'F&B - Peacock Lounge',
  'F&B - Quill',
  "F&B - Goldie's",
  'F&B - Kappo Kappo',
]);

// The available time period filters shown in the toggle bar
const PERIODS = [
  { key: '7d',  label: '7 Days' },
  { key: 'mtd', label: 'MTD' },
  { key: '30d', label: 'Last 30 Days' },
  { key: '90d', label: '90 Days' },
  { key: 'ytd', label: 'YTD' },
];

// ─── Period helpers ───────────────────────────────────────────────────────────

// Returns the cutoff Date for a given period key
function getPeriodStart(period) {
  const now = new Date();
  if (period === '7d')  return new Date(now - 7  * 86400000);
  if (period === 'mtd') return new Date(now.getFullYear(), now.getMonth(), 1);
  if (period === '30d') return new Date(now - 30 * 86400000);
  if (period === '90d') return new Date(now - 90 * 86400000);
  if (period === 'ytd') return new Date(now.getFullYear(), 0, 1);
  return new Date(now - 30 * 86400000);
}

// Returns the display label for a period key
function getPeriodLabel(period) {
  return PERIODS.find(p => p.key === period)?.label ?? 'Last 30 Days';
}

// Minimum occurrences to qualify as "urgent" — scaled to the period length
// so short windows (7d) don't produce empty results
function getMinOccurrences(period) {
  if (period === '7d' || period === 'mtd') return 2;
  if (period === '90d') return 4;
  if (period === 'ytd') return 5;
  return 3; // default for 30d
}

// ─── Client-side metrics computation ─────────────────────────────────────────
// All filtering and aggregation happens here in the browser.
// Switching periods is instant because we already have all records in memory.

function computeMetrics(records, period) {
  const start      = getPeriodStart(period);
  const now        = new Date();
  const filtered   = records.filter(r => new Date(r.date) >= start);
  const minOcc     = getMinOccurrences(period);
  const periodDays = (now - start) / 86400000 || 1;

  // ── Urgent Issues ─────────────────────────────────────────────────────────
  // Ranked by a composite score: 60% frequency weight + 40% recency weight
  const catMap = {};
  filtered.forEach(r => {
    (r.cats || []).forEach(cat => {
      if (!catMap[cat]) catMap[cat] = { count: 0, lastDate: null, depts: new Set() };
      catMap[cat].count++;
      if (!catMap[cat].lastDate || r.date > catMap[cat].lastDate) catMap[cat].lastDate = r.date;
      if (r.dept) catMap[cat].depts.add(r.dept);
    });
  });

  const maxCatCount = Math.max(...Object.values(catMap).map(v => v.count), 1);

  const urgentIssues = Object.entries(catMap)
    .filter(([, v]) => v.count >= minOcc)
    .map(([cat, v]) => {
      const daysSince    = (now - new Date(v.lastDate)) / 86400000;
      const recencyScore = Math.max(0, 1 - daysSince / periodDays);
      const score        = (v.count / maxCatCount) * 0.6 + recencyScore * 0.4;
      return {
        category:       cat,
        count:          v.count,
        lastOccurrence: v.lastDate,
        departments:    [...v.depts],
        score:          Math.round(score * 100) / 100,
      };
    })
    .sort((a, b) => b.score - a.score || b.count - a.count)
    .slice(0, 10);

  // ── Room Patterns ─────────────────────────────────────────────────────────
  const roomMap = {};
  filtered.forEach(r => {
    if (!r.room) return;
    if (!roomMap[r.room]) roomMap[r.room] = { count: 0, cats: new Set(), dates: [] };
    roomMap[r.room].count++;
    (r.cats || []).forEach(c => roomMap[r.room].cats.add(c));
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

  // ── Department Patterns ───────────────────────────────────────────────────
  const deptMap = {};
  filtered.forEach(r => {
    if (!r.dept) return;
    deptMap[r.dept] = (deptMap[r.dept] || 0) + 1;
  });

  const deptPatterns = Object.entries(deptMap)
    .map(([dept, count]) => ({ dept, count }))
    .sort((a, b) => b.count - a.count);

  // ── Venue (F&B) Patterns ──────────────────────────────────────────────────
  const venuePatterns = deptPatterns.filter(d => FNB_DEPTS.has(d.dept));

  return { urgentIssues, roomPatterns, deptPatterns, venuePatterns, count: filtered.length };
}

// YTD summary is always year-to-date regardless of the period toggle
function computeYTD(records) {
  const start = new Date(new Date().getFullYear(), 0, 1);
  const ytd   = records.filter(r => new Date(r.date) >= start);

  const deptMap = {};
  ytd.forEach(r => {
    if (!r.dept) return;
    deptMap[r.dept] = (deptMap[r.dept] || 0) + 1;
  });

  const monthlyMap = {};
  ytd.forEach(r => {
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
    total:        ytd.length,
    byDepartment: Object.entries(deptMap).map(([dept, count]) => ({ dept, count })).sort((a, b) => b.count - a.count),
    byVenue:      Object.entries(deptMap).filter(([dept]) => FNB_DEPTS.has(dept)).map(([dept, count]) => ({ dept, count })).sort((a, b) => b.count - a.count),
    monthlyTrend,
  };
}

// ─── Data hook ────────────────────────────────────────────────────────────────
// Fetches all records once on load. Period switching is purely client-side.

function useDashboard() {
  const [data, setData]             = useState(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const fetchData = useCallback(async (bust = false) => {
    try {
      if (bust) setRefreshing(true);
      else setLoading(true);
      setError(null);

      const url = bust ? '/api/dashboard?refresh=true' : '/api/dashboard';
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      setData(await res.json());
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  return { data, loading, error, refresh: () => fetchData(true), refreshing };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function fmtDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTimestamp(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function daysAgoLabel(dateStr) {
  if (!dateStr) return '—';
  const diff = (Date.now() - new Date(dateStr).getTime()) / 86400000;
  if (diff < 1) return 'Today';
  if (diff < 2) return 'Yesterday';
  return `${Math.round(diff)}d ago`;
}

function stripFnb(dept) {
  return dept.replace(/^F&B\s*[-–]\s*/i, '');
}

// ─── Sub-components ───────────────────────────────────────────────────────────

// Period toggle bar — sits between the header and the main content
function PeriodBar({ period, onChange }) {
  return (
    <div className="period-bar">
      <div className="period-inner">
        {PERIODS.map(p => (
          <button
            key={p.key}
            className={`period-btn${period === p.key ? ' active' : ''}`}
            onClick={() => onChange(p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SectionCard({ title, subtitle, lastUpdated, isEmpty, children }) {
  return (
    <div className="section-card">
      <div className="section-header">
        <div>
          <h2 className="section-title">{title}</h2>
          {subtitle && <p className="section-subtitle">{subtitle}</p>}
        </div>
        {lastUpdated && (
          <span className="last-updated">Updated {fmtTimestamp(lastUpdated)}</span>
        )}
      </div>
      {isEmpty
        ? <div className="empty-state">No data available for this period.</div>
        : children}
    </div>
  );
}

// Section 1 — Top Urgent Issues
function UrgentIssues({ issues, lastUpdated, periodLabel }) {
  return (
    <SectionCard
      title={`Top Urgent Issues — ${periodLabel}`}
      subtitle="Ranked by pattern frequency + recency · Minimum occurrences threshold scales with period"
      lastUpdated={lastUpdated}
      isEmpty={!issues?.length}
    >
      <div className="urgent-table">
        <div className="table-head">
          <span>#</span>
          <span>Issue Category</span>
          <span>Occurrences</span>
          <span>Last Seen</span>
          <span>Departments Affected</span>
        </div>
        {issues.map((issue, i) => (
          <div key={issue.category} className={`table-row rank-${i + 1}`}>
            <span className="rank-badge">{i + 1}</span>
            <span className="issue-name">{issue.category}</span>
            <span className="count-cell"><span className="count-pill">{issue.count}</span></span>
            <span className="issue-date">{daysAgoLabel(issue.lastOccurrence)}</span>
            <span className="dept-tags">
              {issue.departments.slice(0, 3).map(d => (
                <span key={d} className="dept-tag">{d}</span>
              ))}
              {issue.departments.length > 3 && (
                <span className="dept-tag dept-tag-more">+{issue.departments.length - 3}</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// Section 2 — Room Patterns
function RoomPatterns({ rooms, lastUpdated, periodLabel }) {
  return (
    <SectionCard
      title="Recurrent Patterns by Room"
      subtitle={`Rooms with 2 or more issues — ${periodLabel}`}
      lastUpdated={lastUpdated}
      isEmpty={!rooms?.length}
    >
      <div className="room-grid">
        {rooms.map(r => (
          <div key={r.room} className="room-card">
            <div className="room-header">
              <span className="room-number">Room {r.room}</span>
              <span className="room-count">{r.count}×</span>
            </div>
            <div className="room-last">Last: {fmtDate(r.lastDate)}</div>
            <div className="room-cats">
              {r.issueTypes.slice(0, 4).map(c => (
                <span key={c} className="cat-chip">{c}</span>
              ))}
              {r.issueTypes.length > 4 && (
                <span className="cat-chip cat-chip-more">+{r.issueTypes.length - 4}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// Section 3 — Department Patterns
// Accepts `records` + `period` so it can compute per-dept category breakdowns on hover.
function DeptPatterns({ depts, lastUpdated, periodLabel, records, period }) {
  const VISIBLE = 6;
  const [expanded, setExpanded] = useState(false);
  // tooltip: { dept, cats: [{cat,count}], x, y } | null
  const [tooltip, setTooltip] = useState(null);

  const max = Math.max(...(depts?.map(d => d.count) ?? [1]), 1);
  const visible = expanded ? depts : depts?.slice(0, VISIBLE);
  const hiddenCount = (depts?.length ?? 0) - VISIBLE;

  // Compute top issue categories for a dept in the current period (for the hover tooltip)
  function getTopCats(dept) {
    if (!records?.length) return [];
    const start = getPeriodStart(period);
    const catMap = {};
    records
      .filter(r => r.dept === dept && new Date(r.date) >= start)
      .forEach(r => (r.cats || []).forEach(cat => {
        catMap[cat] = (catMap[cat] || 0) + 1;
      }));
    return Object.entries(catMap)
      .map(([cat, count]) => ({ cat, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }

  function handleMouseEnter(dept, e) {
    const cats = getTopCats(dept);
    if (!cats.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    // Position to the right; fall back to left if near screen edge
    const ttW = 290;
    let x = rect.right + 12;
    if (x + ttW > window.innerWidth - 12) x = rect.left - ttW - 12;
    setTooltip({ dept, cats, x, y: rect.top });
  }

  function handleMouseLeave() {
    setTooltip(null);
  }

  return (
    <>
      <SectionCard
        title="Recurrent Patterns by Department"
        subtitle={`Issue volume ranked by department — ${periodLabel} · Hover for breakdown`}
        lastUpdated={lastUpdated}
        isEmpty={!depts?.length}
      >
        <div className="bar-list">
          {visible.map((d, i) => (
            <div
              key={d.dept}
              className="bar-row dept-row-hoverable"
              onMouseEnter={e => handleMouseEnter(d.dept, e)}
              onMouseLeave={handleMouseLeave}
            >
              <span className="bar-label">{d.dept}</span>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{ width: `${(d.count / max) * 100}%`, opacity: Math.max(0.35, 1 - i * 0.055) }}
                />
              </div>
              <span className="bar-count">{d.count}</span>
            </div>
          ))}
        </div>

        {/* Show more / show fewer toggle — only rendered when there are > 6 depts */}
        {hiddenCount > 0 && (
          <div style={{ textAlign: 'center', marginTop: 16 }}>
            <button className="show-more-btn" onClick={() => setExpanded(v => !v)}>
              {expanded
                ? '▲ Show fewer'
                : `Show ${hiddenCount} more department${hiddenCount !== 1 ? 's' : ''} ▼`}
            </button>
          </div>
        )}
      </SectionCard>

      {/* Floating tooltip — rendered outside the card so it isn't clipped */}
      {tooltip && (
        <div
          className="dept-tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <div className="dept-tt-header">{tooltip.dept}</div>
          {(() => {
            const maxCat = tooltip.cats[0].count;
            return tooltip.cats.map(({ cat, count }) => (
              <div key={cat} className="dept-tt-row">
                <span className="dept-tt-label">{cat}</span>
                <div className="dept-tt-bar-wrap">
                  <div className="dept-tt-bar-fill" style={{ width: `${(count / maxCat) * 100}%` }} />
                </div>
                <span className="dept-tt-cnt">{count}</span>
              </div>
            ));
          })()}
        </div>
      )}
    </>
  );
}

// Section 4 — Venue (F&B) Patterns
function VenuePatterns({ venues, lastUpdated, periodLabel }) {
  return (
    <SectionCard
      title="Recurrent Patterns by Restaurant & Venue"
      subtitle={`F&B venues only — ${periodLabel}`}
      lastUpdated={lastUpdated}
      isEmpty={!venues?.length}
    >
      <div className="venue-grid">
        {venues.map(v => (
          <div key={v.dept} className="venue-card">
            <div className="venue-name">{stripFnb(v.dept)}</div>
            <div className="venue-number">{v.count}</div>
            <div className="venue-label">issues</div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// Section 5 — YTD Summary (always year-to-date, not affected by period toggle)
const CHART_TOOLTIP_STYLE = {
  contentStyle: { background: '#181820', border: '1px solid rgba(196,154,60,0.2)', borderRadius: 6, color: '#ede9df', fontSize: 12 },
  labelStyle:   { color: '#c49a3c', fontWeight: 600 },
  cursor:       { stroke: 'rgba(196,154,60,0.15)' },
};

function YTDSummary({ ytd, lastUpdated }) {
  if (!ytd) return null;
  const { total, byDepartment, byVenue, monthlyTrend } = ytd;

  return (
    <SectionCard
      title={`Year-to-Date Summary — ${new Date().getFullYear()}`}
      subtitle="All issues logged · Department and venue breakdown with monthly trend"
      lastUpdated={lastUpdated}
    >
      <div className="ytd-hero">
        <span className="ytd-big-number">{total}</span>
        <span className="ytd-big-label">total issues logged year-to-date</span>
      </div>

      {monthlyTrend?.length > 0 && (
        <div className="chart-wrap">
          <p className="chart-heading">Monthly Issue Volume</p>
          <ResponsiveContainer width="100%" height={190}>
            <AreaChart data={monthlyTrend} margin={{ top: 8, right: 8, left: -24, bottom: 0 }}>
              <defs>
                <linearGradient id="goldGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#c49a3c" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="#c49a3c" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis dataKey="month" tick={{ fill: '#4a4640', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fill: '#4a4640', fontSize: 11 }} axisLine={false} tickLine={false} />
              <Tooltip {...CHART_TOOLTIP_STYLE} />
              <Area type="monotone" dataKey="count" stroke="#c49a3c" strokeWidth={1.5} fill="url(#goldGrad)"
                dot={{ fill: '#c49a3c', r: 3, strokeWidth: 0 }} activeDot={{ fill: '#ddb96a', r: 4 }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="ytd-tables">
        <div>
          <p className="ytd-col-title">By Department</p>
          {byDepartment.map(d => (
            <div key={d.dept} className="ytd-row">
              <span>{d.dept}</span>
              <span className="ytd-count">{d.count}</span>
            </div>
          ))}
        </div>
        {byVenue.length > 0 && (
          <div>
            <p className="ytd-col-title">F&B Venues</p>
            {byVenue.map(v => (
              <div key={v.dept} className="ytd-row">
                <span>{stripFnb(v.dept)}</span>
                <span className="ytd-count">{v.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </SectionCard>
  );
}

// ─── Root App ──────────────────────────────────────────────────────────────────

export default function App() {
  const { data, loading, error, refresh, refreshing } = useDashboard();

  // Default to "Last 30 Days" — matches the most common operational view
  const [period, setPeriod] = useState('30d');

  // Re-compute all section metrics whenever records load or period changes.
  // useMemo ensures this only re-runs when the dependencies actually change.
  const metrics = useMemo(() => {
    if (!data?.records) return null;
    return computeMetrics(data.records, period);
  }, [data, period]);

  // YTD summary always reflects the full year regardless of period toggle
  const ytd = useMemo(() => {
    if (!data?.records) return null;
    return computeYTD(data.records);
  }, [data]);

  const periodLabel = getPeriodLabel(period);

  return (
    <div className="app">
      {/* ── Header ── */}
      <header className="app-header">
        <div className="header-inner">
          <div className="header-brand">
            <span className="hotel-eyebrow">Austin Proper Hotel</span>
            <h1 className="dashboard-title">Guest Issues Weekly Briefing</h1>
            <p className="dashboard-meta">
              Live · Notion Guest Issues Task Tracker
              {data && (
                <>
                  <span className="meta-sep">·</span>
                  {data.totalRecords} records
                  <span className="meta-sep">·</span>
                  {metrics?.count ?? 0} in period
                  <span className="meta-sep">·</span>
                  {ytd?.total ?? 0} YTD
                </>
              )}
            </p>
          </div>
          <button
            className={`refresh-btn${refreshing ? ' refreshing' : ''}`}
            onClick={refresh}
            disabled={loading || refreshing}
            aria-label="Refresh data from Notion"
          >
            <span className="refresh-icon">↻</span>
            {refreshing ? 'Refreshing…' : 'Refresh Data'}
          </button>
        </div>
      </header>

      {/* ── Period Toggle — shown once data is loaded ── */}
      {!loading && !error && (
        <PeriodBar period={period} onChange={setPeriod} />
      )}

      {/* ── Main Content ── */}
      <main className="app-main">
        {loading && (
          <div className="loading-state">
            <div className="loading-spinner" />
            <p className="loading-text">Pulling live data from Notion…</p>
          </div>
        )}

        {error && !loading && (
          <div className="error-state">
            <p className="error-title">⚠ Unable to load dashboard</p>
            <p className="error-msg">{error}</p>
          </div>
        )}

        {metrics && !loading && (
          <div className="dashboard-grid">
            <UrgentIssues
              issues={metrics.urgentIssues}
              lastUpdated={data.lastUpdated}
              periodLabel={periodLabel}
            />

            <div className="two-col">
              <RoomPatterns
                rooms={metrics.roomPatterns}
                lastUpdated={data.lastUpdated}
                periodLabel={periodLabel}
              />
              <VenuePatterns
                venues={metrics.venuePatterns}
                lastUpdated={data.lastUpdated}
                periodLabel={periodLabel}
              />
            </div>

            <DeptPatterns
              depts={metrics.deptPatterns}
              lastUpdated={data.lastUpdated}
              periodLabel={periodLabel}
              records={data.records}
              period={period}
            />

            <YTDSummary ytd={ytd} lastUpdated={data.lastUpdated} />
          </div>
        )}
      </main>

      {/* ── Footer ── */}
      <footer className="app-footer">
        <p>Austin Proper Hotel &nbsp;·&nbsp; Guest Experience Intelligence &nbsp;·&nbsp; Internal Use Only</p>
      </footer>
    </div>
  );
}
