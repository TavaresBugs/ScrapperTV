import { generateChartSession } from './connection.js';
import type {
  Candle,
  GetCandlesParams,
  RawCandle,
  Timeframe,
  TradingViewConnection,
} from './types.js';

const MAX_BATCH_SIZE = 10000; // Aumentado para otimizar busca

/**
 * Converte timeframe para string do TradingView
 */
function timeframeToString(tf: Timeframe): string {
  return tf.toString();
}

/**
 * Busca candles históricos para um símbolo
 */
export async function getCandles({
  connection,
  symbol,
  timeframe = 60,
  amount,
  from,
  to,
}: GetCandlesParams): Promise<Candle[]> {
  const chartSession = generateChartSession();
  
  // Se 'amount' não for especificado mas 'from' for, usa um batch grande inicial
  const requestAmount = amount ? Math.min(amount, MAX_BATCH_SIZE) : MAX_BATCH_SIZE;

  return new Promise<Candle[]>((resolve, reject) => {
    let rawCandles: RawCandle[] = [];
    let resolved = false;
    let requestCount = 0;
    let lastLength = 0;
    let stallCount = 0;

    const timeout = setTimeout(() => {
      if (!resolved) {
        unsubscribe();
        reject(new Error(`Timeout ao buscar candles para ${symbol}`));
      }
    }, 120000); // 2 minutos timeout

    const unsubscribe = connection.subscribe((event) => {
      // Recebeu novos candles
      if (event.name === 'timescale_update') {
        const params = event.params as [string, Record<string, { s: RawCandle[] }>];
        const seriesData = params[1]?.['sds_1']?.s;
        
        if (seriesData && Array.isArray(seriesData)) {
          // Merge inteligente para evitar duplicatas e garantir ordem
          const newCandles = seriesData;
          
          if (rawCandles.length === 0) {
            rawCandles = newCandles;
          } else {
            // Adicionar apenas os que não existem (baseado em timestamp/index)
            // TradingView envia do mais antigo para novo no array, mas updates podem vir parciais
            // Estratégia simples: concatenar e depois dedublicar por timestamp
            rawCandles = newCandles.concat(rawCandles);
          }
          
          console.log(`📊 ${symbol}: ${rawCandles.length} candles carregados...`);
        }
        return;
      }

      // Série completa ou carregamento finalizado
      if (['series_completed', 'symbol_error'].includes(event.name)) {
        if (event.name === 'symbol_error') {
          console.warn(`⚠️ Erro no símbolo ${symbol}:`, event.params);
          // Não rejeitar imediatamente, pode ter dados parciais
        }

        // Dedublicar e ordenar
        const uniqueCandles = new Map<number, RawCandle>();
        rawCandles.forEach(c => uniqueCandles.set(c.v[0], c));
        rawCandles = Array.from(uniqueCandles.values()).sort((a, b) => a.v[0] - b.v[0]);

        const currentLength = rawCandles.length;
        const oldestCandle = rawCandles[0];
        const newestCandle = rawCandles[rawCandles.length - 1];

        // Se o tamanho não mudou após uma requisição, provavelmente chegamos ao fim dos dados
        if (requestCount > 0 && currentLength === lastLength) {
          stallCount++;
        } else {
          stallCount = 0;
        }
        lastLength = currentLength;

        // Verificar se precisamos de mais dados
        let needMore = false;

        // 1. Critério por Data (FROM)
        if (from && oldestCandle && oldestCandle.v[0] > from) {
          needMore = true;
          if (stallCount >= 3) {
            console.warn(`⚠️ Parando busca por ${symbol} (sem novos dados após 3 tentativas). Chegamos em ${new Date(oldestCandle.v[0] * 1000).toISOString()}`);
            needMore = false;
          }
        }
        // 2. Critério por Quantidade (AMOUNT)
        else if (amount && currentLength < amount) {
          needMore = true;
          if (stallCount >= 3) {
             needMore = false;
          }
        }

        if (needMore) {
          requestCount++;
          console.log(`📥 Buscando mais dados para ${symbol}... (Req #${requestCount}, Oldest: ${new Date(oldestCandle.v[0] * 1000).toISOString()})`);
          connection.send('request_more_data', [chartSession, 'sds_1', MAX_BATCH_SIZE]);
          return;
        }

        // --- Finalização ---
        
        resolved = true;
        clearTimeout(timeout);
        unsubscribe();

        // Filtragem final
        let finalCandles = rawCandles.map((c) => ({
          timestamp: c.v[0],
          datetime: new Date(c.v[0] * 1000).toISOString(),
          open: c.v[1],
          high: c.v[2],
          low: c.v[3],
          close: c.v[4],
          volume: c.v[5] || 0,
        }));

        // Aplicar filtros de data
        if (from) {
          finalCandles = finalCandles.filter(c => c.timestamp >= from);
        }
        if (to) {
          finalCandles = finalCandles.filter(c => c.timestamp <= to);
        }
        
        // Aplicar limite de quantidade se for o critério principal (sem from)
        if (amount && !from && finalCandles.length > amount) {
          // Pegar os mais recentes
          finalCandles = finalCandles.slice(-amount);
        }

        console.log(`✅ ${symbol}: Total final ${finalCandles.length} candles (De ${finalCandles[0]?.datetime} até ${finalCandles[finalCandles.length-1]?.datetime})`);
        resolve(finalCandles);
      }
    });

    // Criar sessão do chart
    connection.send('chart_create_session', [chartSession, '']);

    // Resolver símbolo
    connection.send('resolve_symbol', [
      chartSession,
      'sds_sym_0',
      '=' + JSON.stringify({ symbol, adjustment: 'splits' }),
    ]);

    // Criar série
    // Se tivermos 'to' (data final), precisamos configurar uma range session, mas o TV normalmente trabalha "do presente para trás" no create_series padrão.
    // O create_series pede 'range' ou 'amount'. Vamos manter amount para iniciar.
    connection.send('create_series', [
      chartSession,
      'sds_1',
      's0',
      'sds_sym_0',
      timeframeToString(timeframe),
      requestAmount,
      '', 
    ]);
  });
}

/**
 * Busca candles para múltiplos símbolos
 */
export async function getCandlesMultiple(
  connection: TradingViewConnection,
  symbols: string[],
  timeframe: Timeframe = 60,
  amount?: number
): Promise<Map<string, Candle[]>> {
  const results = new Map<string, Candle[]>();

  for (const symbol of symbols) {
    try {
      const candles = await getCandles({
        connection,
        symbol,
        timeframe,
        amount,
      });
      results.set(symbol, candles);
    } catch (error) {
      console.error(`❌ Erro ao buscar ${symbol}:`, error);
      results.set(symbol, []);
    }
  }

  return results;
}
