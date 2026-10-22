import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from polyprep import model

OK = {"choices": [{"message": {"content": "hi", "reasoning_content": "because"}}], "usage": {"total_tokens": 3}}


@pytest.fixture
def stub():
    """A throwaway HTTP server answering from a script of (status, body) replies, one per request; records the count."""
    replies: list[tuple[int, str]] = []
    hits: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            self.rfile.read(int(self.headers.get("content-length", 0)))
            hits.append(self.path)
            status, body = replies.pop(0)
            data = body.encode()
            self.send_response(status)
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args):
            pass

    httpd = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_port}", replies, hits
    httpd.shutdown()
    httpd.server_close()


def call(server, **kw):
    return model.chat(server, "m", [{"role": "user", "content": "x"}], seed=1, max_tokens=8, reasoning_effort="low", **kw)


def test_a_4xx_fails_at_once_without_retrying(stub, monkeypatch):
    server, replies, hits = stub
    monkeypatch.setattr(model.time, "sleep", lambda s: None)
    replies.append((404, "no such route"))
    with pytest.raises(RuntimeError, match="model server answered 404: no such route"):
        call(server, retries=3)
    assert len(hits) == 1


def test_a_5xx_is_retried(stub, monkeypatch):
    server, replies, hits = stub
    monkeypatch.setattr(model.time, "sleep", lambda s: None)
    replies += [(500, "boom"), (200, json.dumps(OK))]
    assert call(server, retries=1) == {"finish_reason": None, "content": "hi", "reasoning": "because", "usage": {"total_tokens": 3}}
    assert len(hits) == 2


def test_a_reply_that_is_not_json_is_a_malformed_reply_error(stub):
    server, replies, hits = stub
    replies.append((200, "not json"))
    with pytest.raises(RuntimeError, match="malformed reply: not json"):
        call(server, retries=3)
    assert len(hits) == 1


def test_a_reply_without_choices_is_a_malformed_reply_error(stub):
    server, replies, _ = stub
    replies.append((200, "{}"))
    with pytest.raises(RuntimeError, match="malformed reply"):
        call(server)
