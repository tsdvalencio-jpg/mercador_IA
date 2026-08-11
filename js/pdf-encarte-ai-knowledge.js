(function () {
  'use strict';

  // Mercador IA — camada profissional de compreensão visual de encartes.
  // O PDF original é enviado ao Firebase AI Logic / Gemini como documento multimodal
  // e retorna JSON estruturado. O OCR/Tesseract anterior permanece disponível somente
  // como fallback explícito de emergência, nunca silenciosamente em modo profissional.

  const previous = window.MercadorPDFImporter;
  if (!previous || typeof previous.analyzeFile !== 'function') {
    console.error('[Mercador IA] Importador base não encontrado antes do motor visual IA.');
    return;
  }

  const ENGINE_VERSION = '4.0.0-ai-document-knowledge';
  const KNOWLEDGE_SCHEMA_VERSION = 'mercador.encarte.ai-knowledge.v1';
  const FIREBASE_SDK_VERSION = '12.16.0';
  const DEFAULT_MODEL = 'gemini-3.6-flash';
  const MAX_INLINE_BYTES = 18 * 1024 * 1024; // margem abaixo do limite documentado de 20 MB.

  let modulesPromise = null;
  let modelPromise = null;

  const clamp = (n, min, max) => Math.max(min, Math.min(max, Number(n) || 0));
  const clean = (v) => String(v == null ? '' : v).replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  const fold = (v) => clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const normalizeName = (v) => fold(v).replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

  function tokenize(v) {
    return normalizeName(v).split(' ').filter((x) => x.length > 1);
  }

  function tokenSimilarity(a, b) {
    const A = new Set(tokenize(a));
    const B = new Set(tokenize(b));
    if (!A.size || !B.size) return 0;
    const common = [...A].filter((x) => B.has(x)).length;
    return common / Math.max(A.size, B.size);
  }

  function exactCoreAgreement(a, b) {
    const A = normalizeName(a), B = normalizeName(b);
    if (!A || !B) return 0;
    if (A === B) return 1;
    if (A.includes(B) || B.includes(A)) {
      const shorter = Math.min(A.length, B.length), longer = Math.max(A.length, B.length);
      return clamp(shorter / Math.max(1, longer), 0, 1);
    }
    return tokenSimilarity(A, B);
  }

  function bboxCenter(box) {
    if (!box) return null;
    return {
      x: Number(box.x || 0) + Number(box.width || 0) / 2,
      y: Number(box.y || 0) + Number(box.height || 0) / 2,
    };
  }

  function bboxDistance(a, b) {
    const A = bboxCenter(a), B = bboxCenter(b);
    if (!A || !B) return Infinity;
    return Math.hypot(A.x - B.x, A.y - B.y);
  }

  function isPlausiblePrice(v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n < 10000;
  }

  function toTimestampStart(iso) {
    const s = clean(iso);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(`${s}T00:00:00`);
    return Number.isFinite(d.getTime()) ? d.getTime() : null;
  }

  function toTimestampEnd(iso) {
    const s = clean(iso);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const d = new Date(`${s}T23:59:59.999`);
    return Number.isFinite(d.getTime()) ? d.getTime() : null;
  }

  async function sha256Hex(file) {
    try {
      const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
      return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (_) {
      return '';
    }
  }

  async function fileToInlinePart(file) {
    if (!file || file.type !== 'application/pdf') throw new Error('Selecione um arquivo PDF válido.');
    if (file.size > MAX_INLINE_BYTES) throw new Error('Este PDF é grande demais para a análise visual inline. Reduza o arquivo ou use uma origem hospedada.');
    const base64 = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const raw = String(reader.result || '');
        const comma = raw.indexOf(',');
        if (comma < 0) reject(new Error('Não foi possível preparar o PDF para análise visual.'));
        else resolve(raw.slice(comma + 1));
      };
      reader.onerror = () => reject(reader.error || new Error('Falha ao ler o PDF.'));
      reader.readAsDataURL(file);
    });
    return { inlineData: { data: base64, mimeType: 'application/pdf' } };
  }

  async function loadFirebaseAIModules() {
    if (!modulesPromise) {
      modulesPromise = Promise.all([
        import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-ai.js`),
      ]).then(([appMod, aiMod]) => ({ appMod, aiMod }));
    }
    return modulesPromise;
  }

  function firebaseConfig() {
    const config = window.MercadorIA?.firebaseConfig || window.firebaseConfig || null;
    if (!config?.apiKey || !config?.projectId) {
      throw new Error('Configuração Firebase não encontrada para o motor visual IA.');
    }
    return config;
  }

  async function getModel() {
    if (!modelPromise) {
      modelPromise = (async () => {
        const { appMod, aiMod } = await loadFirebaseAIModules();
        const config = firebaseConfig();
        const name = 'mercador-ai-logic';
        let app = appMod.getApps().find((x) => x.name === name);
        if (!app) app = appMod.initializeApp(config, name);
        const ai = aiMod.getAI(app, { backend: new aiMod.GoogleAIBackend() });

        const offerSchema = aiMod.Schema.object({
          properties: {
            cardOrder: aiMod.Schema.number(),
            productName: aiMod.Schema.string(),
            brand: aiMod.Schema.string(),
            packageText: aiMod.Schema.string(),
            category: aiMod.Schema.string(),
            price: aiMod.Schema.number(),
            regularPrice: aiMod.Schema.number(),
            priceKind: aiMod.Schema.string(),
            requiresClub: aiMod.Schema.boolean(),
            clubName: aiMod.Schema.string(),
            conditions: aiMod.Schema.string(),
            printedText: aiMod.Schema.string(),
            confidence: aiMod.Schema.number(),
            needsReview: aiMod.Schema.boolean(),
            reviewReason: aiMod.Schema.string(),
            bbox: aiMod.Schema.object({
              properties: {
                x: aiMod.Schema.number(),
                y: aiMod.Schema.number(),
                width: aiMod.Schema.number(),
                height: aiMod.Schema.number(),
              },
            }),
          },
          optionalProperties: ['brand', 'packageText', 'regularPrice', 'clubName', 'conditions', 'reviewReason'],
        });

        const pageSchema = aiMod.Schema.object({
          properties: {
            pageNumber: aiMod.Schema.number(),
            visualOfferCount: aiMod.Schema.number(),
            offers: aiMod.Schema.array({ items: offerSchema, maxItems: 120 }),
          },
        });

        const schema = aiMod.Schema.object({
          properties: {
            retailerName: aiMod.Schema.string(),
            documentTitle: aiMod.Schema.string(),
            validityStart: aiMod.Schema.string(),
            validityEnd: aiMod.Schema.string(),
            validityText: aiMod.Schema.string(),
            pages: aiMod.Schema.array({ items: pageSchema, maxItems: 80 }),
          },
          optionalProperties: ['retailerName', 'documentTitle', 'validityStart', 'validityEnd', 'validityText'],
        });

        return aiMod.getGenerativeModel(ai, {
          model: DEFAULT_MODEL,
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: schema,
            temperature: 0,
            maxOutputTokens: 32768,
          },
        });
      })();
    }
    return modelPromise;
  }

  const EXTRACTION_PROMPT = `
Você é o motor profissional de transcrição de encartes do Mercador IA.
Analise VISUALMENTE todas as páginas do PDF original. Não use suposições e não combine cards vizinhos.

REGRAS OBRIGATÓRIAS:
1. Cada oferta visual é um card independente. Um nome nunca pode conter palavras de outro card.
2. Transcreva productName fielmente ao texto impresso. Não parafraseie, não resuma e não invente marca, peso ou variedade.
3. Se alguma palavra estiver ilegível, preserve apenas o que está realmente legível e marque needsReview=true; não complete por conhecimento de mundo.
4. price deve ser o preço promocional principal daquele card exatamente como impresso. regularPrice recebe outro preço maior do MESMO card, quando existir.
5. Texto como "a partir de 3 unidades", "cada", "kg", "clube", "app", limite por cliente e condições ficam em conditions/priceKind, nunca misturados ao nome do produto.
6. Não crie ofertas a partir de cabeçalhos, slogans, rodapés, telefone, endereço, validade, meios de pagamento ou texto jurídico.
7. Conte todos os cards de oferta da página em visualOfferCount e retorne todos eles em offers.
8. cardOrder deve seguir a leitura visual: de cima para baixo e, em cada faixa, da esquerda para a direita. Não renumere por preço.
9. bbox usa coordenadas normalizadas de 0 a 1000 relativas à página inteira: x, y, width, height do card visual.
10. confidence é de 0 a 100 e mede somente a legibilidade/fidelidade da transcrição daquele card, não sua certeza geral sobre supermercado.
11. Para preços por kg/unidade, não transforme peso da embalagem em preço. Nunca converta 400g, 500g, 1kg, 250ml etc. em valor monetário.
12. Para dois preços no mesmo card, preserve a relação real: preço normal, clube/app ou quantidade mínima conforme impresso.

Faça uma transcrição documental, não uma interpretação criativa.`;

  function verificationPrompt(firstJson) {
    return `
Você é o segundo auditor independente do Mercador IA. Releia o MESMO PDF visualmente e produza novamente o JSON completo, corrigindo qualquer erro da primeira leitura.

A primeira leitura está abaixo apenas como referência de auditoria; ela NÃO é fonte da verdade:
${JSON.stringify(firstJson)}

REGRAS DE AUDITORIA:
- A fonte da verdade é exclusivamente o PDF visual anexado.
- Reconte todos os cards de cada página. Se a primeira leitura perdeu cards, acrescente-os.
- Se juntou dois produtos vizinhos, separe-os.
- Corrija nomes mutilados somente olhando o PDF, nunca por adivinhação.
- Confira cada preço dígito por dígito e a unidade/embalagem.
- Não aceite frases impossíveis como nome de produto.
- Mantenha cardOrder e bbox de acordo com a posição visual.
- Retorne o documento completo no mesmo esquema JSON.`;
  }

  function normalizeAIResponse(raw) {
    const pages = Array.isArray(raw?.pages) ? raw.pages : [];
    return {
      retailerName: clean(raw?.retailerName),
      documentTitle: clean(raw?.documentTitle),
      validityStart: clean(raw?.validityStart),
      validityEnd: clean(raw?.validityEnd),
      validityText: clean(raw?.validityText),
      pages: pages.map((page, pageIndex) => ({
        pageNumber: Math.max(1, Math.round(Number(page?.pageNumber) || pageIndex + 1)),
        visualOfferCount: Math.max(0, Math.round(Number(page?.visualOfferCount) || 0)),
        offers: (Array.isArray(page?.offers) ? page.offers : []).map((offer, offerIndex) => ({
          cardOrder: Math.max(1, Math.round(Number(offer?.cardOrder) || offerIndex + 1)),
          productName: clean(offer?.productName),
          brand: clean(offer?.brand),
          packageText: clean(offer?.packageText),
          category: clean(offer?.category) || 'outros',
          price: Number(offer?.price),
          regularPrice: Number(offer?.regularPrice),
          priceKind: clean(offer?.priceKind) || 'general',
          requiresClub: offer?.requiresClub === true,
          clubName: clean(offer?.clubName),
          conditions: clean(offer?.conditions),
          printedText: clean(offer?.printedText),
          confidence: clamp(offer?.confidence, 0, 100),
          needsReview: offer?.needsReview === true,
          reviewReason: clean(offer?.reviewReason),
          bbox: {
            x: clamp(offer?.bbox?.x, 0, 1000),
            y: clamp(offer?.bbox?.y, 0, 1000),
            width: clamp(offer?.bbox?.width, 0, 1000),
            height: clamp(offer?.bbox?.height, 0, 1000),
          },
        })).filter((offer) => offer.productName && isPlausiblePrice(offer.price)),
      })),
    };
  }

  function flattenOffers(doc) {
    return (doc.pages || []).flatMap((page) => page.offers.map((offer) => ({ ...offer, pageNumber: page.pageNumber, pageVisualOfferCount: page.visualOfferCount })));
  }

  function matchFirstPass(second, firstOffers) {
    let best = null;
    firstOffers.forEach((first) => {
      if (Number(first.pageNumber) !== Number(second.pageNumber)) return;
      const distance = bboxDistance(first.bbox, second.bbox);
      const positionScore = Number.isFinite(distance) ? clamp(1 - distance / 280, 0, 1) : 0;
      const nameScore = exactCoreAgreement(first.productName, second.productName);
      const priceScore = Math.abs(Number(first.price) - Number(second.price)) < .011 ? 1 : 0;
      const orderScore = Number(first.cardOrder) === Number(second.cardOrder) ? 1 : 0;
      const score = positionScore * .46 + nameScore * .27 + priceScore * .18 + orderScore * .09;
      if (!best || score > best.score) best = { first, score, nameScore, priceScore, positionScore, orderScore };
    });
    return best && best.score >= .45 ? best : null;
  }

  function makeCandidate(second, match, pageCounts) {
    const first = match?.first || null;
    const nameAgreement = first ? exactCoreAgreement(first.productName, second.productName) : 0;
    const priceAgreement = first ? Math.abs(Number(first.price) - Number(second.price)) < .011 : false;
    const packageAgreement = first && second.packageText ? exactCoreAgreement(first.packageText, second.packageText) : 0;
    const dualPass = Boolean(first && priceAgreement && nameAgreement >= .82);
    const pageCountOk = Number(second.pageVisualOfferCount || 0) === Number(pageCounts.get(second.pageNumber) || 0);
    const risks = [];
    const evidence = ['PDF interpretado visualmente pelo motor multimodal com saída JSON estruturada'];

    if (dualPass) evidence.push('produto e preço confirmados em duas leituras visuais independentes');
    else risks.push('association_disagreement');
    if (second.needsReview) risks.push('ocr_low_description_quality');
    if (!pageCountOk) risks.push('single_association_pass');
    if (!isPlausiblePrice(second.price)) risks.push('invalid_price');
    if (!second.productName || normalizeName(second.productName).split(' ').length < 1) risks.push('short_product_name');

    const suspiciousInstitutional = /\b(?:OFERTAS?\s+V[ÁA]LIDAS?|ENQUANTO\s+DURAREM|SEM\s+JUROS|TELEVENDAS|CONSULTE\s+DISPONIBILIDADE|LOJAS?\s+DE|MODALIDADE\s+ATACADO|PRE[CÇ]OS?\s+NA\s+MODALIDADE)\b/i.test(second.productName);
    if (suspiciousInstitutional) risks.push('header_contamination');

    const validityStart = window.__mercadorAIValidity?.startAt || null;
    const validityEnd = window.__mercadorAIValidity?.endAt || null;
    if (!validityStart || !validityEnd) risks.push('missing_validity');

    let confidence = clamp(Number(second.confidence || 0) / 100, .40, .995);
    if (dualPass) confidence = Math.min(.995, Math.max(confidence, .97) + .015 * Math.min(1, nameAgreement));
    else confidence = Math.min(confidence, .89);
    if (second.needsReview) confidence = Math.min(confidence, .84);
    if (!pageCountOk) confidence = Math.min(confidence, .90);

    const regular = isPlausiblePrice(second.regularPrice) && Number(second.regularPrice) > Number(second.price) ? Number(second.regularPrice) : null;
    const kindRaw = fold(second.priceKind);
    const requiresClub = second.requiresClub === true || /CLUBE|APP|FIDELIDADE/.test(kindRaw);
    const priceKind = requiresClub ? 'club' : 'general';
    const structuralSafe = dualPass && !second.needsReview && pageCountOk && !risks.some((r) => ['invalid_price','header_contamination','missing_validity'].includes(r));

    return {
      id: `ai-p${second.pageNumber}-c${second.cardOrder}`,
      pageNumber: second.pageNumber,
      pageWidth: 1000,
      pageHeight: 1000,
      productName: second.productName,
      category: second.category || 'outros',
      brand: second.brand || '',
      packageText: second.packageText || '',
      price: Number(second.price),
      previousPrice: regular,
      detectedPrices: regular ? [Number(second.price), regular] : [Number(second.price)],
      priceKind,
      requiresClub,
      clubName: requiresClub ? (second.clubName || '') : '',
      clubSignal: requiresClub,
      conditions: second.conditions || '',
      confidence,
      riskFlags: [...new Set(risks)],
      evidence: [...new Set(evidence)],
      associationAgreement: dualPass ? Math.max(.92, nameAgreement) : Math.max(.35, nameAgreement),
      ownershipConfidence: dualPass ? Math.max(.94, match?.positionScore || 0) : Math.max(.45, match?.positionScore || 0),
      clusterCoherence: dualPass ? Math.max(.94, nameAgreement) : Math.max(.45, nameAgreement),
      descriptionCompleteness: clamp(second.productName.length / 45, .45, 1),
      descriptionAgreement: nameAgreement,
      descriptionVariantCount: first ? 2 : 1,
      knowledgeCardText: second.printedText || second.productName,
      structuralSafe,
      automationSafe: structuralSafe && confidence >= .985,
      sourceBox: {
        x: second.bbox.x,
        y: second.bbox.y,
        width: second.bbox.width,
        height: second.bbox.height,
      },
      startAt: validityStart,
      endAt: validityEnd,
      verified: false,
      verificationMode: '',
      ignored: false,
      published: false,
      reviewed: false,
      extractionMode: 'ai-pdf-dual-pass',
      aiDualPass: dualPass,
      aiFirstProductName: first?.productName || '',
      aiFirstPrice: first ? Number(first.price) : null,
      aiReviewReason: second.reviewReason || '',
    };
  }

  async function runAI(file, options, onProgress) {
    if (onProgress) onProgress({ pageNumber: 1, numPages: 1, percent: 3, mode: 'ai-document' });
    const [model, filePart, hash] = await Promise.all([getModel(), fileToInlinePart(file), sha256Hex(file)]);

    if (onProgress) onProgress({ pageNumber: 1, numPages: 1, percent: 12, mode: 'ai-document' });
    const firstResult = await model.generateContent([EXTRACTION_PROMPT, filePart]);
    const firstText = firstResult?.response?.text?.() || '';
    let firstRaw;
    try { firstRaw = JSON.parse(firstText); }
    catch (_) { throw new Error('O motor visual retornou um JSON inválido na primeira leitura. Nenhuma promoção foi criada.'); }
    const first = normalizeAIResponse(firstRaw);

    if (onProgress) onProgress({ pageNumber: 1, numPages: Math.max(1, first.pages.length), percent: 52, mode: 'ai-document-audit' });
    const secondResult = await model.generateContent([verificationPrompt(first), filePart]);
    const secondText = secondResult?.response?.text?.() || '';
    let secondRaw;
    try { secondRaw = JSON.parse(secondText); }
    catch (_) { throw new Error('O auditor visual retornou um JSON inválido. Nenhuma promoção foi criada.'); }
    const second = normalizeAIResponse(secondRaw);

    const startAt = toTimestampStart(second.validityStart || first.validityStart);
    const endAt = toTimestampEnd(second.validityEnd || first.validityEnd);
    const validity = {
      startAt,
      endAt,
      raw: second.validityText || first.validityText || '',
      condition: '',
      inferred: false,
    };
    window.__mercadorAIValidity = validity;

    const firstOffers = flattenOffers(first);
    const secondOffers = flattenOffers(second);
    const pageCounts = new Map();
    second.pages.forEach((page) => pageCounts.set(Number(page.pageNumber), Number(page.visualOfferCount || page.offers.length)));

    const candidates = secondOffers
      .map((offer) => makeCandidate(offer, matchFirstPass(offer, firstOffers), pageCounts))
      .filter((candidate) => candidate.productName && isPlausiblePrice(candidate.price) && !(candidate.riskFlags || []).includes('header_contamination'));

    const numPages = Math.max(1, second.pages.length || first.pages.length || 1);
    const totalWords = secondOffers.reduce((sum, x) => sum + tokenize(`${x.productName} ${x.brand} ${x.packageText} ${x.conditions}`).length, 0);
    const knowledgeDocument = {
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      generatedAt: new Date().toISOString(),
      source: { fileName: file.name, sha256: hash, mimeType: file.type, size: file.size },
      extraction: {
        provider: 'Firebase AI Logic',
        model: DEFAULT_MODEL,
        mode: 'dual-pass-pdf-vision',
        deterministicTemperature: 0,
        legacyLocalOcrUsed: false,
      },
      firstPass: first,
      verifiedPass: second,
      validity,
      promotionFacts: candidates.map((c) => ({
        id: c.id,
        pageNumber: c.pageNumber,
        productName: c.productName,
        brand: c.brand,
        packageText: c.packageText,
        price: c.price,
        regularPrice: c.previousPrice,
        priceKind: c.priceKind,
        conditions: c.conditions,
        confidence: c.confidence,
        dualPass: c.aiDualPass,
        riskFlags: c.riskFlags,
        bbox: c.sourceBox,
        printedText: c.knowledgeCardText,
      })),
    };

    if (onProgress) onProgress({ pageNumber: numPages, numPages, percent: 100, mode: 'ai-document-complete' });
    return {
      fileName: file.name,
      hash,
      numPages,
      validity,
      candidates,
      engineVersion: ENGINE_VERSION,
      pdfjsVersion: 'visual IA',
      extractionMode: 'ai-pdf-dual-pass',
      knowledgeSchemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      knowledgeDocument,
      knowledgeMetrics: {
        pages: numPages,
        modes: ['gemini-pdf', 'structured-json', 'dual-pass'],
        words: totalWords,
        lines: candidates.length,
        prices: candidates.length,
        candidates: candidates.length,
      },
      aiModel: DEFAULT_MODEL,
    };
  }

  function professionalError(error) {
    const message = String(error?.message || error || '');
    if (/app.?check|403|permission|unauthorized|firebase ai|api.*not.*enabled|failed.?precondition/i.test(message)) {
      return new Error('Motor visual profissional indisponível neste projeto. Ative Firebase AI Logic e App Check para o app Web do Mercador IA. A análise local imprecisa foi bloqueada para não gerar promoções erradas.');
    }
    return error instanceof Error ? error : new Error(message || 'Falha no motor visual profissional.');
  }

  async function analyzeFile(file, options = {}, onProgress) {
    try {
      return await runAI(file, options, onProgress);
    } catch (error) {
      console.error('[Mercador IA] Motor visual IA falhou:', error);
      // Nada de regressão silenciosa para Tesseract: só existe fallback se o SuperAdmin
      // habilitar conscientemente esta chave local para diagnóstico.
      if (localStorage.getItem('mercadorPdfAllowLegacyFallback') === '1') {
        console.warn('[Mercador IA] Fallback local explicitamente habilitado para diagnóstico.');
        return previous.analyzeFile(file, options, onProgress);
      }
      throw professionalError(error);
    } finally {
      delete window.__mercadorAIValidity;
    }
  }

  function downloadKnowledgeJson(knowledgeDocument, fileName = 'encarte') {
    const data = knowledgeDocument || window.MercadorPDFImporter?.lastKnowledgeDocument;
    if (!data) throw new Error('Nenhum JSON de conhecimento disponível.');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const safe = String(fileName || 'encarte').replace(/\.pdf$/i, '').replace(/[^a-z0-9._-]+/gi, '_');
    a.href = url;
    a.download = `${safe}.mercador-ai-knowledge.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.MercadorPDFImporter = {
    ...previous,
    ENGINE_VERSION,
    KNOWLEDGE_SCHEMA_VERSION,
    analyzeFile,
    analyzeFileLegacy: previous.analyzeFile.bind(previous),
    downloadKnowledgeJson,
    getLastKnowledgeDocument: () => window.MercadorPDFImporter.lastKnowledgeDocument || null,
    lastKnowledgeDocument: null,
  };

  const originalAnalyze = window.MercadorPDFImporter.analyzeFile;
  window.MercadorPDFImporter.analyzeFile = async function wrappedAnalyze(file, options, onProgress) {
    const result = await originalAnalyze(file, options, onProgress);
    window.MercadorPDFImporter.lastKnowledgeDocument = result?.knowledgeDocument || null;
    return result;
  };
})();
