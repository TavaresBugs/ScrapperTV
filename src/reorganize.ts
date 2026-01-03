#!/usr/bin/env node
/**
 * Reorganiza JSONs existentes para a nova estrutura:
 * - Mensal, Semanal, Diario → Arquivo único
 * - 4H, 1H, 15M → Por ano  
 * - 5M, 3M, 1M → Por mês (manter)
 */
import { readFile, writeFile, readdir, rm, mkdir } from 'fs/promises';
import { join, basename } from 'path';
import { existsSync } from 'fs';
import type { Candle } from './types.js';

interface SingleFileData {
  symbol: string;
  timeframe: string;
  updatedAt: string;
  totalCandles: number;
  firstCandle: string;
  lastCandle: string;
  candles: Candle[];
}

interface ChunkIndex {
  symbol: string;
  timeframe: string;
  updatedAt: string;
  totalCandles: number;
  firstCandle: string;
  lastCandle: string;
  chunks: { file: string; startDate: string; endDate: string; startTimestamp: number; endTimestamp: number; count: number }[];
}

function formatDateISO(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().split('T')[0];
}

/**
 * Lê todos os candles de uma pasta (recursivamente)
 */
async function readAllCandles(dir: string): Promise<Candle[]> {
  const allCandles: Candle[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    
    if (entry.isDirectory()) {
      // Recursivamente ler subdiretórios
      const subCandles = await readAllCandles(fullPath);
      allCandles.push(...subCandles);
    } else if (entry.name.endsWith('.json') && entry.name !== 'index.json') {
      try {
        const content = await readFile(fullPath, 'utf-8');
        const data = JSON.parse(content);
        
        // Pode ser array de candles ou objeto com .candles
        if (Array.isArray(data)) {
          allCandles.push(...data);
        } else if (data.candles && Array.isArray(data.candles)) {
          allCandles.push(...data.candles);
        }
      } catch (e) {
        console.log(`  ⚠️ Erro lendo ${entry.name}`);
      }
    }
  }
  
  return allCandles;
}

/**
 * Consolida pasta fragmentada em arquivo único
 */
async function consolidateToSingleFile(
  tfDir: string,
  symbol: string,
  timeframe: string,
  outputDir: string
): Promise<void> {
  console.log(`\n📦 Consolidando ${timeframe}...`);
  
  const candles = await readAllCandles(tfDir);
  
  if (candles.length === 0) {
    console.log(`  ⚠️ Nenhum candle encontrado`);
    return;
  }
  
  // Remover duplicatas e ordenar
  const uniqueMap = new Map<number, Candle>();
  for (const c of candles) uniqueMap.set(c.timestamp, c);
  const uniqueCandles = Array.from(uniqueMap.values()).sort((a, b) => a.timestamp - b.timestamp);
  
  const data: SingleFileData = {
    symbol,
    timeframe,
    updatedAt: new Date().toISOString(),
    totalCandles: uniqueCandles.length,
    firstCandle: formatDateISO(uniqueCandles[0].timestamp),
    lastCandle: formatDateISO(uniqueCandles[uniqueCandles.length - 1].timestamp),
    candles: uniqueCandles,
  };
  
  // Salvar arquivo único
  const outPath = join(outputDir, `${timeframe}.json`);
  await writeFile(outPath, JSON.stringify(data, null, 2));
  console.log(`  ✅ ${timeframe}.json: ${uniqueCandles.length} candles (${data.firstCandle} → ${data.lastCandle})`);
  
  // Remover pasta antiga
  console.log(`  🗑️ Removendo pasta ${timeframe}/`);
  await rm(tfDir, { recursive: true, force: true });
}

/**
 * Reorganiza pasta para estrutura por ano
 */
async function reorganizeToYearly(
  tfDir: string,
  symbol: string,
  timeframe: string
): Promise<void> {
  console.log(`\n📅 Reorganizando ${timeframe} para por ano...`);
  
  const candles = await readAllCandles(tfDir);
  
  if (candles.length === 0) {
    console.log(`  ⚠️ Nenhum candle encontrado`);
    return;
  }
  
  // Remover duplicatas
  const uniqueMap = new Map<number, Candle>();
  for (const c of candles) uniqueMap.set(c.timestamp, c);
  const uniqueCandles = Array.from(uniqueMap.values()).sort((a, b) => a.timestamp - b.timestamp);
  
  // Agrupar por ano
  const byYear = new Map<string, Candle[]>();
  for (const c of uniqueCandles) {
    const year = new Date(c.timestamp * 1000).getFullYear().toString();
    if (!byYear.has(year)) byYear.set(year, []);
    byYear.get(year)!.push(c);
  }
  
  // Limpar pasta
  await rm(tfDir, { recursive: true, force: true });
  await mkdir(tfDir, { recursive: true });
  
  // Salvar por ano
  const chunks: { file: string; startDate: string; endDate: string; startTimestamp: number; endTimestamp: number; count: number }[] = [];
  
  for (const [year, yearCandles] of byYear) {
    const filename = `${year}.json`;
    await writeFile(join(tfDir, filename), JSON.stringify(yearCandles, null, 2));
    
    chunks.push({
      file: filename,
      startDate: formatDateISO(yearCandles[0].timestamp),
      endDate: formatDateISO(yearCandles[yearCandles.length - 1].timestamp),
      startTimestamp: yearCandles[0].timestamp,
      endTimestamp: yearCandles[yearCandles.length - 1].timestamp,
      count: yearCandles.length,
    });
    
    console.log(`    📁 ${filename}: ${yearCandles.length} candles`);
  }
  
  // Salvar índice
  chunks.sort((a, b) => a.startTimestamp - b.startTimestamp);
  
  const index: ChunkIndex = {
    symbol,
    timeframe,
    updatedAt: new Date().toISOString(),
    totalCandles: uniqueCandles.length,
    firstCandle: formatDateISO(uniqueCandles[0].timestamp),
    lastCandle: formatDateISO(uniqueCandles[uniqueCandles.length - 1].timestamp),
    chunks,
  };
  
  await writeFile(join(tfDir, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`  ✅ ${timeframe}/: ${byYear.size} anos, ${uniqueCandles.length} candles`);
}

async function main() {
  const symbolDir = './data/raw/CME_MINI_DL_NQ1';
  const symbol = 'CME_MINI_DL_NQ1';
  
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║           Reorganizando Estrutura de Dados                    ║
╚═══════════════════════════════════════════════════════════════╝
`);
  
  // 1. Consolidar HTF em arquivos únicos
  for (const tf of ['Mensal', 'Semanal', 'Diario']) {
    const tfDir = join(symbolDir, tf);
    if (existsSync(tfDir)) {
      await consolidateToSingleFile(tfDir, symbol, tf, symbolDir);
    }
  }
  
  // 2. Reorganizar MTF para por ano
  for (const tf of ['4H', '1H', '15M']) {
    const tfDir = join(symbolDir, tf);
    if (existsSync(tfDir)) {
      await reorganizeToYearly(tfDir, symbol, tf);
    }
  }
  
  // 3. 5M, 3M, 1M - Atualizar índice se necessário
  for (const tf of ['5M', '3M', '1M']) {
    const tfDir = join(symbolDir, tf);
    if (existsSync(tfDir)) {
      console.log(`\n📊 ${tf}: Atualizando índice...`);
      
      const candles = await readAllCandles(tfDir);
      const uniqueMap = new Map<number, Candle>();
      for (const c of candles) uniqueMap.set(c.timestamp, c);
      const uniqueCandles = Array.from(uniqueMap.values()).sort((a, b) => a.timestamp - b.timestamp);
      
      // Ler chunks existentes
      const entries = await readdir(tfDir, { withFileTypes: true });
      const chunks: { file: string; startDate: string; endDate: string; startTimestamp: number; endTimestamp: number; count: number }[] = [];
      
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const yearDir = join(tfDir, entry.name);
          const monthFiles = await readdir(yearDir);
          
          for (const monthFile of monthFiles) {
            if (!monthFile.endsWith('.json')) continue;
            
            const monthPath = join(yearDir, monthFile);
            const content = await readFile(monthPath, 'utf-8');
            const monthCandles: Candle[] = JSON.parse(content);
            
            if (monthCandles.length > 0) {
              chunks.push({
                file: `${entry.name}/${monthFile}`,
                startDate: formatDateISO(monthCandles[0].timestamp),
                endDate: formatDateISO(monthCandles[monthCandles.length - 1].timestamp),
                startTimestamp: monthCandles[0].timestamp,
                endTimestamp: monthCandles[monthCandles.length - 1].timestamp,
                count: monthCandles.length,
              });
            }
          }
        }
      }
      
      chunks.sort((a, b) => a.startTimestamp - b.startTimestamp);
      
      const index: ChunkIndex = {
        symbol,
        timeframe: tf,
        updatedAt: new Date().toISOString(),
        totalCandles: uniqueCandles.length,
        firstCandle: formatDateISO(uniqueCandles[0].timestamp),
        lastCandle: formatDateISO(uniqueCandles[uniqueCandles.length - 1].timestamp),
        chunks,
      };
      
      await writeFile(join(tfDir, 'index.json'), JSON.stringify(index, null, 2));
      console.log(`  ✅ ${tf}/: ${chunks.length} meses, ${uniqueCandles.length} candles`);
    }
  }
  
  console.log('\n🎉 Reorganização completa!\n');
}

main().catch(console.error);
