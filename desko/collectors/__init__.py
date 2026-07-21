"""Collectors: each exposes ``async def start(state, config, session)``.

Each collector runs its own loop, calls ``state.set_section(...)`` when its data
changes, and degrades gracefully (no-op / hide widget) when its source is
unavailable. See IMPLEMENTATION_PLAN §7.
"""
