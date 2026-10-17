import json
import logging

from app.core.logging import JsonFormatter


def test_sensitive_fields_are_masked():
    rec = logging.LogRecord("t", logging.INFO, "f", 1, "msg", None, None)
    rec.ctx = {"Authorization": "secret-token", "seller": 5}
    out = json.loads(JsonFormatter().format(rec))
    assert out["Authorization"] == "***" and out["seller"] == 5
    assert "secret-token" not in json.dumps(out)
