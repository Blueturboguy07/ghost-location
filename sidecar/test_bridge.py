"""Protocol behavior tests; all USB and location calls are replaced, no phone access."""
import asyncio
from contextlib import AsyncExitStack
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

import ios_bridge as bridge_module


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def wait_until(self, predicate):
        # Windows timers can have a 15 ms granularity. Assert completion, not
        # how many 5 ms sleeps a loaded CI host happens to fit into 40 ms.
        async with asyncio.timeout(2):
            while not predicate():
                await asyncio.sleep(0.005)

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
            await self.wait_until(lambda: len(emit.call_args_list) >= 2)
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
            await self.wait_until(lambda: session["location"].set.await_count > 1)
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

    async def test_wifi_factory_uses_only_paired_exact_identity_and_closes_other_phones(self):
        wanted = "00008030-0000000000000001"
        other = SimpleNamespace(udid="00008030-0000000000000002", paired=True, close=AsyncMock())
        selected = SimpleNamespace(udid=wanted, paired=True, close=AsyncMock())
        options = []
        async def network_devices(**kwargs):
            options.append(kwargs)
            yield "192.168.1.21", other
            yield "192.168.1.20", selected
        token = bridge_module.CONNECTION.set("wifi")
        try:
            with patch.object(bridge_module, "get_mobdev2_lockdowns", network_devices), patch.object(bridge_module, "usb_lockdown", AsyncMock()) as usb:
                with patch.object(bridge_module.CoreDeviceTunnelProxy, "create", AsyncMock(return_value="proxy")):
                    self.assertEqual(await bridge_module.strict_usb_provider(wanted, True, True), ("proxy", selected))
                usb.assert_not_awaited()
            self.assertTrue(options[0]["only_paired"])
            other.close.assert_awaited_once()
            selected.close.assert_not_awaited()
        finally:
            bridge_module.CONNECTION.reset(token)

    async def test_direct_address_dials_only_the_trusted_exact_phone(self):
        wanted = "00008030-0000000000000001"
        selected = SimpleNamespace(udid=wanted, paired=True, close=AsyncMock())
        dial = AsyncMock(return_value=selected)
        async def no_bonjour(**kwargs):
            raise AssertionError("Bonjour must not run when the saved address answers")
            yield None
        token = bridge_module.CONNECTION.set("wifi")
        direct = bridge_module.DIRECT.set(bridge_module.direct_target({"host": "100.64.0.2", "udid": wanted}))
        try:
            with patch.object(bridge_module, "create_using_tcp", dial), \
                    patch.object(bridge_module, "get_preferred_pair_record", AsyncMock(return_value={"HostID": "x"})), \
                    patch.object(bridge_module, "get_mobdev2_lockdowns", no_bonjour), \
                    patch.object(bridge_module, "usb_lockdown", AsyncMock()) as usb:
                self.assertIs(await bridge_module.connection_lockdown(wanted), selected)
                usb.assert_not_awaited()
            self.assertEqual(dial.await_args.kwargs["hostname"], "100.64.0.2")
            self.assertFalse(dial.await_args.kwargs["autopair"])
            self.assertEqual(dial.await_args.kwargs["pair_record"], {"HostID": "x"})
        finally:
            bridge_module.DIRECT.reset(direct)
            bridge_module.CONNECTION.reset(token)

    async def test_direct_address_rejects_other_phones_and_missing_trust(self):
        wanted = "00008030-0000000000000001"
        stranger = SimpleNamespace(udid="00008030-0000000000000002", paired=True, close=AsyncMock())
        with patch.object(bridge_module, "create_using_tcp", AsyncMock(return_value=stranger)), \
                patch.object(bridge_module, "get_preferred_pair_record", AsyncMock(return_value={"HostID": "x"})):
            with self.assertRaisesRegex(ConnectionError, "not the trusted iPhone"):
                await bridge_module.direct_lockdown(wanted, "100.64.0.2")
        stranger.close.assert_awaited_once()
        dial = AsyncMock()
        with patch.object(bridge_module, "create_using_tcp", dial), \
                patch.object(bridge_module, "get_preferred_pair_record", AsyncMock(return_value=None)):
            with self.assertRaisesRegex(ConnectionError, "no saved trust record"):
                await bridge_module.direct_lockdown(wanted, "100.64.0.2")
        dial.assert_not_awaited()

    async def test_direct_address_failure_falls_back_to_local_discovery_then_reports_address(self):
        wanted = "00008030-0000000000000001"
        selected = SimpleNamespace(udid=wanted, paired=True, close=AsyncMock())
        found = [selected]
        async def network_devices(**kwargs):
            for item in found:
                yield "192.168.1.20", item
        token = bridge_module.CONNECTION.set("wifi")
        direct = bridge_module.DIRECT.set({"host": "100.64.0.2", "udid": wanted})
        try:
            with patch.object(bridge_module, "create_using_tcp", AsyncMock(side_effect=OSError("unreachable"))), \
                    patch.object(bridge_module, "get_preferred_pair_record", AsyncMock(return_value={"HostID": "x"})), \
                    patch.object(bridge_module, "get_mobdev2_lockdowns", network_devices):
                self.assertIs(await bridge_module.connection_lockdown(wanted), selected)
                found.clear()
                with self.assertRaisesRegex(ConnectionError, "did not answer at 100.64.0.2"):
                    await bridge_module.connection_lockdown(wanted)
        finally:
            bridge_module.DIRECT.reset(direct)
            bridge_module.CONNECTION.reset(token)

    async def test_direct_address_is_validated_and_ignored_over_usb(self):
        for bad in ("100.64.0.2/evil", "a b", "-x", 7):
            with self.assertRaises(ValueError):
                bridge_module.direct_target({"host": bad, "udid": "00008030-0000000000000001"})
        with self.assertRaises(ValueError):
            bridge_module.direct_target({"host": "100.64.0.2"})
        self.assertIsNone(bridge_module.direct_target({"udid": "00008030-0000000000000001"}))
        self.assertEqual(bridge_module.direct_target({"host": "iphone.tail1234.ts.net", "hostUdid": "00008030-0000000000000001"}),
                         {"host": "iphone.tail1234.ts.net", "udid": "00008030-0000000000000001"})
        bridge = bridge_module.Bridge()
        seen = []
        async def dispatch(method, params):
            seen.append(bridge_module.DIRECT.get())
            return {}
        bridge._dispatch = dispatch
        await bridge.dispatch("discover", {"connection": "usb", "host": "100.64.0.2", "hostUdid": "00008030-0000000000000001"})
        await bridge.dispatch("discover", {"connection": "wifi", "host": "100.64.0.2", "hostUdid": "00008030-0000000000000001"})
        self.assertEqual(seen, [None, {"host": "100.64.0.2", "udid": "00008030-0000000000000001"}])
        self.assertIsNone(bridge_module.DIRECT.get())

    async def test_private_network_route_is_preferred_and_never_dials_classic_lockdown(self):
        wanted = "00008030-0000000000000001"
        service = SimpleNamespace(close=AsyncMock())
        bridge = bridge_module.Bridge()
        params = {"connection": "wifi", "host": "100.64.0.2", "hostUdid": wanted}
        with patch.object(bridge_module, "remote_paired", return_value=True), \
                patch.object(bridge_module, "remote_service", AsyncMock(return_value=service)) as remote, \
                patch.object(bridge_module, "recall_device", return_value={"name": "Phone", "osVersion": "27.0"}), \
                patch.object(bridge_module, "create_using_tcp", AsyncMock(side_effect=AssertionError("classic dial"))):
            found = await bridge.dispatch("discover", params)
            ready = await bridge.dispatch("prepare", {"connection": "wifi", "host": "100.64.0.2", "udid": wanted})
        self.assertEqual([(item["serial"], item["name"], item["connection"], item["state"]) for item in found],
                         [(wanted, "Phone", "wifi", "ready")])
        self.assertTrue(ready["ready"])
        self.assertEqual(remote.await_args.args, (wanted, "100.64.0.2"))
        self.assertEqual(service.close.await_count, 2)

    async def test_private_network_route_needs_its_own_pairing_and_falls_back_when_down(self):
        wanted = "00008030-0000000000000001"
        bridge = bridge_module.Bridge()
        token = bridge_module.CONNECTION.set("wifi")
        direct = bridge_module.DIRECT.set({"host": "100.64.0.2", "udid": wanted})
        try:
            with patch.object(bridge_module, "remote_paired", return_value=False), \
                    patch.object(bridge_module, "remote_service", AsyncMock()) as remote:
                self.assertIsNone(await bridge.remote_or_none(wanted))
                self.assertIsNone(await bridge.discover_remote({"host": "100.64.0.2", "udid": wanted}))
                remote.assert_not_awaited()
            with patch.object(bridge_module, "remote_paired", return_value=True), \
                    patch.object(bridge_module, "remote_service", AsyncMock(side_effect=ConnectionError("down"))):
                self.assertIsNone(await bridge.remote_or_none(wanted))
                self.assertIsNone(await bridge.remote_or_none("00008030-0000000000000002"))
        finally:
            bridge_module.DIRECT.reset(direct)
            bridge_module.CONNECTION.reset(token)

    async def test_private_network_service_tries_known_port_then_searches(self):
        wanted, calls = "00008030-0000000000000001", []
        service = SimpleNamespace(close=AsyncMock())
        async def attempt(udid, host, port, timeout):
            calls.append(port)
            if port != 50111:
                raise ConnectionError("not the pairing service")
            bridge_module.REMOTE_PORTS[host] = port
            return service
        self.addCleanup(bridge_module.REMOTE_PORTS.clear)
        with patch.object(bridge_module, "remote_attempt", attempt), \
                patch.object(bridge_module, "open_ports", AsyncMock(return_value=[49152, 50111, 62000])) as scan:
            self.assertIs(await bridge_module.remote_service(wanted, "100.64.0.2"), service)
            self.assertEqual(calls, [49152, 50111])
            calls.clear()
            self.assertIs(await bridge_module.remote_service(wanted, "100.64.0.2"), service)
            self.assertEqual(calls, [50111])
            self.assertEqual(scan.await_count, 1)
        with patch.object(bridge_module, "remote_attempt", AsyncMock(side_effect=OSError("refused"))), \
                patch.object(bridge_module, "open_ports", AsyncMock(return_value=[])):
            with self.assertRaisesRegex(ConnectionError, "did not answer at 100.64.0.9"):
                await bridge_module.remote_service(wanted, "100.64.0.9")

    async def test_tunnel_provider_uses_the_authenticated_private_service(self):
        service = SimpleNamespace()
        token = bridge_module.REMOTE_SERVICE.set(service)
        try:
            with patch.object(bridge_module, "connection_lockdown", AsyncMock(side_effect=AssertionError("lockdown"))):
                self.assertEqual(await bridge_module.strict_usb_provider("00008030-0000000000000001", False), (service, None))
        finally:
            bridge_module.REMOTE_SERVICE.reset(token)

    async def test_usb_pairing_for_private_networks_completes_and_checks_the_device_proof(self):
        service = SimpleNamespace(connect=AsyncMock(side_effect=bridge_module.RemotePairingCompletedError()), close=AsyncMock())
        with patch.object(bridge_module.RemotePairingLockdownService, "create", AsyncMock(return_value=service)):
            await bridge_module.pair_remote(SimpleNamespace(udid="00008030-0000000000000001"))
        self.assertTrue(service.connect.await_args.kwargs["autopair"])
        service.close.assert_awaited_once()

        proof = bytes(range(64))
        def protocol(expected):
            return SimpleNamespace(
                srp_context=SimpleNamespace(public="ab" * 384, key_proof="cd" * 64, key_proof_hash=expected),
                _send_receive_pairing_data=AsyncMock(return_value=b"reply"),
                decode_tlv=lambda _items: {bridge_module.PairingDataComponentType.PROOF: proof})
        with patch.object(bridge_module.PairingDataComponentTLVBuf, "parse", return_value=[]):
            await bridge_module.verified_proof(protocol(proof.hex().encode()))
            await bridge_module.verified_proof(protocol(proof.hex().upper()))
            with self.assertRaisesRegex(ConnectionError, "pairing secret"):
                await bridge_module.verified_proof(protocol("00" * 64))

    async def test_wifi_missing_phone_never_falls_back_to_usb(self):
        async def network_devices(**kwargs):
            if False:
                yield None
        token = bridge_module.CONNECTION.set("wifi")
        try:
            with patch.object(bridge_module, "get_mobdev2_lockdowns", network_devices), patch.object(bridge_module, "usb_lockdown", AsyncMock()) as usb:
                with self.assertRaisesRegex(ConnectionError, "not found on Wi-Fi"):
                    await bridge_module.connection_lockdown("00008030-0000000000000001")
                usb.assert_not_awaited()
        finally:
            bridge_module.CONNECTION.reset(token)

    async def test_wifi_requests_keep_streaming_and_clear_the_session(self):
        bridge, session, _ = self.connected_bridge(refresh_interval=0.005)
        with patch.object(bridge_module, "emit"):
            await bridge.dispatch("set", {"udid": "phone", "connection": "wifi", "latitude": 1, "longitude": 2})
            await self.wait_until(lambda: session["location"].set.await_count >= 4)
            self.assertGreaterEqual(session["location"].set.await_count, 4)
            await bridge.dispatch("set", {"udid": "phone", "connection": "wifi", "latitude": 3, "longitude": 4})
            await asyncio.sleep(0.02)
            self.assertEqual(session["location"].set.await_args.args, (3, 4))
            await bridge.dispatch("clear", {"udid": "phone", "connection": "wifi"})
            self.assertIsNone(bridge.session)
            session["location"].clear.assert_awaited_once()
        self.assertEqual(bridge_module.CONNECTION.get(), "usb")

    async def test_enabling_wifi_uses_usb_trust_and_caches_pair_record(self):
        bridge = bridge_module.Bridge()
        lockdown = AsyncMock()
        lockdown.paired = True
        lockdown.__aenter__.return_value = lockdown
        with patch.object(bridge_module, "usb_lockdown", AsyncMock(return_value=lockdown)) as usb:
            result = await bridge.dispatch("enable-wifi", {"udid": "00008030-0000000000000001"})
            self.assertTrue(result["enabled"])
            usb.assert_awaited_once_with("00008030-0000000000000001", autopair=True)
            lockdown.save_pair_record.assert_awaited_once()
            lockdown.set_enable_wifi_connections.assert_awaited_once_with(True)

    async def test_enabling_wifi_preserves_same_phone_usb_stream(self):
        bridge, session, _ = self.connected_bridge(refresh_interval=0.005)
        lockdown = AsyncMock()
        lockdown.paired = True
        lockdown.__aenter__.return_value = lockdown
        with patch.object(bridge_module, "emit"), patch.object(bridge_module, "usb_lockdown", AsyncMock(return_value=lockdown)):
            await bridge.dispatch("set", {"udid": "phone", "latitude": 1, "longitude": 2})
            await bridge.dispatch("enable-wifi", {"udid": "phone"})
            await self.wait_until(lambda: session["location"].set.await_count >= 3)
            self.assertIs(bridge.session, session)
            self.assertGreaterEqual(session["location"].set.await_count, 3)
            session["location"].clear.assert_not_awaited()
            with self.assertRaisesRegex(RuntimeError, "owns the USB session"):
                await bridge.dispatch("enable-wifi", {"udid": "another-phone"})

    async def test_wifi_discovery_deduplicates_and_closes_connections(self):
        bridge = bridge_module.Bridge()
        lockdown = AsyncMock()
        lockdown.udid = "00008030-0000000000000001"
        lockdown.paired = True
        lockdown.__aenter__.return_value = lockdown
        async def devices(**kwargs):
            yield "192.168.1.20", lockdown
            yield "fe80::1", lockdown
        bridge.describe = AsyncMock(return_value={"id": "phone", "connection": "wifi"})
        with patch.object(bridge_module, "get_mobdev2_lockdowns", devices):
            result = await bridge.dispatch("discover", {"connection": "wifi"})
        self.assertEqual(len(result), 1)
        self.assertEqual(lockdown.__aexit__.await_count, 2)


if __name__ == "__main__":
    unittest.main()
