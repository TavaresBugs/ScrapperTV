import 'dotenv/config';
import { connect } from './connection.js';
import { RawCandle } from './types.js';

async function testDirectReplaySeries() {
  const sessionId = process.env.TV_SESSION_ID;
  console.log('\n🎯 Testando Create Series DIRETO no Replay Session...');
  
  const connection = await connect({ sessionId });
  console.log('✅ Conectado.');

  const replaySession = 'rs_' + Math.random().toString(36).substring(2, 14);
  const symbol = 'CME_MINI:NQ1!';
  const targetTime = 1633392000; // 2021

  connection.subscribe((event) => {
    if (event.name === 'critical_error') {
       console.error('❌ CRITICAL:', event.params);
       process.exit(1);
    }
    
    if (event.name === 'timescale_update') {
        const params = event.params as [string, Record<string, { s: RawCandle[] }>];
        // Check params[0] which is session ID
        console.log(`📥 Timescale Update para: ${params[0]}`);
        
        const s = params[1]?.['sds_1']?.s;
        if (s && s.length > 0) {
            console.log(`🎉 DADOS! ${s.length} candles. Inicio: ${new Date(s[0].v[0]*1000).toISOString()}`);
            process.exit(0);
        }
    }
  });

  // 1. Criar Replay
  console.log('1️⃣ Criando Replay...');
  connection.send('replay_create_session', [replaySession, '']);
  
  // 2. Resetar (não vamos resolver simbolo explicitamente se der erro)
  console.log('2️⃣ Resetando...');
  connection.send('replay_reset', [replaySession, 'sds_sym_0', targetTime]); // Symbol ID genérico sds_sym_0

  // 3. Tentar criar série usando o PRÓPRIO Replay Session como "Chart Session"
  // E o MESMO Symbol ID (sds_sym_0) usado no Reset
  setTimeout(() => {
      console.log('3️⃣ Tentando create_series no REPLAY SESSION...');
      connection.send('create_series', [
          replaySession, // <--- Replay ID aqui!
          'sds_1',
          's1',
          'sds_sym_0', // Symbol ID que foi usado no Reset
          '15',
          50,
          ''
      ]);
  }, 1000);
}

testDirectReplaySeries();
