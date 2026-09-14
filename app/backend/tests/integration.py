"""Run inside community: python tests/integration.py. No model calls are made."""
import hashlib
import json
import sys
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, "/service")
from src.database import SessionLocal
from src.models import User, WorkspaceFile, PrepState, Note, MigrationReceipt

BASE = "http://127.0.0.1:8001"


def call(path, token=None, data=None, method=None):
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = Request(BASE + path, data=json.dumps(data).encode() if data is not None else None, headers=headers, method=method)
    try:
        with urlopen(req, timeout=30) as response:
            content = response.read()
            return response.status, json.loads(content) if content else None
    except HTTPError as exc:
        return exc.code, exc.read().decode()


assert call("/health")[0] == 200
assert call("/api/workbench/resumes")[0] == 401
assert call("/api/v1/preparation")[0] == 401
assert call("/api/v1/auth/login", data={"email": "root", "password": "incorrect"})[0] == 401
code, auth = call("/api/v1/auth/login", data={"email": "root", "password": "0000"})
assert code == 200, (code, auth)
root_token, root_id = auth["token"], auth["user"]["id"]
assert call("/api/v1/auth/me", root_token)[1]["display_name"] == "root"
report = call("/api/v1/migration-report", root_token)[1]
workspace_report = next(item["report"] for item in report if item["key"] == "local-workspace-v1")
assert workspace_report["verified"]
print("Migration:", json.dumps(workspace_report, ensure_ascii=False))
with SessionLocal() as db:
    files = db.query(WorkspaceFile).filter_by(user_id=root_id).all()
    verified = 0
    for item in files:
        original = Path("/legacy") / item.path
        assert hashlib.sha256(item.content).hexdigest() == item.checksum
        if original.is_file():
            assert original.read_bytes() == item.content, item.path
            verified += 1
    assert verified == workspace_report["files"]
    print("Original-to-MySQL byte verification:", verified, "files")

for kind in ("resumes", "positions", "analyses", "interview"):
    code, result = call("/api/workbench/" + kind, root_token)
    assert code == 200, (kind, code, result)
    key = "interviews" if kind == "interview" else kind
    print("Authenticated workspace:", key, len(result[key]))

email = "integration-" + uuid.uuid4().hex + "@example.com"
test_id = None
try:
    code, auth2 = call("/api/v1/auth/register", data={"email": email, "password": "Integration-test-123", "display_name": "Integration test"})
    assert code == 201, (code, auth2)
    token, test_id = auth2["token"], auth2["user"]["id"]
    assert call("/api/v1/auth/register", data={"email": email, "password": "Integration-test-123", "display_name": "Duplicate"})[0] == 409
    assert call("/api/workbench/resumes", token)[1]["resumes"] == []
    assert call("/api/workbench/positions", token)[1]["positions"] == []
    root_resumes = call("/api/workbench/resumes", root_token)[1]["resumes"]
    assert call("/api/workbench/resumes/" + root_resumes[0]["id"], token)[0] == 404
    assert call("/api/workbench/models/info", token)[0] == 403
    prep = call("/api/v1/preparation", token)[1]
    prep["notes"] = [{"id": "test-note", "title": "Isolation test", "body": "Stored in MySQL", "tag": "test"}]
    assert call("/api/v1/preparation", token, prep, "PUT")[0] == 200
    assert call("/api/v1/preparation", token, prep, "PUT")[0] == 409
    assert call("/api/v1/preparation", token)[1]["notes"][0]["body"] == "Stored in MySQL"
    assert not any(note["id"] == "test-note" for note in call("/api/v1/preparation", root_token)[1]["notes"])
    assert call("/api/v1/preparation/import-local", token, {"saved": [], "notes": [], "tasks": [], "drafts": []})[0] == 403
    created = call("/api/workbench/positions", token, {"name": "Integration", "company_name": "Example", "job_title": "Developer", "job_requirements": "Python"})
    assert created[0] == 200, created
    position_id = created[1]["position"]["id"]
    with SessionLocal() as db:
        record = db.query(WorkspaceFile).filter_by(user_id=test_id, path=f"positions/{position_id}.json").one()
        assert json.loads(record.content)["company_name"] == "Example"
    assert call("/api/workbench/positions/" + position_id, root_token)[0] == 404
    assert call("/api/workbench/positions/" + position_id, token, method="DELETE")[0] == 200
    assert call("/api/v1/auth/logout", token, {})[0] == 200
    assert call("/api/v1/auth/me", token)[0] == 401
    assert call("/api/workbench/resumes", token)[0] == 401
    print("PASS: register/login, ownership isolation, DB writes, revision conflicts, logout revocation")
finally:
    # Delete only the synthetic account and rows created by this test.
    if test_id:
        with SessionLocal() as db:
            for model in (WorkspaceFile, PrepState, Note, MigrationReceipt):
                db.query(model).filter_by(user_id=test_id).delete()
            db.query(User).filter_by(id=test_id, email=email).delete()
            db.commit()
