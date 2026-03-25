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

# Categories that represent physical/facility defects in a room.
# Used to filter the "Recurrent Patterns by Room" section so it shows
# infrastructure issues (broken phone, lighting, HVAC, plumbing, etc.)
# rather than service quality issues.
FACILITY_CATEGORIES = {
    # Temperature & plumbing (in-room)
    "Hot Water/HVAC",
    "HVAC/Temperature",
    "Room Comfort",
    "Shower Issues",
    # In-room technology & devices
    "Technology/TV",
    "In-Room Tech Issues",
    "In-Room Technology",
    "Phone System Issues",
    "Technology/Phone System Issues",
    # Physical room condition
    "Room Lighting",
    "Room Comfort and Decor",
    "Room Bedding",
    "Room Amenities",
    "Bathroom Amenities",
    "Noise Issues",
    "Cleanliness",
    "Housekeeping Room Readiness",
    "Room Doesn't Match Expectations",
}

# Facility issues specific to public/shared spaces (pool, lobby, fitness center).
# These are physical defects — NOT service quality issues.
PUBLIC_FACILITY_CATEGORIES = {
    # Pool
    "Pool Too Cold",
    "Pool Too Small",
    "Pool Size",
    "Pool Chair Availability",
    # Fitness center
    "Wellness Equipment Maintenance",
    "Fitness Center Entertainment",
    # Lobby & common areas
    "Public Area Accessibility",
    "Lobby Comfort",
    "Lobby Experience",
}

# Maps public facility categories to a display space name
PUBLIC_SPACE_MAP = {
    "Pool Too Cold":               "Pool",
    "Pool Too Small":              "Pool",
    "Pool Size":                   "Pool",
    "Pool Chair Availability":     "Pool",
    "Wellness Equipment Maintenance": "Fitness Center",
    "Fitness Center Entertainment":   "Fitness Center",
    "Public Area Accessibility":   "Common Areas",
    "Lobby Comfort":               "Lobby",
    "Lobby Experience":            "Lobby",
}

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


def infer_department(title: str) -> str:
    """
    Best-guess department from Issue Summary when the stored Department is 'Other'.
    Checks venue/dept keywords in order from most-specific to most-generic.
    Returns the inferred department name, or 'Other' if nothing matches.
    """
    if not title:
        return "Other"
    t = title.lower()

    # ── F&B venues (most specific first) ──
    if "la piscina" in t or "piscina" in t:
        return "F&B - La Piscina"
    if "peacock lounge" in t or "pkb" in t:
        return "F&B - Peacock Lounge"
    if "peacock" in t:
        return "F&B - Peacock"
    if "goldie" in t:
        return "F&B - Goldie's"
    if "kappo" in t:
        return "F&B - Kappo Kappo"
    if "quill" in t:
        return "F&B - Quill"
    if " ird" in t or "in-room dining" in t or "in room dining" in t or "room service" in t:
        return "F&B - IRD"
    if any(k in t for k in ["restaurant", "bar ", "dining", "f&b", "food & bev", "menu"]):
        return "F&B - Peacock"  # generic F&B → main venue

    # ── Other departments ──
    if "pool" in t:
        return "Pool"
    if any(k in t for k in ["spa", "pilates", "massage", "fitness", "gym", "treadmill", "wellness"]):
        return "Spa"
    if any(k in t for k in ["valet", "parking", "car retriev"]):
        return "Valet"
    if any(k in t for k in ["wifi", "wi-fi", "internet", "it ", "streaming", "tv ", "television"]):
        return "IT/Systems"
    if any(k in t for k in [
        "engineer", "maintenan", "elevator", "hvac", "plumbing",
        "broken", "repair", "leak", "air condition", "heating", "electrical",
        "noise", "light bulb", "fixture", "door lock",
    ]):
        return "Engineering"
    if any(k in t for k in [
        "housekeep", "cleanliness", "clean room", "maid", "turndown",
        "linen", "towel", "sheet", "dirty",
    ]):
        return "Housekeeping"
    if any(k in t for k in [
        "front desk", "check-in", "check in", "checkout", "check out",
        "reservation", "billing", "charge", "key card", "lost", "found",
        "concierge", "late check", "early check",
    ]):
        return "Front Desk"

    return "Other"


def parse_record(page):
    p = page.get("properties", {})

    def txt(field):
        items = p.get(field, {}).get("rich_text", [])
        return items[0]["plain_text"].strip() if items else None

    def title():
        items = p.get("Issue Summary", {}).get("title", [])
        return items[0]["plain_text"] if items else "(untitled)"

    other_sub = (p.get("Other Subcategory", {}).get("select") or {}).get("name")

    # Resolve "Other" to its subcategory when available.
    # If "Other" has no subcategory, drop it — it adds no pattern value.
    raw_cats = [s["name"] for s in p.get("Issue Category", {}).get("multi_select", [])]
    resolved_cats = []
    for cat in raw_cats:
        if cat == "Other":
            if other_sub and other_sub != "Other (needs review)":
                resolved_cats.append(f"Other: {other_sub}")
            # else drop bare "Other" entirely
        else:
            resolved_cats.append(cat)

    issue_title = title()
    dept = (p.get("Department", {}).get("select") or {}).get("name")
    if dept == "Other":
        dept = infer_department(issue_title)

    return {
        "id": page["id"],
        "issueTitle": issue_title,
        "issueCategories": resolved_cats,
        "department": dept,
        "room": txt("Room"),
        "status": (p.get("Status", {}).get("status") or {}).get("name"),
        "date": (p.get("Date", {}).get("date") or {}).get("start"),
        "source": (p.get("Source", {}).get("select") or {}).get("name"),
    }


# ── Dashboard computation ────────────────────────────────────────────────────
def compute_dashboard(raw_records):
    now = datetime.now(timezone.utc)

    records = [parse_record(r) for r in raw_records]
    records = [r for r in records if r["date"]]

    # Compact format for client-side computation — keeps payload small
    compact = [
        {"date": r["date"], "cats": r["issueCategories"], "dept": r["department"], "room": r["room"]}
        for r in records
    ]

    return {
        "records": compact,
        "lastUpdated": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "totalRecords": len(records),
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
