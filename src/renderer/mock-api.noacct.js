/**
 * Заглушка window.api для проверки интерфейса без Electron.
 * Отдаёт правдоподобные данные, чтобы разделы отрисовывались целиком.
 * В сборку не попадает — исключена в package.json.
 */
(function () {
  const delay = (value, ms = 60) => new Promise((r) => setTimeout(() => r(value), ms));

  const instances = [
    {
      id: 'fab-1', name: 'Fabulously Optimized', mcVersion: '1.21.1', loader: 'fabric',
      loaderLabel: 'Fabric', loaderVersion: '0.16.5', versionId: 'fabric-loader-0.16.5-1.21.1',
      modCount: 96, lastPlayed: Date.now() - 3600e3, overrides: {},
    },
    {
      id: 'van-2', name: 'Ванильная', mcVersion: '1.20.4', loader: 'vanilla',
      loaderLabel: 'Vanilla', versionId: '1.20.4', modCount: 0, lastPlayed: null, overrides: {},
    },
  ];

  const catalogItem = (i, type) => ({
    source: 'modrinth', id: 'p' + i, slug: 'proj-' + i,
    name: (type === 'shader' ? 'Шейдер ' : type === 'resourcepack' ? 'Набор ' : 'Мод ') + i,
    summary: 'Описание проекта номер ' + i + ' — короткая строка для проверки вёрстки.',
    author: 'author' + i, downloads: 1000 * i + 137, followers: i * 3,
    icon: null, categories: ['optimization'], updated: new Date(Date.now() - i * 864e5).toISOString(),
    gameVersions: ['1.21.1'], link: 'https://modrinth.com/mod/proj-' + i,
  });

  const CATEGORIES = {
    mod: [{ id: 'optimization', label: 'Оптимизация' }, { id: 'magic', label: 'Магия' }],
    resourcepack: [{ id: 'gui', label: 'Интерфейс' }, { id: 'realistic', label: 'Реализм' }],
    shader: [{ id: 'realistic', label: 'Реализм' }, { id: 'shadows', label: 'Тени' }],
    modpack: [{ id: 'quests', label: 'Задания' }],
  };

  const servers = [
    { id: 'hypixel', name: 'Hypixel', address: 'mc.hypixel.net', site: 'https://hypixel.net', region: 'Мир', licensed: true, online: true, latency: 92, players: 41230, maxPlayers: 200000, version: '1.8-1.21', motd: 'Hypixel Network', icon: null, error: null },
    { id: 'funtime', name: 'FunTime', address: 'mc.funtime.su', site: 'https://funtime.su', region: 'Россия', licensed: false, online: true, latency: 41, players: 8120, maxPlayers: 20000, version: '1.16-1.21', motd: 'FunTime', icon: null, error: null },
    { id: 'own-1', name: 'Сервер друга', address: 'play.friend.local', site: null, region: 'Свой', licensed: false, own: true, online: true, latency: 12, players: 3, maxPlayers: 20, version: '1.21.1', motd: 'Дом', icon: null, error: null },
    { id: 'dead', name: 'Wynncraft', address: 'play.wynncraft.com', site: 'https://wynncraft.com', region: 'Мир', licensed: true, online: false, latency: 0, players: 0, maxPlayers: 0, version: '', motd: '', icon: null, error: 'Нет ответа' },
  ];

  let proxies = [
    { id: 'px1', label: 'Свой VPS', host: 'proxy.example.com', port: 1080, username: '', hasPassword: false, lastCheck: { ok: true, ip: '185.22.10.7', country: 'Нидерланды', latency: 74, at: Date.now() } },
    { id: 'px2', label: 'Резервный', host: '10.0.0.5', port: 1080, username: 'user', hasPassword: true, lastCheck: null },
  ];
  let proxyState = { connected: false, proxy: null, relays: 0 };

  window.api = {
    app: {
      info: () => delay({ version: '1.5.0', root: 'C:/AppData/.kubick-launcher' }),
      minimize: () => {}, maximize: () => {}, close: () => {},
      openExternal: (u) => { console.log('openExternal', u); return delay(true); },
      reveal: () => delay(true),
    },
    events: {
      onProgress: () => {}, onGameLog: () => {}, onGameStarted: () => {}, onGameExit: () => {},
      onMsaDone: () => {}, onUpdate: () => {}, onLan: () => {}, onFriends: () => {}, onVpn: () => {},
    },
    settings: {
      get: () => delay({ memoryMb: 4096, jvmArgs: '', width: 1280, height: 720, accent: 'sand', bgTheme: 'default', bgDim: 40, bgAnimate: true, fontFamily: 'system', versionView: 'list', windowControls: 'mac' }),
      save: (p) => delay(p), reset: () => delay({}),
    },
    accounts: { list: () => delay({ list: [], activeId: null }) },
    instances: {
      list: () => delay(instances),
      openFolder: () => delay(true),
      repair: () => delay(true),
      duplicate: () => delay(instances[0]),
      remove: () => delay(true),
    },
    io: {
      inspect: () => delay({
        instance: { id: 'fab-1', name: 'Fabulously Optimized', mcVersion: '1.21.1', loader: 'fabric' },
        parts: [
          { id: 'mods', label: 'Моды', size: 184 * 1024 * 1024, present: true },
          { id: 'config', label: 'Конфиги модов', size: 2.4 * 1024 * 1024, present: true },
          { id: 'resourcepacks', label: 'Наборы ресурсов', size: 0, present: false },
          { id: 'shaderpacks', label: 'Наборы шейдеров', size: 31 * 1024 * 1024, present: true },
          { id: 'options', label: 'Настройки игры', size: 14 * 1024, present: true },
          { id: 'saves', label: 'Миры', size: 1.6 * 1024 * 1024 * 1024, present: true },
        ],
      }),
      export: () => delay({ file: 'C:/tmp/pack.kubick', size: 219e6, included: ['mods'], name: 'Fabulously Optimized' }),
      pick: () => delay({
        file: 'C:/tmp/pack.kubick', name: 'Сборка друга', mcVersion: '1.21.1',
        loader: 'fabric', loaderVersion: '0.16.5', exportedAt: Date.now(), size: 219e6,
        format: 'mrpack', needsCurseforgeKey: false,
        folders: [{ folder: 'моды из каталога', files: 96 }, { folder: 'файлы настроек', files: 41 }],
      }),
      import: () => delay({ instance: instances[0], files: 137 }),
      reveal: () => delay(true),
    },
    game: { launch: () => delay(true), stop: () => delay(true), running: () => delay([]) },
    mods: {
      search: ({ projectType, offset = 0, limit = 30 }) => delay({
        total: 248,
        items: Array.from({ length: Math.min(limit, 248 - offset) }, (_, k) => catalogItem(offset + k + 1, projectType)),
      }, 120),
      versions: () => delay([{ id: 'v1', projectId: 'p1', name: 'v1.0', versionNumber: '1.0.0', channel: 'release', gameVersions: ['1.21.1'], loaders: ['fabric'], published: new Date().toISOString(), dependencies: [], file: { url: 'x', filename: 'mod.jar', size: 1024 } }]),
      categories: (type) => delay(CATEGORIES[type] || []),
      install: () => delay(true),
      installed: () => delay([]),
    },
    inst: {
      mods: () => delay([
        { name: 'Sodium', version: '0.5.11', filename: 'sodium.jar', path: 'x/sodium.jar', enabled: true, mtime: Date.now(), loader: 'fabric', description: 'Оптимизация отрисовки', icon: null },
        { name: 'Iris', version: '1.7.0', filename: 'iris.jar', path: 'x/iris.jar', enabled: false, mtime: Date.now(), loader: 'fabric', description: '', icon: null },
      ]),
      packs: () => delay([]),
      components: () => delay({
        versionId: 'fabric-loader-0.16.5-1.21.1', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
        assetIndex: '17', libraries: 62,
        components: [
          { name: 'Minecraft', version: '1.21.1', required: true },
          { name: 'Fabric Loader', version: '0.16.5', required: true },
          { name: 'Java', version: '25', required: true },
          { name: 'LWJGL', version: '3.3.3', required: false },
        ],
      }),
      notes: () => delay(''), saveNotes: () => delay(true),
      worlds: () => delay([]), screenshots: () => delay([]), servers: () => delay([]),
      logs: () => delay([]), readLog: () => delay(''),
      addFiles: () => delay({ added: 0 }), deleteFile: () => delay(true),
      pingServers: () => delay([]), openFile: () => delay(true),
    },
    crash: {
      list: () => delay([
        { instanceId:'fab-1', instanceName:'Fabulously Optimized', versionId:'26.2', java:25, code:1, at:Date.now()-3600e3, playedSeconds:4,
          cause:{ id:'natives', title:'Не найдены нативные библиотеки', why:'Игре не хватает lwjgl.dll и соседних файлов: они либо не распаковались, либо не попали в classpath.', fix:'Откройте раздел «Версия» в окне сборки и нажмите «Переустановить файлы».', detail:null },
          description:'Loading library LWJGL system', exception:'java.lang.UnsatisfiedLinkError: Failed to locate library: lwjgl.dll',
          gameReport:'C:/crash.txt', logFile:'C:/log.log', tail:['[LWJGL] Failed to load a library.'] },
        { instanceId:'fab-1', instanceName:'Fabulously Optimized', versionId:'26.2', java:25, code:-1073741819, at:Date.now()-86400e3, playedSeconds:930,
          cause:null, description:null, exception:null, gameReport:null, logFile:'C:/log.log', tail:['ничего понятного'] },
      ]),
      remove: () => delay(true), clear: () => delay(true), open: () => delay(true),
    },
    servers: { list: () => delay(servers), status: () => delay(servers), ping: () => delay(servers[0]), add: (p) => delay({ ...p, name: p.name || p.address }), remove: () => delay(true) },
    proxy: {
      list: () => delay(proxies),
      add: (p) => { const e = { ...p, id: 'px' + (proxies.length + 1), hasPassword: Boolean(p.password) }; proxies = [...proxies, e]; return delay(e); },
      remove: (id) => { proxies = proxies.filter((p) => p.id !== id); return delay(true); },
      check: (id) => delay({ id, ok: true, latency: 74, ip: '185.22.10.7', country: 'Нидерланды', code: 'NL', city: 'Amsterdam' }, 300),
      ip: () => delay({ ip: '203.0.113.45', country: 'Россия', code: 'RU', city: 'Москва' }, 200),
      status: () => delay(proxyState),
      presets: () => delay([
        { id: 'tor', label: 'Tor', host: '127.0.0.1', port: 9050, note: 'Служба Tor', added: false },
        { id: 'tor-browser', label: 'Tor Browser', host: '127.0.0.1', port: 9150, note: 'Пока окно открыто', added: true },
        { id: 'xray', label: 'Xray / V2Ray', host: '127.0.0.1', port: 10808, note: 'Порт по умолчанию', added: false },
      ]),
      start: (id) => { proxyState = { connected: true, proxy: proxies.find((p) => p.id === id), relays: 0 }; return delay(proxyState); },
      stop: () => { proxyState = { connected: false, proxy: null, relays: 0 }; return delay(proxyState); },
    },
    vpn: {
      status: () => delay({ connected: false, server: null, since: null, openvpn: 'C:/resources/openvpn/openvpn.exe', source: 'bundled', driver: null }),
      countries: () => delay([
        { code: 'JP', name: 'Japan', count: 210, bestPing: 12, maxSpeed: 88 },
        { code: 'KR', name: 'Korea', count: 96, bestPing: 24, maxSpeed: 54 },
      ]),
      servers: () => delay([{ id: 's1', ip: '203.0.113.9', country: 'Japan', code: 'JP', ping: 12, speedMbps: 88, sessions: 4, uptimeHours: 300 }]),
      connect: () => delay(true), disconnect: () => delay(true),
      saveConfig: () => delay({ file: 'C:/vpn/jp.ovpn' }), openFolder: () => delay(true),
    },
    lan: { status: () => delay({ hosting: false }), servers: () => delay([]), addServer: () => delay(true), removeServer: () => delay(true) },
    friends: { status: () => delay({ code: null, hasAccount: false, nick: 'Игрок', friends: [] }) },
    themes: { status: () => delay({ list: [], current: 'default' }) },
    fonts: { list: () => delay({ list: [] }), css: () => delay({ css: '', stack: '' }) },
    updates: { status: () => delay({ currentVersion: '1.5.0', state: 'idle' }) },
    versions: { list: () => delay({ versions: [{ id: '1.21.1', type: 'release', releaseTime: '2024-08-08' }], latest: { release: '1.21.1' } }) },
    java: {
      scan: () => delay([
        { major: 21, path: 'C:/AppData/.kubick-launcher/java/temurin-21/bin/java.exe', source: 'runtime', version: '21.0.5' },
        { major: 8, path: 'C:/Program Files/Java/jre1.8.0_502/bin/java.exe', source: 'registry', version: '1.8.0_502' },
      ]),
      install: (m) => delay({ major: m, path: 'C:/AppData/.kubick-launcher/java/temurin-' + m + '/bin/java.exe' }, 400),
      pick: () => delay(null),
      validate: () => delay({ ok: true, info: { major: 21 } }),
      requirement: () => delay({ required: 21, max: null, mcVersion: '1.21.1', satisfied: true, available: [] }),
    },
    account: {
      status: () => delay({ signedIn: true, online: true, configured: false, user: { username: 'Steve', uuid: '5627dd98-e6be-3c21-b8a8-e92344183641' }, offlineDaysLeft: 30 }),
      restore: () => delay({ signedIn: true, online: false, configured: false, user: { username: 'Steve', uuid: '5627dd98-e6be-3c21-b8a8-e92344183641' }, offlineDaysLeft: 12 }),
      register: () => delay({ signedIn: true, online: true, configured: false, user: { username: 'Steve' }, offlineDaysLeft: 30 }),
      login: () => delay({ signedIn: true, online: true, configured: false, user: { username: 'Steve' }, offlineDaysLeft: 30 }),
      logout: () => delay({ signedIn: false, online: false, configured: false, user: null }),
      changePassword: () => delay({ signedIn: true, online: true, configured: false, user: { username: 'Steve' }, offlineDaysLeft: 30 }),
      friends: () => delay({ friends: [] }),
      addFriend: () => delay({ ok: true }),
    },
    loader: {
      versions: () => delay([]),
      available: () => delay([
        { id: 'vanilla', label: 'Vanilla', versions: [], available: true },
        { id: 'fabric', label: 'Fabric', versions: [{ id: '0.16.9', stable: true }, { id: '0.16.5', stable: true }], available: true },
        { id: 'quilt', label: 'Quilt', versions: [{ id: '0.26.0', stable: true }], available: true },
        { id: 'forge', label: 'Forge', versions: [{ id: '47.3.0', stable: true }, { id: '47.2.0', stable: true }], available: true },
        { id: 'neoforge', label: 'NeoForge', versions: [], available: false },
      ]),
      plan: () => delay({
        instanceId: 'fab-1', name: 'Fabulously Optimized', mcVersion: '1.21.1',
        from: { loader: 'fabric', label: 'Fabric', version: '0.16.5' },
        to: { loader: 'forge', label: 'Forge' },
        mods: 96, modsCompatible: false, backupName: 'mods_backup_fabric',
        keeps: ['saves', 'options.txt', 'resourcepacks', 'shaderpacks', 'screenshots', 'config'],
      }),
      apply: () => delay({
        instance: instances[0], from: 'fabric', to: 'forge', versionId: 'forge-47.3.0-1.21.1',
        mods: { action: 'backup', moved: 96, to: 'mods_backup_fabric' }, removedOldProfile: true,
      }, 500),
    },
    modpacks: { install: () => delay({}) },
  };

  /**
   * То, что здесь не описано, возвращает пустоту вместо падения:
   * заглушка не должна ломаться каждый раз, когда в preload появляется новый метод.
   */
  const forgiving = (obj, name) => new Proxy(obj, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key !== 'string') return undefined;
      return (...args) => {
        console.warn('mock-api: ' + name + '.' + key + ' не описан', args);
        return delay(null);
      };
    },
  });

  for (const [group, value] of Object.entries(window.api)) {
    if (value && typeof value === 'object') window.api[group] = forgiving(value, group);
  }
})();
