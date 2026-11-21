"""LiteLLM gateway: key pool with ordered failover, built-in response caching, failure simulation."""
import logging
import time
from dataclasses import dataclass

import litellm
from litellm.caching.caching import Cache

from .config import Settings

log = logging.getLogger("llm")
litellm.drop_params = True
litellm.suppress_debug_info = True


class AllProvidersUnavailable(Exception):
    pass


@dataclass
class LLMResult:
    reply: str
    resolution_source: str
    model: str
    latency_ms: int
    input_tokens: int
    output_tokens: int
    key_id: str | None
    fallback_attempts: int


def parse_simulation(header: str | None) -> dict[str, int]:
    """'key_1=429,key_2=500' / '*=429' -> {'key_1': 429, ...}. Invalid pairs are ignored."""
    out: dict[str, int] = {}
    if not header:
        return out
    for part in header.split(","):
        if "=" not in part:
            continue
        k, v = part.split("=", 1)
        k, v = k.strip(), v.strip()
        if v.isdigit() and int(v) in (429, 500, 502, 503):
            out[k] = int(v)
    return out


_EXC = {
    429: litellm.RateLimitError,
    500: litellm.InternalServerError,
    502: litellm.InternalServerError,
    503: litellm.ServiceUnavailableError,
}


def _simulated_error(status: int, model: str):
    return _EXC[status](message=f"simulated {status}", llm_provider="simulated", model=model)


class LLMGateway:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.keys = {f"key_{i}": k for i, k in enumerate(settings.api_keys, start=1)}
        if settings.cache_enabled:
            litellm.cache = Cache(type="local")

    async def _call(self, key: str, messages: list[dict], caching: bool):
        return await litellm.acompletion(
            model=self.settings.model,
            messages=messages,
            api_key=key,
            caching=caching,
            timeout=self.settings.request_timeout,
            num_retries=0,
        )

    async def complete(self, messages: list[dict], simulate: dict[str, int] | None = None) -> LLMResult:
        simulate = simulate or {}
        start = time.perf_counter()
        # A simulated-failure request always goes through the key pool (cache read bypassed)
        # so failover is demonstrable even for a message that is already cached.
        use_cache = self.settings.cache_enabled and not simulate
        attempts = 0
        for key_id, key in self.keys.items():
            status = simulate.get(key_id, simulate.get("*"))
            try:
                if status:
                    raise _simulated_error(status, self.settings.model)
                resp = await self._call(key, messages, caching=use_cache)
            except Exception as exc:  # any provider failure -> try next key
                log.warning("%s failed (%s: %s)", key_id, type(exc).__name__, str(exc)[:200])
                attempts += 1
                continue
            hit = bool(use_cache and (getattr(resp, "_hidden_params", None) or {}).get("cache_hit"))
            text = (resp.choices[0].message.content or "").strip()
            if not text:
                attempts += 1
                continue
            usage = resp.usage
            return LLMResult(
                reply=text,
                resolution_source="LLM_CACHE" if hit else "LIVE_INFERENCE",
                model=self.settings.model,
                latency_ms=int((time.perf_counter() - start) * 1000),
                input_tokens=int(usage.prompt_tokens),
                output_tokens=int(usage.completion_tokens),
                key_id=None if hit else key_id,
                fallback_attempts=0 if hit else attempts,
            )
        raise AllProvidersUnavailable()
