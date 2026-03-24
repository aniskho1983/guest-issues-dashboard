#!/usr/bin/env python3
"""
Austin Proper Hotel — Guest Issues Weekly Briefing
Pure Python 3 server. No external packages needed.

Usage:
    cp .env.example .env   # add your NOTION_API_KEY
    python3 server.py
    open http://localhost:3001
"""

import json
import os
import time
import threading
import urllib.request
import urllib.error
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime, timezone, timedelta
from pathlib import Path

# ── Config ──────────────────────────────────────────────────────────────────
PORT = int(os.environ.get("PORT", 3001))
DATABASE_ID = "fe6160a3d0fd4c5e824af43c7338ba92"
CACHE_TTL = 10 * 60  # seconds

FNB_DEPTS = {
    "F&B - Peacock",
    "F&B - La Piscina",
    "F&B - IRD",
    "F&B - Peacock Lounge",
    "F&B - Quill",
    "F&B - Goldie's",
    "F&B - Kappo Kappo",
}

# ── Load .env (stdlib only) ─────────────────────────────────────────────────
def load_env():
    env_path = Path(__file__).parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, val = line.partition("=")
                os.environ.setdefault(key.strip(), val.strip())

load_env()

# ── Notion API (urllib only, no requests) ───────────────────────────────────
def notion_request(path, payload=None):
    api_key = os.environ.get("NOTION_API_KEY", "")
    if not api_key:
        raise RuntimeError(
            "NOTION_API_KEY is not set. "
            "Copy .env.example → .env and add your key."
        )
    url = f"https://api.notion.com/v1{path}"
    data = json.dumps(payload).encode() if payload else None
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
        },
        method="POST" if payload is not None else "GET",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def fetch_all_records():
    records = []
    cursor = None
    while True:
        payload = {"page_size": 100, "sorts": [{"property": "Date", "direction": "descending"}]}
        if cursor:
            payload["start_cursor"] = cursor
        resp = notion_request(f"/databases/{DATABASE_ID}/query", payload)
        records.extend(resp.get("results", []))
        if resp.get("has_more"):
            cursor = resp.get("next_cursor")
        else:
            break
    return records


def parse_record(page):
    p = page.get("properties", {})

    def txt(field):
        items = p.get(field, {}).get("rich_text", [])
        return items[0]["plain_text"].strip() if items else None

    def title():
        items = p.get("Issue Summary", {}).get("title", [])
        return items[0]["plain_text"] if items else "(untitled)"

    return {
        "id": page["id"],
        "issueTitle": title(),
        "issueCategories": [s["name"] for s in p.get("Issue Category", {}).get("multi_select", [])],
        "department": (p.get("Department", {}).get("select") or {}).get("name"),
        "room": txt("Room"),
        "status": (p.get("Status", {}).get("status") or {}).get("name"),
        "date": (p.get("Date", {}).get("date") or {}).get("start"),
        "source": (p.get("Source", {}).get("select") or {}).get("name"),
    }


# ── Dashboard computation ────────────────────────────────────────────────────
def compute_dashboard(raw_records):
    now = datetime.now(timezone.utc)
    thirty_days_ago = now - timedelta(days=30)
    start_of_year = now.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)

    records = [parse_record(r) for r in raw_records]
    records = [r for r in records if r["date"]]

    def parse_date(s):
        # handles both "YYYY-MM-DD" and "YYYY-MM-DDTHH:MM:SS..."
        s = s[:10]
        return datetime(int(s[:4]), int(s[5:7]), int(s[8:10]), tzinfo=timezone.utc)

    last30 = [r for r in records if parse_date(r["date"]) >= thirty_days_ago]
    ytd    = [r for r in records if parse_date(r["date"]) >= start_of_year]

    # ── 1. Top Urgent Issues ────────────────────────────────────────────────
    cat_map = {}
    for r in last30:
        for cat in r["issueCategories"]:
            if cat not in cat_map:
                cat_map[cat] = {"count": 0, "last_date": None, "depts": set()}
            cat_map[cat]["count"] += 1
            if not cat_map[cat]["last_date"] or r["date"] > cat_map[cat]["last_date"]:
                cat_map[cat]["last_date"] = r["date"]
            if r["department"]:
                cat_map[cat]["depts"].add(r["department"])

    max_count = max((v["count"] for v in cat_map.values()), default=1)

    urgent = []
    for cat, v in cat_map.items():
        if v["count"] < 3:
            continue
        days_since = (now - parse_date(v["last_date"])).total_seconds() / 86400
        recency = max(0.0, 1 - days_since / 30)
        score = (v["count"] / max_count) * 0.6 + recency * 0.4
        urgent.append({
            "category": cat,
            "count": v["count"],
            "lastOccurrence": v["last_date"],
            "departments": sorted(v["depts"]),
            "score": round(score, 3),
        })
    urgent.sort(key=lambda x: (-x["score"], -x["count"]))
    urgent = urgent[:10]

    # ── 2. Room Patterns ────────────────────────────────────────────────────
    room_map = {}
    for r in last30:
        if not r["room"]:
            continue
        rm = r["room"]
        if rm not in room_map:
            room_map[rm] = {"count": 0, "cats": set(), "dates": []}
        room_map[rm]["count"] += 1
        room_map[rm]["cats"].update(r["issueCategories"])
        room_map[rm]["dates"].append(r["date"])

    room_patterns = []
    for rm, v in room_map.items():
        if v["count"] < 2:
            continue
        room_patterns.append({
            "room": rm,
            "count": v["count"],
            "issueTypes": sorted(v["cats"]),
            "lastDate": sorted(v["dates"])[-1],
        })
    room_patterns.sort(key=lambda x: -x["count"])

    # ── 3. Dept Patterns ────────────────────────────────────────────────────
    dept_map = {}
    for r in last30:
        if r["department"]:
            dept_map[r["department"]] = dept_map.get(r["department"], 0) + 1
    dept_patterns = sorted(
        [{"dept": d, "count": c} for d, c in dept_map.items()],
        key=lambda x: -x["count"],
    )

    # ── 4. Venue Patterns (F&B only) ────────────────────────────────────────
    venue_patterns = [d for d in dept_patterns if d["dept"] in FNB_DEPTS]

    # ── 5. YTD ──────────────────────────────────────────────────────────────
    ytd_dept_map = {}
    for r in ytd:
        if r["department"]:
            ytd_dept_map[r["department"]] = ytd_dept_map.get(r["department"], 0) + 1

    month_map = {}
    for r in ytd:
        m = r["date"][:7]  # "YYYY-MM"
        month_map[m] = month_map.get(m, 0) + 1

    def month_label(ym):
        y, mo = int(ym[:4]), int(ym[5:7])
        months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
        return f"{months[mo-1]} '{str(y)[2:]}"

    monthly_trend = [
        {"month": month_label(m), "count": c}
        for m, c in sorted(month_map.items())
    ]

    return {
        "urgentIssues": urgent,
        "roomPatterns": room_patterns,
        "deptPatterns": dept_patterns,
        "venuePatterns": venue_patterns,
        "ytd": {
            "total": len(ytd),
            "byDepartment": sorted(
                [{"dept": d, "count": c} for d, c in ytd_dept_map.items()],
                key=lambda x: -x["count"],
            ),
            "byVenue": sorted(
                [{"dept": d, "count": c} for d, c in ytd_dept_map.items() if d in FNB_DEPTS],
                key=lambda x: -x["count"],
            ),
            "monthlyTrend": monthly_trend,
        },
        "lastUpdated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "totalRecords": len(records),
        "last30Count": len(last30),
        "ytdCount": len(ytd),
    }


# ── Cache ────────────────────────────────────────────────────────────────────
_cache = {"data": None, "ts": 0}
_cache_lock = threading.Lock()


def get_dashboard(bust=False):
    with _cache_lock:
        if not bust and _cache["data"] and (time.time() - _cache["ts"] < CACHE_TTL):
            print("[cache] Serving cached data")
            return _cache["data"]

    print("[notion] Fetching records…")
    raw = fetch_all_records()
    print(f"[notion] Got {len(raw)} records")
    data = compute_dashboard(raw)
    with _cache_lock:
        _cache["data"] = data
        _cache["ts"] = time.time()
    return data


# ── HTTP Handler ─────────────────────────────────────────────────────────────
DASHBOARD_HTML = Path(__file__).parent / "dashboard.html"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"  {self.address_string()} {fmt % args}")

    def send_json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", len(body))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?")[0]
        qs = self.path[len(path):]

        if path == "/api/health":
            self.send_json(200, {"ok": True})

        elif path == "/api/dashboard":
            bust = "refresh=true" in qs
            try:
                data = get_dashboard(bust=bust)
                self.send_json(200, data)
            except Exception as e:
                print(f"[error] {e}")
                self.send_json(500, {"error": str(e)})

        elif path in ("/", "/index.html"):
            if DASHBOARD_HTML.exists():
                body = DASHBOARD_HTML.read_bytes()
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", len(body))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_json(404, {"error": "dashboard.html not found"})

        else:
            self.send_json(404, {"error": "not found"})


# ── Main ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    if not os.environ.get("NOTION_API_KEY"):
        print("\n  ⚠  NOTION_API_KEY is not set!")
        print("  Copy .env.example → .env and add your key.\n")

    server = HTTPServer(("", PORT), Handler)
    print("\n────────────────────────────────────────────")
    print("  Austin Proper Hotel")
    print("  Guest Issues Weekly Briefing")
    print(f"  http://localhost:{PORT}")
    print("────────────────────────────────────────────\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
