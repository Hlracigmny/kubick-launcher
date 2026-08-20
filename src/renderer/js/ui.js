// Мелкие помощники UI: DOM, форматирование, тосты, модалки.
(function () {
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /** Экранирование — всё, что приходит из API модов, попадает в разметку только через него. */
  function esc(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function el(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html.trim();
    return tpl.content.firstElementChild;
  }

  function formatCount(n) {
    const num = Number(n) || 0;
    if (num >= 1000000) return (num / 1000000).toFixed(num >= 10000000 ? 0 : 1).replace('.0', '') + ' млн';
    if (num >= 1000) return (num / 1000).toFixed(num >= 10000 ? 0 : 1).replace('.0', '') + ' тыс.';
    return String(num);
  }

  function formatSize(bytes) {
    const b = Number(bytes) || 0;
    if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' ГБ';
    if (b >= 1048576) return (b / 1048576).toFixed(1) + ' МБ';
    if (b >= 1024) return (b / 1024).toFixed(0) + ' КБ';
    return b + ' Б';
  }

  function formatDuration(seconds) {
    const s = Number(seconds) || 0;
    if (s < 60) return s + ' сек';
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    if (h) return h + ' ч ' + m + ' мин';
    return m + ' мин';
  }

  /** Короткая дата для плотных списков: «7 июн 2023». */
  function shortDate(value) {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' }).replace(' г.', '');
  }

  function formatDate(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '—';
    const now = Date.now();
    const diff = now - d.getTime();
    if (diff < 60000) return 'только что';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' мин назад';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' ч назад';
    if (diff < 604800000) return Math.floor(diff / 86400000) + ' дн назад';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /* ------------------------------ Тосты ------------------------------ */

  function toast(title, message, kind) {
    const host = $('#toasts');
    if (!host) return;
    const node = el(
      '<div class="toast ' + (kind || '') + '">' +
        '<div class="grow"><b>' + esc(title) + '</b>' +
        (message ? '<span>' + esc(message) + '</span>' : '') + '</div>' +
        '<button class="x" title="Закрыть">' + window.Icons.x + '</button>' +
      '</div>'
    );
    const remove = () => {
      node.style.transition = 'opacity .18s, transform .18s';
      node.style.opacity = '0';
      node.style.transform = 'translateX(20px)';
      setTimeout(() => node.remove(), 190);
    };
    node.querySelector('.x').addEventListener('click', remove);
    host.appendChild(node);
    // Ошибки держим дольше — их нужно успеть прочитать
    setTimeout(remove, kind === 'err' ? 9000 : 4500);
  }

  const toastOk = (t, m) => toast(t, m, 'ok');
  const toastErr = (t, m) => toast(t, m, 'err');

  /* ----------------------------- Модалки ----------------------------- */

  let openModal = null;

  /**
   * Открывает модальное окно. buttons — массив {label, kind, value, keepOpen}.
   * Возвращает промис со значением нажатой кнопки (null при закрытии).
   */
  function modal({ title, subtitle, body, buttons, wide, size, onMount }) {
    return new Promise((resolve) => {
      const backdrop = el('<div class="modal-backdrop"></div>');
      const box = el(
        '<div class="modal' + (wide ? ' wide' : '') + (size ? ' ' + size : '') + '">' +
          '<div class="modal-head"><h2>' + esc(title) + '</h2>' +
          (subtitle ? '<p>' + esc(subtitle) + '</p>' : '') + '</div>' +
          '<div class="modal-body"></div>' +
          '<div class="modal-foot"></div>' +
        '</div>'
      );
      const bodyEl = box.querySelector('.modal-body');
      if (typeof body === 'string') bodyEl.innerHTML = body;
      else if (body) bodyEl.appendChild(body);

      const foot = box.querySelector('.modal-foot');
      let settled = false;
      const close = (value) => {
        if (settled) return;
        settled = true;
        backdrop.remove();
        document.removeEventListener('keydown', onKey);
        openModal = null;
        resolve(value);
      };

      for (const btn of buttons || [{ label: 'Закрыть', value: null }]) {
        const node = el('<button class="btn ' + (btn.kind || '') + '">' + esc(btn.label) + '</button>');
        node.addEventListener('click', async () => {
          if (btn.onClick) {
            const result = await btn.onClick({ box, bodyEl, close });
            if (btn.keepOpen || result === false) return;
            close(result === undefined ? btn.value : result);
            return;
          }
          close(btn.value);
        });
        foot.appendChild(node);
      }

      const onKey = (e) => {
        if (e.key === 'Escape') close(null);
      };
      document.addEventListener('keydown', onKey);
      backdrop.addEventListener('mousedown', (e) => {
        if (e.target === backdrop) close(null);
      });

      backdrop.appendChild(box);
      document.body.appendChild(backdrop);
      openModal = { close };
      if (onMount) onMount({ box, bodyEl, close });

      const firstInput = bodyEl.querySelector('input, select, textarea');
      if (firstInput) setTimeout(() => firstInput.focus(), 60);
    });
  }

  function confirm(title, message, danger) {
    return modal({
      title,
      subtitle: message,
      body: '',
      buttons: [
        { label: 'Отмена', value: false },
        { label: 'Подтвердить', kind: danger ? 'danger' : 'primary', value: true },
      ],
    });
  }

  function closeModal() {
    if (openModal) openModal.close(null);
  }

  window.UI = { $, $$, el, esc, toast, toastOk, toastErr, modal, confirm, closeModal, formatCount, formatSize, formatDuration, formatDate, shortDate };
})();
