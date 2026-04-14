from fastapi import FastAPI

app = FastAPI(title="InkEcho AI-API", version="0.1.0")


@app.get("/health")
def health():
    return {"status": "ok", "service": "ink-echo-ai-api"}
