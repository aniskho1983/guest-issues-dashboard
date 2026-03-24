import { useState, useEffect, useCallback } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

// ─── Data hook ───────────────────────────────────────────────────────────────
function useDashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
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

// ─── Utilities ───────────────────────────────────────────────────────────────
function fmtDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
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

// ─── Sub-components ──────────────────────────────────────────────────────────

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
function UrgentIssues({ issues, lastUpdated }) {
  return (
    <SectionCard
      title="Top Urgent Issues — Last 30 Days"
      subtitle="Ranked by pattern frequency + recency · Minimum 3 occurrences to qualify"
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
          <div
            key={issue.category}
            className={`table-row rank-${i + 1}`}
          >
            <span className="rank-badge">{i + 1}</span>
            <span className="issue-name">{issue.category}</span>
            <span className="count-cell">
              <span className="count-pill">{issue.count}</span>
            </span>
            <span className="issue-date">{daysAgoLabel(issue.lastOccurrence)}</span>
            <span className="dept-tags">
              {issue.departments.slice(0, 3).map((d) => (
                <span key={d} className="dept-tag">{d}</span>
              ))}
              {issue.departments.length > 3 && (
                <span className="dept-tag dept-tag-more">
                  +{issue.departments.length - 3}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// Section 2 — Room Patterns
function RoomPatterns({ rooms, lastUpdated }) {
  return (
    <SectionCard
      title="Recurrent Patterns by Room"
      subtitle="Rooms with 2 or more issues in the last 30 days"
      lastUpdated={lastUpdated}
      isEmpty={!rooms?.length}
    >
      <div className="room-grid">
        {rooms.map((r) => (
          <div key={r.room} className="room-card">
            <div className="room-header">
              <span className="room-number">Room {r.room}</span>
              <span className="room-count">{r.count}×</span>
            </div>
            <div className="room-last">Last: {fmtDate(r.lastDate)}</div>
            <div className="room-cats">
              {r.issueTypes.slice(0, 4).map((c) => (
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
function DeptPatterns({ depts, lastUpdated }) {
  const max = Math.max(...(depts?.map((d) => d.count) ?? [1]), 1);
  return (
    <SectionCard
      title="Recurrent Patterns by Department"
      subtitle="Issue volume ranked by department — last 30 days"
      lastUpdated={lastUpdated}
      isEmpty={!depts?.length}
    >
      <div className="bar-list">
        {depts.map((d, i) => (
          <div key={d.dept} className="bar-row">
            <span className="bar-label">{d.dept}</span>
            <div className="bar-track">
              <div
                className="bar-fill"
                style={{
                  width: `${(d.count / max) * 100}%`,
                  opacity: Math.max(0.35, 1 - i * 0.055),
                }}
              />
            </div>
            <span className="bar-count">{d.count}</span>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// Section 4 — Venue (F&B) Patterns
function VenuePatterns({ venues, lastUpdated }) {
  return (
    <SectionCard
      title="Recurrent Patterns by Restaurant & Venue"
      subtitle="F&B venues only — last 30 days"
      lastUpdated={lastUpdated}
      isEmpty={!venues?.length}
    >
      <div className="venue-grid">
        {venues.map((v) => (
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

// Section 5 — YTD Summary
const CHART_TOOLTIP_STYLE = {
  contentStyle: {
    background: '#181820',
    border: '1px solid rgba(196,154,60,0.2)',
    borderRadius: 6,
    color: '#ede9df',
    fontSize: 12,
  },
  labelStyle: { color: '#c49a3c', fontWeight: 600 },
  cursor: { stroke: 'rgba(196,154,60,0.15)' },
};

function YTDSummary({ ytd, lastUpdated }) {
  if (!ytd) return null;
  const { total, byDepartment, byVenue, monthlyTrend } = ytd;

  return (
    <SectionCard
      title={`Year-to-Date Summary — ${new Date().getFullYear()}`}
      subtitle="All issues logged · Broken down by department and venue with monthly trend"
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
                  <stop offset="5%" stopColor="#c49a3c" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="#c49a3c" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
              <XAxis
                dataKey="month"
                tick={{ fill: '#4a4640', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fill: '#4a4640', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip {...CHART_TOOLTIP_STYLE} />
              <Area
                type="monotone"
                dataKey="count"
                stroke="#c49a3c"
                strokeWidth={1.5}
                fill="url(#goldGrad)"
                dot={{ fill: '#c49a3c', r: 3, strokeWidth: 0 }}
                activeDot={{ fill: '#ddb96a', r: 4 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="ytd-tables">
        <div>
          <p className="ytd-col-title">By Department</p>
          {byDepartment.map((d) => (
            <div key={d.dept} className="ytd-row">
              <span>{d.dept}</span>
              <span className="ytd-count">{d.count}</span>
            </div>
          ))}
        </div>
        {byVenue.length > 0 && (
          <div>
            <p className="ytd-col-title">F&B Venues</p>
            {byVenue.map((v) => (
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

// ─── Root App ────────────────────────────────────────────────────────────────
export default function App() {
  const { data, loading, error, refresh, refreshing } = useDashboard();

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
                  {data.last30Count} last 30d
                  <span className="meta-sep">·</span>
                  {data.ytdCount} YTD
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

      {/* ── Main ── */}
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

        {data && !loading && (
          <div className="dashboard-grid">
            <UrgentIssues issues={data.urgentIssues} lastUpdated={data.lastUpdated} />

            <div className="two-col">
              <RoomPatterns rooms={data.roomPatterns} lastUpdated={data.lastUpdated} />
              <VenuePatterns venues={data.venuePatterns} lastUpdated={data.lastUpdated} />
            </div>

            <DeptPatterns depts={data.deptPatterns} lastUpdated={data.lastUpdated} />

            <YTDSummary ytd={data.ytd} lastUpdated={data.lastUpdated} />
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
