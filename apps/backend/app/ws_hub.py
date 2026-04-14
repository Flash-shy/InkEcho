import asyncio
from collections import defaultdict

from fastapi import WebSocket


class SessionWsHub:
    """Fan-out JSON messages to browsers subscribed to a session."""

    def __init__(self) -> None:
        self._rooms: dict[str, list[WebSocket]] = defaultdict(list)
        self._lock = asyncio.Lock()

    async def connect(self, session_id: str, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._rooms[session_id].append(ws)

    async def disconnect(self, session_id: str, ws: WebSocket) -> None:
        async with self._lock:
            room = self._rooms.get(session_id)
            if not room:
                return
            try:
                room.remove(ws)
            except ValueError:
                return
            if not room:
                del self._rooms[session_id]

    async def broadcast(self, session_id: str, payload: dict) -> None:
        async with self._lock:
            clients = list(self._rooms.get(session_id, ()))
        for ws in clients:
            try:
                await ws.send_json(payload)
            except Exception:
                await self.disconnect(session_id, ws)
