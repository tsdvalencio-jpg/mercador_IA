(function () {
  'use strict';

  // Motor universal de conhecimento: preserva o importador anterior como validador,
  // mas transforma primeiro o PDF em um JSON canônico (texto nativo, OCR ou híbrido)
  // e extrai as promoções desse documento estruturado.
  const base = window.MercadorPDFImporter;
  if (!base || typeof base.analyzeFile !== 'function') {
    console.error('[Mercador IA] Importador PDF base não encontrado; fallback OCR não foi instalado.');
    return;
  }

  const OCR_ENGINE_VERSION = '3.3.0-card-consensus';
  const KNOWLEDGE_SCHEMA_VERSION = 'mercador.encarte.knowledge.v4';
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
    const maxPriceWidth=Math.max(145,medianWordHeight*10.5);
    const priceToken=(word)=>{
      const raw=cleanText(word?.text||'');
      if(!raw)return false;
      if(currencyAnchor(word))return true;
      const folded=fold(raw).replace(/\s+/g,'');
      if(/^[,.;:]$/.test(folded))return true;
      if(/^(?:R\$)?[0-9ILMOQ|]{1,5}(?:[,.;:][0-9ILMOQ|]{1,2})?$/.test(folded))return true;
      return compactNumericToken(raw)!=='' && !/[A-HJ-KNPR-Z]/i.test(raw);
    };

    lines.forEach((line,lineIndex)=>{
      const words=line.words||[];
      for(let i=0;i<words.length;i+=1){
        if(!priceToken(words[i]))continue;
        for(let len=1;len<=5&&i+len<=words.length;len+=1){
          const slice=words.slice(i,i+len);
          if(slice.some((w)=>!priceToken(w)))break;
          const box=unionBoxes(slice);
          if(!box||box.width>maxPriceWidth)break;
          const text=cleanText(slice.map((w)=>w.text).join(' '));
          const parsed=parseOcrMoney(text);
          if(!parsed)continue;
          const hasCurrency=parsed.explicitCurrency||slice.some(currencyAnchor);
          if(!hasCurrency&&len>2)continue;
          const confidence=slice.reduce((sum,w)=>sum+(Number(w.confidence)||0),0)/slice.length;
          const scale=box.height/Math.max(1,medianWordHeight);
          found.push({price:parsed.price,box,words:slice,lineIndex,confidence,explicitCurrency:hasCurrency,text,pass,pattern:parsed.pattern,scale});
        }
      }
    });

    const dedup=[];
    found.sort((a,b)=>Number(b.explicitCurrency)-Number(a.explicitCurrency)||b.confidence-a.confidence||b.scale-a.scale||a.box.width-b.box.width).forEach((p)=>{
      const pc=center(p.box);
      const exists=dedup.some((x)=>{
        const xc=center(x.box);
        return Math.abs(x.price-p.price)<.001&&Math.abs(xc.x-pc.x)<55&&Math.abs(xc.y-pc.y)<38;
      });
      if(!exists)dedup.push(p);
    });
    return dedup;
  }

  function compactNumericToken(value) {
    const original=cleanText(value);
    // Peso/volume/quantidade não podem virar parte de preço: 400g, 250ml, 3un etc.
    const alpha=fold(original).replace(/[ILMOQ]/g,'').replace(/[^A-Z]/g,'');
    if(alpha)return '';
    const normalized=normalizeNumericOcr(original).replace(/\s+/g,'');
    if(/[A-Z%]/.test(normalized.replace(/R\$?|RS/g,'')))return '';
    const raw=normalized.replace(/[^0-9]/g,'');
    return /^\d{1,5}$/.test(raw)?raw:'';
  }

  function currencyAnchor(word) {
    const t=fold(word?.text||'').replace(/\s+/g,'');
    return t==='R$'||t==='RS'||t==='$'||t==='R';
  }

  // Muitos encartes desenham "R$", reais e centavos como objetos tipográficos separados.
  // Tesseract pode colocar os centavos acima/abaixo da linha e o parser por linha perde o preço.
  // Esta leitura usa geometria, não somente texto corrido, e por isso recupera preços como:
  //   R$ 1 95   /   R$ 14 98   /   R$249   /   R$ 2,49
  // sem transformar números soltos de embalagem em preço.
  function priceCandidatesFromWords(words,{pass='layout',medianWordHeight=16}={}) {
    const list=(words||[]).filter((w)=>w?.text&&w.width>0&&w.height>0);
    const found=[];
    const maxX=Math.max(105,medianWordHeight*7.0);
    const maxY=Math.max(48,medianWordHeight*2.5);

    const push=(price,parts,pattern)=>{
      if(!Number.isFinite(price)||price<=0||price>=10000||!parts?.length)return;
      if(parts.some((w)=>w!==parts[0]&&compactNumericToken(w.text)===''&&!/^[,.;:]$/.test(cleanText(w.text))))return;
      const box=unionBoxes(parts);if(!box)return;
      if(box.width>Math.max(155,medianWordHeight*10.8))return;
      const confidence=parts.reduce((sum,w)=>sum+(Number(w.confidence)||0),0)/parts.length;
      const scale=box.height/Math.max(1,medianWordHeight);
      found.push({price:Number(price.toFixed(2)),box,words:[...parts],lineIndex:-1,confidence,explicitCurrency:true,text:cleanText(parts.map((w)=>w.text).join(' ')),pass,pattern,scale});
    };

    list.filter(currencyAnchor).forEach((anchor)=>{
      const ac=center(anchor);
      const near=list.filter((w)=>{
        if(w===anchor)return false;
        const wc=center(w);
        if(w.x1<anchor.x0-5||w.x0>anchor.x1+maxX)return false;
        if(Math.abs(wc.y-ac.y)>maxY)return false;
        if(compactNumericToken(w.text)===''&&!/^[,.;:]$/.test(cleanText(w.text)))return false;
        return true;
      }).sort((a,b)=>a.x0-b.x0||a.y0-b.y0);

      const ordered=near.filter((w)=>w.x0>=anchor.x0-4).slice(0,6);
      for(let start=0;start<Math.min(2,ordered.length);start+=1){
        for(let len=1;len<=3&&start+len<=ordered.length;len+=1){
          const parts=[anchor,...ordered.slice(start,start+len)];
          const box=unionBoxes(parts);
          if(!box||box.width>Math.max(155,medianWordHeight*10.8))continue;
          const parsed=parseOcrMoney(parts.map((w)=>w.text).join(' '));
          if(parsed?.price)push(parsed.price,parts,`spatial-${parsed.pattern}`);
        }
      }

      // Reais + centavos separados precisam formar um único bloco tipográfico compacto.
      const majors=near.filter((w)=>/^\d{1,4}$/.test(compactNumericToken(w.text)));
      majors.forEach((major)=>{
        const majorDigits=compactNumericToken(major.text);
        if(!majorDigits||major.x0<anchor.x0-5||major.x0-anchor.x1>Math.max(62,medianWordHeight*4.2))return;
        const mc=center(major);
        const cents=near
          .filter((w)=>w!==major&&/^\d{2}$/.test(compactNumericToken(w.text)))
          .filter((w)=>{
            const wc=center(w),gap=w.x0-major.x1;
            const heightRatio=w.height/Math.max(1,major.height);
            return gap>=-5&&gap<=Math.max(46,major.height*2.15)
              &&Math.abs(wc.y-mc.y)<=Math.max(38,major.height*1.15)
              &&heightRatio>=.32&&heightRatio<=1.45;
          })
          .sort((a,b)=>Math.abs(a.x0-major.x1)-Math.abs(b.x0-major.x1)||Math.abs(center(a).y-mc.y)-Math.abs(center(b).y-mc.y));
        if(cents.length){
          const centsDigits=compactNumericToken(cents[0].text);
          const value=Number(`${majorDigits}.${centsDigits}`);
          if(value>=.25&&value<1000)push(value,[anchor,major,cents[0]],'spatial-major-cents');
        }
      });
    });

    const dedup=[];
    found.sort((a,b)=>b.confidence-a.confidence||b.scale-a.scale||a.box.width-b.box.width).forEach((p)=>{
      const pc=center(p.box);
      const duplicate=dedup.some((x)=>{
        const xc=center(x.box);
        return Math.abs(x.price-p.price)<.011&&Math.abs(xc.x-pc.x)<56&&Math.abs(xc.y-pc.y)<42;
      });
      if(!duplicate)dedup.push(p);
    });
    return dedup;
  }

  function collectPassPrices(entry) {
    const linePrices=priceCandidatesFromLines(entry.lines,{pass:entry.pass,medianWordHeight:entry.medianWordHeight});
    const wordPrices=priceCandidatesFromWords(entry.words||[],{pass:entry.pass,medianWordHeight:entry.medianWordHeight});
    const all=[...linePrices,...wordPrices];
    const dedup=[];
    all.sort((a,b)=>Number(b.explicitCurrency)-Number(a.explicitCurrency)||b.confidence-a.confidence||b.scale-a.scale).forEach((p)=>{
      const pc=center(p.box);
      const duplicate=dedup.some((x)=>{
        const xc=center(x.box);
        return Math.abs(x.price-p.price)<.011&&Math.abs(xc.x-pc.x)<68&&Math.abs(xc.y-pc.y)<50;
      });
      if(!duplicate)dedup.push(p);
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
        return Math.abs(g.price-p.price)<.011&&Math.abs(gc.x-pc.x)<58&&Math.abs(gc.y-pc.y)<44;
      });
      if(!group){
        group={...p,passNames:new Set([p.pass]),passCount:1,observations:[p],conflicts:[]};groups.push(group);return;
      }
      group.passNames.add(p.pass);group.passCount=group.passNames.size;group.observations.push(p);
      if(p.confidence>group.confidence){group.confidence=p.confidence;group.box=p.box;group.words=p.words;group.explicitCurrency=group.explicitCurrency||p.explicitCurrency;group.text=p.text;group.scale=Math.max(group.scale,p.scale);group.pattern=p.pattern||group.pattern;}
      else{group.explicitCurrency=group.explicitCurrency||p.explicitCurrency;group.scale=Math.max(group.scale,p.scale);}
    });

    const regions=[];
    groups.forEach((g)=>{
      const gc=center(g.box);
      let region=regions.find((r)=>Math.abs(r.cx-gc.x)<54&&Math.abs(r.cy-gc.y)<40);
      if(!region){region={cx:gc.x,cy:gc.y,groups:[]};regions.push(region);}
      region.groups.push(g);
      region.cx=region.groups.reduce((sum,x)=>sum+center(x.box).x,0)/region.groups.length;
      region.cy=region.groups.reduce((sum,x)=>sum+center(x.box).y,0)/region.groups.length;
    });

    const resolved=[];
    regions.forEach((region)=>{
      if(region.groups.length===1){resolved.push(region.groups[0]);return;}
      const score=(x)=>Number(x.passCount||1)*110+(x.explicitCurrency?28:0)+Number(x.confidence||0)+Math.min(2.4,Number(x.scale||0))*12;
      const ranked=[...region.groups].sort((a,b)=>score(b)-score(a));
      const best=ranked[0],second=ranked[1];
      const dominant=Number(best.passCount||1)>=2&&score(best)-score(second)>=58;
      if(dominant){
        best.conflicts=[];
        best.resolvedConflicts=ranked.slice(1).map((x)=>x.price);
        resolved.push(best);
      }else{
        ranked.forEach((g)=>{
          const gc=center(g.box);
          g.conflicts=ranked.filter((x)=>x!==g&&Math.abs(center(x.box).x-gc.x)<58&&Math.abs(center(x.box).y-gc.y)<44&&Math.abs(x.price-g.price)>.011).map((x)=>x.price);
          resolved.push(g);
        });
      }
    });
    return resolved;
  }

  const CATEGORY_HEADING_RE=/^(?:ACOUGUE(?:\s+COMPLETO)?|AÇOUGUE(?:\s+COMPLETO)?|PADARIA|PERECIVEIS(?:\s+E\s+SALSICHARIA)?|PERECÍVEIS(?:\s+E\s+SALSICHARIA)?|SALSICHARIA|HORTIFRUTI|HORTI\s*FRUTI|BEBIDAS|MERCEARIA|LIMPEZA|HIGIENE|BAZAR|FRIOS|CONGELADOS)$/i;
  const INSTITUTIONAL_RE=/(?:PRECO\s+BAIXO|PREÇO\s+BAIXO|FEIRA\s+GIGANTE|QUEM\s+QUISER|PODE\s+ECONOMIZAR|TODA\s+A\s+LOJA|SEM\s+JUROS|CARTAO|CARTÃO|CREDIFFATO|CREDIFATO|PECA\s+JA|PEÇA\s+JÁ|CLUBE\s+MAX|BAIXE\s+O\s+APP|APROVEITE\s+DESCONTOS|ACESSE\s+(?:O|AO)|FACA\s+(?:UM\s+)?CADASTRO|FAÇA\s+(?:UM\s+)?CADASTRO|INFORME\s+SEU\s+CPF|PRECOS?\s+VALIDOS?|PREÇOS?\s+VÁLIDOS?|ENQUANTO\s+DURAREM|MODALIDADE\s+ATACADO|PRODUTOS\s+DA\s+MESMA|CONSULTE\s+DISPONIBILIDADE|CONSULTAR\s+DISP(?:ONIBILIDADE)?|O?FERTAS?\s+V[AÁ]LIDAS?|OPORTUNIDADES|CANDIDATE[- ]?SE|INCLUSAO|INCLUSÃO|TELEVENDAS|VALE[- ]?GAS|VALE[- ]?GÁS|WHATSAPP|SAO\s+JOSE\s+DO\s+RIO\s+PRETO|SÃO\s+JOSÉ\s+DO\s+RIO\s+PRETO|VOTUPORANGA|FERNANDOPOLIS|FERNANDÓPOLIS|CATANDUVA|TEMOS\s+OPORTUNIDADES|NAO\s+JOGUE|NÃO\s+JOGUE|PAPEL\s+NO\s+CHAO|PAPEL\s+NO\s+CHÃO|ECONOMIA\s+NO\s+SEU\s+BOLSO|FARTURA\s+NO\s+CHURRASCO|CONDICOES|CONDIÇÕES|PARCELA|PARCELE|PARCELE\s+MINIMA|PARCELA\s+MINIMA|LOJES\s+COM|\bBAZAR\b|\bPARC[A-ZÀ-Ü]{0,7}\b|ACADO\s+SAO\s+VALID|ACADO\s+SÃO\s+VÁLID|SOMONTE\s+PARA|SOMENTE\s+PARA\s+PROD|CRED[ÍI]FIATO|CONDL[A-ZÀ-Ü]*)/i;

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
    if(extractPackage(line?.text||''))return false;
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

  const PRODUCT_CUE_RE=/\b(?:ABACATE|ABACAXI|ABOBORA|ABÓBORA|ABOBRINHA|ACELGA|ALHO|ALMEIRAO|ALMEIRÃO|ALFACE|BANANA|BATATA|BERINJELA|BETERRABA|BROCOLIS|BRÓCOLIS|CEBOLA|CENOURA|CHUCHU|COUVE|LARANJA|LIMAO|LIMÃO|MACA|MAÇÃ|MAMAO|MAMÃO|MANDIOCA|MANGA|MELANCIA|MELAO|MELÃO|MORANGO|MOURGOT|OVOS?|PEPINO|PERA|PIMENTAO|PIMENTÃO|REPOLHO|TANGERINA|TOMATE|UVA|VAGEM|FRANGO|BOVIN|SUIN|SUÍN|CARNE|COSTELA|PALETA|FILE|FILÉ|COXA|SOBRECOXA|PEITO|PERNIL|PANCETA|LINGUICA|LINGUIÇA|PRESUNTO|QUEIJO|MUSSARELA|MARGARINA|MANTEIGA|REQUEIJAO|REQUEIJÃO|IOGURTE|BEBIDA|LEITE|PAO|PÃO|BOLO|BROA|ROSCA|TORTA|SONHO|SALGADINHO|CAROLINA|EMPANADO|NUGGET|STEAK|SALSICHA|RAVIOLI|ARROZ|FEIJAO|FEIJÃO|CAFE|CAFÉ|ACUCAR|AÇÚCAR|OLEO|ÓLEO|MASSA|MACARR|BISCO|CHOC|REFRIG|CERVEJA|AGUA|ÁGUA|SABAO|SABÃO|DETERG|AMAC|PAPEL|SHAMPOO|SABONETE|FRALDA|DESOD|CARVAO|CARVÃO|AZEITE|FARINHA|MOLHO|MAIONESE|ATUM|MILHO)\b/i;
  const CORE_PRODUCT_CUE_RE=/\b(?:FRANGO|BOVIN|SUIN|SUÍN|CARNE|COSTELA|PALETA|FILE|FILÉ|COXA|SOBRECOXA|PEITO|PERNIL|PANCETA|LINGUICA|LINGUIÇA|PRESUNTO|QUEIJO|MUSSARELA|MARGARINA|MANTEIGA|REQUEIJAO|REQUEIJÃO|IOGURTE|BEBIDA|LEITE|PAO|PÃO|BOLO|BROA|ROSCA|TORTA|SONHO|SALGADINHO|CAROLINA|EMPANADO|NUGGET|STEAK|SALSICHA|RAVIOLI|ARROZ|FEIJAO|FEIJÃO|CAFE|CAFÉ|ACUCAR|AÇÚCAR|OLEO|ÓLEO|MASSA|MACARR|BISCO|CHOC|REFRIG|CERVEJA|AGUA|ÁGUA|SABAO|SABÃO|DETERG|AMAC|PAPEL|SHAMPOO|SABONETE|FRALDA|DESOD|CARVAO|CARVÃO|AZEITE|FARINHA|MOLHO|MAIONESE|ATUM|MILHO)\b/i;

  function polishProductText(text) {
    let clean=sanitizeProductText(text)
      // Confusões ópticas universais de OCR em nomes de supermercado. A correção só é
      // aplicada à palavra inteira; não altera marcas ou descrições arbitrárias.
      .replace(/\bLOGURTE\b/gi,'Iogurte')
      .replace(/^(?:O|A)\s+(?=(?:GARRAFA|PACOTE|POTE|BANDEJA|LATA|PET)\b)/i,'')
      // Corrige unidades que o OCR costuma confundir somente em contexto inequívoco de embalagem.
      .replace(/\b(PACOTE|PCT|BANDEJA|BDJ|POTE|LATA|GARRAFA)\s*(\d{2,4})9\b/gi,'$1 $2g')
      .replace(/\b(PACOTE|PCT|BANDEJA|BDJ|POTE)\s+(\d{1,2})K[O0]\b/gi,'$1 $2Kg')
      // Condição promocional pertence ao card, mas não ao nome comercial do produto.
      .replace(/\bA\s+PARTIR\s+DE\s+\d+\s+UNIDADES?.*$/i,'')
      .replace(/\bAPARTRDE\s+\d+\s+UNIDADES?.*$/i,'')
      // Faixas publicitárias não podem completar o nome do produto na borda do card.
      .replace(/\b(?:ECONOMIA\s+NO\s+SEU\s+BOLSO|BOLSO\s+E\s+FARTURA|FARTURA\s+NO\s+CHURRASCO|TODA\s+A\s+LOJA).*$/i,'')
      // Sequência como "Pacote To0g" é corrupção visual, não peso confiável. Retém o
      // substantivo de embalagem e deixa a ausência de peso cair na validação, sem inventar.
      .replace(/\b(PACOTE|PCT|BANDEJA|BDJ|POTE|GARRAFA)\s+T[O0]{2}G\b/gi,'$1')
      .trim();
    let tokens=clean.split(/\s+/).filter(Boolean);
    const allowedShortEdge=/^(?:KG|G|GR|ML|L|LT|LTS|UN|UND|TP|PET|PCT|CX|BDJ|OU|DE|DA|DO|DAS|DOS|COM|SEM|E)$/i;
    // Remove fragmentos curtos internos que o Tesseract cria a partir de bordas de foto/preço
    // ("Er", "to", "ns" etc.). Conectivos e unidades legítimos continuam preservados.
    tokens=tokens.filter((token)=>{const norm=fold(token).replace(/[^A-Z0-9]/g,'');return norm.length>2||allowedShortEdge.test(norm)||/^\d/.test(norm);});
    while(tokens.length>2){
      const tail=tokens[tokens.length-1],norm=fold(tail).replace(/[^A-Z0-9]/g,'');
      if(norm.length<=2&&!allowedShortEdge.test(norm))tokens.pop();else break;
    }
    const cueIndex=tokens.findIndex((token)=>PRODUCT_CUE_RE.test(token));
    if(cueIndex>0){
      const prefix=tokens.slice(0,cueIndex);
      const noisy=prefix.filter((t)=>fold(t).replace(/[^A-Z0-9]/g,'').length<=2||/[^A-Za-zÀ-ÿ0-9-]/.test(t)).length/Math.max(1,prefix.length);
      if(noisy>=.45){
        tokens=tokens.slice(cueIndex);
      }else if(cueIndex>=2&&prefix.some((t)=>fold(t).replace(/[^A-Z0-9]/g,'').length<=2)){
        // Se existe lixo curto antes do tipo de produto, preserva apenas o sufixo plausível
        // imediatamente anterior ao produto (normalmente uma marca) e descarta o ruído remoto.
        let keepFrom=cueIndex;
        for(let i=cueIndex-1;i>=0;i-=1){
          const norm=fold(tokens[i]).replace(/[^A-Z0-9]/g,'');
          const plausible=norm.length>=3&&/[AEIOU]/.test(norm);
          if(!plausible)break;
          keepFrom=i;
          if(cueIndex-i>=2)break;
        }
        if(keepFrom>0)tokens=tokens.slice(keepFrom);
      }
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


  // A descrição comercial precisa ser completa, não apenas "um texto perto do preço".
  // Esta nota diferencia um nome utilizável (ex.: "Queijo Mussarela Fatiado ... 160g")
  // de um fragmento plausível porém incompleto (ex.: "Fatiado Seara").
  function descriptionCompletenessScore(text) {
    const clean=polishProductText(text);
    if(!clean||isInstitutionalText(clean))return 0;
    const tokens=clean.split(/\s+/).filter(Boolean);
    const cue=PRODUCT_CUE_RE.test(clean);
    const pack=Boolean(extractPackage(clean));
    const folded=fold(clean);
    let score=.28;
    if(tokens.length>=3&&tokens.length<=12)score+=.16;else if(tokens.length===2)score+=.04;else if(tokens.length>15)score-=.20;
    if(cue)score+=.30;
    if(pack)score+=.18;
    if(/\b(?:KG|G|GR|ML|L|LT|LTS|UN|UND|PACOTE|PCT|BANDEJA|BDJ|POTE|LATA|PET|GARRAFA|PECA|PEÇA)\b/i.test(clean))score+=.06;
    if(/\b(?:PACOTE|PCT|BANDEJA|BDJ|POTE|LATA|GARRAFA)\s*$/i.test(clean))score-=.28;
    if(/^(?:FATIAD[OA]|TRADICIONAL|SABORES?|PACOTE|BANDEJA|CONGELAD[OA]|RESFRIAD[OA]|SEM|COM|LIGHT|ZERO|TIPOS?)\b/.test(folded)&&!cue)score-=.30;
    if(!cue&&!pack&&tokens.length<=3)score-=.24;
    if(/[»«]{1,}|['"`´]{2,}/.test(clean))score-=.12;
    return clamp(score,0,1);
  }

  function descriptionTokenSet(value) {
    return new Set(fold(value).replace(/[^A-Z0-9]+/g,' ').split(' ').filter((x)=>x.length>1));
  }

  function descriptionSimilarity(a,b) {
    const A=descriptionTokenSet(a),B=descriptionTokenSet(b);
    if(!A.size||!B.size)return 0;
    const common=[...A].filter((x)=>B.has(x)).length;
    return common/Math.max(A.size,B.size);
  }

  function descriptionContains(longer,shorter) {
    const A=descriptionTokenSet(longer),B=descriptionTokenSet(shorter);
    if(!A.size||!B.size||A.size<B.size)return false;
    const common=[...B].filter((x)=>A.has(x)).length;
    return common/Math.max(1,B.size)>=.88;
  }

  // Expande a descrição escolhida para linhas imediatamente acima/abaixo que pertençam ao
  // mesmo corredor visual. A expansão é conservadora: ela só entra quando aumenta a
  // completude sem degradar a semântica e sem atravessar claramente para o preço vizinho.
  function expandProductDescription(product,price,fragments,prices,pageWidth) {
    if(!product?.selectedFragments?.length)return product;
    const selected=[...product.selectedFragments].sort((a,b)=>a.fragment.box.y0-b.fragment.box.y0||a.fragment.box.x0-b.fragment.box.x0);
    const selectedSet=new Set(selected.map((x)=>x.fragment));
    const baseBox=unionBoxes(selected.map((x)=>x.fragment.box));
    if(!baseBox)return product;
    const pc=center(price.box);
    const corridorPad=Math.max(36,Math.min(105,pageWidth*.038));
    const candidates=(fragments||[]).filter((fragment)=>!selectedSet.has(fragment)).map((fragment)=>{
      const ownership=ownershipForFragment(price,fragment,prices,pageWidth);
      const semantic=productSemanticScore(fragment.text,fragment.confidence);
      const packageOnly=Boolean(extractPackage(fragment.text));
      return {fragment,ownership,semantic,packageOnly};
    }).filter((x)=>{
      if((x.semantic<.20&&!x.packageOnly)||isInstitutionalText(x.fragment.text))return false;
      const box=x.fragment.box,fc=center(box);
      const horizontal=overlap1d(box.x0,box.x1,baseBox.x0-corridorPad,baseBox.x1+corridorPad);
      const centerDiff=Math.abs(fc.x-center(baseBox).x);
      const aboveGap=baseBox.y0-box.y1,belowGap=box.y0-baseBox.y1;
      const nearVertical=(aboveGap>=0&&aboveGap<=78)||(belowGap>=0&&belowGap<=56);
      if(!nearVertical)return false;
      if(horizontal<=0&&centerDiff>Math.max(88,pageWidth*.052))return false;
      if(x.ownership.own>=99999)return false;
      // Se outro preço é claramente dono deste fragmento, não atravessamos o card.
      if(Number.isFinite(x.ownership.other)&&x.ownership.own>x.ownership.other+16)return false;
      // Linhas muito abaixo do preço normalmente já pertencem ao próximo card.
      if(box.y0>price.box.y1+42)return false;
      return true;
    });

    let best={...product,completeness:descriptionCompletenessScore(product.productName)};
    const trySubset=(subset)=>{
      const ordered=[...subset].sort((a,b)=>a.fragment.box.y0-b.fragment.box.y0||a.fragment.box.x0-b.fragment.box.x0);
      const text=polishProductText(ordered.map((x)=>x.fragment.text).join(' '));
      if(!text||isInstitutionalText(text))return;
      const words=text.split(/\s+/).filter(Boolean).length;
      if(words>17)return;
      for(let k=1;k<ordered.length;k+=1){if(ordered[k].fragment.box.y0-ordered[k-1].fragment.box.y1>84)return;}
      const box=unionBoxes(ordered.map((x)=>x.fragment.box));
      const ocrConfidence=ordered.reduce((s,x)=>s+Number(x.fragment.confidence||0),0)/ordered.length;
      const semantic=productSemanticScore(text,ocrConfidence);
      const completeness=descriptionCompletenessScore(text);
      const ownershipConfidence=ordered.reduce((s,x)=>s+Number(x.ownership?.confidence ?? .55),0)/ordered.length;
      const horizontal=rangeDistance(pc.x,box.x0-10,box.x1+10);
      const vertical=box.y1<=price.box.y0?price.box.y0-box.y1:Math.abs(center(box).y-pc.y)*1.1;
      const spatial=clamp(1-horizontal/Math.max(140,pageWidth*.10)-vertical/Math.max(260,pageWidth*.19)*.62,0,1);
      // Para substituir a versão anterior, a expansão precisa ser mais completa e manter
      // semântica/posição em patamar profissional.
      const improvement=completeness-(best.completeness||0);
      const score=completeness*120+semantic*100+spatial*45+ownershipConfidence*35+ocrConfidence*.12+Math.min(words,11)*2;
      const bestScore=(best.completeness||0)*120+Number(best.semantic||0)*100+Number(best.spatial||0)*45+Number(best.ownershipConfidence||0)*35+Number(best.ocrConfidence||0)*.12+Math.min((best.productName||'').split(/\s+/).length,11)*2;
      const additions=ordered.filter((x)=>!selectedSet.has(x.fragment));
      const structuralAddition=additions.some((x)=>x.packageOnly||PRODUCT_CUE_RE.test(x.fragment.text));
      const directAddition=additions.some((x)=>{
        const b=x.fragment.box;
        return Math.min(Math.abs(baseBox.y0-b.y1),Math.abs(b.y0-baseBox.y1))<=38;
      });
      if(semantic>=Math.max(.48,Number(best.semantic||0)-.055)&&completeness>=.55&&(improvement>=.025||score>bestScore+3||(structuralAddition&&directAddition&&completeness>=Number(best.completeness||0)-.01&&score>=bestScore-2))){
        best={...best,productName:text,productBox:box,ocrConfidence,semantic,ownershipConfidence,spatial,selectedFragments:ordered,completeness};
      }
    };

    candidates.forEach((candidate)=>trySubset([...selected,candidate]));
    // Também tenta duas linhas adicionais quando são contíguas e do mesmo corredor.
    for(let i=0;i<candidates.length;i+=1){
      for(let j=i+1;j<candidates.length;j+=1){
        const a=candidates[i].fragment.box,b=candidates[j].fragment.box;
        if(Math.abs(center(a).x-center(b).x)>Math.max(110,pageWidth*.06))continue;
        if(Math.abs(a.y0-b.y0)>150)continue;
        trySubset([...selected,candidates[i],candidates[j]]);
      }
    }
    return best;
  }

  // Fecha a descrição pelo corredor exclusivo do card depois da escolha principal.
  // Diferente da expansão por score, esta etapa recupera cabeçalho e embalagem contíguos
  // (ex.: "Queijo" + "Mussarela ..." + "160g") sem atravessar para o card vizinho.
  function completeOwnedProductDescription(product,price,fragments,prices,pageWidth) {
    if(!product?.selectedFragments?.length)return product;
    const baseItems=[...product.selectedFragments];
    const baseBox=unionBoxes(baseItems.map((x)=>x.fragment.box));
    if(!baseBox)return product;
    const connector=/^(?:OU|COM|SEM|DE|DA|DO|DAS|DOS|E)$/i;
    const pad=Math.max(34,Math.min(62,pageWidth*.034));
    const candidates=(fragments||[]).map((fragment)=>{
      const ownership=ownershipForFragment(price,fragment,prices,pageWidth);
      const semantic=productSemanticScore(fragment.text,fragment.confidence);
      const pack=Boolean(extractPackage(fragment.text));
      const connect=connector.test(fold(fragment.text));
      return {fragment,ownership,semantic,packageOnly:pack,connectorOnly:connect};
    }).filter((x)=>{
      if(!x.ownership.accepted||isInstitutionalText(x.fragment.text))return false;
      if(x.semantic<.20&&!x.packageOnly&&!x.connectorOnly)return false;
      const box=x.fragment.box,fc=center(box),bc=center(baseBox);
      const horizontal=overlap1d(box.x0,box.x1,baseBox.x0-pad,baseBox.x1+pad);
      if(horizontal<=0&&Math.abs(fc.x-bc.x)>Math.max(68,pageWidth*.04))return false;
      if(box.y1<baseBox.y0-58||box.y0>price.box.y0+12)return false;
      return true;
    }).sort((a,b)=>a.fragment.box.y0-b.fragment.box.y0||a.fragment.box.x0-b.fragment.box.x0);

    if(!candidates.length)return product;
    const selected=[];
    // Começa pelos itens já escolhidos e adiciona vizinhos contíguos acima/abaixo.
    const originalSet=new Set(baseItems.map((x)=>x.fragment));
    candidates.forEach((x)=>{if(originalSet.has(x.fragment))selected.push(x);});
    let changed=true;
    while(changed){
      changed=false;
      const currentBox=unionBoxes(selected.map((x)=>x.fragment.box))||baseBox;
      for(const x of candidates){
        if(selected.includes(x))continue;
        const b=x.fragment.box;
        const gapAbove=currentBox.y0-b.y1;
        const gapBelow=b.y0-currentBox.y1;
        const verticalNear=(gapAbove>=-8&&gapAbove<=42)||(gapBelow>=-8&&gapBelow<=38)||(b.y0<=currentBox.y1&&b.y1>=currentBox.y0);
        if(!verticalNear)continue;
        selected.push(x);changed=true;
      }
    }
    if(!selected.length)return product;
    selected.sort((a,b)=>a.fragment.box.y0-b.fragment.box.y0||a.fragment.box.x0-b.fragment.box.x0);
    const text=polishProductText(selected.map((x)=>x.fragment.text).join(' '));
    if(!text||isInstitutionalText(text))return product;
    const words=text.split(/\s+/).filter(Boolean);
    if(words.length>17)return product;
    const ocrConfidence=selected.reduce((sum,x)=>sum+Number(x.fragment.confidence||0),0)/selected.length;
    const semantic=productSemanticScore(text,ocrConfidence);
    const completeness=descriptionCompletenessScore(text);
    const oldWords=(product.productName||'').split(/\s+/).filter(Boolean).length;
    const usefulGain=words.length>oldWords||Boolean(extractPackage(text)&&!extractPackage(product.productName));
    if(!usefulGain||semantic<Math.max(.48,Number(product.semantic||0)-.06)||completeness<Math.max(.52,Number(product.completeness||0)-.04))return product;
    const productBox=unionBoxes(selected.map((x)=>x.fragment.box));
    const ownershipConfidence=selected.reduce((sum,x)=>sum+Number(x.ownership.confidence||0),0)/selected.length;
    const pc=center(price.box);
    const horizontal=rangeDistance(pc.x,productBox.x0-10,productBox.x1+10);
    const vertical=productBox.y1<=price.box.y0?price.box.y0-productBox.y1:Math.abs(center(productBox).y-pc.y)*1.1;
    const spatial=clamp(1-horizontal/Math.max(140,pageWidth*.10)-vertical/Math.max(260,pageWidth*.19)*.62,0,1);
    return {...product,productName:text,productBox,ocrConfidence,semantic,ownershipConfidence,spatial,selectedFragments:selected,completeness};
  }

  function descriptionNoisePenalty(text) {
    const clean=polishProductText(text),tokens=clean.split(/\s+/).filter(Boolean);
    let penalty=0;
    tokens.forEach((token)=>{
      const norm=fold(token).replace(/[^A-Z0-9]/g,'');
      if(!norm)return;
      if(norm.length<=2&&!/^(?:KG|G|GR|ML|L|LT|UN|TP|OU|DE|DA|DO|COM|SEM|E)$/.test(norm))penalty+=.18;
      if(/[A-Z].*\d.*[A-Z]|\d.*[A-Z].*\d/.test(norm)&&!/^\d+(?:KG|G|ML|L|LT|UN)$/.test(norm))penalty+=.13;
    });
    if(/\b(?:FEM|NEH|GTA|CAMA|TO0G|T00G)\b/i.test(clean))penalty+=.22;
    return clamp(penalty,0,.7);
  }

  // Escolhe a melhor descrição entre as leituras independentes (página inteira, densa,
  // faixas verticais/horizontais). Uma leitura longa e coerente vence um fragmento curto;
  // leituras conflitantes são explicitamente marcadas para revisão.
  function chooseProductDescriptionVariant(variants) {
    const prepared=(variants||[]).filter(Boolean).map((variant)=>{
      const productName=polishProductText(variant.productName||'');
      const semantic=productSemanticScore(productName,variant.ocrConfidence||0);
      const completeness=descriptionCompletenessScore(productName);
      return {...variant,productName,semantic,completeness};
    }).filter((v)=>v.productName&&v.semantic>=.42&&v.completeness>=.35&&!isInstitutionalText(v.productName));
    if(!prepared.length)return null;

    // Remove duplicatas textuais mantendo a leitura mais forte.
    const unique=[];
    prepared.sort((a,b)=>b.completeness-a.completeness||b.semantic-a.semantic||b.ocrConfidence-a.ocrConfidence).forEach((v)=>{
      const existing=unique.find((x)=>descriptionSimilarity(x.productName,v.productName)>=.94);
      if(!existing)unique.push(v);
    });

    unique.forEach((v)=>{
      let agreement=unique.length===1?1:0,support=0,containmentBonus=0;
      unique.forEach((o)=>{
        if(o===v)return;
        const sim=descriptionSimilarity(v.productName,o.productName);
        agreement=Math.max(agreement,sim);
        if(sim>=.64)support+=1;
        if(descriptionContains(v.productName,o.productName)&&v.productName.split(/\s+/).length>o.productName.split(/\s+/).length)containmentBonus+=10;
      });
      const words=v.productName.split(/\s+/).filter(Boolean).length;
      const partialPenalty=unique.some((o)=>o!==v&&descriptionContains(o.productName,v.productName)&&o.completeness>=v.completeness-.04&&o.productName.split(/\s+/).length>=words+2)?18:0;
      v.descriptionAgreement=agreement;
      v.variantSupport=support;
      const noisePenalty=descriptionNoisePenalty(v.productName);
      v.descriptionNoisePenalty=noisePenalty;
      v.variantScore=v.completeness*150+v.semantic*115+Number(v.spatial||0)*52+Number(v.ownershipConfidence||0)*42+Number(v.ocrConfidence||0)*.16+support*16+containmentBonus+Math.min(words,12)*2-partialPenalty-noisePenalty*95;
    });
    unique.sort((a,b)=>b.variantScore-a.variantScore||b.completeness-a.completeness);
    const best=unique[0],runner=unique[1];
    let conflict=false;
    if(runner&&best.completeness>=.58&&runner.completeness>=.58){
      const sim=descriptionSimilarity(best.productName,runner.productName);
      const contained=descriptionContains(best.productName,runner.productName)||descriptionContains(runner.productName,best.productName);
      conflict=sim<.32&&!contained&&Math.abs(best.variantScore-runner.variantScore)<32;
    }
    const fidelity=clamp(best.completeness*.47+best.semantic*.30+Number(best.spatial||0)*.13+Number(best.descriptionAgreement||0)*.10,0,1);
    return {...best,descriptionConflict:conflict,descriptionFidelity:fidelity,descriptionVariantCount:unique.length};
  }

  function pricesShareCard(a,b) {
    if(!a||!b||!a.box||!b.box)return false;
    const A=center(a.box),B=center(b.box);
    const h=Math.max(Number(a.box.height||0),Number(b.box.height||0),18);
    return Math.abs(A.x-B.x)<=Math.max(52,h*1.8)&&Math.abs(A.y-B.y)<=Math.max(38,h*1.6);
  }

  function horizontalPriceCell(price,prices,pageWidth=1200) {
    const pc=center(price.box);
    const rowTol=Math.max(72,Number(price.box?.height||0)*3.0);
    const peers=(prices||[]).filter((p)=>p!==price&&!pricesShareCard(p,price)&&Math.abs(center(p.box).y-pc.y)<=rowTol);
    const left=peers.filter((p)=>center(p.box).x<pc.x).sort((a,b)=>center(b.box).x-center(a.box).x)[0];
    const right=peers.filter((p)=>center(p.box).x>pc.x).sort((a,b)=>center(a.box).x-center(b.box).x)[0];
    const l=left?(center(left.box).x+pc.x)/2:Math.max(0,pc.x-Math.max(115,pageWidth*.09));
    const r=right?(center(right.box).x+pc.x)/2:Math.min(pageWidth,pc.x+Math.max(115,pageWidth*.09));
    return {left:l,right:r};
  }

  function boxInsideHorizontalCell(box,price,prices,pageWidth=1200) {
    const cell=horizontalPriceCell(price,prices,pageWidth);
    const inside=Math.max(0,Math.min(box.x1,cell.right)-Math.max(box.x0,cell.left));
    const ratio=inside/Math.max(1,box.width);
    const cx=center(box).x;
    return {accepted:cx>=cell.left-4&&cx<=cell.right+4&&ratio>=.62,ratio,cell};
  }

  function nearestPriceOwnerForBox(box,prices,pageWidth=1200) {
    if(!box||(prices||[]).length===0)return {price:null,confidence:0,best:Infinity,second:Infinity};
    const fc=center(box);
    const scored=(prices||[]).map((price)=>{
      const pc=center(price.box);
      const above=price.box.y0-box.y1;
      const below=box.y0-price.box.y1;
      if(above>Math.max(300,pageWidth*.20)||below>Math.max(88,pageWidth*.055))return {price,cost:99999};
      const horizontal=rangeDistance(pc.x,box.x0-10,box.x1+10);
      const vertical=above>=0?above*.58:(below>=0?below*1.9:Math.abs(fc.y-pc.y)*.42);
      const centerDx=Math.abs(fc.x-pc.x);
      return {price,cost:horizontal*1.55+vertical+centerDx*.075};
    }).filter((x)=>x.cost<99999).sort((a,b)=>a.cost-b.cost);
    if(!scored.length)return {price:null,confidence:0,best:Infinity,second:Infinity};
    const best=scored[0],second=scored[1];
    if(!second)return {price:best.price,confidence:1,best:best.cost,second:Infinity};
    const margin=second.cost-best.cost;
    const confidence=clamp(.45+margin/Math.max(55,second.cost)*.72,0,1);
    return {price:best.price,confidence,best:best.cost,second:second.cost,margin};
  }

  function buildTextFragments(words, prices, pageWidth=1200) {
    const lines=segmentRows(words);
    const priceBoxes=(prices||[]).map((p)=>p.box).filter(Boolean);
    const heights=words.map((w)=>w.height);const medianH=median(heights)||16;
    const fragments=[];
    lines.forEach((line)=>{
      const kept=(line.words||[]).filter((word)=>{
        if(/^(?:R\$|R|\$|RS)$/i.test(cleanText(word.text)))return false;
        return !priceBoxes.some((pb)=>intersectionRatio(word,pb)>=.34);
      }).sort((a,b)=>a.x0-b.x0);
      let seg=[],segOwner=null;
      const flush=()=>{
        if(!seg.length)return;
        const box=unionBoxes(seg),text=sanitizeProductText(seg.map((w)=>w.text).join(' '));
        const confidence=seg.reduce((sum,w)=>sum+(Number(w.confidence)||0),0)/seg.length;
        const owner=nearestPriceOwnerForBox(box,prices,pageWidth);
        if(text&&!isNoiseLine({text,box}))fragments.push({text,words:[...seg],box,confidence,cy:(box.y0+box.y1)/2,ownerPrice:owner.price,ownerConfidence:owner.confidence});
        seg=[];segOwner=null;
      };
      kept.forEach((word)=>{
        const wordOwner=nearestPriceOwnerForBox(word,prices,pageWidth);
        if(seg.length){
          const prev=seg[seg.length-1],gap=word.x0-prev.x1,scale=Math.max(prev.height,word.height,medianH,8);
          const ownerChanged=segOwner?.price&&wordOwner?.price&&segOwner.price!==wordOwner.price&&!pricesShareCard(segOwner.price,wordOwner.price)&&Math.max(segOwner.confidence,wordOwner.confidence)>=.54;
          if(gap>Math.max(20,Math.min(40,scale*1.42))||ownerChanged)flush();
        }
        if(!seg.length)segOwner=wordOwner;
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
    const scored=(prices||[]).map((candidate)=>({candidate,cost:priceFragmentCost(candidate,fragment,pageWidth)})).filter((x)=>x.cost<99999).sort((a,b)=>a.cost-b.cost);
    if(!scored.length)return {accepted:false,confidence:0,own,other:Infinity};
    const best=scored[0],second=scored[1];
    const shares=fragment.ownerPrice&&pricesShareCard(fragment.ownerPrice,price);
    const explicitOwnerOk=!fragment.ownerPrice||fragment.ownerPrice===price||shares||Number(fragment.ownerConfidence||0)<.48;
    const isBest=best.candidate===price||pricesShareCard(best.candidate,price);
    const cellCheck=boxInsideHorizontalCell(fragment.box,price,prices,pageWidth);
    const other=second?.cost??Infinity;
    const margin=Number.isFinite(other)?other-own:Infinity;
    const confidence=!Number.isFinite(other)?1:clamp(.46+margin/Math.max(50,other)*.72,0,1);
    const ambiguous=Number.isFinite(other)&&margin<Math.max(5,Math.min(18,own*.10));
    return {accepted:own<99999&&isBest&&explicitOwnerOk&&cellCheck.accepted&&!ambiguous,confidence:confidence*cellCheck.ratio,own,other,cell:cellCheck.cell};
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

    const completeness=Number(product.completeness ?? descriptionCompletenessScore(product.productName));
    if(completeness>=.82){score+=.065;evidence.push('descrição comercial completa reconstruída por OCR');}
    else if(completeness>=.66){score+=.03;evidence.push('descrição comercial com boa completude');}
    else {risks.push('ocr_incomplete_description');score-=.09;}
    if(Number(product.descriptionVariantCount||0)>=2&&Number(product.descriptionAgreement||0)>=.66){score+=.045;evidence.push('descrição confirmada em leituras independentes');}
    if(product.descriptionConflict){risks.push('ocr_description_conflict');score-=.10;}

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

    const hard=new Set(['association_disagreement','missing_validity','ocr_low_price_confidence','ocr_price_conflict','ocr_price_scale_suspicious','ocr_low_description_quality','ocr_incomplete_description','ocr_description_conflict','ocr_validity_inferred']);
    if(risks.some((r)=>hard.has(r)))score=Math.min(score,.91);
    const confidence=clamp(score,.42,.995);
    const agreementOk=Number(product.descriptionVariantCount||0)<2||Number(product.descriptionAgreement||0)>=.46;
    const structuralSafe=!risks.some((r)=>hard.has(r))&&Boolean(validity?.startAt&&validity?.endAt)&&!validity?.inferred&&price.explicitCurrency&&product.semantic>=.62&&completeness>=.66&&agreementOk&&!product.descriptionConflict&&product.spatial>=.68&&product.ownershipConfidence>=.50&&product.ocrConfidence>=68&&price.confidence>=72;
    const automationSafe=structuralSafe&&product.semantic>=.74&&completeness>=.78&&(Number(product.descriptionVariantCount||0)<2||Number(product.descriptionAgreement||0)>=.60)&&product.spatial>=.78&&product.ownershipConfidence>=.64&&product.ocrConfidence>=72&&price.confidence>=78&&(price.passCount>=2||price.scale>=1.28)&&confidence>=.97;
    return {confidence,risks:[...new Set(risks)],evidence:[...new Set(evidence)],structuralSafe,automationSafe};
  }

  function productSimilarity(a,b) {
    const tokens=(v)=>new Set(fold(v).replace(/[^A-Z0-9]+/g,' ').split(' ').filter((x)=>x.length>1));
    const A=tokens(a),B=tokens(b);if(!A.size||!B.size)return 0;
    const common=[...A].filter((x)=>B.has(x)).length;return common/Math.max(A.size,B.size);
  }

  function buildOcrCandidates(pageData,validity,options) {
    const inferCategory=window.MercadorIA?.inferCategory;
    const passContexts=(pageData.passLines||[]).map((entry)=>{
      const prices=collectPassPrices(entry);
      return {entry,prices,fragments:buildTextFragments(entry.words||[],prices,pageData.canvasWidth)};
    });
    const prices=mergePricePasses(passContexts.map((ctx)=>ctx.prices));
    const fragments=buildTextFragments(pageData.words,prices,pageData.canvasWidth);
    const raw=[];

    prices.forEach((price,index)=>{
      const refinement=matchRefinementForPrice(price,pageData.cardRefinements||[],pageData.canvasWidth);
      const effectivePrice=refinement?.priceConfirmed
        ? {...price,price:Number(refinement.refinedPrice)}
        : price;

      // Política fail-closed: um preço conflitante ou visualmente absurdo não aparece como
      // promoção enquanto a releitura local não o confirmar. É preferível faltar um card na
      // fila a exibir R$ 144,99 quando o encarte mostra R$ 14,99.
      if(refinement&&!refinement.priceConfirmed&&(price.conflicts?.length||Number(price.price)>=100||!price.explicitCurrency))return;
      if(!refinement&&Number(price.price)>=100)return;

      const variants=[];
      let mergedProduct=productForPrice(price,fragments,prices,pageData.canvasWidth);
      if(mergedProduct){
        mergedProduct=expandProductDescription(mergedProduct,price,fragments,prices,pageData.canvasWidth);
        mergedProduct=completeOwnedProductDescription(mergedProduct,price,fragments,prices,pageData.canvasWidth);
        variants.push({...mergedProduct,descriptionPass:'merged'});
      }

      (price.observations||[]).forEach((observation)=>{
        if(observation.pass==='color')return;
        const ctx=passContexts.find((x)=>x.entry.pass===observation.pass);
        if(!ctx)return;
        let localPrice=ctx.prices.find((p)=>p===observation);
        if(!localPrice){
          const oc=center(observation.box);
          localPrice=ctx.prices.filter((p)=>Math.abs(Number(p.price)-Number(price.price))<.011).sort((a,b)=>{
            const ac=center(a.box),bc=center(b.box);
            return Math.hypot(ac.x-oc.x,ac.y-oc.y)-Math.hypot(bc.x-oc.x,bc.y-oc.y);
          })[0];
        }
        if(!localPrice)return;
        let local=productForPrice(localPrice,ctx.fragments,ctx.prices,pageData.canvasWidth);
        if(local){
          local=expandProductDescription(local,localPrice,ctx.fragments,ctx.prices,pageData.canvasWidth);
          local=completeOwnedProductDescription(local,localPrice,ctx.fragments,ctx.prices,pageData.canvasWidth);
          variants.push({...local,descriptionPass:observation.pass});
        }
      });

      // Reinterpreta também as palavras do OCR global, mas somente dentro da caixa isolada
      // do card. Essa variante costuma preservar acentos/marcas que uma releitura local pode
      // simplificar, sem permitir que o texto atravesse para o produto vizinho.
      if(refinement?.card?.rect){
        const rr=refinement.card.rect;
        const cardWords=(pageData.words||[]).filter((w)=>{
          const wc=center(w);
          return wc.x>=rr.x0&&wc.x<=rr.x1&&wc.y>=rr.y0&&wc.y<=rr.y1;
        });
        if(cardWords.length){
          const cardFragments=buildTextFragments(cardWords,prices,pageData.canvasWidth);
          let cardGlobal=productForPrice(price,cardFragments,prices,pageData.canvasWidth);
          if(cardGlobal){
            cardGlobal=expandProductDescription(cardGlobal,price,cardFragments,prices,pageData.canvasWidth);
            cardGlobal=completeOwnedProductDescription(cardGlobal,price,cardFragments,prices,pageData.canvasWidth);
            variants.push({...cardGlobal,descriptionPass:'card-global-filtered'});
          }
        }
      }

      let cardLocal=null;
      if(refinement?.productConfirmed&&refinement.product){
        cardLocal={
          ...refinement.product,
          descriptionPass:'card-reread',
          completeness:Number(refinement.descriptionCompleteness||descriptionCompletenessScore(refinement.product.productName)),
          descriptionAgreement:Number(refinement.descriptionAgreement||refinement.product.descriptionAgreement||1),
          descriptionVariantCount:Math.max(1,Number(refinement.product.descriptionVariantCount||1)),
          descriptionFidelity:clamp(
            Number(refinement.descriptionCompleteness||0)*.50+
            Number(refinement.product.semantic||0)*.30+
            Number(refinement.product.spatial||0)*.12+
            Number(refinement.descriptionAgreement||0)*.08,0,1
          )
        };
        variants.push(cardLocal);
      }

      let product=chooseProductDescriptionVariant(variants);
      if(cardLocal){
        // A releitura isolada do card tem prioridade sobre uma frase global contaminada por
        // produto vizinho. Ela só vence se passou os gates de completude/semântica acima.
        const sim=product?descriptionSimilarity(product.productName,cardLocal.productName):0;
        const localComp=descriptionCompletenessScore(cardLocal.productName);
        const globalComp=product?descriptionCompletenessScore(product.productName):0;
        if(!product||sim<.50||localComp>=globalComp-.035){
          product={...cardLocal,
            descriptionConflict:Boolean(product&&sim<.28&&globalComp>=.60),
            descriptionVariantCount:Math.max(Number(cardLocal.descriptionVariantCount||1),Number(product?.descriptionVariantCount||1)),
            descriptionAgreement:Math.max(Number(cardLocal.descriptionAgreement||0),sim)
          };
        }
      }

      if(!product||!product.productName||product.productName.length<3)return;
      if(isInstitutionalText(product.productName))return;
      const wordsCount=product.productName.split(/\s+/).filter(Boolean).length;
      if(wordsCount<1||product.semantic<.34)return;

      // Em página OCR, o nome exibido precisa ter passado pela releitura local ou ser muito
      // forte nas evidências globais. Isso elimina textos como "fem io..." e slogans mutilados.
      if((pageData.cardRefinements||[]).length&&refinement&&!refinement.productConfirmed){
        // Em modo profissional, releitura local não confirmada não vira oferta visível.
        // O dado continua preservado no JSON do card para diagnóstico, mas não aparece como
        // promoção e jamais pode ser publicado por engano.
        return;
      }

      const packageText=extractPackage(product.productName);
      const quality=candidateConfidence({product,price:effectivePrice,validity,packageText,wordsCount});
      let confidence=quality.confidence;
      let structuralSafe=quality.structuralSafe;
      let automationSafe=quality.automationSafe;
      const riskFlags=[...(quality.risks||[])];
      const evidence=[...(quality.evidence||[])];

      if(refinement){
        if(refinement.productConfirmed)evidence.push('descrição relida isoladamente no próprio card');
        else{
          riskFlags.push('ocr_card_description_unconfirmed');
          confidence=Math.min(confidence,.86);structuralSafe=false;automationSafe=false;
        }
        if(refinement.priceConfirmed)evidence.push('preço confirmado por releitura numérica do próprio card');
        else{
          riskFlags.push('ocr_card_price_unconfirmed');
          confidence=Math.min(confidence,.86);structuralSafe=false;automationSafe=false;
        }
      }

      const category=inferCategory?(inferCategory(product.productName)||'outros'):'outros';
      const sourceBoxCanvas=unionBoxes([product.productBox,price.box]);
      raw.push({
        id:`ocr-p${pageData.pageNumber}-${index}`,
        pageNumber:pageData.pageNumber,pageWidth:pageData.pageWidth,pageHeight:pageData.pageHeight,
        productName:product.productName,category,brand:'',packageText,
        price:Number(effectivePrice.price),previousPrice:null,detectedPrices:[Number(effectivePrice.price)],priceKind:'general',requiresClub:false,clubName:'',clubSignal:false,
        conditions:validity?.condition||'',confidence,riskFlags:[...new Set(riskFlags)],evidence:[...new Set(evidence)],
        associationAgreement:product.spatial,
        ownershipConfidence:product.ownershipConfidence,
        clusterCoherence:Number(product.descriptionFidelity ?? product.semantic),
        descriptionCompleteness:Number(product.completeness ?? descriptionCompletenessScore(product.productName)),
        descriptionAgreement:Number(product.descriptionAgreement ?? 1),
        descriptionVariantCount:Number(product.descriptionVariantCount || 1),
        descriptionPass:product.descriptionPass || 'merged',
        knowledgeCardText:refinement?.localText||cleanText((product.selectedFragments||[]).map((x)=>x.fragment?.text||'').join(' ')),
        knowledgeOwnerConfidence:Number(product.ownershipConfidence||0),
        cardReread:refinement?{
          productConfirmed:refinement.productConfirmed===true,
          priceConfirmed:refinement.priceConfirmed===true,
          originalPrice:Number(refinement.originalPrice||price.price),
          refinedPrice:Number(refinement.refinedPrice||effectivePrice.price),
          priceReadings:[...(refinement.priceReadings||[])],
          priceVotes:[...(refinement.priceVotes||[])]
        }:null,
        domainOwnership:product.ownershipConfidence,blockCoherence:Number(product.descriptionFidelity ?? product.semantic),
        structuralSafe,automationSafe,
        sourceBox:toSourceBox(sourceBoxCanvas,pageData.renderScale),startAt:validity?.startAt||null,endAt:validity?.endAt||null,
        verified:false,verificationMode:'',ignored:false,published:false,reviewed:false,
        extractionMode:refinement?'ocr-card-reread':'ocr-image-fallback',
        ocrConfidence:Number(((product.ocrConfidence+effectivePrice.confidence)/2/100).toFixed(3)),
        ocrPricePasses:effectivePrice.passCount,ocrPriceScale:Number(effectivePrice.scale.toFixed(2)),ocrSemanticScore:Number(product.semantic.toFixed(3)),ocrDescriptionCompleteness:Number((product.completeness ?? descriptionCompletenessScore(product.productName)).toFixed(3)),ocrDescriptionAgreement:Number((product.descriptionAgreement ?? 1).toFixed(3))
      });
    });

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
    const sw=Math.max(1,Number(source?.width||0)),sh=Math.max(1,Number(source?.height||0));
    const left=clamp(Math.floor(Number(x0)||0),0,Math.max(0,sw-1));
    const top=clamp(Math.floor(Number(y0)||0),0,Math.max(0,sh-1));
    const right=clamp(Math.ceil(Number(x1)||0),left+1,sw);
    const bottom=clamp(Math.ceil(Number(y1)||0),top+1,sh);
    const width=Math.max(1,right-left),height=Math.max(1,bottom-top);
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d',{alpha:false});ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);
    if(width>1&&height>1&&left<sw&&top<sh){ctx.drawImage(source,left,top,width,height,0,0,width,height);}
    return {canvas,offsetX:left,offsetY:top,width,height,valid:width>1&&height>1};
  }

  async function recognizePass(worker,canvas,{pass,psm='11',offsetX=0,offsetY=0}={}) {
    // Garante que parâmetros de uma releitura especializada de preço não vazem para o OCR textual.
    await worker.setParameters({
      preserve_interword_spaces:'1',
      tessedit_pageseg_mode:String(psm),
      tessedit_char_whitelist:''
    }).catch(()=>{});
    const result=await worker.recognize(canvas);
    const words=normalizeOcrWords(result.data,{pass,offsetX,offsetY});
    const lines=segmentRows(words);
    return {pass,words,lines,text:cleanText(result.data?.text||lines.map((x)=>x.text).join(' ')),medianWordHeight:median(words.map((w)=>w.height))||16};
  }

  async function recognizePricePass(worker,canvas,{pass,psm='7',offsetX=0,offsetY=0}={}) {
    await worker.setParameters({
      preserve_interword_spaces:'1',
      tessedit_pageseg_mode:String(psm),
      tessedit_char_whitelist:'R$0123456789,.'
    }).catch(()=>{});
    const result=await worker.recognize(canvas);
    const raw=cleanText(result.data?.text||'');
    const words=normalizeOcrWords(result.data,{pass,offsetX,offsetY});
    return {pass,raw,words,lines:segmentRows(words),medianWordHeight:median(words.map((w)=>w.height))||16};
  }


  function splitNativeTextItem(item,pdfjsLib,viewport,pass='native') {
    const text=cleanText(item?.str||'');
    if(!text)return [];
    let tx;
    try{tx=pdfjsLib.Util.transform(viewport.transform,item.transform);}catch(_){tx=[1,0,0,1,0,0];}
    const fontHeight=Math.max(1,Math.hypot(Number(tx[2]||0),Number(tx[3]||0))||Math.abs(Number(item.height||0)*viewport.scale)||10);
    const totalWidth=Math.max(1,Math.abs(Number(item.width||0)*viewport.scale)||text.length*fontHeight*.48);
    const x0=Number(tx[4]||0),baselineY=Number(tx[5]||fontHeight),y0=baselineY-fontHeight,y1=baselineY;
    const tokens=[...text.matchAll(/\S+/g)];
    if(!tokens.length)return [];
    const charTotal=Math.max(1,text.length);
    return tokens.map((match,index)=>{
      const start=match.index||0,end=start+match[0].length;
      const left=x0+totalWidth*(start/charTotal),right=x0+totalWidth*(end/charTotal);
      return {id:`${pass}-${index}-${start}`,pass,text:cleanText(match[0]),confidence:100,x0:left,y0,x1:Math.max(left+1,right),y1,width:Math.max(1,right-left),height:fontHeight,passNames:new Set([pass]),passCount:1};
    });
  }

  async function analyzeNativeKnowledge(file,onProgress) {
    const pdfjsLib=await loadPdfJs();
    const bytes=await file.arrayBuffer();
    const pdf=await pdfjsLib.getDocument({data:bytes,cMapUrl:`${PDFJS_BASE}/cmaps/`,cMapPacked:true,standardFontDataUrl:`${PDFJS_BASE}/standard_fonts/`,wasmUrl:`${PDFJS_BASE}/wasm/`}).promise;
    const pages=[],documentTexts=[];
    for(let pageNumber=1;pageNumber<=pdf.numPages;pageNumber+=1){
      if(onProgress)onProgress({pageNumber,numPages:pdf.numPages,percent:Math.round(((pageNumber-1)/Math.max(1,pdf.numPages))*18),mode:'knowledge-native'});
      const page=await pdf.getPage(pageNumber);
      const baseViewport=page.getViewport({scale:1});
      const renderScale=2.25;
      const viewport=page.getViewport({scale:renderScale});
      const textContent=await page.getTextContent({normalizeWhitespace:false,disableCombineTextItems:false});
      const words=[];
      (textContent.items||[]).forEach((item,index)=>{
        splitNativeTextItem(item,pdfjsLib,viewport,`native-${pageNumber}-${index}`).forEach((word)=>words.push(word));
      });
      const lines=segmentRows(words);
      const text=cleanText(lines.map((x)=>x.text).join(' '));
      const entry={pass:'native',words,lines,text,medianWordHeight:median(words.map((w)=>w.height))||16};
      const prices=collectPassPrices(entry);
      const usefulWords=words.filter((w)=>!isInstitutionalText(w.text));
      const expectedFloor=Math.round(clamp(usefulWords.length/10.5,2,34));
      pages.push({pageNumber,pageWidth:baseViewport.width,pageHeight:baseViewport.height,canvasWidth:viewport.width,canvasHeight:viewport.height,renderScale,words,lines,text,passLines:[entry],priceCoverageCount:prices.length,expectedPriceFloor:expectedFloor,coveragePasses:0,knowledgeMode:'native'});
      documentTexts.push(text);
    }
    return {pages,documentText:documentTexts.join(' '),numPages:pdf.numPages};
  }

  function knowledgePageNeedsOcr(page) {
    const words=page?.words?.length||0;
    const textChars=String(page?.text||'').replace(/\s+/g,'').length;
    const prices=Number(page?.priceCoverageCount||0);
    const expected=Math.max(2,Number(page?.expectedPriceFloor||2));
    return words<28 || textChars<140 || prices<Math.min(5,Math.ceil(expected*.5));
  }

  function mergeKnowledgePages(nativePage,ocrPage) {
    if(!nativePage)return ocrPage;
    if(!ocrPage)return nativePage;
    const passLines=[...(nativePage.passLines||[]),...(ocrPage.passLines||[])];
    const textPasses=passLines.filter((p)=>p.pass!=='color');
    const words=mergeOcrWords(textPasses.map((p)=>p.words||[]));
    const lines=segmentRows(words);
    const text=cleanText([...new Set(textPasses.map((p)=>p.text||'').filter(Boolean))].join(' '));
    const prices=mergePricePasses(passLines.map((entry)=>collectPassPrices(entry)));
    return {...ocrPage,...nativePage,canvasWidth:ocrPage.canvasWidth||nativePage.canvasWidth,canvasHeight:ocrPage.canvasHeight||nativePage.canvasHeight,renderScale:ocrPage.renderScale||nativePage.renderScale,words,lines,text,passLines,priceCoverageCount:prices.length,expectedPriceFloor:Math.max(Number(nativePage.expectedPriceFloor||0),Number(ocrPage.expectedPriceFloor||0)),coveragePasses:Number(ocrPage.coveragePasses||0),knowledgeMode:'hybrid'};
  }

  function serializableWord(word) {
    return {id:word.id||'',text:word.text||'',normalized:fold(word.text||''),confidence:Number(word.confidence||0),bbox:{x:Number(word.x0||0),y:Number(word.y0||0),width:Number(word.width||Math.max(0,Number(word.x1||0)-Number(word.x0||0))),height:Number(word.height||Math.max(0,Number(word.y1||0)-Number(word.y0||0)))},sources:[...(word.passNames||new Set([word.pass||'unknown']))]};
  }

  function serializableLine(line) {
    return {text:line.text||'',confidence:Number(line.confidence||0),bbox:line.box?{x:Number(line.box.x0||0),y:Number(line.box.y0||0),width:Number(line.box.width||0),height:Number(line.box.height||0)}:null,wordIds:(line.words||[]).map((w)=>w.id||'').filter(Boolean)};
  }

  function knowledgePriceFacts(page) {
    return mergePricePasses((page.passLines||[]).map((entry)=>collectPassPrices(entry))).map((price)=>({value:Number(price.price),text:price.text||'',confidence:Number(price.confidence||0),currencyExplicit:price.explicitCurrency===true,pattern:price.pattern||'',passes:Number(price.passCount||1),bbox:price.box?{x:Number(price.box.x0||0),y:Number(price.box.y0||0),width:Number(price.box.width||0),height:Number(price.box.height||0)}:null}));
  }

  function buildKnowledgeDocument(file,hash,pages,validity,candidates,legacyResult) {
    const modes=[...new Set(pages.map((p)=>p.knowledgeMode||'unknown'))];
    const documentText=cleanText(pages.map((p)=>p.text||'').join(' '));
    return {
      schemaVersion:KNOWLEDGE_SCHEMA_VERSION,
      engineVersion:OCR_ENGINE_VERSION,
      generatedAt:new Date().toISOString(),
      source:{fileName:file.name||'',mimeType:file.type||'application/pdf',size:Number(file.size||0),sha256:hash||'',numPages:pages.length},
      extraction:{modes,pdfjsVersion:PDFJS_VERSION,tesseractVersion:TESSERACT_VERSION,legacyValidator:legacyResult?.engineVersion||base.ENGINE_VERSION||'2.2.0'},
      validity:validity||null,
      documentText,
      pages:pages.map((page)=>({
        pageNumber:page.pageNumber,width:Number(page.pageWidth||0),height:Number(page.pageHeight||0),
        mode:page.knowledgeMode||'unknown',text:page.text||'',
        metrics:{
          words:page.words?.length||0,lines:page.lines?.length||0,
          pricesDetected:Number(page.priceCoverageCount||0),
          expectedPriceFloor:Number(page.expectedPriceFloor||0),
          coveragePasses:Number(page.coveragePasses||0),
          cardsReread:Number(page.cardRefinements?.length||0)
        },
        words:(page.words||[]).map(serializableWord),
        lines:(page.lines||[]).map(serializableLine),
        prices:knowledgePriceFacts(page),
        cards:(page.cardRefinements||[]).map((card)=>({
          id:card.id||'',
          bbox:card.rect?{
            x:Number(card.rect.x0||0)/Math.max(1,Number(page.renderScale||1)),
            y:Number(card.rect.y0||0)/Math.max(1,Number(page.renderScale||1)),
            width:Number(card.rect.width||0)/Math.max(1,Number(page.renderScale||1)),
            height:Number(card.rect.height||0)/Math.max(1,Number(page.renderScale||1))
          }:null,
          text:card.text||'',
          passes:[...(card.passes||[])],
          matches:(card.matches||[]).map((match)=>({
            originalPrice:Number(match.originalPrice||0),
            refinedPrice:Number(match.refinedPrice||0),
            priceConfirmed:match.priceConfirmed===true,
            productName:match.productName||'',
            productConfirmed:match.productConfirmed===true,
            descriptionAgreement:Number(match.descriptionAgreement||0),
            descriptionCompleteness:Number(match.descriptionCompleteness||0),
            priceReadings:[...(match.priceReadings||[])],
            priceVotes:[...(match.priceVotes||[])]
          }))
        }))
      })),
      promotionFacts:(candidates||[]).map((c)=>({id:c.id,pageNumber:c.pageNumber,productName:c.productName,category:c.category||'outros',packageText:c.packageText||'',price:Number(c.price||0),previousPrice:Number(c.previousPrice||0)||null,priceKind:c.priceKind||'general',conditions:c.conditions||'',confidence:Number(c.confidence||0),riskFlags:[...(c.riskFlags||[])],evidence:[...(c.evidence||[])],bbox:c.sourceBox||null,sourceCardText:c.knowledgeCardText||'',ownerConfidence:Number(c.knowledgeOwnerConfidence||c.ownershipConfidence||0),descriptionCompleteness:Number(c.descriptionCompleteness||0),descriptionAgreement:Number(c.descriptionAgreement||0),knowledgeMode:c.knowledgeMode||c.extractionMode||''}))
    };
  }

  async function sha256Hex(file) {
    try{
      const bytes=await file.arrayBuffer();
      const hash=await crypto.subtle.digest('SHA-256',bytes);
      return [...new Uint8Array(hash)].map((b)=>b.toString(16).padStart(2,'0')).join('');
    }catch(_){return '';}
  }

  function sourceBoxCenter(candidate){const b=candidate?.sourceBox;if(!b)return null;return {x:Number(b.x||0)+Number(b.width||0)/2,y:Number(b.y||0)+Number(b.height||0)/2};}

  function mergeCandidateEngines(knowledgeCandidates,legacyCandidates) {
    const result=knowledgeCandidates.map((x)=>({...x,knowledgeMode:x.knowledgeMode||x.extractionMode||'knowledge-json'}));
    (legacyCandidates||[]).forEach((legacy)=>{
      const lc=sourceBoxCenter(legacy);
      let bestIndex=-1,bestScore=0;
      result.forEach((candidate,index)=>{
        if(Number(candidate.pageNumber||0)!==Number(legacy.pageNumber||0))return;
        if(Math.abs(Number(candidate.price||0)-Number(legacy.price||0))>.011)return;
        const kc=sourceBoxCenter(candidate);
        const distance=(lc&&kc)?Math.hypot(lc.x-kc.x,lc.y-kc.y):Infinity;
        const nameScore=productSimilarity(candidate.productName,legacy.productName);
        const positionScore=Number.isFinite(distance)?clamp(1-distance/150,0,1):0;
        const score=Math.max(nameScore,positionScore*.72+nameScore*.28);
        if(score>bestScore){bestScore=score;bestIndex=index;}
      });
      if(bestIndex>=0&&bestScore>=.38){
        const current=result[bestIndex];
        const similarity=productSimilarity(current.productName,legacy.productName);
        const currentCompleteness=descriptionCompletenessScore(current.productName);
        const legacyCompleteness=descriptionCompletenessScore(legacy.productName);
        const conflict=similarity<.20&&current.productName&&legacy.productName;
        const risks=new Set([...(current.riskFlags||[]),...(legacy.riskFlags||[])]);
        if(conflict)risks.add('knowledge_legacy_description_conflict');
        const evidence=new Set([...(current.evidence||[]),...(legacy.evidence||[])]);
        evidence.add(conflict?'JSON de conhecimento e motor legado discordam na descrição':'JSON de conhecimento validado por segunda leitura independente');
        const useLegacy=!conflict&&legacyCompleteness>currentCompleteness+.14;
        result[bestIndex]={...legacy,...current,productName:useLegacy?legacy.productName:current.productName,packageText:useLegacy?(legacy.packageText||current.packageText):current.packageText,riskFlags:[...risks],evidence:[...evidence],confidence:conflict?Math.min(Number(current.confidence||0),Number(legacy.confidence||0),.89):Math.min(1,Math.max(Number(current.confidence||0),Number(legacy.confidence||0))+.01),automationSafe:!conflict&&(current.automationSafe===true||legacy.automationSafe===true),structuralSafe:!conflict&&(current.structuralSafe===true||legacy.structuralSafe===true),knowledgeMode:'knowledge-json-validated',extractionMode:'knowledge-json-validated'};
      }else{
        result.push({...legacy,evidence:[...(legacy.evidence||[]),'Mantido pelo motor PDF anterior para compatibilidade sem regressão'],knowledgeMode:'legacy-compatibility',extractionMode:legacy.extractionMode||'legacy-compatibility'});
      }
    });
    const dedup=[];
    result.sort((a,b)=>Number(b.confidence||0)-Number(a.confidence||0)).forEach((candidate)=>{
      const cc=sourceBoxCenter(candidate);
      const duplicate=dedup.some((x)=>{
        if(Number(x.pageNumber||0)!==Number(candidate.pageNumber||0))return false;
        if(Math.abs(Number(x.price||0)-Number(candidate.price||0))>.011)return false;
        const xc=sourceBoxCenter(x);
        const pos=cc&&xc?Math.hypot(cc.x-xc.x,cc.y-xc.y)<45:false;
        return pos&&productSimilarity(x.productName,candidate.productName)>=.45;
      });
      if(!duplicate)dedup.push(candidate);
    });
    return dedup;
  }


  function ocrEditDistance(a,b) {
    const A=fold(a).replace(/[^A-Z0-9]/g,''),B=fold(b).replace(/[^A-Z0-9]/g,'');
    if(A===B)return 0;
    if(!A.length)return B.length;if(!B.length)return A.length;
    const prev=Array.from({length:B.length+1},(_,i)=>i),cur=new Array(B.length+1);
    for(let i=1;i<=A.length;i+=1){cur[0]=i;for(let j=1;j<=B.length;j+=1){cur[j]=Math.min(cur[j-1]+1,prev[j]+1,prev[j-1]+(A[i-1]===B[j-1]?0:1));}for(let j=0;j<=B.length;j+=1)prev[j]=cur[j];}
    return prev[B.length];
  }

  function ocrTokensEquivalent(a,b) {
    const A=fold(a).replace(/[^A-Z0-9]/g,''),B=fold(b).replace(/[^A-Z0-9]/g,'');
    if(!A||!B)return false;if(A===B)return true;
    const maxLen=Math.max(A.length,B.length),dist=ocrEditDistance(A,B);
    if(maxLen<=3)return dist<=1;
    return dist<=1||(maxLen>=7&&dist<=2);
  }

  // Consolida palavras de PSMs diferentes pela MESMA posição física. Isso é decisivo em
  // encartes: se uma passagem lê "ProBioZ" e duas leem "ProBio2", o JSON preserva o consenso
  // "ProBio2" em vez de escolher cegamente a leitura de maior confidence.
  function consensusOcrPass(passes,{pass='card-consensus'}={}) {
    const observations=[];
    (passes||[]).filter(Boolean).forEach((entry)=>{
      (entry.words||[]).forEach((word)=>{
        if(!word?.text||!word.width||!word.height)return;
        const wc=center(word);
        let group=observations.find((g)=>{
          const gc=center(g.box);
          const overlap=intersectionRatio(g.box,word);
          const close=Math.hypot(gc.x-wc.x,gc.y-wc.y)<=Math.max(10,Math.min(Number(g.box.height||0),Number(word.height||0))*.72);
          return (overlap>=.46||close)&&ocrTokensEquivalent(g.bestText,word.text);
        });
        if(!group){group={box:{...word},items:[],bestText:word.text};observations.push(group);}
        group.items.push(word);
        group.box=unionBoxes(group.items);
        const variants=[];
        group.items.forEach((item)=>{
          let v=variants.find((x)=>ocrTokensEquivalent(x.text,item.text));
          if(!v){v={text:item.text,count:0,confidence:0,exact:new Map()};variants.push(v);}
          v.count+=1;v.confidence+=Number(item.confidence||0);
          const key=fold(item.text);v.exact.set(key,(v.exact.get(key)||0)+1);
        });
        variants.forEach((v)=>{v.exactBest=[...v.exact.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]||fold(v.text);});
        variants.sort((a,b)=>b.count-a.count||b.confidence-a.confidence||b.text.length-a.text.length);
        const winner=variants[0];
        // Dentro de um grupo fuzzy, prefere a grafia exata que apareceu mais vezes. Se empatar,
        // usa a observação de maior confiança daquela grafia.
        const exactCounts=new Map();group.items.forEach((item)=>{const k=fold(item.text);exactCounts.set(k,(exactCounts.get(k)||0)+1);});
        const bestExact=[...exactCounts.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0];
        const eligible=group.items.filter((item)=>!bestExact||fold(item.text)===bestExact);
        const bestItem=(eligible.length?eligible:group.items).sort((a,b)=>Number(b.confidence||0)-Number(a.confidence||0))[0];
        group.bestText=bestItem?.text||winner.text;
      });
    });
    const words=observations.map((group,index)=>{
      const box=group.box,items=group.items;
      const exactCounts=new Map();items.forEach((item)=>{const k=fold(item.text);exactCounts.set(k,(exactCounts.get(k)||0)+1);});
      const bestExact=[...exactCounts.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0];
      const same=items.filter((item)=>!bestExact||fold(item.text)===bestExact);
      const best=(same.length?same:items).sort((a,b)=>Number(b.confidence||0)-Number(a.confidence||0))[0];
      return {id:`${pass}-${index}`,pass,text:best?.text||group.bestText,confidence:items.reduce((sum,x)=>sum+Number(x.confidence||0),0)/items.length,x0:box.x0,y0:box.y0,x1:box.x1,y1:box.y1,width:box.width,height:box.height,consensusVotes:Math.max(...exactCounts.values()),consensusPasses:items.length};
    });
    const lines=segmentRows(words);
    return {pass,words,lines,text:cleanText(lines.map((x)=>x.text).join(' ')),medianWordHeight:median(words.map((w)=>w.height))||16};
  }

  function likelySameOfferCard(a,b,pageWidth=1200) {
    if(!a||!b||!a.box||!b.box)return false;
    if(pricesShareCard(a,b))return true;
    const A=center(a.box),B=center(b.box);
    const h=Math.max(Number(a.box.height||0),Number(b.box.height||0),18);
    return Math.abs(A.x-B.x)<=Math.max(118,pageWidth*.055)
      && Math.abs(A.y-B.y)<=Math.max(82,h*2.65);
  }

  function groupPricesIntoOfferCards(prices,pageWidth=1200) {
    const groups=[];
    (prices||[]).forEach((price)=>{
      const matches=groups.filter((group)=>group.prices.some((p)=>likelySameOfferCard(p,price,pageWidth)));
      if(!matches.length){groups.push({prices:[price]});return;}
      const target=matches[0];target.prices.push(price);
      matches.slice(1).forEach((other)=>{
        target.prices.push(...other.prices);
        const idx=groups.indexOf(other);if(idx>=0)groups.splice(idx,1);
      });
    });
    groups.forEach((group,index)=>{
      group.id=`card-${index+1}`;
      group.box=unionBoxes(group.prices.map((p)=>p.box));
      group.cx=group.prices.reduce((sum,p)=>sum+center(p.box).x,0)/group.prices.length;
      group.cy=group.prices.reduce((sum,p)=>sum+center(p.box).y,0)/group.prices.length;
    });
    return groups;
  }

  function deriveOfferCardRect(group,groups,pageWidth,pageHeight) {
    const rowTol=Math.max(105,pageWidth*.045);
    const peers=(groups||[]).filter((g)=>g!==group&&Math.abs(g.cy-group.cy)<=rowTol);
    const leftPeer=peers.filter((g)=>g.cx<group.cx).sort((a,b)=>b.cx-a.cx)[0];
    const rightPeer=peers.filter((g)=>g.cx>group.cx).sort((a,b)=>a.cx-b.cx)[0];

    let x0=leftPeer?(leftPeer.cx+group.cx)/2:group.cx-Math.max(205,pageWidth*.092);
    let x1=rightPeer?(rightPeer.cx+group.cx)/2:group.cx+Math.max(205,pageWidth*.092);
    x0=Math.min(x0,group.box.x0-18);x1=Math.max(x1,group.box.x1+18);
    // O OCR local precisa enxergar a palavra inteira mesmo quando ela encosta na divisória
    // entre dois cards. O recorte pode sobrepor levemente o vizinho porque a propriedade
    // de cada palavra continua sendo calculada contra TODOS os preços da página.
    const horizontalOverlap=Math.max(42,Math.min(72,pageWidth*.022));
    x0=clamp(x0-horizontalOverlap,0,pageWidth);
    x1=clamp(x1+horizontalOverlap,0,pageWidth);

    const verticalPeers=(groups||[]).filter((g)=>g!==group&&g.cx>=x0-70&&g.cx<=x1+70);
    const above=verticalPeers.filter((g)=>g.cy<group.cy-38).sort((a,b)=>b.cy-a.cy)[0];
    const below=verticalPeers.filter((g)=>g.cy>group.cy+38).sort((a,b)=>a.cy-b.cy)[0];
    const defaultTop=group.cy-Math.max(315,pageWidth*.135);
    const defaultBottom=group.cy+Math.max(105,pageWidth*.048);
    const aboveMid=above?(above.cy+group.cy)/2:null;
    const belowMid=below?(below.cy+group.cy)/2:null;
    const overlapTop=above?Math.min(26,Math.max(8,(group.cy-above.cy)*.08)):0;
    const overlapBottom=below?Math.min(18,Math.max(6,(below.cy-group.cy)*.05)):0;
    let y0=above?aboveMid-overlapTop:defaultTop;
    let y1=below?belowMid+overlapBottom:defaultBottom;

    // O texto comercial normalmente está acima/ao lado do preço. Quando existe um card
    // imediatamente acima/abaixo, o ponto médio entre os preços é tratado como fronteira dura,
    // admitindo apenas uma sobreposição pequena para não cortar uma linha na borda.
    if(!above)y0=Math.min(y0,group.box.y0-Math.max(125,pageWidth*.052));
    y1=Math.max(y1,group.box.y1+Math.max(46,pageWidth*.018));
    y0=clamp(y0,0,pageHeight);y1=clamp(y1,0,pageHeight);
    if(y1-y0<170){
      const mid=(y0+y1)/2;y0=clamp(mid-100,0,pageHeight);y1=clamp(mid+100,0,pageHeight);
    }
    if(x1-x0<150){
      const mid=(x0+x1)/2;x0=clamp(mid-90,0,pageWidth);x1=clamp(mid+90,0,pageWidth);
    }
    return {x0,y0,x1,y1,width:x1-x0,height:y1-y0};
  }

  function dedicatedPriceValue(raw) {
    const t=normalizeNumericOcr(raw).replace(/\s+/g,' ');
    let m=t.match(/(\d{1,4})\s*[,.;:]\s*(\d{2})(?!\d)/);
    if(m){
      const value=Number(`${m[1]}.${m[2]}`);
      return Number.isFinite(value)&&value>=.05&&value<10000?Number(value.toFixed(2)):null;
    }
    const groups=(t.match(/\d+/g)||[]);
    if(groups.length===1&&groups[0].length>=3&&groups[0].length<=5){
      const digits=groups[0],value=Number(`${digits.slice(0,-2)}.${digits.slice(-2)}`);
      return Number.isFinite(value)&&value>=.05&&value<10000?Number(value.toFixed(2)):null;
    }
    if(groups.length===2&&groups[1].length===2&&groups[0].length<=4){
      const value=Number(`${groups[0]}.${groups[1]}`);
      return Number.isFinite(value)&&value>=.05&&value<10000?Number(value.toFixed(2)):null;
    }
    return null;
  }

  function priceMicroRect(price,cardRect,pageWidth,pageHeight) {
    const b=price.box,h=Math.max(14,Number(b.height||0));
    const x0=clamp(Math.max(cardRect.x0,b.x0-Math.max(24,h*.8)),0,pageWidth);
    const x1=clamp(Math.min(cardRect.x1,b.x1+Math.max(74,h*2.7)),0,pageWidth);
    const y0=clamp(Math.max(cardRect.y0,b.y0-Math.max(24,h*.65)),0,pageHeight);
    const y1=clamp(Math.min(cardRect.y1,b.y1+Math.max(34,h*.95)),0,pageHeight);
    return {x0,y0,x1,y1,width:x1-x0,height:y1-y0};
  }

  function cueAnchoredLocalProduct(pass,anchorPrice,allPagePrices,pageWidth) {
    const rawLines=(pass?.lines||[]).map((line)=>{
      const text=polishProductText(line.text||'');
      if(!text||isInstitutionalText(text))return null;
      if(/R\s*\$|\b\d{1,4}\s*[,.;:]\s*\d{2}\b/i.test(text))return null;
      const fragment={text,box:line.box,confidence:Number(line.confidence||0)};
      const ownership=ownershipForFragment(anchorPrice,fragment,allPagePrices||[anchorPrice],pageWidth);
      const semantic=productSemanticScore(text,fragment.confidence);
      const packageOnly=Boolean(extractPackage(text));
      const connector=/^(?:OU|COM|SEM|DE|DA|DO|DAS|DOS|E)$/i.test(fold(text));
      return {line,fragment,ownership,semantic,packageOnly,connector,cue:PRODUCT_CUE_RE.test(text),strongCue:CORE_PRODUCT_CUE_RE.test(text)};
    }).filter(Boolean).filter((x)=>{
      if(!x.ownership.accepted&&Number(x.ownership.confidence||0)<.42)return false;
      if(x.fragment.box.y0>anchorPrice.box.y1+62)return false;
      if(x.semantic<.16&&!x.packageOnly&&!x.connector)return false;
      return true;
    });
    const anchors=rawLines.filter((x)=>x.cue);
    if(!anchors.length)return null;
    let best=null;
    for(const anchor of anchors){
      const selected=[anchor];
      let box=anchor.fragment.box;
      let changed=true;
      while(changed){
        changed=false;
        const candidates=rawLines.filter((x)=>!selected.includes(x)).map((x)=>{
          const b=x.fragment.box;
          const gapAbove=box.y0-b.y1,gapBelow=b.y0-box.y1;
          const verticalNear=(gapAbove>=-8&&gapAbove<=58)||(gapBelow>=-8&&gapBelow<=58)||(b.y0<=box.y1&&b.y1>=box.y0);
          if(!verticalNear)return null;
          const overlap=overlap1d(b.x0,b.x1,box.x0-55,box.x1+55);
          const centerDiff=Math.abs(center(b).x-center(box).x);
          if(overlap<=0&&centerDiff>Math.max(110,pageWidth*.055))return null;
          const distance=Math.min(
            Math.abs(gapAbove>=0?gapAbove:9999),
            Math.abs(gapBelow>=0?gapBelow:9999),
            Math.abs(center(b).y-center(box).y)
          );
          return {x,distance};
        }).filter(Boolean).sort((a,b)=>a.distance-b.distance||b.x.semantic-a.x.semantic);
        if(candidates.length){
          const next=candidates[0].x;
          selected.push(next);box=unionBoxes(selected.map((x)=>x.fragment.box));changed=true;
          if(selected.length>=6)changed=false;
        }
      }
      selected.sort((a,b)=>a.fragment.box.y0-b.fragment.box.y0||a.fragment.box.x0-b.fragment.box.x0);
      const text=polishProductText(selected.map((x)=>x.fragment.text).join(' '));
      if(!text||isInstitutionalText(text))continue;
      const words=text.split(/\s+/).filter(Boolean);
      if(words.length>16)continue;
      const ocrConfidence=selected.reduce((sum,x)=>sum+Number(x.fragment.confidence||0),0)/selected.length;
      const semantic=productSemanticScore(text,ocrConfidence);
      const completeness=descriptionCompletenessScore(text);
      const ownershipConfidence=selected.reduce((sum,x)=>sum+Number(x.ownership.confidence||0),0)/selected.length;
      const productBox=unionBoxes(selected.map((x)=>x.fragment.box));
      const pc=center(anchorPrice.box);
      const horizontal=rangeDistance(pc.x,productBox.x0-15,productBox.x1+15);
      const vertical=productBox.y1<=anchorPrice.box.y0?anchorPrice.box.y0-productBox.y1:Math.abs(center(productBox).y-pc.y);
      const spatial=clamp(1-horizontal/Math.max(180,pageWidth*.09)-vertical/Math.max(310,pageWidth*.16),0,1);
      const firstToken=fold(words[0]||'');
      const startsWithCue=PRODUCT_CUE_RE.test(firstToken);
      const strongCue=selected.some((x)=>x.strongCue);
      const score=completeness*180+semantic*130+ownershipConfidence*62+ocrConfidence*.18+Math.min(words.length,12)*2+(startsWithCue?58:0)+(strongCue?42:0);
      if(!best||score>best.score){
        best={score,productName:text,productBox,ocrConfidence,semantic,ownershipConfidence,spatial,
          selectedFragments:selected.map((x)=>({fragment:x.fragment,ownership:x.ownership})),completeness};
      }
    }
    return best;
  }

  function fallbackProductFromLocalPass(pass,anchorPrice,pageWidth) {
    const pc=center(anchorPrice.box);
    const candidates=(pass?.lines||[]).filter((line)=>{
      if(!line?.text||isNoiseLine(line)||isInstitutionalText(line.text))return false;
      if(/R\s*\$|\b\d{1,4}\s*[,.;:]\s*\d{2}\b/i.test(line.text))return false;
      const box=line.box;if(!box)return false;
      if(box.y0>anchorPrice.box.y1+34)return false;
      const horizontal=rangeDistance(pc.x,box.x0-12,box.x1+12);
      if(horizontal>Math.max(145,pageWidth*.075))return false;
      return true;
    });
    let best=null;
    for(let i=0;i<candidates.length;i+=1){
      for(let len=1;len<=4&&i+len<=candidates.length;len+=1){
        const subset=candidates.slice(i,i+len);
        let contiguous=true;
        for(let k=1;k<subset.length;k+=1){
          if(subset[k].box.y0-subset[k-1].box.y1>58){contiguous=false;break;}
        }
        if(!contiguous)continue;
        const text=polishProductText(subset.map((x)=>x.text).join(' '));
        if(!text||isInstitutionalText(text))continue;
        const ocrConfidence=subset.reduce((sum,x)=>sum+Number(x.confidence||0),0)/subset.length;
        const semantic=productSemanticScore(text,ocrConfidence);
        const completeness=descriptionCompletenessScore(text);
        const box=unionBoxes(subset.map((x)=>x.box));
        const horizontal=rangeDistance(pc.x,box.x0-10,box.x1+10);
        const vertical=box.y1<=anchorPrice.box.y0?anchorPrice.box.y0-box.y1:Math.abs(center(box).y-pc.y);
        const spatial=clamp(1-horizontal/Math.max(150,pageWidth*.08)-vertical/Math.max(270,pageWidth*.14),0,1);
        const score=completeness*155+semantic*125+spatial*58+ocrConfidence*.18;
        if((PRODUCT_CUE_RE.test(text)||extractPackage(text)||semantic>=.72)&&(!best||score>best.score)){
          best={score,productName:text,productBox:box,ocrConfidence,semantic,ownershipConfidence:.92,spatial,selectedFragments:subset.map((line)=>({fragment:{text:line.text,box:line.box,confidence:line.confidence},ownership:{confidence:.92}})),completeness};
        }
      }
    }
    return best;
  }

  function localProductFromPass(pass,anchorPrice,allPagePrices,pageWidth) {
    const localPrices=collectPassPrices(pass);
    const ac=center(anchorPrice.box);
    const matched=[...localPrices].sort((a,b)=>{
      const A=center(a.box),B=center(b.box);
      const da=Math.hypot(A.x-ac.x,A.y-ac.y),db=Math.hypot(B.x-ac.x,B.y-ac.y);
      const va=Math.abs(Number(a.price)-Number(anchorPrice.price))<.011?-70:0;
      const vb=Math.abs(Number(b.price)-Number(anchorPrice.price))<.011?-70:0;
      return (da+va)-(db+vb);
    })[0];
    // A releitura local nunca muda o DONO espacial da descrição. O preço global é a âncora
    // geométrica do card; uma leitura local divergente serve apenas como evidência numérica.
    // Isso evita que um OCR de 14,39/14,89 faça o texto do Iogurte migrar para outro preço.
    const priceRef=anchorPrice;
    const pricesForText=[];
    [...(allPagePrices||[]),...localPrices].forEach((p)=>{
      if(!pricesForText.includes(p))pricesForText.push(p);
    });
    if(!pricesForText.length)pricesForText.push(anchorPrice);
    const fragments=buildTextFragments(pass.words||[],pricesForText,pageWidth);
    let product=productForPrice(priceRef,fragments,pricesForText,pageWidth);
    if(product){
      product=expandProductDescription(product,priceRef,fragments,pricesForText,pageWidth);
      product=completeOwnedProductDescription(product,priceRef,fragments,pricesForText,pageWidth);
    }
    const cueProduct=cueAnchoredLocalProduct(pass,priceRef,pricesForText,pageWidth);
    const fallback=fallbackProductFromLocalPass(pass,priceRef,pageWidth);
    const choices=[product,cueProduct,fallback].filter(Boolean);
    if(!choices.length)return null;
    const cueFirst=cueProduct&&PRODUCT_CUE_RE.test(fold(cueProduct.productName||'').split(/\s+/)[0]||'')&&descriptionCompletenessScore(cueProduct.productName)>=.68;
    if(cueFirst&&CORE_PRODUCT_CUE_RE.test(cueProduct.productName))return cueProduct;
    choices.forEach((candidate)=>{
      const comp=descriptionCompletenessScore(candidate.productName);
      const sem=productSemanticScore(candidate.productName,candidate.ocrConfidence);
      const cue=PRODUCT_CUE_RE.test(candidate.productName)?1:0;
      candidate._localChoiceScore=comp*1.35+sem+Number(candidate.ownershipConfidence||0)*.25+cue*.20;
    });
    choices.sort((a,b)=>b._localChoiceScore-a._localChoiceScore);
    const best=choices[0];
    delete best._localChoiceScore;
    return best;
  }

  function needsSecondCardPass(product,price,localPrice) {
    if(!product)return true;
    if(Number(product.ocrConfidence||0)<76)return true;
    if(descriptionCompletenessScore(product.productName)<.67)return true;
    // Embalagem sozinha não prova que a descrição é completa ("500g" pode sobreviver ao OCR
    // mesmo quando o nome desaparece). Sem um núcleo de produto reconhecido, buscamos outra leitura.
    if(!PRODUCT_CUE_RE.test(product.productName))return true;
    if(price?.conflicts?.length)return true;
    if(localPrice!=null&&Math.abs(Number(localPrice)-Number(price.price))>.011)return true;
    return false;
  }

  function matchRefinementForPrice(price,refinements,pageWidth) {
    const pc=center(price.box);
    let best=null;
    (refinements||[]).forEach((card)=>{
      (card.matches||[]).forEach((match)=>{
        const dx=Number(match.anchorX||0)-pc.x,dy=Number(match.anchorY||0)-pc.y;
        const dist=Math.hypot(dx,dy);
        const valuePenalty=Math.abs(Number(match.originalPrice||0)-Number(price.price||0))<.011?0:42;
        const score=dist+valuePenalty;
        if(score<=Math.max(130,pageWidth*.07)&&(!best||score<best.score))best={...match,score,card};
      });
    });
    return best;
  }

  async function refineOfferCards(worker,source,prices,pageWidth,pageHeight,{pageNumber=1,onProgress=null}={}) {
    const groups=groupPricesIntoOfferCards(prices,pageWidth);
    const refinements=[];
    for(let index=0;index<groups.length;index+=1){
      const group=groups[index],rect=deriveOfferCardRect(group,groups,pageWidth,pageHeight);
      const crop=cropCanvas(source,rect.x0,rect.y0,rect.x1,rect.y1);
      if(crop.canvas.width<80||crop.canvas.height<80){crop.canvas.width=crop.canvas.height=1;continue;}

      const sparse=await recognizePass(worker,crop.canvas,{pass:`card-p${pageNumber}-${index+1}-sparse`,psm:'11',offsetX:crop.offsetX,offsetY:crop.offsetY});
      const sparsePrices=collectPassPrices(sparse);
      const matches=[];
      let autoPass=null,blockPass=null;

      // Primeiro avaliamos cada preço com a releitura local. PSM 3 costuma reconstruir melhor
      // linhas quebradas em encartes; PSM 6 entra somente quando ainda há conflito/incompletude.
      for(const anchor of group.prices){
        const ac=center(anchor.box);
        let localPriceEntry=[...sparsePrices].sort((a,b)=>{
          const A=center(a.box),B=center(b.box);
          return Math.hypot(A.x-ac.x,A.y-ac.y)-Math.hypot(B.x-ac.x,B.y-ac.y);
        })[0]||null;
        if(localPriceEntry&&Math.hypot(center(localPriceEntry.box).x-ac.x,center(localPriceEntry.box).y-ac.y)>Math.max(170,pageWidth*.08))localPriceEntry=null;

        let product1=localProductFromPass(sparse,anchor,prices,pageWidth);
        const localPrice1=localPriceEntry?.price??null;
        const secondNeeded=needsSecondCardPass(product1,anchor,localPrice1);

        if(secondNeeded&&!autoPass){
          const prepared=preprocessCanvas(crop.canvas,'mild');
          autoPass=await recognizePass(worker,prepared,{pass:`card-p${pageNumber}-${index+1}-auto`,psm:'3',offsetX:crop.offsetX,offsetY:crop.offsetY});
          prepared.width=prepared.height=1;
        }
        const product2=autoPass?localProductFromPass(autoPass,anchor,prices,pageWidth):null;
        const localAgreement12=product1&&product2?descriptionSimilarity(product1.productName,product2.productName):0;
        const thirdNeeded=secondNeeded&&(
          !product2||
          needsSecondCardPass(product2,anchor,localPrice1)||
          (product1&&product2&&localAgreement12<.54)
        );
        if(thirdNeeded&&!blockPass){
          const prepared=preprocessCanvas(crop.canvas,'mild');
          blockPass=await recognizePass(worker,prepared,{pass:`card-p${pageNumber}-${index+1}-block`,psm:'6',offsetX:crop.offsetX,offsetY:crop.offsetY});
          prepared.width=prepared.height=1;
        }
        const product3=blockPass?localProductFromPass(blockPass,anchor,prices,pageWidth):null;
        const consensusPass=consensusOcrPass([sparse,autoPass,blockPass].filter(Boolean),{pass:`card-p${pageNumber}-${index+1}-consensus`});
        const productConsensus=localProductFromPass(consensusPass,anchor,prices,pageWidth);
        const productVariants=[
          product1&&{...product1,descriptionPass:'card-sparse'},
          product2&&{...product2,descriptionPass:'card-auto'},
          product3&&{...product3,descriptionPass:'card-block'},
          productConsensus&&{...productConsensus,descriptionPass:'card-consensus',ocrConfidence:Math.max(Number(productConsensus.ocrConfidence||0),78)}
        ].filter(Boolean);
        const localProduct=chooseProductDescriptionVariant(productVariants);

        // Preço: faz uma leitura numérica dedicada no entorno do preço. Se ela discordar,
        // uma segunda segmentação de linha é usada para formar consenso antes de substituir.
        const micro=priceMicroRect(anchor,rect,pageWidth,pageHeight);
        const priceCrop=cropCanvas(source,micro.x0,micro.y0,micro.x1,micro.y1);
        let pricePass1=null,pricePass2=null,p1=null,p2=null;
        if(priceCrop.canvas.width>=35&&priceCrop.canvas.height>=24){
          pricePass1=await recognizePricePass(worker,priceCrop.canvas,{pass:`card-p${pageNumber}-${index+1}-price7`,psm:'7',offsetX:priceCrop.offsetX,offsetY:priceCrop.offsetY});
          p1=dedicatedPriceValue(pricePass1.raw);
          const disagreement=p1!=null&&Math.abs(p1-Number(anchor.price))>.011;
          const suspicious=Number(anchor.price)>=100||anchor.conflicts?.length||!anchor.explicitCurrency;
          if(disagreement||suspicious||p1==null){
            pricePass2=await recognizePricePass(worker,priceCrop.canvas,{pass:`card-p${pageNumber}-${index+1}-price13`,psm:'13',offsetX:priceCrop.offsetX,offsetY:priceCrop.offsetY});
            p2=dedicatedPriceValue(pricePass2.raw);
          }
        }
        priceCrop.canvas.width=priceCrop.canvas.height=1;

        const localCardPrice=localPrice1;
        const votes=[
          p1!=null?{value:p1,source:'price-psm7',weight:3}:null,
          p2!=null?{value:p2,source:'price-psm13',weight:3}:null,
          localCardPrice!=null?{value:Number(localCardPrice),source:'card-text',weight:2}:null,
          {value:Number(anchor.price),source:'global',weight:Math.max(1,Math.min(3,Number(anchor.passCount||1)))}
        ].filter(Boolean);
        const buckets=[];
        votes.forEach((vote)=>{
          let bucket=buckets.find((b)=>Math.abs(b.value-vote.value)<.011);
          if(!bucket){bucket={value:vote.value,weight:0,sources:[]};buckets.push(bucket);}
          bucket.weight+=vote.weight;bucket.sources.push(vote.source);
        });
        buckets.sort((a,b)=>b.weight-a.weight||a.value-b.value);
        const bestBucket=buckets[0],runner=buckets[1];
        const priceConfirmed=Boolean(bestBucket&&(bestBucket.weight>=5||bestBucket.sources.length>=2)
          &&(!runner||bestBucket.weight-runner.weight>=2||Math.abs(bestBucket.value-Number(anchor.price))<.011));
        const refinedPrice=priceConfirmed?Number(bestBucket.value.toFixed(2)):Number(anchor.price);

        const localCue=Boolean(localProduct&&PRODUCT_CUE_RE.test(localProduct.productName));
        const localAgreement=Number(localProduct?.descriptionAgreement||0);
        const localVariants=Number(localProduct?.descriptionVariantCount||0);
        const localName=polishProductText(localProduct?.productName||'');
        const localStartsWithCue=Boolean(localName&&PRODUCT_CUE_RE.test(localName.split(/\s+/)[0]||''));
        const localOcr=Number(localProduct?.ocrConfidence||0);
        const localNoise=descriptionNoisePenalty(localName);
        const evidenceStrong=localOcr>=76||(localVariants>=2&&localAgreement>=.68&&descriptionCompletenessScore(localName)>=.80);
        const productConfirmed=Boolean(localProduct
          && descriptionCompletenessScore(localName)>=.68
          && productSemanticScore(localName,localProduct.ocrConfidence)>=.62
          && localCue
          && localStartsWithCue
          && localNoise<=.12
          && evidenceStrong
          && !/^(?:FEM|IO|NS|TO|ER|FE|EM)\b/i.test(localName));

        matches.push({
          anchorX:ac.x,anchorY:ac.y,originalPrice:Number(anchor.price),
          refinedPrice,priceConfirmed,priceVotes:votes,
          productName:localProduct?.productName||'',
          productConfirmed,
          product:localProduct||null,
          descriptionAgreement:Number(localProduct?.descriptionAgreement||0),
          descriptionCompleteness:Number(localProduct?.completeness??(localProduct?descriptionCompletenessScore(localProduct.productName):0)),
          localText:cleanText([consensusPass?.text||'',sparse.text,autoPass?.text||'',blockPass?.text||''].filter(Boolean).join(' | ')),
          priceReadings:[pricePass1?.raw||'',pricePass2?.raw||''].filter(Boolean)
        });
      }

      refinements.push({
        id:group.id,pageNumber,rect,
        text:cleanText([sparse.text,autoPass?.text||'',blockPass?.text||''].filter(Boolean).join(' | ')),
        passes:[sparse.pass,autoPass?.pass,blockPass?.pass,'card-consensus'].filter(Boolean),
        matches
      });
      crop.canvas.width=crop.canvas.height=1;
      if(onProgress)onProgress({done:index+1,total:groups.length});
    }
    return refinements;
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

        let preliminary=mergePricePasses(passes.map((entry)=>collectPassPrices(entry)));

        // COBERTURA ADAPTATIVA DE ENCARTE VISUAL
        // Um encarte denso pode ter 20-30 cards por página. OCR de página inteira frequentemente
        // enxerga só os textos maiores. Em vez de aceitar essa subdetecção, fazemos uma segunda
        // cobertura por regiões. Os recortes se sobrepõem e são consolidados por coordenadas,
        // portanto aumentam recall sem publicar duplicatas.
        const mergedInitialWords=mergeOcrWords(passes.filter((p)=>p.pass!=='color').map((p)=>p.words));
        const usefulInitialWords=mergedInitialWords.filter((w)=>!isInstitutionalText(w.text));
        const expectedFloor=Math.round(clamp(usefulInitialWords.length/9.5,10,28));
        const richPage=mergedInitialWords.length>=55;
        const needsVerticalCoverage=richPage&&(preliminary.length<18||preliminary.length<expectedFloor);
        let coveragePasses=0;

        if(needsVerticalCoverage){
          const strips=5,overlap=Math.round(mild.width*.035);
          for(let i=0;i<strips;i+=1){
            const x0=Math.max(0,Math.round(i*mild.width/strips)-overlap),x1=Math.min(mild.width,Math.round((i+1)*mild.width/strips)+overlap);
            const crop=cropCanvas(mild,x0,0,x1,mild.height);
            progressBase=.88+i*(.065/strips);progressWeight=.065/strips;
            const pass=await recognizePass(worker,crop.canvas,{pass:`vstrip${i+1}`,psm:'11',offsetX:crop.offsetX,offsetY:crop.offsetY});
            passes.push(pass);coveragePasses+=1;crop.canvas.width=crop.canvas.height=1;
          }
          preliminary=mergePricePasses(passes.map((entry)=>collectPassPrices(entry)));
        }

        // Se a varredura vertical ainda estiver abaixo da densidade textual esperada, fazemos
        // faixas horizontais. Isso cobre layouts mistos (ex.: duas colunas grandes + grade de 3 colunas)
        // sem assumir um modelo específico de supermercado.
        const mergedAfterVertical=mergeOcrWords(passes.filter((p)=>p.pass!=='color').map((p)=>p.words));
        const horizontalFloor=Math.max(16,Math.round(expectedFloor*.88));
        const needsHorizontalCoverage=richPage&&preliminary.length<horizontalFloor&&mergedAfterVertical.length>=70;
        if(needsHorizontalCoverage){
          const bands=3,overlap=Math.round(strong.height*.028);
          for(let i=0;i<bands;i+=1){
            const y0=Math.max(0,Math.round(i*strong.height/bands)-overlap),y1=Math.min(strong.height,Math.round((i+1)*strong.height/bands)+overlap);
            const crop=cropCanvas(strong,0,y0,strong.width,y1);
            progressBase=.945+i*(.045/bands);progressWeight=.045/bands;
            const pass=await recognizePass(worker,crop.canvas,{pass:`hband${i+1}`,psm:'11',offsetX:crop.offsetX,offsetY:crop.offsetY});
            passes.push(pass);coveragePasses+=1;crop.canvas.width=crop.canvas.height=1;
          }
          preliminary=mergePricePasses(passes.map((entry)=>collectPassPrices(entry)));
        }

        // RELEITURA LOCAL POR CARD
        // O OCR global localiza preços e estrutura. Antes de gerar qualquer promoção, cada região
        // comercial é recortada e relida isoladamente. Isso impede que palavras de dois cards
        // vizinhos sejam concatenadas (ex.: queijo + margarina) e permite uma releitura numérica
        // dedicada para corrigir preços visualmente estilizados.
        progressBase=.986;progressWeight=.010;
        const cardRefinements=await refineOfferCards(
          worker,source,preliminary,mild.width,mild.height,
          {pageNumber,onProgress:({done,total})=>{
            if(onProgress)onProgress({
              pageNumber,numPages:pdf.numPages,
              percent:Math.round(clamp(((pageNumber-1)+(0.965+0.03*(done/Math.max(1,total))))/pdf.numPages*100,0,99)),
              mode:'ocr-card-reread'
            });
          }}
        );

        // Rodapé dedicado: validade costuma estar em corpo muito menor que os preços. A releitura
        // não entra no parser de produtos; serve exclusivamente ao conhecimento documental.
        let footerText='';
        const footerY=Math.max(0,Math.floor(source.height*.70));
        const footerCrop=cropCanvas(source,0,footerY,source.width,source.height);
        if(footerCrop.canvas.width>120&&footerCrop.canvas.height>55){
          const footerPrepared=preprocessCanvas(footerCrop.canvas,'mild');
          const footerPass=await recognizePass(worker,footerPrepared,{pass:`footer-p${pageNumber}`,psm:'6',offsetX:footerCrop.offsetX,offsetY:footerCrop.offsetY});
          footerText=footerPass.text||'';
          footerPrepared.width=footerPrepared.height=1;
        }
        footerCrop.canvas.width=footerCrop.canvas.height=1;

        const textPasses=passes.filter((p)=>p.pass!=='color');
        const words=mergeOcrWords(textPasses.map((p)=>p.words));
        const lines=segmentRows(words);
        // Validade e condições combinam OCR principal + rodapé dedicado.
        const pageText=cleanText([...new Set([...textPasses.map((p)=>p.text).filter(Boolean),footerText].filter(Boolean))].join(' '));
        documentTexts.push(pageText);
        pages.push({pageNumber,pageWidth:baseViewport.width,pageHeight:baseViewport.height,canvasWidth:mild.width,canvasHeight:mild.height,renderScale,words,lines,text:pageText,footerText,passLines:passes.map((p)=>({pass:p.pass,words:p.words,lines:p.lines,medianWordHeight:p.medianWordHeight})),priceCoverageCount:preliminary.length,expectedPriceFloor:expectedFloor,coveragePasses,cardRefinements});
        source.width=source.height=1;mild.width=mild.height=1;strong.width=strong.height=1;saturation.width=saturation.height=1;
      }

      const documentText=documentTexts.join(' '),validity=enrichValidity(documentText,file.name);
      const candidates=pages.flatMap((page)=>buildOcrCandidates(page,validity,options));
      if(onProgress)onProgress({pageNumber:pdf.numPages,numPages:pdf.numPages,percent:100,mode:'ocr'});
      return {validity,candidates,documentText,numPages:pdf.numPages,pages,ocrPages:pages.map((p)=>({pageNumber:p.pageNumber,words:p.words.length,lines:p.lines.length,passes:p.passLines.length,pricesDetected:p.priceCoverageCount,expectedFloor:p.expectedPriceFloor,coveragePasses:p.coveragePasses,cardsReread:p.cardRefinements?.length||0}))};
    }finally{await worker.terminate().catch(()=>{});}
  }

  async function analyzeFile(file,options={},onProgress) {
    const hashPromise=sha256Hex(file);
    if(onProgress)onProgress({pageNumber:1,numPages:1,percent:1,mode:'knowledge-json'});

    // 1) O PDF vira primeiro um documento canônico de conhecimento. A extração comercial
    // acontece somente depois dessa camada, independentemente de o PDF ser textual, híbrido ou imagem.
    const nativeKnowledge=await analyzeNativeKnowledge(file,onProgress);
    let pages=nativeKnowledge.pages;
    const sparsePages=pages.filter(knowledgePageNeedsOcr).map((p)=>p.pageNumber);
    let ocrResult=null;

    // 2) OCR não substitui o texto nativo: ele complementa somente quando a página não trouxe
    // cobertura suficiente. Em PDF híbrido, as duas evidências permanecem no mesmo JSON.
    if(sparsePages.length){
      if(onProgress)onProgress({pageNumber:sparsePages[0],numPages:nativeKnowledge.numPages,percent:19,mode:'knowledge-ocr'});
      ocrResult=await analyzeImagePdf(file,options,(progress)=>{
        if(!onProgress)return;
        onProgress({...progress,percent:Math.round(20+Number(progress.percent||0)*.62),mode:'knowledge-ocr'});
      });
      const ocrByPage=new Map((ocrResult.pages||[]).map((p)=>[Number(p.pageNumber),p]));
      pages=pages.map((nativePage)=>sparsePages.includes(nativePage.pageNumber)?mergeKnowledgePages(nativePage,ocrByPage.get(nativePage.pageNumber)):nativePage);
    }

    const documentText=cleanText(pages.map((p)=>p.text||'').join(' '));
    const validity=enrichValidity(documentText,file.name);
    const knowledgeCandidates=pages.flatMap((page)=>buildOcrCandidates(page,validity,options));

    // 3) O motor anterior não é removido. Ele passa a atuar como validador independente e
    // caminho de compatibilidade para não regredir PDFs que já funcionavam bem.
    if(onProgress)onProgress({pageNumber:1,numPages:nativeKnowledge.numPages,percent:84,mode:'legacy-validator'});
    const legacyResult=await originalAnalyzeFile(file,options,(progress)=>{
      if(!onProgress)return;
      onProgress({...progress,percent:Math.round(84+Number(progress.percent||0)*.13),mode:'legacy-validator'});
    });
    const candidates=mergeCandidateEngines(knowledgeCandidates,legacyResult.candidates||[]);
    const hash=(await hashPromise)||legacyResult.hash||'';
    const knowledgeDocument=buildKnowledgeDocument(file,hash,pages,validity,candidates,legacyResult);
    const modes=knowledgeDocument.extraction.modes;
    const extractionMode=modes.includes('hybrid')?'knowledge-json-hybrid':(modes.includes('native')&&!ocrResult?'knowledge-json-native':'knowledge-json-ocr');

    if(onProgress)onProgress({pageNumber:nativeKnowledge.numPages,numPages:nativeKnowledge.numPages,percent:100,mode:'knowledge-json'});
    const result={...legacyResult,fileName:legacyResult.fileName||file.name,hash,numPages:nativeKnowledge.numPages,validity:validity?.startAt?validity:(legacyResult.validity||validity),candidates,engineVersion:OCR_ENGINE_VERSION,extractionMode,knowledgeSchemaVersion:KNOWLEDGE_SCHEMA_VERSION,knowledgeDocument,knowledgeMetrics:{pages:pages.length,modes,words:pages.reduce((s,p)=>s+(p.words?.length||0),0),lines:pages.reduce((s,p)=>s+(p.lines?.length||0),0),prices:pages.reduce((s,p)=>s+knowledgePriceFacts(p).length,0),candidates:candidates.length},ocrEngine:ocrResult?`tesseract.js-${TESSERACT_VERSION}`:'',ocrPages:ocrResult?.ocrPages||[]};
    window.MercadorPDFImporter.lastKnowledgeDocument=knowledgeDocument;
    return result;
  }

  function downloadKnowledgeJson(knowledgeDocument,fileName='encarte') {
    const data=knowledgeDocument||window.MercadorPDFImporter?.lastKnowledgeDocument;
    if(!data)throw new Error('Nenhum JSON de conhecimento disponível. Analise um encarte primeiro.');
    const safe=String(fileName||'encarte').replace(/\.pdf$/i,'').replace(/[^a-z0-9._-]+/gi,'_');
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json;charset=utf-8'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=`${safe}.mercador-knowledge.json`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }

  window.MercadorPDFImporter={...base,ENGINE_VERSION:OCR_ENGINE_VERSION,KNOWLEDGE_SCHEMA_VERSION,analyzeFile,downloadKnowledgeJson,getLastKnowledgeDocument:()=>window.MercadorPDFImporter.lastKnowledgeDocument||null,lastKnowledgeDocument:null};
})();
