# Project Overview

Internal operations dashboard for Austin Proper Hotel. Visualizes guest issues logged in Notion to help managers track patterns, department performance, and resolution times.

**Live URL:** https://guest-issues-dashboard-vercel.vercel.app/

# Current Architecture

- **Data source:** Notion database (guest issues log)
- **Frontend:** React + Vite (`src/App.jsx`) — all metrics computed client-side
- **API:** Vercel serverless function (`api/dashboard.js`) — fetches Notion data with 10-min cache
- **Hosting:** Vercel (auto-deploys from GitHub `main` branch)
- **Old GitHub Pages URL:** https://aniskho1983.github.io/guest-issues-dashboard/ (no longer used)

# Tech Stack

| File / Folder | Purpose |
|---|---|
| `index.html` | Entry point |
| `dashboard.html` | Main dashboard view |
| `src/` | Source files (JS, CSS, components) |
| `vite.config.js` | Vite bundler configuration |
| `package.json` | Node dependencies and scripts |
| `server.js` | Node.js server (local dev / future Vercel functions) |
| `generate.py` | Python script — pulls Notion data and bakes static HTML |
| `server.py` | Python server (likely local dev) |

- **Bundler:** Vite
- **Package manager:** npm
- **Runtime:** Node.js v24.14.1
- **Data scripting:** Python

# Notion Database Schema

| Code Field | Notion Column |
|---|---|
| `issueTitle` | Issue Summary |
| `issueCategories` | Issue Category |
| `department` | Department |
| `room` | Room |
| `status` | Status |
| `date` | Date |
| `source` | Source |

# What the Dashboard Tracks

- Guest complaints and issues (type, description, date logged)
- Resolution status (open / in progress / resolved)
- Department ownership (which team owns each issue)
- Response time and SLA performance
- Trends by department
- Trends by room or area of the property

# Design Rules

- Clean, scannable layout — this is an internal operations tool
- Mobile-friendly (managers and staff may view on phones)
- Proper Hospitality brand aesthetic where applicable, but function takes priority over form
- Favor charts and summaries over raw data tables

# Users

- Austin Proper operations and management team
- Non-technical audience — no developer tools or raw data exposed
- Goal: give managers a fast, clear read on guest issue patterns and resolution health

# Local Development

- Likely: `npm run dev` (confirm in `package.json` scripts)
- `generate.py` must be run separately to refresh static data in current setup

# Notes

- Notion API key should be stored in `.env` — never hardcoded
- When making changes, preserve the existing Notion field mappings unless explicitly asked to modify them
- Known issues: to be documented as discovered
