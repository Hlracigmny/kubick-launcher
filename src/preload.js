'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Каждый invoke возвращает {ok, data|error}; здесь это разворачивается в промис,
// чтобы в UI работал обычный try/catch.
function call(channel, payload) {
  return ipcRenderer.invoke(channel, payload).then((res) => {
    if (!res) throw new Error('Пустой ответ от ' + channel);
    if (!res.ok) throw new Error(res.error || 'Неизвестная ошибка');
    return res.data;
  });
}

function on(channel, handler) {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('api', {
  app: {
    info: () => call('app:info'),
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    quit: () => ipcRenderer.send('app:quit'),
    openExternal: (url) => call('shell:openExternal', { url }),
    reveal: (which) => call('settings:reveal', which),
  },
  settings: {
    get: () => call('settings:get'),
    save: (patch) => call('settings:save', patch),
    reset: () => call('settings:reset'),
  },
  versions: {
    list: (opts) => call('versions:list', opts),
    loader: (loader, mcVersion) => call('loader:versions', { loader, mcVersion }),
  },
  instances: {
    list: () => call('instances:list'),
    create: (payload) => call('instances:create', payload),
    update: (id, patch) => call('instances:update', { id, patch }),
    remove: (id, deleteFiles) => call('instances:delete', { id, deleteFiles }),
    duplicate: (id, name) => call('instances:duplicate', { id, name }),
    repair: (id) => call('instances:repair', { id }),
    openFolder: (id, sub) => call('instances:openFolder', { id, sub }),
  },
  game: {
    launch: (id) => call('game:launch', { id }),
    stop: (id) => call('game:stop', { id }),
    running: () => call('game:running'),
    log: (id) => call('logs:read', { id }),
  },
  accounts: {
    list: () => call('accounts:list'),
    addOffline: (name) => call('accounts:addOffline', { name }),
    msStart: () => call('accounts:msStart'),
    msCancel: () => call('accounts:msCancel'),
    remove: (id) => call('accounts:remove', { id }),
    setActive: (id) => call('accounts:setActive', { id }),
  },
  java: {
    scan: () => call('java:scan'),
    install: (major) => call('java:install', { major }),
    pick: () => call('java:pick'),
  },
  mods: {
    search: (opts) => call('mods:search', opts),
    versions: (opts) => call('mods:versions', opts),
    install: (instanceId, version, projectType) => call('mods:install', { instanceId, version, projectType }),
    installed: (instanceId) => call('mods:installed', { instanceId }),
    toggle: (filePath, enabled) => call('mods:toggle', { filePath, enabled }),
    remove: (filePath) => call('mods:remove', { filePath }),
  },
  inst: {
    mods: (id) => call('inst:mods', { id }),
    packs: (id, sub) => call('inst:packs', { id, sub }),
    worlds: (id) => call('inst:worlds', { id }),
    screenshots: (id) => call('inst:screenshots', { id }),
    logs: (id) => call('inst:logs', { id }),
    readLog: (file) => call('inst:readLog', { file }),
    notes: (id) => call('inst:notes', { id }),
    saveNotes: (id, text) => call('inst:saveNotes', { id, text }),
    components: (id) => call('inst:components', { id }),
    pingServers: (addresses) => call('inst:pingServers', { addresses }),
    addFiles: (id, sub, kind) => call('inst:addFiles', { id, sub, kind }),
    openFile: (file) => call('inst:openFile', { file }),
    showFile: (file) => call('inst:showFile', { file }),
    deleteFile: (file, recursive) => call('inst:deleteFile', { file, recursive }),
  },
  vpn: {
    countries: (force) => call('vpn:countries', { force }),
    servers: (code) => call('vpn:servers', { code }),
    status: () => call('vpn:status'),
    saveConfig: (id) => call('vpn:saveConfig', { id }),
    connect: (id) => call('vpn:connect', { id }),
    disconnect: () => call('vpn:disconnect'),
    openFolder: () => call('vpn:openFolder'),
  },
  themes: {
    status: () => call('themes:status'),
    ensure: (id, force) => call('themes:ensure', { id, force }),
    photo: (id) => call('themes:photo', { id }),
    clear: (id) => call('themes:clear', { id }),
  },
  friends: {
    status: () => call('friends:status'),
    add: (code, nick) => call('friends:add', { code, nick }),
    remove: (code) => call('friends:remove', { code }),
  },
  background: {
    pick: () => call('bg:pick'),
    image: (name) => call('bg:image', { name }),
    clear: (name) => call('bg:clear', { name }),
  },
  lan: {
    status: () => call('lan:status'),
    servers: (instanceId) => call('lan:servers', { instanceId }),
    addServer: (instanceId, name, ip) => call('lan:addServer', { instanceId, name, ip }),
    removeServer: (instanceId, ip) => call('lan:removeServer', { instanceId, ip }),
  },
  modpacks: {
    install: (source, version, name) => call('modpacks:install', { source, version, name }),
  },
  fonts: {
    list: () => call('fonts:list'),
    install: (id) => call('fonts:install', { id }),
    remove: (id) => call('fonts:remove', { id }),
    css: (id) => call('fonts:css', { id }),
  },
  updates: {
    status: () => call('updates:status'),
    check: () => call('updates:check'),
    download: () => call('updates:download'),
    install: () => call('updates:install'),
  },
  events: {
    onProgress: (h) => on('task:progress', h),
    onGameLog: (h) => on('game:log', h),
    onGameStarted: (h) => on('game:started', h),
    onGameExit: (h) => on('game:exit', h),
    onMsaDone: (h) => on('accounts:msDone', h),
    onUpdate: (h) => on('updates:changed', h),
    onLan: (h) => on('lan:changed', h),
    onFriends: (h) => on('friends:changed', h),
    onVpn: (h) => on('vpn:changed', h),
  },
});
