#!/usr/bin/env python3
"""
Austin Proper Hotel — Guest Issues Weekly Briefing
Static site generator for GitHub Pages deployment.

GitHub Actions runs this on a schedule.
It fetches live data from Notion, then bakes it into docs/index.html.

Local usage:
    NOTION_API_KEY=secret_xxx python3 generate.py
    open docs/index.html
"""

import json
import os
import sys
from pathlib import Path
from datetime import datetime, timezone

# Reuse all Notion + computation logic from server.py
from server import load_env, fetch_all_records, compute_dashboard

def main():
    load_env()

    api_key = os.environ.get("NOTION_API_KEY", "")
    if not api_key:
        print("ERROR: NOTION_API_KEY is not set.")
        print("  Local: add it to your .env file")
        print("  GitHub Actions: add it as a repository secret")
        sys.exit(1)

    print("Fetching data from Notion…")
    raw_records = fetch_all_records()
    print(f"Fetched {len(raw_records)} records")

    data = compute_dashboard(raw_records)
    print(f"Computed dashboard — {data['totalRecords']} records, "
          f"{data['last30Count']} last 30d, {data['ytdCount']} YTD")

    # Read the HTML template
    template_path = Path(__file__).parent / "dashboard.html"
    html = template_path.read_text(encoding="utf-8")

    # Inject the data as a global variable before </head>
    data_json = json.dumps(data, indent=None, separators=(',', ':'))
    injection = f'\n  <script>window.DASHBOARD_DATA={data_json};</script>\n'
    html = html.replace('</head>', injection + '</head>', 1)

    # Write to docs/index.html (GitHub Pages serves from docs/)
    out_dir = Path(__file__).parent / "docs"
    out_dir.mkdir(exist_ok=True)
    out_path = out_dir / "index.html"
    out_path.write_text(html, encoding="utf-8")

    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    print(f"Generated docs/index.html at {generated_at}")
    print("Done.")

if __name__ == "__main__":
    main()
