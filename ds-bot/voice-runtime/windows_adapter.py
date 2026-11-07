"""Windows Voice Runtime device adapter boundary.

The adapter owns endpoint identity and device/playback state.  LiveKit/WebRTC
remains the audio transport; this module deliberately contains no model or
DS Bot cognition code and can be replaced by a native Windows client.
"""
from __future__ import annotations

from dataclasses import dataclass
from uuid import uuid4


@dataclass(frozen=True)
class DeviceIdentity:
    device_type: str
    device_id: str
    target_id: str
    session_id: str

    @property
    def participant_identity(self) -> str:
        return f"{self.device_id}:{self.session_id}"


class WindowsDeviceAdapter:
    """Lifecycle-only Windows adapter used by the LiveKit client boundary."""

    def __init__(self, device_id: str, *, target_id: str | None = None):
        if not device_id or not device_id.strip():
            raise ValueError("device_id is required")
        self.device_id = device_id
        self.target_id = target_id or device_id
        self.identity: DeviceIdentity | None = None
        self.connected = False
        self.playback_active = False

    def connect(self) -> DeviceIdentity:
        # A reconnect preserves device_id/target_id and receives a fresh
        # session_id/LiveKit participant identity.
        self.identity = DeviceIdentity("windows", self.device_id, self.target_id, uuid4().hex)
        self.connected = True
        self.playback_active = False
        return self.identity

    def disconnect(self) -> None:
        self.connected = False
        self.playback_active = False

    def set_playback(self, active: bool) -> None:
        if not self.connected:
            raise RuntimeError("device is disconnected")
        self.playback_active = bool(active)


