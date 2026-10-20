#!/usr/bin/env python3
"""Dump chatgpt.com cookies from one Chromium-family profile (Linux).

Chrome's os_crypt on Linux: "v11" prefix + AES-128-CBC with a key derived by
PBKDF2-HMAC-SHA1(keyring secret, salt="saltysalt", 1 iteration, 16 bytes) and a
fixed IV of 16 spaces; the plaintext carries a 32-byte SHA256(host) domain
separator in front of the value. The keyring secret ("Chrome Safe Storage") is
read over the Secret Service D-Bus API, the same lookup Chrome itself does.
The profile database is opened read-only (copied to a temp file first).

Usage:
  python3 dump-browser-cookies.py --db <Cookies path> --host chatgpt.com,auth.openai.com
Prints TSV lines: host<TAB>name<TAB>value
"""
import argparse
import hashlib
import os
import shutil
import sqlite3
import sys
import tempfile

try:
    import dbus
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes
except ImportError as exc:  # pragma: no cover
    raise SystemExit(f"missing dependency: {exc} (apt install python3-dbus python3-cryptography)")


def chrome_safe_storage() -> bytes:
    bus = dbus.SessionBus()
    svc_obj = bus.get_object("org.freedesktop.secrets", "/org/freedesktop/secrets")
    svc = dbus.Interface(svc_obj, "org.freedesktop.Secret.Service")
    props = dbus.Interface(svc_obj, "org.freedesktop.DBus.Properties")
    collections = props.Get("org.freedesktop.Secret.Service", "Collections")
    for col_path in collections:
        col_obj = bus.get_object("org.freedesktop.secrets", col_path)
        col_props = dbus.Interface(col_obj, "org.freedesktop.DBus.Properties")
        for item_path in col_props.Get("org.freedesktop.Secret.Collection", "Items"):
            it_obj = bus.get_object("org.freedesktop.secrets", item_path)
            it_props = dbus.Interface(it_obj, "org.freedesktop.DBus.Properties")
            if "Safe Storage" in str(it_props.Get("org.freedesktop.Secret.Item", "Label")):
                session = svc.OpenSession("plain", "")[1]
                secret = dbus.Interface(
                    bus.get_object("org.freedesktop.secrets", item_path),
                    "org.freedesktop.Secret.Item",
                ).GetSecret(session)
                return bytes(secret[2])
    raise SystemExit("Chrome Safe Storage not found in the keyring")


def decrypt_v11(encrypted: bytes, key: bytes, host: str) -> str:
    if encrypted[:3] not in (b"v10", b"v11"):
        raise ValueError(f"not v10/v11 (prefix {encrypted[:3]!r})")
    cipher = Cipher(algorithms.AES(key), modes.CBC(b" " * 16))
    dec = cipher.decryptor()
    plain = dec.update(encrypted[3:]) + dec.finalize()
    n = plain[-1]
    if not (1 <= n <= 16) or plain[-n:] != bytes([n]) * n:
        raise ValueError("bad padding")
    plain = plain[:-n]
    if len(plain) > 32 and plain[:32] == hashlib.sha256(host.encode()).digest():
        plain = plain[32:]
    return plain.decode("utf-8")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--host", required=True, help="comma-separated host filters")
    args = parser.parse_args()
    hosts = [h for h in args.host.split(",") if h]

    key = PBKDF2HMAC(algorithm=hashes.SHA1(), length=16, salt=b"saltysalt", iterations=1).derive(
        chrome_safe_storage()
    )
    tmp = tempfile.mktemp()
    shutil.copy2(args.db, tmp)
    try:
        con = sqlite3.connect(tmp)
        clause = " OR ".join("host_key LIKE ?" for _ in hosts)
        rows = con.execute(
            f"SELECT host_key, name, encrypted_value FROM cookies WHERE ({clause})",
            [f"%{h}" for h in hosts],
        ).fetchall()
        con.close()
    finally:
        os.unlink(tmp)
    for host, name, enc in rows:
        try:
            value = decrypt_v11(bytes(enc), key, host)
        except Exception:  # noqa: BLE001 - skip undecryptable entries
            continue
        if all(0x21 <= ord(c) <= 0x7E for c in value):
            print(f"{host}\t{name}\t{value}")


if __name__ == "__main__":
    main()
