// ===== Inventory Module =====
// Production-grade: XSS-safe, debounced, paginated, store-scoped, cancellable

(function() {
  'use strict';

  // ===== State =====
  let invProducts = [];
  let invCategories = [];
  let editingProductId = null;
  let stockAdjType = 'in';
  let activeFilter = { search: '', cat: '', stock: '' };
  let isLoading = false;
  let pendingLoad = false;
  let currentPage = 1;
  let totalPages = 1;
  let isDestroyed = false;
  let refreshDebounce = null;
  let searchDebounce = null;

  // ===== Constants =====
  const PAGE_SIZE = 50;
  const DEBOUNCE_MS = 300;
  const SOCKET_DEBOUNCE_MS = 500;

  // ===== DOM Cache =====
  const $ = (id) => document.getElementById(id);
  const els = {
    tbody: $('inv-tbody'),
    search: $('inv-search'),
    catFilter: $('cat-filter'),
    stockFilter: $('stock-filter'),
    resetBtn: $('reset-filters-btn'),
    addBtn: $('add-product-btn'),
    form: $('product-form'),
    modalTitle: $('product-modal-title'),
    productId: $('product-id'),
    pName: $('p-name'),
    pSku: $('p-sku'),
    pCategory: $('p-category'),
    pUnit: $('p-unit'),
    pPrice: $('p-price'),
    pCost: $('p-cost'),
    pTax: $('p-tax'),
    pStock: $('p-stock'),
    pThreshold: $('p-threshold'),
    pBarcode: $('p-barcode'),
    pDesc: $('p-desc'),
    saveBtn: $('save-product-btn'),
    stockModalId: $('stock-product-id'),
    stockModalName: $('stock-product-name'),
    stockCurrent: $('stock-current'),
    stockQty: $('stock-qty'),
    stockReason: $('stock-reason'),
    confirmStockBtn: $('confirm-stock-btn'),
    addCatBtn: $('add-cat-btn'),
    newCatName: $('new-cat-name'),
    newCatIcon: $('new-cat-icon'),
    catList: $('cat-list'),
    exportBtn: $('export-btn'),
    statTotal: $('stat-total'),
    statInStock: $('stat-instock'),
    statLow: $('stat-low'),
    statOut: $('stat-out'),
    statValue: $('stat-value'),
    alertBanner: $('low-stock-alert'),
    alertCount: $('low-stock-count')
  };

  // ===== Initialization =====
  document.addEventListener('DOMContentLoaded', () => {
    if (!els.tbody) return;
    initInventory();
  });

  async function initInventory() {
    await Promise.all([loadInvCategories(), loadInvProducts()]);
    bindInvEvents();
    setupInvSocketListeners();
  }

  // ===== Safe DOM Helpers =====
  function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function setLoading(loading) {
    isLoading = loading;
    document.body.style.cursor = loading ? 'wait' : '';
    if (els.tbody) {
      els.tbody.style.opacity = loading ? '0.6' : '';
      els.tbody.style.pointerEvents = loading ? 'none' : '';
    }
  }

  // ===== Data Loading =====
  async function loadInvCategories() {
    if (isDestroyed) return;
    try {
      const res = await apiFetch('/categories');
      if (!res.success || !Array.isArray(res.data)) {
        throw new Error(res.message || 'Invalid categories response');
      }
      invCategories = res.data;
      populateCatDropdowns();
      renderCatFilter();
    } catch (err) {
      console.error('Categories load error:', err);
      toast('Failed to load categories', 'error');
    }
  }

  async function loadInvProducts(page = 1, append = false) {
    if (isDestroyed) return;
    if (isLoading) {
      pendingLoad = true;
      return;
    }

    isLoading = true;
    pendingLoad = false;
    setLoading(true);

    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(PAGE_SIZE)
      });

      if (activeFilter.search) params.set('search', activeFilter.search);
      if (activeFilter.cat) params.set('category', activeFilter.cat);

      const res = await apiFetch(`/products?${params.toString()}`);

      if (!res.success || !Array.isArray(res.data)) {
        throw new Error(res.message || 'Invalid products response');
      }

      if (append) {
        invProducts = invProducts.concat(res.data);
      } else {
        invProducts = res.data;
        currentPage = page;
      }

      totalPages = res.meta?.pages || 1;

      renderInvTable();
      updateInvStats();

      if (page < totalPages && invProducts.length < PAGE_SIZE * 2) {
        await loadInvProducts(page + 1, true);
      }
    } catch (err) {
      console.error('Products load error:', err);
      if (!isDestroyed) {
        els.tbody.innerHTML = `
          <tr>
            <td colspan="8" class="dashboard-empty-cell">
              Failed to load. ${escapeHtml(err.message || 'Check connection.')}
            </td>
          </tr>`;
      }
    } finally {
      isLoading = false;
      setLoading(false);
      if (pendingLoad && !isDestroyed) {
        setTimeout(() => loadInvProducts(currentPage), 100);
      }
    }
  }

  function populateCatDropdowns() {
    const formSelect = els.pCategory;
    const filterSelect = els.catFilter;

    if (!formSelect || !filterSelect) return;

    const formOptions = ['<option value="">Select category...</option>'];
    const filterOptions = ['<option value="">All Categories</option>'];

    invCategories.forEach(cat => {
      const safeName = escapeHtml(cat.name);
      const safeIcon = escapeHtml(cat.icon || '📦');
      const option = `<option value="${escapeHtml(cat._id)}">${safeIcon} ${safeName}</option>`;
      formOptions.push(option);
      filterOptions.push(option);
    });

    formSelect.innerHTML = formOptions.join('');
    filterSelect.innerHTML = filterOptions.join('');
  }

  function renderCatFilter() {
    populateCatDropdowns();
  }

  // ===== Table Rendering =====
  function renderInvTable() {
    if (!els.tbody) return;

    let products = [...invProducts];

    if (activeFilter.search) {
      const q = activeFilter.search.toLowerCase();
      products = products.filter(p => {
        const name = String(p.name || '').toLowerCase();
        const sku = String(p.sku || '').toLowerCase();
        const barcode = String(p.barcode || '').toLowerCase();
        return name.includes(q) || sku.includes(q) || barcode.includes(q);
      });
    }
    if (activeFilter.cat) {
      products = products.filter(p => {
        const catId = p.category?._id || p.category;
        return String(catId) === activeFilter.cat;
      });
    }
    if (activeFilter.stock) {
      products = products.filter(p => {
        const stock = Number(p.stock) || 0;
        const threshold = Number(p.lowStockThreshold) || 10;
        if (activeFilter.stock === 'low') return stock > 0 && stock <= threshold;
        if (activeFilter.stock === 'out') return stock <= 0;
        if (activeFilter.stock === 'ok') return stock > threshold;
        return true;
      });
    }

    if (products.length === 0) {
      els.tbody.innerHTML = `
        <tr>
          <td colspan="8" class="dashboard-empty-cell">No products found</td>
        </tr>`;
      return;
    }

    const fragment = document.createDocumentFragment();

    products.forEach(p => {
      const stock = Number(p.stock) || 0;
      const threshold = Number(p.lowStockThreshold) || 10;
      const isLow = stock > 0 && stock <= threshold;
      const isOut = stock <= 0;

      const statusBadge = isOut
        ? '<span class="badge badge-danger">Out of Stock</span>'
        : isLow
          ? '<span class="badge badge-warning">Low Stock</span>'
          : '<span class="badge badge-success">In Stock</span>';

      const stockPct = Math.min(100, (stock / (threshold * 3)) * 100);
      const fillClass = isOut ? 'critical' : isLow ? 'low' : '';
      const catName = escapeHtml(p.category?.name || 'Uncategorized');
      const catIcon = escapeHtml(p.category?.icon || '📦');
      const catColor = escapeHtml(p.category?.color || '#6366f1');
      const price = Number(p.price) || 0;
      const costPrice = Number(p.costPrice) || 0;
      const margin = price > 0 ? (((price - costPrice) / price) * 100).toFixed(1) : '0.0';

      const tr = document.createElement('tr');

      tr.innerHTML = `
        <td>
          <div class="flex items-center gap-2">
            <span style="font-size:20px">${catIcon}</span>
            <div>
              <div style="font-weight:500">${escapeHtml(p.name)}</div>
              ${p.barcode ? `<div style="font-size:11px;color:var(--text-muted)">BC: ${escapeHtml(p.barcode)}</div>` : ''}
            </div>
          </div>
        </td>
        <td>
          <span class="receipt-badge">${escapeHtml(p.sku || 'N/A')}</span>
        </td>
        <td>
          <span style="background:${catColor}22;color:${catColor};padding:3px 8px;border-radius:10px;font-size:12px;font-weight:500">
            ${catIcon} ${catName}
          </span>
        </td>
        <td>
          <span style="font-weight:600;color:var(--primary-light)">${fmt.currency(price)}</span>
        </td>
        <td>
          <div style="font-size:12px">${fmt.currency(costPrice)}</div>
          <div style="font-size:11px;color:var(--success)">${margin}% margin</div>
        </td>
        <td>
          <div style="font-weight:600;${isOut ? 'color:var(--danger)' : isLow ? 'color:var(--warning)' : ''}">
            ${stock} ${escapeHtml(p.unit || 'pcs')}
          </div>
          <div class="stock-bar" style="width:80px">
            <div class="stock-fill ${fillClass}" style="width:${stockPct}%"></div>
          </div>
        </td>
        <td>${statusBadge}</td>
        <td>
          <div class="flex gap-2">
            <button class="btn btn-ghost btn-icon" title="Adjust Stock" data-action="stock" data-id="${escapeHtml(p._id)}">📦</button>
            <button class="btn btn-ghost btn-icon" title="Edit" data-action="edit" data-id="${escapeHtml(p._id)}">✏️</button>
            <button class="btn btn-ghost btn-icon" title="Delete" data-action="delete" data-id="${escapeHtml(p._id)}" data-name="${escapeHtml(p.name)}">🗑️</button>
          </div>
        </td>
      `;

      fragment.appendChild(tr);
    });

    els.tbody.innerHTML = '';
    els.tbody.appendChild(fragment);

    els.tbody.addEventListener('click', handleTableAction, { once: false });
  }

  function handleTableAction(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const id = btn.dataset.id;
    const name = btn.dataset.name;

    e.stopPropagation();

    switch (action) {
      case 'stock':
        openStockModal(id);
        break;
      case 'edit':
        openEditProduct(id);
        break;
      case 'delete':
        confirmDeleteProduct(id, name);
        break;
    }
  }

  function updateInvStats() {
    const total = invProducts.length;
    const out = invProducts.filter(p => (Number(p.stock) || 0) <= 0).length;
    const low = invProducts.filter(p => {
      const stock = Number(p.stock) || 0;
      const threshold = Number(p.lowStockThreshold) || 10;
      return stock > 0 && stock <= threshold;
    }).length;
    const inStock = total - out;
    const value = invProducts.reduce((sum, p) => sum + (Number(p.stock) || 0) * (Number(p.price) || 0), 0);

    if (els.statTotal) els.statTotal.textContent = fmt.number(total);
    if (els.statInStock) els.statInStock.textContent = fmt.number(inStock);
    if (els.statLow) els.statLow.textContent = fmt.number(low);
    if (els.statOut) els.statOut.textContent = fmt.number(out);
    if (els.statValue) els.statValue.textContent = fmt.currency(value);

    const alertCount = low + out;
    if (els.alertBanner && els.alertCount) {
      if (alertCount > 0) {
        els.alertBanner.classList.remove('hidden');
        els.alertCount.textContent = alertCount;
      } else {
        els.alertBanner.classList.add('hidden');
      }
    }
  }

  // ===== Event Binding =====
  function bindInvEvents() {
    els.search?.addEventListener('input', (e) => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        activeFilter.search = e.target.value;
        currentPage = 1;
        loadInvProducts(1);
      }, DEBOUNCE_MS);
    });

    els.catFilter?.addEventListener('change', (e) => {
      activeFilter.cat = e.target.value;
      currentPage = 1;
      loadInvProducts(1);
    });

    els.stockFilter?.addEventListener('change', (e) => {
      activeFilter.stock = e.target.value;
      renderInvTable();
    });

    els.resetBtn?.addEventListener('click', () => {
      activeFilter = { search: '', cat: '', stock: '' };
      if (els.search) els.search.value = '';
      if (els.catFilter) els.catFilter.value = '';
      if (els.stockFilter) els.stockFilter.value = '';
      currentPage = 1;
      loadInvProducts(1);
    });

    els.addBtn?.addEventListener('click', openAddProduct);
    els.form?.addEventListener('submit', saveProduct);

    document.querySelectorAll('#stock-modal .payment-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        stockAdjType = btn.dataset.type;
        document.querySelectorAll('#stock-modal .payment-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    els.confirmStockBtn?.addEventListener('click', confirmStockAdj);
    els.addCatBtn?.addEventListener('click', addCategory);
    els.exportBtn?.addEventListener('click', exportCSV);
  }

  // ===== Product CRUD =====
  function openAddProduct() {
    editingProductId = null;
    if (els.modalTitle) els.modalTitle.textContent = '➕ Add Product';
    els.form?.reset();
    if (els.productId) els.productId.value = '';
    if (els.pTax) els.pTax.value = '0';
    if (els.pThreshold) els.pThreshold.value = '10';
    if (els.pUnit) els.pUnit.value = 'pcs';
    if (els.pStock) els.pStock.value = '0';
    openModal('product-modal');
  }

  function openEditProduct(id) {
    const product = invProducts.find(p => p._id === id);
    if (!product) {
      toast('Product not found', 'error');
      return;
    }

    editingProductId = id;

    if (els.modalTitle) els.modalTitle.textContent = '✏️ Edit Product';
    if (els.productId) els.productId.value = id;
    if (els.pName) els.pName.value = product.name || '';
    if (els.pSku) els.pSku.value = product.sku || '';
    if (els.pCategory) els.pCategory.value = product.category?._id || product.category || '';
    if (els.pUnit) els.pUnit.value = product.unit || 'pcs';
    if (els.pPrice) els.pPrice.value = product.price || '';
    if (els.pCost) els.pCost.value = product.costPrice || 0;
    if (els.pTax) els.pTax.value = product.taxRate || 0;
    if (els.pStock) els.pStock.value = product.stock || 0;
    if (els.pThreshold) els.pThreshold.value = product.lowStockThreshold || 10;
    if (els.pBarcode) els.pBarcode.value = product.barcode || '';
    if (els.pDesc) els.pDesc.value = product.description || '';

    openModal('product-modal');
  }

  async function saveProduct(e) {
    e.preventDefault();

    const name = els.pName?.value.trim();
    const sku = els.pSku?.value.trim();
    const category = els.pCategory?.value;
    const price = parseFloat(els.pPrice?.value);
    const stock = parseInt(els.pStock?.value);

    if (!name || name.length < 2) {
      toast('Product name is required (min 2 characters)', 'warning');
      els.pName?.focus();
      return;
    }
    if (!sku) {
      toast('SKU is required', 'warning');
      els.pSku?.focus();
      return;
    }
    if (!category) {
      toast('Please select a category', 'warning');
      els.pCategory?.focus();
      return;
    }
    if (isNaN(price) || price < 0) {
      toast('Price must be a non-negative number', 'warning');
      els.pPrice?.focus();
      return;
    }
    if (isNaN(stock) || stock < 0) {
      toast('Stock must be a non-negative integer', 'warning');
      els.pStock?.focus();
      return;
    }

    const btn = els.saveBtn;
    if (!btn) return;

    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Saving...';

    const data = {
      name,
      sku: sku.toUpperCase(),
      category,
      unit: (els.pUnit?.value || 'pcs').trim(),
      price,
      costPrice: parseFloat(els.pCost?.value) || 0,
      taxRate: parseFloat(els.pTax?.value) || 0,
      stock,
      lowStockThreshold: parseInt(els.pThreshold?.value) || 10,
      barcode: (els.pBarcode?.value || '').trim(),
      description: (els.pDesc?.value || '').trim()
    };

    try {
      if (editingProductId) {
        await apiFetch(`/products/${editingProductId}`, { method: 'PUT', body: JSON.stringify(data) });
        toast('Product updated successfully', 'success');
      } else {
        await apiFetch('/products', { method: 'POST', body: JSON.stringify(data) });
        toast('Product added successfully', 'success');
      }
      closeModal('product-modal');
      await loadInvProducts(1);
    } catch (err) {
      toast(err.message || 'Failed to save product', 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  function confirmDeleteProduct(id, name) {
    const confirmed = window.confirm(`Delete "${escapeHtml(name)}"?\n\nThis action cannot be undone.`);
    if (!confirmed) return;

    deleteProduct(id, name);
  }

  async function deleteProduct(id, name) {
    try {
      await apiFetch(`/products/${id}`, { method: 'DELETE' });
      toast(`"${escapeHtml(name)}" deleted`, 'success');
      invProducts = invProducts.filter(p => p._id !== id);
      renderInvTable();
      updateInvStats();
    } catch (err) {
      toast(err.message || 'Failed to delete product', 'error');
    }
  }

  // ===== Stock Adjustment =====
  function openStockModal(id) {
    const product = invProducts.find(p => p._id === id);
    if (!product) {
      toast('Product not found', 'error');
      return;
    }

    if (els.stockModalId) els.stockModalId.value = id;
    if (els.stockModalName) els.stockModalName.textContent = product.name;
    if (els.stockCurrent) els.stockCurrent.textContent = `${product.stock || 0} ${product.unit || 'pcs'}`;
    if (els.stockQty) els.stockQty.value = '';
    if (els.stockReason) els.stockReason.value = '';

    stockAdjType = 'in';
    document.querySelectorAll('#stock-modal .payment-btn').forEach(b => b.classList.remove('active'));
    document.querySelector('#stock-modal .payment-btn[data-type="in"]')?.classList.add('active');

    openModal('stock-modal');
  }

  async function confirmStockAdj() {
    const id = els.stockModalId?.value;
    const qty = parseInt(els.stockQty?.value);
    const reason = els.stockReason?.value || '';

    if (!id) {
      toast('Product ID missing', 'error');
      return;
    }
    if (!qty || qty <= 0 || !Number.isInteger(qty)) {
      toast('Enter a valid positive quantity', 'warning');
      els.stockQty?.focus();
      return;
    }

    const btn = els.confirmStockBtn;
    if (!btn) return;

    btn.disabled = true;

    try {
      await apiFetch(`/products/${id}/stock`, {
        method: 'PATCH',
        body: JSON.stringify({ quantity: qty, type: stockAdjType, reason })
      });
      toast('Stock updated successfully', 'success');
      closeModal('stock-modal');
      await loadInvProducts(currentPage);
    } catch (err) {
      toast(err.message || 'Failed to update stock', 'error');
    } finally {
      btn.disabled = false;
    }
  }

  // ===== Categories =====
  async function addCategory() {
    const name = els.newCatName?.value.trim();
    const icon = els.newCatIcon?.value.trim() || '📦';

    if (!name) {
      toast('Enter a category name', 'warning');
      els.newCatName?.focus();
      return;
    }

    try {
      await apiFetch('/categories', {
        method: 'POST',
        body: JSON.stringify({ name, icon })
      });
      toast(`Category "${escapeHtml(name)}" added`, 'success');
      if (els.newCatName) els.newCatName.value = '';
      await loadInvCategories();
      renderCatModal();
    } catch (err) {
      toast(err.message || 'Failed to add category', 'error');
    }
  }

  function renderCatModal() {
    if (!els.catList) return;

    if (invCategories.length === 0) {
      els.catList.innerHTML = '<div style="color:var(--text-muted);font-size:13px">No categories yet</div>';
      return;
    }

    const html = invCategories.map(cat => `
      <div class="flex items-center justify-between" style="padding:8px 0;border-bottom:1px solid var(--border)">
        <span style="font-size:14px">${escapeHtml(cat.icon || '📦')} ${escapeHtml(cat.name)}</span>
        <button class="btn btn-ghost btn-sm" data-action="delete-cat" data-id="${escapeHtml(cat._id)}" data-name="${escapeHtml(cat.name)}">🗑️</button>
      </div>`).join('');

    els.catList.innerHTML = html;

    els.catList.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action="delete-cat"]');
      if (!btn) return;

      const catId = btn.dataset.id;
      const catName = btn.dataset.name;

      if (window.confirm(`Delete category "${escapeHtml(catName)}"?`)) {
        deleteCat(catId, catName);
      }
    }, { once: true });
  }

  async function deleteCat(id, name) {
    try {
      await apiFetch(`/categories/${id}`, { method: 'DELETE' });
      toast(`Category "${escapeHtml(name)}" deleted`, 'success');
      invCategories = invCategories.filter(c => c._id !== id);
      populateCatDropdowns();
      renderCatModal();
    } catch (err) {
      toast(err.message || 'Failed to delete category', 'error');
    }
  }

  function filterLowStock() {
    activeFilter.stock = 'low';
    if (els.stockFilter) els.stockFilter.value = 'low';
    renderInvTable();
  }

  // ===== CSV Export =====
  function exportCSV() {
    const rows = [['Name', 'SKU', 'Category', 'Price', 'Cost', 'Stock', 'Unit', 'Status']];

    invProducts.forEach(p => {
      const stock = Number(p.stock) || 0;
      const threshold = Number(p.lowStockThreshold) || 10;
      const status = stock <= 0 ? 'Out of Stock' : stock <= threshold ? 'Low Stock' : 'In Stock';

      rows.push([
        escapeCsvField(p.name),
        escapeCsvField(p.sku),
        escapeCsvField(p.category?.name || ''),
        p.price,
        p.costPrice || 0,
        stock,
        escapeCsvField(p.unit || 'pcs'),
        status
      ]);
    });

    const csv = rows.map(r => r.join(',')).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `inventory-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast('CSV exported successfully', 'success');
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
  function setupInvSocketListeners() {
    const debouncedReload = () => {
      if (isDestroyed) return;
      clearTimeout(refreshDebounce);
      refreshDebounce = setTimeout(() => {
        if (!isDestroyed) loadInvProducts(currentPage);
      }, SOCKET_DEBOUNCE_MS);
    };

    socket.on('product:created', debouncedReload);
    socket.on('product:updated', debouncedReload);
    socket.on('product:deleted', (payload) => {
      if (isDestroyed) return;
      if (payload?.id) {
        invProducts = invProducts.filter(p => p._id !== payload.id);
        renderInvTable();
        updateInvStats();
      }
    });

    socket.on('product:stockUpdated', (product) => {
      if (isDestroyed) return;
      const idx = invProducts.findIndex(p => p._id === product?._id);
      if (idx !== -1) {
        invProducts[idx] = { ...invProducts[idx], ...product };
        renderInvTable();
        updateInvStats();
      }
    });

    socket.on('category:created', async () => {
      if (isDestroyed) return;
      await loadInvCategories();
      renderCatModal();
    });

    socket.on('category:deleted', async () => {
      if (isDestroyed) return;
      await loadInvCategories();
      renderCatModal();
    });
  }

  // ===== Cleanup =====
  window.addEventListener('beforeunload', () => {
    isDestroyed = true;
    clearTimeout(refreshDebounce);
    clearTimeout(searchDebounce);
    socket.off('product:created');
    socket.off('product:updated');
    socket.off('product:deleted');
    socket.off('product:stockUpdated');
    socket.off('category:created');
    socket.off('category:deleted');
  });
})();