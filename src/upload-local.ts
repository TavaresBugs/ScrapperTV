#!/usr/bin/env node
/**
 * Upload Local Data to Drive
 * 
 * Faz upload dos dados locais existentes (data/raw) para o Google Drive.
 * Mescla com dados já existentes no Drive para não perder histórico.
 */
import { readFile, readdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { downloadJson, uploadJson, findOrCreateFolder } from './drive.js';
import 'dotenv/config';

const LOCAL_DATA_PATH = './data/raw';

interface DataFile {
  symbol?: string;
  timeframe?: string;
  period?: string;
  candles: Array<{
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  lastUpdate?: string;
  totalCandles?: number;
}

function getDriveConfig() {
  return {
    credentialsPath: process.env.GOOGLE_CREDENTIALS_PATH || './scrappertv-6f272e09d271.json',
    credentialsJson: process.env.GOOGLE_CREDENTIALS,
    folderId: process.env.GOOGLE_FOLDER_ID || '179sM5CqlpObj7Ad_dagazBjgoapFW-7M',
  };
}

/**
 * Mescla candles
 */
function mergeCandles(old: DataFile['candles'], newer: DataFile['candles']): DataFile['candles'] {
  const map = new Map<number, DataFile['candles'][0]>();
  for (const c of old) map.set(c.timestamp, c);
  for (const c of newer) map.set(c.timestamp, c);
  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Lê dados locais de um arquivo
 * Suporta dois formatos:
 * - Array direto: [{timestamp, open, ...}, ...]
 * - Objeto com candles: {candles: [...], ...}
 */
async function readLocalData(filePath: string): Promise<DataFile | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    
    // Se for array direto, converter para formato DataFile
    if (Array.isArray(parsed)) {
      return {
        candles: parsed,
      };
    }
    
    // Se for objeto com candles
    if (parsed.candles && Array.isArray(parsed.candles)) {
      return parsed;
    }
    
    return null;
  } catch {
    return null;
  }
}

/**
 * Upload de um arquivo local para o Drive
 */
async function uploadLocalFile(
  localPath: string,
  driveFolderId: string,
  fileName: string,
  driveConfig: ReturnType<typeof getDriveConfig>
): Promise<void> {
  // Ler dados locais
  const localData = await readLocalData(localPath);
  if (!localData || !localData.candles || localData.candles.length === 0) {
    console.log(`    ⚠️ Sem dados: ${fileName}`);
    return;
  }
  
  // Baixar dados existentes do Drive
  let driveData: DataFile | null = null;
  try {
    driveData = await downloadJson<DataFile>(driveConfig, fileName, driveFolderId);
  } catch {}
  
  // Mesclar
  const merged = mergeCandles(driveData?.candles || [], localData.candles);
  
  // Fazer upload
  await uploadJson(driveConfig, fileName, {
    ...localData,
    candles: merged,
    lastUpdate: new Date().toISOString(),
    totalCandles: merged.length,
  }, driveFolderId);
  
  const driveCount = driveData?.candles?.length || 0;
  const newCount = merged.length - driveCount;
  console.log(`    ✅ ${fileName}: ${merged.length} candles (${newCount > 0 ? `+${newCount} novos` : 'atualizado'})`);
}

/**
 * Upload recursivo de uma pasta de timeframe
 */
async function uploadTimeframeFolder(
  localFolder: string,
  driveFolderId: string,
  driveConfig: ReturnType<typeof getDriveConfig>,
  timeframeName: string
): Promise<number> {
  const entries = await readdir(localFolder, { withFileTypes: true });
  let count = 0;
  const trackedYears: number[] = [];
  
  for (const entry of entries) {
    const localPath = join(localFolder, entry.name);
    
    if (entry.isDirectory()) {
      // É uma pasta de ano (2024, 2025, etc)
      const year = parseInt(entry.name);
      if (!isNaN(year)) {
        trackedYears.push(year);
        console.log(`    📁 ${entry.name}/`);
        
        // Criar pasta do ano no Drive
        const yearFolderId = await findOrCreateFolder({ ...driveConfig, folderId: driveFolderId }, entry.name);
        
        // Processar arquivos de mês
        const monthFiles = await readdir(localPath, { withFileTypes: true });
        for (const monthFile of monthFiles.filter(f => f.name.endsWith('.json') && f.name !== 'index.json')) {
          await uploadLocalFile(join(localPath, monthFile.name), yearFolderId, monthFile.name, driveConfig);
          count++;
        }
      }
    } else if (entry.name.endsWith('.json') && entry.name !== 'index.json') {
      // Arquivo de ano direto (para 4H, 1H) ou arquivo único
      await uploadLocalFile(localPath, driveFolderId, entry.name, driveConfig);
      count++;
      
      // Se for 2024.json, extrai o ano
      const year = parseInt(entry.name.replace('.json', ''));
      if (!isNaN(year) && year > 1990 && year < 2100) {
        trackedYears.push(year);
      }
    }
  }
  
  // Atualizar index.json com os anos encontrados
  if (trackedYears.length > 0) {
    const sortedYears = [...new Set(trackedYears)].sort();
    await uploadJson(driveConfig, 'index.json', {
      timeframe: timeframeName,
      years: sortedYears,
      lastUpdate: new Date().toISOString(),
    }, driveFolderId);
    console.log(`    📋 index.json atualizado: ${sortedYears.join(', ')}`);
  }
  
  return count;
}

async function main() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║          Upload de Dados Locais para o Google Drive           ║
╚═══════════════════════════════════════════════════════════════╝
📅 ${new Date().toISOString()}
📂 Fonte: ${LOCAL_DATA_PATH}
`);

  const driveConfig = getDriveConfig();
  
  if (!existsSync(LOCAL_DATA_PATH)) {
    console.error(`❌ Pasta não encontrada: ${LOCAL_DATA_PATH}`);
    process.exit(1);
  }
  
  // Processar cada símbolo
  const symbols = await readdir(LOCAL_DATA_PATH, { withFileTypes: true });
  
  for (const symbol of symbols.filter(s => s.isDirectory())) {
    console.log(`\n📊 ${symbol.name}`);
    
    // Criar/encontrar pasta do símbolo no Drive
    const symbolFolderId = await findOrCreateFolder(driveConfig, symbol.name);
    const localSymbolPath = join(LOCAL_DATA_PATH, symbol.name);
    
    // Processar cada timeframe dentro do símbolo
    const timeframes = await readdir(localSymbolPath, { withFileTypes: true });
    let totalCount = 0;
    
    for (const tf of timeframes.filter(t => t.isDirectory())) {
      console.log(`  📁 ${tf.name}/`);
      
      // Criar pasta do timeframe no Drive
      const tfFolderId = await findOrCreateFolder({ ...driveConfig, folderId: symbolFolderId }, tf.name);
      const localTfPath = join(localSymbolPath, tf.name);
      
      // Upload dos arquivos do timeframe
      const count = await uploadTimeframeFolder(localTfPath, tfFolderId, driveConfig, tf.name);
      totalCount += count;
    }
    
    // Processar arquivos soltos (Diario.json, Semanal.json, Mensal.json)
    for (const file of timeframes.filter(f => f.isFile() && f.name.endsWith('.json') && f.name !== 'index.json')) {
      const localFilePath = join(localSymbolPath, file.name);
      await uploadLocalFile(localFilePath, symbolFolderId, file.name, driveConfig);
      totalCount++;
    }
    
    console.log(`  ✅ ${totalCount} arquivos processados`);
  }
  
  console.log('\n✅ Upload concluído!');
}

main().catch(error => {
  console.error('❌ Erro fatal:', error);
  process.exit(1);
});
