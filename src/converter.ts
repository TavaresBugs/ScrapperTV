#!/usr/bin/env node
/**
 * Conversor de CSV para JSON chunked
 * 
 * Lê arquivos CSV raw e converte para estrutura
 * otimizada para o sistema de replay
 */
import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
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

// Configuração de chunking por timeframe
const CHUNK_CONFIG: Record<string, { by: 'year' | 'month' | 'week' | 'single'; maxCandles: number }> = {
  // Arquivos Únicos
  '1M': { by: 'single', maxCandles: Infinity },
  '1W': { by: 'single', maxCandles: Infinity },
  '1D': { by: 'single', maxCandles: Infinity },
  
  // Por ANO (Mid/Low timeframe 15min - 4H)
  '4H': { by: 'year', maxCandles: Infinity },
  '240': { by: 'year', maxCandles: Infinity },
  '1H': { by: 'year', maxCandles: Infinity },
  '60': { by: 'year', maxCandles: Infinity },
  '30min': { by: 'year', maxCandles: Infinity },
  '30': { by: 'year', maxCandles: Infinity },
  '15min': { by: 'year', maxCandles: Infinity }, 
  '15': { by: 'year', maxCandles: Infinity },

  // Por MÊS (High timeframe <= 5min)
  '5min': { by: 'month', maxCandles: Infinity },
  '5': { by: 'month', maxCandles: Infinity },
  '3min': { by: 'month', maxCandles: Infinity },
  '3': { by: 'month', maxCandles: Infinity }, 
  '1min': { by: 'month', maxCandles: Infinity },
  '1': { by: 'month', maxCandles: Infinity },
};

// Mapa de aliases para normalizar nomes de timeframes
// Nomenclatura: Mensal, Semanal, Diario, 4H, 1H, 15M, 5M, 3M, 1M
const TIMEFRAME_ALIASES: Record<string, string> = {
  // Timeframes maiores
  '1M': 'Mensal',
  'M': 'Mensal',
  'Mensal': 'Mensal',
  '1W': 'Semanal',
  'W': 'Semanal',
  'Semanal': 'Semanal',
  '1D': 'Diario',
  'D': 'Diario',
  'Diario': 'Diario',
  // Timeframes intraday
  '240': '4H',
  '4H': '4H',
  '60': '1H',
  '1H': '1H',
  '30': '30M',
  '30min': '30M',
  '15': '15M',
  '15min': '15M',
  '5': '5M',
  '5min': '5M',
  '3': '3M',
  '3min': '3M',
  '1': '1M',
  '1min': '1M',
};

/**
 * Normaliza o nome do timeframe para um formato canônico
 * Ex: 60 -> 1H, 240 -> 4H
 */
function normalizeTimeframe(tf: string): string {
  return TIMEFRAME_ALIASES[tf] || tf;
}

/**
 * Parse CSV para array de Candles
 * Suporta formatos:
 * 1. Timestamp UNIX (1483398000)
 * 2. ISO String (2025-12-08T13:00...)
 * 3. Híbrido (Timestamp + Datetime)
 */
function parseCSV(content: string): Candle[] {
  const lines = content.trim().split('\n');
  const header = lines[0].toLowerCase();
  
  // Detectar colunas
  const cols = header.split(',');
  const timeIndex = cols.findIndex(c => c.includes('time')); // 'time' ou 'timestamp'
  const openIndex = cols.findIndex(c => c.includes('open'));
  const highIndex = cols.findIndex(c => c.includes('high'));
  const lowIndex = cols.findIndex(c => c.includes('low'));
  const closeIndex = cols.findIndex(c => c.includes('close'));
  const volumeIndex = cols.findIndex(c => c.includes('vol')); // 'volume'
  
  // Opcional: datetime explicito
  const datetimeIndex = cols.findIndex(c => c === 'datetime');

  if (timeIndex === -1 || openIndex === -1) {
      console.error('❌ CSV inválido: Colunas obrigatórias não encontradas');
      return [];
  }

  return lines.slice(1).map(line => {
    const parts = line.split(',');
    
    // 1. Resolver Timestamp e Datetime
    let timestamp: number;
    let datetime: string;

    const timeRaw = parts[timeIndex];
    
    // Verifica se col 0 é ISO (contém 'T' ou '-') ou Numérico
    const isIsoString = timeRaw.includes('T') || timeRaw.includes('-');
    
    // Helper para formatar date (YYYY-MM-DD HH:mm:ss)
    const formatCustomDate = (date: Date) => {
        const pad = (n: number) => n.toString().padStart(2, '0');
        return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
    };

    if (isIsoString) {
        // Caso: time="2025-12-08T..." ou "2025-12-08 13:00..."
        const d = new Date(timeRaw);
        datetime = formatCustomDate(d);
        timestamp = Math.floor(d.getTime() / 1000);
    } else {
        // Caso: time="148393..."
        timestamp = parseInt(timeRaw);
        
        // Se timestamp for ms (13 digitos), normalizar para s (10 digitos) no objeto final
        // mas usar ms para criar o Date
        const ms = timestamp > 9999999999 ? timestamp : timestamp * 1000;
        const d = new Date(ms);
        
        if (datetimeIndex !== -1 && parts[datetimeIndex]) {
            // Se já vier no CSV, tenta usar, mas recomendo padronizar também
            // Para garantir o formato pedido, vamos ignorar o do CSV e gerar novo
            // ou formatar o que veio se for parseável. Vamos gerar do timestamp q é seguro.
            datetime = formatCustomDate(d);
        } else {
            datetime = formatCustomDate(d);
        }
        
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
 * Formata timestamp para data
 */
function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().split('T')[0];
}

/**
 * Obtém chave de chunk baseado no timeframe
 */
function getChunkKey(timestamp: number, chunkBy: 'year' | 'month' | 'week' | 'single'): string {
  const date = new Date(timestamp * 1000);
  
  switch (chunkBy) {
    case 'single':
      return 'all';
    case 'year':
      return date.getFullYear().toString();
    case 'month':
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    case 'week':
      const startOfYear = new Date(date.getFullYear(), 0, 1);
      const days = Math.floor((date.getTime() - startOfYear.getTime()) / (24 * 60 * 60 * 1000));
      const week = Math.ceil((days + startOfYear.getDay() + 1) / 7);
      return `${date.getFullYear()}-W${String(week).padStart(2, '0')}`;
  }
}

/**
 * Agrupa candles em chunks
 */
function groupIntoChunks(
  candles: Candle[],
  chunkBy: 'year' | 'month' | 'week' | 'single'
): Map<string, Candle[]> {
  const chunks = new Map<string, Candle[]>();
  
  for (const candle of candles) {
    const key = getChunkKey(candle.timestamp, chunkBy);
    if (!chunks.has(key)) {
      chunks.set(key, []);
    }
    chunks.get(key)!.push(candle);
  }
  
  return chunks;
}

/**
 * Converte CSV para JSON chunked
 */
async function convertCSV(csvPath: string, outputDir?: string): Promise<void> {
  console.log(`\n📄 Processando: ${csvPath}`);
  
  // Ler CSV
  const content = await readFile(csvPath, 'utf-8');
  const candles = parseCSV(content);
  
  if (candles.length === 0) {
    console.log('⚠️ Nenhum candle encontrado no arquivo');
    return;
  }
  
  // Ordenar por timestamp
  candles.sort((a, b) => a.timestamp - b.timestamp);
  
  // Extrair informações do path
  const filename = basename(csvPath, '.csv');
  const symbol = basename(dirname(csvPath));
  
  // Tentar detectar timeframe no nome do arquivo (ex: NQ1!_1H_2019...)
  // Procura por chaves do config dentro do nome
  let timeframe = filename;
  const knownTimeframes = Object.keys(CHUNK_CONFIG);
  
  // Ordena por tamanho para evitar falsos positivos (ex: '15' matching '15min')
  knownTimeframes.sort((a, b) => b.length - a.length);
  
  const detectedTf = knownTimeframes.find(tf => {
      // Verifica se o timeframe está no nome, cercado por _ ou inicio/fim
      // Ex: _1H_ ou _1H ou 1H_
      return filename.includes(`_${tf}_`) || filename.endsWith(`_${tf}`) || filename.startsWith(`${tf}_`);
  });

  if (detectedTf) {
      timeframe = detectedTf;
  }
  
  // Determinar configuração de chunking
  const config = CHUNK_CONFIG[timeframe] || { by: 'month' as const, maxCandles: 5000 };
  
  // Normalizar timeframe para nome canônico (60 -> 1H, etc)
  const normalizedTimeframe = normalizeTimeframe(timeframe);
  
  // Definir diretório de saída
  // Se outputDir for fornecido, usa ele como base. Se não, usa o diretório do CSV.
  // Estrutura desejada: .../1H/2019.json (sem sufixo _json chato)
  const baseDir = outputDir || dirname(csvPath);
  
  // Se estamos salvando na mesma pasta do raw, talvez criar uma subpasta 'json' seja bom?
  // Mas o usuário sugeriu: "usar apenas dentro do 1H ja em modo Json"
  // Vamos criar uma pasta com o nome do Timeframe NORMALIZADO.
  // Ex: se estamos em data/raw/Symbol/, cria data/raw/Symbol/1H/ (não 60/)
  const jsonDir = join(baseDir, normalizedTimeframe);
  
  await mkdir(jsonDir, { recursive: true });
  
  console.log(`📊 ${candles.length} candles encontrados`);
  console.log(`📅 Período: ${formatDate(candles[0].timestamp)} → ${formatDate(candles[candles.length - 1].timestamp)}`);
  console.log(`📦 Estratégia de chunking: ${config.by}`);
  
  if (config.by === 'single') {
    // Arquivo único
    const outPath = join(jsonDir, `${timeframe}.json`);
    await writeFile(outPath, JSON.stringify({
      symbol,
      timeframe,
      count: candles.length,
      firstDate: formatDate(candles[0].timestamp),
      lastDate: formatDate(candles[candles.length - 1].timestamp),
      candles,
    }, null, 2));
    console.log(`✅ Salvo: ${outPath}`);
    return;
  }
  
  // Agrupar em chunks
  const chunks = groupIntoChunks(candles, config.by);
  const chunkInfos: ChunkInfo[] = [];
  
  // Salvar cada chunk
  for (const [key, chunkCandles] of chunks) {
    let chunkFilename: string;
    let chunkPath: string;
    
    // Para chunks mensais, criar estrutura ano/mes.json
    if (config.by === 'month' && key.includes('-')) {
      const [year, month] = key.split('-');
      const yearDir = join(jsonDir, year);
      await mkdir(yearDir, { recursive: true });
      chunkFilename = `${year}/${month}.json`;
      chunkPath = join(yearDir, `${month}.json`);
    } else {
      chunkFilename = `${key}.json`;
      chunkPath = join(jsonDir, chunkFilename);
    }
    
    // Formatar JSON com indentação para legibilidade
    await writeFile(chunkPath, JSON.stringify(chunkCandles, null, 2));
    
    chunkInfos.push({
      file: chunkFilename,
      startDate: formatDate(chunkCandles[0].timestamp),
      endDate: formatDate(chunkCandles[chunkCandles.length - 1].timestamp),
      startTimestamp: chunkCandles[0].timestamp,
      endTimestamp: chunkCandles[chunkCandles.length - 1].timestamp,
      count: chunkCandles.length,
    });
    
    console.log(`  📁 ${chunkFilename}: ${chunkCandles.length} candles`);
  }
  
  // Ordenar chunks por data
  chunkInfos.sort((a, b) => a.startTimestamp - b.startTimestamp);
  
  // Ler index existente (se houver) para mesclar novos chunks
  const indexPath = join(jsonDir, 'index.json');
  let existingChunks: ChunkInfo[] = [];
  
  if (existsSync(indexPath)) {
    try {
      const existingIndex = JSON.parse(await readFile(indexPath, 'utf-8')) as ChunkIndex;
      existingChunks = existingIndex.chunks || [];
    } catch {}
  }
  
  // Mesclar: combinar chunks existentes com novos (evitar duplicatas por nome de arquivo)
  const allChunksMap = new Map<string, ChunkInfo>();
  for (const chunk of existingChunks) {
    allChunksMap.set(chunk.file, chunk);
  }
  for (const chunk of chunkInfos) {
    allChunksMap.set(chunk.file, chunk); // Sobrescreve se já existir
  }
  
  const allChunks = Array.from(allChunksMap.values()).sort((a, b) => a.startTimestamp - b.startTimestamp);
  
  // Calcular totais do índice mesclado
  const allCandles = allChunks.reduce((sum, c) => sum + c.count, 0);
  const firstChunk = allChunks[0];
  const lastChunk = allChunks[allChunks.length - 1];
  
  // Criar índice atualizado
  const index: ChunkIndex = {
    symbol,
    timeframe: normalizedTimeframe,
    updatedAt: new Date().toISOString(),
    totalCandles: allCandles,
    firstCandle: firstChunk.startDate,
    lastCandle: lastChunk.endDate,
    chunks: allChunks,
  };
  
  await writeFile(indexPath, JSON.stringify(index, null, 2));
  
  console.log(`\n✅ Convertido! ${chunks.size} chunks criados em ${jsonDir} (total: ${allChunks.length} chunks)`);
}

/**
 * Converte todos os CSVs de um diretório
 */
async function convertAll(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    
    if (entry.isDirectory()) {
      // Recursivamente processar subdiretórios
      await convertAll(fullPath);
    } else if (entry.name.endsWith('.csv')) {
      await convertCSV(fullPath);
    }
  }
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║         CSV to JSON Converter - Para Sistema de Replay        ║
╚═══════════════════════════════════════════════════════════════╝

USAGE:
  npm run convert -- <caminho>

EXEMPLOS:
  # Converter um arquivo específico
  npm run convert -- ./data/MNQ/5min.csv

  # Converter todos os CSVs de um diretório
  npm run convert -- ./data

ESTRATÉGIA DE CHUNKING:
  Mensal/Semanal/Diário → Arquivo único
  4H                    → Por ano
  1H/30min              → Por mês
  15min/5min/1min       → Por semana
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
║         CSV to JSON Converter - Para Sistema de Replay        ║
╚═══════════════════════════════════════════════════════════════╝
`);
  
  if (path.endsWith('.csv')) {
    await convertCSV(path);
  } else {
    await convertAll(path);
  }
  
  console.log('\n🎉 Conversão completa!\n');
}

main().catch(console.error);
