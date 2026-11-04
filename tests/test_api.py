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
    assert client.calls and str(f) in " ".join(client.calls[0])


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
