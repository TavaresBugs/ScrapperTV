#!/usr/bin/env node
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { connect, getCandles, type Candle, type Timeframe } from './index.js';

// Argumentos da linha de comando
const args = process.argv.slice(2);

interface CliOptions {
  symbol?: string;
  timeframe?: Timeframe;
  amount?: number;
  sessionId?: string;
  output?: string;
  help?: boolean;
  test?: boolean;
  debug?: boolean;
}

function parseArgs(): CliOptions {
  const options: CliOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case '--symbol':
      case '-s':
        options.symbol = next;
        i++;
        break;
      case '--timeframe':
      case '-t':
        const tf = next;
        if (['1D', '1W', '1M'].includes(tf)) {
          options.timeframe = tf as Timeframe;
        } else {
          options.timeframe = parseInt(tf) as Timeframe;
        }
        i++;
        break;
      case '--amount':
      case '-a':
        options.amount = parseInt(next);
        i++;
        break;
      case '--session':
      case '--sessionId':
        options.sessionId = next;
        i++;
        break;
      case '--output':
      case '-o':
        options.output = next;
        i++;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--test':
        options.test = true;
        break;
      case '--debug':
      case '-d':
        options.debug = true;
        break;
    }
  }

  // Verificar variável de ambiente
  if (!options.sessionId && process.env.TRADINGVIEW_SESSION_ID) {
    options.sessionId = process.env.TRADINGVIEW_SESSION_ID;
  }

  return options;
}

function showHelp() {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║           TradingView Scraper - Download de Dados             ║
╚═══════════════════════════════════════════════════════════════╝

USAGE:
  npm run cli -- [options]

OPTIONS:
  --symbol, -s      Símbolo (ex: BTCUSD, FX:EURUSD, CME_MINI:MNQ1!)
  --timeframe, -t   Timeframe: 1, 5, 15, 30, 60, 240, 1D, 1W, 1M
  --amount, -a      Quantidade de candles (default: máximo)
  --session         SessionId do TradingView (para conta Plus)
  --output, -o      Diretório de saída (default: ./data)
  --test            Testar conexão apenas
  --debug, -d       Modo debug
  --help, -h        Mostrar esta ajuda

EXEMPLOS:
  npm run cli -- -s BTCUSD -t 60 -a 10000
  npm run cli -- -s CME_MINI:MNQ1! -t 5 --session SEU_SESSION_ID
  npm run cli -- -s OANDA:XAUUSD -t 1D
`);
}

/**
 * Formata timeframe para nome de arquivo
 * Nomenclatura: Mensal, Semanal, Diario, 4H, 1H, 15M, 5M, 3M, 1M
 */
function formatTimeframeForFile(tf: Timeframe): string {
  const tfStr = String(tf);
  
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
  
  return TIMEFRAME_NAMES[tfStr] || tfStr;
}

/**
 * Converte timestamp para data legível
 */
function formatDate(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * Gera CSV a partir dos candles
 */
function candlesToCSV(candles: Candle[]): string {
  const header = 'timestamp,datetime,open,high,low,close,volume';
  const rows = candles.map(c => 
    `${c.timestamp},${formatDate(c.timestamp)},${c.open},${c.high},${c.low},${c.close},${c.volume}`
  );
  return [header, ...rows].join('\n');
}

/**
 * Salva candles em CSV
 */
async function saveCandles(
  candles: Candle[],
  symbol: string,
  timeframe: Timeframe,
  outputDir: string
): Promise<string> {
  // Normalizar nome do símbolo
  const symbolClean = symbol.replace(/[/:]/g, '_').replace(/[!?.]/g, '');
  const symbolDir = join(outputDir, symbolClean);

  await mkdir(symbolDir, { recursive: true });

  const filename = `${formatTimeframeForFile(timeframe)}.csv`;
  const filepath = join(symbolDir, filename);

  // Salvar CSV
  const csv = candlesToCSV(candles);
  await writeFile(filepath, csv);

  return filepath;
}

async function testConnection(sessionId?: string) {
  console.log('\n🧪 Testando conexão com TradingView...\n');

  try {
    const connection = await connect({ sessionId, debug: false });
    console.log('✅ Conexão estabelecida com sucesso!');

    console.log('\n📊 Testando busca de dados (BTCUSD)...');
    const candles = await getCandles({
      connection,
      symbol: 'BTCUSD',
      timeframe: 60,
      amount: 10,
    });

    if (candles.length > 0) {
      console.log(`✅ Dados recebidos! ${candles.length} candles`);
      console.log('\nÚltimo candle:');
      const last = candles[candles.length - 1];
      console.log(`  Data: ${formatDate(last.timestamp)}`);
      console.log(`  O: ${last.open} H: ${last.high} L: ${last.low} C: ${last.close}`);
      console.log(`  Volume: ${last.volume}`);
    }

    await connection.close();
    console.log('\n✅ Teste completo!\n');
  } catch (error) {
    console.error('\n❌ Erro no teste:', error);
    process.exit(1);
  }
}

async function downloadData(options: CliOptions) {
  const { symbol, timeframe = 60, amount, sessionId, output = './data', debug } = options;

  if (!symbol) {
    console.error('❌ Símbolo é obrigatório! Use --symbol ou -s');
    process.exit(1);
  }

  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║           TradingView Scraper - Download CSV                  ║
╚═══════════════════════════════════════════════════════════════╝

📊 Símbolo: ${symbol}
⏱️  Timeframe: ${timeframe}
📈 Quantidade: ${amount || 'máximo disponível'}
🔐 Autenticado: ${sessionId ? 'Sim (Plus)' : 'Não'}
📁 Saída: ${output}
`);

  try {
    console.log('🔗 Conectando ao TradingView...\n');
    const connection = await connect({ sessionId, debug });

    console.log(`📥 Baixando dados de ${symbol}...\n`);
    const candles = await getCandles({
      connection,
      symbol,
      timeframe,
      amount,
    });

    if (candles.length === 0) {
      console.log('⚠️ Nenhum candle retornado. Verifique o símbolo.');
      await connection.close();
      process.exit(1);
    }

    // Salvar CSV
    const filepath = await saveCandles(candles, symbol, timeframe, output);
    console.log(`\n💾 CSV salvo em: ${filepath}`);

    // Estatísticas
    const first = candles[0];
    const last = candles[candles.length - 1];
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                        RESUMO                                 ║
╚═══════════════════════════════════════════════════════════════╝
📊 Total de candles: ${candles.length}
📅 De: ${formatDate(first.timestamp)}
📅 Até: ${formatDate(last.timestamp)}
💰 Range: ${Math.min(...candles.map(c => c.low)).toFixed(2)} - ${Math.max(...candles.map(c => c.high)).toFixed(2)}
📁 Arquivo: ${filepath}
`);

    await connection.close();
    console.log('✅ Download completo!\n');
  } catch (error) {
    console.error('\n❌ Erro:', error);
    process.exit(1);
  }
}

// Main
async function main() {
  const options = parseArgs();

  if (options.help) {
    showHelp();
    return;
  }

  if (options.test) {
    await testConnection(options.sessionId);
    return;
  }

  await downloadData(options);
}

main().catch(console.error);
