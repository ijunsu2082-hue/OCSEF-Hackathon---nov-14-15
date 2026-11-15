"""Service tests with `etl` and Redis replaced; no node process or Redis server is needed.

Run: pip install -r research/etl/requirements-dev.txt && pytest research/etl/test_service.py
"""

import asyncio
import json
import logging
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import service  # noqa: E402

LOCATION_ID = "location-" + "a" * 24
REVISION = "b" * 64
REPORT = json.dumps({"evidence": {"region": {"id": LOCATION_ID}}, "state_hash": "c" * 64}).encode()


class FakeRedis:
    def __init__(self):
        self.calls = []

    async def eval(self, *arguments):
        self.calls.append(arguments)
        return 1


def sentinel(value):
    return f"{service.RESULT_SENTINEL} {json.dumps(value)}"


# (a) revision recovery


def test_sentinel_line_wins_over_surrounding_junk():
    stderr = "\n".join([
        "(node:123) ExperimentalWarning: something",
        '{"revision": "' + "0" * 64 + '"}',
        sentinel({"location": LOCATION_ID, "revision": REVISION}),
        "retrying https://example.test after 300ms",
        "",
    ]).encode()
    assert service.collect_result(stderr)["revision"] == REVISION


def test_last_sentinel_line_is_used():
    stderr = "\n".join([
        sentinel({"location": LOCATION_ID, "revision": "1" * 64}),
        sentinel({"location": LOCATION_ID, "revision": REVISION}),
        "trailing warning",
    ]).encode()
    assert service.collect_result(stderr)["revision"] == REVISION


def test_legacy_last_line_json_still_parses():
    stderr = json.dumps({"location": LOCATION_ID, "revision": REVISION}).encode() + b"\n"
    assert service.collect_result(stderr)["revision"] == REVISION


def test_legacy_json_found_behind_trailing_junk():
    stderr = ("warning one\n" + json.dumps({"location": LOCATION_ID, "revision": REVISION})
              + "\n[1, 2]\n{\"other\": true}\nnot json\n").encode()
    assert service.collect_result(stderr)["revision"] == REVISION


def test_no_result_raises_clear_error():
    with pytest.raises(RuntimeError, match="no result line with a revision"):
        service.collect_result(b"warning\n{\"location\": \"x\"}\n" + service.RESULT_SENTINEL.encode() + b" not-json\n")
    with pytest.raises(RuntimeError, match="no result line with a revision"):
        service.collect_result(b"")


def test_refresh_backs_up_revision_from_noisy_stderr(monkeypatch, tmp_path):
    calls = []

    async def fake_etl(*arguments, timeout=120):
        calls.append(arguments)
        if arguments[0] == "collect":
            noisy = "\n".join(["(node) Warning: x", sentinel({"location": LOCATION_ID, "revision": REVISION}), "retry notice"])
            return REPORT, noisy.encode()
        return b"{}", b""

    monkeypatch.setattr(service, "etl", fake_etl)
    monkeypatch.setenv("ETL_BACKUP_DIRECTORY", str(tmp_path))
    asyncio.run(service.refresh(FakeRedis(), service.Location(lat=33.75, lon=-118.0)))
    assert calls[1] == ("backup", LOCATION_ID, REVISION, str(tmp_path / LOCATION_ID / f"{REVISION}.json"))


# (b) CAISO flag


def collect_arguments(monkeypatch, location):
    calls = []

    async def fake_etl(*arguments, timeout=120):
        calls.append(arguments)
        return REPORT, b""

    monkeypatch.setattr(service, "etl", fake_etl)
    monkeypatch.delenv("ETL_BACKUP_DIRECTORY", raising=False)
    asyncio.run(service.refresh(FakeRedis(), location))
    return calls[0]


def test_caiso_flag_appended_when_enabled(monkeypatch):
    arguments = collect_arguments(monkeypatch, service.Location(lat=33.75, lon=-118.0, respondent="CISO", caiso=True))
    assert arguments[0] == "collect"
    assert arguments[-1] == "--caiso"
    assert arguments.count("--caiso") == 1
    assert ("--respondent", "CISO") == arguments[arguments.index("--respondent"):arguments.index("--respondent") + 2]


def test_caiso_flag_absent_by_default(monkeypatch):
    arguments = collect_arguments(monkeypatch, service.Location(lat=33.75, lon=-118.0))
    assert "--caiso" not in arguments


def test_oasis_node_flag_passed_when_set(monkeypatch):
    arguments = collect_arguments(monkeypatch, service.Location(lat=33.75, lon=-118.0, oasis_node="TH_SP15_GEN-APND"))
    assert arguments.count("--oasis-node") == 1
    assert arguments[arguments.index("--oasis-node") + 1] == "TH_SP15_GEN-APND"
    assert "--caiso" not in arguments


def test_oasis_node_flag_absent_by_default(monkeypatch):
    arguments = collect_arguments(monkeypatch, service.Location(lat=33.75, lon=-118.0, caiso=True))
    assert "--oasis-node" not in arguments


@pytest.mark.parametrize("node", ["", "ab", "th_sp15", "NODE&market_run_id=DAM", "A" * 65, "NODE ID", "--caiso", "NODE\n"])
def test_oasis_node_is_validated(node):
    with pytest.raises(ValueError):
        service.Location(lat=0, lon=0, oasis_node=node)


def test_oasis_node_accepts_published_node_shapes():
    for node in ["TH_SP15_GEN-APND", "ABC", "A.B-C_1", "A" * 64]:
        assert service.Location(lat=0, lon=0, oasis_node=node).oasis_node == node


def test_oasis_node_cadence_is_five_minutes():
    assert service.telemetry_interval(service.Location(lat=0, lon=0, oasis_node="TH_SP15_GEN-APND")) == 300
    assert service.telemetry_interval(service.Location(lat=0, lon=0, oasis_node="TH_SP15_GEN-APND"), 42) == 42


def test_telemetry_interval_rules():
    assert service.telemetry_interval(service.Location(lat=0, lon=0, caiso=True)) == 300
    assert service.telemetry_interval(service.Location(lat=0, lon=0)) == 600
    assert service.telemetry_interval(service.Location(lat=0, lon=0, caiso=True), 42) == 42


# (c) scheduler


async def run_workers(locations, interval, concurrency, duration):
    semaphore = asyncio.Semaphore(concurrency)
    tasks = [asyncio.create_task(service.telemetry_worker(FakeRedis(), location, interval, semaphore))
             for location in locations]
    await asyncio.sleep(duration)
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


def test_slow_location_does_not_delay_others_and_never_overlaps(monkeypatch, caplog):
    slow, fast = service.Location(lat=1, lon=1), service.Location(lat=2, lon=2)
    starts = {slow.lat: [], fast.lat: []}
    active = {slow.lat: 0, fast.lat: 0}
    peak = {slow.lat: 0, fast.lat: 0}

    async def fake_refresh(redis, location):
        starts[location.lat].append(time.monotonic())
        active[location.lat] += 1
        peak[location.lat] = max(peak[location.lat], active[location.lat])
        try:
            await asyncio.sleep(0.32 if location.lat == slow.lat else 0.005)
        finally:
            active[location.lat] -= 1

    monkeypatch.setattr(service, "refresh", fake_refresh)
    with caplog.at_level(logging.WARNING, logger=service.LOGGER.name):
        asyncio.run(run_workers([slow, fast], 0.05, 4, 0.52))

    fast_starts = starts[fast.lat]
    gaps = [later - earlier for earlier, later in zip(fast_starts, fast_starts[1:])]
    # 0.52 s at 0.05 s cadence is 11 ticks; allow scheduler jitter but no 0.3 s stall.
    assert len(fast_starts) >= 9, fast_starts
    assert max(gaps) < 0.1, gaps
    # Slow run spans 6.4 intervals: it starts at t=0 and next at the t=0.35 tick only.
    assert len(starts[slow.lat]) == 2, starts[slow.lat]
    assert peak[slow.lat] == 1
    assert any("skipping tick" in record.getMessage() for record in caplog.records)


def test_concurrency_cap_is_shared_across_locations(monkeypatch):
    locations = [service.Location(lat=index, lon=index) for index in range(5)]
    state = {"active": 0, "peak": 0, "runs": 0}

    async def fake_refresh(redis, location):
        state["active"] += 1
        state["runs"] += 1
        state["peak"] = max(state["peak"], state["active"])
        try:
            await asyncio.sleep(0.08)
        finally:
            state["active"] -= 1

    monkeypatch.setattr(service, "refresh", fake_refresh)
    asyncio.run(run_workers(locations, 0.05, 2, 0.4))
    assert state["peak"] == 2
    assert state["runs"] >= 6


def test_missed_ticks_are_skipped_without_catch_up_burst(monkeypatch):
    location = service.Location(lat=3, lon=3)
    starts = []

    async def fake_refresh(redis, location):
        starts.append(time.monotonic())
        if len(starts) == 1:
            time.sleep(0.22)  # blocks the event loop, so several ticks pass unserved

    monkeypatch.setattr(service, "refresh", fake_refresh)
    asyncio.run(run_workers([location], 0.05, 1, 0.5))
    stall_end = starts[0] + 0.22
    # A catch-up scheduler would fire the ~4 missed ticks back to back here. This one runs
    # the late tick once, then realigns to start + k*interval.
    after_stall = [start for start in starts if stall_end <= start < stall_end + 0.05]
    assert len(after_stall) <= 2, starts
    offsets = [(start - starts[0]) / 0.05 for start in starts[2:]]
    assert all(abs(offset - round(offset)) < 0.3 for offset in offsets), offsets
    assert len(starts) <= 9, starts


def test_failed_refresh_is_logged_and_retried_next_tick(monkeypatch, caplog):
    location = service.Location(lat=4, lon=4)
    calls = []

    async def failing_refresh(redis, location):
        calls.append(time.monotonic())
        raise RuntimeError("feed down")

    monkeypatch.setattr(service, "refresh", failing_refresh)
    with caplog.at_level(logging.ERROR, logger=service.LOGGER.name):
        asyncio.run(run_workers([location], 0.05, 1, 0.22))
    assert len(calls) >= 4
    assert any("retrying next tick" in record.getMessage() for record in caplog.records)


def test_cancel_stops_in_flight_refresh(monkeypatch):
    cancelled = []

    async def hanging_refresh(redis, location):
        try:
            await asyncio.sleep(10)
        except asyncio.CancelledError:
            cancelled.append(True)
            raise

    monkeypatch.setattr(service, "refresh", hanging_refresh)
    asyncio.run(run_workers([service.Location(lat=5, lon=5)], 0.05, 1, 0.1))
    assert cancelled == [True]


# Scheduled asset backups


def test_asset_backup_after_publish_and_skipped_when_present(monkeypatch, tmp_path):
    calls = []

    async def fake_etl(*arguments, timeout=120):
        calls.append(arguments)
        if arguments[0] == "assets":
            return json.dumps({"path": f"/state/{arguments[1]}/manifest.json"}).encode(), b""
        if arguments[0] == "load-assets":
            return json.dumps({"location": LOCATION_ID, "revision": REVISION}).encode(), b""
        if arguments[0] == "backup-assets":
            Path(arguments[3]).parent.mkdir(parents=True, exist_ok=True)
            Path(arguments[3]).write_text("{}")
        return b"{}", b""

    monkeypatch.setattr(service, "etl", fake_etl)
    monkeypatch.setenv("ETL_BACKUP_DIRECTORY", str(tmp_path))
    location = service.AssetLocation(lat=33.75, lon=-118.0, sources=["hifld-substations"])
    redis = FakeRedis()
    asyncio.run(service.refresh_assets(redis, location))
    destination = tmp_path / LOCATION_ID / "assets" / f"{REVISION}.json"
    assert calls[-1] == ("backup-assets", LOCATION_ID, REVISION, str(destination))
    assert len(redis.calls) == 1

    calls.clear()
    asyncio.run(service.refresh_assets(redis, location))
    assert [call[0] for call in calls] == ["assets", "load-assets"]


def test_asset_backup_off_without_directory(monkeypatch):
    calls = []

    async def fake_etl(*arguments, timeout=120):
        calls.append(arguments)
        if arguments[0] == "assets":
            return json.dumps({"path": "/state/manifest.json"}).encode(), b""
        return json.dumps({"location": LOCATION_ID, "revision": REVISION}).encode(), b""

    monkeypatch.setattr(service, "etl", fake_etl)
    monkeypatch.delenv("ETL_BACKUP_DIRECTORY", raising=False)
    asyncio.run(service.refresh_assets(FakeRedis(), service.AssetLocation(lat=1, lon=1, sources=["hifld-substations"])))
    assert [call[0] for call in calls] == ["assets", "load-assets"]


# Settings validation


@pytest.mark.parametrize("name,value", [
    ("ETL_TELEMETRY_CONCURRENCY", "0"),
    ("ETL_TELEMETRY_INTERVAL_SECONDS", "0"),
    ("ETL_TELEMETRY_INTERVAL_SECONDS", "-5"),
])
def test_lifespan_rejects_non_positive_telemetry_settings(monkeypatch, name, value):
    monkeypatch.setenv(name, value)

    async def enter():
        async with service.lifespan(service.app):
            pass

    with pytest.raises(ValueError, match="Telemetry interval and concurrency"):
        asyncio.run(enter())
