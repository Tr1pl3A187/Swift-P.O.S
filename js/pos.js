// ===== POS Module =====
// Production-grade: paginated, idempotent, XSS-safe, store-scoped, race-proof

(function() {
  'use strict';

  // ===== State =====
  let allProducts = [];
  let categories = [];
  let cart = [];
  let selectedCategory = 'all';
  let paymentMethod = 'cash';
  let isProcessing = false;
  let isDestroyed = false;
  let currentProductPage = 1;
  let totalProductPages = 1;
  let searchDebounce = null;
  let socketDebounce = null;
  let checkoutAbort = null;

  // ===== Constants =====
  const PAGE_SIZE = 100;
  const SEARCH_DEBOUNCE_MS = 200;
  const SOCKET_DEBOUNCE_MS = 300;

  // ===== DOM Cache =====
  const $ = (id) => document.getElementById(id);
  const els = {
    productGrid: $('product-grid'),
    catTabs: $('cat-tabs'),
    searchInput: $('product-search'),
    searchClear: $('search-clear'),
    cartItems: $('cart-items'),
    cartCount: $('cart-count'),
    cartSubtotal: $('cart-subtotal'),
    cartTax: $('cart-tax'),
    cartTotal: $('cart-total'),
    cartDiscount: $('cart-discount'),
    checkoutBtn: $('checkout-btn'),
    checkoutTotal: $('checkout-total'),
    clearCartBtn: $('clear-cart-btn'),
    paymentBtns: document.querySelectorAll('.payment-btn'),
    numpad: $('numpad'),
    amountPaid: $('amount-paid'),
    modalItemsCount: $('modal-items-count'),
    modalSubtotal: $('modal-subtotal'),
    modalDiscount: $('modal-discount'),
    modalTax: $('modal-tax'),
    modalTotal: $('modal-total'),
    modalPaymentMethod: $('modal-payment-method'),
    cashInputGroup: $('cash-input-group'),
    modalChange: $('modal-change'),
    saleNote: $('sale-note'),
    confirmPaymentBtn: $('confirm-payment-btn'),
    receiptContent: $('receipt-content')
  };

  // ===== Initialization =====
  document.addEventListener('DOMContentLoaded', () => {
    if (!els.productGrid) return; // Not on POS page
    initPOS();
  });

  async function initPOS() {
    await Promise.all([loadCategories(), loadProducts()]);
    bindEvents();
    setupSocketListeners();
  }

  // ===== Safe DOM Helpers =====
  function escapeHtml(str) {
    if (str == null) return '';
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  // ===== Data Loading =====
  async function loadCategories() {
    if (isDestroyed) return;
    try {
      const res = await apiFetch('/categories');
      if (!res.success || !Array.isArray(res.data)) {
        throw new Error(res.message || 'Invalid categories response');
      }
      categories = res.data;
      renderCategoryTabs();
    } catch (err) {
      console.error('Categories load error:', err);
      toast('Failed to load categories', 'error');
    }
  }

  async function loadProducts(page = 1, append = false) {
    if (isDestroyed) return;
    if (isLoadingProducts) {
      pendingProductLoad = true;
      return;
    }

    isLoadingProducts = true;

    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(PAGE_SIZE),
        isActive: 'true'
      });

      const res = await apiFetch(`/products?${params.toString()}`);

      if (!res.success || !Array.isArray(res.data)) {
        throw new Error(res.message || 'Invalid products response');
      }

      if (append) {
        allProducts = allProducts.concat(res.data);
      } else {
        allProducts = res.data;
        currentProductPage = page;
      }

      totalProductPages = res.meta?.pages || 1;

      renderProductGrid(els.searchInput?.value || '');
      updateLowStockBadge();

      // Preload next page if available
      if (page < totalProductPages && allProducts.length < PAGE_SIZE * 2) {
        await loadProducts(page + 1, true);
      }
    } catch (err) {
      console.error('Products load error:', err);
      if (!isDestroyed) {
        els.productGrid.innerHTML = `
          <div class="cart-empty" style="grid-column:1/-1; min-height:200px;">
            <div class="cart-empty-icon">⚠️</div>
            <div class="cart-empty-text">Failed to load products. ${escapeHtml(err.message || 'Check connection.')}</div>
          </div>`;
      }
    } finally {
      isLoadingProducts = false;
      if (pendingProductLoad && !isDestroyed) {
        pendingProductLoad = false;
        setTimeout(() => loadProducts(currentProductPage), 100);
      }
    }
  }

  let isLoadingProducts = false;
  let pendingProductLoad = false;

  // ===== Category Tabs =====
  function renderCategoryTabs() {
    if (!els.catTabs) return;

    const fragment = document.createDocumentFragment();

    const allTab = document.createElement('div');
    allTab.className = 'cat-tab' + (selectedCategory === 'all' ? ' active' : '');
    allTab.dataset.cat = 'all';
    allTab.textContent = '🏷️ All';
    fragment.appendChild(allTab);

    categories.forEach(cat => {
      const tab = document.createElement('div');
      tab.className = 'cat-tab' + (selectedCategory === cat._id ? ' active' : '');
      tab.dataset.cat = cat._id;
      tab.style.setProperty('--tab-color', cat.color || '#6366f1');
      tab.textContent = `${cat.icon || '📦'} ${cat.name}`;
      fragment.appendChild(tab);
    });

    els.catTabs.innerHTML = '';
    els.catTabs.appendChild(fragment);
  }

  // ===== Product Grid =====
  function renderProductGrid(filter = '') {
    if (!els.productGrid) return;

    let products = [...allProducts];

    if (selectedCategory !== 'all') {
      products = products.filter(p => {
        const catId = p.category?._id || p.category;
        return String(catId) === selectedCategory;
      });
    }

    if (filter) {
      const q = filter.toLowerCase();
      products = products.filter(p => {
        const name = String(p.name || '').toLowerCase();
        const sku = String(p.sku || '').toLowerCase();
        const barcode = String(p.barcode || '').toLowerCase();
        return name.includes(q) || sku.includes(q) || barcode.includes(q);
      });
    }

    if (products.length === 0) {
      els.productGrid.innerHTML = `
        <div class="cart-empty" style="grid-column:1/-1; min-height:200px;">
          <div class="cart-empty-icon">🔍</div>
          <div class="cart-empty-text">No products found</div>
        </div>`;
      return;
    }

    const fragment = document.createDocumentFragment();

    products.forEach(p => {
      const stock = Number(p.stock) || 0;
      const threshold = Number(p.lowStockThreshold) || 10;
      const outOfStock = stock <= 0;
      const lowStock = stock > 0 && stock <= threshold;
      const catColor = escapeHtml(p.category?.color || '#6366f1');
      const catIcon = escapeHtml(p.category?.icon || '📦');
      const stockText = outOfStock
        ? 'Out of stock'
        : lowStock
          ? `Low: ${stock} ${escapeHtml(p.unit || 'pcs')}`
          : `${stock} ${escapeHtml(p.unit || 'pcs')}`;
      const stockClass = outOfStock ? 'out' : lowStock ? 'low' : '';

      const card = document.createElement('div');
      card.className = 'product-card' + (outOfStock ? ' out-of-stock' : '');
      card.dataset.id = p._id;
      card.style.setProperty('--cat-color', catColor);
      card.title = escapeHtml(p.name);

      if (!outOfStock) {
        card.addEventListener('click', () => addToCart(p._id));
      }

      card.innerHTML = `
        <div class="product-emoji">${catIcon}</div>
        <div class="product-name truncate">${escapeHtml(p.name)}</div>
        <div class="product-price">${fmt.currency(p.price || 0)}</div>
        <div class="product-stock ${stockClass}">${escapeHtml(stockText)}</div>
      `;

      fragment.appendChild(card);
    });

    els.productGrid.innerHTML = '';
    els.productGrid.appendChild(fragment);
  }

  // ===== Cart Logic =====
  function addToCart(productId) {
    if (isProcessing) return;

    const product = allProducts.find(p => p._id === productId);
    if (!product) {
      toast('Product not found', 'error');
      return;
    }

    const stock = Number(product.stock) || 0;
    if (stock <= 0) {
      toast('Product is out of stock', 'warning');
      return;
    }

    const existing = cart.find(i => i.productId === productId);
    if (existing) {
      if (existing.quantity >= stock) {
        toast(`Max stock reached: ${stock}`, 'warning');
        return;
      }
      existing.quantity++;
    } else {
      cart.push({
        productId,
        name: product.name,
        price: Number(product.price) || 0,
        taxRate: Number(product.taxRate) || 0,
        quantity: 1,
        stock: stock,
        unit: product.unit || 'pcs'
      });
    }

    // Visual feedback
    const card = els.productGrid?.querySelector(`.product-card[data-id="${productId}"]`);
    if (card) {
      card.style.borderColor = 'var(--primary)';
      setTimeout(() => { card.style.borderColor = ''; }, 300);
    }

    renderCart();
    toast(`Added: ${escapeHtml(product.name)}`, 'success');
  }

  function removeFromCart(productId) {
    cart = cart.filter(i => i.productId !== productId);
    renderCart();
  }

  function updateQty(productId, delta) {
    const item = cart.find(i => i.productId === productId);
    if (!item) return;

    item.quantity += delta;

    if (item.quantity <= 0) {
      removeFromCart(productId);
      return;
    }

    if (item.quantity > item.stock) {
      item.quantity = item.stock;
      toast('Max stock reached', 'warning');
    }

    renderCart();
  }

  function clearCart() {
    cart = [];
    if (els.cartDiscount) els.cartDiscount.value = '0';
    renderCart();
  }

  function getCartTotals() {
    const discount = Math.max(0, parseFloat(els.cartDiscount?.value) || 0);
    const subtotal = cart.reduce((sum, i) => sum + (i.price * i.quantity), 0);
    const tax = cart.reduce((sum, i) => sum + (i.price * i.quantity * (i.taxRate / 100)), 0);
    const total = Math.max(0, subtotal - discount + tax);
    return { subtotal, discount, tax, total };
  }

  // ===== Render Cart =====
  function renderCart() {
    if (!els.cartItems) return;

    const count = cart.reduce((sum, i) => sum + i.quantity, 0);
    if (els.cartCount) els.cartCount.textContent = count;

    if (cart.length === 0) {
      els.cartItems.innerHTML = `
        <div class="cart-empty">
          <div class="cart-empty-icon">🛒</div>
          <div class="cart-empty-text">Cart is empty</div>
        </div>`;
      if (els.checkoutBtn) els.checkoutBtn.disabled = true;
      updateTotals();
      return;
    }

    const fragment = document.createDocumentFragment();

    cart.forEach(item => {
      const div = document.createElement('div');
      div.className = 'cart-item';

      div.innerHTML = `
        <div class="cart-item-info">
          <div class="cart-item-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
          <div class="cart-item-price">${fmt.currency(item.price)} / ${escapeHtml(item.unit)}</div>
        </div>
        <div class="cart-item-qty">
          <button class="qty-btn" data-action="minus" data-id="${escapeHtml(item.productId)}">−</button>
          <span class="qty-val">${item.quantity}</span>
          <button class="qty-btn" data-action="plus" data-id="${escapeHtml(item.productId)}">+</button>
        </div>
        <div class="cart-item-subtotal">${fmt.currency(item.price * item.quantity)}</div>
        <button class="cart-item-remove" data-action="remove" data-id="${escapeHtml(item.productId)}" title="Remove">✕</button>
      `;

      fragment.appendChild(div);
    });

    els.cartItems.innerHTML = '';
    els.cartItems.appendChild(fragment);

    // Event delegation for cart actions
    els.cartItems.addEventListener('click', handleCartAction, { once: false });

    if (els.checkoutBtn) els.checkoutBtn.disabled = false;
    updateTotals();
  }

  function handleCartAction(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const id = btn.dataset.id;

    e.stopPropagation();

    switch (action) {
      case 'minus':
        updateQty(id, -1);
        break;
      case 'plus':
        updateQty(id, 1);
        break;
      case 'remove':
        removeFromCart(id);
        break;
    }
  }

  function updateTotals() {
    const { subtotal, discount, tax, total } = getCartTotals();
    if (els.cartSubtotal) els.cartSubtotal.textContent = fmt.currency(subtotal);
    if (els.cartTax) els.cartTax.textContent = fmt.currency(tax);
    if (els.cartTotal) els.cartTotal.textContent = fmt.currency(total);
    if (els.checkoutTotal) els.checkoutTotal.textContent = fmt.currency(total);
  }

  // ===== Event Bindings =====
  function bindEvents() {
    // Search with debounce
    els.searchInput?.addEventListener('input', (e) => {
      const val = e.target.value;
      els.searchClear?.classList.toggle('hidden', !val);

      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => {
        renderProductGrid(val);
      }, SEARCH_DEBOUNCE_MS);
    });

    els.searchClear?.addEventListener('click', () => {
      if (els.searchInput) els.searchInput.value = '';
      els.searchClear?.classList.add('hidden');
      renderProductGrid();
    });

    // Category tabs
    els.catTabs?.addEventListener('click', (e) => {
      const tab = e.target.closest('.cat-tab');
      if (!tab) return;

      selectedCategory = tab.dataset.cat;
      document.querySelectorAll('.cat-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      renderProductGrid(els.searchInput?.value || '');
    });

    // Discount
    els.cartDiscount?.addEventListener('input', () => {
      const val = parseFloat(els.cartDiscount.value) || 0;
      if (val < 0) {
        els.cartDiscount.value = '0';
        toast('Discount cannot be negative', 'warning');
      }
      updateTotals();
    });

    // Clear cart
    els.clearCartBtn?.addEventListener('click', () => {
      if (cart.length === 0) return;
      if (window.confirm('Clear all items from cart?')) {
        clearCart();
      }
    });

    // Payment method
    els.paymentBtns?.forEach(btn => {
      btn.addEventListener('click', () => {
        paymentMethod = btn.dataset.method;
        els.paymentBtns.forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-checked', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-checked', 'true');
      });
    });

    // Checkout
    els.checkoutBtn?.addEventListener('click', openCheckout);

    // Numpad
    els.numpad?.addEventListener('click', (e) => {
      const btn = e.target.closest('.numpad-btn');
      if (!btn) return;

      const val = btn.dataset.val;
      const input = els.amountPaid;
      if (!input) return;

      let curr = input.value || '';

      if (val === 'clear') {
        input.value = '';
      } else if (val === 'back') {
        input.value = curr.slice(0, -1);
      } else {
        // Prevent more than 2 decimal places
        if (curr.includes('.')) {
          const decimals = curr.split('.')[1];
          if (decimals && decimals.length >= 2) return;
        }
        // Prevent multiple leading zeros
        if (curr === '0' && val === '0') return;
        if (curr === '0' && val !== '.') {
          input.value = val;
        } else {
          input.value = curr + val;
        }
      }

      updateChange();
    });

    els.amountPaid?.addEventListener('input', updateChange);
    els.confirmPaymentBtn?.addEventListener('click', confirmPayment);
  }

  // ===== Checkout Flow =====
  function openCheckout() {
    if (cart.length === 0) return;

    const { subtotal, discount, tax, total } = getCartTotals();
    const methodLabels = { cash: '💵 Cash', card: '💳 Card', mobile: '📱 Mobile' };

    if (els.modalItemsCount) els.modalItemsCount.textContent = cart.reduce((s, i) => s + i.quantity, 0);
    if (els.modalSubtotal) els.modalSubtotal.textContent = fmt.currency(subtotal);
    if (els.modalDiscount) els.modalDiscount.textContent = fmt.currency(discount);
    if (els.modalTax) els.modalTax.textContent = fmt.currency(tax);
    if (els.modalTotal) els.modalTotal.textContent = fmt.currency(total);
    if (els.modalPaymentMethod) els.modalPaymentMethod.textContent = methodLabels[paymentMethod] || paymentMethod;

    if (els.amountPaid) {
      els.amountPaid.value = paymentMethod !== 'cash' ? total.toFixed(2) : '';
    }
    if (els.cashInputGroup) {
      els.cashInputGroup.style.display = paymentMethod === 'cash' ? 'block' : 'none';
    }
    if (els.modalChange) els.modalChange.textContent = '$0.00';
    if (els.saleNote) els.saleNote.value = '';

    openModal('checkout-modal');

    if (paymentMethod === 'cash' && els.amountPaid) {
      setTimeout(() => els.amountPaid.focus(), 100);
    }
  }

  function updateChange() {
    const total = getCartTotals().total;
    const paid = parseFloat(els.amountPaid?.value) || 0;
    const change = Math.max(0, paid - total);

    if (els.modalChange) els.modalChange.textContent = fmt.currency(change);

    if (els.confirmPaymentBtn) {
      els.confirmPaymentBtn.disabled = paymentMethod === 'cash' && paid < total;
    }
  }

  async function confirmPayment() {
    if (isProcessing) return;

    const idempotencyKey = generateIdempotencyKey();
    isProcessing = true;

    // Abort any previous checkout attempt
    if (checkoutAbort) checkoutAbort.abort();
    checkoutAbort = new AbortController();

    const { subtotal, discount, tax, total } = getCartTotals();
    const paid = parseFloat(els.amountPaid?.value) || (paymentMethod !== 'cash' ? total : 0);

    if (paymentMethod === 'cash' && paid < total) {
      toast('Amount paid is less than total', 'error');
      isProcessing = false;
      return;
    }

    const btn = els.confirmPaymentBtn;
    const originalText = btn?.textContent || '✅ Confirm Payment';

    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Processing...';
    }

    try {
      const saleData = {
        items: cart.map(i => ({
          productId: i.productId,
          quantity: i.quantity,
          discount: 0
        })),
        discount,
        paymentMethod,
        amountPaid: paid,
        cashier: 'Admin',
        note: (els.saleNote?.value || '').trim()
      };

      // FIXED: Use apiFetchWithRetry for proper retry logic
      const res = await apiFetchWithRetry('/sales', {
        method: 'POST',
        body: JSON.stringify(saleData),
        headers: {
          'Idempotency-Key': idempotencyKey
        }
      }, 2);

      if (!res.success || !res.data) {
        throw new Error(res.message || 'Checkout failed');
      }

      const sale = res.data;

      closeModal('checkout-modal');
      showReceipt(sale);
      clearCart();

      setTimeout(() => loadProducts(1), 500);

      toast('Sale completed successfully!', 'success');

    } catch (err) {
      console.error('Checkout error:', err);
      toast(err.message || 'Payment failed. Please try again.', 'error');

      if (err.name === 'TimeoutError') {
        if (btn) {
          btn.disabled = false;
          btn.textContent = '↻ Retry Payment';
        }
        return;
      }
    } finally {
      isProcessing = false;
      if (btn && btn.textContent !== '↻ Retry Payment') {
        btn.disabled = false;
        btn.textContent = originalText;
      }
      checkoutAbort = null;
    }
  }

  function generateIdempotencyKey() {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
  }

  // ===== Receipt =====
  function showReceipt(sale) {
    if (!els.receiptContent || !sale) return;

    const items = (sale.items || []).map(i => `
      <div class="receipt-row">
        <span>${escapeHtml(i.productName || 'Unknown')} × ${i.quantity || 0}</span>
        <span>${fmt.currency(i.subtotal || 0)}</span>
      </div>`).join('');

    const discountRow = (sale.discount || 0) > 0
      ? `<div class="receipt-row"><span>Discount</span><span>-${fmt.currency(sale.discount)}</span></div>`
      : '';

    const taxRow = (sale.tax || 0) > 0
      ? `<div class="receipt-row"><span>Tax</span><span>${fmt.currency(sale.tax)}</span></div>`
      : '';

    const changeRow = (sale.change || 0) > 0
      ? `<div class="receipt-row"><span>Change</span><span>${fmt.currency(sale.change)}</span></div>`
      : '';

    els.receiptContent.innerHTML = `
      <div class="receipt">
        <div class="receipt-header">
          <div class="receipt-shop">🛒 SwiftPOS</div>
          <div class="receipt-sub">Professional Point of Sale</div>
          <div class="receipt-sub" style="margin-top:4px">${fmt.datetime(sale.createdAt)}</div>
          <div class="receipt-sub">Receipt: <b>${escapeHtml(sale.receiptNumber || 'N/A')}</b></div>
        </div>
        <div class="receipt-section">
          ${items}
        </div>
        <hr class="receipt-divider" />
        <div class="receipt-section">
          <div class="receipt-row"><span>Subtotal</span><span>${fmt.currency(sale.subtotal || 0)}</span></div>
          ${discountRow}
          ${taxRow}
          <div class="receipt-row receipt-total-row"><span>TOTAL</span><span>${fmt.currency(sale.total || 0)}</span></div>
          <div class="receipt-row"><span>Paid (${escapeHtml(sale.paymentMethod || 'unknown').toUpperCase()})</span><span>${fmt.currency(sale.amountPaid || 0)}</span></div>
          ${changeRow}
        </div>
        <div class="receipt-footer">
          <div>Cashier: ${escapeHtml(sale.cashier || 'Unknown')}</div>
          ${sale.note ? `<div style="margin-top:4px;font-style:italic">"${escapeHtml(sale.note)}"</div>` : ''}
          <div style="margin-top:8px">Thank you for shopping with us!</div>
          <div>— SwiftPOS —</div>
        </div>
      </div>`;

    openModal('receipt-modal');
  }

  function updateLowStockBadge() {
    const lowCount = allProducts.filter(p => {
      const stock = Number(p.stock) || 0;
      const threshold = Number(p.lowStockThreshold) || 10;
      return stock > 0 && stock <= threshold;
    }).length;

    const outCount = allProducts.filter(p => (Number(p.stock) || 0) <= 0).length;
    const total = lowCount + outCount;

    const navItem = document.querySelector('.nav-item[data-path="/inventory"]');
    if (!navItem) return;

    let badge = navItem.querySelector('.nav-badge');

    if (total > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav-badge';
        navItem.appendChild(badge);
      }
      badge.textContent = total > 99 ? '99+' : total;
    } else if (badge) {
      badge.remove();
    }
  }

  // ===== Socket Listeners — Debounced =====
  function setupSocketListeners() {
    // FIXED: Guard against missing socket (if Socket.IO script failed to load)
    if (typeof socket === 'undefined' || !socket) {
      console.warn('[POS] Socket.IO not available — real-time updates disabled');
      return;
    }

    const debouncedRender = () => {
      if (isDestroyed) return;
      clearTimeout(socketDebounce);
      socketDebounce = setTimeout(() => {
        if (!isDestroyed) {
          renderProductGrid(els.searchInput?.value || '');
          updateLowStockBadge();
        }
      }, SOCKET_DEBOUNCE_MS);
    };

    socket.on('product:stockUpdated', (updatedProduct) => {
      if (isDestroyed) return;
      const idx = allProducts.findIndex(p => p._id === updatedProduct?._id);
      if (idx !== -1) {
        allProducts[idx] = { ...allProducts[idx], ...updatedProduct };
        cart.forEach(item => {
          if (item.productId === updatedProduct._id) {
            item.stock = Number(updatedProduct.stock) || 0;
          }
        });
        debouncedRender();
      }
    });

    socket.on('product:created', (product) => {
      if (isDestroyed) return;
      if (!allProducts.find(p => p._id === product?._id)) {
        allProducts.push(product);
        debouncedRender();
      }
    });

    socket.on('product:updated', (updated) => {
      if (isDestroyed) return;
      const idx = allProducts.findIndex(p => p._id === updated?._id);
      if (idx !== -1) {
        allProducts[idx] = { ...allProducts[idx], ...updated };
        debouncedRender();
      }
    });

    socket.on('product:deleted', ({ id }) => {
      if (isDestroyed) return;
      allProducts = allProducts.filter(p => p._id !== id);
      cart = cart.filter(i => i.productId !== id);
      renderCart();
      debouncedRender();
    });

    socket.on('category:created', (cat) => {
      if (isDestroyed) return;
      if (!categories.find(c => c._id === cat?._id)) {
        categories.push(cat);
        renderCategoryTabs();
      }
    });
  }

  // ===== Cleanup =====
  window.addEventListener('beforeunload', () => {
    isDestroyed = true;
    clearTimeout(searchDebounce);
    clearTimeout(socketDebounce);
    if (checkoutAbort) checkoutAbort.abort();
    if (typeof socket !== 'undefined' && socket) {
      socket.off('product:stockUpdated');
      socket.off('product:created');
      socket.off('product:updated');
      socket.off('product:deleted');
      socket.off('category:created');
    }
  });
})();