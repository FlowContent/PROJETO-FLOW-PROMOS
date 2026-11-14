// Vercel Serverless Function — API de Conversões da Meta (server-side)
// Recebe o clique nos botões de grupo e reenvia o evento Lead direto para a Meta.
// O event_id é o mesmo do pixel do navegador, entao a Meta conta UMA vez so.
//
// Variaveis de ambiente (Vercel > Settings > Environment Variables):
//   META_CAPI_TOKEN        (obrigatoria) token de acesso do System User
//   META_PIXEL_ID          (opcional)    padrao: 1338420338279998
//   META_TEST_EVENT_CODE   (opcional)    IGNORADA em producao de proposito (ver abaixo)
//   ALLOWED_ORIGINS        (opcional)    dominios aceitos, separados por virgula

const GRAPH_VERSION = 'v21.0';
const PIXEL_PADRAO = '1338420338279998';

// Só estes grupos existem na pagina. Qualquer outro valor e requisicao forjada.
// FLOW MAMAES continua aceito de proposito: o grupo virou FLOW BARBER, mas
// paginas ja abertas no navegador de quem esta no site AGORA ainda mandam o
// nome antigo. Sem isso, esses cliques tomariam 400 e o lead seria perdido.
// Pode ser removido depois de alguns dias.
const GRUPOS_VALIDOS = ['A FLOW FIT', 'FLOW FIT', 'FLOW CUIUDOS', 'FLOW ODONTO', 'FLOW BARBER', 'FLOW MAMAES'];

const ORIGENS_PADRAO = [
  'https://flowcontentpromos.shop',
  'https://www.flowcontentpromos.shop'
];

// Limite por IP. Instancias serverless sao efemeras e concorrentes, entao isto e
// um freio de mao contra script bobo — NAO e protecao real. Quem quiser forjar
// lead consegue. A protecao de verdade seria assinar o event_id com HMAC.
const JANELA_MS = 60 * 1000;
const MAX_POR_JANELA = 12;
const contador = new Map();

// Um clique legitimo gera ~450 bytes. 4000 ja e folga larga.
const LIMITE_CORPO = 4000;

// Trava de idempotencia: se o MESMO event_id chegar de novo (beacon repetido,
// retry do navegador, duplo envio em webview), o segundo e descartado antes de
// virar evento na Meta. Instancia serverless e efemera, entao isto pega o caso
// comum (os dois envios caem na mesma instancia quente), nao todos.
const JANELA_IDEMPOTENCIA_MS = 10 * 60 * 1000;
const vistos = new Map();

function jaProcessado(eventId) {
  const agora = Date.now();
  if (vistos.size > 5000) vistos.clear();
  const visto = vistos.get(eventId);
  if (visto && agora - visto < JANELA_IDEMPOTENCIA_MS) return true;
  vistos.set(eventId, agora);
  return false;
}

// Orcamento de tempo para falar com a Meta: 2 tentativas de 3,5s + 0,4s de espera.
const TIMEOUT_META_MS = 3500;
const TENTATIVAS_META = 2;

function origensPermitidas() {
  const brutas = (process.env.ALLOWED_ORIGINS || '').split(',')
    .map(s => s.trim()).filter(Boolean);
  const lista = brutas.length ? brutas : ORIGENS_PADRAO;
  // Normaliza: barra final, maiuscula e caminho extra nao podem quebrar o match.
  return lista.map(function (s) {
    try { return new URL(s).origin; } catch (e) { return ''; }
  }).filter(Boolean);
}

// A checagem de origem so vale contra navegador; curl passa por cima dela.
// Por isso, quando NAO ha sinal nenhum (nem Origin nem Referer) preferimos
// aceitar e registrar: um 403 falso custa o lead inteiro, sem alarme nenhum,
// e o ganho de seguranca seria zero de qualquer jeito.
function origemValida(req) {
  const permitidas = origensPermitidas();

  const origin = req.headers.origin;
  if (origin && origin !== 'null') return permitidas.includes(origin);

  const referer = req.headers.referer;
  if (referer) {
    try { return permitidas.includes(new URL(referer).origin); } catch (e) { return false; }
  }

  console.warn('[capi] sem Origin nem Referer — aceito assim mesmo | ua=',
    req.headers['user-agent'] || '?');
  return true;
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

// decodeURIComponent LANCA em qualquer valor com "%" solto (ex: "promo=50%off").
// Sem o try, um unico cookie ruim no dominio derrubaria todo clique daquele
// navegador com 500 — e de forma invisivel, porque o sendBeacon nao le resposta.
function lerCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(function (parte) {
    const i = parte.indexOf('=');
    if (i <= 0) return;
    const chave = parte.slice(0, i).trim();
    const bruto = parte.slice(i + 1).trim();
    try { out[chave] = decodeURIComponent(bruto); } catch (e) { out[chave] = bruto; }
  });
  return out;
}

// A Meta as vezes devolve 5xx/429 transitorio. Sem retry, o lead some para
// sempre: o sendBeacon nao repete e o cliente nem fica sabendo.
async function postarNaMeta(url, opcoes) {
  let ultimoErro = null;
  for (let tentativa = 0; tentativa < TENTATIVAS_META; tentativa++) {
    try {
      const controle = new AbortController();
      const relogio = setTimeout(function () { controle.abort(); }, TIMEOUT_META_MS);
      try {
        const r = await fetch(url, Object.assign({}, opcoes, { signal: controle.signal }));
        if (r.status < 500 && r.status !== 429) return r; // resposta definitiva
        ultimoErro = new Error('http_' + r.status);
      } finally {
        clearTimeout(relogio);
      }
    } catch (e) {
      ultimoErro = e;
    }
    if (tentativa < TENTATIVAS_META - 1) {
      await new Promise(function (ok) { setTimeout(ok, 400); });
    }
  }
  throw ultimoErro || new Error('falha_desconhecida');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ erro: 'metodo_nao_permitido' });
  }

  if (!origemValida(req)) {
    console.warn('[capi] 403 origem | origin=', req.headers.origin,
      '| referer=', req.headers.referer);
    return res.status(403).json({ erro: 'origem_nao_permitida' });
  }

  // A Vercel sobrescreve x-forwarded-for e nao repassa IP externo, entao o
  // primeiro valor e confiavel (nao da para falsificar por header).
  const encaminhado = String(req.headers['x-forwarded-for'] || '');
  const ip = encaminhado.split(',')[0].trim() || undefined;
  if (excedeuLimite(ip)) return res.status(429).json({ erro: 'muitas_requisicoes' });

  const token = process.env.META_CAPI_TOKEN;
  const pixelId = process.env.META_PIXEL_ID || PIXEL_PADRAO;

  // Se META_TEST_EVENT_CODE ficar setada em producao, 100% dos leads viram
  // "Test Events" e param de alimentar a otimizacao da campanha — e nada no
  // painel avisa. Em producao a variavel e ignorada de proposito.
  const emProducao = process.env.VERCEL_ENV === 'production';
  const testCodeBruto = process.env.META_TEST_EVENT_CODE || '';
  if (emProducao && testCodeBruto) {
    console.error('[capi] ATENCAO: META_TEST_EVENT_CODE esta definida em producao. ' +
      'Ignorando de proposito para nao perder o sinal de otimizacao. Remova a variavel.');
  }
  const testCode = emProducao ? '' : testCodeBruto;

  if (!token) {
    console.error('[capi] META_CAPI_TOKEN ausente — evento nao enviado');
    return res.status(500).json({ erro: 'token_ausente' });
  }

  // Tamanho antes do conteudo. Atencao: req.body e um getter que LANCA quando
  // o JSON e malformado, e a Vercel pode entregar objeto, string, Buffer ou
  // undefined dependendo do Content-Type. Os quatro casos precisam de trato.
  const tamanhoBruto = Number(req.headers['content-length']);
  if (Number.isFinite(tamanhoBruto) && tamanhoBruto > LIMITE_CORPO) {
    return res.status(413).json({ erro: 'corpo_grande_demais' });
  }

  let corpo;
  try {
    corpo = req.body;
  } catch (e) {
    return res.status(400).json({ erro: 'json_malformado' });
  }

  if (Buffer.isBuffer(corpo)) {
    if (corpo.length > LIMITE_CORPO) return res.status(413).json({ erro: 'corpo_grande_demais' });
    try { corpo = JSON.parse(corpo.toString('utf8')); } catch (e) { corpo = null; }
  } else if (typeof corpo === 'string') {
    if (corpo.length > LIMITE_CORPO) return res.status(413).json({ erro: 'corpo_grande_demais' });
    try { corpo = JSON.parse(corpo); } catch (e) { corpo = null; }
  } else if (corpo && typeof corpo === 'object') {
    let medida = 0;
    try { medida = JSON.stringify(corpo).length; } catch (e) { medida = LIMITE_CORPO + 1; }
    if (medida > LIMITE_CORPO) return res.status(413).json({ erro: 'corpo_grande_demais' });
  }

  if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) {
    return res.status(400).json({ erro: 'corpo_invalido' });
  }

  const eventId = corpo.event_id;
  if (typeof eventId !== 'string' || !/^lead-\d{10,}-[a-z0-9]{4,16}$/.test(eventId)) {
    return res.status(400).json({ erro: 'event_id_invalido' });
  }

  if (jaProcessado(eventId)) {
    console.log('[capi] duplicado descartado | event_id=' + eventId);
    return res.status(200).json({ ok: true, duplicado: true });
  }

  const grupo = corpo.content_name;
  if (!GRUPOS_VALIDOS.includes(grupo)) return res.status(400).json({ erro: 'grupo_invalido' });

  const cookies = lerCookies(req.headers.cookie);
  const fbp = corpo.fbp || cookies._fbp || undefined;

  // Se o cliente nao conseguiu montar o _fbc (pixel bloqueado, cookie ainda nao
  // gravado), reconstruimos aqui a partir do fbclid cru que ele mandou.
  let fbc = corpo.fbc || cookies._fbc || undefined;
  if (!fbc && typeof corpo.fbclid === 'string' && /^[\w.-]{1,300}$/.test(corpo.fbclid)) {
    fbc = 'fb.1.' + Date.now() + '.' + corpo.fbclid;
  }

  // A Meta exige client_user_agent e event_source_url em eventos web.
  // Nao podem ser condicionais.
  const userData = { client_user_agent: req.headers['user-agent'] || 'desconhecido' };
  if (ip) userData.client_ip_address = ip;
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;

  // A URL vem do cliente. Sem validar, um POST forjado apontaria o relatorio da
  // Meta para qualquer endereco. So aceitamos URL dos nossos proprios dominios.
  const permitidas = origensPermitidas();
  let fonte = '';
  try {
    const u = new URL(String(corpo.event_source_url || ''));
    if (permitidas.includes(u.origin)) fonte = u.href.slice(0, 500);
  } catch (e) { /* ignora */ }
  if (!fonte) fonte = (permitidas[0] || ORIGENS_PADRAO[0]) + '/';

  // Hora do CLIQUE, nao da entrega: o beacon pode ficar enfileirado enquanto a
  // pessoa troca para o WhatsApp. Aceitamos so valores plausiveis.
  const agoraS = Math.floor(Date.now() / 1000);
  let eventTime = agoraS;
  const tsCliente = Number(corpo.event_time);
  if (Number.isFinite(tsCliente) && tsCliente <= agoraS && agoraS - tsCliente < 6 * 86400) {
    eventTime = Math.floor(tsCliente);
  }

  const evento = {
    event_name: 'Lead',
    event_time: eventTime,
    event_id: eventId,
    action_source: 'website',
    event_source_url: fonte,
    user_data: userData,
    custom_data: { content_name: grupo }
  };
  if (corpo.content_category) {
    evento.custom_data.content_category = String(corpo.content_category).slice(0, 60);
  }

  const payload = { data: [evento] };
  if (testCode) payload.test_event_code = testCode;

  const url = 'https://graph.facebook.com/' + GRAPH_VERSION + '/' + pixelId +
              '/events?access_token=' + encodeURIComponent(token);

  try {
    const r = await postarNaMeta(url, {
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

    // Rastro nos logs da Vercel: da para conferir se a CAPI esta viva sem
    // depender de o navegador reportar coisa alguma.
    console.log('[capi] ok | grupo=' + grupo + ' | event_id=' + eventId +
      ' | fbc=' + (fbc ? 'sim' : 'nao') + ' | fbp=' + (fbp ? 'sim' : 'nao') +
      ' | recebidos=' + dados.events_received);

    return res.status(200).json({ ok: true, recebidos: dados.events_received });
  } catch (e) {
    console.error('[capi] falha ao chamar a Meta apos', TENTATIVAS_META, 'tentativas:',
      e && e.message, '| event_id=', eventId);
    return res.status(502).json({ erro: 'falha_de_rede' });
  }
};
