"""PR11 read-only Preview smoke tests. Never target the live shop."""
import json
import os
import re
import subprocess
from urllib.parse import urlsplit

BASE = os.environ.get(
    "TANUKI_PREVIEW_URL",
    "https://tanuki-shop-preview-pr11.sashh4051.workers.dev",
).rstrip("/")
url = urlsplit(BASE)
if (
    url.scheme != "https"
    or not re.fullmatch(
        r"tanuki-shop-(?:preview(?:-[a-z0-9]+)*|coins-preview(?:-[a-z0-9]+)*)\\.sashh4051\\.workers\\.dev",
        url.hostname or "",
    )
    or url.username
    or url.password
    or url.path
    or url.query
    or url.fragment
):
    raise SystemExit("Refusing smoke tests outside an explicitly named Tanuki Shop Preview Worker")


def check(path, expected, payload=None):
    args = [
        "curl", "--silent", "--show-error", "--max-time", "30",
        "--write-out", "\\n%{http_code}", BASE + path,
        "--header", "Accept: application/json",
    ]
    if payload is not None:
        args += [
            "--header", "Content-Type: application/json",
            "--header", "Origin: " + BASE,
            "--header", "X-Tanuki-Request: 1",
            "--data-binary", json.dumps(payload),
        ]
    output = subprocess.check_output(args, text=True)
    raw, status = output.rsplit("\\n", 1)
    if int(status) != expected:
        raise AssertionError(f"{path}: expected {expected}, got {status}; {raw[:180]}")
    response = json.loads(raw)
    print("PASS", path, status, flush=True)
    return response


health = check("/api/health", 200)
assert health.get("ok") is True and health.get("database") == "connected"
products = check("/api/products", 200)
assert products.get("ok") is True and isinstance(products.get("products"), list)

check("/api/unknown", 404)
check("/api/admin/orders", 401)

# PR11 intentionally has no customer login; a staging bot and its secrets
# must be configured and separately tested before enabling it.
for path in (
    "/api/customer/auth-config",
    "/api/customer/me",
    "/api/customer/wallet",
    "/api/customer/orders",
):
    response = check(path, 503)
    assert response.get("ok") is False

for path, body in (
    ("/api/customer/telegram", {}),
    ("/api/customer/register", {"name": "QA", "email": "invalid", "password": "short"}),
    ("/api/customer/forgot", {"email": "invalid"}),
):
    assert check(path, 503, body).get("ok") is False

# Negative requests are guaranteed not to create an order or redeem a coupon.
assert check("/api/promotions/quote", 400, {"code": "!!", "items": [{"id": "qa-sticker", "quantity": 1}]}).get("ok") is False
assert check("/api/orders", 400, {"items": []}).get("ok") is False
print("PASS: PR11 Preview API smoke complete; no purchases, database writes or production calls.")
