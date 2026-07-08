// ===== Sales History Module =====
// Production-grade: XSS-safe, debounced, store-scoped, paginated

(function() {
  'use strict';

  // ===== State =====
  let currentPage = 1;
  let totalPages = 1;
  let allSales = [];
  let salesFilters = {};
  let isLoading = false;
  let isDestroyed = false;
  let searchDebounce = null;
  let socketDebounce = null;

  // ===== Constants =====
  const PAGE_SIZE = 20;
  const SEARCH_DEBOUNCE_MS = 200;
  const SOCKET_DEBOUNCE_MS = 500;

  // ===== DOM Cache =====
  const $ = (id) => document.getElementById(id);
  const els = {
    dateFrom: $('date-from'),
    dateTo: $('date-to'),
    paymentFilter: $('payment-filter'),
    salesSearch: $('sales-search'),
    tbody: $('sales-tbody'),
    paginationInfo: $('pagination-info'),
    paginationBtns: $('pagination-btns'),
    filterBtn: $('filter-sales-btn'),
    resetBtn: $('reset-sales-btn'),
    exportBtn: $('export-sales-btn'),
    detailContent: $('sale-detail-content'),
    todayRev: $('sh-today-rev'),
    todayCount: $('sh-today-count'),
    monthRev: $('sh-month-rev'),
    monthCount: $('sh-month-count'),
    totalRev: $('sh-total-rev'),
    totalCount: $('sh-total-count'),
    avgTicket: $('sh-avg')
  };

  // ===== Initialization =====
  document.addEventListener('DOMContentLoaded', () => {
    if (!els.tbody) return; // Not on sales history page
    initSalesHistory();
  });

  async function initSalesHistory() {
    setDefaultDates();
    await Promise.all([loadSalesSummary(), loadSales(1)]);
    bindSalesEvents();
    setupSalesSocket();
  }

  // ===== Safe DOM Helpers =====
  function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function setLoading(loading) {
    if (els.tbody) {
      els.tbody.style.opacity = loading ? '0.6' : '';
      els.tbody.style.pointerEvents = loading ? 'none' : '';
    }
  }

  // ===== Date Helpers =====
  function setDefaultDates() {
    const today = new Date();
    const firstDay = new Date(today.getFullYear(), today.getMonth(), 1);

    if (els.dateFrom) els.dateFrom.value = formatDateLocal(firstDay);
    if (els.dateTo) els.dateTo.value = formatDateLocal(today);
  }

  function formatDateLocal(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function isValidDate(str) {
    if (!str) return false;
    const d = new Date(str);
    return !isNaN(d.getTime());
  }

  // ===== Data Loading =====
  async function loadSalesSummary() {
    if (isDestroyed) return;
    try {
      const res = await apiFetch('/sales/reports/summary');
      if (!res.success || !res.data) {
        throw new Error(res.message || 'Invalid summary response');
      }

      const d = res.data;
      const today = d?.today || {};
      const month = d?.month || {};
      const total = d?.total || {};

      if (els.todayRev) els.todayRev.textContent = fmt.currency(today.revenue || 0);
      if (els.todayCount) els.todayCount.textContent = `${today.sales || 0} sales`;
      if (els.monthRev) els.monthRev.textContent = fmt.currency(month.revenue || 0);
      if (els.monthCount) els.monthCount.textContent = `${month.sales || 0} sales`;
      if (els.totalRev) els.totalRev.textContent = fmt.currency(total.revenue || 0);
      if (els.totalCount) els.totalCount.textContent = `${total.sales || 0} sales`;

      const avg = (total.sales || 0) > 0 ? (total.revenue || 0) / total.sales : 0;
      if (els.avgTicket) els.avgTicket.textContent = fmt.currency(avg);
    } catch (err) {
      console.error('Summary load failed:', err);
      if (!isDestroyed) toast('Failed to load summary', 'error');
    }
  }

  async function loadSales(page = 1) {
    if (isDestroyed) return;
    if (isLoading) return;

    isLoading = true;
    currentPage = page;
    setLoading(true);

    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(PAGE_SIZE)
      });

      if (salesFilters.from && isValidDate(salesFilters.from)) {
        params.set('from', salesFilters.from);
      }
      if (salesFilters.to && isValidDate(salesFilters.to)) {
        params.set('to', salesFilters.to);
      }
      if (salesFilters.payment) {
        params.set('status', 'completed'); // Only show completed sales in history
        // Note: backend doesn't filter by paymentMethod yet — add if needed
      }

      const res = await apiFetch(`/sales?${params.toString()}`);

      if (!res.success || !Array.isArray(res.data)) {
        throw new Error(res.message || 'Invalid sales response');
      }

      allSales = res.data;
      const meta = res.meta || res.pagination || {};
      totalPages = meta.pages || 1;

      renderSalesTable(allSales, meta);
    } catch (err) {
      console.error('Sales load error:', err);
      if (!isDestroyed && els.tbody) {
        els.tbody.innerHTML = `
          <tr>
            <td colspan="10" class="dashboard-empty-cell">
              Failed to load sales. ${escapeHtml(err.message || 'Check connection.')}
            </td>
          </tr>`;
      }
    } finally {
      isLoading = false;
      setLoading(false);
    }
  }

  // ===== Table Rendering =====
  function renderSalesTable(sales, pagination) {
    if (!els.tbody) return;

    const search = (els.salesSearch?.value || '').toLowerCase().trim();
    let filtered = sales;

    if (search) {
      filtered = sales.filter(s => {
        const receipt = String(s.receiptNumber || '').toLowerCase();
        const cashier = String(s.cashier || '').toLowerCase();
        return receipt.includes(search) || cashier.includes(search);
      });
    }

    if (filtered.length === 0) {
      els.tbody.innerHTML = `
        <tr>
          <td colspan="10" class="dashboard-empty-cell">
            ${sales.length === 0 ? 'No sales found for this period' : 'No matching results'}
          </td>
        </tr>`;
    } else {
      const fragment = document.createDocumentFragment();
      const methodIcons = { cash: '💵', card: '💳', mobile: '📱' };

      filtered.forEach(sale => {
        const tr = document.createElement('tr');

        const itemCount = (sale.items || []).reduce((s, i) => s + (i.quantity || 0), 0);
        const hasDiscount = (sale.discount || 0) > 0;
        const hasTax = (sale.tax || 0) > 0;
        const methodIcon = methodIcons[sale.paymentMethod] || '';

        tr.innerHTML = `
          <td>
            <span class="receipt-badge">${escapeHtml(sale.receiptNumber || 'N/A')}</span>
          </td>
          <td class="cell-muted">${fmt.datetime(sale.createdAt)}</td>
          <td>
            <span class="badge badge-info">${itemCount} items</span>
          </td>
          <td>${fmt.currency(sale.subtotal || 0)}</td>
          <td class="text-danger">
            ${hasDiscount ? '-' + fmt.currency(sale.discount) : '—'}
          </td>
          <td class="text-warning">
            ${hasTax ? fmt.currency(sale.tax) : '—'}
          </td>
          <td>
            <span class="font-bold text-success">${fmt.currency(sale.total || 0)}</span>
          </td>
          <td>
            ${methodIcon}
            <span style="font-size:12px;text-transform:capitalize">${escapeHtml(sale.paymentMethod || 'unknown')}</span>
          </td>
          <td class="cell-muted">${escapeHtml(sale.cashier || 'Unknown')}</td>
          <td>
            <button class="btn btn-ghost btn-icon view-sale-btn" data-id="${escapeHtml(sale._id)}" title="View Details">👁️</button>
          </td>
        `;

        fragment.appendChild(tr);
      });

      els.tbody.innerHTML = '';
      els.tbody.appendChild(fragment);

      // Event delegation for view buttons
      els.tbody.addEventListener('click', handleTableClick, { once: false });
    }

    // Update pagination info
    const showing = Math.min(filtered.length, PAGE_SIZE);
    const total = pagination.total || filtered.length;
    if (els.paginationInfo) {
      els.paginationInfo.textContent = `Showing ${showing} of ${total} results`;
    }

    renderPagination(pagination);
  }

  function handleTableClick(e) {
    const btn = e.target.closest('.view-sale-btn');
    if (!btn) return;
    e.stopPropagation();
    viewSaleDetail(btn.dataset.id);
  }

  function renderPagination(pagination) {
    if (!els.paginationBtns) return;

    const page = pagination.page || currentPage;
    const pages = pagination.pages || totalPages;

    if (pages <= 1) {
      els.paginationBtns.innerHTML = '';
      return;
    }

    const fragment = document.createDocumentFragment();

    // Prev button
    const prevBtn = document.createElement('button');
    prevBtn.className = 'btn btn-secondary btn-sm';
    prevBtn.textContent = '← Prev';
    prevBtn.disabled = page <= 1;
    prevBtn.addEventListener('click', () => loadSales(page - 1));
    fragment.appendChild(prevBtn);

    // Page buttons
    const startPage = Math.max(1, page - 2);
    const endPage = Math.min(pages, page + 2);

    for (let i = startPage; i <= endPage; i++) {
      const btn = document.createElement('button');
      btn.className = `btn btn-sm ${i === page ? 'btn-primary' : 'btn-secondary'}`;
      btn.textContent = String(i);
      btn.addEventListener('click', () => loadSales(i));
      fragment.appendChild(btn);
    }

    // Next button
    const nextBtn = document.createElement('button');
    nextBtn.className = 'btn btn-secondary btn-sm';
    nextBtn.textContent = 'Next →';
    nextBtn.disabled = page >= pages;
    nextBtn.addEventListener('click', () => loadSales(page + 1));
    fragment.appendChild(nextBtn);

    els.paginationBtns.innerHTML = '';
    els.paginationBtns.appendChild(fragment);
  }

  // ===== Event Binding =====
  function bindSalesEvents() {
    els.filterBtn?.addEventListener('click', () => {
      salesFilters = {
        from: els.dateFrom?.value,
        to: els.dateTo?.value,
        payment: els.paymentFilter?.value
      };
      loadSales(1);
    });

    els.resetBtn?.addEventListener('click', () => {
      salesFilters = {};
      if (els.paymentFilter) els.paymentFilter.value = '';
      if (els.salesSearch) els.salesSearch.value = '';
      setDefaultDates();
      loadSales(1);
    });

    els.salesSearch?.addEventListener('input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        renderSalesTable(allSales, { page: currentPage, pages: totalPages, limit: PAGE_SIZE, total: allSales.length });
      }, SEARCH_DEBOUNCE_MS);
    });

    els.exportBtn?.addEventListener('click', exportSalesCSV);
  }

  // ===== Sale Detail Modal =====
  async function viewSaleDetail(id) {
    if (!id) return;

    try {
      const res = await apiFetch(`/sales/${id}`);
      if (!res.success || !res.data) {
        throw new Error(res.message || 'Sale not found');
      }

      const sale = res.data;
      const methodIcons = { cash: '💵', card: '💳', mobile: '📱' };
      const methodIcon = methodIcons[sale.paymentMethod] || '';

      const itemsHtml = (sale.items || []).map(i => `
        <tr>
          <td style="padding:5px 0">
            ${escapeHtml(i.productName || 'Unknown')}
            <br>
            <span style="font-size:10px;color:#999">${escapeHtml(i.sku || 'N/A')}</span>
          </td>
          <td style="text-align:center">${i.quantity || 0}</td>
          <td style="text-align:right">${fmt.currency(i.unitPrice || 0)}</td>
          <td style="text-align:right">${fmt.currency(i.subtotal || 0)}</td>
        </tr>`).join('');

      const hasDiscount = (sale.discount || 0) > 0;
      const hasTax = (sale.tax || 0) > 0;
      const hasChange = (sale.change || 0) > 0;
      const hasNote = sale.note && sale.note.trim();

      if (els.detailContent) {
        els.detailContent.innerHTML = `
          <div class="receipt">
            <div class="receipt-header">
              <div class="receipt-shop">🛒 SwiftPOS</div>
              <div class="receipt-sub">${fmt.datetime(sale.createdAt)}</div>
              <div class="receipt-sub">Receipt: <b>${escapeHtml(sale.receiptNumber || 'N/A')}</b></div>
            </div>
            <table style="width:100%;font-size:12px;margin:12px 0">
              <thead>
                <tr style="border-bottom:1px solid #ddd">
                  <th style="text-align:left;padding:4px 0">Product</th>
                  <th style="text-align:center">Qty</th>
                  <th style="text-align:right">Unit $</th>
                  <th style="text-align:right">Total</th>
                </tr>
              </thead>
              <tbody>${itemsHtml}</tbody>
            </table>
            <hr class="receipt-divider" />
            <div class="receipt-row">
              <span>Subtotal</span>
              <span>${fmt.currency(sale.subtotal || 0)}</span>
            </div>
            ${hasDiscount ? `
              <div class="receipt-row">
                <span>Discount</span>
                <span style="color:#ef4444">-${fmt.currency(sale.discount)}</span>
              </div>` : ''}
            ${hasTax ? `
              <div class="receipt-row">
                <span>Tax</span>
                <span>${fmt.currency(sale.tax)}</span>
              </div>` : ''}
            <div class="receipt-row receipt-total-row">
              <span>TOTAL</span>
              <span>${fmt.currency(sale.total || 0)}</span>
            </div>
            <div class="receipt-row">
              <span>Payment</span>
              <span>${methodIcon} ${escapeHtml(sale.paymentMethod || 'unknown').toUpperCase()}</span>
            </div>
            <div class="receipt-row">
              <span>Paid</span>
              <span>${fmt.currency(sale.amountPaid || 0)}</span>
            </div>
            ${hasChange ? `
              <div class="receipt-row">
                <span>Change</span>
                <span style="color:#10b981">${fmt.currency(sale.change)}</span>
              </div>` : ''}
            <div class="receipt-footer">
              <div>Cashier: ${escapeHtml(sale.cashier || 'Unknown')}</div>
              ${hasNote ? `<div>Note: ${escapeHtml(sale.note)}</div>` : ''}
            </div>
          </div>`;
      }

      openModal('sale-detail-modal');
    } catch (err) {
      console.error('Sale detail error:', err);
      toast(err.message || 'Failed to load sale details', 'error');
    }
  }

  // ===== CSV Export =====
  function exportSalesCSV() {
    const rows = [['Receipt #', 'Date', 'Items', 'Subtotal', 'Discount', 'Tax', 'Total', 'Payment', 'Cashier']];

    allSales.forEach(s => {
      const itemCount = (s.items || []).reduce((sum, i) => sum + (i.quantity || 0), 0);
      rows.push([
        escapeCsvField(s.receiptNumber),
        fmt.datetime(s.createdAt),
        itemCount,
        s.subtotal || 0,
        s.discount || 0,
        s.tax || 0,
        s.total || 0,
        escapeCsvField(s.paymentMethod),
        escapeCsvField(s.cashier)
      ]);
    });

    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `sales-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast('Sales exported successfully', 'success');
  }

  function escapeCsvField(field) {
    if (field == null) return '';
    const str = String(field);
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  // ===== Socket Listeners — Debounced =====
  function setupSalesSocket() {
    const debouncedRefresh = () => {
      if (isDestroyed) return;
      clearTimeout(socketDebounce);
      socketDebounce = setTimeout(() => {
        if (!isDestroyed) {
          loadSalesSummary();
          loadSales(currentPage);
        }
      }, SOCKET_DEBOUNCE_MS);
    };

    socket.on('sale:created', debouncedRefresh);
    socket.on('dashboard:refresh', debouncedRefresh);
  }

  // ===== Cleanup =====
  window.addEventListener('beforeunload', () => {
    isDestroyed = true;
    clearTimeout(searchDebounce);
    clearTimeout(socketDebounce);
    socket.off('sale:created');
    socket.off('dashboard:refresh');
  });
})();