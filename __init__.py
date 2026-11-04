"""file-actions — turn every local file delivery into an action island.

Hooked on ``transform_llm_output`` (fired once per turn, BEFORE the assistant row is persisted,
so the rewritten text is both what the user sees and what is stored):

* ``MEDIA:/abs/path`` delivery lines are rewritten in place:
  - non-media files (md, txt, pdf, docx, csv, json, zip …) lose the generic Download card and
    become a ``::file-actions{path="..."}`` island paragraph (``.html`` also gets a live
    ``::preview`` frame);
  - images/audio/video keep their inline player and gain the island right after it.
* Stray ``MEDIA:`` tokens outside delivery position (prose, inline code, fenced examples,
  non-existent paths) are defused to ``MEDIA :`` so no ghost Download cards appear mid-sentence.
* Messaging platforms (Telegram, Slack, …) are left alone: they deliver files natively.
* Idempotent and fail-open: a repeated directive is deduplicated; any internal error leaves the
  text untouched.

The island itself is rendered by this package's desktop half (``desktop/plugin.js``).
"""
from __future__ import annotations

import os
import re

MEDIA_EXT = {
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "avif", "heic", "heif",
    "icns", "tiff", "tif",
    "mp3", "wav", "aac", "flac", "m4a", "ogg", "opus", "aiff", "caf",
    "mp4", "mov", "m4v", "webm", "avi", "mkv",
}
RENDERABLE = {"html", "htm"}  # also shown live in the native ::preview frame

# Platforms whose adapters deliver MEDIA: attachments themselves — never inject directives there.
NATIVE_DELIVERY_PLATFORMS = {
    "telegram", "slack", "discord", "whatsapp", "whatsapp_cloud", "imessage", "bluebubbles",
    "signal", "matrix", "mattermost", "irc", "feishu", "lark", "teams", "email", "sms",
    "dingtalk", "wecom", "weixin", "qqbot", "yuanbao",
}

_DELIVERY_RE = re.compile(r"^[ \t]*MEDIA:[ \t]*(.+?)[ \t]*$")
_TOKEN_RE = re.compile(r"MEDIA:")
_DIRECTIVE_LINE = ("::file-actions{", "::finder-reveal{")


def _normalize(path: str) -> str:
    p = path.strip()
    while p.endswith("*"):  # trailing markdown emphasis a greedy renderer would swallow
        p = p[:-1]
    if len(p) > 1 and p[0] == p[-1] and p[0] in "\"'`":
        p = p[1:-1].strip()
    return p


def _ext(path: str) -> str:
    return os.path.splitext(path)[1].lower().lstrip(".")


def _quote(path: str) -> str:
    return path.replace('"', '\\"')


def _island(path: str) -> str:
    return '::file-actions{path="' + _quote(path) + '"}'


def rewrite_deliveries(response_text: str, platform: str = "", **_kwargs):
    """Return the rewritten text, or ``None`` when nothing changed."""
    if not response_text or "MEDIA:" not in response_text:
        return None
    native = (platform or "").lower() in NATIVE_DELIVERY_PLATFORMS
    out: list[str] = []
    in_fence = False
    changed = False

    for line in response_text.split("\n"):
        stripped = line.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            out.append(line)
            continue
        if in_fence:
            if _TOKEN_RE.search(line):
                out.append(_TOKEN_RE.sub("MEDIA :", line))
                changed = True
            else:
                out.append(line)
            continue

        m = _DELIVERY_RE.match(line)
        if not m:
            if _TOKEN_RE.search(line):
                out.append(_TOKEN_RE.sub("MEDIA :", line))
                changed = True
            else:
                out.append(line)
            continue

        path = _normalize(m.group(1))
        local = path.startswith("/") or path.startswith("~")
        if not local or not os.path.isfile(os.path.expanduser(path)):
            if native and not local:
                out.append(line)  # URL delivery on a messaging platform: leave it
                continue
            out.append(_TOKEN_RE.sub("MEDIA :", line))  # dead path: no ghost card
            changed = True
            continue

        ext = _ext(path)
        if native:
            out.append(line)  # the platform delivers the file itself
            continue
        if ext in MEDIA_EXT:
            out.extend([line, "", _island(path), ""])
        else:
            out.append("")
            if ext in RENDERABLE:
                out.extend(['::preview{file="' + _quote(path) + '"}', ""])
            out.extend([_island(path), ""])
        changed = True

    if not changed:
        return None

    text = re.sub(r"\n{4,}", "\n\n\n", "\n".join(out))
    seen: set[str] = set()
    dedup: list[str] = []
    for line in text.split("\n"):
        if line.startswith(_DIRECTIVE_LINE):
            if line in seen:
                continue
            seen.add(line)
        dedup.append(line)
    return _group_galleries("\n".join(dedup))


_ISLAND_RE = re.compile(r'^::file-actions\{path="((?:[^"\\]|\\.)*)"\}$')
# Images only: a video keeps its own inline player + card (grouping would drop playback).
GALLERY_EXT = {"png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "avif", "tif", "tiff"}


def _groupable(path: str) -> bool:
    return "|" not in path and _ext(path.replace('\\"', '"')) in GALLERY_EXT


def _group_galleries(text: str) -> str:
    """Collapse 2+ consecutive image/video deliveries into one ``paths=`` gallery island.

    Consecutive means only blank lines and their inline-player ``MEDIA:`` lines sit between them.
    The player lines are dropped for grouped items (the gallery shows them); a run is never
    grouped across prose, so a sentence between two images keeps two separate cards.
    """
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    while i < len(lines):
        run: list[str] = []
        j = i
        while j < len(lines):
            s = lines[j].strip()
            m = _ISLAND_RE.match(s)
            if m and _groupable(m.group(1)):
                run.append(m.group(1))
                j += 1
                continue
            d = _DELIVERY_RE.match(lines[j])
            if not s or (d and _groupable(_normalize(d.group(1)))):
                j += 1
                continue
            break
        if len(run) >= 2:
            out.extend(["", '::file-actions{paths="' + "|".join(run) + '"}', ""])
            i = j
            continue
        out.append(lines[i])
        i += 1
    return re.sub(r"\n{3,}", "\n\n", "\n".join(out)).strip("\n") + ("\n" if text.endswith("\n") else "")


def transform_llm_output(response_text=None, **kwargs):
    try:
        return rewrite_deliveries(response_text or "", **kwargs)
    except Exception:
        return None  # fail-open: never break a delivery


def register(ctx):
    ctx.register_hook("transform_llm_output", transform_llm_output)
