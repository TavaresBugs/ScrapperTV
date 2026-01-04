#!/usr/bin/env node
/**
 * Updater Script - Estrutura Hierárquica
 * 
 * Estrutura no Drive:
 * data/
 * └── CME_MINI_DL_NQ1/
 *     ├── Mensal.json         # UM arquivo
 *     ├── Semanal.json        # UM arquivo
 *     ├── Diario.json         # UM arquivo
 *     ├── 4H/
 *     │   └── index.json + por ano (2024.json, 2025.json)
 *     ├── 1H/
 *     │   └── index.json + por ano
 *     ├── 15M/
 *     │   └── ano/mes.json (2025/01.json)
 *     ├── 5M/
 *     │   └── ano/mes.json
 *     └── 1M/
 *         └── ano/mes.json
 */
import { connect, getCandles, type Candle, type Timeframe } from './index.js';
import { downloadJson, uploadJson, findOrCreateFolder, findFolder } from './drive.js';
import 'dotenv/config';

// Configuração
interface SymbolConfig {
  symbol: string;
  driveFolderName: string; // Nome da pasta no Drive
  timeframes: TimeframeConfig[];
}

interface TimeframeConfig {
  tf: Timeframe;
  name: string;
  structure: 'single' | 'yearly' | 'monthly';
}

interface DataFile {
  symbol: string;
  timeframe: string;
  period?: string;
  candles: Candle[];
  lastUpdate: string;
  totalCandles: number;
}

// Símbolos para atualizar
const SYMBOLS: SymbolConfig[] = [
  {
    symbol: 'CME_MINI:NQ1!',
    driveFolderName: 'CME_MINI_DL_NQ1',
    timeframes: [
      { tf: '1M', name: 'Mensal', structure: 'single' },
      { tf: '1W', name: 'Semanal', structure: 'single' },
      { tf: '1D', name: 'Diario', structure: 'single' },
      { tf: 240, name: '4H', structure: 'yearly' },
      { tf: 60, name: '1H', structure: 'yearly' },
      { tf: 15, name: '15M', structure: 'monthly' },
      { tf: 5, name: '5M', structure: 'monthly' },
      { tf: 1, name: '1M', structure: 'monthly' },
    ],
  },
];

// Configuração do Drive
function getDriveConfig() {
  return {
    credentialsPath: process.env.GOOGLE_CREDENTIALS_PATH || './scrappertv-6f272e09d271.json',
    credentialsJson: process.env.GOOGLE_CREDENTIALS,
    folderId: process.env.GOOGLE_FOLDER_ID || '179sM5CqlpObj7Ad_dagazBjgoapFW-7M',
  };
}

/**
 * Agrupa candles por ano
 */
function groupByYear(candles: Candle[]): Map<number, Candle[]> {
  const groups = new Map<number, Candle[]>();
  for (const c of candles) {
    const year = new Date(c.timestamp * 1000).getFullYear();
    if (!groups.has(year)) groups.set(year, []);
    groups.get(year)!.push(c);
  }
  return groups;
}

/**
 * Agrupa candles por ano/mês
 */
function groupByMonth(candles: Candle[]): Map<string, Candle[]> {
  const groups = new Map<string, Candle[]>();
  for (const c of candles) {
    const d = new Date(c.timestamp * 1000);
    const key = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(c);
  }
  return groups;
}

/**
 * Mescla candles
 */
function mergeCandles(old: Candle[], newer: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of old) map.set(c.timestamp, c);
  for (const c of newer) map.set(c.timestamp, c);
  return Array.from(map.values()).sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Atualiza timeframe com estrutura SINGLE (um arquivo só)
 */
async function updateSingle(
  connection: Awaited<ReturnType<typeof connect>>,
  symbol: string,
  tfConfig: TimeframeConfig,
  driveConfig: ReturnType<typeof getDriveConfig>,
  symbolFolderId: string
): Promise<number> {
  const fileName = `${tfConfig.name}.json`;
  console.log(`  📥 ${tfConfig.name}...`);
  
  // Baixar existente
  let existing: DataFile | null = null;
  try {
    existing = await downloadJson<DataFile>(driveConfig, fileName, symbolFolderId);
  } catch {}
  
  // Buscar novos dados
  const newCandles = await getCandles({
    connection,
    symbol,
    timeframe: tfConfig.tf,
    amount: existing ? 500 : 10000,
  });
  
  if (newCandles.length === 0) {
    console.log(`    ⚠️ Sem dados`);
    return 0;
  }
  
  const merged = mergeCandles(existing?.candles || [], newCandles);
  
  await uploadJson(driveConfig, fileName, {
    symbol,
    timeframe: tfConfig.name,
    candles: merged,
    lastUpdate: new Date().toISOString(),
    totalCandles: merged.length,
  }, symbolFolderId);
  
  console.log(`    ✅ ${merged.length} candles`);
  return merged.length;
}

/**
 * Atualiza timeframe com estrutura YEARLY (pasta + ano.json)
 */
async function updateYearly(
  connection: Awaited<ReturnType<typeof connect>>,
  symbol: string,
  tfConfig: TimeframeConfig,
  driveConfig: ReturnType<typeof getDriveConfig>,
  symbolFolderId: string
): Promise<number> {
  console.log(`  📥 ${tfConfig.name}/...`);
  
  // Criar pasta do timeframe
  const tfFolderId = await findOrCreateFolder({ ...driveConfig, folderId: symbolFolderId }, tfConfig.name);
  
  // Buscar dados
  const candles = await getCandles({
    connection,
    symbol,
    timeframe: tfConfig.tf,
    amount: 10000,
  });
  
  if (candles.length === 0) {
    console.log(`    ⚠️ Sem dados`);
    return 0;
  }
  
  // Agrupar por ano
  const byYear = groupByYear(candles);
  let total = 0;
  
  for (const [year, yearCandles] of byYear) {
    const fileName = `${year}.json`;
    
    // Baixar existente e mesclar
    let existing: DataFile | null = null;
    try {
      existing = await downloadJson<DataFile>(driveConfig, fileName, tfFolderId);
    } catch {}
    
    const merged = mergeCandles(existing?.candles || [], yearCandles);
    
    await uploadJson(driveConfig, fileName, {
      symbol,
      timeframe: tfConfig.name,
      period: String(year),
      candles: merged,
      lastUpdate: new Date().toISOString(),
      totalCandles: merged.length,
    }, tfFolderId);
    
    total += merged.length;
  }
  
  // Criar/atualizar index.json
  const years = Array.from(byYear.keys()).sort();
  await uploadJson(driveConfig, 'index.json', {
    symbol,
    timeframe: tfConfig.name,
    years,
    lastUpdate: new Date().toISOString(),
  }, tfFolderId);
  
  console.log(`    ✅ ${total} candles em ${years.length} anos`);
  return total;
}

/**
 * Atualiza timeframe com estrutura MONTHLY (pasta/ano/mes.json)
 */
async function updateMonthly(
  connection: Awaited<ReturnType<typeof connect>>,
  symbol: string,
  tfConfig: TimeframeConfig,
  driveConfig: ReturnType<typeof getDriveConfig>,
  symbolFolderId: string
): Promise<number> {
  console.log(`  📥 ${tfConfig.name}/...`);
  
  // Criar pasta do timeframe
  const tfFolderId = await findOrCreateFolder({ ...driveConfig, folderId: symbolFolderId }, tfConfig.name);
  
  // Buscar dados
  const candles = await getCandles({
    connection,
    symbol,
    timeframe: tfConfig.tf,
    amount: 10000,
  });
  
  if (candles.length === 0) {
    console.log(`    ⚠️ Sem dados`);
    return 0;
  }
  
  // Agrupar por ano/mês
  const byMonth = groupByMonth(candles);
  let total = 0;
  const years = new Set<number>();
  
  for (const [yearMonth, monthCandles] of byMonth) {
    const [year, month] = yearMonth.split('/');
    years.add(parseInt(year));
    
    // Criar pasta do ano
    const yearFolderId = await findOrCreateFolder({ ...driveConfig, folderId: tfFolderId }, year);
    
    const fileName = `${month}.json`;
    
    // Baixar existente e mesclar
    let existing: DataFile | null = null;
    try {
      existing = await downloadJson<DataFile>(driveConfig, fileName, yearFolderId);
    } catch {}
    
    const merged = mergeCandles(existing?.candles || [], monthCandles);
    
    await uploadJson(driveConfig, fileName, {
      symbol,
      timeframe: tfConfig.name,
      period: yearMonth,
      candles: merged,
      lastUpdate: new Date().toISOString(),
      totalCandles: merged.length,
    }, yearFolderId);
    
    total += merged.length;
  }
  
  // Criar/atualizar index.json
  await uploadJson(driveConfig, 'index.json', {
    symbol,
    timeframe: tfConfig.name,
    years: Array.from(years).sort(),
    lastUpdate: new Date().toISOString(),
  }, tfFolderId);
  
  console.log(`    ✅ ${total} candles em ${byMonth.size} meses`);
  return total;
}

/**
 * Executa atualização completa
 */
async function runUpdate() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║           ScrapperTV - Atualização Hierárquica                ║
╚═══════════════════════════════════════════════════════════════╝
📅 ${new Date().toISOString()}
`);
  
  const driveConfig = getDriveConfig();
  const sessionId = process.env.TV_SESSION_ID;
  
  if (!sessionId) {
    console.warn('⚠️ TV_SESSION_ID não configurado.');
  }
  
  console.log('🔗 Conectando ao TradingView...');
  const connection = await connect({ sessionId });
  console.log('✅ Conectado!\n');
  
  for (const config of SYMBOLS) {
    console.log(`\n📊 ${config.driveFolderName}`);
    
    // Criar pasta do símbolo
    const symbolFolderId = await findOrCreateFolder(driveConfig, config.driveFolderName);
    
    for (const tfConfig of config.timeframes) {
      try {
        switch (tfConfig.structure) {
          case 'single':
            await updateSingle(connection, config.symbol, tfConfig, driveConfig, symbolFolderId);
            break;
          case 'yearly':
            await updateYearly(connection, config.symbol, tfConfig, driveConfig, symbolFolderId);
            break;
          case 'monthly':
            await updateMonthly(connection, config.symbol, tfConfig, driveConfig, symbolFolderId);
            break;
        }
      } catch (error) {
        console.error(`    ❌ Erro: ${error}`);
      }
      
      await new Promise(r => setTimeout(r, 500));
    }
  }
  
  await connection.close();
  console.log('\n✅ Atualização concluída!');
}

// CLI
async function main() {
  if (process.argv.includes('--help')) {
    console.log(`
USAGE: npx tsx src/updater.ts

Atualiza dados do TradingView para o Google Drive com estrutura hierárquica.
`);
    return;
  }
  
  await runUpdate();
}

main().catch(error => {
  console.error('❌ Erro fatal:', error);
  process.exit(1);
});
