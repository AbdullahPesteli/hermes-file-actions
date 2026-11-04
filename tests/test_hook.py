import importlib.util
import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


hook = _load("fa_hook", ROOT / "__init__.py")


@pytest.fixture
def files(tmp_path):
    report = tmp_path / "report.md"
    report.write_text("# hi")
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"\0")
    page = tmp_path / "page.html"
    page.write_text("<b>x</b>")
    return report, clip, page


def test_non_media_becomes_island(files):
    report, _, _ = files
    out = hook.rewrite_deliveries(f"Done.\nMEDIA:{report}\n")
    assert f'::file-actions{{path="{report}"}}' in out
    assert "MEDIA:" not in out


def test_media_keeps_player_and_gains_island(files):
    _, clip, _ = files
    out = hook.rewrite_deliveries(f"MEDIA:{clip}")
    assert f"MEDIA:{clip}" in out
    assert out.index(f"MEDIA:{clip}") < out.index("::file-actions{")


def test_html_gets_live_preview(files):
    _, _, page = files
    out = hook.rewrite_deliveries(f"MEDIA:{page}")
    assert f'::preview{{file="{page}"}}' in out
    assert f'::file-actions{{path="{page}"}}' in out


def test_stray_and_dead_tokens_are_defused(files):
    out = hook.rewrite_deliveries("Use the `MEDIA:` tag.\nMEDIA:/no/such/file.txt")
    assert "MEDIA:" not in out
    assert out.count("MEDIA :") == 2


def test_fenced_examples_are_defused_not_delivered(files):
    report, _, _ = files
    out = hook.rewrite_deliveries(f"```\nMEDIA:{report}\n```")
    assert "::file-actions" not in out
    assert "MEDIA :" in out


def test_messaging_platform_untouched(files):
    report, _, _ = files
    assert hook.rewrite_deliveries(f"MEDIA:{report}", platform="telegram") is None


def test_no_token_is_noop():
    assert hook.rewrite_deliveries("plain text") is None


def test_duplicate_delivery_dedupes(files):
    report, _, _ = files
    out = hook.rewrite_deliveries(f"MEDIA:{report}\nMEDIA:{report}")
    assert out.count("::file-actions{") == 1


def test_quotes_in_path_are_escaped(tmp_path):
    odd = tmp_path / 'a"b.txt'
    odd.write_text("x")
    out = hook.rewrite_deliveries(f"MEDIA:{odd}")
    assert '\\"b.txt' in out


def test_hook_fails_open(monkeypatch):
    monkeypatch.setattr(hook, "rewrite_deliveries", lambda *a, **k: 1 / 0)
    assert hook.transform_llm_output("MEDIA:/x") is None


def test_consecutive_images_become_one_gallery(tmp_path):
    imgs = []
    for n in "abc":
        p = tmp_path / f"{n}.jpg"
        p.write_bytes(b"\0")
        imgs.append(p)
    text = "Covers:\n" + "\n".join(f"MEDIA:{p}" for p in imgs) + "\nDone."
    out = hook.rewrite_deliveries(text)
    assert out.count("::file-actions{") == 1
    assert '::file-actions{paths="' + "|".join(map(str, imgs)) + '"}' in out
    assert "MEDIA:" not in out          # players dropped: the gallery shows them
    assert out.startswith("Covers:") and out.rstrip().endswith("Done.")


def test_prose_between_images_keeps_separate_cards(tmp_path):
    a, b = tmp_path / "a.png", tmp_path / "b.png"
    a.write_bytes(b"\0"); b.write_bytes(b"\0")
    out = hook.rewrite_deliveries(f"MEDIA:{a}\nThis one is warmer:\nMEDIA:{b}")
    assert "paths=" not in out
    assert out.count("::file-actions{path=") == 2


def test_videos_are_never_grouped(tmp_path):
    a, b = tmp_path / "a.mp4", tmp_path / "b.mp4"
    a.write_bytes(b"\0"); b.write_bytes(b"\0")
    out = hook.rewrite_deliveries(f"MEDIA:{a}\nMEDIA:{b}")
    assert "paths=" not in out
    assert f"MEDIA:{a}" in out and f"MEDIA:{b}" in out
