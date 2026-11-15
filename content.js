// ForumX — x.com'u eski usul forum görünümüne çevirir.
// Strateji: X'in React DOM'una dokunmadan (düğüm taşımadan/silmeden) yalnızca
// kendi öğelerimizi ekler, gerisini forum.css ile gizler/yeniden biçimlendiririz.
(() => {
  'use strict';
  if (window.__forumxLoaded) return;
  window.__forumxLoaded = true;

  const LS_KEY = 'forumx:enabled';
  const root = document.documentElement;
  let enabled = true;
  try { enabled = localStorage.getItem(LS_KEY) !== '0'; } catch {}
  root.classList.toggle('fx-on', enabled);

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const THREAD_RE = /^\/([^/]+)\/status\/(\d+)/;
  const OTHER_RE = /^\/(messages|settings|jobs|login|logout|i\/(chat|grok|premium|monetization|flow|verified))/;
  const OVERLAY_RE = /(\/(photo|video)\/\d+$)|^\/compose\/|^\/intent\//;

  let mode = null;        // 'list' | 'thread' | 'other'
  let lastPath = null;
  let thread = { id: null, author: '', nums: new Map(), next: 1, title: '' };
  let chrome_, crumb, topbar, profileLink;

  // ---------- yardımcılar ----------

  // textContent emojileri (img alt) kaçırır; metni emojilerle birlikte topla.
  function richText(node) {
    if (!node) return '';
    let out = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) out += c.data;
      else if (c.nodeType === 1) out += c.tagName === 'IMG' ? (c.alt || '') : richText(c);
    }
    return out;
  }

  function makeTitle(text, d) {
    const t = (text || '').replace(/\s+/g, ' ').trim();
    if (!t) return d.hasVideo ? '[Video]' : d.hasPhoto ? '[Görsel]' : '[Başlıksız konu]';
    if (t.length <= 110) return t;
    const cut = t.slice(0, 110);
    const sp = cut.lastIndexOf(' ');
    return (sp > 60 ? cut.slice(0, sp) : cut) + '…';
  }

  const pad = (n) => String(n).padStart(2, '0');
  function fmtDate(iso, short) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(new Date()) - day(d)) / 864e5);
    if (diff === 0) return `Bugün ${hm}`;
    if (diff === 1) return `Dün ${hm}`;
    const date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
    return short ? date : `${date}, ${hm}`;
  }

  function timeLink(art) {
    const t = $('a[href*="/status/"] time', art);
    return t ? t.closest('a') : null;
  }

  function avatarSrc(art) {
    const img = $('[data-testid="Tweet-User-Avatar"] img', art);
    return img && img.src ? img.src.replace(/_(normal|bigger|mini|x96)\./, '_200x200.') : '';
  }

  function avatarImg(src) {
    const av = el('img', 'fx-avatar');
    av.src = src;
    av.alt = '';
    av.loading = 'lazy';
    return av;
  }

  function extract(art) {
    const link = timeLink(art);
    const un = $('[data-testid="User-Name"]', art);
    const a1 = un && $('a[href^="/"]', un);
    let textEl = $('[data-testid="tweetText"]', art);
    if (textEl && textEl.closest('[role="link"]')) textEl = null; // alıntılanan tweet'in metni
    const count = (tid) => {
      const b = $(`[data-testid="${tid}"], [data-testid="un${tid}"]`, art);
      return b ? (b.textContent.trim() || '0') : '-';
    };
    const views = $('a[href$="/analytics"]', art);
    const d = {
      href: link ? link.getAttribute('href') : '',
      iso: link ? $('time', link).getAttribute('datetime') : '',
      handle: a1 ? a1.getAttribute('href').slice(1) : '',
      name: a1 ? richText(a1).trim() : '',
      verified: !!(un && $('[data-testid="icon-verified"]', un)),
      replies: count('reply'),
      likes: count('like'),
      views: views ? (views.textContent.trim() || '0') : '-',
      avatar: avatarSrc(art),
      social: richText($('[data-testid="socialContext"]', art)).trim(),
      hasPhoto: !!$('[data-testid="tweetPhoto"]', art),
      hasVideo: !!$('[data-testid="videoPlayer"], [data-testid="videoComponent"]', art),
    };
    d.title = makeTitle(richText(textEl), d);
    return d;
  }

  // "1.2K", "3,4 B", "12" -> yaklaşık sayı (yalnızca "sıcak konu" simgesi için)
  function approx(s) {
    const m = /([\d.,]+)\s*([KMBkmb]|Mn|B)?/.exec(s || '');
    if (!m) return 0;
    let n = parseFloat(m[1].replace(',', '.')) || 0;
    if (m[2]) n *= /^(M|Mn|m)$/.test(m[2]) ? 1e6 : 1e3;
    return n;
  }

  // Gizli duran orijinal X bağlantısına tıklayarak sayfa yenilemeden (SPA) gezin.
  function spaClick(target, e) {
    if (!target) return false;
    if (e) e.preventDefault();
    target.click();
    return true;
  }
  const plainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

  // ---------- konu listesi satırı ----------

  function buildRow(art, d) {
    const row = el('div', 'fx-el fx-row');

    const hot = approx(d.replies) >= 100;
    const icon = el('div', 'fx-c fx-c-icon', hot ? '🔥' : d.hasVideo ? '🎞️' : d.hasPhoto ? '🖼️' : '📁');
    icon.title = hot ? 'Sıcak konu' : 'Konu';

    const main = el('div', 'fx-c fx-c-main');
    const line = el('div', 'fx-titleline');
    const expand = el('button', 'fx-expand', '[+]');
    expand.type = 'button';
    expand.title = 'Mesajı burada önizle';
    const title = el('a', 'fx-title', d.title);
    if (d.href) title.href = d.href;
    line.append(expand, title);
    const meta = el('div', 'fx-meta');
    if (d.social) meta.append(el('span', 'fx-social', `↻ ${d.social} · `));
    else if (!d.href) meta.append(el('span', 'fx-social', 'Sponsorlu · '));
    meta.append('Başlatan: ');
    const user = el('a', 'fx-userlink', d.name || d.handle || '?');
    if (d.handle) user.href = '/' + d.handle;
    meta.append(user);
    if (d.handle) meta.append(el('span', 'fx-handle', ` (@${d.handle})`));
    main.append(line, meta);

    const num = (v, label) => {
      const c = el('div', 'fx-c fx-c-num', v);
      c.title = label;
      return c;
    };
    const date = el('div', 'fx-c fx-c-date', fmtDate(d.iso, true) || '—');

    row.append(icon, main, num(d.replies, 'Cevap'), num(d.likes, 'Beğeni'), num(d.views, 'Gösterim'), date);

    const toggle = () => {
      // React className'i yeniden yazdığı için durum data- özniteliğinde tutulur.
      const open = !art.hasAttribute('data-fx-open');
      art.toggleAttribute('data-fx-open', open);
      expand.textContent = open ? '[−]' : '[+]';
    };
    row.addEventListener('click', (e) => {
      e.stopPropagation(); // X'in article tıklama işleyicisine ulaşmasın
      if (e.target.closest('.fx-expand')) return toggle();
      if (!plainClick(e)) return; // yeni sekmede aç vb. tarayıcıya kalsın
      if (e.target.closest('.fx-userlink')) {
        spaClick($('[data-testid="User-Name"] a[href^="/"]', art), e);
        return;
      }
      if (!spaClick(timeLink(art), e)) { e.preventDefault(); toggle(); }
    });
    return row;
  }

  // ---------- konu içi mesaj (post) ----------

  function buildPost(art, d) {
    const key = d.href || location.pathname;
    if (!thread.nums.has(key)) thread.nums.set(key, thread.next++);
    const no = thread.nums.get(key);

    const head = el('div', 'fx-el fx-posthead');
    head.append(el('span', 'fx-postdate', '🗓 ' + (fmtDate(d.iso) || '—')));
    const noA = el('a', 'fx-postno', '#' + no);
    if (d.href) noA.href = d.href;
    noA.title = 'Mesaj bağlantısı';
    head.append(noA);

    const panel = el('div', 'fx-el fx-userpanel');
    const name = el('a', 'fx-username', d.name || d.handle || '?');
    if (d.handle) name.href = '/' + d.handle;
    const isOp = d.handle && d.handle.toLowerCase() === thread.author.toLowerCase();
    const rank = el('div', 'fx-rank', isOp ? 'Konu Sahibi' : d.verified ? 'Onaylı Üye' : 'Üye');
    const pips = el('div', 'fx-pips', isOp ? '★★★★★' : d.verified ? '★★★☆☆' : '★☆☆☆☆');
    const av = d.avatar
      ? avatarImg(d.avatar)
      : el('div', 'fx-avatar fx-avatar-empty', (d.name || d.handle || '?').charAt(0).toUpperCase());
    panel.append(name, rank, pips, av);
    if (d.handle) panel.append(el('div', 'fx-handle', '@' + d.handle));

    const stop = (e) => {
      e.stopPropagation();
      const a = e.target.closest('a');
      if (!a || !plainClick(e)) return;
      if (a === name) spaClick($('[data-testid="User-Name"] a[href^="/"]', art), e);
      else if (a === noA) spaClick(timeLink(art), e);
    };
    head.addEventListener('click', stop);
    panel.addEventListener('click', stop);

    // Orijinal avatar sütununu gizle (üye paneli onun yerini alıyor).
    let n = $('[data-testid="Tweet-User-Avatar"]', art);
    if (n) {
      while (n.parentElement && n.parentElement !== art &&
             !n.parentElement.querySelector('[data-testid="User-Name"]')) n = n.parentElement;
      n.setAttribute('data-fx-hide', '');
    }

    art.prepend(head, panel);

    if (!thread.title && thread.id && d.href.includes('/status/' + thread.id)) {
      thread.title = d.title;
      updateCrumb();
    }
  }

  function decorate(art) {
    const link = timeLink(art);
    const key = mode + '|' + (link ? link.getAttribute('href') : '');
    if (art.dataset.fx === key && art.querySelector(':scope > .fx-el')) {
      // X avatarı geç yüklüyor; harf yer tutucusunu gerçek resimle değiştir.
      const empty = $(':scope > .fx-userpanel > .fx-avatar-empty', art);
      const src = empty && avatarSrc(art);
      if (src) empty.replaceWith(avatarImg(src));
      return;
    }
    $$(':scope > .fx-el', art).forEach((n) => n.remove());
    $$('[data-fx-hide]', art).forEach((n) => n.removeAttribute('data-fx-hide'));
    art.removeAttribute('data-fx-open');
    const d = extract(art);
    if (mode === 'list') art.prepend(buildRow(art, d));
    else buildPost(art, d);
    art.dataset.fx = key;
  }

  // ---------- üst forum çerçevesi ----------

  const NAV = [
    ['Ana Sayfa', '/home', 'AppTabBar_Home_Link'],
    ['Arama', '/explore', 'AppTabBar_Explore_Link'],
    ['Bildirimler', '/notifications', 'AppTabBar_Notifications_Link'],
    ['Özel Mesajlar', '/messages', 'AppTabBar_DirectMessage_Link'],
    ['Yer İmleri', '/i/bookmarks', null],
    ['Profilim', null, 'AppTabBar_Profile_Link'],
    ['Ayarlar', '/settings', null],
    ['✎ Yeni Konu Aç', '/compose/post', 'SideNav_NewTweet_Button'],
  ];

  function setEnabled(v) {
    enabled = v;
    try { localStorage.setItem(LS_KEY, v ? '1' : '0'); } catch {}
    root.classList.toggle('fx-on', v);
    schedule();
  }

  function ensureChrome() {
    if (chrome_ && chrome_.isConnected) return;
    if (!chrome_) {
      chrome_ = el('div', 'fx-el fx-chrome');
      const wrap = el('div', 'fx-wrap');
      const banner = el('div', 'fx-banner');
      const logo = el('a', 'fx-logo', 'ForumX');
      logo.href = '/home';
      banner.append(logo, el('span', 'fx-tagline', 'Eski usul forum keyfi'));
      const nav = el('div', 'fx-nav');
      for (const [label, href, tid] of NAV) {
        const a = el('a', tid === 'SideNav_NewTweet_Button' ? 'fx-newtopic' : '', label);
        if (href) a.href = href;
        if (tid === 'AppTabBar_Profile_Link') profileLink = a;
        a.addEventListener('click', (e) => {
          if (!plainClick(e)) return;
          spaClick(tid && $(`[data-testid="${tid}"]`), e); // bulunamazsa normal bağlantı gibi çalışır
        });
        nav.append(a);
      }
      const off = el('a', 'fx-off', 'Klasik X’e dön');
      off.href = '#';
      off.addEventListener('click', (e) => { e.preventDefault(); setEnabled(false); });
      nav.append(off);
      logo.addEventListener('click', (e) => {
        if (plainClick(e)) spaClick($('[data-testid="AppTabBar_Home_Link"]'), e);
      });
      crumb = el('div', 'fx-crumb');
      wrap.append(banner, nav, crumb);
      chrome_.append(wrap);

      const on = el('button', 'fx-reenable', 'ForumX');
      on.type = 'button';
      on.title = 'Forum görünümünü aç';
      on.addEventListener('click', () => setEnabled(true));
      chrome_.reenable = on;
    }
    document.body.prepend(chrome_);
    document.body.append(chrome_.reenable);
  }

  function updateCrumb() {
    if (!crumb) return;
    const p = location.pathname;
    const parts = [['ForumX', '/home']];
    const m = THREAD_RE.exec(p);
    if (mode === 'thread' && m) {
      parts.push(['@' + m[1], '/' + m[1]], [thread.title || 'Konu', null]);
    } else if (p === '/home' || p === '/') parts.push(['Ana Sayfa', null]);
    else if (p.startsWith('/explore')) parts.push(['Arama', null]);
    else if (p.startsWith('/search')) parts.push(['Arama', '/explore'], [new URLSearchParams(location.search).get('q') || 'Sonuçlar', null]);
    else if (p.startsWith('/notifications')) parts.push(['Bildirimler', null]);
    else if (p.startsWith('/messages') || p.startsWith('/i/chat')) parts.push(['Özel Mesajlar', null]);
    else if (p.startsWith('/i/bookmarks')) parts.push(['Yer İmleri', null]);
    else if (p.startsWith('/settings')) parts.push(['Ayarlar', null]);
    else if (/^\/[A-Za-z0-9_]{1,15}(\/|$)/.test(p)) parts.push(['Üye: @' + p.split('/')[1], null]);
    else parts.push([p, null]);
    crumb.textContent = '';
    parts.forEach(([text, href], i) => {
      if (i) crumb.append(' » ');
      const n = el(href ? 'a' : 'span', href ? '' : 'fx-here', text);
      if (href) n.href = href;
      crumb.append(n);
    });
  }

  // Zaman akışının hemen üstüne: listede sütun başlıkları, konuda konu başlığı.
  function ensureTopbar(pc) {
    const cell = $('[data-testid="cellInnerDiv"]', pc);
    const sec = cell && cell.closest('section');
    if (!sec) return;
    const sig = mode + '|' + (mode === 'thread' ? thread.title : '');
    if (!topbar) topbar = el('div', 'fx-el fx-topbar');
    if (topbar.dataset.sig !== sig) {
      topbar.dataset.sig = sig;
      topbar.textContent = '';
      if (mode === 'list') {
        topbar.className = 'fx-el fx-topbar fx-cols';
        for (const t of ['', 'Konu / Başlatan', 'Cevap', 'Beğeni', 'Gösterim', 'Tarih']) topbar.append(el('div', 'fx-c', t));
      } else {
        topbar.className = 'fx-el fx-topbar fx-threadtitle';
        topbar.append(el('span', 'fx-label', 'Konu: '), thread.title || '…');
      }
    }
    if (topbar.nextSibling !== sec) sec.parentElement.insertBefore(topbar, sec);
  }

  // Forum temasını X'in kendi açık/koyu ayarına uydur (metin renkleri X'ten gelir).
  let lastBg = null;
  function syncTheme() {
    const bg = document.body.style.backgroundColor ||
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)');
    if (bg === lastBg) return;
    lastBg = bg;
    const m = bg.match(/\d+/g) || [255, 255, 255];
    const dark = 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2] < 128;
    root.classList.toggle('fx-dark', dark);
    root.classList.toggle('fx-light', !dark);
    root.style.setProperty('--fx-panel', bg);
  }

  function onRoute(path) {
    let next;
    if (OVERLAY_RE.test(path) && mode) next = mode; // fotoğraf/yazma penceresi: arkadaki sayfa aynı
    else if (THREAD_RE.test(path)) next = 'thread';
    else if (OTHER_RE.test(path)) next = 'other';
    else next = 'list';
    mode = next;
    for (const m of ['list', 'thread', 'other']) root.classList.toggle('fx-' + m, m === mode);
    const t = THREAD_RE.exec(path);
    if (mode === 'thread' && t && t[2] !== thread.id) {
      thread = { id: t[2], author: t[1], nums: new Map(), next: 1, title: '' };
    }
    updateCrumb();
  }

  // ---------- ana döngü ----------

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(cycle);
  }

  function cycle() {
    scheduled = false;
    if (!document.body) return;
    try {
      ensureChrome();
      if (!enabled) return;
      syncTheme();
      const path = location.pathname;
      if (path !== lastPath) { lastPath = path; onRoute(path); }
      if (profileLink && !profileLink.getAttribute('href')) {
        const p = $('[data-testid="AppTabBar_Profile_Link"]');
        if (p) profileLink.href = p.getAttribute('href');
      }
      const pc = $('[data-testid="primaryColumn"]');
      if (!pc || mode === 'other') return;
      for (const art of $$('article[data-testid="tweet"]', pc)) decorate(art);
      ensureTopbar(pc);
    } catch (err) {
      console.warn('[ForumX]', err);
    }
  }

  new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
  window.addEventListener('popstate', schedule);
  schedule();
})();
