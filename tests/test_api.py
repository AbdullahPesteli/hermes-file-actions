import importlib.util
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("fa_api", ROOT / "dashboard" / "plugin_api.py")
api = importlib.util.module_from_spec(spec)
sys.modules["fa_api"] = api
spec.loader.exec_module(api)


@pytest.fixture
def client(monkeypatch):
    calls = []

    class Done:
        returncode = 0
        stderr = ""

    monkeypatch.setattr(api.subprocess, "run", lambda args, **kw: calls.append(args) or Done())
    app = FastAPI()
    app.include_router(api.router, prefix="/api/plugins/file-actions")
    c = TestClient(app)
    c.calls = calls
    return c


def test_reveal_existing_file(client, tmp_path):
    f = tmp_path / "x.txt"
    f.write_text("x")
    r = client.post("/api/plugins/file-actions/reveal", json={"path": str(f)})
    assert r.status_code == 200 and r.json()["ok"] is True
    assert client.calls == [api.reveal_command(str(f))]


def test_missing_file_is_404_with_stable_code(client):
    r = client.post("/api/plugins/file-actions/reveal", json={"path": "/no/such/thing"})
    assert r.status_code == 404
    assert r.json()["detail"] == api.NOT_FOUND
    assert client.calls == []


def test_relative_path_rejected(client):
    r = client.post("/api/plugins/file-actions/reveal", json={"path": "relative/x"})
    assert r.status_code == 400
    assert r.json()["detail"] == api.BAD_PATH


def test_exists(client, tmp_path):
    r = client.get("/api/plugins/file-actions/exists", params={"path": str(tmp_path)})
    assert r.json() == {"exists": True, "is_dir": True}


@pytest.mark.parametrize("plat,head", [("darwin", ["/usr/bin/open", "-R"]), ("win32", ["explorer.exe"])])
def test_reveal_command_per_platform(plat, head, tmp_path):
    cmd = api.reveal_command(str(tmp_path), platform=plat)
    assert cmd[: len(head)] == head


def test_linux_reveal_opens_parent(monkeypatch, tmp_path):
    f = tmp_path / "x.txt"
    f.write_text("x")
    monkeypatch.setattr(api.shutil, "which", lambda n: "/usr/bin/xdg-open" if n == "xdg-open" else None)
    assert api.reveal_command(str(f), platform="linux") == ["/usr/bin/xdg-open", str(tmp_path)]


def test_info_missing_is_soft(client):
    r = client.get("/api/plugins/file-actions/info", params={"path": "/no/such/x.mp4"})
    assert r.status_code == 200
    assert r.json()["exists"] is False and r.json()["kind"] == "video"


def test_info_existing_file(client, tmp_path):
    f = tmp_path / "notes.md"
    f.write_text("a\nb\n")
    j = client.get("/api/plugins/file-actions/info", params={"path": str(f)}).json()
    assert j["exists"] and j["ext"] == "md" and j["size"] == 4


def test_open_with_refuses_app_the_os_did_not_offer(client, tmp_path, monkeypatch):
    f = tmp_path / "x.txt"
    f.write_text("x")
    monkeypatch.setattr(api.sys, "platform", "darwin")
    monkeypatch.setattr(api, "list_apps", lambda p, limit=8: [{"name": "TextEdit", "path": "/System/Applications/TextEdit.app", "default": True}])
    bad = client.post("/api/plugins/file-actions/open-with", json={"path": str(f), "app": "/bin/sh"})
    assert bad.status_code == 400 and bad.json()["detail"] == api.BAD_APP
    assert client.calls == []
    ok = client.post("/api/plugins/file-actions/open-with", json={"path": str(f), "app": "/System/Applications/TextEdit.app"})
    assert ok.status_code == 200
    assert client.calls[-1] == ["/usr/bin/open", "-a", "/System/Applications/TextEdit.app", str(f)]


def test_reveal_many_rejects_missing(client, tmp_path):
    f = tmp_path / "a.jpg"
    f.write_text("x")
    r = client.post("/api/plugins/file-actions/reveal-many", json={"paths": [str(f), "/no/such.jpg"]})
    assert r.status_code == 404 and client.calls == []


def test_rank_apps_default_first_then_known_tools_and_noise_dropped():
    paths = ["/Applications/QuickTime Player.app", "/Applications/Books.app", "/Applications/VLC.app",
             "/Applications/PhotoSync.app", "/Applications/IINA.app", "/Users/x/Library/Caches/ms-playwright/c.app"]
    out = api.rank_apps(paths, "/Applications/VLC.app", "video")
    names = [a["name"] for a in out]
    assert names[0] == "VLC" and out[0]["default"] is True
    assert names.index("QuickTime Player") < names.index("IINA")
    assert "Books" not in names and "PhotoSync" not in names and "c" not in names


def test_rank_apps_offers_installed_undeclared_pro_tool(monkeypatch):
    resolve = "/Applications/DaVinci Resolve/DaVinci Resolve.app"
    monkeypatch.setattr(api.os.path, "exists", lambda p: p == resolve)
    names = [a["name"] for a in api.rank_apps(["/Applications/QuickTime Player.app"], None, "video")]
    assert names == ["QuickTime Player", "DaVinci Resolve"]
