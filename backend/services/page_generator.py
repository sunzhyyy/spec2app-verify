"""Server-side AI webpage generation.

Two provider paths share one prompt and one validator:
  * OpenAI-compatible provider, used when AI_API_KEY and AI_BASE_URL are set.
  * Atoms AI Hub (built-in), used otherwise; model from AI_MODEL (default gpt-5.4).
Provider keys are read from the server environment only and never returned or logged.
"""

import asyncio
import json
import logging
import os
import re
import time
import uuid
from typing import Any, Dict, List, Optional

from schemas.aihub import ChatMessage, GenTxtRequest
from services.aihub import AIHubService

logger = logging.getLogger(__name__)

PROVIDER_TIMEOUT_SECONDS = float(os.environ.get("AI_TIMEOUT_SECONDS", "170"))
MAX_FILE_CHARS = 60_000
REQUIRED_FIELDS = ["title", "summary", "indexHtml", "stylesCss", "scriptJs", "readme", "generationNotes"]
FILE_FIELDS = {"indexHtml": "index.html", "stylesCss": "styles.css", "scriptJs": "script.js", "readme": "README.md"}
CODE_FIELDS = ["indexHtml", "stylesCss", "scriptJs"]

SYSTEM_PROMPT = """You are a senior front-end engineer who generates complete, runnable, single-page web applications from a natural-language idea.
Return ONLY one JSON object (no prose, no Markdown) with these string fields: title, summary, indexHtml, stylesCss, scriptJs, readme, generationNotes.
Rules:
- indexHtml: a complete HTML5 document. Include <link rel="stylesheet" href="styles.css"> in <head> and <script src="script.js"></script> at the end of <body>. Do not put inline <script> or <style> blocks in indexHtml.
- stylesCss: all CSS. scriptJs: all JavaScript as plain ES2020 (no modules, imports, frameworks, CDNs, external URLs or network requests).
- The page runs in a sandboxed iframe (sandbox="allow-scripts", opaque origin). localStorage, sessionStorage, cookies, alert, confirm, prompt, window.open and top-level navigation are unavailable. Show messages inline in the DOM.
- Persist user data ONLY through the host bridge: `const saved = await window.AppStorage.load();` returns the previously saved JSON value or null, and `window.AppStorage.save(state)` stores a JSON-serialisable value under 100 KB. Call save after every data change. Initialise inside an async function and render defaults when load returns null.
- Forms: listen for the 'submit' event and call event.preventDefault(); the host dispatches submit events for submit buttons and Enter key presses.
- Implement every requested interaction with real working logic (adding, editing, deleting, filtering, calculating, validation, visible UI updates). No placeholder content, lorem ipsum or TODOs.
- Responsive, accessible (labels, focus states, sufficient contrast) and visually polished.
- Never wrap any field value in Markdown code fences. readme is Markdown describing the page and how to use it. generationNotes is 1-3 sentences about key decisions.
- For a follow-up edit you receive the current files: return the COMPLETE updated files (not diffs) and keep existing working features unless the request changes them.
- Keep the total output compact (well under 12000 tokens)."""


class GenerationError(Exception):
    """Provider or validation failure with a stable, user-facing code."""

    def __init__(self, code: str, message: str, provider_invoked: bool):
        super().__init__(message)
        self.code = code
        self.message = message
        self.provider_invoked = provider_invoked


def build_messages(prompt: str, history: List[str], current_files: Optional[Dict[str, str]]) -> List[Dict[str, str]]:
    parts: List[str] = []
    if history:
        parts.append("Earlier prompts in this project (oldest first):\n" + "\n".join(f"- {h[:500]}" for h in history[-6:]))
    if current_files:
        for field, name in FILE_FIELDS.items():
            parts.append(f"<current-file name=\"{name}\">\n{current_files.get(field, '')}\n</current-file>")
        parts.append(f"Follow-up change request: {prompt}")
    else:
        parts.append(f"Webpage request: {prompt}")
    return [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": "\n\n".join(parts)}]


def _strip_fence(value: str) -> str:
    text = value.strip()
    match = re.match(r"^```[a-zA-Z0-9_-]*\s*\n(.*?)\n?```$", text, re.S)
    return match.group(1).strip() if match else text


def parse_provider_content(raw: str) -> Dict[str, str]:
    text = (raw or "").strip()
    if not text:
        raise GenerationError("empty_content", "The model returned an empty response.", True)
    text = _strip_fence(text)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise GenerationError("malformed_json", "The model response did not contain a JSON object.", True)
    try:
        data: Any = json.loads(text[start : end + 1])
    except json.JSONDecodeError as exc:
        raise GenerationError("malformed_json", f"The model returned malformed JSON ({exc.msg}).", True) from exc
    if not isinstance(data, dict):
        raise GenerationError("schema_invalid", "The model response was not a JSON object.", True)

    missing_files = [FILE_FIELDS[f] for f in FILE_FIELDS if f not in data]
    if missing_files:
        raise GenerationError("missing_files", f"Missing generated files: {', '.join(missing_files)}.", True)
    missing = [f for f in REQUIRED_FIELDS if f not in data]
    if missing:
        raise GenerationError("schema_invalid", f"Missing fields: {', '.join(missing)}.", True)

    result: Dict[str, str] = {}
    for field in REQUIRED_FIELDS:
        value = data[field]
        if field == "generationNotes" and isinstance(value, list):
            value = " ".join(str(v) for v in value)
        if not isinstance(value, str):
            raise GenerationError("schema_invalid", f"Field '{field}' must be a string.", True)
        result[field] = _strip_fence(value) if field in FILE_FIELDS else value.strip()

    for field, name in FILE_FIELDS.items():
        if not result[field]:
            raise GenerationError("empty_content", f"Generated {name} is empty.", True)
        if len(result[field]) > MAX_FILE_CHARS:
            raise GenerationError("schema_invalid", f"Generated {name} exceeds {MAX_FILE_CHARS} characters.", True)
    for field in CODE_FIELDS:
        if "```" in result[field]:
            raise GenerationError("schema_invalid", f"Generated {FILE_FIELDS[field]} contains Markdown fences.", True)
    if not re.search(r"<[a-zA-Z][^>]*>", result["indexHtml"]):
        raise GenerationError("schema_invalid", "Generated index.html contains no HTML elements.", True)
    if not result["title"]:
        raise GenerationError("schema_invalid", "Generated title is empty.", True)
    result["title"] = result["title"][:120]
    result["summary"] = result["summary"][:600]
    result["generationNotes"] = result["generationNotes"][:1000]
    return result


def _classify(exc: Exception) -> GenerationError:
    text = str(exc).lower()
    if isinstance(exc, (asyncio.TimeoutError, TimeoutError)) or "timeout" in text or "timed out" in text:
        return GenerationError("timeout", "The AI provider timed out. Retry, or use a saved fallback example.", True)
    if any(k in text for k in ("quota", "429", "402", "insufficient", "rate limit", "balance")):
        return GenerationError("quota_exhausted", "The AI provider quota is exhausted or rate-limited.", True)
    return GenerationError("provider_unavailable", f"The AI provider is unavailable ({type(exc).__name__}).", True)


async def _call_openai_compatible(messages: List[Dict[str, str]], key: str, base: str, model: str) -> str:
    import httpx

    try:
        async with httpx.AsyncClient(timeout=PROVIDER_TIMEOUT_SECONDS) as http:
            response = await http.post(
                base.rstrip("/") + "/chat/completions",
                headers={"Authorization": f"Bearer {key}"},
                json={"model": model, "messages": messages, "temperature": 0.4},
            )
    except httpx.TimeoutException as exc:
        raise GenerationError("timeout", "The AI provider timed out.", True) from exc
    except httpx.HTTPError as exc:
        raise GenerationError("provider_unavailable", f"Could not reach the AI provider ({type(exc).__name__}).", True) from exc
    if response.status_code in (402, 429):
        raise GenerationError("quota_exhausted", f"The AI provider rejected the request (HTTP {response.status_code}).", True)
    if response.status_code >= 400:
        raise GenerationError("provider_unavailable", f"The AI provider returned HTTP {response.status_code}.", True)
    try:
        return response.json()["choices"][0]["message"]["content"] or ""
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise GenerationError("malformed_json", "The AI provider returned an unexpected response envelope.", True) from exc


async def call_provider(messages: List[Dict[str, str]]) -> Dict[str, str]:
    key = os.environ.get("AI_API_KEY")
    base = os.environ.get("AI_BASE_URL")
    if key and base:
        model = os.environ.get("AI_MODEL") or "gpt-4o-mini"
        return {"content": await _call_openai_compatible(messages, key, base, model), "provider": f"openai-compatible:{model}"}
    model = os.environ.get("AI_MODEL") or "gpt-5.4"
    request = GenTxtRequest(
        messages=[ChatMessage(role=m["role"], content=m["content"]) for m in messages],
        model=model,
        temperature=0.4,
        max_tokens=16000,
    )
    try:
        response = await asyncio.wait_for(AIHubService().gentxt(request), PROVIDER_TIMEOUT_SECONDS)
    except GenerationError:
        raise
    except Exception as exc:  # provider SDK errors vary; classify without leaking details
        logger.warning("AI provider failure: %s", type(exc).__name__)
        raise _classify(exc) from exc
    return {"content": response.content or "", "provider": f"atoms-aihub:{model}"}


async def generate_page(prompt: str, history: List[str], current_files: Optional[Dict[str, str]]) -> Dict[str, Any]:
    started = time.monotonic()
    request_id = uuid.uuid4().hex[:12]
    messages = build_messages(prompt, history, current_files)
    provider_result = await call_provider(messages)
    files = parse_provider_content(provider_result["content"])
    logger.info("page generation %s ok in %.1fs via %s", request_id, time.monotonic() - started, provider_result["provider"])
    return {
        **files,
        "generationMode": "live",
        "providerInvoked": True,
        "provider": provider_result["provider"],
        "receivedPrompt": prompt,
        "requestId": request_id,
        "durationMs": int((time.monotonic() - started) * 1000),
    }
