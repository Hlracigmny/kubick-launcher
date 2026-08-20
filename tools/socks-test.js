// Стенд для клиента SOCKS5 и ретранслятора: свой SOCKS-сервер + эхо-сервер, без интернета.
const net = require('net');
const proxyMod = require('../src/main/proxy.js');

function startEcho() {
  return new Promise((resolve) => {
    const s = net.createServer((c) => {
      c.on('data', (d) => c.write(Buffer.concat([Buffer.from('echo:'), d])));
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
  });
}

// Минимальный SOCKS5: без авторизации либо логин/пароль, только CONNECT по имени.
function startSocks({ requireAuth = false, user = 'u', pass = 'p' } = {}) {
  const seen = [];
  const server = net.createServer((client) => {
    let stage = 'greeting';
    let buf = Buffer.alloc(0);
    client.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'greeting') {
        if (buf.length < 2) return;
        const n = buf[1];
        if (buf.length < 2 + n) return;
        const methods = [...buf.subarray(2, 2 + n)];
        buf = buf.subarray(2 + n);
        if (requireAuth) {
          if (!methods.includes(2)) { client.end(Buffer.from([5, 0xff])); return; }
          client.write(Buffer.from([5, 2]));
          stage = 'auth';
        } else {
          client.write(Buffer.from([5, 0]));
          stage = 'request';
        }
      }
      if (stage === 'auth') {
        if (buf.length < 2) return;
        const ulen = buf[1];
        if (buf.length < 2 + ulen + 1) return;
        const plen = buf[2 + ulen];
        if (buf.length < 3 + ulen + plen) return;
        const gotUser = buf.subarray(2, 2 + ulen).toString();
        const gotPass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
        buf = buf.subarray(3 + ulen + plen);
        const ok = gotUser === user && gotPass === pass;
        client.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) { client.end(); return; }
        stage = 'request';
      }
      if (stage === 'request') {
        if (buf.length < 5) return;
        const atyp = buf[3];
        if (atyp !== 3) { client.end(Buffer.from([5, 8, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
        const len = buf[4];
        if (buf.length < 5 + len + 2) return;
        const host = buf.subarray(5, 5 + len).toString();
        const port = buf.readUInt16BE(5 + len);
        buf = buf.subarray(5 + len + 2);
        seen.push(host + ':' + port);

        const upstream = net.connect({ host: host === 'target.test' ? '127.0.0.1' : host, port }, () => {
          // Отвечаем адресом привязки в виде домена — проверяем и эту ветку разбора
          const name = Buffer.from('bind.local');
          client.write(Buffer.concat([
            Buffer.from([5, 0, 0, 3, name.length]), name, Buffer.from([0, 80]),
          ]));
          stage = 'pipe';
          if (buf.length) upstream.write(buf);
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on('error', () => { client.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0])); });
      }
    });
    client.on('error', () => client.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, seen }));
  });
}

function talk(host, port, message) {
  return new Promise((resolve, reject) => {
    const c = net.connect({ host, port }, () => c.write(message));
    c.once('data', (d) => { c.destroy(); resolve(d.toString()); });
    c.once('error', reject);
    setTimeout(() => { c.destroy(); reject(new Error('таймаут')); }, 5000);
  });
}

(async () => {
  const results = [];
  const echo = await startEcho();

  /* 1. Туннель без авторизации */
  const plain = await startSocks();
  const sock = await proxyMod.socksConnect(
    { host: '127.0.0.1', port: plain.port }, 'target.test', echo.port);
  const answer = await new Promise((res) => { sock.once('data', (d) => res(d.toString())); sock.write('ping'); });
  results.push(['туннель SOCKS5 без авторизации', answer === 'echo:ping', answer]);
  results.push(['адрес ушёл именем, не IP', plain.seen[0] === 'target.test:' + echo.port, plain.seen[0]]);
  sock.destroy();

  /* 2. Туннель с логином и паролем */
  const authed = await startSocks({ requireAuth: true });
  const sock2 = await proxyMod.socksConnect(
    { host: '127.0.0.1', port: authed.port, username: 'u', password: 'p' }, 'target.test', echo.port);
  const answer2 = await new Promise((res) => { sock2.once('data', (d) => res(d.toString())); sock2.write('auth'); });
  results.push(['туннель с логином и паролем', answer2 === 'echo:auth', answer2]);
  sock2.destroy();

  /* 3. Неверный пароль отклоняется понятной ошибкой */
  try {
    await proxyMod.socksConnect(
      { host: '127.0.0.1', port: authed.port, username: 'u', password: 'wrong' }, 'target.test', echo.port);
    results.push(['неверный пароль отклонён', false, 'соединение прошло']);
  } catch (e) {
    results.push(['неверный пароль отклонён', /логин или пароль/.test(e.message), e.message]);
  }

  /* 4. Ретранслятор: игра идёт на 127.0.0.1, наружу — через прокси */
  proxyMod.add({ host: '127.0.0.1', port: plain.port, label: 'Стенд' });
  const entry = proxyMod.list().find((p) => p.label === 'Стенд');
  proxyMod.start(entry.id);
  const relay = await proxyMod.relayFor('target.test', echo.port);
  const answer3 = await talk(relay.host, relay.port, 'through-relay');
  results.push(['ретранслятор доводит трафик до сервера', answer3 === 'echo:through-relay', answer3]);
  results.push(['ретранслятор слушает только 127.0.0.1', relay.host === '127.0.0.1', relay.host]);

  const again = await proxyMod.relayFor('target.test', echo.port);
  results.push(['повторный вызов переиспользует порт', again.port === relay.port, String(again.port)]);
  results.push(['статус показывает подключение', proxyMod.status().connected === true, JSON.stringify(proxyMod.status().relays)]);

  proxyMod.stop();
  results.push(['после отключения ретрансляторов нет', proxyMod.status().connected === false, '']);
  results.push(['выключенный режим не даёт адрес', (await proxyMod.relayFor('target.test', echo.port)) === null, '']);

  /* 5. Мёртвый прокси даёт ошибку, а не зависание */
  try {
    await proxyMod.socksConnect({ host: '127.0.0.1', port: 1 }, 'target.test', 80, 2000);
    results.push(['мёртвый прокси даёт ошибку', false, 'соединение прошло']);
  } catch (e) {
    results.push(['мёртвый прокси даёт ошибку', /прокси/i.test(e.message), e.message]);
  }

  let failed = 0;
  for (const [name, ok, detail] of results) {
    if (!ok) failed++;
    console.log((ok ? '  OK   ' : '  FAIL ') + name + (ok ? '' : '  -> ' + detail));
  }
  console.log(failed ? '\n' + failed + ' проверок не прошло' : '\nВсе проверки прошли');

  echo.server.close(); plain.server.close(); authed.server.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('СБОЙ СТЕНДА:', e); process.exit(1); });
