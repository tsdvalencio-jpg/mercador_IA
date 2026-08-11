(function () {
  'use strict';

  // Camada complementar: o motor PDF nativo continua sendo a primeira opção.
  // Este arquivo só assume quando o PDF não possui uma camada de texto útil.
  const base = window.MercadorPDFImporter;
  if (!base || typeof base.analyzeFile !== 'function') {
    console.error('[Mercador IA] Importador PDF base não encontrado; fallback OCR não foi instalado.');
    return;
  }

  const OCR_ENGINE_VERSION = '2.4.0-ocr';
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
  const center = (box) => ({ x:(Number(box?.x0 || 0)+Number(box?.x1 || 0))/2, y:(Number(box?.y0 || 0)+Number(box?.y1 || 0))/2 });

  function unionBoxes(boxes) {
    const list = (boxes || []).filter(Boolean);
    if (!list.length) return null;
    const x0 = Math.min(...list.map((b) => Number(b.x0 ?? b.x ?? 0)));
    const y0 = Math.min(...list.map((b) => Number(b.y0 ?? b.y ?? 0)));
    const x1 = Math.max(...list.map((b) => Number(b.x1 ?? ((b.x || 0) + (b.width || 0)))));
    const y1 = Math.max(...list.map((b) => Number(b.y1 ?? ((b.y || 0) + (b.height || 0)))));
    return { x0, y0, x1, y1, width:Math.max(1,x1-x0), height:Math.max(1,y1-y0) };
  }

  function toSourceBox(box, scale) {
    if (!box) return null;
    return { x:box.x0/scale, y:box.y0/scale, width:box.width/scale, height:box.height/scale };
  }

  function rangeDistance(value, start, end) {
    if (value < start) return start - value;
    if (value > end) return value - end;
    return 0;
  }

  function overlap1d(a0, a1, b0, b1) {
    return Math.max(0, Math.min(a1,b1)-Math.max(a0,b0));
  }

  function intersectionRatio(a,b) {
    if(!a || !b) return 0;
    const ix=overlap1d(a.x0,a.x1,b.x0,b.x1);
    const iy=overlap1d(a.y0,a.y1,b.y0,b.y1);
    const inter=ix*iy;
    if(!inter)return 0;
    return inter/Math.max(1,Math.min(a.width*a.height,b.width*b.height));
  }

  function median(values) {
    const a=(values||[]).filter(Number.isFinite).sort((x,y)=>x-y);
    if(!a.length)return 0;
    const mid=Math.floor(a.length/2);
    return a.length%2?a[mid]:(a[mid-1]+a[mid])/2;
  }

  async function loadTesseract() {
    if (window.Tesseract?.createWorker) return window.Tesseract;
    if (!tesseractPromise) {
      tesseractPromise = new Promise((resolve, reject) => {
        const existing=document.querySelector(`script[data-mercador-tesseract="${TESSERACT_VERSION}"]`);
        if(existing){
          existing.addEventListener('load',()=>resolve(window.Tesseract),{once:true});
          existing.addEventListener('error',()=>reject(new Error('Falha ao carregar o OCR visual.')),{once:true});
          return;
        }
        const script=document.createElement('script');
        script.src=TESSERACT_URL;script.async=true;script.dataset.mercadorTesseract=TESSERACT_VERSION;
        script.onload=()=>window.Tesseract?.createWorker?resolve(window.Tesseract):reject(new Error('OCR visual carregou sem API disponível.'));
        script.onerror=()=>reject(new Error('Não foi possível carregar o OCR visual. Verifique a conexão.'));
        document.head.appendChild(script);
      });
    }
    return tesseractPromise;
  }

  async function loadPdfJs() {
    if(!pdfjsPromise){
      pdfjsPromise=import(`${PDFJS_BASE}/build/pdf.mjs`).then((pdfjsLib)=>{
        pdfjsLib.GlobalWorkerOptions.workerSrc=`${PDFJS_BASE}/build/pdf.worker.mjs`;
        return pdfjsLib;
      });
    }
    return pdfjsPromise;
  }

  function flattenWords(data) {
    if(Array.isArray(data?.words)&&data.words.length)return data.words;
    const out=[];
    (Array.isArray(data?.blocks)?data.blocks:[]).forEach((block)=>(block.paragraphs||[]).forEach((paragraph)=>(paragraph.lines||[]).forEach((line)=>(line.words||[]).forEach((word)=>out.push(word)))));
    return out;
  }

  function normalizeOcrWords(data, {pass='layout',offsetX=0,offsetY=0}={}) {
    return flattenWords(data).map((word,index)=>{
      const bbox=word.bbox||{};
      const x0=Number(bbox.x0??bbox.left??0)+offsetX;
      const y0=Number(bbox.y0??bbox.top??0)+offsetY;
      const x1=Number(bbox.x1??bbox.right??x0+1)+offsetX;
      const y1=Number(bbox.y1??bbox.bottom??y0+1)+offsetY;
      return {id:`${pass}-${index}`,pass,text:cleanText(word.text),confidence:Number(word.confidence??word.conf??0),x0,y0,x1,y1,width:Math.max(1,x1-x0),height:Math.max(1,y1-y0)};
    }).filter((w)=>w.text&&w.width>0&&w.height>0);
  }

  function wordCenterDistance(a,b){const A=center(a),B=center(b);return Math.hypot(A.x-B.x,A.y-B.y);}

  // Une as leituras sem duplicar palavras sobrepostas. A leitura de maior confiança vence,
  // mas o número de passagens que enxergou a região fica preservado para calibrar confiança.
  function mergeOcrWords(wordSets) {
    const merged=[];
    (wordSets||[]).flat().sort((a,b)=>b.confidence-a.confidence).forEach((word)=>{
      const same=merged.find((x)=>{
        const overlap=intersectionRatio(x,word);
        const close=wordCenterDistance(x,word)<=Math.max(10,Math.min(x.height,word.height)*.7);
        const sizeRatio=Math.min(x.width,word.width)/Math.max(1,Math.max(x.width,word.width));
        return (overlap>=.52 || (close&&sizeRatio>=.55)) && fold(x.text)===fold(word.text);
      });
      if(same){
        same.passNames.add(word.pass);
        same.passCount=same.passNames.size;
        if(word.confidence>same.confidence){
          ['text','confidence','x0','y0','x1','y1','width','height','pass'].forEach((k)=>{same[k]=word[k];});
        }
        return;
      }
      merged.push({...word,passNames:new Set([word.pass]),passCount:1});
    });
    return merged;
  }

  function segmentRows(words) {
    if(!words.length)return [];
    const medianH=median(words.map((w)=>w.height))||18;
    const tolerance=Math.max(7,medianH*.52);
    const rows=[];
    [...words].sort((a,b)=>a.y0-b.y0||a.x0-b.x0).forEach((word)=>{
      const cy=(word.y0+word.y1)/2;
      let best=null,bestDelta=Infinity;
      rows.forEach((row)=>{
        const delta=Math.abs(row.cy-cy);
        const verticalOverlap=overlap1d(word.y0,word.y1,row.y0,row.y1);
        if(delta<=tolerance && (verticalOverlap>0 || delta<=medianH*.42) && delta<bestDelta){best=row;bestDelta=delta;}
      });
      if(!best){best={cy,y0:word.y0,y1:word.y1,words:[]};rows.push(best);}
      best.words.push(word);best.y0=Math.min(best.y0,word.y0);best.y1=Math.max(best.y1,word.y1);
      best.cy=best.words.reduce((s,w)=>s+(w.y0+w.y1)/2,0)/best.words.length;
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
        lines.push({text,words:[...segment],box,confidence,cy:(box.y0+box.y1)/2});segment=[];
      };
      sorted.forEach((word)=>{
        if(segment.length){
          const prev=segment[segment.length-1];
          const gap=word.x0-prev.x1;
          const scale=Math.max(prev.height,word.height,medianH,9);
          // Limite menor evita juntar ofertas vizinhas na mesma linha do encarte.
          if(gap>Math.max(25,Math.min(54,scale*1.65)))flush();
        }
        segment.push(word);
      });
      flush();
    });
    return lines.sort((a,b)=>a.box.y0-b.box.y0||a.box.x0-b.box.x0);
  }

  function normalizeNumericOcr(value) {
    return fold(value)
      .replace(/[|IL](?=\d)/g,'1')
      .replace(/(?<=\d)[OQ](?=\d|\b)/g,'0')
      .replace(/S(?=\s*\$)/g,'R')
      .replace(/\s+/g,' ')
      .trim();
  }

  function parseOcrMoney(text) {
    let t=normalizeNumericOcr(text);
    const explicit=/\bR\s*\$|R\$|\bRS\b/.test(t);
    t=t.replace(/\bRS\b/g,'R$');

    let m=t.match(/(?:R\s*\$\s*)?(\d{1,4})\s*[,.;:]\s*(\d{2})(?!\d)/);
    if(m){
      const value=Number(`${m[1]}.${m[2]}`);
      if(Number.isFinite(value)&&value>0&&value<10000)return {price:Number(value.toFixed(2)),explicitCurrency:explicit,pattern:'decimal'};
    }

    if(explicit){
      // Encartes usam fonte muito grande: o OCR frequentemente separa reais e centavos.
      m=t.match(/R\s*\$\s*(\d{1,4})\s+(\d{2})(?!\d)/);
      if(m){
        const value=Number(`${m[1]}.${m[2]}`);
        if(Number.isFinite(value)&&value>0&&value<10000)return {price:Number(value.toFixed(2)),explicitCurrency:true,pattern:'split-cents'};
      }

      // Outro erro recorrente em arte promocional é perder a vírgula: R$248 = R$ 2,48.
      // Só aceitamos 3 a 5 dígitos depois de R$, nunca números soltos sem moeda.
      m=t.match(/R\s*\$\s*(\d{3,5})(?!\d)/);
      if(m){
        const digits=m[1];
        const integer=digits.slice(0,-2),cents=digits.slice(-2);
        const value=Number(`${integer}.${cents}`);
        if(Number.isFinite(value)&&value>=.5&&value<1000)return {price:Number(value.toFixed(2)),explicitCurrency:true,pattern:'compact-cents'};
      }
    }
    return null;
  }

  function priceCandidatesFromLines(lines, {pass='layout',medianWordHeight=16}={}) {
    const found=[];
    lines.forEach((line,lineIndex)=>{
      const words=line.words||[];
      for(let i=0;i<words.length;i+=1){
        for(let len=1;len<=6&&i+len<=words.length;len+=1){
          const slice=words.slice(i,i+len);
          const box=unionBoxes(slice);
          if(!box||box.width>520)break;
          const text=cleanText(slice.map((w)=>w.text).join(' '));
          const parsed=parseOcrMoney(text);
          if(!parsed)continue;
          const hasCurrency=parsed.explicitCurrency||slice.some((w)=>/R\s*\$|R\$|\bRS\b/i.test(w.text));
          if(!hasCurrency&&len>3)continue;
          const confidence=slice.reduce((s,w)=>s+(Number(w.confidence)||0),0)/slice.length;
          const scale=box.height/Math.max(1,medianWordHeight);
          found.push({price:parsed.price,box,words:slice,lineIndex,confidence,explicitCurrency:hasCurrency,text,pass,pattern:parsed.pattern,scale});
        }
      }
      const parsedLine=parseOcrMoney(line.text);
      if(parsedLine&&!found.some((p)=>p.lineIndex===lineIndex&&Math.abs(p.price-parsedLine.price)<.001)){
        const scale=line.box.height/Math.max(1,medianWordHeight);
        found.push({price:parsedLine.price,box:line.box,words:line.words,lineIndex,confidence:line.confidence,explicitCurrency:parsedLine.explicitCurrency,text:line.text,pass,pattern:parsedLine.pattern,scale});
      }
    });

    // Deduplica a mesma leitura dentro da mesma passagem.
    const dedup=[];
    found.sort((a,b)=>Number(b.explicitCurrency)-Number(a.explicitCurrency)||b.confidence-a.confidence||b.scale-a.scale||a.box.width-b.box.width).forEach((p)=>{
      const pc=center(p.box);
      const exists=dedup.some((x)=>{
        const xc=center(x.box);
        return Math.abs(x.price-p.price)<.001&&Math.abs(xc.x-pc.x)<60&&Math.abs(xc.y-pc.y)<42;
      });
      if(!exists)dedup.push(p);
    });
    return dedup;
  }

  function mergePricePasses(passPrices) {
    const all=(passPrices||[]).flat();
    const groups=[];
    all.sort((a,b)=>Number(b.explicitCurrency)-Number(a.explicitCurrency)||b.confidence-a.confidence).forEach((p)=>{
      const pc=center(p.box);
      let group=groups.find((g)=>{
        const gc=center(g.box);
        return Math.abs(g.price-p.price)<.011&&Math.abs(gc.x-pc.x)<72&&Math.abs(gc.y-pc.y)<52;
      });
      if(!group){
        group={...p,passNames:new Set([p.pass]),passCount:1,observations:[p],conflicts:[]};groups.push(group);return;
      }
      group.passNames.add(p.pass);group.passCount=group.passNames.size;group.observations.push(p);
      if(p.confidence>group.confidence){group.confidence=p.confidence;group.box=p.box;group.words=p.words;group.explicitCurrency=group.explicitCurrency||p.explicitCurrency;group.text=p.text;group.scale=Math.max(group.scale,p.scale);}
      else{group.explicitCurrency=group.explicitCurrency||p.explicitCurrency;group.scale=Math.max(group.scale,p.scale);}
    });

    // Marca leituras diferentes na mesma posição. Não são descartadas automaticamente porque
    // podem representar dois preços reais; porém jamais serão publicadas sem coerência de bloco.
    groups.forEach((g)=>{
      const gc=center(g.box);
      g.conflicts=groups.filter((x)=>x!==g&&Math.abs(center(x.box).x-gc.x)<62&&Math.abs(center(x.box).y-gc.y)<46&&Math.abs(x.price-g.price)>.011).map((x)=>x.price);
    });
    return groups;
  }

  const CATEGORY_HEADING_RE=/^(?:ACOUGUE(?:\s+COMPLETO)?|AÇOUGUE(?:\s+COMPLETO)?|PADARIA|PERECIVEIS(?:\s+E\s+SALSICHARIA)?|PERECÍVEIS(?:\s+E\s+SALSICHARIA)?|SALSICHARIA|HORTIFRUTI|HORTI\s*FRUTI|BEBIDAS|MERCEARIA|LIMPEZA|HIGIENE|BAZAR|FRIOS|CONGELADOS)$/i;
  const INSTITUTIONAL_RE=/(?:PRECO\s+BAIXO|PREÇO\s+BAIXO|FEIRA\s+GIGANTE|QUEM\s+QUISER|PODE\s+ECONOMIZAR|TODA\s+A\s+LOJA|SEM\s+JUROS|CARTAO|CARTÃO|CREDIFFATO|CREDIFATO|PECA\s+JA|PEÇA\s+JÁ|CLUBE\s+MAX|BAIXE\s+O\s+APP|APROVEITE\s+DESCONTOS|ACESSE\s+(?:O|AO)|FACA\s+(?:UM\s+)?CADASTRO|FAÇA\s+(?:UM\s+)?CADASTRO|INFORME\s+SEU\s+CPF|PRECOS?\s+VALIDOS?|PREÇOS?\s+VÁLIDOS?|ENQUANTO\s+DURAREM|MODALIDADE\s+ATACADO|PRODUTOS\s+DA\s+MESMA|CONSULTE\s+DISPONIBILIDADE|OPORTUNIDADES|CANDIDATE[- ]?SE|INCLUSAO|INCLUSÃO|TELEVENDAS|VALE[- ]?GAS|VALE[- ]?GÁS|WHATSAPP|SAO\s+JOSE\s+DO\s+RIO\s+PRETO|SÃO\s+JOSÉ\s+DO\s+RIO\s+PRETO|VOTUPORANGA|FERNANDOPOLIS|FERNANDÓPOLIS|CATANDUVA|TEMOS\s+OPORTUNIDADES|NAO\s+JOGUE|NÃO\s+JOGUE|PAPEL\s+NO\s+CHAO|PAPEL\s+NO\s+CHÃO|ECONOMIA\s+NO\s+SEU\s+BOLSO|FARTURA\s+NO\s+CHURRASCO|CONDICOES|CONDIÇÕES|PARCELA|PARCELE|PARCELE\s+MINIMA|PARCELA\s+MINIMA|LOJES\s+COM|\bBAZAR\b|\bPARC[A-ZÀ-Ü]{0,7}\b|ACADO\s+SAO\s+VALID|ACADO\s+SÃO\s+VÁLID|SOMONTE\s+PARA|SOMENTE\s+PARA\s+PROD|CRED[ÍI]FIATO|CONDL[A-ZÀ-Ü]*)/i;

  function isInstitutionalText(text) {
    const t=cleanText(text);
    if(!t)return true;
    if(CATEGORY_HEADING_RE.test(t))return true;
    if(INSTITUTIONAL_RE.test(t))return true;
    const f=fold(t);
    if(/^(?:MAX|GIGANTE|OFERTA|OFERTAS|FEIRA|CLUBE|PROMOCAO|PROMOÇÃO)$/.test(f))return true;
    if(/\b(?:VALIDOS?\s+APENAS|MESMA\s+FRAGRANCIA|MESMA\s+FRAGRÂNCIA|SABORES\s+ETC)\b/.test(f))return true;
    return false;
  }

  function isNoiseLine(line) {
    const t=fold(line?.text||'');
    if(!t||t.length<2)return true;
    if(isInstitutionalText(line.text))return true;
    if(/^(?:KG|G|GR|ML|L|LT|LTS|UN|UND|UNIDADE|UNIDADES|CADA|PACOTE|PCT|BANDEJA|BDJ|CAIXA|CX)$/.test(t))return true;
    if(/^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}/.test(t))return true;
    const letters=(t.match(/[A-Z]/g)||[]).length,digits=(t.match(/\d/g)||[]).length;
    if(letters<2&&digits>letters*2)return true;
    return false;
  }

  function dedupeWords(text) {
    const words=cleanText(text).split(' ').filter(Boolean);const out=[];
    words.forEach((w)=>{if(!out.length||fold(out[out.length-1])!==fold(w))out.push(w);});
    return out.join(' ').replace(/\b(\w{3,})\s+\1\b/gi,'$1').replace(/\s+/g,' ').trim();
  }

  function sanitizeProductText(text) {
    let value=dedupeWords(text)
      .replace(/^[\s|:;,.\-–—»«'"`´]+/g,'')
      .replace(/[\s|:;,.\-–—»«'"`´]+$/g,'')
      .replace(/\bR\s*\$\s*\d.*$/i,'')
      .replace(/\s+/g,' ')
      .trim();
    // Remove tokens isolados típicos de ruído de OCR nas extremidades sem mexer no miolo real do produto.
    const tokens=value.split(' ').filter(Boolean);
    while(tokens.length>2&&/^[^A-Za-zÀ-ÿ0-9]*[A-Za-zÀ-ÿ]?[^A-Za-zÀ-ÿ0-9]*$/.test(tokens[0])&&tokens[0].length<=2)tokens.shift();
    while(tokens.length>2&&/^[^A-Za-zÀ-ÿ0-9]*[A-Za-zÀ-ÿ]?[^A-Za-zÀ-ÿ0-9]*$/.test(tokens[tokens.length-1])&&tokens[tokens.length-1].length<=2)tokens.pop();
    value=tokens.join(' ');
    return value;
  }

  function extractPackage(text) {
    const t=fold(text);
    const patterns=[
      /\bL\d+P\d+\b/,
      /\b(?:PACOTE|PCT|BANDEJA|BDJ|CAIXA|CX|GARRAFA|PET|LATA|POTE|SACO|SCH|PECA|PEÇA)?\s*\d+(?:[,.]\d+)?\s*(?:KG|G|GR|ML|L|LT|LTS|UN|UND|UNIDADES)\b/,
      /\b\d+\s*X\s*\d+(?:[,.]\d+)?\s*(?:G|ML|L|LT)\b/
    ];
    for(const p of patterns){const m=t.match(p);if(m)return cleanText(m[0]).toLowerCase();}
    return '';
  }

  const PRODUCT_CUE_RE=/\b(?:ABOBORA|ABÓBORA|BATATA|CEBOLA|TOMATE|CENOURA|BANANA|MACA|MAÇÃ|UVA|ALFACE|BROCOLIS|BRÓCOLIS|MANDIOCA|ACEL(?:GA)?|OVOS?|FRANGO|BOVIN|SUIN|SUÍN|CARNE|COSTELA|PALETA|FILE|FILÉ|COXA|SOBRECOXA|PEITO|PERNIL|PANCETA|LINGUICA|LINGUIÇA|PRESUNTO|QUEIJO|MUSSARELA|MARGARINA|REQUEIJAO|REQUEIJÃO|IOGURTE|BEBIDA|LEITE|PAO|PÃO|SALGADINHO|CAROLINA|EMPANADO|NUGGET|SALSICHA|RAVIOLI|ARROZ|FEIJAO|FEIJÃO|CAFE|CAFÉ|ACUCAR|AÇÚCAR|OLEO|ÓLEO|MASSA|MACARR|BISCO|CHOC|REFRIG|CERVEJA|AGUA|ÁGUA|SABAO|SABÃO|DETERG|AMAC|PAPEL|SHAMPOO|SABONETE|FRALDA|DESOD|CARVAO|CARVÃO|AZEITE|FARINHA|MOLHO|MAIONESE|ATUM|MILHO)\b/i;

  function polishProductText(text) {
    let clean=sanitizeProductText(text);
    let tokens=clean.split(/\s+/).filter(Boolean);
    const cueIndex=tokens.findIndex((token)=>PRODUCT_CUE_RE.test(token));
    if(cueIndex>0){
      const prefix=tokens.slice(0,cueIndex);
      const noisy=prefix.filter((t)=>fold(t).replace(/[^A-Z0-9]/g,'').length<=2||/[^A-Za-zÀ-ÿ0-9-]/.test(t)).length/Math.max(1,prefix.length);
      if(noisy>=.45)tokens=tokens.slice(cueIndex);
    }
    const compact=[];
    for(let i=0;i<tokens.length;i+=1){
      const token=tokens[i],next=tokens[i+1];
      if(next){
        const a=fold(token).replace(/[^A-Z0-9]/g,''),b=fold(next).replace(/[^A-Z0-9]/g,'');
        if(a.length>=3&&b.length>=3&&(a.includes(b)||b.startsWith(a))){
          compact.push(b.length>=a.length?next:token);i+=1;continue;
        }
      }
      compact.push(token);
    }
    clean=dedupeWords(compact.join(' '));
    return clean;
  }

  function productSemanticScore(text, ocrConfidence=0) {
    const clean=polishProductText(text);
    if(!clean||isInstitutionalText(clean))return 0;
    const tokens=clean.split(/\s+/).filter(Boolean);
    if(!tokens.length)return 0;
    const chars=[...clean];
    const alpha=chars.filter((c)=>/[A-Za-zÀ-ÿ]/.test(c)).length;
    const weird=chars.filter((c)=>!/[A-Za-zÀ-ÿ0-9\s%/.,+&()\-]/.test(c)).length;
    const alphaRatio=alpha/Math.max(1,chars.length);
    const shortRatio=tokens.filter((t)=>fold(t).replace(/[^A-Z0-9]/g,'').length<=2).length/tokens.length;
    const wordLike=tokens.filter((t)=>{
      const letters=t.replace(/[^A-Za-zÀ-ÿ]/g,'');
      return letters.length<3||/[AEIOUÁÀÂÃÉÊÍÓÔÕÚÜ]/i.test(letters);
    }).length/tokens.length;
    const unique=new Set(tokens.map((t)=>fold(t))).size/Math.max(1,tokens.length);
    let score=.43;
    if(tokens.length>=2&&tokens.length<=9)score+=.15;else if(tokens.length<=13)score+=.07;else score-=.22;
    if(alphaRatio>=.62)score+=.10;else if(alphaRatio<.42)score-=.18;
    if(shortRatio<=.22)score+=.06;else if(shortRatio>.55)score-=.38;else if(shortRatio>.42)score-=.26;
    if(wordLike>=.70)score+=.08;else if(wordLike<.48)score-=.18;
    if(unique>=.72)score+=.05;else score-=.10;
    if(extractPackage(clean))score+=.12;
    if(PRODUCT_CUE_RE.test(clean))score+=.09;
    if(/\b(?:KG|G|GR|ML|L|LT|LTS|UN|UND|PACOTE|PCT|BANDEJA|BDJ|POTE|LATA|PET|GARRAFA|PECA|PEÇA)\b/i.test(clean))score+=.06;
    if(weird/Math.max(1,chars.length)>.055)score-=.18;
    if(ocrConfidence>=85)score+=.05;else if(ocrConfidence<58)score-=.12;
    if(/[»«]{1,}|['"`´]{2,}|\b[A-ZÀ-Ü]\s+[A-ZÀ-Ü]\s+[A-ZÀ-Ü]\b/.test(clean))score-=.10;
    return clamp(score,0,1);
  }

  function buildTextFragments(words, prices) {
    const lines=segmentRows(words);
    const priceBoxes=(prices||[]).map((p)=>p.box).filter(Boolean);
    const heights=words.map((w)=>w.height);const medianH=median(heights)||16;
    const fragments=[];
    lines.forEach((line)=>{
      const kept=(line.words||[]).filter((word)=>{
        if(/^(?:R\$|R|\$|RS)$/i.test(cleanText(word.text)))return false;
        return !priceBoxes.some((pb)=>intersectionRatio(word,pb)>=.40);
      }).sort((a,b)=>a.x0-b.x0);
      let seg=[];
      const flush=()=>{
        if(!seg.length)return;
        const box=unionBoxes(seg),text=sanitizeProductText(seg.map((w)=>w.text).join(' '));
        const confidence=seg.reduce((s,w)=>s+(Number(w.confidence)||0),0)/seg.length;
        if(text&&!isNoiseLine({text,box}))fragments.push({text,words:[...seg],box,confidence,cy:(box.y0+box.y1)/2});
        seg=[];
      };
      kept.forEach((word)=>{
        if(seg.length){const prev=seg[seg.length-1],gap=word.x0-prev.x1,scale=Math.max(prev.height,word.height,medianH,8);if(gap>Math.max(22,Math.min(46,scale*1.55)))flush();}
        seg.push(word);
      });
      flush();
    });
    return fragments;
  }

  function priceFragmentCost(price,fragment,pageWidth) {
    const pc=center(price.box),fc=center(fragment.box);
    const horizontal=rangeDistance(pc.x,fragment.box.x0-12,fragment.box.x1+12);
    const aboveGap=price.box.y0-fragment.box.y1;
    const belowGap=fragment.box.y0-price.box.y1;
    const sameBand=Math.abs(fc.y-pc.y)<=Math.max(34,price.box.height*1.25);
    if(sameBand&&fragment.box.x1<=price.box.x0+50){
      const gap=Math.max(0,price.box.x0-fragment.box.x1);
      return gap*.58+Math.abs(fc.y-pc.y)*.82+horizontal*.3;
    }
    if(aboveGap>=-18&&aboveGap<=Math.max(250,pageWidth*.18))return Math.max(0,aboveGap)*.70+horizontal*1.04+Math.abs(fc.x-pc.x)*.035;
    if(belowGap>=0&&belowGap<=Math.max(70,price.box.height*2.2))return belowGap*1.35+horizontal*1.15+42;
    return 99999;
  }

  function ownershipForFragment(price,fragment,prices,pageWidth) {
    const own=priceFragmentCost(price,fragment,pageWidth);
    let other=Infinity;
    (prices||[]).forEach((candidate)=>{if(candidate===price)return;other=Math.min(other,priceFragmentCost(candidate,fragment,pageWidth));});
    if(!Number.isFinite(other))return {accepted:own<99999,confidence:1,own,other};
    const margin=other-own;
    const confidence=clamp(.5+margin/Math.max(90,other)*.5,0,1);
    return {accepted:own<99999&&(own<=other+8||margin>=-8),confidence,own,other};
  }

  function productForPrice(price, fragments, prices, pageWidth) {
    const eligible=[];
    fragments.forEach((fragment)=>{
      const ownership=ownershipForFragment(price,fragment,prices,pageWidth);
      if(!ownership.accepted)return;
      const semantic=productSemanticScore(fragment.text,fragment.confidence);
      if(semantic<.24)return;
      const cost=ownership.own;
      if(cost>=99999)return;
      eligible.push({fragment,ownership,semantic,cost});
    });
    if(!eligible.length)return null;

    eligible.sort((a,b)=>(a.cost-b.cost)||(b.semantic-a.semantic));
    const anchors=eligible.slice(0,Math.min(8,eligible.length));
    let best=null;
    anchors.forEach((anchor)=>{
      const owned=eligible
        .filter((x)=>x.ownership.confidence>=.40)
        .filter((x)=>{
          const box=x.fragment.box,ab=anchor.fragment.box;
          const yDistance=Math.abs(box.y1-ab.y1);
          const hOverlap=overlap1d(box.x0,box.x1,ab.x0-85,ab.x1+85);
          const centerDiff=Math.abs(center(box).x-center(ab).x);
          return yDistance<=220&&(hOverlap>0||centerDiff<=Math.max(120,pageWidth*.08));
        })
        .sort((a,b)=>a.fragment.box.y0-b.fragment.box.y0);

      const anchorIndex=owned.findIndex((x)=>x.fragment===anchor.fragment);
      const start=Math.max(0,anchorIndex-3),end=Math.min(owned.length,anchorIndex+2);
      for(let s=start;s<=anchorIndex;s+=1){
        for(let e=Math.max(anchorIndex,s);e<end;e+=1){
          const subset=owned.slice(s,e+1);
          if(!subset.some((x)=>x.fragment===anchor.fragment))continue;
          let contiguous=true;
          for(let k=1;k<subset.length;k+=1){if(subset[k].fragment.box.y0-subset[k-1].fragment.box.y1>82){contiguous=false;break;}}
          if(!contiguous)continue;
          const text=polishProductText(subset.map((x)=>x.fragment.text).join(' '));
          if(!text||isInstitutionalText(text))continue;
          const box=unionBoxes(subset.map((x)=>x.fragment.box));
          const ocrConfidence=subset.reduce((sum,x)=>sum+x.fragment.confidence,0)/subset.length;
          const semantic=productSemanticScore(text,ocrConfidence);
          const ownershipConfidence=subset.reduce((sum,x)=>sum+x.ownership.confidence,0)/subset.length;
          const pc=center(price.box);
          const horizontal=rangeDistance(pc.x,box.x0-10,box.x1+10);
          const vertical=box.y1<=price.box.y0?price.box.y0-box.y1:Math.abs(center(box).y-pc.y)*1.1;
          const spatial=clamp(1-horizontal/Math.max(140,pageWidth*.10)-vertical/Math.max(260,pageWidth*.19)*.62,0,1);
          const words=text.split(/\s+/).length;
          const score=semantic*145+spatial*64+ownershipConfidence*52+ocrConfidence*.20-Math.max(0,words-12)*8-anchor.cost*.05;
          if(!best||score>best.score)best={score,productName:text,productBox:box,ocrConfidence,semantic,ownershipConfidence,spatial,selectedFragments:subset};
        }
      }
    });
    if(!best||best.semantic<.50)return null;
    if(!PRODUCT_CUE_RE.test(best.productName)&&!extractPackage(best.productName)&&best.semantic<.68)return null;
    if(best.productName.split(/\s+/).length>15)return null;
    return best;
  }

  function parseFilenameValidity(fileName) {
    const name=fold(fileName).replace(/[._-]+/g,' ');const year=new Date().getFullYear();
    const m=name.match(/\b(\d{1,2})\s*(?:E|A|ATE)\s*(\d{1,2})\s+(\d{1,2})\b/);
    if(!m)return null;
    const startDay=Number(m[1]),endDay=Number(m[2]),month=Number(m[3]);
    if(month<1||month>12||startDay<1||startDay>31||endDay<1||endDay>31)return null;
    const start=new Date(year,month-1,startDay,0,0,0,0).getTime();
    const end=new Date(year,month-1,endDay,23,59,59,999).getTime();
    return {startAt:start,endAt:end,raw:`${String(startDay).padStart(2,'0')}/${String(month).padStart(2,'0')}/${year} a ${String(endDay).padStart(2,'0')}/${String(month).padStart(2,'0')}/${year}`,condition:'',inferred:true};
  }

  function enrichValidity(documentText,fileName) {
    const detected=typeof base.extractValidity==='function'?base.extractValidity(documentText):{startAt:null,endAt:null,raw:'',condition:''};
    if(detected?.startAt&&detected?.endAt){
      const condition=/ENQUANTO\s+DURAREM\s+OS?\s+ESTOQUES?/i.test(documentText)?'enquanto durarem os estoques':(detected.condition||'');
      return {...detected,condition,inferred:false};
    }
    return parseFilenameValidity(fileName)||detected||{startAt:null,endAt:null,raw:'',condition:'',inferred:false};
  }

  function candidateConfidence({product,price,validity,packageText,wordsCount}) {
    let score=.55;const evidence=[],risks=[];
    if(price.explicitCurrency){score+=.07;evidence.push('preço com marcador R$ reconhecido por OCR');}else risks.push('ocr_price_without_currency');
    if(price.passCount>=2){score+=.06;evidence.push('preço confirmado em mais de uma leitura visual');}
    else if(price.confidence<84||price.scale<1.18)risks.push('ocr_price_single_pass');
    if(price.confidence>=86){score+=.055;evidence.push('preço visual com OCR de alta confiança');}
    else if(price.confidence>=72)score+=.025;else risks.push('ocr_low_price_confidence');
    if(price.scale>=1.18){score+=.04;evidence.push('preço com destaque tipográfico compatível com oferta');}
    else if(price.scale<.82)risks.push('ocr_price_scale_suspicious');
    if(price.conflicts?.length){risks.push('ocr_price_conflict');score-=.08;}

    if(product.ocrConfidence>=86){score+=.045;evidence.push('texto visual com OCR de alta confiança');}
    else if(product.ocrConfidence>=70){score+=.018;evidence.push('texto visual reconhecido por OCR');}
    else risks.push('ocr_low_text_confidence');

    if(product.semantic>=.78){score+=.12;evidence.push('descrição com estrutura compatível com produto');}
    else if(product.semantic>=.62){score+=.07;evidence.push('descrição de produto consistente');}
    else if(product.semantic<.48){risks.push('ocr_low_description_quality');score-=.10;}

    if(product.spatial>=.82){score+=.075;evidence.push('produto e preço no mesmo bloco visual');}
    else if(product.spatial>=.66){score+=.035;evidence.push('associação espacial visual compatível');}
    else risks.push('association_disagreement');

    if(product.ownershipConfidence>=.72){score+=.055;evidence.push('bloco visual pertence ao preço selecionado');}
    else if(product.ownershipConfidence>=.52)score+=.02;
    else {risks.push('ocr_block_ownership_weak');score-=.05;}

    if(wordsCount>=2&&wordsCount<=12)score+=.025;
    if(packageText){score+=.025;evidence.push('embalagem identificada');}
    if(validity?.startAt&&validity?.endAt&&!validity.inferred){score+=.065;evidence.push('validade lida no próprio encarte');}
    else if(validity?.startAt&&validity?.endAt&&validity.inferred){score+=.01;evidence.push('validade inferida pelo nome do arquivo');risks.push('ocr_validity_inferred');}
    else risks.push('missing_validity');

    const hard=new Set(['association_disagreement','missing_validity','ocr_low_price_confidence','ocr_price_conflict','ocr_price_scale_suspicious','ocr_low_description_quality']);
    if(risks.some((r)=>hard.has(r)))score=Math.min(score,.91);
    const confidence=clamp(score,.42,.995);
    const structuralSafe=!risks.some((r)=>hard.has(r))&&Boolean(validity?.startAt&&validity?.endAt)&&!validity?.inferred&&price.explicitCurrency&&product.semantic>=.62&&product.spatial>=.68&&product.ownershipConfidence>=.50&&product.ocrConfidence>=68&&price.confidence>=72;
    const automationSafe=structuralSafe&&product.semantic>=.74&&product.spatial>=.78&&product.ownershipConfidence>=.64&&product.ocrConfidence>=72&&price.confidence>=78&&(price.passCount>=2||price.scale>=1.28)&&confidence>=.97;
    return {confidence,risks:[...new Set(risks)],evidence:[...new Set(evidence)],structuralSafe,automationSafe};
  }

  function productSimilarity(a,b) {
    const tokens=(v)=>new Set(fold(v).replace(/[^A-Z0-9]+/g,' ').split(' ').filter((x)=>x.length>1));
    const A=tokens(a),B=tokens(b);if(!A.size||!B.size)return 0;
    const common=[...A].filter((x)=>B.has(x)).length;return common/Math.max(A.size,B.size);
  }

  function buildOcrCandidates(pageData,validity,options) {
    const inferCategory=window.MercadorIA?.inferCategory;
    const passPrices=(pageData.passLines||[]).map((entry)=>priceCandidatesFromLines(entry.lines,{pass:entry.pass,medianWordHeight:entry.medianWordHeight}));
    const prices=mergePricePasses(passPrices);
    const fragments=buildTextFragments(pageData.words,prices);
    const raw=[];

    prices.forEach((price,index)=>{
      const product=productForPrice(price,fragments,prices,pageData.canvasWidth);
      if(!product||!product.productName||product.productName.length<3)return;
      if(isInstitutionalText(product.productName))return;
      const wordsCount=product.productName.split(/\s+/).filter(Boolean).length;
      if(wordsCount<1||product.semantic<.34)return;
      const packageText=extractPackage(product.productName);
      const quality=candidateConfidence({product,price,validity,packageText,wordsCount});
      const category=inferCategory?(inferCategory(product.productName)||'outros'):'outros';
      const sourceBoxCanvas=unionBoxes([product.productBox,price.box]);
      raw.push({
        id:`ocr-p${pageData.pageNumber}-${index}`,
        pageNumber:pageData.pageNumber,pageWidth:pageData.pageWidth,pageHeight:pageData.pageHeight,
        productName:product.productName,category,brand:'',packageText,
        price:price.price,previousPrice:null,detectedPrices:[price.price],priceKind:'general',requiresClub:false,clubName:'',clubSignal:false,
        conditions:validity?.condition||'',confidence:quality.confidence,riskFlags:quality.risks,evidence:quality.evidence,
        associationAgreement:product.spatial,
        ownershipConfidence:product.ownershipConfidence,
        clusterCoherence:product.semantic,
        // Mantidos também para compatibilidade com versões intermediárias.
        domainOwnership:product.ownershipConfidence,blockCoherence:product.semantic,
        structuralSafe:quality.structuralSafe,automationSafe:quality.automationSafe,
        sourceBox:toSourceBox(sourceBoxCanvas,pageData.renderScale),startAt:validity?.startAt||null,endAt:validity?.endAt||null,
        verified:false,verificationMode:'',ignored:false,published:false,reviewed:false,
        extractionMode:'ocr-image-fallback',ocrConfidence:Number(((product.ocrConfidence+price.confidence)/2/100).toFixed(3)),
        ocrPricePasses:price.passCount,ocrPriceScale:Number(price.scale.toFixed(2)),ocrSemanticScore:Number(product.semantic.toFixed(3))
      });
    });

    // Duplicatas do mesmo card/preço são descartadas. Candidatos semanticamente melhores vencem.
    const dedup=[];
    raw.sort((a,b)=>b.confidence-a.confidence||b.clusterCoherence-a.clusterCoherence).forEach((candidate)=>{
      const cb=candidate.sourceBox||{},ccx=(cb.x||0)+(cb.width||0)/2,ccy=(cb.y||0)+(cb.height||0)/2;
      const duplicate=dedup.some((x)=>{
        const xb=x.sourceBox||{},xcx=(xb.x||0)+(xb.width||0)/2,xcy=(xb.y||0)+(xb.height||0)/2;
        return Math.abs(Number(x.price)-Number(candidate.price))<.011&&Math.abs(xcx-ccx)<38&&Math.abs(xcy-ccy)<38&&productSimilarity(x.productName,candidate.productName)>=.52;
      });
      if(!duplicate)dedup.push(candidate);
    });
    return dedup;
  }

  function preprocessCanvas(source,mode='mild') {
    const canvas=document.createElement('canvas');canvas.width=source.width;canvas.height=source.height;
    const ctx=canvas.getContext('2d',{alpha:false,willReadFrequently:true});ctx.drawImage(source,0,0);
    const image=ctx.getImageData(0,0,canvas.width,canvas.height),d=image.data;
    for(let i=0;i<d.length;i+=4){
      const r=d[i],g=d[i+1],b=d[i+2];
      const lum=.299*r+.587*g+.114*b;
      if(mode==='saturation'){
        const max=Math.max(r,g,b),min=Math.min(r,g,b),sat=(max-min)/Math.max(1,max);
        const keep=(sat>.34&&max<240)||(max<88);
        const v=keep?0:255;d[i]=d[i+1]=d[i+2]=v;d[i+3]=255;continue;
      }
      let v;
      if(mode==='strong'){
        v=(lum-128)*1.42+128;if(v>246)v=255;else if(v<24)v=0;
      }else{
        v=(lum-128)*1.16+128;if(v>251)v=255;else if(v<8)v=0;
      }
      v=clamp(Math.round(v),0,255);d[i]=d[i+1]=d[i+2]=v;d[i+3]=255;
    }
    ctx.putImageData(image,0,0);return canvas;
  }

  function cropCanvas(source,x0,y0,x1,y1) {
    const left=Math.max(0,Math.floor(x0)),top=Math.max(0,Math.floor(y0));
    const right=Math.min(source.width,Math.ceil(x1)),bottom=Math.min(source.height,Math.ceil(y1));
    const canvas=document.createElement('canvas');canvas.width=Math.max(1,right-left);canvas.height=Math.max(1,bottom-top);
    const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(source,left,top,canvas.width,canvas.height,0,0,canvas.width,canvas.height);
    return {canvas,offsetX:left,offsetY:top};
  }

  async function recognizePass(worker,canvas,{pass,psm='11',offsetX=0,offsetY=0}={}) {
    await worker.setParameters({preserve_interword_spaces:'1',tessedit_pageseg_mode:String(psm)}).catch(()=>{});
    const result=await worker.recognize(canvas);
    const words=normalizeOcrWords(result.data,{pass,offsetX,offsetY});
    const lines=segmentRows(words);
    return {pass,words,lines,text:cleanText(result.data?.text||lines.map((x)=>x.text).join(' ')),medianWordHeight:median(words.map((w)=>w.height))||16};
  }

  async function analyzeImagePdf(file,options,onProgress) {
    const [pdfjsLib,Tesseract]=await Promise.all([loadPdfJs(),loadTesseract()]);
    const arrayBuffer=await file.arrayBuffer();
    const pdf=await pdfjsLib.getDocument({data:arrayBuffer,cMapUrl:`${PDFJS_BASE}/cmaps/`,cMapPacked:true,standardFontDataUrl:`${PDFJS_BASE}/standard_fonts/`,wasmUrl:`${PDFJS_BASE}/wasm/`}).promise;

    let currentPage=1,progressBase=0,progressWeight=1;
    const worker=await Tesseract.createWorker('por',1,{logger:(m)=>{
      if(m?.status==='recognizing text'&&Number.isFinite(m.progress)&&onProgress){
        const pageFraction=(currentPage-1+(progressBase+m.progress*progressWeight))/pdf.numPages;
        onProgress({pageNumber:currentPage,numPages:pdf.numPages,percent:Math.round(clamp(pageFraction*100,0,99)),mode:'ocr'});
      }
    }});

    try{
      const pages=[],documentTexts=[];
      for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber+=1){
        currentPage=pageNumber;if(onProgress)onProgress({pageNumber,numPages:pdf.numPages,percent:Math.round((pageNumber-1)/pdf.numPages*100),mode:'ocr'});
        const page=await pdf.getPage(pageNumber),baseViewport=page.getViewport({scale:1});
        const targetWidth=Math.min(2500,Math.max(1900,baseViewport.width*3.45));
        const renderScale=targetWidth/baseViewport.width,viewport=page.getViewport({scale:renderScale});
        const source=document.createElement('canvas');source.width=Math.ceil(viewport.width);source.height=Math.ceil(viewport.height);
        const ctx=source.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,source.width,source.height);await page.render({canvasContext:ctx,viewport}).promise;
        const mild=preprocessCanvas(source,'mild');
        const strong=preprocessCanvas(source,'strong');
        const saturation=preprocessCanvas(source,'saturation');
        const passes=[];

        progressBase=0;progressWeight=.34;
        passes.push(await recognizePass(worker,mild,{pass:'layout',psm:'11'}));

        // Segunda leitura independente usa segmentação automática para recuperar linhas corridas.
        progressBase=.34;progressWeight=.27;
        passes.push(await recognizePass(worker,strong,{pass:'dense',psm:'3'}));

        // Terceira leitura é focada em texto destacado/cores. Ela aumenta muito a recuperação de
        // preços estilizados sem contaminar a descrição do produto.
        progressBase=.61;progressWeight=.27;
        passes.push(await recognizePass(worker,saturation,{pass:'color',psm:'11'}));

        let preliminary=mergePricePasses(passes.map((entry)=>priceCandidatesFromLines(entry.lines,{pass:entry.pass,medianWordHeight:entry.medianWordHeight})));

        // Se uma página visualmente rica ainda produziu poucos preços, entra o modo reforçado por faixas verticais.
        const mergedInitialWords=mergeOcrWords(passes.filter((p)=>p.pass!=='color').map((p)=>p.words));
        const needsEnhanced=preliminary.length<7&&mergedInitialWords.length>=70;
        if(needsEnhanced){
          const strips=4,overlap=Math.round(strong.width*.025);
          for(let i=0;i<strips;i+=1){
            const x0=Math.max(0,Math.round(i*strong.width/strips)-overlap),x1=Math.min(strong.width,Math.round((i+1)*strong.width/strips)+overlap);
            const crop=cropCanvas(strong,x0,0,x1,strong.height);
            progressBase=.88+i*(.10/strips);progressWeight=.10/strips;
            const pass=await recognizePass(worker,crop.canvas,{pass:`strip${i+1}`,psm:'6',offsetX:crop.offsetX,offsetY:crop.offsetY});
            passes.push(pass);crop.canvas.width=crop.canvas.height=1;
          }
        }

        const textPasses=passes.filter((p)=>p.pass!=='color');
        const words=mergeOcrWords(textPasses.map((p)=>p.words));
        const lines=segmentRows(words);
        // Validade e condições usam apenas passagens textuais; a máscara cromática serve só ao preço.
        const pageText=cleanText([...new Set(textPasses.map((p)=>p.text).filter(Boolean))].join(' '));
        documentTexts.push(pageText);
        pages.push({pageNumber,pageWidth:baseViewport.width,pageHeight:baseViewport.height,canvasWidth:mild.width,canvasHeight:mild.height,renderScale,words,lines,text:pageText,passLines:passes.map((p)=>({pass:p.pass,lines:p.lines,medianWordHeight:p.medianWordHeight}))});
        source.width=source.height=1;mild.width=mild.height=1;strong.width=strong.height=1;saturation.width=saturation.height=1;
      }

      const documentText=documentTexts.join(' '),validity=enrichValidity(documentText,file.name);
      const candidates=pages.flatMap((page)=>buildOcrCandidates(page,validity,options));
      if(onProgress)onProgress({pageNumber:pdf.numPages,numPages:pdf.numPages,percent:100,mode:'ocr'});
      return {validity,candidates,documentText,numPages:pdf.numPages,ocrPages:pages.map((p)=>({pageNumber:p.pageNumber,words:p.words.length,lines:p.lines.length,passes:p.passLines.length}))};
    }finally{await worker.terminate().catch(()=>{});}
  }

  async function analyzeFile(file,options={},onProgress) {
    const nativeResult=await originalAnalyzeFile(file,options,onProgress);
    if(Array.isArray(nativeResult.candidates)&&nativeResult.candidates.length>0)return {...nativeResult,extractionMode:nativeResult.extractionMode||'pdf-text'};
    if(onProgress)onProgress({pageNumber:1,numPages:nativeResult.numPages||1,percent:1,mode:'ocr'});
    const ocr=await analyzeImagePdf(file,options,onProgress);
    return {...nativeResult,validity:ocr.validity?.startAt?ocr.validity:nativeResult.validity,candidates:ocr.candidates,numPages:ocr.numPages||nativeResult.numPages,engineVersion:OCR_ENGINE_VERSION,extractionMode:'ocr-image-fallback',ocrEngine:`tesseract.js-${TESSERACT_VERSION}`,ocrPages:ocr.ocrPages};
  }

  window.MercadorPDFImporter={...base,ENGINE_VERSION:OCR_ENGINE_VERSION,analyzeFile};
})();
