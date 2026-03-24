import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import axios from 'axios';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend,
} from 'recharts';

const API_BASE = process.env.REACT_APP_API_BASE || 'http://localhost:3001';

const DEFAULT_SUGGESTED_QUESTIONS = [
  'What are my top pages by traffic?',
  'Where does my traffic come from?',
  'How is my bounce rate?',
];

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const ACCENT = '#2563eb';
const ACCENT_LIGHT = '#eff6ff';
const BORDER = '#e5e7eb';
const MUTED = '#6b7280';
const CHART_COLORS = ['#2563eb', '#7c3aed', '#059669', '#d97706', '#dc2626', '#0891b2', '#be185d', '#4f46e5'];

/* ─── helpers ─── */
function parseQuickActionJson(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let str = raw.trim();
  const codeBlock = str.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) str = codeBlock[1].trim();
  const obj = str.match(/\{[\s\S]*\}/);
  if (obj) {
    try {
      const data = JSON.parse(obj[0]);
      if (Array.isArray(data.items)) return data;
    } catch (_) {}
  }
  return null;
}

function ga4RowsToTable(report) {
  if (!report || !report.rows || !report.dimensionHeaders || !report.metricHeaders) return [];
  const dimNames = (report.dimensionHeaders || []).map(h => h.name);
  const metNames = (report.metricHeaders || []).map(h => h.name);
  return report.rows.map(row => {
    const out = {};
    (row.dimensionValues || []).forEach((d, i) => { out[dimNames[i] || `dim_${i}`] = d.value; });
    (row.metricValues || []).forEach((m, i) => { out[metNames[i] || `met_${i}`] = m.value; });
    return out;
  });
}

function fmtNum(n) {
  const v = Number(n);
  if (isNaN(v)) return n;
  if (v >= 1000000) return (v / 1000000).toFixed(1) + 'M';
  if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
  return v.toLocaleString();
}

function fmtPct(v) {
  const n = Number(v);
  return isNaN(n) ? v : (n * 100).toFixed(1) + '%';
}

function fmtDate(d) {
  if (!d || d.length !== 8) return d;
  return d.slice(4, 6) + '/' + d.slice(6, 8);
}

const RECENT_INSIGHTS_KEY = 'analytics_recent_insights';
function loadRecentInsights() { try { const r = localStorage.getItem(RECENT_INSIGHTS_KEY); return r ? JSON.parse(r) : null; } catch (_) { return null; } }
function saveRecentInsights(parsed) { try { if (parsed?.items?.length) localStorage.setItem(RECENT_INSIGHTS_KEY, JSON.stringify({ items: parsed.items, updatedAt: new Date().toISOString() })); } catch (_) {} }

/* ─── icons ─── */
function IconClose() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>; }
function IconSend() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" /></svg>; }
function IconHome() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" /><polyline points="9 22 9 12 15 12 15 22" /></svg>; }
function IconChat() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>; }
function IconDashboard() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></svg>; }
function IconFab() { return <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>; }
function IconChevron() { return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9" /></svg>; }
function IconTrendUp() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2.5"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" /></svg>; }
function IconTrendDown() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2.5"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6" /><polyline points="17 18 23 18 23 12" /></svg>; }
function IconRefresh() { return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>; }

/* ─── Markdown renderer for chat ─── */
function MarkdownMessage({ content }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        table: ({ children }) => (
          <div style={{ overflowX: 'auto', margin: '8px 0' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, lineHeight: 1.4 }}>{children}</table>
          </div>
        ),
        thead: ({ children }) => <thead style={{ background: '#f8fafc' }}>{children}</thead>,
        th: ({ children }) => <th style={{ padding: '6px 8px', borderBottom: `2px solid ${BORDER}`, textAlign: 'left', fontSize: 11, fontWeight: 600, color: MUTED, whiteSpace: 'nowrap' }}>{children}</th>,
        td: ({ children }) => <td style={{ padding: '5px 8px', borderBottom: `1px solid ${BORDER}`, fontSize: 12 }}>{children}</td>,
        p: ({ children }) => <p style={{ margin: '6px 0', lineHeight: 1.5 }}>{children}</p>,
        ul: ({ children }) => <ul style={{ margin: '6px 0', paddingLeft: 18 }}>{children}</ul>,
        ol: ({ children }) => <ol style={{ margin: '6px 0', paddingLeft: 18 }}>{children}</ol>,
        li: ({ children }) => <li style={{ marginBottom: 3, lineHeight: 1.45 }}>{children}</li>,
        strong: ({ children }) => <strong style={{ fontWeight: 600, color: '#111' }}>{children}</strong>,
        h1: ({ children }) => <div style={{ fontSize: 15, fontWeight: 700, margin: '10px 0 6px', color: '#111' }}>{children}</div>,
        h2: ({ children }) => <div style={{ fontSize: 14, fontWeight: 600, margin: '8px 0 4px', color: '#111' }}>{children}</div>,
        h3: ({ children }) => <div style={{ fontSize: 13, fontWeight: 600, margin: '6px 0 3px', color: '#374151' }}>{children}</div>,
        code: ({ inline, children }) => inline
          ? <code style={{ background: '#f1f5f9', padding: '1px 4px', borderRadius: 3, fontSize: 12, fontFamily: 'monospace' }}>{children}</code>
          : <pre style={{ background: '#f1f5f9', padding: 8, borderRadius: 6, fontSize: 12, overflowX: 'auto', fontFamily: 'monospace', margin: '6px 0' }}><code>{children}</code></pre>,
      }}
    >
      {content}
    </ReactMarkdown>
  );
}

/* ─── KPI card ─── */
function KpiCard({ label, value, change, icon }) {
  const isPositive = change != null && change >= 0;
  return (
    <div style={{ background: '#fff', borderRadius: 12, padding: '14px 14px 12px', border: `1px solid ${BORDER}`, boxShadow: '0 1px 3px rgba(0,0,0,0.05)', flex: '1 1 0', minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 500, color: MUTED, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: '#111', lineHeight: 1.2 }}>{value}</div>
      {change != null && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, marginTop: 4, fontSize: 11, fontWeight: 600, color: isPositive ? '#059669' : '#dc2626' }}>
          {isPositive ? <IconTrendUp /> : <IconTrendDown />}
          {Math.abs(change).toFixed(1)}% vs prior
        </div>
      )}
    </div>
  );
}

/* ─── Mini chart component ─── */
function TrafficSparkline({ data }) {
  if (!data?.length) return null;
  return (
    <div style={{ background: '#fff', borderRadius: 12, padding: '12px 10px 6px', border: `1px solid ${BORDER}`, boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 6, paddingLeft: 4 }}>Daily active users (30d)</div>
      <ResponsiveContainer width="100%" height={100}>
        <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
          <defs>
            <linearGradient id="sparkGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={ACCENT} stopOpacity={0.3} />
              <stop offset="100%" stopColor={ACCENT} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <XAxis dataKey="date" tick={{ fontSize: 9, fill: MUTED }} tickFormatter={fmtDate} interval="preserveStartEnd" axisLine={false} tickLine={false} />
          <YAxis tick={{ fontSize: 9, fill: MUTED }} axisLine={false} tickLine={false} tickFormatter={fmtNum} />
          <Tooltip contentStyle={{ fontSize: 12, borderRadius: 8, border: `1px solid ${BORDER}` }} labelFormatter={fmtDate} formatter={(v) => [fmtNum(v), 'Users']} />
          <Area type="monotone" dataKey="activeUsers" stroke={ACCENT} strokeWidth={2} fill="url(#sparkGrad)" dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ─── styles ─── */
const wrapStyle = { position: 'fixed', bottom: 20, right: 20, zIndex: 9999, fontFamily: FONT };
const fabStyle = { width: 52, height: 52, borderRadius: '50%', background: ACCENT, color: '#fff', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 2px 12px rgba(37,99,235,0.4)' };
const panelStyle = { position: 'absolute', bottom: 60, right: 0, width: 400, maxWidth: 'calc(100vw - 40px)', height: 600, maxHeight: '85vh', borderRadius: 16, border: `1px solid ${BORDER}`, boxShadow: '0 12px 32px rgba(0,0,0,0.12)', display: 'flex', flexDirection: 'column', background: '#fafbfc', overflow: 'hidden' };
const headerStyle = { flexShrink: 0, padding: '14px 16px', borderBottom: `1px solid ${BORDER}`, background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'space-between' };
const closeBtnStyle = { background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: MUTED, lineHeight: 1 };
const bodyScrollStyle = { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: 14, WebkitOverflowScrolling: 'touch' };
const bodyStyle = { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' };
const navStyle = { flexShrink: 0, display: 'flex', borderTop: `1px solid ${BORDER}`, background: '#fff' };
const navBtnStyle = { flex: 1, padding: '10px 0', border: 'none', background: 'none', cursor: 'pointer', fontSize: 12, color: MUTED, fontFamily: FONT, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 };
const navBtnActiveStyle = { ...navBtnStyle, color: ACCENT, fontWeight: 600 };
const sectionTitleStyle = { fontSize: 11, fontWeight: 600, color: MUTED, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8, marginTop: 16 };
const chatAreaStyle = { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '12px 14px', WebkitOverflowScrolling: 'touch' };
const inputRowStyle = { flexShrink: 0, display: 'flex', gap: 8, padding: '10px 14px', borderTop: `1px solid ${BORDER}`, background: '#fff' };
const inputStyle = { flex: 1, padding: '10px 12px', borderRadius: 10, border: `1px solid ${BORDER}`, fontSize: 14, outline: 'none', fontFamily: FONT };
const sendBtnStyle = { width: 40, height: 40, borderRadius: 10, background: ACCENT, color: '#fff', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 1px 3px rgba(37,99,235,0.3)' };
const cardStyle = { background: '#fff', borderRadius: 12, padding: '12px 14px', border: `1px solid ${BORDER}`, boxShadow: '0 1px 3px rgba(0,0,0,0.05)', marginBottom: 8 };

/* ─── MAIN WIDGET ─── */
function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState('home');
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [quickActionResult, setQuickActionResult] = useState(null);
  const [quickActionLoading, setQuickActionLoading] = useState(false);
  const [recentInsights, setRecentInsights] = useState(() => loadRecentInsights());
  const [analyticsData, setAnalyticsData] = useState(null);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [blogData, setBlogData] = useState(null);
  const [blogLoading, setBlogLoading] = useState(false);
  const quickActionFetchedRef = useRef(false);
  const analyticsFetchedRef = useRef(false);
  const messagesEndRef = useRef(null);
  const [suggestedQuestionsList, setSuggestedQuestionsList] = useState(DEFAULT_SUGGESTED_QUESTIONS);
  const suggestedTopicsRef = useRef('');

  /* ── data fetching ── */
  const runQuickAction = useCallback(async () => {
    if (quickActionLoading) return;
    setQuickActionLoading(true);
    setQuickActionResult(null);
    try {
      const { data } = await axios.post(`${API_BASE}/api/quick-action`);
      const raw = data.response || '';
      setQuickActionResult(raw);
      const parsed = parseQuickActionJson(raw);
      if (parsed) { saveRecentInsights(parsed); setRecentInsights(loadRecentInsights()); }
    } catch (err) {
      setQuickActionResult('Error: ' + (err.response?.data?.error || err.message || 'Request failed'));
    } finally { setQuickActionLoading(false); }
  }, [quickActionLoading]);

  const fetchAnalytics = useCallback(async () => {
    if (analyticsLoading) return;
    setAnalyticsLoading(true);
    try {
      const { data } = await axios.get(`${API_BASE}/api/analytics`);
      setAnalyticsData(data);
    } catch (_) { setAnalyticsData(null); }
    finally { setAnalyticsLoading(false); }
  }, [analyticsLoading]);

  // Fetch analytics + quick action on open
  useEffect(() => {
    if (!open) { quickActionFetchedRef.current = false; analyticsFetchedRef.current = false; return; }
    if (!analyticsFetchedRef.current) { analyticsFetchedRef.current = true; fetchAnalytics(); }
    if (view === 'home' && quickActionResult === null && !quickActionLoading && !quickActionFetchedRef.current) {
      quickActionFetchedRef.current = true; runQuickAction();
    }
  }, [open, view, quickActionResult, quickActionLoading, runQuickAction, fetchAnalytics]);

  useEffect(() => {
    if (view !== 'dashboard' || !open) return;
    setBlogLoading(true);
    axios.get(`${API_BASE}/api/analytics/blogs`)
      .then(({ data }) => setBlogData(data))
      .catch(() => setBlogData(null))
      .finally(() => setBlogLoading(false));
  }, [view, open]);

  /* ── chat ── */
  const sendMessage = useCallback(async (text) => {
    const trimmed = (text ?? input).trim();
    if (!trimmed || loading) return;
    setInput('');
    setMessages(m => [...m, { role: 'user', content: trimmed }]);
    setLoading(true);
    try {
      const { data } = await axios.post(`${API_BASE}/api/chat`, { message: trimmed });
      setMessages(m => [...m, { role: 'assistant', content: data.response || '' }]);
    } catch (err) {
      setMessages(m => [...m, { role: 'assistant', content: 'Error: ' + (err.response?.data?.error || err.message || 'Request failed') }]);
    } finally { setLoading(false); }
  }, [input, loading]);

  const handleKeyDown = useCallback((e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }, [sendMessage]);
  const goHome = useCallback(() => setView('home'), []);
  const goChat = useCallback(() => setView('chat'), []);
  const goDashboard = useCallback(() => setView('dashboard'), []);
  const toggleOpen = useCallback(() => setOpen(o => !o), []);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  const quickActionParsed = useMemo(() => quickActionResult != null ? parseQuickActionJson(quickActionResult) : null, [quickActionResult]);

  useEffect(() => {
    if (view !== 'chat' || loading) return;
    if (messages.length === 0) { setSuggestedQuestionsList(DEFAULT_SUGGESTED_QUESTIONS); suggestedTopicsRef.current = ''; return; }
    axios.post(`${API_BASE}/api/suggested-questions`, {
      messages: messages.map(m => ({ role: m.role, content: m.content })),
      topics_discussed: suggestedTopicsRef.current,
    }).then(({ data }) => {
      if (data.questions?.length) { setSuggestedQuestionsList(data.questions.slice(0, 3)); if (data.topics_discussed != null) suggestedTopicsRef.current = data.topics_discussed; }
    }).catch(() => {});
  }, [view, loading, messages]);

  /* ── derived data for charts ── */
  const trendData = useMemo(() => {
    if (!analyticsData?.trend) return [];
    return ga4RowsToTable(analyticsData.trend).map(r => ({
      date: r.date, activeUsers: Number(r.activeUsers) || 0, sessions: Number(r.sessions) || 0, views: Number(r.screenPageViews) || 0,
    })).sort((a, b) => a.date.localeCompare(b.date));
  }, [analyticsData]);

  const deviceData = useMemo(() => {
    if (!analyticsData?.devices) return [];
    return ga4RowsToTable(analyticsData.devices).map(r => ({ name: r.deviceCategory, value: Number(r.activeUsers) || 0 }));
  }, [analyticsData]);

  const geoData = useMemo(() => {
    if (!analyticsData?.geography) return [];
    return ga4RowsToTable(analyticsData.geography).map(r => ({ country: r.country, users: Number(r.activeUsers) || 0 })).sort((a, b) => b.users - a.users).slice(0, 8);
  }, [analyticsData]);

  const sourceData = useMemo(() => {
    if (!analyticsData?.sources) return [];
    return ga4RowsToTable(analyticsData.sources).map(r => ({
      source: (r.sessionSource || '(direct)') + ' / ' + (r.sessionMedium || '(none)'),
      sessions: Number(r.sessions) || 0,
      bounceRate: Number(r.bounceRate) || 0,
    })).sort((a, b) => b.sessions - a.sessions).slice(0, 8);
  }, [analyticsData]);

  const topPages = useMemo(() => {
    if (!analyticsData?.pages) return [];
    return ga4RowsToTable(analyticsData.pages).map(r => ({
      page: r.pagePath, users: Number(r.activeUsers) || 0, views: Number(r.screenPageViews) || 0,
      bounce: Number(r.bounceRate) || 0, duration: Number(r.averageSessionDuration) || 0,
    })).sort((a, b) => b.users - a.users).slice(0, 10);
  }, [analyticsData]);

  const kpis = useMemo(() => {
    if (!trendData.length) return null;
    const total = (key) => trendData.reduce((s, r) => s + (r[key] || 0), 0);
    const mid = Math.floor(trendData.length / 2);
    const firstHalf = trendData.slice(0, mid);
    const secondHalf = trendData.slice(mid);
    const halfSum = (arr, key) => arr.reduce((s, r) => s + (r[key] || 0), 0);
    const pctChange = (key) => { const p = halfSum(firstHalf, key); const c = halfSum(secondHalf, key); return p > 0 ? ((c - p) / p) * 100 : null; };
    return {
      users: fmtNum(total('activeUsers')), sessions: fmtNum(total('sessions')), views: fmtNum(total('views')),
      usersChange: pctChange('activeUsers'), sessionsChange: pctChange('sessions'), viewsChange: pctChange('views'),
    };
  }, [trendData]);

  /* ── render ── */
  if (!open) {
    return (
      <div style={wrapStyle}>
        <button type="button" style={fabStyle} onClick={toggleOpen} aria-label="Open"><IconFab /></button>
      </div>
    );
  }

  return (
    <div style={wrapStyle}>
      <div style={panelStyle}>
        {/* Header */}
        <header style={headerStyle}>
          <span style={{ fontSize: 15, fontWeight: 700, color: '#111' }}>
            {view === 'home' ? '📊 Analytics' : view === 'dashboard' ? '📈 Dashboard' : '💬 Chat'}
          </span>
          <button type="button" style={closeBtnStyle} onClick={toggleOpen} aria-label="Close"><IconClose /></button>
        </header>

        {/* Body */}
        <div style={view === 'chat' ? bodyStyle : bodyScrollStyle}>

          {/* ═══ HOME VIEW ═══ */}
          {view === 'home' && (
            <>
              {/* KPI row */}
              {kpis && (
                <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                  <KpiCard label="Users" value={kpis.users} change={kpis.usersChange} />
                  <KpiCard label="Sessions" value={kpis.sessions} change={kpis.sessionsChange} />
                  <KpiCard label="Views" value={kpis.views} change={kpis.viewsChange} />
                </div>
              )}

              {/* Traffic sparkline */}
              {trendData.length > 0 && <TrafficSparkline data={trendData} />}

              {/* Quick actions */}
              <div style={sectionTitleStyle}>Quick insights</div>
              {quickActionLoading && <div style={{ fontSize: 13, color: MUTED, padding: 8 }}>Analyzing your data…</div>}
              {!quickActionLoading && quickActionParsed && (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {quickActionParsed.items.map((item, idx) => (
                      <div key={idx} style={cardStyle}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: '#111', marginBottom: 3 }}>{item.title}</div>
                        <div style={{ fontSize: 12, lineHeight: 1.45, color: '#4b5563' }}>{item.description}</div>
                      </div>
                    ))}
                  </div>
                  <button type="button" style={{ fontSize: 12, color: ACCENT, background: 'none', border: 'none', cursor: 'pointer', padding: '8px 0', fontFamily: FONT, display: 'flex', alignItems: 'center', gap: 4 }} onClick={runQuickAction}>
                    <IconRefresh /> Refresh insights
                  </button>
                </>
              )}
              {!quickActionLoading && !quickActionParsed && quickActionResult && (
                <div style={cardStyle}><div style={{ fontSize: 13, color: '#374151', whiteSpace: 'pre-wrap' }}>{quickActionResult}</div></div>
              )}

              <div style={sectionTitleStyle}>Ask anything</div>
              <button type="button" style={{ display: 'block', width: '100%', padding: '12px 16px', textAlign: 'left', fontSize: 14, fontWeight: 500, color: '#111', background: '#fff', border: `1px solid ${BORDER}`, borderRadius: 12, cursor: 'pointer', fontFamily: FONT, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }} onClick={goChat}>
                Ask a question about your data →
              </button>
            </>
          )}

          {/* ═══ DASHBOARD VIEW ═══ */}
          {view === 'dashboard' && (
            <>
              {analyticsLoading && <div style={{ fontSize: 13, color: MUTED, padding: 16, textAlign: 'center' }}>Loading dashboard data…</div>}

              {!analyticsLoading && analyticsData && (
                <>
                  {/* KPI row */}
                  {kpis && (
                    <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
                      <KpiCard label="Users" value={kpis.users} change={kpis.usersChange} />
                      <KpiCard label="Sessions" value={kpis.sessions} change={kpis.sessionsChange} />
                      <KpiCard label="Views" value={kpis.views} change={kpis.viewsChange} />
                    </div>
                  )}

                  {/* Traffic trend */}
                  {trendData.length > 0 && (
                    <div style={{ ...cardStyle, padding: '12px 8px 4px' }}>
                      <div style={{ ...sectionTitleStyle, marginTop: 0, paddingLeft: 8 }}>Traffic trend (30d)</div>
                      <ResponsiveContainer width="100%" height={140}>
                        <AreaChart data={trendData} margin={{ top: 4, right: 8, bottom: 0, left: -16 }}>
                          <defs>
                            <linearGradient id="gradUsers" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={ACCENT} stopOpacity={0.25} /><stop offset="100%" stopColor={ACCENT} stopOpacity={0.02} /></linearGradient>
                            <linearGradient id="gradSessions" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#7c3aed" stopOpacity={0.2} /><stop offset="100%" stopColor="#7c3aed" stopOpacity={0.02} /></linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                          <XAxis dataKey="date" tick={{ fontSize: 9, fill: MUTED }} tickFormatter={fmtDate} interval="preserveStartEnd" axisLine={false} tickLine={false} />
                          <YAxis tick={{ fontSize: 9, fill: MUTED }} axisLine={false} tickLine={false} tickFormatter={fmtNum} />
                          <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8, border: `1px solid ${BORDER}` }} labelFormatter={fmtDate} formatter={(v, name) => [fmtNum(v), name === 'activeUsers' ? 'Users' : 'Sessions']} />
                          <Area type="monotone" dataKey="activeUsers" stroke={ACCENT} strokeWidth={2} fill="url(#gradUsers)" dot={false} name="activeUsers" />
                          <Area type="monotone" dataKey="sessions" stroke="#7c3aed" strokeWidth={1.5} fill="url(#gradSessions)" dot={false} name="sessions" />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  )}

                  {/* Device + Geography row */}
                  <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                    {/* Devices pie */}
                    {deviceData.length > 0 && (
                      <div style={{ ...cardStyle, flex: 1, padding: '10px 6px 4px', marginBottom: 0 }}>
                        <div style={{ ...sectionTitleStyle, marginTop: 0, paddingLeft: 6 }}>Devices</div>
                        <ResponsiveContainer width="100%" height={120}>
                          <PieChart>
                            <Pie data={deviceData} cx="50%" cy="50%" innerRadius={25} outerRadius={45} paddingAngle={2} dataKey="value" nameKey="name" label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`} labelLine={false}
                              style={{ fontSize: 9 }}>
                              {deviceData.map((_, i) => <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                            </Pie>
                            <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8 }} formatter={(v) => fmtNum(v)} />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                    )}

                    {/* Top countries bar */}
                    {geoData.length > 0 && (
                      <div style={{ ...cardStyle, flex: 1.2, padding: '10px 6px 4px', marginBottom: 0 }}>
                        <div style={{ ...sectionTitleStyle, marginTop: 0, paddingLeft: 6 }}>Top countries</div>
                        <ResponsiveContainer width="100%" height={120}>
                          <BarChart data={geoData.slice(0, 5)} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
                            <XAxis type="number" tick={{ fontSize: 9, fill: MUTED }} axisLine={false} tickLine={false} tickFormatter={fmtNum} />
                            <YAxis type="category" dataKey="country" tick={{ fontSize: 9, fill: '#374151' }} width={60} axisLine={false} tickLine={false} />
                            <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8 }} formatter={(v) => [fmtNum(v), 'Users']} />
                            <Bar dataKey="users" fill={ACCENT} radius={[0, 4, 4, 0]} barSize={14} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </div>

                  {/* Traffic sources */}
                  {sourceData.length > 0 && (
                    <div style={{ ...cardStyle, marginTop: 8, padding: '10px 6px 4px' }}>
                      <div style={{ ...sectionTitleStyle, marginTop: 0, paddingLeft: 6 }}>Top sources</div>
                      <ResponsiveContainer width="100%" height={140}>
                        <BarChart data={sourceData.slice(0, 6)} layout="vertical" margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
                          <XAxis type="number" tick={{ fontSize: 9, fill: MUTED }} axisLine={false} tickLine={false} tickFormatter={fmtNum} />
                          <YAxis type="category" dataKey="source" tick={{ fontSize: 8, fill: '#374151' }} width={100} axisLine={false} tickLine={false} />
                          <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8 }} formatter={(v) => [fmtNum(v), 'Sessions']} />
                          <Bar dataKey="sessions" fill="#7c3aed" radius={[0, 4, 4, 0]} barSize={14} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  )}

                  {/* Top pages table */}
                  {topPages.length > 0 && (
                    <div style={{ ...cardStyle, marginTop: 8, padding: '10px 10px 6px' }}>
                      <div style={{ ...sectionTitleStyle, marginTop: 0 }}>Top pages</div>
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                          <thead>
                            <tr>
                              <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: `2px solid ${BORDER}`, color: MUTED, fontWeight: 600, fontSize: 10 }}>Page</th>
                              <th style={{ textAlign: 'right', padding: '4px 6px', borderBottom: `2px solid ${BORDER}`, color: MUTED, fontWeight: 600, fontSize: 10 }}>Users</th>
                              <th style={{ textAlign: 'right', padding: '4px 6px', borderBottom: `2px solid ${BORDER}`, color: MUTED, fontWeight: 600, fontSize: 10 }}>Bounce</th>
                            </tr>
                          </thead>
                          <tbody>
                            {topPages.map((r, i) => (
                              <tr key={i}>
                                <td style={{ padding: '4px 6px', borderBottom: `1px solid #f3f4f6`, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.page}>{r.page}</td>
                                <td style={{ padding: '4px 6px', borderBottom: `1px solid #f3f4f6`, textAlign: 'right', fontWeight: 500 }}>{fmtNum(r.users)}</td>
                                <td style={{ padding: '4px 6px', borderBottom: `1px solid #f3f4f6`, textAlign: 'right', color: r.bounce > 0.7 ? '#dc2626' : r.bounce > 0.5 ? '#d97706' : '#059669' }}>{fmtPct(r.bounce)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* Blog performance */}
                  <div style={{ ...sectionTitleStyle, marginTop: 16 }}>Blog performance</div>
                  {blogLoading && <div style={{ fontSize: 13, color: MUTED, padding: 8 }}>Loading blog data…</div>}
                  {!blogLoading && blogData?.blogs && (() => {
                    const rows = ga4RowsToTable(blogData.blogs);
                    if (!rows.length) return <div style={{ fontSize: 13, color: MUTED }}>No blog pages found.</div>;
                    return (
                      <div style={{ ...cardStyle, padding: '10px 10px 6px' }}>
                        <div style={{ overflowX: 'auto' }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                            <thead>
                              <tr>
                                <th style={{ textAlign: 'left', padding: '4px 6px', borderBottom: `2px solid ${BORDER}`, color: MUTED, fontWeight: 600, fontSize: 10 }}>Blog</th>
                                <th style={{ textAlign: 'right', padding: '4px 6px', borderBottom: `2px solid ${BORDER}`, color: MUTED, fontWeight: 600, fontSize: 10 }}>Users</th>
                                <th style={{ textAlign: 'right', padding: '4px 6px', borderBottom: `2px solid ${BORDER}`, color: MUTED, fontWeight: 600, fontSize: 10 }}>Views</th>
                                <th style={{ textAlign: 'right', padding: '4px 6px', borderBottom: `2px solid ${BORDER}`, color: MUTED, fontWeight: 600, fontSize: 10 }}>Bounce</th>
                              </tr>
                            </thead>
                            <tbody>
                              {rows.slice(0, 10).map((r, i) => (
                                <tr key={i}>
                                  <td style={{ padding: '4px 6px', borderBottom: `1px solid #f3f4f6`, maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.pagePath}>{r.pagePath}</td>
                                  <td style={{ padding: '4px 6px', borderBottom: `1px solid #f3f4f6`, textAlign: 'right', fontWeight: 500 }}>{r.activeUsers || '—'}</td>
                                  <td style={{ padding: '4px 6px', borderBottom: `1px solid #f3f4f6`, textAlign: 'right' }}>{r.screenPageViews || '—'}</td>
                                  <td style={{ padding: '4px 6px', borderBottom: `1px solid #f3f4f6`, textAlign: 'right' }}>{r.bounceRate != null ? fmtPct(r.bounceRate) : '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })()}
                </>
              )}
            </>
          )}

          {/* ═══ CHAT VIEW ═══ */}
          {view === 'chat' && (
            <>
              <div style={chatAreaStyle}>
                {messages.length === 0 && (
                  <div style={{ textAlign: 'center', padding: '30px 10px' }}>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>💬</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: '#111', marginBottom: 4 }}>Ask about your analytics</div>
                    <div style={{ fontSize: 12, color: MUTED }}>Traffic, top pages, sources, devices, trends, comparisons…</div>
                  </div>
                )}
                {messages.map((msg, i) => {
                  if (msg.role === 'user') {
                    return (
                      <div key={i} style={{ marginBottom: 10, maxWidth: '88%', marginLeft: 'auto' }}>
                        <div style={{ padding: '10px 14px', borderRadius: 14, borderBottomRightRadius: 4, background: ACCENT, color: '#fff', fontSize: 14, lineHeight: 1.4, boxShadow: '0 1px 2px rgba(37,99,235,0.2)' }}>{msg.content}</div>
                      </div>
                    );
                  }
                  return (
                    <div key={i} style={{ marginBottom: 10, maxWidth: '92%' }}>
                      <div style={{ padding: '10px 14px', borderRadius: 14, borderBottomLeftRadius: 4, background: '#fff', color: '#1e293b', fontSize: 13, lineHeight: 1.5, border: `1px solid ${BORDER}`, boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
                        <MarkdownMessage content={msg.content} />
                      </div>
                    </div>
                  );
                })}
                {loading && <div style={{ fontSize: 12, color: MUTED, fontStyle: 'italic', padding: '8px 0' }}>Thinking…</div>}
                <div ref={messagesEndRef} />
                {!loading && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 10 }}>
                    {suggestedQuestionsList.map((q, idx) => (
                      <button key={idx} type="button"
                        style={{ padding: '7px 12px', borderRadius: 20, fontSize: 12, color: ACCENT, background: ACCENT_LIGHT, border: `1px solid rgba(37,99,235,0.25)`, cursor: 'pointer', fontFamily: FONT, maxWidth: '100%', lineHeight: 1.3 }}
                        onClick={() => sendMessage(q)}>{q}</button>
                    ))}
                  </div>
                )}
              </div>
              <div style={inputRowStyle}>
                <input style={inputStyle} placeholder="Ask about your analytics…" value={input} onChange={e => setInput(e.target.value)} onKeyDown={handleKeyDown} disabled={loading} />
                <button type="button" style={sendBtnStyle} onClick={() => sendMessage()} disabled={loading} aria-label="Send"><IconSend /></button>
              </div>
            </>
          )}
        </div>

        {/* Nav */}
        <nav style={navStyle}>
          <button type="button" style={view === 'home' ? navBtnActiveStyle : navBtnStyle} onClick={goHome}><IconHome /><span>Home</span></button>
          <button type="button" style={view === 'dashboard' ? navBtnActiveStyle : navBtnStyle} onClick={goDashboard}><IconDashboard /><span>Dashboard</span></button>
          <button type="button" style={view === 'chat' ? navBtnActiveStyle : navBtnStyle} onClick={goChat}><IconChat /><span>Chat</span></button>
        </nav>
      </div>

      <button type="button" style={fabStyle} onClick={toggleOpen} aria-label="Close"><IconChevron /></button>
    </div>
  );
}

export default ChatWidget;
