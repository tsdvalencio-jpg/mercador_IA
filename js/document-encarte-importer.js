(function () {
  'use strict';

  // Mercador IA — camada universal de entrada documental.
  // Preserva integralmente o importador PDF existente e acrescenta imagens e texto/OCR.
  // Todos os caminhos convergem para o mesmo formato de resultado/candidates usado pelo Admin.

  const previous = window.MercadorPDFImporter;
  if (!previous || typeof previous.analyzeFile !== 'function') {
    console.error('[Mercador IA] Importador documental não instalado: motor PDF base indisponível.');
    return;
  }
  if (previous.__multiFormatDocumentImporterInstalled) return;

  const ENGINE_VERSION = '6.0.0-multiformat-document-intelligence';
  const KNOWLEDGE_SCHEMA_VERSION = 'mercador.encarte.knowledge.v6';
  const TESSERACT_VERSION = '5.1.1';
  const TESSERACT_URL = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js`;
  const MAX_IMAGE_FILES = 12;
  const MAX_IMAGE_BYTES = 18 * 1024 * 1024;
  const IMAGE_TARGET_WIDTH = 2500;
  const IMAGE_MAX_HEIGHT = 6200;

  const previousAnalyzeFile = previous.analyzeFile.bind(previous);
  const previousRenderPreview = typeof previous.renderPreview === 'function' ? previous.renderPreview.bind(previous) : null;
  const previousDownloadKnowledgeJson = typeof previous.downloadKnowledgeJson === 'function' ? previous.downloadKnowledgeJson.bind(previous) : null;
  const resolveCardFirst = typeof previous.resolveKnowledgeDocumentCardFirst === 'function'
    ? previous.resolveKnowledgeDocumentCardFirst.bind(previous)
    : null;

  let tesseractPromise = null;
  let activeSource = { type: '', hash: '', rasterPages: [], text: '' };

  const clamp = (v, min, max) => Math.max(min, Math.min(max, Number(v) || 0));
  const clean = (v) => String(v == null ? '' : v).replace(/\u0000/g, '').replace(/[\t\u00a0]+/g, ' ').replace(/\s+/g, ' ').trim();
  const fold = (v) => clean(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
  const normalizeName = (v) => fold(v).replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  const unique = (list) => [...new Set((list || []).filter(Boolean))];
  const validPrice = (v) => Number.isFinite(Number(v)) && Number(v) > 0 && Number(v) < 10000;

  const INSTITUTIONAL_RE = /\b(?:HOR[ÁA]RIO\s+DE\s+ATENDIMENTO|PRE[CÇ]OS?\s+V[ÁA]LID|OFERTAS?|FEIR[ÃA]O|WHATSAPP|RECEBA\s+NOSSAS|ESCANEIE|QR\s*CODE|GOOGLE\s*PLAY|APP\s*STORE|CLUBE\s+DE\s+VANTAGENS|TODO\s+MUNDO|ATACADO|ATACADISTA|ENQUANTO\s+HOUVER\s+ESTOQUE|ENQUANTO\s+DURAREM|DOMINGO|FERIADOS?|SEGUNDA\s+A\s+S[ÁA]BADO|PARTICIPE\s+DA\s+COMUNIDADE)\b/i;
  const CONDITION_RE = /\b(?:A\s+PARTIR\s+DE|LEVE\s+\d+|PAGUE\s+\d+|POR\s+CLIENTE|LIMITE|CLUBE|APP|APLICATIVO|CADA|UNIDADE\s+SAI\s+POR|NESTA\s+EMBALAGEM|ENQUANTO\s+HOUVER|ENQUANTO\s+DURAREM|EXCETO|SOMENTE)\b/i;
  const PACKAGE_RE = /\b(?:PACOTE|PCT|BANDEJA|BDJ|POTE|GARRAFA|PET|LATA|CAIXA|CX|SACO|SACH[ÊE]|FRASCO|CARTELA|UNIDADE|UNID|UN|UND)\s*(?:DE\s*)?\d*(?:[,.]\d+)?\s*(?:KG|G|GR|ML|L|LT|LTS|UN|UND|UNIDADES?)?\b|\b\d+(?:[,.]\d+)?\s*(?:KG|G|GR|ML|L|LT|LTS|UN|UND|UNIDADES?)\b|\b(?:KG|UNIDADE|UNID|UNIDADES|BDJ)\b/i;

  function bbox(word) {
    if (!word) return null;
    const x = Number(word.x ?? word.x0 ?? word.left ?? 0);
    const y = Number(word.y ?? word.y0 ?? word.top ?? 0);
    const width = Math.max(1, Number(word.width ?? ((word.x1 ?? x + 1) - x) ?? 1));
    const height = Math.max(1, Number(word.height ?? ((word.y1 ?? y + 1) - y) ?? 1));
    return { x, y, width, height, x1: x + width, y1: y + height };
  }

  function unionBoxes(values) {
    const boxes = (values || []).map(bbox).filter(Boolean);
    if (!boxes.length) return null;
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x1));
    const y1 = Math.max(...boxes.map((b) => b.y1));
    return { x, y, width: Math.max(1, x1 - x), height: Math.max(1, y1 - y), x1, y1 };
  }

  function center(value) {
    const b = bbox(value);
    return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : { x: 0, y: 0 };
  }

  function overlap1d(a0, a1, b0, b1) {
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  }

  function intersectionRatio(aValue, bValue) {
    const a = bbox(aValue), b = bbox(bValue);
    if (!a || !b) return 0;
    const ix = overlap1d(a.x, a.x1, b.x, b.x1);
    const iy = overlap1d(a.y, a.y1, b.y, b.y1);
    const area = ix * iy;
    if (!area) return 0;
    return area / Math.max(1, Math.min(a.width * a.height, b.width * b.height));
  }

  function median(values) {
    const a = (values || []).map(Number).filter(Number.isFinite).sort((x, y) => x - y);
    if (!a.length) return 0;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  async function sha256Bytes(bytes) {
    try {
      const hash = await crypto.subtle.digest('SHA-256', bytes);
      return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch (_) { return ''; }
  }

  async function sha256Text(text) {
    return sha256Bytes(new TextEncoder().encode(String(text || '')).buffer);
  }

  async function sha256Files(files) {
    try {
      const parts = [];
      let total = 0;
      for (const file of files) {
        const name = new TextEncoder().encode(`${file.name}\n${file.type}\n${file.size}\n`);
        const body = new Uint8Array(await file.arrayBuffer());
        parts.push(name, body);
        total += name.length + body.length;
      }
      const merged = new Uint8Array(total);
      let offset = 0;
      parts.forEach((part) => { merged.set(part, offset); offset += part.length; });
      return sha256Bytes(merged.buffer);
    } catch (_) { return ''; }
  }

  function normalizeNumericText(value) {
    return fold(value)
      .replace(/(?<=\d)[OQ](?=\d|\b)/g, '0')
      .replace(/[IL|](?=\d)/g, '1')
      .replace(/(?<=\d)[IL|](?=\d|\b)/g, '1')
      .replace(/\bRS\b/g, 'R$')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function parseMoneyText(value) {
    let text = normalizeNumericText(value);
    const explicitCurrency = /R\s*\$|\bR\$|\bRS\b/.test(text);
    let m = text.match(/(?:R\s*\$\s*)?(\d{1,4})\s*[,.;:]\s*(\d{2})(?!\d)/);
    if (m) {
      const price = Number(`${m[1]}.${m[2]}`);
      if (validPrice(price)) return { price:Number(price.toFixed(2)), explicitCurrency, pattern:'decimal' };
    }
    if (explicitCurrency) {
      m = text.match(/R\s*\$\s*(\d{1,4})\s+(\d{2})(?!\d)/);
      if (m) {
        const price = Number(`${m[1]}.${m[2]}`);
        if (validPrice(price)) return { price:Number(price.toFixed(2)), explicitCurrency:true, pattern:'split-cents' };
      }
      m = text.match(/R\s*\$\s*(\d{3,5})(?!\d)/);
      if (m) {
        const digits = m[1];
        const price = Number(`${digits.slice(0,-2)}.${digits.slice(-2)}`);
        if (validPrice(price)) return { price:Number(price.toFixed(2)), explicitCurrency:true, pattern:'compact-cents' };
      }
    }
    return null;
  }

  function looksNumericWord(value) {
    const t = fold(value).replace(/\s+/g, '');
    return /^(?:R\$|R|\$|RS|[0-9IL|OQ]+|[,.;:])$/.test(t)
      || /^(?:R\$)?[0-9IL|OQ]{1,5}[,.;:][0-9IL|OQ]{1,2}$/.test(t);
  }

  function currencyWord(value) {
    return /^(?:R\$|R|\$|RS)$/i.test(clean(value));
  }

  function numericDigits(value) {
    const t = normalizeNumericText(value).replace(/[^0-9]/g, '');
    return t;
  }

  function normalizeWords(data, pass) {
    const rawWords = Array.isArray(data?.words) && data.words.length
      ? data.words
      : (Array.isArray(data?.blocks) ? data.blocks.flatMap((block) => (block.paragraphs || []).flatMap((p) => (p.lines || []).flatMap((l) => l.words || []))) : []);
    return rawWords.map((word, index) => {
      const b = word.bbox || {};
      const x = Number(b.x0 ?? b.left ?? word.left ?? 0);
      const y = Number(b.y0 ?? b.top ?? word.top ?? 0);
      const x1 = Number(b.x1 ?? b.right ?? x + Number(word.width || 1));
      const y1 = Number(b.y1 ?? b.bottom ?? y + Number(word.height || 1));
      return {
        id:`${pass}-${index}`,
        text:clean(word.text),
        confidence:clamp(Number(word.confidence ?? word.conf ?? 0), 0, 100),
        x, y, width:Math.max(1, x1-x), height:Math.max(1, y1-y),
        sources:[pass], alternatives:[]
      };
    }).filter((word) => word.text && word.width > 0 && word.height > 0);
  }

  function mergeWordSets(wordSets) {
    const output = [];
    (wordSets || []).flat().sort((a,b) => Number(b.confidence)-Number(a.confidence)).forEach((word) => {
      const wc = center(word);
      const same = output.find((existing) => {
        const ec = center(existing);
        const overlap = intersectionRatio(existing, word);
        const dist = Math.hypot(ec.x-wc.x, ec.y-wc.y);
        const scale = Math.max(8, Math.min(existing.height, word.height));
        return overlap >= .50 || (dist <= scale*.58 && Math.abs(existing.width-word.width) <= Math.max(existing.width,word.width)*.55);
      });
      if (!same) {
        output.push({ ...word, sources:[...(word.sources||[])], alternatives:[] });
        return;
      }
      same.sources = unique([...(same.sources||[]), ...(word.sources||[])]);
      if (normalizeName(same.text) !== normalizeName(word.text) && word.text) {
        same.alternatives = unique([...(same.alternatives||[]), word.text]);
      }
      if (Number(word.confidence) > Number(same.confidence)) {
        const preservedSources = same.sources, alternatives = same.alternatives;
        Object.assign(same, word);
        same.sources = preservedSources;
        same.alternatives = alternatives;
      }
    });
    return output.sort((a,b) => a.y-b.y || a.x-b.x);
  }

  function segmentLines(words) {
    if (!(words || []).length) return [];
    const medianH = Math.max(8, median(words.map((w) => w.height)) || 16);
    const tolerance = Math.max(7, medianH*.58);
    const rows = [];
    [...words].sort((a,b)=>a.y-b.y||a.x-b.x).forEach((word) => {
      const cy = word.y + word.height/2;
      let best = null, delta = Infinity;
      rows.forEach((row) => {
        const d = Math.abs(row.cy-cy);
        if (d <= tolerance && d < delta) { best=row; delta=d; }
      });
      if (!best) { best={cy,words:[]}; rows.push(best); }
      best.words.push(word);
      best.cy = best.words.reduce((sum,w)=>sum+w.y+w.height/2,0)/best.words.length;
    });
    const lines=[];
    rows.forEach((row) => {
      const sorted=row.words.sort((a,b)=>a.x-b.x);
      let segment=[];
      const flush=()=>{
        if(!segment.length)return;
        const b=unionBoxes(segment);
        const text=clean(segment.map((w)=>w.text).join(' '));
        const confidence=segment.reduce((sum,w)=>sum+Number(w.confidence||0),0)/segment.length;
        const sources=unique(segment.flatMap((w)=>w.sources||[]));
        lines.push({text,confidence,bbox:{x:b.x,y:b.y,width:b.width,height:b.height},wordIds:segment.map((w)=>w.id),sources});
        segment=[];
      };
      sorted.forEach((word) => {
        if(segment.length){
          const prev=segment[segment.length-1];
          const gap=word.x-(prev.x+prev.width);
          const scale=Math.max(prev.height,word.height,medianH,8);
          if(gap>Math.max(24,Math.min(58,scale*1.75)))flush();
        }
        segment.push(word);
      });
      flush();
    });
    return lines.sort((a,b)=>a.bbox.y-b.bbox.y||a.bbox.x-b.bbox.x);
  }

  function pricesFromPass(words, lines, pass) {
    const found=[];
    const medianH=Math.max(8,median(words.map((w)=>w.height))||16);

    (lines||[]).forEach((line) => {
      const lineWords=(line.wordIds||[]).map((id)=>words.find((w)=>w.id===id)).filter(Boolean).sort((a,b)=>a.x-b.x);
      for(let i=0;i<lineWords.length;i+=1){
        if(!looksNumericWord(lineWords[i].text))continue;
        for(let len=1;len<=5&&i+len<=lineWords.length;len+=1){
          const slice=lineWords.slice(i,i+len);
          if(slice.some((w)=>!looksNumericWord(w.text)))break;
          const parsed=parseMoneyText(slice.map((w)=>w.text).join(' '));
          if(!parsed)continue;
          const b=unionBoxes(slice);
          const confidence=slice.reduce((sum,w)=>sum+Number(w.confidence||0),0)/slice.length;
          const scale=b.height/medianH;
          if(!parsed.explicitCurrency && scale<1.30)continue;
          found.push({value:parsed.price,text:clean(slice.map((w)=>w.text).join(' ')),confidence,currencyExplicit:parsed.explicitCurrency,pattern:parsed.pattern,passes:1,passNames:[pass],bbox:{x:b.x,y:b.y,width:b.width,height:b.height}});
        }
      }
    });

    // Reconstrói tipografia promocional em que reais e centavos são glifos separados.
    const currency = words.filter((w)=>currencyWord(w.text));
    const majors = words.filter((w)=>/^\d{1,3}$/.test(numericDigits(w.text)) && w.height>=medianH*1.30);
    majors.forEach((major) => {
      const mc=center(major), majorDigits=numericDigits(major.text);
      const cents=words.filter((w)=>w!==major&&/^\d{2}$/.test(numericDigits(w.text))).filter((w)=>{
        const wc=center(w), gap=w.x-(major.x+major.width), ratio=w.height/Math.max(1,major.height);
        return gap>=-8&&gap<=Math.max(74,major.height*2.8)&&Math.abs(wc.y-mc.y)<=Math.max(54,major.height*1.25)&&ratio>=.28&&ratio<=1.45;
      }).sort((a,b)=>Math.abs(a.x-(major.x+major.width))-Math.abs(b.x-(major.x+major.width)));
      if(!cents.length)return;
      const nearbyCurrency=currency.filter((r)=>{
        const rc=center(r);
        return rc.x<=mc.x+20&&Math.abs(rc.y-mc.y)<=Math.max(65,major.height*1.5)&&mc.x-rc.x<=Math.max(190,major.height*5.5);
      }).sort((a,b)=>Math.abs(center(a).x-mc.x)-Math.abs(center(b).x-mc.x))[0];
      if(!nearbyCurrency && major.height<medianH*1.58)return;
      const value=Number(`${majorDigits}.${numericDigits(cents[0].text)}`);
      if(!validPrice(value))return;
      const parts=nearbyCurrency?[nearbyCurrency,major,cents[0]]:[major,cents[0]];
      const b=unionBoxes(parts);
      found.push({value:Number(value.toFixed(2)),text:clean(parts.map((w)=>w.text).join(' ')),confidence:parts.reduce((s,w)=>s+Number(w.confidence||0),0)/parts.length,currencyExplicit:Boolean(nearbyCurrency),pattern:'spatial-major-cents',passes:1,passNames:[pass],bbox:{x:b.x,y:b.y,width:b.width,height:b.height}});
    });

    const dedup=[];
    found.sort((a,b)=>Number(b.currencyExplicit)-Number(a.currencyExplicit)||b.confidence-a.confidence).forEach((price)=>{
      const pc=center(price);
      const existing=dedup.find((x)=>Math.abs(Number(x.value)-Number(price.value))<.011&&Math.abs(center(x).x-pc.x)<Math.max(45,price.bbox.height*1.4)&&Math.abs(center(x).y-pc.y)<Math.max(34,price.bbox.height));
      if(!existing)dedup.push(price);
    });
    return dedup;
  }

  function mergePricePasses(passPrices) {
    const all=(passPrices||[]).flat();
    const groups=[];
    all.forEach((price)=>{
      const pc=center(price);
      let group=groups.find((g)=>Math.abs(center(g.reference).x-pc.x)<Math.max(72,price.bbox.height*2.1)&&Math.abs(center(g.reference).y-pc.y)<Math.max(55,price.bbox.height*1.55));
      if(!group){group={reference:price,items:[]};groups.push(group);}
      group.items.push(price);
      if(Number(price.confidence)>Number(group.reference.confidence))group.reference=price;
    });
    return groups.map((group)=>{
      const votes=new Map();
      group.items.forEach((item)=>{
        const key=Number(item.value).toFixed(2);
        if(!votes.has(key))votes.set(key,{value:Number(item.value),items:[],passes:new Set()});
        votes.get(key).items.push(item);
        (item.passNames||[]).forEach((p)=>votes.get(key).passes.add(p));
      });
      const ranked=[...votes.values()].sort((a,b)=>b.passes.size-a.passes.size||b.items.length-a.items.length||Math.max(...b.items.map((x)=>x.confidence))-Math.max(...a.items.map((x)=>x.confidence)));
      const winner=ranked[0];
      const best=[...winner.items].sort((a,b)=>Number(b.currencyExplicit)-Number(a.currencyExplicit)||b.confidence-a.confidence)[0];
      const runner=ranked[1];
      const conflict=Boolean(runner && runner.passes.size>=winner.passes.size);
      const confidence=conflict?Math.min(74,best.confidence):Math.min(99,Math.max(best.confidence,winner.passes.size>=2?92:best.confidence));
      return {...best,value:winner.value,confidence,passes:winner.passes.size,passNames:[...winner.passes],conflict,conflictValues:ranked.slice(1,4).map((x)=>x.value)};
    }).filter((p)=>validPrice(p.value)).sort((a,b)=>a.bbox.y-b.bbox.y||a.bbox.x-b.bbox.x);
  }

  function preprocessCanvas(source, mode) {
    const canvas=document.createElement('canvas');
    canvas.width=source.width;canvas.height=source.height;
    const ctx=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
    ctx.drawImage(source,0,0);
    if(mode==='original')return canvas;
    const image=ctx.getImageData(0,0,canvas.width,canvas.height),d=image.data;
    for(let i=0;i<d.length;i+=4){
      const r=d[i],g=d[i+1],b=d[i+2],lum=.299*r+.587*g+.114*b;
      let value;
      if(mode==='price-invert') value=lum>=176?0:255;
      else if(mode==='strong') value=clamp(Math.round((lum-128)*1.55+128),0,255);
      else value=clamp(Math.round((lum-128)*1.18+128),0,255);
      if(mode!=='price-invert'){
        if(value>248)value=255;
        if(value<12)value=0;
      }
      d[i]=d[i+1]=d[i+2]=value;d[i+3]=255;
    }
    ctx.putImageData(image,0,0);
    return canvas;
  }

  async function loadTesseract() {
    if(window.Tesseract?.createWorker)return window.Tesseract;
    if(!tesseractPromise){
      tesseractPromise=new Promise((resolve,reject)=>{
        const existing=document.querySelector(`script[data-mercador-document-tesseract="${TESSERACT_VERSION}"]`);
        if(existing){
          existing.addEventListener('load',()=>resolve(window.Tesseract),{once:true});
          existing.addEventListener('error',()=>reject(new Error('Falha ao carregar o OCR visual.')),{once:true});
          return;
        }
        const script=document.createElement('script');
        script.src=TESSERACT_URL;script.async=true;script.crossOrigin='anonymous';script.dataset.mercadorDocumentTesseract=TESSERACT_VERSION;
        script.onload=()=>window.Tesseract?.createWorker?resolve(window.Tesseract):reject(new Error('OCR visual carregou sem API disponível.'));
        script.onerror=()=>reject(new Error('Não foi possível carregar o OCR visual. Verifique a conexão.'));
        document.head.appendChild(script);
      });
    }
    return tesseractPromise;
  }

  async function imageFileToCanvas(file) {
    if(!file||!String(file.type||'').startsWith('image/'))throw new Error('Arquivo de imagem inválido.');
    if(file.size>MAX_IMAGE_BYTES)throw new Error(`A imagem ${file.name||''} ultrapassa 18 MB.`);
    let bitmap=null,url='';
    try{
      if(typeof createImageBitmap==='function')bitmap=await createImageBitmap(file);
      let width,height,drawSource;
      if(bitmap){width=bitmap.width;height=bitmap.height;drawSource=bitmap;}
      else{
        url=URL.createObjectURL(file);
        const img=await new Promise((resolve,reject)=>{const el=new Image();el.onload=()=>resolve(el);el.onerror=()=>reject(new Error(`Não foi possível abrir ${file.name||'a imagem'}.`));el.src=url;});
        width=img.naturalWidth;height=img.naturalHeight;drawSource=img;
      }
      if(!(width>0&&height>0))throw new Error('Imagem sem dimensões válidas.');
      const scale=Math.min(Math.max(1,IMAGE_TARGET_WIDTH/width),IMAGE_MAX_HEIGHT/height);
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
      const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(drawSource,0,0,canvas.width,canvas.height);
      return {canvas,originalWidth:width,originalHeight:height,scale};
    }finally{if(bitmap?.close)bitmap.close();if(url)URL.revokeObjectURL(url);}
  }

  async function recognizePass(worker, canvas, pass, psm, onProgress, pageIndex, pageCount, passIndex, passCount, whitelist='') {
    await worker.setParameters({preserve_interword_spaces:'1',tessedit_pageseg_mode:String(psm),tessedit_char_whitelist:whitelist}).catch(()=>{});
    const result=await worker.recognize(canvas);
    const words=normalizeWords(result.data,pass);
    const lines=segmentLines(words);
    if(onProgress){
      const part=(pageIndex+(passIndex+1)/passCount)/pageCount;
      onProgress({pageNumber:pageIndex+1,numPages:pageCount,percent:Math.round(5+part*82),mode:`image-${pass}`});
    }
    return {pass,words,lines,text:clean(result.data?.text||lines.map((x)=>x.text).join(' '))};
  }

  function normalizeValidityRaw(validity) {
    if(!validity)return {startAt:null,endAt:null,raw:'',condition:'',inferred:false};
    return {startAt:Number(validity.startAt)||null,endAt:Number(validity.endAt)||null,raw:clean(validity.raw),condition:clean(validity.condition),inferred:validity.inferred===true,provided:validity.provided===true};
  }

  function localDate(year,month,day,end){
    const d=new Date(Number(year),Number(month)-1,Number(day),end?23:0,end?59:0,end?59:0,end?999:0);
    return Number.isFinite(d.getTime())?d.getTime():null;
  }

  function extractValidityFlexible(rawText) {
    const text=clean(rawText);
    const base=typeof previous.extractValidity==='function'?normalizeValidityRaw(previous.extractValidity(text)):normalizeValidityRaw(null);
    if(base.startAt&&base.endAt)return {...base,inferred:false};
    let m=text.match(/\b(?:DIAS?\s*:?)?\s*(\d{1,2})\s*(?:E|A|AT[ÉE])\s*(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})\b/i);
    if(m)return {startAt:localDate(m[4],m[3],m[1],false),endAt:localDate(m[4],m[3],m[2],true),raw:m[0],condition:/ENQUANTO\s+(?:HOUVER|DURAREM)/i.test(text)?'enquanto houver estoque':'',inferred:false};
    m=text.match(/\b(\d{1,2})[\/.](\d{1,2})\s*(?:E|A|AT[ÉE])\s*(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})\b/i);
    if(m)return {startAt:localDate(m[5],m[2],m[1],false),endAt:localDate(m[5],m[4],m[3],true),raw:m[0],condition:/ENQUANTO\s+(?:HOUVER|DURAREM)/i.test(text)?'enquanto houver estoque':'',inferred:false};
    return base;
  }

  function sourceValidity(options, documentText) {
    const start=Number(options?.suppliedStartAt||0),end=Number(options?.suppliedEndAt||0);
    if(start>0&&end>start)return {startAt:start,endAt:end,raw:'validade informada pelo administrador',condition:'',inferred:false,provided:true};
    return extractValidityFlexible(documentText);
  }

  function serializableWord(word) {
    return {id:word.id,text:word.text,normalized:normalizeName(word.text),confidence:Number(word.confidence||0),bbox:{x:word.x,y:word.y,width:word.width,height:word.height},sources:[...(word.sources||[])],alternatives:[...(word.alternatives||[])]};
  }

  async function analyzeImages(files, options={}, onProgress) {
    const list=[...(files||[])].filter((file)=>String(file.type||'').startsWith('image/'));
    if(!list.length)throw new Error('Selecione pelo menos uma imagem válida.');
    if(list.length>MAX_IMAGE_FILES)throw new Error(`Selecione no máximo ${MAX_IMAGE_FILES} imagens por análise.`);
    const Tesseract=await loadTesseract();
    const hashPromise=sha256Files(list);
    const rasterPages=[];let currentProgress={pageIndex:0,passIndex:0,passCount:4,pageCount:list.length};
    const worker=await Tesseract.createWorker('por',1,{logger:(m)=>{
      if(m.status==='recognizing text'&&onProgress){
        const base=(currentProgress.pageIndex+(currentProgress.passIndex+Number(m.progress||0))/currentProgress.passCount)/currentProgress.pageCount;
        onProgress({pageNumber:currentProgress.pageIndex+1,numPages:currentProgress.pageCount,percent:Math.round(4+base*82),mode:'image-ocr'});
      }
    }});
    try{
      const pages=[];const documentParts=[];
      for(let pageIndex=0;pageIndex<list.length;pageIndex+=1){
        const file=list[pageIndex];
        if(onProgress)onProgress({pageNumber:pageIndex+1,numPages:list.length,percent:Math.round(3+pageIndex/list.length*82),mode:'image-prepare'});
        const raster=await imageFileToCanvas(file);
        rasterPages.push({pageNumber:pageIndex+1,fileName:file.name,canvas:raster.canvas,originalWidth:raster.originalWidth,originalHeight:raster.originalHeight,scale:raster.scale});
        const mild=preprocessCanvas(raster.canvas,'mild'),strong=preprocessCanvas(raster.canvas,'strong'),priceInvert=preprocessCanvas(raster.canvas,'price-invert');
        const specs=[
          {pass:'layout',canvas:raster.canvas,psm:11,whitelist:''},
          {pass:'gray',canvas:mild,psm:11,whitelist:''},
          {pass:'strong',canvas:strong,psm:6,whitelist:''},
          {pass:'price',canvas:priceInvert,psm:11,whitelist:'R$0123456789,. '}
        ];
        const passResults=[];
        for(let passIndex=0;passIndex<specs.length;passIndex+=1){
          currentProgress={pageIndex,passIndex,passCount:specs.length,pageCount:list.length};
          const spec=specs[passIndex];
          passResults.push(await recognizePass(worker,spec.canvas,spec.pass,spec.psm,onProgress,pageIndex,list.length,passIndex,specs.length,spec.whitelist));
        }
        await worker.setParameters({tessedit_char_whitelist:''}).catch(()=>{});
        const textPasses=passResults.filter((x)=>x.pass!=='price');
        const words=mergeWordSets(textPasses.map((x)=>x.words));
        const lines=segmentLines(words);
        const passPrices=passResults.map((x)=>pricesFromPass(x.words,x.lines,x.pass));
        const prices=mergePricePasses(passPrices);
        const text=clean(unique(textPasses.map((x)=>x.text).filter(Boolean)).join(' '));
        documentParts.push(text);
        pages.push({
          pageNumber:pageIndex+1,width:raster.canvas.width,height:raster.canvas.height,mode:'image-ocr',text,
          metrics:{words:words.length,lines:lines.length,pricesDetected:prices.length,ocrPasses:passResults.length},
          words:words.map(serializableWord),lines,prices,
          ocrPasses:passResults.map((x)=>({pass:x.pass,text:x.text,words:x.words.length,lines:x.lines.length,prices:pricesFromPass(x.words,x.lines,x.pass).length}))
        });
        [mild,strong,priceInvert].forEach((canvas)=>{canvas.width=1;canvas.height=1;});
      }
      const documentText=clean(documentParts.join(' '));
      const validity=sourceValidity(options,documentText);
      const hash=await hashPromise;
      const knowledgeDocument={
        schemaVersion:KNOWLEDGE_SCHEMA_VERSION,engineVersion:ENGINE_VERSION,generatedAt:new Date().toISOString(),sourceType:'image',
        source:{type:'image',fileName:list.length===1?list[0].name:`${list.length} imagens`,files:list.map((f)=>({name:f.name,mimeType:f.type,size:f.size})),sha256:hash,numPages:pages.length},
        extraction:{mode:'image-ocr-multipass',modes:['image','ocr','geometry','multipass'],tesseractVersion:TESSERACT_VERSION,geometryAvailable:true},
        validity,documentText,pages,promotionFacts:[]
      };
      let result={fileName:list.length===1?list[0].name:`${list.length} imagens do encarte`,hash,numPages:pages.length,validity,candidates:[],engineVersion:ENGINE_VERSION,pdfjsVersion:'—',extractionMode:'image-ocr-multipass',knowledgeSchemaVersion:KNOWLEDGE_SCHEMA_VERSION,knowledgeDocument,knowledgeMetrics:{pages:pages.length,modes:['image-ocr','geometry','multipass'],words:pages.reduce((s,p)=>s+p.words.length,0),lines:pages.reduce((s,p)=>s+p.lines.length,0),prices:pages.reduce((s,p)=>s+p.prices.length,0),candidates:0},sourceType:'image',sourceLabel:list.length===1?'Imagem':'Imagens'};
      if(resolveCardFirst)result=resolveCardFirst(result);
      result=promoteStrongImageCards(result);
      result.sourceType='image';result.sourceLabel=list.length===1?'Imagem':'Imagens';
      result.knowledgeMetrics={...(result.knowledgeMetrics||{}),candidates:(result.candidates||[]).length};
      window.MercadorPDFImporter.lastKnowledgeDocument=result.knowledgeDocument||null;
      activeSource={type:'image',hash,rasterPages,text:''};
      if(onProgress)onProgress({pageNumber:pages.length,numPages:pages.length,percent:100,mode:'image-complete'});
      return result;
    }finally{await worker.terminate().catch(()=>{});}
  }

  function upgradeKnowledgeV6(result, sourceType, sourceLabel) {
    if (!result) return result;
    const engine = String(result.engineVersion || '');
    const finalEngine = engine.includes(ENGINE_VERSION) ? engine : `${engine || 'document'}+${ENGINE_VERSION}`;
    let knowledge = result.knowledgeDocument;
    if (knowledge && typeof knowledge === 'object') {
      knowledge = {
        ...knowledge,
        previousSchemaVersion: knowledge.schemaVersion && knowledge.schemaVersion !== KNOWLEDGE_SCHEMA_VERSION ? knowledge.schemaVersion : (knowledge.previousSchemaVersion || ''),
        schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
        sourceType,
        multiformatEngineVersion: ENGINE_VERSION,
        source: { ...(knowledge.source || {}), type: sourceType }
      };
    }
    return { ...result, sourceType, sourceLabel, engineVersion: finalEngine, knowledgeSchemaVersion: KNOWLEDGE_SCHEMA_VERSION, knowledgeDocument: knowledge };
  }

  function promoteStrongImageCards(result) {
    const visualBlocks=result?.knowledgeDocument?.visualBlocks||[];
    const cardMap=new Map(visualBlocks.map((card)=>[card.id,card]));
    const validity=result?.validity||{};
    const validitySafe=Boolean(validity.startAt&&validity.endAt&&!validity.inferred);
    const candidates=(result?.candidates||[]).map((candidate)=>{
      if(!candidate?.cardId)return candidate;
      const card=cardMap.get(candidate.cardId);if(!card)return candidate;
      const anchor=card.priceAnchor||{};
      const textPassSupport=Number(card.textPassSupport||0);
      const conflict=anchor.conflict===true||(anchor.conflictValues||[]).length>0;
      const strong=validitySafe&&!conflict&&anchor.currencyExplicit===true&&Number(anchor.passes||0)>=2&&Number(anchor.confidence||0)>=.90&&Number(card.confidence||0)>=.92&&textPassSupport>=2&&clean(candidate.productName).length>=3;
      const risks=new Set(candidate.riskFlags||[]);
      if(conflict)risks.add('image_price_conflict');
      if(!validitySafe)risks.add('missing_validity');
      if(textPassSupport<2)risks.add('image_text_single_pass');
      if(strong){
        risks.delete('single_association_pass');risks.delete('ocr_block_ownership_weak');risks.delete('ocr_price_without_currency');risks.delete('image_text_single_pass');
      }
      const hard=[...risks].some((risk)=>['association_disagreement','missing_validity','invalid_price','header_contamination','ocr_price_conflict','knowledge_legacy_description_conflict','image_price_conflict'].includes(risk));
      return {...candidate,riskFlags:[...risks],confidence:strong&&!hard?Math.max(Number(candidate.confidence||0),.985):Number(candidate.confidence||0),structuralSafe:strong&&!hard,automationSafe:strong&&!hard,evidence:unique([...(candidate.evidence||[]),strong?'card de imagem confirmado por múltiplas leituras OCR independentes':'imagem preservada para revisão quando a evidência não é unânime']),extractionMode:`${candidate.extractionMode||'image'}+multiformat`};
    });
    if(result?.knowledgeDocument){
      result.knowledgeDocument.offerCandidates=candidates.map((c)=>({id:c.id,pageNumber:c.pageNumber,cardId:c.cardId||null,productName:c.productName,packageText:c.packageText||'',price:Number(c.price||0),confidence:Number(c.confidence||0),automationSafe:c.automationSafe===true,structuralSafe:c.structuralSafe===true,riskFlags:[...(c.riskFlags||[])],bbox:c.sourceBox||null}));
      result.knowledgeDocument.resolvedOffers=candidates.filter((c)=>c.automationSafe===true||c.structuralSafe===true).map((c)=>({id:c.id,pageNumber:c.pageNumber,cardId:c.cardId||null,productName:c.productName,packageText:c.packageText||'',price:Number(c.price||0),confidence:Number(c.confidence||0),bbox:c.sourceBox||null}));
    }
    return upgradeKnowledgeV6({...result,candidates}, 'image', result.sourceLabel || 'Imagem');
  }

  function textPriceMatches(line) {
    const output=[];
    const regex=/(?:R\s*\$|R\$|\$)?\s*(\d{1,4})\s*[,.;:]\s*(\d{2})\b/gi;
    let m;
    while((m=regex.exec(line))){
      const price=Number(`${m[1]}.${m[2]}`);if(!validPrice(price))continue;
      output.push({price:Number(price.toFixed(2)),text:m[0],currencyExplicit:/R\s*\$|R\$/.test(m[0])});
    }
    return output;
  }

  function cleanTextCandidate(value) {
    return clean(value).replace(/(?:R\s*\$|R\$|\$)?\s*\d{1,4}\s*[,.;:]\s*\d{2}\b/gi,' ').replace(/\s+/g,' ').trim();
  }

  function textProductLines(lines, priceIndex, previousPriceIndex) {
    const start=Math.max(previousPriceIndex+1,priceIndex-6);
    const candidates=[];
    for(let i=start;i<=priceIndex;i+=1){
      const text=cleanTextCandidate(lines[i]||'');
      if(!text||INSTITUTIONAL_RE.test(text)||/\bPRE[CÇ]OS?\s+V[ÁA]LID/i.test(text)||/\bHOR[ÁA]RIO\s+DE\s+ATENDIMENTO/i.test(text)||/^\d+[\s\d/.-]*$/.test(text))continue;
      if(CONDITION_RE.test(text)&&candidates.length)continue;
      candidates.push({index:i,text});
    }
    return candidates.slice(-4);
  }

  function extractPackage(text) {
    const m=clean(text).match(PACKAGE_RE);return m?clean(m[0]):'';
  }

  async function analyzeText(rawText, options={}, onProgress, fileName='texto-colado.txt') {
    const raw=String(rawText||'').replace(/\r\n?/g,'\n');
    if(!raw.trim())throw new Error('Cole o texto/OCR do encarte antes de analisar.');
    if(onProgress)onProgress({pageNumber:1,numPages:1,percent:10,mode:'text-parse'});
    const lines=raw.split('\n').map((line)=>line.trim()).filter(Boolean);
    const documentText=clean(raw);
    const validity=sourceValidity(options,documentText);
    const hash=await sha256Text(raw);
    const candidates=[];const conflicts=[];let previousPriceIndex=-1;
    lines.forEach((line,index)=>{
      const prices=textPriceMatches(line);if(!prices.length)return;
      const productLines=textProductLines(lines,index,previousPriceIndex);
      const productName=clean(productLines.map((x)=>x.text).join(' '));
      prices.forEach((price,pIndex)=>{
        if(!productName)return;
        const risks=['text_source_no_geometry'];
        if(!price.currencyExplicit)risks.push('text_price_without_currency');
        if(!validity.startAt||!validity.endAt)risks.push('missing_validity');
        if(prices.length>1)risks.push('ambiguous_price_kind');
        const category=window.MercadorIA?.inferCategory?.(productName)||'outros';
        const id=`text-${index+1}-${pIndex+1}`;
        const candidate={id,pageNumber:1,pageWidth:0,pageHeight:0,productName:productName.slice(0,160),category,brand:'',packageText:extractPackage(productName).slice(0,100),price:price.price,previousPrice:null,detectedPrices:prices.map((x)=>x.price),priceKind:prices.length>1?'review':'general',requiresClub:false,clubName:'',conditions:validity.condition||'',confidence:.72,riskFlags:risks,evidence:['texto/OCR preservado como fonte sem geometria','publicação automática bloqueada porque a relação espacial do encarte não está disponível'],associationAgreement:.45,ownershipConfidence:.30,clusterCoherence:.55,descriptionCompleteness:clamp(productName.split(/\s+/).length/8,.35,1),descriptionAgreement:.45,descriptionVariantCount:1,knowledgeCardText:productLines.map((x)=>x.text).join(' '),structuralSafe:false,automationSafe:false,sourceBox:null,startAt:validity.startAt||null,endAt:validity.endAt||null,verified:false,verificationMode:'',ignored:false,published:false,reviewed:false,extractionMode:'text-no-geometry',sourceText:[...productLines.map((x)=>x.text),price.text].join('\n')};
        candidates.push(candidate);
        conflicts.push({id:`conflict-${id}`,type:'text_source_no_geometry',productName:candidate.productName,price:candidate.price,resolution:'manual_review_required'});
      });
      previousPriceIndex=index;
    });
    const pageLines=lines.map((text,index)=>({text,confidence:100,bbox:null,wordIds:[],sources:['text']}));
    const knowledgeDocument={schemaVersion:KNOWLEDGE_SCHEMA_VERSION,engineVersion:ENGINE_VERSION,generatedAt:new Date().toISOString(),sourceType:'text',source:{type:'text',fileName,mimeType:'text/plain',size:new TextEncoder().encode(raw).length,sha256:hash,numPages:1},extraction:{mode:'text-preserved',modes:['text','no-geometry'],geometryAvailable:false},validity,documentText,pages:[{pageNumber:1,width:0,height:0,mode:'text',text:documentText,metrics:{lines:lines.length,pricesDetected:candidates.length},words:[],lines:pageLines,prices:[]}],visualBlocks:[],offerCandidates:candidates.map((c)=>({id:c.id,productName:c.productName,packageText:c.packageText,price:c.price,riskFlags:c.riskFlags,evidence:c.evidence})),resolvedOffers:[],conflicts,promotionFacts:candidates.map((c)=>({id:c.id,productName:c.productName,price:c.price,packageText:c.packageText,confidence:c.confidence,riskFlags:c.riskFlags}))};
    activeSource={type:'text',hash,rasterPages:[],text:raw};
    window.MercadorPDFImporter.lastKnowledgeDocument=knowledgeDocument;
    if(onProgress)onProgress({pageNumber:1,numPages:1,percent:100,mode:'text-complete'});
    return {fileName,hash,numPages:1,validity,candidates,engineVersion:ENGINE_VERSION,pdfjsVersion:'—',extractionMode:'text-no-geometry',knowledgeSchemaVersion:KNOWLEDGE_SCHEMA_VERSION,knowledgeDocument,knowledgeMetrics:{pages:1,modes:['text','no-geometry'],words:documentText.split(/\s+/).filter(Boolean).length,lines:lines.length,prices:candidates.length,candidates:candidates.length},sourceType:'text',sourceLabel:'Texto/OCR'};
  }

  async function analyzeSource(source={}, options={}, onProgress) {
    const files=[...(source.files||[])].filter(Boolean);
    const pasted=String(source.text||'').trim();
    if(files.length&&pasted)throw new Error('Use um tipo de entrada por vez: arquivo/imagens OU texto colado.');
    if(!files.length&&!pasted)throw new Error('Selecione um PDF/imagem ou cole o texto do encarte.');
    if(pasted)return analyzeText(pasted,options,onProgress,'texto-colado.txt');
    const pdfs=files.filter((f)=>f.type==='application/pdf'||/\.pdf$/i.test(f.name||''));
    const texts=files.filter((f)=>f.type==='text/plain'||/\.txt$/i.test(f.name||''));
    const images=files.filter((f)=>String(f.type||'').startsWith('image/')||/\.(?:jpe?g|png|webp)$/i.test(f.name||''));
    if(pdfs.length){
      if(files.length!==1||pdfs.length!==1)throw new Error('Para PDF, selecione somente um arquivo por análise.');
      const result=upgradeKnowledgeV6(await previousAnalyzeFile(pdfs[0],options,onProgress), 'pdf', 'PDF');
      activeSource={type:'pdf',hash:result.hash||'',rasterPages:[],text:''};
      window.MercadorPDFImporter.lastKnowledgeDocument=result.knowledgeDocument||null;
      return result;
    }
    if(texts.length){
      if(files.length!==1||texts.length!==1)throw new Error('Para TXT, selecione somente um arquivo por análise.');
      return analyzeText(await texts[0].text(),options,onProgress,texts[0].name||'encarte.txt');
    }
    if(images.length===files.length)return analyzeImages(images,options,onProgress);
    throw new Error('Formato não suportado. Use PDF, JPG, JPEG, PNG, WebP, TXT ou texto colado.');
  }

  function wrapCanvasText(canvas, text, x, y, maxWidth, lineHeight) {
    const ctx=canvas.getContext('2d');
    const words=String(text||'').split(/\s+/);let line='';let yy=y;
    words.forEach((word)=>{
      const test=line?`${line} ${word}`:word;
      if(ctx.measureText(test).width>maxWidth&&line){ctx.fillText(line,x,yy);line=word;yy+=lineHeight;}
      else line=test;
    });
    if(line)ctx.fillText(line,x,yy);
  }

  async function renderPreview(candidate, canvas) {
    if(activeSource.type==='pdf'&&previousRenderPreview)return previousRenderPreview(candidate,canvas);
    if(activeSource.type==='image'){
      const page=activeSource.rasterPages.find((p)=>Number(p.pageNumber)===Number(candidate.pageNumber))||activeSource.rasterPages[0];
      if(!page?.canvas)throw new Error('Imagem de origem não está mais disponível.');
      const source=candidate.sourceBox||{x:0,y:0,width:page.canvas.width,height:page.canvas.height};
      const margin=Math.max(28,Math.min(page.canvas.width,page.canvas.height)*.018);
      const sx=Math.max(0,Number(source.x||0)-margin),sy=Math.max(0,Number(source.y||0)-margin);
      const sw=Math.min(page.canvas.width-sx,Number(source.width||page.canvas.width)+margin*2),sh=Math.min(page.canvas.height-sy,Number(source.height||page.canvas.height)+margin*2);
      const ratio=Math.min(1,900/Math.max(1,sw));canvas.width=Math.max(1,Math.round(sw*ratio));canvas.height=Math.max(1,Math.round(sh*ratio));
      const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(page.canvas,sx,sy,sw,sh,0,0,canvas.width,canvas.height);return;
    }
    if(activeSource.type==='text'){
      canvas.width=900;canvas.height=240;const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.fillStyle='#222';ctx.font='18px sans-serif';
      wrapCanvasText(canvas,candidate?.sourceText||candidate?.knowledgeCardText||candidate?.productName||'',24,38,850,28);return;
    }
    if(previousRenderPreview)return previousRenderPreview(candidate,canvas);
  }

  function downloadKnowledgeJson(knowledgeDocument,fileName='encarte'){
    const data=knowledgeDocument||window.MercadorPDFImporter?.lastKnowledgeDocument;
    if(!data)throw new Error('Nenhum JSON de conhecimento disponível.');
    if(previousDownloadKnowledgeJson&&data.schemaVersion!==KNOWLEDGE_SCHEMA_VERSION)return previousDownloadKnowledgeJson(data,fileName);
    const safe=String(fileName||'encarte').replace(/\.(?:pdf|txt|jpe?g|png|webp)$/i,'').replace(/[^a-z0-9._-]+/gi,'_');
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=`${safe}.mercador-knowledge-v6.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  window.MercadorPDFImporter={
    ...previous,
    MULTIFORMAT_ENGINE_VERSION:ENGINE_VERSION,
    MULTIFORMAT_KNOWLEDGE_SCHEMA_VERSION:KNOWLEDGE_SCHEMA_VERSION,
    analyzeSource,
    analyzeImages,
    analyzeText,
    renderPreview,
    downloadKnowledgeJson,
    __multiFormatDocumentImporterInstalled:true
  };

  console.info(`[Mercador IA] Document Intelligence ${ENGINE_VERSION} ativo: PDF + imagem + texto.`);
})();
