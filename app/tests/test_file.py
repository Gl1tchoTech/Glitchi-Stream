from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_list_files_empty():
    response = client.get("/files/")
    assert response.status_code == 200
    assert "files" in response.json()


def test_stream_missing_file():
    response = client.get("/files/stream?filename=nonexistent.flac")
    assert response.status_code == 404
