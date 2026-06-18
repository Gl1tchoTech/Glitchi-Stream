from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_search_no_query():
    response = client.get("/search/")
    assert response.status_code == 422


def test_search_valid():
    response = client.get("/search/?q=Daft Punk&type=artist&limit=3")
    assert response.status_code in (200, 502)  # 502 if no Spotify creds
    if response.status_code == 200:
        data = response.json()
        assert "tracks" in data
        assert "albums" in data
        assert "artists" in data
