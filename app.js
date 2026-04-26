/* =====================================================================
   ALCHEMICAL CONSOLE — application script
   Phase 1: Gateway (session management) + storage utilities.
   ===================================================================== */

(() => {
  'use strict';

  /* ===================================================================
     STORAGE LAYER
     -------------------------------------------------------------------
     All state lives in localStorage.
     - Master index:  global:sessions  -> array of session metadata
     - Session data:  <id>:<keyName>   -> arbitrary JSON for that session

     The five domain keys (air, spirit, fire, water, earth) are
     initialized on session creation so the dashboard can bind cleanly.
     =================================================================== */

  const GLOBAL_KEY = 'global:sessions';
  const DOMAIN_KEYS = ['air', 'spirit', 'fire', 'water', 'earth'];
  const SETTINGS_KEY = 'settings';

  const Storage = {
    /* --- master index ------------------------------------------------ */

    getSessions() {
      const raw = localStorage.getItem(GLOBAL_KEY);
      if (!raw) return [];
      try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    },

    saveSessions(sessions) {
      localStorage.setItem(GLOBAL_KEY, JSON.stringify(sessions));
    },

    /* --- id allocation ----------------------------------------------- */

    nextId() {
      const sessions = this.getSessions();
      const used = new Set(sessions.map(s => s.id));
      let id = 1;
      while (used.has(id)) id++;
      return id;
    },

    /* --- per-session key helpers ------------------------------------- */

    keyFor(sessionId, key) {
      return `${sessionId}:${key}`;
    },

    getKey(sessionId, key, fallback = null) {
      const raw = localStorage.getItem(this.keyFor(sessionId, key));
      if (raw === null) return fallback;
      try { return JSON.parse(raw); } catch { return fallback; }
    },

    setKey(sessionId, key, value) {
      localStorage.setItem(this.keyFor(sessionId, key), JSON.stringify(value));
    },

    /* --- session lifecycle ------------------------------------------- */

    createSession(name) {
      const sessions = this.getSessions();
      const id = this.nextId();
      const now = Date.now();
      const meta = {
        id,
        name: String(name || `untitled-${id}`).trim() || `untitled-${id}`,
        createdAt: now,
        lastAccessed: now,
      };
      sessions.push(meta);
      this.saveSessions(sessions);

      // Initialize the five domains as empty arrays.
      DOMAIN_KEYS.forEach(d => this.setKey(id, d, []));
      // Initialize settings stub for future use.
      this.setKey(id, SETTINGS_KEY, { createdAt: now });

      return meta;
    },

    removeSession(id) {
      // Strip every key prefixed with `<id>:`.
      const prefix = `${id}:`;
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix)) toRemove.push(key);
      }
      toRemove.forEach(k => localStorage.removeItem(k));

      const sessions = this.getSessions().filter(s => s.id !== id);
      this.saveSessions(sessions);
    },

    touchSession(id) {
      const sessions = this.getSessions();
      const s = sessions.find(s => s.id === id);
      if (!s) return;
      s.lastAccessed = Date.now();
      this.saveSessions(sessions);
    },

    renameSession(id, name) {
      const sessions = this.getSessions();
      const s = sessions.find(s => s.id === id);
      if (!s) return;
      s.name = String(name).trim() || s.name;
      this.saveSessions(sessions);
    },

    /* --- export / import --------------------------------------------- */

    exportSession(id) {
      const meta = this.getSessions().find(s => s.id === id);
      if (!meta) throw new Error(`session ${id} not found`);

      const prefix = `${id}:`;
      const data = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix)) {
          // Strip the session prefix so the bundle is portable.
          data[key.slice(prefix.length)] = localStorage.getItem(key);
        }
      }

      return {
        format: 'alchemical-console.session',
        version: 1,
        meta,
        data,
      };
    },

    importSession(payload) {
      if (!payload || payload.format !== 'alchemical-console.session') {
        throw new Error('unrecognized bundle format');
      }
      const meta = payload.meta || {};
      const data = payload.data || {};

      const sessions = this.getSessions();
      const used = new Set(sessions.map(s => s.id));

      // Remap if the original id collides with an existing one.
      let newId = Number.isInteger(meta.id) ? meta.id : this.nextId();
      let remapped = false;
      if (used.has(newId)) {
        newId = this.nextId();
        remapped = true;
      }

      // Inject all keys under the new id.
      Object.entries(data).forEach(([subKey, value]) => {
        // value was stored as a raw string; preserve it exactly.
        localStorage.setItem(this.keyFor(newId, subKey), String(value));
      });

      const now = Date.now();
      const newMeta = {
        id: newId,
        name: String(meta.name || `imported-${newId}`),
        createdAt: meta.createdAt || now,
        lastAccessed: now,
        importedAt: now,
        importedFromId: remapped ? meta.id : undefined,
      };
      sessions.push(newMeta);
      this.saveSessions(sessions);

      return { meta: newMeta, remapped };
    },
  };

  /* ===================================================================
     UI HELPERS
     =================================================================== */

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  const fmtId = n => '#' + String(n).padStart(3, '0');

  const fmtDate = ts => {
    if (!ts) return '—';
    const d = new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const fmtRelative = ts => {
    if (!ts) return '—';
    const diff = Date.now() - ts;
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d}d ago`;
    return fmtDate(ts);
  };

  const safeFilename = s =>
    String(s).toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '') || 'session';

  /* --- toast / status ---------------------------------------------- */

  const setStatus = (msg, tone = '') => {
    const el = $('#foot-status');
    el.textContent = msg;
    if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
  };

  let toastTimer;
  const toast = (msg, tone = '') => {
    const existing = $('.toast');
    if (existing) existing.remove();
    clearTimeout(toastTimer);
    const el = document.createElement('div');
    el.className = 'toast';
    if (tone) el.dataset.tone = tone;
    el.textContent = msg;
    document.body.appendChild(el);
    toastTimer = setTimeout(() => el.remove(), 2400);
  };

  /* --- modal -------------------------------------------------------- */

  const Modal = (() => {
    const root = $('#modal-root');
    const titleEl = $('#modal-title');
    const bodyEl = $('#modal-body');
    const footEl = $('#modal-foot');

    let activeResolve = null;

    const close = (value) => {
      root.hidden = true;
      bodyEl.innerHTML = '';
      footEl.innerHTML = '';
      const r = activeResolve;
      activeResolve = null;
      if (r) r(value);
    };

    root.addEventListener('click', (e) => {
      if (e.target.matches('[data-modal-close]')) close(null);
    });

    document.addEventListener('keydown', (e) => {
      if (root.hidden) return;
      if (e.key === 'Escape') close(null);
    });

    const open = ({ title, render, footer }) => {
      return new Promise(resolve => {
        activeResolve = resolve;
        titleEl.textContent = title || 'PROMPT';
        bodyEl.innerHTML = '';
        footEl.innerHTML = '';
        render(bodyEl, close);
        if (footer) footer(footEl, close);
        root.hidden = false;
      });
    };

    /* ---------- prompt: text input ---------- */
    const prompt = ({ title = 'PROMPT', label = '', placeholder = '', initial = '', confirmLabel = 'CONFIRM' }) =>
      open({
        title,
        render: (body, close) => {
          if (label) {
            const l = document.createElement('label');
            l.textContent = label;
            body.appendChild(l);
          }
          const input = document.createElement('input');
          input.className = 'modal-input';
          input.type = 'text';
          input.placeholder = placeholder;
          input.value = initial;
          input.autocomplete = 'off';
          input.spellcheck = false;
          body.appendChild(input);

          const submit = () => {
            const v = input.value.trim();
            if (!v) { input.focus(); return; }
            close(v);
          };
          input.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
          });
          setTimeout(() => input.focus(), 20);
          // expose for the footer button
          body._submit = submit;
        },
        footer: (foot, close) => {
          const cancel = document.createElement('button');
          cancel.className = 'btn-ghost';
          cancel.textContent = 'CANCEL';
          cancel.addEventListener('click', () => close(null));
          const ok = document.createElement('button');
          ok.className = 'btn-confirm';
          ok.textContent = confirmLabel;
          ok.addEventListener('click', () => bodyEl._submit && bodyEl._submit());
          foot.append(cancel, ok);
        },
      });

    /* ---------- confirm: yes/no with optional danger styling ---------- */
    const confirm = ({ title = 'CONFIRM', message = '', confirmLabel = 'CONFIRM', danger = false }) =>
      open({
        title,
        render: (body) => {
          const p = document.createElement('p');
          p.innerHTML = message;
          body.appendChild(p);
        },
        footer: (foot, close) => {
          const cancel = document.createElement('button');
          cancel.className = 'btn-ghost';
          cancel.textContent = 'CANCEL';
          cancel.addEventListener('click', () => close(false));
          const ok = document.createElement('button');
          ok.className = 'btn-confirm' + (danger ? ' danger' : '');
          ok.textContent = confirmLabel;
          ok.addEventListener('click', () => close(true));
          foot.append(cancel, ok);
        },
      });

    return { prompt, confirm, close };
  })();

  /* ===================================================================
     GATEWAY VIEW
     =================================================================== */

  const Gateway = (() => {
    const listEl = $('#session-list');
    const emptyEl = $('#session-empty');
    const countEl = $('#session-count');

    const renderRow = (s) => {
      const li = document.createElement('li');
      li.className = 'session-row';
      li.dataset.id = s.id;
      li.innerHTML = `
        <span class="session-id">${fmtId(s.id)}</span>
        <div class="session-info">
          <span class="session-name"></span>
          <div class="session-times">
            <span><span class="time-key">created</span>${fmtDate(s.createdAt)}</span>
            <span><span class="time-key">accessed</span>${fmtRelative(s.lastAccessed)}</span>
          </div>
        </div>
        <div class="row-actions">
          <button class="row-btn" data-act="export" title="Export session">↓</button>
          <button class="row-btn" data-act="rename" title="Rename session">✎</button>
          <button class="row-btn danger" data-act="remove" title="Remove session">×</button>
          <span class="row-enter" aria-hidden="true">⟶</span>
        </div>
      `;
      // Set name via textContent to avoid HTML injection from user-provided strings.
      li.querySelector('.session-name').textContent = s.name;
      return li;
    };

    const render = () => {
      const sessions = Storage.getSessions()
        .slice()
        .sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));

      listEl.innerHTML = '';
      sessions.forEach(s => listEl.appendChild(renderRow(s)));

      const n = sessions.length;
      countEl.textContent = `— ${n} active`;
      emptyEl.hidden = n !== 0;
      listEl.hidden = n === 0;
    };

    /* --- handlers ----------------------------------------------------- */

    const onListClick = async (e) => {
      const row = e.target.closest('.session-row');
      if (!row) return;
      const id = Number(row.dataset.id);
      const actBtn = e.target.closest('[data-act]');

      if (actBtn) {
        e.stopPropagation();
        const act = actBtn.dataset.act;
        if (act === 'remove') return handleRemove(id);
        if (act === 'export') return handleExport(id);
        if (act === 'rename') return handleRename(id);
        return;
      }

      // Row body click → enter session
      handleEnter(id);
    };

    const handleEnter = (id) => {
      Storage.touchSession(id);
      const session = Storage.getSessions().find(s => s.id === id);
      if (!session) { toast('session not found', 'error'); return render(); }
      App.enterDashboard(session);
    };

    const handleNew = async () => {
      const name = await Modal.prompt({
        title: 'NEW SESSION',
        label: 'PROJECT NAME',
        placeholder: 'e.g. orbital-mechanics',
        confirmLabel: 'INSTANTIATE',
      });
      if (!name) return;
      const meta = Storage.createSession(name);
      setStatus(`instantiated ${fmtId(meta.id)}`, 'ok');
      toast(`session ${fmtId(meta.id)} created`, 'ok');
      render();
    };

    const handleRename = async (id) => {
      const session = Storage.getSessions().find(s => s.id === id);
      if (!session) return;
      const name = await Modal.prompt({
        title: 'RENAME SESSION',
        label: `RENAME ${fmtId(id)}`,
        initial: session.name,
        confirmLabel: 'APPLY',
      });
      if (!name) return;
      Storage.renameSession(id, name);
      render();
    };

    const handleRemove = async (id) => {
      const session = Storage.getSessions().find(s => s.id === id);
      if (!session) return;
      const ok = await Modal.confirm({
        title: 'REMOVE SESSION',
        message:
          `Permanently delete <strong>${escapeHTML(session.name)}</strong> ` +
          `(${fmtId(id)})?<br><br>` +
          `All keys prefixed <code>${id}:</code> will be erased from localStorage. ` +
          `This action cannot be undone.`,
        confirmLabel: 'DELETE',
        danger: true,
      });
      if (!ok) return;
      Storage.removeSession(id);
      setStatus(`removed ${fmtId(id)}`, 'warn');
      toast(`session ${fmtId(id)} removed`, 'warn');
      render();
    };

    const handleExport = (id) => {
      try {
        const bundle = Storage.exportSession(id);
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const stamp = new Date().toISOString().slice(0, 10);
        a.download = `ac-${fmtId(id).replace('#','')}-${safeFilename(bundle.meta.name)}-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        setStatus(`exported ${fmtId(id)}`, 'ok');
        toast(`exported ${fmtId(id)}`, 'ok');
      } catch (err) {
        console.error(err);
        toast(`export failed: ${err.message}`, 'error');
      }
    };

    const handleImport = async () => {
      $('#import-input').click();
    };

    const onImportFile = async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = ''; // reset so re-importing same file works
      if (!file) return;

      try {
        const text = await file.text();
        const payload = JSON.parse(text);
        const { meta, remapped } = Storage.importSession(payload);
        setStatus(`imported ${fmtId(meta.id)}${remapped ? ' (remapped)' : ''}`, 'ok');
        toast(`imported as ${fmtId(meta.id)}${remapped ? ' (remapped)' : ''}`, 'ok');
        render();
      } catch (err) {
        console.error(err);
        toast(`import failed: ${err.message}`, 'error');
        setStatus('import failed', 'error');
      }
    };

    const escapeHTML = s => String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const init = () => {
      listEl.addEventListener('click', onListClick);
      $('#btn-new').addEventListener('click', handleNew);
      $('#btn-import').addEventListener('click', handleImport);
      $('#import-input').addEventListener('change', onImportFile);
      render();
    };

    return { init, render };
  })();

  /* ===================================================================
     APP CONTROLLER (view switching)
     =================================================================== */

  const App = {
    activeSessionId: null,

    enterDashboard(session) {
      this.activeSessionId = session.id;
      $('#dash-session-name').textContent = session.name;
      $('#dash-session-id').textContent = fmtId(session.id);
      $('#gateway').dataset.active = 'false';
      $('#dashboard').dataset.active = 'true';
      setStatus(`engaged ${fmtId(session.id)}`, 'ok');
    },

    exitDashboard() {
      this.activeSessionId = null;
      $('#dashboard').dataset.active = 'false';
      $('#gateway').dataset.active = 'true';
      Gateway.render();
      setStatus('ready');
    },

    init() {
      Gateway.init();
      $('#btn-exit').addEventListener('click', () => this.exitDashboard());
    },
  };

  /* expose for debugging in devtools */
  window.AC = { Storage, App };

  document.addEventListener('DOMContentLoaded', () => App.init());
})();
