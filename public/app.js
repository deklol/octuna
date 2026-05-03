(function () {
  const dz = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const pickBtn = document.getElementById('pickBtn');
  const results = document.getElementById('results');
  const status = document.getElementById('status');
  const statsEl = document.getElementById('stats');
  const visitors = document.getElementById('visitors');
  const fmtSel = document.getElementById('fmt');
  const addrBar = document.getElementById('addrBar');
  const greet = document.getElementById('greet');

  const loginForm = document.getElementById('loginForm');
  const loggedIn = document.getElementById('loggedIn');
  const loginMsg = document.getElementById('loginMsg');
  const adminWho = document.getElementById('adminWho');
  const logoutBtn = document.getElementById('logoutBtn');

  // Defer to server-rendered config (injected as window.OCTUNA below)
  const cfg = window.OCTUNA || { addressBarMode: 'real', addressBarFixed: '' };

  // --- Address bar mirrors real URL or shows configured fixed string ---
  function refreshAddrBar() {
    if (cfg.addressBarMode === 'fixed' && cfg.addressBarFixed) {
      addrBar.value = cfg.addressBarFixed;
    } else {
      addrBar.value = location.href;
    }
  }
  refreshAddrBar();
  window.addEventListener('hashchange', refreshAddrBar);

  // --- File picker ---
  pickBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => {
    [...e.target.files].forEach(uploadOne);
    fileInput.value = '';
  });

  // --- Drag-drop (multi) ---
  ['dragenter', 'dragover'].forEach(evt =>
    dz.addEventListener(evt, e => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(evt =>
    dz.addEventListener(evt, e => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', e => {
    [...e.dataTransfer.files].forEach(uploadOne);
  });

  // --- Paste ---
  document.addEventListener('paste', e => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) uploadOne(f);
      }
    }
  });

  // --- Upload (single file, with progress + per-file card) ---
  function uploadOne(file) {
    const card = makeCard(file);
    results.prepend(card.el);
    status.textContent = 'Uploading ' + file.name + '...';

    const fd = new FormData();
    fd.append('file', file);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/upload');
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) {
        const pct = (e.loaded / e.total) * 100;
        card.bar.style.width = pct.toFixed(1) + '%';
      }
    };
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) {
          renderUploaded(card, file, data);
          refreshStats();
        } else {
          renderError(card, data.error || ('HTTP ' + xhr.status));
        }
      } catch {
        renderError(card, 'Bad server response');
      }
      status.textContent = 'Done';
    };
    xhr.onerror = () => { renderError(card, 'Network error'); status.textContent = 'Error'; };
    xhr.send(fd);
  }

  function makeCard(file) {
    const el = document.createElement('div');
    el.className = 'card uploading';
    el.innerHTML = `
      <div class="preview"><span style="font-family:Tahoma;color:#888">⌛</span></div>
      <div class="info">
        <div><b>${escapeHtml(file.name)}</b> <span class="meta">(${formatBytes(file.size)})</span></div>
        <div class="progress"><span></span></div>
      </div>`;
    return { el, bar: el.querySelector('.progress > span') };
  }

  function renderError(card, message) {
    card.el.classList.remove('uploading');
    card.el.classList.add('error');
    card.el.querySelector('.info').innerHTML =
      '<div><b>Upload failed:</b> ' + escapeHtml(message) + '</div>';
  }

  function renderUploaded(card, file, data) {
    card.el.classList.remove('uploading');
    const isVideo = (file.type || '').startsWith('video/');
    const previewMedia = isVideo
      ? `<video src="${data.url}" muted></video>`
      : `<img src="${data.url}" alt="${data.id}">`;

    card.el.innerHTML = `
      <a class="preview" href="${data.viewUrl}" target="_blank" rel="noopener">${previewMedia}</a>
      <div class="info">
        <div><b>${escapeHtml(file.name)}</b> <span class="meta">(${formatBytes(file.size)}) → <code>${data.id}.${data.ext}</code></span></div>
        <div class="row">
          <select class="fmtPick">
            <option value="url">Direct URL</option>
            <option value="markdown">Markdown</option>
            <option value="html">HTML</option>
            <option value="bbcode">BBCode</option>
            <option value="view">View page</option>
          </select>
          <input class="linkbox" readonly>
          <button class="copyBtn" type="button">Copy</button>
          <button class="shareBtn" type="button">Share</button>
          <a class="button openBtn" href="${data.url}" target="_blank" rel="noopener" style="text-decoration:none">Open</a>
        </div>
      </div>`;

    const fmtPick = card.el.querySelector('.fmtPick');
    const linkbox = card.el.querySelector('.linkbox');
    const copyBtn = card.el.querySelector('.copyBtn');
    const shareBtn = card.el.querySelector('.shareBtn');

    fmtPick.value = fmtSel.value;
    update();
    fmtPick.addEventListener('change', update);

    function update() {
      linkbox.value = formatLink(fmtPick.value, data);
    }

    copyBtn.addEventListener('click', () => {
      copyToClipboard(linkbox.value);
      flash(copyBtn, 'Copied!');
    });
    shareBtn.addEventListener('click', async () => {
      const text = linkbox.value;
      if (navigator.share) {
        try {
          await navigator.share({ title: 'Octuna upload', text, url: data.url });
        } catch { /* user cancelled */ }
      } else {
        copyToClipboard(text);
        flash(shareBtn, 'Copied!');
      }
    });
  }

  function formatLink(fmt, d) {
    switch (fmt) {
      case 'markdown': return '![image](' + d.url + ')';
      case 'html':     return '<img src="' + d.url + '" alt="">';
      case 'bbcode':   return '[img]' + d.url + '[/img]';
      case 'view':     return d.viewUrl;
      default:         return d.url;
    }
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallback());
    } else fallback();
    function fallback() {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      document.body.removeChild(ta);
    }
  }

  function flash(btn, text) {
    const orig = btn.textContent;
    btn.textContent = text;
    btn.classList.add('copied');
    setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1200);
  }

  // --- Real stats ---
  function refreshStats() {
    fetch('/api/stats').then(r => r.json()).then(s => {
      statsEl.innerHTML =
        '&#128247; Files: <b>' + s.count.toLocaleString() + '</b><br>' +
        '&#128190; Total: <b>' + formatBytes(s.totalSize) + '</b><br>' +
        '&#128338; Up since: <b>' + (s.since ? new Date(s.since).toLocaleDateString() : '&mdash;') + '</b>';
      visitors.textContent = String(s.count).padStart(9, '0').replace(/(\d{3})(?=\d)/g, '$1,');
    }).catch(() => { statsEl.textContent = '(stats unavailable)'; });
  }
  refreshStats();

  // --- Auth status / login form ---
  function refreshAuth() {
    fetch('/admin/me').then(r => r.json()).then(d => {
      if (d.user) {
        loginForm.style.display = 'none';
        loggedIn.style.display = 'flex';
        adminWho.textContent = d.user;
        greet.innerHTML = '&#9733; Welcome, ' + escapeHtml(d.user) + '!';
      } else {
        loginForm.style.display = 'flex';
        loggedIn.style.display = 'none';
        greet.innerHTML = '&#9733; Welcome, Guest!';
      }
    }).catch(() => {});
  }
  refreshAuth();

  loginForm.addEventListener('submit', e => {
    e.preventDefault();
    loginMsg.textContent = '';
    const user = document.getElementById('lUser').value;
    const password = document.getElementById('lPass').value;
    fetch('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user, password })
    }).then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (ok) {
          document.getElementById('lPass').value = '';
          refreshAuth();
        } else {
          loginMsg.textContent = d.error || 'Login failed';
        }
      })
      .catch(() => { loginMsg.textContent = 'Network error'; });
  });

  logoutBtn.addEventListener('click', () => {
    fetch('/admin/logout', { method: 'POST' }).then(refreshAuth);
  });

  // --- helpers ---
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(2) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }
})();
