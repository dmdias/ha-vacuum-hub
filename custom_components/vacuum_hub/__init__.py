"""Vacuum Hub: one dashboard card for several robot vacuums, with local room cleaning."""
from __future__ import annotations

import logging
from pathlib import Path

import voluptuous as vol

from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import ATTR_ENTITY_ID
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv

from .card import async_register_card, async_unregister_card
from .const import ATTR_ROOMS, DOMAIN, FRONTEND_URL, SERVICE_CLEAN_ROOMS, VERSION
from .rooms import clean_rooms, resolve_local_vacuum

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

CLEAN_ROOMS_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_ENTITY_ID): cv.entity_id,
        vol.Required(ATTR_ROOMS): vol.All(cv.ensure_list, [vol.Coerce(int)], vol.Length(min=1)),
    }
)

# Cache busting: the card URL changes with every release
CARD_URL = f"{FRONTEND_URL}?v={VERSION}"


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Serve the card and register the room cleaning service."""
    if not hass.data.get(f"{DOMAIN}_static"):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(FRONTEND_URL, str(Path(__file__).parent / "frontend" / "vacuum-hub-card.js"), False)]
        )
        hass.data[f"{DOMAIN}_static"] = True
        # A dashboard resource, added and kept up to date by the integration
        await async_register_card(hass, FRONTEND_URL, CARD_URL)

    async def handle_clean_rooms(call: ServiceCall) -> None:
        entity_id: str = call.data[ATTR_ENTITY_ID]
        rooms: list[int] = call.data[ATTR_ROOMS]
        vacuum = resolve_local_vacuum(hass, entity_id)
        _LOGGER.debug("Cleaning rooms %s on %s (%s)", rooms, entity_id, vacuum.model)
        await hass.async_add_executor_job(clean_rooms, vacuum, rooms)

    hass.services.async_register(DOMAIN, SERVICE_CLEAN_ROOMS, handle_clean_rooms, schema=CLEAN_ROOMS_SCHEMA)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Remove the service and stop loading the card."""
    hass.services.async_remove(DOMAIN, SERVICE_CLEAN_ROOMS)
    return True


async def async_remove_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """The integration removed: stop loading the card."""
    if not [e for e in hass.config_entries.async_entries(DOMAIN) if e.entry_id != entry.entry_id]:
        await async_unregister_card(hass, FRONTEND_URL, CARD_URL)
