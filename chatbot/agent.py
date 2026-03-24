"""
GA4 Analytics agent built with LangGraph.
- Chat: ReAct agent over GA4 tools with conversation memory (checkpointer).
- Quick action: standalone flow returning 5 recommendations as JSON (no graph).

SETUP PREREQUISITES:
- GCP: Create a service account with Viewer role, download JSON key, enable
  Google Analytics Data API for your project.
- GA4: Note your GA4 Property ID (Admin > Property settings).
- Env vars (e.g. in chatbot/.env):
  OPENAI_API_KEY          - OpenAI API key for the chat model
  OPENAI_CHAT_MODEL       - (Optional) Chat model name, default gpt-4o-mini (e.g. gpt-4-turbo-preview)
  GOOGLE_APPLICATION_CREDENTIALS - Path to the GCP service account JSON key file
  GA4_PROPERTY_ID         - Your GA4 property ID (numeric)
- Install: pip install langgraph langchain-openai google-analytics-data (langchain-core is pulled in by langchain-openai).
"""
import logging
import os
import json
import re
from typing import Annotated, Literal, Sequence, TypedDict

from dotenv import load_dotenv

log = logging.getLogger(__name__)

load_dotenv()

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage, AIMessage, ToolMessage
from langchain_core.runnables import RunnableConfig
from langchain_openai import ChatOpenAI
from langgraph.graph import StateGraph, END
from langgraph.graph.message import add_messages
from langgraph.checkpoint.memory import MemorySaver

from ga4_tool import (
    query_ga4_report,
    list_available_metrics_and_dimensions,
    get_top_pages,
    get_traffic_overview,
    get_top_blog_pages,
    compare_periods,
)

# ---- System prompt for the chat agent ----
CHAT_SYSTEM_PROMPT = """You are an expert analytics assistant for this website's Google Analytics (GA4) data.

SITE CONTEXT (use this to interpret pagePath and answer accurately):
- Homepage: /
- Key sections: /careers/, /contact-us/, and other main directories. These are not blog pages.
- Blogs: any page whose path contains "/blog/" (e.g. /home/blog/title, /blog/post-slug). Only these are "blog" pages.
- When the user asks about "blogs", "best performing blogs", or "blog performance", use the get_top_blog_pages tool and report only those results. Do not use get_top_pages for blog questions, and do not label homepage or /careers/ or /contact-us/ as blogs.

GREETINGS:
- If the user only sends a greeting (hi, hello, hey, what's up, etc.), respond in a friendly, brief way. For example: "Hi! Ask me anything about your analytics—traffic, top pages, sources, devices, or trends." Do not refuse or correct them.

BOUNDARIES (for non-greeting messages):
- Answer ONLY questions about this site's GA4 data (traffic, pages, sources, devices, geography, trends, bounce rate, etc.).
- If the user asks about anything else (general knowledge, other companies, off-topic, or non-analytics questions), respond briefly: "I can only answer questions about your analytics data. Ask me about traffic, top pages, sources, devices, or trends."
- If they ask for "recommendations" or "Quick action", say: "Use the Quick action on the Home tab for that. Here I only answer questions about your data."

You have access to these tools:
1. query_ga4_report - Fetch GA4 data with dimensions and metrics (supports multiple dimensions for comparison/trends)
2. list_available_metrics_and_dimensions - Show what can be queried
3. get_top_pages - Top pages by active users (all pages; use for general "top pages" questions)
4. get_traffic_overview - Traffic sources, devices, countries
5. get_top_blog_pages - Top blog pages only (paths containing "blog"); returns each row with a "blog" field (title or slug) for identifying specific blogs
6. compare_periods - Compare metrics between two time periods (e.g. this week vs last week). Handles all date math correctly. ALWAYS use this for any comparison/vs/change-over-time question.

PERIOD COMPARISON - CRITICAL:
- When the user asks to "compare", uses "vs", or asks about changes over time (e.g. "this week vs last week", "compare this month to last month", "how did traffic change"), ALWAYS use the compare_periods tool.
- NEVER try to compute date ranges manually for comparisons — the compare_periods tool handles all date math with exact calendar boundaries.
- Supported period names: 'this_week', 'last_week', 'this_month', 'last_month', 'last_7_days', 'last_14_days', 'last_30_days', 'yesterday', 'today', or exact 'YYYY-MM-DD,YYYY-MM-DD'
- Examples:
  - "compare this week to last week" → compare_periods(metrics='activeUsers,sessions', current_period='this_week', previous_period='last_week')
  - "this month vs last month for India" → compare_periods(metrics='activeUsers', current_period='this_month', previous_period='last_month', dimensions='country')

DATE RANGE (for single-period queries using query_ga4_report):
- "yesterday" → date_range='yesterday,yesterday' (single day, NOT yesterday,today which spans 2 days)
- "today" → date_range='today,today'
- "last 7 days" → date_range='7daysAgo,yesterday' (complete days only; exclude today as it's partial)
- "last 30 days" → date_range='30daysAgo,yesterday'
- "this week" → date_range='7daysAgo,today'
- "this month" → date_range='30daysAgo,today'
- If the user does not specify a time period, default to '30daysAgo,today'.
- NEVER use 'yesterday,today' — that spans 2 days and inflates numbers.

AVAILABLE DIMENSIONS (use the exact GA4 name):
- Geography: country (full name, e.g. "India"), countryId (ISO code, e.g. "IN"), city, region
- Pages: pagePath, pageTitle, landingPage
- Technology: deviceCategory, browser, operatingSystem
- Traffic: sessionSource, sessionMedium
- Time: date, dateHour
- Events: eventName
When the user says "country id" or "country code", use dimension='countryId'. When they say "country" use dimension='country'.

MULTI-COLUMN / COMPARISON QUERIES (few-shot):
- Query: users by country and device -> Use query_ga4_report with dimensions='country,deviceCategory', metrics='activeUsers'. Summarize as a pivot-style comparison (e.g. top countries, then by device).
- Query: compare traffic sources and devices -> Use dimensions='sessionSource,deviceCategory', metrics='sessions,activeUsers'. Highlight top combinations.
- Query: activeUsers by pagePath and deviceCategory -> Use dimensions='pagePath,deviceCategory', metrics='activeUsers', limit=25. Summarize top page-device combinations.

BLOGS VS OTHER PAGES:
- For "blogs", "best performing blogs", "blog performance", "top blog posts": use get_top_blog_pages. The tool returns a "blog" column (page title or slug from the path). When reporting, list specific blogs by that name (e.g. "1) Design of Experiment (DOE) — 453 users, 696 views, 96.2% bounce. 2) ..."). Do not use truncated pagePath; use the "blog" field so users see which specific blog each row is.
- For "top pages", "best pages", "most visited pages", or general performance: use get_top_pages. Do not call that list "blogs" unless the paths actually contain /blog/.

TOP 5 DEFAULT:
- When answering about rankings or lists (top pages, traffic sources, countries, devices, browsers, etc.), show the top 5 by default unless the user explicitly asks for a different number (e.g. "top 3", "top 10", "show me 7").

ANALYSIS QUALITY:
- Always include specific numbers (users, sessions, percentages) — never give vague answers like "high traffic" without data.
- When reporting percentages like bounce rate, compare them to common benchmarks (e.g. bounce rate above 70% is high, 40-60% is average, below 40% is good).
- When showing trends or comparisons, highlight the most significant findings: biggest changes, outliers, and anomalies.
- If the data seems incomplete or unexpected (e.g. zero sessions, unusually low numbers), mention this to the user rather than presenting it as normal.
- Cross-reference related metrics when relevant (e.g. a page with high views but high bounce rate signals content issues).

FORMATTING:
- Use markdown tables for data with 3+ rows and 2+ columns — they are supported by the UI.
- For short lists (1-2 items), use numbered lists or bullet points.
- Always include a brief insight or takeaway after presenting data, not just raw numbers.
- Bold key numbers and percentages for readability."""


# ---- LangGraph state ----
# add_messages is LangGraph's recommended reducer for message state (merges/deduplicates by ID; operator.add would just concatenate).
class AgentState(TypedDict, total=False):
    """State for the ReAct agent: messages with reducer; optional routing and pandas state."""
    messages: Annotated[Sequence[BaseMessage], add_messages]
    query_complexity: str  # "simple" | "multi_column"
    last_dataframe_json: str


# ---- Tools and model ----
TOOLS = [
    query_ga4_report,
    list_available_metrics_and_dimensions,
    get_top_pages,
    get_traffic_overview,
    get_top_blog_pages,
    compare_periods,
]

TOOLS_BY_NAME = {t.name: t for t in TOOLS}

# Keywords that suggest multi-dimension / comparison analysis (route to pandas_node after tools).
MULTI_COLUMN_KEYWORDS = (
    "compare", "comparison", "versus", "vs", "vs.",
    "trends across", "breakdown by", "broken down by", "break down by",
    "by country and device", "by device and country", "by source and device",
    "pivot", "multi-column", "cross-tab",
    "across countries", "across devices", "across sources", "across browsers",
    "by country, device", "country and device", "device and country",
    "per country", "per device", "per source", "per browser",
    "split by", "segment by", "group by",
    "correlation", "relationship between",
)

# Pattern: "by X and Y", "X by Y", "X vs Y", "X versus Y"
_MULTI_COL_PATTERNS = [
    re.compile(r"\bby\s+\w+\s+and\s+\w+", re.IGNORECASE),
    re.compile(r"\b(compare|comparison)\b.*\b(and|vs\.?|versus|with)\b", re.IGNORECASE),
    re.compile(r"\b\w+\s+vs\.?\s+\w+", re.IGNORECASE),
    re.compile(r"\b(traffic|users|sessions|views)\s+(by|per|across)\s+\w+\s+(and|,)\s+\w+", re.IGNORECASE),
]


def _classify_query_complexity(text: str) -> Literal["simple", "multi_column"]:
    """Classify user query as simple (single metric/top N) vs multi_column (compare, trends, multiple dimensions)."""
    if not text or not isinstance(text, str):
        return "simple"
    lower = text.lower().strip()
    if any(kw in lower for kw in MULTI_COLUMN_KEYWORDS):
        return "multi_column"
    if any(p.search(text) for p in _MULTI_COL_PATTERNS):
        return "multi_column"
    return "simple"


def _router_node(state: AgentState) -> dict:
    """Run before agent: set query_complexity from latest user message."""
    messages = state.get("messages") or []
    query_complexity = "simple"
    for m in reversed(messages):
        if isinstance(m, HumanMessage) and hasattr(m, "content") and m.content:
            query_complexity = _classify_query_complexity(m.content if isinstance(m.content, str) else str(m.content))
            break
    log.info("router → query_complexity=%s", query_complexity)
    return {"query_complexity": query_complexity}


def _get_llm():
    """Chat model with tools bound. Model name from OPENAI_CHAT_MODEL (default gpt-4o-mini)."""
    model = os.getenv("OPENAI_CHAT_MODEL", "gpt-4o-mini")
    llm = ChatOpenAI(
        model=model,
        temperature=0,
        api_key=os.getenv("OPENAI_API_KEY"),
    )
    return llm.bind_tools(TOOLS)


# ---- Graph nodes ----
def _call_model(state: AgentState, config: RunnableConfig) -> dict:
    """Agent node: invoke LLM with system prompt and current message history."""
    llm = _get_llm()
    system = SystemMessage(content=CHAT_SYSTEM_PROMPT)
    response = llm.invoke([system] + list(state["messages"]), config)
    return {"messages": [response]}


# Custom tool node (use langgraph.prebuilt.ToolNode(TOOLS) when available, e.g. langgraph-prebuilt package).
def _validate_tool_result(content: str, tool_name: str) -> str:
    """Validate tool results and add warnings for suspicious data."""
    if not content or content.startswith("Error:") or "No data found" in content:
        return content
    # Check for empty or near-empty data sets
    if content.startswith("Data (list of records): "):
        try:
            data_part = content.split("Data (list of records): ", 1)[1]
            data_part = data_part.split("\n\nAnalyze")[0]
            records = json.loads(data_part)
            if isinstance(records, list):
                if len(records) == 0:
                    return "No data found for the specified query."
                # Warn about suspiciously low numbers
                warnings = []
                for rec in records:
                    for key, val in rec.items():
                        if key in ("activeUsers", "totalUsers", "sessions") and str(val) == "0":
                            warnings.append(f"Warning: {key} is 0 for some rows — data may be incomplete.")
                            break
                    if warnings:
                        break
                if warnings:
                    content = content + "\n\n" + " ".join(set(warnings))
        except (json.JSONDecodeError, IndexError):
            pass
    return content


def _tool_node(state: AgentState) -> dict:
    """Execute tool calls from the last AI message and return ToolMessages."""
    last = state["messages"][-1]
    if not isinstance(last, AIMessage) or not last.tool_calls:
        return {"messages": []}
    tool_names = [tc.get("name", getattr(tc, "name", "")) for tc in last.tool_calls if isinstance(tc, dict)] or [getattr(tc, "name", "") for tc in last.tool_calls]
    log.info("tools → invoking: %s", tool_names)
    outputs = []
    for tc in last.tool_calls:
        name = tc["name"] if isinstance(tc, dict) else getattr(tc, "name", "")
        args = (tc.get("args") or {}) if isinstance(tc, dict) else getattr(tc, "args", {}) or {}
        tool_call_id = (tc.get("id") or "") if isinstance(tc, dict) else getattr(tc, "id", "")
        if name not in TOOLS_BY_NAME:
            content = f"Unknown tool: {name}"
        else:
            try:
                result = TOOLS_BY_NAME[name].invoke(args)
                content = result if isinstance(result, str) else json.dumps(result)
                content = _validate_tool_result(content, name)
            except Exception as e:
                content = f"Error: {str(e)}"
        outputs.append(
            ToolMessage(content=content, tool_call_id=tool_call_id, name=name)
        )
    return {"messages": outputs}


def _should_continue(state: AgentState) -> str:
    """Route: if last message has tool_calls go to tools, else end."""
    last = state["messages"][-1]
    if isinstance(last, AIMessage) and last.tool_calls:
        return "tools"
    return "end"


def _after_tools_route(state: AgentState) -> Literal["pandas", "retry", "agent"]:
    """After tools: route to pandas_node (multi_column + data), retry_node (error), or back to agent."""
    messages = state.get("messages") or []
    if not messages:
        return "agent"
    last = messages[-1]
    if not isinstance(last, ToolMessage):
        return "agent"
    content = (last.content or "").strip()
    if content.startswith("Error:") or "No data found" in content or "No blog pages found" in content:
        log.info("after_tools → retry (error or no data)")
        return "retry"
    complexity = state.get("query_complexity") or "simple"
    if complexity == "multi_column" and (content.startswith("Data") or content.startswith("[")):
        log.info("after_tools → pandas_node (multi_column + data)")
        return "pandas"
    log.info("after_tools → agent")
    return "agent"


def _pandas_node(state: AgentState) -> dict:
    """Parse last ToolMessage as JSON/CSV into DataFrame, run LLM analysis, append AIMessage and set last_dataframe_json."""
    import pandas as pd
    messages = state.get("messages") or []
    if not messages:
        return {}
    last = messages[-1]
    if not isinstance(last, ToolMessage):
        return {}
    content = (last.content or "").strip()
    log.info("pandas_node → parsing tool response, content_len=%s", len(content))
    # Strip prefix like "Data (list of records): " or "Data: "
    for prefix in ("Data (list of records): ", "Data: "):
        if content.startswith(prefix):
            content = content[len(prefix):].strip()
            break
    if content.endswith("\n\nAnalyze trends/comparisons and summarize for the user."):
        content = content[:-len("\n\nAnalyze trends/comparisons and summarize for the user.")].strip()
    try:
        if content.strip().startswith("["):
            df = pd.read_json(content)
        else:
            from io import StringIO
            df = pd.read_csv(StringIO(content))
    except Exception:
        return {"messages": [AIMessage(content="Could not parse the data for analysis. Here is the raw response: " + (last.content or "")[:500])]}
    df_json = df.to_json(orient="records")
    # Get original user question from last HumanMessage
    user_question = ""
    for m in reversed(messages):
        if isinstance(m, HumanMessage) and hasattr(m, "content") and m.content:
            user_question = m.content if isinstance(m.content, str) else str(m.content)
            break
    llm = ChatOpenAI(model=os.getenv("OPENAI_CHAT_MODEL", "gpt-4o-mini"), temperature=0, api_key=os.getenv("OPENAI_API_KEY"))
    table_preview = df.head(20).to_string() if len(df) > 0 else "Empty table"
    prompt = f"""Data columns: [{', '.join(df.columns.tolist())}]. Total rows: {len(df)}. Here is the GA4 data:

{table_preview}

The user asked: {user_question}

Provide a thorough analysis:
1. Answer the user's specific question with exact numbers.
2. Highlight the top segments and any outliers or anomalies.
3. Note meaningful comparisons (e.g. mobile vs desktop, top country vs others).
4. If bounce rates or engagement rates are included, evaluate whether they are good or concerning.
5. End with a brief actionable takeaway.
Use markdown tables if the data has 3+ rows. Use bold for key numbers."""
    response = llm.invoke(prompt)
    analysis = getattr(response, "content", str(response))
    log.info("pandas_node → analysis done, len=%s", len(analysis))
    return {
        "messages": [AIMessage(content=analysis)],
        "last_dataframe_json": df_json,
    }


def _retry_node(state: AgentState) -> dict:
    """On tool error: append a note and return to agent (user can rephrase or simplify)."""
    log.info("retry_node → appending rephrase suggestion")
    note = "The last GA4 query returned an error or no data. Try rephrasing (e.g. shorter date range, or ask for top pages only)."
    return {"messages": [HumanMessage(content=note)]}


# ---- Build and compile graph ----
def _build_graph():
    workflow = StateGraph(AgentState)
    workflow.add_node("router", _router_node)
    workflow.add_node("agent", _call_model)
    workflow.add_node("tools", _tool_node)
    workflow.add_node("pandas_node", _pandas_node)
    workflow.add_node("retry_node", _retry_node)
    workflow.set_entry_point("router")
    workflow.add_edge("router", "agent")
    workflow.add_conditional_edges("agent", _should_continue, {"tools": "tools", "end": END})
    workflow.add_conditional_edges("tools", _after_tools_route, {"pandas": "pandas_node", "retry": "retry_node", "agent": "agent"})
    workflow.add_edge("pandas_node", "agent")
    workflow.add_edge("retry_node", "agent")
    compile_kwargs = {"checkpointer": MemorySaver()}
    if os.getenv("INTERRUPT_BEFORE_FINAL_REPLY", "").lower() in ("1", "true", "yes"):
        compile_kwargs["interrupt_before"] = ["agent"]
    return workflow.compile(**compile_kwargs)


# ---- Public API (same as before for api.py) ----
def create_chat_agent():
    """Create the chat agent (compiled LangGraph with memory).

    The returned graph supports both .invoke(...) and .stream(...). Use
    app.stream({"messages": [HumanMessage(content='...')]}, config=config)
    to stream state updates (agent/tool messages) for debugging.
    """
    return _build_graph()


def chat(executor, user_input: str, thread_id: str = "default") -> str:
    """Send a message to the chat agent and get the final reply. For streaming (e.g. debugging), use executor.stream(...) instead of invoke."""
    try:
        config = RunnableConfig(configurable={"thread_id": thread_id})
        result = executor.invoke(
            {"messages": [HumanMessage(content=user_input.strip())]},
            config=config,
        )
        messages = result.get("messages") or []
        for m in reversed(messages):
            if isinstance(m, AIMessage) and not m.tool_calls:
                return m.content or "No response generated."
        return "No response generated."
    except Exception as e:
        return f"Error: {str(e)}"


# ---- Quick action: standalone (unchanged behavior) ----
QUICK_ACTION_SYSTEM = """You are a senior web analytics consultant. Analyze GA4 traffic data and output exactly 5 actionable, specific recommendations.

Based ONLY on the GA4 data provided below, output a single valid JSON object and nothing else. No markdown, no code fences, no extra text.

Format (use double quotes, escape inner quotes):
{"items": [{"title": "Short title (3-6 words)", "description": "One clear, specific sentence with a concrete action and the data point that supports it"}, ...]}

QUALITY RULES:
- Each recommendation MUST reference specific numbers from the data (e.g. "Bounce rate on /careers/ is 82%—add clearer CTAs").
- Be specific: name exact pages, sources, or devices from the data. Never say "some pages" or "certain sources".
- Prioritize the most impactful issues: high-traffic pages with poor engagement, major traffic sources with high bounce, device categories with low session duration.
- Each recommendation must be distinct—do not repeat the same advice in different words.
- Include exactly 5 items."""


def run_quick_action() -> str:
    """Fetch GA4 overview and return 5 recommendations as JSON string."""
    try:
        data_str = get_traffic_overview.invoke({"date_range": "30daysAgo,today"})
    except Exception as e:
        return json.dumps({"items": [], "error": str(e)})

    llm = ChatOpenAI(
        model=os.getenv("OPENAI_CHAT_MODEL", "gpt-4o"),
        temperature=0,
        api_key=os.getenv("OPENAI_API_KEY"),
    )
    messages = [
        SystemMessage(content=QUICK_ACTION_SYSTEM),
        HumanMessage(content=f"GA4 data:\n\n{data_str}"),
    ]
    response = llm.invoke(messages)
    text = (response.content or "").strip()
    if text.startswith("```"):
        lines = text.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)
    return text


# ---- Suggested follow-up questions ----
SUGGESTED_QUESTIONS_PROMPT = """You help suggest follow-up questions for an analytics chat.

Given the conversation so far and the topics already discussed (if any), suggest exactly 3 short follow-up questions the user might ask. Rules:
- Only suggest questions about GA4 analytics data (traffic, pages, sources, devices, geography, bounce rate, engagement, etc.).
- Prefer questions that build on the conversation or explore related areas not yet covered.
- Keep each question under 10 words where possible. No quotes or punctuation at the end.
- Return ONLY valid JSON, no other text: {"questions": ["Question one?", "Question two?", "Question three?"], "topics_discussed": "Brief comma-separated summary of topics covered in this conversation (e.g. top pages, bounce rate, traffic sources)"}
- topics_discussed should grow: merge any previous topics with new ones from the latest exchange."""


def get_suggested_questions(messages: list, topics_discussed: str = "") -> dict:
    """Return { questions: [str, str, str], topics_discussed: str } from conversation and optional previous topics."""
    llm = ChatOpenAI(
        model="gpt-4o-mini",
        temperature=0,
        api_key=os.getenv("OPENAI_API_KEY"),
    )
    conv = ""
    for m in messages:
        role = "User" if m.get("role") == "user" else "Assistant"
        conv += f"{role}: {m.get('content', '')}\n"
    if not conv.strip():
        return {
            "questions": [
                "What are my top pages by traffic?",
                "Where does my traffic come from?",
                "How is my bounce rate?",
            ],
            "topics_discussed": "",
        }
    user_content = f"Conversation:\n{conv}\n"
    if topics_discussed:
        user_content += f"Topics discussed so far: {topics_discussed}\n"
    user_content += "\nOutput JSON only:"
    response = llm.invoke([
        SystemMessage(content=SUGGESTED_QUESTIONS_PROMPT),
        HumanMessage(content=user_content),
    ])
    text = (response.content or "").strip()
    if text.startswith("```"):
        lines = text.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        text = "\n".join(lines)
    try:
        obj = json.loads(text)
        q = obj.get("questions") or []
        t = obj.get("topics_discussed") or ""
        if not isinstance(q, list) or len(q) < 3:
            q = (q + ["What are my top pages?", "Where does my traffic come from?", "How is my bounce rate?"])[:3]
        return {"questions": q[:3], "topics_discussed": t}
    except Exception:
        return {
            "questions": [
                "What are my top pages by traffic?",
                "Where does my traffic come from?",
                "How is my bounce rate?",
            ],
            "topics_discussed": topics_discussed or "",
        }


def create_ga4_agent():
    return create_chat_agent()


if __name__ == "__main__":
    print("LangGraph chat agent...")
    graph = create_chat_agent()
    print(chat(graph, "What are my top 3 pages?", thread_id="test"))
    print("\nQuick action...")
    print(run_quick_action()[:200] + "...")
