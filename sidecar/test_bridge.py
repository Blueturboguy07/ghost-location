"""Protocol behavior tests; all USB and location calls are replaced, no phone access."""
import asyncio
from contextlib import AsyncExitStack
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import ios_bridge as bridge_module


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    def connected_bridge(self, **kwargs):
        bridge = bridge_module.Bridge(**kwargs)
        disconnected = asyncio.Event()
        session = {"udid": "phone", "stack": AsyncExitStack(), "active": False, "valid": True,
                   "dvt": SimpleNamespace(dtx=SimpleNamespace(_closed=False, wait_disconnected=disconnected.wait)),
                   "location": SimpleNamespace(set=AsyncMock(), clear=AsyncMock()), "target": None}
        bridge.session = session
        bridge.connect = AsyncMock(return_value=session)
        self.addAsyncCleanup(bridge.close_session, False)
        return bridge, session, disconnected

    async def test_factory_forces_usb_exact_udid_and_no_autopair(self):
        lockdown = SimpleNamespace(paired=True, close=AsyncMock())
        with patch.object(bridge_module, "create_using_usbmux", new=AsyncMock(return_value=lockdown)) as create:
            with patch.object(bridge_module.CoreDeviceTunnelProxy, "create", new=AsyncMock(return_value="proxy")):
                result = await bridge_module.strict_usb_provider("00008030-0000000000000001", True, True)
        self.assertEqual(result, ("proxy", lockdown))
        self.assertEqual(create.await_args.kwargs["connection_type"], "USB")
        self.assertEqual(create.await_args.kwargs["serial"], "00008030-0000000000000001")
        self.assertFalse(create.await_args.kwargs["autopair"])

    async def test_set_does_not_ack_before_device_reply(self):
        bridge, session, _ = self.connected_bridge()
        reply = asyncio.Event()
        async def set_location(_lat, _lon):
            await reply.wait()
        session["location"].set = set_location
        task = asyncio.create_task(bridge.dispatch("set", {"udid": "phone", "latitude": 1, "longitude": 2}))
        await asyncio.sleep(0)
        self.assertFalse(task.done())
        self.assertFalse(session["active"])
        reply.set()
        self.assertEqual((await task)["applied"], True)
        self.assertTrue(session["active"])

    async def test_set_error_closes_session_and_reports_unknown(self):
        bridge = bridge_module.Bridge()
        closed = []
        stack = AsyncExitStack()
        stack.callback(lambda: closed.append(True))
        session = {"udid": "phone", "stack": stack, "active": False,
                   "location": SimpleNamespace(set=AsyncMock(side_effect=ConnectionError("USB lost")))}
        bridge.session = session
        bridge.connect = AsyncMock(return_value=session)
        with patch.object(bridge_module, "emit") as emit:
            with self.assertRaises(ConnectionError):
                await bridge.dispatch("set", {"udid": "phone", "latitude": 1, "longitude": 2})
        self.assertIsNone(bridge.session)
        self.assertEqual(closed, [True])
        self.assertEqual(emit.call_args.args[0]["event"], "session-ended")

    async def test_shutdown_clears_before_closing(self):
        bridge = bridge_module.Bridge()
        calls = []
        async def clear():
            calls.append("clear")
        stack = AsyncExitStack()
        stack.callback(lambda: calls.append("close"))
        bridge.session = {"udid": "phone", "stack": stack, "active": True,
                          "location": SimpleNamespace(clear=clear)}
        await bridge.dispatch("shutdown", {})
        self.assertEqual(calls, ["clear", "close"])

    async def test_shutdown_without_restore_only_closes_transport(self):
        bridge = bridge_module.Bridge()
        calls = []
        async def clear():
            calls.append("clear")
        stack = AsyncExitStack()
        stack.callback(lambda: calls.append("close"))
        bridge.session = {"udid": "phone", "stack": stack, "active": True,
                          "location": SimpleNamespace(clear=clear)}
        await bridge.dispatch("shutdown", {"restore": False})
        self.assertEqual(calls, ["close"])
        # EOF's final best-effort cleanup cannot clear the already-closed session.
        await bridge.close_session(clear=True)
        self.assertEqual(calls, ["close"])

    async def test_invalid_coordinates_do_not_connect(self):
        bridge = bridge_module.Bridge()
        bridge.connect = AsyncMock()
        for latitude in [True, float("nan"), 100, "1"]:
            with self.assertRaises(ValueError):
                await bridge.dispatch("set", {"udid": "phone", "latitude": latitude, "longitude": 0})
        bridge.connect.assert_not_awaited()

    async def test_discovery_excludes_network_devices_before_opening(self):
        bridge = bridge_module.Bridge()
        with patch.object(bridge_module.usbmux, "list_devices", new=AsyncMock(return_value=[
            SimpleNamespace(serial="network-phone", connection_type="Network")])):
            with patch.object(bridge_module, "usb_lockdown", new=AsyncMock()) as connect:
                self.assertEqual(await bridge.discover(), [])
                connect.assert_not_awaited()

    async def test_periodic_refresh_acknowledges_only_after_reply(self):
        bridge, session, _ = self.connected_bridge(refresh_interval=0.01)
        started, reply = asyncio.Event(), asyncio.Event()
        calls = []
        async def set_location(lat, lon):
            calls.append((lat, lon))
            if len(calls) == 2:
                started.set()
                await reply.wait()
        session["location"].set = set_location
        with patch.object(bridge_module, "emit") as emit:
            initial = await bridge.dispatch("set", {"udid": "phone", "latitude": 1, "longitude": 2, "sessionId": "intent-1"})
            self.assertEqual(initial["refreshCount"], 1)
            await asyncio.wait_for(started.wait(), 0.5)
            emit.assert_not_called()
            reply.set()
            for _ in range(100):
                if emit.called:
                    break
                await asyncio.sleep(0.001)
            event = emit.call_args.args[0]
            self.assertEqual(event["event"], "location-refreshed")
            self.assertEqual(event["sessionId"], "intent-1")
            self.assertEqual(event["refreshCount"], 2)
            self.assertTrue(event["refreshedAt"].endswith("Z"))
            await bridge.close_session(False)

    async def test_update_waits_for_refresh_and_never_sends_old_target_after_update(self):
        bridge, session, _ = self.connected_bridge(refresh_interval=0.01)
        started, reply = asyncio.Event(), asyncio.Event()
        calls, concurrent = [], 0
        async def set_location(lat, lon):
            nonlocal concurrent
            concurrent += 1
            self.assertEqual(concurrent, 1)
            calls.append((lat, lon))
            if len(calls) == 2:
                started.set()
                await reply.wait()
            concurrent -= 1
        session["location"].set = set_location
        with patch.object(bridge_module, "emit") as emit:
            await bridge.dispatch("set", {"udid": "phone", "latitude": 1, "longitude": 2, "sessionId": "old"})
            await asyncio.wait_for(started.wait(), 0.5)
            update = asyncio.create_task(bridge.dispatch("set", {"udid": "phone", "latitude": 3, "longitude": 4, "sessionId": "new"}))
            await asyncio.sleep(0)
            self.assertFalse(update.done())
            reply.set()
            result = await update
            self.assertEqual(result["sessionId"], "new")
            self.assertEqual(result["refreshCount"], 1)
            emit.reset_mock()
            await asyncio.sleep(0.035)
            await bridge.close_session(False)
            self.assertTrue(emit.called)
            self.assertTrue(all(call.args[0]["sessionId"] == "new" for call in emit.call_args_list))
        self.assertEqual(calls[:3], [(1, 2), (1, 2), (3, 4)])
        self.assertTrue(all(point == (3, 4) for point in calls[3:]))

    async def test_clear_serializes_with_inflight_refresh_and_stops_loop(self):
        bridge, session, _ = self.connected_bridge(refresh_interval=0.01)
        started, reply = asyncio.Event(), asyncio.Event()
        calls = []
        async def set_location(_lat, _lon):
            calls.append("set")
            if len(calls) == 2:
                started.set()
                await reply.wait()
        async def clear_location():
            calls.append("clear")
        session["location"] = SimpleNamespace(set=set_location, clear=clear_location)
        with patch.object(bridge_module, "emit"):
            await bridge.dispatch("set", {"udid": "phone", "latitude": 1, "longitude": 2})
            await asyncio.wait_for(started.wait(), 0.5)
            clearing = asyncio.create_task(bridge.dispatch("clear", {"udid": "phone"}))
            await asyncio.sleep(0)
            self.assertFalse(clearing.done())
            reply.set()
            self.assertTrue((await clearing)["cleared"])
            await asyncio.sleep(0.03)
        self.assertEqual(calls, ["set", "set", "clear"])
        self.assertIsNone(bridge.session)
        self.assertTrue(session["refresher"].done())

    async def test_refresh_timeout_closes_session_and_reports_matching_intent_once(self):
        bridge, session, _ = self.connected_bridge(refresh_interval=0.01, acknowledgement_timeout=0.02)
        calls = 0
        cancelled = asyncio.Event()
        async def set_location(_lat, _lon):
            nonlocal calls
            calls += 1
            if calls > 1:
                try:
                    await asyncio.Event().wait()
                finally:
                    cancelled.set()
        session["location"].set = set_location
        with patch.object(bridge_module, "emit") as emit:
            await bridge.dispatch("set", {"udid": "phone", "latitude": 1, "longitude": 2, "sessionId": "stalled"})
            await asyncio.wait_for(cancelled.wait(), 0.5)
            await asyncio.wait_for(session["refresher"], 0.5)
            events = [call.args[0] for call in emit.call_args_list]
        self.assertIsNone(bridge.session)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["event"], "session-ended")
        self.assertEqual(events[0]["sessionId"], "stalled")
        self.assertEqual(calls, 2)

    async def test_disconnect_invalidates_before_lock_and_cannot_be_reused_after_replug(self):
        bridge, session, disconnected = self.connected_bridge()
        session["watcher"] = asyncio.create_task(bridge.watch_session(session))
        async with bridge.lock:
            disconnected.set()
            await asyncio.sleep(0)
            self.assertFalse(session["valid"])
            # Simulate a new USB phone while the old DVT close watcher waits.
            bridge.prepare = AsyncMock(side_effect=RuntimeError("fresh preparation reached"))
            with patch.object(bridge_module, "usb_lockdown", new=AsyncMock()) as usb_probe:
                with self.assertRaisesRegex(RuntimeError, "fresh preparation reached"):
                    await bridge_module.Bridge.connect(bridge, "phone")
                usb_probe.assert_not_awaited()
        self.assertIsNone(bridge.session)

    async def test_closed_dvt_flag_is_checked_without_waiting_for_disconnected_event(self):
        bridge, session, _ = self.connected_bridge()
        session["dvt"].dtx._closed = True
        bridge.prepare = AsyncMock(side_effect=RuntimeError("fresh preparation reached"))
        with self.assertRaisesRegex(RuntimeError, "fresh preparation reached"):
            await bridge_module.Bridge.connect(bridge, "phone")
        self.assertIsNone(bridge.session)

    async def test_reset_stops_refresh_and_closes_transport_without_clear(self):
        bridge, session, _ = self.connected_bridge(refresh_interval=0.01)
        await bridge.dispatch("set", {"udid": "phone", "latitude": 1, "longitude": 2})
        self.assertTrue((await bridge.dispatch("reset", {"udid": "phone"}))["reset"])
        await asyncio.sleep(0.03)
        session["location"].set.assert_awaited_once()
        session["location"].clear.assert_not_awaited()
        self.assertTrue(session["refresher"].done())
        self.assertIsNone(bridge.session)

    async def test_discovery_does_not_hold_refresh_lock(self):
        bridge, session, _ = self.connected_bridge(refresh_interval=0.01)
        discovery_started, discovery_reply = asyncio.Event(), asyncio.Event()
        async def discover():
            discovery_started.set()
            await discovery_reply.wait()
            return []
        bridge.discover = discover
        with patch.object(bridge_module, "emit"):
            await bridge.dispatch("set", {"udid": "phone", "latitude": 1, "longitude": 2})
            listing = asyncio.create_task(bridge.dispatch("discover", {}))
            await discovery_started.wait()
            await asyncio.sleep(0.03)
            self.assertGreater(session["location"].set.await_count, 1)
            self.assertFalse(listing.done())
            discovery_reply.set()
            await listing
            await bridge.close_session(False)

    async def test_failed_tunnel_cleanup_requires_process_restart_before_reuse(self):
        bridge, session, _ = self.connected_bridge()
        session["stack"] = SimpleNamespace(aclose=AsyncMock(side_effect=TimeoutError("stuck tunnel")))
        with self.assertRaises(TimeoutError):
            await bridge.close_session(False)
        self.assertIsNone(bridge.session)
        with self.assertRaisesRegex(RuntimeError, "restart the sidecar"):
            await bridge.dispatch("reset", {"udid": "phone"})
        with self.assertRaisesRegex(RuntimeError, "did not close completely"):
            await bridge_module.Bridge.connect(bridge, "phone")


if __name__ == "__main__":
    unittest.main()
