'use strict';

const http = require('http');
const https = require('https');

const PROMPT_VERSION = 'v3_food_group_genis';

const SYSTEM_PROMPT = `Rol: Sen bir F&B maliyet, menü analizi ve ürün sınıflandırma uzmanısın.

Görevin, verilen stok_mali ve kategori bilgisini üç sınıflandırmaya tabi tutmaktır:

1) protein_bucket
Zorunlu kovalar:
dana | kuzu | tavuk | balik | deniz | hindi | diger

Protein öncelik sırası:
deniz > balik > kuzu > dana > hindi > tavuk > diger

2) food_group
Zorunlu gruplar:
karbonhidrat | et_urunleri | sarkuteri | sut_urunleri | yumurta | meyve_sebze | yag | tatli_pastane | kuruyemis | baharat_sos | sicak_icecek | diger

food_group kuralları:
- Ekmek, un, makarna, pirinç, bulgur, bakliyat, irmik, nişasta, hamur, yufka, börek, mantı, pizza hamuru, tortilla, galeta, patates, cips, kraker, mısır gevreği, tuzlu atıştırmalık: karbonhidrat
- Taze/donuk kırmızı et, kuzu, dana, tavuk, hindi, balık, deniz ürünü ve sakatat: et_urunleri
- Sucuk, salam, sosis, jambon, füme et, pastırma, bacon, pepperoni, kavurma, işlenmiş et: sarkuteri
- Peynir, süt, yoğurt, ayran, kefir, krema, kaymak, labne, süt tozu: sut_urunleri
- Yumurta (kabuklu, sıvı, toz): yumurta
- Taze/donuk/konserve sebze ve meyve, mantar, zeytin, turşu, taze yeşillik ve otlar, deniz yosunu (nori): meyve_sebze
- Tereyağı, margarin, ayçiçek/zeytin/mısır/fındık yağı, kızartmalık yağ: yag
- Baklava, pasta, kek, kurabiye, bisküvi, dondurma, çikolata, kakao, şeker, pudra şekeri, lokum, helva, bal, reçel, marmelat, tatlı sosu, fondan, krema şanti, pastane malzemesi: tatli_pastane
- Fındık, ceviz, badem, fıstık, kaju, leblebi, çekirdek, kuru üzüm, kuru kayısı, hurma ve diğer kuru meyveler: kuruyemis
- Baharat, tuz, sirke, ketçap, mayonez, hardal, soya sosu, salça, bulyon, çeşni, aroma, sos, dressing: baharat_sos
- Kahve, çay, bitki çayı, sıcak çikolata tozu, salep: sicak_icecek
- diger yalnız yukarıdakilerin hiçbirine uymayanlar içindir (ör. maya, jelatin, katkı maddesi, ambalajlı hazır yemek). Mümkünse diger kullanma.

Ürün adını kategoriye tercih et: kategori ERP grubudur ve yanıltıcı olabilir (ör. "SUT - YOGURTLAR" altında baklava → tatli_pastane).
Ürün adlarında ERP kısaltmaları olabilir (ör. "(AU)", "(PA)", "KG", "LT", "DONUK", "PKT") — bunları yok say.

3) cost_proxy (Menu engineering — tipik hammadde maliyet yoğunluğu; gerçek fatura/fiyat değil)
Zorunlu değer (İngilizce büyük harf): HIGH | MEDIUM | LOW

HIGH: Karides, istakoz, kalamar, somon, levrek, ton, premium deniz ürünleri; dana, kuzu, bonfile, antrikot vb. yüksek birim değerli etler.
MEDIUM: Hindi, orta segment et ürünleri; şarküteri, peynir, tereyağı, zeytinyağı, süt/yoğurt, fıçı ürünler; emin değilsen MEDIUM.
LOW: Tavuk, pirinç, makarna, bulgur, patates, sebze, ekmek, hamur işi gibi geniş hacimli düşük birim maliyetli girdiler.

Önemli:
- Her satır için tek protein_bucket ve tek food_group üret.
- protein_bucket hayvansal ana protein talebini gösterir.
- food_group ürünün mutfak/maliyet sınıfını gösterir.
- Peynir protein içerse bile protein_bucket=diger, food_group=sut_urunleri olmalıdır.
- Sucuk protein_bucket=dana veya ilgili hayvan türü, food_group=sarkuteri olmalıdır.
- Somon protein_bucket=balik, food_group=et_urunleri olmalıdır.
- Karides protein_bucket=deniz, food_group=et_urunleri olmalıdır.
- Zeytinyağı protein_bucket=diger, food_group=yag olmalıdır.
- Yumurta protein_bucket=diger, food_group=yumurta olmalıdır.
- Baklava protein_bucket=diger, food_group=tatli_pastane olmalıdır.
- cost_proxy yalnızca HIGH, MEDIUM veya LOW olmalı (tam bu yazım).
- Açıklama yazma.
- Markdown kullanma.
- Sadece tek JSON obje döndür.

JSON şeması:
{
  "stok_mali": "string",
  "kategori": "string veya null",
  "protein_bucket": "dana|kuzu|tavuk|balik|deniz|hindi|diger",
  "food_group": "karbonhidrat|et_urunleri|sarkuteri|sut_urunleri|yumurta|meyve_sebze|yag|tatli_pastane|kuruyemis|baharat_sos|sicak_icecek|diger",
  "cost_proxy": "HIGH|MEDIUM|LOW",
  "confidence": "yüksek|orta|düşük",
  "gerekce": "string",
  "notes": "string veya null"
}`;

const ALLOW_PROTEIN = new Set(['dana', 'kuzu', 'tavuk', 'balik', 'deniz', 'hindi', 'diger']);
const ALLOW_FOOD = new Set([
  'karbonhidrat', 'et_urunleri', 'sarkuteri', 'sut_urunleri', 'yumurta', 'meyve_sebze', 'yag',
  'tatli_pastane', 'kuruyemis', 'baharat_sos', 'sicak_icecek', 'diger'
]);
const ALLOW_COST = new Set(['HIGH', 'MEDIUM', 'LOW']);
const ALLOW_CONF = new Set(['yüksek', 'orta', 'düşük']);

function buildUserPayload(stok_mali, kategori) {
  return `Ürün bilgisi (JSON):\n${JSON.stringify({ stok_mali, kategori: kategori == null || kategori === '' ? null : kategori })}`;
}

function getOllamaConfig() {
  const url = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/generate').trim();
  const model = (process.env.OLLAMA_MODEL || 'gemma4:31b').trim();
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
  // Protein kovası yalnız et / şarküteri için anlamlı (ör. "MAKARNA DENIZ KABUGU" deniz ürünü değildir).
  if (protein_bucket !== 'diger' && food_group !== 'et_urunleri' && food_group !== 'sarkuteri') {
    notesParts.push(`protein_bucket "${protein_bucket}" → diger (food_group=${food_group})`);
    protein_bucket = 'diger';
  }
  if (!ALLOW_CONF.has(confidence)) {
    notesParts.push(`Geçersiz confidence → düşük`);
    confidence = 'düşük';
  }

  const costRaw = String(obj.cost_proxy ?? '').trim().toLocaleLowerCase('tr-TR');
  let cost_proxy;
  if (['high', 'yüksek', 'yuksek'].includes(costRaw)) cost_proxy = 'HIGH';
  else if (['low', 'düşük', 'dusuk'].includes(costRaw)) cost_proxy = 'LOW';
  else if (['medium', 'orta', 'med'].includes(costRaw)) cost_proxy = 'MEDIUM';
  else {
    const u = String(obj.cost_proxy ?? '').trim().toUpperCase();
    cost_proxy = ALLOW_COST.has(u) ? u : null;
  }
  if (!cost_proxy) {
    notesParts.push(`Geçersiz cost_proxy "${obj.cost_proxy}" → MEDIUM`);
    cost_proxy = 'MEDIUM';
  }

  const gerekce = String(obj.gerekce || '').slice(0, 2000);
  const notes = [obj.notes, notesParts.join('; ')].filter(Boolean).join('; ') || null;

  return {
    stok_mali,
    kategori: kategori === undefined ? null : kategori,
    protein_bucket,
    food_group,
    cost_proxy,
    confidence,
    gerekce,
    notes
  };
}

/** Ollama yapılandırılmış çıktı şeması: sabit anahtarlar + enum; fazladan alan / tekrar döngüsünü engeller. */
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    stok_mali: { type: 'string' },
    kategori: { type: ['string', 'null'] },
    protein_bucket: { type: 'string', enum: [...ALLOW_PROTEIN] },
    food_group: { type: 'string', enum: [...ALLOW_FOOD] },
    cost_proxy: { type: 'string', enum: [...ALLOW_COST] },
    confidence: { type: 'string', enum: [...ALLOW_CONF] },
    gerekce: { type: 'string', maxLength: 300 },
    notes: { type: ['string', 'null'] }
  },
  required: ['protein_bucket', 'food_group', 'cost_proxy', 'confidence', 'gerekce'],
  additionalProperties: false
};

/** Başarısız (fallback) kayıtların sürümü — «yalnız eksikler» bunları yeniden dener. */
const PROMPT_VERSION_HATA = `${PROMPT_VERSION}_hata`;

async function callOllamaOnce(stok_mali, kategori, attempt = 1) {
  const cfg = getOllamaConfig();
  const prompt = `${SYSTEM_PROMPT}\n\n${buildUserPayload(stok_mali, kategori)}`;
  const payload = {
    model: cfg.model,
    prompt,
    stream: false,
    format: OUTPUT_SCHEMA,
    options: {
      // Tekrar denemede sıcaklığı artır: aynı tekrar döngüsüne düşmesin.
      temperature: attempt === 1 ? 0.1 : attempt === 2 ? 0.4 : 0.7,
      top_p: 0.9,
      repeat_penalty: 1.15,
      num_predict: 400,
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
      return await callOllamaOnce(stok_mali, kategori, attempt);
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
    cost_proxy: 'MEDIUM',
    confidence: 'düşük',
    gerekce: 'LLM çağrısı başarısız',
    notes: lastErr.slice(0, 2000),
    raw_response: null,
    model_name: getOllamaConfig().model,
    prompt_version: PROMPT_VERSION_HATA
  };
}

module.exports = {
  SYSTEM_PROMPT,
  PROMPT_VERSION,
  PROMPT_VERSION_HATA,
  classifyProductWithRetries,
  getOllamaConfig,
  ALLOW_PROTEIN,
  ALLOW_FOOD,
  ALLOW_COST
};
