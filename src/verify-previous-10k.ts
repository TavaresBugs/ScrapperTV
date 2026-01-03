import 'dotenv/config';
import { connectHistory } from './history-connection.js';
import { getCandles } from './candles.js';

async function verifyPrevious10k() {
  const sessionId = process.env.TV_SESSION_ID;
  console.log('\n📜 Verificando "Previous 10k" (Set-Nov 2025)...');
  
  // Usar endpoint de histórico para tentar limite maior
  const connection = await connectHistory({ sessionId });
  console.log('✅ Conectado (Endpoint History).');

  // Timestamps (UTC)
  // Alvo Final: 02 Nov 2025 23:00 (Onde parou o último)
  const toTime = 1762124400; 
  // Alvo Inicial: 10k candles antes (~35 dias) -> 28 Set 2025
  const fromTime = toTime - (35 * 24 * 60 * 60); 

  console.log(`🎯 Alvo: ${new Date(fromTime*1000).toISOString()} -> ${new Date(toTime*1000).toISOString()}`);
  console.log(`   (Unix: ${fromTime} -> ${toTime})`);
  console.log(`   Profundidade estimada necessária: ~21000 candles a partir de hoje.`);

  try {
      const candles = await getCandles({
          connection,
          symbol: 'CME_MINI:NQ1!',
          timeframe: 5,
          from: fromTime,
          to: toTime,
          // Pedir um amount alto para forçar a lógica de loop
          amount: 25000 
      });

      console.log(`\n🎉 Resultado da Busca Profunda:`);
      console.log(`   Total Candles Retornados: ${candles.length}`);
      
      if (candles.length > 0) {
          const first = candles[0];
          const last = candles[candles.length - 1];
          console.log(`   Primeiro: ${first.datetime} (${first.timestamp})`);
          console.log(`   Último:   ${last.datetime} (${last.timestamp})`);
          
          if (first.timestamp <= fromTime + 3600) {
              console.log('✅ SUCESSO! Conseguimos alcançar os dados de Setembro!');
          } else {
              console.log('⚠️ ALERTA: Não alcançou a data inicial desejada.');
              console.log(`   Faltaram aprox ${(first.timestamp - fromTime)/3600/24} dias.`);
              console.log('   Isso indica o limite máximo de candles por sessão.');
          }
      }

  } catch (error) {
      console.error('❌ Erro na verificação:', error);
  } finally {
      connection.close();
  }
}

verifyPrevious10k();
