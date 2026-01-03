import 'dotenv/config';
import { connect } from './connection.js';
import { getCandles } from './candles.js';

async function verifyM5Range() {
  const sessionId = process.env.TV_SESSION_ID; // Optional
  console.log('\n📅 Verificando Alcance de Dados M5 (Nov-Dez 2025)...');
  
  const connection = await connect({ sessionId });
  console.log('✅ Conectado.');

  // Timestamps (UTC)
  // 02 Nov 2025 18:00:00
  const fromTime = new Date('2025-11-02T18:00:00Z').getTime() / 1000;
  // 26 Dec 2025 16:55:00
  const toTime = new Date('2025-12-26T16:55:00Z').getTime() / 1000;

  console.log(`🎯 Alvo: ${new Date(fromTime*1000).toISOString()} -> ${new Date(toTime*1000).toISOString()}`);
  console.log(`   (Unix: ${fromTime} -> ${toTime})`);

  try {
      const candles = await getCandles({
          connection,
          symbol: 'CME_MINI:NQ1!',
          timeframe: 5, // M5
          from: fromTime,
          to: toTime
      });

      console.log(`\n🎉 Resultado da Busca:`);
      console.log(`   Total Candles: ${candles.length}`);
      
      if (candles.length > 0) {
          const first = candles[0];
          const last = candles[candles.length - 1];
          console.log(`   Primeiro: ${first.datetime}`);
          console.log(`   Último:   ${last.datetime}`);
          
          // Validação simples
          const coveredStart = first.timestamp <= fromTime + (5*60*10); // Tolerância de alguns candles
          const coveredEnd = last.timestamp >= toTime - (5*60*10);
          
          if (coveredStart && coveredEnd) {
             console.log('✅ Cobertura Completa do Intervalo Solicitado!');
          } else {
             console.log('⚠️ Cobertura Parcial (Verifique horários de mercado/feriados).');
          }
      } else {
          console.log('❌ Nenhum dado encontrado neste intervalo.');
      }

  } catch (error) {
      console.error('❌ Erro na verificação:', error);
  } finally {
      connection.close();
  }
}

verifyM5Range();
