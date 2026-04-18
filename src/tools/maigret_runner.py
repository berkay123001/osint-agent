#!/usr/bin/env python3
"""
Maigret JSON runner — called by the TypeScript wrapper.
Account search across 3000+ platforms for a given username.
Output: JSON (stdout)
"""
import sys
import json
import asyncio
import logging
from pathlib import Path


async def run_maigret(username: str, top_sites: int, timeout: int):
    try:
        from maigret.checking import maigret, MaigretDatabase, MaigretCheckStatus
        import maigret as _m
    except ImportError as e:
        print(json.dumps({"error": f"maigret not installed: {e}"}))
        sys.exit(1)

    db_path = Path(_m.__file__).parent / "resources" / "data.json"
    if not db_path.exists():
        print(json.dumps({"error": f"maigret data.json not found: {db_path}"}))
        sys.exit(1)

    db = MaigretDatabase().load_from_file(str(db_path))

    # Take the top N most popular sites (ranked_sites_dict is already sorted)
    try:
        site_dict = db.ranked_sites_dict(top=top_sites)
    except Exception:
        import itertools
        site_dict = dict(itertools.islice(db.sites_dict.items(), top_sites))

    # Sessiz logger — stdout'u kirletmesin
    logger = logging.getLogger("maigret_runner")
    logger.setLevel(logging.CRITICAL)

    results = await maigret(
        username=username,
        site_dict=site_dict,
        logger=logger,
        timeout=timeout,
        max_connections=10,    # keep low to reduce rate-limit hits
        no_progressbar=True,
        is_parsing_enabled=False,
    )

    found = []
    for site_name, info in results.items():
        status_obj = info.get("status")
        if status_obj is None:
            continue
        # MaigretCheckStatus.CLAIMED → hesap var
        from maigret.checking import MaigretCheckStatus as S
        if status_obj.status == S.CLAIMED:
            found.append({
                "site": site_name,
                "url": info.get("url_user", ""),
                "ids": {k: v for k, v in (info.get("ids_data") or {}).items() if v},
            })

    output = {
        "username": username,
        "found": found,
        "foundCount": len(found),
        "checkedCount": len(results),
    }
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: maigret_runner.py <username> [top_sites] [timeout]"}))
        sys.exit(1)

    username = sys.argv[1]
    # Security: allow only alphanumeric + - _ . in username
    import re
    if not re.match(r'^[A-Za-z0-9_.\-]{1,50}$', username):
        print(json.dumps({"error": f"Invalid username format: {username}"}))
        sys.exit(1)

    top_sites = int(sys.argv[2]) if len(sys.argv) > 2 else 500
    timeout = int(sys.argv[3]) if len(sys.argv) > 3 else 20

    asyncio.run(run_maigret(username, top_sites, timeout))
