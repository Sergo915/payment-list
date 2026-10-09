(() => {
  'use strict';

  const $ = (selector) => document.querySelector(selector);
  const login = $('#login');
  const app = $('#app');
  const boot = $('#boot');
  const loginError = $('#login-error');
  const loading = $('#login-loading');
  const status = $('#status');
  let transactions = [];
  let activeFilter = null;

  function setLoading(active, text = 'Խնդրում ենք սպասել…') {
    loading.textContent = text;
    loading.hidden = !active;
  }

  async function jsonRequest(url, options) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error?.message || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function todayOffset(days) {
    const value = new Date();
    value.setDate(value.getDate() + days);
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }

  function initializeDateRangePicker() {
    const dateFrom = $('#date-from');
    const dateTo = $('#date-to');
    const container = $('.date-range');
    const initialRange = [dateFrom.value, dateTo.value];
    dateFrom.type = 'hidden';
    dateTo.type = 'hidden';

    const field = document.createElement('label');
    field.className = 'modern-range-field';
    const caption = document.createElement('span');
    caption.textContent = 'Ժամանակահատված';
    const pickerInput = document.createElement('input');
    pickerInput.type = 'text';
    pickerInput.id = 'date-range-picker';
    pickerInput.placeholder = 'Ընտրեք սկզբի և վերջի ամսաթվերը';
    pickerInput.readOnly = true;
    field.append(caption, pickerInput);
    container.replaceChildren(field, dateFrom, dateTo);

    const armenianLocale = {
      ...flatpickr.l10ns.hy,
      weekdays: {
        shorthand: ['Կ', 'Ե', 'Ե', 'Չ', 'Հ', 'Ու', 'Շ'],
        longhand: flatpickr.l10ns.hy.weekdays.longhand,
      },
    };
    const picker = flatpickr(pickerInput, {
      mode: 'range',
      dateFormat: 'Y-m-d',
      altInput: true,
      altFormat: 'd.m.Y',
      conjunction: '  →  ',
      defaultDate: initialRange,
      locale: armenianLocale,
      showMonths: 1,
      monthSelectorType: 'static',
      disableMobile: true,
      animate: true,
      position: 'below left',
      appendTo: document.body,
      onChange(selectedDates) {
        if (selectedDates[0]) dateFrom.value = flatpickr.formatDate(selectedDates[0], 'Y-m-d');
        if (selectedDates[1]) dateTo.value = flatpickr.formatDate(selectedDates[1], 'Y-m-d');
      },
      onReady(_dates, _text, instance) {
        instance.calendarContainer.classList.add('modern-range-calendar');
        const shortcuts = document.createElement('div');
        shortcuts.className = 'calendar-shortcuts';
        const ranges = [
          ['7 օր', 6],
          ['30 օր', 29],
          ['Այս ամիս', 'month'],
        ];
        for (const [label, range] of ranges) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = label;
          button.addEventListener('click', () => {
            const end = new Date();
            const start = range === 'month' ? new Date(end.getFullYear(), end.getMonth(), 1) : new Date(end.getFullYear(), end.getMonth(), end.getDate() - range);
            instance.setDate([start, end], true);
            instance.close();
          });
          shortcuts.append(button);
        }
        instance.calendarContainer.append(shortcuts);
      },
    });
    pickerInput.setAttribute('aria-label', 'Ընտրեք ժամանակահատվածը');
    return picker;
  }

  async function showLogin() {
    app.hidden = true;
    boot.hidden = true;
    login.hidden = false;
    try {
      const config = await jsonRequest('/api/auth/config');
      if (!window.google?.accounts?.id) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = 'https://accounts.google.com/gsi/client?hl=hy';
          script.async = true;
          script.onload = resolve;
          script.onerror = () => reject(new Error('Google Sign-In-ը չհաջողվեց բեռնել'));
          document.head.appendChild(script);
        });
      }
      google.accounts.id.initialize({
        client_id: config.googleClientId,
        callback: async ({ credential }) => {
          setLoading(true, 'Google հաշիվը ստուգվում է…');
          loginError.textContent = '';
          try {
            const result = await jsonRequest('/api/auth/google', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential }) });
            $('#google-button').hidden = true;
            $('#login-help').textContent = `${result.email} · մուտքագրեք Authenticator կոդը։`;
            $('#totp-step').hidden = false;
            if (result.requiresEnrollment) {
              const enrollment = await jsonRequest('/api/auth/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
              $('#enrollment').hidden = false;
              $('#qr').src = enrollment.qrCode;
              $('#manual-key').textContent = enrollment.manualKey;
            }
            $('#code').focus();
          } catch (error) { loginError.textContent = error.message; }
          finally { setLoading(false); }
        },
      });
      google.accounts.id.renderButton($('#google-button'), { theme: 'outline', size: 'large', width: Math.min(350, Math.max(220, window.innerWidth - 96)), locale: 'hy' });
    } catch (error) { loginError.textContent = error.message; }
  }

  async function loadAccounts() {
    const result = await jsonRequest('/api/accounts');
    const select = $('#account');
    select.replaceChildren(new Option('Ընտրեք հաշվեհամարը', ''));
    for (const account of result.accounts || []) {
      const balance = Number.isFinite(Number(account.balance)) ? ` · ${new Intl.NumberFormat('hy-AM', { maximumFractionDigits: 2 }).format(Number(account.balance))}` : '';
      select.append(new Option(`${account.number} · ${account.currency || ''}${balance}`, String(account.number)));
    }
    if (!result.accounts?.length) select.replaceChildren(new Option('Հասանելի հաշիվներ չկան', ''));
  }

  async function initialize() {
    $('#date-from').value = todayOffset(-2);
    $('#date-to').value = todayOffset(-1);
    initializeDateRangePicker();
    try {
      const me = await jsonRequest('/api/auth/me');
      $('#logout').textContent = `${me.username} · Ելք`;
      $('#logout').hidden = false;
      await loadAccounts();
      login.hidden = true;
      boot.hidden = true;
      app.hidden = false;
    } catch (error) {
      if (error.status === 401) return showLogin();
      boot.hidden = true;
      app.hidden = false;
      status.textContent = error.message;
    }
  }

  function values() {
    const data = { from: $('#date-from').value, to: $('#date-to').value, account: $('#account').value };
    if (!data.from || !data.to || !data.account) throw new Error('Ընտրեք ամսաթվերը և հաշվեհամարը։');
    if (data.from > data.to) throw new Error('Սկզբի ամսաթիվը չի կարող վերջից ուշ լինել։');
    return data;
  }

  function format(value, type) {
    if (value === null || value === undefined || value === '') return '—';
    if (type === 'amount') return new Intl.NumberFormat('hy-AM', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value));
    if (type === 'date') {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat('hy-AM', { dateStyle: 'short', timeStyle: 'short' }).format(date);
    }
    return String(value);
  }

  function render() {
    const shown = activeFilter === 'credit' ? transactions.filter((x) => Number(x.creditAmount || 0) > 0) : activeFilter === 'debit' ? transactions.filter((x) => Number(x.debitAmount || 0) > 0) : transactions;
    const debit = shown.reduce((sum, item) => sum + Number(item.debitAmount || 0), 0);
    const credit = shown.reduce((sum, item) => sum + Number(item.creditAmount || 0), 0);
    $('#summary').textContent = `${shown.length} գործարք · Ելք ${format(debit, 'amount')} · Մուտք ${format(credit, 'amount')}`;
    document.querySelectorAll('.filter').forEach((button) => button.classList.toggle('active', button.dataset.filter === activeFilter));
    const body = $('#transactions');
    body.replaceChildren();
    if (!shown.length) {
      const row = body.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 8;
      cell.textContent = 'Ընտրված ժամանակահատվածում գործարքներ չկան։';
      return;
    }
    const columns = [['operationDate', 'date', 'Գործարքի ամսաթիվ'], ['creationDate', 'date', 'Ստեղծման ամսաթիվ'], ['debitAmount', 'amount', 'Ելք'], ['creditAmount', 'amount', 'Մուտք'], ['comment', null, 'Նպատակ / մեկնաբանություն'], ['correspondentAccount', null, 'Թղթակից հաշիվ'], ['correspondentName', null, 'Թղթակից'], ['bankTransactionId', null, 'Գործարքի ID']];
    for (const item of shown) {
      const row = body.insertRow();
      for (const [key, type, label] of columns) {
        const cell = row.insertCell();
        cell.dataset.label = label;
        cell.textContent = format(item[key], type);
      }
    }
  }

  async function view() {
    const button = $('#view');
    button.disabled = true;
    status.textContent = '';
    try {
      const data = values();
      const query = new URLSearchParams({ dateFrom: data.from, dateTo: data.to, showAmdEquivalents: 'true' });
      const result = await jsonRequest(`/api/accounts/${encodeURIComponent(data.account)}/transactions?${query}`);
      transactions = result.transactions || [];
      activeFilter = null;
      $('#results').hidden = false;
      render();
    } catch (error) {
      if (error.status === 401) return window.location.reload();
      status.textContent = error.message;
    } finally { button.disabled = false; }
  }

  async function download() {
    const button = $('#download');
    button.disabled = true;
    status.textContent = '';
    try {
      const data = values();
      const query = new URLSearchParams({ dateFrom: data.from, dateTo: data.to });
      const response = await fetch(`/api/accounts/${encodeURIComponent(data.account)}/transactions.xlsx?${query}`, { cache: 'no-store' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const error = new Error(body.error?.message || `HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `statement_${data.account}_${data.from}_${data.to}.xlsx`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      if (error.status === 401) return window.location.reload();
      status.textContent = error.message;
    } finally { button.disabled = false; }
  }

  $('#totp-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    setLoading(true, 'Authenticator կոդը ստուգվում է…');
    loginError.textContent = '';
    try {
      await jsonRequest('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('#code').value }) });
      window.location.reload();
    } catch (error) { loginError.textContent = error.message; $('#code').value = ''; $('#code').focus(); }
    finally { setLoading(false); }
  });
  $('#logout').addEventListener('click', async () => { await fetch('/api/auth/logout', { method: 'POST' }); window.location.reload(); });
  $('#copy-manual-key').addEventListener('click', async () => {
    const button = $('#copy-manual-key');
    const key = $('#manual-key').textContent.trim();
    if (!key) return;
    try {
      await navigator.clipboard.writeText(key);
      button.textContent = 'Պատճենված է';
      setTimeout(() => { button.textContent = 'Պատճենել'; }, 1600);
    } catch {
      const range = document.createRange();
      range.selectNodeContents($('#manual-key'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
  });
  $('#view').addEventListener('click', view);
  $('#download').addEventListener('click', download);
  document.querySelectorAll('.filter').forEach((button) => button.addEventListener('click', () => { activeFilter = activeFilter === button.dataset.filter ? null : button.dataset.filter; render(); }));
  initialize();
})();
