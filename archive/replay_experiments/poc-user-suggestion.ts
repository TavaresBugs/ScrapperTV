import 'dotenv/config';
import { connect } from './connection.js';
import { RawCandle } from './types.js';

async function testUserSuggestion() {
  const sessionId = process.env.TV_SESSION_ID;
  console.log('\n🧪 Testando Sugestão do Usuário: Range no create_series...');
  
  const connection = await connect({ sessionId });
  console.log('✅ Conectado.');

  const chartSession = 'cs_' + Math.random().toString(36).substring(2, 14);
  const symbol = 'CME_MINI:NQ1!';
  
  // Target: Nov 2011
  const from = 1322611200; // 2011-11-30 00:00
  const to   = 1322697600; // 2011-11-31 00:00

  return new Promise<void>((resolve, reject) => {
    connection.subscribe((event) => {
      if (['critical_error', 'error'].includes(event.name)) {
         console.error('❌ Erro:', event.params);
      }
      
      if(event.name === 'timescale_update') {
        const params = event.params as [string, Record<string, { s: RawCandle[] }>];
        const seriesData = params[1]?.['sds_1']?.s;
        if (seriesData) {
          console.log(`📊 DADOS RECEBIDOS! ${seriesData.length} candles.`);
          console.log(`   Primeiro: ${new Date(seriesData[0].v[0]*1000).toISOString()}`);
          resolve();
          connection.close();
        }
      }
    });

    console.log('📤 Setup...');
    connection.send('chart_create_session', [chartSession, '']);
    connection.send('resolve_symbol', [
      chartSession,
      'sds_sym_0',
      JSON.stringify({ symbol, adjustment: 'splits' })
    ]);

    console.log('📤 create_series com RANGE OBJECT...');
    // Tentativa 1: Substituir o COUNT (número) por um objeto RANGE
    connection.send('create_series', [
      chartSession,
      'sds_1',
      's0',
      'sds_sym_0',
      '15',
      { from, to }, // <--- AQUI A MUDANÇA
      ''
    ]);
  });
}

testUserSuggestion();
