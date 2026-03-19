/* ─── Nav Scroll Effect ──────────────────────── */
const nav = document.querySelector('.nav');
const hero = document.querySelector('.hero');

function updateNav() {
  const heroBottom = hero.getBoundingClientRect().bottom;
  nav.classList.toggle('scrolled', heroBottom <= 56);
}

window.addEventListener('scroll', updateNav, { passive: true });
updateNav();

/* ─── Mobile Nav Toggle ──────────────────────── */
const navToggle = document.getElementById('navToggle');
const navLinks = document.getElementById('navLinks');

navToggle.addEventListener('click', () => {
  navLinks.classList.toggle('open');
  navToggle.textContent = navLinks.classList.contains('open') ? '\u2715' : '\u2630';
});

navLinks.querySelectorAll('a').forEach(link => {
  link.addEventListener('click', () => {
    navLinks.classList.remove('open');
    navToggle.textContent = '\u2630';
  });
});

/* ─── Scroll Fade-In Animations (staggered) ──── */
const fadeElements = document.querySelectorAll('.fade-in');

const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      // Find siblings for stagger
      const parent = entry.target.parentElement;
      const siblings = parent ? Array.from(parent.querySelectorAll(':scope > .fade-in')) : [];
      const idx = siblings.indexOf(entry.target);
      const delay = idx > 0 ? idx * 80 : 0;
      setTimeout(() => entry.target.classList.add('visible'), delay);
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

fadeElements.forEach(el => observer.observe(el));

/* ─── Live Reputation Score ──────────────────── */
async function fetchReputation() {
  try {
    const res = await fetch('https://api.toppa.cc/reputation');
    if (!res.ok) return;
    const data = await res.json();
    const el = document.getElementById('reputationScore');
    if (el && data.score !== undefined) {
      el.textContent = data.score.toFixed(1);
    }
  } catch {
    // API unreachable
  }
}

fetchReputation();

/* ─── API Playground ─────────────────────────── */
const ENDPOINTS = {
  operators: {
    url: country => `https://api.toppa.cc/operators/${country}`,
    usesCountry: true,
    renderCard: item => ({
      icon: item.logoUrls?.[0] || '',
      name: item.name || item.operatorName || 'Unknown',
      detail: [item.bundle && 'Bundle', item.data && 'Data', item.pin && 'PIN'].filter(Boolean).join(' · ') || item.countryCode || '',
      badge: item.denominationType || '',
    }),
  },
  'gift-cards': {
    url: () => 'https://api.toppa.cc/gift-cards',
    usesCountry: false,
    renderCard: item => ({
      icon: item.logoUrls?.[0] || item.image?.url || '',
      name: item.productName || item.brand?.brandName || item.name || 'Unknown',
      detail: item.country?.isoName || item.recipientCurrencyCode || '',
      badge: item.denominationType || (item.fixedRecipientDenominations?.length ? 'FIXED' : 'RANGE'),
    }),
  },
  billers: {
    url: country => `https://api.toppa.cc/billers/${country}`,
    usesCountry: true,
    renderCard: item => ({
      icon: '',
      name: item.name || item.billerName || 'Unknown',
      detail: item.type || item.serviceType || '',
      badge: item.countryCode || '',
    }),
  },
  promotions: {
    url: country => `https://api.toppa.cc/promotions/${country}`,
    usesCountry: true,
    renderCard: item => ({
      icon: item.operatorImage || '',
      name: item.title || item.operatorName || 'Promotion',
      detail: item.denominations || item.description || '',
      badge: item.endDate ? 'Ends ' + item.endDate.slice(0, 10) : '',
    }),
  },
};

let currentEp = 'operators';
let showRaw = false;
let lastData = null;

function initPlayground() {
  const tabs = document.querySelectorAll('.pg-tab');
  const sendBtn = document.getElementById('pgSend');
  const countrySelect = document.getElementById('pgCountry');

  if (!tabs.length || !sendBtn) return;

  // Tab switching
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentEp = tab.dataset.ep;
      showRaw = false;
      lastData = null;
      updateUrl();
      resetResponse();
      updateCountryVisibility();
    });
  });

  // Country change
  countrySelect.addEventListener('change', () => {
    updateUrl();
    // Auto-fetch on country change if we already have data
    if (lastData !== null) sendRequest();
  });

  // Send button
  sendBtn.addEventListener('click', sendRequest);

  // Add raw toggle button to response bar
  const responseBar = document.querySelector('.pg-response-bar');
  if (responseBar) {
    const rawBtn = document.createElement('button');
    rawBtn.className = 'pg-raw-toggle';
    rawBtn.id = 'pgRawToggle';
    rawBtn.textContent = 'JSON';
    rawBtn.addEventListener('click', toggleRaw);
    responseBar.appendChild(rawBtn);
  }

  updateUrl();
  updateCountryVisibility();
}

function updateCountryVisibility() {
  const countrySelect = document.getElementById('pgCountry');
  const ep = ENDPOINTS[currentEp];
  if (countrySelect) {
    countrySelect.style.display = ep.usesCountry ? '' : 'none';
  }
}

function updateUrl() {
  const urlEl = document.getElementById('pgUrl');
  const country = document.getElementById('pgCountry').value;
  const ep = ENDPOINTS[currentEp];
  urlEl.textContent = ep.url(country);
}

function resetResponse() {
  const body = document.getElementById('pgResponseBody');
  const status = document.getElementById('pgStatus');
  const count = document.getElementById('pgCount');
  const rawToggle = document.getElementById('pgRawToggle');

  body.innerHTML = '<div class="pg-placeholder">Select an endpoint and click Send</div>';
  status.textContent = '';
  status.className = 'pg-status';
  count.textContent = '';
  if (rawToggle) {
    rawToggle.classList.remove('active');
    rawToggle.style.display = 'none';
  }
}

function toggleRaw() {
  if (!lastData) return;
  showRaw = !showRaw;
  const rawToggle = document.getElementById('pgRawToggle');
  rawToggle.classList.toggle('active', showRaw);
  renderResults(lastData);
}

async function sendRequest() {
  const body = document.getElementById('pgResponseBody');
  const status = document.getElementById('pgStatus');
  const count = document.getElementById('pgCount');
  const sendBtn = document.getElementById('pgSend');
  const rawToggle = document.getElementById('pgRawToggle');

  const country = document.getElementById('pgCountry').value;
  const ep = ENDPOINTS[currentEp];
  const url = ep.url(country);

  // Loading state
  body.innerHTML = '<div class="pg-loading">Loading...</div>';
  status.textContent = '';
  status.className = 'pg-status';
  count.textContent = '';
  sendBtn.disabled = true;
  sendBtn.textContent = '...';
  if (rawToggle) rawToggle.style.display = 'none';

  try {
    const res = await fetch(url);
    const text = await res.text();

    sendBtn.disabled = false;
    sendBtn.innerHTML = 'Send &rarr;';

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (res.ok) {
      status.textContent = '200 OK';
      status.className = 'pg-status s200';

      // Normalize data to array
      let items = Array.isArray(data) ? data : (data.data || data.items || data.results || data.operators || data.content || [data]);
      lastData = { items, raw: data };

      count.textContent = items.length + ' items';
      if (rawToggle) rawToggle.style.display = '';
      renderResults(lastData);
    } else {
      status.textContent = res.status + ' ' + res.statusText;
      status.className = 'pg-status s500';
      lastData = null;
      count.textContent = '';
      body.innerHTML = '<pre class="pg-raw">' + escapeHtml(typeof data === 'string' ? data : JSON.stringify(data, null, 2)) + '</pre>';
    }
  } catch (err) {
    sendBtn.disabled = false;
    sendBtn.innerHTML = 'Send &rarr;';
    status.textContent = 'Error';
    status.className = 'pg-status s500';
    lastData = null;
    count.textContent = '';
    body.innerHTML = '<div class="pg-placeholder">Network error — ' + escapeHtml(err.message) + '</div>';
  }
}

function renderResults(data) {
  const body = document.getElementById('pgResponseBody');

  if (showRaw) {
    body.innerHTML = '<pre class="pg-raw">' + escapeHtml(JSON.stringify(data.raw, null, 2)) + '</pre>';
    return;
  }

  const ep = ENDPOINTS[currentEp];
  const items = data.items;

  if (!items.length) {
    body.innerHTML = '<div class="pg-placeholder">No results found</div>';
    return;
  }

  let html = '<div class="pg-cards">';
  const max = Math.min(items.length, 50); // Cap at 50 for performance

  for (let i = 0; i < max; i++) {
    const card = ep.renderCard(items[i]);
    html += '<div class="pg-card">';

    if (card.icon) {
      html += '<img class="pg-card-icon" src="' + escapeHtml(card.icon) + '" alt="" onerror="this.style.display=\'none\'">';
    } else {
      html += '<div class="pg-card-icon" style="display:flex;align-items:center;justify-content:center;font-size:0.75rem;color:var(--text-4);">' + currentEp.charAt(0).toUpperCase() + '</div>';
    }

    html += '<div class="pg-card-info">';
    html += '<div class="pg-card-name">' + escapeHtml(card.name) + '</div>';
    if (card.detail) {
      html += '<div class="pg-card-detail">' + escapeHtml(card.detail) + '</div>';
    }
    html += '</div>';

    if (card.badge) {
      html += '<span class="pg-card-badge">' + escapeHtml(card.badge) + '</span>';
    }

    html += '</div>';
  }

  if (items.length > max) {
    html += '<div class="pg-card" style="justify-content:center;color:var(--text-4);font-size:0.8rem;">+ ' + (items.length - max) + ' more items (toggle JSON to see all)</div>';
  }

  html += '</div>';
  body.innerHTML = html;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

initPlayground();

/* ─── Interactive Dot Grid ───────────────────── */
function initDotGrid(container, opts = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'dot-grid-canvas';
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:0;';
  container.style.position = 'relative';
  container.insertBefore(canvas, container.firstChild);

  const ctx = canvas.getContext('2d');
  const spacing = opts.spacing || 32;
  const baseRadius = opts.baseRadius || 1.2;
  const hoverRadius = opts.hoverRadius || 3.5;
  const hoverRange = opts.hoverRange || 120;
  const baseColor = opts.color || 'rgba(255,255,255,0.15)';
  const enableTraces = opts.traces || false;
  const traceColor = opts.traceColor || 'rgba(255,255,255,0.6)';
  const traceSpeed = opts.traceSpeed || 0.012;
  const maxTraces = opts.maxTraces || 6;

  let mouse = { x: -1000, y: -1000 };
  let dots = [];
  let cols = 0, rows = 0;
  let traces = [];
  let raf;
  let w, h;

  function resize() {
    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    w = rect.width;
    h = rect.height;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);
    buildDots();
  }

  function buildDots() {
    dots = [];
    cols = Math.ceil(w / spacing) + 1;
    rows = Math.ceil(h / spacing) + 1;
    const offsetX = (w - (cols - 1) * spacing) / 2;
    const offsetY = (h - (rows - 1) * spacing) / 2;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        dots.push({ x: offsetX + c * spacing, y: offsetY + r * spacing, col: c, row: r, scale: 0 });
      }
    }
    traces = [];
  }

  // Get dot at grid position
  function dotAt(c, r) {
    if (c < 0 || c >= cols || r < 0 || r >= rows) return null;
    return dots[r * cols + c];
  }

  // Spawn a new trace
  function spawnTrace() {
    if (traces.length >= maxTraces) return;
    const startIdx = Math.floor(Math.random() * dots.length);
    const start = dots[startIdx];
    // Pick random direction: 0=right, 1=down, 2=left, 3=up
    const dirs = [[1,0],[0,1],[-1,0],[0,-1]];
    // Build a random path of 4-8 segments
    const pathLen = 4 + Math.floor(Math.random() * 5);
    const path = [start];
    let cc = start.col, rr = start.row;
    let dir = dirs[Math.floor(Math.random() * 4)];
    for (let i = 0; i < pathLen; i++) {
      // Occasionally change direction
      if (Math.random() < 0.3) {
        dir = dirs[Math.floor(Math.random() * 4)];
      }
      const nc = cc + dir[0];
      const nr = rr + dir[1];
      const next = dotAt(nc, nr);
      if (next) {
        path.push(next);
        cc = nc;
        rr = nr;
      } else {
        // Bounce — try another direction
        dir = dirs[Math.floor(Math.random() * 4)];
      }
    }
    if (path.length > 1) {
      traces.push({ path, progress: 0, tailLen: 3 });
    }
  }

  function drawTraces() {
    for (let i = traces.length - 1; i >= 0; i--) {
      const tr = traces[i];
      tr.progress += traceSpeed;

      const totalSegs = tr.path.length - 1;
      const headPos = tr.progress * totalSegs;
      const tailPos = headPos - tr.tailLen;

      // Remove completed traces
      if (tailPos >= totalSegs) {
        traces.splice(i, 1);
        continue;
      }

      // Draw each segment the trace covers
      for (let s = 0; s < totalSegs; s++) {
        if (s + 1 < tailPos || s > headPos) continue;

        const a = tr.path[s];
        const b = tr.path[s + 1];

        // Clamp segment portion
        const segStart = Math.max(0, tailPos - s);
        const segEnd = Math.min(1, headPos - s);
        if (segEnd <= segStart) continue;

        const x1 = a.x + (b.x - a.x) * segStart;
        const y1 = a.y + (b.y - a.y) * segStart;
        const x2 = a.x + (b.x - a.x) * segEnd;
        const y2 = a.y + (b.y - a.y) * segEnd;

        // Fade based on distance from head
        const distFromHead = headPos - (s + segEnd);
        const alpha = Math.max(0, 1 - distFromHead / tr.tailLen);

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = traceColor.replace(/[\d.]+\)$/, (alpha * 0.5).toFixed(2) + ')');
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Draw glowing head dot
      if (headPos >= 0 && headPos <= totalSegs) {
        const segIdx = Math.min(Math.floor(headPos), totalSegs - 1);
        const segT = headPos - segIdx;
        const a = tr.path[segIdx];
        const b = tr.path[segIdx + 1];
        const hx = a.x + (b.x - a.x) * segT;
        const hy = a.y + (b.y - a.y) * segT;

        ctx.beginPath();
        ctx.arc(hx, hy, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = traceColor;
        ctx.fill();
      }
    }
  }

  let frameCount = 0;

  function draw() {
    ctx.clearRect(0, 0, w, h);

    // Draw dots
    for (const dot of dots) {
      const dx = dot.x - mouse.x;
      const dy = dot.y - mouse.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const t = Math.max(0, 1 - dist / hoverRange);

      const target = t;
      dot.scale += (target - dot.scale) * 0.15;

      const radius = baseRadius + (hoverRadius - baseRadius) * dot.scale;

      ctx.beginPath();
      ctx.arc(dot.x, dot.y, radius, 0, Math.PI * 2);

      if (dot.scale > 0.01) {
        const alpha = 0.15 + 0.35 * dot.scale;
        ctx.fillStyle = baseColor.replace(/[\d.]+\)$/, alpha.toFixed(2) + ')');
      } else {
        ctx.fillStyle = baseColor;
      }

      ctx.fill();
    }

    // Draw traces
    if (enableTraces) {
      frameCount++;
      if (frameCount % 90 === 0) spawnTrace(); // New trace every ~1.5s
      drawTraces();
    }

    raf = requestAnimationFrame(draw);
  }

  container.addEventListener('mousemove', (e) => {
    const rect = container.getBoundingClientRect();
    mouse.x = e.clientX - rect.left;
    mouse.y = e.clientY - rect.top;
  });

  container.addEventListener('mouseleave', () => {
    mouse.x = -1000;
    mouse.y = -1000;
  });

  // Observe visibility to start/stop animation
  const visObs = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting) {
      resize();
      draw();
    } else {
      cancelAnimationFrame(raf);
    }
  }, { threshold: 0.05 });

  visObs.observe(container);

  window.addEventListener('resize', () => {
    cancelAnimationFrame(raf);
    resize();
    draw();
  });
}

// Hero grid — white dots on orange
const heroEl = document.querySelector('.hero');
if (heroEl) {
  // Make sure hero children are above canvas
  heroEl.querySelectorAll('.container').forEach(c => c.style.position = 'relative');
  heroEl.querySelectorAll('.container').forEach(c => c.style.zIndex = '1');
  initDotGrid(heroEl, {
    spacing: 36,
    baseRadius: 1.5,
    hoverRadius: 4.5,
    hoverRange: 140,
    color: 'rgba(0,0,0,0.12)',
    traces: true,
    traceColor: 'rgba(255,255,255,0.7)',
    traceSpeed: 0.015,
    maxTraces: 5,
  });
}

// Features section — subtle dark dots
const featuresEl = document.getElementById('features');
if (featuresEl) {
  featuresEl.querySelectorAll('.container').forEach(c => c.style.position = 'relative');
  featuresEl.querySelectorAll('.container').forEach(c => c.style.zIndex = '1');
  initDotGrid(featuresEl, {
    spacing: 40,
    baseRadius: 0.8,
    hoverRadius: 2.5,
    hoverRange: 100,
    color: 'rgba(15,23,42,0.04)',
  });
}

// Developers section — subtle dots
const devEl = document.getElementById('developers');
if (devEl) {
  devEl.querySelectorAll('.container').forEach(c => c.style.position = 'relative');
  devEl.querySelectorAll('.container').forEach(c => c.style.zIndex = '1');
  initDotGrid(devEl, {
    spacing: 40,
    baseRadius: 0.8,
    hoverRadius: 2.5,
    hoverRange: 100,
    color: 'rgba(15,23,42,0.04)',
  });
}
