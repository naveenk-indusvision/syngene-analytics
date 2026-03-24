const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { BetaAnalyticsDataClient, protos } = require('@google-analytics/data');

const CHAT_API_URL = process.env.CHAT_API_URL || 'http://127.0.0.1:8000';

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

const app = express();
const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(s => s.trim())
  : '*';
app.use(cors({ origin: corsOrigin }));
app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => {
  const bodySummary = req.body && Object.keys(req.body).length
    ? ` body=${JSON.stringify(req.body).slice(0, 120)}${JSON.stringify(req.body).length > 120 ? '...' : ''}`
    : '';
  log(`→ ${req.method} ${req.path}${bodySummary}`);
  next();
});

// Load GCP credentials from env var (for deployment) or file (for local dev)
if (process.env.GOOGLE_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tmpFile = path.join(os.tmpdir(), 'gcp-credentials.json');
  fs.writeFileSync(tmpFile, process.env.GOOGLE_CREDENTIALS_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpFile;
}

const client = new BetaAnalyticsDataClient();

// Keep chatbot warm by pinging its health endpoint every 5 minutes
setInterval(() => {
  fetch(`${CHAT_API_URL}/health`).catch(() => {});
}, 5 * 60 * 1000);

// CONTAINS = 4 for GA4 dimension string filter
const CONTAINS = (protos.google.analytics.data.v1beta.Filter.StringFilter.MatchType && protos.google.analytics.data.v1beta.Filter.StringFilter.MatchType.CONTAINS) || 4;

// Comprehensive analytics endpoint with all key metrics
app.get('/api/analytics', async (req, res) => {
  try {
    const property = `properties/${process.env.GA4_PROPERTY_ID}`;
    
    // Page-level metrics
    const pageRequest = {
      property,
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [
        { name: 'activeUsers' },
        { name: 'totalUsers' },
        { name: 'newUsers' },
        { name: 'sessions' },
        { name: 'screenPageViews' },
        { name: 'bounceRate' },
        { name: 'averageSessionDuration' },
        { name: 'engagementRate' }
      ]
    };

    // Traffic sources
    const sourceRequest = {
      property,
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'sessionSource' }, { name: 'sessionMedium' }],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
        { name: 'bounceRate' }
      ]
    };

    // Device breakdown
    const deviceRequest = {
      property,
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'deviceCategory' }],
      metrics: [
        { name: 'activeUsers' },
        { name: 'sessions' },
        { name: 'screenPageViews' }
      ]
    };

    // Geographic data
    const geoRequest = {
      property,
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'country' }],
      metrics: [
        { name: 'activeUsers' },
        { name: 'sessions' }
      ]
    };

    // Daily trend
    const trendRequest = {
      property,
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'date' }],
      metrics: [
        { name: 'activeUsers' },
        { name: 'sessions' },
        { name: 'screenPageViews' }
      ],
      orderBys: [{ dimension: { dimensionName: 'date' } }]
    };

    // Browser breakdown
    const browserRequest = {
      property,
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'browser' }],
      metrics: [
        { name: 'activeUsers' },
        { name: 'sessions' }
      ]
    };

    const [pageData, sourceData, deviceData, geoData, trendData, browserData] = await Promise.all([
      client.runReport(pageRequest),
      client.runReport(sourceRequest),
      client.runReport(deviceRequest),
      client.runReport(geoRequest),
      client.runReport(trendRequest),
      client.runReport(browserRequest)
    ]);

    res.json({
      pages: pageData[0],
      sources: sourceData[0],
      devices: deviceData[0],
      geography: geoData[0],
      trend: trendData[0],
      browsers: browserData[0]
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Blog performance: pages where pagePath contains "blog"
app.get('/api/analytics/blogs', async (req, res) => {
  try {
    const property = `properties/${process.env.GA4_PROPERTY_ID}`;
    const dimensionFilter = {
      filter: {
        fieldName: 'pagePath',
        stringFilter: {
          matchType: CONTAINS,
          value: 'blog'
        }
      }
    };
    const blogPageRequest = {
      property,
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'pagePath' }],
      metrics: [
        { name: 'activeUsers' },
        { name: 'totalUsers' },
        { name: 'sessions' },
        { name: 'screenPageViews' },
        { name: 'bounceRate' },
        { name: 'averageSessionDuration' },
        { name: 'engagementRate' }
      ],
      dimensionFilter,
      orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
      limit: 50
    };
    const blogTrendRequest = {
      property,
      dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
      dimensions: [{ name: 'date' }],
      metrics: [
        { name: 'activeUsers' },
        { name: 'sessions' },
        { name: 'screenPageViews' }
      ],
      dimensionFilter,
      orderBys: [{ dimension: { dimensionName: 'date' } }]
    };
    const [blogPageResult, blogTrendResult] = await Promise.all([
      client.runReport(blogPageRequest),
      client.runReport(blogTrendRequest)
    ]);
    const blogPageData = Array.isArray(blogPageResult) ? blogPageResult[0] : blogPageResult;
    const blogTrendData = Array.isArray(blogTrendResult) ? blogTrendResult[0] : blogTrendResult;
    res.json({
      blogs: blogPageData,
      blogTrend: blogTrendData
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Chat agent: data Q&A only (strict boundaries)
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Missing or invalid message' });
    }
    log(`  proxy → ${CHAT_API_URL}/chat`);
    const r = await fetch(`${CHAT_API_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: message.trim() })
    });
    if (!r.ok) {
      const err = await r.text();
      log(`  ← chatbot ${r.status}: ${err.slice(0, 200)}`);
      return res.status(r.status).json({ error: err || 'Chat service error' });
    }
    const data = await r.json();
    log(`  ← chatbot 200, response length=${(data.response || '').length}`);
    res.json(data);
  } catch (error) {
    log(`  ← chatbot unreachable: ${error.message}`);
    const hint = (error.cause && error.cause.code === 'ECONNREFUSED') || (error.code === 'ECONNREFUSED')
      ? ` Chatbot at ${CHAT_API_URL} is not running. Start it: cd chatbot && uvicorn api:app --reload --port 8000`
      : '';
    res.status(502).json({ error: (error.message || 'Chat service unavailable') + hint });
  }
});

// Quick action: recommendations only (separate agent, no body)
app.post('/api/quick-action', async (req, res) => {
  try {
    log(`  proxy → ${CHAT_API_URL}/quick-action`);
    const r = await fetch(`${CHAT_API_URL}/quick-action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (!r.ok) {
      const err = await r.text();
      log(`  ← chatbot ${r.status}: ${err.slice(0, 200)}`);
      return res.status(r.status).json({ error: err || 'Quick action service error' });
    }
    const data = await r.json();
    log(`  ← chatbot 200, response length=${(data.response || '').length}`);
    res.json(data);
  } catch (error) {
    log(`  ← chatbot unreachable: ${error.message}`);
    const hint = (error.cause && error.cause.code === 'ECONNREFUSED') || (error.code === 'ECONNREFUSED')
      ? ` Chatbot at ${CHAT_API_URL} is not running. Start it: cd chatbot && uvicorn api:app --reload --port 8000`
      : '';
    res.status(502).json({ error: (error.message || 'Quick action unavailable') + hint });
  }
});

// Suggested follow-up questions (from conversation + stored topics)
app.post('/api/suggested-questions', async (req, res) => {
  try {
    const body = req.body || {};
    log(`  proxy → ${CHAT_API_URL}/suggested-questions (messages=${(body.messages || []).length}, topics_len=${(body.topics_discussed || '').length})`);
    const r = await fetch(`${CHAT_API_URL}/suggested-questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: body.messages || [],
        topics_discussed: body.topics_discussed || ''
      })
    });
    if (!r.ok) {
      const err = await r.text();
      log(`  ← chatbot ${r.status}: ${err.slice(0, 200)}`);
      return res.status(r.status).json({ error: err || 'Suggested questions error' });
    }
    const data = await r.json();
    log(`  ← chatbot 200, questions=${(data.questions || []).length}`);
    res.json(data);
  } catch (error) {
    log(`  ← chatbot unreachable: ${error.message}`);
    const hint = (error.cause && error.cause.code === 'ECONNREFUSED') || (error.code === 'ECONNREFUSED')
      ? ` Chatbot at ${CHAT_API_URL} is not running. Start it: cd chatbot && uvicorn api:app --reload --port 8000`
      : '';
    res.status(502).json({ error: (error.message || 'Suggested questions unavailable') + hint });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
  console.log('Chat API proxy target:', CHAT_API_URL, '(start chatbot with: cd chatbot && uvicorn api:app --reload --port 8000)');
});
