'use strict';
const os = require('os');

/**
 * Общая часть обнаружения по локальной сети для lan.js и friends.js.
 *
 * Зачем отдельный модуль. Раньше оба слушателя делали `addMembership(GROUP)`
 * без указания интерфейса. Node в этом случае подписывается на группу только
 * на одном интерфейсе — том, который система считает основным. На машине
 * с VPN, Hyper-V, VirtualBox или WSL основным оказывается виртуальный адаптер,
 * и пакеты из настоящей локальной сети просто не приходят: соседний компьютер
 * «не виден», хотя всё работает. Подписываться нужно на каждом интерфейсе.
 *
 * Вторая причина — сети, где мультикаст не проходит вовсе: гостевой Wi-Fi
 * с изоляцией клиентов, часть домашних роутеров, старые сборки Windows
 * с жёсткими правилами брандмауэра. Там помогает широковещательная рассылка,
 * но только для своего протокола: Minecraft вещает открытый мир исключительно
 * мультикастом, и заменить это мы не можем — броадкаст добавляется как
 * дополнение к мультикасту, а не вместо него.
 */

/** Все пригодные IPv4-интерфейсы машины: адрес и широковещательный адрес. */
function ipv4Interfaces() {
  const out = [];
  const all = os.networkInterfaces();
  for (const [name, list] of Object.entries(all)) {
    for (const iface of list || []) {
      if (iface.family !== 'IPv4' && iface.family !== 4) continue;
      if (iface.internal) continue;
      out.push({ name, address: iface.address, broadcast: broadcastOf(iface.address, iface.netmask) });
    }
  }
  return out;
}

/** Широковещательный адрес подсети: адрес | ~маска. */
function broadcastOf(address, netmask) {
  if (!address || !netmask) return null;
  const a = address.split('.').map(Number);
  const m = netmask.split('.').map(Number);
  if (a.length !== 4 || m.length !== 4 || a.some(Number.isNaN) || m.some(Number.isNaN)) return null;
  return a.map((part, i) => (part | (~m[i] & 0xff))).join('.');
}

/**
 * Подписывает сокет на мультикаст-группу на каждом интерфейсе.
 * Возвращает, где получилось: пустой список означает, что мультикаст недоступен,
 * но это ещё не повод считать сеть нерабочей — остаётся броадкаст.
 */
function joinOnAllInterfaces(socket, group) {
  const joined = [];
  const failed = [];

  for (const iface of ipv4Interfaces()) {
    try {
      socket.addMembership(group, iface.address);
      joined.push(iface);
    } catch (e) {
      // Интерфейс без мультикаста (часть VPN-адаптеров) — не повод бросать остальные
      failed.push({ iface, error: e.message });
    }
  }

  // Интерфейсов может не быть вовсе (машина без сети) — тогда пробуем как раньше
  if (!joined.length) {
    try {
      socket.addMembership(group);
      joined.push({ name: 'default', address: null, broadcast: null });
    } catch (e) {
      failed.push({ iface: { name: 'default' }, error: e.message });
    }
  }

  return { joined, failed };
}

/** Куда рассылать своё присутствие: сама группа плюс броадкаст каждой подсети. */
function announceTargets(group) {
  const targets = [group];
  for (const iface of ipv4Interfaces()) {
    if (iface.broadcast && !targets.includes(iface.broadcast)) targets.push(iface.broadcast);
  }
  // 255.255.255.255 доходит там, где подсетевой броадкаст режется
  if (!targets.includes('255.255.255.255')) targets.push('255.255.255.255');
  return targets;
}

/** Человеческое описание состояния — его видно в интерфейсе, а не в логах. */
function describe({ joined, failed }, broadcast) {
  if (joined.length) {
    const names = joined.map((i) => i.name).filter(Boolean);
    return 'Слушаем сеть на ' + joined.length + ' интерфейсе' + (joined.length === 1 ? '' : 'ах') +
      (names.length ? ' (' + names.slice(0, 3).join(', ') + ')' : '');
  }
  if (broadcast) {
    return 'Мультикаст недоступен, работаем через широковещательную рассылку. ' +
      'Открытые миры Minecraft так не находятся — только друзья с этим лаунчером.';
  }
  return 'Сеть недоступна: ' + ((failed[0] && failed[0].error) || 'не удалось подписаться на группу');
}

module.exports = { ipv4Interfaces, broadcastOf, joinOnAllInterfaces, announceTargets, describe };
