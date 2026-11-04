"""Backend for the file-actions island, mounted at ``/api/plugins/file-actions/``.

Two jobs:

* **OS actions** the browser-hosted Webapp cannot do itself (the Electron app has its own IPC):
  reveal in the file manager, open, open with a chosen app.
* **Rich card data** for every surface: file facts (size, kind, duration, dimensions),
  a small thumbnail, and the apps that can open the file.

Every route sits behind the same dashboard/Webapp sign-in as the rest of ``/api``. Routes only read
metadata and launch the OS file manager / an app the OS itself lists for the file; nothing here
writes, moves or deletes user files. Thumbnails go to a private cache dir.

Imported standalone by file path (``spec_from_file_location``): keep it self-contained.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

# Stable machine-readable error codes; the desktop half matches on these.
NOT_FOUND = "file_not_found"
BAD_PATH = "absolute_path_required"
UNSUPPORTED = "platform_unsupported"
NO_THUMB = "no_thumbnail"
BAD_APP = "app_not_offered"

IMAGE_EXT = {"png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "tif", "tiff", "avif"}
VIDEO_EXT = {"mp4", "mov", "m4v", "webm", "mkv", "avi"}
AUDIO_EXT = {"mp3", "wav", "aac", "flac", "m4a", "ogg", "opus", "aiff", "caf"}
# Quick Look is fast for these and hangs on others (measured: a .zip blocked > 30 s).
QL_EXT = {"pdf", "md", "txt", "rtf", "docx", "xlsx", "pptx", "pages", "numbers", "key", "psd", "ai", "svg", "html"}
THUMB_PX = 320
_TIMEOUT = 8


class PathBody(BaseModel):
    path: str


class OpenWithBody(BaseModel):
    path: str
    app: str


class PathsBody(BaseModel):
    paths: list[str]


# ── helpers ──────────────────────────────────────────────────────────────────
def resolve_path(raw: str) -> str:
    p = os.path.expanduser((raw or "").strip())
    if not p or not os.path.isabs(p) or "\x00" in p:
        raise HTTPException(status_code=400, detail=BAD_PATH)
    if not os.path.exists(p):
        raise HTTPException(status_code=404, detail=NOT_FOUND)
    return os.path.normpath(p)


def ext_of(path: str) -> str:
    return os.path.splitext(path)[1].lower().lstrip(".")


def kind_of(path: str) -> str:
    if os.path.isdir(path):
        return "folder"
    e = ext_of(path)
    if e in IMAGE_EXT:
        return "image"
    if e in VIDEO_EXT:
        return "video"
    if e in AUDIO_EXT:
        return "audio"
    if e == "pdf":
        return "pdf"
    return "file"


def _tool(name: str) -> Optional[str]:
    return shutil.which(name) or next(
        (p for p in (f"/opt/homebrew/bin/{name}", f"/usr/local/bin/{name}") if os.path.exists(p)), None
    )


def _run(args: list[str], timeout: int = _TIMEOUT) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail=f"timeout: {os.path.basename(args[0])}") from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=str(exc)[:300]) from exc


def _launch(args: list[str]) -> None:
    r = _run(args, timeout=10)
    # explorer.exe exits 1 even on success, so only POSIX return codes are trusted.
    if r.returncode != 0 and not sys.platform.startswith("win"):
        raise HTTPException(status_code=500, detail=(r.stderr or "open failed").strip()[:300])


def reveal_command(path: str, platform: Optional[str] = None) -> list[str]:
    """argv that selects ``path`` in the OS file manager (a folder is opened)."""
    plat = platform or sys.platform
    if plat == "darwin":
        return ["/usr/bin/open", "-R", path]
    if plat.startswith("win"):
        return ["explorer.exe", "/select," + path]
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


# ── apps that can open a file (macOS LaunchServices) ─────────────────────────
_JXA = r"""
ObjC.import('AppKit')
function run(argv){
  const url=$.NSURL.fileURLWithPath(argv[0]); const ws=$.NSWorkspace.sharedWorkspace
  const d=ws.URLForApplicationToOpenURL(url); const arr=ws.URLsForApplicationsToOpenURL(url)
  const out=[]; for(let i=0;i<arr.count;i++) out.push(ObjC.unwrap(arr.objectAtIndex(i).path))
  return JSON.stringify({def: d.isNil()?null:ObjC.unwrap(d.path), apps: out})
}"""
_HIDE = ("/Library/Caches/", "/.cache/", "/Contents/Applications/", "/Contents/Frameworks/", "/Contents/Helpers/")

# LaunchServices returns every app that claims the type, in no useful order (measured on an .mp4:
# Books, PhotoSync and WhatsApp ahead of IINA). Rank by: the OS default, then well-known tools for
# the kind, then the rest. Pro tools that never declare the type (DaVinci Resolve for .mp4) are
# offered when installed, because they do open it.
_PREFERRED = {
    "video": ["QuickTime Player", "IINA", "DaVinci Resolve", "VLC", "Final Cut Pro", "Adobe Premiere Pro",
              "Shutter Encoder", "HandBrake", "Frame.io", "MediaInfo"],
    "audio": ["Music", "QuickTime Player", "IINA", "VLC", "iZotope RX 11 Audio Editor", "Audacity", "Logic Pro"],
    "image": ["Preview", "Adobe Photoshop 2026", "Adobe Photoshop (Beta)", "Pixelmator Pro", "Affinity",
              "Adobe Illustrator", "krita", "CleanShot X", "Topaz Gigapixel AI"],
    "pdf": ["Preview", "Adobe Acrobat", "Adobe Illustrator"],
    "file": ["Visual Studio Code", "Cursor", "Zed", "Obsidian", "TextEdit", "Xcode", "BBEdit", "Sublime Text"],
}
_UNDECLARED = {
    "video": ["/Applications/DaVinci Resolve/DaVinci Resolve.app", "/Applications/Final Cut Pro.app"],
    "audio": [],
    "image": [],
    "pdf": [],
    "file": [],
}
_NOISE = {"Books", "WhatsApp", "BaiduNetdisk_mac", "PhotoSync", "Instruments", "Google Chrome for Testing"}


def rank_apps(paths: list[str], default: Optional[str], kind: str, limit: int = 8) -> list[dict]:
    pref = _PREFERRED.get(kind, _PREFERRED["file"])
    order = {name: i for i, name in enumerate(pref)}
    seen: set[str] = set()
    cands: list[tuple[tuple, dict]] = []
    for i, p in enumerate(list(paths) + [u for u in _UNDECLARED.get(kind, []) if os.path.exists(u)]):
        if not p or not p.endswith(".app") or any(h in p for h in _HIDE):
            continue
        name = _app_name(p)
        if name in seen or (name in _NOISE and p != default):
            continue
        seen.add(name)
        is_def = p == default
        key = (0 if is_def else 1, order.get(name, len(pref)), i)
        cands.append((key, {"name": name, "path": p, "default": is_def}))
    cands.sort(key=lambda c: c[0])
    return [c[1] for c in cands[:limit]]


def _app_name(app_path: str) -> str:
    return os.path.splitext(os.path.basename(app_path))[0]


def list_apps(path: str, limit: int = 8) -> list[dict]:
    if sys.platform != "darwin":
        return []
    try:
        r = _run(["/usr/bin/osascript", "-l", "JavaScript", "-e", _JXA, path], timeout=6)
        data = json.loads(r.stdout or "{}")
    except (HTTPException, ValueError):
        return []
    return rank_apps(list(data.get("apps") or []), data.get("def"), kind_of(path), limit)


# ── file facts ───────────────────────────────────────────────────────────────
def _probe_av(path: str) -> dict:
    ffprobe = _tool("ffprobe")
    if not ffprobe:
        return {}
    try:
        r = _run([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries",
                  "stream=width,height,avg_frame_rate:format=duration", "-of", "json", path], timeout=6)
        j = json.loads(r.stdout or "{}")
    except (HTTPException, ValueError):
        return {}
    out: dict = {}
    s = (j.get("streams") or [{}])[0]
    if s.get("width"):
        out["width"], out["height"] = int(s["width"]), int(s["height"])
    fr = str(s.get("avg_frame_rate") or "")
    num, _, den = fr.partition("/")
    try:
        fps = float(num) / float(den or 1)
        if 1 <= fps <= 240:
            out["fps"] = round(fps, 3)
    except (ValueError, ZeroDivisionError):
        pass
    d = (j.get("format") or {}).get("duration")
    if d:
        out["duration"] = round(float(d), 2)
    return out


def _probe_image(path: str) -> dict:
    if sys.platform != "darwin":
        return {}
    try:
        r = _run(["/usr/bin/sips", "-g", "pixelWidth", "-g", "pixelHeight", path], timeout=5)
    except HTTPException:
        return {}
    out: dict = {}
    for line in r.stdout.splitlines():
        k, _, v = line.strip().partition(": ")
        if k == "pixelWidth" and v.isdigit():
            out["width"] = int(v)
        elif k == "pixelHeight" and v.isdigit():
            out["height"] = int(v)
    return out


def file_info(path: str) -> dict:
    st = os.stat(path)
    kind = kind_of(path)
    info = {"exists": True, "path": path, "name": os.path.basename(path.rstrip("/")) or path,
            "ext": ext_of(path), "kind": kind, "size": None if kind == "folder" else st.st_size,
            "mtime": st.st_mtime}
    if kind in ("video", "audio"):
        info.update(_probe_av(path))
    elif kind == "image":
        info.update(_probe_image(path))
    elif kind == "folder":
        try:
            info["items"] = sum(1 for e in os.scandir(path) if not e.name.startswith("."))
        except OSError:
            pass
    return info


# ── thumbnails (cached by path + mtime + size) ───────────────────────────────
def _cache_dir() -> Path:
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    d = Path(home) / "cache" / "file-actions-thumbs"
    d.mkdir(parents=True, exist_ok=True)
    return d


_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _key(path: str) -> str:
    st = os.stat(path)
    return hashlib.sha1(f"{path}|{st.st_mtime_ns}|{st.st_size}|{THUMB_PX}".encode()).hexdigest()


def make_thumbnail(path: str) -> Optional[Path]:
    kind, e = kind_of(path), ext_of(path)
    out = _cache_dir() / (_key(path) + ".jpg")
    if out.exists() and out.stat().st_size > 0:
        return out
    with _locks_guard:
        lock = _locks.setdefault(str(out), threading.Lock())
    with lock:
        if out.exists() and out.stat().st_size > 0:
            return out
        tmp = Path(tempfile.mkdtemp(dir=_cache_dir()))
        try:
            ffmpeg = _tool("ffmpeg")
            if kind == "video" and ffmpeg:
                dur = _probe_av(path).get("duration") or 0
                _run([ffmpeg, "-y", "-v", "error", "-ss", "1" if dur > 2 else "0", "-i", path,
                      "-frames:v", "1", "-vf", f"scale={THUMB_PX}:-2", str(tmp / "t.jpg")], timeout=10)
            elif kind == "image" and sys.platform == "darwin":
                _run(["/usr/bin/sips", "-s", "format", "jpeg", "-Z", str(THUMB_PX), path,
                      "--out", str(tmp / "t.jpg")], timeout=8)
            elif (kind == "pdf" or e in QL_EXT) and sys.platform == "darwin":
                _run(["/usr/bin/qlmanage", "-t", "-s", str(THUMB_PX), "-o", str(tmp), path], timeout=8)
                png = next(tmp.glob("*.png"), None)
                if png:
                    _run(["/usr/bin/sips", "-s", "format", "jpeg", str(png), "--out", str(tmp / "t.jpg")], timeout=5)
            got = tmp / "t.jpg"
            if got.exists() and got.stat().st_size > 0:
                os.replace(got, out)
                return out
            return None
        except HTTPException:
            return None
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# ── routes ───────────────────────────────────────────────────────────────────
@router.post("/reveal")
def reveal(body: PathBody) -> dict:
    p = resolve_path(body.path)
    _launch(reveal_command(p))
    return {"ok": True, "path": p}


@router.post("/reveal-many")
def reveal_many(body: PathsBody) -> dict:
    paths = [resolve_path(p) for p in body.paths[:50]]
    if not paths:
        raise HTTPException(status_code=400, detail=BAD_PATH)
    if sys.platform == "darwin":
        _launch(["/usr/bin/open", "-R", *paths])
    else:
        _launch(reveal_command(paths[0]))
    return {"ok": True, "count": len(paths)}


@router.post("/open")
def open_path(body: PathBody) -> dict:
    p = resolve_path(body.path)
    _launch(open_command(p))
    return {"ok": True, "path": p}


@router.post("/open-with")
def open_with(body: OpenWithBody) -> dict:
    p = resolve_path(body.path)
    if sys.platform != "darwin":
        raise HTTPException(status_code=501, detail=UNSUPPORTED)
    offered = {a["path"] for a in list_apps(p, limit=50)}
    if body.app not in offered:  # only apps the OS itself lists for this file
        raise HTTPException(status_code=400, detail=BAD_APP)
    _launch(["/usr/bin/open", "-a", body.app, p])
    return {"ok": True, "app": _app_name(body.app)}


@router.get("/info")
def info(path: str) -> dict:
    p = os.path.expanduser((path or "").strip())
    if not p or not os.path.isabs(p):
        raise HTTPException(status_code=400, detail=BAD_PATH)
    if not os.path.exists(p):
        return {"exists": False, "path": p, "name": os.path.basename(p), "ext": ext_of(p), "kind": kind_of(p)}
    return file_info(os.path.normpath(p))


@router.get("/apps")
def apps(path: str) -> dict:
    return {"apps": list_apps(resolve_path(path))}


STRIP_FRAMES = 20
STRIP_TILE_W = 160


def make_strip(path: str) -> Optional[tuple[Path, int, float]]:
    """A horizontal sprite of STRIP_FRAMES evenly spaced frames for scrub previews.

    Keyframe-only decode first (measured: 203 MB / 36 s clip in 3.4 s vs 17.7 s full decode);
    short clips with a single keyframe yield nothing that way, so fall back to a full decode,
    which is cheap exactly when the clip is short. Cached like thumbnails.
    """
    ffmpeg = _tool("ffmpeg")
    if kind_of(path) != "video" or not ffmpeg:
        return None
    dur = _probe_av(path).get("duration") or 0
    if dur <= 0:
        return None
    n = STRIP_FRAMES
    out = _cache_dir() / (_key(path) + f".strip{n}.jpg")
    if not (out.exists() and out.stat().st_size > 0):
        with _locks_guard:
            lock = _locks.setdefault(str(out), threading.Lock())
        with lock:
            if not (out.exists() and out.stat().st_size > 0):
                tmp = Path(tempfile.mkdtemp(dir=_cache_dir()))
                try:
                    vf = f"fps={n}/{dur:.3f},scale={STRIP_TILE_W}:-2:out_range=pc,format=yuvj420p,tile={n}x1"
                    for extra, budget in ((["-skip_frame", "nokey"], 20), ([], 60)):
                        try:
                            _run([ffmpeg, "-v", "error", *extra, "-i", path, "-an", "-vf", vf,
                                  "-frames:v", "1", "-q:v", "6", str(tmp / "s.jpg")], timeout=budget)
                        except HTTPException:
                            pass
                        if (tmp / "s.jpg").exists() and (tmp / "s.jpg").stat().st_size > 0:
                            os.replace(tmp / "s.jpg", out)
                            break
                finally:
                    shutil.rmtree(tmp, ignore_errors=True)
    if not out.exists():
        return None
    return out, n, dur


@router.get("/strip")
def strip(path: str) -> dict:
    """Scrub-preview sprite: ``{dataUrl, frames, duration, tileWidth}``."""
    p = resolve_path(path)
    got = make_strip(p)
    if not got:
        raise HTTPException(status_code=404, detail=NO_THUMB)
    f, n, dur = got
    import base64
    return {"dataUrl": "data:image/jpeg;base64," + base64.b64encode(f.read_bytes()).decode("ascii"),
            "frames": n, "duration": dur, "tileWidth": STRIP_TILE_W}


@router.get("/thumb")
def thumb(path: str) -> dict:
    """Small JPEG thumbnail as a data URL (JSON, so it travels through ctx.rest on every surface)."""
    p = resolve_path(path)
    t = make_thumbnail(p)
    if not t:
        raise HTTPException(status_code=404, detail=NO_THUMB)
    import base64
    return {"dataUrl": "data:image/jpeg;base64," + base64.b64encode(t.read_bytes()).decode("ascii")}


@router.get("/exists")
def exists(path: str) -> dict:
    p = os.path.expanduser((path or "").strip())
    ok = bool(p) and os.path.isabs(p) and os.path.exists(p)
    return {"exists": ok, "is_dir": ok and os.path.isdir(p)}
