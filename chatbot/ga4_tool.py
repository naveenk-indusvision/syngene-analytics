"""
GA4 LangChain Tool - Fetches Google Analytics data on demand
"""
from langchain_core.tools import tool
from google.analytics.data_v1beta import BetaAnalyticsDataClient
from google.analytics.data_v1beta.types import (
    RunReportRequest,
    DateRange,
    Dimension,
    Metric,
    FilterExpression,
    Filter,
    OrderBy,
)
from google.oauth2 import service_account
import os
import pandas as pd
from datetime import datetime, timedelta
from dotenv import load_dotenv

load_dotenv()

# Available metrics and dimensions for reference
COMMON_METRICS = [
    "activeUsers", "totalUsers", "newUsers", "sessions", "screenPageViews",
    "bounceRate", "averageSessionDuration", "engagementRate", "eventCount",
    "conversions", "userEngagementDuration", "sessionsPerUser"
]

COMMON_DIMENSIONS = [
    "pagePath", "pageTitle", "country", "countryId", "city", "deviceCategory",
    "browser", "operatingSystem", "sessionSource", "sessionMedium", "date",
    "dateHour", "landingPage", "eventName", "region"
]


def get_ga4_client():
    """Initialize GA4 client with service account credentials."""
    import json as _json

    creds_json_str = os.getenv('GOOGLE_CREDENTIALS_JSON')
    if creds_json_str:
        info = _json.loads(creds_json_str)
        credentials = service_account.Credentials.from_service_account_info(
            info,
            scopes=['https://www.googleapis.com/auth/analytics.readonly']
        )
    else:
        creds_path = os.getenv('GOOGLE_APPLICATION_CREDENTIALS')
        credentials = service_account.Credentials.from_service_account_file(
            creds_path,
            scopes=['https://www.googleapis.com/auth/analytics.readonly']
        )
    return BetaAnalyticsDataClient(credentials=credentials)


def _normalize_date_range(start_date: str, end_date: str) -> tuple[str, str]:
    """Normalize date ranges to prevent accidental multi-day spans.

    Common issue: LLM passes 'yesterday,today' when user asks for 'yesterday',
    which actually spans 2 days in GA4 API. This fixes that.

    Rules:
    - 'yesterday,today' → 'yesterday,yesterday' (user meant yesterday only)
    - 'today,today' → 'today,today' (correct)
    - 'yesterday,yesterday' → 'yesterday,yesterday' (correct)
    - 'NdaysAgo,today' → unchanged (intentional range)
    - 'YYYY-MM-DD,YYYY-MM-DD' → unchanged
    """
    s = start_date.strip().lower()
    e = end_date.strip().lower()
    # If start is 'yesterday' and end is 'today', user almost certainly means yesterday only
    if s == "yesterday" and e == "today":
        return "yesterday", "yesterday"
    # If start is 'today' and end is 'today', that's fine
    return start_date.strip(), end_date.strip()


def _format_ga4_result(df: pd.DataFrame, output_format: str = "json", limit: int = 25) -> str:
    """Format GA4 DataFrame with row limit and optional JSON/CSV/markdown. Prefix for agent parsing."""
    df_limited = df.head(limit)
    if output_format == "csv":
        payload = df_limited.to_csv(index=False)
    elif output_format == "markdown":
        payload = df_limited.to_markdown(index=False)
    else:
        payload = df_limited.to_json(orient="records")
    prefix = "Data (list of records): " if output_format == "json" else "Data: "
    return prefix + payload + "\n\nAnalyze trends/comparisons and summarize for the user."


@tool
def query_ga4_report(
    dimensions: str,
    metrics: str,
    date_range: str = "30daysAgo,today",
    limit: int = 25,
    output_format: str = "json",
) -> str:
    """
    Fetch GA4 analytics data with specified dimensions and metrics.
    Multiple dimensions are supported for comparison/trend queries.

    Example - active users by country: dimensions='country', metrics='activeUsers', date_range='yesterday,today'
    For 'users by country and device': dimensions='country,deviceCategory', metrics='activeUsers', date_range='30daysAgo,today'

    Args:
        dimensions: Comma-separated dimension names (e.g., 'pagePath,country' or 'country,deviceCategory')
                   Available: pagePath, pageTitle, country, countryId (ISO code), city, region,
                   deviceCategory, browser, operatingSystem, sessionSource, sessionMedium, date
        metrics: Comma-separated metric names (e.g., 'activeUsers,sessions')
                Available: activeUsers, totalUsers, newUsers, sessions,
                screenPageViews, bounceRate, averageSessionDuration, engagementRate
        date_range: Start and end date separated by comma (e.g., '7daysAgo,today')
                   Formats: 'NdaysAgo', 'yesterday', 'today', or 'YYYY-MM-DD'
        limit: Max rows to return (default 25) for richer analysis context
        output_format: 'json' (default), 'csv', or 'markdown'

    Returns:
        Prefixed data string (JSON/CSV/markdown) for multi-column parsing
    """
    try:
        client = get_ga4_client()
        property_id = os.getenv('GA4_PROPERTY_ID')
        dim_list = [d.strip() for d in dimensions.split(',') if d.strip()]
        met_list = [m.strip() for m in metrics.split(',') if m.strip()]
        dates = date_range.split(',')
        start_date = dates[0].strip()
        end_date = dates[1].strip() if len(dates) > 1 else 'today'
        start_date, end_date = _normalize_date_range(start_date, end_date)
        request = RunReportRequest(
            property=f'properties/{property_id}',
            date_ranges=[DateRange(start_date=start_date, end_date=end_date)],
            dimensions=[Dimension(name=d) for d in dim_list],
            metrics=[Metric(name=m) for m in met_list]
        )
        response = client.run_report(request)
        if not response.rows:
            return "No data found for the specified query."
        data = []
        for row in response.rows:
            row_data = {}
            for i, dim in enumerate(dim_list):
                row_data[dim] = row.dimension_values[i].value
            for i, met in enumerate(met_list):
                value = row.metric_values[i].value
                if met in ['bounceRate', 'engagementRate']:
                    row_data[met] = f"{float(value) * 100:.1f}%"
                elif met == 'averageSessionDuration':
                    secs = float(value)
                    row_data[met] = f"{int(secs // 60)}m {int(secs % 60)}s"
                else:
                    row_data[met] = value
            data.append(row_data)
        df = pd.DataFrame(data)
        df.to_json('temp_ga4_data.json', orient='records', indent=2)
        return _format_ga4_result(df, output_format=output_format, limit=limit)
    except Exception as e:
        return f"Error fetching GA4 data: {str(e)}"


@tool
def list_available_metrics_and_dimensions() -> str:
    """
    List all commonly available GA4 metrics and dimensions.
    Use this to understand what data can be queried.
    
    Returns:
        List of available metrics and dimensions
    """
    result = "## Available GA4 Metrics\n"
    for metric in COMMON_METRICS:
        result += f"- {metric}\n"
    
    result += "\n## Available GA4 Dimensions\n"
    for dim in COMMON_DIMENSIONS:
        result += f"- {dim}\n"
    
    result += "\n## Example Queries\n"
    result += "- Top pages: dimensions='pagePath', metrics='activeUsers,screenPageViews'\n"
    result += "- Users by country and device: dimensions='country,deviceCategory', metrics='activeUsers'\n"
    result += "- Traffic sources: dimensions='sessionSource,sessionMedium', metrics='sessions,totalUsers'\n"
    result += "- Device breakdown: dimensions='deviceCategory', metrics='activeUsers,sessions'\n"
    result += "- Daily trend: dimensions='date', metrics='activeUsers,sessions,screenPageViews'\n"
    
    return result


@tool
def get_top_pages(limit: int = 25, date_range: str = "30daysAgo,today", output_format: str = "json") -> str:
    """
    Quick helper to get top pages by active users.

    Args:
        limit: Number of top pages to return (default 25)
        date_range: Date range (default '30daysAgo,today')
        output_format: 'json' (default), 'csv', or 'markdown'

    Returns:
        Prefixed data string (same format as query_ga4_report)
    """
    return query_ga4_report.invoke({
        "dimensions": "pagePath",
        "metrics": "activeUsers,screenPageViews,bounceRate,averageSessionDuration",
        "date_range": date_range,
        "limit": limit,
        "output_format": output_format,
    })


@tool
def get_traffic_overview(date_range: str = "30daysAgo,today") -> str:
    """
    Get a comprehensive traffic overview including sources, devices, and geography.
    
    Args:
        date_range: Date range (default '30daysAgo,today')
    
    Returns:
        Multi-section traffic overview
    """
    overview = "# Traffic Overview\n\n"
    
    # Traffic sources
    overview += "## Traffic Sources\n"
    overview += query_ga4_report.invoke({
        "dimensions": "sessionSource,sessionMedium",
        "metrics": "sessions,totalUsers,bounceRate",
        "date_range": date_range,
        "limit": 10,
        "output_format": "json",
    })
    overview += "\n\n## Device Breakdown\n"
    overview += query_ga4_report.invoke({
        "dimensions": "deviceCategory",
        "metrics": "activeUsers,sessions,screenPageViews",
        "date_range": date_range,
        "limit": 10,
        "output_format": "json",
    })
    overview += "\n\n## Top Countries\n"
    overview += query_ga4_report.invoke({
        "dimensions": "country",
        "metrics": "activeUsers,sessions",
        "date_range": date_range,
        "limit": 10,
        "output_format": "json",
    })
    
    return overview


def _blog_dimension_filter():
    """Filter for pagePath containing 'blog' (blog section)."""
    return FilterExpression(
        filter=Filter(
            field_name="pagePath",
            string_filter=Filter.StringFilter(
                match_type=Filter.StringFilter.MatchType.CONTAINS,
                value="blog",
            )
        )
    )


def _path_to_blog_label(page_path: str, max_len: int = 72) -> str:
    """Derive a readable blog label from pagePath when pageTitle is missing (e.g. segment after blog/)."""
    if not page_path or not isinstance(page_path, str):
        return page_path or ""
    path = page_path.strip().rstrip("/")
    # Prefer segment after last "blog/" (e.g. /resources/blogs/design-of-experiment-doe... -> design-of-experiment-doe...)
    if "blog" in path.lower():
        idx = path.lower().rfind("blog")
        after = path[idx:].split("/", 2)
        if len(after) >= 3:
            path = after[-1]
        elif len(after) == 2:
            path = after[1] if after[1] else path
    else:
        path = path.split("/")[-1] or path
    # Hyphens to spaces, strip
    label = path.replace("-", " ").strip()
    if len(label) > max_len:
        label = label[: max_len - 3].rstrip() + "..."
    return label or page_path[:max_len]


@tool
def get_top_blog_pages(limit: int = 25, date_range: str = "30daysAgo,today") -> str:
    """
    Get top blog pages only (pages whose URL path contains "blog", e.g. /blog/ or /resources/blogs/).
    Returns specific blogs with a clear identifier (title or slug) so you can show stats per blog.
    Use when the user asks about blogs, blog performance, or best performing blogs.

    Args:
        limit: Number of top blog pages to return (default 25)
        date_range: Date range (default '30daysAgo,today')
    
    Returns:
        Top blog pages with blog (title/slug), activeUsers, screenPageViews, bounceRate, averageSessionDuration
    """
    try:
        client = get_ga4_client()
        property_id = os.getenv('GA4_PROPERTY_ID')
        dates = date_range.split(',')
        start_date = dates[0].strip()
        end_date = dates[1].strip() if len(dates) > 1 else 'today'
        start_date, end_date = _normalize_date_range(start_date, end_date)
        request = RunReportRequest(
            property=f'properties/{property_id}',
            date_ranges=[DateRange(start_date=start_date, end_date=end_date)],
            dimensions=[
                Dimension(name='pagePath'),
                Dimension(name='pageTitle'),
            ],
            metrics=[
                Metric(name='activeUsers'),
                Metric(name='screenPageViews'),
                Metric(name='bounceRate'),
                Metric(name='averageSessionDuration'),
            ],
            dimension_filter=_blog_dimension_filter(),
            order_bys=[
                OrderBy(
                    metric=OrderBy.MetricOrderBy(metric_name="screenPageViews"),
                    desc=True,
                )
            ],
            limit=limit,
        )
        response = client.run_report(request)
        if not response.rows:
            return "No blog pages found (no page paths containing 'blog' in the selected date range)."
        data = []
        for row in response.rows:
            page_path = row.dimension_values[0].value or ""
            page_title = (row.dimension_values[1].value or "").strip()
            blog_label = page_title if page_title else _path_to_blog_label(page_path)
            row_data = {
                "blog": blog_label,
                "pagePath": page_path,
                "activeUsers": row.metric_values[0].value,
                "screenPageViews": row.metric_values[1].value,
                "bounceRate": f"{float(row.metric_values[2].value) * 100:.1f}%",
                "averageSessionDuration": _format_duration(float(row.metric_values[3].value)),
            }
            data.append(row_data)
        df = pd.DataFrame(data)
        return _format_ga4_result(df, output_format="json", limit=limit)
    except Exception as e:
        return f"Error fetching blog pages: {str(e)}"


def _format_duration(secs: float) -> str:
    """Format seconds as e.g. 2m 7s."""
    m = int(secs // 60)
    s = int(secs % 60)
    return f"{m}m {s}s"


def _resolve_period_dates(period: str) -> tuple[str, str]:
    """Convert a human-readable period name to exact YYYY-MM-DD start/end dates.

    Supported periods:
    - 'this_week'  : Monday of current week → today
    - 'last_week'  : Monday → Sunday of the previous week
    - 'this_month' : 1st of current month → today
    - 'last_month' : 1st → last day of previous month
    - 'last_7_days': 7 days ago → yesterday (complete days)
    - 'last_14_days': 14 days ago → yesterday
    - 'last_30_days': 30 days ago → yesterday
    - 'yesterday'  : yesterday → yesterday
    - 'today'      : today → today
    - 'YYYY-MM-DD,YYYY-MM-DD': pass-through exact dates
    """
    today = datetime.now().date()
    period_lower = period.strip().lower().replace(" ", "_")

    if period_lower == "this_week":
        # Monday of this week
        start = today - timedelta(days=today.weekday())
        return start.strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")
    elif period_lower == "last_week":
        # Monday to Sunday of previous week
        this_monday = today - timedelta(days=today.weekday())
        last_monday = this_monday - timedelta(days=7)
        last_sunday = this_monday - timedelta(days=1)
        return last_monday.strftime("%Y-%m-%d"), last_sunday.strftime("%Y-%m-%d")
    elif period_lower == "this_month":
        start = today.replace(day=1)
        return start.strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")
    elif period_lower == "last_month":
        first_this_month = today.replace(day=1)
        last_day_prev = first_this_month - timedelta(days=1)
        first_prev_month = last_day_prev.replace(day=1)
        return first_prev_month.strftime("%Y-%m-%d"), last_day_prev.strftime("%Y-%m-%d")
    elif period_lower == "last_7_days":
        return (today - timedelta(days=7)).strftime("%Y-%m-%d"), (today - timedelta(days=1)).strftime("%Y-%m-%d")
    elif period_lower == "last_14_days":
        return (today - timedelta(days=14)).strftime("%Y-%m-%d"), (today - timedelta(days=1)).strftime("%Y-%m-%d")
    elif period_lower == "last_30_days":
        return (today - timedelta(days=30)).strftime("%Y-%m-%d"), (today - timedelta(days=1)).strftime("%Y-%m-%d")
    elif period_lower == "yesterday":
        yday = (today - timedelta(days=1)).strftime("%Y-%m-%d")
        return yday, yday
    elif period_lower == "today":
        return today.strftime("%Y-%m-%d"), today.strftime("%Y-%m-%d")
    elif "," in period:
        # Exact dates passed through: "YYYY-MM-DD,YYYY-MM-DD"
        parts = period.split(",")
        return parts[0].strip(), parts[1].strip()
    else:
        # Fallback: treat as GA4 relative date
        return period.strip(), today.strftime("%Y-%m-%d")


@tool
def compare_periods(
    metrics: str,
    current_period: str = "this_week",
    previous_period: str = "last_week",
    dimensions: str = "",
    limit: int = 10,
) -> str:
    """
    Compare GA4 metrics between two time periods using exact calendar dates.
    Use this whenever the user asks to compare, e.g. "this week vs last week",
    "this month vs last month", "compare yesterday to last week".

    This tool handles all date math correctly — do NOT try to compute date offsets manually.

    Args:
        metrics: Comma-separated metric names (e.g., 'activeUsers,sessions')
        current_period: The recent period. Accepts: 'this_week', 'last_week', 'this_month',
                       'last_month', 'last_7_days', 'last_14_days', 'last_30_days',
                       'yesterday', 'today', or exact 'YYYY-MM-DD,YYYY-MM-DD'
        previous_period: The comparison period (same formats as current_period)
        dimensions: Optional comma-separated dimensions to group by (e.g., 'country')
        limit: Max rows per period (default 10)

    Returns:
        JSON with both periods' data and date ranges for accurate comparison
    """
    try:
        client = get_ga4_client()
        property_id = os.getenv('GA4_PROPERTY_ID')
        met_list = [m.strip() for m in metrics.split(',') if m.strip()]
        dim_list = [d.strip() for d in dimensions.split(',') if d.strip()] if dimensions else []

        curr_start, curr_end = _resolve_period_dates(current_period)
        prev_start, prev_end = _resolve_period_dates(previous_period)

        # Fetch current period
        request_curr = RunReportRequest(
            property=f'properties/{property_id}',
            date_ranges=[DateRange(start_date=curr_start, end_date=curr_end)],
            dimensions=[Dimension(name=d) for d in dim_list] if dim_list else [],
            metrics=[Metric(name=m) for m in met_list],
        )
        response_curr = client.run_report(request_curr)

        # Fetch previous period
        request_prev = RunReportRequest(
            property=f'properties/{property_id}',
            date_ranges=[DateRange(start_date=prev_start, end_date=prev_end)],
            dimensions=[Dimension(name=d) for d in dim_list] if dim_list else [],
            metrics=[Metric(name=m) for m in met_list],
        )
        response_prev = client.run_report(request_prev)

        def _parse_response(response, met_list, dim_list):
            data = []
            if not response.rows:
                return data
            for row in response.rows:
                row_data = {}
                for i, dim in enumerate(dim_list):
                    row_data[dim] = row.dimension_values[i].value
                for i, met in enumerate(met_list):
                    value = row.metric_values[i].value
                    if met in ['bounceRate', 'engagementRate']:
                        row_data[met] = f"{float(value) * 100:.1f}%"
                    elif met == 'averageSessionDuration':
                        secs = float(value)
                        row_data[met] = f"{int(secs // 60)}m {int(secs % 60)}s"
                    else:
                        row_data[met] = value
                data.append(row_data)
            return data

        curr_data = _parse_response(response_curr, met_list, dim_list)
        prev_data = _parse_response(response_prev, met_list, dim_list)

        result = {
            "current_period": {
                "label": current_period,
                "start": curr_start,
                "end": curr_end,
                "data": curr_data[:limit],
            },
            "previous_period": {
                "label": previous_period,
                "start": prev_start,
                "end": prev_end,
                "data": prev_data[:limit],
            },
        }

        # Calculate summary change for non-dimension queries
        if not dim_list and curr_data and prev_data:
            changes = {}
            for met in met_list:
                if met in ['bounceRate', 'engagementRate', 'averageSessionDuration']:
                    continue
                try:
                    curr_val = float(curr_data[0].get(met, 0))
                    prev_val = float(prev_data[0].get(met, 0))
                    if prev_val > 0:
                        pct_change = ((curr_val - prev_val) / prev_val) * 100
                        changes[met] = {
                            "current": curr_val,
                            "previous": prev_val,
                            "change_pct": f"{pct_change:+.1f}%",
                        }
                except (ValueError, TypeError, IndexError):
                    pass
            if changes:
                result["summary_changes"] = changes

        import json as _json
        return "Comparison data:\n" + _json.dumps(result, indent=2) + "\n\nPresent the comparison clearly with both periods, exact dates, numbers, and percentage changes."

    except Exception as e:
        return f"Error comparing periods: {str(e)}"


# Test function
if __name__ == "__main__":
    print("Testing GA4 Tool...")
    print("\nAvailable metrics and dimensions:")
    print(list_available_metrics_and_dimensions.invoke({}))
    print("\nFetching top pages:")
    print(query_ga4_report.invoke({
        "dimensions": "pagePath",
        "metrics": "activeUsers,sessions",
        "date_range": "7daysAgo,today"
    }))
