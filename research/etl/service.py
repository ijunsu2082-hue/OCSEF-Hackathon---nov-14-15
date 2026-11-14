"""Refresh configured locations and stream report changes through Redis."""

import asyncio
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field
from redis.asyncio import Redis

LOGGER = logging.getLogger("uvicorn.error")
PUBLISH_CHANGED = """
local previous = redis.call('GET', KEYS[1])
if previous == ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('PUBLISH', KEYS[1], ARGV[1])
return 1
"""


class Location(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    radius: float = Field(default=100, ge=1, le=500)
    respondent: str | None = Field(default=None, pattern=r"^[A-Z0-9]{2,8}$")


async def etl(*arguments: str):
    process = await asyncio.create_subprocess_exec(
        "node", "node_modules/tsx/dist/cli.mjs", "research/etl/cli.ts", *arguments,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), 120)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    if process.returncode:
        raise RuntimeError(stderr.decode(errors="replace").strip()[:1000])
    return stdout, stderr


async def refresh(redis: Redis, location: Location):
    arguments = [
        "collect", "--lat", str(location.lat), "--lon", str(location.lon),
        "--radius", str(location.radius),
    ]
    if location.respondent:
        arguments += ["--respondent", location.respondent]
    stdout, stderr = await etl(*arguments)
    report = json.loads(stdout)
    location_id = report["evidence"]["region"]["id"]
    event = json.dumps({
        "event": "STATE_UPDATE",
        "location_id": location_id,
        "state_hash": report["state_hash"],
    }, separators=(",", ":"))
    await redis.eval(PUBLISH_CHANGED, 1, f"location-report:{location_id}", event)
    backup_root = os.environ.get("ETL_BACKUP_DIRECTORY")
    if backup_root:
        revision = json.loads(stderr.decode().strip().splitlines()[-1])["revision"]
        destination = Path(backup_root) / location_id / f"{revision}.json"
        if not destination.is_file():
            await etl("backup", location_id, revision, str(destination))


async def worker(redis: Redis, locations: list[Location]):
    # One scheduled writer. Multiple WebSocket processes can share Redis.
    while True:
        for location in locations:
            try:
                await refresh(redis, location)
            except Exception:
                LOGGER.exception("Location refresh failed")
        await asyncio.sleep(60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    redis = Redis.from_url(os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0"), decode_responses=True)
    raw_locations = json.loads(os.environ.get("ETL_LOCATIONS", "[]"))
    if not isinstance(raw_locations, list):
        raise ValueError("ETL_LOCATIONS must be a JSON array")
    locations = [Location.model_validate(item) for item in raw_locations]
    app.state.redis = redis
    task = asyncio.create_task(worker(redis, locations)) if locations else None
    try:
        yield
    finally:
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await redis.aclose()


app = FastAPI(lifespan=lifespan)


@app.websocket("/ws/location/{location_id}")
async def stream(websocket: WebSocket, location_id: str):
    origin = websocket.headers.get("origin")
    allowed = os.environ.get("ETL_BROWSER_ORIGINS", "http://localhost:3000,http://localhost:3700").split(",")
    if not re.fullmatch(r"location-[a-f0-9]{24}", location_id) or (origin and origin not in allowed):
        await websocket.close(code=1008)
        return
    await websocket.accept()
    redis: Redis = websocket.app.state.redis
    channel = f"location-report:{location_id}"

    async def send_updates():
        async with redis.pubsub() as subscription:
            await subscription.subscribe(channel)
            # Consume the subscription acknowledgment before reading saved state.
            await subscription.get_message(timeout=5)
            initial = await redis.get(channel)
            if initial:
                await websocket.send_text(initial)
            async for event in subscription.listen():
                if event["type"] == "message":
                    await websocket.send_text(event["data"])

    async def watch_disconnect():
        while True:
            await websocket.receive_text()

    tasks = [asyncio.create_task(send_updates()), asyncio.create_task(watch_disconnect())]
    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()
    except WebSocketDisconnect:
        pass
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
