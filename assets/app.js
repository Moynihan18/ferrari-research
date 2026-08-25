(function () {
  const CATEGORY_LABELS = {
    acquisition: 'Acquisition',
    funding: 'Funding',
    leadership: 'Leadership',
    product_launch: 'Product',
    partnership: 'Partnership',
    other: 'Other',
  };

  const COMPETITOR_CATEGORY_LABELS = {
    pricing: 'Pricing',
    product_launch: 'Product',
    funding: 'Funding',
    partnership: 'Partnership',
    customer_win: 'Customer win',
    benchmark_perf: 'Benchmark',
    leadership: 'Leadership',
    other: 'Other',
  };

  const state = {
    companies: [],
    newsByCompany: {},
    reoByCompany: {},
    outreachPlan: null,
    filters: { tab: null, category: null, region: null, reo: null, platform: null, modality: null },
    search: '',
    onlyNews: false,
    sortBy: 'news',

    view: 'accounts',
    competitors: [],
    competitorNewsById: {},
    competitorFilters: { category: null },
  };

  async function fetchJson(path) {
    try {
      const res = await fetch(path, { cache: 'no-store' });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  function fmtDate(d) {
    if (!d || d === 'undated') return '';
    const dt = new Date(d + (d.length === 10 ? 'T00:00:00Z' : ''));
    if (isNaN(dt)) return d;
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function reoTier(reo) {
    if (!reo || !reo.found) return 'none';
    const intent = (reo.intent_level || '').toLowerCase();
    const events = reo.total_events_90d || 0;
    if (intent === 'high' || events > 50) return 'hot';
    if (reo.customer_fit_score === 'STRONG' && events > 0) return 'strong';
    if (events > 0 || intent === 'medium' || intent === 'moderate') return 'moderate';
    if (reo.customer_fit_score === 'WEAK') return 'weak';
    return 'weak';
  }

  function sfBadgeClass(status) {
    if (!status) return 'badge-sf-notinsf';
    const s = status.toLowerCase();
    if (s.includes('customer')) return 'badge-sf-customer';
    if (s.includes('partner')) return 'badge-sf-partner';
    if (s.includes('prospect')) return 'badge-sf-prospect';
    return 'badge-sf-notinsf';
  }

  function getPlatforms(company) {
    const raw = (company.competitor_platforms || '').trim();
    if (!raw || raw === '-') return [];
    return raw
      .split(';')
      .map(p => p.replace(/\[.*?\]/g, '').trim())
      .filter(p => p && !/^none confirmed/i.test(p));
  }

  function getModalities(company) {
    const raw = (company.modality || '').trim();
    if (!raw) return [];
    return raw.split(';').map(m => m.trim()).filter(Boolean);
  }

  function mostRecentNewsDate(news) {
    if (!news || !news.length) return null;
    const dates = news.map(n => n.date).filter(d => d && d !== 'undated').sort();
    return dates.length ? dates[dates.length - 1] : null;
  }

  async function loadData() {
    const [companiesDoc, newsDoc, reoDoc, planDoc, competitorsDoc, competitorNewsDoc] = await Promise.all([
      fetchJson('data/companies.json'),
      fetchJson('data/news.json'),
      fetchJson('data/reo_activity.json'),
      fetchJson('data/outreach_plan.json'),
      fetchJson('data/competitors.json'),
      fetchJson('data/competitor_news.json'),
    ]);

    state.companies = (companiesDoc && companiesDoc.companies) || [];
    const newsList = (newsDoc && newsDoc.companies) || [];
    const reoList = (reoDoc && reoDoc.companies) || [];
    state.outreachPlan = planDoc || null;

    newsList.forEach(c => { state.newsByCompany[c.id] = c.news || []; });
    reoList.forEach(c => { state.reoByCompany[c.id] = c.reo || { found: false }; });

    state.competitors = (competitorsDoc && competitorsDoc.competitors) || [];
    const competitorNewsList = (competitorNewsDoc && competitorNewsDoc.companies) || [];
    competitorNewsList.forEach(c => { state.competitorNewsById[c.id] = c.news || []; });

    const refreshed = (newsDoc && newsDoc.generated_at) || (reoDoc && reoDoc.generated_at) || null;
    document.getElementById('lastRefreshed').textContent = refreshed
      ? `Last refreshed: ${fmtDate(refreshed)}`
      : 'Last refreshed: not yet run';
  }

  function buildFilterChips() {
    const tabs = [
      { key: 'model_lab', label: 'Model labs' },
      { key: 'competitor_customer', label: 'Inference customers' },
    ];
    renderChipGroup('filterTab', tabs, state.filters.tab, (key) => {
      state.filters.tab = state.filters.tab === key ? null : key;
      render();
    });

    const categories = Object.keys(CATEGORY_LABELS).map(key => ({ key, label: CATEGORY_LABELS[key] }));
    renderChipGroup('filterCategory', categories, state.filters.category, (key) => {
      state.filters.category = state.filters.category === key ? null : key;
      render();
    });

    const regions = [...new Set(state.companies.map(c => c.region).filter(Boolean))].sort();
    renderChipGroup('filterRegion', regions.map(r => ({ key: r, label: r })), state.filters.region, (key) => {
      state.filters.region = state.filters.region === key ? null : key;
      render();
    });

    const modalities = [...new Set(state.companies.flatMap(getModalities))].sort();
    renderChipGroup('filterModality', modalities.map(m => ({ key: m, label: m })), state.filters.modality, (key) => {
      state.filters.modality = state.filters.modality === key ? null : key;
      render();
    });

    const reoTiers = [
      { key: 'hot', label: 'Hot' },
      { key: 'strong', label: 'Strong' },
      { key: 'moderate', label: 'Moderate' },
      { key: 'weak', label: 'Weak / none' },
    ];
    renderChipGroup('filterReo', reoTiers, state.filters.reo, (key) => {
      state.filters.reo = state.filters.reo === key ? null : key;
      render();
    });

    const platforms = [...new Set(state.companies.flatMap(getPlatforms))].sort();
    const platformChips = [
      ...platforms.map(p => ({ key: p, label: p })),
      { key: 'none', label: 'None known' },
    ];
    renderChipGroup('filterPlatform', platformChips, state.filters.platform, (key) => {
      state.filters.platform = state.filters.platform === key ? null : key;
      render();
    });
  }

  function renderChipGroup(containerId, items, activeKey, onClick) {
    const container = document.getElementById(containerId);
    container.innerHTML = '';
    items.forEach(({ key, label }) => {
      const chip = document.createElement('div');
      chip.className = 'chip' + (activeKey === key ? ' active' : '');
      chip.textContent = label;
      chip.addEventListener('click', () => onClick(key));
      container.appendChild(chip);
    });
  }

  function matchesFilters(company) {
    const { tab, category, region, reo, platform, modality } = state.filters;
    if (tab && company.tab !== tab) return false;
    if (region && company.region !== region) return false;
    if (modality && !getModalities(company).includes(modality)) return false;

    if (platform) {
      const platforms = getPlatforms(company);
      if (platform === 'none') {
        if (platforms.length) return false;
      } else if (!platforms.includes(platform)) {
        return false;
      }
    }

    const news = state.newsByCompany[company.id] || [];
    if (category && !news.some(n => n.category === category)) return false;
    if (state.onlyNews && news.length === 0) return false;

    const reoData = state.reoByCompany[company.id];
    if (reo && reoTier(reoData) !== reo) return false;

    if (state.search) {
      const q = state.search.toLowerCase();
      const hay = [company.name, company.domain, company.ceo, company.cto, company.key_context]
        .filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }

  function sortCompanies(list) {
    const copy = [...list];
    if (state.sortBy === 'name') {
      copy.sort((a, b) => a.name.localeCompare(b.name));
    } else if (state.sortBy === 'reo') {
      const order = { hot: 0, strong: 1, moderate: 2, weak: 3, none: 4 };
      copy.sort((a, b) => order[reoTier(state.reoByCompany[a.id])] - order[reoTier(state.reoByCompany[b.id])]);
    } else {
      copy.sort((a, b) => {
        const da = mostRecentNewsDate(state.newsByCompany[a.id]) || '0000-00-00';
        const db = mostRecentNewsDate(state.newsByCompany[b.id]) || '0000-00-00';
        return db.localeCompare(da);
      });
    }
    return copy;
  }

  function renderCard(company) {
    const tpl = document.getElementById('cardTemplate');
    const node = tpl.content.cloneNode(true);
    const news = state.newsByCompany[company.id] || [];
    const reo = state.reoByCompany[company.id] || { found: false };

    node.querySelector('.card-name').textContent = company.name;
    node.querySelector('.card-domain').textContent = company.domain;

    const badges = node.querySelector('.card-badges');
    const tabBadge = document.createElement('span');
    tabBadge.className = `badge badge-${company.tab}`;
    tabBadge.textContent = company.tab === 'model_lab' ? 'Model Lab' : 'Inference Customer';
    badges.appendChild(tabBadge);

    if (company.salesforce_status) {
      const sfBadge = document.createElement('span');
      sfBadge.className = `badge ${sfBadgeClass(company.salesforce_status)}`;
      sfBadge.textContent = company.salesforce_status;
      badges.appendChild(sfBadge);
    }

    const meta = node.querySelector('.card-meta');
    const metaBits = [
      company.country ? `<span>${company.country}</span>` : '',
      company.valuation ? `<span><b>${escapeHtml(company.valuation)}</b></span>` : '',
      company.ceo ? `<span>${escapeHtml(company.ceo)}</span>` : '',
    ].filter(Boolean);
    meta.innerHTML = metaBits.join('');

    const modalities = getModalities(company);
    if (modalities.length) {
      meta.innerHTML += `<span>${modalities.map(m => `<span class="modality-pill">${escapeHtml(m)}</span>`).join(' ')}</span>`;
    }

    const reoEl = node.querySelector('.card-reo');
    const tier = reoTier(reo);
    reoEl.classList.add(`reo-${tier}`);
    if (!reo.found) {
      reoEl.innerHTML = `<span><span class="reo-dot"></span>Not tracked in Reo.dev</span>`;
    } else {
      const bits = [];
      bits.push(`<span><span class="reo-dot"></span>${reo.customer_fit_score || 'Fit unknown'} fit</span>`);
      if (reo.intent_level) bits.push(`<span>Intent: <b style="color:var(--text)">${reo.intent_level}</b></span>`);
      if (typeof reo.total_events_90d === 'number') bits.push(`<span>${reo.total_events_90d} events / 90d</span>`);
      if (reo.last_activity_date) bits.push(`<span>Last seen ${fmtDate(reo.last_activity_date)}</span>`);
      if (typeof reo.open_roles === 'number') bits.push(`<span>${reo.open_roles} open roles</span>`);
      reoEl.innerHTML = bits.join('');
      if (reo.note) reoEl.title = reo.note;
    }

    const platformEl = node.querySelector('.card-platform');
    const platforms = getPlatforms(company);
    if (platforms.length) {
      const pills = platforms
        .map(p => `<span class="platform-pill">${escapeHtml(p)}</span>`)
        .join('');
      platformEl.innerHTML = `<span class="platform-label">Currently serving on:</span>${pills}`;
    } else {
      platformEl.innerHTML = '';
    }

    const newsEl = node.querySelector('.card-news');
    if (!news.length) {
      newsEl.innerHTML = `<div class="news-empty">No notable news found in this refresh cycle.</div>`;
    } else {
      news
        .slice()
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        .forEach(item => {
          const div = document.createElement('div');
          div.className = 'news-item';
          div.style.borderLeftColor = `var(--cat-${item.category || 'other'})`;
          div.innerHTML = `
            <div class="news-head">
              <span class="cat-pill cat-${item.category || 'other'}">${CATEGORY_LABELS[item.category] || 'Other'}</span>
              <span class="news-title">${escapeHtml(item.title || '')}</span>
              <span class="news-date">${fmtDate(item.date)}</span>
            </div>
            <div class="news-summary">${escapeHtml(item.summary || '')}</div>
            <div class="news-relevance"><b>Sales angle:</b> ${escapeHtml(item.sales_relevance || '')}</div>
            <div class="news-source">${escapeHtml(item.source || '')}${item.url ? ` · <a href="${item.url}" target="_blank" rel="noopener">source</a>` : ''}</div>
          `;
          newsEl.appendChild(div);
        });
    }

    return node;
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function render() {
    buildFilterChips();
    const filtered = sortCompanies(state.companies.filter(matchesFilters));
    const cardsEl = document.getElementById('cards');
    cardsEl.innerHTML = '';
    filtered.forEach(c => cardsEl.appendChild(renderCard(c)));

    document.getElementById('resultCount').textContent = `${filtered.length} of ${state.companies.length} accounts`;
    document.getElementById('emptyState').hidden = filtered.length !== 0;

    const totalNews = state.companies.reduce((sum, c) => sum + (state.newsByCompany[c.id] || []).length, 0);
    const hotCount = state.companies.filter(c => ['hot', 'strong'].includes(reoTier(state.reoByCompany[c.id]))).length;
    const onCompetitorCount = state.companies.filter(c => getPlatforms(c).length > 0).length;
    document.getElementById('statBlock').innerHTML = `
      <div class="stat-line"><span>Total accounts</span><b>${state.companies.length}</b></div>
      <div class="stat-line"><span>News items this cycle</span><b>${totalNews}</b></div>
      <div class="stat-line"><span>Hot / strong Reo signal</span><b>${hotCount}</b></div>
      <div class="stat-line"><span>On a known competitor</span><b>${onCompetitorCount}</b></div>
    `;
  }

  function mostRecentCompetitorNewsDate(id) {
    return mostRecentNewsDate(state.competitorNewsById[id]);
  }

  function buildCompetitorFilterChips() {
    const categories = Object.keys(COMPETITOR_CATEGORY_LABELS).map(key => ({ key, label: COMPETITOR_CATEGORY_LABELS[key] }));
    renderChipGroup('filterCompetitorCategory', categories, state.competitorFilters.category, (key) => {
      state.competitorFilters.category = state.competitorFilters.category === key ? null : key;
      renderCompetitors();
    });
  }

  function matchesCompetitorFilters(competitor) {
    const { category } = state.competitorFilters;
    if (!category) return true;
    const news = state.competitorNewsById[competitor.id] || [];
    return news.some(n => n.category === category);
  }

  function renderCompetitorCard(competitor) {
    const tpl = document.getElementById('competitorCardTemplate');
    const node = tpl.content.cloneNode(true);
    const news = state.competitorNewsById[competitor.id] || [];

    node.querySelector('.card-name').textContent = competitor.name;
    node.querySelector('.card-domain').textContent = competitor.domain;

    const badges = node.querySelector('.card-badges');
    const catBadge = document.createElement('span');
    catBadge.className = 'badge badge-competitor_customer';
    catBadge.textContent = competitor.category;
    badges.appendChild(catBadge);

    node.querySelector('.card-description').textContent = competitor.description || '';

    const newsEl = node.querySelector('.card-news');
    if (!news.length) {
      newsEl.innerHTML = `<div class="news-empty">No notable competitive moves found in this refresh cycle.</div>`;
    } else {
      news
        .slice()
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        .forEach(item => {
          const div = document.createElement('div');
          div.className = 'news-item';
          div.style.borderLeftColor = `var(--cat-${item.category || 'other'})`;
          div.innerHTML = `
            <div class="news-head">
              <span class="cat-pill cat-${item.category || 'other'}">${COMPETITOR_CATEGORY_LABELS[item.category] || 'Other'}</span>
              <span class="news-title">${escapeHtml(item.title || '')}</span>
              <span class="news-date">${fmtDate(item.date)}</span>
            </div>
            <div class="news-summary">${escapeHtml(item.summary || '')}</div>
            <div class="news-relevance"><b>Why it matters:</b> ${escapeHtml(item.competitive_takeaway || '')}</div>
            <div class="news-source">${escapeHtml(item.source || '')}${item.url ? ` · <a href="${item.url}" target="_blank" rel="noopener">source</a>` : ''}</div>
          `;
          newsEl.appendChild(div);
        });
    }

    return node;
  }

  function renderCompetitors() {
    buildCompetitorFilterChips();
    const filtered = state.competitors
      .filter(matchesCompetitorFilters)
      .slice()
      .sort((a, b) => (mostRecentCompetitorNewsDate(b.id) || '0000-00-00').localeCompare(mostRecentCompetitorNewsDate(a.id) || '0000-00-00'));

    const cardsEl = document.getElementById('competitorCards');
    cardsEl.innerHTML = '';
    filtered.forEach(c => cardsEl.appendChild(renderCompetitorCard(c)));

    document.getElementById('competitorResultCount').textContent = `${filtered.length} of ${state.competitors.length} competitors`;
    document.getElementById('competitorEmptyState').hidden = filtered.length !== 0;

    const totalNews = state.competitors.reduce((sum, c) => sum + (state.competitorNewsById[c.id] || []).length, 0);
    const withMoves = state.competitors.filter(c => (state.competitorNewsById[c.id] || []).length > 0).length;
    document.getElementById('competitorStatBlock').innerHTML = `
      <div class="stat-line"><span>Competitors tracked</span><b>${state.competitors.length}</b></div>
      <div class="stat-line"><span>Competitive moves this cycle</span><b>${totalNews}</b></div>
      <div class="stat-line"><span>With activity this cycle</span><b>${withMoves}</b></div>
    `;
  }

  function switchView(view) {
    state.view = view;
    document.getElementById('accountsView').hidden = view !== 'accounts';
    document.getElementById('competitorsView').hidden = view !== 'competitors';
    document.getElementById('outreachBtn').hidden = view !== 'accounts';
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });
  }

  function renderOutreachPlan() {
    const body = document.getElementById('outreachBody');
    const genEl = document.getElementById('outreachGenerated');
    const plan = state.outreachPlan;

    if (!plan || !plan.items || !plan.items.length) {
      genEl.textContent = '';
      body.innerHTML = `<div class="empty-state">No outreach plan has been generated yet. It's produced as part of the weekly Monday refresh.</div>`;
      return;
    }

    genEl.textContent = `Generated ${fmtDate(plan.generated_at)} · top ${plan.items.length} accounts to prioritize this week`;
    body.innerHTML = '';
    plan.items.forEach((item, idx) => {
      const div = document.createElement('div');
      div.className = 'plan-item';
      div.innerHTML = `
        <div class="plan-head">
          <span class="plan-rank">${idx + 1}</span>
          <span class="plan-name">${escapeHtml(item.name)}</span>
          <span class="cat-pill cat-${item.category || 'other'}">${CATEGORY_LABELS[item.category] || 'Signal'}</span>
        </div>
        <div class="plan-why">${escapeHtml(item.why)}</div>
        <div class="plan-message">
          <div class="plan-message-label">
            <span>Suggested outreach message</span>
            <button class="btn btn-small copy-btn" type="button">Copy</button>
          </div>
          <div class="plan-message-text">${escapeHtml(item.message)}</div>
        </div>
      `;
      div.querySelector('.copy-btn').addEventListener('click', (e) => {
        navigator.clipboard.writeText(item.message).then(() => {
          e.target.textContent = 'Copied!';
          setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
        });
      });
      body.appendChild(div);
    });
  }

  function wireControls() {
    document.getElementById('search').addEventListener('input', (e) => {
      state.search = e.target.value;
      render();
    });
    document.getElementById('onlyNews').addEventListener('change', (e) => {
      state.onlyNews = e.target.checked;
      render();
    });
    document.getElementById('sortBy').addEventListener('change', (e) => {
      state.sortBy = e.target.value;
      render();
    });
    document.getElementById('outreachBtn').addEventListener('click', () => {
      renderOutreachPlan();
      document.getElementById('outreachOverlay').hidden = false;
    });
    document.getElementById('closeOutreach').addEventListener('click', () => {
      document.getElementById('outreachOverlay').hidden = true;
    });
    document.getElementById('outreachOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'outreachOverlay') document.getElementById('outreachOverlay').hidden = true;
    });
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });
  }

  async function init() {
    wireControls();
    await loadData();
    render();
    renderCompetitors();
  }

  init();
})();
