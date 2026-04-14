from fastapi import FastAPI

from app.transcribe import router as transcribe_router

app = FastAPI(title="InkEcho AI-API", version="0.1.0")
app.include_router(transcribe_router)


@app.get("/health")
def health():
    return {"status": "ok", "service": "ink-echo-ai-api"}
