#!/usr/bin/env python3
# pyright: reportMissingImports=false
"""
scrapling_runner.py — Scrapling tabanlı stealth web scraper
──────────────────────────────────────────────────────────────
Kullanım:
  python scrapling_runner.py <url> [--stealth] [--dynamic] [--css SELECTOR]

Çıktı: JSON (stdout)
  { "markdown": "...", "title": "...", "links": [...], "emails": [...],
    "avatarUrl": "...", "status": 200, "error": null }

conda activate scrapling
"""

import sys
import json
import re
import argparse

EMAIL_REGEX    = re.compile(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}')
BITCOIN_REGEX  = re.compile(r'\b(bc1[a-z0-9]{25,39}|[13][a-zA-Z0-9]{25,34})\b')
ETH_REGEX      = re.compile(r'\b0x[a-fA-F0-9]{40}\b')
TELEGRAM_REGEX = re.compile(r't\.me/([a-zA-Z0-9_]{5,})')
DISCORD_REGEX  = re.compile(r'\b[a-zA-Z0-9_.]{2,32}#[0-9]{4}\b')


def extract_osint(text: str, links: list[str]) -> dict:
    emails        = list(set(EMAIL_REGEX.findall(text)))
    btc           = list(set(BITCOIN_REGEX.findall(text)))
    eth           = list(set(ETH_REGEX.findall(text)))
    crypto        = btc + eth
    telegram      = [f"telegram:{m}" for m in TELEGRAM_REGEX.findall(text)]
    discord       = [f"discord:{m}" for m in DISCORD_REGEX.findall(text)]
    username_hints = list(set(telegram + discord))
    return {
        "emails": emails,
        "cryptoWallets": crypto,
        "usernameHints": username_hints,
    }


def scrape(url: str, mode: str, css_selector: str | None) -> dict:
    try:
        if mode == "stealth":
            from scrapling.fetchers import StealthyFetcher
            page = StealthyFetcher.fetch(
                url,
                headless=True,
                network_idle=True,
                disable_resources=True,  # CSS/img skip — daha hızlı
            )
        elif mode == "dynamic":
            from scrapling.fetchers import DynamicFetcher
            page = DynamicFetcher.fetch(
                url,
                headless=True,
                network_idle=True,
            )
        else:
            # Hızlı HTTP — TLS fingerprint spoofing dahil
            from scrapling.fetchers import Fetcher
            page = Fetcher.get(url, stealthy_headers=True, impersonate="chrome")

        status = page.status

        # İçerik çıkar
        title = ""
        try:
            og_title = page.css('meta[property="og:title"]::attr(content)')
            title = og_title.get() if og_title else (page.css("title::text").get() or "")
        except Exception:
            pass

        # Avatar
        avatar_url = None
        try:
            og_img = page.css('meta[property="og:image"]::attr(content)')
            avatar_url = og_img.get() if og_img else None
            if not avatar_url:
                tw_img = page.css('meta[name="twitter:image"]::attr(content)')
                avatar_url = tw_img.get() if tw_img else None
        except Exception:
            pass

        # CSS selector ile hedefli içerik veya body metni
        # 50K karakter — akademik makaleler için yeterli (model 1M context destekliyor)
        MAX_TEXT = 50000
        if css_selector:
            try:
                elements = page.css(css_selector)
                text = " ".join(el.get_all_text(separator="\n") for el in elements)[:MAX_TEXT]
            except Exception:
                text = page.get_all_text(separator="\n")[:MAX_TEXT] if hasattr(page, "get_all_text") else str(page.html_content or "")[:MAX_TEXT]
        else:
            try:
                text = page.get_all_text(separator="\n")[:MAX_TEXT]
            except Exception:
                text = str(getattr(page, 'html_content', '') or "")[:MAX_TEXT]

        # Linkler
        links = []
        try:
            raw_links = page.css("a::attr(href)").getall()
            links = list(set(l for l in raw_links if l and l.startswith("http")))[:30]
        except Exception:
            pass

        osint = extract_osint(text, links)

        return {
            "markdown": text,
            "title": title,
            "description": f"Scrapled via Scrapling ({mode})",
            "links": links,
            "emails": osint["emails"],
            "cryptoWallets": osint["cryptoWallets"],
            "usernameHints": osint["usernameHints"],
            "avatarUrl": avatar_url,
            "status": status,
            "error": None,
        }

    except Exception as e:
        return {
            "markdown": "",
            "title": "",
            "description": "",
            "links": [],
            "emails": [],
            "cryptoWallets": [],
            "usernameHints": [],
            "avatarUrl": None,
            "status": 0,
            "error": str(e),
        }


def main():
    parser = argparse.ArgumentParser(description="Scrapling stealth fetcher")
    parser.add_argument("url", help="Hedef URL")
    parser.add_argument("--stealth",  action="store_true", help="Patchright StealthyFetcher kullan")
    parser.add_argument("--dynamic",  action="store_true", help="Playwright DynamicFetcher kullan")
    parser.add_argument("--css",      default=None,  help="CSS selector (opsiyonel)")
    args = parser.parse_args()

    if args.stealth:
        mode = "stealth"
    elif args.dynamic:
        mode = "dynamic"
    else:
        mode = "http"

    result = scrape(args.url, mode, args.css)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
