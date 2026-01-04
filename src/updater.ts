#!/usr/bin/env node
/**
 * Updater Script
 * 
 * Baixa dados atualizados do TradingView e atualiza arquivos no Google Drive.
 * Usado pelo GitHub Actions para atualizações automáticas.
 */
import { connect, getCandles, type Candle, type Timeframe } from './index.js';
import { listFiles, downloadJson, uploadJson, findOrCreateFolder } from './drive.js';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import 'dotenv/config';

// Configuração
interface SymbolConfig {
  symbol: string;
  name: string;
  timeframes: Timeframe[];
}

interface DataFile {
  symbol: string;
  timeframe: string;
  candles: Candle[];
  lastUpdate: string;
  totalCandles: number;
}

// Símbolos para atualizar
const SYMBOLS: SymbolConfig[] = [
  {
    symbol: 'CME_MINI:NQ1!',
    name: 'NQ',
    timeframes: ['1D', '1W', '1M', 240, 60, 15, 5, 1],
  },
  {
    symbol: 'CME_MINI:ES1!',
    name: 'ES',
    timeframes: ['1D', '1W', '1M', 240, 60],
  },
  {
    symbol: 'OANDA:XAUUSD',
    name: 'GOLD',
    timeframes: ['1D', '1W', 240, 60],
  },
];

// Mapeia timeframe para nome legível
function timeframeName(tf: Timeframe): string {
  const names: Record<string, string> = {
    '1M': 'Mensal',
    '1W': 'Semanal',
    '1D': 'Diario',
    '240': '4H',
    '60': '1H',
    '30': '30M',
    '15': '15M',
    '5': '5M',
    '3': '3M',
    '1': '1M',
  };
  return names[String(tf)] || String(tf);
}

// Configuração do Drive
function getDriveConfig() {
  return {
    credentialsPath: process.env.GOOGLE_CREDENTIALS_PATH || './scrappertv-6f272e09d271.json',
    credentialsJson: process.env.GOOGLE_CREDENTIALS,
    folderId: process.env.GOOGLE_FOLDER_ID || '179sM5CqlpObj7Ad_dagazBjgoapFW-7M',
  };
}

// Nome do arquivo no Drive
function getFileName(symbolName: string, tf: Timeframe): string {
  return `${symbolName}_${timeframeName(tf)}.json`;
}

/**
 * Mescla candles antigos com novos, evitando duplicatas
 */
function mergeCandles(oldCandles: Candle[], newCandles: Candle[]): Candle[] {
  const byTimestamp = new Map<number, Candle>();
  
  // Adiciona antigos
  for (const c of oldCandles) {
    byTimestamp.set(c.timestamp, c);
  }
  
  // Sobrescreve/adiciona novos (mais recentes têm prioridade)
  for (const c of newCandles) {
    byTimestamp.set(c.timestamp, c);
  }
  
  // Ordena por timestamp
  return Array.from(byTimestamp.values()).sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Atualiza dados de um símbolo/timeframe
 */
async function updateSymbolTimeframe(
  connection: Awaited<ReturnType<typeof connect>>,
  config: SymbolConfig,
  tf: Timeframe,
  driveConfig: ReturnType<typeof getDriveConfig>,
  symbolFolderId: string
): Promise<{ updated: boolean; count: number }> {
  const fileName = getFileName(config.name, tf);
  
  console.log(`  📥 ${timeframeName(tf)}...`);
  
  try {
    // Baixar dados existentes do Drive
    let existingData: DataFile | null = null;
    try {
      existingData = await downloadJson<DataFile>(driveConfig, fileName, symbolFolderId);
    } catch {
      // Arquivo pode não existir ainda
    }
    
    // Buscar novos dados do TradingView
    // Se já tem dados, busca menos (apenas atualização)
    const amount = existingData ? 500 : 10000;
    
    const newCandles = await getCandles({
      connection,
      symbol: config.symbol,
      timeframe: tf,
      amount,
    });
    
    if (newCandles.length === 0) {
      console.log(`    ⚠️ Nenhum dado retornado`);
      return { updated: false, count: 0 };
    }
    
    // Mesclar dados
    const oldCandles = existingData?.candles || [];
    const merged = mergeCandles(oldCandles, newCandles);
    
    const dataFile: DataFile = {
      symbol: config.symbol,
      timeframe: String(tf),
      candles: merged,
      lastUpdate: new Date().toISOString(),
      totalCandles: merged.length,
    };
    
    // Upload para o Drive
    await uploadJson(driveConfig, fileName, dataFile, symbolFolderId);
    
    const newCount = merged.length - oldCandles.length;
    console.log(`    ✅ ${merged.length} candles (${newCount > 0 ? `+${newCount} novos` : 'atualizado'})`);
    
    return { updated: true, count: merged.length };
  } catch (error) {
    console.error(`    ❌ Erro: ${error}`);
    return { updated: false, count: 0 };
  }
}

/**
 * Executa atualização completa
 */
async function runUpdate() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║           ScrapperTV - Atualização Automática                 ║
╚═══════════════════════════════════════════════════════════════╝
📅 ${new Date().toISOString()}
`);
  
  const driveConfig = getDriveConfig();
  const sessionId = process.env.TV_SESSION_ID;
  
  if (!sessionId) {
    console.warn('⚠️ TV_SESSION_ID não configurado. Usando conta gratuita.');
  }
  
  // Conectar ao TradingView
  console.log('🔗 Conectando ao TradingView...');
  const connection = await connect({ sessionId });
  console.log('✅ Conectado!\n');
  
  const results: { symbol: string; timeframe: string; count: number }[] = [];
  
  for (const config of SYMBOLS) {
    console.log(`\n📊 ${config.name} (${config.symbol})`);
    
    // Criar/encontrar pasta do símbolo no Drive
    let symbolFolderId: string;
    try {
      symbolFolderId = await findOrCreateFolder(driveConfig, config.name);
    } catch (error) {
      console.error(`  ❌ Erro ao criar pasta: ${error}`);
      continue;
    }
    
    for (const tf of config.timeframes) {
      const result = await updateSymbolTimeframe(connection, config, tf, driveConfig, symbolFolderId);
      if (result.updated) {
        results.push({
          symbol: config.name,
          timeframe: timeframeName(tf),
          count: result.count,
        });
      }
      
      // Pequeno delay entre requests
      await new Promise(r => setTimeout(r, 500));
    }
  }
  
  // Fechar conexão
  await connection.close();
  
  // Resumo
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                        RESUMO                                 ║
╚═══════════════════════════════════════════════════════════════╝
`);
  
  if (results.length === 0) {
    console.log('⚠️ Nenhum arquivo atualizado.');
  } else {
    console.log(`✅ ${results.length} arquivos atualizados:\n`);
    for (const r of results) {
      console.log(`  📄 ${r.symbol}/${r.timeframe}: ${r.count} candles`);
    }
  }
  
  console.log('\n✅ Atualização concluída!');
}

// CLI
async function main() {
  const args = process.argv.slice(2);
  
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
USAGE:
  npx tsx src/updater.ts [options]

OPTIONS:
  --help, -h    Mostra esta ajuda
  --dry-run     Simula execução sem fazer upload

ENVIRONMENT:
  TV_SESSION_ID           SessionId do TradingView (opcional)
  GOOGLE_CREDENTIALS      JSON das credenciais Google (para CI)
  GOOGLE_CREDENTIALS_PATH Caminho para arquivo de credenciais
  GOOGLE_FOLDER_ID        ID da pasta no Drive
`);
    return;
  }
  
  await runUpdate();
}

main().catch(error => {
  console.error('❌ Erro fatal:', error);
  process.exit(1);
});
