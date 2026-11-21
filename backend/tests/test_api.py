import os
import tempfile
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

import litellm

os.environ["DATABASE_URL"] = "sqlite:///" + os.path.join(tempfile.mkdtemp(), "t.db")
os.environ["LLM_API_KEYS"] = "k1,k2"
os.environ["ENABLE_FAILURE_SIMULATION"] = "true"

from app.main import create_app  # noqa: E402
from app.config import Settings  # noqa: E402
from app import llm  # noqa: E402

CALLS = []


async def fake_acompletion(model, messages, api_key, caching, **kw):
    """Fake provider honoring LiteLLM-style caching semantics with a tiny dict cache."""
    CALLS.append(api_key)
    key = repr((model, messages))
    if caching and key in fake_acompletion.cache:
        r = fake_acompletion.cache[key]
        r._hidden_params = {"cache_hit": True}
        return r
    text = f"echo:{messages[-1]['content']}"
    r = SimpleNamespace(
        choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
        usage=SimpleNamespace(prompt_tokens=sum(len(m["content"]) for m in messages), completion_tokens=len(text)),
        model=model,
        _hidden_params={},
    )
    fake_acompletion.cache[key] = r
    return r


fake_acompletion.cache = {}


@pytest.fixture()
def client(monkeypatch):
    fake_acompletion.cache.clear()
    CALLS.clear()
    monkeypatch.setattr(llm.litellm, "acompletion", fake_acompletion)
    return TestClient(create_app(Settings()))


def chat(c, sid, msg, **headers):
    return c.post("/chat", json={"session_id": sid, "message": msg}, headers=headers)


def test_health(client):
    assert client.get("/health").json() == {"status": "ok", "keys_configured": 2, "cache_enabled": True}


def test_chat_and_history(client):
    r = chat(client, "a", "hi")
    assert r.status_code == 200
    m = r.json()["metadata"]
    assert m["resolution_source"] == "LIVE_INFERENCE" and m["key_id"] == "key_1" and m["fallback_attempts"] == 0
    chat(client, "a", "again")
    h = client.get("/sessions/a/messages").json()["messages"]
    assert [x["role"] for x in h] == ["user", "assistant", "user", "assistant"]
    assert client.get("/sessions/nope/messages").status_code == 404


def test_cache_hit_same_first_message_new_session(client):
    first = chat(client, "s1", "capital of France?").json()
    second = chat(client, "s2", "capital of France?").json()
    assert second["metadata"]["resolution_source"] == "LLM_CACHE"
    assert second["metadata"]["key_id"] is None and second["metadata"]["fallback_attempts"] == 0
    assert second["reply"] == first["reply"]
    assert chat(client, "s3", "different").json()["metadata"]["resolution_source"] == "LIVE_INFERENCE"


@pytest.mark.parametrize("hdr", ["key_1=429", "key_1=500"])
def test_failover(client, hdr):
    r = chat(client, "f", "hello", **{"X-Simulate-Failure": hdr})
    assert r.status_code == 200
    assert r.json()["metadata"]["key_id"] == "key_2" and r.json()["metadata"]["fallback_attempts"] == 1


def test_all_fail_503_not_stored(client):
    r = chat(client, "g", "hello", **{"X-Simulate-Failure": "*=429"})
    assert r.status_code == 503 and r.json() == {"detail": "all providers unavailable"}
    assert client.get("/sessions/g/messages").status_code == 404


@pytest.mark.parametrize("body", [{}, {"session_id": "", "message": "x"}, {"session_id": "a", "message": "   "},
                                  {"session_id": "a", "message": "x" * 4001}])
def test_validation_422(client, body):
    r = client.post("/chat", json=body)
    assert r.status_code == 422 and "detail" in r.json()


def test_malformed_json_422(client):
    r = client.post("/chat", content="{bad", headers={"content-type": "application/json"})
    assert r.status_code == 422
