(function () {
  'use strict';

  const base = window.MercadorPDFImporter;
  if (!base || typeof base.analyzeFile !== 'function') {
    console.error('[Mercador IA] Importador PDF base não encontrado; fallback OCR não foi instalado.');
    return;
  }

  const OCR_ENGINE_VERSION = '2.3.0-ocr';
  const TESSERACT_VERSION = '5.1.1';
  const PDFJS_VERSION = base.PDFJS_VERSION || '5.7.284';
  const PDFJS_BASE = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;
  const TESSERACT_URL = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/tesseract.min.js`;
  const originalAnalyzeFile = base.analyzeFile.bind(base);
  let tesseractPromise = null;
  let pdfjsPromise = null;

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const cleanText = (v) => String(v || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
  const fold = (v) => cleanText(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();

  function unionBoxes(boxes) {
    const list = (boxes || []).filter(Boolean);
    if (!list.length) return null;
    const x0 = Math.min(...list.map((b) => Number(b.x0 ?? b.x ?? 0)));
    const y0 = Math.min(...list.map((b) => Number(b.y0 ?? b.y ?? 0)));
    const x1 = Math.max(...list.map((b) => Number(b.x1 ?? ((b.x || 0) + (b.width || 0)))));
    const y1 = Math.max(...list.map((b) => Number(b.y1 ?? ((b.y || 0) + (b.height || 0)))));
    return { x0, y0, x1, y1, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
  }

  function toSourceBox(box, scale) {
    if (!box) return null;
    return {
      x: box.x0 / scale,
      y: box.y0 / scale,
      width: box.width / scale,
      height: box.height / scale
    };
  }

  function rangeDistance(value, start, end) {
    if (value < start) return start - value;
    if (value > end) return value - end;
    return 0;
  }

  function overlap1d(a0, a1, b0, b1) {
    return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  }

  async function loadTesseract() {
    if (window.Tesseract?.createWorker) return window.Tesseract;
    if (!tesseractPromise) {
      tesseractPromise = new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-mercador-tesseract="${TESSERACT_VERSION}"]`);
        if (existing) {
          existing.addEventListener('load', () => resolve(window.Tesseract), { once:true });
          existing.addEventListener('error', () => reject(new Error('Falha ao carregar o OCR visual.')), { once:true });
          return;
        }
        const script = document.createElement('script');
        script.src = TESSERACT_URL;
        script.async = true;
        script.dataset.mercadorTesseract = TESSERACT_VERSION;
        script.onload = () => window.Tesseract?.createWorker ? resolve(window.Tesseract) : reject(new Error('OCR visual carregou sem API disponível.'));
        script.onerror = () => reject(new Error('Não foi possível carregar o OCR visual. Verifique a conexão.'));
        document.head.appendChild(script);
      });
    }
    return tesseractPromise;
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

  function flattenWords(data) {
    if (Array.isArray(data?.words) && data.words.length) return data.words;
    const out = [];
    const blocks = Array.isArray(data?.blocks) ? data.blocks : [];
    blocks.forEach((block) => (block.paragraphs || []).forEach((paragraph) => (paragraph.lines || []).forEach((line) => (line.words || []).forEach((word) => out.push(word)))));
    return out;
  }

  function normalizeOcrWords(data) {
    return flattenWords(data).map((word, index) => {
      const bbox = word.bbox || {};
      const x0 = Number(bbox.x0 ?? bbox.left ?? 0);
      const y0 = Number(bbox.y0 ?? bbox.top ?? 0);
      const x1 = Number(bbox.x1 ?? bbox.right ?? x0 + 1);
      const y1 = Number(bbox.y1 ?? bbox.bottom ?? y0 + 1);
      return {
        id:index,
        text:cleanText(word.text),
        confidence:Number(word.confidence ?? word.conf ?? 0),
        x0, y0, x1, y1,
        width:Math.max(1,x1-x0),
        height:Math.max(1,y1-y0)
      };
    }).filter((w) => w.text && w.width > 0 && w.height > 0);
  }

  function segmentRows(words) {
    if (!words.length) return [];
    const heights = words.map((w) => w.height).sort((a,b)=>a-b);
    const medianH = heights[Math.floor(heights.length / 2)] || 18;
    const tolerance = Math.max(10, medianH * .68);
    const rows = [];
    [...words].sort((a,b)=>a.y0-b.y0 || a.x0-b.x0).forEach((word) => {
      const cy=(word.y0+word.y1)/2;
      let row=rows.find((r)=>Math.abs(r.cy-cy)<=tolerance && overlap1d(word.y0,word.y1,r.y0,r.y1)>=-1);
      if(!row){row={cy,y0:word.y0,y1:word.y1,words:[]};rows.push(row);}
      row.words.push(word);
      row.y0=Math.min(row.y0,word.y0);row.y1=Math.max(row.y1,word.y1);
      row.cy=row.words.reduce((s,w)=>s+(w.y0+w.y1)/2,0)/row.words.length;
    });

    const lines=[];
    rows.forEach((row)=>{
      const sorted=row.words.sort((a,b)=>a.x0-b.x0);
      let segment=[];
      const flush=()=>{
        if(!segment.length)return;
        const box=unionBoxes(segment);
        const text=cleanText(segment.map((w)=>w.text).join(' '));
        const confidence=segment.reduce((s,w)=>s+(Number(w.confidence)||0),0)/segment.length;
        lines.push({text,words:[...segment],box,confidence,cy:(box.y0+box.y1)/2});
        segment=[];
      };
      sorted.forEach((word)=>{
        if(segment.length){
          const prev=segment[segment.length-1];
          const gap=word.x0-prev.x1;
          const scale=Math.max(prev.height,word.height,medianH,10);
          if(gap>Math.max(38,scale*2.35))flush();
        }
        segment.push(word);
      });
      flush();
    });
    return lines.sort((a,b)=>a.box.y0-b.box.y0 || a.box.x0-b.box.x0);
  }

  function parseOcrMoney(text) {
    let t=fold(text)
      .replace(/[|]/g,'1')
      .replace(/S(?=\s*\$)/g,'R')
      .replace(/\s+/g,' ')
      .trim();
    const explicit=/\bR\s*\$|R\$|RS\b/.test(t);
    t=t.replace(/\bRS\b/g,'R$');
    let m=t.match(/(?:R\s*\$\s*)?(\d{1,4})\s*[,.;:]\s*(\d{2})(?!\d)/);
    if(!m && explicit)m=t.match(/(?:R\s*\$\s*)(\d{1,4})\s+(\d{2})(?!\d)/);
    if(!m)return null;
    const price=Number(`${m[1]}.${m[2]}`);
    if(!Number.isFinite(price)||price<=0||price>=10000)return null;
    return {price:Number(price.toFixed(2)),explicitCurrency:explicit};
  }

  function priceCandidatesFromLines(lines) {
    const found=[];
    lines.forEach((line,lineIndex)=>{
      const words=line.words;
      for(let i=0;i<words.length;i+=1){
        for(let len=1;len<=4 && i+len<=words.length;len+=1){
          const slice=words.slice(i,i+len);
          const box=unionBoxes(slice);
          if(box.width>420)break;
          const text=cleanText(slice.map((w)=>w.text).join(' '));
          const parsed=parseOcrMoney(text);
          if(!parsed)continue;
          const hasCurrency=parsed.explicitCurrency || slice.some((w)=>/R\s*\$|R\$|\bRS\b/i.test(w.text));
          if(!hasCurrency && len>2)continue;
          const confidence=slice.reduce((s,w)=>s+(Number(w.confidence)||0),0)/slice.length;
          found.push({price:parsed.price,box,words:slice,lineIndex,confidence,explicitCurrency:hasCurrency,text});
        }
      }
      const parsedLine=parseOcrMoney(line.text);
      if(parsedLine && !found.some((p)=>p.lineIndex===lineIndex && Math.abs(p.price-parsedLine.price)<.001)){
        found.push({price:parsedLine.price,box:line.box,words:line.words,lineIndex,confidence:line.confidence,explicitCurrency:parsedLine.explicitCurrency,text:line.text});
      }
    });

    const dedup=[];
    found.sort((a,b)=>b.explicitCurrency-a.explicitCurrency || b.confidence-a.confidence || a.box.width-b.box.width).forEach((p)=>{
      const pcx=(p.box.x0+p.box.x1)/2,pcy=(p.box.y0+p.box.y1)/2;
      const exists=dedup.some((x)=>{
        const xcx=(x.box.x0+x.box.x1)/2,xcy=(x.box.y0+x.box.y1)/2;
        return Math.abs(x.price-p.price)<.001 && Math.abs(xcx-pcx)<55 && Math.abs(xcy-pcy)<38;
      });
      if(!exists)dedup.push(p);
    });
    return dedup;
  }

  function isNoiseLine(line, priceLines) {
    const t=fold(line.text);
    if(!t || t.length<2)return true;
    if(priceLines.has(line))return true;
    if(/(?:R\s*\$|R\$)\s*\d/.test(t))return true;
    if(/^(?:KG|G|ML|L|LT|LTS|UN|UND|UNIDADE|CADA|PACOTE|PCT|BANDEJA|BDJ)$/.test(t))return true;
    if(/^(?:PRECO|PRECO BAIXO|OFERTA|OFERTAS|FEIRA|GIGANTE|MAX|CLUBE MAX|PECA JA|TELEVENDAS)$/.test(t))return true;
    if(/\b(?:PREÇOS|PRECOS)\s+VALIDOS|ENQUANTO\s+DURAREM|CREDIFFATO|CREDIFATO|CONSULTE|LOJAS|WHATSAPP|OPORTUNIDADES|CANDIDATE-SE|ACESSE|APLICATIVO|CARTAO\b/.test(t))return true;
    if(/^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}/.test(t))return true;
    const letters=(t.match(/[A-Z]/g)||[]).length;
    const digits=(t.match(/\d/g)||[]).length;
    if(letters<2 && digits>letters*2)return true;
    return false;
  }

  function dedupeWords(text) {
    const words=cleanText(text).split(' ').filter(Boolean);
    const out=[];
    words.forEach((w)=>{if(!out.length || fold(out[out.length-1])!==fold(w))out.push(w);});
    return out.join(' ').replace(/\b(\w{3,})\s+\1\b/gi,'$1').trim();
  }

  function extractPackage(text) {
    const t=fold(text);
    const m=t.match(/\b(?:PACOTE|PCT|BANDEJA|BDJ|CAIXA|CX)?\s*(\d+(?:[,.]\d+)?)\s*(KG|G|GR|ML|L|LT|LTS|UN|UND|UNIDADES|CADA|100G)\b/) || t.match(/\b(L\d+P\d+)\b/);
    return m ? cleanText(m[0]).toLowerCase() : '';
  }

  function productForPrice(price, lines, prices, pageWidth) {
    const pcx=(price.box.x0+price.box.x1)/2;
    const pcy=(price.box.y0+price.box.y1)/2;
    const priceLineObjects=new Set(prices.map((p)=>lines[p.lineIndex]).filter(Boolean));
    const candidates=lines.filter((line)=>{
      if(isNoiseLine(line,priceLineObjects))return false;
      const lc=(line.box.x0+line.box.x1)/2;
      const horizontal=rangeDistance(pcx,line.box.x0-65,line.box.x1+65);
      const verticalAbove=price.box.y0-line.box.y1;
      const sameBand=Math.abs(line.cy-pcy)<=Math.max(34,price.box.height*1.25);
      const leftOfPrice=sameBand && line.box.x1<=price.box.x0+40 && price.box.x0-line.box.x1<=Math.max(230,pageWidth*.16);
      if(leftOfPrice)return true;
      return verticalAbove>=-20 && verticalAbove<=Math.max(270,pageWidth*.20) && horizontal<=Math.max(105,pageWidth*.075) && Math.abs(lc-pcx)<=Math.max(260,pageWidth*.18);
    });
    if(!candidates.length)return null;

    const ranked=candidates.map((line)=>{
      const lc=(line.box.x0+line.box.x1)/2;
      const horizontal=rangeDistance(pcx,line.box.x0,line.box.x1);
      const vertical=line.box.y1<=price.box.y0 ? price.box.y0-line.box.y1 : Math.abs(line.cy-pcy)*1.25;
      const sameBand=Math.abs(line.cy-pcy)<=Math.max(34,price.box.height*1.25);
      const leftBonus=sameBand&&line.box.x1<=price.box.x0+40?-75:0;
      return {line,score:vertical*.76+horizontal*.78+Math.abs(lc-pcx)*.08+leftBonus};
    }).sort((a,b)=>a.score-b.score);

    const anchor=ranked[0].line;
    const selected=[anchor];
    const above=candidates.filter((line)=>line!==anchor && line.box.y1<=anchor.box.y1+18)
      .sort((a,b)=>b.box.y1-a.box.y1);
    for(const line of above){
      if(selected.length>=4)break;
      const currentTop=Math.min(...selected.map((x)=>x.box.y0));
      const gap=currentTop-line.box.y1;
      const hOverlap=overlap1d(line.box.x0,line.box.x1,anchor.box.x0-80,anchor.box.x1+80);
      const centerDiff=Math.abs((line.box.x0+line.box.x1)/2-(anchor.box.x0+anchor.box.x1)/2);
      if(gap>Math.max(72,anchor.box.height*3.2))continue;
      if(hOverlap<=0 && centerDiff>Math.max(125,pageWidth*.085))continue;
      selected.push(line);
    }
    selected.sort((a,b)=>a.box.y0-b.box.y0 || a.box.x0-b.box.x0);
    let productName=dedupeWords(selected.map((x)=>x.text).join(' '));
    productName=productName.replace(/\bR\s*\$.*$/i,'').replace(/\s+/g,' ').trim();
    if(productName.split(' ').length>16)productName=productName.split(' ').slice(-16).join(' ');
    const productBox=unionBoxes(selected.map((x)=>x.box));
    const confidence=selected.reduce((s,x)=>s+(Number(x.confidence)||0),0)/selected.length;
    const horizontal=rangeDistance(pcx,productBox.x0,productBox.x1);
    const vertical=Math.max(0,price.box.y0-productBox.y1);
    const spatial=clamp(1-(horizontal/Math.max(150,pageWidth*.11))-(vertical/Math.max(300,pageWidth*.22))*.55,0,1);
    return {productName,productBox,ocrConfidence:confidence,spatial,selectedLines:selected};
  }

  function parseFilenameValidity(fileName) {
    const name=fold(fileName).replace(/[._-]+/g,' ');
    const year=new Date().getFullYear();
    let m=name.match(/\b(\d{1,2})\s*(?:E|A|ATE)\s*(\d{1,2})\s+(\d{1,2})\b/);
    if(!m)return null;
    const startDay=Number(m[1]),endDay=Number(m[2]),month=Number(m[3]);
    if(month<1||month>12||startDay<1||startDay>31||endDay<1||endDay>31)return null;
    const start=new Date(year,month-1,startDay,0,0,0,0).getTime();
    const end=new Date(year,month-1,endDay,23,59,59,999).getTime();
    return {startAt:start,endAt:end,raw:`${String(startDay).padStart(2,'0')}/${String(month).padStart(2,'0')}/${year} a ${String(endDay).padStart(2,'0')}/${String(month).padStart(2,'0')}/${year}`,condition:'',inferred:true};
  }

  function enrichValidity(documentText, fileName) {
    const detected=typeof base.extractValidity==='function' ? base.extractValidity(documentText) : {startAt:null,endAt:null,raw:'',condition:''};
    if(detected?.startAt && detected?.endAt){
      const condition=/ENQUANTO\s+DURAREM\s+OS?\s+ESTOQUES?/i.test(documentText) ? 'enquanto durarem os estoques' : (detected.condition||'');
      return {...detected,condition,inferred:false};
    }
    return parseFilenameValidity(fileName) || detected || {startAt:null,endAt:null,raw:'',condition:'',inferred:false};
  }

  function candidateConfidence({product,price,validity,packageText,wordsCount}) {
    let score=.885;
    const evidence=[];
    const risks=[];
    if(price.explicitCurrency){score+=.025;evidence.push('preço com marcador R$ reconhecido por OCR');}
    else risks.push('ocr_price_without_currency');
    if(product.ocrConfidence>=88){score+=.025;evidence.push('texto visual com OCR de alta confiança');}
    else if(product.ocrConfidence>=76){score+=.012;evidence.push('texto visual reconhecido por OCR');}
    else risks.push('ocr_low_text_confidence');
    if(price.confidence>=85){score+=.018;evidence.push('preço visual com OCR de alta confiança');}
    else if(price.confidence<65)risks.push('ocr_low_price_confidence');
    if(product.spatial>=.78){score+=.028;evidence.push('produto e preço no mesmo bloco visual');}
    else if(product.spatial>=.58){score+=.014;evidence.push('associação espacial visual compatível');}
    else risks.push('association_disagreement');
    if(wordsCount>=2 && wordsCount<=12){score+=.018;evidence.push('descrição de produto consistente');}
    if(packageText){score+=.008;evidence.push('embalagem identificada');}
    if(validity?.startAt && validity?.endAt && !validity.inferred){score+=.025;evidence.push('validade lida no próprio encarte');}
    else if(validity?.startAt && validity?.endAt && validity.inferred){score+=.006;evidence.push('validade inferida pelo nome do arquivo');risks.push('ocr_validity_inferred');}
    else risks.push('missing_validity');
    const confidence=clamp(score,.55,.995);
    const hardRisk=risks.some((x)=>['association_disagreement','missing_validity','ocr_low_price_confidence'].includes(x));
    const structuralSafe=!hardRisk && Boolean(validity?.startAt && validity?.endAt) && !validity?.inferred && price.explicitCurrency && wordsCount>=2 && product.spatial>=.68 && product.ocrConfidence>=80 && price.confidence>=75;
    const automationSafe=structuralSafe && product.spatial>=.76 && product.ocrConfidence>=84 && price.confidence>=80 && confidence>=.98;
    return {confidence,risks,evidence,structuralSafe,automationSafe};
  }

  function buildOcrCandidates(pageData, validity, options) {
    const inferCategory=window.MercadorIA?.inferCategory;
    const prices=priceCandidatesFromLines(pageData.lines);
    const raw=[];
    prices.forEach((price,index)=>{
      const product=productForPrice(price,pageData.lines,prices,pageData.canvasWidth);
      if(!product || !product.productName || product.productName.length<3)return;
      const wordsCount=product.productName.split(/\s+/).filter(Boolean).length;
      if(wordsCount<1)return;
      const packageText=extractPackage(product.productName);
      const quality=candidateConfidence({product,price,validity,packageText,wordsCount});
      const category=inferCategory ? (inferCategory(product.productName)||'outros') : 'outros';
      const sourceBoxCanvas=unionBoxes([product.productBox,price.box]);
      raw.push({
        id:`ocr-p${pageData.pageNumber}-${index}`,
        pageNumber:pageData.pageNumber,
        pageWidth:pageData.pageWidth,
        pageHeight:pageData.pageHeight,
        productName:product.productName,
        category,
        brand:'',
        packageText,
        price:price.price,
        previousPrice:null,
        detectedPrices:[price.price],
        priceKind:'general',
        requiresClub:false,
        clubName:'',
        clubSignal:false,
        conditions:validity?.condition||'',
        confidence:quality.confidence,
        riskFlags:quality.risks,
        evidence:quality.evidence,
        associationAgreement:product.spatial,
        domainOwnership:product.spatial,
        blockCoherence:1,
        structuralSafe:quality.structuralSafe,
        automationSafe:quality.automationSafe,
        sourceBox:toSourceBox(sourceBoxCanvas,pageData.renderScale),
        startAt:validity?.startAt||null,
        endAt:validity?.endAt||null,
        verified:false,
        verificationMode:'',
        ignored:false,
        published:false,
        reviewed:false,
        extractionMode:'ocr-image-fallback',
        ocrConfidence:Number(((product.ocrConfidence+price.confidence)/2/100).toFixed(3))
      });
    });

    // Remove duplicatas visuais do mesmo preço/produto na mesma região.
    const norm=(s)=>fold(s).replace(/[^A-Z0-9]+/g,' ').trim();
    const tokens=(s)=>new Set(norm(s).split(' ').filter((x)=>x.length>1));
    const similarity=(a,b)=>{const A=tokens(a),B=tokens(b);if(!A.size||!B.size)return 0;const common=[...A].filter((x)=>B.has(x)).length;return common/Math.max(A.size,B.size);};
    const dedup=[];
    raw.sort((a,b)=>b.confidence-a.confidence).forEach((candidate)=>{
      const cb=candidate.sourceBox||{};const ccx=(cb.x||0)+(cb.width||0)/2;const ccy=(cb.y||0)+(cb.height||0)/2;
      const duplicate=dedup.some((x)=>{
        const xb=x.sourceBox||{};const xcx=(xb.x||0)+(xb.width||0)/2;const xcy=(xb.y||0)+(xb.height||0)/2;
        return Math.abs(Number(x.price)-Number(candidate.price))<.001 && Math.abs(xcx-ccx)<35 && Math.abs(xcy-ccy)<35 && similarity(x.productName,candidate.productName)>=.55;
      });
      if(!duplicate)dedup.push(candidate);
    });
    return dedup;
  }

  function preprocessCanvas(source) {
    const canvas=document.createElement('canvas');
    canvas.width=source.width;canvas.height=source.height;
    const ctx=canvas.getContext('2d',{alpha:false,willReadFrequently:true});
    ctx.drawImage(source,0,0);
    const image=ctx.getImageData(0,0,canvas.width,canvas.height);
    const d=image.data;
    for(let i=0;i<d.length;i+=4){
      const lum=.299*d[i]+.587*d[i+1]+.114*d[i+2];
      let v=(lum-128)*1.28+128;
      if(v>238)v=255;else if(v<32)v=0;
      v=clamp(Math.round(v),0,255);
      d[i]=d[i+1]=d[i+2]=v;d[i+3]=255;
    }
    ctx.putImageData(image,0,0);
    return canvas;
  }

  async function analyzeImagePdf(file, options, onProgress) {
    const [pdfjsLib,Tesseract]=await Promise.all([loadPdfJs(),loadTesseract()]);
    const arrayBuffer=await file.arrayBuffer();
    const pdf=await pdfjsLib.getDocument({
      data:arrayBuffer,
      cMapUrl:`${PDFJS_BASE}/cmaps/`,cMapPacked:true,
      standardFontDataUrl:`${PDFJS_BASE}/standard_fonts/`,wasmUrl:`${PDFJS_BASE}/wasm/`
    }).promise;

    let currentPage=1;
    let currentProgress=0;
    const worker=await Tesseract.createWorker('por',1,{logger:(m)=>{
      if(m?.status==='recognizing text' && Number.isFinite(m.progress)){
        currentProgress=m.progress;
        if(onProgress)onProgress({pageNumber:currentPage,numPages:pdf.numPages,percent:Math.round(((currentPage-1)+m.progress*.88)/pdf.numPages*100),mode:'ocr'});
      }
    }});
    try{
      await worker.setParameters({preserve_interword_spaces:'1'}).catch(()=>{});
      const pages=[];const documentTexts=[];
      for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber+=1){
        currentPage=pageNumber;currentProgress=0;
        if(onProgress)onProgress({pageNumber,numPages:pdf.numPages,percent:Math.round((pageNumber-1)/pdf.numPages*100),mode:'ocr'});
        const page=await pdf.getPage(pageNumber);
        const baseViewport=page.getViewport({scale:1});
        const targetWidth=Math.min(2500,Math.max(1850,baseViewport.width*3.35));
        const renderScale=targetWidth/baseViewport.width;
        const viewport=page.getViewport({scale:renderScale});
        const source=document.createElement('canvas');
        source.width=Math.ceil(viewport.width);source.height=Math.ceil(viewport.height);
        const ctx=source.getContext('2d',{alpha:false});
        ctx.fillStyle='#fff';ctx.fillRect(0,0,source.width,source.height);
        await page.render({canvasContext:ctx,viewport}).promise;
        const prepared=preprocessCanvas(source);
        const result=await worker.recognize(prepared);
        const words=normalizeOcrWords(result.data);
        const lines=segmentRows(words);
        const pageText=cleanText(result.data?.text || lines.map((x)=>x.text).join(' '));
        documentTexts.push(pageText);
        pages.push({pageNumber,pageWidth:baseViewport.width,pageHeight:baseViewport.height,canvasWidth:prepared.width,canvasHeight:prepared.height,renderScale,words,lines,text:pageText});
        source.width=source.height=1;prepared.width=prepared.height=1;
      }
      const documentText=documentTexts.join(' ');
      const validity=enrichValidity(documentText,file.name);
      const candidates=pages.flatMap((page)=>buildOcrCandidates(page,validity,options));
      if(onProgress)onProgress({pageNumber:pdf.numPages,numPages:pdf.numPages,percent:100,mode:'ocr'});
      return {validity,candidates,documentText,numPages:pdf.numPages,ocrPages:pages.map((p)=>({pageNumber:p.pageNumber,words:p.words.length,lines:p.lines.length}))};
    }finally{
      await worker.terminate().catch(()=>{});
    }
  }

  async function analyzeFile(file, options={}, onProgress) {
    const nativeResult=await originalAnalyzeFile(file,options,onProgress);
    if(Array.isArray(nativeResult.candidates) && nativeResult.candidates.length>0){
      return {...nativeResult,extractionMode:nativeResult.extractionMode||'pdf-text'};
    }

    if(onProgress)onProgress({pageNumber:1,numPages:nativeResult.numPages||1,percent:1,mode:'ocr'});
    const ocr=await analyzeImagePdf(file,options,onProgress);
    return {
      ...nativeResult,
      validity:ocr.validity?.startAt ? ocr.validity : nativeResult.validity,
      candidates:ocr.candidates,
      numPages:ocr.numPages||nativeResult.numPages,
      engineVersion:OCR_ENGINE_VERSION,
      extractionMode:'ocr-image-fallback',
      ocrEngine:`tesseract.js-${TESSERACT_VERSION}`,
      ocrPages:ocr.ocrPages
    };
  }

  window.MercadorPDFImporter={
    ...base,
    ENGINE_VERSION:OCR_ENGINE_VERSION,
    analyzeFile
  };
})();
