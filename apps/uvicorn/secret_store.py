"""Small local secret helper for switch profile API keys."""

from __future__ import annotations

import base64
import ctypes
import sys
from typing import Any


class SecretStoreError(RuntimeError):
    pass


if sys.platform == "win32":
    from ctypes import wintypes

    class DATA_BLOB(ctypes.Structure):
        _fields_ = [
            ("cbData", wintypes.DWORD),
            ("pbData", ctypes.POINTER(ctypes.c_char)),
        ]

    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32

    def _blob_from_bytes(data: bytes) -> tuple[DATA_BLOB, Any]:
        buffer = ctypes.create_string_buffer(data)
        return DATA_BLOB(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char))), buffer

    def encrypt_secret(value: str) -> str:
        raw = value.encode("utf-8")
        input_blob, _buffer = _blob_from_bytes(raw)
        output_blob = DATA_BLOB()
        ok = crypt32.CryptProtectData(
            ctypes.byref(input_blob),
            None,
            None,
            None,
            None,
            0,
            ctypes.byref(output_blob),
        )
        if not ok:
            raise SecretStoreError("failed to encrypt API key")
        try:
            encrypted = ctypes.string_at(output_blob.pbData, output_blob.cbData)
            return "dpapi:" + base64.b64encode(encrypted).decode("ascii")
        finally:
            kernel32.LocalFree(output_blob.pbData)

    def decrypt_secret(value: str) -> str:
        if not value.startswith("dpapi:"):
            raise SecretStoreError("unsupported encrypted secret format")
        encrypted = base64.b64decode(value[6:])
        input_blob, _buffer = _blob_from_bytes(encrypted)
        output_blob = DATA_BLOB()
        ok = crypt32.CryptUnprotectData(
            ctypes.byref(input_blob),
            None,
            None,
            None,
            None,
            0,
            ctypes.byref(output_blob),
        )
        if not ok:
            raise SecretStoreError("failed to decrypt API key")
        try:
            return ctypes.string_at(output_blob.pbData, output_blob.cbData).decode("utf-8")
        finally:
            kernel32.LocalFree(output_blob.pbData)

else:

    def encrypt_secret(value: str) -> str:
        raise SecretStoreError("persistent API key storage is only supported on Windows")

    def decrypt_secret(value: str) -> str:
        raise SecretStoreError("persistent API key storage is only supported on Windows")
