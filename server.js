
// Servidor do painel: sem dependências (precisa de Node 18+).
// Uso: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Lê o arquivo .env
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
    .split(/\r?\n/).forEach(l => {
      const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || l.trim().startsWith('#')) return;
      let v = m[2].replace(/^(['"])(.*)\1$/, '$2');
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    });
} catch (e) {
  console.log('Aviso: .env não encontrado, usando valores padrão.');
}

const E = process.env;
const PORT = E.PORT || 3000;
const TZ = E.TIMEZONE || 'America/Sao_Paulo';

const CONFIG = {
  nome: E.HOSPITAL_NOME || 'HOSPITAL',
  tz: TZ,
  locais: (E.LOCAIS || 'Triagem,Consultório 1')
    .split(',').map(x => x.trim()).filter(Boolean),
  frases: (E.FRASES || 'Acolhimento não tem pressa.')
    .split('|').map(x => x.trim().replace(/\/\//g, '<br>')).filter(Boolean)
};

const LAT = E.LATITUDE || '-25.14';
const LON = E.LONGITUDE || '-54.40';
const KEY = (E.OPEN_METEO_API_KEY || '').trim();
const CLIMA_MS = Math.max(1, Number(E.CLIMA_CACHE_MIN) || 10) * 60 * 1000;

let climaCache = { temp: null, ts: 0 };

const DATA = path.join(__dirname, 'data.json');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

const CORES = ['azul', 'verde', 'amarelo', 'laranja'];

// Estado inicial
let state = {
  fila: [],
  hist: [],
  call: null,
  seq: 0,
  audio: {
    enabled: false,
    paused: false,
    testSeq: 0
  }
};

try {
  state = Object.assign(
    state,
    JSON.parse(fs.readFileSync(DATA, 'utf8'))
  );
} catch (e) {}

// Garante que o estado de áudio exista mesmo em dados antigos
state.audio = Object.assign(
  {
    enabled: false,
    paused: false,
    testSeq: 0
  },
  state.audio || {}
);

const clients = new Set();

const hora = () => new Date().toLocaleTimeString('pt-BR', {
  timeZone: TZ,
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit'
});

function publish() {
  try {
    fs.writeFileSync(DATA, JSON.stringify(state));
  } catch (e) {}

  const msg = 'data: ' + JSON.stringify(state) + '\n\n';

  clients.forEach(res => res.write(msg));
}

function body(req) {
  return new Promise(resolve => {
    let b = '';

    req.on('data', c => {
      b += c;
      if (b.length > 1e5) req.destroy();
    });

    req.on('end', () => {
      try {
        resolve(JSON.parse(b || '{}'));
      } catch (e) {
        resolve({});
      }
    });
  });
}

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json'
  });

  res.end(JSON.stringify(obj));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // Eventos em tempo real
  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    res.write(
      'retry: 2000\ndata: ' +
      JSON.stringify(state) +
      '\n\n'
    );

    clients.add(res);

    const ping = setInterval(() => {
      res.write(': ping\n\n');
    }, 25000);

    req.on('close', () => {
      clients.delete(res);
      clearInterval(ping);
    });

    return;
  }

  if (p === '/api/state' && req.method === 'GET') {
    return json(res, 200, state);
  }

  if (p === '/api/config') {
    return json(res, 200, CONFIG);
  }

  // Clima
  if (p === '/api/clima') {
    if (
      climaCache.temp === null ||
      Date.now() - climaCache.ts > CLIMA_MS
    ) {
      try {
        const base = KEY
          ? 'https://customer-api.open-meteo.com'
          : 'https://api.open-meteo.com';

        const u = base +
          '/v1/forecast?latitude=' + LAT +
          '&longitude=' + LON +
          '&current=temperature_2m&timezone=' +
          encodeURIComponent(TZ) +
          (KEY ? '&apikey=' + encodeURIComponent(KEY) : '');

        const r = await fetch(u);
        const d = await r.json();

        if (typeof d.current?.temperature_2m === 'number') {
          climaCache = {
            temp: d.current.temperature_2m,
            ts: Date.now()
          };
        } else {
          console.log(
            'Open-Meteo respondeu sem temperatura:',
            d.reason || r.status
          );
        }
      } catch (e) {
        console.log('Falha ao consultar Open-Meteo:', e.message);
      }
    }

    return climaCache.temp === null
      ? json(res, 502, { erro: 'clima indisponível' })
      : json(res, 200, { temp: climaCache.temp });
  }

  // Adicionar paciente à fila
  if (p === '/api/fila' && req.method === 'POST') {
    const b = await body(req);
    const nome = String(b.nome || '').trim().slice(0, 40);

    if (!nome || !CORES.includes(b.cor)) {
      return json(res, 400, { erro: 'dados inválidos' });
    }

    state.fila.push({
      id: 'p' + Date.now() + Math.random().toString(36).slice(2, 5),
      nome,
      cor: b.cor,
      hora: hora(),
      ts: Date.now()
    });

    publish();

    return json(res, 200, { ok: true });
  }

  // Remover paciente
  if (p.startsWith('/api/fila/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.slice(10));

    state.fila = state.fila.filter(x => x.id !== id);

    publish();

    return json(res, 200, { ok: true });
  }

  // CONTROLES DO ÁUDIO
  if (p === '/api/audio' && req.method === 'POST') {
    const b = await body(req);

    if (typeof b.enabled === 'boolean') {
      state.audio.enabled = b.enabled;
    }

    if (typeof b.paused === 'boolean') {
      state.audio.paused = b.paused;
    }

    if (b.test === true) {
      state.audio.enabled = true;
      state.audio.paused = false;
      state.audio.testSeq = (state.audio.testSeq || 0) + 1;
    }

    publish();

    return json(res, 200, {
      ok: true,
      audio: state.audio
    });
  }

  // Chamar paciente
  if (p === '/api/chamar' && req.method === 'POST') {
    const b = await body(req);

    const nome = String(b.nome || '').trim().slice(0, 40);
    const local = String(b.local || '').trim().slice(0, 40);

    if (!nome || !local) {
      return json(res, 400, { erro: 'dados inválidos' });
    }

    const item = b.id
      ? state.fila.find(x => x.id === b.id)
      : null;

    const cor = item
      ? item.cor
      : (CORES.includes(b.cor) ? b.cor : null);

    if (b.id) {
      state.fila = state.fila.filter(x => x.id !== b.id);
    }

    const h = hora();

    state.hist.unshift({
      nome,
      local,
      cor,
      hora: h
    });

    state.hist = state.hist.slice(0, 30);

    state.call = {
      nome,
      local,
      cor,
      hora: h,
      seq: ++state.seq
    };

    publish();

    return json(res, 200, { ok: true });
  }

  // Limpar histórico
  if (p === '/api/limpar' && req.method === 'POST') {
    state.hist = [];
    state.call = null;

    publish();

    return json(res, 200, { ok: true });
  }

  // Arquivos estáticos
  let f = p === '/' ? '/painel.html' : p;

  f = path.normalize(path.join(__dirname, f));

  const ok = [
    '.html',
    '.css',
    '.js',
    '.webmanifest'
  ].includes(path.extname(f)) &&
    f.startsWith(__dirname) &&
    path.basename(f) !== 'server.js';

  if (!ok) {
    res.writeHead(404);
    return res.end('Não encontrado');
  }

  fs.readFile(f, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Não encontrado');
    }

    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(f)] || 'text/plain'
    });

    res.end(data);
  });

}).listen(PORT, '0.0.0.0', () => {
  console.log('\nPainel rodando!\n');

  console.log('  Neste PC:    http://localhost:' + PORT + '/painel.html');

  Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i.family === 'IPv4' && !i.internal)
    .forEach(i => {
      console.log(
        '  Na rede:     http://' +
        i.address +
        ':' + PORT +
        '/painel.html   (recepção: /recepcao.html)'
      );
    });

  console.log(
    '  Open-Meteo:  ' +
    (KEY ? 'com chave (API comercial)' : 'sem chave (API gratuita)')
  );

  console.log('');
});
