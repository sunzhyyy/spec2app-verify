from typing import List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services.page_generator import MAX_FILE_CHARS, GenerationError, generate_page

router = APIRouter(prefix="/api/v1/generate", tags=["generate"])

STATUS_BY_CODE = {"timeout": 504, "quota_exhausted": 429}


class CurrentFiles(BaseModel):
    indexHtml: str = Field(..., max_length=MAX_FILE_CHARS)
    stylesCss: str = Field(..., max_length=MAX_FILE_CHARS)
    scriptJs: str = Field(..., max_length=MAX_FILE_CHARS)
    readme: str = Field(..., max_length=MAX_FILE_CHARS)


class GeneratePageRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=4000)
    history: List[str] = Field(default_factory=list, max_length=12)
    currentFiles: Optional[CurrentFiles] = None


@router.post("/page")
async def generate_page_route(data: GeneratePageRequest):
    prompt = data.prompt.strip()
    if not prompt:
        raise HTTPException(status_code=422, detail={"code": "invalid_request", "message": "Prompt is empty.", "providerInvoked": False})
    try:
        return await generate_page(
            prompt,
            [h[:500] for h in data.history],
            data.currentFiles.model_dump() if data.currentFiles else None,
        )
    except GenerationError as err:
        raise HTTPException(
            status_code=STATUS_BY_CODE.get(err.code, 502),
            detail={"code": err.code, "message": err.message, "providerInvoked": err.provider_invoked},
        ) from err
