// ==UserScript==
// @name         Food Club: NFC Import + Tidy
// @namespace    foodclub-nfc-import
// @version      1.1
// @description  Adds a NeoFoodClub importer to the revamped Food Club "Place a Bet" tab, and trims some page clutter.
// @match        https://www.neopets.com/pirates/foodclub.phtml*
// @match        https://neopets.com/pirates/foodclub.phtml*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const COMPACT = true;          // set false to leave the page's layout alone
    const MIN_BET = 50;
    const DELAY_MS = 600;          // pause between bets when placing a queue

    // ───────────── Light tidy-up (CSS only, easy to switch off above) ─────────────
    if (COMPACT) {
        const css = document.createElement('style');
        css.textContent = `
            .fc-head__desc { display: none !important; }
            .fc-hero img { width: 72px !important; height: 72px !important; }
            #fcx-panel input, #fcx-panel select, #fcx-panel button { font: inherit; }
        `;
        document.head.appendChild(css);
    }

    // ───────────── NFC decoding ─────────────
    // Accepts a full NeoFoodClub URL or just the b=/a= pieces.
    function parseNFC(text) {
        const bMatch = text.match(/[?&#]b=([a-y]+)/i) || text.match(/^\s*([a-y]{3,})\s*$/);
        if (!bMatch) return null;

        const letters = bMatch[1].toLowerCase();
        const flat = [];
        for (const ch of letters) {
            const n = ch.charCodeAt(0) - 97;       // 0..24
            flat.push(Math.floor(n / 5), n % 5);
        }
        const bets = [];
        for (let i = 0; i + 5 <= flat.length; i += 5) bets.push(flat.slice(i, i + 5));

        // Amounts: 3-char base-52 chunks, offset by 70304.
        let amounts = [];
        const aMatch = text.match(/[?&]a=([A-Za-z]+)/);
        if (aMatch) {
            const A = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
            amounts = (aMatch[1].match(/.{1,3}/g) || []).map(chunk => {
                let v = 0;
                for (const c of chunk) v = v * 52 + A.indexOf(c);
                return v - 70304;
            });
        }
        return bets.length ? { bets, amounts } : null;
    }

    // ───────────── Read the native bet form ─────────────
    function readForm() {
        const form = document.getElementById('fc-bet-form');
        if (!form) return null;
        const n = k => parseInt(form.getAttribute(k), 10) || 0;
        const arenas = [];
        form.querySelectorAll('.fc-bet-row').forEach(row => {
            const match = parseInt(row.getAttribute('data-match'), 10);
            const nameEl = row.querySelector('.fc-bet-arena__name');
            const pirates = Array.from(row.querySelectorAll('.fc-bet-pirate-radio')).map(r => {
                const label = r.closest('label') || r.parentNode;
                const nEl = label && label.querySelector('.fc-bet-pirate__name');
                return {
                    id: parseInt(r.value, 10),
                    odds: parseInt(r.getAttribute('data-odds'), 10) || 1,
                    name: nEl ? nEl.textContent.trim() : String(r.value),
                    el: r,
                };
            });
            arenas.push({ match, name: nameEl ? nameEl.textContent.trim() : 'Arena ' + match, pirates, row });
        });
        arenas.sort((a, b) => a.match - b.match);
        return {
            form, arenas,
            maxBet: n('data-max-bet'), maxWin: n('data-max-win') || 1000000,
            maxBets: n('data-max-bets'), placed: n('data-bets-placed'),
            ck: form.getAttribute('data-ck') || '',
        };
    }

    // ───────────── Bet maths ─────────────
    const totalOdds = (sel, arenas) => {
        let o = 1, any = false;
        sel.forEach((idx, a) => {
            if (!idx) return;
            const p = arenas[a] && arenas[a].pirates[idx - 1];
            if (p) { any = true; o *= p.odds; }
        });
        return any ? o : 0;
    };
    const capFor = (odds, info) => odds > 0 ? Math.min(info.maxBet, Math.ceil(info.maxWin / odds)) : info.maxBet;
    const clamp = (amt, odds, info) => Math.max(MIN_BET, Math.min(isNaN(amt) ? capFor(odds, info) : amt, capFor(odds, info)));

    // ───────────── Panel ─────────────
    let queue = [];                       // [{sel:[0..4 pirate positions], amount}]

    // Parse NFC text into the queue; returns false if no bet string was found.
    function loadQueue(text) {
        const parsed = parseNFC(text);
        if (!parsed) return false;
        queue = parsed.bets.map((sel, i) => ({
            sel,
            amount: parsed.amounts[i] || parsed.amounts[0] || NaN,   // NaN → clamps to that bet's max
        }));
        return true;
    }

    // Import ?b= and ?a= from the page URL as soon as the script runs, whichever tab is showing.
    // The panel picks the queue up when it is built.
    let urlImport = '';
    {
        const params = new URLSearchParams(location.search);
        const hash = new URLSearchParams(location.hash.replace(/^#/, ''));   // NFC links sometimes carry b= in the hash
        const b = (params.get('b') || hash.get('b') || '').trim(), a = (params.get('a') || hash.get('a') || '').trim();
        if (b) {
            const text = `?b=${b}` + (a ? `&a=${a}` : '');   // parseNFC reads b=/a= pieces
            if (loadQueue(text)) urlImport = text;
            else console.warn('[NFC import] could not parse b from URL:', b);
        }
    }

    function el(tag, attrs, html) {
        const e = document.createElement(tag);
        Object.entries(attrs || {}).forEach(([k, v]) => e.setAttribute(k, v));
        if (html != null) e.innerHTML = html;
        return e;
    }
    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function loadIntoForm(info, bet) {
        const reset = document.getElementById('fc-bet-reset');
        if (reset && !reset.classList.contains('fc-btn-disabled')) reset.click();
        info.arenas.forEach((a, i) => {
            const idx = bet.sel[i];
            if (!idx || !a.pirates[idx - 1]) return;
            const radio = a.pirates[idx - 1].el;
            radio.checked = true;
            radio.dispatchEvent(new Event('change', { bubbles: true }));
        });
        const amt = document.getElementById('fc-bet-amount');
        if (amt) {
            const odds = totalOdds(bet.sel, info.arenas);
            amt.value = String(clamp(bet.amount, odds, info));
            amt.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const target = document.getElementById('fc-calc') || info.form;
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function render(panel, info) {
        const box = panel.querySelector('#fcx-queue');
        box.innerHTML = '';
        const status = panel.querySelector('#fcx-status');
        const capLeft = info.maxBets > 0 ? Math.max(0, info.maxBets - info.placed) : Infinity;

        if (!queue.length) { status.textContent = ''; return; }

        let total = 0;
        queue.forEach((bet, i) => {
            const odds = totalOdds(bet.sel, info.arenas);
            bet.amount = odds ? clamp(bet.amount, odds, info) : bet.amount;
            if (odds) total += bet.amount;

            const legs = bet.sel.map((idx, a) => {
                const p = idx && info.arenas[a] && info.arenas[a].pirates[idx - 1];
                return p ? `<span style="white-space:nowrap">${esc(info.arenas[a].name)}: <b>${esc(p.name)}</b> (${p.odds}:1)</span>` : '';
            }).filter(Boolean).join(' &middot; ') || '<i>no picks – will be skipped</i>';

            const row = el('div', { style: 'border:1px solid #bbb;border-radius:6px;padding:6px 8px;margin:6px 0;font-size:12px;' });
            row.innerHTML = `
                <div>${legs}</div>
                <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:4px;">
                    <span><b>${odds ? odds + ':1' : '–'}</b></span>
                    <input type="number" min="${MIN_BET}" value="${bet.amount}" style="width:90px;" ${odds ? '' : 'disabled'}>
                    <button type="button" data-a="max" ${odds ? '' : 'disabled'}>Max</button>
                    <span style="margin-left:auto;">Win: <b>${odds ? Math.min(odds * bet.amount, info.maxWin).toLocaleString() : 0}</b></span>
                    <button type="button" data-a="load" ${odds ? '' : 'disabled'} title="Fill the native form below with this bet">Load</button>
                    <button type="button" data-a="del">✕</button>
                    <span class="fcx-st" style="min-width:44px;text-align:center;"></span>
                </div>`;
            const input = row.querySelector('input');
            input.addEventListener('change', () => { bet.amount = parseInt(input.value, 10); render(panel, info); });
            row.querySelector('[data-a="max"]').addEventListener('click', () => { bet.amount = capFor(odds, info); render(panel, info); });
            row.querySelector('[data-a="load"]').addEventListener('click', () => loadIntoForm(info, bet));
            row.querySelector('[data-a="del"]').addEventListener('click', () => { queue.splice(i, 1); render(panel, info); });
            bet.statusEl = row.querySelector('.fcx-st');
            box.appendChild(row);
        });

        const valid = queue.filter(b => totalOdds(b.sel, info.arenas) > 0).length;
        status.innerHTML = `${valid} bet(s) &middot; total <b>${total.toLocaleString()} NP</b> &middot; max bet ${info.maxBet.toLocaleString()}` +
            (info.maxBets > 0 ? ` &middot; slots left this round: <b>${capLeft}</b>` : '');
    }

    async function placeAll(panel, info, btn) {
        btn.disabled = true;
        let ck = info.ck, placed = info.placed;
        for (const bet of queue) {
            const odds = totalOdds(bet.sel, info.arenas);
            if (!odds) continue;
            const st = bet.statusEl;
            if (info.maxBets > 0 && placed >= info.maxBets) { if (st) st.textContent = 'Cap'; continue; }
            if (st) st.textContent = '…';

            const picks = {};
            bet.sel.forEach((idx, a) => { if (idx && info.arenas[a].pirates[idx - 1]) picks[info.arenas[a].match] = info.arenas[a].pirates[idx - 1].id; });
            try {
                const res = await fetch('/np-templates/ajax/pirates/foodclub/place_bet.php', {
                    method: 'POST', credentials: 'include',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                    body: JSON.stringify({ _ref_ck: ck, bet_amount: clamp(bet.amount, odds, info), picks }),
                });
                const data = await res.json();
                if (data && data.ck) ck = data.ck;                  // one-time token: always take the new one
                if (data && typeof data.placed !== 'undefined') placed = parseInt(data.placed, 10) || placed;
                else if (data && data.success) placed++;
                if (st) { st.textContent = data && data.success ? '✔' : 'Error'; st.title = (data && data.error) || ''; st.style.color = data && data.success ? 'green' : 'crimson'; }
            } catch (e) {
                if (st) { st.textContent = 'Error'; st.style.color = 'crimson'; }
            }
            await new Promise(r => setTimeout(r, DELAY_MS));
        }
        // The page's own form still holds the old token, so refresh it before anything else is placed.
        btn.textContent = 'Done – reload page';
        btn.disabled = false;
        btn.onclick = () => location.reload();
    }

    function buildPanel(info) {
        const panel = el('div', { id: 'fcx-panel', style: 'border:2px solid #888;border-radius:8px;padding:10px;margin:10px 0;background:rgba(128,128,128,.08);' });
        panel.innerHTML = `
            <div style="font-weight:bold;margin-bottom:6px;">NeoFoodClub import</div>
            <div style="display:flex;gap:6px;flex-wrap:wrap;">
                <input id="fcx-input" type="text" placeholder="Paste NFC URL or bet string…" style="flex:1;min-width:200px;">
                <button type="button" id="fcx-load">Load bets</button>
            </div>
            <div id="fcx-bulk" style="display:none;margin-top:6px;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px;">
                Set all: <input id="fcx-bulk-amt" type="number" min="${MIN_BET}" style="width:90px;">
                <button type="button" id="fcx-bulk-apply">Apply</button>
                <button type="button" id="fcx-bulk-max">Max every bet</button>
                <button type="button" id="fcx-clear">Clear</button>
            </div>
            <div id="fcx-status" style="font-size:12px;margin-top:6px;"></div>
            <div id="fcx-queue"></div>
            <div id="fcx-actions" style="display:none;margin-top:6px;"><button type="button" id="fcx-place" style="width:100%;padding:6px;">Place all bets</button></div>`;

        const bulk = panel.querySelector('#fcx-bulk'), actions = panel.querySelector('#fcx-actions');
        const refresh = () => {
            render(panel, info);
            const has = queue.length > 0;
            bulk.style.display = has ? 'flex' : 'none';
            actions.style.display = has ? 'block' : 'none';
        };

        const loadBets = () => {
            if (!loadQueue(panel.querySelector('#fcx-input').value)) { panel.querySelector('#fcx-status').textContent = 'Couldn\'t find a b= bet string in that text.'; return; }
            refresh();
        };
        panel.querySelector('#fcx-load').addEventListener('click', loadBets);
        panel.querySelector('#fcx-bulk-apply').addEventListener('click', () => {
            const v = parseInt(panel.querySelector('#fcx-bulk-amt').value, 10);
            if (isNaN(v)) return;
            queue.forEach(b => { b.amount = v; });
            refresh();
        });
        panel.querySelector('#fcx-bulk-max').addEventListener('click', () => {
            queue.forEach(b => { b.amount = NaN; });
            refresh();
        });
        panel.querySelector('#fcx-clear').addEventListener('click', () => { queue = []; refresh(); });
        panel.querySelector('#fcx-place').onclick = ev => {
            if (!queue.length) return;
            const total = queue.reduce((s, b) => s + (totalOdds(b.sel, info.arenas) ? b.amount : 0), 0);
            if (confirm(`Place ${queue.filter(b => totalOdds(b.sel, info.arenas)).length} bet(s) totalling ${total.toLocaleString()} NP?`)) placeAll(panel, info, ev.target);
        };

        if (urlImport) panel.querySelector('#fcx-input').value = urlImport;   // show what was auto-loaded from the URL
        if (queue.length) refresh();    // shows the URL import, and keeps an imported queue when switching tabs and coming back
        return panel;
    }

    // ───────────── Inject whenever the bet tab appears (page swaps tabs via AJAX) ─────────────
    function inject() {
        if (document.getElementById('fcx-panel')) return;
        const info = readForm();
        if (!info || !info.arenas.length) return;
        info.form.parentNode.insertBefore(buildPanel(info), info.form);
    }

    const swap = document.getElementById('fc-swap') || document.body;
    new MutationObserver(inject).observe(swap, { childList: true, subtree: true });
    inject();
})();
