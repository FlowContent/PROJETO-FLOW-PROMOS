// Vercel Serverless Function — API de Conversões da Meta (server-side)
// Recebe o clique nos botões de grupo e reenvia o evento Lead direto para a Meta.
// O event_id é o mesmo do pixel do navegador, entao a Meta conta UMA vez so.
//
// Variaveis de ambiente (Vercel > Settings > Environment Variables):
//   META_CAPI_TOKEN        (obrigatoria) token de acesso do System User
//   META_PIXEL_ID          (opcional)    padrao: 1338420338279998
//   META_TEST_EVENT_CODE   (opcional)    so durante testes, remover depois
//   ALLOWED_ORIGINS        (opcional)    dominios aceitos, separados por virgula

const GRAPH_VERSION = 'v21.0';
const PIXEL_PADRAO = '1338420338279998';

// Só estes grupos existem na pagina. Qualquer outro valor e requisicao forjada.
const GRUPOS_VALIDOS = ['FLOW FIT', 'FLOW CUIUDOS', 'FLOW ODONTO', 'FLOW MAMAES'];

const ORIGENS_PADRAO = [
  'https://flowcontentpromos.shop',
  'https://www.flowcontentpromos.shop'
];

// Limite por IP. Instancias serverless sao efemeras, entao isto e um freio de
// mao — nao uma trava perfeita. Ainda assim corta abuso automatizado simples.
const JANELA_MS = 60 * 1000;
const MAX_POR_JANELA = 12;
const contador = new Map();

function origensPermitidas() {
  const env = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  return env.length ? env : ORIGENS_PADRAO;
}

function origemValida(req) {
  const permitidas = origensPermitidas();
  const origin = req.headers.origin;
  if (origin) return permitidas.includes(origin);

  // Alguns navegadores omitem Origin; cai para o Referer.
  const referer = req.headers.referer || req.headers.referrer;
  if (referer) {
    try { return permitidas.includes(new URL(referer).origin); } catch (e) { return false; }
  }
  // Sem nenhum dos dois: nao da para confirmar que veio do site. Recusa.
  return false;
}

function excedeuLimite(ip) {
  if (!ip) return false;
  const agora = Date.now();
  const registro = contador.get(ip);
  if (!registro || agora - registro.inicio > JANELA_MS) {
    contador.set(ip, { inicio: agora, n: 1 });
    if (contador.size > 5000) contador.clear(); // evita crescer sem limite
    return false;
  }
  registro.n += 1;
  return registro.n > MAX_POR_JANELA;
}

function lerCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(function (parte) {
    const i = parte.indexOf('=');
    if (i > 0) out[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  });
  return out;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ erro: 'metodo_nao_permitido' });
  }

  if (!origemValida(req)) return res.status(403).json({ erro: 'origem_nao_permitida' });

  const encaminhado = String(req.headers['x-forwarded-for'] || '');
  const ip = encaminhado.split(',')[0].trim() || undefined;
  if (excedeuLimite(ip)) return res.status(429).json({ erro: 'muitas_requisicoes' });

  const token = process.env.META_CAPI_TOKEN;
  const pixelId = process.env.META_PIXEL_ID || PIXEL_PADRAO;
  const testCode = process.env.META_TEST_EVENT_CODE || '';

  if (!token) {
    console.error('[capi] META_CAPI_TOKEN ausente — evento nao enviado');
    return res.status(500).json({ erro: 'token_ausente' });
  }

  let corpo = req.body;
  if (typeof corpo === 'string') {
    if (corpo.length > 4000) return res.status(413).json({ erro: 'corpo_grande_demais' });
    try { corpo = JSON.parse(corpo); } catch (e) { corpo = null; }
  }
  if (!corpo || typeof corpo !== 'object') return res.status(400).json({ erro: 'corpo_invalido' });

  const eventId = corpo.event_id;
  if (typeof eventId !== 'string' || !/^lead-\d{10,}-[a-z0-9]{4,16}$/.test(eventId)) {
    return res.status(400).json({ erro: 'event_id_invalido' });
  }

  const grupo = corpo.content_name;
  if (!GRUPOS_VALIDOS.includes(grupo)) return res.status(400).json({ erro: 'grupo_invalido' });

  const cookies = lerCookies(req.headers.cookie);
  const fbp = corpo.fbp || cookies._fbp || undefined;
  const fbc = corpo.fbc || cookies._fbc || undefined;
  const ua = req.headers['user-agent'] || undefined;

  const userData = {};
  if (ip) userData.client_ip_address = ip;
  if (ua) userData.client_user_agent = ua;
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  const evento = {
    event_name: 'Lead',
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    action_source: 'website',
    user_data: userData,
    custom_data: { content_name: grupo }
  };
  if (corpo.content_category) evento.custom_data.content_category = String(corpo.content_category).slice(0, 60);
  if (corpo.event_source_url) evento.event_source_url = String(corpo.event_source_url).slice(0, 500);

  const payload = { data: [evento] };
  if (testCode) payload.test_event_code = testCode;

  const url = 'https://graph.facebook.com/' + GRAPH_VERSION + '/' + pixelId +
              '/events?access_token=' + encodeURIComponent(token);

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const dados = await r.json().catch(function () { return {}; });

    if (!r.ok) {
      // Loga o detalhe no servidor, mas nao devolve ao cliente.
      console.error('[capi] Meta recusou', r.status, JSON.stringify(dados));
      return res.status(502).json({ erro: 'meta_recusou' });
    }
    return res.status(200).json({ ok: true, recebidos: dados.events_received });
  } catch (e) {
    console.error('[capi] falha ao chamar a Meta:', e && e.message);
    return res.status(502).json({ erro: 'falha_de_rede' });
  }
};
