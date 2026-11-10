"""Ghost iOS bridge: private JSONL stdin/stdout, one explicitly selected USB or Wi-Fi DVT session.

No request is acknowledged until the awaited upstream operation completes.
The DVT set selector expects a device reply; clear is an upstream no-reply selector.
"""
import asyncio
import binascii
from contextlib import AsyncExitStack, aclosing, suppress
from contextvars import ContextVar
from datetime import datetime, timezone
import hmac
import importlib.metadata
import json
import logging
import math
import platform
import re
import sys

PROTOCOL_VERSION = 1
PINNED_VERSION = "11.12.4"
REFRESH_INTERVAL = 1.0
LOCATION_ACK_TIMEOUT = 5.0
PROTOCOL_OUT = sys.stdout
# Third-party prints must never corrupt the protocol stream.
sys.stdout = sys.stderr
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

from packaging.version import Version
from pymobiledevice3 import usbmux
from pymobiledevice3.exceptions import AlreadyMountedError, RemotePairingCompletedError
from pymobiledevice3.common import get_home_folder
from pymobiledevice3.lockdown import create_using_tcp, create_using_usbmux, get_mobdev2_lockdowns
from pymobiledevice3.pair_records import get_preferred_pair_record, iter_remote_paired_identifiers
from pymobiledevice3.remote import userspace_tunnel
from pymobiledevice3.remote.tunnel_service import (CoreDeviceTunnelProxy, PairingDataComponentTLVBuf, PairingDataComponentType,
                                                    RemotePairingLockdownService, RemotePairingProtocol,
                                                    RemotePairingTunnelService)
from pymobiledevice3.services.dvt.instruments.dvt_provider import DvtProvider
from pymobiledevice3.services.dvt.instruments.location_simulation import LocationSimulation
from pymobiledevice3.services.mobile_image_mounter import PersonalizedImageMounter, fetch_personalized_ddi


def emit(value):
    PROTOCOL_OUT.write(json.dumps(value, ensure_ascii=True) + "\n")
    PROTOCOL_OUT.flush()


def explain(error):
    name = type(error).__name__
    if "Usbmuxd" in name:
        return "Apple USB services are unavailable. On Windows, install iTunes and reconnect the cable."
    if any(word in name for word in ("Pair", "Passcode", "UserDenied", "Password")):
        return "Unlock the iPhone and accept Trust This Computer, then try again."
    if "DeveloperMode" in name:
        return "Enable Developer Mode in iPhone Settings → Privacy & Security, restart, and confirm it."
    return f"{name}: {str(error) or 'The iPhone did not complete the operation.'}"


async def usb_lockdown(udid, autopair=False):
    if not isinstance(udid, str) or not re.fullmatch(r"[A-Za-z0-9-]{8,80}", udid):
        raise ValueError("A specific iPhone identifier is required.")
    # Explicit connection_type is essential: a paired phone may also appear over Wi-Fi.
    return await create_using_usbmux(serial=udid, connection_type="USB", autopair=autopair, pair_timeout=20)


# A request chooses its transport explicitly. Child tunnel tasks inherit this
# context, while concurrent discovery and refresh tasks keep their own context.
CONNECTION = ContextVar("ghost_connection", default="usb")
# Optional direct network address (for example a Tailscale address) for one
# specific iPhone. It replaces Bonjour discovery, which only works on a shared LAN.
DIRECT = ContextVar("ghost_direct", default=None)
DIRECT_TIMEOUT = 6.0


def direct_target(params):
    host, udid = params.get("host"), params.get("hostUdid", params.get("udid"))
    if host in (None, ""):
        return None
    if (not isinstance(host, str) or not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.:-]{0,251}[A-Za-z0-9])?", host) or
            not isinstance(udid, str) or not re.fullmatch(r"[A-Za-z0-9-]{8,80}", udid)):
        raise ValueError("Enter the iPhone's network address, for example 100.64.0.2.")
    return {"host": host, "udid": udid}


async def direct_lockdown(udid, host):
    """Dial one known address. The saved USB trust record must match this exact iPhone."""
    record = await get_preferred_pair_record(udid, get_home_folder())
    if record is None:
        raise ConnectionError("This iPhone has no saved trust record. Connect it by USB and choose Switch to Wi-Fi once first.")
    try:
        async with asyncio.timeout(DIRECT_TIMEOUT):
            lockdown = await create_using_tcp(hostname=host, autopair=False, pair_record=record, keep_alive=True)
    except (TimeoutError, OSError, RecursionError) as error:
        # iOS resets classic lockdown on VPN interfaces; pinned upstream then recurses.
        raise ConnectionError(f"The iPhone did not answer at {host}. Check that both devices are connected to the same private network.") from error
    if lockdown.udid == udid and lockdown.paired:
        return lockdown
    await lockdown.close()
    raise ConnectionError(f"The device at {host} is not the trusted iPhone selected in Ghost.")


# iOS refuses classic lockdown on VPN interfaces (for example Tailscale) but serves
# RemotePairing there. That route needs its own pairing record, created once over USB.
REMOTE_SERVICE = ContextVar("ghost_remote_service", default=None)
REMOTE_PORT = 49152
REMOTE_PORTS = {}
REMOTE_TIMEOUT = 8.0


async def verified_proof(self):
    """Pinned upstream compares the device's SRP proof in mismatched encodings and always fails."""
    client_public = binascii.unhexlify(self.srp_context.public)
    tlv = PairingDataComponentTLVBuf.build([
        {"type": PairingDataComponentType.STATE, "data": b"\x03"},
        {"type": PairingDataComponentType.PUBLIC_KEY, "data": client_public[:255]},
        {"type": PairingDataComponentType.PUBLIC_KEY, "data": client_public[255:]},
        {"type": PairingDataComponentType.PROOF, "data": binascii.unhexlify(self.srp_context.key_proof)},
    ])
    response = await self._send_receive_pairing_data({
        "data": tlv, "kind": "setupManualPairing", "sendingHost": platform.node(), "startNewSession": False})
    data = self.decode_tlv(PairingDataComponentTLVBuf.parse(response))
    expected = self.srp_context.key_proof_hash
    expected = expected.decode() if isinstance(expected, bytes) else str(expected)
    received = data.get(PairingDataComponentType.PROOF, b"").hex()
    if not hmac.compare_digest(received.lower(), expected.lower()):
        raise ConnectionError("The iPhone did not prove the pairing secret.")


RemotePairingProtocol._verify_proof = verified_proof


def remote_paired(udid):
    return udid in set(iter_remote_paired_identifiers())


def device_note(udid):
    return get_home_folder() / f"ghost_{udid}.json"


def remember_device(udid, name, version):
    with suppress(Exception):
        device_note(udid).write_text(json.dumps({"name": str(name)[:120], "osVersion": str(version)[:40]}), encoding="utf-8")


def recall_device(udid):
    try:
        saved = json.loads(device_note(udid).read_text(encoding="utf-8"))
        return {"name": str(saved.get("name") or "iPhone")[:120], "osVersion": str(saved.get("osVersion") or "")[:40]}
    except Exception:
        return {"name": "iPhone", "osVersion": ""}


async def pair_remote(lockdown):
    """Validate or create the RemotePairing record over trusted USB; no prompt on the phone."""
    service = await RemotePairingLockdownService.create(lockdown)
    try:
        async with asyncio.timeout(30):
            await service.connect(autopair=True)
    except RemotePairingCompletedError:
        pass
    finally:
        await service.close()


async def open_ports(host):
    """The service port is dynamic and Bonjour cannot cross routed networks, so look for it."""
    limit, found = asyncio.Semaphore(256), []

    async def probe(port):
        async with limit:
            with suppress(TimeoutError, OSError):
                async with asyncio.timeout(2):
                    _reader, writer = await asyncio.open_connection(host, port)
                writer.close()
                found.append(port)

    await asyncio.gather(*(probe(port) for port in range(49152, 65536)))
    return sorted(found)


async def remote_attempt(udid, host, port, timeout):
    service = RemotePairingTunnelService(udid, host, port)
    try:
        async with asyncio.timeout(timeout):
            # Pair-verify succeeds only for the iPhone holding this record's keys.
            await service.connect(autopair=False)
    except BaseException:
        with suppress(Exception):
            await service.close()
        raise
    REMOTE_PORTS[host] = port
    return service


async def remote_service(udid, host):
    tried = []
    for port in (REMOTE_PORTS.get(host), REMOTE_PORT):
        if port and port not in tried:
            tried.append(port)
            with suppress(Exception):
                return await remote_attempt(udid, host, port, REMOTE_TIMEOUT)
    for port in await open_ports(host):
        if port not in tried:
            with suppress(Exception):
                return await remote_attempt(udid, host, port, 4)
    raise ConnectionError(f"The iPhone did not answer at {host}. Check that both devices are connected to the same private network.")


async def connection_lockdown(udid, autopair=False):
    if CONNECTION.get() == "usb":
        return await usb_lockdown(udid, autopair=autopair)
    if not isinstance(udid, str) or not re.fullmatch(r"[A-Za-z0-9-]{8,80}", udid):
        raise ValueError("A specific iPhone identifier is required.")
    direct = DIRECT.get()
    direct_error = None
    if direct and direct["udid"] == udid:
        try:
            return await direct_lockdown(udid, direct["host"])
        except ConnectionError as error:
            # Same-network discovery remains a valid route when the saved address is down.
            direct_error = error
    with suppress(TimeoutError):
        async with asyncio.timeout(8):
            async with aclosing(get_mobdev2_lockdowns(only_paired=True, timeout=2)) as devices:
                async for _address, lockdown in devices:
                    # Bonjour names and pairing records alone do not establish identity.
                    if lockdown.udid == udid and lockdown.paired:
                        return lockdown
                    await lockdown.close()
    if direct_error:
        raise direct_error
    raise ConnectionError("This trusted iPhone was not found on Wi-Fi. Unlock it, use the same network and enable Wi-Fi over USB first.")


async def strict_usb_provider(serial, autopair, remotepairing_fallback=False):
    """Use only the requested transport; retain the pinned rootless tunnel lifecycle."""
    service = REMOTE_SERVICE.get()
    if service is not None:
        # connect() already authenticated this exact iPhone on its private address.
        return service, None
    lockdown = await connection_lockdown(serial, autopair=False)
    try:
        if not lockdown.paired:
            raise RuntimeError("Unlock the iPhone and trust this computer first.")
        return await CoreDeviceTunnelProxy.create(lockdown), lockdown
    except BaseException:
        await lockdown.close()
        raise


userspace_tunnel._create_no_root_tunnel_provider = strict_usb_provider


class Bridge:
    def __init__(self, refresh_interval=REFRESH_INTERVAL, acknowledgement_timeout=LOCATION_ACK_TIMEOUT):
        self.session = None
        self.lock = asyncio.Lock()
        self.refresh_interval = refresh_interval
        self.acknowledgement_timeout = acknowledgement_timeout
        self.target_sequence = 0
        self.transport_error = None

    async def describe(self, lockdown, connection):
        item = {"id": f"ios:{lockdown.udid}", "serial": lockdown.udid,
                "platform": "ios", "name": lockdown.all_values.get("DeviceName") or lockdown.product_type or "iPhone",
                "osVersion": lockdown.product_version, "connection": connection,
                "state": "unauthorized", "detail": "Unlock your iPhone and trust this computer over USB."}
        if not lockdown.paired:
            pass
        elif Version(lockdown.product_version) < Version("17.4"):
            item.update(state="setup-required", detail="This version supports iOS 17.4 or later.")
        elif not await lockdown.get_developer_mode_status():
            item.update(state="setup-required", detail="Enable Developer Mode in Settings → Privacy & Security.")
        else:
            item.update(state="ready", detail=f"{'Wi-Fi' if connection == 'wifi' else 'USB'} connected. Developer Mode enabled.")
            if connection == "usb":
                remember_device(lockdown.udid, item["name"], item["osVersion"])
        return item

    async def discover(self):
        result = []
        if CONNECTION.get() == "wifi":
            seen = set()
            direct = DIRECT.get()
            if direct:
                item = await self.discover_remote(direct)
                if item:
                    return [item]
                # A known address answers faster than Bonjour and works across routed networks.
                with suppress(Exception):
                    async with await direct_lockdown(direct["udid"], direct["host"]) as lockdown:
                        result.append(await self.describe(lockdown, "wifi"))
                        seen.add(lockdown.udid)
                if result:
                    return result
            # Bound Bonjour discovery so an unreachable paired phone cannot hang a scan.
            try:
                async with asyncio.timeout(8):
                    async with aclosing(get_mobdev2_lockdowns(only_paired=True, timeout=2)) as devices:
                        async for _address, lockdown in devices:
                            async with lockdown:
                                if lockdown.udid not in seen and lockdown.paired:
                                    result.append(await self.describe(lockdown, "wifi"))
                                    seen.add(lockdown.udid)
            except TimeoutError:
                pass
            return result
        for device in await usbmux.list_devices():
            if device.connection_type != "USB":
                continue
            try:
                async with await usb_lockdown(device.serial) as lockdown:
                    result.append(await self.describe(lockdown, "usb"))
            except Exception as error:
                result.append({"id": f"ios:{device.serial}", "serial": device.serial,
                               "platform": "ios", "name": "iPhone", "osVersion": "",
                               "connection": "usb", "state": "unauthorized", "detail": explain(error)})
        return result

    async def enable_wifi(self, udid):
        if self.session and (self.session["udid"] != udid or self.session.get("connection", "usb") != "usb"):
            raise RuntimeError("Select the iPhone that owns the USB session.")
        async with await usb_lockdown(udid, autopair=True) as lockdown:
            if not lockdown.paired:
                raise RuntimeError("Unlock the iPhone and trust this computer first.")
            # Cache the existing trusted record for authenticated Bonjour discovery.
            await lockdown.save_pair_record()
            await lockdown.set_enable_wifi_connections(True)
            try:
                # Classic Wi-Fi sync is refused on VPN interfaces; this pairing is what works there.
                await pair_remote(lockdown)
            except Exception as error:
                logging.warning("Private-network pairing was not completed: %s", explain(error))
        return {"enabled": True, "message": "Wi-Fi enabled. Keep both devices on the same network, then choose Wi-Fi in Ghost."}

    async def discover_remote(self, direct):
        udid = direct["udid"]
        if not remote_paired(udid):
            return None
        session = self.session
        if not (session and session["udid"] == udid and session.get("remote") and self.session_usable(session)):
            try:
                await (await remote_service(udid, direct["host"])).close()
            except Exception:
                return None
        known = recall_device(udid)
        return {"id": f"ios:{udid}", "serial": udid, "platform": "ios", "name": known["name"],
                "osVersion": known["osVersion"], "connection": "wifi", "state": "ready",
                "detail": "Connected through your private network."}

    async def remote_or_none(self, udid):
        direct = DIRECT.get()
        if CONNECTION.get() != "wifi" or not direct or direct["udid"] != udid or not remote_paired(udid):
            return None
        try:
            return await remote_service(udid, direct["host"])
        except ConnectionError:
            # A phone on the same LAN is still reachable through the classic route.
            return None

    async def ensure_image(self, provider):
        async with PersonalizedImageMounter(provider) as mounter:
            if not await mounter.is_image_mounted("Personalized"):
                # Keep potentially slow first-run download off the session event loop.
                image, manifest, trustcache = await asyncio.to_thread(fetch_personalized_ddi)
                with suppress(AlreadyMountedError):
                    await mounter.mount(image, manifest, trustcache)

    async def prepare(self, udid, remote=True):
        service = await self.remote_or_none(udid) if remote else None
        if service is not None:
            await service.close()
            return {"ready": True, "message": "iPhone is reachable through your private network."}
        async with await connection_lockdown(udid, autopair=True) as lockdown:
            if not lockdown.paired:
                raise RuntimeError("Unlock the iPhone and trust this computer.")
            if Version(lockdown.product_version) < Version("17.4"):
                raise RuntimeError("This version requires iOS 17.4 or later.")
            if not await lockdown.get_developer_mode_status():
                raise RuntimeError("Enable Developer Mode in Settings → Privacy & Security, restart, and confirm it.")
            await self.ensure_image(lockdown)
        return {"ready": True, "message": "iPhone developer services are ready."}

    async def connect(self, udid):
        if self.transport_error:
            raise RuntimeError("The previous iPhone transport did not close completely. Reset the connection to retry.")
        if self.session:
            if self.session["udid"] == udid and self.session.get("connection", "usb") == CONNECTION.get():
                # A new lockdown connection after replug says nothing about the old
                # DVT stream. Check its lifetime both before and after the USB probe.
                session = self.session
                if self.session_usable(session) and session.get("remote"):
                    # No lockdown exists on this route; the DVT stream is the liveness signal.
                    return session
                if self.session_usable(session):
                    try:
                        async with await connection_lockdown(udid):
                            if self.session_usable(session):
                                return session
                    except BaseException:
                        await self.fail_session(session, "iPhone connection ended. Location state is unknown.")
                        raise
                await self.fail_session(session, "iPhone developer connection ended. Location state is unknown.")
            else:
                raise RuntimeError("Restore the active iPhone location before switching devices.")
        service = await self.remote_or_none(udid)
        if service is None:
            await self.prepare(udid, remote=False)
        stack = AsyncExitStack()
        token = REMOTE_SERVICE.set(service)
        try:
            tunnel = userspace_tunnel.UserspaceRsdTunnel(serial=udid, autopair=False, remotepairing_fallback=False)
            rsd = await stack.enter_async_context(tunnel)
            if rsd.udid != udid:
                raise RuntimeError("Connected iPhone does not match the selected device.")
            if service is not None:
                await self.ensure_image(rsd)
            dvt = await stack.enter_async_context(DvtProvider(rsd))
            location = await stack.enter_async_context(LocationSimulation(dvt))
        except BaseException:
            try:
                await asyncio.wait_for(stack.aclose(), 8)
            except BaseException as error:
                self.transport_error = error
                raise
            finally:
                if service is not None:
                    with suppress(Exception):
                        await service.close()
            raise
        finally:
            REMOTE_SERVICE.reset(token)
        session = {"udid": udid, "connection": CONNECTION.get(), "remote": service is not None, "stack": stack, "dvt": dvt, "tunnel": tunnel,
                   "location": location, "active": False, "valid": True, "target": None}
        self.session = session
        session["watcher"] = asyncio.create_task(self.watch_session(session))
        return session

    def session_usable(self, session):
        # _closed is pinned 11.12.4's immediate close flag; wait_disconnected()
        # only completes after socket/channel cleanup, which can take seconds.
        return (self.session is session and session.get("valid", True) and
                not getattr(getattr(session.get("dvt"), "dtx", None), "_closed", False) and
                (not session.get("tunnel") or session["tunnel"].rsd is not None))

    def session_event(self, session, error):
        event = {"event": "session-ended", "deviceId": f"ios:{session['udid']}", "error": error}
        target = session.get("target")
        if target:
            event.update(sessionId=target["sessionId"], generation=target["generation"])
        return event

    async def fail_session(self, session, error):
        if self.session is not session:
            return
        event = self.session_event(session, error)
        report = session.get("active") or session.get("target") is not None
        try:
            await self.close_session(clear=False)
        finally:
            if report:
                emit(event)

    async def watch_session(self, session):
        await session["dvt"].dtx.wait_disconnected()
        # Invalidate before waiting for an in-flight request's lock. Replugging
        # must never make this dead stream eligible for reuse.
        session["valid"] = False
        async with self.lock:
            await self.fail_session(session, "iPhone connection ended. Location state is unknown; reconnect to restore it.")

    async def apply_target(self, session, target):
        # The pinned selector has only latitude/longitude, no timestamp argument.
        # The time below records the awaited reply, never a measured GPS fix.
        await asyncio.wait_for(session["location"].set(target["latitude"], target["longitude"]),
                               timeout=self.acknowledgement_timeout)
        if not self.session_usable(session) or session.get("target") is not target:
            raise ConnectionError("iPhone connection ended before the location acknowledgement was accepted.")
        target["refreshCount"] += 1
        target["refreshedAt"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        return {"deviceId": f"ios:{session['udid']}", "sessionId": target["sessionId"],
                "generation": target["generation"], "latitude": target["latitude"], "longitude": target["longitude"],
                "refreshedAt": target["refreshedAt"], "refreshCount": target["refreshCount"],
                "refreshIntervalMs": round(self.refresh_interval * 1000)}

    async def refresh_session(self, session):
        while True:
            await asyncio.sleep(self.refresh_interval)
            async with self.lock:
                if self.session is not session or not session.get("active"):
                    return
                try:
                    if not self.session_usable(session):
                        raise ConnectionError("iPhone developer transport is closed.")
                    acknowledged = await self.apply_target(session, session["target"])
                    emit({"event": "location-refreshed", **acknowledged})
                except Exception as error:
                    await self.fail_session(session, f"iPhone location refresh failed ({explain(error)}). Location state is unknown; reconnect to retry.")
                    return

    async def close_session(self, clear):
        session, self.session = self.session, None
        if not session:
            return
        session["valid"] = False
        tasks = [session[name] for name in ("watcher", "refresher")
                 if session.get(name) and session[name] is not asyncio.current_task()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        try:
            if clear and session["active"]:
                await asyncio.wait_for(session["location"].clear(), self.acknowledgement_timeout)
                session["active"] = False
        finally:
            try:
                await asyncio.wait_for(session["stack"].aclose(), 8)
            except BaseException as error:
                # Upstream owns a process-global tunnel singleton. If its cleanup
                # fails, a fresh process is required before any reconnect attempt.
                self.transport_error = error
                raise

    async def dispatch(self, method, params):
        connection = params.get("connection", "usb")
        if connection not in ("usb", "wifi"):
            raise ValueError("Choose USB or Wi-Fi.")
        direct = direct_target(params) if connection == "wifi" else None
        token = CONNECTION.set(connection)
        direct_token = DIRECT.set(direct)
        try:
            return await self._dispatch(method, params)
        finally:
            DIRECT.reset(direct_token)
            CONNECTION.reset(token)

    async def _dispatch(self, method, params):
        if method == "status":
            version = importlib.metadata.version("pymobiledevice3")
            return {"available": version == PINNED_VERSION, "message": f"iPhone support {version}; iOS 17.4+ over USB or paired Wi-Fi.",
                    "protocolVersion": PROTOCOL_VERSION}
        # Discovery opens independent lockdown connections. It
        # must not pause the persistent DVT refresh loop behind slow trust probes.
        if method == "discover":
            return await self.discover()
        async with self.lock:
            if method == "enable-wifi":
                return await self.enable_wifi(params.get("udid"))
            if method == "prepare":
                return await self.prepare(params.get("udid"))
            if method == "set":
                lat, lon = params.get("latitude"), params.get("longitude")
                if (isinstance(lat, bool) or isinstance(lon, bool) or
                    not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)) or
                    not math.isfinite(lat) or not math.isfinite(lon) or abs(lat) > 90 or abs(lon) > 180):
                    raise ValueError("Invalid latitude or longitude.")
                session_id = params.get("sessionId")
                if session_id is not None and (not isinstance(session_id, str) or len(session_id) > 200):
                    raise ValueError("Invalid location session identifier.")
                session = await self.connect(params.get("udid"))
                self.target_sequence += 1
                target = {"latitude": lat, "longitude": lon, "sessionId": session_id,
                          "generation": params.get("generation", self.target_sequence), "refreshCount": 0}
                # Replace the whole intent while holding the same lock as refresh.
                # A prior coordinate can never be sent after this update begins.
                session["target"] = target
                try:
                    acknowledged = await self.apply_target(session, target)
                    session["active"] = True
                    if not session.get("refresher") or session["refresher"].done():
                        session["refresher"] = asyncio.create_task(self.refresh_session(session))
                    return {"applied": True, **acknowledged}
                except BaseException:
                    await self.fail_session(session, "Location update failed. Location state is unknown; reconnect to restore it.")
                    raise
            if method == "clear":
                session = await self.connect(params.get("udid"))
                try:
                    await asyncio.wait_for(session["location"].clear(), self.acknowledgement_timeout)
                    session["active"] = False
                except BaseException:
                    emit(self.session_event(session, "Restore command failed. Location state is unknown; reconnect to restore it."))
                    raise
                finally:
                    await self.close_session(clear=False)
                return {"cleared": True, "message": "Restore command sent to the iPhone."}
            if method == "reset":
                if self.session and self.session["udid"] != params.get("udid"):
                    raise ValueError("The selected iPhone does not own the current session.")
                await self.close_session(clear=False)
                if self.transport_error:
                    raise RuntimeError("iPhone transport cleanup failed; restart the sidecar before reconnecting.")
                return {"reset": True, "message": "Developer transport closed; the next request creates a fresh connection."}
            if method == "shutdown":
                # A normal quit may explicitly preserve an unresolved session journal
                # without sending another restore command. Closing the transport does
                # not guarantee the OS will retain (or clear) the simulated location.
                await self.close_session(clear=params.get("restore", True) is not False)
                return {"stopped": True}
            raise ValueError("Unknown iPhone operation.")


async def main():
    bridge = Bridge()
    try:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                break
            request = {}
            try:
                if len(line) > 32768:
                    raise ValueError("Request is too large.")
                request = json.loads(line)
                if not isinstance(request, dict) or not isinstance(request.get("params", {}), dict):
                    request = {}
                    raise ValueError("Invalid request.")
                method = request.get("method")
                result = await bridge.dispatch(method, request.get("params", {}))
                emit({"id": request.get("id"), "ok": True, "result": result})
                if method == "shutdown":
                    break
            except Exception as error:
                emit({"id": request.get("id"), "ok": False, "error": explain(error)})
    finally:
        with suppress(Exception):
            await asyncio.wait_for(bridge.close_session(clear=True), 8)


if __name__ == "__main__":
    if importlib.metadata.version("pymobiledevice3") != PINNED_VERSION:
        raise RuntimeError(f"This bridge requires pymobiledevice3 {PINNED_VERSION}.")
    asyncio.run(main())
