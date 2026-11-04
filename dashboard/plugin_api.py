"""Backend for the file-actions island, mounted at ``/api/plugins/file-actions/``.

The Electron app reveals files through its own IPC (``ctx.os.revealPath``). The browser-hosted
Webapp has no such bridge, so the island calls these routes instead and the OS action runs on the
machine that serves the page — the machine the files live on. Every route is behind the same
dashboard/Webapp sign-in as the rest of ``/api``.

Imported standalone by file path (``spec_from_file_location``): keep it self-contained.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

# Stable machine-readable error codes; the desktop half matches on these.
NOT_FOUND = "file_not_found"
BAD_PATH = "absolute_path_required"
UNSUPPORTED = "platform_unsupported"


class PathBody(BaseModel):
    path: str


def resolve_path(raw: str) -> str:
    p = os.path.expanduser((raw or "").strip())
    if not p or not os.path.isabs(p) or "\x00" in p:
        raise HTTPException(status_code=400, detail=BAD_PATH)
    if not os.path.exists(p):
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    return os.path.normpath(p)


def reveal_command(path: str, platform: Optional[str] = None) -> list[str]:
    """argv that selects ``path`` in the OS file manager (a folder is opened)."""
    plat = platform or sys.platform
    if plat == "darwin":
        return ["/usr/bin/open", "-R", path]
    if plat.startswith("win"):
        return ["explorer.exe", "/select," + path]
    # Linux/BSD: no portable "select"; open the containing folder (or the folder itself).
    target = path if os.path.isdir(path) else os.path.dirname(path)
    opener = shutil.which("xdg-open") or shutil.which("gio")
    if not opener:
        raise HTTPException(status_code=501, detail=UNSUPPORTED)
    return [opener, "open", target] if opener.endswith("gio") else [opener, target]


def open_command(path: str, platform: Optional[str] = None) -> list[str]:
    plat = platform or sys.platform
    if plat == "darwin":
        return ["/usr/bin/open", path]
    if plat.startswith("win"):
        return ["explorer.exe", path]
    opener = shutil.which("xdg-open")
    if not opener:
        raise HTTPException(status_code=501, detail=UNSUPPORTED)
    return [opener, path]


def _run(args: list[str]) -> None:
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise HTTPException(status_code=500, detail=str(exc)[:300])
    # explorer.exe exits 1 even on success, so only POSIX return codes are trusted.
    if r.returncode != 0 and not sys.platform.startswith("win"):
        raise HTTPException(status_code=500, detail=(r.stderr or "open failed").strip()[:300])


@router.post("/reveal")
def reveal(body: PathBody) -> dict:
    p = resolve_path(body.path)
    _run(reveal_command(p))
    return {"ok": True, "path": p}


@router.post("/open")
def open_path(body: PathBody) -> dict:
    p = resolve_path(body.path)
    _run(open_command(p))
    return {"ok": True, "path": p}


@router.get("/exists")
def exists(path: str) -> dict:
    p = os.path.expanduser((path or "").strip())
    ok = bool(p) and os.path.isabs(p) and os.path.exists(p)
    return {"exists": ok, "is_dir": ok and os.path.isdir(p)}
