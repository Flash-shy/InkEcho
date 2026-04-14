from collections.abc import AsyncGenerator
from pathlib import Path

from sqlalchemy import event, inspect, text
from sqlalchemy.engine.url import make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings
from app.models import Base


def _ensure_sqlite_parent_dir(url_str: str) -> None:
    url = make_url(url_str)
    if not url.drivername.startswith("sqlite"):
        return
    if not url.database or url.database == ":memory:":
        return
    path = Path(url.database)
    if not path.is_absolute():
        path = Path.cwd() / path
    path.resolve().parent.mkdir(parents=True, exist_ok=True)


_ensure_sqlite_parent_dir(settings.database_url_async)

_engine = create_async_engine(
    settings.database_url_async,
    pool_pre_ping=settings.database_url_async.startswith("postgresql"),
)


@event.listens_for(_engine.sync_engine, "connect")
def _sqlite_pragma(dbapi_connection, _connection_record) -> None:
    if _engine.sync_engine.dialect.name != "sqlite":
        return
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.close()


SessionLocal = async_sessionmaker(_engine, class_=AsyncSession, expire_on_commit=False)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with SessionLocal() as session:
        yield session


def _migrate_sessions_summary_columns(sync_conn) -> None:
    insp = inspect(sync_conn)
    if "sessions" not in insp.get_table_names():
        return
    cols = {c["name"] for c in insp.get_columns("sessions")}
    alters: list[str] = []
    if "summary_text" not in cols:
        alters.append("ALTER TABLE sessions ADD COLUMN summary_text TEXT")
    if "summary_error" not in cols:
        alters.append("ALTER TABLE sessions ADD COLUMN summary_error TEXT")
    if "summary_status" not in cols:
        alters.append("ALTER TABLE sessions ADD COLUMN summary_status VARCHAR(32) DEFAULT 'idle'")
    if "minutes_text" not in cols:
        alters.append("ALTER TABLE sessions ADD COLUMN minutes_text TEXT")
    if "minutes_error" not in cols:
        alters.append("ALTER TABLE sessions ADD COLUMN minutes_error TEXT")
    if "minutes_status" not in cols:
        alters.append("ALTER TABLE sessions ADD COLUMN minutes_status VARCHAR(32) DEFAULT 'idle'")
    for stmt in alters:
        sync_conn.execute(text(stmt))


async def init_db() -> None:
    _ensure_sqlite_parent_dir(settings.database_url_async)
    async with _engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_migrate_sessions_summary_columns)
