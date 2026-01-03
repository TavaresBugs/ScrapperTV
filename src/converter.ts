#!/usr/bin/env node
/**
 * Conversor de CSV para JSON
 * 
 * Estrutura de saída:
 * data/SYMBOL/
 * ├── Mensal.json       # Arquivo único
 * ├── Semanal.json      # Arquivo único
 * ├── Diario.json       # Arquivo único
 * ├── 4H/               # Por ano
 * │   ├── index.json
 * │   └── 2024.json
 * ├── 1H/               # Por ano
 * │   ├── index.json
 * │   └── 2024.json
 * ├── 15M/              # Por mês
 * │   ├── index.json
 * │   └── 2024/01.json
 * ├── 5M/               # Por mês
 * ├── 3M/               # Por mês
 * └── 1M/               # Por mês
 */
import { readFile, writeFile, mkdir, readdir, rm } from 'fs/promises';
import { join, basename, dirname } from 'path';
import { existsSync } from 'fs';
import type { Candle } from './types.js';

interface ChunkIndex {
  symbol: string;
  timeframe: string;
  updatedAt: string;
  totalCandles: number;
  firstCandle: string;
  lastCandle: string;
  chunks: ChunkInfo[];
}

interface ChunkInfo {
  file: string;
  startDate: string;
  endDate: string;
  startTimestamp: number;
  endTimestamp: number;
  count: number;
}

interface SingleFileData {
  symbol: string;
  timeframe: string;
  updatedAt: string;
  totalCandles: number;
  firstCandle: string;
  lastCandle: string;
  candles: Candle[];
}

// Estratégia de chunking por timeframe normalizado
type ChunkStrategy = 'single' | 'year' | 'month';

const CHUNK_STRATEGY: Record<string, ChunkStrategy> = {
  // Arquivos únicos (HTF)
  'Mensal': 'single',
  'Semanal': 'single',
  'Diario': 'single',
  
  // Por ano (MTF)
  '4H': 'year',
  '1H': 'year',
  '30M': 'year',
  '15M': 'year',
  
  // Por mês (LTF - muitos candles)
  '5M': 'month',
  '3M': 'month',
  '1M': 'month',
};

// Mapa de aliases para normalizar nomes de timeframes
const TIMEFRAME_ALIASES: Record<string, string> = {
  // HTF
  'M': 'Mensal',
  '1M': 'Mensal', // Cuidado: 1M também pode ser 1 minuto
  'Mensal': 'Mensal',
  'W': 'Semanal',
  '1W': 'Semanal',
  'Semanal': 'Semanal',
  'D': 'Diario',
  '1D': 'Diario',
  'Diario': 'Diario',
  
  // MTF
  '240': '4H',
  '4H': '4H',
  '60': '1H',
  '1H': '1H',
  '30': '30M',
  '30min': '30M',
  '30M': '30M',
  '15': '15M',
  '15min': '15M',
  '15M': '15M',
  
  // LTF
  '5': '5M',
  '5min': '5M',
  '5M': '5M',
  '3': '3M',
  '3min': '3M',
  '3M': '3M',
  '1': '1min', // 1 minuto, não mensal
  '1min': '1min',
};

/**
 * Detecta timeframe a partir do nome do arquivo
 */
function detectTimeframe(filename: string): string | null {
  // Prioridade: timeframes mais específicos primeiro
  const patterns: [RegExp, string][] = [
    // HTF - nomes em português
    [/Mensal/i, 'Mensal'],
    [/Semanal/i, 'Semanal'],
    [/Diario/i, 'Diario'],
    
    // MTF - formato _TF_ ou _TF.csv
    [/_4H[_.]/, '4H'],
    [/_1H[_.]/, '1H'],
    [/_30M?[_.]/, '30M'],
    [/_15M?[_.]/, '15M'],
    
    // LTF
    [/_5M?[_.]/, '5M'],
    [/_3M?[_.]/, '3M'],
    [/_1[_.]/, '1min'], // 1 minuto
    
    // Fallback: número no nome (ex: CME_..._1_2023-05-16 = 1 minuto)
    [/_(\d+)_\d{4}-/, null], // Captura grupo
  ];
  
  for (const [pattern, tf] of patterns) {
    if (pattern.test(filename)) {
      if (tf === null) {
        // Extrair número do padrão
        const match = filename.match(/_(\d+)_\d{4}-/);
        if (match) {
          const num = match[1];
          if (num === '1') return '1min';
          if (num === '3') return '3M';
          if (num === '5') return '5M';
          if (num === '15') return '15M';
          if (num === '30') return '30M';
          if (num === '60') return '1H';
          if (num === '240') return '4H';
        }
      }
      return tf;
    }
  }
  
  return null;
}

/**
 * Normaliza o nome do timeframe
 */
function normalizeTimeframe(tf: string): string {
  return TIMEFRAME_ALIASES[tf] || tf;
}

/**
 * Parse CSV para array de Candles
 */
function parseCSV(content: string): Candle[] {
  const lines = content.trim().split('\n');
  const header = lines[0].toLowerCase();
  
  const cols = header.split(',');
  const timeIndex = cols.findIndex(c => c.includes('time'));
  const openIndex = cols.findIndex(c => c.includes('open'));
  const highIndex = cols.findIndex(c => c.includes('high'));
  const lowIndex = cols.findIndex(c => c.includes('low'));
  const closeIndex = cols.findIndex(c => c.includes('close'));
  const volumeIndex = cols.findIndex(c => c.includes('vol'));

  if (timeIndex === -1 || openIndex === -1) {
    console.error('❌ CSV inválido: Colunas obrigatórias não encontradas');
    return [];
  }

  const formatDate = (date: Date) => {
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  };

  return lines.slice(1).map(line => {
    const parts = line.split(',');
    const timeRaw = parts[timeIndex];
    
    let timestamp: number;
    let datetime: string;
    
    const isIsoString = timeRaw.includes('T') || timeRaw.includes('-');
    
    if (isIsoString) {
      const d = new Date(timeRaw);
      datetime = formatDate(d);
      timestamp = Math.floor(d.getTime() / 1000);
    } else {
      timestamp = parseInt(timeRaw);
      const ms = timestamp > 9999999999 ? timestamp : timestamp * 1000;
      const d = new Date(ms);
      datetime = formatDate(d);
      if (timestamp > 9999999999) timestamp = Math.floor(timestamp / 1000);
    }

    return {
      timestamp,
      datetime,
      open: parseFloat(parts[openIndex]),
      high: parseFloat(parts[highIndex]),
      low: parseFloat(parts[lowIndex]),
      close: parseFloat(parts[closeIndex]),
      volume: volumeIndex !== -1 ? (parseFloat(parts[volumeIndex]) || 0) : 0,
    };
  }).filter(c => !isNaN(c.timestamp));
}

/**
 * Formata timestamp para data ISO
 */
function formatDateISO(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().split('T')[0];
}

/**
 * Agrupa candles por ano
 */
function groupByYear(candles: Candle[]): Map<string, Candle[]> {
  const groups = new Map<string, Candle[]>();
  for (const candle of candles) {
    const year = new Date(candle.timestamp * 1000).getFullYear().toString();
    if (!groups.has(year)) groups.set(year, []);
    groups.get(year)!.push(candle);
  }
  return groups;
}

/**
 * Agrupa candles por mês (ano/mês)
 */
function groupByMonth(candles: Candle[]): Map<string, Candle[]> {
  const groups = new Map<string, Candle[]>();
  for (const candle of candles) {
    const date = new Date(candle.timestamp * 1000);
    const year = date.getFullYear().toString();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const key = `${year}/${month}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(candle);
  }
  return groups;
}

/**
 * Salva arquivo único em pasta (para Mensal, Semanal, Diario)
 * Estrutura: TF/index.json + TF/all.json
 */
async function saveSingleFile(
  candles: Candle[],
  symbol: string,
  timeframe: string,
  outputDir: string
): Promise<void> {
  const tfDir = join(outputDir, timeframe);
  await mkdir(tfDir, { recursive: true });
  
  // Salvar all.json (só candles)
  await writeFile(join(tfDir, 'all.json'), JSON.stringify(candles, null, 2));
  
  // Salvar index.json (metadados)
  const index: ChunkIndex = {
    symbol,
    timeframe,
    updatedAt: new Date().toISOString(),
    totalCandles: candles.length,
    firstCandle: formatDateISO(candles[0].timestamp),
    lastCandle: formatDateISO(candles[candles.length - 1].timestamp),
    chunks: [{
      file: 'all.json',
      startDate: formatDateISO(candles[0].timestamp),
      endDate: formatDateISO(candles[candles.length - 1].timestamp),
      startTimestamp: candles[0].timestamp,
      endTimestamp: candles[candles.length - 1].timestamp,
      count: candles.length,
    }],
  };
  
  await writeFile(join(tfDir, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`  ✅ ${timeframe}/: ${candles.length} candles`);
}

/**
 * Salva arquivos por ano (para 4H, 1H, 30M, 15M)
 */
async function saveByYear(
  candles: Candle[],
  symbol: string,
  timeframe: string,
  outputDir: string
): Promise<void> {
  const tfDir = join(outputDir, timeframe);
  await mkdir(tfDir, { recursive: true });
  
  const groups = groupByYear(candles);
  const chunkInfos: ChunkInfo[] = [];
  
  for (const [year, yearCandles] of groups) {
    const filename = `${year}.json`;
    await writeFile(join(tfDir, filename), JSON.stringify(yearCandles, null, 2));
    
    chunkInfos.push({
      file: filename,
      startDate: formatDateISO(yearCandles[0].timestamp),
      endDate: formatDateISO(yearCandles[yearCandles.length - 1].timestamp),
      startTimestamp: yearCandles[0].timestamp,
      endTimestamp: yearCandles[yearCandles.length - 1].timestamp,
      count: yearCandles.length,
    });
    
    console.log(`    📁 ${filename}: ${yearCandles.length} candles`);
  }
  
  // Ordenar e salvar índice
  chunkInfos.sort((a, b) => a.startTimestamp - b.startTimestamp);
  
  const index: ChunkIndex = {
    symbol,
    timeframe,
    updatedAt: new Date().toISOString(),
    totalCandles: candles.length,
    firstCandle: formatDateISO(candles[0].timestamp),
    lastCandle: formatDateISO(candles[candles.length - 1].timestamp),
    chunks: chunkInfos,
  };
  
  await writeFile(join(tfDir, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`  ✅ ${timeframe}/: ${groups.size} anos, ${candles.length} candles total`);
}

/**
 * Salva arquivos por mês (para 5M, 3M, 1M)
 */
async function saveByMonth(
  candles: Candle[],
  symbol: string,
  timeframe: string,
  outputDir: string
): Promise<void> {
  const tfDir = join(outputDir, timeframe);
  await mkdir(tfDir, { recursive: true });
  
  const groups = groupByMonth(candles);
  const chunkInfos: ChunkInfo[] = [];
  
  for (const [yearMonth, monthCandles] of groups) {
    const [year, month] = yearMonth.split('/');
    const yearDir = join(tfDir, year);
    await mkdir(yearDir, { recursive: true });
    
    const filename = `${year}/${month}.json`;
    await writeFile(join(yearDir, `${month}.json`), JSON.stringify(monthCandles, null, 2));
    
    chunkInfos.push({
      file: filename,
      startDate: formatDateISO(monthCandles[0].timestamp),
      endDate: formatDateISO(monthCandles[monthCandles.length - 1].timestamp),
      startTimestamp: monthCandles[0].timestamp,
      endTimestamp: monthCandles[monthCandles.length - 1].timestamp,
      count: monthCandles.length,
    });
  }
  
  // Ordenar e salvar índice
  chunkInfos.sort((a, b) => a.startTimestamp - b.startTimestamp);
  
  const index: ChunkIndex = {
    symbol,
    timeframe,
    updatedAt: new Date().toISOString(),
    totalCandles: candles.length,
    firstCandle: formatDateISO(candles[0].timestamp),
    lastCandle: formatDateISO(candles[candles.length - 1].timestamp),
    chunks: chunkInfos,
  };
  
  await writeFile(join(tfDir, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`  ✅ ${timeframe}/: ${groups.size} meses, ${candles.length} candles total`);
}

/**
 * Converte um arquivo CSV
 */
async function convertCSV(csvPath: string, outputDir: string): Promise<void> {
  const filename = basename(csvPath, '.csv');
  const timeframe = detectTimeframe(filename);
  
  if (!timeframe) {
    console.log(`  ⚠️ Timeframe não detectado: ${filename}`);
    return;
  }
  
  const normalizedTf = normalizeTimeframe(timeframe);
  const strategy = CHUNK_STRATEGY[normalizedTf] || 'month';
  
  console.log(`  📄 ${filename} → ${normalizedTf} (${strategy})`);
  
  const content = await readFile(csvPath, 'utf-8');
  const candles = parseCSV(content);
  
  if (candles.length === 0) {
    console.log(`    ⚠️ Nenhum candle encontrado`);
    return;
  }
  
  candles.sort((a, b) => a.timestamp - b.timestamp);
  
  const symbol = basename(dirname(csvPath));
  
  switch (strategy) {
    case 'single':
      await saveSingleFile(candles, symbol, normalizedTf, outputDir);
      break;
    case 'year':
      await saveByYear(candles, symbol, normalizedTf, outputDir);
      break;
    case 'month':
      await saveByMonth(candles, symbol, normalizedTf, outputDir);
      break;
  }
}

/**
 * Processa todos os CSVs de um diretório de símbolo
 */
async function processSymbolDir(symbolDir: string): Promise<void> {
  const symbol = basename(symbolDir);
  console.log(`\n📊 Processando ${symbol}...`);
  
  // Listar todos os CSVs
  const entries = await readdir(symbolDir, { withFileTypes: true });
  const csvFiles = entries.filter(e => e.isFile() && e.name.endsWith('.csv'));
  
  if (csvFiles.length === 0) {
    console.log('  ⚠️ Nenhum CSV encontrado');
    return;
  }
  
  // Agrupar CSVs por timeframe detectado
  const byTimeframe = new Map<string, string[]>();
  
  for (const csv of csvFiles) {
    const tf = detectTimeframe(csv.name);
    if (!tf) continue;
    
    const normalizedTf = normalizeTimeframe(tf);
    if (!byTimeframe.has(normalizedTf)) byTimeframe.set(normalizedTf, []);
    byTimeframe.get(normalizedTf)!.push(join(symbolDir, csv.name));
  }
  
  // Processar cada timeframe (mesclando múltiplos CSVs do mesmo TF)
  for (const [tf, files] of byTimeframe) {
    console.log(`\n  🕐 ${tf}: ${files.length} arquivo(s)`);
    
    // Ler e mesclar todos os candles
    let allCandles: Candle[] = [];
    
    for (const file of files) {
      const content = await readFile(file, 'utf-8');
      const candles = parseCSV(content);
      allCandles = allCandles.concat(candles);
    }
    
    if (allCandles.length === 0) continue;
    
    // Remover duplicatas (por timestamp)
    const uniqueMap = new Map<number, Candle>();
    for (const c of allCandles) {
      uniqueMap.set(c.timestamp, c);
    }
    allCandles = Array.from(uniqueMap.values());
    
    // Ordenar
    allCandles.sort((a, b) => a.timestamp - b.timestamp);
    
    console.log(`    📈 ${allCandles.length} candles únicos (${formatDateISO(allCandles[0].timestamp)} → ${formatDateISO(allCandles[allCandles.length - 1].timestamp)})`);
    
    // Salvar conforme estratégia
    const strategy = CHUNK_STRATEGY[tf] || 'month';
    
    switch (strategy) {
      case 'single':
        await saveSingleFile(allCandles, symbol, tf, symbolDir);
        break;
      case 'year':
        await saveByYear(allCandles, symbol, tf, symbolDir);
        break;
      case 'month':
        await saveByMonth(allCandles, symbol, tf, symbolDir);
        break;
    }
  }
}

/**
 * Limpa estrutura antiga (pastas de TF fragmentadas)
 */
async function cleanOldStructure(symbolDir: string): Promise<void> {
  const entries = await readdir(symbolDir, { withFileTypes: true });
  
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const dirPath = join(symbolDir, entry.name);
      
      // Remover pastas antigas de TF que agora são arquivos únicos
      if (['Mensal', 'Semanal', 'Diario'].includes(entry.name)) {
        console.log(`  🗑️ Removendo pasta antiga: ${entry.name}/`);
        await rm(dirPath, { recursive: true, force: true });
      }
    }
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║              CSV → JSON Converter v2.0                        ║
╚═══════════════════════════════════════════════════════════════╝

USAGE:
  npm run convert -- <caminho>

EXEMPLOS:
  # Converter todos os CSVs de um símbolo
  npm run convert -- ./data/raw/CME_MINI_DL_NQ1

  # Converter todos os símbolos em data/raw
  npm run convert -- ./data/raw

ESTRUTURA DE SAÍDA:
  data/SYMBOL/
  ├── Mensal.json       # Arquivo único
  ├── Semanal.json      # Arquivo único  
  ├── Diario.json       # Arquivo único
  ├── 4H/               # Por ano
  │   ├── index.json
  │   └── 2024.json
  ├── 1H/               # Por ano
  ├── 15M/              # Por mês
  │   ├── index.json
  │   └── 2024/01.json
  ├── 5M/               # Por mês
  ├── 3M/               # Por mês
  └── 1M/               # Por mês
`);
    return;
  }
  
  const path = args[0];
  
  if (!existsSync(path)) {
    console.error(`❌ Caminho não encontrado: ${path}`);
    process.exit(1);
  }
  
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║              CSV → JSON Converter v2.0                        ║
╚═══════════════════════════════════════════════════════════════╝
`);
  
  // Verificar se é diretório de símbolo ou diretório pai
  const entries = await readdir(path, { withFileTypes: true });
  const hasCsvFiles = entries.some(e => e.isFile() && e.name.endsWith('.csv'));
  
  if (hasCsvFiles) {
    // É um diretório de símbolo
    await cleanOldStructure(path);
    await processSymbolDir(path);
  } else {
    // É diretório pai - processar cada subdiretório
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const symbolDir = join(path, entry.name);
        const subEntries = await readdir(symbolDir, { withFileTypes: true });
        const subHasCsv = subEntries.some(e => e.isFile() && e.name.endsWith('.csv'));
        
        if (subHasCsv) {
          await cleanOldStructure(symbolDir);
          await processSymbolDir(symbolDir);
        }
      }
    }
  }
  
  console.log('\n🎉 Conversão completa!\n');
}

main().catch(console.error);
