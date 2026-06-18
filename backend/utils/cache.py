from cachetools import TTLCache
import hashlib, json
from typing import Optional

_cache: TTLCache = TTLCache(maxsize=500, ttl=300)  # 5-min TTL

def cache_key(query: str, engine: str, mode: str) -> str:
    raw = json.dumps({'q': query.lower().strip(), 'e': engine, 'm': mode}, sort_keys=True)
    return hashlib.md5(raw.encode()).hexdigest()

def get_cached(key: str) -> Optional[dict]:
    return _cache.get(key)

def set_cached(key: str, value: dict) -> None:
    _cache[key] = value