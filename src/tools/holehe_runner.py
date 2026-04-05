#!/usr/bin/env python3
"""
Holehe JSON runner — TypeScript wrapper tarafından çağrılır.
Email adresinin hangi platformlarda kayıtlı olduğunu kontrol eder.
Çıktı: JSON (stdout)
"""
import sys
import json
import trio
import httpx
from holehe.core import get_functions, launch_module, import_submodules
import holehe.modules


async def check(email: str):
    modules = import_submodules(holehe.modules)
    websites = get_functions(modules)
    out = []

    async with httpx.AsyncClient() as client:
        async with trio.open_nursery() as nursery:
            for website in websites:
                nursery.start_soon(launch_module, website, email, client, out)

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
