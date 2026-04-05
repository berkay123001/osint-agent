#!/usr/bin/env python3
"""
Holehe JSON runner — TypeScript wrapper tarafından çağrılır.
Email adresinin hangi platformlarda kayıtlı olduğunu kontrol eder.
Çıktı: JSON (stdout)

Concurrency: MAX_CONCURRENT ile sınırlanır, rate-limited platformlar RETRY_DELAY
saniye bekleyip MAX_RETRIES kez yeniden denenir.
"""
import sys
import json
import trio
import httpx
import random
from holehe.core import get_functions, launch_module, import_submodules
import holehe.modules

MAX_CONCURRENT = 10   # aynı anda max istek sayısı (122 → 10'ar paket)
MAX_RETRIES    = 2    # rate-limit yiyen platform için retry sayısı
RETRY_DELAY    = 2.0  # retry öncesi bekleme (saniye)


async def check_with_semaphore(sem: trio.Semaphore, website, email: str, client: httpx.AsyncClient, out: list):
    async with sem:
        await launch_module(website, email, client, out)


async def check(email: str):
    modules = import_submodules(holehe.modules)
    websites = get_functions(modules)
    out = []
    sem = trio.Semaphore(MAX_CONCURRENT)

    # Tur 1: Tüm platformları sınırlı concurrency ile tara
    async with httpx.AsyncClient(timeout=15) as client:
        async with trio.open_nursery() as nursery:
            for website in websites:
                nursery.start_soon(check_with_semaphore, sem, website, email, client, out)

    # Rate-limited platformları belirle ve retry et
    for attempt in range(MAX_RETRIES):
        rl_names = {
            r["name"] for r in out
            if r.get("rateLimit") or r.get("rate_limit")
        }
        if not rl_names:
            break

        # Önceki rate-limit sonuçlarını temizle
        out = [r for r in out if r.get("name") not in rl_names]

        # Fonksiyon adı → site adı eşlemesi (holehe modülü name alanıyla)
        rl_websites = [w for w in websites if w.__name__ in rl_names]

        await trio.sleep(RETRY_DELAY * (attempt + 1) + random.uniform(0, 1))

        async with httpx.AsyncClient(timeout=15) as client:
            async with trio.open_nursery() as nursery:
                retry_out: list = []
                for website in rl_websites:
                    nursery.start_soon(check_with_semaphore, sem, website, email, client, retry_out)
        out.extend(retry_out)

    found = []
    rate_limited = []
    for r in out:
        # Rate limit → kesinlikle dahil etme, ayrı listede say
        if r.get("rateLimit") or r.get("rate_limit"):
            rate_limited.append(r["name"])
            continue
        if r.get("exists") is True:
            entry = {
                "name": r["name"],
                "exists": True,
                "emailrecovery": r.get("emailrecovery"),
                "phoneNumber": r.get("phoneNumber"),
                "others": r.get("others"),
            }
            found.append(entry)

    result = {
        "email": email,
        "services": found,
        "totalChecked": len(out),
        "rateLimitedCount": len(rate_limited),
        "rateLimitedPlatforms": rate_limited,
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Email adresi belirtilmedi"}))
        sys.exit(1)

    email = sys.argv[1]
    trio.run(check, email)
