'use strict';

const http = require('http');
const https = require('https');

const PROMPT_VERSION = 'v1_protein_food_group_classification';

const SYSTEM_PROMPT = `Rol: Sen bir F&B maliyet, menü analizi ve ürün sınıflandırma uzmanısın.

Görevin, verilen stok_mali ve kategori bilgisini iki ayrı sınıflandırmaya tabi tutmaktır:

1) protein_bucket
Zorunlu kovalar:
dana | kuzu | tavuk | balik | deniz | hindi | diger

Protein öncelik sırası:
deniz > balik > kuzu > dana > hindi > tavuk > diger

2) food_group
Zorunlu gruplar:
karbonhidrat | et_urunleri | sut_urunleri | meyve_sebze | sarkuteri | yag | diger

food_group kuralları:
- Ekmek, un, makarna, pirinç, bulgur, bakliyat, hamur işi, bisküvi, börek, mantı, pizza hamuru, tortilla gibi ürünler: karbonhidrat
- Taze kırmızı et, kuzu, dana, tavuk, hindi, balık, deniz ürünü ve sakatat: et_urunleri
- Sucuk, salam, sosis, jambon, füme et, pastırma, bacon, pepperoni, işlenmiş et ürünleri: sarkuteri
- Peynir, süt, yoğurt, ayran, kefir, krema, kaymak gibi süt bazlı ürünler: sut_urunleri
- Tereyağı, margarin, ayçiçek yağı, zeytinyağı, kızartmalık yağ, susam yağı vb.: yag
- Taze sebze/meyve, donuk sebze/meyve, püre meyve, konserve sebze/meyve: meyve_sebze
- Baharat, sos, çay, kahve, şeker, reçel, çikolata, tatlı, katkı, içecek hammaddesi gibi ürünler: diger

Önemli:
- Her satır için tek protein_bucket ve tek food_group üret.
- protein_bucket hayvansal ana protein talebini gösterir.
- food_group ürünün mutfak/maliyet sınıfını gösterir.
- Peynir protein içerse bile protein_bucket=diger, food_group=sut_urunleri olmalıdır.
- Sucuk protein_bucket=dana veya ilgili hayvan türü, food_group=sarkuteri olmalıdır.
- Somon protein_bucket=balik, food_group=et_urunleri olmalıdır.
- Karides protein_bucket=deniz, food_group=et_urunleri olmalıdır.
- Zeytinyağı protein_bucket=diger, food_group=yag olmalıdır.
- Açıklama yazma.
- Markdown kullanma.
- Sadece tek JSON obje döndür.

JSON şeması:
{
  "stok_mali": "string",
  "kategori": "string veya null",
  "protein_bucket": "dana|kuzu|tavuk|balik|deniz|hindi|diger",
  "food_group": "karbonhidrat|et_urunleri|sut_urunleri|meyve_sebze|sarkuteri|yag|diger",
  "confidence": "yüksek|orta|düşük",
  "gerekce": "string",
  "notes": "string veya null"
}`;

const ALLOW_PROTEIN = new Set(['dana', 'kuzu', 'tavuk', 'balik', 'deniz', 'hindi', 'diger']);
const ALLOW_FOOD = new Set(['karbonhidrat', 'et_urunleri', 'sut_urunleri', 'meyve_sebze', 'sarkuteri', 'yag', 'diger']);
const ALLOW_CONF = new Set(['yüksek', 'orta', 'düşük']);

function buildUserPayload(stok_mali, kategori) {
  return `Ürün bilgisi (JSON):\n${JSON.stringify({ stok_mali, kategori: kategori == null || kategori === '' ? null : kategori })}`;
}

function getOllamaConfig() {
  const url = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/generate').trim();
  const model = (process.env.OLLAMA_MODEL || 'gemma2:27b').trim();
  const u = new URL(url);
  return {
    url,
    model,
    hostname: u.hostname,
    port: u.port || (u.protocol === 'https:' ? 443 : 80),
    protocol: u.protocol,
    pathname: u.pathname || '/api/generate'
  };
}

function postJson(urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const isHttps = u.protocol === 'https:';
    const lib = isHttps ? https : http;
    const payload = JSON.stringify(body);
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: 600000
      },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch (e) {
            resolve({ status: res.statusCode, body: data, parseError: e.message });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Ollama isteği zaman aşımı'));
    });
    req.write(payload);
    req.end();
  });
}

function extractJsonObject(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch (_) {
    const i = t.indexOf('{');
    const j = t.lastIndexOf('}');
    if (i >= 0 && j > i) {
      try {
        return JSON.parse(t.slice(i, j + 1));
      } catch (_) {
        return null;
      }
    }
  }
  return null;
}

function normalizeAndFix(obj, stok_mali, kategori, fixNotes) {
  const notesParts = fixNotes && fixNotes.length ? [fixNotes] : [];
  let protein_bucket = String(obj.protein_bucket || '').trim().toLowerCase();
  let food_group = String(obj.food_group || '').trim().toLowerCase();
  if (protein_bucket === 'balık') protein_bucket = 'balik';
  const confRaw = String(obj.confidence || '').trim().toLowerCase();
  let confidence = confRaw;
  if (confidence === 'yuksek') confidence = 'yüksek';
  if (confidence === 'dusuk') confidence = 'düşük';

  if (!ALLOW_PROTEIN.has(protein_bucket)) {
    notesParts.push(`Geçersiz protein_bucket "${obj.protein_bucket}" → diger`);
    protein_bucket = 'diger';
  }
  if (!ALLOW_FOOD.has(food_group)) {
    notesParts.push(`Geçersiz food_group "${obj.food_group}" → diger`);
    food_group = 'diger';
  }
  if (!ALLOW_CONF.has(confidence)) {
    notesParts.push(`Geçersiz confidence → düşük`);
    confidence = 'düşük';
  }

  const gerekce = String(obj.gerekce || '').slice(0, 2000);
  const notes = [obj.notes, notesParts.join('; ')].filter(Boolean).join('; ') || null;

  return {
    stok_mali,
    kategori: kategori === undefined ? null : kategori,
    protein_bucket,
    food_group,
    confidence,
    gerekce,
    notes
  };
}

async function callOllamaOnce(stok_mali, kategori) {
  const cfg = getOllamaConfig();
  const prompt = `${SYSTEM_PROMPT}\n\n${buildUserPayload(stok_mali, kategori)}`;
  const payload = {
    model: cfg.model,
    prompt,
    stream: false,
    format: 'json',
    options: {
      temperature: 0.1,
      top_p: 0.9,
      num_ctx: 4096
    }
  };
  const res = await postJson(cfg.url, payload);
  if (res.status !== 200) {
    throw new Error(`Ollama HTTP ${res.status}: ${typeof res.body === 'string' ? res.body : JSON.stringify(res.body)}`);
  }
  if (res.parseError) {
    throw new Error(`Ollama yanıtı JSON değil: ${res.parseError}`);
  }
  const body = res.body;
  const raw = typeof body.response === 'string' ? body.response : JSON.stringify(body.response ?? body);
  let parsed = extractJsonObject(raw);
  if (!parsed && body.response && typeof body.response === 'object') {
    parsed = body.response;
  }
  if (!parsed) {
    throw new Error(`Model çıktısı parse edilemedi: ${String(raw).slice(0, 500)}`);
  }
  const fixed = normalizeAndFix(parsed, stok_mali, kategori, null);
  return { ...fixed, raw_response: raw, model_name: cfg.model, prompt_version: PROMPT_VERSION };
}

async function classifyProductWithRetries(stok_mali, kategori) {
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await callOllamaOnce(stok_mali, kategori);
    } catch (e) {
      lastErr = e.message || String(e);
      await new Promise(r => setTimeout(r, 400 * attempt));
    }
  }
  return {
    stok_mali,
    kategori: kategori === undefined ? null : kategori,
    protein_bucket: 'diger',
    food_group: 'diger',
    confidence: 'düşük',
    gerekce: 'LLM çağrısı başarısız',
    notes: lastErr.slice(0, 2000),
    raw_response: null,
    model_name: getOllamaConfig().model,
    prompt_version: PROMPT_VERSION
  };
}

module.exports = {
  SYSTEM_PROMPT,
  PROMPT_VERSION,
  classifyProductWithRetries,
  getOllamaConfig,
  ALLOW_PROTEIN,
  ALLOW_FOOD
};
