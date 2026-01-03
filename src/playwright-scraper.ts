#!/usr/bin/env node
/**
 * TradingView Historical Data Scraper via Playwright
 * Usa Bar Replay para baixar dados históricos ano a ano
 */
import { chromium, Browser, Page } from 'playwright';
import { join } from 'path';
import { mkdir, readFile, stat, readdir } from 'fs/promises';
import { existsSync, createReadStream } from 'fs';
import { createHash } from 'crypto';

// ═══════════════════════════════════════════════════════════════════════════
// Configuração de Gap por Timeframe
// Gap = quantidade de candles que queremos baixar por arquivo CSV (~10k candles)
// ═══════════════════════════════════════════════════════════════════════════

interface TimeframeConfig {
  gapCandles: number;           // Quantidade de candles por download (~10k)
  timeMinutes: number;          // Minutos por candle
}

const TIMEFRAME_CONFIG: Record<string, TimeframeConfig> = {
  // Fator de mercado médio: 1.57x | Margem de erro: ~1h para 5M (12 candles)
  // Gap conservador: 9800 candles (margem de ~200 candles ≈ 17min em 5M)
  '1':   { gapCandles: 9800, timeMinutes: 1   },  // ~19.8 dias reais
  '3':   { gapCandles: 9800, timeMinutes: 3   },  // ~33.3 dias reais
  '5':   { gapCandles: 9800, timeMinutes: 5   },  // ~53 dias reais
  '15':  { gapCandles: 9800, timeMinutes: 15  },  // ~154 dias reais
  '60':  { gapCandles: 9800, timeMinutes: 60  },  // ~608 dias reais
  '240': { gapCandles: 9800, timeMinutes: 240 },  // ~2430 dias reais
};

/**
 * Formata Date para string legível: YYYY-MM-DD HH:mm
 */
function formatDate(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Calcula a data ajustada com margem de segurança
 * Aplica fator de mercado ou usa gap adaptativo se fornecido
 */
function calculateAdjustedDate(
  targetDate: Date, 
  timeframe: string,
  overrideGapMinutes?: number // Gap adaptativo calculado do CSV anterior
): { adjustedDate: Date; warnings: string[]; config: TimeframeConfig; realMinutes: number } {
  
  const warnings: string[] = [];
  const config = TIMEFRAME_CONFIG[timeframe];
  
  // Fator de mercado: 2.05 = gap padrão de ~70 dias para 5M
  const MARKET_FACTOR = 1.9;
  // Margem de segurança: +3 dias em minutos
  const SAFETY_MARGIN_MINUTES = 3 * 24 * 60;
  
  if (!config) {
    // Fallback para 1H se timeframe não suportado
    console.warn(`⚠️ Timeframe '${timeframe}' não configurado. Usando fallback 60m.`);
    return calculateAdjustedDate(targetDate, '60', overrideGapMinutes);
  }
  
  let realMinutes: number;
  
  // Cálculo padrão com fator de mercado
  const theoreticalMinutes = config.gapCandles * config.timeMinutes;
  const defaultGapMinutes = Math.round(theoreticalMinutes * MARKET_FACTOR);
  
  // Só usa gap adaptativo se for MAIOR que o padrão (para compensar dados antigos)
  if (overrideGapMinutes && overrideGapMinutes > defaultGapMinutes) {
    // Usar gap adaptativo do CSV anterior + margem de segurança
    realMinutes = overrideGapMinutes + SAFETY_MARGIN_MINUTES;
    console.log(`   🔧 Usando gap adaptativo: ${Math.round(overrideGapMinutes / 60 / 24)} dias + 3 dias margem`);
  } else {
    // Usar gap padrão
    realMinutes = defaultGapMinutes;
  }
  
  // Data ajustada = target - gap real
  const adjustedDate = new Date(targetDate);
  adjustedDate.setMinutes(adjustedDate.getMinutes() - realMinutes);
  
  return { adjustedDate, warnings, config, realMinutes };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Validação de arquivo
const MIN_FILE_SIZE = 400 * 1024; // 400 KB

async function getFileHash(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

async function validateFile(filePath: string, allowSmall = false): Promise<{ valid: boolean; reason?: string; size?: number }> {
  try {
    const stats = await stat(filePath);
    const sizeKB = Math.round(stats.size / 1024);
    
    // Aceitar arquivos menores se for potencialmente o último (allowSmall)
    if (stats.size < MIN_FILE_SIZE && !allowSmall) {
      return { valid: false, reason: `Arquivo pequeno: ${sizeKB}KB (mín: 400KB)`, size: sizeKB };
    }
    // Mesmo com allowSmall, rejeitar arquivos muito pequenos (< 10KB = provavelmente erro)
    if (stats.size < 10 * 1024) {
      return { valid: false, reason: `Arquivo muito pequeno: ${sizeKB}KB`, size: sizeKB };
    }
    return { valid: true, size: sizeKB };
  } catch {
    return { valid: false, reason: 'Arquivo não encontrado' };
  }
}

/**
 * Analisa um CSV e retorna o range de datas e dias cobertos
 * Usado para calcular o gap adaptativo
 */
async function analyzeCSVDateRange(filePath: string): Promise<{ 
  firstDate: Date | null; 
  lastDate: Date | null; 
  daysCovered: number;
  candleCount: number;
}> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    
    if (lines.length < 2) {
      return { firstDate: null, lastDate: null, daysCovered: 0, candleCount: 0 };
    }
    
    // Pular header, pegar primeira e última linha de dados
    const dataLines = lines.slice(1);
    const firstLine = dataLines[0];
    const lastLine = dataLines[dataLines.length - 1];
    
    // Formato: timestamp,datetime,open,high,low,close,volume
    // Usar timestamp Unix (coluna 0) que é mais confiável
    const firstTimestamp = parseInt(firstLine.split(',')[0]);
    const lastTimestamp = parseInt(lastLine.split(',')[0]);
    
    // Timestamps já estão em segundos, converter para Date
    const firstDate = new Date(firstTimestamp * 1000);
    const lastDate = new Date(lastTimestamp * 1000);
    
    // Calcular dias cobertos diretamente dos timestamps (em segundos)
    const diffSeconds = lastTimestamp - firstTimestamp;
    const daysCovered = Math.round(Math.abs(diffSeconds) / (60 * 60 * 24));
    
    return { 
      firstDate, 
      lastDate, 
      daysCovered,
      candleCount: dataLines.length
    };
  } catch (error) {
    console.warn(`⚠️ Erro ao analisar CSV: ${error}`);
    return { firstDate: null, lastDate: null, daysCovered: 0, candleCount: 0 };
  }
}

/**
 * Busca o ponto de retomada analisando CSVs existentes na pasta
 * Retorna a data mais antiga encontrada para continuar de onde parou
 */
async function findResumePoint(
  outputDir: string,
  symbol: string,
  timeframe: string
): Promise<{ resumeDate: string | null; lastGapMinutes: number; filesFound: number }> {
  try {
    if (!existsSync(outputDir)) {
      return { resumeDate: null, lastGapMinutes: 0, filesFound: 0 };
    }
    
    const files = await readdir(outputDir);
    
    // Filtrar CSVs do símbolo e timeframe corretos
    // Formato esperado: SYMBOL_TIMEFRAME_DATE.csv
    const safeSymbol = symbol.replace(/[:/]/g, '_');
    const pattern = new RegExp(`${safeSymbol}_${timeframe}_.*\\.csv$`);
    const csvFiles = files.filter(f => pattern.test(f));
    
    if (csvFiles.length === 0) {
      return { resumeDate: null, lastGapMinutes: 0, filesFound: 0 };
    }
    
    console.log(`\n🔍 Encontrados ${csvFiles.length} arquivos anteriores para análise de resume...`);
    
    // Analisar todos os CSVs e encontrar a data mais antiga
    let oldestDate: Date | null = null;
    let lastGapMinutes = 0;
    
    for (const file of csvFiles) {
      const filePath = join(outputDir, file);
      const analysis = await analyzeCSVDateRange(filePath);
      
      if (analysis.firstDate) {
        if (!oldestDate || analysis.firstDate < oldestDate) {
          oldestDate = analysis.firstDate;
          // Guardar o gap deste arquivo para usar como adaptativo
          if (analysis.daysCovered > 0) {
            lastGapMinutes = analysis.daysCovered * 24 * 60;
          }
        }
      }
    }
    
    if (oldestDate) {
      // Formatar data para o formato esperado: YYYY-MM-DD HH:mm
      const pad = (n: number) => n.toString().padStart(2, '0');
      const resumeDate = `${oldestDate.getFullYear()}-${pad(oldestDate.getMonth() + 1)}-${pad(oldestDate.getDate())} ${pad(oldestDate.getHours())}:${pad(oldestDate.getMinutes())}`;
      
      console.log(`   📅 Data mais antiga encontrada: ${resumeDate}`);
      console.log(`   🔧 Gap adaptativo do último arquivo: ${Math.round(lastGapMinutes / 60 / 24)} dias`);
      
      return { resumeDate, lastGapMinutes, filesFound: csvFiles.length };
    }
    
    return { resumeDate: null, lastGapMinutes: 0, filesFound: csvFiles.length };
  } catch (error) {
    console.warn(`⚠️ Erro ao buscar ponto de resume: ${error}`);
    return { resumeDate: null, lastGapMinutes: 0, filesFound: 0 };
  }
}

interface ScraperOptions {
  symbol: string;
  timeframe: string;
  outputDir: string;
  dates: string[];
  sessionId?: string;
  headless?: boolean;
}

class TradingViewScraper {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private options: ScraperOptions;
  private baseUrl = 'https://www.tradingview.com/chart?symbol=';
  private lastValidHash: string = '';
  private adaptiveGapMinutes: number = 0; // Gap adaptativo calculado do CSV anterior

  constructor(options: ScraperOptions) {
    this.options = options;
  }

  async init(): Promise<void> {
    console.log('🚀 Iniciando browser...');
    
    this.browser = await chromium.launch({
      headless: this.options.headless ?? false,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36'
    });

    if (this.options.sessionId) {
      await context.addCookies([{
        name: 'sessionid',
        value: this.options.sessionId,
        domain: '.tradingview.com',
        path: '/'
      }]);
      console.log('\n🔐 Cookie de sessão configurado');
    }

    this.page = await context.newPage();
    
    if (!existsSync(this.options.outputDir)) {
      await mkdir(this.options.outputDir, { recursive: true });
    }
  }

  async navigateToSymbol(): Promise<void> {
    if (!this.page) return;
    const url = `${this.baseUrl}${this.options.symbol}`;
    console.log(`\n📊 Navegando para ${this.options.symbol}...`);
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await sleep(4000);
  }

  async setTimeframe(): Promise<void> {
    if (!this.page) return;
    console.log(`\n⏱️  Configurando timeframe: ${this.options.timeframe}`);
    await this.page.keyboard.type(this.options.timeframe);
    await sleep(800);
    await this.page.keyboard.press('Enter');
    await sleep(1600);
  }

  /**
   * Faz zoom out máximo no gráfico para carregar mais dados históricos
   * Isso deve ser feito ANTES de ativar o replay
   */
  async scrollToMaximum(): Promise<void> {
    if (!this.page) return;
    
    console.log('\n🔍 Fazendo zoom out para carregar dados históricos...');
    
    // Clicar no gráfico para garantir foco
    try {
      await this.page.click('.chart-container', { timeout: 3000 });
    } catch {
      try {
        await this.page.click('canvas', { timeout: 2000 });
      } catch {}
    }
    await sleep(1000);
    
    const zoomIterations = 20;
    
    for (let i = 1; i <= zoomIterations; i++) {
      // Ctrl + ArrowDown faz zoom out no TradingView
      await this.page.keyboard.down('Control');
      await this.page.keyboard.press('ArrowDown');
      await this.page.keyboard.up('Control');
      await sleep(150);
      
      if (i % 5 === 0) {
        console.log(`   🔍 Zoom out ${i}/${zoomIterations}...`);
      }
    }
    
    // Aguardar carregamento final
    await sleep(3000);
    console.log('   ✅ Zoom out completo - gráfico deve mostrar mais dados');
  }

  async activateReplay(): Promise<void> {
    if (!this.page) return;
    
    console.log('\n▶️  Ativando modo Replay...');
    
    try {
      await this.page.click('#header-toolbar-replay', { timeout: 5000 });
      console.log('   ✅ Replay ativado');
    } catch (e) {
      console.log('   ⚠️ Botão replay não encontrado, tentando fallback...');
      try {
        // Fallback: procurar por texto
        await this.page.click('button:has-text("Replay")', { timeout: 3000 });
        console.log('   ✅ Replay ativado (fallback)');
      } catch {
        console.log('   ❌ Falha ao ativar replay');
      }
    }
    await sleep(4000);
  }

  async selectReplayDate(dateStr: string): Promise<boolean> {
    if (!this.page) return false;
    
    console.log('   📅 Abrindo modal de seleção de data...');
    await sleep(2400);
    
    let clicked = false;
    
    // PASSO 1: Primeiro tenta clicar direto no botão Select date
    try {
      const replayDateBtn = await this.page.waitForSelector('.selectDateBar__button-rEmcWy54', { timeout: 3000 });
      if (replayDateBtn) {
        await replayDateBtn.click();
        clicked = true;
        console.log('   ✅ Botão Select date clicado');
      }
    } catch (e) {
      // PASSO 2: Se não encontrar, clica no dropdown menu primeiro
      console.log('   ⚠️ Botão Select date não visível, abrindo dropdown...');
      try {
        await this.page.click('[data-qa-id="select-date-bar-mode-menu"]', { timeout: 3000 });
        await sleep(1000);
        console.log('   ✅ Dropdown aberto');
        
        // Agora tenta clicar no Select date
        try {
          await this.page.click('.selectDateBar__button-rEmcWy54', { timeout: 3000 });
          clicked = true;
          console.log('   ✅ Botão Select date clicado');
        } catch {
          try {
            await this.page.click('div[data-role="button"]:has-text("Select date")', { timeout: 3000 });
            clicked = true;
            console.log('   ✅ Botão Select date clicado (fallback)');
          } catch {
            console.log('   ❌ Select date não encontrado após abrir dropdown');
          }
        }
      } catch {
        console.log('   ❌ Dropdown menu não encontrado');
        return false;
      }
    }
    
    if (!clicked) {
      console.log('   ❌ Select date falhou - clique não executado');
      return false;
    }
    
    await sleep(1600);
    console.log('   📝 Modal aberto, procurando inputs...');

    // Parse: pode ser "YYYY-MM-DD" ou "YYYY-MM-DD HH:mm"
    const [datePart, timePart] = dateStr.split(' ');

    // Input de data
    const dateInput = await this.page.$('input[placeholder="YYYY-MM-DD"]');
    if (dateInput) {
      await dateInput.click({ clickCount: 3 });
      await sleep(400);
      await this.page.keyboard.type(datePart);
    } else {
      console.log('   ❌ Input de data não encontrado');
      return false;
    }

    // Input de hora (se existir)
    if (timePart) {
      await sleep(300);
      const timeInput = await this.page.$('input[data-qa-id*="time-input-input"]');
      if (timeInput) {
        await timeInput.click({ clickCount: 3 });
        await sleep(240);
        await this.page.keyboard.type(timePart);
      }
    }

    // Clicar no botão "Select" para confirmar
    await sleep(500);
    try {
      await this.page.click('[data-name="submit-button"]', { timeout: 3000 });
    } catch {
      await this.page.keyboard.press('Enter');
    }
    await sleep(4000);
    return true;
  }

  async goToDate(dateStr: string): Promise<boolean> {
    if (!this.page) return false;
    
    try {
      const goToBtn = await this.page.waitForSelector('[data-name="go-to-date"]', { timeout: 5000 });
      if (goToBtn) await goToBtn.click();
    } catch (e) {
      try {
        await this.page.keyboard.press('Alt+g');
      } catch {
        console.log('   ❌ Go to date falhou');
        return false;
      }
    }
    await sleep(1200);

    // Parse: pode ser "YYYY-MM-DD", "YYYY-MM-DD HH:mm" ou "YYYY-MM-DDTHH:mm"
    const parts = dateStr.includes('T') ? dateStr.split('T') : dateStr.split(' ');
    const [datePart, timePart] = parts;
    
    // Input de data
    const dateInput = await this.page.$('input[placeholder="YYYY-MM-DD"]');
    if (dateInput) {
      await dateInput.click({ clickCount: 3 });
      await sleep(240);
      await this.page.keyboard.type(datePart);
    } else {
      console.log('   ❌ Input Go to date não encontrado');
      return false;
    }

    // Se tiver hora, procura input de hora
    if (timePart) {
      await sleep(300);
      // Seletor do input de hora do TradingView
      const timeInput = await this.page.$('input[data-qa-id*="time-input-input"]');
      if (timeInput) {
        await timeInput.click({ clickCount: 3 });
        await sleep(240);
        await this.page.keyboard.type(timePart);
      }
    }

    // Clicar no botão "Go to" para confirmar
    await sleep(500);
    try {
      await this.page.click('[data-name="submit-button"]', { timeout: 3000 });
    } catch {
      await this.page.keyboard.press('Enter');
    }
    await sleep(2400);
    return true;
  }

  async exportCSV(dateStr: string): Promise<string | null> {
    if (!this.page) return null;
    
    const maxRetries = 3;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        if (attempt > 1) console.log(`   ⚠️ Retry ${attempt}/${maxRetries}...`);

        await this.page.click('[data-name="save-load-menu"]', { timeout: 5000 });
        await sleep(800);
        
        const downloadPromise = this.page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
        
        try {
          await this.page.click('[data-role="menuitem"]:has-text("Download chart data")', { timeout: 2000 });
        } catch {
          await this.page.click('text="Download chart data"', { timeout: 2000 });
        }
        
        const earlyDownload = await Promise.race([
          downloadPromise,
          sleep(1600).then(() => null)
        ]);
        
        if (earlyDownload) {
          const safeSymbol = this.options.symbol.replace(/[:/]/g, '_');
          const filename = `${safeSymbol}_${this.options.timeframe}_${dateStr}.csv`;
          const savePath = join(this.options.outputDir, filename);
          await earlyDownload.saveAs(savePath);
          console.log(`   ✅ CSV salvo: ${filename}`);
          return savePath;
        }

        const [download] = await Promise.all([
          downloadPromise,
          this.page.click('[data-qa-id="download-btn"]', { force: true, timeout: 5000 })
        ]);

        if (download) {
          const safeSymbol = this.options.symbol.replace(/[:/]/g, '_');
          const filename = `${safeSymbol}_${this.options.timeframe}_${dateStr}.csv`;
          const savePath = join(this.options.outputDir, filename);
          await download.saveAs(savePath);
          console.log(`   ✅ CSV salvo: ${filename}`);
          return savePath;
        }
        
      } catch (error) {
        console.log(`   ❌ Erro export: ${error}`);
        await this.page.keyboard.press('Escape');
        await sleep(1600);
      }
    }
    return null;
  }

  async deactivateReplay(): Promise<void> {
    if (!this.page) return;
    try {
      await this.page.click('[data-name="exit-replay"]', { timeout: 2000 });
    } catch {}
    await sleep(800);
  }

  async scrape(): Promise<void> {
    await this.init();
    await this.navigateToSymbol();
    await this.setTimeframe();
    
    // === SISTEMA DE RESUME AUTOMÁTICO ===
    // Verifica se existem arquivos anteriores e retoma de onde parou
    const resumeInfo = await findResumePoint(
      this.options.outputDir,
      this.options.symbol,
      this.options.timeframe
    );
    
    if (resumeInfo.resumeDate) {
      console.log(`\n🔄 MODO RESUME ATIVADO!`);
      console.log(`   Continuando de: ${resumeInfo.resumeDate}`);
      console.log(`   Arquivos encontrados: ${resumeInfo.filesFound}`);
      
      // Usar a data de resume e o gap adaptativo
      this.options.dates = [resumeInfo.resumeDate];
      if (resumeInfo.lastGapMinutes > 0) {
        this.adaptiveGapMinutes = resumeInfo.lastGapMinutes;
      }
    }
    
    for (const initialDate of this.options.dates) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`=== INICIANDO CICLO PRINCIPAL em ${initialDate.replace('T', ' ')} ===`);
      console.log(`${'='.repeat(60)}`);
      
      // Normalizar formato: T -> espaço
      let replayDate = initialDate.replace('T', ' ');
      const minYear = 2000;
      let iteration = 0;

      // PASSO 1: Scroll para carregar dados históricos ANTES do replay
      await this.scrollToMaximum();
      
      // PASSO 2: Ativar replay mode
      await this.activateReplay();
      
      while (true) {
        iteration++;
        
        // Parse da data do replay
        const replayDateObj = new Date(replayDate.replace(' ', 'T'));
        
        // Calcular data ajustada com gap adaptativo se disponível
        const { adjustedDate, warnings, config, realMinutes } = calculateAdjustedDate(
          replayDateObj,
          this.options.timeframe,
          this.adaptiveGapMinutes // Passa gap adaptativo (0 na primeira iteração)
        );
        
        // Formatar goToDate
        const goToDate = formatDate(adjustedDate);
        const totalGapDays = Math.round(realMinutes / 60 / 24);
        
        // Logging detalhado
        console.log('\n📊 ═══════════════════════════════════════════════════════');
        console.log(`⚙️  Timeframe: ${this.options.timeframe}m (${config.timeMinutes} min/candle)`);
        console.log(`🎯 Target: ${replayDate}`);
        console.log(`📏 Gap: ${totalGapDays} dias${this.adaptiveGapMinutes > 0 ? ' (ADAPTATIVO)' : ' (padrão)'}`);
        console.log(`🔄 [${iteration}] ${replayDate} → ${goToDate}`);
        
        if (warnings.length > 0) {
          warnings.forEach(w => console.log(w));
        }
        console.log('═══════════════════════════════════════════════════════\n');

        // Verifica limite de ano ANTES de processar
        if (parseInt(replayDate.split('-')[0]) < minYear) {
          console.log(`   🛑 Limite ${minYear} atingido.`);
          break;
        }

        let replaySuccess = await this.selectReplayDate(replayDate);
        
        if (!replaySuccess) {
          console.log('   ⚠️ Recuperando replay...');
          await sleep(1600);
          await this.deactivateReplay();
          await sleep(1600);
          await this.activateReplay();
          await sleep(1600);
          replaySuccess = await this.selectReplayDate(replayDate);
          
          if (!replaySuccess) {
            console.log('   ❌ Falha crítica. Abortando.');
            break;
          }
        }
        await sleep(1600);

        await this.goToDate(goToDate);
        await sleep(4000);
        
        // Export com validação e retry
        const maxValidationRetries = 3;
        let validExport = false;
        let exportedPath: string | null = null;
        
        for (let validationAttempt = 1; validationAttempt <= maxValidationRetries; validationAttempt++) {
          exportedPath = await this.exportCSV(replayDate);
          
          if (!exportedPath) {
            console.log(`   ❌ Falha no export (tentativa ${validationAttempt})`);
            continue;
          }
          
          // Validação de tamanho (allowSmall se perto do limite de ano)
          const yearOfGoTo = parseInt(goToDate.split('-')[0]);
          const isNearLimit = yearOfGoTo <= 2003; // Próximo do limite 2000
          const validation = await validateFile(exportedPath, isNearLimit);
          if (!validation.valid) {
            console.log(`   ⚠️ ${validation.reason} (tentativa ${validationAttempt})`);
            continue;
          }
          
          // Detecção de duplicata
          const currentHash = await getFileHash(exportedPath);
          if (this.lastValidHash && currentHash === this.lastValidHash) {
            console.log(`   ⚠️ Arquivo duplicado detectado (tentativa ${validationAttempt})`);
            continue;
          }
          
          // Arquivo válido
          this.lastValidHash = currentHash;
          validExport = true;
          break;
        }
        
        if (!validExport || !exportedPath) {
          console.log('   ❌ Falha após 3 tentativas. Abortando.');
          break;
        }
        console.log(`   ✅ ${exportedPath}`);

        // === SISTEMA ADAPTATIVO ===
        // Analisar CSV e atualizar gap para próxima iteração
        const csvAnalysis = await analyzeCSVDateRange(exportedPath);
        if (csvAnalysis.daysCovered > 0) {
          // Converter dias cobertos para minutos
          this.adaptiveGapMinutes = csvAnalysis.daysCovered * 24 * 60;
          console.log(`   🔧 Gap adaptativo atualizado: ${csvAnalysis.daysCovered} dias (${csvAnalysis.candleCount} candles)`);
        }

        // Verifica se próxima data seria antes do limite
        if (parseInt(goToDate.split('-')[0]) < minYear) {
          console.log(`   🛑 Limite ${minYear} atingido.`);
          break;
        }

        replayDate = goToDate;
        await sleep(800);
      }

      await this.deactivateReplay();
    }

    console.log(`\n${'═'.repeat(63)}`);
    console.log('║                 PROCESSO FINALIZADO!                          ║');
    console.log(`${'═'.repeat(63)}`);
    console.log(`👉 Para converter os dados para JSON, execute:`);
    console.log(`   npm run convert -- "${this.options.outputDir}"`);
    
    await this.browser?.close();
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  
  let symbol = '', timeframe = '60', outputDir = './data/raw', sessionId = '', headless = false;
  const dates: string[] = [];

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '-s': case '--symbol': symbol = args[++i]; break;
      case '-t': case '--timeframe': timeframe = args[++i]; break;
      case '-d': case '--date': dates.push(args[++i]); break;
      case '-o': case '--output': outputDir = args[++i]; break;
      case '--session': sessionId = args[++i]; break;
      case '--headless': headless = true; break;
    }
  }

  if (!symbol) {
    console.log('Uso: tsx playwright-scraper.ts -s SYMBOL -t TIMEFRAME -d DATE --session ID');
    process.exit(1);
  }

  if (dates.length === 0) {
    dates.push(new Date().toISOString().split('T')[0]);
  }

  const scraper = new TradingViewScraper({
    symbol,
    timeframe,
    outputDir,
    dates,
    sessionId,
    headless
  });

  await scraper.scrape();
}

main().catch(console.error);
