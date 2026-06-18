from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_download_missing_url():
    response = client.post("/download/", json={})
    assert response.status_code == 422


def test_download_invalid_url():
    response = client.post(
        "/download/",
        json={"url": "https://google.com"},
    )
    assert response.status_code == 422


def test_download_valid_spotify_url():
    response = client.post(
        "/download/",
        json={"url": "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"},
    )
    assert response.status_code == 200
    assert response.json()["message"] == "Download queued successfully"
