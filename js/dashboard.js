// ===== Dashboard Module =====
// Production-grade: deduplicated, debounced, store-scoped, cancellable

(function() {
  'use strict';

  // ===== State =====
  let isLoading = false;
  let pendingLoad = false;
  let refreshDebounce = null;
  let pollInterval = null;
  let isDestroyed = false;

  // ===== Constants =====
  const AUTO_REFRESH_MS = 30000;
  const DEBOUNCE_MS = 500;
  const MAX_RECENT_SALES = 8;
  const MAX_STOCK_ALERTS = 8;

  // ===== DOM Cache =====
  const $ = (id) => document.getElementById(id);
  const els = {
    todayRev: $('d-today-rev'),
    todaySales: $('d-today-sales'),
    monthRev: $('d-month-rev'),
    monthSales: $('d-month-sales'),
    totalRev: $('d-total-rev'),
    totalSales: $('d-total-sales'),
    lowStockCount: $('d-low-stock'),
    paymentChart: $('payment-chart'),
    topProducts: $('top-products-list'),
    recentSalesBody: $('recent-sales-tbody'),
    stockAlerts: $('stock-alerts-list'),
    refreshBtn: $('refresh-dash-btn')
  };

  // ===== Payment Method Config =====
  const PAYMENT_METHODS = [
    { key: 'cash', label: '💵 Cash', color: '#10b981' },
    { key: 'card', label: '💳 Card', color: '#6366f1' },
    { key: 'mobile', label: '📱 Mobile', color: '#0ea5e9' }
  ];

  const PAYMENT_ICONS = { cash: '💵', card: '💳', mobile: '📱' };

  // ===== Initialization =====
  document.addEventListener('DOMContentLoaded', () => {
    if (!els.refreshBtn) return; // Not on dashboard page

    initDashboard();
  });

  function initDashboard() {
    loadDashboard();

    // Manual refresh with debounce
    els.refreshBtn.addEventListener('click', () => {
      els.refreshBtn.disabled = true;
      els.refreshBtn.style.opacity = '0.6';
      loadDashboard().finally(() => {
        setTimeout(() => {
          els.refreshBtn.disabled = false;
          els.refreshBtn.style.opacity = '';
        }, 1000);
      });
    });

    setupSocketListeners();

    // Fallback polling ONLY if Socket.IO disconnects
    startFallbackPolling();
  }

  // ===== Core Load Orchestrator =====
  async function loadDashboard() {
    if (isDestroyed) return;
    if (isLoading) {
      pendingLoad = true;
      return;
    }

    isLoading = true;
    pendingLoad = false;

    // Show skeleton loading states
    setLoadingState(true);

    try {
      await Promise.all([
        loadSummary(),
        loadRecentSales(),
        loadStockAlerts()
      ]);
    } catch (err) {
      console.error('Dashboard load failed:', err);
      if (!isDestroyed) {
        toast('Failed to refresh dashboard. Will retry shortly.', 'warning');
      }
    } finally {
      isLoading = false;
      setLoadingState(false);

      // If a load was requested while busy, schedule it
      if (pendingLoad && !isDestroyed) {
        setTimeout(loadDashboard, 100);
      }
    }
  }

  function setLoadingState(loading) {
    if (loading) {
      els.refreshBtn?.classList.add('loading');
      document.body.style.cursor = 'wait';
    } else {
      els.refreshBtn?.classList.remove('loading');
      document.body.style.cursor = '';
    }
  }

  // ===== Summary Section =====
  async function loadSummary() {
    if (isDestroyed) return;

    try {
      const res = await apiFetch('/sales/reports/summary');

      if (!res.success || !res.data) {
        throw new Error(res.message || 'Invalid summary response');
      }

      const d = res.data;

      // Safe DOM updates
      safeSetText(els.todayRev, fmt.currency(d?.today?.revenue ?? 0));
      safeSetText(els.todaySales, `${d?.today?.sales ?? 0} transactions`);
      safeSetText(els.monthRev, fmt.currency(d?.month?.revenue ?? 0));
      safeSetText(els.monthSales, `${d?.month?.sales ?? 0} transactions`);
      safeSetText(els.totalRev, fmt.currency(d?.total?.revenue ?? 0));
      safeSetText(els.totalSales, `${d?.total?.sales ?? 0} all time`);

      renderPaymentChart(d.paymentBreakdown);
      renderTopProducts(d.topProducts);
    } catch (err) {
      console.error('Summary load error:', err);
      safeSetHTML(els.paymentChart, renderErrorState('Failed to load summary'));
      safeSetHTML(els.topProducts, renderErrorState('Failed to load top products'));
    }
  }

  function renderPaymentChart(breakdown) {
    if (!els.paymentChart) return;

    const total = Object.values(breakdown || {}).reduce((a, b) => a + (Number(b) || 0), 0);

    if (total === 0) {
      safeSetHTML(els.paymentChart, `
        <div class="dashboard-empty">
          <div style="font-size:32px;margin-bottom:8px">📊</div>
          <div>No sales today yet</div>
        </div>`);
      return;
    }

    const bars = PAYMENT_METHODS.map(m => {
      const val = breakdown[m.key] || 0;
      const pct = total > 0 ? ((val / total) * 100).toFixed(1) : 0;
      return `
        <div class="payment-bar">
          <div class="payment-bar-header">
            <span class="payment-bar-label">${m.label}</span>
            <span class="payment-bar-value">
              ${fmt.currency(val)}
              <span class="payment-bar-pct">(${pct}%)</span>
            </span>
          </div>
          <div class="payment-bar-track">
            <div class="payment-bar-fill" style="width:${pct}%;background:${m.color}"></div>
          </div>
        </div>`;
    }).join('');

    safeSetHTML(els.paymentChart, `
      ${bars}
      <div class="separator"></div>
      <div class="payment-total">
        <span>Total Today</span>
        <span class="payment-total-value">${fmt.currency(total)}</span>
      </div>`);
  }

  function renderTopProducts(products) {
    if (!els.topProducts) return;

    const list = products || [];
    if (list.length === 0) {
      safeSetHTML(els.topProducts, `
        <div class="dashboard-empty">
          <div style="font-size:32px;margin-bottom:8px">🏆</div>
          <div>No sales this month yet</div>
        </div>`);
      return;
    }

    const rankStyles = ['gold', 'silver', 'bronze'];
    const html = list.map((p, i) => `
      <div class="top-product-item">
        <div class="top-product-rank ${rankStyles[i] || ''}">${i + 1}</div>
        <div class="top-product-info">
          <div class="top-product-name">${escapeHtml(p.name)}</div>
          <div class="top-product-qty">${fmt.number(p.qty || 0)} units sold</div>
        </div>
        <div class="top-product-rev">${fmt.currency(p.revenue || 0)}</div>
      </div>`).join('');

    safeSetHTML(els.topProducts, html);
  }

  // ===== Recent Sales =====
  async function loadRecentSales() {
    if (isDestroyed) return;

    try {
      const res = await apiFetch(`/sales?limit=${MAX_RECENT_SALES}&page=1`);

      if (!res.success || !Array.isArray(res.data)) {
        throw new Error(res.message || 'Invalid sales response');
      }

      const sales = res.data;

      if (sales.length === 0) {
        safeSetHTML(els.recentSalesBody, `
          <tr>
            <td colspan="5" class="dashboard-empty-cell">No sales yet</td>
          </tr>`);
        return;
      }

      const html = sales.map(sale => `
        <tr>
          <td>
            <span class="receipt-badge">${escapeHtml(sale.receiptNumber?.slice(-8) || 'N/A')}</span>
          </td>
          <td class="cell-muted">${fmt.datetime(sale.createdAt)}</td>
          <td>${(sale.items || []).reduce((s, i) => s + (i.quantity || 0), 0)}</td>
          <td class="cell-success">${fmt.currency(sale.total || 0)}</td>
          <td class="cell-muted">
            ${PAYMENT_ICONS[sale.paymentMethod] || ''} ${escapeHtml(sale.paymentMethod || 'unknown')}
          </td>
        </tr>`).join('');

      safeSetHTML(els.recentSalesBody, html);
    } catch (err) {
      console.error('Recent sales load error:', err);
      safeSetHTML(els.recentSalesBody, `
        <tr>
          <td colspan="5" class="dashboard-empty-cell">Failed to load sales</td>
        </tr>`);
    }
  }

  // ===== Stock Alerts =====
  async function loadStockAlerts() {
    if (isDestroyed) return;

    try {
      const res = await apiFetch('/products/alerts/low-stock');

      if (!res.success || !Array.isArray(res.data)) {
        throw new Error(res.message || 'Invalid stock response');
      }

      const products = res.data;
      const outCount = products.filter(p => (p.stock || 0) <= 0).length;

      safeSetText(els.lowStockCount, products.length.toString());

      if (products.length === 0) {
        safeSetHTML(els.stockAlerts, `
          <div class="dashboard-empty" style="color:var(--success)">
            <div style="font-size:32px;margin-bottom:8px">✅</div>
            <div>All products are well stocked!</div>
          </div>`);
        return;
      }

      const alertBanner = outCount > 0
        ? `<div class="alert-banner" style="margin-bottom:12px">🚨 ${outCount} product(s) out of stock!</div>`
        : '';

      const items = products.slice(0, MAX_STOCK_ALERTS).map(p => {
        const isOut = (p.stock || 0) <= 0;
        const stockClass = isOut ? 'text-danger' : 'text-warning';
        const badge = isOut
          ? '<span class="badge badge-danger">OUT</span>'
          : '<span class="badge badge-warning">LOW</span>';

        return `
          <div class="stock-alert-item">
            <span class="stock-alert-icon">${escapeHtml(p.category?.icon || '📦')}</span>
            <div class="stock-alert-info">
              <div class="stock-alert-name">${escapeHtml(p.name)}</div>
              <div class="stock-alert-sku">${escapeHtml(p.sku || 'N/A')}</div>
            </div>
            <div class="stock-alert-stock">
              <div class="${stockClass}">${p.stock || 0} ${escapeHtml(p.unit || 'pcs')}</div>
              <div class="stock-alert-min">min: ${p.lowStockThreshold || 0}</div>
            </div>
            ${badge}
          </div>`;
      }).join('');

      const more = products.length > MAX_STOCK_ALERTS
        ? `<div class="stock-alert-more">+${products.length - MAX_STOCK_ALERTS} more items</div>`
        : '';

      safeSetHTML(els.stockAlerts, alertBanner + items + more);
    } catch (err) {
      console.error('Stock alerts load error:', err);
      safeSetHTML(els.stockAlerts, `
        <div class="dashboard-empty" style="padding:16px">
          Failed to load stock alerts
        </div>`);
    }
  }

  // ===== Socket.IO — Debounced Updates =====
  function setupSocketListeners() {
    // Debounce rapid-fire events (bulk sales, stock adjustments)
    socket.on('sale:created', debouncedRefresh);
    socket.on('dashboard:refresh', debouncedRefresh);
    socket.on('product:stockUpdated', debouncedStockRefresh);
  }

  function debouncedRefresh() {
    if (isDestroyed) return;
    clearTimeout(refreshDebounce);
    refreshDebounce = setTimeout(() => {
      if (!isDestroyed) loadDashboard();
    }, DEBOUNCE_MS);
  }

  function debouncedStockRefresh() {
    if (isDestroyed) return;
    clearTimeout(refreshDebounce);
    refreshDebounce = setTimeout(() => {
      if (!isDestroyed) loadStockAlerts();
    }, DEBOUNCE_MS);
  }

  // ===== Fallback Polling (only when Socket.IO is down) =====
  function startFallbackPolling() {
    // Cancel polling if Socket.IO is healthy
    socket.on('connect', () => {
      if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
        console.log('[Dashboard] Socket connected — polling disabled');
      }
    });

    // Start polling if Socket.IO disconnects
    socket.on('disconnect', () => {
      if (!pollInterval) {
        console.log('[Dashboard] Socket disconnected — polling enabled');
        pollInterval = setInterval(() => {
          if (!isDestroyed) loadDashboard();
        }, AUTO_REFRESH_MS);
      }
    });

    // Initial state: if already disconnected, start polling
    if (!socket.connected) {
      pollInterval = setInterval(() => {
        if (!isDestroyed) loadDashboard();
      }, AUTO_REFRESH_MS);
    }
  }

  // ===== Safe DOM Helpers =====
  function safeSetText(el, text) {
    if (el) el.textContent = text;
  }

  function safeSetHTML(el, html) {
    if (el) el.innerHTML = html;
  }

  function renderErrorState(message) {
    return `<div class="dashboard-empty" style="color:var(--text-muted)">${escapeHtml(message)}</div>`;
  }

  function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  // ===== Cleanup on page unload =====
  window.addEventListener('beforeunload', () => {
    isDestroyed = true;
    clearTimeout(refreshDebounce);
    if (pollInterval) clearInterval(pollInterval);
    socket.off('sale:created', debouncedRefresh);
    socket.off('dashboard:refresh', debouncedRefresh);
    socket.off('product:stockUpdated', debouncedStockRefresh);
  });

})();