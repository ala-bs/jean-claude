#!/usr/bin/env python3
import asyncio
import json
import logging
import sys

from idb.common.types import HIDDirection, HIDKey, HIDPress, HIDTouch, Point
from idb.grpc.management import ClientManager


def event_from_payload(payload):
    event_type = payload.get("type")
    direction = (
        HIDDirection.UP
        if event_type == "touchUp" or event_type == "keyUp"
        else HIDDirection.DOWN
    )
    if event_type == "keyDown" or event_type == "keyUp":
        return HIDPress(
            action=HIDKey(keycode=int(payload["keycode"])),
            direction=direction,
        )
    return HIDPress(
        action=HIDTouch(point=Point(x=float(payload["x"]), y=float(payload["y"]))),
        direction=direction,
    )


async def main():
    if len(sys.argv) < 2:
        print("Usage: mobile-preview-ios-hid-helper.py <device-udid>", file=sys.stderr)
        return 64

    udid = sys.argv[1]
    queue = asyncio.Queue()
    loop = asyncio.get_running_loop()

    async def read_stdin():
        while True:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                await queue.put(None)
                return
            try:
                await queue.put(event_from_payload(json.loads(line)))
            except Exception as error:
                print(f"Invalid HID event: {error}", file=sys.stderr, flush=True)

    async def events():
        while True:
            event = await queue.get()
            if event is None:
                return
            yield event

    async with ClientManager(logger=logging.getLogger("jc-ios-hid")).from_udid(
        udid=udid
    ) as client:
        print("READY", flush=True)
        hid_task = asyncio.create_task(client.hid(events()))
        await read_stdin()
        await hid_task

    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
