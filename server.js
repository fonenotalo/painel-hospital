// Servidor do painel: Node 18+ com PostgreSQL (Render).
// Uso: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Pool } = require('pg');

// Lê o arquivo .env
try {
  fs.readFileSync(path.join(__dirname, '.env'), 'utf8')
    .split(/\r?\n/).forEach(l => {
      const m = l.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || l.trim().startsWith('#')) return;
      let v = m[2].replace(/^(['\"])(.*)\1$/, '$2');
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

// Pool de conexão PostgreSQL
const pool = new Pool({
  connectionString: E.DATABASE_URL,
  ssl: E.DATABASE_URL && E.DATABASE_URL.includes('render.com')
    ? { rejectUnauthorized: false }
    : false
});

const DATA = path.join(__dirname, 'data.json');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
};

const CORES = ['azul', 'verde', 'amarelo', 'laranja'];

// Inicializa tabelas no banco
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS state_meta (
        key TEXT PRIMARY KEY,
        value JSONB NOT NULL
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS fila (
        id TEXT PRIMARY KEY,
        nome TEXT NOT NULL,
        cor TEXT NOT NULL,
        hora TEXT NOT NULL,
        ts BIGINT NOT NULL
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS historico (
        id SERIAL PRIMARY KEY,
        nome TEXT NOT NULL,
        local TEXT NOT NULL,
        cor TEXT,
        hora TEXT NOT NULL,
        criado_em TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS chamada (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        nome TEXT,
        local TEXT,
        cor TEXT,
        hora TEXT,
        seq INTEGER DEFAULT 0,
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS configuracao_geral (
        id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
        audio JSONB NOT NULL DEFAULT '{"enabled":false,"paused":false,"testSeq":0}',
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Insere registro vazio da chamada se não existir
    await client.query(`
      INSERT INTO chamada (id, nome, local, cor, hora, seq)
      VALUES (1, NULL, NULL, NULL, NULL, 0)
      ON CONFLICT (id) DO NOTHING;
    `);
    // Insere configuração geral se não existir
    await client.query(`
      INSERT INTO configuracao_geral (id, audio)
      VALUES (1, '{"enabled":false,"paused":false,"testSeq":0}'::jsonb)
      ON CONFLICT (id) DO NOTHING;
    `);
  } finally {
    client.release();
  }
}

// Carrega estado do banco
async function loadState() {
  const client = await pool.connect();
  try {
    // Meta (seq, etc.)
    const metaRes = await client.query("SELECT value FROM state_meta WHERE key = 'app'");
    let seq = 0;
    if (metaRes.rows.length > 0) {
      seq = metaRes.rows[0].value.seq || 0;
    }

    // Fila
    const filaRes = await client.query('SELECT id, nome, cor, hora, ts FROM fila ORDER BY ts ASC');
    const fila = filaRes.rows.map(r => ({
      id: r.id,
      nome: r.nome,
      cor: r.cor,
      hora: r.hora,
      ts: r.ts
    }));

    // Histórico (últimos 30)
    const histRes = await client.query(
      'SELECT nome, local, cor, hora FROM historico ORDER BY criado_em DESC LIMIT 30'
    );
    const hist = histRes.rows.map(r => ({
      nome: r.nome,
      local: r.local,
      cor: r.cor,
      hora: r.hora
    }));

    // Chamada atual
    const callRes = await client.query('SELECT nome, local, cor, hora, seq FROM chamada WHERE id = 1');
    let call = null;
    if (callRes.rows.length > 0 && callRes.rows[0].nome) {
      call = {
        nome: callRes.rows[0].nome,
        local: callRes.rows[0].local,
        cor: callRes.rows[0].cor,
        hora: callRes.rows[0].hora,
        seq: callRes.rows[0].seq
      };
    }

    // Áudio
    const audioRes = await client.query('SELECT audio FROM configuracao_geral WHERE id = 1');
    let audio = { enabled: false, paused: false, testSeq: 0 };
    if (audioRes.rows.length > 0) {
      const a = audioRes.rows[0].audio;
      audio = {
        enabled: a.enabled !== undefined ? a.enabled : false,
        paused: a.paused !== undefined ? a.paused : false,
        testSeq: a.testSeq !== undefined ? a.testSeq : 0
      };
    }

    return { fila, hist, call, seq, audio };
  } finally {
    client.release();
  }
}

// Salva estado completo no banco (usado após cada mutação)
async function persistState(state) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Atualiza meta
    await client.query(
      `INSERT INTO state_meta (key, value) VALUES ('app', $1::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = $1::jsonb`,
      [JSON.stringify({ seq: state.seq })]
    );

    // Substitui fila inteira
    await client.query('DELETE FROM fila');
    for (const item of state.fila) {
      await client.query(
        `INSERT INTO fila (id, nome, cor, hora, ts) VALUES ($1, $2, $3, $4, $5)`,
        [item.id, item.nome, item.cor, item.hora, item.ts]
      );
    }

    // Atualiza chamada
    if (state.call) {
      await client.query(
        `UPDATE chamada SET nome = $1, local = $2, cor = $3, hora = $4, seq = $5, atualizado_em = NOW() WHERE id = 1`,
        [state.call.nome, state.call.local, state.call.cor, state.call.hora, state.call.seq]
      );
    } else {
      await client.query(
        `UPDATE chamada SET nome = NULL, local = NULL, cor = NULL, hora = NULL, atualizado_em = NOW() WHERE id = 1`
      );
    }

    // Atualiza áudio
    await client.query(
      `UPDATE configuracao_geral SET audio = $1::jsonb, atualizado_em = NOW() WHERE id = 1`,
      [JSON.stringify(state.audio)]
    );

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Insere um item no histórico
async function addHistorico(item) {
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO historico (nome, local, cor, hora) VALUES ($1, $2, $3, $4)`,
      [item.nome, item.local, item.cor, item.hora]
    );
    // Mantém apenas os últimos 30
    await client.query(`
      DELETE FROM historico
      WHERE id NOT IN (
        SELECT id FROM historico ORDER BY criado_em DESC LIMIT 30
      )
    `);
  } finally {
    client.release();
  }
}

// SSE clients
const clients = new Set();

const hora = () => new Date().toLocaleTimeString('pt-BR', {
  timeZone: TZ,
  hourCycle: 'h23',
  hour: '2-digit',
  minute: '2-digit'
});

function publish(state) {
  const msg = 'data: ' + JSON.stringify(state) + '\n\n';
  clients.forEach(res => {
    try { res.write(msg); } catch (e) {}
  });
}

function body(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => {
      b += c;
      if (b.length > 1e5) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); }
    });
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

let currentState = null;

async function getState() {
  if (!currentState) {
    currentState = await loadState();
  }
  return currentState;
}

async function setState(newState) {
  currentState = newState;
  await persistState(newState);
  publish(newState);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // Inicializa banco na primeira requisição (lazy init)
  try { await initDb(); } catch (e) { console.log('Erro init DB:', e.message); }

  // Eventos em tempo real (SSE)
  if (p === '/api/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive'
    });

    const st = await getState();
    res.write('retry: 2000\ndata: ' + JSON.stringify(st) + '\n\n');

    clients.add(res);

    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch (e) {}
    }, 25000);

    req.on('close', () => {
      clients.delete(res);
      clearInterval(ping);
    });
    return;
  }

  if (p === '/api/state' && req.method === 'GET') {
    return json(res, 200, await getState());
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
          climaCache = { temp: d.current.temperature_2m, ts: Date.now() };
        } else {
          console.log('Open-Meteo respondeu sem temperatura:', d.reason || r.status);
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
    const st = await getState();
    st.fila.push({
      id: 'p' + Date.now() + Math.random().toString(36).slice(2, 5),
      nome,
      cor: b.cor,
      hora: hora(),
      ts: Date.now()
    });
    await setState(st);
    return json(res, 200, { ok: true });
  }

  // Remover paciente
  if (p.startsWith('/api/fila/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.slice(10));
    const st = await getState();
    st.fila = st.fila.filter(x => x.id !== id);
    await setState(st);
    return json(res, 200, { ok: true });
  }

  // CONTROLES DO ÁUDIO
  if (p === '/api/audio' && req.method === 'POST') {
    const b = await body(req);
    const st = await getState();
    if (typeof b.enabled === 'boolean') st.audio.enabled = b.enabled;
    if (typeof b.paused === 'boolean') st.audio.paused = b.paused;
    if (b.test === true) {
      st.audio.enabled = true;
      st.audio.paused = false;
      st.audio.testSeq = (st.audio.testSeq || 0) + 1;
    }
    await setState(st);
    return json(res, 200, { ok: true, audio: st.audio });
  }

  // Chamar paciente
  if (p === '/api/chamar' && req.method === 'POST') {
    const b = await body(req);
    const nome = String(b.nome || '').trim().slice(0, 40);
    const local = String(b.local || '').trim().slice(0, 40);
    if (!nome || !local) {
      return json(res, 400, { erro: 'dados inválidos' });
    }
    const st = await getState();
    const item = b.id ? st.fila.find(x => x.id === b.id) : null;
    const cor = item ? item.cor : (CORES.includes(b.cor) ? b.cor : null);
    if (b.id) {
      st.fila = st.fila.filter(x => x.id !== b.id);
    }
    const h = hora();
    st.hist.unshift({ nome, local, cor, hora: h });
    st.hist = st.hist.slice(0, 30);
    st.call = { nome, local, cor, hora: h, seq: ++st.seq };
    await setState(st);
    await addHistorico({ nome, local, cor, hora: h });
    return json(res, 200, { ok: true });
  }

  // Limpar histórico
  if (p === '/api/limpar' && req.method === 'POST') {
    const st = await getState();
    st.hist = [];
    st.call = null;
    await setState(st);
    return json(res, 200, { ok: true });
  }

  // Arquivos estáticos
  let f = p === '/' ? '/painel.html' : p;
  f = path.normalize(path.join(__dirname, f));
  const ok = [
    '.html', '.css', '.js', '.webmanifest'
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
}).listen(PORT, '0.0.0.0', async () => {
  console.log('\nPainel rodando!');
  console.log('  Neste PC:    http://localhost:' + PORT + '/painel.html');
  Object.values(os.networkInterfaces())
    .flat()
    .filter(i => i.family === 'IPv4' && !i.internal)
    .forEach(i => {
      console.log(
        '  Na rede:     http://' +
        i.address + ':' + PORT +
        '/painel.html   (recepção: /recepcao.html)'
      );
    });
  console.log(
    '  Open-Meteo:  ' +
    (KEY ? 'com chave (API comercial)' : 'sem chave (API gratuita)')
  );
  console.log('  Banco:       PostgreSQL (DATABASE_URL configurado)');
  console.log('');
});
