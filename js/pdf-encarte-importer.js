(function () {
  'use strict';

  const PDFJS_VERSION = '5.7.284';
  const ENGINE_VERSION = '2.0.0';
  const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;
  let pdfjsPromise = null;
  let activeDocument = null;
  let activeFileHash = '';

  function cleanText(value) {
    return String(value || '')
      .replace(/\u0000/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function collapseDuplicatedGlyphs(word) {
    const text = cleanText(word);
    if (/^\d+$/.test(text)) return text;
    if (text.length < 6) return text;
    const chunks = [...text.matchAll(/(.)\1*/g)].map((m) => ({ char:m[1], length:m[0].length }));
    const repeated = chunks.filter((x) => x.length > 1).reduce((sum, x) => sum + x.length, 0);
    if (repeated / text.length < 0.55) return text;
    const repeatedLengths = chunks.filter((x) => x.length > 1).map((x) => x.length);
    const gcd = (a,b) => b ? gcd(b, a % b) : a;
    const factor = repeatedLengths.reduce((acc, n) => gcd(acc, n), repeatedLengths[0] || 1);
    if (factor <= 1) return text;
    return chunks.map((x) => x.char.repeat(Math.max(1, Math.round(x.length / factor)))).join('');
  }

  function sanitizeWord(value) {
    return collapseDuplicatedGlyphs(value)
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseMoney(value) {
    const match = String(value || '').replace(/\s+/g, '').match(/(?:R\$)?(\d{1,8})[,.](\d{2})/i);
    if (!match) return null;
    let integer = match[1];
    if (integer.length >= 4 && integer.length % 2 === 0) {
      const half = integer.length / 2;
      if (integer.slice(0, half) === integer.slice(half)) integer = integer.slice(0, half);
    }
    const number = Number(`${integer}.${match[2]}`);
    return Number.isFinite(number) && number > 0 && number < 10000 ? number : null;
  }

  function center(box) {
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  function unionBoxes(boxes) {
    const valid = (boxes || []).filter(Boolean);
    if (!valid.length) return null;
    const x0 = Math.min(...valid.map((b) => b.x));
    const y0 = Math.min(...valid.map((b) => b.y));
    const x1 = Math.max(...valid.map((b) => b.x + b.width));
    const y1 = Math.max(...valid.map((b) => b.y + b.height));
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  function overlapX(a, b) {
    const left = Math.max(a.x, b.x);
    const right = Math.min(a.x + a.width, b.x + b.width);
    return Math.max(0, right - left);
  }

  function genericLine(text) {
    const t = cleanText(text).toUpperCase();
    if (!t) return true;
    return /^(R\$|CADA|KG|UN|UND|UNIDADE|UNIDADES|CLIENTE|CLUBE|PAGA|OFERTA|OFERTAS|ESPECIAIS|PREÇO|PRECO)$/.test(t)
      || /^(LIMITE|LIMITE DE|POR CLIENTE|EXCETO|LEVE|PAGUE)\b/.test(t)
      || /^(PREÇOS?|PRECOS?|OFERTAS?)\s+VÁLID[AO]S?\b/.test(t)
      || /^HORÁRIO DE ATENDIMENTO\b/.test(t)
      || /^\d{1,2}\/\d{1,2}/.test(t)
      || /^\d+[,.]?\d*$/.test(t);
  }

  function conditionLine(text) {
    const t = cleanText(text).toUpperCase();
    return /\b(LIMITE|POR CLIENTE|EXCETO|LEV[EA]|PAGUE|ENQUANTO HOUVER ESTOQUE|CLUBE)\b/.test(t);
  }

  function groupLines(boxes, tolerance = 4.5) {
    const lines = [];
    [...boxes].sort((a, b) => a.y - b.y || a.x - b.x).forEach((box) => {
      const cy = box.y + box.height / 2;
      let line = lines.find((x) => Math.abs(x.cy - cy) <= tolerance);
      if (!line) {
        line = { cy, boxes: [] };
        lines.push(line);
      }
      line.boxes.push(box);
      line.cy = line.boxes.reduce((sum, x) => sum + x.y + x.height / 2, 0) / line.boxes.length;
    });
    return lines.map((line) => {
      line.boxes.sort((a, b) => a.x - b.x);
      return {
        ...line,
        text: cleanText(line.boxes.map((x) => x.text).join(' ')),
        box: unionBoxes(line.boxes)
      };
    }).sort((a, b) => a.cy - b.cy);
  }

  function productSimilarity(a, b) {
    const norm = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const aa = new Set(norm(a).split(' ').filter((x) => x.length > 1));
    const bb = new Set(norm(b).split(' ').filter((x) => x.length > 1));
    if (!aa.size || !bb.size) return 0;
    const common = [...aa].filter((x) => bb.has(x)).length;
    return common / Math.max(aa.size, bb.size);
  }

  function extractPackage(text) {
    const t = cleanText(text).toUpperCase();
    const patterns = [
      /(L\d+P\d+)/,
      /(PACK\s*C\/?\s*\d+\s*UN(?:IDADES)?)/,
      /(\d+(?:[,.]\d+)?\s*(?:KG|G|ML|L|LT|LTS|LITROS?|UN|UND|UNIDADES|PCT|BDJ))/,
      /(PCT\s*\d+(?:[,.]\d+)?\s*(?:KG|G|ML|L|LT|LTS))/
    ];
    for (const pattern of patterns) {
      const m = t.match(pattern);
      if (m) return cleanText(m[1]).toLowerCase();
    }
    return '';
  }

  function findProductForPrice(priceBox, boxes) {
    const pc = center(priceBox);
    const nearby = boxes.filter((b) => {
      if (b === priceBox) return false;
      if (b.height > 17) return false;
      const bc = center(b);
      const aboveDistance = priceBox.y - (b.y + b.height);
      if (aboveDistance < -3 || aboveDistance > 112) return false;
      if (Math.abs(bc.x - pc.x) > 82) return false;
      const upper = b.text.toUpperCase();
      if (/^(R\$|CADA)$/.test(upper)) return false;
      if (/^[,\d.]+$/.test(upper)) return false;
      return true;
    });

    const lines = groupLines(nearby).filter((line) => !genericLine(line.text));
    const productLines = lines.filter((line) => !conditionLine(line.text)).slice(-5);
    const conditionLines = lines.filter((line) => conditionLine(line.text)).slice(-4);

    let productText = cleanText(productLines.map((x) => x.text).join(' '));
    productText = productText
      .replace(/\bOFERTAS?\s+ESPECIAIS\b/ig, '')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      productText,
      productBox: unionBoxes(productLines.flatMap((x) => x.boxes)),
      localConditions: cleanText(conditionLines.map((x) => x.text).join(' · '))
    };
  }

  function findProductForPriceStrict(priceBox, boxes) {
    const pc = center(priceBox);
    const nearby = boxes.filter((b) => {
      if (b === priceBox || b.height > 18) return false;
      const bc = center(b);
      const aboveDistance = priceBox.y - (b.y + b.height);
      if (aboveDistance < -2 || aboveDistance > 88) return false;
      const horizontalOverlap = overlapX(
        { x: priceBox.x - 56, y: priceBox.y, width: priceBox.width + 112, height: priceBox.height },
        b
      );
      if (horizontalOverlap <= 0 && Math.abs(bc.x - pc.x) > 48) return false;
      const upper = b.text.toUpperCase();
      if (/^(R\$|CADA)$/.test(upper) || /^[,\d.]+$/.test(upper)) return false;
      return true;
    });
    const lines = groupLines(nearby, 3.5).filter((line) => !genericLine(line.text));
    const productLines = lines.filter((line) => !conditionLine(line.text)).slice(-4);
    return {
      productText: cleanText(productLines.map((x) => x.text).join(' ')),
      productBox: unionBoxes(productLines.flatMap((x) => x.boxes))
    };
  }

  function candidateQuality(input) {
    const {
      productName, packageText, category, detectedPrices, price, previousPrice,
      validity, sourceBox, primaryProduct, strictProduct, priceBox, options, conditions
    } = input;
    const risks = [];
    const evidence = [];
    let score = 0.55;
    const words = cleanText(productName).split(' ').filter(Boolean);
    const agreement = productSimilarity(primaryProduct, strictProduct);

    if (agreement >= 0.80) { score += 0.15; evidence.push('dupla associação espacial concordante'); }
    else if (agreement >= 0.60) { score += 0.09; evidence.push('associação espacial compatível'); }
    else if (strictProduct) { score -= 0.10; risks.push('association_disagreement'); }
    else { score -= 0.04; risks.push('single_association_pass'); }

    if (words.length >= 4) { score += 0.06; evidence.push('descrição detalhada'); }
    else if (words.length >= 2) score += 0.03;
    else risks.push('short_product_name');

    if (packageText) { score += 0.06; evidence.push('embalagem identificada'); }
    if (category && category !== 'outros') { score += 0.04; evidence.push('categoria reconhecida'); }
    if (sourceBox && priceBox) { score += 0.04; evidence.push('origem espacial preservada'); }

    if (validity?.startAt && validity?.endAt) { score += 0.08; evidence.push('validade identificada'); }
    else { score -= 0.12; risks.push('missing_validity'); }

    const countPrices = (detectedPrices || []).length;
    if (countPrices === 1) { score += 0.05; evidence.push('preço único no bloco'); }
    else if (countPrices === 2 && (options.lowerPriceIsClub || /\b(CLUBE|CLIENTE.*PAGA)\b/i.test(conditions || ''))) { score += 0.04; evidence.push('duplo preço com sinal de programa/clube'); }
    else if (countPrices > 2) { score -= 0.12; risks.push('too_many_prices'); }
    else if (countPrices === 2) { score -= 0.06; risks.push('ambiguous_price_kind'); }

    if (conditions) score += 0.015;
    if (!Number.isFinite(price) || price <= 0 || price >= 10000) risks.push('invalid_price');
    if (previousPrice && Number(previousPrice) <= Number(price)) risks.push('invalid_previous_price');

    const upper = cleanText(productName).toUpperCase();
    if (/HOR[ÁA]RIO|VALID[AO]S?|TODO MUNDO|COMUNIDADE|WHATSAPP|OFERTAS ESPECIAIS/.test(upper)) {
      score -= 0.18;
      risks.push('header_contamination');
    }
    if ((upper.match(/R\$/g) || []).length || /\b\d{1,4}[,.]\d{2}\b/.test(upper)) {
      score -= 0.12;
      risks.push('price_inside_product_text');
    }
    if (words.length > 18) { score -= 0.08; risks.push('overlong_product_text'); }

    const critical = new Set(['association_disagreement','missing_validity','too_many_prices','ambiguous_price_kind','invalid_price','invalid_previous_price','header_contamination','price_inside_product_text']);
    if (risks.some((r) => critical.has(r))) score = Math.min(score, 0.965);
    if (risks.includes('association_disagreement') || risks.includes('header_contamination')) score = Math.min(score, 0.89);
    if (risks.includes('missing_validity') || risks.includes('invalid_price')) score = Math.min(score, 0.84);

    score = Math.max(0.35, Math.min(0.995, score));
    return {
      confidence: score,
      riskFlags: [...new Set(risks)],
      evidence: [...new Set(evidence)],
      associationAgreement: agreement,
      automationSafe: !risks.some((r) => critical.has(r)) && score >= 0.97
    };
  }

  function findPriceBoxes(boxes) {
    const prices = [];

    boxes.forEach((box) => {
      const direct = parseMoney(box.text);
      if (/R\$/i.test(box.text) && direct) {
        prices.push({ price: direct, box, parts: [box] });
        return;
      }

      if (box.text.toUpperCase() !== 'R$') return;
      const bc = center(box);

      const directNumber = boxes
        .filter((candidate) => {
          const cc = center(candidate);
          return candidate.x >= box.x + box.width - 4
            && candidate.x <= box.x + 110
            && Math.abs(cc.y - bc.y) <= 23
            && /^\d{1,8}[,.]\d{2}$/.test(candidate.text)
            && candidate.height >= box.height * .9;
        })
        .sort((a,b) => Math.abs(a.x - (box.x + box.width)) - Math.abs(b.x - (box.x + box.width)))[0];

      if (directNumber) {
        const value = parseMoney(directNumber.text);
        if (value) prices.push({ price:value, box:unionBoxes([box,directNumber]), parts:[box,directNumber] });
        return;
      }

      const integers = boxes
        .filter((candidate) => {
          const cc = center(candidate);
          return candidate.x >= box.x + box.width - 4
            && candidate.x <= box.x + 90
            && Math.abs(cc.y - bc.y) <= 23
            && /^\d{1,8}$/.test(candidate.text)
            && candidate.height >= box.height * 1.15;
        })
        .sort((a,b) => {
          const dxA = Math.abs(a.x - (box.x + box.width));
          const dxB = Math.abs(b.x - (box.x + box.width));
          return dxA - dxB || b.height - a.height;
        });

      const integer = integers[0];
      if (!integer) return;

      const decimals = boxes
        .filter((candidate) => {
          const cc = center(candidate);
          const ic = center(integer);
          return candidate.x >= integer.x + integer.width - 8
            && candidate.x <= integer.x + integer.width + 35
            && Math.abs(cc.y - ic.y) <= 20
            && /^[,.]\d{2}$/.test(candidate.text)
            && candidate.height >= box.height * .85;
        })
        .sort((a,b) => Math.abs(a.x - (integer.x + integer.width)) - Math.abs(b.x - (integer.x + integer.width)));

      const decimal = decimals[0];
      if (!decimal) return;
      const value = parseMoney(`${integer.text}${decimal.text}`);
      if (value) prices.push({ price:value, box:unionBoxes([box,integer,decimal]), parts:[box,integer,decimal] });
    });

    const deduped = [];
    for (const price of prices) {
      const pc = center(price.box);
      const duplicate = deduped.some((x) => {
        const xc = center(x.box);
        return Math.abs(x.price - price.price) < 0.001 && Math.abs(pc.x - xc.x) < 8 && Math.abs(pc.y - xc.y) < 8;
      });
      if (!duplicate) deduped.push(price);
    }
    return deduped;
  }

  function detectGlobalCondition(text) {
    const normalized = cleanText(text);
    const parts = [];
    if (/enquanto houver estoque/i.test(normalized)) parts.push('ou enquanto houver estoque');
    return parts.join(' · ');
  }

  function localMidnight(year, month, day, endOfDay) {
    const d = new Date(year, month - 1, day, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
    return d.getTime();
  }

  function extractValidity(text) {
    const t = cleanText(text);
    let m = t.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\s*(?:a|até)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i);
    if (m) {
      return {
        startAt: localMidnight(Number(m[3]), Number(m[2]), Number(m[1]), false),
        endAt: localMidnight(Number(m[6]), Number(m[5]), Number(m[4]), true),
        raw: m[0],
        condition: detectGlobalCondition(t)
      };
    }
    m = t.match(/\b(\d{1,2})\/(\d{1,2})\s*(?:a|até)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i);
    if (m) {
      return {
        startAt: localMidnight(Number(m[5]), Number(m[2]), Number(m[1]), false),
        endAt: localMidnight(Number(m[5]), Number(m[4]), Number(m[3]), true),
        raw: m[0],
        condition: detectGlobalCondition(t)
      };
    }
    m = t.match(/\b(\d{1,2})\s*(?:a|até)\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\b/i);
    if (m) {
      return {
        startAt: localMidnight(Number(m[4]), Number(m[3]), Number(m[1]), false),
        endAt: localMidnight(Number(m[4]), Number(m[3]), Number(m[2]), true),
        raw: m[0],
        condition: detectGlobalCondition(t)
      };
    }
    return { startAt: null, endAt: null, raw: '', condition: detectGlobalCondition(t) };
  }

  function normalizeTextItem(item, viewport, pdfjsLib) {
    const text = sanitizeWord(item.str);
    if (!text) return null;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const height = Math.max(2, Math.hypot(tx[2], tx[3]));
    const width = Math.max(1, Math.abs(Number(item.width || 0) * viewport.scale));
    return {
      text,
      x: tx[4],
      y: tx[5] - height,
      width,
      height
    };
  }

  function buildCandidates(pageNumber, pageWidth, pageHeight, boxes, priceBoxes, validity, options, inferCategory) {
    const globalCondition = validity?.condition || '';
    const rawPrices = priceBoxes.map((price, index) => {
      const info = findProductForPrice(price.box, boxes);
      const strict = findProductForPriceStrict(price.box, boxes);
      return {
        id: `${pageNumber}-${index}`,
        pageNumber,
        pageWidth,
        pageHeight,
        price: price.price,
        priceBox: price.box,
        productName: info.productText,
        strictProductName: strict.productText,
        productBox: info.productBox,
        localConditions: info.localConditions
      };
    }).filter((x) => x.productName && x.productName.length >= 3);

    const clusters = [];
    rawPrices.forEach((entry) => {
      const ec = center(entry.priceBox);
      let cluster = clusters.find((x) => {
        const xc = center(x.entries[0].priceBox);
        const sim = productSimilarity(entry.productName, x.entries[0].productName);
        return Math.abs(ec.x - xc.x) <= 68 && Math.abs(ec.y - xc.y) <= 125 && sim >= 0.58;
      });
      if (!cluster) {
        cluster = { entries: [] };
        clusters.push(cluster);
      }
      cluster.entries.push(entry);
    });

    return clusters.map((cluster, index) => {
      const entriesSortedByName = [...cluster.entries].sort((a, b) => b.productName.length - a.productName.length);
      const productName = entriesSortedByName[0].productName;
      const strictProduct = entriesSortedByName.map((x) => x.strictProductName).filter(Boolean).sort((a,b) => b.length-a.length)[0] || '';
      const uniquePrices = [...new Set(cluster.entries.map((x) => Number(x.price.toFixed(2))))].sort((a, b) => a - b);
      const promoPrice = uniquePrices[0];
      const normalPrice = uniquePrices.length > 1 ? uniquePrices[uniquePrices.length - 1] : null;
      const multiple = uniquePrices.length > 1;
      const packageText = extractPackage(productName);
      const category = inferCategory ? (inferCategory(productName) || 'outros') : 'outros';
      const conditions = cleanText([globalCondition, ...cluster.entries.map((x) => x.localConditions)].filter(Boolean).join(' · '));
      const clubSignal = /\b(CLUBE|CLIENTE\s+CLUBE|CLIENTE.*PAGA)\b/i.test(conditions);
      const priceKind = multiple ? ((clubSignal || options.lowerPriceIsClub) ? 'club' : 'review') : 'general';
      const sourceBox = unionBoxes(cluster.entries.flatMap((x) => [x.productBox, x.priceBox]));
      const quality = candidateQuality({
        productName,
        packageText,
        category,
        detectedPrices: uniquePrices,
        price: promoPrice,
        previousPrice: normalPrice,
        validity,
        sourceBox,
        primaryProduct: productName,
        strictProduct,
        priceBox: cluster.entries[0].priceBox,
        options,
        conditions
      });

      return {
        id: `p${pageNumber}-c${index}`,
        pageNumber,
        pageWidth,
        pageHeight,
        productName,
        category,
        brand: '',
        packageText,
        price: promoPrice,
        previousPrice: normalPrice,
        detectedPrices: uniquePrices,
        priceKind,
        requiresClub: priceKind === 'club',
        clubName: priceKind === 'club' ? cleanText(options.clubName || '') : '',
        clubSignal,
        conditions,
        confidence: quality.confidence,
        riskFlags: quality.riskFlags,
        evidence: quality.evidence,
        associationAgreement: quality.associationAgreement,
        automationSafe: quality.automationSafe,
        sourceBox,
        startAt: validity?.startAt || null,
        endAt: validity?.endAt || null,
        verified: false,
        verificationMode: '',
        ignored: false,
        published: false,
        reviewed: false
      };
    }).filter((x) => Number.isFinite(x.price) && x.price > 0 && x.productName.length >= 3);
  }

  async function loadPdfJs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(`${PDFJS_BASE}/build/pdf.mjs`).then((pdfjsLib) => {
        pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.mjs`;
        return pdfjsLib;
      });
    }
    return pdfjsPromise;
  }

  async function sha256(arrayBuffer) {
    if (!crypto?.subtle) return '';
    const digest = await crypto.subtle.digest('SHA-256', arrayBuffer.slice(0));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function analyzeFile(file, options = {}, onProgress) {
    if (!file || (file.type && file.type !== 'application/pdf') || !/\.pdf$/i.test(file.name || '')) throw new Error('Selecione um arquivo PDF válido.');
    const pdfjsLib = await loadPdfJs();
    const arrayBuffer = await file.arrayBuffer();
    const hash = await sha256(arrayBuffer);
    const loadingTask = pdfjsLib.getDocument({
      data: arrayBuffer,
      cMapUrl: `${PDFJS_BASE}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
      wasmUrl: `${PDFJS_BASE}/wasm/`
    });
    const pdf = await loadingTask.promise;
    activeDocument = pdf;
    activeFileHash = hash;

    const pages = [];
    const allText = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      if (onProgress) onProgress({ pageNumber, numPages: pdf.numPages, percent: Math.round((pageNumber - 1) / pdf.numPages * 100) });
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const textContent = await page.getTextContent();
      const boxes = textContent.items.map((item) => normalizeTextItem(item, viewport, pdfjsLib)).filter(Boolean);
      const pageText = cleanText(boxes.map((x) => x.text).join(' '));
      allText.push(pageText);
      const priceBoxes = findPriceBoxes(boxes);
      pages.push({ pageNumber, width: viewport.width, height: viewport.height, boxes, priceBoxes });
    }

    const documentText = allText.join(' ');
    const validity = extractValidity(documentText);
    const inferCategory = window.MercadorIA?.inferCategory;
    const candidates = pages.flatMap((page) => buildCandidates(
      page.pageNumber,
      page.width,
      page.height,
      page.boxes,
      page.priceBoxes,
      validity,
      options,
      inferCategory
    ));

    if (onProgress) onProgress({ pageNumber: pdf.numPages, numPages: pdf.numPages, percent: 100 });

    return {
      fileName: file.name,
      fileSize: file.size,
      hash,
      numPages: pdf.numPages,
      validity,
      candidates,
      analyzedAt: Date.now(),
      engineVersion: ENGINE_VERSION,
      pdfjsVersion: PDFJS_VERSION
    };
  }

  async function renderPreview(candidate, canvas) {
    if (!activeDocument || !candidate || !canvas) return;
    const page = await activeDocument.getPage(candidate.pageNumber);
    const scale = 1.8;
    const viewport = page.getViewport({ scale });
    const full = document.createElement('canvas');
    full.width = Math.ceil(viewport.width);
    full.height = Math.ceil(viewport.height);
    const ctx = full.getContext('2d', { alpha: false });
    await page.render({ canvasContext: ctx, viewport }).promise;

    const source = candidate.sourceBox || { x: 0, y: 0, width: candidate.pageWidth, height: candidate.pageHeight };
    const margin = 38;
    const sx = Math.max(0, (source.x - margin) * scale);
    const sy = Math.max(0, (source.y - margin) * scale);
    const sw = Math.min(full.width - sx, (source.width + margin * 2) * scale);
    const sh = Math.min(full.height - sy, (source.height + margin * 2) * scale);
    const maxWidth = 900;
    const ratio = Math.min(1, maxWidth / Math.max(1, sw));
    canvas.width = Math.max(1, Math.round(sw * ratio));
    canvas.height = Math.max(1, Math.round(sh * ratio));
    const out = canvas.getContext('2d', { alpha: false });
    out.clearRect(0, 0, canvas.width, canvas.height);
    out.drawImage(full, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  }

  function hasActiveDocument(hash) {
    return Boolean(activeDocument && (!hash || activeFileHash === hash));
  }

  window.MercadorPDFImporter = {
    PDFJS_VERSION,
    ENGINE_VERSION,
    analyzeFile,
    renderPreview,
    extractValidity,
    hasActiveDocument
  };
})();
