"""Refresh configured locations and stream report changes through Redis."""

import asyncio
import json
import logging
import os
import re
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field, model_validator
from redis.asyncio import Redis

LOGGER = logging.getLogger("uvicorn.error")
PUBLISH_CHANGED = """
local previous = redis.call('GET', KEYS[1])
if previous == ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[1])
redis.call('PUBLISH', KEYS[2], ARGV[1])
return 1
"""
RESULT_SENTINEL = "@@GRIDSENTINEL_RESULT@@"


class Location(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    radius: float = Field(default=100, ge=1, le=500)
    respondent: str | None = Field(default=None, pattern=r"^[A-Z0-9]{2,8}$")
    caiso: bool = False
    # CAISO OASIS pricing node; same rule as research/etl/oasis.ts OASIS_NODE.
    oasis_node: str | None = Field(default=None, pattern=r"^[A-Z0-9_\-.]{3,64}$")


async def etl(*arguments: str, timeout: int = 120):
    process = await asyncio.create_subprocess_exec(
        "node", "node_modules/tsx/dist/cli.mjs", "research/etl/cli.ts", *arguments,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
    if process.returncode:
        raise RuntimeError(stderr.decode(errors="replace").strip()[:1000])
    return stdout, stderr


def collect_result(stderr: bytes) -> dict:
    """Return the collect result object from stderr, ignoring unrelated lines.

    Prefers the last sentinel-prefixed line; falls back to the last line that is a
    JSON object carrying a string "revision" (output of older CLI builds).
    """
    lines = [line.strip() for line in stderr.decode(errors="replace").splitlines()]
    for line in reversed(lines):
        if line.startswith(RESULT_SENTINEL):
            try:
                value = json.loads(line[len(RESULT_SENTINEL):])
            except ValueError:
                continue
            if isinstance(value, dict) and isinstance(value.get("revision"), str):
                return value
    for line in reversed(lines):
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict) and isinstance(value.get("revision"), str):
            return value
    raise RuntimeError("Collection stderr carried no result line with a revision")


async def refresh(redis: Redis, location: Location):
    arguments = [
        "collect", "--lat", str(location.lat), "--lon", str(location.lon),
        "--radius", str(location.radius),
    ]
    if location.respondent:
        arguments += ["--respondent", location.respondent]
    if location.caiso:
        arguments.append("--caiso")
    if location.oasis_node:
        arguments += ["--oasis-node", location.oasis_node]
    stdout, stderr = await etl(*arguments)
    report = json.loads(stdout)
    location_id = report["evidence"]["region"]["id"]
    event = json.dumps({
        "event": "STATE_UPDATE",
        "location_id": location_id,
        "state_hash": report["state_hash"],
    }, separators=(",", ":"))
    await redis.eval(
        PUBLISH_CHANGED, 2,
        f"location-report:state:{location_id}", f"location-report:{location_id}", event,
    )
    backup_root = os.environ.get("ETL_BACKUP_DIRECTORY")
    if backup_root:
        revision = collect_result(stderr)["revision"]
        destination = Path(backup_root) / location_id / f"{revision}.json"
        if not destination.is_file():
            await etl("backup", location_id, revision, str(destination))


def telemetry_interval(location: Location, override: float | None = None) -> float:
    # Match the fastest source cadence: CAISO telemetry and OASIS RTM intervals
    # are 5-minute, NWS observations 10-minute.
    if override is not None:
        return override
    return 300 if location.caiso or location.oasis_node else 600


async def telemetry_worker(redis: Redis, location: Location, interval: float, semaphore: asyncio.Semaphore):
    # One task per location on a fixed-rate tick; the CLI's per-feed freshness reuse still applies.
    loop = asyncio.get_running_loop()
    start = loop.time()
    tick = 0
    running: asyncio.Task | None = None

    async def run_once():
        try:
            async with semaphore:
                await refresh(redis, location)
        except asyncio.CancelledError:
            raise
        except Exception:
            LOGGER.exception("Location refresh failed for %s,%s; retrying next tick", location.lat, location.lon)

    try:
        while True:
            if running is not None and not running.done():
                LOGGER.warning("Location refresh for %s,%s still running after %ss; skipping tick",
                               location.lat, location.lon, interval)
            else:
                running = asyncio.create_task(run_once())
            # Next tick stays on start + k*interval; ticks already missed are skipped, not replayed.
            tick = max(tick + 1, int((loop.time() - start) // interval) + 1)
            await asyncio.sleep(max(0.0, start + tick * interval - loop.time()))
    finally:
        if running is not None and not running.done():
            running.cancel()
            await asyncio.gather(running, return_exceptions=True)


class AssetLocation(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    radius: float = Field(default=100, ge=1, le=500)
    sources: list[Literal["eia-atlas-plants", "hifld-substations", "hifld-transmission"]] = Field(default_factory=lambda: [
        "eia-atlas-plants", "hifld-substations", "hifld-transmission",
    ], min_length=1)

    @model_validator(mode="after")
    def unique_sources(self):
        if len(set(self.sources)) != len(self.sources):
            raise ValueError("Asset sources must be unique per location")
        return self


async def refresh_assets(redis: Redis, location: AssetLocation):
    manifests = []
    for source in location.sources:
        result, _ = await etl(
            "assets", source, str(location.lat), str(location.lon), str(location.radius),
            timeout=1800,
        )
        manifest = json.loads(result)
        path = manifest.get("path")
        if not isinstance(path, str) or not path:
            raise RuntimeError(f"Asset collection returned no manifest path for {source}")
        manifests.append(path)
    result, _ = await etl("load-assets", *manifests, timeout=1800)
    loaded = json.loads(result)
    location_id = loaded.get("location")
    revision = loaded.get("revision")
    if not isinstance(location_id, str) or not re.fullmatch(r"location-[a-f0-9]{24}", location_id):
        raise RuntimeError("Asset loading returned an invalid location id")
    if not isinstance(revision, str) or not re.fullmatch(r"[a-f0-9]{64}", revision):
        raise RuntimeError("Asset loading returned an invalid inventory revision")
    event = json.dumps({
        "event": "INVENTORY_UPDATE",
        "location_id": location_id,
        "inventory_revision": revision,
    }, separators=(",", ":"))
    await redis.eval(
        PUBLISH_CHANGED, 2,
        f"location-report:inventory:{location_id}", f"location-report:{location_id}", event,
    )
    backup_root = os.environ.get("ETL_BACKUP_DIRECTORY")
    if backup_root:
        # backup-assets writes exactly this path; an existing file means this revision is archived.
        destination = Path(backup_root) / location_id / "assets" / f"{revision}.json"
        if not destination.is_file():
            await etl("backup-assets", location_id, revision, str(destination), timeout=1800)


async def asset_worker(redis: Redis, location: AssetLocation, interval: int, retry_delay: int, semaphore: asyncio.Semaphore):
    # Inventory calls can be slow; keep them outside telemetry's refresh loop.
    while True:
        try:
            async with semaphore:
                await refresh_assets(redis, location)
        except asyncio.CancelledError:
            raise
        except Exception:
            LOGGER.exception("Asset inventory refresh failed")
            await asyncio.sleep(retry_delay)
        else:
            await asyncio.sleep(interval)


@asynccontextmanager
async def lifespan(app: FastAPI):
    redis = Redis.from_url(os.environ.get("REDIS_URL", "redis://127.0.0.1:6379/0"), decode_responses=True)
    raw_locations = json.loads(os.environ.get("ETL_LOCATIONS", "[]"))
    if not isinstance(raw_locations, list):
        raise ValueError("ETL_LOCATIONS must be a JSON array")
    locations = [Location.model_validate(item) for item in raw_locations]
    raw_asset_locations = json.loads(os.environ.get("ETL_ASSET_LOCATIONS", "[]"))
    if not isinstance(raw_asset_locations, list):
        raise ValueError("ETL_ASSET_LOCATIONS must be a JSON array")
    asset_locations = [AssetLocation.model_validate(item) for item in raw_asset_locations]
    asset_interval = int(os.environ.get("ETL_ASSET_REFRESH_SECONDS", "86400"))
    asset_retry = int(os.environ.get("ETL_ASSET_RETRY_SECONDS", "60"))
    asset_concurrency = int(os.environ.get("ETL_ASSET_CONCURRENCY", "2"))
    if asset_interval < 1 or asset_retry < 1 or asset_concurrency < 1:
        raise ValueError("Asset refresh, retry, and concurrency settings must be positive")
    asset_scopes = [(location.lat, location.lon, location.radius) for location in asset_locations]
    if len(set(asset_scopes)) != len(asset_scopes):
        raise ValueError("ETL_ASSET_LOCATIONS must not repeat coordinate/radius scopes")
    telemetry_concurrency = int(os.environ.get("ETL_TELEMETRY_CONCURRENCY", "4"))
    raw_telemetry_interval = os.environ.get("ETL_TELEMETRY_INTERVAL_SECONDS")
    telemetry_override = int(raw_telemetry_interval) if raw_telemetry_interval else None
    if telemetry_concurrency < 1 or (telemetry_override is not None and telemetry_override < 1):
        raise ValueError("Telemetry interval and concurrency settings must be positive")
    app.state.redis = redis
    tasks = []
    telemetry_semaphore = asyncio.Semaphore(telemetry_concurrency)
    tasks.extend(asyncio.create_task(telemetry_worker(
        redis, location, telemetry_interval(location, telemetry_override), telemetry_semaphore,
    )) for location in locations)
    asset_semaphore = asyncio.Semaphore(asset_concurrency)
    tasks.extend(asyncio.create_task(asset_worker(redis, location, asset_interval, asset_retry, asset_semaphore))
                  for location in asset_locations)
    try:
        yield
    finally:
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
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
            latest_state = await redis.get(f"location-report:state:{location_id}")
            latest_inventory = await redis.get(f"location-report:inventory:{location_id}")
            for initial in (latest_state, latest_inventory):
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
