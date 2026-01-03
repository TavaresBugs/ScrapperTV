#!/usr/bin/env node
/**
 * Analisador de Gap via WebSocket
 * Baixa candles de cada timeframe e calcula o gap ideal baseado nos dados reais
 */
import { connect } from './connection.js';
import { getCandles } from './candles.js';

const TIMEFRAMES = [1, 3, 5, 15, 60] as const;
const SYMBOL = 'CME_MINI:NQ1!';
const TARGET_CANDLES = 10000; // Quantidade alvo por download

interface AnalysisResult {
  timeframe: number;
  candles: number;
  startDate: string;
  endDate: string;
  realDays: number;
  theoreticalDays: number;
  marketFactor: number;
}

async function analyzeGaps() {
  console.log('🚀 Iniciando análise de gaps via WebSocket...\n');
  
  const sessionId = process.env.TV_SESSION_ID;
  
  if (!sessionId) {
    console.log('⚠️ TV_SESSION_ID não definido. Usando modo não autenticado.');
    console.log('   Para autenticar, exporte: export TV_SESSION_ID="seu_session_id"\n');
  }

  const connection = await connect({ 
    sessionId,
    debug: false,
    endpoint: 'prodata'
  });

  console.log('✅ Conectado ao TradingView\n');

  const results: AnalysisResult[] = [];

  for (const tf of TIMEFRAMES) {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  TIMEFRAME: ${tf} minutos`);
    console.log(`${'═'.repeat(60)}`);

    try {
      const candles = await getCandles({
        connection,
        symbol: SYMBOL,
        timeframe: tf,
        amount: TARGET_CANDLES,
      });

      if (candles.length < 10) {
        console.log(`   ❌ Poucos candles recebidos: ${candles.length}`);
        continue;
      }

      const firstCandle = candles[0];
      const lastCandle = candles[candles.length - 1];

      const startDate = firstCandle.datetime;
      const endDate = lastCandle.datetime;

      // Calcular dias reais
      const startMs = new Date(startDate).getTime();
      const endMs = new Date(endDate).getTime();
      const realDays = Math.round((endMs - startMs) / (1000 * 60 * 60 * 24));

      // Calcular dias teóricos (se mercado operasse 24/7)
      const totalMinutes = candles.length * tf;
      const theoreticalDays = Math.round(totalMinutes / 60 / 24);

      // Fator de mercado
      const marketFactor = theoreticalDays > 0 ? realDays / theoreticalDays : 1;

      results.push({
        timeframe: tf,
        candles: candles.length,
        startDate: startDate.slice(0, 19).replace('T', ' '),
        endDate: endDate.slice(0, 19).replace('T', ' '),
        realDays,
        theoreticalDays,
        marketFactor
      });

      console.log(`   ✅ ${candles.length} candles`);
      console.log(`   📅 De: ${startDate.slice(0, 19)}`);
      console.log(`   📅 Até: ${endDate.slice(0, 19)}`);
      console.log(`   📊 Dias reais: ${realDays} | Teóricos: ${theoreticalDays} | Fator: ${marketFactor.toFixed(2)}x`);

    } catch (error) {
      console.log(`   ❌ Erro: ${error}`);
    }

    // Pequeno delay entre timeframes
    await new Promise(r => setTimeout(r, 2000));
  }

  await connection.close();

  // Relatório final
  console.log(`\n\n${'═'.repeat(80)}`);
  console.log('║                          RELATÓRIO DE ANÁLISE DE GAPS                          ║');
  console.log(`${'═'.repeat(80)}\n`);

  console.log('| TF   | Candles | Início              | Fim                 | Dias R | Dias T | Fator |');
  console.log('|------|---------|---------------------|---------------------|--------|--------|-------|');

  for (const r of results) {
    console.log(
      `| ${String(r.timeframe).padEnd(4)} | ${r.candles.toString().padStart(7)} | ${r.startDate.padEnd(19)} | ${r.endDate.padEnd(19)} | ${r.realDays.toString().padStart(6)} | ${r.theoreticalDays.toString().padStart(6)} | ${r.marketFactor.toFixed(2).padStart(5)} |`
    );
  }

  // Calcular média do fator de mercado
  if (results.length > 0) {
    const avgFactor = results.reduce((sum, r) => sum + r.marketFactor, 0) / results.length;
    console.log(`\n📊 Fator de Mercado Médio: ${avgFactor.toFixed(2)}x`);
    console.log('   (Dias reais = Dias teóricos × Fator)\n');

    // Configuração sugerida
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    console.log('                    CONFIGURAÇÃO SUGERIDA PARA PLAYWRIGHT-SCRAPER              ');
    console.log('═══════════════════════════════════════════════════════════════════════════════\n');

    console.log('const TIMEFRAME_CONFIG: Record<string, TimeframeConfig> = {');
    for (const r of results) {
      const realDaysPerDownload = Math.round(r.candles * r.timeframe / 60 / 24 * r.marketFactor);
      console.log(`  '${r.timeframe}':   { gapCandles: ${r.candles}, timeMinutes: ${String(r.timeframe).padEnd(3)} },  // ~${realDaysPerDownload} dias reais`);
    }
    console.log('};');
    
    console.log('\n\n📋 Copie a configuração acima para o arquivo playwright-scraper.ts');
  }

  console.log('\n✅ Análise concluída!');
}

analyzeGaps().catch(console.error);
