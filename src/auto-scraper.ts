#!/usr/bin/env node
import { exec as execCallback, spawn } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

const exec = promisify(execCallback);

// Helper para executar comandos com logs em tempo real
const runWithLogs = (command: string, args: string[]): Promise<void> => {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      stdio: 'inherit', // Mostra logs em tempo real
      shell: true
    });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Processo terminou com código ${code}`));
    });
    proc.on('error', reject);
  });
};

/**
 * Auto Scraper - Sistema Híbrido
 * 
 * 1. Baixa dados recentes via WebSocket (mais rápido/bruto)
 * 2. Identifica a data mais antiga baixada
 * 3. Baixa dados anteriores via Playwright (Replay Mode)
 * 4. Converte tudo para JSON
 */

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flags: string[]): string | undefined => {
    for (const flag of flags) {
      const idx = args.indexOf(flag);
      if (idx !== -1 && args[idx + 1]) return args[idx + 1];
    }
    return undefined;
  };

  const symbol = getArg(['-s', '--symbol']);
  const timeframe = getArg(['-t', '--timeframe']) || '60';
  const sessionId = getArg(['--session']);

  if (!symbol) {
    console.error('❌ Símbolo obrigatório! Use -s ou --symbol');
    process.exit(1);
  }

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║               AUTO SCRAPER - SISTEMA HÍBRIDO                  ║
╚═══════════════════════════════════════════════════════════════╝
`);

  try {
    // ---------------------------------------------------------
    // PREPARAÇÃO: Identificar Caminho do Arquivo
    // ---------------------------------------------------------
    
    // Normaliza nome do símbolo igual ao CLI
    const symbolClean = symbol.replace(/[/:]/g, '_').replace(/[!?.]/g, '');
    
    // Função auxiliar para garantir compatibilidade com cli.ts
    const getTfFilename = (tf: string) => {
      const TIMEFRAME_NAMES: Record<string, string> = {
        '1M': 'Mensal', 'M': 'Mensal', 'Mensal': 'Mensal',
        '1W': 'Semanal', 'W': 'Semanal', 'Semanal': 'Semanal',
        '1D': 'Diario', 'D': 'Diario', 'Diario': 'Diario',
        '240': '4H', '4H': '4H',
        '60': '1H', '1H': '1H',
        '30': '30M', '30min': '30M',
        '15': '15M', '15min': '15M',
        '5': '5M', '5min': '5M',
        '3': '3M', '3min': '3M',
        '1': '1M', '1min': '1M',
      };
      
      const tfStr = String(tf);
      return TIMEFRAME_NAMES[tfStr] || tfStr;
    }
    
    const tfFilename = `${getTfFilename(timeframe)}.csv`;
    const rawFile = join('./data/raw', symbolClean, tfFilename);

    // ---------------------------------------------------------
    // PASSO 1: Scraper WebSocket (Dados Recentes)
    // ---------------------------------------------------------
    
    if (existsSync(rawFile)) {
      console.log(`\n✅ [1/3] Arquivo existente encontrado: ${rawFile}`);
      console.log('   ⏭️  Pulando download via WebSocket (usando cache).');
    } else {
      console.log('\n🚀 [1/3] Baixando dados recentes (WebSocket - Anônimo)...');
      // IMPORTANTE: NÃO passamos --session para o WS para garantir acesso a mais dados (2019-2025)
      let cliCmd = `npx tsx src/cli.ts -s ${symbol} -t ${timeframe} -o ./data/raw`;
      
      console.log(`   Executando: ${cliCmd}`);
      const { stdout: cliOut } = await exec(cliCmd);
      console.log(cliOut);
    }

    // ---------------------------------------------------------
    // PASSO 2: Identificar Data de Corte
    // ---------------------------------------------------------
    console.log('\n🔍 [2/3] Analisando dados...');
    
    if (!existsSync(rawFile)) {
      throw new Error(`Arquivo não encontrado após tentativa de download: ${rawFile}`);
    }

    const content = await readFile(rawFile, 'utf-8');
    const lines = content.trim().split('\n');
    const firstDataLine = lines[1]; 
    if (!firstDataLine) throw new Error('CSV vazio');
    
    // Extrair data (e hora para timeframes de minutos)
    const firstDateStr = firstDataLine.split(',')[1]; // "2024-03-31 22:00:00"
    const [datePart, timePart] = firstDateStr.split(' ');
    const tfMinutes = parseInt(timeframe) || 60;
    
    // Só inclui hora para timeframes < 60min (usando T como separador)
    const oldestDateTime = (tfMinutes < 60 && timePart) 
      ? `${datePart}T${timePart.substring(0, 5)}` 
      : datePart;
    
    console.log(`   📅 Data/hora mais antiga: ${oldestDateTime.replace('T', ' ')}`);
    console.log(`   ⏮️  Playwright irá buscar dados anteriores a esta data`);

    // ---------------------------------------------------------
    // PASSO 3: Scraper Playwright (Dados Antigos)
    // ---------------------------------------------------------
    console.log('\n🎬 [3/3] Iniciando Playwright (Dados Históricos)...');
    
    // Monta argumentos para o playwright
    const pwArgs = [
      'tsx', 'src/playwright-scraper.ts',
      '-s', symbol,
      '-t', timeframe,
      '-d', oldestDateTime,
      '-o', `./data/raw/${symbolClean}`
    ];
    if (sessionId) pwArgs.push('--session', sessionId);
    
    console.log(`   Executando: npx ${pwArgs.join(' ')}`);
    
    // Usa runWithLogs para mostrar logs em TEMPO REAL
    await runWithLogs('npx', pwArgs);

    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                 PROCESSO FINALIZADO!                          ║
╚═══════════════════════════════════════════════════════════════╝
👉 Para converter os dados para JSON, execute:
   npm run convert -- "./data/raw/${symbolClean}"
`);

  } catch (error) {
    console.error('\n❌ Erro:', error);
    process.exit(1);
  }
}

main().catch(console.error);
