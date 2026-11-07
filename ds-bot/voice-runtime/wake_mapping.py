"""Shared role wake mapping validation for Windows and Android adapters."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence


@dataclass(frozen=True)
class WakeMapping:
    version: str
    roles: Mapping[str, tuple[str, ...]]

    @classmethod
    def from_roster(cls, value: Mapping[str, object]) -> "WakeMapping":
        """A bounded full snapshot from an authenticated Bridge connection."""
        epoch, revision, rows = (value.get(key) for key in ('activity_epoch', 'revision', 'roles'))
        if (not isinstance(epoch, str) or not epoch.strip() or len(epoch) > 80
                or type(revision) is not int or not 0 <= revision <= 9007199254740991
                or not isinstance(rows, list) or len(rows) > 32):
            raise ValueError('invalid_role_roster')
        roles = {}
        names_seen = {}
        for row in rows:
            if (not isinstance(row, dict)
                    or not {'bot_id', 'session_id', 'wake_names', 'profile_version'}.issubset(row)
                    or set(row) - {'bot_id', 'session_id', 'wake_names', 'profile_version', 'tts_voice'}):
                raise ValueError('invalid_role_roster')
            role, session_id, names, profile = row['bot_id'], row['session_id'], row['wake_names'], row['profile_version']
            if (not isinstance(role, str) or not role.strip() or len(role) > 128 or role in roles
                    or not isinstance(session_id, str) or not session_id.strip() or len(session_id) > 128
                    or not isinstance(names, list) or not 1 <= len(names) <= 32
                    or type(profile) is not int or not 0 <= profile <= 9007199254740991
                    or any(not isinstance(n, str) or not n.strip() or len(n) > 128 for n in names)
                    or len(set(names)) != len(names)):
                raise ValueError('invalid_role_roster')
            for name in names:
                if name in names_seen and names_seen[name] != role:
                    raise ValueError('ambiguous_wake_names')
                names_seen[name] = role
            roles[role] = tuple(names)
        return cls(f'{epoch}:{revision}', roles)

    @classmethod
    def from_config(cls, config: Mapping[str, object]) -> "WakeMapping":
        version = config.get('wake_mapping_version', '1')
        raw = config.get('bot_wake_names') or {}
        if not isinstance(version, str) or not version.strip() or not isinstance(raw, Mapping):
            raise ValueError('invalid_wake_mapping')
        roles = {}
        for bot_id, names in raw.items():
            if not isinstance(bot_id, str) or not bot_id.strip() or isinstance(names, str):
                raise ValueError('invalid_wake_mapping')
            normalized = tuple(dict.fromkeys(name.strip() for name in names
                                             if isinstance(name, str) and name.strip()))
            if not normalized:
                raise ValueError('invalid_wake_mapping')
            roles[bot_id] = normalized
        return cls(version.strip(), roles)

    def names_for(self, bot_id: str) -> tuple[str, ...]:
        return self.roles.get(bot_id, ())

    def all_names(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys(
            name for names in self.roles.values() for name in names))


