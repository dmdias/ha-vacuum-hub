"""Room cleaning over the local miio protocol.

The cloud (MIoT) APIs of several Xiaomi ecosystem vacuums cannot clean
selected rooms, while the local miio protocol can. The host and token of the
vacuum are taken from its Xiaomi Cloud Map Extractor config entry, so the
user never has to copy them anywhere.
"""
from __future__ import annotations

from dataclasses import dataclass
import logging

from homeassistant.core import HomeAssistant
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import device_registry as dr, entity_registry as er

from .const import MAP_EXTRACTOR_DOMAIN

_LOGGER = logging.getLogger(__name__)

VIOMI_PREFIXES = ("viomi.vacuum.",)
ROBOROCK_PREFIXES = ("roborock.vacuum.", "rockrobo.vacuum.")


@dataclass
class LocalVacuum:
    """What is needed to talk to a vacuum locally."""

    model: str
    host: str
    token: str


def supported_model(model: str | None) -> bool:
    """Whether room cleaning is implemented for a model."""
    return bool(model) and model.startswith(VIOMI_PREFIXES + ROBOROCK_PREFIXES)


def vacuum_model(hass: HomeAssistant, entity_id: str) -> str | None:
    """Model of the device behind a vacuum entity (e.g. viomi.vacuum.v8)."""
    entry = er.async_get(hass).async_get(entity_id)
    if entry is None or entry.device_id is None:
        return None
    device = dr.async_get(hass).async_get(entry.device_id)
    return device.model if device else None


def resolve_local_vacuum(hass: HomeAssistant, entity_id: str) -> LocalVacuum:
    """Find the model, host and token of the vacuum behind an entity."""
    model = vacuum_model(hass, entity_id)
    if not model:
        raise ServiceValidationError(f"Could not find the device model of {entity_id}")
    if not supported_model(model):
        raise ServiceValidationError(f"Room cleaning is not supported for {model} ({entity_id})")

    candidates = [
        entry
        for entry in hass.config_entries.async_entries(MAP_EXTRACTOR_DOMAIN)
        if entry.data.get("model") == model and entry.data.get("host") and entry.data.get("token")
    ]
    if not candidates:
        raise ServiceValidationError(
            f"No Xiaomi Cloud Map Extractor entry found for {model}. Add the vacuum to "
            "Xiaomi Cloud Map Extractor (v3) first: Vacuum Hub reads its host and token from there."
        )
    if len(candidates) > 1:
        _LOGGER.warning("Several Map Extractor entries for %s, using %s", model, candidates[0].title)
    data = candidates[0].data
    return LocalVacuum(model=model, host=data["host"], token=data["token"])


def clean_rooms(vacuum: LocalVacuum, rooms: list[int]) -> None:
    """Send the room cleaning command (blocking, run in the executor)."""
    try:
        if vacuum.model.startswith(VIOMI_PREFIXES):
            from miio import ViomiVacuum

            device = ViomiVacuum(vacuum.host, vacuum.token)
            # python-miio's start_with_room looks the rooms up by name first, which
            # needs a "fake schedule" in the app; the ids already come from the map.
            # The current mode (vacuum / mop) is kept.
            mode = device.get_properties(["mode"])
            device.send("set_mode_withroom", mode + [1, len(rooms)] + rooms)
        else:
            from miio import RoborockVacuum

            RoborockVacuum(vacuum.host, vacuum.token).segment_clean(rooms)
    except Exception as err:  # python-miio raises a variety of exceptions
        raise HomeAssistantError(
            f"Could not start room cleaning on {vacuum.model} at {vacuum.host}: {err}"
        ) from err
