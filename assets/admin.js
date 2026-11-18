/* seller console. talks to /.netlify/functions/admin only.
   the token sits in sessionStorage: it survives a refresh, dies with the tab. */
(function () {
  'use strict';

  var FN = '/.netlify/functions/admin';
  var KEY = 'slate:adm';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var fmtDate = function (ms) {
    if (!ms) return '-';
    var d = new Date(ms);
    return d.toISOString().slice(0, 10);
  };
  var fmtStamp = function (ms) {
    if (!ms) return '-';
    var d = new Date(ms);
    return d.toISOString().slice(5, 16).replace('T', ' ');
  };
  var money = function (n) { return '$' + Number(n || 0).toLocaleString('en-US'); };

  var gate = $('#gate'), consoleBox = $('#console'), rowsBox = $('#admRows'), detail = $('#admDetail');
  var q = $('#admQ'), per = $('#admPer'), countEl = $('#admCount'), statsEl = $('#admStats');
  var toastEl = $('#admToast'), envEl = $('#admEnv'), outBtn = $('#admOut');
  var headEl = $('.adm-head'), modeBtn = $('#admMode'), exportBtn = $('#admExport');
  var headOrders = headEl.innerHTML;
  var state = {
    token: '', otp: '', page: 1, q: '', selected: null, rows: [], total: 0,
    mode: 'orders', tickets: [], tsel: null, ticketsOpen: 0
  };
  var toastTimer;

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2200);
  }

  function call(action, extra) {
    var body = Object.assign({ action: action }, extra || {});
    return fetch(FN, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-token': state.token,
        'x-admin-otp': state.otp || ''
      },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 || r.status === 403) {
          if (j.error === 'bad_otp') throw new Error('2fa code rejected');
          if (j.error === 'no_admin_token') throw new Error('ADMIN_TOKEN is not set on the server');
          throw new Error('token rejected');
        }
        if (!r.ok) throw new Error(j.error || ('request failed: ' + r.status));
        return j;
      });
    });
  }

  /* ---------- gate ---------- */
  function unlock(token, otp) {
    state.token = token;
    state.otp = otp;
    return call('login').then(function (j) {
      sessionStorage.setItem(KEY, JSON.stringify({ token: token, otp: otp }));
      gate.hidden = true;
      consoleBox.hidden = false;
      envEl.textContent = 'live';
      outBtn.hidden = false;
      paintStats(j.stats);
      return load();
    });
  }

  $('#gateForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var token = $('#admToken').value.trim();
    var otp = $('#admOtp').value.replace(/\D/g, '');
    var status = $('#gateStatus');
    if (!token) { status.textContent = 'token required'; return; }
    status.textContent = 'checking...';
    unlock(token, otp).then(function () {
      status.textContent = '';
    }).catch(function (err) {
      status.textContent = err.message;
      state.token = '';
      state.otp = '';
    });
  });

  outBtn.addEventListener('click', function () {
    sessionStorage.removeItem(KEY);
    state.token = '';
    state.otp = '';
    state.selected = null;
    state.tsel = null;
    state.mode = 'orders';
    state.tickets = [];
    headEl.className = 'adm-head';
    headEl.innerHTML = headOrders;
    per.hidden = false;
    exportBtn.hidden = false;
    q.value = '';
    q.placeholder = 'search email, key, tier or machine';
    gate.hidden = false;
    consoleBox.hidden = true;
    detail.hidden = true;
    outBtn.hidden = true;
    envEl.textContent = 'locked';
    $('#admToken').value = '';
    $('#admOtp').value = '';
  });

  /* ---------- stats ---------- */
  function paintStats(s) {
    if (!s) return;
    state.ticketsOpen = s.ticketsOpen || 0;
    if (state.mode === 'orders') {
      modeBtn.textContent = 'tickets' + (state.ticketsOpen ? ' (' + state.ticketsOpen + ')' : '');
    }
    var cells = [
      ['orders', s.orders],
      ['live keys', s.live],
      ['revenue', money(s.revenue)],
      ['last 24h', s.last24],
      ['last 7d', s.last7],
      ['bound pcs', s.bound],
      ['revoked', s.revoked],
      ['permanent', s.byTier.life || 0],
      ['tickets open', state.ticketsOpen]
    ];
    statsEl.innerHTML = cells.map(function (c) {
      return '<div class="adm-stat"><span class="k">' + c[0] + '</span><span class="v">' + esc(c[1]) + '</span></div>';
    }).join('');
  }

  /* ---------- list ---------- */
  function tierLabel(t) {
    return ({ day: '1 day', week: '7 days', month: '30 days', quarter: '90 days', life: 'permanent', once: 'one-time' })[t] || t || '-';
  }

  function rowState(r) {
    if (r.revoked) return ['revoked', 'dead'];
    if (r.expires && Date.now() > r.expires) return ['expired', 'dead'];
    return ['live', 'live'];
  }

  function paintRows(rows) {
    if (!rows.length) {
      rowsBox.innerHTML = '<div class="adm-empty">no orders match that search</div>';
      return;
    }
    rowsBox.innerHTML = rows.map(function (r) {
      var st = rowState(r);
      return '<div class="adm-row' + (state.selected === r.email ? ' sel' : '') + '" data-email="' + esc(r.email) + '">' +
        '<span class="e" title="' + esc(r.email) + '">' + esc(r.email) + '</span>' +
        '<span class="t">' + esc(tierLabel(r.tier)) + '</span>' +
        '<span class="x">' + (r.expires ? fmtDate(r.expires) : 'never') + '</span>' +
        '<span class="r">' + (r.resets === null ? '&infin;' : r.resets) + '</span>' +
        '<span class="k" title="' + esc(r.machine ? r.machine.name : '') + '">' + esc(r.machine ? r.machine.name : '-') + '</span>' +
        '<span class="st ' + st[1] + '">' + st[0] + '</span>' +
        '</div>';
    }).join('');
  }

  function load() {
    return call('list', { q: state.q, page: state.page, per: Number(per.value) }).then(function (j) {
      state.rows = j.rows;
      state.total = j.total;
      paintStats(j.stats);
      paintRows(j.rows);
      var from = j.total ? (j.page - 1) * j.per + 1 : 0;
      var to = Math.min(j.page * j.per, j.total);
      countEl.textContent = j.total + ' orders  ' + from + '-' + to;
      if (state.selected) {
        var still = j.rows.filter(function (r) { return r.email === state.selected; })[0];
        if (still) paintDetail(still);
      }
    }).catch(function (err) {
      rowsBox.innerHTML = '<div class="adm-empty">' + esc(err.message) + '</div>';
    });
  }

  /* ---------- tickets ---------- */
  function paintTickets() {
    var qq = state.q.toLowerCase();
    var list = qq
      ? state.tickets.filter(function (t) {
          return [t.id, t.email, t.subject, t.key || ''].join(' ').toLowerCase().indexOf(qq) >= 0;
        })
      : state.tickets;
    if (!list.length) {
      rowsBox.innerHTML = '<div class="adm-empty">' +
        (state.tickets.length ? 'no tickets match that search' : 'no tickets yet') + '</div>';
      return;
    }
    rowsBox.innerHTML = list.map(function (t) {
      var closed = t.status === 'closed';
      return '<div class="adm-trow' + (state.tsel === t.id ? ' sel' : '') + '" data-tid="' + esc(t.id) + '">' +
        '<span class="id">' + esc(t.id) + '</span>' +
        '<span class="sj">' + esc(t.subject) +
          '<small>' + esc(t.email) + ' &middot; ' + fmtStamp(t.at) + '</small></span>' +
        '<span class="st' + (closed ? ' closed' : '') + '">' + (closed ? 'closed' : 'open') + '</span>' +
        '</div>';
    }).join('');
  }

  function loadTickets() {
    return call('tickets').then(function (j) {
      state.tickets = j.rows || [];
      state.ticketsOpen = j.open || 0;
      paintTickets();
      countEl.textContent = j.total + ' tickets  ' + j.open + ' open';
      modeBtn.textContent = 'orders';
      if (state.tsel) {
        var still = state.tickets.filter(function (t) { return t.id === state.tsel; })[0];
        if (still) paintTicket(still);
      }
    }).catch(function (err) {
      rowsBox.innerHTML = '<div class="adm-empty">' + esc(err.message) + '</div>';
    });
  }

  function paintTicket(t) {
    state.tsel = t.id;
    detail.hidden = false;
    var closed = t.status === 'closed';
    detail.innerHTML =
      '<div class="hd"><b>' + esc(t.id) + '</b><span class="badge ' + (closed ? '' : 'on') + '">' +
        (closed ? 'closed' : 'open') + '</span></div>' +
      '<div class="bd">' +
        '<div class="kv">' +
          '<span class="k">subject</span><span class="v">' + esc(t.subject) + '</span>' +
          '<span class="k">email</span><span class="v">' + esc(t.email) + '</span>' +
          '<span class="k">key</span><span class="v">' + esc(t.key || 'not given') + '</span>' +
          '<span class="k">opened</span><span class="v">' + fmtStamp(t.at) + '</span>' +
          (t.closedAt ? '<span class="k">closed</span><span class="v">' + fmtStamp(t.closedAt) + '</span>' : '') +
        '</div>' +
        '<div class="adm-ticket">' + esc(t.body) + '</div>' +
        '<div class="adm-acts">' +
          (closed
            ? '<button data-t="open">reopen</button>'
            : '<button data-t="close" class="danger">close</button>') +
          '<button data-t="order">find order</button>' +
        '</div>' +
      '</div>';

    detail.querySelectorAll('[data-t]').forEach(function (b) {
      b.addEventListener('click', function () { ticketAct(b.dataset.t, t); });
    });
  }

  function ticketAct(what, t) {
    if (what === 'order') {
      setMode('orders', t.email);
      return;
    }
    call('ticket-' + what, { id: t.id }).then(function (j) {
      toast('ticket ' + (what === 'close' ? 'closed' : 'reopened'));
      if (j.ticket) paintTicket(j.ticket);
      loadTickets();
    }).catch(function (err) { toast(err.message); });
  }

  function setMode(m, prefill) {
    if (m === state.mode) return;
    state.mode = m;
    state.selected = null;
    state.tsel = null;
    state.q = prefill || '';
    q.value = prefill || '';
    state.page = 1;
    detail.hidden = true;

    if (m === 'tickets') {
      per.hidden = true;
      exportBtn.hidden = true;
      headEl.className = 'adm-head tickets';
      headEl.innerHTML = '<span>id</span><span>subject</span><span>state</span>';
      q.placeholder = 'search ticket id, email, subject or key';
      countEl.textContent = '';
      rowsBox.innerHTML = '<div class="adm-empty">loading...</div>';
      loadTickets();
    } else {
      per.hidden = false;
      exportBtn.hidden = false;
      headEl.className = 'adm-head';
      headEl.innerHTML = headOrders;
      q.placeholder = 'search email, key, tier or machine';
      countEl.textContent = '';
      modeBtn.textContent = 'tickets' + (state.ticketsOpen ? ' (' + state.ticketsOpen + ')' : '');
      load();
    }
  }

  /* ---------- detail ---------- */
  function paintDetail(r) {
    state.selected = r.email;
    detail.hidden = false;
    var st = rowState(r);
    var hist = (r.history || []).map(function (h) {
      return '<li><span>' + esc(fmtStamp(h.at)) + '</span><span class="w">' + esc(h.what) + '</span><span>' + esc(h.note || '') + '</span></li>';
    }).join('');

    detail.innerHTML =
      '<div class="hd"><b>' + esc(r.email) + '</b><span class="badge ' + (st[1] === 'live' ? 'on' : '') + '">' + st[0] + '</span></div>' +
      '<div class="bd">' +
        '<div class="kv">' +
          '<span class="k">key</span><span class="v">' + esc(r.key) + '</span>' +
          '<span class="k">tier</span><span class="v">' + esc(tierLabel(r.tier)) + '</span>' +
          '<span class="k">bought</span><span class="v">' + fmtDate(r.created) + '</span>' +
          '<span class="k">started</span><span class="v">' + fmtDate(r.started) + '</span>' +
          '<span class="k">expires</span><span class="v">' + (r.expires ? fmtDate(r.expires) : 'never') + '</span>' +
          '<span class="k">resets left</span><span class="v">' + (r.resets === null ? 'unlimited' : r.resets) + '</span>' +
          '<span class="k">machine</span><span class="v">' + esc(r.machine ? (r.machine.name + '  ' + (r.machine.hwid || '')) : 'not bound') + '</span>' +
          '<span class="k">paid</span><span class="v">' + money(r.spent) + ' over ' + (r.orders || 1) + ' order' + ((r.orders || 1) === 1 ? '' : 's') + '</span>' +
        '</div>' +
        '<div class="adm-acts">' +
          '<button data-a="copy">copy key</button>' +
          '<button data-a="resend">resend</button>' +
          '<button data-a="reset">free reset</button>' +
          '<button data-a="unbind">unbind</button>' +
          '<button data-a="extend">+7 days</button>' +
          (r.revoked
            ? '<button data-a="unrevoke">restore</button>'
            : '<button data-a="revoke" class="danger">revoke</button>') +
        '</div>' +
        '<div class="adm-note">' +
          '<input id="admNote" placeholder="support note" value="' + esc(r.note || '') + '">' +
          '<button type="button" data-a="note">save</button>' +
        '</div>' +
        '<p class="note" style="margin:0 0 4px">history</p>' +
        '<ul class="adm-hist">' + (hist || '<li><span>-</span><span>-</span><span>nothing yet</span></li>') + '</ul>' +
      '</div>';

    detail.querySelectorAll('[data-a]').forEach(function (b) {
      b.addEventListener('click', function () { act(b.dataset.a, r); });
    });
  }

  function act(what, r) {
    var email = r.email;
    if (what === 'copy') {
      navigator.clipboard.writeText(r.key).then(function () { toast('key copied'); },
        function () { toast('copy blocked by the browser'); });
      return;
    }
    if (what === 'revoke' && !confirm('revoke ' + email + '? their key stops working immediately.')) return;

    var note = $('#admNote') ? $('#admNote').value.trim() : '';
    var map = {
      resend: ['resend', {}],
      reset: ['reset', { note: note || 'support reset' }],
      unbind: ['unbind', {}],
      extend: ['extend', { days: 7 }],
      revoke: ['revoke', { note: note }],
      unrevoke: ['unrevoke', { note: note }],
      note: ['note', { note: note }]
    };
    var m = map[what];
    if (!m) return;

    call(m[0], Object.assign({ email: email }, m[1])).then(function (j) {
      toast(what + ' ok');
      if (j.row) paintDetail(j.row);
      load();
    }).catch(function (err) {
      toast(err.message);
    });
  }

  rowsBox.addEventListener('click', function (e) {
    var trow = e.target.closest('.adm-trow');
    if (trow) {
      var tid = trow.dataset.tid;
      rowsBox.querySelectorAll('.adm-trow').forEach(function (x) { x.classList.remove('sel'); });
      trow.classList.add('sel');
      var hit = state.tickets.filter(function (t) { return t.id === tid; })[0];
      if (hit) paintTicket(hit);
      return;
    }
    var row = e.target.closest('.adm-row');
    if (!row) return;
    var email = row.dataset.email;
    rowsBox.querySelectorAll('.adm-row').forEach(function (x) { x.classList.remove('sel'); });
    row.classList.add('sel');
    call('get', { email: email }).then(function (j) { paintDetail(j.row); })
      .catch(function (err) { toast(err.message); });
  });

  modeBtn.addEventListener('click', function () {
    setMode(state.mode === 'orders' ? 'tickets' : 'orders');
  });

  /* ---------- toolbar ---------- */
  var debounce;
  q.addEventListener('input', function () {
    clearTimeout(debounce);
    debounce = setTimeout(function () {
      state.q = q.value.trim();
      if (state.mode === 'tickets') { paintTickets(); return; }
      state.page = 1;
      load();
    }, 220);
  });

  per.addEventListener('change', function () { state.page = 1; load(); });
  $('#admRefresh').addEventListener('click', function () {
    var p = state.mode === 'tickets' ? loadTickets() : load();
    p.then(function () { toast('refreshed'); });
  });

  $('#admExport').addEventListener('click', function () {
    call('export', { q: state.q }).then(function (j) {
      var blob = new Blob([j.csv], { type: 'text/csv' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'slate-orders-' + new Date().toISOString().slice(0, 10) + '.csv';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      toast(j.count + ' rows exported');
    }).catch(function (err) { toast(err.message); });
  });

  /* ---------- resume ---------- */
  try {
    var saved = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (saved && saved.token) {
      unlock(saved.token, saved.otp || '').catch(function () {
        sessionStorage.removeItem(KEY);
      });
    }
  } catch (e) { /* nothing saved */ }
})();
