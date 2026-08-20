/* Kubick Launcher — интерфейс. */
(function () {
  const { $, el, esc, toast, toastOk, toastErr, modal, confirm, formatCount, formatSize, formatDuration, formatDate, shortDate } = window.UI;
  const I = window.Icons;

  const state = {
    settings: {},
    instances: [],
    accounts: { list: [], activeId: null },
    versions: [],
    latest: {},
    running: new Set(),
    busy: new Set(),
    logs: [],
    view: 'library',
    modsQuery: { source: 'modrinth', type: 'mod', text: '', instanceId: null, sort: 'relevance' },
    modsResults: null,
    modsLoading: false,
    appInfo: {},
    update: null,
    fonts: null,
    lan: null,
    lanServers: null,
    settingsPage: 'general',
    bgPhoto: null,
    themeStatus: null,
    themePhoto: null,
    vpn: null,
    vpnCountries: null,
    vpnServers: null,
    vpnCountry: null,
    friends: null,
  };

  const LOADER_GLYPH = { vanilla: 'MC', fabric: 'FA', quilt: 'QU', forge: 'FO', neoforge: 'NE' };

  /* ============================ Служебное ============================ */

  function activeAccount() {
    return state.accounts.list.find((a) => a.id === state.accounts.activeId) || null;
  }

  function setStatus(text, percent, kind) {
    const bar = $('#status-bar-fill');
    const label = $('#status-text');
    const dot = $('#status-dot');
    if (label) label.textContent = text || 'Готов к работе';
    if (bar) bar.style.width = (percent == null ? 0 : Math.max(0, Math.min(100, percent))) + '%';
    if (dot) dot.className = 'dot ' + (kind || '');
  }

  function percentOf(p) {
    if (!p || !p.total) return null;
    return Math.round((p.done / p.total) * 100);
  }

  async function guard(label, fn) {
    try {
      return await fn();
    } catch (e) {
      toastErr(label, e.message);
      setStatus('Ошибка: ' + e.message, 0, '');
      return null;
    }
  }

  /* ============================= Роутер ============================= */

  const VIEWS = {
    library: { title: 'Библиотека', subtitle: 'Ваши сборки Minecraft', render: renderLibrary },
    mods: { title: 'Каталог модов', subtitle: 'Modrinth и CurseForge — актуальные базы', render: renderMods },
    accounts: { title: 'Аккаунты', subtitle: 'Microsoft и офлайн-профили', render: renderAccounts },
    network: { title: 'Игра по сети', subtitle: 'Миры друзей в локальной сети и список серверов', render: renderNetwork },
    vpn: { title: 'VPN', subtitle: 'Бесплатные серверы VPN Gate с выбором страны', render: renderVpn },
    settings: { title: 'Настройки', subtitle: 'Java, память и внешний вид', render: renderSettings },
    console: { title: 'Консоль', subtitle: 'Логи запуска и работы игры', render: renderConsole },
  };

  function go(view) {
    if (!VIEWS[view]) view = 'library';
    state.view = view;
    for (const item of document.querySelectorAll('.nav-item')) {
      item.classList.toggle('active', item.dataset.view === view);
    }
    render();
  }

  function render() {
    const def = VIEWS[state.view];
    const host = $('#view');
    host.scrollTop = 0;
    host.innerHTML =
      '<div class="page-head">' +
        '<div><h1>' + esc(def.title) + '</h1><p>' + esc(def.subtitle) + '</p></div>' +
        '<div class="head-actions" id="head-actions"></div>' +
      '</div>' +
      '<div id="view-body"></div>';
    def.render($('#view-body'), $('#head-actions'));
  }

  /* =========================== Библиотека =========================== */

  function renderLibrary(body, actions) {
    actions.appendChild(button('Обновить', I.refresh, 'ghost sm', async () => {
      await loadInstances();
      render();
    }));

    if (state.instances.length) {
      // Компактная кнопка по центру вместо крупной в углу шапки
      const bar = el('<div class="create-bar"></div>');
      bar.appendChild(button('Новая сборка', I.plus, 'primary sm', openCreateModal));
      body.appendChild(bar);
    }

    if (!state.instances.length) {
      body.appendChild(el(
        '<div class="empty">' + I.package +
          '<h3>Пока нет ни одной сборки</h3>' +
          '<p>Создайте сборку: выберите версию Minecraft и загрузчик модов — Fabric, Quilt, Forge или NeoForge. Все файлы скачаются автоматически.</p>' +
        '</div>'
      ));
      const cta = button('Создать первую сборку', I.plus, 'primary sm', openCreateModal);
      body.querySelector('.empty').appendChild(cta);
      return;
    }

    const list = el('<div class="inst-list"></div>');
    const sorted = [...state.instances].sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0));
    for (const inst of sorted) list.appendChild(instanceRow(inst));
    body.appendChild(list);
  }

  /** Строка сборки — тот же плотный список, что и в каталоге модов. */
  function instanceRow(inst) {
    const isRunning = state.running.has(inst.id);
    const isBusy = state.busy.has(inst.id);
    const glyph = LOADER_GLYPH[inst.loader] || 'MC';

    const row = el(
      '<div class="inst-row' + (isRunning ? ' running' : '') + '" data-id="' + esc(inst.id) + '">' +
        '<div class="inst-mark l-' + esc(inst.loader) + '">' + esc(glyph) + '</div>' +
        '<div class="inst-main">' +
          '<div class="inst-name">' + esc(inst.name) + '</div>' +
          '<div class="inst-sub">' +
            '<span class="chip loader-' + esc(inst.loader) + '">' + esc(inst.loaderLabel || inst.loader) + '</span>' +
            '<span class="chip">' + esc(inst.mcVersion) + '</span>' +
            (inst.modCount ? '<span class="chip">' + inst.modCount + ' модов</span>' : '') +
            '<span class="muted" data-role="state">' +
              (isRunning ? 'игра запущена' : isBusy ? 'подготовка…' :
                (inst.lastPlayed ? 'играли ' + formatDate(inst.lastPlayed) : 'ещё не запускалась')) +
            '</span>' +
          '</div>' +
        '</div>' +
        '<div class="inst-actions"></div>' +
        '<div class="inst-progress"><i data-role="bar"></i></div>' +
      '</div>'
    );

    const actions = row.querySelector('.inst-actions');
    if (isRunning) {
      actions.appendChild(button('Остановить', I.stop, 'danger sm', () => stopGame(inst.id)));
    } else {
      const play = button(isBusy ? 'Подготовка…' : 'Играть', I.play, 'primary sm', () => launchGame(inst.id));
      play.disabled = isBusy;
      actions.appendChild(play);
    }

    actions.appendChild(iconButton(I.package, 'Каталог модов для этой сборки', () => {
      state.modsQuery.instanceId = inst.id;
      go('mods');
    }));
    actions.appendChild(iconButton(I.folder, 'Открыть папку', () => window.api.instances.openFolder(inst.id)));
    actions.appendChild(iconButton(I.sliders, 'Окно сборки', () => openInstanceMenu(inst)));

    return row;
  }

  const INSTANCE_SECTIONS = [
    { id: 'log', label: 'Журнал', icon: 'terminal' },
    { id: 'version', label: 'Версия', icon: 'cube' },
    { id: 'mods', label: 'Моды', icon: 'package' },
    { id: 'resourcepacks', label: 'Наборы ресурсов', icon: 'image' },
    { id: 'shaderpacks', label: 'Наборы шейдеров', icon: 'palette' },
    { id: 'notes', label: 'Заметки', icon: 'inbox' },
    { id: 'worlds', label: 'Миры', icon: 'library' },
    { id: 'servers', label: 'Серверы', icon: 'network' },
    { id: 'screenshots', label: 'Снимки экрана', icon: 'grid' },
    { id: 'settings', label: 'Параметры', icon: 'sliders' },
    { id: 'logs', label: 'Другие журналы', icon: 'rows' },
  ];

  /**
   * Окно сборки: слева разделы, справа содержимое. Всё, что показывается,
   * читается из настоящих файлов игры — моды из jar, миры из level.dat,
   * серверы опрашиваются по сетевому протоколу Minecraft.
   */
  async function openInstanceMenu(inst) {
    const ui = {
      section: 'log',
      overrides: { ...(inst.overrides || {}) },
      data: {},              // кеш загруженного по разделам
      logOptions: { follow: true, wrap: true, color: true },
      logText: null,
      openedLog: null,
    };

    const body = el('<div class="inst-window"></div>');
    const nav = el('<div class="inst-nav"></div>');
    const host = el('<div class="inst-content"></div>');
    body.appendChild(nav);
    body.appendChild(host);

    function paintNav() {
      nav.innerHTML = '';
      for (const s of INSTANCE_SECTIONS) {
        const item = el(
          '<button class="inst-nav-item' + (s.id === ui.section ? ' active' : '') + '">' +
          (I[s.icon] || '') + esc(s.label) + '</button>'
        );
        item.addEventListener('click', () => { ui.section = s.id; paint(); });
        nav.appendChild(item);
      }
    }

    function paint() {
      paintNav();
      host.innerHTML = '';
      const render = SECTION_RENDER[ui.section];
      if (render) render(host);
      host.scrollTop = 0;
    }

    /** Раздел с основной областью и панелью действий справа. */
    function split(target, title, subtitle) {
      const wrap = el(
        '<div class="sec">' +
          '<div class="sec-head"><h2>' + esc(title) + '</h2>' +
            (subtitle ? '<p>' + esc(subtitle) + '</p>' : '') + '</div>' +
          '<div class="sec-split"><div class="sec-main"></div><div class="sec-aside"></div></div>' +
        '</div>'
      );
      target.appendChild(wrap);
      return { main: wrap.querySelector('.sec-main'), aside: wrap.querySelector('.sec-aside') };
    }

    /** Загружает данные раздела один раз и перерисовывает, когда они пришли. */
    function ensure(key, loader, target, placeholderHeight) {
      if (ui.data[key]) return ui.data[key];
      target.appendChild(el('<div class="skeleton" style="height:' + (placeholderHeight || 120) + 'px"></div>'));
      loader().then((value) => {
        ui.data[key] = value || [];
        paint();
      }).catch((e) => {
        ui.data[key] = [];
        toastErr('Не удалось прочитать данные', e.message);
        paint();
      });
      return null;
    }

    const reload = (key) => { delete ui.data[key]; paint(); };

    /* ------------------------------ Журнал ------------------------------ */

    function sectionLog(target) {
      const wrap = el(
        '<div class="sec">' +
          '<div class="sec-head"><h2>Журнал</h2>' +
            '<p>Вывод игры. Пока сборка запущена, строки appear здесь в реальном времени.</p></div>' +
          '<div class="log-toolbar"></div>' +
          '<pre class="log-view" data-role="log"></pre>' +
        '</div>'
      );
      const toolbar = wrap.querySelector('.log-toolbar');
      const view = wrap.querySelector('[data-role="log"]');

      for (const [key, label] of [['follow', 'Продолжать обновление'], ['wrap', 'Перенос строк'], ['color', 'Цветные строки']]) {
        const box = el(
          '<label class="check"><input type="checkbox"' + (ui.logOptions[key] ? ' checked' : '') + '>' +
          '<span>' + esc(label) + '</span></label>'
        );
        box.querySelector('input').addEventListener('change', (e) => {
          ui.logOptions[key] = e.target.checked;
          paint();
        });
        toolbar.appendChild(box);
      }

      const actions = el('<div class="log-actions"></div>');
      actions.appendChild(button('Копировать', I.copy, 'sm', async () => {
        try {
          await navigator.clipboard.writeText(currentLogText());
          toastOk('Журнал скопирован');
        } catch {
          toastErr('Не удалось скопировать');
        }
      }));
      actions.appendChild(button('Открыть файл', I.external, 'sm', async () => {
        await guard('Не удалось открыть файл', () => window.api.inst.openFile(logPathOf(inst)));
      }));
      actions.appendChild(button('Очистить', I.trash, 'sm', () => {
        ui.logText = '';
        if (state.logs.length) state.logs = [];
        paint();
      }));
      toolbar.appendChild(actions);
      target.appendChild(wrap);

      view.classList.toggle('nowrap', !ui.logOptions.wrap);

      if (ui.logText === null) {
        view.textContent = 'Читаем журнал…';
        window.api.game.log(inst.id).then((text) => {
          ui.logText = text || '';
          paint();
        }).catch(() => { ui.logText = ''; paint(); });
        return;
      }

      const text = currentLogText();
      if (!text.trim()) {
        view.innerHTML = '<span class="muted">Журнал пуст — запустите сборку, и здесь появится вывод игры.</span>';
        return;
      }

      const lines = text.split(/\r?\n/).slice(-2500);
      view.innerHTML = ui.logOptions.color
        ? lines.map(logLine).join('\n')
        : lines.map((l) => esc(l)).join('\n');
      if (ui.logOptions.follow) view.scrollTop = view.scrollHeight;
    }

    function currentLogText() {
      // Пока игра идёт, живые строки полнее файла на диске
      const live = state.running.has(inst.id) && state.logs.length ? state.logs.join('\n') : '';
      return live || ui.logText || '';
    }

    function logPathOf(instance) {
      return (state.appInfo.root || '') + '\\logs\\' + instance.id + '.log';
    }

    /* ------------------------------ Версия ------------------------------ */

    function sectionVersion(target) {
      const { main, aside } = split(target, 'Версия', 'Из чего собрана эта сборка.');

      const info = ensure('components', () => window.api.inst.components(inst.id), main, 160);
      if (info) {
        const table = el('<div class="grid-table"></div>');
        table.appendChild(el(
          '<div class="gt-head"><span>Компонент</span><span>Версия</span><span>Обязателен</span></div>'
        ));
        for (const c of info.components) {
          table.appendChild(el(
            '<div class="gt-row"><span><b>' + esc(c.name) + '</b></span>' +
            '<span class="mono">' + esc(c.version || '—') + '</span>' +
            '<span>' + (c.required ? I.check : '') + '</span></div>'
          ));
        }
        main.appendChild(table);
        main.appendChild(el(
          '<div class="hint" style="margin-top:12px">Идентификатор запуска: <span class="mono">' +
          esc(info.versionId) + '</span><br>Главный класс: <span class="mono">' + esc(info.mainClass) + '</span>' +
          '<br>Индекс ресурсов: <span class="mono">' + esc(info.assetIndex) + '</span> · библиотек: ' + info.libraries +
          '</div>'
        ));
      }

      aside.appendChild(button('Переустановить файлы', I.wrench, 'sm block', async () => {
        window.UI.closeModal();
        await guard('Не удалось переустановить', async () => {
          state.busy.add(inst.id); render();
          try {
            await window.api.instances.repair(inst.id);
            toastOk('Файлы проверены', 'Повреждённые перекачаны заново');
          } finally {
            state.busy.delete(inst.id);
            setStatus('Готов к работе', 0, '');
            render();
          }
        });
      }));
      aside.appendChild(button('Папка сборки', I.folder, 'sm block', () => window.api.instances.openFolder(inst.id)));
      aside.appendChild(button('Папка библиотек', I.folder, 'sm block', () => window.api.app.reveal('root')));
      aside.appendChild(button('Дублировать', I.copy, 'sm block', async () => {
        window.UI.closeModal();
        await guard('Не удалось дублировать', async () => {
          await window.api.instances.duplicate(inst.id);
          await loadInstances();
          render();
          toastOk('Сборка скопирована');
        });
      }));
      aside.appendChild(button('Удалить сборку', I.trash, 'danger sm block', async () => {
        window.UI.closeModal();
        const yes = await confirm('Удалить сборку?',
          'Папка «' + inst.name + '» со всеми модами и мирами будет удалена безвозвратно.', true);
        if (!yes) return;
        await guard('Не удалось удалить', async () => {
          await window.api.instances.remove(inst.id, true);
          await loadInstances();
          render();
          toastOk('Сборка удалена');
        });
      }));
    }

    /* -------------------------- Моды и наборы --------------------------- */

    function fileSection(target, opts) {
      const { main, aside } = split(target, opts.title, opts.subtitle);
      const items = ensure(opts.key, opts.loader, main, 160);
      if (!items) return;

      if (!items.length) {
        main.appendChild(el(
          '<div class="empty" style="padding:34px">' + I.inbox +
          '<h3>Пока пусто</h3><p>' + esc(opts.emptyHint) + '</p></div>'
        ));
      } else {
        const table = el('<div class="grid-table ' + opts.tableClass + '"></div>');
        table.appendChild(el('<div class="gt-head">' + opts.head + '</div>'));
        for (const item of items) table.appendChild(opts.row(item));
        main.appendChild(table);
        main.appendChild(el('<div class="hint" style="margin-top:10px">Всего: ' + items.length + '</div>'));
      }

      aside.appendChild(button('Скачать', I.download, 'primary sm block', () => {
        window.UI.closeModal();
        state.modsQuery.instanceId = inst.id;
        state.modsQuery.type = opts.catalogType;
        state.modsResults = null;
        go('mods');
      }));
      aside.appendChild(button('Добавить файлы', I.plus, 'sm block', async () => {
        await guard('Не удалось добавить файлы', async () => {
          const res = await window.api.inst.addFiles(inst.id, opts.sub, opts.kind);
          if (res.added) {
            toastOk('Добавлено файлов: ' + res.added);
            reload(opts.key);
          }
        });
      }));
      aside.appendChild(button('Открыть папку', I.folder, 'sm block',
        () => window.api.instances.openFolder(inst.id, opts.sub)));
      aside.appendChild(button('Обновить список', I.refresh, 'sm block', () => reload(opts.key)));
      if (items && items.length) {
        aside.appendChild(button('Скопировать список', I.copy, 'sm block', async () => {
          const text = items.map((m) => m.name + (m.version ? ' ' + m.version : '')).join('\n');
          try {
            await navigator.clipboard.writeText(text);
            toastOk('Список скопирован', items.length + ' строк');
          } catch {
            toastErr('Не удалось скопировать');
          }
        }));
      }
    }

    function toggleRow(item, key) {
      const sw = el('<label class="switch"><input type="checkbox"' +
        (item.enabled ? ' checked' : '') + '><span class="track"></span></label>');
      sw.querySelector('input').addEventListener('change', async (e) => {
        const wanted = e.target.checked;
        try {
          await window.api.mods.toggle(item.path, wanted);
          reload(key);
        } catch (err) {
          e.target.checked = !wanted;
          toastErr('Не удалось переключить', err.message);
        }
      });
      return sw;
    }

    function removeButton(item, key, recursive) {
      return iconButton(I.trash, 'Удалить', async () => {
        const yes = await confirm('Удалить файл?', item.filename || item.folder, true);
        if (!yes) return;
        await guard('Не удалось удалить', async () => {
          await window.api.inst.deleteFile(item.path, Boolean(recursive));
          reload(key);
        });
      });
    }

    function sectionMods(target) {
      fileSection(target, {
        key: 'mods', sub: 'mods', kind: 'mod', catalogType: 'mod',
        title: 'Моды', subtitle: 'Названия и версии прочитаны из самих jar-файлов.',
        emptyHint: 'Скачайте моды из каталога или положите jar-файлы в папку mods.',
        tableClass: 'gt-mods',
        head: '<span></span><span></span><span>Название</span><span>Версия</span><span>Изменён</span><span>Загрузчик</span><span></span>',
        loader: () => window.api.inst.mods(inst.id),
        row: (m) => {
          const row = el(
            '<div class="gt-row' + (m.enabled ? '' : ' off') + '">' +
              '<span data-role="sw"></span>' +
              '<span class="gt-icon">' + (m.icon ? '<img src="' + esc(m.icon) + '" alt="">' : I.package) + '</span>' +
              '<span><b>' + esc(m.name) + '</b>' +
                (m.description ? '<em>' + esc(m.description.slice(0, 70)) + '</em>' : '') + '</span>' +
              '<span class="mono">' + esc(m.version || '—') + '</span>' +
              '<span class="muted">' + esc(shortDate(m.mtime)) + '</span>' +
              '<span class="muted">' + esc(m.loader || '—') + '</span>' +
              '<span data-role="act"></span>' +
            '</div>'
          );
          row.querySelector('[data-role="sw"]').appendChild(toggleRow(m, 'mods'));
          row.querySelector('[data-role="act"]').appendChild(removeButton(m, 'mods'));
          return row;
        },
      });
    }

    function packSection(target, sub, title, subtitle, catalogType) {
      fileSection(target, {
        key: sub, sub, kind: 'pack', catalogType,
        title, subtitle,
        emptyHint: 'Скачайте их из каталога или положите файлы в папку ' + sub + '.',
        tableClass: 'gt-packs',
        head: '<span></span><span>Название</span><span>Формат</span><span>Изменён</span><span>Размер</span><span></span>',
        loader: () => window.api.inst.packs(inst.id, sub),
        row: (p) => {
          const row = el(
            '<div class="gt-row">' +
              '<span class="gt-icon">' + (p.icon ? '<img src="' + esc(p.icon) + '" alt="">' : I.image) + '</span>' +
              '<span><b>' + esc(p.name) + '</b>' +
                (p.description ? '<em>' + esc(p.description.slice(0, 70)) + '</em>' : '') + '</span>' +
              '<span class="mono">' + (p.format != null ? esc(String(p.format)) : '—') + '</span>' +
              '<span class="muted">' + esc(shortDate(p.mtime)) + '</span>' +
              '<span class="muted">' + esc(formatSize(p.size)) + '</span>' +
              '<span data-role="act"></span>' +
            '</div>'
          );
          row.querySelector('[data-role="act"]').appendChild(removeButton(p, sub, p.folder));
          return row;
        },
      });
    }

    /* ------------------------------ Заметки ----------------------------- */

    function sectionNotes(target) {
      const wrap = el(
        '<div class="sec">' +
          '<div class="sec-head"><h2>Заметки</h2>' +
          '<p>Личные записи по сборке: список нужных модов, координаты, пароли от серверов.</p></div>' +
        '</div>'
      );
      target.appendChild(wrap);

      const text = ensure('notes', async () => [await window.api.inst.notes(inst.id)], wrap, 200);
      if (!text) return;

      const area = el('<textarea class="input notes-area" placeholder="Здесь пусто — напишите что-нибудь"></textarea>');
      area.value = text[0] || '';
      wrap.appendChild(area);

      const row = el('<div class="inline" style="margin-top:12px"></div>');
      row.appendChild(button('Сохранить', I.check, 'primary sm', async () => {
        await guard('Не удалось сохранить заметки', async () => {
          await window.api.inst.saveNotes(inst.id, area.value);
          ui.data.notes = [area.value];
          toastOk('Заметки сохранены');
        });
      }));
      row.appendChild(el('<span class="hint">Файл kubick-notes.txt в папке сборки</span>'));
      wrap.appendChild(row);
    }

    /* ------------------------------- Миры ------------------------------- */

    function sectionWorlds(target) {
      const { main, aside } = split(target, 'Миры', 'Прочитаны из level.dat в папке saves.');
      const list = ensure('worlds', () => window.api.inst.worlds(inst.id), main, 160);
      if (!list) return;

      if (!list.length) {
        main.appendChild(el('<div class="empty" style="padding:34px">' + I.library +
          '<h3>Миров пока нет</h3><p>Создайте мир в игре — он появится здесь.</p></div>'));
      } else {
        const box = el('<div class="stack" style="gap:9px"></div>');
        for (const w of list) {
          const row = el(
            '<div class="world-row">' +
              '<div class="world-icon">' + (w.icon ? '<img src="' + esc(w.icon) + '" alt="">' : I.library) + '</div>' +
              '<div class="grow" style="min-width:0"><b>' + esc(w.name) + '</b>' +
                '<div class="muted" style="font-size:11.5px">' +
                  [w.mode, w.hardcore ? 'хардкор' : '', w.version, formatSize(w.size),
                    w.lastPlayed ? 'играли ' + formatDate(w.lastPlayed) : '']
                    .filter(Boolean).map(esc).join(' · ') +
                '</div>' +
              '</div>' +
            '</div>'
          );
          const ctl = el('<div class="row-ctl"></div>');
          ctl.appendChild(iconButton(I.folder, 'Открыть папку мира', () => window.api.inst.showFile(w.path)));
          ctl.appendChild(removeButton({ path: w.path, filename: w.name }, 'worlds', true));
          row.appendChild(ctl);
          box.appendChild(row);
        }
        main.appendChild(box);
      }

      aside.appendChild(button('Папка миров', I.folder, 'sm block',
        () => window.api.instances.openFolder(inst.id, 'saves')));
      aside.appendChild(button('Обновить', I.refresh, 'sm block', () => reload('worlds')));
    }

    /* ------------------------------ Серверы ----------------------------- */

    function sectionServers(target) {
      const { main, aside } = split(target, 'Серверы', 'Список из servers.dat. Пинг опрашивается у самих серверов.');
      const list = ensure('servers', () => window.api.lan.servers(inst.id), main, 140);
      if (!list) return;

      if (!list.length) {
        main.appendChild(el('<div class="empty" style="padding:34px">' + I.network +
          '<h3>Серверов нет</h3><p>Добавьте адрес справа — он появится в игре во вкладке «Сетевая игра».</p></div>'));
      } else {
        const box = el('<div class="stack" style="gap:8px"></div>');
        for (const s of list) {
          const ping = (ui.data.pings || {})[s.ip];
          const row = el(
            '<div class="file-row">' +
              '<div class="fname"><b>' + esc(s.name) + '</b>' +
                '<div class="muted" style="font-size:11.5px">' + esc(s.ip) +
                  (ping ? (ping.online
                    ? ' · ' + ping.latency + ' мс · ' + esc(ping.version) + ' · игроков ' + ping.players + '/' + ping.maxPlayers
                    : ' · ' + esc(ping.error)) : ' · пинг не проверен') +
                '</div>' +
                (ping && ping.online && ping.motd ? '<div class="muted" style="font-size:11px">' + esc(ping.motd) + '</div>' : '') +
              '</div>' +
              '<span class="ping-dot ' + (ping ? (ping.online ? 'up' : 'down') : '') + '"></span>' +
            '</div>'
          );
          const ctl = el('<div class="row-ctl"></div>');
          ctl.appendChild(iconButton(I.copy, 'Скопировать адрес', async () => {
            try { await navigator.clipboard.writeText(s.ip); toastOk('Адрес скопирован', s.ip); }
            catch { toastErr('Не удалось скопировать'); }
          }));
          ctl.appendChild(iconButton(I.trash, 'Убрать сервер', async () => {
            await guard('Не удалось убрать', async () => {
              await window.api.lan.removeServer(inst.id, s.ip);
              reload('servers');
            });
          }));
          row.appendChild(ctl);
          box.appendChild(row);
        }
        main.appendChild(box);
      }

      aside.appendChild(button('Проверить пинг', I.refresh, 'primary sm block', async () => {
        if (!list.length) return;
        await guard('Не удалось опросить серверы', async () => {
          const results = await window.api.inst.pingServers(list.map((s) => s.ip));
          ui.data.pings = {};
          for (const r of results) ui.data.pings[r.address] = r;
          paint();
        });
      }));
      aside.appendChild(button('Добавить сервер', I.plus, 'sm block', async () => {
        window.UI.closeModal();
        await addServerToInstance('', '');
      }));
      aside.appendChild(button('Обновить список', I.rows, 'sm block', () => reload('servers')));
    }

    /* --------------------------- Снимки экрана -------------------------- */

    function sectionScreenshots(target) {
      const { main, aside } = split(target, 'Снимки экрана', 'Из папки screenshots — превью строится на лету.');
      const shots = ensure('screenshots', () => window.api.inst.screenshots(inst.id), main, 160);
      if (!shots) return;

      if (!shots.length) {
        main.appendChild(el('<div class="empty" style="padding:34px">' + I.grid +
          '<h3>Снимков нет</h3><p>Нажмите F2 в игре — кадры появятся здесь.</p></div>'));
      } else {
        const grid = el('<div class="shot-grid"></div>');
        for (const shot of shots) {
          const card = el(
            '<div class="shot-card">' +
              (shot.preview ? '<img src="' + esc(shot.preview) + '" alt="">' : '<div class="shot-empty"></div>') +
              '<div class="shot-meta"><b>' + esc(shot.filename) + '</b>' +
              '<span>' + esc(shortDate(shot.mtime)) + ' · ' + esc(formatSize(shot.size)) + '</span></div>' +
            '</div>'
          );
          card.addEventListener('click', () => window.api.inst.openFile(shot.path));
          const del = iconButton(I.trash, 'Удалить снимок', async (e) => {
            e.stopPropagation();
            await guard('Не удалось удалить', async () => {
              await window.api.inst.deleteFile(shot.path, false);
              reload('screenshots');
            });
          });
          del.classList.add('shot-del');
          card.appendChild(del);
          grid.appendChild(card);
        }
        main.appendChild(grid);
      }

      aside.appendChild(button('Открыть папку', I.folder, 'sm block',
        () => window.api.instances.openFolder(inst.id, 'screenshots')));
      aside.appendChild(button('Обновить', I.refresh, 'sm block', () => reload('screenshots')));
    }

    /* -------------------------- Другие журналы -------------------------- */

    function sectionLogs(target) {
      const { main, aside } = split(target, 'Другие журналы', 'Файлы из logs и crash-reports внутри сборки.');
      const files = ensure('logs', () => window.api.inst.logs(inst.id), main, 140);
      if (!files) return;

      if (!files.length) {
        main.appendChild(el('<div class="empty" style="padding:34px">' + I.rows +
          '<h3>Журналов нет</h3><p>Они появятся после первого запуска игры.</p></div>'));
      } else {
        const box = el('<div class="stack" style="gap:7px"></div>');
        for (const f of files) {
          const row = el(
            '<div class="file-row' + (ui.openedLog === f.path ? ' active' : '') + '">' +
              '<div class="fname"><b>' + esc(f.filename) + '</b>' +
                '<div class="muted" style="font-size:11.5px">' + esc(f.kind) + ' · ' +
                esc(shortDate(f.mtime)) + ' · ' + esc(formatSize(f.size)) + '</div></div>' +
            '</div>'
          );
          const ctl = el('<div class="row-ctl"></div>');
          ctl.appendChild(button('Показать', I.terminal, 'sm', async () => {
            await guard('Не удалось прочитать', async () => {
              const text = await window.api.inst.readLog(f.path);
              ui.openedLog = f.path;
              ui.data.openedText = text;
              paint();
            });
          }));
          ctl.appendChild(iconButton(I.external, 'Открыть в системе', () => window.api.inst.openFile(f.path)));
          row.appendChild(ctl);
          box.appendChild(row);
        }
        main.appendChild(box);

        if (ui.openedLog && ui.data.openedText != null) {
          const view = el('<pre class="log-view" style="height:280px;margin-top:14px"></pre>');
          view.innerHTML = ui.data.openedText.split(/\r?\n/).slice(-1500).map(logLine).join('\n');
          main.appendChild(view);
          view.scrollTop = view.scrollHeight;
        }
      }

      aside.appendChild(button('Папка логов', I.folder, 'sm block',
        () => window.api.instances.openFolder(inst.id, 'logs')));
      aside.appendChild(button('Обновить', I.refresh, 'sm block', () => reload('logs')));
    }

    /* ----------------------------- Параметры ---------------------------- */

    function sectionSettings(target) {
      const effective = (key) => (key in ui.overrides ? ui.overrides[key] : state.settings[key]);
      const isOwn = (key) => key in ui.overrides;
      const setOwn = (key, value) => { ui.overrides[key] = value; paint(); };
      const clearOwn = (key) => { delete ui.overrides[key]; paint(); };

      const describe = (key) => {
        const v = state.settings[key];
        if (key === 'memoryMb') return v + ' МБ';
        if (key === 'javaPath') return v || 'автоматически';
        if (key === 'fullscreen') return v ? 'включён' : 'выключен';
        if (key === 'jvmArgs') return v ? String(v).slice(0, 34) + '…' : 'пусто';
        return String(v);
      };

      function overrideRow(title, hint, key, build) {
        const own = isOwn(key);
        const row = el(
          '<div class="row"><div class="row-info"><b>' + esc(title) +
            (own ? ' <span class="chip" style="margin-left:6px">своё</span>' : '') + '</b>' +
            '<span>' + esc(own ? hint : hint + ' · сейчас общее: ' + describe(key)) + '</span></div></div>'
        );
        const ctl = el('<div class="row-ctl"></div>');
        build(ctl);
        if (own) ctl.appendChild(iconButton(I.refresh, 'Вернуть общее значение', () => clearOwn(key)));
        row.appendChild(ctl);
        return row;
      }

      const wrap = el(
        '<div class="sec"><div class="sec-head"><h2>Параметры</h2>' +
        '<p>Действуют только для сборки «' + esc(inst.name) + '», поверх общих настроек.</p></div>' +
        '<div class="panel" data-role="panel"></div></div>'
      );
      const panel = wrap.querySelector('[data-role="panel"]');

      panel.appendChild(overrideRow('Оперативная память', 'Сколько выделять этой сборке', 'memoryMb', (ctl) => {
        const box = el('<div style="display:flex;align-items:center;gap:10px;width:270px"></div>');
        const value = el('<b style="width:72px;text-align:right">' + effective('memoryMb') + ' МБ</b>');
        const range = el('<input type="range" min="1024" max="16384" step="512" value="' + effective('memoryMb') + '">');
        range.addEventListener('input', () => { value.textContent = range.value + ' МБ'; });
        range.addEventListener('change', () => setOwn('memoryMb', parseInt(range.value, 10)));
        box.appendChild(range); box.appendChild(value);
        ctl.appendChild(box);
      }));

      panel.appendChild(overrideRow('Путь к Java', 'Своя версия Java для этой сборки', 'javaPath', (ctl) => {
        ctl.appendChild(button('Выбрать', I.coffee, 'sm', async () => {
          await guard('Не удалось выбрать Java', async () => {
            const info = await window.api.java.pick();
            if (!info) return;
            setOwn('javaPath', info.path);
            toastOk('Java выбрана', 'Версия ' + info.major);
          });
        }));
      }));
      if (isOwn('javaPath')) {
        panel.appendChild(el('<div class="hint" style="word-break:break-all">' + esc(ui.overrides.javaPath) + '</div>'));
      }

      panel.appendChild(overrideRow('Аргументы JVM', 'Флаги запуска именно этой сборки', 'jvmArgs', (ctl) => {
        const input = el('<input class="input" style="width:300px" value="' + esc(effective('jvmArgs') || '') + '">');
        input.addEventListener('change', () => setOwn('jvmArgs', input.value));
        ctl.appendChild(input);
      }));
      panel.appendChild(overrideRow('Ширина окна', 'В пикселях', 'width', (ctl) => {
        const input = el('<input class="input" type="number" style="width:110px" value="' + effective('width') + '">');
        input.addEventListener('change', () => setOwn('width', parseInt(input.value, 10) || 1280));
        ctl.appendChild(input);
      }));
      panel.appendChild(overrideRow('Высота окна', 'В пикселях', 'height', (ctl) => {
        const input = el('<input class="input" type="number" style="width:110px" value="' + effective('height') + '">');
        input.addEventListener('change', () => setOwn('height', parseInt(input.value, 10) || 720));
        ctl.appendChild(input);
      }));
      panel.appendChild(overrideRow('Полный экран', 'Игнорирует заданное разрешение', 'fullscreen', (ctl) => {
        const sw = el('<label class="switch"><input type="checkbox"' +
          (effective('fullscreen') ? ' checked' : '') + '><span class="track"></span></label>');
        sw.querySelector('input').addEventListener('change', (e) => setOwn('fullscreen', e.target.checked));
        ctl.appendChild(sw);
      }));

      target.appendChild(wrap);

      target.appendChild(el(
        '<div class="panel" style="margin-top:14px"><h2>Сведения</h2>' +
        '<div class="row"><div class="row-info"><b>Версия запуска</b><span class="mono">' + esc(inst.versionId) + '</span></div></div>' +
        '<div class="row"><div class="row-info"><b>Наиграно</b><span>' + esc(formatDuration(inst.playTime || 0)) + '</span></div></div>' +
        '<div class="row"><div class="row-info"><b>Последний запуск</b><span>' +
          esc(inst.lastPlayed ? formatDate(inst.lastPlayed) : 'ещё не запускалась') + '</span></div></div>' +
        (inst.modpack ? '<div class="row"><div class="row-info"><b>Готовая сборка</b><span>' +
          esc(inst.modpack.source === 'modrinth' ? 'Modrinth' : 'CurseForge') + '</span></div></div>' : '') +
        '<div class="row"><div class="row-info"><b>Папка</b><span style="word-break:break-all">' +
          esc(inst.dir) + '</span></div></div></div>'
      ));
    }

    const SECTION_RENDER = {
      log: sectionLog,
      version: sectionVersion,
      mods: sectionMods,
      resourcepacks: (t) => packSection(t, 'resourcepacks', 'Наборы ресурсов',
        'Описания прочитаны из pack.mcmeta внутри наборов.', 'resourcepack'),
      shaderpacks: (t) => packSection(t, 'shaderpacks', 'Наборы шейдеров',
        'Файлы из папки shaderpacks.', 'shader'),
      notes: sectionNotes,
      worlds: sectionWorlds,
      servers: sectionServers,
      screenshots: sectionScreenshots,
      settings: sectionSettings,
      logs: sectionLogs,
    };

    paint();

    const result = await modal({
      title: inst.name,
      subtitle: (inst.loaderLabel || inst.loader) + ' · Minecraft ' + inst.mcVersion,
      body,
      size: 'xl',
      buttons: [
        { label: 'Закрыть', value: null },
        { label: 'Сохранить параметры', kind: 'primary', value: 'save' },
      ],
    });

    if (result !== 'save') return;
    await guard('Не удалось сохранить', async () => {
      await window.api.instances.update(inst.id, { overrides: ui.overrides });
      await loadInstances();
      render();
      const count = Object.keys(ui.overrides).length;
      toastOk('Параметры сохранены', count ? 'Своих значений: ' + count : 'Все параметры общие');
    });
  }

  /* ======================= Создание сборки ========================== */

  async function openCreateModal() {
    const body = el(
      '<div class="stack">' +
        '<div class="seg cr-modes" id="cr-mode">' +
          '<button data-m="custom">Своя сборка</button>' +
          '<button data-m="pack">Готовая сборка игроков</button>' +
        '</div>' +
        '<div class="field"><label>Название сборки</label>' +
          '<input class="input" id="cr-name" placeholder="Например: Приключения с друзьями" maxlength="48"></div>' +
        '<div id="cr-packs" hidden></div>' +
        '<div id="cr-custom">' +
        '<div class="field">' +
          '<div class="picker-head">' +
            '<label>Версия Minecraft</label>' +
            '<div class="picker-tools">' +
              '<div class="search-wrap"><input class="input" id="cr-search" placeholder="Поиск версии"></div>' +
              '<select class="select" id="cr-type" style="width:130px">' +
                '<option value="release">Релизы</option>' +
                '<option value="snapshot">Снапшоты</option>' +
                '<option value="old">Старые</option>' +
                '<option value="all">Все версии</option>' +
              '</select>' +
              '<div class="seg" id="cr-view">' +
                '<button data-v="list" title="Списком"></button>' +
                '<button data-v="cards" title="Карточками"></button>' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div class="version-box" id="cr-versions"></div>' +
          '<span class="hint" id="cr-version-hint"></span>' +
        '</div>' +
        '<div class="panel-grid">' +
          '<div class="field"><label>Загрузчик модов</label>' +
            '<select class="select" id="cr-loader">' +
              '<option value="vanilla">Vanilla — без модов</option>' +
              '<option value="fabric">Fabric — лёгкий и быстрый</option>' +
              '<option value="quilt">Quilt — форк Fabric</option>' +
              '<option value="forge">Forge — классика, много модов</option>' +
              '<option value="neoforge">NeoForge — развитие Forge</option>' +
            '</select>' +
          '</div>' +
        '</div>' +
        '<div class="field" id="cr-loader-wrap" hidden><label>Версия загрузчика</label>' +
          '<select class="select" id="cr-loader-version"></select>' +
          '<span class="hint" id="cr-loader-hint">Рекомендуется оставить последнюю стабильную.</span>' +
        '</div>' +
        '</div>' +
      '</div>'
    );

    const nameInput = body.querySelector('#cr-name');
    const searchInput = body.querySelector('#cr-search');
    const typeSel = body.querySelector('#cr-type');
    const viewSeg = body.querySelector('#cr-view');
    const versionBox = body.querySelector('#cr-versions');
    const versionHint = body.querySelector('#cr-version-hint');
    const loaderSel = body.querySelector('#cr-loader');
    const loaderWrap = body.querySelector('#cr-loader-wrap');
    const loaderSel2 = body.querySelector('#cr-loader-version');
    const loaderHint = body.querySelector('#cr-loader-hint');

    /* --- Два способа создать сборку: собрать самому или взять готовую --- */
    const modeSeg = body.querySelector('#cr-mode');
    const customBox = body.querySelector('#cr-custom');
    const packsBox = body.querySelector('#cr-packs');
    let mode = 'custom';
    let pack = null;          // выбранная готовая сборка
    let packVersions = [];    // её версии

    function applyMode() {
      for (const btn of modeSeg.querySelectorAll('button')) {
        btn.classList.toggle('active', btn.dataset.m === mode);
      }
      customBox.hidden = mode !== 'custom';
      packsBox.hidden = mode !== 'pack';
      if (mode === 'pack' && !packsBox.dataset.ready) buildPacks();
    }
    for (const btn of modeSeg.querySelectorAll('button')) {
      btn.addEventListener('click', () => { mode = btn.dataset.m; applyMode(); });
    }
    applyMode();

    let packSource = 'modrinth';
    let packToken = 0;

    function buildPacks() {
      packsBox.dataset.ready = '1';
      packsBox.innerHTML =
        '<div class="picker-head" style="margin-bottom:10px">' +
          '<label>Сборки, собранные игроками</label>' +
          '<div class="picker-tools">' +
            '<div class="search-wrap"><input class="input" id="pk-q" placeholder="Поиск сборки"></div>' +
            '<div class="seg" id="pk-src">' +
              '<button data-s="modrinth" class="active">Modrinth</button>' +
              '<button data-s="curseforge">CurseForge</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="pack-list" id="pk-list"></div>' +
        '<div class="field" id="pk-ver-wrap" hidden style="margin-top:12px">' +
          '<label>Версия сборки</label><select class="select" id="pk-ver"></select>' +
          '<span class="hint" id="pk-ver-hint"></span>' +
        '</div>';

      const qInput = packsBox.querySelector('#pk-q');
      let t = null;
      qInput.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => searchPacks(qInput.value), 400);
      });
      for (const btn of packsBox.querySelectorAll('#pk-src button')) {
        btn.addEventListener('click', () => {
          packSource = btn.dataset.s;
          for (const b of packsBox.querySelectorAll('#pk-src button')) {
            b.classList.toggle('active', b.dataset.s === packSource);
          }
          searchPacks(qInput.value);
        });
      }
      searchPacks('');
    }

    async function searchPacks(query) {
      const host = packsBox.querySelector('#pk-list');
      const token = ++packToken;
      host.innerHTML = '<div class="skeleton" style="height:62px"></div>';
      try {
        const data = await window.api.mods.search({
          source: packSource, query, projectType: 'modpack', limit: 20, sort: query ? 'relevance' : 'downloads',
        });
        if (token !== packToken) return;
        paintPacks(data.items || []);
      } catch (e) {
        if (token !== packToken) return;
        host.innerHTML = '';
        host.appendChild(el('<div class="net-note err">' + esc(e.message) + '</div>'));
      }
    }

    function paintPacks(items) {
      const host = packsBox.querySelector('#pk-list');
      host.innerHTML = '';
      if (!items.length) {
        host.appendChild(el('<div class="version-empty">Ничего не найдено</div>'));
        return;
      }
      for (const item of items) {
        // Свежие версии игры показываем прямо в строке — по ним и выбирают сборку
        const versions = (item.gameVersions || []).slice(-3).reverse();
        const row = el(
          '<button class="pack-row' + (pack && pack.id === item.id ? ' selected' : '') + '">' +
            '<div class="mod-icon">' +
              (item.icon ? '<img loading="lazy" src="' + esc(item.icon) + '" alt="">'
                         : esc(String(item.name || '?').slice(0, 2).toUpperCase())) +
            '</div>' +
            '<div class="mod-main">' +
              '<div class="mod-title"><b>' + esc(item.name) + '</b>' +
                '<span class="src-badge ' + esc(item.source) + '">' +
                  (item.source === 'modrinth' ? 'Modrinth' : 'CurseForge') + '</span>' +
                versions.map((v) => '<span class="chip">' + esc(v) + '</span>').join('') +
              '</div>' +
              '<div class="mod-desc">' + esc(item.summary) + '</div>' +
              '<div class="mod-meta"><span>' + I.download + formatCount(item.downloads) + '</span>' +
                '<span>' + I.user + esc(item.author) + '</span></div>' +
            '</div>' +
          '</button>'
        );
        const img = row.querySelector('img');
        if (img) img.addEventListener('error', () => { img.parentElement.textContent = String(item.name || '?').slice(0, 2).toUpperCase(); });
        row.addEventListener('click', () => choosePack(item));
        host.appendChild(row);
      }
    }

    async function choosePack(item) {
      pack = item;
      for (const row of packsBox.querySelectorAll('.pack-row')) row.classList.remove('selected');
      const rows = [...packsBox.querySelectorAll('.pack-row')];
      const idx = [...packsBox.querySelectorAll('.pack-row .mod-title b')].findIndex((b) => b.textContent === item.name);
      if (idx >= 0 && rows[idx]) rows[idx].classList.add('selected');

      if (!nameInput.value.trim()) nameInput.value = item.name.slice(0, 48);

      const wrap = packsBox.querySelector('#pk-ver-wrap');
      const sel = packsBox.querySelector('#pk-ver');
      const hint = packsBox.querySelector('#pk-ver-hint');
      wrap.hidden = false;
      sel.innerHTML = '<option>Загрузка версий…</option>';
      sel.disabled = true;
      hint.textContent = '';

      try {
        packVersions = await window.api.mods.versions({ source: item.source, projectId: item.id });
        if (!packVersions.length) {
          sel.innerHTML = '<option value="">Нет файлов для скачивания</option>';
          hint.textContent = 'У этой сборки нет доступных файлов';
          return;
        }
        sel.innerHTML = packVersions.slice(0, 50).map((v, i) =>
          '<option value="' + i + '">' + esc(v.versionNumber || v.name) +
          ' · Minecraft ' + esc((v.gameVersions || []).join(', ') || '—') +
          ' · ' + esc(v.channel) + '</option>'
        ).join('');
        const best = packVersions.findIndex((v) => v.channel === 'release');
        sel.value = String(best >= 0 ? best : 0);
        sel.disabled = false;
        hint.textContent = 'Версия Minecraft и загрузчик возьмутся из самой сборки — выбирать их не нужно.';
      } catch (e) {
        sel.innerHTML = '<option value="">Ошибка</option>';
        hint.textContent = e.message;
      }
    }

    // Выбранная версия живёт здесь, а не в DOM — так проще переключать вид без потери выбора
    const versionSel = { value: state.latest.release || (state.versions[0] || {}).id || '' };
    let viewMode = state.settings.versionView === 'cards' ? 'cards' : 'list';

    viewSeg.querySelector('[data-v="list"]').innerHTML = I.rows;
    viewSeg.querySelector('[data-v="cards"]').innerHTML = I.grid;
    for (const btn of viewSeg.querySelectorAll('button')) {
      btn.addEventListener('click', () => {
        viewMode = btn.dataset.v;
        saveSettings({ versionView: viewMode });
        fillVersions();
      });
    }

    const TYPE_LABEL = { release: 'релиз', snapshot: 'снапшот', old_beta: 'beta', old_alpha: 'alpha' };
    const MAX_RENDERED = 220;

    function matchesType(v) {
      const kind = typeSel.value;
      if (kind === 'all') return true;
      if (kind === 'release') return v.type === 'release';
      if (kind === 'snapshot') return v.type === 'snapshot';
      return v.type === 'old_beta' || v.type === 'old_alpha';
    }

    function fillVersions() {
      const query = searchInput.value.trim().toLowerCase();
      const all = state.versions.filter((v) => matchesType(v) && (!query || v.id.toLowerCase().includes(query)));

      for (const btn of viewSeg.querySelectorAll('button')) {
        btn.classList.toggle('active', btn.dataset.v === viewMode);
      }

      if (!all.length) {
        versionBox.className = 'version-box';
        versionBox.innerHTML = '<div class="version-empty">Ничего не найдено</div>';
        versionHint.textContent = state.versions.length ? '' : 'Список версий ещё загружается…';
        return;
      }

      // Если текущий выбор отфильтровался — выбираем первую подходящую, чтобы поле не осталось пустым
      if (!all.some((v) => v.id === versionSel.value)) versionSel.value = all[0].id;

      const shown = all.slice(0, MAX_RENDERED);
      versionBox.className = 'version-box ' + (viewMode === 'cards' ? 'as-cards' : 'as-list');
      versionBox.innerHTML = '';

      for (const v of shown) {
        const isLatest = v.id === state.latest.release;
        const tag = isLatest ? 'последняя' : (TYPE_LABEL[v.type] || v.type);
        const node = el(
          viewMode === 'cards'
            ? '<button class="ver-card' + (v.id === versionSel.value ? ' selected' : '') + '">' +
                '<span class="ver-id">' + esc(v.id) + '</span>' +
                '<span class="ver-tag t-' + esc(v.type) + '">' + esc(tag) + '</span>' +
                '<span class="ver-date">' + esc(shortDate(v.releaseTime)) + '</span>' +
                (v.installed ? '<span class="ver-installed">установлена</span>' : '') +
              '</button>'
            : '<button class="ver-row' + (v.id === versionSel.value ? ' selected' : '') + '">' +
                '<span class="ver-dot t-' + esc(v.type) + '"></span>' +
                '<span class="ver-id">' + esc(v.id) + '</span>' +
                '<span class="ver-tag t-' + esc(v.type) + '">' + esc(tag) + '</span>' +
                (v.installed ? '<span class="ver-installed">установлена</span>' : '') +
                '<span class="ver-date">' + esc(shortDate(v.releaseTime)) + '</span>' +
              '</button>'
        );
        node.addEventListener('click', () => {
          versionSel.value = v.id;
          fillVersions();
          fillLoaderVersions();
        });
        versionBox.appendChild(node);
      }

      const selected = versionBox.querySelector('.selected');
      if (selected) selected.scrollIntoView({ block: 'nearest' });

      versionHint.textContent = 'Выбрана ' + versionSel.value + ' · найдено версий: ' + all.length +
        (all.length > shown.length ? ' (показаны первые ' + shown.length + ', уточните поиск)' : '');
    }

    let loaderToken = 0;
    async function fillLoaderVersions() {
      const loader = loaderSel.value;
      const mcVersion = versionSel.value;
      if (loader === 'vanilla' || !mcVersion) {
        loaderWrap.hidden = true;
        return;
      }
      loaderWrap.hidden = false;
      const token = ++loaderToken;
      loaderSel2.innerHTML = '<option>Загрузка списка…</option>';
      loaderSel2.disabled = true;
      loaderHint.textContent = 'Запрашиваем версии ' + loader + '…';

      try {
        const list = await window.api.versions.loader(loader, mcVersion);
        if (token !== loaderToken) return;
        if (!list.length) {
          loaderSel2.innerHTML = '<option value="">Нет версий</option>';
          loaderHint.textContent = loader + ' пока не поддерживает Minecraft ' + mcVersion + '.';
          return;
        }
        loaderSel2.innerHTML = list.slice(0, 60).map((entry) => {
          const value = entry.version;
          const tags = [];
          if (entry.recommended) tags.push('рекомендуемая');
          if (entry.latest) tags.push('последняя');
          if (entry.stable) tags.push('стабильная');
          if (entry.beta) tags.push('beta');
          return '<option value="' + esc(value) + '">' + esc(value) +
            (tags.length ? ' — ' + esc(tags.join(', ')) : '') + '</option>';
        }).join('');
        const preferred = list.find((e) => e.recommended) || list.find((e) => e.stable) || list[0];
        if (preferred) loaderSel2.value = preferred.version;
        loaderSel2.disabled = false;
        loaderHint.textContent = 'Доступно версий: ' + list.length + '. По умолчанию выбрана оптимальная.';
      } catch (e) {
        if (token !== loaderToken) return;
        loaderSel2.innerHTML = '<option value="">Ошибка загрузки</option>';
        loaderHint.textContent = e.message;
      }
    }

    fillVersions();
    let searchTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(fillVersions, 180);
    });
    typeSel.addEventListener('change', () => { fillVersions(); fillLoaderVersions(); });
    loaderSel.addEventListener('change', fillLoaderVersions);

    // Список версий грузится в фоне — если он подъедет позже, перерисуем выбор
    if (!state.versions.length) {
      loadVersions().then(() => {
        if (!versionSel.value) versionSel.value = state.latest.release || '';
        fillVersions();
      });
    }

    const choice = await modal({
      title: 'Новая сборка',
      subtitle: 'Файлы игры и загрузчик скачаются автоматически',
      body,
      wide: true,
      buttons: [
        { label: 'Отмена', value: null },
        { label: 'Создать', kind: 'primary', value: 'create' },
      ],
    });
    if (choice !== 'create') return;

    if (mode === 'pack') {
      if (!pack) { toastErr('Сборка не выбрана', 'Выберите одну из списка'); return; }
      const sel = packsBox.querySelector('#pk-ver');
      const version = packVersions[Number(sel && sel.value)];
      if (!version) { toastErr('Версия сборки не выбрана', 'У этой сборки нет доступного файла'); return; }

      setStatus('Установка сборки ' + pack.name + '…', 0, 'busy');
      await guard('Не удалось установить сборку', async () => {
        const result = await window.api.modpacks.install(pack.source, version, nameInput.value.trim() || pack.name);
        await loadInstances();
        render();
        setStatus('Готов к работе', 0, '');
        toastOk('Сборка установлена',
          result.instance.name + ' — Minecraft ' + result.mcVersion + ', модов: ' + result.modCount);
      });
      return;
    }

    const payload = {
      name: nameInput.value.trim(),
      mcVersion: versionSel.value,
      loader: loaderSel.value,
      loaderVersion: loaderSel.value === 'vanilla' ? null : (loaderSel2.value || null),
    };
    if (!payload.mcVersion) { toastErr('Выберите версию', 'Список версий пуст — проверьте интернет'); return; }
    if (payload.loader !== 'vanilla' && !payload.loaderVersion) {
      toastErr('Версия загрузчика не выбрана', 'Для ' + payload.loader + ' нет доступных версий под ' + payload.mcVersion);
      return;
    }

    setStatus('Создание сборки…', 0, 'busy');
    await guard('Не удалось создать сборку', async () => {
      const inst = await window.api.instances.create(payload);
      await loadInstances();
      render();
      setStatus('Готов к работе', 0, '');
      toastOk('Сборка создана', inst.name + ' готова к запуску');
    });
  }

  /* ============================= Запуск ============================= */

  async function launchGame(id) {
    if (!activeAccount()) {
      toastErr('Нужен аккаунт', 'Добавьте аккаунт на вкладке «Аккаунты»');
      go('accounts');
      return;
    }
    state.busy.add(id);
    render();
    setStatus('Подготовка к запуску…', 0, 'busy');

    try {
      await window.api.game.launch(id);
    } catch (e) {
      toastErr('Не удалось запустить', e.message);
      setStatus('Ошибка запуска', 0, '');
    } finally {
      state.busy.delete(id);
      render();
    }
  }

  async function stopGame(id) {
    await guard('Не удалось остановить', async () => {
      await window.api.game.stop(id);
      toast('Останавливаем игру', 'Процесс Minecraft закрывается');
    });
  }

  /* ============================== Моды ============================== */

  function renderMods(body, actions) {
    // Модпаки не ставятся внутрь существующей сборки — они создают новую,
    // поэтому для них ни выбранная сборка, ни её наличие не нужны
    const isModpack = state.modsQuery.type === 'modpack';

    if (!isModpack && !state.instances.length) {
      const empty = el(
        '<div class="empty">' + I.package +
          '<h3>Сначала создайте сборку</h3>' +
          '<p>Моды устанавливаются в конкретную сборку — так они не конфликтуют между собой. ' +
          'Либо поставьте готовую сборку целиком: версия, загрузчик и моды приедут одним пакетом.</p>' +
        '</div>'
      );
      empty.appendChild(button('Смотреть готовые сборки', I.package, 'primary sm', () => {
        state.modsQuery.type = 'modpack';
        state.modsResults = null;
        render();
      }));
      body.appendChild(empty);
      return;
    }

    if (state.instances.length &&
        (!state.modsQuery.instanceId || !state.instances.some((i) => i.id === state.modsQuery.instanceId))) {
      state.modsQuery.instanceId = state.instances[0].id;
    }
    const inst = state.instances.find((i) => i.id === state.modsQuery.instanceId) || null;

    if (inst) {
      actions.appendChild(button('Установленные', I.inbox, 'ghost sm', () => openInstalledMods(inst)));
    }

    const toolbar = el('<div class="mods-toolbar"></div>');

    if (!isModpack && inst) {
      const instSel = el('<select class="select" style="width:220px"></select>');
      instSel.innerHTML = state.instances
        .map((i) => '<option value="' + esc(i.id) + '">' + esc(i.name) + ' · ' + esc(i.mcVersion) + '</option>')
        .join('');
      instSel.value = inst.id;
      instSel.addEventListener('change', () => {
        state.modsQuery.instanceId = instSel.value;
        state.modsResults = null;
        render(); // render сам запустит поиск, увидев сброшенный результат
      });
      toolbar.appendChild(instSel);
    }

    const search = el(
      '<div class="search-wrap">' + I.search +
        '<input class="input" placeholder="Поиск модов: Sodium, JEI, Create…" value="' + esc(state.modsQuery.text) + '">' +
      '</div>'
    );
    const searchInput = search.querySelector('input');
    let debounce = null;
    searchInput.addEventListener('input', () => {
      state.modsQuery.text = searchInput.value;
      clearTimeout(debounce);
      debounce = setTimeout(searchMods, 420);
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { clearTimeout(debounce); searchMods(); }
    });
    toolbar.appendChild(search);

    const sourceSeg = el(
      '<div class="seg">' +
        '<button data-src="modrinth">Modrinth</button>' +
        '<button data-src="curseforge">CurseForge</button>' +
      '</div>'
    );
    for (const btn of sourceSeg.querySelectorAll('button')) {
      btn.classList.toggle('active', btn.dataset.src === state.modsQuery.source);
      btn.addEventListener('click', () => {
        state.modsQuery.source = btn.dataset.src;
        state.modsResults = null;
        render();
      });
    }
    toolbar.appendChild(sourceSeg);

    const typeSel = el(
      '<select class="select" style="width:160px">' +
        '<option value="mod">Моды</option>' +
        '<option value="resourcepack">Ресурспаки</option>' +
        '<option value="shader">Шейдеры</option>' +
      '</select>'
    );
    typeSel.value = state.modsQuery.type;
    typeSel.addEventListener('change', () => {
      state.modsQuery.type = typeSel.value;
      state.modsResults = null;
      render();
    });
    toolbar.appendChild(typeSel);

    const sortSel = el(
      '<select class="select" style="width:150px">' +
        '<option value="relevance">По релевантности</option>' +
        '<option value="downloads">По загрузкам</option>' +
        '<option value="updated">По обновлению</option>' +
      '</select>'
    );
    sortSel.value = state.modsQuery.sort;
    sortSel.addEventListener('change', () => {
      state.modsQuery.sort = sortSel.value;
      searchMods();
    });
    toolbar.appendChild(sortSel);

    body.appendChild(toolbar);

    body.appendChild(el(
      isModpack
        ? '<div class="muted" style="margin-bottom:14px;font-size:12.5px">' +
          'Готовая сборка ставится целиком: лаунчер сам поставит нужную версию Minecraft, ' +
          'загрузчик и все моды — <b style="color:var(--text)">новой отдельной сборкой</b>.</div>'
        : '<div class="muted" style="margin-bottom:14px;font-size:12.5px">Установка в сборку: <b style="color:var(--text)">' +
          esc(inst.name) + '</b> — Minecraft ' + esc(inst.mcVersion) +
          (inst.loader !== 'vanilla' ? ' · ' + esc(inst.loaderLabel || inst.loader) : '') + '</div>'
    ));

    const results = el('<div class="mod-list" id="mod-results"></div>');
    body.appendChild(results);
    paintModResults(results, inst);

    if (state.modsResults === null && !state.modsLoading) searchMods();
  }

  let searchToken = 0;

  async function searchMods() {
    const isModpack = state.modsQuery.type === 'modpack';
    const inst = state.instances.find((i) => i.id === state.modsQuery.instanceId) || null;
    if (!isModpack && !inst) return;
    // Ответ устаревшего запроса не должен перетирать актуальный результат
    const token = ++searchToken;
    state.modsLoading = true;
    const host = $('#mod-results');
    if (host) {
      host.innerHTML = '<div class="skeleton"></div><div class="skeleton" style="margin-top:10px"></div><div class="skeleton" style="margin-top:10px"></div>';
    }
    try {
      const data = await window.api.mods.search({
        source: state.modsQuery.source,
        query: state.modsQuery.text,
        gameVersion: isModpack ? null : inst.mcVersion,
        loader: isModpack ? null : inst.loader,
        projectType: state.modsQuery.type,
        sort: state.modsQuery.sort,
        limit: 30,
      });
      if (token !== searchToken) return;
      state.modsResults = data;
    } catch (e) {
      if (token !== searchToken) return;
      state.modsResults = { items: [], total: 0, error: e.message };
    } finally {
      if (token === searchToken) {
        state.modsLoading = false;
        const target = $('#mod-results');
        if (target) paintModResults(target, inst);
      }
    }
  }

  function paintModResults(host, inst) {
    const data = state.modsResults;
    host.innerHTML = '';
    if (!data) return;

    if (data.error) {
      const isKey = /API-ключ/.test(data.error);
      const empty = el(
        '<div class="empty">' + I.shield +
          '<h3>' + (isKey ? 'Нужен ключ CurseForge' : 'Не удалось загрузить каталог') + '</h3>' +
          '<p>' + esc(data.error) + '</p>' +
        '</div>'
      );
      if (isKey) empty.appendChild(button('Открыть настройки', I.settings, 'primary', () => go('settings')));
      host.appendChild(empty);
      return;
    }

    if (!data.items.length) {
      host.appendChild(el(
        '<div class="empty">' + I.search +
          '<h3>Ничего не найдено</h3>' +
          '<p>' + (inst
            ? 'Попробуйте другой запрос или проверьте, поддерживает ли он Minecraft ' +
              esc(inst.mcVersion) + ' с загрузчиком ' + esc(inst.loaderLabel || inst.loader) + '.'
            : 'Попробуйте изменить запрос.') + '</p>' +
        '</div>'
      ));
      return;
    }

    for (const item of data.items) host.appendChild(modCard(item, inst));
  }

  function modCard(item, inst) {
    const initials = esc(String(item.name || '?').slice(0, 2).toUpperCase());
    const card = el(
      '<div class="mod-card">' +
        '<div class="mod-icon">' + (item.icon ? '<img loading="lazy" src="' + esc(item.icon) + '" alt="">' : initials) + '</div>' +
        '<div class="mod-main">' +
          '<div class="mod-title">' +
            '<b>' + esc(item.name) + '</b>' +
            '<span class="src-badge ' + esc(item.source) + '">' + (item.source === 'modrinth' ? 'Modrinth' : 'CurseForge') + '</span>' +
          '</div>' +
          '<div class="mod-desc">' + esc(item.summary) + '</div>' +
          '<div class="mod-meta">' +
            '<span>' + I.download + formatCount(item.downloads) + ' загрузок</span>' +
            '<span>' + I.user + esc(item.author) + '</span>' +
            (item.updated ? '<span>' + I.clock + esc(formatDate(item.updated)) + '</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="mod-actions"></div>' +
      '</div>'
    );

    const img = card.querySelector('img');
    if (img) img.addEventListener('error', () => { img.parentElement.textContent = String(item.name || '?').slice(0, 2).toUpperCase(); });

    const actions = card.querySelector('.mod-actions');
    const installBtn = button(state.modsQuery.type === 'modpack' ? 'Установить сборку' : 'Установить',
      I.download, 'primary sm', () => openVersionPicker(item, inst, installBtn));
    actions.appendChild(installBtn);
    if (item.link) {
      actions.appendChild(button('Страница', I.external, 'ghost sm', () => window.api.app.openExternal(item.link)));
    }
    return card;
  }

  async function openVersionPicker(item, inst, sourceBtn) {
    const isModpack = state.modsQuery.type === 'modpack';
    if (sourceBtn) { sourceBtn.disabled = true; sourceBtn.textContent = 'Загрузка…'; }
    let list;
    try {
      list = await window.api.mods.versions({
        source: item.source,
        projectId: item.id,
        // У готовой сборки своя версия игры и свой загрузчик — фильтровать по текущей нельзя
        gameVersion: isModpack ? null : inst.mcVersion,
        loader: state.modsQuery.type === 'mod' ? inst.loader : null,
      });
    } catch (e) {
      toastErr('Не удалось получить версии', e.message);
      return;
    } finally {
      if (sourceBtn) {
        sourceBtn.disabled = false;
        sourceBtn.innerHTML = I.download + (isModpack ? 'Установить сборку' : 'Установить');
      }
    }

    if (!list.length) {
      toastErr('Нет подходящих версий', isModpack
        ? 'У «' + item.name + '» нет доступных для скачивания файлов'
        : item.name + ' не поддерживает Minecraft ' + inst.mcVersion +
          (state.modsQuery.type === 'mod' ? ' с ' + (inst.loaderLabel || inst.loader) : ''));
      return;
    }

    if (isModpack) return installModpack(item, list);

    const body = el('<div class="stack"></div>');
    const sel = el('<select class="select"></select>');
    sel.innerHTML = list.slice(0, 50).map((v, i) =>
      '<option value="' + i + '">' + esc(v.versionNumber || v.name) + ' — ' + esc(v.channel) +
      ' · ' + esc(formatDate(v.published)) + '</option>'
    ).join('');
    const best = list.findIndex((v) => v.channel === 'release');
    sel.value = String(best >= 0 ? best : 0);

    body.appendChild(el('<div class="field"><label>Версия файла</label></div>')).appendChild(sel);
    const depsSwitch = el(
      '<label class="switch"><input type="checkbox" checked><span class="track"></span>' +
      '<span class="hint" style="color:var(--text-dim)">Установить обязательные зависимости</span></label>'
    );
    body.appendChild(depsSwitch);

    const blocked = list[Number(sel.value)] && list[Number(sel.value)].file.blocked;
    if (blocked) {
      body.appendChild(el('<div class="hint" style="color:var(--warn)">Автор запретил стороннее скачивание — файл будет загружен по прямой ссылке CDN, это может не сработать.</div>'));
    }

    const choice = await modal({
      title: item.name,
      subtitle: 'Установка в сборку «' + inst.name + '»',
      body,
      buttons: [
        { label: 'Отмена', value: null },
        { label: 'Установить', kind: 'primary', value: 'install' },
      ],
    });
    if (choice !== 'install') return;

    const version = list[Number(sel.value)];
    setStatus('Установка ' + item.name + '…', 0, 'busy');
    await guard('Не удалось установить мод', async () => {
      const files = await window.api.mods.install(inst.id, version, state.modsQuery.type);
      await loadInstances();
      setStatus('Готов к работе', 0, '');
      const deps = files.filter((f) => f.dependency).length;
      toastOk('Установлено: ' + item.name, deps ? 'Вместе с зависимостями (' + deps + ')' : 'Файл добавлен в сборку');
    });
  }

  /** Готовая сборка ставится целиком и создаёт отдельную сборку в библиотеке. */
  async function installModpack(item, list) {
    const body = el('<div class="stack"></div>');

    const sel = el('<select class="select"></select>');
    sel.innerHTML = list.slice(0, 50).map((v, i) =>
      '<option value="' + i + '">' + esc(v.versionNumber || v.name) + ' — ' + esc(v.channel) +
      ' · ' + esc(formatDate(v.published)) + '</option>'
    ).join('');
    const best = list.findIndex((v) => v.channel === 'release');
    sel.value = String(best >= 0 ? best : 0);

    const verField = el('<div class="field"><label>Версия сборки</label></div>');
    verField.appendChild(sel);
    body.appendChild(verField);

    const nameField = el(
      '<div class="field"><label>Название в библиотеке</label>' +
        '<input class="input" value="' + esc(item.name) + '" maxlength="48">' +
        '<span class="hint">Будет создана новая сборка — существующие не затрагиваются.</span>' +
      '</div>'
    );
    body.appendChild(nameField);

    const info = el('<div class="hint" data-role="info"></div>');
    const paintInfo = () => {
      const v = list[Number(sel.value)];
      const versions = (v.gameVersions || []).slice(0, 4).join(', ');
      info.textContent = versions ? 'Minecraft: ' + versions : '';
    };
    sel.addEventListener('change', paintInfo);
    paintInfo();
    body.appendChild(info);

    if (item.source === 'curseforge') {
      body.appendChild(el(
        '<div class="hint" style="color:var(--warn)">Для сборок CurseForge нужен API-ключ ' +
        '(Настройки → Интеграции). Часть модов авторы запрещают скачивать сторонним лаунчерам — ' +
        'такие файлы могут не установиться.</div>'
      ));
    }

    const choice = await modal({
      title: item.name,
      subtitle: 'Установка готовой сборки',
      body,
      buttons: [
        { label: 'Отмена', value: null },
        { label: 'Установить сборку', kind: 'primary', value: 'install' },
      ],
    });
    if (choice !== 'install') return;

    const version = list[Number(sel.value)];
    const name = nameField.querySelector('input').value.trim() || item.name;

    setStatus('Установка сборки ' + item.name + '…', 0, 'busy');
    await guard('Не удалось установить сборку', async () => {
      const result = await window.api.modpacks.install(item.source, version, name);
      await loadInstances();
      setStatus('Готов к работе', 0, '');
      toastOk('Сборка установлена', result.instance.name + ' — Minecraft ' + result.mcVersion +
        ', модов: ' + result.modCount);
      go('library');
    });
  }

  async function openInstalledMods(inst) {
    let files = [];
    try {
      files = await window.api.mods.installed(inst.id);
    } catch (e) {
      toastErr('Не удалось прочитать список', e.message);
      return;
    }

    const body = el('<div class="stack"></div>');
    if (!files.length) {
      body.appendChild(el('<div class="empty" style="padding:34px">' + I.inbox +
        '<h3>В сборке нет модов</h3><p>Найдите их в каталоге и нажмите «Установить».</p></div>'));
    } else {
      const list = el('<div class="stack" style="gap:8px"></div>');
      for (const file of files) list.appendChild(installedRow(file, inst, list));
      body.appendChild(list);
    }

    body.appendChild(button('Открыть папку mods', I.folder, '', () => window.api.instances.openFolder(inst.id, 'mods')));

    await modal({
      title: 'Установленные файлы',
      subtitle: inst.name + ' · найдено: ' + files.length,
      body,
      wide: true,
      buttons: [{ label: 'Закрыть', value: null }],
    });
  }

  function installedRow(file, inst, listHost) {
    const row = el(
      '<div class="file-row' + (file.enabled ? '' : ' off') + '">' +
        '<div class="fname">' + esc(file.name || file.filename) +
          (file.dependency ? ' <span class="chip" style="margin-left:6px">зависимость</span>' : '') +
        '</div>' +
        '<div class="fsize">' + esc(formatSize(file.size)) + '</div>' +
      '</div>'
    );

    const toggle = el(
      '<label class="switch"><input type="checkbox"' + (file.enabled ? ' checked' : '') + '><span class="track"></span></label>'
    );
    const checkbox = toggle.querySelector('input');
    checkbox.addEventListener('change', async () => {
      try {
        const next = await window.api.mods.toggle(file.path, checkbox.checked);
        file.path = next;
        file.enabled = checkbox.checked;
        row.classList.toggle('off', !checkbox.checked);
      } catch (e) {
        checkbox.checked = !checkbox.checked;
        toastErr('Не удалось переключить', e.message);
      }
    });
    row.appendChild(toggle);

    row.appendChild(iconButton(I.trash, 'Удалить файл', async () => {
      const yes = await confirm('Удалить файл?', file.filename, true);
      if (!yes) return;
      try {
        await window.api.mods.remove(file.path);
        row.remove();
        await loadInstances();
        if (!listHost.children.length) {
          listHost.appendChild(el('<div class="muted center">Все файлы удалены</div>'));
        }
      } catch (e) {
        toastErr('Не удалось удалить', e.message);
      }
    }));

    return row;
  }

  /* ============================ Аккаунты ============================ */

  function renderAccounts(body, actions) {
    actions.appendChild(button('Офлайн-аккаунт', I.user, 'ghost', openOfflineModal));
    actions.appendChild(button('Войти через Microsoft', I.shield, 'primary', openMicrosoftLogin));

    if (!state.accounts.list.length) {
      body.appendChild(el(
        '<div class="empty">' + I.user +
          '<h3>Аккаунтов пока нет</h3>' +
          '<p>Войдите через Microsoft, чтобы играть на лицензии и заходить на серверы. Офлайн-аккаунт подойдёт для одиночной игры и локальных серверов.</p>' +
        '</div>'
      ));
      return;
    }

    const list = el('<div class="stack" style="gap:10px"></div>');
    for (const acc of state.accounts.list) {
      const isActive = acc.id === state.accounts.activeId;
      const row = el(
        '<div class="acc-row' + (isActive ? ' active' : '') + '">' +
          '<div class="avatar">' + (acc.skinUrl ? '<img src="' + esc(acc.skinUrl) + '" alt="">' : esc(acc.name.slice(0, 1).toUpperCase())) + '</div>' +
          '<div class="grow" style="min-width:0">' +
            '<b style="font-size:14px">' + esc(acc.name) + '</b>' +
            '<div class="muted" style="font-size:12px">' +
              (acc.type === 'microsoft' ? 'Microsoft · лицензия' : 'Офлайн-профиль') +
              ' · добавлен ' + esc(formatDate(acc.addedAt)) +
            '</div>' +
          '</div>' +
        '</div>'
      );
      const ctl = el('<div class="row-ctl"></div>');
      if (isActive) ctl.appendChild(el('<span class="chip" style="color:var(--ok);border-color:rgba(52,211,153,.35)">активный</span>'));
      else ctl.appendChild(button('Выбрать', I.check, 'sm', async () => {
        await guard('Не удалось выбрать', async () => {
          await window.api.accounts.setActive(acc.id);
          await loadAccounts();
          render();
        });
      }));
      ctl.appendChild(iconButton(I.trash, 'Удалить аккаунт', async () => {
        const yes = await confirm('Удалить аккаунт?', acc.name, true);
        if (!yes) return;
        await guard('Не удалось удалить', async () => {
          await window.api.accounts.remove(acc.id);
          await loadAccounts();
          render();
        });
      }));
      row.appendChild(ctl);
      list.appendChild(row);
    }
    body.appendChild(list);

    body.appendChild(el(
      '<div class="panel" style="margin-top:18px">' +
        '<h2>Как работает вход через Microsoft</h2>' +
        '<p class="panel-sub">Лаунчер использует официальный вход по коду устройства: пароль вводится только на сайте Microsoft и никогда не попадает в лаунчер.</p>' +
        '<div class="hint">Для работы нужен свой Azure Client ID — бесплатное приложение в Azure Portal с включённым «Allow public client flows». ' +
        'Укажите его в разделе «Настройки». Без него доступны офлайн-аккаунты.</div>' +
      '</div>'
    ));
  }

  async function openOfflineModal() {
    const body = el(
      '<div class="stack">' +
        '<div class="field"><label>Игровой ник</label>' +
          '<input class="input" id="off-name" placeholder="Steve" maxlength="16">' +
          '<span class="hint">3–16 символов: латиница, цифры и подчёркивание. UUID вычисляется так же, как на ванильном сервере в офлайн-режиме.</span>' +
        '</div>' +
      '</div>'
    );
    const choice = await modal({
      title: 'Офлайн-аккаунт',
      subtitle: 'Для одиночной игры и серверов с online-mode=false',
      body,
      buttons: [
        { label: 'Отмена', value: null },
        { label: 'Добавить', kind: 'primary', value: 'add' },
      ],
    });
    if (choice !== 'add') return;
    const name = body.querySelector('#off-name').value;
    await guard('Не удалось добавить аккаунт', async () => {
      await window.api.accounts.addOffline(name);
      await loadAccounts();
      render();
      toastOk('Аккаунт добавлен', name);
    });
  }

  async function openMicrosoftLogin() {
    if (!state.settings.azureClientId) {
      const goSettings = await modal({
        title: 'Нужен Azure Client ID',
        subtitle: 'Одноразовая настройка для входа через Microsoft',
        body:
          '<div class="stack">' +
            '<div class="hint">1. Откройте <b>portal.azure.com</b> → Azure Active Directory → App registrations → New registration.<br>' +
            '2. Тип аккаунтов: <b>Personal Microsoft accounts</b>.<br>' +
            '3. В разделе Authentication включите <b>Allow public client flows</b>.<br>' +
            '4. Скопируйте <b>Application (client) ID</b> и вставьте его в настройках лаунчера.</div>' +
          '</div>',
        buttons: [
          { label: 'Позже', value: null },
          { label: 'Открыть настройки', kind: 'primary', value: 'settings' },
        ],
      });
      if (goSettings === 'settings') go('settings');
      return;
    }

    let flow;
    try {
      flow = await window.api.accounts.msStart();
    } catch (e) {
      toastErr('Не удалось начать вход', e.message);
      return;
    }

    const body = el(
      '<div class="stack">' +
        '<div class="hint center">Откройте страницу входа Microsoft и введите этот код:</div>' +
        '<div class="device-code">' + esc(flow.userCode) + '</div>' +
        '<div class="center"><span class="muted" style="font-size:12.5px">Код действует ' +
          Math.round(flow.expiresIn / 60) + ' мин. Окно закроется само после входа.</span></div>' +
        '<div class="inline" style="justify-content:center" id="ms-actions"></div>' +
        '<div class="center" id="ms-status" style="color:var(--accent-2);font-size:12.5px">Ожидаем подтверждение…</div>' +
      '</div>'
    );

    const actionsHost = body.querySelector('#ms-actions');
    actionsHost.appendChild(button('Открыть страницу входа', I.external, 'primary', () => window.api.app.openExternal(flow.verificationUri)));
    actionsHost.appendChild(button('Копировать код', I.copy, '', async () => {
      try {
        await navigator.clipboard.writeText(flow.userCode);
        toastOk('Код скопирован');
      } catch {
        toastErr('Не удалось скопировать', 'Выделите код вручную');
      }
    }));

    let done = false;
    const off = window.api.events.onMsaDone(async (result) => {
      done = true;
      off();
      window.UI.closeModal();
      if (result.ok) {
        await loadAccounts();
        render();
        toastOk('Вход выполнен', 'Добро пожаловать, ' + result.account.name);
      } else {
        toastErr('Вход не удался', result.error);
      }
    });

    const closed = await modal({
      title: 'Вход через Microsoft',
      subtitle: flow.verificationUri,
      body,
      buttons: [{ label: 'Отменить вход', value: 'cancel' }],
    });
    if (!done) {
      off();
      if (closed === 'cancel' || closed === null) await window.api.accounts.msCancel();
    }
  }

  /* ========================== Игра по сети =========================== */

  function renderNetwork(body, actions) {
    const lan = state.lan;

    actions.appendChild(button('Добавить по адресу', I.plus, 'ghost sm', openManualServer));
    actions.appendChild(button('Добавить друга', I.users, 'primary sm', openAddFriend));

    body.appendChild(friendsPanel());

    /* --- Найденные миры --- */
    const found = el(
      '<div class="panel">' +
        '<h2>Миры в вашей сети</h2>' +
        '<p class="panel-sub">Когда друг открывает мир для сети, он появляется здесь сам — ' +
        'адрес вводить не нужно.</p>' +
        '<div data-role="worlds"></div>' +
      '</div>'
    );
    const worldsHost = found.querySelector('[data-role="worlds"]');

    if (!lan) {
      worldsHost.appendChild(el('<div class="skeleton" style="height:64px"></div>'));
    } else if (lan.error) {
      worldsHost.appendChild(el(
        '<div class="net-note err">' + esc(lan.error) +
        '<br><span class="muted">Обычно это значит, что порт 4445 занят другим лаунчером.</span></div>'
      ));
    } else if (!lan.worlds.length) {
      worldsHost.appendChild(el(
        '<div class="net-empty">' + I.network +
          '<b>Пока никто не открыл мир</b>' +
          '<span>Ждём широковещательные сообщения Minecraft в локальной сети…</span>' +
        '</div>'
      ));
    } else {
      const list = el('<div class="stack" style="gap:9px"></div>');
      for (const world of lan.worlds) list.appendChild(worldRow(world));
      worldsHost.appendChild(list);
    }
    body.appendChild(found);

    /* --- Как открыть свой мир --- */
    const share = el(
      '<div class="panel">' +
        '<h2>Открыть свой мир для друзей</h2>' +
        '<p class="panel-sub">Все должны быть в одной сети: домашний Wi-Fi, кабель или общий VPN.</p>' +
        '<ol class="net-steps">' +
          '<li>Запустите сборку и войдите в свой мир.</li>' +
          '<li>Нажмите <b>Esc</b> → <b>Открыть для сети</b> → <b>Открыть мир для сети</b>.</li>' +
          '<li>Игра покажет порт, а этот экран сразу увидит ваш мир — как и лаунчеры друзей.</li>' +
        '</ol>' +
        '<div data-role="addresses"></div>' +
      '</div>'
    );
    const addrHost = share.querySelector('[data-role="addresses"]');
    const addresses = (lan && lan.addresses) || [];
    if (addresses.length) {
      addrHost.appendChild(el('<div class="hint" style="margin-bottom:8px">Ваши адреса в сети — продиктуйте другу, если поиск не сработал:</div>'));
      const row = el('<div class="inline"></div>');
      for (const a of addresses) {
        const chip = el('<button class="chip net-chip" title="Скопировать">' + esc(a.address) + '<span class="muted"> · ' + esc(a.iface) + '</span></button>');
        chip.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(a.address);
            toastOk('Адрес скопирован', a.address);
          } catch {
            toastErr('Не удалось скопировать', 'Скопируйте вручную: ' + a.address);
          }
        });
        row.appendChild(chip);
      }
      addrHost.appendChild(row);
    } else {
      addrHost.appendChild(el('<div class="hint">Сетевые адреса не найдены — проверьте подключение к сети.</div>'));
    }
    body.appendChild(share);

    /* --- Серверы, добавленные в сборки --- */
    if (state.instances.length) {
      const saved = el(
        '<div class="panel">' +
          '<h2>Серверы в сборках</h2>' +
          '<p class="panel-sub">Эти адреса игра показывает во вкладке «Сетевая игра».</p>' +
          '<div data-role="list"></div>' +
        '</div>'
      );
      const host = saved.querySelector('[data-role="list"]');
      if (!state.lanServers) {
        host.appendChild(el('<div class="skeleton" style="height:48px"></div>'));
        loadLanServers().then(() => { if (state.view === 'network') render(); });
      } else if (!state.lanServers.length) {
        host.appendChild(el('<div class="hint">Пока ни одного сервера не добавлено.</div>'));
      } else {
        const list = el('<div class="stack" style="gap:8px"></div>');
        for (const entry of state.lanServers) {
          const row = el(
            '<div class="file-row">' +
              '<div class="fname"><b>' + esc(entry.name) + '</b>' +
                '<div class="muted" style="font-size:11.5px">' + esc(entry.ip) + ' · ' + esc(entry.instanceName) + '</div>' +
              '</div>' +
            '</div>'
          );
          row.appendChild(iconButton(I.trash, 'Убрать из сборки', async () => {
            await guard('Не удалось убрать сервер', async () => {
              await window.api.lan.removeServer(entry.instanceId, entry.ip);
              await loadLanServers();
              render();
            });
          }));
          list.appendChild(row);
        }
        host.appendChild(list);
      }
      body.appendChild(saved);
    }
  }

  /**
   * Друзья. Обменялись кодами один раз — дальше мир, открытый другом,
   * сам появляется в списке серверов у всех, кто добавил его в друзья.
   */
  function friendsPanel() {
    const data = state.friends;

    const panel = el(
      '<div class="panel">' +
        '<h2>Друзья</h2>' +
        '<p class="panel-sub">Обменяйтесь кодами — и мир, открытый другом для сети, ' +
        'сам появится у вас в списке серверов Minecraft.</p>' +
        '<div data-role="me"></div>' +
        '<div data-role="list" style="margin-top:14px"></div>' +
      '</div>'
    );

    /* --- Свой код --- */
    const me = panel.querySelector('[data-role="me"]');
    const myCode = (data && data.code) || '—';
    const codeRow = el(
      '<div class="friend-me">' +
        '<div><span class="muted" style="font-size:12px">Ваш код — продиктуйте его друзьям</span>' +
          '<div class="friend-code">' + esc(myCode) + '</div></div>' +
      '</div>'
    );
    const codeCtl = el('<div class="row-ctl"></div>');
    codeCtl.appendChild(button('Скопировать', I.copy, 'sm', async () => {
      try {
        await navigator.clipboard.writeText(myCode);
        toastOk('Код скопирован', myCode);
      } catch {
        toastErr('Не удалось скопировать', myCode);
      }
    }));
    codeRow.appendChild(codeCtl);
    me.appendChild(codeRow);

    if (data && data.error) {
      me.appendChild(el('<div class="net-note err" style="margin-top:10px">' + esc(data.error) + '</div>'));
    }

    /* --- Список друзей --- */
    const host = panel.querySelector('[data-role="list"]');
    const friends = (data && data.friends) || [];

    if (!friends.length) {
      host.appendChild(el(
        '<div class="net-empty">' + I.users +
          '<b>Список друзей пуст</b>' +
          '<span>Возьмите код друга и добавьте его — этого достаточно.</span>' +
        '</div>'
      ));
      return panel;
    }

    const list = el('<div class="stack" style="gap:9px"></div>');
    for (const friend of friends) list.appendChild(friendRow(friend));
    host.appendChild(list);
    return panel;
  }

  function friendRow(friend) {
    const row = el(
      '<div class="friend-row' + (friend.online ? ' online' : '') + '">' +
        '<div class="avatar">' + esc(friend.nick.slice(0, 1).toUpperCase()) + '</div>' +
        '<div class="grow" style="min-width:0">' +
          '<b>' + esc(friend.nick) + '</b>' +
          '<div class="muted" style="font-size:11.5px">' +
            (friend.online && friend.world
              ? 'Мир открыт: ' + esc(friend.world.motd) + ' · ' + esc(friend.world.host)
              : esc(friend.code) + ' · мир не открыт') +
          '</div>' +
        '</div>' +
      '</div>'
    );

    const ctl = el('<div class="row-ctl"></div>');
    if (friend.online && friend.world) {
      ctl.appendChild(el('<span class="chip" style="color:var(--ok);border-color:rgba(52,211,153,.35)">в сборках</span>'));
      ctl.appendChild(button('Скопировать адрес', I.copy, 'sm', async () => {
        try {
          await navigator.clipboard.writeText(friend.world.host);
          toastOk('Адрес скопирован', friend.world.host);
        } catch {
          toastErr('Не удалось скопировать', friend.world.host);
        }
      }));
    }
    ctl.appendChild(iconButton(I.trash, 'Удалить из друзей', async () => {
      const yes = await confirm('Удалить друга?', friend.nick, true);
      if (!yes) return;
      await guard('Не удалось удалить', async () => {
        state.friends = await window.api.friends.remove(friend.code).then(() => window.api.friends.status());
        render();
      });
    }));
    row.appendChild(ctl);
    return row;
  }

  async function openAddFriend() {
    const body = el(
      '<div class="stack">' +
        '<div class="field"><label>Код друга</label>' +
          '<input class="input" id="fr-code" placeholder="KB-A1B2-C3D4" maxlength="13" style="text-transform:uppercase">' +
          '<span class="hint">Друг найдёт свой код на этом же экране, в разделе «Друзья».</span>' +
        '</div>' +
        '<div class="field"><label>Как подписать</label>' +
          '<input class="input" id="fr-nick" placeholder="Например: Вася" maxlength="24"></div>' +
        '<div class="hint">Оба должны добавить друг друга. Дальше достаточно открыть мир ' +
        'через «Открыть для сети» — адрес пропишется автоматически.</div>' +
      '</div>'
    );

    const choice = await modal({
      title: 'Добавить друга',
      subtitle: 'Ваш код: ' + ((state.friends && state.friends.code) || '—'),
      body,
      buttons: [
        { label: 'Отмена', value: null },
        { label: 'Добавить', kind: 'primary', value: 'add' },
      ],
    });
    if (choice !== 'add') return;

    const code = body.querySelector('#fr-code').value;
    const nick = body.querySelector('#fr-nick').value;
    await guard('Не удалось добавить друга', async () => {
      await window.api.friends.add(code, nick);
      state.friends = await window.api.friends.status();
      render();
      toastOk('Друг добавлен', nick || code);
    });
  }

  function worldRow(world) {
    const row = el(
      '<div class="net-world' + (world.own ? ' own' : '') + '">' +
        '<span class="net-dot"></span>' +
        '<div class="grow" style="min-width:0">' +
          '<b>' + esc(world.motd) + '</b>' +
          '<div class="muted" style="font-size:11.5px">' + esc(world.host) +
            (world.own ? ' · это ваш мир' : '') + '</div>' +
        '</div>' +
      '</div>'
    );
    const ctl = el('<div class="row-ctl"></div>');

    ctl.appendChild(button('Скопировать адрес', I.copy, 'sm', async () => {
      try {
        await navigator.clipboard.writeText(world.host);
        toastOk('Адрес скопирован', world.host);
      } catch {
        toastErr('Не удалось скопировать', world.host);
      }
    }));

    if (!world.own && state.instances.length) {
      ctl.appendChild(button('Добавить в сборку', I.plus, 'primary sm', () => addServerToInstance(world.motd, world.host)));
    }
    row.appendChild(ctl);
    return row;
  }

  /** Записывает адрес в servers.dat выбранной сборки — в игре он появится сам. */
  async function addServerToInstance(name, ip) {
    if (!state.instances.length) {
      toastErr('Нет сборок', 'Сначала создайте сборку, куда добавить сервер');
      return;
    }

    const body = el('<div class="stack"></div>');
    const instSel = el('<select class="select"></select>');
    instSel.innerHTML = state.instances
      .map((i) => '<option value="' + esc(i.id) + '">' + esc(i.name) + ' · ' + esc(i.mcVersion) + '</option>')
      .join('');
    const instField = el('<div class="field"><label>В какую сборку добавить</label></div>');
    instField.appendChild(instSel);
    body.appendChild(instField);

    const nameField = el(
      '<div class="field"><label>Название сервера</label>' +
        '<input class="input" value="' + esc(name || ip) + '" maxlength="48"></div>'
    );
    body.appendChild(nameField);

    const ipField = el(
      '<div class="field"><label>Адрес</label>' +
        '<input class="input" value="' + esc(ip) + '">' +
        '<span class="hint">Появится в игре во вкладке «Сетевая игра». Игру нужно перезапустить, если она открыта.</span>' +
      '</div>'
    );
    body.appendChild(ipField);

    const choice = await modal({
      title: 'Добавить сервер',
      subtitle: 'Адрес запишется в список серверов сборки',
      body,
      buttons: [
        { label: 'Отмена', value: null },
        { label: 'Добавить', kind: 'primary', value: 'add' },
      ],
    });
    if (choice !== 'add') return;

    await guard('Не удалось добавить сервер', async () => {
      const result = await window.api.lan.addServer(
        instSel.value,
        nameField.querySelector('input').value.trim(),
        ipField.querySelector('input').value.trim()
      );
      await loadLanServers();
      render();
      toastOk('Сервер добавлен', result.name + ' — ' + result.ip);
    });
  }

  function openManualServer() {
    return addServerToInstance('', '');
  }

  async function loadLanServers() {
    const all = [];
    for (const inst of state.instances) {
      try {
        const servers = await window.api.lan.servers(inst.id);
        for (const s of servers) all.push({ ...s, instanceId: inst.id, instanceName: inst.name });
      } catch {
        // сборка могла быть удалена прямо сейчас
      }
    }
    state.lanServers = all;
  }

  /* ============================== VPN =============================== */

  const FLAGS = {
    JP: '🇯🇵', KR: '🇰🇷', TH: '🇹🇭', RU: '🇷🇺', VN: '🇻🇳', US: '🇺🇸', GB: '🇬🇧', RO: '🇷🇴',
    DE: '🇩🇪', FR: '🇫🇷', CA: '🇨🇦', UA: '🇺🇦', KZ: '🇰🇿', PL: '🇵🇱', NL: '🇳🇱', CN: '🇨🇳',
    IN: '🇮🇳', BR: '🇧🇷', TR: '🇹🇷', ID: '🇮🇩', TW: '🇹🇼', SG: '🇸🇬', IT: '🇮🇹', ES: '🇪🇸',
  };

  const COUNTRY_RU = {
    Japan: 'Япония', 'Korea Republic of': 'Южная Корея', Thailand: 'Таиланд',
    'Russian Federation': 'Россия', 'Viet Nam': 'Вьетнам', 'United States': 'США',
    'United Kingdom': 'Великобритания', Romania: 'Румыния', Germany: 'Германия',
    France: 'Франция', Canada: 'Канада', Ukraine: 'Украина', Kazakhstan: 'Казахстан',
    Poland: 'Польша', Netherlands: 'Нидерланды', China: 'Китай', India: 'Индия',
    Brazil: 'Бразилия', Turkey: 'Турция', Indonesia: 'Индонезия', Taiwan: 'Тайвань',
    Singapore: 'Сингапур', Italy: 'Италия', Spain: 'Испания',
  };

  const countryName = (name) => COUNTRY_RU[name] || name;

  function renderVpn(body, actions) {
    actions.appendChild(button('Обновить список', I.refresh, 'ghost sm', async () => {
      setStatus('Обновляем список серверов…', null, 'busy');
      await guard('Не удалось обновить список', async () => {
        state.vpnCountries = await window.api.vpn.countries(true);
        setStatus('Готов к работе', 0, '');
        render();
      });
    }));
    actions.appendChild(button('Папка конфигов', I.folder, 'ghost sm', () => window.api.vpn.openFolder()));

    /* --- Состояние подключения --- */
    const st = state.vpn || {};
    const statusPanel = el(
      '<div class="panel">' +
        '<h2>' + (st.connected ? 'VPN подключён' : 'VPN отключён') + '</h2>' +
        '<p class="panel-sub">' +
          (st.connected && st.server
            ? esc(countryName(st.server.country) + ' · ' + st.server.ip)
            : 'Список серверов — открытый проект VPN Gate университета Цукубы. ' +
              'Серверы поднимают добровольцы, поэтому доступ бесплатный.') +
        '</p>' +
      '</div>'
    );

    const statusRow = el('<div class="row"><div class="row-info" data-role="info"></div></div>');
    const statusInfo = statusRow.querySelector('[data-role="info"]');
    const statusCtl = el('<div class="row-ctl"></div>');

    if (st.connected) {
      statusInfo.innerHTML = '<b>Соединение активно</b><span>Подключено ' +
        esc(formatDate(st.since)) + '</span>';
      statusCtl.appendChild(button('Отключить', I.power, 'danger sm', async () => {
        await guard('Не удалось отключить', async () => {
          await window.api.vpn.disconnect();
          state.vpn = await window.api.vpn.status();
          render();
        });
      }));
    } else if (!st.openvpn) {
      statusInfo.innerHTML = '<b>OpenVPN не установлен</b>' +
        '<span>Без него лаунчер может только подготовить файл настройки — подключение выполняет клиент OpenVPN</span>';
      statusCtl.appendChild(button('Скачать OpenVPN', I.external, 'sm',
        () => window.api.app.openExternal('https://openvpn.net/community-downloads/')));
    } else {
      statusInfo.innerHTML = '<b>Готов к подключению</b><span>OpenVPN найден: ' + esc(st.openvpn) + '</span>';
    }
    statusRow.appendChild(statusCtl);
    statusPanel.appendChild(statusRow);
    body.appendChild(statusPanel);

    body.appendChild(el(
      '<div class="net-note" style="margin-bottom:16px">Трафик пойдёт через сервер добровольца, ' +
      'который видит адреса ваших подключений. Для игры и обхода блокировок это нормально, ' +
      'для банка и почты пользоваться таким VPN не стоит.</div>'
    ));

    /* --- Страны --- */
    if (!state.vpnCountries) {
      body.appendChild(el('<div class="skeleton" style="height:90px"></div>'));
      loadVpnCountries().then(() => { if (state.view === 'vpn') render(); });
      return;
    }
    if (!state.vpnCountries.length) {
      body.appendChild(el(
        '<div class="empty">' + I.shield +
          '<h3>Список серверов недоступен</h3>' +
          '<p>Не удалось получить данные VPN Gate. Проверьте интернет и нажмите «Обновить список».</p>' +
        '</div>'
      ));
      return;
    }

    const panel = el(
      '<div class="panel"><h2>Страны</h2>' +
      '<p class="panel-sub">Всего серверов: ' +
      state.vpnCountries.reduce((n, c) => n + c.count, 0) + '. Выберите страну, чтобы увидеть список.</p>' +
      '<div class="vpn-grid" data-role="grid"></div></div>'
    );
    const grid = panel.querySelector('[data-role="grid"]');

    for (const c of state.vpnCountries) {
      const card = el(
        '<button class="vpn-country' + (state.vpnCountry === c.code ? ' active' : '') + '">' +
          '<span class="vpn-flag">' + (FLAGS[c.code] || '🌐') + '</span>' +
          '<span class="vpn-cname">' + esc(countryName(c.name)) + '</span>' +
          '<span class="vpn-cmeta">' + c.count + ' серв. · от ' + c.bestPing + ' мс · до ' + c.maxSpeed + ' Мбит</span>' +
        '</button>'
      );
      card.addEventListener('click', () => selectVpnCountry(c.code));
      grid.appendChild(card);
    }
    body.appendChild(panel);

    /* --- Серверы выбранной страны --- */
    if (!state.vpnCountry) return;
    const chosen = state.vpnCountries.find((c) => c.code === state.vpnCountry);
    const serversPanel = el(
      '<div class="panel"><h2>Серверы · ' + esc(countryName(chosen ? chosen.name : state.vpnCountry)) + '</h2>' +
      '<p class="panel-sub">Отсортированы по скорости. Чем меньше сессий, тем свободнее сервер.</p>' +
      '<div data-role="list"></div></div>'
    );
    const listHost = serversPanel.querySelector('[data-role="list"]');

    if (!state.vpnServers) {
      listHost.appendChild(el('<div class="skeleton" style="height:60px"></div>'));
    } else if (!state.vpnServers.length) {
      listHost.appendChild(el('<div class="hint">В этой стране сейчас нет доступных серверов.</div>'));
    } else {
      const list = el('<div class="stack" style="gap:8px"></div>');
      for (const s of state.vpnServers.slice(0, 25)) list.appendChild(vpnServerRow(s, st));
      listHost.appendChild(list);
    }
    body.appendChild(serversPanel);
  }

  function vpnServerRow(server, st) {
    const row = el(
      '<div class="file-row">' +
        '<div class="fname"><b>' + esc(server.ip) + '</b>' +
          '<div class="muted" style="font-size:11.5px">' +
            server.speedMbps + ' Мбит · ' + server.ping + ' мс · сессий: ' + server.sessions +
            ' · аптайм ' + server.uptimeHours + ' ч</div>' +
        '</div>' +
      '</div>'
    );
    const ctl = el('<div class="row-ctl"></div>');

    if (st.openvpn && !st.connected) {
      ctl.appendChild(button('Подключить', I.power, 'primary sm', async () => {
        setStatus('Подключаемся к VPN…', null, 'busy');
        await guard('Не удалось подключиться', async () => {
          await window.api.vpn.connect(server.id);
          state.vpn = await window.api.vpn.status();
          render();
        });
      }));
    }
    ctl.appendChild(button('Сохранить конфиг', I.download, 'sm', async () => {
      await guard('Не удалось сохранить конфигурацию', async () => {
        const saved = await window.api.vpn.saveConfig(server.id);
        toastOk('Файл сохранён', saved.file.split(/[\\/]/).pop());
      });
    }));
    row.appendChild(ctl);
    return row;
  }

  async function selectVpnCountry(code) {
    state.vpnCountry = code;
    state.vpnServers = null;
    render();
    await guard('Не удалось получить серверы', async () => {
      state.vpnServers = await window.api.vpn.servers(code);
      render();
    });
  }

  async function loadVpnCountries() {
    try {
      state.vpnCountries = await window.api.vpn.countries(false);
    } catch {
      state.vpnCountries = [];
    }
  }

  /* =========================== Настройки ============================ */

  const SETTINGS_PAGES = [
    { id: 'general', label: 'Общие', icon: 'sliders', render: settingsGeneral },
    { id: 'game', label: 'Игра', icon: 'play', render: settingsGame },
    { id: 'appearance', label: 'Оформление', icon: 'palette', render: settingsAppearance },
    { id: 'themes', label: 'Темы и фон', icon: 'image', render: settingsThemes },
    { id: 'integrations', label: 'Интеграции', icon: 'shield', render: settingsIntegrations },
    { id: 'updates', label: 'Обновления', icon: 'download', render: settingsUpdates },
    { id: 'about', label: 'О программе', icon: 'cube', render: settingsAbout },
  ];

  const BG_THEMES = [
    { id: 'default', name: 'По умолчанию', note: 'Спокойное свечение в фирменных цветах' },
    { id: 'space', name: 'Космос', note: 'Звёздное поле и медленные туманности' },
    { id: 'racing', name: 'Гонки', note: 'Неон и линии скорости' },
    { id: 'nature', name: 'Природа', note: 'Мягкие зелёные переливы' },
    { id: 'pvp', name: 'PvP', note: 'Резкий красный — для боевых серверов' },
    { id: 'pve', name: 'PvE', note: 'Глубокий фиолетовый с частицами' },
    { id: 'custom', name: 'Своё фото', note: 'Любая картинка с вашего компьютера' },
  ];

  function renderSettings(body, actions) {
    actions.appendChild(button('Папка лаунчера', I.folder, 'ghost sm', () => window.api.app.reveal('root')));
    actions.appendChild(button('Сбросить', I.refresh, 'danger sm', resetSettings));

    const tabs = el('<div class="settings-tabs"></div>');
    for (const page of SETTINGS_PAGES) {
      const tab = el(
        '<button class="settings-tab' + (page.id === state.settingsPage ? ' active' : '') + '">' +
        (I[page.icon] || '') + esc(page.label) + '</button>'
      );
      tab.addEventListener('click', () => {
        state.settingsPage = page.id;
        render();
      });
      tabs.appendChild(tab);
    }
    body.appendChild(tabs);

    const current = SETTINGS_PAGES.find((p) => p.id === state.settingsPage) || SETTINGS_PAGES[0];
    const host = el('<div class="settings-page"></div>');
    body.appendChild(host);
    current.render(host);
  }

  /** Сброс касается только настроек: аккаунты, сборки и миры остаются на месте. */
  async function resetSettings() {
    const yes = await confirm('Сбросить настройки?',
      'Память, путь к Java, разрешение, шрифт, тема и ключи API вернутся к заводским. ' +
      'Аккаунты, сборки и миры не пострадают.', true);
    if (!yes) return;

    await guard('Не удалось сбросить настройки', async () => {
      state.settings = await window.api.settings.reset();
      state.bgPhoto = null;
      applyAccent();
      applyWindowControls();
      await applyFont();
      await applyTheme();
      await loadFonts();
      render();
      toastOk('Настройки сброшены', 'Всё вернулось к значениям по умолчанию');
    });
  }

  /* --- Общие: Java и загрузки --- */

  function settingsGeneral(host) {
    const perf = el(
      '<div class="panel">' +
        '<h2>Java и производительность</h2>' +
        '<p class="panel-sub">Лаунчер сам скачает нужную версию Java, если подходящей нет в системе.</p>' +
      '</div>'
    );

    const memRow = el(
      '<div class="row">' +
        '<div class="row-info"><b>Оперативная память</b><span>Рекомендуется 4–8 ГБ для сборок с модами</span></div>' +
      '</div>'
    );
    const memCtl = el('<div class="row-ctl" style="width:320px"></div>');
    const memValue = el('<b style="width:78px;text-align:right">' + state.settings.memoryMb + ' МБ</b>');
    const memRange = el('<input type="range" min="1024" max="16384" step="512" value="' + state.settings.memoryMb + '">');
    memRange.addEventListener('input', () => { memValue.textContent = memRange.value + ' МБ'; });
    memRange.addEventListener('change', () => saveSettings({ memoryMb: parseInt(memRange.value, 10) }));
    memCtl.appendChild(memRange);
    memCtl.appendChild(memValue);
    memRow.appendChild(memCtl);
    perf.appendChild(memRow);

    const javaRow = el(
      '<div class="row">' +
        '<div class="row-info"><b>Путь к Java</b><span>' +
          (state.settings.javaPath ? esc(state.settings.javaPath) : 'Автоматически — определяется под версию игры') +
        '</span></div>' +
      '</div>'
    );
    const javaCtl = el('<div class="row-ctl"></div>');
    javaCtl.appendChild(button('Выбрать вручную', I.coffee, 'sm', async () => {
      await guard('Не удалось выбрать Java', async () => {
        const info = await window.api.java.pick();
        if (!info) return;
        await saveSettings({ javaPath: info.path });
        render();
        toastOk('Java выбрана', 'Версия ' + info.major);
      });
    }));
    if (state.settings.javaPath) {
      javaCtl.appendChild(button('Сбросить', I.refresh, 'sm', async () => {
        await saveSettings({ javaPath: '' });
        render();
      }));
    }
    javaCtl.appendChild(button('Найти в системе', I.search, 'sm', async () => {
      await guard('Поиск не удался', async () => {
        setStatus('Ищем установленные Java…', null, 'busy');
        const list = await window.api.java.scan();
        setStatus('Готов к работе', 0, '');
        if (!list.length) {
          toastErr('Java не найдена', 'Ничего страшного — лаунчер скачает нужную версию сам при первом запуске');
          return;
        }
        await modal({
          title: 'Найденные версии Java',
          subtitle: 'Всего: ' + list.length,
          body: '<div class="stack" style="gap:8px">' + list.map((j) =>
            '<div class="file-row"><div class="fname">Java ' + j.major + '<div class="muted" style="font-size:11.5px">' +
            esc(j.path) + '</div></div></div>').join('') + '</div>',
          buttons: [{ label: 'Закрыть', value: null }],
          wide: true,
        });
      });
    }));
    javaRow.appendChild(javaCtl);
    perf.appendChild(javaRow);

    const argsRow = el(
      '<div class="row">' +
        '<div class="row-info"><b>Аргументы JVM</b><span>Флаги оптимизации сборщика мусора</span></div>' +
      '</div>'
    );
    const argsCtl = el('<div class="row-ctl"></div>');
    const argsInput = el('<input class="input" style="width:330px" value="' + esc(state.settings.jvmArgs) + '">');
    argsInput.addEventListener('change', () => saveSettings({ jvmArgs: argsInput.value }));
    argsCtl.appendChild(argsInput);
    argsRow.appendChild(argsCtl);
    perf.appendChild(argsRow);

    perf.appendChild(numberRow('Параллельных загрузок', 'Больше — быстрее, но выше нагрузка на сеть',
      'maxDownloads', 1, 32, 1));
    host.appendChild(perf);

    const behaviour = el(
      '<div class="panel"><h2>Поведение лаунчера</h2>' +
      '<p class="panel-sub">Что происходит при закрытии окна.</p></div>'
    );
    behaviour.appendChild(switchRow('Сворачивать в трей при закрытии',
      'Крестик прячет окно в область уведомлений — лаунчер продолжает работать и видит друзей. ' +
      'Полный выход через меню значка', 'minimizeToTray'));
    host.appendChild(behaviour);
  }

  /* --- Игра: окно --- */

  function settingsGame(host) {
    const panel = el(
      '<div class="panel"><h2>Окно игры</h2><p class="panel-sub">Разрешение при запуске Minecraft.</p></div>'
    );
    const resRow = el('<div class="row"><div class="row-info"><b>Разрешение</b><span>Ширина × высота в пикселях</span></div></div>');
    const resCtl = el('<div class="row-ctl"></div>');
    const wInput = el('<input class="input" type="number" style="width:100px" value="' + state.settings.width + '">');
    const hInput = el('<input class="input" type="number" style="width:100px" value="' + state.settings.height + '">');
    wInput.addEventListener('change', () => saveSettings({ width: parseInt(wInput.value, 10) || 1280 }));
    hInput.addEventListener('change', () => saveSettings({ height: parseInt(hInput.value, 10) || 720 }));
    resCtl.appendChild(wInput);
    resCtl.appendChild(el('<span class="muted">×</span>'));
    resCtl.appendChild(hInput);
    resRow.appendChild(resCtl);
    panel.appendChild(resRow);
    panel.appendChild(switchRow('Запускать в полный экран', 'Игнорирует заданное разрешение', 'fullscreen'));
    panel.appendChild(switchRow('Сворачивать лаунчер при запуске', 'Освобождает место на панели задач', 'closeOnLaunch'));
    host.appendChild(panel);
  }

  /* --- Оформление: акцент и шрифт --- */

  function settingsAppearance(host) {
    const look = el('<div class="panel"><h2>Акцентный цвет</h2><p class="panel-sub">Задаёт цвет кнопок, выделений и полос загрузки.</p></div>');
    const accentRow = el('<div class="row"><div class="row-info"><b>Акцент</b><span>Применяется мгновенно</span></div></div>');
    const accents = el('<div class="row-ctl"></div>');
    for (const [key, color] of [['sand', '#d9a256'], ['sage', '#9caf88'], ['terracotta', '#c0685a'], ['forest', '#4e6650'], ['slate', '#7c8aa3']]) {
      const dot = el('<button title="' + key + '" style="width:26px;height:26px;border-radius:8px;background:' + color +
        ';border:2px solid ' + (state.settings.accent === key ? '#fff' : 'transparent') + '"></button>');
      dot.addEventListener('click', async () => {
        await saveSettings({ accent: key });
        applyAccent();
        render();
      });
      accents.appendChild(dot);
    }
    accentRow.appendChild(accents);
    look.appendChild(accentRow);
    host.appendChild(look);

    /* --- Стиль кнопок окна --- */
    const wc = el(
      '<div class="panel"><h2>Кнопки окна</h2>' +
      '<p class="panel-sub">Как выглядят «закрыть», «свернуть» и «развернуть» в заголовке.</p>' +
      '<div class="wc-grid" data-role="grid"></div></div>'
    );
    const wcGrid = wc.querySelector('[data-role="grid"]');
    const activeWc = state.settings.windowControls || 'mac';

    for (const style of WINDOW_CONTROLS) {
      const card = el(
        '<button class="wc-card' + (style.id === activeWc ? ' active' : '') + '">' +
          '<div class="wc-preview ' + style.preview + '"><i></i><i></i><i></i></div>' +
          '<div class="wc-meta"><b>' + esc(style.name) + '</b><span>' + esc(style.note) + '</span></div>' +
        '</button>'
      );
      card.addEventListener('click', async () => {
        await saveSettings({ windowControls: style.id });
        applyWindowControls();
        render();
      });
      wcGrid.appendChild(card);
    }
    host.appendChild(wc);

    host.appendChild(fontPanel());
  }

  /* --- Темы и фон --- */

  function settingsThemes(host) {
    const active = state.settings.bgTheme || 'default';
    const hasPhoto = Boolean(state.settings.bgImage);

    const panel = el(
      '<div class="panel">' +
        '<h2>Фон интерфейса</h2>' +
        '<p class="panel-sub">Темы нарисованы средствами самого интерфейса: не требуют интернета, ' +
        'не занимают места и не тормозят слабые машины.</p>' +
        '<div class="theme-grid" data-role="grid"></div>' +
      '</div>'
    );
    const grid = panel.querySelector('[data-role="grid"]');

    for (const theme of BG_THEMES) {
      const isCustom = theme.id === 'custom';
      const card = el(
        '<button class="theme-card' + (theme.id === active ? ' active' : '') + '">' +
          '<div class="theme-preview' + (isCustom && !hasPhoto ? ' empty-photo' : '') + '" data-t="' + esc(theme.id) + '">' +
            (theme.id === active ? '<span class="theme-badge">включена</span>' : '') +
          '</div>' +
          '<div class="theme-body"><b>' + esc(theme.name) + '</b><span>' + esc(theme.note) + '</span></div>' +
        '</button>'
      );
      if (isCustom && hasPhoto && state.bgPhoto) {
        card.querySelector('.theme-preview').style.backgroundImage = 'url(' + state.bgPhoto + ')';
      }
      card.addEventListener('click', () => selectTheme(theme.id));
      grid.appendChild(card);
    }
    host.appendChild(panel);

    // Блок про фотографии готовых тем
    const photoThemes = Object.keys(state.themeStatus || {});
    if (photoThemes.includes(active)) {
      const meta = state.themePhoto && state.themePhoto.id === active ? state.themePhoto : null;
      const src = el(
        '<div class="panel"><h2>Картинка темы</h2>' +
        '<p class="panel-sub">Скачивается из источников со свободной лицензией: медиатека NASA ' +
        '(общественное достояние) и Wikimedia Commons с фильтром по public domain и CC0.</p></div>'
      );
      const srcRow = el('<div class="row"><div class="row-info"><b>' +
        esc(meta ? (meta.title || 'Изображение загружено') : 'Картинка ещё не загружена') + '</b><span>' +
        esc(meta ? (meta.author || '') + ' · ' + (meta.license || '') : 'Тема пока показывает рисованную сцену') +
        '</span></div></div>');
      const srcCtl = el('<div class="row-ctl"></div>');
      srcCtl.appendChild(button(meta ? 'Другая картинка' : 'Загрузить картинку', I.refresh, 'sm',
        () => fetchThemePhoto(active, Boolean(meta))));
      if (meta) {
        srcCtl.appendChild(iconButton(I.trash, 'Убрать картинку темы', async () => {
          await guard('Не удалось убрать', async () => {
            await window.api.themes.clear(active);
            state.themePhoto = null;
            state.themeStatus = await window.api.themes.status().catch(() => state.themeStatus);
            await applyTheme();
            render();
          });
        }));
      }
      srcRow.appendChild(srcCtl);
      src.appendChild(srcRow);
      host.appendChild(src);
    }

    const photo = el(
      '<div class="panel"><h2>Своё изображение</h2>' +
      '<p class="panel-sub">PNG, JPG, WebP или GIF до 20 МБ. Файл копируется в папку лаунчера — ' +
      'оригинал потом можно удалить или перенести.</p></div>'
    );
    const photoRow = el(
      '<div class="row"><div class="row-info"><b>Файл фона</b><span>' +
      (hasPhoto ? esc(state.settings.bgImage) : 'не выбран') + '</span></div></div>'
    );
    const photoCtl = el('<div class="row-ctl"></div>');
    photoCtl.appendChild(button(hasPhoto ? 'Заменить' : 'Выбрать файл', I.image, 'sm', pickBackground));
    if (hasPhoto) photoCtl.appendChild(iconButton(I.trash, 'Убрать изображение', clearBackground));
    photoRow.appendChild(photoCtl);
    photo.appendChild(photoRow);
    host.appendChild(photo);

    const tune = el(
      '<div class="panel"><h2>Настройка фона</h2>' +
      '<p class="panel-sub">Чем сильнее затемнение, тем лучше читается текст поверх яркой картинки.</p></div>'
    );
    const dimRow = el('<div class="row"><div class="row-info"><b>Затемнение</b><span>Тёмная вуаль поверх фона</span></div></div>');
    const dimCtl = el('<div class="row-ctl" style="width:300px"></div>');
    const dimValue = el('<b style="width:52px;text-align:right">' + (state.settings.bgDim == null ? 40 : state.settings.bgDim) + ' %</b>');
    const dimRange = el('<input type="range" min="0" max="90" step="5" value="' +
      (state.settings.bgDim == null ? 40 : state.settings.bgDim) + '">');
    dimRange.addEventListener('input', () => {
      dimValue.textContent = dimRange.value + ' %';
      // Показываем результат сразу, пока тянут ползунок
      document.documentElement.style.setProperty('--bg-dim', Number(dimRange.value) / 100);
    });
    dimRange.addEventListener('change', () => saveSettings({ bgDim: parseInt(dimRange.value, 10) }));
    dimCtl.appendChild(dimRange);
    dimCtl.appendChild(dimValue);
    dimRow.appendChild(dimCtl);
    tune.appendChild(dimRow);
    tune.appendChild(switchRow('Анимация фона', 'Выключите, если интерфейс подтормаживает', 'bgAnimate', applyTheme));
    host.appendChild(tune);
  }

  async function selectTheme(id) {
    // «Своё фото» без картинки бессмысленно — сразу предлагаем выбрать файл
    if (id === 'custom' && !state.settings.bgImage) {
      await pickBackground();
      return;
    }
    await saveSettings({ bgTheme: id });
    await applyTheme();
    render();

    // У темы есть фотография, но она ещё не скачана — тянем её сейчас
    const status = state.themeStatus || {};
    if (id in status && !status[id]) await fetchThemePhoto(id, false);
  }

  /** Скачивает картинку темы из свободных источников (NASA, Wikimedia). */
  async function fetchThemePhoto(id, force) {
    setStatus(force ? 'Ищем другую картинку…' : 'Загрузка картинки темы…', null, 'busy');
    await guard('Не удалось загрузить картинку темы', async () => {
      const meta = await window.api.themes.ensure(id, force);
      state.themeStatus = await window.api.themes.status().catch(() => state.themeStatus);
      state.themePhoto = null;
      await applyTheme();
      render();
      setStatus('Готов к работе', 0, '');
      if (meta) toastOk('Картинка темы загружена', meta.title || '');
      else toast('Картинку найти не удалось', 'Тема осталась на рисованном фоне');
    });
  }

  async function pickBackground() {
    await guard('Не удалось выбрать изображение', async () => {
      const picked = await window.api.background.pick();
      if (!picked) return;
      state.bgPhoto = picked.dataUrl;
      await saveSettings({ bgImage: picked.name, bgTheme: 'custom' });
      await applyTheme();
      render();
      toastOk('Фон установлен', formatSize(picked.size));
    });
  }

  async function clearBackground() {
    await guard('Не удалось убрать изображение', async () => {
      await window.api.background.clear(state.settings.bgImage);
      state.bgPhoto = null;
      await saveSettings({ bgImage: '', bgTheme: 'default' });
      await applyTheme();
      render();
    });
  }

  /** Применяет тему фона: слои рисуются CSS, фото приходит из главного процесса. */
  async function applyTheme() {
    const root = document.documentElement;
    const theme = state.settings.bgTheme || 'default';
    root.dataset.bg = theme;
    root.dataset.bganim = state.settings.bgAnimate === false ? 'off' : 'on';
    root.style.setProperty('--bg-dim', (state.settings.bgDim == null ? 40 : state.settings.bgDim) / 100);

    const layer = $('#bg-photo');
    if (!layer) return;

    if (theme === 'custom' && state.settings.bgImage) {
      if (!state.bgPhoto) {
        state.bgPhoto = await window.api.background.image(state.settings.bgImage).catch(() => null);
      }
      if (state.bgPhoto) {
        layer.style.backgroundImage = 'url(' + state.bgPhoto + ')';
        layer.classList.add('on');
        return;
      }
    }

    // У готовых тем может быть скачанная фотография из свободного источника
    if (!state.themePhoto || state.themePhoto.id !== theme) {
      const found = await window.api.themes.photo(theme).catch(() => null);
      state.themePhoto = found && found.dataUrl ? { id: theme, ...found } : null;
    }
    if (state.themePhoto && state.themePhoto.id === theme) {
      layer.style.backgroundImage = 'url(' + state.themePhoto.dataUrl + ')';
      layer.classList.add('on');
      return;
    }

    layer.classList.remove('on');
    layer.style.backgroundImage = '';
  }

  /* --- Интеграции --- */

  function settingsIntegrations(host) {
    const api = el(
      '<div class="panel"><h2>Ключи доступа</h2>' +
      '<p class="panel-sub">Хранятся локально в папке лаунчера и никуда не отправляются, ' +
      'кроме официальных API соответствующих сервисов.</p></div>'
    );
    api.appendChild(textRow('API-ключ CurseForge',
      'Нужен для каталога и сборок CurseForge — получить на console.curseforge.com', 'curseforgeKey', 'password'));
    api.appendChild(textRow('Azure Client ID',
      'Для входа через Microsoft — приложение в portal.azure.com с public client flows', 'azureClientId', 'text'));
    host.appendChild(api);
  }

  /* --- Обновления --- */

  function settingsUpdates(host) {
    host.appendChild(updatePanel());
  }

  /* --- О программе --- */

  function settingsAbout(host) {
    host.appendChild(el(
      '<div class="panel">' +
        '<h2>Kubick Launcher</h2>' +
        '<p class="panel-sub">Версия ' + esc(state.appInfo.version || '1.0.0') + '</p>' +
        '<div class="row"><div class="row-info"><b>Папка данных</b><span style="word-break:break-all">' +
          esc(state.appInfo.root || '') + '</span></div></div>' +
        '<div class="row"><div class="row-info"><b>Платформа</b><span>' +
          esc((state.appInfo.platform || '') + ' · ' + (state.appInfo.arch || '') +
          ' · Electron ' + (state.appInfo.electron || '')) +
        '</span></div></div>' +
      '</div>'
    ));

    const danger = el(
      '<div class="panel"><h2>Сброс</h2>' +
      '<p class="panel-sub">Вернуть все настройки к заводским. Аккаунты, сборки и миры остаются на месте.</p></div>'
    );
    const resetRow = el('<div class="row"><div class="row-info"><b>Настройки по умолчанию</b><span>Действие нельзя отменить</span></div></div>');
    const resetCtl = el('<div class="row-ctl"></div>');
    resetCtl.appendChild(button('Сбросить настройки', I.refresh, 'danger sm', resetSettings));
    resetRow.appendChild(resetCtl);
    danger.appendChild(resetRow);
    host.appendChild(danger);
  }

  /**
   * Панель шрифтов. Каждый шрифт можно скачать отдельно — интерфейс не тянет
   * ничего лишнего, пока пользователь сам не выберет.
   */
  function fontPanel() {
    const panel = el(
      '<div class="panel">' +
        '<h2>Шрифт интерфейса</h2>' +
        '<p class="panel-sub">Открытые шрифты с поддержкой кириллицы под лицензией OFL. ' +
        'Скачиваются один раз и дальше работают без интернета.</p>' +
        '<div class="font-list" data-role="list"></div>' +
      '</div>'
    );
    const list = panel.querySelector('[data-role="list"]');

    if (!state.fonts) {
      list.innerHTML = '<div class="skeleton" style="height:56px"></div>';
      loadFonts().then(() => { if (state.view === 'settings') render(); });
      return panel;
    }

    for (const font of state.fonts) list.appendChild(fontRow(font));
    return panel;
  }

  function fontRow(font) {
    const isActive = (state.settings.fontFamily || 'system') === font.id;
    // San Francisco есть только в macOS: Apple запрещает распространять его отдельно
    const unavailable = font.appleOnly && state.appInfo.platform !== 'darwin';

    // Системный шрифт задаётся стеком имён, скачанный — одним семейством
    const previewStyle = font.family
      ? ' style="font-family:' + esc(font.system ? font.family : "'" + font.family + "'") + '"'
      : '';

    const row = el(
      '<div class="font-row' + (isActive ? ' active' : '') + '">' +
        '<div class="font-preview"' + (font.installed ? previewStyle : '') + '>Аа</div>' +
        '<div class="font-meta">' +
          '<b>' + esc(font.name) + '</b>' +
          '<span>' + esc(font.note) + '</span>' +
          '<span class="font-sub">' + esc(font.builtin ? font.author : font.author + ' · ' + font.license) +
            (font.installed && font.size ? ' · ' + esc(formatSize(font.size)) : '') + '</span>' +
          (unavailable
            ? '<span class="font-sub" style="color:var(--warn)">Не найден в этой системе — ' +
              'ближайшая открытая замена по рисунку это Inter</span>'
            : '') +
        '</div>' +
        '<div class="font-actions"></div>' +
      '</div>'
    );

    const actions = row.querySelector('.font-actions');

    if (!font.installed) {
      actions.appendChild(button('Скачать', I.download, 'sm', async () => {
        setStatus('Загрузка шрифта ' + font.name + '…', null, 'busy');
        await guard('Не удалось скачать шрифт', async () => {
          await window.api.fonts.install(font.id);
          await loadFonts();
          await selectFont(font.id);
          setStatus('Готов к работе', 0, '');
          toastOk('Шрифт установлен', font.name + ' применён к интерфейсу');
        });
      }));
      return row;
    }

    if (isActive) {
      actions.appendChild(el('<span class="chip" style="color:var(--ok);border-color:rgba(52,211,153,.35)">применён</span>'));
    } else {
      actions.appendChild(button('Применить', I.check, 'sm', () => selectFont(font.id)));
    }

    if (!font.builtin && !font.system) {
      actions.appendChild(iconButton(I.trash, 'Удалить файлы шрифта', async () => {
        await guard('Не удалось удалить', async () => {
          await window.api.fonts.remove(font.id);
          if (isActive) await selectFont('system');
          await loadFonts();
          render();
        });
      }));
    }
    return row;
  }

  async function selectFont(id) {
    await saveSettings({ fontFamily: id });
    await applyFont();
    await loadFonts();
    render();
  }

  async function loadFonts() {
    try {
      state.fonts = await window.api.fonts.list();
    } catch {
      state.fonts = [];
    }
  }

  /** Панель обновлений: показывает ровно одно осмысленное состояние, без «проверьте позже». */
  function updatePanel() {
    const u = state.update || {};
    const panel = el(
      '<div class="panel">' +
        '<h2>Обновления</h2>' +
        '<p class="panel-sub">Установленная версия: ' + esc(u.currentVersion || state.appInfo.version || '1.0.0') + '</p>' +
      '</div>'
    );

    const row = el('<div class="row"><div class="row-info" data-role="info"></div></div>');
    const info = row.querySelector('[data-role="info"]');
    const ctl = el('<div class="row-ctl"></div>');
    row.appendChild(ctl);
    panel.appendChild(row);

    const say = (title, hint) => {
      info.innerHTML = '<b>' + esc(title) + '</b><span>' + esc(hint) + '</span>';
    };

    if (!u.configured) {
      say('Обновлений нет — проверять пока негде',
        'Репозиторий для обновлений ещё не указан: заполните поле repository в package.json');
      return panel;
    }
    if (!u.supported) {
      const why = u.reason === 'portable'
        ? 'Портативная версия обновляется скачиванием нового файла вручную'
        : 'Проверка доступна только в установленной версии, не при запуске из исходников';
      say('Обновления недоступны здесь', why);
      return panel;
    }

    if (u.status === 'checking') {
      say('Проверяем обновления…', 'Запрашиваем сведения о последней версии');
      return panel;
    }

    if (u.status === 'available') {
      say('Доступна версия ' + (u.version || ''), u.notes ? String(u.notes).split('\n')[0] : 'Нажмите, чтобы скачать обновление');
      ctl.appendChild(button('Скачать', I.download, 'primary sm', async () => {
        await guard('Не удалось скачать обновление', () => window.api.updates.download());
      }));
      return panel;
    }

    if (u.status === 'downloading') {
      say('Загрузка обновления', 'Скачано ' + (u.percent || 0) + '%');
      const bar = el('<span class="bar" style="width:180px"><i style="width:' + (u.percent || 0) + '%"></i></span>');
      ctl.appendChild(bar);
      return panel;
    }

    if (u.status === 'ready') {
      say('Обновление готово', 'Версия ' + (u.version || '') + ' установится после перезапуска');
      ctl.appendChild(button('Перезапустить', I.refresh, 'primary sm', async () => {
        await guard('Не удалось применить обновление', () => window.api.updates.install());
      }));
      return panel;
    }

    if (u.status === 'error') {
      say('Ошибка проверки', u.error || 'Неизвестная ошибка');
    } else if (u.status === 'latest') {
      say('Обновлений нет', 'У вас последняя версия ' + (u.currentVersion || '') +
        (u.checkedAt ? ' · проверено ' + formatDate(u.checkedAt) : ''));
    } else {
      say('Проверка обновлений', 'Лаунчер проверяет их автоматически при запуске');
    }

    ctl.appendChild(button('Проверить', I.refresh, 'sm', async () => {
      state.update = { ...(state.update || {}), status: 'checking' };
      render();
      await guard('Проверка не удалась', async () => {
        state.update = await window.api.updates.check();
        render();
      });
    }));
    return panel;
  }

  function switchRow(title, hint, key, after) {
    const row = el('<div class="row"><div class="row-info"><b>' + esc(title) + '</b><span>' + esc(hint) + '</span></div></div>');
    const ctl = el('<div class="row-ctl"></div>');
    const sw = el('<label class="switch"><input type="checkbox"' + (state.settings[key] ? ' checked' : '') + '><span class="track"></span></label>');
    sw.querySelector('input').addEventListener('change', async (e) => {
      await saveSettings({ [key]: e.target.checked });
      if (after) await after();
    });
    ctl.appendChild(sw);
    row.appendChild(ctl);
    return row;
  }

  function textRow(title, hint, key, type) {
    const row = el('<div class="row"><div class="row-info"><b>' + esc(title) + '</b><span>' + esc(hint) + '</span></div></div>');
    const ctl = el('<div class="row-ctl"></div>');
    const input = el('<input class="input" type="' + (type || 'text') + '" placeholder="не задан" value="' + esc(state.settings[key] || '') + '">');
    input.addEventListener('change', () => saveSettings({ [key]: input.value.trim() }));
    ctl.appendChild(input);
    row.appendChild(ctl);
    return row;
  }

  function numberRow(title, hint, key, min, max, step) {
    const row = el('<div class="row"><div class="row-info"><b>' + esc(title) + '</b><span>' + esc(hint) + '</span></div></div>');
    const ctl = el('<div class="row-ctl"></div>');
    const input = el('<input class="input" type="number" style="width:110px" min="' + min + '" max="' + max +
      '" step="' + step + '" value="' + state.settings[key] + '">');
    input.addEventListener('change', () => {
      const value = Math.max(min, Math.min(max, parseInt(input.value, 10) || min));
      input.value = value;
      saveSettings({ [key]: value });
    });
    ctl.appendChild(input);
    row.appendChild(ctl);
    return row;
  }

  async function saveSettings(patch) {
    try {
      state.settings = await window.api.settings.save(patch);
    } catch (e) {
      toastErr('Не удалось сохранить настройку', e.message);
    }
  }

  function applyAccent() {
    document.documentElement.dataset.accent = state.settings.accent || 'sand';
  }

  const WINDOW_CONTROLS = [
    { id: 'mac', name: 'macOS', note: 'Три цветных кружка слева', preview: 'mac' },
    { id: 'win', name: 'Windows', note: 'Прямоугольные кнопки справа', preview: 'win right' },
    { id: 'soft', name: 'Скруглённые', note: 'Мягкие пилюли справа', preview: 'soft right' },
    { id: 'bare', name: 'Штрихи', note: 'Только символы, без подложки', preview: 'bare right' },
  ];

  function applyWindowControls() {
    document.documentElement.dataset.wc = state.settings.windowControls || 'mac';
  }

  const SYSTEM_STACK = "'Segoe UI Variable Text', 'Segoe UI', system-ui, -apple-system, sans-serif";

  /**
   * Подключает выбранный шрифт: главный процесс отдаёт готовый CSS с @font-face,
   * где файл вшит как data:-URI — поэтому после скачивания шрифт работает офлайн.
   */
  async function applyFont() {
    const id = state.settings.fontFamily || 'system';
    let style = document.getElementById('font-faces');
    if (!style) {
      style = document.createElement('style');
      style.id = 'font-faces';
      document.head.appendChild(style);
    }

    if (id === 'system') {
      style.textContent = '';
      document.documentElement.style.setProperty('--font-ui', SYSTEM_STACK);
      return;
    }

    try {
      const data = await window.api.fonts.css(id);
      if (!data || !data.stack) {
        // Шрифт выбран, но файлов нет — не оставляем интерфейс без шрифта
        style.textContent = '';
        document.documentElement.style.setProperty('--font-ui', SYSTEM_STACK);
        return;
      }
      style.textContent = data.css || '';
      document.documentElement.style.setProperty('--font-ui', data.stack + ', ' + SYSTEM_STACK);
    } catch {
      document.documentElement.style.setProperty('--font-ui', SYSTEM_STACK);
    }
  }

  /* ============================ Консоль ============================= */

  function renderConsole(body, actions) {
    actions.appendChild(button('Очистить', I.trash, 'ghost', () => {
      state.logs = [];
      render();
    }));

    const box = el('<div class="console" id="console-box"></div>');
    if (!state.logs.length) {
      box.innerHTML = '<span class="muted">Логи появятся здесь после запуска игры.</span>';
    } else {
      box.innerHTML = state.logs.map(logLine).join('\n');
    }
    body.appendChild(box);
    box.scrollTop = box.scrollHeight;
  }

  function logLine(line) {
    const cls = /ERROR|SEVERE|Exception|\bat [a-z]+\./.test(line) ? 'l-err'
      : /WARN/.test(line) ? 'l-warn'
      : /INFO/.test(line) ? 'l-info' : '';
    return '<span class="' + cls + '">' + esc(line) + '</span>';
  }

  function pushLog(line) {
    state.logs.push(line);
    if (state.logs.length > 3000) state.logs.splice(0, state.logs.length - 3000);
    if (state.view !== 'console') return;
    const box = $('#console-box');
    if (!box) return;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    if (state.logs.length === 1) box.innerHTML = '';
    box.insertAdjacentHTML('beforeend', (box.textContent ? '\n' : '') + logLine(line));
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  /* =========================== Компоненты =========================== */

  function button(label, icon, kind, onClick) {
    const node = el('<button class="btn ' + (kind || '') + '">' + (icon || '') + esc(label) + '</button>');
    node.addEventListener('click', onClick);
    return node;
  }

  function iconButton(icon, title, onClick) {
    const node = el('<button class="icon-btn" title="' + esc(title) + '">' + icon + '</button>');
    node.addEventListener('click', onClick);
    return node;
  }

  /* ============================ Загрузка ============================ */

  async function loadInstances() {
    try {
      state.instances = await window.api.instances.list();
      state.running = new Set(state.instances.filter((i) => i.running).map((i) => i.id));
    } catch (e) {
      toastErr('Не удалось загрузить сборки', e.message);
    }
    updateBadges();
  }

  async function loadAccounts() {
    try {
      state.accounts = await window.api.accounts.list();
    } catch (e) {
      toastErr('Не удалось загрузить аккаунты', e.message);
    }
    renderAccountCard();
  }

  async function loadVersions() {
    try {
      const data = await window.api.versions.list({ snapshots: true });
      state.versions = data.versions;
      state.latest = data.latest;
    } catch (e) {
      toastErr('Список версий недоступен', e.message);
    }
  }

  function renderAccountCard() {
    const host = $('#account-card');
    if (!host) return;
    const acc = activeAccount();
    host.innerHTML = acc
      ? '<div class="avatar">' + (acc.skinUrl ? '<img src="' + esc(acc.skinUrl) + '">' : esc(acc.name.slice(0, 1).toUpperCase())) + '</div>' +
        '<div class="account-meta"><b>' + esc(acc.name) + '</b><span>' +
        (acc.type === 'microsoft' ? 'Microsoft' : 'Офлайн') + '</span></div>'
      : '<div class="avatar">' + I.user + '</div><div class="account-meta"><b>Нет аккаунта</b><span>Нажмите, чтобы добавить</span></div>';
  }

  function updateBadges() {
    const badge = $('#badge-library');
    if (badge) {
      badge.textContent = state.instances.length || '';
      badge.style.display = state.instances.length ? '' : 'none';
    }
  }

  /* ============================== Старт ============================= */

  function wireEvents() {
    window.api.events.onProgress((p) => {
      const percent = percentOf(p);
      const label = p.label || 'Работаем…';
      setStatus(label + (percent != null ? ' — ' + percent + '%' : ''), percent, 'busy');

      // Прогресс на карточке запускаемой сборки
      if (p.instanceId) {
        const card = document.querySelector('.inst-row[data-id="' + CSS.escape(p.instanceId) + '"]');
        if (card) {
          const bar = card.querySelector('[data-role="bar"]');
          const text = card.querySelector('[data-role="state"]');
          if (bar && percent != null) bar.style.width = percent + '%';
          if (text) { text.textContent = label; text.classList.add('active'); }
        }
      }
    });

    window.api.events.onGameStarted(async (e) => {
      state.running.add(e.instanceId);
      state.busy.delete(e.instanceId);
      setStatus('Minecraft запущен (Java ' + e.java + ')', 100, 'ok');
      toastOk('Игра запущена', 'Версия ' + e.versionId);
      await loadInstances();
      if (state.view === 'library') render();
    });

    window.api.events.onVpn((e) => {
      if (e.status) state.vpn = e.status;
      if (e.type === 'connected') toastOk('VPN подключён', countryName(e.server.country));
      if (e.type === 'disconnected') {
        if (e.error) toastErr('VPN отключился', e.error);
        else toast('VPN отключён', 'Соединение закрыто');
      }
      if (e.type === 'error') toastErr('Ошибка VPN', e.error);
      setStatus('Готов к работе', 0, '');
      if (state.view === 'vpn') render();
    });

    window.api.events.onFriends((snapshot) => {
      const wasOnline = state.friends ? state.friends.friends.filter((f) => f.online).length : 0;
      state.friends = snapshot;
      const nowOnline = snapshot.friends.filter((f) => f.online);
      if (nowOnline.length > wasOnline) {
        const fresh = nowOnline[nowOnline.length - 1];
        toastOk('Друг открыл мир', fresh.nick + ' — сервер добавлен в ваши сборки');
      }
      if (state.view === 'network') render();
    });

    window.api.events.onLan((snapshot) => {
      const hadWorlds = state.lan ? state.lan.worlds.length : 0;
      state.lan = snapshot;
      const badge = $('#badge-lan');
      if (badge) {
        badge.textContent = snapshot.worlds.length || '';
        badge.style.display = snapshot.worlds.length ? '' : 'none';
      }
      if (snapshot.worlds.length > hadWorlds) {
        const fresh = snapshot.worlds.find((w) => !w.own);
        if (fresh) toast('Найден мир в сети', fresh.motd + ' — ' + fresh.host);
      }
      if (state.view === 'network') render();
    });

    window.api.events.onGameLog((e) => pushLog(e.line));

    window.api.events.onUpdate((snapshot) => {
      const wasAvailable = state.update && state.update.status === 'available';
      state.update = snapshot;
      if (snapshot.status === 'available' && !wasAvailable) {
        toast('Доступно обновление ' + snapshot.version, 'Откройте Настройки, чтобы установить');
      }
      if (snapshot.status === 'ready') {
        toastOk('Обновление загружено', 'Перезапустите лаунчер, чтобы применить');
      }
      if (state.view === 'settings') render();
    });

    window.api.events.onGameExit(async (e) => {
      state.running.delete(e.instanceId);
      state.busy.delete(e.instanceId);
      await loadInstances();
      if (state.view === 'library') render();
      if (e.error) {
        setStatus('Игра завершилась с ошибкой', 0, '');
        toastErr('Игра закрылась', e.error);
      } else {
        setStatus('Готов к работе', 0, '');
        toast('Сессия завершена', 'Вы играли ' + formatDuration(e.seconds || 0));
      }
    });
  }

  function wireChrome() {
    $('#win-min').addEventListener('click', () => window.api.app.minimize());
    $('#win-max').addEventListener('click', () => window.api.app.maximize());
    $('#win-close').addEventListener('click', () => window.api.app.close());

    for (const item of document.querySelectorAll('.nav-item')) {
      item.addEventListener('click', () => go(item.dataset.view));
    }
    $('#account-card').addEventListener('click', () => go('accounts'));
  }

  async function init() {
    // Иконки в статичной разметке
    for (const node of document.querySelectorAll('[data-icon]')) {
      node.insertAdjacentHTML('afterbegin', I[node.dataset.icon] || '');
    }

    wireChrome();
    wireEvents();

    state.settings = await window.api.settings.get().catch(() => ({ memoryMb: 4096, accent: 'violet' }));
    applyAccent();
    applyWindowControls();
    await applyTheme();
    await applyFont();
    state.appInfo = await window.api.app.info().catch(() => ({}));
    state.update = await window.api.updates.status().catch(() => null);
    state.lan = await window.api.lan.status().catch(() => null);
    state.friends = await window.api.friends.status().catch(() => null);
    state.themeStatus = await window.api.themes.status().catch(() => null);
    state.vpn = await window.api.vpn.status().catch(() => null);

    await Promise.all([loadInstances(), loadAccounts()]);
    render();
    setStatus('Готов к работе', 0, '');

    // Список версий тянем в фоне — интерфейс не должен ждать сеть
    loadVersions().then(() => {
      if (state.view === 'library') updateBadges();
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
