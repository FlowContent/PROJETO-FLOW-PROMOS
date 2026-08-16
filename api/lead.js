// Vercel Serverless Function — API de Conversões da Meta (server-side)
// Recebe o clique nos botões de grupo e reenvia o evento Lead direto para a Meta.
// O event_id é o mesmo do pixel do navegador, entao a Meta conta UMA vez so.
//
// Variaveis de ambiente necessarias (Vercel > Settings > Environment Variables):
//   META_CAPI_TOKEN        (obrigatoria) token de acesso do System User
//   META_PIXEL_ID          (opcional)    padrao: 1338420338279998
//   META_TEST_EVENT_CODE   (opcional)    so durante testes, remover depois

const GRAPH_VERSION = 'v21.0';
const PIXEL_PADRAO = '1338420338279998';

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

  const token = process.env.META_CAPI_TOKEN;
  const pixelId = process.env.META_PIXEL_ID || PIXEL_PADRAO;
  const testCode = process.env.META_TEST_EVENT_CODE || '';

  if (!token) {
    // Nao derruba o site: apenas registra e responde. O pixel do navegador segue funcionando.
    console.error('[capi] META_CAPI_TOKEN ausente — evento nao enviado');
    return res.status(500).json({ erro: 'token_ausente' });
  }

  let corpo = req.body;
  if (typeof corpo === 'string') {
    try { corpo = JSON.parse(corpo); } catch (e) { corpo = null; }
  }
  if (!corpo || typeof corpo !== 'object') return res.status(400).json({ erro: 'corpo_invalido' });

  const eventId = corpo.event_id;
  if (!eventId) return res.status(400).json({ erro: 'event_id_ausente' });

  const cookies = lerCookies(req.headers.cookie);
  const fbp = corpo.fbp || cookies._fbp || undefined;
  const fbc = corpo.fbc || cookies._fbc || undefined;

  const encaminhado = String(req.headers['x-forwarded-for'] || '');
  const ip = encaminhado.split(',')[0].trim() || undefined;
  const ua = req.headers['user-agent'] || undefined;

  const userData = {};
  if (ip) userData.client_ip_address = ip;
  if (ua) userData.client_user_agent = ua;
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  const evento = {
    event_name: 'Lead',
    event_time: Math.floor(Date.now() / 1000),
    event_id: String(eventId),
    action_source: 'website',
    user_data: userData
  };
  if (corpo.event_source_url) evento.event_source_url = String(corpo.event_source_url);

  const custom = {};
  if (corpo.content_name) custom.content_name = String(corpo.content_name);
  if (corpo.content_category) custom.content_category = String(corpo.content_category);
  if (Object.keys(custom).length) evento.custom_data = custom;

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
      console.error('[capi] Meta recusou', r.status, JSON.stringify(dados));
      return res.status(502).json({ erro: 'meta_recusou', status: r.status, detalhe: dados });
    }
    return res.status(200).json({ ok: true, recebidos: dados.events_received, event_id: eventId });
  } catch (e) {
    console.error('[capi] falha ao chamar a Meta:', e && e.message);
    return res.status(502).json({ erro: 'falha_de_rede' });
  }
};
