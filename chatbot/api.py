"""
FastAPI API for GA4 Analytics.
- POST /chat → chat agent (data Q&A only).
- POST /quick-action → recommendations only (returns JSON).
Run: uvicorn api:app --reload --port 8000
"""
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] %(levelname)s %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
log = logging.getLogger(__name__)
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from agent import create_chat_agent, chat as agent_chat, run_quick_action, get_suggested_questions

_chat_agent = None


def get_chat_agent():
    global _chat_agent
    if _chat_agent is None:
        _chat_agent = create_chat_agent()
    return _chat_agent


@asynccontextmanager
async def lifespan(app: FastAPI):
    yield
    global _chat_agent
    _chat_agent = None


app = FastAPI(title="GA4 Analytics API", lifespan=lifespan)

_default_origins = ["http://localhost:3000", "http://127.0.0.1:3000"]
_cors_origins_env = os.getenv("CORS_ORIGINS", "")
_cors_origins = [o.strip() for o in _cors_origins_env.split(",") if o.strip()] if _cors_origins_env else _default_origins

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ChatRequest(BaseModel):
    message: str


class ChatResponse(BaseModel):
    response: str


class SuggestedRequest(BaseModel):
    messages: list = []
    topics_discussed: str = ""


class SuggestedResponse(BaseModel):
    questions: list
    topics_discussed: str


@app.post("/chat", response_model=ChatResponse)
def chat(request: ChatRequest):
    """Chat agent: answers only questions about the user's GA4 data. The graph also supports .stream() for debugging (stream state updates)."""
    msg = request.message.strip()
    log.info("chat request: message=%s", repr(msg[:200]) + ("..." if len(msg) > 200 else ""))
    executor = get_chat_agent()
    response_text = agent_chat(executor, msg)
    log.info("chat done: response_len=%s", len(response_text))
    return ChatResponse(response=response_text)


@app.post("/quick-action", response_model=ChatResponse)
def quick_action():
    """Recommendations agent: returns 5 actionable items as JSON (no chat, no memory)."""
    log.info("quick-action request")
    response_text = run_quick_action()
    log.info("quick-action done: response_len=%s", len(response_text))
    return ChatResponse(response=response_text)


@app.post("/suggested-questions", response_model=SuggestedResponse)
def suggested_questions(request: SuggestedRequest):
    """Generate 3 follow-up questions from conversation and optional topics (stored, growing)."""
    messages = request.messages or []
    topics = request.topics_discussed or ""
    log.info("suggested-questions request: messages=%s topics_len=%s", len(messages), len(topics))
    out = get_suggested_questions(messages, topics)
    log.info("suggested-questions done: questions=%s", len(out.get("questions", [])))
    return SuggestedResponse(questions=out["questions"], topics_discussed=out.get("topics_discussed", ""))


@app.get("/health")
def health():
    return {"status": "ok"}
